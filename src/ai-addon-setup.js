const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const AdmZip = require('adm-zip');
const { SENSITIVE_PROGRESS_KEY_SET } = require('./ai-progress-sanitizer');

const {
  AI_MODEL_CATALOG,
  buildAiAddonStatus,
  getAiAddonPaths,
  getDiarizationModelRef,
  getDiarizationAvailability,
  getDiarizationDependencyArtifactForPlatform,
  getSummaryArtifactForPlatform,
  getSummaryRuntimeArtifactForPlatform,
  getSummaryAvailability,
  loadAiAddonManifest,
  normalizeAiAddonManifest,
  resolveModelId,
} = require('./ai-addon-state');
const {
  TOKEN_KEYS,
  deleteAiAddonToken,
  getAiAddonToken,
  hasAiAddonToken,
  isTokenEncryptionAvailable,
  storeAiAddonToken,
} = require('./ai-addon-token-store');

const AI_ADDON_PROGRESS_CHANNEL = 'ai-addon-progress';
const DOWNLOAD_TIMEOUT_MS = 120000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const DOWNLOAD_REDIRECT_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'files.pythonhosted.org',
  'cdn-lfs.hf.co',
  'cdn-lfs-us-1.hf.co',
  'cdn-lfs-eu-1.hf.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
  'cdn-lfs-eu-1.huggingface.co',
  'cas-bridge.xethub.hf.co',
  'cas-server.xethub.hf.co',
  'cas-server.xethub.huggingface.co',
  'cas-bridge.xethub.huggingface.co',
  'transfer.xethub.hf.co',
  'transfer.xethub.huggingface.co',
]);
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  ...collectConfiguredDownloadHosts(AI_MODEL_CATALOG),
  ...DOWNLOAD_REDIRECT_HOSTS,
]);

function collectConfiguredDownloadHosts(value, hosts = new Set()) {
  if (!value) {
    return hosts;
  }

  if (typeof value === 'string') {
    if (value.startsWith('https://')) {
      try {
        hosts.add(new URL(value).hostname.toLowerCase());
      } catch (error) {
        // Validation below reports malformed configured URLs at their call sites.
      }
    }
    return hosts;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectConfiguredDownloadHosts(item, hosts);
    }
    return hosts;
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectConfiguredDownloadHosts(item, hosts);
    }
  }

  return hosts;
}

function getDirectorySizeBytes(dirPath, fsModule = fs) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const readdirSync = bindFsMethod(fsModule, 'readdirSync');
  const statSync = bindFsMethod(fsModule, 'statSync');
  if (!dirPath || !existsSync || !readdirSync || !statSync || !existsSync(dirPath)) {
    return 0;
  }

  let total = 0;
  const queue = [dirPath];
  while (queue.length) {
    const currentDir = queue.shift();
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      const entryStats = statSync(entryPath);
      const isDirectory = typeof entry.isDirectory === 'function'
        ? entry.isDirectory()
        : entryStats.isDirectory();
      if (isDirectory) {
        queue.push(entryPath);
      } else if (typeof entryStats.size === 'number') {
        total += entryStats.size;
      }
    }
  }

  return total;
}

function getFileSizeBytes(filePath, fsModule = fs) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const statSync = bindFsMethod(fsModule, 'statSync');
  if (!filePath || !existsSync || !statSync || !existsSync(filePath)) {
    return 0;
  }

  const stats = statSync(filePath);
  if (stats && typeof stats.isDirectory === 'function' && stats.isDirectory()) {
    return 0;
  }
  return typeof stats.size === 'number' ? stats.size : 0;
}

function safePathSegment(value) {
  return String(value || 'model')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'model';
}

function getSummaryModelCacheDir(userDataDir, modelId) {
  return path.join(getAiAddonPaths(userDataDir).summaryModelCacheDir, safePathSegment(modelId));
}

function getDiarizationModelCacheDir(userDataDir, modelId) {
  return path.join(getAiAddonPaths(userDataDir).diarizationModelCacheDir, safePathSegment(modelId));
}

function getDiarizationDependencyDir(userDataDir, artifact) {
  return path.join(getAiAddonPaths(userDataDir).diarizationDependencyCacheDir, safePathSegment(artifact && artifact.id));
}

function getDiarizationDependencySitePackagesDir(userDataDir, artifact) {
  return path.join(getDiarizationDependencyDir(userDataDir, artifact), 'site-packages');
}

function getDiarizationDependencyMarkerPath(userDataDir, artifact) {
  return path.join(getDiarizationDependencyDir(userDataDir, artifact), 'install.json');
}

function getSummaryArtifactPath(userDataDir, artifact) {
  if (!artifact || !artifact.fileName) {
    return null;
  }

  return path.join(getSummaryModelCacheDir(userDataDir, artifact.modelId), artifact.fileName);
}

function getSummaryRuntimeDir(userDataDir, artifact) {
  return path.join(getSummaryModelCacheDir(userDataDir, artifact && artifact.modelId), 'runtime', artifact && artifact.platform ? `${artifact.platform}-${artifact.arch}` : 'current');
}

function getSummaryRuntimeExecutablePath(userDataDir, artifact, runtimeArtifact) {
  const executableName = runtimeArtifact && runtimeArtifact.executableName;
  return executableName ? path.join(getSummaryRuntimeDir(userDataDir, artifact), executableName) : null;
}

function getSummaryRuntimeExtractDir(userDataDir, artifact, runtimeArtifact) {
  return path.join(getSummaryRuntimeDir(userDataDir, artifact), 'extract');
}

function getSummaryRuntimeArchiveDir(userDataDir, artifact) {
  return path.join(getSummaryRuntimeDir(userDataDir, artifact), 'archives');
}

function getSummaryRuntimeArchivePath(userDataDir, artifact, runtimeArchive) {
  if (!runtimeArchive || !runtimeArchive.fileName) {
    return null;
  }

  return path.join(getSummaryRuntimeArchiveDir(userDataDir, artifact), runtimeArchive.fileName);
}

function findRuntimeExecutablePath(runtimeDir, executableName, fsModule = fs) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const readdirSync = bindFsMethod(fsModule, 'readdirSync');
  const statSync = bindFsMethod(fsModule, 'statSync');
  if (!runtimeDir || !executableName || !existsSync || !readdirSync || !statSync || !existsSync(runtimeDir)) {
    return null;
  }

  const visited = new Set();
  const searchRoot = (rootDir) => {
    const queue = [rootDir];
    while (queue.length) {
      const currentDir = queue.shift();
      const normalizedDir = path.normalize(currentDir);
      if (visited.has(normalizedDir)) {
        continue;
      }
      visited.add(normalizedDir);
      for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
        const entryPath = path.join(currentDir, entry.name);
        const isDirectory = typeof entry.isDirectory === 'function'
          ? entry.isDirectory()
          : statSync(entryPath).isDirectory();
        if (!isDirectory && entry.name === executableName) {
          return entryPath;
        }
        if (isDirectory) {
          queue.push(entryPath);
        }
      }
    }

    return null;
  };

  const extractDir = path.join(runtimeDir, 'extract');
  const extractMatch = existsSync(extractDir) ? searchRoot(extractDir) : null;
  if (extractMatch) {
    return extractMatch;
  }

  return searchRoot(runtimeDir);
}

