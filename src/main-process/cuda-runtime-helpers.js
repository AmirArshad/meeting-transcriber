'use strict';

const path = require('path');

const CUDA_RUNTIME_PROFILES = Object.freeze({
  cuda12: Object.freeze({
    id: 'cuda12',
    label: 'CUDA 12 runtime',
    supported: true,
    pipPackages: Object.freeze(['nvidia-cublas-cu12', 'nvidia-cudnn-cu12']),
    requiredDlls: Object.freeze(['cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn64_9.dll']),
    expectedDllPrefixes: Object.freeze(['cublas64_12', 'cublaslt64_12', 'cudnn64_9']),
  }),
  cuda13: Object.freeze({
    id: 'cuda13',
    label: 'CUDA 13 runtime',
    supported: false,
    pipPackages: Object.freeze(['nvidia-cublas', 'nvidia-cudnn-cu13']),
    requiredDlls: Object.freeze(['cublas64_13.dll', 'cublasLt64_13.dll', 'cudnn64_9.dll']),
    expectedDllPrefixes: Object.freeze(['cublas64_13', 'cublaslt64_13']),
  }),
});
const SUPPORTED_TRANSCRIPTION_CUDA_PROFILE_IDS = Object.freeze(['cuda12']);
const DEFAULT_TRANSCRIPTION_CUDA_PROFILE_ID = SUPPORTED_TRANSCRIPTION_CUDA_PROFILE_IDS[0];
const RETRYABLE_CUDA_TRANSCRIPTION_ERROR_PATTERNS = Object.freeze([
  'cublas64_12.dll',
  'cublas64_13.dll',
  'cublaslt64_12.dll',
  'cublaslt64_13.dll',
  'cudnn',
  'cuda failed',
  'cuda error',
  'is not found or cannot be loaded',
  'cannot be loaded',
]);
const GPU_RUNTIME_ACTION_TIMEOUT_MS = 60 * 60 * 1000;
const LEGACY_TRANSCRIPTION_CUDA_PACKAGES = Object.freeze(['torch', 'torchvision', 'torchaudio']);
const PYTORCH_CUDA_BIN_DIRS = Object.freeze([
  ['nvidia', 'cublas', 'bin'],
  ['nvidia', 'cudnn', 'bin'],
  ['nvidia', 'cuda_runtime', 'bin'],
  ['nvidia', 'cufft', 'bin'],
  ['nvidia', 'curand', 'bin'],
  ['nvidia', 'cusolver', 'bin'],
  ['nvidia', 'cusparse', 'bin'],
  ['nvidia', 'nccl', 'bin'],
  ['nvidia', 'nvjitlink', 'bin'],
  ['nvidia', 'nvtx', 'bin'],
]);

