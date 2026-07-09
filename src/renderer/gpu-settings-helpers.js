(function initGpuSettingsHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.gpuSettingsHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildGpuSettingsHelpers() {
  function isGpuRuntimeActionBusyError(error) {
    const message = String(error && error.message ? error.message : '').toUpperCase();
    return message.includes('GPU_RUNTIME_ACTION_BUSY') || message.includes('ALREADY IN PROGRESS');
  }

  return {
    isGpuRuntimeActionBusyError,
  };
}));
