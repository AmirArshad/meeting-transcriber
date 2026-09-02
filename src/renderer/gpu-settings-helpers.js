(function initGpuSettingsHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.gpuSettingsHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildGpuSettingsHelpers() {
  function isGpuRuntimeActionBusyError(error) {
    const message = String(error && error.message ? error.message : '').toUpperCase();
    return message.includes('GPU_RUNTIME_ACTION_BUSY')
      || message.includes('GPU_RUNTIME_COMPUTE_BUSY')
      || message.includes('MODEL_DOWNLOAD_COMPUTE_BUSY')
      || message.includes('ALREADY IN PROGRESS')
      || message.includes('WAIT FOR TRANSCRIPTION TO FINISH BEFORE')
      || message.includes('QUEUED FOR TRANSCRIPTION');
  }

  /**
   * Prefer the main-process N-queued message for compute-busy codes; use the
   * generic "another GPU setup" copy only for true overlapping GPU installs.
   */
  function formatGpuRuntimeBusyAlertMessage(error) {
    const message = String(error && error.message ? error.message : '').trim();
    const code = String(error && error.code ? error.code : '').toUpperCase();
    const upper = message.toUpperCase();
    if (
      code === 'GPU_RUNTIME_COMPUTE_BUSY'
      || code === 'MODEL_DOWNLOAD_COMPUTE_BUSY'
      || upper.includes('GPU_RUNTIME_COMPUTE_BUSY')
      || upper.includes('MODEL_DOWNLOAD_COMPUTE_BUSY')
      || upper.includes('QUEUED FOR TRANSCRIPTION')
    ) {
      return message || 'Local AI work is still running. Finish or cancel it before continuing.';
    }
    return (
      'Another GPU setup operation is already running.\n\n'
      + 'Please wait for it to finish and then try again.'
    );
  }

  function resolveGpuSettingsSurface(platform, arch) {
    if (platform === 'darwin') {
      return arch === 'arm64' ? 'macos-metal' : 'macos-intel-cpu';
    }
    if (platform === 'win32') {
      return 'windows-cuda';
    }
    return 'unsupported';
  }

  function isLinuxCudaSettingsOffered(platform, cudaInfo) {
    return platform === 'linux'
      && Boolean(cudaInfo)
      && typeof cudaInfo.statusCode === 'string'
      && cudaInfo.statusCode.trim() !== ''
      && cudaInfo.statusCode !== 'unsupportedPlatform';
  }

  function isCudaRuntimeSettingsSurface(platform, cudaInfo) {
    return platform === 'win32' || isLinuxCudaSettingsOffered(platform, cudaInfo);
  }

  function getUnsupportedGpuSettingsCopy(platform) {
    if (platform === 'linux') {
      return {
        description: 'No NVIDIA GPU was detected. Transcription uses CPU faster-whisper. Optional CUDA 12 setup appears when an NVIDIA GPU is available; it is tested on CachyOS x86_64 with an RTX 4070, and other NVIDIA Linux setups are best-effort.',
        statusLabel: 'CPU transcription',
        diagnostics: 'Linux CUDA is opt-in. Uninstall returns transcription to CPU.',
      };
    }
    return {
      description: 'GPU acceleration is not supported on this platform.',
      statusLabel: 'Unsupported',
      diagnostics: 'No GPU runtime is configured for this operating system.',
    };
  }

  function getLinuxCudaSettingsDescription() {
    return 'Optional CUDA 12 acceleration for faster-whisper. Tested on CachyOS x86_64 with an NVIDIA RTX 4070; other NVIDIA Linux setups are best-effort. Transcription uses the CPU until you install a working runtime, and returns to CPU if you uninstall.';
  }

  function getLinuxCudaBrokenRuntimeCopy() {
    return ' Transcription stays on this CUDA install until you repair it or uninstall to return to CPU.';
  }

  function getLinuxCudaUninstallConfirmSuffix() {
    return 'AvaNevis transcription will return to CPU faster-whisper.\n\n';
  }

  function hasLinuxManagedCudaRuntime(cudaInfo) {
    return Boolean(cudaInfo && cudaInfo.managedRuntimePresent === true);
  }

  function isLinuxManagedCudaRuntimeBroken(cudaInfo) {
    return hasLinuxManagedCudaRuntime(cudaInfo) && cudaInfo.installed !== true;
  }

  /**
   * Uninstall stays reachable whenever a Linux managed tree exists, including
   * corrupt/incomplete installs and leftover trees after the GPU disappears.
   * Windows still keys Uninstall on a ready/installed runtime.
   */
  function shouldShowGpuUninstallButton(platform, cudaInfo) {
    if (platform === 'linux') {
      return hasLinuxManagedCudaRuntime(cudaInfo);
    }
    return Boolean(cudaInfo && cudaInfo.installed === true);
  }

  function shouldShowGpuInstallOrRepairButton(cudaInfo) {
    return Boolean(cudaInfo) && cudaInfo.installed !== true;
  }

  function shouldUseGpuRepairButton(platform, cudaInfo) {
    if (!cudaInfo || cudaInfo.installed === true) {
      return false;
    }
    if (cudaInfo.repairRecommendedAfterQuit === true) {
      return true;
    }
    const statusCode = String(cudaInfo.statusCode || '').trim();
    if (statusCode === 'unsupportedRuntimeMajor') {
      return true;
    }
    return platform === 'linux' && isLinuxManagedCudaRuntimeBroken(cudaInfo);
  }

  function shouldShowGpuHomeCta({ platform, gpuInfo, cudaInfo }) {
    return isCudaRuntimeSettingsSurface(platform, cudaInfo)
      && Boolean(gpuInfo && gpuInfo.hasGPU)
      && Boolean(cudaInfo)
      && cudaInfo.installed !== true;
  }

  function shouldShowCudaRuntimeWarning({ platform, gpuInfo, cudaInfo }) {
    if (!isCudaRuntimeSettingsSurface(platform, cudaInfo) || !cudaInfo) {
      return false;
    }
    if (platform === 'linux' && isLinuxManagedCudaRuntimeBroken(cudaInfo)) {
      return true;
    }
    if (!gpuInfo || !gpuInfo.hasGPU) {
      return false;
    }
    return cudaInfo.repairRecommendedAfterQuit === true
      || (cudaInfo.deviceAvailable && cudaInfo.runtimeLoadable === false);
  }

  return {
    isGpuRuntimeActionBusyError,
    formatGpuRuntimeBusyAlertMessage,
    resolveGpuSettingsSurface,
    isLinuxCudaSettingsOffered,
    isCudaRuntimeSettingsSurface,
    getUnsupportedGpuSettingsCopy,
    getLinuxCudaSettingsDescription,
    getLinuxCudaBrokenRuntimeCopy,
    getLinuxCudaUninstallConfirmSuffix,
    hasLinuxManagedCudaRuntime,
    isLinuxManagedCudaRuntimeBroken,
    shouldShowGpuUninstallButton,
    shouldShowGpuInstallOrRepairButton,
    shouldUseGpuRepairButton,
    shouldShowGpuHomeCta,
    shouldShowCudaRuntimeWarning,
  };
}));