function bindFsMethod(fsModule, methodName) {
  const method = fsModule && fsModule[methodName];
  return typeof method === 'function' ? method.bind(fsModule) : undefined;
}

function loadManifest({ userDataDir, fsModule = fs, catalog = AI_MODEL_CATALOG } = {}) {
  return loadAiAddonManifest({
    userDataDir,
    existsSync: bindFsMethod(fsModule, 'existsSync'),
    readFileSync: bindFsMethod(fsModule, 'readFileSync'),
    catalog,
  }).manifest;
}

function writeFileAtomicSync(fsModule, targetPath, contents) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const writeFileSync = bindFsMethod(fsModule, 'writeFileSync');
  const renameSync = bindFsMethod(fsModule, 'renameSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');

  if (!writeFileSync) {
    throw new Error('File system does not support writing AI add-on state.');
  }

  try {
    writeFileSync(tempPath, contents, 'utf8');
    if (renameSync) {
      renameSync(tempPath, targetPath);
    } else {
      writeFileSync(targetPath, contents, 'utf8');
      if (unlinkSync) {
        unlinkSync(tempPath);
      }
    }
  } finally {
    const existsSync = bindFsMethod(fsModule, 'existsSync');
    if (existsSync && unlinkSync && existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch (error) {
        // Best effort cleanup only.
      }
    }
  }
}

