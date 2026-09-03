'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  AI_MODEL_CATALOG,
  buildAiAddonStatus,
  getAiAddonPaths,
  getDiarizationDependencyArtifactForPlatform,
  getSpeakrsSetupArtifactsForPlatform,
  getSummaryArtifactForPlatform,
  getSummaryRuntimeArtifactForPlatform,
  loadAiAddonManifest,
  normalizeAiAddonManifest,
} = require('../ai-addon-state');
const {
  SPEAKRS_DIARIZATION_ENGINES,
  SPEAKRS_MODEL_PACK_REVISION,
  SPEAKRS_ORT_SO_NAMES,
  getSpeakrsExtractedRuntimeDllPins,
  getSpeakrsRequiredRuntimeLibraryNames,
  resolveContainedSpeakrsPath,
} = require('./speakrs-pack-spec');
const {
  getManagedLinuxCudaLibraryDirs,
  getManagedLinuxCudaRuntimeTarget,
} = require('../main-process/cuda-runtime-helpers');
const {
  buildContainedLinuxCudaLibraryPath,
  isWorldWritableMode,
  lstatRejectSymlink,
  resolveRequiredLinuxCudaLibraryPath,
  resolveLinuxCudaDriverLibraryDirs,
  validateLinuxCudaManagedRoot,
} = require('../main-process/linux-cuda-runtime-helpers');
const {
  getLinuxCudaDriverLibraryAllowlist,
  getLinuxCudaRequiredLibraries,
} = require('../main-process/linux-cuda-runtime-catalog');
const {
  SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
  getPackagedSpeakrsIntegrityError,
  inspectPackagedSpeakrsLayout,
} = require('./speakrs-cli-integrity');
const { getDiarizationTokenStatus, isAllowedDownloadUrl } = require('./download-helpers');

const HASH_YIELD_BYTES = 8 * 1024 * 1024;
const HUGGING_FACE_ENV_KEY_PATTERN = /^(HF_|HUGGINGFACE_|HUGGING_FACE_|TRANSFORMERS_)/i;
const HUGGING_FACE_ENV_KEYS = Object.freeze([
  'HF_HOME',
  'HF_HUB_CACHE',
  'HUGGINGFACE_HUB_CACHE',
  'TRANSFORMERS_CACHE',
  'TRANSFORMERS_OFFLINE',
  'HF_HUB_OFFLINE',
  'HF_TOKEN',
  'HUGGINGFACE_HUB_TOKEN',
  'HUGGING_FACE_HUB_TOKEN',
  'HF_TOKEN_PATH',
  'HF_ENDPOINT',
  'HF_HUB_ENABLE_HF_TRANSFER',
  'HF_HUB_DISABLE_TELEMETRY',
  'HF_HUB_DISABLE_XET',
  'HF_XET_CACHE',
  'HF_HUB_VERBOSITY',
]);

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

function getSpeakrsModelCacheDir(userDataDir) {
  return getAiAddonPaths(userDataDir).speakrsModelCacheDir;
}

function getSpeakrsOrtRuntimeDir(userDataDir) {
  return getAiAddonPaths(userDataDir).speakrsOrtRuntimeDir;
}

function getSpeakrsModelRevisionDir(userDataDir, revision = SPEAKRS_MODEL_PACK_REVISION) {
  return path.join(getSpeakrsModelCacheDir(userDataDir), safePathSegment(revision));
}

function getSpeakrsSourceFilePath(userDataDir, file, revision = SPEAKRS_MODEL_PACK_REVISION) {
  if (!file || !file.path) {
    return null;
  }
  return resolveContainedSpeakrsPath(getSpeakrsModelRevisionDir(userDataDir, revision), file.path);
}

function getSpeakrsCliExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'speakrs-cli.exe' : 'speakrs-cli';
}

function getBundledSpeakrsCliPath({
  platform = process.platform,
  resourcesPath = process.resourcesPath,
} = {}) {
  if (!resourcesPath) {
    return null;
  }
  return path.join(resourcesPath, 'bin', getSpeakrsCliExecutableName(platform));
}

function isNativeSpeakrsCliPath(cliPath, platform = process.platform) {
  if (!cliPath || typeof cliPath !== 'string') {
    return false;
  }
  const baseName = path.basename(cliPath);
  if (baseName.toLowerCase().endsWith('.py')) {
    return false;
  }
  return baseName === getSpeakrsCliExecutableName(platform);
}

function resolveSpeakrsCliPath({
  platform = process.platform,
  env = process.env,
  fsModule = fs,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, '..', '..'),
} = {}) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  if (!existsSync) {
    return null;
  }
  const executableName = getSpeakrsCliExecutableName(platform);
  const packaged = env?.AVANEVIS_PACKAGED === '1';
  const packagedCandidate = getBundledSpeakrsCliPath({ platform, resourcesPath });
  if (packaged) {
    return packagedCandidate && existsSync(packagedCandidate) ? packagedCandidate : null;
  }
  const candidates = [];
  if (env && typeof env.SPEAKRS_CLI_PATH === 'string' && env.SPEAKRS_CLI_PATH.trim()) {
    candidates.push(env.SPEAKRS_CLI_PATH.trim());
  }
  if (packagedCandidate) {
    candidates.push(packagedCandidate);
  }
  if (projectRoot) {
    candidates.push(path.join(projectRoot, 'native', 'speakrs-cli', 'target', 'release', executableName));
  }
  for (const pathDir of String(env?.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(pathDir, executableName));
  }
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function getSpeakrsCliMissingMessage(env = process.env) {
  return env?.AVANEVIS_PACKAGED === '1'
    ? SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE
    : 'Speakrs CLI is not available.';
}

function getPackagedSpeakrsCliPreflightError({
  engine,
  env = process.env,
  platform = process.platform,
  resourcesPath = process.resourcesPath,
  fsModule = fs,
  applyQaOverride = true,
} = {}) {
  const resolvedEngine = applyQaOverride
    ? resolveSpawnDiarizationEngine(engine, env)
    : (engine === 'speakrs' || engine === 'pyannote' ? engine : null);
  if (resolvedEngine !== 'speakrs' || env?.AVANEVIS_PACKAGED !== '1') {
    return null;
  }
  return getPackagedSpeakrsIntegrityError({ platform, resourcesPath, fsModule });
}

function resolveSpeakrsCliPathForSpawn({
  platform = process.platform,
  env = process.env,
  fsModule = fs,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, '..', '..'),
} = {}) {
  const packaged = env?.AVANEVIS_PACKAGED === '1';
  const bundled = getBundledSpeakrsCliPath({ platform, resourcesPath });
  if (packaged) {
    return bundled;
  }
  return resolveSpeakrsCliPath({ platform, env, fsModule, resourcesPath, projectRoot }) || bundled;
}

function resolveSpawnDiarizationEngine(manifestEngine, env = process.env) {
  const qaEngine = String(env?.AVANEVIS_DIARIZATION_ENGINE || '').trim().toLowerCase();
  if (SPEAKRS_DIARIZATION_ENGINES.includes(qaEngine)) {
    return qaEngine;
  }
  const engine = String(manifestEngine || '').trim().toLowerCase();
  return SPEAKRS_DIARIZATION_ENGINES.includes(engine) ? engine : null;
}

function assertLinuxSpeakrsOnlyEngine(engine, platform = process.platform) {
  if (platform === 'linux' && engine !== 'speakrs') {
    const error = new Error('Pyannote speaker identification is not available on Linux in this version.');
    error.code = 'LINUX_PYANNOTE_UNAVAILABLE';
    throw error;
  }
  return engine;
}

function resolveSpeakrsMode(requiredDevice, env = process.env) {
  const raw = String(requiredDevice || '').trim().toLowerCase();
  if (raw === 'cuda') {
    return 'cuda';
  }
  if (raw === 'mps' || raw === 'coreml') {
    return 'coreml';
  }
  const envMode = String(env?.SPEAKRS_MODE || '').trim().toLowerCase();
  if (envMode === 'cpu' || envMode === 'coreml' || envMode === 'cuda') {
    return envMode;
  }
  return null;
}

