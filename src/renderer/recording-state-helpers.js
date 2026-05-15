(function attachRecordingStateHelpers(root) {
  function getRecordButtonAction(recordingState) {
    if (recordingState === 'idle') {
      return 'start';
    }

    if (recordingState === 'recording') {
      return 'stop';
    }

    return 'ignore';
  }

  const helpers = {
    getRecordButtonAction,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }

  root.recordingStateHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