function saveAiAddonManifest({ userDataDir, manifest, fsModule = fs, catalog = AI_MODEL_CATALOG } = {}) {
  const paths = getAiAddonPaths(userDataDir);
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const normalized = normalizeAiAddonManifest(manifest, catalog);

  if (mkdirSync) {
    mkdirSync(paths.rootDir, { recursive: true });
  }

  writeFileAtomicSync(fsModule, paths.manifestPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function updateManifestFeature({ userDataDir, feature, updates, fsModule = fs, catalog = AI_MODEL_CATALOG } = {}) {
  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const nextManifest = normalizeAiAddonManifest({
    ...manifest,
    features: {
      ...manifest.features,
      [feature]: {
        ...manifest.features[feature],
        ...updates,
      },
    },
  }, catalog);

  return saveAiAddonManifest({ userDataDir, manifest: nextManifest, fsModule, catalog });
}

function createValidation(status, message, now = () => new Date().toISOString()) {
  return {
    status,
    checkedAt: now(),
    message,
  };
}

function sanitizeProgressMessage(message) {
  return String(message || '')
    .replace(/hf_[A-Za-z0-9_-]+/g, '[redacted-token]')
    .slice(0, 300);
}

function createAiAddonProgressEvent(input = {}) {
  const event = {
    feature: input.feature === 'summary' ? 'summary' : 'diarization',
    phase: String(input.phase || 'status').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
    message: sanitizeProgressMessage(input.message),
  };

  if (Number.isFinite(input.percent)) {
    event.percent = Math.max(0, Math.min(100, Number(input.percent)));
  }
  if (typeof input.modelId === 'string' && input.modelId.trim()) {
    event.modelId = input.modelId.trim();
  }
  if (typeof input.status === 'string' && input.status.trim()) {
    event.status = input.status.trim();
  }

  for (const key of Object.keys(input)) {
    if (SENSITIVE_PROGRESS_KEY_SET.has(key)) {
      delete event[key];
    }
  }

  return event;
}

function emitSafeProgress(emitProgress, payload) {
  if (typeof emitProgress === 'function') {
    emitProgress(createAiAddonProgressEvent(payload));
  }
}

function isLikelyHuggingFaceToken(token) {
  return /^hf_[A-Za-z0-9_-]{8,}$/.test(String(token || '').trim());
}

function getDiarizationTokenStatus({ userDataDir, safeStorage, fsModule = fs, checkEncryptionAvailability = true } = {}) {
  return {
    hasToken: hasAiAddonToken({
      userDataDir,
      tokenKey: TOKEN_KEYS.diarizationHuggingFace,
      fsModule,
    }),
    encryptionAvailable: isTokenEncryptionAvailable({ safeStorage, checkAvailability: checkEncryptionAvailability }),
  };
}

function checkDiarizationCache({ userDataDir, modelId }) {
  return {
    cacheDir: getDiarizationModelCacheDir(userDataDir, modelId),
    provider: 'huggingface',
    managedBy: 'pyannote.audio',
  };
}

function buildDiarizationStorageFootprint({ userDataDir, dependencyCache, fsModule = fs, includeSizes = false } = {}) {
  const modelCacheDir = getAiAddonPaths(userDataDir).diarizationModelCacheDir;
  const dependencyDir = dependencyCache && dependencyCache.dependencyDir;
  const modelCacheBytes = includeSizes ? getDirectorySizeBytes(modelCacheDir, fsModule) : null;
  const dependencyBytes = includeSizes ? getDirectorySizeBytes(dependencyDir, fsModule) : null;
  const estimatedDependencyDownloadBytes = dependencyCache?.artifact?.estimatedDownloadBytes || null;
  const runtimeFamilies = dependencyCache?.artifact?.runtimeFamilies || [];
  const estimatedInstalledBytes = dependencyCache?.installed && estimatedDependencyDownloadBytes
    ? estimatedDependencyDownloadBytes
    : null;

  return {
    modelCacheDir,
    dependencyDir,
    modelCacheBytes,
    dependencyBytes,
    installedBytes: includeSizes ? (modelCacheBytes || 0) + (dependencyBytes || 0) : null,
    installedBytesAccuracy: includeSizes ? 'actual' : 'notScanned',
    estimatedInstalledBytes,
    estimatedDownloadBytes: estimatedDependencyDownloadBytes,
    runtimeFamilies,
  };
}

function buildSummaryStorageFootprint({ userDataDir, modelId, cache, runtimeCache, fsModule = fs, includeSizes = false } = {}) {
  const modelCacheDir = cache?.modelCacheDir || getSummaryModelCacheDir(userDataDir, modelId);
  const runtimeDir = runtimeCache?.runtimeDir || null;
  const cacheBytes = includeSizes ? getDirectorySizeBytes(modelCacheDir, fsModule) : null;
  const runtimeBytes = includeSizes ? getDirectorySizeBytes(runtimeDir, fsModule) : null;
  const artifactSize = includeSizes && cache?.installed && typeof cache?.artifactPath === 'string'
    ? getFileSizeBytes(cache.artifactPath, fsModule)
    : 0;
  const modelBytes = artifactSize || (cache?.installed ? cache?.estimatedSizeBytes || 0 : 0);
  const estimatedModelBytes = cache?.artifact?.estimatedSizeBytes || null;
  const estimatedRuntimeBytes = Array.isArray(runtimeCache?.runtimeArtifact?.artifacts)
    ? runtimeCache.runtimeArtifact.artifacts.reduce((total, artifact) => total + (Number(artifact.sizeBytes) || 0), 0)
    : null;
  const estimatedInstalledBytes = cache?.installed
    ? (estimatedModelBytes || 0) + (runtimeCache?.installed ? estimatedRuntimeBytes || 0 : 0)
    : null;

  return {
    modelCacheDir,
    runtimeDir,
    modelBytes,
    runtimeBytes,
    cacheBytes,
    installedBytes: includeSizes ? cacheBytes : null,
    installedBytesAccuracy: includeSizes ? 'actual' : 'notScanned',
    estimatedInstalledBytes,
    estimatedModelBytes,
    estimatedRuntimeBytes,
    runtimeFamilies: runtimeCache?.runtimeArtifact?.runtimeFamilies || ['llama.cpp'],
  };
}

function buildGpuRuntimeFootprint({ platform, diarization, summary }) {
  const warnings = [];
  if (platform === 'win32') {
    const runtimeFamilies = [
      ...(diarization?.storage?.runtimeFamilies || []),
      ...(summary?.storage?.runtimeFamilies || []),
    ];
    const usesPyTorchCuda = runtimeFamilies.includes('pytorch-cuda');
    const usesLlamaCuda = runtimeFamilies.includes('llama-cpp-cuda');
    if (usesPyTorchCuda && usesLlamaCuda) {
      warnings.push('Speaker identification and summaries use separate CUDA runtimes; disk and VRAM use can add up. GPU-heavy work is serialized.');
    }
  }

  return {
    platform,
    warnings,
    totalInstalledBytes: (diarization?.storage?.installedBytes || 0) + (summary?.storage?.installedBytes || 0),
    estimatedTotalInstalledBytes: (diarization?.storage?.estimatedInstalledBytes || 0) + (summary?.storage?.estimatedInstalledBytes || 0),
  };
}

function validateDiarizationDependencyArtifact(artifact) {
  if (!artifact) {
    return 'No speaker identification dependency setup is available for this platform.';
  }
  if (!artifact.id || !artifact.package || !artifact.version) {
    return 'Speaker identification dependency metadata is incomplete.';
  }
  if (!artifact.pip || !Array.isArray(artifact.pip.requirements) || artifact.pip.requirements.length === 0) {
    return 'Speaker identification dependency requirements are not configured.';
  }
  if (!artifact.pip.indexUrl || !isAllowedDownloadUrl(artifact.pip.indexUrl)) {
    return 'Speaker identification dependency index URL host is not allowed.';
  }
  for (const extraIndexUrl of artifact.pip.extraIndexUrls || []) {
    if (!isAllowedDownloadUrl(extraIndexUrl)) {
      return 'Speaker identification dependency extra index URL host is not allowed.';
    }
  }
  return null;
}

function readDiarizationDependencyMarker({ userDataDir, artifact, fsModule = fs } = {}) {
  const markerPath = getDiarizationDependencyMarkerPath(userDataDir, artifact);
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const readFileSync = bindFsMethod(fsModule, 'readFileSync');
  if (!existsSync || !readFileSync || !existsSync(markerPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function checkDiarizationDependencyCache({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
} = {}) {
  const artifact = getDiarizationDependencyArtifactForPlatform(platform, arch, catalog);
  const validationError = validateDiarizationDependencyArtifact(artifact);
  const dependencyDir = artifact ? getDiarizationDependencyDir(userDataDir, artifact) : null;
  const sitePackagesDir = artifact ? getDiarizationDependencySitePackagesDir(userDataDir, artifact) : null;
  const markerPath = artifact ? getDiarizationDependencyMarkerPath(userDataDir, artifact) : null;
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const marker = artifact ? readDiarizationDependencyMarker({ userDataDir, artifact, fsModule }) : null;
  const installed = Boolean(sitePackagesDir && existsSync && existsSync(sitePackagesDir) && marker && marker.artifactId === artifact.id);

  return {
    supported: Boolean(artifact),
    installed,
    valid: installed && !validationError,
    validationStatus: validationError ? 'error' : installed ? 'ready' : 'notConfigured',
    reason: validationError || (installed ? null : 'Speaker identification dependencies are not installed.'),
    artifact,
    artifactId: artifact && artifact.id,
    dependencyDir,
    sitePackagesDir,
    markerPath,
    marker,
  };
}

async function hashFileSha256(filePath, fsModule = fs) {
  const createReadStream = bindFsMethod(fsModule, 'createReadStream');
  if (!createReadStream) {
    return crypto.createHash('sha256').update(fsModule.readFileSync(filePath)).digest('hex');
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function isPinnedSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || ''));
}

function validateSummaryRuntimeArtifact(runtimeArtifact) {
  if (!runtimeArtifact) {
    return 'Pinned llama.cpp runtime artifact is not configured for this platform.';
  }
  if (!runtimeArtifact.executableName) {
    return 'Pinned llama.cpp runtime executable name is not configured.';
  }
  if (!Array.isArray(runtimeArtifact.artifacts) || runtimeArtifact.artifacts.length === 0) {
    return 'Pinned llama.cpp runtime archives are not configured.';
  }
  for (const archive of runtimeArtifact.artifacts) {
    if (!archive.fileName || !archive.downloadUrl || !isPinnedSha256(archive.sha256)) {
      return 'Pinned llama.cpp runtime archive metadata is incomplete.';
    }
    if (!isAllowedDownloadUrl(archive.downloadUrl)) {
      return 'Pinned llama.cpp runtime archive host is not allowed.';
    }
  }

  return null;
}

function isAllowedDownloadUrl(url) {
  try {
    const parsedUrl = new URL(String(url || ''));
    return parsedUrl.protocol === 'https:' && isAllowedDownloadHost(parsedUrl.hostname);
  } catch (error) {
    return false;
  }
}

function isAllowedDownloadHost(hostname) {
  const normalizedHostname = String(hostname || '').toLowerCase();
  // Hugging Face/Xet redirects rotate among CDN subdomains. Artifact downloads
  // that rely on this wildcard must still pass pinned SHA-256 validation.
  return ALLOWED_DOWNLOAD_HOSTS.has(normalizedHostname)
    || normalizedHostname.endsWith('.hf.co')
    || normalizedHostname.endsWith('.huggingface.co');
}

function getDownloadHost(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch (error) {
    return 'unknown';
  }
}

function checkSummaryRuntimeCache({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
} = {}) {
  const artifact = getSummaryArtifactForPlatform(modelId, platform, arch, catalog);
  const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(platform, arch, catalog);
  const runtimeDir = artifact ? getSummaryRuntimeDir(userDataDir, artifact) : null;
  const expectedExecutablePath = artifact && runtimeArtifact
    ? getSummaryRuntimeExecutablePath(userDataDir, artifact, runtimeArtifact)
    : null;
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const validationError = validateSummaryRuntimeArtifact(runtimeArtifact);
  const executablePath = findRuntimeExecutablePath(runtimeDir, runtimeArtifact && runtimeArtifact.executableName, fsModule)
    || (expectedExecutablePath && existsSync && existsSync(expectedExecutablePath) ? expectedExecutablePath : null);
  const installed = Boolean(executablePath && existsSync && existsSync(executablePath));

  return {
    supported: Boolean(artifact && runtimeArtifact),
    installed,
    valid: installed && !validationError,
    validationStatus: validationError ? 'pendingPinnedRuntime' : installed ? 'ready' : 'notConfigured',
    reason: validationError || (installed ? null : 'llama.cpp runtime is not installed.'),
    estimatedDownloadBytes: Array.isArray(runtimeArtifact?.artifacts)
      ? runtimeArtifact.artifacts.reduce((total, runtimeArchive) => total + (Number(runtimeArchive.sizeBytes) || 0), 0)
      : null,
    runtimeDir,
    expectedExecutablePath,
    executablePath,
    runtimeArtifact,
  };
}

async function checkSummaryModelCache({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  verifyChecksum = false,
} = {}) {
  const artifact = getSummaryArtifactForPlatform(modelId, platform, arch, catalog);
  if (!artifact) {
    return {
      supported: false,
      installed: false,
      valid: false,
      validationStatus: 'unsupported',
      reason: 'No summary setup artifact is available for this platform.',
    };
  }

  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  const modelCacheDir = getSummaryModelCacheDir(userDataDir, artifact.modelId);
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const installed = Boolean(artifactPath && existsSync && existsSync(artifactPath));

  const base = {
    supported: true,
    modelId: artifact.modelId,
    artifactId: artifact.artifactId,
    modelCacheDir,
    artifactPath,
    expectedFileName: artifact.fileName,
    expectedSha256: artifact.sha256,
    estimatedSizeBytes: artifact.estimatedSizeBytes || null,
    artifact,
    installed,
    valid: false,
    checksumStatus: artifact.sha256 ? 'notChecked' : 'pendingPinnedChecksum',
    validationStatus: artifact.validationStatus,
  };

  if (!artifact.fileName) {
    return {
      ...base,
      reason: 'Summary setup artifact filename is not configured.',
      validationStatus: 'missingPinnedFilename',
    };
  }

  if (!installed) {
    return {
      ...base,
      checksumStatus: 'notChecked',
      validationStatus: 'notConfigured',
      reason: 'Summary model artifact is not installed.',
    };
  }

  if (!artifact.sha256) {
    return {
      ...base,
      reason: 'Pinned summary artifact checksum is not configured.',
      validationStatus: 'pendingPinnedArtifact',
    };
  }

  if (!verifyChecksum) {
    return {
      ...base,
      valid: true,
      reason: null,
      validationStatus: 'installed',
    };
  }

  const actualSha256 = await hashFileSha256(artifactPath, fsModule);
  if (actualSha256 !== artifact.sha256) {
    return {
      ...base,
      actualSha256,
      checksumStatus: 'mismatch',
      validationStatus: 'error',
      reason: 'Summary model artifact checksum does not match the pinned checksum.',
    };
  }

  return {
    ...base,
    actualSha256,
    valid: true,
    checksumStatus: 'match',
    validationStatus: 'ready',
    reason: null,
  };
}

function deriveDiarizationStatus(featureStatus, tokenStatus, dependencyCache) {
  if (!featureStatus.availability.supported) {
    return { ...featureStatus, status: 'unsupported' };
  }
  if (featureStatus.status === 'ready' && (!dependencyCache.installed || dependencyCache.valid === false)) {
    return {
      ...featureStatus,
      status: 'error',
      error: dependencyCache.reason || 'Speaker identification dependencies are not installed.',
    };
  }
  if (featureStatus.status === 'ready' && tokenStatus.encryptionAvailable === false) {
    return {
      ...featureStatus,
      status: 'error',
      error: 'Secure token storage is unavailable.',
    };
  }
  if (featureStatus.status === 'ready' && !tokenStatus.hasToken) {
    return {
      ...featureStatus,
      status: 'needsAccount',
      error: 'Hugging Face token is missing.',
    };
  }
  return featureStatus;
}

function deriveSummaryStatus(featureStatus, cache, runtimeCache) {
  if (!featureStatus.availability.supported) {
    return { ...featureStatus, status: 'unsupported' };
  }
  if (featureStatus.status === 'ready' && !cache.installed) {
    return {
      ...featureStatus,
      status: 'error',
      error: 'Summary model cache is missing.',
    };
  }
  if (featureStatus.status === 'ready' && cache.installed && cache.valid === false && cache.checksumStatus !== 'notChecked') {
    return {
      ...featureStatus,
      status: 'error',
      error: cache.reason || 'Summary model cache validation failed.',
    };
  }
  if (featureStatus.status === 'ready' && (!runtimeCache.installed || runtimeCache.valid === false)) {
    return {
      ...featureStatus,
      status: 'error',
      error: runtimeCache.reason || 'llama.cpp runtime validation failed.',
    };
  }
  return featureStatus;
}

async function checkAiAddonSetupStatus({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  verifyChecksums = false,
  includeStorageSizes = false,
  checkTokenEncryption = false,
} = {}) {
  const { manifest, readError } = loadAiAddonManifest({
    userDataDir,
    existsSync: bindFsMethod(fsModule, 'existsSync'),
    readFileSync: bindFsMethod(fsModule, 'readFileSync'),
    catalog,
  });
  const status = buildAiAddonStatus({ userDataDir, platform, arch, manifest, readError, catalog });
  const tokenStatus = getDiarizationTokenStatus({
    userDataDir,
    safeStorage,
    fsModule,
    checkEncryptionAvailability: checkTokenEncryption,
  });
  const diarizationDependencyCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  const summaryCache = await checkSummaryModelCache({
    userDataDir,
    platform,
    arch,
    modelId: status.features.summary.modelId,
    fsModule,
    catalog,
    verifyChecksum: verifyChecksums,
  });
  const summaryRuntimeCache = checkSummaryRuntimeCache({
    userDataDir,
    platform,
    arch,
    modelId: status.features.summary.modelId,
    fsModule,
    catalog,
  });
  const diarization = deriveDiarizationStatus(status.features.diarization, tokenStatus, diarizationDependencyCache);
  const summary = deriveSummaryStatus(status.features.summary, summaryCache, summaryRuntimeCache);
  const diarizationWithStorage = {
    ...diarization,
    tokenStatus,
    cache: checkDiarizationCache({ userDataDir, modelId: diarization.modelId }),
    dependencyCache: diarizationDependencyCache,
    setupComplete: diarization.status === 'ready' && tokenStatus.hasToken && tokenStatus.encryptionAvailable !== false && diarizationDependencyCache.valid,
  };
  diarizationWithStorage.storage = buildDiarizationStorageFootprint({
    userDataDir,
    dependencyCache: diarizationDependencyCache,
    fsModule,
    includeSizes: includeStorageSizes,
  });
  const summaryWithStorage = {
    ...summary,
    artifact: getSummaryArtifactForPlatform(summary.modelId, platform, arch, catalog),
    cache: summaryCache,
    runtimeCache: summaryRuntimeCache,
    setupComplete: summary.status === 'ready' && summaryCache.installed && summaryRuntimeCache.installed,
  };
  summaryWithStorage.storage = buildSummaryStorageFootprint({
    userDataDir,
    modelId: summary.modelId,
    cache: summaryCache,
    runtimeCache: summaryRuntimeCache,
    fsModule,
    includeSizes: includeStorageSizes,
  });

  return {
    ...status,
    footprint: buildGpuRuntimeFootprint({
      platform,
      diarization: diarizationWithStorage,
      summary: summaryWithStorage,
    }),
    features: {
      diarization: diarizationWithStorage,
      summary: summaryWithStorage,
    },
  };
}

function buildFeatureUpdates({ status, modelId, speakerCount, artifactId, profile, validation, error }) {
  const updates = {
    status,
    lastValidation: validation,
    error: error || null,
  };

  if (modelId) {
    updates.modelId = modelId;
  }
  if (speakerCount !== undefined) {
    updates.speakerCount = speakerCount;
  }
  if (artifactId !== undefined) {
    updates.artifactId = artifactId;
  }
  if (profile !== undefined) {
    updates.profile = profile;
  }

  return updates;
}

function buildDiarizationDependencyInstallArgs({ artifact, targetDir }) {
  const pip = artifact && artifact.pip ? artifact.pip : {};
  const args = [
    '-m',
    'pip',
    'install',
    '--upgrade',
    '--ignore-installed',
    '--target',
    targetDir,
    '--no-warn-script-location',
    '--index-url',
    pip.indexUrl,
  ];

  for (const extraIndexUrl of pip.extraIndexUrls || []) {
    args.push('--extra-index-url', extraIndexUrl);
  }
  if (!pip.allowSourceBuilds) {
    args.push('--only-binary=:all:');
  }
  args.push(...pip.requirements);
  return args;
}

function summarizePipProgress(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const relevantLine = [...lines].reverse().find((line) => /^(Collecting|Downloading|Installing|Successfully installed|Building wheel|Using cached)/.test(line));
  return relevantLine || null;
}

function installDiarizationDependenciesWithPip({ pythonExe = 'python', artifact, targetDir, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExe, buildDiarizationDependencyInstallArgs({ artifact, targetDir }), { windowsHide: true });
    let errorOutput = '';

    const handleOutput = (data) => {
      const text = data.toString();
      errorOutput += text;
      const message = summarizePipProgress(text);
      if (message && typeof onProgress === 'function') {
        onProgress(message);
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
        return;
      }
      const reason = errorOutput.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
      reject(new Error(reason || `Speaker identification dependency install failed with code ${code}.`));
    });
  });
}

async function installDiarizationDependencies({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  pythonExe,
  dependencyInstaller = installDiarizationDependenciesWithPip,
} = {}) {
  const artifact = getDiarizationDependencyArtifactForPlatform(platform, arch, catalog);
  const validationError = validateDiarizationDependencyArtifact(artifact);
  if (validationError) {
    throw new Error(validationError);
  }

  const existingCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  if (existingCache.valid) {
    return existingCache;
  }

  const dependencyDir = getDiarizationDependencyDir(userDataDir, artifact);
  const sitePackagesDir = getDiarizationDependencySitePackagesDir(userDataDir, artifact);
  const markerPath = getDiarizationDependencyMarkerPath(userDataDir, artifact);
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
  if (mkdirSync) {
    mkdirSync(dependencyDir, { recursive: true });
  }
  if (unlinkSync && bindFsMethod(fsModule, 'existsSync')?.(markerPath)) {
    unlinkSync(markerPath);
  }
  if (rmSync) {
    rmSync(sitePackagesDir, { recursive: true, force: true });
  }
  if (mkdirSync) {
    mkdirSync(sitePackagesDir, { recursive: true });
  }

  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'downloading-dependencies',
    message: 'Installing local speaker identification dependencies.',
  });

  await dependencyInstaller({
    pythonExe,
    artifact,
    targetDir: sitePackagesDir,
    onProgress: (message) => emitSafeProgress(emitProgress, {
      feature: 'diarization',
      phase: 'downloading-dependencies',
      message,
    }),
  });

  writeFileAtomicSync(fsModule, markerPath, `${JSON.stringify({
    artifactId: artifact.id,
    package: artifact.package,
    version: artifact.version,
    requirements: artifact.pip.requirements,
    installedAt: now(),
  }, null, 2)}\n`);

  const installedCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  if (!installedCache.valid) {
    throw new Error(installedCache.reason || 'Speaker identification dependency installation did not complete.');
  }
  return installedCache;
}