function parsePythonVersion(output) {
  const match = String(output || '').match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function isSupportedCudaInstallPythonVersion(versionInfo) {
  return Boolean(versionInfo && versionInfo.major === 3 && versionInfo.minor === 11);
}

function buildUnsupportedCudaPythonMessage(versionOutput) {
  const versionInfo = parsePythonVersion(versionOutput);
  const version = versionInfo ? versionInfo.version : String(versionOutput || '').trim() || 'unknown';
  return [
    `GPU acceleration setup requires AvaNevis' supported Python 3.11 runtime, but the current runtime is Python ${version}.`,
    'Start dev mode from a Python 3.11 virtual environment, set AVANEVIS_PYTHON to a Python 3.11 executable, or install Python 3.11 so the Windows py launcher can resolve py -3.11.',
  ].join(' ');
}

function getPythonSitePackagesCandidates({ pythonExe = '', virtualEnv = '', appData = '', platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return [];
  }

  const pythonExeDir = pythonExe ? path.dirname(pythonExe) : '';
  const pythonRootDir = path.basename(pythonExeDir).toLowerCase() === 'scripts'
    ? path.dirname(pythonExeDir)
    : pythonExeDir;

  return [
    pythonRootDir ? path.join(pythonRootDir, 'Lib', 'site-packages') : null,
    virtualEnv ? path.join(virtualEnv, 'Lib', 'site-packages') : null,
    appData ? path.join(appData, 'Python', 'Python311', 'site-packages') : null,
  ].filter(Boolean);
}

function getPyTorchCudaBinCandidates(sitePackagesDirs = []) {
  const candidates = [];
  for (const sitePackagesDir of sitePackagesDirs || []) {
    for (const parts of PYTORCH_CUDA_BIN_DIRS) {
      candidates.push(path.join(sitePackagesDir, ...parts));
    }
  }
  return candidates;
}

function getCudaRuntimeProfile(profileId = DEFAULT_TRANSCRIPTION_CUDA_PROFILE_ID) {
  return CUDA_RUNTIME_PROFILES[profileId] || null;
}

function getCudaRuntimeProfiles() {
  return Object.values(CUDA_RUNTIME_PROFILES);
}

function getSupportedTranscriptionCudaProfileIds() {
  return [...SUPPORTED_TRANSCRIPTION_CUDA_PROFILE_IDS];
}

function getRequiredCudaRuntimeDlls(profileId = DEFAULT_TRANSCRIPTION_CUDA_PROFILE_ID) {
  const profile = getCudaRuntimeProfile(profileId);
  return profile ? [...profile.requiredDlls] : [];
}

function getTranscriptionCudaPackages(profileId = DEFAULT_TRANSCRIPTION_CUDA_PROFILE_ID) {
  const profile = getCudaRuntimeProfile(profileId);
  return profile ? [...profile.pipPackages] : [];
}

function buildTranscriptionCudaInstallArgs(options = {}) {
  const profileId = typeof options === 'string'
    ? options
    : (options && options.profileId) || DEFAULT_TRANSCRIPTION_CUDA_PROFILE_ID;
  const forceReinstall = Boolean(options && options.forceReinstall);
  const noCache = Boolean(options && options.noCache);
  const explicitPackages = Array.isArray(options && options.packages) ? options.packages : null;
  const packages = explicitPackages && explicitPackages.length
    ? explicitPackages
    : getTranscriptionCudaPackages(profileId);
  const args = [
    '-m',
    'pip',
    'install',
  ];
  if (forceReinstall) {
    args.push('--upgrade', '--force-reinstall');
  }
  if (noCache) {
    args.push('--no-cache-dir');
  }
  args.push(
    ...packages,
    '--no-warn-script-location',
  );
  return args;
}

function buildTranscriptionCudaUninstallArgs(options = {}) {
  const profileId = typeof options === 'string'
    ? options
    : (options && options.profileId) || DEFAULT_TRANSCRIPTION_CUDA_PROFILE_ID;
  const explicitPackages = Array.isArray(options && options.packages) ? options.packages : null;
  const packages = explicitPackages && explicitPackages.length
    ? explicitPackages
    : getTranscriptionCudaPackages(profileId);
  return [
    '-m',
    'pip',
    'uninstall',
    '-y',
    ...packages,
    ...LEGACY_TRANSCRIPTION_CUDA_PACKAGES,
  ];
}

function isRetryableCudaTranscriptionError(errorOutput) {
  const normalized = String(errorOutput || '').toLowerCase();
  if (!normalized) {
    return false;
  }
  return RETRYABLE_CUDA_TRANSCRIPTION_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

function classifyCudaProbeStatus({
  deviceAvailable = false,
  runtimeLoadable = false,
  missingLibraries = [],
  unsupportedDetectedProfiles = [],
} = {}) {
  if (deviceAvailable && runtimeLoadable) {
    return 'ready';
  }
  if (unsupportedDetectedProfiles.length > 0) {
    return 'unsupportedRuntimeMajor';
  }
  if (deviceAvailable && missingLibraries.length > 0) {
    return 'missingLibraries';
  }
  if (!deviceAvailable) {
    return 'deviceUnavailable';
  }
  return 'runtimeUnavailable';
}

function resolveCudaInstalledProfile({ matchedProfile = '', installedProfile = '', unsupportedDetectedProfiles = [] } = {}) {
  if (matchedProfile) {
    return matchedProfile;
  }
  if (installedProfile) {
    return installedProfile;
  }
  return unsupportedDetectedProfiles[0] || '';
}

function cudaStatusNeedsGpuRuntimeEnsure(status = {}) {
  if (!status || status.installed) {
    return false;
  }
  const statusCode = String(status.statusCode || '').trim();
  if (statusCode === 'unsupportedPlatform' || statusCode === 'probeError' || statusCode === 'deviceUnavailable') {
    return false;
  }
  return statusCode === 'missingLibraries'
    || statusCode === 'unsupportedRuntimeMajor'
    || statusCode === 'runtimeUnavailable';
}

function selectGpuInstallModeForCudaStatus(status = {}, { forceRepair = false } = {}) {
  if (forceRepair) {
    return 'repair';
  }
  const statusCode = String(status.statusCode || '').trim();
  if (statusCode === 'unsupportedRuntimeMajor' || statusCode === 'missingLibraries') {
    return 'repair';
  }
  return 'install';
}

function getGpuRuntimeEnsurePlan(status = {}, { forceRepair = false, skipInstallIfReady = true } = {}) {
  if (status && status.installed && skipInstallIfReady && !forceRepair) {
    return {
      action: 'none',
      shouldInstall: false,
      success: true,
      message: 'CUDA runtime is already installed and loadable.',
    };
  }

  if (status && status.installed) {
    return {
      action: 'repair',
      shouldInstall: true,
      success: false,
      message: 'CUDA runtime is already loadable; forcing a repair reinstall.',
    };
  }

  if (!cudaStatusNeedsGpuRuntimeEnsure(status)) {
    return {
      action: 'none',
      shouldInstall: false,
      success: false,
      message: `GPU runtime is not ready (${status && status.statusCode ? status.statusCode : 'unknown'}).`,
    };
  }

  const action = selectGpuInstallModeForCudaStatus(status, { forceRepair });
  return {
    action,
    shouldInstall: true,
    success: false,
    message: action === 'repair'
      ? 'GPU runtime requires a repair reinstall.'
      : 'GPU runtime libraries need to be installed.',
  };
}

function parseCheckCudaStatus(output = '') {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const values = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    values[key] = value;
  }

  const deviceAvailable = values.deviceAvailable === 'True' || values.deviceAvailable === 'true';
  const runtimeLoadable = values.runtimeLoadable === 'True' || values.runtimeLoadable === 'true';
  const missingLibraries = (values.missingLibraries || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const runtime = values.runtime || 'ctranslate2';
  const error = values.error || '';
  const matchedProfile = values.matchedProfile || '';
  const rawInstalledProfile = values.installedProfile || '';
  const unsupportedDetectedProfiles = (values.unsupportedDetectedProfiles || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const supportedProfiles = (values.supportedProfiles || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const recommendedInstallProfile = values.recommendedInstallProfile || DEFAULT_TRANSCRIPTION_CUDA_PROFILE_ID;
  const statusCode = classifyCudaProbeStatus({
    deviceAvailable,
    runtimeLoadable,
    missingLibraries,
    unsupportedDetectedProfiles,
  });
  const installedProfile = resolveCudaInstalledProfile({
    matchedProfile,
    installedProfile: rawInstalledProfile,
    unsupportedDetectedProfiles,
  });

  return {
    installed: Boolean(deviceAvailable && runtimeLoadable && missingLibraries.length === 0),
    deviceAvailable,
    runtimeLoadable,
    missingLibraries,
    runtime,
    error,
    statusCode,
    matchedProfile,
    installedProfile,
    supportedProfiles: supportedProfiles.length ? supportedProfiles : getSupportedTranscriptionCudaProfileIds(),
    unsupportedDetectedProfiles,
    recommendedInstallProfile,
  };
}

function shouldForceCpuTranscriptionFromCudaStatus(status = null) {
  return Boolean(
    status
    && status.deviceAvailable === true
    && status.runtimeLoadable === false
  );
}

module.exports = {
  CUDA_RUNTIME_PROFILES,
  getCudaRuntimeProfile,
  getCudaRuntimeProfiles,
  getSupportedTranscriptionCudaProfileIds,
  getRequiredCudaRuntimeDlls,
  getTranscriptionCudaPackages,
  buildTranscriptionCudaInstallArgs,
  buildTranscriptionCudaUninstallArgs,
  buildUnsupportedCudaPythonMessage,
  getPythonSitePackagesCandidates,
  getPyTorchCudaBinCandidates,
  classifyCudaProbeStatus,
  resolveCudaInstalledProfile,
  cudaStatusNeedsGpuRuntimeEnsure,
  selectGpuInstallModeForCudaStatus,
  getGpuRuntimeEnsurePlan,
  shouldForceCpuTranscriptionFromCudaStatus,
  isRetryableCudaTranscriptionError,
  parseCheckCudaStatus,
  isSupportedCudaInstallPythonVersion,
  parsePythonVersion,
  PYTORCH_CUDA_BIN_DIRS,
  GPU_RUNTIME_ACTION_TIMEOUT_MS,
};