function canStartGuidedDiarization({
  status,
  setupComplete,
  engine,
  modelRef,
  env = process.env,
} = {}) {
  if (status !== 'ready' || !setupComplete) {
    return false;
  }
  const resolvedEngine = resolveSpawnDiarizationEngine(engine, env);
  if (resolvedEngine === 'speakrs') {
    return true;
  }
  return Boolean(modelRef);
}

function clearHuggingFaceEnvVars(target, extra = {}, env = process.env) {
  const keys = new Set(HUGGING_FACE_ENV_KEYS);
  for (const source of [extra, env, target]) {
    if (!source || typeof source !== 'object') {
      continue;
    }
    for (const key of Object.keys(source)) {
      if (HUGGING_FACE_ENV_KEY_PATTERN.test(key)) {
        keys.add(key);
      }
    }
  }
  for (const key of keys) {
    target[key] = undefined;
  }
  return target;
}

function linuxAllowlistedLibraryExists(fileName, fsModule = fs) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const realpathSync = bindFsMethod(fsModule, 'realpathSync') || fs.realpathSync;
  const statSync = bindFsMethod(fsModule, 'statSync');
  if (!fileName || !existsSync || !realpathSync || !statSync) {
    return false;
  }
  for (const dir of getLinuxCudaDriverLibraryAllowlist()) {
    const candidate = path.join(dir, fileName);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      const realFile = realpathSync(candidate);
      const stats = statSync(realFile);
      if (!stats || typeof stats.isFile !== 'function' || !stats.isFile()) {
        continue;
      }
      for (const allowed of getLinuxCudaDriverLibraryAllowlist()) {
        try {
          const realAllowed = realpathSync(allowed);
          const relative = path.relative(realAllowed, realFile);
          if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            return true;
          }
        } catch (_error) {
          // Candidate allowlist directory may be absent.
        }
      }
    } catch (_error) {
      continue;
    }
  }
  return false;
}

function buildSpeakrsLinuxLibraryPath({
  userDataDir,
  fsModule = fs,
} = {}) {
  const ortDir = getSpeakrsOrtRuntimeDir(userDataDir);
  const libraryDirs = [];
  const seen = new Set();
  const addDir = (candidate) => {
    if (!candidate || !path.isAbsolute(candidate)) {
      return;
    }
    try {
      const stats = lstatRejectSymlink(candidate, fsModule, 'Speakrs library directory');
      if (typeof stats.isDirectory === 'function' && !stats.isDirectory()) {
        return;
      }
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) {
        return;
      }
      seen.add(resolved);
      libraryDirs.push(resolved);
    } catch (_error) {
      // Missing or unsafe directories are omitted; ambient LD_LIBRARY_PATH stays cleared.
    }
  };

  addDir(ortDir);

  let managedPath = '';
  try {
    const managedRoot = getManagedLinuxCudaRuntimeTarget(userDataDir);
    const existsSync = bindFsMethod(fsModule, 'existsSync');
    const managedDirs = getManagedLinuxCudaLibraryDirs(managedRoot)
      .filter((candidate) => existsSync?.(candidate));
    if (managedDirs.length > 0) {
      let driverLibraryDirs = [];
      try {
        driverLibraryDirs = resolveLinuxCudaDriverLibraryDirs({ fsModule });
      } catch (_error) {
        driverLibraryDirs = [];
      }
      managedPath = buildContainedLinuxCudaLibraryPath({
        managedRoot,
        libraryDirs: managedDirs,
        driverLibraryDirs,
        fsModule,
      });
    }
  } catch (_error) {
    managedPath = '';
  }

  const parts = [
    ...libraryDirs,
    ...String(managedPath || '').split(path.delimiter).filter(Boolean),
  ];
  const unique = [];
  const uniqueSeen = new Set();
  for (const part of parts) {
    const normalized = path.normalize(part);
    if (!normalized || uniqueSeen.has(normalized)) {
      continue;
    }
    uniqueSeen.add(normalized);
    unique.push(part);
  }
  return unique.length > 0 ? unique.join(path.delimiter) : undefined;
}

function prependUniquePathEntry(currentPath, entry, delimiter = path.delimiter) {
  if (!entry) {
    return currentPath || '';
  }
  const parts = String(currentPath || '').split(delimiter).filter(Boolean);
  const normalizedEntry = path.normalize(entry);
  const filtered = parts.filter((part) => path.normalize(part) !== normalizedEntry);
  return [entry, ...filtered].join(delimiter);
}