async function validateDiarizationSetup({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  runtimeValidator,
  existingToken,
} = {}) {
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Validating speaker identification setup.',
  });

  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const modelId = resolveModelId('diarization', manifest.features.diarization.modelId, catalog);
  const availability = getDiarizationAvailability(platform, arch);
  const dependencyCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  let status = 'ready';
  let message = 'Speaker identification setup is ready.';
  let error = null;

  if (!availability.supported) {
    status = 'unsupported';
    message = availability.reason;
    error = availability.reason;
  } else if (!dependencyCache.valid) {
    status = dependencyCache.validationStatus === 'error' ? 'error' : 'notConfigured';
    message = dependencyCache.reason || 'Speaker identification dependencies are not installed.';
    error = message;
  } else if (!getDiarizationTokenStatus({
    userDataDir,
    safeStorage,
    fsModule,
    checkEncryptionAvailability: false,
  }).hasToken) {
    status = 'needsAccount';
    message = 'Hugging Face token is required for speaker identification setup.';
    error = message;
  } else {
    try {
      const token = existingToken || getAiAddonToken({
        userDataDir,
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
        safeStorage,
        fsModule,
      });
      if (!isLikelyHuggingFaceToken(token)) {
        status = 'needsAccount';
        message = 'Stored Hugging Face token does not match the expected token format.';
        error = message;
      } else if (typeof runtimeValidator === 'function') {
        try {
          await runtimeValidator({ modelId, modelRef: getDiarizationModelRef(modelId, catalog), token, dependencyCache });
        } catch (runtimeError) {
          status = 'error';
          message = runtimeError.message || 'Speaker identification runtime validation failed.';
          error = message;
        }
      }
    } catch (validationError) {
      status = 'error';
      message = validationError.message && validationError.message.includes('decrypt')
        ? 'Stored Hugging Face token could not be decrypted.'
        : validationError.message || 'Stored Hugging Face token could not be decrypted.';
      error = message;
    }
  }

  updateManifestFeature({
    userDataDir,
    feature: 'diarization',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status,
      modelId,
      speakerCount: manifest.features.diarization.speakerCount,
      validation: createValidation(status, message, now),
      error,
    }),
  });

  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: status,
    status,
    message,
    modelId,
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
}

