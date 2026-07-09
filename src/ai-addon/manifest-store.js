'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  AI_MODEL_CATALOG,
  buildAiAddonStatus,
  getAiAddonPaths,
  getDiarizationDependencyArtifactForPlatform,
  getSummaryArtifactForPlatform,
  getSummaryRuntimeArtifactForPlatform,
  loadAiAddonManifest,
  normalizeAiAddonManifest,
} = require('../ai-addon-state');
const { getDiarizationTokenStatus, isAllowedDownloadUrl } = require('./download-helpers');

const HASH_YIELD_BYTES = 8 * 1024 * 1024;

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

function normalizeMarkerStringList(values) {
  return Array.isArray(values)
    ? values.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
}

function areStringListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function getDiarizationSourceArtifactMarker(sourceArtifact) {
  return {
    package: String(sourceArtifact?.package || ''),
    version: String(sourceArtifact?.version || ''),
    fileName: String(sourceArtifact?.fileName || ''),
    sha256: String(sourceArtifact?.sha256 || ''),
  };
}

function doesDiarizationDependencyMarkerMatch(marker, artifact) {
  if (!marker || !artifact || marker.artifactId !== artifact.id) {
    return false;
  }

  const expectedRequirements = normalizeMarkerStringList(artifact.pip?.requirements);
  const markerRequirements = normalizeMarkerStringList(marker.requirements);
  if (!areStringListsEqual(markerRequirements, expectedRequirements)) {
    return false;
  }

  const expectedSourceArtifacts = (artifact.pip?.sourceArtifacts || []).map(getDiarizationSourceArtifactMarker);
  const markerSourceArtifacts = Array.isArray(marker.sourceArtifacts)
    ? marker.sourceArtifacts.map(getDiarizationSourceArtifactMarker)
    : [];
  return JSON.stringify(markerSourceArtifacts) === JSON.stringify(expectedSourceArtifacts);
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
  const hasSitePackages = Boolean(sitePackagesDir && existsSync && existsSync(sitePackagesDir));
  const markerMatches = Boolean(hasSitePackages && doesDiarizationDependencyMarkerMatch(marker, artifact));
  const installed = Boolean(hasSitePackages && markerMatches);
  const partial = Boolean(dependencyDir && existsSync && existsSync(dependencyDir) && !installed);
  const staleInstall = Boolean(hasSitePackages && marker && !markerMatches && !validationError);

  return {
    supported: Boolean(artifact),
    installed,
    partial,
    valid: installed && !validationError,
    validationStatus: validationError ? 'error' : installed ? 'ready' : 'notConfigured',
    reason: validationError
      || (installed ? null : staleInstall
        ? 'Speaker identification dependencies are out of date. Remove and reinstall speaker identification setup.'
        : 'Speaker identification dependencies are not installed.'),
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
    let stream;
    try {
      stream = createReadStream(filePath);
    } catch (error) {
      reject(error);
      return;
    }
    let bytesSinceYield = 0;
    let resuming = false;
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      bytesSinceYield += chunk.length;
      if (bytesSinceYield >= HASH_YIELD_BYTES && !resuming) {
        bytesSinceYield = 0;
        resuming = true;
        stream.pause();
        setImmediate(() => {
          resuming = false;
          stream.resume();
        });
      }
    });
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
    setupComplete: diarization.status === 'ready' && diarizationDependencyCache.valid,
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

function createValidation(status, message, now = () => new Date().toISOString()) {
  return {
    status,
    checkedAt: now(),
    message,
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

module.exports = {
  saveAiAddonManifest,
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  checkSummaryModelCache,
  checkSummaryRuntimeCache,
  getDiarizationDependencySitePackagesDir,
  getDiarizationModelCacheDir,
  getSummaryArtifactPath,
  getSummaryModelCacheDir,
  getSummaryRuntimeArchivePath,
  getSummaryRuntimeDir,
  getSummaryRuntimeExecutablePath,
  // Private helpers used by setup flows / other ai-addon modules
  bindFsMethod,
  loadManifest,
  writeFileAtomicSync,
  updateManifestFeature,
  getDiarizationDependencyDir,
  getDiarizationDependencyMarkerPath,
  cleanupStaleDiarizationDependencyDirs,
  getSummaryRuntimeExtractDir,
  getSummaryRuntimeArchiveDir,
  findRuntimeExecutablePath,
  hashFileSha256,
  isPinnedSha256,
  validateDiarizationDependencyArtifact,
  validateSummaryRuntimeArtifact,
  validateSummarySetupArtifact,
  validatePinnedSummarySetup,
  createValidation,
  buildFeatureUpdates,
};