function buildSpeakrsSpawnEnv({
  userDataDir,
  requiredDevice,
  platform = process.platform,
  env = process.env,
  fsModule = fs,
  resourcesPath = process.resourcesPath,
  projectRoot = path.join(__dirname, '..', '..'),
  extra = {},
  cliPath = null,
} = {}) {
  const packaged = env?.AVANEVIS_PACKAGED === '1';
  const bundledCliPath = getBundledSpeakrsCliPath({ platform, resourcesPath });
  // Packaged spawns pin Resources/bin exactly. Ignore cliPath, SPEAKRS_CLI_PATH,
  // PATH lookup, and native-named decoys — including missing bundled files.
  const resolvedCliPath = packaged
    ? bundledCliPath
    : (cliPath || resolveSpeakrsCliPathForSpawn({
      platform,
      env,
      fsModule,
      resourcesPath,
      projectRoot,
    }));
  const modelsDir = getSpeakrsModelRevisionDir(userDataDir);
  const mode = platform === 'linux'
    ? 'cuda'
    : resolveSpeakrsMode(requiredDevice, env);
  const { LD_LIBRARY_PATH: _ignoredLibraryPath, ...restExtra } = extra || {};
  const speakrsEnv = {
    ...restExtra,
    SPEAKRS_EXCLUSIVE: '1',
  };
  clearHuggingFaceEnvVars(speakrsEnv, extra, env);
  if (resolvedCliPath) {
    speakrsEnv.SPEAKRS_CLI_PATH = resolvedCliPath;
  } else if (packaged) {
    speakrsEnv.SPEAKRS_CLI_PATH = undefined;
  }
  if (modelsDir) {
    speakrsEnv.SPEAKRS_MODELS_DIR = modelsDir;
  }
  if (mode) {
    speakrsEnv.SPEAKRS_MODE = mode;
  }
  if (packaged) {
    speakrsEnv.AVANEVIS_PACKAGED = '1';
  }
  if (platform === 'win32') {
    const ortDir = getSpeakrsOrtRuntimeDir(userDataDir);
    const currentPath = extra.PATH || env.PATH || process.env.PATH || '';
    speakrsEnv.PATH = prependUniquePathEntry(currentPath, ortDir);
    speakrsEnv.ORT_DYLIB_PATH = path.join(ortDir, 'onnxruntime.dll');
  }
  if (platform === 'linux') {
    speakrsEnv.LD_LIBRARY_PATH = buildSpeakrsLinuxLibraryPath({
      userDataDir,
      fsModule,
    });
    speakrsEnv.ORT_DYLIB_PATH = path.join(
      getSpeakrsOrtRuntimeDir(userDataDir),
      SPEAKRS_ORT_SO_NAMES[0],
    );
  }
  return speakrsEnv;
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

function buildDiarizationStorageFootprint({
  userDataDir,
  dependencyCache,
  packCache,
  runtimeCache,
  engine = 'pyannote',
  fsModule = fs,
  includeSizes = false,
} = {}) {
  const addonPaths = getAiAddonPaths(userDataDir);
  const modelCacheDir = engine === 'speakrs'
    ? addonPaths.speakrsModelCacheDir
    : addonPaths.diarizationModelCacheDir;
  const dependencyDir = dependencyCache && dependencyCache.dependencyDir;
  const runtimeDir = engine === 'speakrs' ? addonPaths.speakrsOrtRuntimeDir : null;
  const modelCacheBytes = includeSizes ? getDirectorySizeBytes(modelCacheDir, fsModule) : null;
  const dependencyBytes = includeSizes ? getDirectorySizeBytes(dependencyDir, fsModule) : null;
  const runtimeBytes = includeSizes ? getDirectorySizeBytes(runtimeDir, fsModule) : null;
  const estimatedDependencyDownloadBytes = dependencyCache?.artifact?.estimatedDownloadBytes || null;
  const estimatedPackBytes = Array.isArray(packCache?.artifact?.modelFiles)
    ? packCache.artifact.modelFiles.reduce((total, file) => total + (Number(file.sizeBytes) || 0), 0)
    : null;
  const estimatedRuntimeBytes = Array.isArray(runtimeCache?.artifact?.runtimeArtifacts)
    ? runtimeCache.artifact.runtimeArtifacts.reduce((total, file) => total + (Number(file.sizeBytes) || 0), 0)
    : null;
  const runtimeFamilies = engine === 'speakrs'
    ? ['speakrs-ort']
    : (dependencyCache?.artifact?.runtimeFamilies || []);
  const estimatedInstalledBytes = engine === 'speakrs'
    ? (estimatedPackBytes || 0) + (estimatedRuntimeBytes || 0) || null
    : (dependencyCache?.installed && estimatedDependencyDownloadBytes ? estimatedDependencyDownloadBytes : null);

  return {
    modelCacheDir,
    dependencyDir,
    runtimeDir,
    modelCacheBytes,
    dependencyBytes,
    runtimeBytes,
    installedBytes: includeSizes
      ? (modelCacheBytes || 0) + (dependencyBytes || 0) + (runtimeBytes || 0)
      : null,
    installedBytesAccuracy: includeSizes ? 'actual' : 'notScanned',
    estimatedInstalledBytes,
    estimatedDownloadBytes: engine === 'speakrs'
      ? (estimatedPackBytes || 0) + (estimatedRuntimeBytes || 0) || null
      : estimatedDependencyDownloadBytes,
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

const speakrsChecksumFingerprintCache = new Map();

function getArtifactFingerprint(filePath, fsModule = fs) {
  try {
    const statSync = bindFsMethod(fsModule, 'statSync');
    if (!statSync) {
      return null;
    }
    const stat = statSync(filePath);
    if (!stat) {
      return null;
    }
    return `${filePath}\0${Number(stat.size)}\0${Number(stat.mtimeMs)}`;
  } catch (_error) {
    return null;
  }
}

async function checkSpeakrsModelCache({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  verifyChecksum = false,
  verifyChecksumIfChanged = false,
} = {}) {
  const artifact = getSpeakrsSetupArtifactsForPlatform(platform, arch, catalog);
  const modelPack = artifact?.modelPack;
  const revision = artifact?.revision || SPEAKRS_MODEL_PACK_REVISION;
  const modelCacheDir = getSpeakrsModelCacheDir(userDataDir);
  const revisionDir = getSpeakrsModelRevisionDir(userDataDir, revision);
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const files = artifact?.modelFiles || [];
  const missing = [];
  const sizeMismatches = [];
  let unsafePathError = null;
  for (const file of files) {
    let filePath;
    try {
      filePath = getSpeakrsSourceFilePath(userDataDir, file, revision);
    } catch (error) {
      unsafePathError = error;
      break;
    }
    if (!filePath || !existsSync?.(filePath)) {
      missing.push(file.path);
      continue;
    }
    const actualSize = getFileSizeBytes(filePath, fsModule);
    if (Number(file.sizeBytes) && actualSize !== Number(file.sizeBytes)) {
      sizeMismatches.push(file.path);
    }
  }
  const installed = !unsafePathError && files.length > 0 && missing.length === 0 && sizeMismatches.length === 0;
  const partial = Boolean(revisionDir && existsSync && existsSync(revisionDir) && !installed);
  const base = {
    supported: Boolean(artifact),
    installed,
    partial,
    valid: false,
    checksumStatus: 'notChecked',
    validationStatus: installed ? 'installed' : partial ? 'notConfigured' : 'notConfigured',
    reason: unsafePathError?.message || (installed ? null : 'Speakrs model pack is not installed.'),
    modelCacheDir,
    revisionDir,
    revision,
    expectedFiles: files.length,
    missingFiles: missing,
    artifact,
  };

  if (unsafePathError) {
    return {
      ...base,
      supported: false,
      validationStatus: 'error',
    };
  }
  const modelPackPinned = Boolean(
    modelPack
    && modelPack.fileName
    && modelPack.archiveFormat
    && modelPack.downloadUrl
    && isAllowedDownloadUrl(modelPack.downloadUrl)
    && isPinnedSha256(modelPack.sha256)
    && Number(modelPack.sizeBytes) > 0,
  );
  if (!artifact || files.length === 0 || !modelPackPinned) {
    return {
      ...base,
      supported: false,
      valid: false,
      reason: 'No complete pinned Speakrs model-pack archive is configured for this platform.',
      validationStatus: 'unsupported',
    };
  }
  if (!installed) {
    return base;
  }
  if (!verifyChecksum) {
    return {
      ...base,
      valid: true,
      validationStatus: 'installed',
    };
  }

  for (const file of files) {
    const filePath = getSpeakrsSourceFilePath(userDataDir, file, revision);
    const fingerprint = verifyChecksumIfChanged ? getArtifactFingerprint(filePath, fsModule) : null;
    if (fingerprint) {
      const cached = speakrsChecksumFingerprintCache.get(fingerprint);
      if (cached && cached.expectedSha256 === file.sha256 && cached.actualSha256 === file.sha256) {
        continue;
      }
    }
    const actualSha256 = await hashFileSha256(filePath, fsModule);
    if (actualSha256 !== file.sha256) {
      if (fingerprint) {
        speakrsChecksumFingerprintCache.delete(fingerprint);
      }
      return {
        ...base,
        valid: false,
        checksumStatus: 'mismatch',
        validationStatus: 'error',
        reason: `Speakrs model file checksum does not match the pinned checksum: ${file.path}.`,
        actualSha256,
      };
    }
    if (fingerprint) {
      speakrsChecksumFingerprintCache.set(fingerprint, {
        expectedSha256: file.sha256,
        actualSha256,
      });
    }
  }

  return {
    ...base,
    valid: true,
    checksumStatus: 'match',
    validationStatus: 'ready',
    reason: null,
  };
}

function findNamedFiles(rootDir, fileNames, fsModule = fs) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const readdirSync = bindFsMethod(fsModule, 'readdirSync');
  const statSync = bindFsMethod(fsModule, 'statSync');
  const wanted = new Set(fileNames);
  const found = new Map();
  if (!rootDir || !existsSync || !readdirSync || !statSync || !existsSync(rootDir) || wanted.size === 0) {
    return found;
  }
  const queue = [rootDir];
  while (queue.length && found.size < wanted.size) {
    const currentDir = queue.shift();
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      const isDirectory = typeof entry.isDirectory === 'function'
        ? entry.isDirectory()
        : statSync(entryPath).isDirectory();
      if (isDirectory) {
        queue.push(entryPath);
      } else if (wanted.has(entry.name)) {
        found.set(entry.name, entryPath);
      }
    }
  }
  return found;
}

async function hashPinnedSpeakrsFile({
  filePath,
  pin,
  name,
  fsModule,
  verifyChecksum,
  verifyChecksumIfChanged,
  missing,
  invalid,
} = {}) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  if (!existsSync?.(filePath)) {
    missing.push(name);
    return;
  }
  const actualSize = getFileSizeBytes(filePath, fsModule);
  if (actualSize !== pin.sizeBytes) {
    invalid.add(name);
  }
  if (!verifyChecksum) {
    return;
  }
  const fingerprint = verifyChecksumIfChanged ? getArtifactFingerprint(filePath, fsModule) : null;
  const cached = fingerprint ? speakrsChecksumFingerprintCache.get(fingerprint) : null;
  if (cached && cached.expectedSha256 === pin.sha256 && cached.actualSha256 === pin.sha256) {
    return;
  }
  const actualSha256 = await hashFileSha256(filePath, fsModule);
  if (actualSha256 !== pin.sha256) {
    invalid.add(name);
    if (fingerprint) {
      speakrsChecksumFingerprintCache.delete(fingerprint);
    }
    return;
  }
  if (fingerprint) {
    speakrsChecksumFingerprintCache.set(fingerprint, {
      expectedSha256: pin.sha256,
      actualSha256,
    });
  }
}