async function setupDiarizationAddon({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  speakerCount = 'auto',
  token,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  runtimeValidator,
  pythonExe,
  dependencyInstaller,
} = {}) {
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Checking speaker identification setup.',
  });

  const selectedModelId = resolveModelId('diarization', modelId, catalog);
  const availability = getDiarizationAvailability(platform, arch);
  let tokenForValidation = null;

  function markDiarizationError(message) {
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'error',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('error', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'error', status: 'error', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  if (!availability.supported) {
    const message = availability.reason;
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'unsupported',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('unsupported', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'unsupported', status: 'unsupported', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  const trimmedToken = typeof token === 'string' ? token.trim() : '';
  if (trimmedToken) {
    if (!isLikelyHuggingFaceToken(trimmedToken)) {
      const message = 'Hugging Face token does not match the expected token format.';
      updateManifestFeature({
        userDataDir,
        feature: 'diarization',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'needsAccount',
          modelId: selectedModelId,
          speakerCount,
          validation: createValidation('needsAccount', message, now),
          error: message,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'needsAccount', status: 'needsAccount', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    try {
      storeAiAddonToken({
        userDataDir,
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
        token: trimmedToken,
        safeStorage,
        fsModule,
      });
      tokenForValidation = trimmedToken;
    } catch (storageError) {
      return markDiarizationError(storageError.message || 'Secure token storage is unavailable.');
    }
  }

  const tokenStatus = getDiarizationTokenStatus({
    userDataDir,
    safeStorage,
    fsModule,
    checkEncryptionAvailability: false,
  });
  if (!tokenStatus.hasToken) {
    const message = 'Hugging Face token is required for speaker identification setup.';
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'needsAccount',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('needsAccount', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'needsAccount', status: 'needsAccount', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  updateManifestFeature({
    userDataDir,
    feature: 'diarization',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status: 'validating',
      modelId: selectedModelId,
      speakerCount,
      validation: createValidation('validating', 'Speaker identification setup validation started.', now),
      error: null,
    }),
  });

  try {
    await installDiarizationDependencies({
      userDataDir,
      platform,
      arch,
      fsModule,
      catalog,
      now,
      emitProgress,
      pythonExe,
      dependencyInstaller,
    });
  } catch (dependencyError) {
    const message = dependencyError.message || 'Speaker identification dependency setup failed.';
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'error',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('error', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'error', status: 'error', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  if (!tokenForValidation) {
    try {
      tokenForValidation = getAiAddonToken({
        userDataDir,
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
        safeStorage,
        fsModule,
      });
    } catch (storageError) {
      return markDiarizationError(storageError.message || 'Stored Hugging Face token could not be decrypted.');
    }
  }

  return validateDiarizationSetup({
    userDataDir,
    platform,
    arch,
    safeStorage,
    fsModule,
    catalog,
    now,
    emitProgress,
    runtimeValidator,
    existingToken: tokenForValidation,
  });
}

async function removeDiarizationSetup({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
} = {}) {
  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const modelId = manifest.features.diarization.modelId;
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'removing',
    message: 'Removing speaker identification setup.',
    modelId,
  });

  deleteAiAddonToken({ userDataDir, tokenKey: TOKEN_KEYS.diarizationHuggingFace, fsModule });
  if (fsModule.rmSync) {
    fsModule.rmSync(getDiarizationModelCacheDir(userDataDir, modelId), { recursive: true, force: true });
    fsModule.rmSync(getAiAddonPaths(userDataDir).diarizationDependencyCacheDir, { recursive: true, force: true });
  }

  updateManifestFeature({
    userDataDir,
    feature: 'diarization',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status: 'notConfigured',
      modelId,
      speakerCount: 'auto',
      validation: createValidation('notConfigured', 'Speaker identification setup was removed.', now),
      error: null,
    }),
  });

  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'notConfigured',
    status: 'notConfigured',
    message: 'Speaker identification setup was removed.',
    modelId,
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
}

function validateSummarySetupArtifact(artifact) {
  if (!artifact) {
    return 'No summary setup artifact is available for this platform.';
  }
  if (!artifact.fileName) {
    return 'Summary setup artifact filename is not configured.';
  }
  if (!artifact.sha256) {
    return 'Pinned summary artifact checksum is not configured.';
  }
  if (!artifact.downloadUrl) {
    return 'Pinned summary setup artifact download URL is not configured.';
  }
  if (!isAllowedDownloadUrl(artifact.downloadUrl)) {
    return 'Pinned summary setup artifact host is not allowed.';
  }
  return null;
}

function validatePinnedSummarySetup({ artifact, runtimeArtifact }) {
  return validateSummarySetupArtifact(artifact) || validateSummaryRuntimeArtifact(runtimeArtifact);
}

async function downloadFile({ url, destinationPath, expectedSizeBytes, onProgress, redirectCount = 0, timeoutMs = DOWNLOAD_TIMEOUT_MS }) {
  const parsedUrl = new URL(url);
  const client = parsedUrl.protocol === 'https:' ? https : null;
  if (!client) {
    throw new Error('Summary setup artifact downloads require HTTPS.');
  }
  if (!isAllowedDownloadUrl(parsedUrl.toString())) {
    throw new Error(`Summary setup artifact download host is not allowed: ${getDownloadHost(parsedUrl.toString())}.`);
  }
  if (redirectCount > MAX_DOWNLOAD_REDIRECTS) {
    throw new Error('Summary setup artifact download followed too many redirects.');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const request = client.get(parsedUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsedUrl).toString();
        downloadFile({ url: nextUrl, destinationPath, expectedSizeBytes, onProgress, redirectCount: redirectCount + 1, timeoutMs }).then(succeed, fail);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`Summary setup artifact download failed with HTTP ${response.statusCode}.`));
        return;
      }

      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      const file = fs.createWriteStream(destinationPath);
      const total = Number(response.headers['content-length']) || null;
      let downloaded = 0;

      if (expectedSizeBytes && total && total > expectedSizeBytes * 1.1) {
        response.resume();
        file.destroy();
        fail(new Error('Summary setup artifact is larger than the pinned expected size.'));
        return;
      }

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (expectedSizeBytes && downloaded > expectedSizeBytes * 1.1) {
          response.destroy(new Error('Summary setup artifact exceeded the pinned expected size.'));
          file.destroy();
          return;
        }
        if (total && typeof onProgress === 'function') {
          onProgress({ downloaded, total, percent: (downloaded / total) * 100 });
        }
      });

      response.on('error', fail);
      file.on('error', fail);
      file.on('finish', () => file.close(succeed));
      response.pipe(file);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Summary setup artifact download timed out.'));
    });
    request.on('error', fail);
  });
}

