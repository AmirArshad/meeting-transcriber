'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  assertLinuxCudaCatalogIntegrity,
  getLinuxCuda12RuntimeCatalog,
  getLinuxCudaDriverLibraryAllowlist,
} = require('./linux-cuda-runtime-catalog');

const KNOWN_CUDA_PROBE_STATUS_CODES = Object.freeze([
  'ready',
  'missingLibraries',
  'unsupportedRuntimeMajor',
  'deviceUnavailable',
  'runtimeUnavailable',
  'probeError',
  'unsupportedPlatform',
  'probeDeferredDuringGpuAction',
  'repairRecommendedAfterQuit',
  'runtimeIntegrityFailed',
]);

function isKnownCudaProbeStatusCode(value) {
  return KNOWN_CUDA_PROBE_STATUS_CODES.includes(String(value || '').trim());
}

function isWorldWritableMode(mode) {
  return (Number(mode) & 0o002) !== 0;
}

function assertAbsolutePath(targetPath, label) {
  if (!targetPath || !path.isAbsolute(targetPath)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return targetPath;
}

function lstatRejectSymlink(targetPath, fsModule, label) {
  const lstatSync = fsModule.lstatSync || fs.lstatSync;
  let stats;
  try {
    stats = lstatSync(targetPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const missing = new Error(`${label} does not exist: ${targetPath}`);
      missing.code = 'ENOENT';
      throw missing;
    }
    throw error;
  }
  if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) {
    throw new Error(`Rejected symbolic link in CUDA runtime path: ${targetPath}`);
  }
  return stats;
}

function realpathNoEscape(targetPath, fsModule) {
  const realpathSync = (fsModule.realpathSync && fsModule.realpathSync.native)
    || fsModule.realpathSync
    || fs.realpathSync;
  return path.resolve(realpathSync(targetPath));
}

function assertContainedPath(rootPath, candidatePath, fsModule, label) {
  const realRoot = realpathNoEscape(rootPath, fsModule);
  const realCandidate = realpathNoEscape(candidatePath, fsModule);
  const relative = path.relative(realRoot, realCandidate);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (realCandidate !== realRoot) {
      throw new Error(`${label} escapes the managed CUDA runtime root.`);
    }
  }
  return { realRoot, realCandidate };
}

function validateLinuxCudaManagedRoot(managedRoot, fsModule = fs) {
  assertAbsolutePath(managedRoot, 'Managed CUDA runtime root');
  const stats = lstatRejectSymlink(managedRoot, fsModule, 'Managed CUDA runtime root');
  if (typeof stats.isDirectory === 'function' && !stats.isDirectory()) {
    throw new Error('Managed CUDA runtime root must be a directory.');
  }
  if (isWorldWritableMode(stats.mode)) {
    throw new Error('Managed CUDA runtime root must not be world-writable.');
  }
  return realpathNoEscape(managedRoot, fsModule);
}

function validateLinuxCudaLibraryDirectory(managedRoot, libraryDir, fsModule = fs) {
  assertAbsolutePath(libraryDir, 'Managed CUDA library directory');
  const stats = lstatRejectSymlink(libraryDir, fsModule, 'Managed CUDA library directory');
  if (typeof stats.isDirectory === 'function' && !stats.isDirectory()) {
    throw new Error('Managed CUDA library directory must be a directory.');
  }
  if (isWorldWritableMode(stats.mode)) {
    throw new Error('Managed CUDA library directory must not be world-writable.');
  }
  const { realCandidate } = assertContainedPath(managedRoot, libraryDir, fsModule, 'Managed CUDA library directory');
  return realCandidate;
}

function validateLinuxCudaLibraryFile(managedRoot, libraryPath, fsModule = fs) {
  assertAbsolutePath(libraryPath, 'Managed CUDA library');
  const stats = lstatRejectSymlink(libraryPath, fsModule, 'Managed CUDA library');
  if (typeof stats.isFile === 'function' && !stats.isFile()) {
    throw new Error(`Managed CUDA library must be a regular file: ${libraryPath}`);
  }
  if (isWorldWritableMode(stats.mode)) {
    throw new Error(`Managed CUDA library must not be world-writable: ${libraryPath}`);
  }
  const { realCandidate } = assertContainedPath(managedRoot, libraryPath, fsModule, 'Managed CUDA library');
  return { realPath: realCandidate, stats };
}