function collectUnexpectedSpeakrsRuntimeLoaderFiles({
  runtimeDir,
  platform = process.platform,
  expectedNames = [],
  fsModule = fs,
} = {}) {
  const readdirSync = bindFsMethod(fsModule, 'readdirSync');
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  if (!runtimeDir || !readdirSync) {
    throw new Error('File system cannot inspect the Speakrs runtime loader directory.');
  }
  if (existsSync && !existsSync(runtimeDir)) {
    return [];
  }
  const expected = new Set(expectedNames.map((name) => (
    platform === 'win32' ? String(name).toLowerCase() : String(name)
  )));
  const isLoaderFile = platform === 'win32'
    ? (name) => /\.dll$/i.test(name)
    : (name) => /\.so(?:\.|$)/.test(name);
  let entries;
  try {
    entries = readdirSync(runtimeDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .map((entry) => String(entry.name || ''))
    .filter((name) => isLoaderFile(name) && !expected.has(platform === 'win32' ? name.toLowerCase() : name))
    .sort();
}

async function checkSpeakrsRuntimeCache({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  verifyChecksum = false,
  verifyChecksumIfChanged = false,
} = {}) {
  const artifact = getSpeakrsSetupArtifactsForPlatform(platform, arch, catalog);
  const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const readFileSync = bindFsMethod(fsModule, 'readFileSync');
  const runtimeArtifacts = artifact?.runtimeArtifacts || [];
  const requiresExtractedRuntime = (
    (platform === 'win32' && arch === 'x64')
    || (platform === 'linux' && arch === 'x64')
  );
  if (!requiresExtractedRuntime) {
    return {
      supported: true,
      installed: true,
      partial: false,
      valid: true,
      skipped: true,
      validationStatus: 'ready',
      reason: null,
      runtimeDir,
      artifact,
    };
  }
  const expectedNames = getSpeakrsRequiredRuntimeLibraryNames(platform, arch);
  const expectedDllPins = getSpeakrsExtractedRuntimeDllPins(runtimeArtifacts, platform, arch);
  const incompleteReason = platform === 'linux'
    ? 'No complete Speakrs ONNX Runtime artifact is configured for Linux.'
    : 'No complete Speakrs ONNX Runtime artifact is configured for Windows.';
  if (!artifact || runtimeArtifacts.length === 0 || runtimeArtifacts.some((entry) => (
    !entry.id || !entry.fileName || !isPinnedSha256(entry.sha256) || !Number(entry.sizeBytes)
  )) || !expectedDllPins) {
    return {
      supported: false,
      installed: false,
      partial: Boolean(runtimeDir && existsSync?.(runtimeDir)),
      valid: false,
      skipped: false,
      validationStatus: 'unsupported',
      reason: incompleteReason,
      runtimeDir,
      missingFiles: expectedNames,
      artifact,
    };
  }

  const runtimeManifestPath = path.join(runtimeDir, 'install.json');
  let runtimeManifest = null;
  try {
    runtimeManifest = existsSync?.(runtimeManifestPath) && readFileSync
      ? JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
      : null;
  } catch (_error) {
    runtimeManifest = null;
  }
  const expectedArtifactPins = runtimeArtifacts.map((entry) => ({
    id: entry.id,
    sha256: entry.sha256,
  }));
  const manifestPinsMatch = JSON.stringify(runtimeManifest?.artifacts || null) === JSON.stringify(expectedArtifactPins);
  const missing = [];
  const invalid = new Set();
  for (const name of expectedNames) {
    await hashPinnedSpeakrsFile({
      filePath: path.join(runtimeDir, name),
      pin: expectedDllPins[name],
      name,
      fsModule,
      verifyChecksum,
      verifyChecksumIfChanged,
      missing,
      invalid,
    });
  }
  const unexpectedLoaderFiles = collectUnexpectedSpeakrsRuntimeLoaderFiles({
    runtimeDir,
    platform,
    expectedNames,
    fsModule,
  });
  for (const name of unexpectedLoaderFiles) {
    invalid.add(name);
  }

  if (platform === 'linux') {
    const requiredDynamicLibraries = runtimeArtifacts
      .map((entry) => entry.requiredDynamicLibraries)
      .find((list) => Array.isArray(list) && list.length > 0) || [];
    let managedRoot = null;
    try {
      managedRoot = getManagedLinuxCudaRuntimeTarget(userDataDir);
    } catch (_error) {
      managedRoot = null;
    }
    for (const library of requiredDynamicLibraries) {
      if (!library || !library.name || !library.source) {
        continue;
      }
      if (library.source === 'managed-cuda-runtime') {
        if (!managedRoot) {
          missing.push(library.name);
          continue;
        }
        let libraryPath;
        try {
          libraryPath = resolveRequiredLinuxCudaLibraryPath(managedRoot, {
            fileName: library.name,
            relativePath: library.relativePath,
          }, fsModule);
        } catch (_error) {
          missing.push(library.name);
          continue;
        }
        await hashPinnedSpeakrsFile({
          filePath: libraryPath,
          pin: { sha256: library.sha256, sizeBytes: library.sizeBytes },
          name: library.name,
          fsModule,
          verifyChecksum,
          verifyChecksumIfChanged,
          missing,
          invalid,
        });
        continue;
      }
      if (library.source === 'nvidia-driver' || library.source === 'system') {
        if (!linuxAllowlistedLibraryExists(library.name, fsModule)) {
          missing.push(library.name);
        }
      }
    }
  }

  const invalidFiles = [...invalid];
  const installed = manifestPinsMatch && missing.length === 0 && invalidFiles.length === 0;
  const partial = Boolean(runtimeDir && existsSync && existsSync(runtimeDir) && !installed);
  return {
    supported: true,
    installed,
    partial,
    valid: installed,
    skipped: false,
    validationStatus: installed ? 'ready' : (invalidFiles.length || (runtimeManifest && !manifestPinsMatch)) ? 'error' : 'notConfigured',
    reason: installed
      ? null
      : invalidFiles.length || (runtimeManifest && !manifestPinsMatch)
        ? 'Speakrs ONNX Runtime files failed integrity validation.'
        : missing.length
          ? `Speakrs ONNX Runtime is not installed. Missing: ${missing.join(', ')}.`
          : 'Speakrs ONNX Runtime is not installed.',
    runtimeDir,
    missingFiles: missing,
    invalidFiles,
    runtimeManifestPath,
    runtimeManifest,
    artifact,
  };
}

function hasSpeakrsLocalState({ userDataDir, packCache, runtimeCache, fsModule = fs } = {}) {
  const runtimePresent = Boolean(
    runtimeCache
    && runtimeCache.skipped !== true
    && (runtimeCache.installed || runtimeCache.partial)
  );
  if (packCache?.installed || packCache?.partial || runtimePresent) {
    return true;
  }
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const modelDir = getSpeakrsModelCacheDir(userDataDir);
  const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
  return Boolean(existsSync && ((modelDir && existsSync(modelDir)) || (runtimeDir && existsSync(runtimeDir))));
}

function hasPyannoteLocalState({ userDataDir, dependencyCache, tokenStatus, fsModule = fs } = {}) {
  if (dependencyCache?.installed || dependencyCache?.partial || tokenStatus?.hasToken) {
    return true;
  }
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const paths = getAiAddonPaths(userDataDir);
  const cacheRoot = paths.diarizationModelCacheDir;
  return Boolean(existsSync && [
    paths.diarizationDependencyCacheDir,
    path.join(cacheRoot, 'hub'),
    path.join(cacheRoot, 'xet'),
    path.join(cacheRoot, '.locks'),
    getPyannoteTokenPath(userDataDir),
  ].some((candidate) => candidate && existsSync(candidate)));
}

function getSpeakrsUninstallPaths(userDataDir) {
  return [
    getSpeakrsModelCacheDir(userDataDir),
    getSpeakrsOrtRuntimeDir(userDataDir),
  ];
}

function getPyannoteTokenPath(userDataDir) {
  return path.join(getAiAddonPaths(userDataDir).rootDir, 'tokens', 'diarization-huggingface-token.bin');
}

function getPyannoteUninstallPaths(userDataDir) {
  const paths = getAiAddonPaths(userDataDir);
  const cacheRoot = paths.diarizationModelCacheDir;
  return [
    paths.diarizationDependencyCacheDir,
    path.join(cacheRoot, 'hub'),
    path.join(cacheRoot, 'xet'),
    path.join(cacheRoot, '.locks'),
  ];
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

function isPinnedByteSize(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
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
  if (runtimeArtifact.platform === 'linux') {
    if (runtimeArtifact.arch !== 'x64' || runtimeArtifact.acceleration !== 'cuda' || runtimeArtifact.cudaMajor !== 12) {
      return 'Linux summary runtime must be pinned for x86_64 CUDA 12.';
    }
    if (!runtimeArtifact.artifacts.some((archive) => archive.kind === 'nccl-wheel')) {
      return 'Linux summary runtime must include a pinned NCCL CUDA 12 dependency.';
    }
    if (!Array.isArray(runtimeArtifact.requiredDynamicLibraries)
      || !runtimeArtifact.requiredDynamicLibraries.some((library) => library.fileName === 'libnccl.so.2')) {
      return 'Linux summary runtime must declare its NCCL shared-library dependency.';
    }
    const pinnedRuntimeFiles = getSummaryRuntimeRequiredFiles(runtimeArtifact);
    const managedLibraries = new Map(getLinuxCudaRequiredLibraries().map((library) => [library.fileName, library]));
    for (const library of runtimeArtifact.requiredDynamicLibraries) {
      if (!library || !library.fileName || !library.source) {
        return 'Linux summary runtime dependency metadata is incomplete.';
      }
      if (library.source === 'summary-runtime') {
        if (!library.relativePath) {
          return 'Linux summary runtime dependency metadata is incomplete.';
        }
        if (!pinnedRuntimeFiles.some((file) => file.path === library.relativePath)) {
          return `Linux summary runtime dependency is not pinned: ${library.fileName}`;
        }
      } else if (library.source === 'managed-cuda12') {
        if (!library.relativePath) {
          return 'Linux summary runtime dependency metadata is incomplete.';
        }
        const managedPin = managedLibraries.get(library.fileName);
        if (!managedPin || managedPin.relativePath !== library.relativePath) {
          return `Linux summary runtime dependency is not pinned in the managed CUDA catalog: ${library.fileName}`;
        }
      } else if (library.source !== 'nvidia-driver' && library.source !== 'system') {
        return `Unknown Linux summary runtime dependency source: ${library.source}`;
      }
    }
  }
  for (const archive of runtimeArtifact.artifacts) {
    if (!archive.fileName || !archive.downloadUrl || !isPinnedSha256(archive.sha256) || !isPinnedByteSize(archive.sizeBytes)) {
      return 'Pinned llama.cpp runtime archive metadata is incomplete.';
    }
    if (!isAllowedDownloadUrl(archive.downloadUrl)) {
      return 'Pinned llama.cpp runtime archive host is not allowed.';
    }
    if (!['zip', 'tar.gz'].includes(archive.archiveFormat)) {
      return 'Pinned llama.cpp runtime archive format is not supported.';
    }
    for (const file of archive.requiredFiles || []) {
      if (!file.path || !isPinnedSha256(file.sha256) || !isPinnedByteSize(file.sizeBytes)) {
        return 'Pinned llama.cpp runtime extracted-file metadata is incomplete.';
      }
    }
    for (const [fileName, file] of Object.entries(archive.extractedFiles || {})) {
      if (!fileName || !file.path || !isPinnedSha256(file.sha256) || !isPinnedByteSize(file.sizeBytes)) {
        return 'Pinned llama.cpp runtime library metadata is incomplete.';
      }
    }
  }

  return null;
}

function getSummaryRuntimeRequiredFiles(runtimeArtifact) {
  const files = [];
  for (const archive of runtimeArtifact?.artifacts || []) {
    for (const file of archive.requiredFiles || []) {
      files.push({ ...file });
    }
    for (const [fileName, file] of Object.entries(archive.extractedFiles || {})) {
      files.push({
        path: file.path || `${archive.dynamicLibraryDir || ''}/${fileName}`,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      });
    }
  }
  return files;
}

const summaryRuntimeChecksumFingerprintCache = new Map();
const summaryRuntimeDependencyFingerprintCache = new Map();

function getSummaryRuntimeLoaderDirectories(rootPath, runtimeArtifact, requiredFiles, executablePath) {
  const directories = new Map();
  const addDirectory = (relativeDirectory, expectedNames = [], allowRoot = false) => {
    const normalized = String(relativeDirectory || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if ((!normalized && !allowRoot) || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..')) {
      throw new Error('Summary runtime loader directory is unsafe.');
    }
    const directoryPath = path.resolve(rootPath, ...normalized.split('/'));
    if (!directories.has(directoryPath)) {
      directories.set(directoryPath, new Set());
    }
    for (const name of expectedNames) {
      if (name) {
        directories.get(directoryPath).add(name);
      }
    }
  };

  for (const file of requiredFiles || []) {
    const relativePath = String(file.path || '').replace(/\\/g, '/');
    const baseName = path.posix.basename(relativePath);
    if (!/\.so(?:\.|$)/.test(baseName)) {
      continue;
    }
    const relativeDirectory = path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath);
    addDirectory(relativeDirectory, [baseName]);
  }
  for (const archive of runtimeArtifact?.artifacts || []) {
    if (archive.dynamicLibraryDir) {
      addDirectory(archive.dynamicLibraryDir);
    }
  }
  if (executablePath) {
    const relativeExecutableDir = path.relative(rootPath, path.dirname(executablePath));
    addDirectory(relativeExecutableDir, [], true);
  }

  return directories;
}

function getSummaryRuntimeAllowedSymlinkNames(expectedNames) {
  const aliases = new Set();
  for (const name of expectedNames) {
    const match = String(name).match(/^(.*\.so)(?:\.\d.*)?$/);
    if (!match) {
      continue;
    }
    aliases.add(match[1]);
    aliases.add(`${match[1]}.0`);
  }
  return aliases;
}

function collectUnexpectedSummaryRuntimeLoaderFiles({
  runtimeDir,
  runtimeArtifact,
  requiredFiles,
  executablePath,
  fsModule = fs,
} = {}) {
  const readdirSync = bindFsMethod(fsModule, 'readdirSync');
  const lstatSync = bindFsMethod(fsModule, 'lstatSync');
  const realpathSync = bindFsMethod(fsModule, 'realpathSync');
  if (!readdirSync || !lstatSync || !realpathSync) {
    throw new Error('File system cannot inspect the summary runtime loader directories.');
  }
  const rootPath = path.resolve(runtimeDir);
  const realRoot = path.resolve(realpathSync(rootPath));
  const directories = getSummaryRuntimeLoaderDirectories(rootPath, runtimeArtifact, requiredFiles, executablePath);
  const unexpected = [];

  for (const [directoryPath, expectedNames] of directories) {
    let directoryStats;
    try {
      directoryStats = lstatSync(directoryPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    if (!directoryStats?.isDirectory?.()) {
      throw new Error(`Summary runtime loader directory is not a directory: ${path.basename(directoryPath)}`);
    }
    const allowedAliases = getSummaryRuntimeAllowedSymlinkNames(expectedNames);
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const name = String(entry.name || '');
      if (!/\.so(?:\.|$)/.test(name) || expectedNames.has(name)) {
        continue;
      }
      const candidate = path.join(directoryPath, name);
      const stats = lstatSync(candidate);
      if (allowedAliases.has(name) && stats.isSymbolicLink?.()) {
        const realCandidate = path.resolve(realpathSync(candidate));
        const relative = path.relative(realRoot, realCandidate);
        if (!relative.startsWith('..') && !path.isAbsolute(relative) && expectedNames.has(path.basename(realCandidate))) {
          continue;
        }
      }
      unexpected.push(path.relative(rootPath, candidate).split(path.sep).join('/'));
    }
  }
  return unexpected;
}

async function verifySummaryPinnedFile({
  filePath,
  pin,
  fsModule,
  verifyChecksum,
  verifyChecksumIfChanged,
} = {}) {
  const lstatSync = bindFsMethod(fsModule, 'lstatSync');
  const realpathSync = bindFsMethod(fsModule, 'realpathSync');
  const statSync = bindFsMethod(fsModule, 'statSync');
  if (!lstatSync || !realpathSync || !statSync) {
    return 'File system cannot validate the summary runtime dependency.';
  }
  try {
    const lstat = lstatSync(filePath);
    if (lstat.isSymbolicLink?.()) {
      return `Summary runtime dependency must not be a symbolic link: ${path.basename(filePath)}`;
    }
    const stats = statSync(realpathSync(filePath));
    if (!stats?.isFile?.() || Number(stats.size) !== Number(pin.sizeBytes)) {
      return `Summary runtime dependency size mismatch: ${path.basename(filePath)}`;
    }
    if (!verifyChecksum) {
      return null;
    }
    const realFile = path.resolve(realpathSync(filePath));
    const fingerprint = `${realFile}\0${Number(stats.size)}\0${Number(stats.mtimeMs)}`;
    if (verifyChecksumIfChanged) {
      const cached = summaryRuntimeDependencyFingerprintCache.get(fingerprint);
      if (cached && cached.expectedSha256 === pin.sha256 && cached.actualSha256 === pin.sha256) {
        return null;
      }
    }
    const actualSha256 = await hashFileSha256(realFile, fsModule);
    if (actualSha256 !== pin.sha256) {
      summaryRuntimeDependencyFingerprintCache.delete(fingerprint);
      return `Summary runtime dependency hash mismatch: ${path.basename(filePath)}`;
    }
    if (verifyChecksumIfChanged) {
      summaryRuntimeDependencyFingerprintCache.set(fingerprint, {
        expectedSha256: pin.sha256,
        actualSha256,
      });
    }
    return null;
  } catch (error) {
    return error.message || `Summary runtime dependency is missing: ${path.basename(filePath)}`;
  }
}

async function verifySummaryRuntimeDynamicLibraries({
  userDataDir,
  runtimeDir,
  runtimeArtifact,
  requiredFiles,
  fsModule = fs,
  verifyChecksum = false,
  verifyChecksumIfChanged = false,
} = {}) {
  const runtimeLibraries = runtimeArtifact?.requiredDynamicLibraries || [];
  const managedLibraries = getLinuxCudaRequiredLibraries();
  const requiredByPath = new Map((requiredFiles || []).map((file) => [
    String(file.path || '').replace(/\\/g, '/'),
    file,
  ]));
  let managedRoot = null;

  for (const library of runtimeLibraries) {
    const name = String(library.fileName || '');
    if (!name || !library.source) {
      return 'Linux summary runtime dependency metadata is incomplete.';
    }
    if (library.source === 'summary-runtime') {
      const relativePath = String(library.relativePath || '').replace(/\\/g, '/');
      if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '..')) {
        return `Unsafe Linux summary runtime dependency path: ${name}`;
      }
      const pin = requiredByPath.get(relativePath);
      if (!pin) {
        return `Summary runtime dependency is not pinned: ${name}`;
      }
      const error = await verifySummaryPinnedFile({
        filePath: path.join(runtimeDir, ...relativePath.split('/')),
        pin,
        fsModule,
        verifyChecksum,
        verifyChecksumIfChanged,
      });
      if (error) {
        return error;
      }
      continue;
    }
    if (library.source === 'managed-cuda12') {
      const pin = managedLibraries.find((entry) => entry.fileName === name);
      if (!pin) {
        return `Summary runtime dependency is not pinned in the managed CUDA catalog: ${name}`;
      }
      if (!managedRoot) {
        managedRoot = getManagedLinuxCudaRuntimeTarget(userDataDir);
        try {
          managedRoot = validateLinuxCudaManagedRoot(managedRoot, fsModule);
        } catch (error) {
          return error.message;
        }
      }
      let filePath;
      try {
        filePath = resolveRequiredLinuxCudaLibraryPath(managedRoot, pin, fsModule);
      } catch (error) {
        return error.message;
      }
      const error = await verifySummaryPinnedFile({
        filePath,
        pin,
        fsModule,
        verifyChecksum,
        verifyChecksumIfChanged,
      });
      if (error) {
        return error;
      }
      continue;
    }
    if (library.source === 'nvidia-driver' || library.source === 'system') {
      if (!linuxAllowlistedLibraryExists(name, fsModule)) {
        return `Required Linux summary system library is not available: ${name}`;
      }
      continue;
    }
    return `Unknown Linux summary runtime dependency source: ${library.source}`;
  }
  return null;
}

async function verifySummaryRuntimeFiles(runtimeDir, runtimeArtifact, fsModule = fs, verifyChecksum = false, verifyChecksumIfChanged = false) {
  const requiredFiles = getSummaryRuntimeRequiredFiles(runtimeArtifact);
  if (!verifyChecksum || requiredFiles.length === 0) {
    return { ok: true, checksumSkippedUnchanged: false, error: null };
  }
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const lstatSync = bindFsMethod(fsModule, 'lstatSync');
  const realpathSync = bindFsMethod(fsModule, 'realpathSync');
  const statSync = bindFsMethod(fsModule, 'statSync');
  if (!existsSync || !lstatSync || !realpathSync || !statSync) {
    return { ok: false, checksumSkippedUnchanged: false, error: 'File system cannot validate the summary runtime files.' };
  }

  const rootPath = path.resolve(runtimeDir);
  let realRoot;
  try {
    realRoot = path.resolve(realpathSync(rootPath));
  } catch (error) {
    return { ok: false, checksumSkippedUnchanged: false, error: 'Summary runtime extraction directory is not available.' };
  }
  let skippedAll = true;
  for (const file of requiredFiles) {
    const relativePath = String(file.path || '').replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').some((part) => part === '..')) {
      return { ok: false, checksumSkippedUnchanged: false, error: `Unsafe summary runtime file path: ${relativePath}` };
    }
    const filePath = path.join(rootPath, ...relativePath.split('/'));
    try {
      const lstat = lstatSync(filePath);
      if (lstat.isSymbolicLink?.()) {
        return { ok: false, checksumSkippedUnchanged: false, error: `Summary runtime file must not be a symbolic link: ${path.basename(filePath)}` };
      }
      const realFile = path.resolve(realpathSync(filePath));
      const relative = path.relative(realRoot, realFile);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return { ok: false, checksumSkippedUnchanged: false, error: 'Summary runtime file escapes its managed extraction directory.' };
      }
      const stats = statSync(realFile);
      if (!stats?.isFile?.() || Number(stats.size) !== Number(file.sizeBytes)) {
        return { ok: false, checksumSkippedUnchanged: false, error: `Summary runtime file size mismatch: ${path.basename(filePath)}` };
      }
      const fingerprint = `${realFile}\0${Number(stats.size)}\0${Number(stats.mtimeMs)}`;
      if (verifyChecksumIfChanged) {
        const cached = summaryRuntimeChecksumFingerprintCache.get(fingerprint);
        if (cached && cached.expectedSha256 === file.sha256 && cached.actualSha256 === file.sha256) {
          continue;
        }
      }
      skippedAll = false;
      const actualSha256 = await hashFileSha256(realFile, fsModule);
      if (actualSha256 !== file.sha256) {
        return { ok: false, checksumSkippedUnchanged: false, error: `Summary runtime file hash mismatch: ${path.basename(filePath)}` };
      }
      if (verifyChecksumIfChanged) {
        summaryRuntimeChecksumFingerprintCache.set(fingerprint, {
          expectedSha256: file.sha256,
          actualSha256,
        });
      }
    } catch (error) {
      return { ok: false, checksumSkippedUnchanged: false, error: error.message || `Summary runtime file is missing: ${path.basename(filePath)}` };
    }
  }
  const unexpectedLoaderFiles = collectUnexpectedSummaryRuntimeLoaderFiles({
    runtimeDir: rootPath,
    runtimeArtifact,
    requiredFiles,
    executablePath: requiredFiles
      .map((file) => path.join(rootPath, ...String(file.path || '').replace(/\\/g, '/').split('/')))
      .find((filePath) => path.basename(filePath) === runtimeArtifact?.executableName),
    fsModule,
  });
  if (unexpectedLoaderFiles.length > 0) {
    return {
      ok: false,
      checksumSkippedUnchanged: false,
      error: `Unexpected summary runtime loader files: ${unexpectedLoaderFiles.join(', ')}`,
    };
  }
  return { ok: true, checksumSkippedUnchanged: verifyChecksumIfChanged && skippedAll, error: null };
}