function extractZipArchive(archivePath, destinationDir) {
  const zip = archivePath && typeof archivePath.getEntries === 'function'
    ? archivePath
    : new AdmZip(archivePath);
  const resolvedDestination = path.resolve(destinationDir);
  for (const entry of zip.getEntries()) {
    const entryName = String(entry.entryName || '').replace(/\\/g, '/');
    if (!entryName || path.isAbsolute(entryName)) {
      throw new Error('Archive contains an unsafe absolute path.');
    }

    const resolvedEntryPath = path.resolve(resolvedDestination, entryName);
    if (resolvedEntryPath !== resolvedDestination && !resolvedEntryPath.startsWith(`${resolvedDestination}${path.sep}`)) {
      throw new Error('Archive contains an unsafe path traversal entry.');
    }
  }
  zip.extractAllTo(resolvedDestination, true);
}

function extractTarGzArchive(archivePath, destinationDir) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', archivePath, '-C', destinationDir], { windowsHide: true });
    let errorOutput = '';
    tar.stderr.on('data', (data) => { errorOutput += data.toString(); });
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(errorOutput.trim() || `Failed to extract llama.cpp runtime archive: tar exited with code ${code}.`));
    });
  });
}

async function extractRuntimeArchive(archivePath, destinationDir, archiveFormat) {
  if (archiveFormat === 'zip') {
    extractZipArchive(archivePath, destinationDir);
    return;
  }
  if (archiveFormat === 'tar.gz') {
    await extractTarGzArchive(archivePath, destinationDir);
    return;
  }

  throw new Error('Unsupported llama.cpp runtime archive format.');
}

