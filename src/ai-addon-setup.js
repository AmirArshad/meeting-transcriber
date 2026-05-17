const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');
const AdmZip = require('adm-zip');
const { redactSensitiveText, SENSITIVE_PROGRESS_KEY_SET } = require('./ai-progress-sanitizer');

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
const DOWNLOAD_TIMEOUT_MS = 300000;
const MAX_DOWNLOAD_REDIRECTS = 5;
const AI_ADDON_CANCEL_CODE = 'AI_ADDON_SETUP_CANCELLED';
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

function cleanupStaleDiarizationDependencyDirs({ userDataDir, artifact, fsModule = fs } = {}) {
  const dependencyRoot = getAiAddonPaths(userDataDir).diarizationDependencyCacheDir;
  const currentDirName = safePathSegment(artifact && artifact.id);
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const readdirSync = bindFsMethod(fsModule, 'readdirSync');
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  if (!dependencyRoot || !currentDirName || !existsSync || !readdirSync || !rmSync || !existsSync(dependencyRoot)) {
    return;
  }

  for (const entry of readdirSync(dependencyRoot, { withFileTypes: true })) {
    const entryName = String(entry.name || '');
    if (!entryName || entryName === currentDirName) {
      continue;
    }

    const entryPath = path.join(dependencyRoot, entryName);
    const isDirectory = typeof entry.isDirectory === 'function' ? entry.isDirectory() : true;
    if (isDirectory) {
      rmSync(entryPath, { recursive: true, force: true });
    }
  }
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
  return redactSensitiveText(message)
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
  if (Number.isFinite(input.downloadedBytes) && input.downloadedBytes >= 0) {
    event.downloadedBytes = Math.floor(input.downloadedBytes);
  }
  if (Number.isFinite(input.totalBytes) && input.totalBytes > 0) {
    event.totalBytes = Math.floor(input.totalBytes);
  }
  if (event.totalBytes && event.downloadedBytes > event.totalBytes) {
    event.downloadedBytes = event.totalBytes;
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

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function clampBytes(value, maxValue) {
  const bytes = Math.max(0, Math.floor(Number(value) || 0));
  const maxBytes = Math.max(0, Math.floor(Number(maxValue) || 0));
  return maxBytes > 0 ? Math.min(bytes, maxBytes) : bytes;
}

function createAiAddonCancelError(message = 'AI add-on setup was canceled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = AI_ADDON_CANCEL_CODE;
  return error;
}

function forceKillChildProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      return;
    }
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        if (child.exitCode === null && !child.signalCode) {
          child.kill('SIGKILL');
        }
      } catch (killError) {
        // Best effort cleanup only.
      }
    }, 2000).unref?.();
  } catch (killError) {
    // Best effort cleanup only.
  }
}

function isAiAddonCancelError(error) {
  return Boolean(error && (error.code === AI_ADDON_CANCEL_CODE || error.name === 'AbortError'));
}

function throwIfAiAddonCanceled(cancelSignal, message) {
  if (cancelSignal && cancelSignal.aborted) {
    throw createAiAddonCancelError(message);
  }
}

