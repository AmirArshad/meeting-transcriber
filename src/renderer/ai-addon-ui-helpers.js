(function initAiAddonUiHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.aiAddonUiHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildAiAddonUiHelpers() {
  function isAiAddonTerminalStatus(status) {
    return status === 'ready'
      || status === 'error'
      || status === 'notConfigured'
      || status === 'needsAccount'
      || status === 'unsupported';
  }

  function isAiAddonProgressPhase(progress) {
    const phase = progress && progress.phase;
    return phase === 'downloading'
      || phase === 'downloading-runtime'
      || phase === 'downloading-dependencies'
      || phase === 'extracting-runtime'
      || phase === 'validating';
  }

  return {
    isAiAddonProgressPhase,
    isAiAddonTerminalStatus,
  };
}));
