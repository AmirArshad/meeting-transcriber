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

  /**
   * Pure view model for the always-visible top-bar recording presence pill.
   * @returns {{ visible: boolean, label: string, timeText: string|null, modifier: string|null }}
   */
  function getRecordingPresenceView(recordingState, elapsedText) {
    if (recordingState === 'recording') {
      return {
        visible: true,
        label: 'Recording',
        timeText: elapsedText || '00:00',
        modifier: 'recording',
      };
    }

    if (recordingState === 'stopping') {
      return {
        visible: true,
        label: 'Finishing recording...',
        timeText: elapsedText || null,
        modifier: 'stopping',
      };
    }

    return {
      visible: false,
      label: 'Recording',
      timeText: null,
      modifier: null,
    };
  }

  /**
   * Hydrated Stop & Transcribe uses the same stop IPC as a live renderer.
   * It must not depend on transient fields that only the original renderer held
   * (countdown handles, in-memory visualizer buffers, etc.). Settings already
   * in localStorage (model size, language, devices) remain available.
   */
  function canHydratedRendererStopRecording(mainCaptureState) {
    return Boolean(
      mainCaptureState
      && mainCaptureState.state === 'recording'
      && Number.isInteger(mainCaptureState.sessionId),
    );
  }

  const helpers = {
    getRecordButtonAction,
    getRecordingPresenceView,
    canHydratedRendererStopRecording,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }

  root.recordingStateHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