function finalizeInstalledRuntimeExecutable({ userDataDir, artifact, runtimeArtifact, fsModule = fs }) {
  const executablePath = findRuntimeExecutablePath(
    getSummaryRuntimeExtractDir(userDataDir, artifact, runtimeArtifact),
    runtimeArtifact.executableName,
    fsModule,
  );
  const chmodSync = bindFsMethod(fsModule, 'chmodSync');
  if (!executablePath || !chmodSync) {
    return;
  }

  try {
    chmodSync(executablePath, 0o755);
  } catch (error) {
    // Best effort: Windows does not need POSIX execute bits.
  }
}

async function installSummaryRuntime({
  userDataDir,
  platform,
  arch,
  modelId,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  emitProgress,
  downloader = downloadFile,
  extractor = extractRuntimeArchive,
} = {}) {
  const artifact = getSummaryArtifactForPlatform(modelId, platform, arch, catalog);
  const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(platform, arch, catalog);
  const runtimeError = validateSummaryRuntimeArtifact(runtimeArtifact);
  if (runtimeError) {
    throw new Error(runtimeError);
  }

  const existingCache = checkSummaryRuntimeCache({ userDataDir, platform, arch, modelId, fsModule, catalog });
  if (existingCache.valid) {
    return existingCache;
  }

  const runtimeDir = getSummaryRuntimeDir(userDataDir, artifact);
  const extractDir = getSummaryRuntimeExtractDir(userDataDir, artifact, runtimeArtifact);
  const archiveDir = getSummaryRuntimeArchiveDir(userDataDir, artifact);
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  if (mkdirSync) {
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
  }
  const staleTopLevelExecutablePath = getSummaryRuntimeExecutablePath(userDataDir, artifact, runtimeArtifact);
  if (unlinkSync && bindFsMethod(fsModule, 'existsSync')?.(staleTopLevelExecutablePath)) {
    try {
      unlinkSync(staleTopLevelExecutablePath);
    } catch (cleanupError) {
      // Best effort: ignore stale executable cleanup failures.
    }
  }
  if (rmSync) {
    rmSync(extractDir, { recursive: true, force: true });
  }
  if (mkdirSync) {
    mkdirSync(extractDir, { recursive: true });
  }

  for (let index = 0; index < runtimeArtifact.artifacts.length; index += 1) {
    const runtimeArchive = runtimeArtifact.artifacts[index];
    const archivePath = getSummaryRuntimeArchivePath(userDataDir, artifact, runtimeArchive);
    const tempPath = `${archivePath}.download`;
    emitSafeProgress(emitProgress, {
      feature: 'summary',
      phase: 'downloading-runtime',
      message: 'Downloading local summary runtime.',
      modelId,
      percent: (index / runtimeArtifact.artifacts.length) * 100,
    });
    try {
      await downloader({
        url: runtimeArchive.downloadUrl,
        destinationPath: tempPath,
        expectedSizeBytes: runtimeArchive.sizeBytes,
        onProgress: (progress) => emitSafeProgress(emitProgress, {
          feature: 'summary',
          phase: 'downloading-runtime',
          message: 'Downloading local summary runtime.',
          percent: ((index + (progress.percent || 0) / 100) / runtimeArtifact.artifacts.length) * 100,
          modelId,
        }),
      });
    } catch (downloadError) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw downloadError;
    }

    const actualSha256 = await hashFileSha256(tempPath, fsModule);
    if (actualSha256 !== runtimeArchive.sha256) {
      if (unlinkSync) {
        unlinkSync(tempPath);
      }
      throw new Error('Downloaded llama.cpp runtime checksum does not match the pinned checksum.');
    }

    if (fsModule.renameSync) {
      fsModule.renameSync(tempPath, archivePath);
    }
    emitSafeProgress(emitProgress, {
      feature: 'summary',
      phase: 'extracting-runtime',
      message: 'Installing local summary runtime.',
      modelId,
    });
    await extractor(archivePath, extractDir, runtimeArchive.archiveFormat);
    if (unlinkSync) {
      try {
        unlinkSync(archivePath);
      } catch (cleanupError) {
        // Best effort cleanup: runtime archives are redownloadable from the pinned catalog.
      }
    }
  }

  finalizeInstalledRuntimeExecutable({ userDataDir, artifact, runtimeArtifact, fsModule });

  const runtimeCache = checkSummaryRuntimeCache({ userDataDir, platform, arch, modelId, fsModule, catalog });
  if (!runtimeCache.valid) {
    throw new Error(runtimeCache.reason || 'llama.cpp runtime installation did not produce the expected executable.');
  }

  return runtimeCache;
}

