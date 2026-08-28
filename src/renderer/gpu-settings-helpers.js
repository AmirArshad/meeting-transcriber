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

  function getUnsupportedGpuSettingsCopy(platform) {
    if (platform === 'linux') {
      return {
        description: 'Linux GPU acceleration is not available yet. Transcription uses the CPU faster-whisper runtime.',
        statusLabel: 'Not available yet',
        diagnostics: 'CUDA and Metal GPU setup are not offered on Linux in this release.',
      };
    }
    return {
      description: 'GPU acceleration is not supported on this platform.',
      statusLabel: 'Unsupported',
      diagnostics: 'No GPU runtime is configured for this operating system.',
    };
  }

  return {
    isGpuRuntimeActionBusyError,
    formatGpuRuntimeBusyAlertMessage,
    resolveGpuSettingsSurface,
    getUnsupportedGpuSettingsCopy,
  };
}));