function canCurrentUserWrite(targetPath, fsModule = fs) {
  const accessSync = fsModule.accessSync || fs.accessSync;
  const W_OK = (fsModule.constants && fsModule.constants.W_OK)
    || (fs.constants && fs.constants.W_OK)
    || 2;
  try {
    accessSync(targetPath, W_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function resolveLinuxCudaDriverLibraryDirs({
  fsModule = fs,
  allowlist = getLinuxCudaDriverLibraryAllowlist(),
} = {}) {
  const resolved = [];
  const seen = new Set();
  const allowedReal = new Set();
  for (const candidate of allowlist) {
    if (!candidate || !path.isAbsolute(candidate)) {
      continue;
    }
    try {
      allowedReal.add(realpathNoEscape(candidate, fsModule));
    } catch (_error) {
      // Candidate may not exist; skip.
    }
  }
  for (const candidate of allowlist) {
    if (!candidate || typeof candidate !== 'string' || !candidate.trim()) {
      continue;
    }
    if (!path.isAbsolute(candidate)) {
      throw new Error('CUDA driver library allowlist entries must be absolute paths.');
    }
    let stats;
    try {
      stats = lstatRejectSymlink(candidate, fsModule, 'CUDA driver library directory');
    } catch (error) {
      if (error && (error.code === 'ENOENT' || /does not exist/.test(error.message))) {
        continue;
      }
      throw error;
    }
    if (typeof stats.isDirectory === 'function' && !stats.isDirectory()) {
      continue;
    }
    if (isWorldWritableMode(stats.mode)) {
      throw new Error(`Rejected world-writable CUDA driver library directory: ${candidate}`);
    }
    const realDir = realpathNoEscape(candidate, fsModule);
    if (!allowedReal.has(realDir)) {
      throw new Error(`CUDA driver library directory escaped the canonical allowlist: ${candidate}`);
    }
    if (canCurrentUserWrite(realDir, fsModule)) {
      throw new Error(`Rejected writable CUDA driver library directory: ${realDir}`);
    }
    if (seen.has(realDir)) {
      continue;
    }
    seen.add(realDir);
    resolved.push(realDir);
  }
  return resolved;
}

function buildContainedLinuxCudaLibraryPath({
  managedRoot = '',
  libraryDirs = [],
  driverLibraryDirs = [],
  fsModule = fs,
} = {}) {
  if (!managedRoot || !path.isAbsolute(managedRoot)) {
    throw new Error('Managed CUDA runtime root must be an absolute path.');
  }
  const validatedManaged = [];
  const seen = new Set();
  for (const libraryDir of libraryDirs) {
    if (!libraryDir || !path.isAbsolute(libraryDir)) {
      throw new Error('Managed CUDA library directories must be absolute paths.');
    }
    const resolvedDir = validateLinuxCudaLibraryDirectory(managedRoot, libraryDir, fsModule);
    if (seen.has(resolvedDir)) {
      throw new Error('Managed CUDA library directories must not contain a duplicate.');
    }
    seen.add(resolvedDir);
    validatedManaged.push(resolvedDir);
  }
  if (validatedManaged.length === 0) {
    throw new Error('Managed CUDA library directories must not be empty.');
  }
  const validatedDrivers = [];
  for (const driverDir of driverLibraryDirs) {
    if (!driverDir) {
      continue;
    }
    if (!path.isAbsolute(driverDir)) {
      throw new Error('CUDA driver library directories must be absolute paths.');
    }
    if (seen.has(driverDir)) {
      throw new Error('CUDA library path must not contain a duplicate.');
    }
    seen.add(driverDir);
    validatedDrivers.push(driverDir);
  }
  return [...validatedManaged, ...validatedDrivers].join(path.delimiter);
}

function hashFileSha256Sync(filePath, fsModule = fs) {
  const readFileSync = fsModule.readFileSync || fs.readFileSync;
  return crypto.createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function hashFileSha256(filePath, fsModule = fs) {
  const createReadStream = fsModule.createReadStream || fs.createReadStream;
  if (typeof createReadStream !== 'function') {
    return hashFileSha256Sync(filePath, fsModule);
  }
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function resolveRequiredLinuxCudaLibraryPath(managedRoot, library, fsModule = fs) {
  const relativePath = String(library.relativePath || '').replace(/\\/g, '/');
  if (!relativePath || relativePath.includes('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe CUDA library relative path: ${library.fileName || relativePath}`);
  }
  const libraryPath = path.join(managedRoot, ...relativePath.split('/'));
  return validateLinuxCudaLibraryFile(managedRoot, libraryPath, fsModule).realPath;
}

async function verifyLinuxCudaRuntimeIntegrity({
  managedRoot,
  catalog = getLinuxCuda12RuntimeCatalog(),
  fsModule = fs,
} = {}) {
  assertLinuxCudaCatalogIntegrity(catalog);
  let validatedRoot;
  try {
    validatedRoot = validateLinuxCudaManagedRoot(managedRoot, fsModule);
  } catch (error) {
    return {
      ok: false,
      statusCode: 'missingLibraries',
      missingLibraries: getLinuxCuda12RuntimeCatalog().probeLibraryFileNames.slice(),
      error: error.message,
    };
  }

  const missingLibraries = [];
  for (const library of catalog.requiredLibraries) {
    let libraryPath;
    try {
      libraryPath = resolveRequiredLinuxCudaLibraryPath(validatedRoot, library, fsModule);
    } catch (_error) {
      missingLibraries.push(library.fileName);
      continue;
    }
    const stats = (fsModule.statSync || fs.statSync)(libraryPath);
    const size = Number(stats.size);
    if (Number(library.sizeBytes) && size !== Number(library.sizeBytes)) {
      return {
        ok: false,
        statusCode: 'runtimeIntegrityFailed',
        missingLibraries: [],
        error: `Managed CUDA library size mismatch: ${library.fileName}`,
      };
    }
    const actualSha256 = await hashFileSha256(libraryPath, fsModule);
    if (actualSha256 !== library.sha256) {
      return {
        ok: false,
        statusCode: 'runtimeIntegrityFailed',
        missingLibraries: [],
        error: `Managed CUDA library hash mismatch: ${library.fileName}`,
      };
    }
  }

  if (missingLibraries.length > 0) {
    return {
      ok: false,
      statusCode: 'missingLibraries',
      missingLibraries,
      error: `Managed CUDA libraries are missing: ${missingLibraries.join(', ')}`,
    };
  }

  const unexpectedLoaderFiles = collectUnexpectedLinuxCudaLoaderFiles({
    managedRoot: validatedRoot,
    catalog,
    fsModule,
  });
  if (unexpectedLoaderFiles.length > 0) {
    return {
      ok: false,
      statusCode: 'runtimeIntegrityFailed',
      missingLibraries: [],
      error: `Unexpected CUDA loader-directory files: ${unexpectedLoaderFiles.join(', ')}`,
    };
  }

  return {
    ok: true,
    statusCode: 'ready',
    missingLibraries: [],
    error: '',
    managedRoot: validatedRoot,
  };
}

function isLinuxSharedLibraryFileName(name) {
  return /\.so(?:\.|$)/.test(String(name || ''));
}

function getLinuxCudaLoaderRelativeDirs(catalog = getLinuxCuda12RuntimeCatalog()) {
  const dirs = [];
  const seen = new Set();
  const add = (relativeDir) => {
    const normalized = String(relativeDir || '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalized || normalized.includes('..') || path.isAbsolute(normalized) || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    dirs.push(normalized);
  };
  for (const relativeDir of catalog.libraryRelativeDirs || []) {
    add(relativeDir);
  }
  for (const library of catalog.requiredLibraries || []) {
    const relativePath = String(library.relativePath || '').replace(/\\/g, '/');
    const relativeDir = relativePath.split('/').slice(0, -1).join('/');
    add(relativeDir);
  }
  return dirs;
}

function collectUnexpectedLinuxCudaLoaderFiles({
  managedRoot,
  catalog = getLinuxCuda12RuntimeCatalog(),
  fsModule = fs,
} = {}) {
  const expectedByDir = new Map();
  for (const library of catalog.requiredLibraries || []) {
    const relativePath = String(library.relativePath || '').replace(/\\/g, '/');
    const relativeDir = relativePath.split('/').slice(0, -1).join('/');
    if (!expectedByDir.has(relativeDir)) {
      expectedByDir.set(relativeDir, new Set());
    }
    expectedByDir.get(relativeDir).add(library.fileName);
  }

  const unexpected = [];
  const readdirSync = fsModule.readdirSync || fs.readdirSync;
  for (const relativeDir of getLinuxCudaLoaderRelativeDirs(catalog)) {
    const absDir = path.join(managedRoot, ...relativeDir.split('/'));
    let names;
    try {
      names = readdirSync(absDir);
    } catch (_error) {
      continue;
    }
    const allowed = expectedByDir.get(relativeDir) || new Set();
    for (const name of names) {
      if (!isLinuxSharedLibraryFileName(name) || allowed.has(name)) {
        continue;
      }
      unexpected.push(`${relativeDir}/${name}`);
    }
  }
  return unexpected;
}

function getLinuxCudaWheelhousePath(userDataPath) {
  if (!userDataPath || !path.isAbsolute(userDataPath)) {
    throw new Error('CUDA wheelhouse userData path must be an absolute path.');
  }
  return path.join(path.resolve(userDataPath), 'ai-addons', 'cuda', 'wheelhouse');
}

function getLinuxCudaTombstonePath(activePath, { now = Date.now(), pid = process.pid } = {}) {
  return `${activePath}.tombstone-${now}-${pid}`;
}

function getLinuxCudaRuntimeStagingPath(activePath, { now = Date.now(), pid = process.pid } = {}) {
  return `${activePath}.staging-${now}-${pid}`;
}

function getLinuxCudaWheelStagePath(userDataPath, { now = Date.now(), pid = process.pid } = {}) {
  if (!userDataPath || !path.isAbsolute(userDataPath)) {
    throw new Error('CUDA wheel stage userData path must be an absolute path.');
  }
  return path.join(path.resolve(userDataPath), 'ai-addons', 'cuda', `wheel-stage-${now}-${pid}`);
}

function stageVerifiedLinuxCudaWheels({
  sourceDir,
  stagingDir,
  catalog = getLinuxCuda12RuntimeCatalog(),
  fsModule = fs,
} = {}) {
  assertLinuxCudaCatalogIntegrity(catalog);
  if (!sourceDir || !path.isAbsolute(sourceDir)) {
    throw new Error('Linux CUDA wheel source directory must be an absolute path.');
  }
  if (!stagingDir || !path.isAbsolute(stagingDir)) {
    throw new Error('Linux CUDA wheel staging directory must be an absolute path.');
  }
  if (path.resolve(sourceDir) === path.resolve(stagingDir)) {
    throw new Error('Linux CUDA wheel staging directory must not be the persistent wheelhouse.');
  }
  const mkdirSync = fsModule.mkdirSync || fs.mkdirSync;
  const copyFileSync = fsModule.copyFileSync || fs.copyFileSync;
  mkdirSync(stagingDir, { recursive: true });
  return catalog.wheels.map((wheel) => {
    const destinationPath = path.join(stagingDir, wheel.fileName);
    copyFileSync(path.join(sourceDir, wheel.fileName), destinationPath);
    verifyDownloadedLinuxCudaWheel(destinationPath, wheel, fsModule);
    return destinationPath;
  });
}

function buildLinuxCudaOfflineInstallArgs({
  wheelPaths,
  target,
  catalog = getLinuxCuda12RuntimeCatalog(),
} = {}) {
  assertLinuxCudaCatalogIntegrity(catalog);
  if (!target || !path.isAbsolute(target)) {
    throw new Error('Linux CUDA install target must be an absolute path.');
  }
  if (!Array.isArray(wheelPaths) || wheelPaths.length !== catalog.wheels.length) {
    throw new Error('Linux CUDA install requires the exact verified wheel closure.');
  }
  const resolvedWheels = wheelPaths.map((wheelPath, index) => {
    if (!wheelPath || !path.isAbsolute(wheelPath)) {
      throw new Error('Linux CUDA wheel paths must be absolute.');
    }
    const expectedName = catalog.wheels[index].fileName;
    if (path.basename(wheelPath) !== expectedName) {
      throw new Error(`Linux CUDA wheel path does not match catalog name: ${expectedName}`);
    }
    return path.resolve(wheelPath);
  });
  return [
    '-m',
    'pip',
    'install',
    '--no-index',
    '--no-deps',
    '--no-compile',
    '--only-binary=:all:',
    '--no-cache-dir',
    '--no-warn-script-location',
    '--target',
    path.resolve(target),
    ...resolvedWheels,
  ];
}

function swapLinuxCudaRuntimeAtomically({
  activePath,
  stagingPath,
  fsModule = fs,
  now = Date.now(),
  pid = process.pid,
} = {}) {
  assertAbsolutePath(activePath, 'Active CUDA runtime');
  assertAbsolutePath(stagingPath, 'Staged CUDA runtime');
  if (path.resolve(activePath) === path.resolve(stagingPath)) {
    throw new Error('CUDA runtime staging path must not be the active path.');
  }
  const existsSync = fsModule.existsSync || fs.existsSync;
  const renameSync = fsModule.renameSync || fs.renameSync;
  const tombstonePath = getLinuxCudaTombstonePath(activePath, { now, pid });
  let renamedActive = false;
  try {
    if (existsSync(activePath)) {
      renameSync(activePath, tombstonePath);
      renamedActive = true;
    }
    renameSync(stagingPath, activePath);
  } catch (error) {
    if (renamedActive && !existsSync(activePath) && existsSync(tombstonePath)) {
      try {
        renameSync(tombstonePath, activePath);
      } catch (_rollbackError) {
        // Keep the original swap failure. The tombstone still holds the prior runtime.
      }
    }
    throw error;
  }
  return { tombstonePath, renamedActive };
}

function verifyDownloadedLinuxCudaWheel(filePath, wheel, fsModule = fs) {
  const stats = lstatRejectSymlink(filePath, fsModule, 'Downloaded CUDA wheel');
  if (typeof stats.isFile === 'function' && !stats.isFile()) {
    throw new Error(`CUDA wheel is not a regular file: ${wheel.fileName}`);
  }
  if (Number(stats.size) !== Number(wheel.sizeBytes)) {
    throw new Error(`CUDA wheel size mismatch: ${wheel.fileName}`);
  }
  const actualSha256 = hashFileSha256Sync(filePath, fsModule);
  if (actualSha256 !== wheel.sha256) {
    throw new Error(`CUDA wheel hash mismatch: ${wheel.fileName}`);
  }
  return true;
}

function detectUnsupportedLinuxCudaMajor({
  libraryDirs = [],
  prefixes = getLinuxCuda12RuntimeCatalog().unsupportedLibraryPrefixes,
  fsModule = fs,
} = {}) {
  const detected = [];
  const normalizedPrefixes = prefixes.map((prefix) => String(prefix).toLowerCase());
  for (const libraryDir of libraryDirs) {
    let names;
    try {
      names = (fsModule.readdirSync || fs.readdirSync)(libraryDir);
    } catch (_error) {
      continue;
    }
    for (const name of names) {
      const lower = String(name).toLowerCase();
      if (normalizedPrefixes.some((prefix) => lower.startsWith(prefix))) {
        if (!detected.includes('cuda13')) {
          detected.push('cuda13');
        }
      }
    }
  }
  return detected;
}

function buildProbeErrorStatus(error, extras = {}) {
  return {
    installed: false,
    deviceAvailable: false,
    runtimeLoadable: false,
    missingLibraries: [],
    runtime: 'ctranslate2',
    statusCode: 'probeError',
    matchedProfile: '',
    installedProfile: '',
    supportedProfiles: ['cuda12'],
    unsupportedDetectedProfiles: [],
    recommendedInstallProfile: 'cuda12',
    error: String(error || 'CUDA probe failed.'),
    ...extras,
  };
}

function isLinuxCudaStatusReadyForAdmission(status, expectedProfile = 'cuda12') {
  if (!status || typeof status !== 'object') {
    return false;
  }
  return status.statusCode === 'ready'
    && status.installed === true
    && status.deviceAvailable === true
    && status.runtimeLoadable === true
    && Array.isArray(status.missingLibraries)
    && status.missingLibraries.length === 0
    && status.matchedProfile === expectedProfile;
}

function parseLinuxCheckCudaStatus(output = '', { expectedProfile = 'cuda12' } = {}) {
  const raw = String(output || '').trim();
  if (!raw) {
    return buildProbeErrorStatus('CUDA probe produced no output.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_error) {
    return buildProbeErrorStatus('CUDA probe returned invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return buildProbeErrorStatus('CUDA probe returned invalid JSON.');
  }

  if (typeof parsed.deviceAvailable !== 'boolean'
    || typeof parsed.runtimeLoadable !== 'boolean'
    || !Array.isArray(parsed.missingLibraries)
    || typeof parsed.statusCode !== 'string') {
    return buildProbeErrorStatus('CUDA probe JSON failed schema validation.');
  }

  const statusCode = parsed.statusCode.trim();
  if (!isKnownCudaProbeStatusCode(statusCode)) {
    return buildProbeErrorStatus('CUDA probe returned an unknown statusCode.');
  }

  const deviceAvailable = parsed.deviceAvailable;
  const runtimeLoadable = parsed.runtimeLoadable;
  const missingLibraries = parsed.missingLibraries.map((item) => String(item));
  const matchedProfile = typeof parsed.matchedProfile === 'string' ? parsed.matchedProfile : '';
  const unsupportedDetectedProfiles = Array.isArray(parsed.unsupportedDetectedProfiles)
    ? parsed.unsupportedDetectedProfiles.map((item) => String(item))
    : [];
  const supportedProfiles = Array.isArray(parsed.supportedProfiles)
    ? parsed.supportedProfiles.map((item) => String(item))
    : ['cuda12'];
  const rawInstalledProfile = typeof parsed.installedProfile === 'string' ? parsed.installedProfile : '';
  const installedProfile = matchedProfile || rawInstalledProfile || unsupportedDetectedProfiles[0] || '';
  const readyConsistent = deviceAvailable === true
    && runtimeLoadable === true
    && missingLibraries.length === 0
    && matchedProfile === expectedProfile
    && statusCode === 'ready';

  if (statusCode === 'ready' && !readyConsistent) {
    return buildProbeErrorStatus(
      'CUDA probe reported ready without a consistent device, runtime, and matched profile.',
    );
  }

  return {
    installed: readyConsistent,
    deviceAvailable,
    runtimeLoadable,
    missingLibraries,
    runtime: typeof parsed.runtime === 'string' && parsed.runtime ? parsed.runtime : 'ctranslate2',
    error: parsed.error == null ? '' : String(parsed.error),
    statusCode,
    matchedProfile,
    installedProfile,
    supportedProfiles: supportedProfiles.length ? supportedProfiles : ['cuda12'],
    unsupportedDetectedProfiles,
    recommendedInstallProfile: parsed.recommendedInstallProfile || expectedProfile,
    deviceProbe: parsed.deviceProbe || null,
  };
}

module.exports = {
  KNOWN_CUDA_PROBE_STATUS_CODES,
  isKnownCudaProbeStatusCode,
  isWorldWritableMode,
  lstatRejectSymlink,
  validateLinuxCudaManagedRoot,
  validateLinuxCudaLibraryDirectory,
  validateLinuxCudaLibraryFile,
  resolveLinuxCudaDriverLibraryDirs,
  buildContainedLinuxCudaLibraryPath,
  hashFileSha256,
  hashFileSha256Sync,
  resolveRequiredLinuxCudaLibraryPath,
  verifyLinuxCudaRuntimeIntegrity,
  collectUnexpectedLinuxCudaLoaderFiles,
  isLinuxSharedLibraryFileName,
  getLinuxCudaWheelhousePath,
  getLinuxCudaTombstonePath,
  getLinuxCudaRuntimeStagingPath,
  getLinuxCudaWheelStagePath,
  stageVerifiedLinuxCudaWheels,
  swapLinuxCudaRuntimeAtomically,
  buildLinuxCudaOfflineInstallArgs,
  verifyDownloadedLinuxCudaWheel,
  detectUnsupportedLinuxCudaMajor,
  buildProbeErrorStatus,
  parseLinuxCheckCudaStatus,
  isLinuxCudaStatusReadyForAdmission,
};