async function checkSummaryRuntimeCache({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  verifyChecksum = false,
  verifyChecksumIfChanged = false,
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
  const runtimeIntegrity = installed
    ? await verifySummaryRuntimeFiles(path.join(runtimeDir, 'extract'), runtimeArtifact, fsModule, verifyChecksum, verifyChecksumIfChanged)
    : { ok: false, checksumSkippedUnchanged: false, error: null };
  const runtimeDependencyError = installed && runtimeIntegrity.ok && platform === 'linux'
    ? await verifySummaryRuntimeDynamicLibraries({
      userDataDir,
      runtimeDir: path.join(runtimeDir, 'extract'),
      runtimeArtifact,
      requiredFiles: getSummaryRuntimeRequiredFiles(runtimeArtifact),
      fsModule,
      verifyChecksum,
      verifyChecksumIfChanged,
    })
    : null;

  return {
    supported: Boolean(artifact && runtimeArtifact),
    installed,
    partial,
    valid: installed && !validationError && runtimeIntegrity.ok && !runtimeDependencyError,
    validationStatus: validationError
      ? 'pendingPinnedRuntime'
      : installed ? (runtimeIntegrity.ok && !runtimeDependencyError ? 'ready' : 'error') : 'notConfigured',
    reason: validationError || (installed
      ? (runtimeIntegrity.error || runtimeDependencyError)
      : 'llama.cpp runtime is not installed.'),
    checksumSkippedUnchanged: runtimeIntegrity.checksumSkippedUnchanged,
    estimatedDownloadBytes: Array.isArray(runtimeArtifact?.artifacts)
      ? runtimeArtifact.artifacts.reduce((total, runtimeArchive) => total + (Number(runtimeArchive.sizeBytes) || 0), 0)
      : null,
    runtimeDir,
    expectedExecutablePath,
    executablePath,
    runtimeArtifact,
  };
}

function buildSummaryRuntimeEnv({
  userDataDir,
  artifact,
  runtimeArtifact,
  platform = process.platform,
  arch = process.arch,
  fsModule = fs,
  driverLibraryDirs = null,
} = {}) {
  if (platform !== 'linux') {
    return {};
  }
  if (arch !== 'x64') {
    throw new Error('Linux local summaries require x86_64.');
  }
  const selectedRuntimeArtifact = runtimeArtifact
    || getSummaryRuntimeArtifactForPlatform(platform, arch, AI_MODEL_CATALOG);
  const runtimeDir = getSummaryRuntimeDir(userDataDir, artifact);
  const extractRoot = path.join(runtimeDir, 'extract');
  const realpathSync = bindFsMethod(fsModule, 'realpathSync');
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  if (!realpathSync || !existsSync) {
    throw new Error('File system cannot resolve the managed Linux summary runtime.');
  }
  let realExtractRoot;
  try {
    realExtractRoot = path.resolve(realpathSync(extractRoot));
  } catch (_error) {
    throw new Error('Managed Linux summary runtime is not installed.');
  }

  const runtimeLibraryDirs = [];
  const seenRuntimeDirs = new Set();
  for (const archive of selectedRuntimeArtifact?.artifacts || []) {
    if (!archive.dynamicLibraryDir) {
      continue;
    }
    const relativeDir = String(archive.dynamicLibraryDir).replace(/\\/g, '/');
    if (!relativeDir || relativeDir.startsWith('/') || relativeDir.split('/').some((part) => part === '..')) {
      throw new Error('Summary runtime library path is unsafe.');
    }
    const candidate = path.join(realExtractRoot, ...relativeDir.split('/'));
    const stats = lstatRejectSymlink(candidate, fsModule, 'summary runtime library directory');
    if (typeof stats.isDirectory === 'function' && !stats.isDirectory()) {
      throw new Error('Summary runtime library path is not a directory.');
    }
    if (isWorldWritableMode(stats.mode)) {
      throw new Error('Summary runtime library directory must not be world-writable.');
    }
    const realDir = path.resolve(realpathSync(candidate));
    const relative = path.relative(realExtractRoot, realDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Summary runtime library path escaped its managed extraction directory.');
    }
    if (!seenRuntimeDirs.has(realDir)) {
      seenRuntimeDirs.add(realDir);
      runtimeLibraryDirs.push(realDir);
    }
  }
  const executablePath = findRuntimeExecutablePath(runtimeDir, selectedRuntimeArtifact?.executableName, fsModule);
  if (!executablePath) {
    throw new Error('Managed Linux summary runtime executable is not installed.');
  }
  const executableDir = path.resolve(path.dirname(executablePath));
  const executableStats = lstatRejectSymlink(executableDir, fsModule, 'summary runtime executable directory');
  if (typeof executableStats.isDirectory === 'function' && !executableStats.isDirectory()) {
    throw new Error('Summary runtime executable directory is not a directory.');
  }
  if (isWorldWritableMode(executableStats.mode)) {
    throw new Error('Summary runtime executable directory must not be world-writable.');
  }
  const realExecutableDir = path.resolve(realpathSync(executableDir));
  const executableRelative = path.relative(realExtractRoot, realExecutableDir);
  if (executableRelative.startsWith('..') || path.isAbsolute(executableRelative)) {
    throw new Error('Summary runtime executable directory escaped its managed extraction directory.');
  }
  const executableStatsFile = lstatRejectSymlink(executablePath, fsModule, 'summary runtime executable');
  if (typeof executableStatsFile.isFile === 'function' && !executableStatsFile.isFile()) {
    throw new Error('Summary runtime executable is not a regular file.');
  }
  const realExecutable = path.resolve(realpathSync(executablePath));
  const executableFileRelative = path.relative(realExtractRoot, realExecutable);
  if (executableFileRelative.startsWith('..') || path.isAbsolute(executableFileRelative)) {
    throw new Error('Summary runtime executable escaped its managed extraction directory.');
  }
  const unexpectedLoaderFiles = collectUnexpectedSummaryRuntimeLoaderFiles({
    runtimeDir: realExtractRoot,
    runtimeArtifact: selectedRuntimeArtifact,
    requiredFiles: getSummaryRuntimeRequiredFiles(selectedRuntimeArtifact),
    executablePath: realExecutable,
    fsModule,
  });
  if (unexpectedLoaderFiles.length > 0) {
    throw new Error(`Unexpected summary runtime loader files: ${unexpectedLoaderFiles.join(', ')}`);
  }
  if (!seenRuntimeDirs.has(executableDir)) {
    runtimeLibraryDirs.unshift(executableDir);
  }

  const managedRoot = getManagedLinuxCudaRuntimeTarget(userDataDir);
  let driverDirs = [];
  try {
    driverDirs = driverLibraryDirs || resolveLinuxCudaDriverLibraryDirs({ fsModule });
  } catch (_driverError) {
    // The loader can still use the system default driver search path. Never
    // weaken the managed path or admit an unvalidated driver directory.
    driverDirs = [];
  }
  const managedPath = buildContainedLinuxCudaLibraryPath({
    managedRoot,
    libraryDirs: getManagedLinuxCudaLibraryDirs(managedRoot),
    driverLibraryDirs: driverDirs,
    fsModule,
  });
  return {
    LD_LIBRARY_PATH: [...runtimeLibraryDirs, managedPath].join(path.delimiter),
  };
}

/** In-memory fingerprint → sha256 for skip-rehash when artifact mtime/size unchanged. */
const summaryChecksumFingerprintCache = new Map();

function getSummaryArtifactFingerprint(artifactPath, fsModule = fs) {
  try {
    const statSync = bindFsMethod(fsModule, 'statSync');
    if (!statSync) {
      return null;
    }
    const stat = statSync(artifactPath);
    if (!stat) {
      return null;
    }
    return `${artifactPath}\0${Number(stat.size)}\0${Number(stat.mtimeMs)}`;
  } catch (_error) {
    return null;
  }
}

async function checkSummaryModelCache({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  verifyChecksum = false,
  verifyChecksumIfChanged = false,
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

  const fingerprint = verifyChecksumIfChanged
    ? getSummaryArtifactFingerprint(artifactPath, fsModule)
    : null;
  if (fingerprint) {
    const cached = summaryChecksumFingerprintCache.get(fingerprint);
    if (cached && cached.expectedSha256 === artifact.sha256 && cached.actualSha256 === artifact.sha256) {
      return {
        ...base,
        actualSha256: cached.actualSha256,
        valid: true,
        checksumStatus: 'match',
        validationStatus: 'ready',
        reason: null,
        checksumSkippedUnchanged: true,
      };
    }
  }

  const actualSha256 = await hashFileSha256(artifactPath, fsModule);
  if (actualSha256 !== artifact.sha256) {
    if (fingerprint) {
      summaryChecksumFingerprintCache.delete(fingerprint);
    }
    return {
      ...base,
      actualSha256,
      checksumStatus: 'mismatch',
      validationStatus: 'error',
      reason: 'Summary model artifact checksum does not match the pinned checksum.',
    };
  }

  if (fingerprint) {
    summaryChecksumFingerprintCache.set(fingerprint, {
      expectedSha256: artifact.sha256,
      actualSha256,
    });
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

function deriveDiarizationStatus(featureStatus, tokenStatus, dependencyCache, packCache, runtimeCache, cliPresent, env = process.env) {
  if (!featureStatus.availability.supported) {
    return { ...featureStatus, status: 'unsupported' };
  }
  if (featureStatus.engine === 'speakrs') {
    if (env?.AVANEVIS_PACKAGED === '1' && !cliPresent) {
      return {
        ...featureStatus,
        status: 'error',
        error: SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
      };
    }
    if (featureStatus.status === 'ready' && (!packCache?.valid || !runtimeCache?.valid || !cliPresent)) {
      return {
        ...featureStatus,
        status: 'error',
        error: packCache?.reason || runtimeCache?.reason || getSpeakrsCliMissingMessage(env),
      };
    }
    return featureStatus;
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
  verifyChecksumsIfChanged = false,
  computeAdmission = false,
  includeStorageSizes = false,
  checkTokenEncryption = false,
  env = process.env,
  resourcesPath = process.resourcesPath,
  tokenStatusReader = getDiarizationTokenStatus,
  cudaStatus = null,
} = {}) {
  const { manifest, readError } = loadAiAddonManifest({
    userDataDir,
    existsSync: bindFsMethod(fsModule, 'existsSync'),
    readFileSync: bindFsMethod(fsModule, 'readFileSync'),
    catalog,
  });
  const status = buildAiAddonStatus({
    userDataDir,
    platform,
    arch,
    manifest,
    readError,
    catalog,
    cudaStatus,
  });
  const computeAdmissionEngine = computeAdmission
    ? resolveSpawnDiarizationEngine(status.features.diarization.engine, env)
    : null;
  const tokenStatus = status.features.diarization.engine === 'pyannote'
    ? tokenStatusReader({
      userDataDir,
      safeStorage,
      fsModule,
      checkEncryptionAvailability: checkTokenEncryption,
    })
    : {
      hasToken: false,
      encryptionAvailable: null,
    };
  const diarizationDependencyCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  const speakrsPackCache = await checkSpeakrsModelCache({
    userDataDir,
    platform,
    arch,
    fsModule,
    catalog,
    verifyChecksum: verifyChecksums || computeAdmissionEngine === 'speakrs',
    verifyChecksumIfChanged: computeAdmissionEngine === 'speakrs',
  });
  const speakrsRuntimeCache = await checkSpeakrsRuntimeCache({
    userDataDir,
    platform,
    arch,
    fsModule,
    catalog,
    verifyChecksum: verifyChecksums || computeAdmissionEngine === 'speakrs',
    verifyChecksumIfChanged: computeAdmissionEngine === 'speakrs',
  });
  const packagedSpeakrsLayout = env?.AVANEVIS_PACKAGED === '1'
    ? inspectPackagedSpeakrsLayout({ platform, resourcesPath, fsModule })
    : null;
  const speakrsCliPath = packagedSpeakrsLayout
    ? (packagedSpeakrsLayout.ok ? packagedSpeakrsLayout.cliPath : null)
    : resolveSpeakrsCliPath({ platform, env, fsModule, resourcesPath });
  const speakrsCliPresent = Boolean(speakrsCliPath);
  let summaryCache = await checkSummaryModelCache({
    userDataDir,
    platform,
    arch,
    modelId: status.features.summary.modelId,
    fsModule,
    catalog,
    verifyChecksum: verifyChecksums,
    verifyChecksumIfChanged: Boolean(verifyChecksums && verifyChecksumsIfChanged),
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
  const summaryRuntimeCache = await checkSummaryRuntimeCache({
    userDataDir,
    platform,
    arch,
    modelId: status.features.summary.modelId,
    fsModule,
    catalog,
    verifyChecksum: verifyChecksums,
    verifyChecksumIfChanged: Boolean(verifyChecksums && verifyChecksumsIfChanged),
  });
  const diarization = deriveDiarizationStatus(
    status.features.diarization,
    tokenStatus,
    diarizationDependencyCache,
    speakrsPackCache,
    speakrsRuntimeCache,
    speakrsCliPresent,
    env,
  );
  const summary = deriveSummaryStatus(status.features.summary, summaryCache, summaryRuntimeCache);
  const speakrsReady = Boolean(
    diarization.engine === 'speakrs'
    && diarization.status === 'ready'
    && speakrsPackCache.valid
    && speakrsRuntimeCache.valid
    && speakrsCliPresent,
  );
  const pyannoteReady = Boolean(
    diarization.engine !== 'speakrs'
    && diarization.status === 'ready'
    && diarizationDependencyCache.valid,
  );
  const diarizationWithStorage = {
    ...diarization,
    engine: diarization.engine || 'speakrs',
    recommended: diarization.engine === 'speakrs' && platform === 'darwin' && arch === 'arm64',
    tokenStatus,
    cache: checkDiarizationCache({ userDataDir, modelId: diarization.modelId }),
    packCache: speakrsPackCache,
    runtimeCache: speakrsRuntimeCache,
    cliPresent: speakrsCliPresent,
    cliPath: speakrsCliPath,
    cliMissingMessage: speakrsCliPresent ? null : getSpeakrsCliMissingMessage(env),
    dependencyCache: diarizationDependencyCache,
    setupComplete: speakrsReady || pyannoteReady,
  };
  diarizationWithStorage.storage = buildDiarizationStorageFootprint({
    userDataDir,
    dependencyCache: diarizationDependencyCache,
    packCache: speakrsPackCache,
    runtimeCache: speakrsRuntimeCache,
    engine: diarizationWithStorage.engine,
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

function buildFeatureUpdates({ status, modelId, engine, speakerCount, artifactId, profile, validation, error }) {
  const updates = {
    status,
    lastValidation: validation,
    error: error || null,
  };

  if (modelId) {
    updates.modelId = modelId;
  }
  if (engine) {
    updates.engine = engine;
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
  buildSummaryRuntimeEnv,
  getDiarizationDependencySitePackagesDir,
  getDiarizationModelCacheDir,
  getSpeakrsModelCacheDir,
  getSpeakrsModelRevisionDir,
  getSpeakrsOrtRuntimeDir,
  getSpeakrsSourceFilePath,
  getSpeakrsUninstallPaths,
  getPyannoteUninstallPaths,
  hasSpeakrsLocalState,
  hasPyannoteLocalState,
  resolveSpeakrsCliPath,
  resolveSpeakrsCliPathForSpawn,
  getSpeakrsCliExecutableName,
  getBundledSpeakrsCliPath,
  getSpeakrsCliMissingMessage,
  getPackagedSpeakrsCliPreflightError,
  SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
  isNativeSpeakrsCliPath,
  resolveSpawnDiarizationEngine,
  assertLinuxSpeakrsOnlyEngine,
  resolveSpeakrsMode,
  canStartGuidedDiarization,
  buildSpeakrsSpawnEnv,
  checkSpeakrsModelCache,
  checkSpeakrsRuntimeCache,
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
  isPinnedByteSize,
  validateSummarySetupArtifact,
  validatePinnedSummarySetup,
  createValidation,
  buildFeatureUpdates,
};