function onAiAddonCancel(cancelSignal, callback) {
  if (!cancelSignal || typeof cancelSignal.addEventListener !== 'function') {
    return () => {};
  }

  const handleAbort = () => callback(createAiAddonCancelError());
  cancelSignal.addEventListener('abort', handleAbort, { once: true });
  return () => cancelSignal.removeEventListener('abort', handleAbort);
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
  const estimatedInstalledBytes = (estimatedModelBytes || 0) + (estimatedRuntimeBytes || 0) || null;

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
  for (const sourceArtifact of artifact.pip.sourceArtifacts || []) {
    if (!sourceArtifact.fileName || !sourceArtifact.url || !isPinnedSha256(sourceArtifact.sha256)) {
      return 'Speaker identification dependency source artifact metadata is incomplete.';
    }
    if (!isAllowedDownloadUrl(sourceArtifact.url)) {
      return 'Speaker identification dependency source artifact host is not allowed.';
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
  const partial = Boolean(dependencyDir && existsSync && existsSync(dependencyDir) && !installed);

  return {
    supported: Boolean(artifact),
    installed,
    partial,
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
  const partial = Boolean(runtimeDir && existsSync && existsSync(runtimeDir) && !installed);

  return {
    supported: Boolean(artifact && runtimeArtifact),
    installed,
    partial,
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
  const partial = Boolean(modelCacheDir && existsSync && existsSync(modelCacheDir) && !installed);

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
    partial,
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

  if (!isPinnedSha256(artifact.sha256)) {
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
  let summaryCache = await checkSummaryModelCache({
    userDataDir,
    platform,
    arch,
    modelId: status.features.summary.modelId,
    fsModule,
    catalog,
    verifyChecksum: verifyChecksums,
  });
  const summaryValidationText = [
    status.features.summary.error,
    status.features.summary.lastValidation && status.features.summary.lastValidation.message,
  ].filter(Boolean).join(' ');
  if (!verifyChecksums && status.features.summary.status === 'error' && summaryCache.installed && summaryCache.checksumStatus === 'notChecked' && /checksum/i.test(summaryValidationText)) {
    summaryCache = {
      ...summaryCache,
      valid: false,
      checksumStatus: 'mismatch',
      validationStatus: 'error',
      reason: status.features.summary.error || (status.features.summary.lastValidation && status.features.summary.lastValidation.message) || 'Summary model artifact checksum does not match the pinned checksum.',
    };
  }
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
    setupComplete: summary.status === 'ready' && summaryCache.valid === true && summaryCache.checksumStatus !== 'mismatch' && summaryRuntimeCache.valid === true,
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
  const installedSourceArtifacts = (pip.sourceArtifacts || [])
    .filter((sourceArtifact) => sourceArtifact && sourceArtifact.localPath);
  const sourceArtifactPaths = installedSourceArtifacts
    .map((sourceArtifact) => sourceArtifact.localPath)
    .filter(Boolean);
  const sourceArtifactPackages = new Set(installedSourceArtifacts
    .map((sourceArtifact) => String(sourceArtifact && sourceArtifact.package || '').toLowerCase())
    .filter(Boolean));
  const requirements = (pip.requirements || []).filter((requirement) => {
    const packageName = String(requirement || '').split(/[<>=!~\[]/)[0].trim().toLowerCase();
    return !sourceArtifactPackages.has(packageName);
  });
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
  const sourceBuildPackages = installedSourceArtifacts
    .map((sourceArtifact) => sourceArtifact && sourceArtifact.package)
    .filter(Boolean);
  if (sourceBuildPackages.length) {
    args.push(`--no-binary=${sourceBuildPackages.join(',')}`);
  }
  args.push(...requirements, ...sourceArtifactPaths);
  return args;
}

async function downloadDiarizationSourceArtifacts({ artifact, dependencyDir, downloader = downloadFile, fsModule = fs, emitProgress, cancelSignal } = {}) {
  const sourceArtifacts = artifact && artifact.pip && Array.isArray(artifact.pip.sourceArtifacts)
    ? artifact.pip.sourceArtifacts
    : [];
  if (!sourceArtifacts.length) {
    return artifact;
  }

  const sourceDir = path.join(dependencyDir, 'source-artifacts');
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const renameSync = bindFsMethod(fsModule, 'renameSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
  if (!mkdirSync || !renameSync) {
    throw new Error('File system does not support installing speaker identification source artifacts.');
  }
  mkdirSync(sourceDir, { recursive: true });

  const installedSourceArtifacts = [];
  for (let index = 0; index < sourceArtifacts.length; index += 1) {
    const sourceArtifact = sourceArtifacts[index];
    const artifactPath = path.join(sourceDir, sourceArtifact.fileName);
    const tempPath = `${artifactPath}.download`;
    emitSafeProgress(emitProgress, {
      feature: 'diarization',
      phase: 'downloading-dependencies',
      message: `Downloading pinned speaker dependency source artifact ${index + 1} of ${sourceArtifacts.length}.`,
      percent: 8 + Math.round((index / sourceArtifacts.length) * 10),
    });
    try {
      await downloader({
        url: sourceArtifact.url,
        destinationPath: tempPath,
        cancelSignal,
        onProgress: (progress) => emitSafeProgress(emitProgress, {
          feature: 'diarization',
          phase: 'downloading-dependencies',
          message: `Downloading pinned speaker dependency source artifact ${index + 1} of ${sourceArtifacts.length}.`,
          percent: 8 + Math.round(((index + ((progress.percent || 0) / 100)) / sourceArtifacts.length) * 10),
          downloadedBytes: progress.downloaded,
          totalBytes: progress.total,
        }),
      });
      const actualSha256 = await hashFileSha256(tempPath, fsModule);
      if (actualSha256 !== sourceArtifact.sha256) {
        throw new Error(`Pinned speaker dependency source artifact checksum mismatch for ${sourceArtifact.fileName}.`);
      }
      renameSync(tempPath, artifactPath);
      installedSourceArtifacts.push({ ...sourceArtifact, localPath: artifactPath });
    } catch (error) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw error;
    }
  }

  return {
    ...artifact,
    pip: {
      ...artifact.pip,
      sourceArtifacts: installedSourceArtifacts,
    },
  };
}

function summarizePipProgress(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const relevantLine = [...lines].reverse().find((line) => /^(Collecting|Downloading|Installing|Successfully installed|Building wheel|Using cached)/.test(line));
  return relevantLine || null;
}

function installDiarizationDependenciesWithPip({ pythonExe = 'python', artifact, targetDir, onProgress, cancelSignal } = {}) {
  return new Promise((resolve, reject) => {
    if (cancelSignal && cancelSignal.aborted) {
      reject(createAiAddonCancelError('Speaker identification setup was canceled.'));
      return;
    }

    const child = spawn(pythonExe, buildDiarizationDependencyInstallArgs({ artifact, targetDir }), { windowsHide: true });
    const maxBufferedOutput = 64 * 1024;
    let errorOutput = '';
    let settled = false;
    let cancelError = null;
    let cancelFallbackTimer = null;

    const cleanupCancel = onAiAddonCancel(cancelSignal, (abortError) => {
      if (settled || cancelError) {
        return;
      }
      cancelError = abortError;
      forceKillChildProcess(child);
      cancelFallbackTimer = setTimeout(() => finish(reject, cancelError), 5000);
      cancelFallbackTimer.unref?.();
    });

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (cancelFallbackTimer) {
        clearTimeout(cancelFallbackTimer);
      }
      cleanupCancel();
      callback(value);
    };

    const handleOutput = (data) => {
      const text = data.toString();
      errorOutput += text;
      if (errorOutput.length > maxBufferedOutput) {
        errorOutput = errorOutput.slice(-maxBufferedOutput);
      }
      const message = summarizePipProgress(text);
      if (message && typeof onProgress === 'function') {
        onProgress(message);
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (cancelError) {
        finish(reject, cancelError);
        return;
      }
      if (code === 0) {
        finish(resolve, { success: true });
        return;
      }
      const reason = errorOutput.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
      finish(reject, new Error(reason || `Speaker identification dependency install failed with code ${code}.`));
    });
  });
}

function checkMacOSCompilerToolchain({ platform = process.platform, execFileFn = execFile } = {}) {
  if (platform !== 'darwin') {
    return Promise.resolve({ available: true, skipped: true });
  }

  return new Promise((resolve) => {
    execFileFn('xcode-select', ['-p'], { timeout: 10000 }, (xcodeError) => {
      if (xcodeError) {
        resolve({ available: false, reason: 'xcode-select' });
        return;
      }
      execFileFn('cc', ['--version'], { timeout: 10000 }, (compilerError) => {
        resolve(compilerError
          ? { available: false, reason: 'cc' }
          : { available: true });
      });
    });
  });
}

async function assertDiarizationSourceBuildToolchain({ platform = process.platform, artifact, toolchainChecker = checkMacOSCompilerToolchain } = {}) {
  const hasCuratedSourceArtifacts = Boolean(artifact && artifact.pip && Array.isArray(artifact.pip.sourceArtifacts) && artifact.pip.sourceArtifacts.length > 0);
  if (platform !== 'darwin' || !artifact || !artifact.pip || (!artifact.pip.allowSourceBuilds && !hasCuratedSourceArtifacts)) {
    return;
  }

  const result = await toolchainChecker({ artifact, platform });
  if (!result || result.available !== true) {
    throw new Error('Speaker identification setup on macOS needs Apple Command Line Tools to build a source-only pyannote dependency. Install them with `xcode-select --install`, then try setup again.');
  }
}

function estimatePipDownloadPercent(message) {
  const text = String(message || '');
  if (/^Collecting\b/.test(text)) {
    return 12;
  }
  if (/^(Downloading|Using cached)\b/.test(text)) {
    return 45;
  }
  if (/^(Installing|Building wheel)\b/.test(text)) {
    return 70;
  }
  if (/^Successfully installed\b/.test(text)) {
    return 82;
  }
  return 30;
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
  downloader = downloadFile,
  dependencyInstaller = installDiarizationDependenciesWithPip,
  downloadSourceArtifacts = dependencyInstaller === installDiarizationDependenciesWithPip,
  toolchainChecker = checkMacOSCompilerToolchain,
  cancelSignal,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
  const artifact = getDiarizationDependencyArtifactForPlatform(platform, arch, catalog);
  const validationError = validateDiarizationDependencyArtifact(artifact);
  if (validationError) {
    throw new Error(validationError);
  }

  const dependencyDir = getDiarizationDependencyDir(userDataDir, artifact);
  const sitePackagesDir = getDiarizationDependencySitePackagesDir(userDataDir, artifact);
  const markerPath = getDiarizationDependencyMarkerPath(userDataDir, artifact);
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  cleanupStaleDiarizationDependencyDirs({ userDataDir, artifact, fsModule });

  const existingCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  if (existingCache.valid) {
    return existingCache;
  }

  if (mkdirSync) {
    mkdirSync(dependencyDir, { recursive: true });
  }
  if (unlinkSync && existsSync?.(markerPath)) {
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
    percent: 5,
  });

  try {
    const installArtifact = downloadSourceArtifacts
      ? await downloadDiarizationSourceArtifacts({
        artifact,
        dependencyDir,
        downloader,
        fsModule,
        emitProgress,
        cancelSignal,
      })
      : artifact;
    await assertDiarizationSourceBuildToolchain({ platform, artifact: installArtifact, toolchainChecker });
    await dependencyInstaller({
      pythonExe,
      artifact: installArtifact,
      targetDir: sitePackagesDir,
      cancelSignal,
      onProgress: (message) => emitSafeProgress(emitProgress, {
        feature: 'diarization',
        phase: 'downloading-dependencies',
        message,
        percent: estimatePipDownloadPercent(message),
      }),
    });
  } catch (error) {
    if (rmSync) {
      rmSync(sitePackagesDir, { recursive: true, force: true });
    }
    if (unlinkSync && existsSync?.(markerPath)) {
      unlinkSync(markerPath);
    }
    throw error;
  }

  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');

  writeFileAtomicSync(fsModule, markerPath, `${JSON.stringify({
    artifactId: artifact.id,
    package: artifact.package,
    version: artifact.version,
    requirements: artifact.pip.requirements,
    sourceArtifacts: (artifact.pip.sourceArtifacts || []).map((sourceArtifact) => ({
      package: sourceArtifact.package,
      version: sourceArtifact.version,
      fileName: sourceArtifact.fileName,
      sha256: sourceArtifact.sha256,
    })),
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
  cancelSignal,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Validating speaker identification setup.',
    percent: 85,
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
          await runtimeValidator({
            modelId,
            modelRef: getDiarizationModelRef(modelId, catalog),
            token,
            dependencyCache,
            requiredDevice: availability.runtimeDevice || null,
            cancelSignal,
          });
        } catch (runtimeError) {
          if (isAiAddonCancelError(runtimeError)) {
            throw runtimeError;
          }
          status = 'error';
          message = runtimeError.message || 'Speaker identification runtime validation failed.';
          error = message;
        }
      }
    } catch (validationError) {
      if (isAiAddonCancelError(validationError)) {
        throw validationError;
      }
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
    percent: status === 'ready' ? 100 : undefined,
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
  downloader = downloadFile,
  dependencyInstaller,
  downloadSourceArtifacts,
  toolchainChecker,
  cancelSignal,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Checking speaker identification setup.',
    percent: 0,
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
      status: 'downloading',
      modelId: selectedModelId,
      speakerCount,
      validation: createValidation('downloading', 'Speaker identification dependency installation started.', now),
      error: null,
    }),
  });

  const dependencyCacheBeforeInstall = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  const cleanupDownloadedDiarizationDependencies = () => {
    const artifact = getDiarizationDependencyArtifactForPlatform(platform, arch, catalog);
    const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
    const existsSync = bindFsMethod(fsModule, 'existsSync');
    const markerPath = artifact ? getDiarizationDependencyMarkerPath(userDataDir, artifact) : null;
    if (markerPath && unlinkSync && existsSync?.(markerPath)) {
      try {
        unlinkSync(markerPath);
      } catch (cleanupError) {
        // Best effort cleanup.
      }
    }
    if (dependencyCacheBeforeInstall.valid) {
      return;
    }
    const rmSync = bindFsMethod(fsModule, 'rmSync');
    if (artifact && rmSync) {
      rmSync(getDiarizationDependencyDir(userDataDir, artifact), { recursive: true, force: true });
    }
  };

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
      downloader,
      downloadSourceArtifacts,
      dependencyInstaller,
      toolchainChecker,
      cancelSignal,
    });
  } catch (dependencyError) {
    if (isAiAddonCancelError(dependencyError)) {
      const message = 'Speaker identification setup was canceled. Partial downloads were removed.';
      cleanupDownloadedDiarizationDependencies();
      updateManifestFeature({
        userDataDir,
        feature: 'diarization',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'notConfigured',
          modelId: selectedModelId,
          speakerCount,
          validation: createValidation('notConfigured', message, now),
          error: null,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

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

  try {
    throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
    return await validateDiarizationSetup({
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
      cancelSignal,
    });
  } catch (validationError) {
    if (!isAiAddonCancelError(validationError)) {
      throw validationError;
    }

    const message = 'Speaker identification setup was canceled. Partial downloads were removed.';
    cleanupDownloadedDiarizationDependencies();
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'notConfigured',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('notConfigured', message, now),
        error: null,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }
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
  if (!isPinnedSha256(artifact.sha256)) {
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

function isHuggingFaceSummaryArtifact(artifact) {
  return Boolean(artifact && artifact.source && artifact.source.provider === 'huggingface' && artifact.source.repo && artifact.source.revision && artifact.source.fileName);
}

function buildPythonEnvForBackend({ backendPath, extra = {} } = {}) {
  const separator = process.platform === 'win32' ? ';' : ':';
  const existingPythonPath = process.env.PYTHONPATH || '';
  const pythonPathParts = [backendPath, existingPythonPath].filter(Boolean);
  return {
    ...process.env,
    ...extra,
    PYTHONPATH: pythonPathParts.join(separator),
  };
}

async function downloadHuggingFaceSummaryArtifact({ artifact, destinationPath, expectedSizeBytes, userDataDir, pythonExe, backendPath, onProgress, cancelSignal, fsModule = fs }) {
  const spawnProcess = fsModule.__spawn || spawn;
  if (!isHuggingFaceSummaryArtifact(artifact)) {
    throw new Error('Summary model artifact is not a pinned Hugging Face source.');
  }
  if (!pythonExe || !backendPath) {
    throw new Error('Bundled Python is not available for Hugging Face summary model downloads.');
  }

  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  const source = artifact.source;
  const cacheRoot = path.join(getAiAddonPaths(userDataDir).rootDir, 'huggingface-cache');
  const destinationRoot = path.dirname(path.resolve(destinationPath));
  const args = [
    '-m', 'summaries.hf_model_downloader',
    '--repo', source.repo,
    '--revision', source.revision,
    '--filename', source.fileName,
    '--destination', destinationPath,
    '--destination-root', destinationRoot,
    '--expected-size', String(expectedSizeBytes || source.sizeBytes || 0),
    '--expected-sha256', artifact.sha256,
    '--cache-root', cacheRoot,
  ];

  await new Promise((resolve, reject) => {
    let settled = false;
    let cancelError = null;
    let cancelFallbackTimer = null;
    let stdoutBuffer = '';
    let stderrOutput = '';
    const child = spawnProcess(pythonExe, args, {
      cwd: backendPath,
      windowsHide: true,
      env: buildPythonEnvForBackend({
        backendPath,
        extra: {
          HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          DO_NOT_TRACK: '1',
          HF_HUB_DISABLE_PROGRESS_BARS: '1',
        },
      }),
    });
    const cleanupCancel = onAiAddonCancel(cancelSignal, (abortError) => {
      if (settled || cancelError) {
        return;
      }
      cancelError = abortError;
      forceKillChildProcess(child);
      cleanupCancel?.();
      cancelFallbackTimer = setTimeout(() => {
        finish(reject, cancelError);
      }, 5000);
      cancelFallbackTimer.unref?.();
    });
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (cancelFallbackTimer) {
        clearTimeout(cancelFallbackTimer);
      }
      cleanupCancel?.();
      callback(value);
    };
    const handleStdoutLine = (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line);
        if ((event.type === 'progress' || event.type === 'result') && typeof onProgress === 'function') {
          onProgress({
            downloaded: event.downloadedBytes,
            total: event.totalBytes || expectedSizeBytes,
            percent: event.percent,
          });
        }
      } catch (error) {
        // Ignore non-JSON helper output; stderr is summarized on failure.
      }
    };
    child.stdout.on('data', (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        handleStdoutLine(line);
      }
    });
    child.stderr.on('data', (data) => { stderrOutput += data.toString(); });
    child.on('error', (error) => finish(reject, cancelError || error));
    child.on('close', (code) => {
      if (stdoutBuffer) {
        handleStdoutLine(stdoutBuffer);
      }
      if (cancelError) {
        finish(reject, cancelError);
        return;
      }
      if (code === 0) {
        finish(resolve);
        return;
      }
      const reason = stderrOutput.trim().split(/\r?\n/).filter(Boolean).pop() || `Hugging Face downloader exited with code ${code}.`;
      finish(reject, new Error(reason.replace(/^ERROR:\s*/i, '')));
    });
  });

  const existsSync = bindFsMethod(fsModule, 'existsSync');
  if (!existsSync || !existsSync(destinationPath)) {
    throw new Error('Hugging Face summary model download did not produce the expected artifact.');
  }
}

async function downloadFile({ url, destinationPath, expectedSizeBytes, onProgress, redirectCount = 0, timeoutMs = DOWNLOAD_TIMEOUT_MS, cancelSignal }) {
  throwIfAiAddonCanceled(cancelSignal, 'Download was canceled.');
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
    let request = null;
    let file = null;
    const removePartialFile = () => {
      try {
        if (destinationPath && fs.existsSync(destinationPath)) {
          fs.unlinkSync(destinationPath);
        }
      } catch (cleanupError) {
        // Best effort cleanup only.
      }
    };
    const closeAndRemovePartialFile = (done = () => {}) => {
      if (!file) {
        removePartialFile();
        done();
        return;
      }
      let cleanupDone = false;
      const finishCleanup = () => {
        if (cleanupDone) {
          return;
        }
        cleanupDone = true;
        removePartialFile();
        setTimeout(removePartialFile, 1000).unref?.();
        done();
      };
      file.once('close', finishCleanup);
      try {
        file.destroy();
      } catch (cleanupError) {
        // Best effort cleanup only.
      }
      setTimeout(finishCleanup, 250).unref?.();
    };
    const cleanupCancel = onAiAddonCancel(cancelSignal, (cancelError) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupCancel?.();
      if (request) {
        request.destroy(cancelError);
      }
      closeAndRemovePartialFile(() => reject(cancelError));
    });
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupCancel?.();
      closeAndRemovePartialFile(() => reject(error));
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanupCancel?.();
      resolve();
    };

    request = client.get(parsedUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsedUrl).toString();
        downloadFile({ url: nextUrl, destinationPath, expectedSizeBytes, onProgress, redirectCount: redirectCount + 1, timeoutMs, cancelSignal }).then(succeed, fail);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`Summary setup artifact download failed with HTTP ${response.statusCode}.`));
        return;
      }

      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      file = fs.createWriteStream(destinationPath);
      const total = Number(response.headers['content-length']) || Number(expectedSizeBytes) || null;
      let downloaded = 0;

      if (expectedSizeBytes && total && total > expectedSizeBytes * 1.1) {
        response.resume();
        fail(new Error('Summary setup artifact is larger than the pinned expected size.'));
        return;
      }

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (expectedSizeBytes && downloaded > expectedSizeBytes * 1.1) {
          response.destroy(new Error('Summary setup artifact exceeded the pinned expected size.'));
          return;
        }
        if (total && typeof onProgress === 'function') {
          onProgress({ downloaded, total, percent: Math.min((downloaded / total) * 100, 100) });
        }
      });

      response.on('error', (error) => fail(isAiAddonCancelError(error) ? error : new Error(`Summary setup artifact download stream failed: ${error.message}`)));
      file.on('error', (error) => fail(isAiAddonCancelError(error) ? error : new Error(`Could not write summary setup artifact: ${error.message}`)));
      file.on('finish', () => file.close(succeed));
      response.pipe(file);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Summary setup artifact download timed out.'));
    });
    request.on('error', (error) => {
      if (isAiAddonCancelError(error)) {
        fail(error);
        return;
      }
      fail(new Error(`Summary setup artifact download failed from ${getDownloadHost(parsedUrl.toString())}: ${error.message}`));
    });
  });
}

function extractZipArchive(archivePath, destinationDir) {
  const zip = archivePath && typeof archivePath.getEntries === 'function'
    ? archivePath
    : new AdmZip(archivePath);
  const resolvedDestination = path.resolve(destinationDir);
  fs.mkdirSync(resolvedDestination, { recursive: true });
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

function validateTarEntryName(entryName, destinationDir) {
  const normalizedEntryName = String(entryName || '').trim().replace(/\\/g, '/');
  if (!normalizedEntryName) {
    return;
  }
  if (normalizedEntryName.startsWith('/') || path.isAbsolute(normalizedEntryName)) {
    throw new Error('Archive contains an unsafe absolute path.');
  }

  const parts = normalizedEntryName.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Archive contains an unsafe path traversal entry.');
  }

  const resolvedDestination = path.resolve(destinationDir);
  const resolvedEntryPath = path.resolve(resolvedDestination, normalizedEntryName);
  if (resolvedEntryPath !== resolvedDestination && !resolvedEntryPath.startsWith(`${resolvedDestination}${path.sep}`)) {
    throw new Error('Archive contains an unsafe path traversal entry.');
  }
}

function parseTarListingLine(line) {
  const text = String(line || '').trim();
  if (!text) {
    return null;
  }

  const mode = text.slice(0, 10);
  const type = mode[0];
  const tokens = text.split(/\s+/);
  if (tokens.length < 6) {
    throw new Error('Runtime archive contains an unparseable tar listing entry.');
  }

  const timeIndex = tokens.findIndex((token, index) => index > 0 && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(token));
  const monthIndex = tokens.findIndex((token, index) => index > 0 && /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i.test(token));
  let nameStartIndex = timeIndex >= 0 ? timeIndex + 1 : -1;
  if (nameStartIndex < 0 && monthIndex >= 0 && tokens.length > monthIndex + 3) {
    nameStartIndex = monthIndex + 3;
  }
  if (nameStartIndex < 0 || nameStartIndex >= tokens.length) {
    throw new Error('Runtime archive contains an unparseable tar listing entry.');
  }
  let name = tokens.slice(nameStartIndex).join(' ');
  const linkIndex = name.indexOf(' -> ');
  const linkTarget = linkIndex >= 0 ? name.slice(linkIndex + 4) : null;
  if (linkIndex >= 0) {
    name = name.slice(0, linkIndex);
  }

  return { type, name, linkTarget };
}

function validateTarListing(listingOutput, destinationDir) {
  const entries = String(listingOutput || '').split(/\r?\n/).map(parseTarListingLine).filter(Boolean);
  if (!entries.length) {
    throw new Error('Runtime archive did not contain any extractable entries.');
  }

  for (const entry of entries) {
    validateTarEntryName(entry.name, destinationDir);
    if (!['-', 'd', 'l', 'x', 'g'].includes(entry.type)) {
      throw new Error('Archive contains an unsupported file type.');
    }
    if (entry.type === 'l') {
      if (!entry.linkTarget) {
        throw new Error('Archive contains an unsafe symlink entry.');
      }
      const linkTarget = String(entry.linkTarget).replace(/\\/g, '/');
      if (linkTarget.startsWith('/') || path.isAbsolute(linkTarget) || linkTarget.split('/').some((part) => part === '..')) {
        throw new Error('Archive contains an unsafe symlink entry.');
      }
      const linkBase = path.dirname(entry.name);
      validateTarEntryName(path.join(linkBase, linkTarget), destinationDir);
    }
  }
}

function runTarCommand(args) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', args, { windowsHide: true });
    let stdout = '';
    let errorOutput = '';
    tar.stdout.on('data', (data) => { stdout += data.toString(); });
    tar.stderr.on('data', (data) => { errorOutput += data.toString(); });
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(errorOutput.trim() || `Failed to inspect llama.cpp runtime archive: tar exited with code ${code}.`));
    });
  });
}

async function extractTarGzArchive(archivePath, destinationDir, tarRunner = runTarCommand) {
  const listingOutput = await tarRunner(['-tzvf', archivePath]);
  validateTarListing(listingOutput, destinationDir);
  await tarRunner(['-xzf', archivePath, '-C', destinationDir]);
}

async function extractRuntimeArchive(archivePath, destinationDir, archiveFormat) {
  if (archiveFormat === 'zip') {
    extractZipArchive(archivePath, destinationDir);
    return;
  }
  if (archiveFormat === 'tar.gz') {
    fs.mkdirSync(destinationDir, { recursive: true });
    await extractTarGzArchive(archivePath, destinationDir);
    return;
  }

  throw new Error(`Unsupported llama.cpp runtime archive format: ${archiveFormat || 'unknown'}.`);
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
  cancelSignal,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
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
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  if (mkdirSync) {
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
  }
  const staleTopLevelExecutablePath = getSummaryRuntimeExecutablePath(userDataDir, artifact, runtimeArtifact);
  if (unlinkSync && existsSync?.(staleTopLevelExecutablePath)) {
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
    const totalRuntimeBytes = runtimeArtifact.artifacts.reduce((total, archive) => total + (Number(archive.sizeBytes) || 0), 0);
    const completedRuntimeBytes = runtimeArtifact.artifacts
      .slice(0, index)
      .reduce((total, archive) => total + (Number(archive.sizeBytes) || 0), 0);
    emitSafeProgress(emitProgress, {
      feature: 'summary',
      phase: 'downloading-runtime',
      message: 'Downloading local summary runtime.',
      modelId,
      percent: clampPercent(totalRuntimeBytes ? (completedRuntimeBytes / totalRuntimeBytes) * 100 : (index / runtimeArtifact.artifacts.length) * 100),
      downloadedBytes: clampBytes(completedRuntimeBytes, totalRuntimeBytes),
      totalBytes: totalRuntimeBytes || undefined,
    });
    try {
      await downloader({
        url: runtimeArchive.downloadUrl,
        destinationPath: tempPath,
        expectedSizeBytes: runtimeArchive.sizeBytes,
        cancelSignal,
        onProgress: (progress) => emitSafeProgress(emitProgress, {
          feature: 'summary',
          phase: 'downloading-runtime',
          message: 'Downloading local summary runtime.',
          percent: clampPercent(totalRuntimeBytes
            ? ((completedRuntimeBytes + (progress.downloaded || 0)) / totalRuntimeBytes) * 100
            : ((index + (progress.percent || 0) / 100) / runtimeArtifact.artifacts.length) * 100),
          downloadedBytes: clampBytes(completedRuntimeBytes + (progress.downloaded || 0), totalRuntimeBytes || progress.total),
          totalBytes: totalRuntimeBytes || progress.total,
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

    try {
      throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
    } catch (cancelError) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw cancelError;
    }

    const actualSha256 = await hashFileSha256(tempPath, fsModule);
    if (actualSha256 !== runtimeArchive.sha256) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw new Error('Downloaded llama.cpp runtime checksum does not match the pinned checksum.');
    }

    if (!fsModule.renameSync) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw new Error('File system does not support installing summary runtime archives.');
    }
    fsModule.renameSync(tempPath, archivePath);
    emitSafeProgress(emitProgress, {
      feature: 'summary',
      phase: 'extracting-runtime',
      message: 'Installing local summary runtime.',
      modelId,
      percent: 95,
    });
    try {
      await extractor(archivePath, extractDir, runtimeArchive.archiveFormat);
    } catch (extractError) {
      if (rmSync) {
        rmSync(extractDir, { recursive: true, force: true });
      }
      if (unlinkSync) {
        try {
          unlinkSync(archivePath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw extractError;
    }
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
  cancelSignal,
} = {}) {
  const selectedModelId = resolveModelId('summary', modelId, catalog);
  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'validating',
    message: 'Validating local summary model.',
    modelId: selectedModelId,
    percent: 95,
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
      await runtimeValidator({ modelId: selectedModelId, cache, runtimeCache, cancelSignal });
    } catch (runtimeError) {
      if (isAiAddonCancelError(runtimeError)) {
        throw runtimeError;
      }
      status = 'error';
      message = runtimeError.message || 'Local summary runtime validation failed.';
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
    percent: status === 'ready' ? 100 : undefined,
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, verifyChecksums: true });
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
  huggingFaceDownloader = downloadHuggingFaceSummaryArtifact,
  extractor = extractRuntimeArchive,
  runtimeValidator,
  pythonExe,
  backendPath,
  cancelSignal,
} = {}) {
  const selectedModelId = resolveModelId('summary', modelId, catalog);
  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  const artifact = getSummaryArtifactForPlatform(selectedModelId, platform, arch, catalog);
  const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(platform, arch, catalog);
  const availability = getSummaryAvailability(platform, arch);
  const artifactError = availability.supported ? validatePinnedSummarySetup({ artifact, runtimeArtifact }) : availability.reason;

  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'downloading',
    message: 'Checking local summary setup artifact.',
    modelId: selectedModelId,
    percent: 0,
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
  const hadValidModelBeforeSetup = cache.valid;
  const hadValidRuntimeBeforeSetup = runtimeCache.valid;
  const cleanupDownloadedSummaryArtifacts = ({ includeModel = !hadValidModelBeforeSetup, includeRuntime = !hadValidRuntimeBeforeSetup } = {}) => {
    const rmSync = bindFsMethod(fsModule, 'rmSync');
    const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
    if (unlinkSync && artifact) {
      try {
        unlinkSync(`${getSummaryArtifactPath(userDataDir, artifact)}.download`);
      } catch (cleanupError) {
        // Best effort cleanup.
      }
    }
    if (!rmSync) {
      return;
    }
    if (includeRuntime) {
      rmSync(getSummaryRuntimeDir(userDataDir, artifact), { recursive: true, force: true });
    }
    if (includeModel) {
      rmSync(getSummaryModelCacheDir(userDataDir, selectedModelId), { recursive: true, force: true });
    }
  };
  if (cache.valid && runtimeCache.valid) {
    try {
      return await validateSummaryModel({ userDataDir, platform, arch, modelId: selectedModelId, profile, safeStorage, fsModule, catalog, now, emitProgress, runtimeValidator, cancelSignal });
    } catch (validationError) {
      if (isAiAddonCancelError(validationError)) {
        const message = 'Summary model setup was canceled. Existing local model and runtime were kept.';
        cleanupDownloadedSummaryArtifacts({ includeModel: false, includeRuntime: false });
        updateManifestFeature({
          userDataDir,
          feature: 'summary',
          fsModule,
          catalog,
          updates: buildFeatureUpdates({
            status: 'ready',
            modelId: selectedModelId,
            artifactId: artifact && artifact.artifactId,
            profile,
            validation: createValidation('ready', message, now),
            error: null,
          }),
        });
        emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'ready', message, modelId: selectedModelId, percent: 100 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
      }
      throw validationError;
    }
  }

  if (!runtimeCache.valid) {
    try {
      await installSummaryRuntime({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog, emitProgress, downloader, extractor, cancelSignal });
    } catch (runtimeError) {
      if (isAiAddonCancelError(runtimeError)) {
        const message = 'Summary model setup was canceled. Partial downloads were removed.';
        updateManifestFeature({
          userDataDir,
          feature: 'summary',
          fsModule,
          catalog,
          updates: buildFeatureUpdates({
            status: 'notConfigured',
            modelId: selectedModelId,
            artifactId: artifact && artifact.artifactId,
            profile,
            validation: createValidation('notConfigured', message, now),
            error: null,
          }),
        });
        cleanupDownloadedSummaryArtifacts({ includeModel: false, includeRuntime: !hadValidRuntimeBeforeSetup });
        emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
      }

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

  const runtimeCacheAfterInstall = checkSummaryRuntimeCache({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog });

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
      const selectedDownloader = isHuggingFaceSummaryArtifact(artifact) && pythonExe && backendPath
        ? (options) => huggingFaceDownloader({ ...options, artifact, userDataDir, pythonExe, backendPath, fsModule })
        : downloader;
      await selectedDownloader({
        url: artifact.downloadUrl,
        destinationPath: tempPath,
        expectedSizeBytes: artifact.estimatedSizeBytes,
        cancelSignal,
        onProgress: (progress) => emitSafeProgress(emitProgress, {
          feature: 'summary',
          phase: 'downloading',
          message: isHuggingFaceSummaryArtifact(artifact)
            ? 'Downloading local summary model through Hugging Face accelerated transfer.'
            : 'Downloading local summary setup artifact.',
          percent: progress.percent,
          downloadedBytes: progress.downloaded,
          totalBytes: progress.total || artifact.estimatedSizeBytes,
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
      if (isAiAddonCancelError(downloadError)) {
        const message = 'Summary model setup was canceled. Partial downloads were removed.';
        updateManifestFeature({
          userDataDir,
          feature: 'summary',
          fsModule,
          catalog,
          updates: buildFeatureUpdates({
            status: 'notConfigured',
            modelId: selectedModelId,
            artifactId: hadValidModelBeforeSetup ? artifact.artifactId : null,
            profile,
            validation: createValidation('notConfigured', message, now),
            error: null,
          }),
        });
        cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
        emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
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
      cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    try {
      throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
    } catch (cancelError) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      const message = 'Summary model setup was canceled. Partial downloads were removed.';
      updateManifestFeature({
        userDataDir,
        feature: 'summary',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'notConfigured',
          modelId: selectedModelId,
          artifactId: hadValidModelBeforeSetup ? artifact.artifactId : null,
          profile,
          validation: createValidation('notConfigured', message, now),
          error: null,
        }),
      });
      cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    const actualSha256 = await hashFileSha256(tempPath, fsModule);
    if (actualSha256 !== artifact.sha256) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
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
      cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    if (!renameSync) {
      throw new Error('File system does not support installing summary setup artifacts.');
    }
    renameSync(tempPath, artifactPath);
  }

  try {
    const status = await validateSummaryModel({ userDataDir, platform, arch, modelId: selectedModelId, profile, safeStorage, fsModule, catalog, now, emitProgress, runtimeValidator, cancelSignal });
    if (status.features.summary.status !== 'ready' && !hadValidRuntimeBeforeSetup && runtimeCacheAfterInstall.valid) {
      const rmSync = bindFsMethod(fsModule, 'rmSync');
      if (rmSync) {
        rmSync(getSummaryRuntimeDir(userDataDir, artifact), { recursive: true, force: true });
      }
    }
    return status;
  } catch (validationError) {
    if (isAiAddonCancelError(validationError)) {
      const status = hadValidModelBeforeSetup && hadValidRuntimeBeforeSetup ? 'ready' : 'notConfigured';
      const percent = status === 'ready' ? 100 : 0;
      const message = hadValidModelBeforeSetup && hadValidRuntimeBeforeSetup
        ? 'Summary model setup was canceled. Existing local model and runtime were kept.'
        : 'Summary model setup was canceled. Partial downloads were removed.';
      cleanupDownloadedSummaryArtifacts({ includeModel: status !== 'ready', includeRuntime: status !== 'ready' });
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
          validation: createValidation(status, message, now),
          error: null,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status, message, modelId: selectedModelId, percent });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }
    throw validationError;
  }
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
  AI_ADDON_CANCEL_CODE,
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  checkMacOSCompilerToolchain,
  checkSummaryModelCache,
  checkSummaryRuntimeCache,
  buildDiarizationDependencyInstallArgs,
  createAiAddonProgressEvent,
  downloadFile,
  downloadHuggingFaceSummaryArtifact,
  extractZipArchive,
  extractTarGzArchive,
  validateTarListing,
  getDiarizationTokenStatus,
  getDiarizationDependencySitePackagesDir,
  getDiarizationModelCacheDir,
  getSummaryArtifactPath,
  getSummaryModelCacheDir,
  getSummaryRuntimeArchivePath,
  getSummaryRuntimeDir,
  getSummaryRuntimeExecutablePath,
  isAllowedDownloadUrl,
  isAiAddonCancelError,
  isLikelyHuggingFaceToken,
  installDiarizationDependencies,
  downloadDiarizationSourceArtifacts,
  removeDiarizationSetup,
  removeSummaryModel,
  saveAiAddonManifest,
  setupDiarizationAddon,
  setupSummaryModel,
  summarizePipProgress,
  validateDiarizationSetup,
  validateSummaryModel,
};
