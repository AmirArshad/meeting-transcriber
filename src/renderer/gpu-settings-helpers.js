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

  return {
    isGpuRuntimeActionBusyError,
  };
}));