async function validateSummaryModel({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  profile,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  runtimeValidator,
} = {}) {
  const selectedModelId = resolveModelId('summary', modelId, catalog);
  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'validating',
    message: 'Validating local summary model.',
    modelId: selectedModelId,
  });

  const availability = getSummaryAvailability(platform, arch);
  const cache = await checkSummaryModelCache({
    userDataDir,
    platform,
    arch,
    modelId: selectedModelId,
    fsModule,
    catalog,
    verifyChecksum: true,
  });
  const runtimeCache = checkSummaryRuntimeCache({
    userDataDir,
    platform,
    arch,
    modelId: selectedModelId,
    fsModule,
    catalog,
  });
  let status = cache.valid ? 'ready' : 'error';
  let message = cache.valid ? 'Local summary model is ready.' : cache.reason;

  if (!availability.supported) {
    status = 'unsupported';
    message = availability.reason;
  } else if (cache.valid && !runtimeCache.valid) {
    status = runtimeCache.validationStatus === 'pendingPinnedRuntime' ? 'error' : 'notConfigured';
    message = runtimeCache.reason;
  } else if (!cache.installed) {
    status = 'notConfigured';
  } else if (cache.valid && runtimeCache.valid && typeof runtimeValidator === 'function') {
    try {
      await runtimeValidator({ modelId: selectedModelId, cache, runtimeCache });
    } catch (runtimeError) {
      status = 'error';
      message = runtimeError.message || 'llama.cpp runtime smoke validation failed.';
    }
  }

  updateManifestFeature({
    userDataDir,
    feature: 'summary',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status,
      modelId: selectedModelId,
      artifactId: cache.artifactId || null,
      profile,
      validation: createValidation(status, message, now),
      error: status === 'ready' ? null : message,
    }),
  });

  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: status,
    status,
    message,
    modelId: selectedModelId,
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
}

async function setupSummaryModel({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  profile,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  downloader = downloadFile,
  extractor = extractRuntimeArchive,
  runtimeValidator,
} = {}) {
  const selectedModelId = resolveModelId('summary', modelId, catalog);
  const artifact = getSummaryArtifactForPlatform(selectedModelId, platform, arch, catalog);
  const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(platform, arch, catalog);
  const availability = getSummaryAvailability(platform, arch);
  const artifactError = availability.supported ? validatePinnedSummarySetup({ artifact, runtimeArtifact }) : availability.reason;

  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'downloading',
    message: 'Checking local summary setup artifact.',
    modelId: selectedModelId,
  });

  if (artifactError) {
    const status = availability.supported ? 'error' : 'unsupported';
    updateManifestFeature({
      userDataDir,
      feature: 'summary',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status,
        modelId: selectedModelId,
        artifactId: artifact && artifact.artifactId,
        profile,
        validation: createValidation(status, artifactError, now),
        error: artifactError,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'summary', phase: status, status, message: artifactError, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  const cache = await checkSummaryModelCache({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog, verifyChecksum: true });
  const runtimeCache = checkSummaryRuntimeCache({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog });
  if (cache.valid && runtimeCache.valid) {
    return validateSummaryModel({ userDataDir, platform, arch, modelId: selectedModelId, profile, safeStorage, fsModule, catalog, now, emitProgress, runtimeValidator });
  }

  if (!runtimeCache.valid) {
    try {
      await installSummaryRuntime({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog, emitProgress, downloader, extractor });
    } catch (runtimeError) {
      const message = runtimeError.message || 'Local summary runtime setup failed.';
      updateManifestFeature({
        userDataDir,
        feature: 'summary',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'error',
          modelId: selectedModelId,
          artifactId: artifact && artifact.artifactId,
          profile,
          validation: createValidation('error', message, now),
          error: message,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }
  }

  if (!cache.valid) {
    const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
    const tempPath = `${artifactPath}.download`;
    const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
    const renameSync = bindFsMethod(fsModule, 'renameSync');
    const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
    if (mkdirSync) {
      mkdirSync(path.dirname(artifactPath), { recursive: true });
    }

    try {
      await downloader({
        url: artifact.downloadUrl,
        destinationPath: tempPath,
        expectedSizeBytes: artifact.estimatedSizeBytes,
        onProgress: (progress) => emitSafeProgress(emitProgress, {
          feature: 'summary',
          phase: 'downloading',
          message: 'Downloading local summary setup artifact.',
          percent: progress.percent,
          modelId: selectedModelId,
        }),
      });
    } catch (downloadError) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      const message = downloadError.message || 'Local summary model download failed.';
      updateManifestFeature({
        userDataDir,
        feature: 'summary',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'error',
          modelId: selectedModelId,
          artifactId: artifact.artifactId,
          profile,
          validation: createValidation('error', message, now),
          error: message,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    const actualSha256 = await hashFileSha256(tempPath, fsModule);
    if (actualSha256 !== artifact.sha256) {
      if (unlinkSync) {
        unlinkSync(tempPath);
      }
      const message = 'Downloaded summary setup artifact checksum does not match the pinned checksum.';
      updateManifestFeature({
        userDataDir,
        feature: 'summary',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'error',
          modelId: selectedModelId,
          artifactId: artifact.artifactId,
          profile,
          validation: createValidation('error', message, now),
          error: message,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    if (!renameSync) {
      throw new Error('File system does not support installing summary setup artifacts.');
    }
    renameSync(tempPath, artifactPath);
  }

  return validateSummaryModel({ userDataDir, platform, arch, modelId: selectedModelId, profile, safeStorage, fsModule, catalog, now, emitProgress, runtimeValidator });
}

async function removeSummaryModel({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
} = {}) {
  const selectedModelId = resolveModelId('summary', modelId, catalog);
  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'removing',
    message: 'Removing local summary model.',
    modelId: selectedModelId,
  });

  if (fsModule.rmSync) {
    fsModule.rmSync(getSummaryModelCacheDir(userDataDir, selectedModelId), { recursive: true, force: true });
  }

  updateManifestFeature({
    userDataDir,
    feature: 'summary',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status: 'notConfigured',
      modelId: selectedModelId,
      artifactId: null,
      validation: createValidation('notConfigured', 'Local summary model was removed.', now),
      error: null,
    }),
  });

  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'notConfigured',
    status: 'notConfigured',
    message: 'Local summary model was removed.',
    modelId: selectedModelId,
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
}

module.exports = {
  AI_ADDON_PROGRESS_CHANNEL,
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  checkSummaryModelCache,
  checkSummaryRuntimeCache,
  buildDiarizationDependencyInstallArgs,
  createAiAddonProgressEvent,
  extractZipArchive,
  getDiarizationTokenStatus,
  getDiarizationDependencySitePackagesDir,
  getDiarizationModelCacheDir,
  getSummaryArtifactPath,
  getSummaryModelCacheDir,
  getSummaryRuntimeArchivePath,
  getSummaryRuntimeDir,
  getSummaryRuntimeExecutablePath,
  isAllowedDownloadUrl,
  isLikelyHuggingFaceToken,
  installDiarizationDependencies,
  removeDiarizationSetup,
  removeSummaryModel,
  saveAiAddonManifest,
  setupDiarizationAddon,
  setupSummaryModel,
  summarizePipProgress,
  validateDiarizationSetup,
  validateSummaryModel,
};
