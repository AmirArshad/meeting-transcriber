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
   * Discard is offered only while actively capturing or during countdown.
   * Once Stop is pressed (`stopping`) or discard is in flight (`cancelling`), hide it.
   */
  function shouldShowDiscardRecordingControl(recordingState) {
    return recordingState === 'recording'
      || recordingState === 'countdown'
      || recordingState === 'starting';
  }

  /**
   * True when an in-flight startRecording() should abort after start IPC returns.
   */
  function isStartRecordingResultDiscarded({
    discardRequested = false,
    startEpoch = 0,
    currentEpoch = 0,
    result = null,
  } = {}) {
    return Boolean(
      discardRequested
      || startEpoch !== currentEpoch
      || (result && result.cancelled)
      || (result && result.code === 'RECORDING_CANCELLED')
    );
  }

  /**
   * When Cancel won during a main idle gate wait, start may still return success.
   * Issue a compensating cancel for discard flag OR a stale start epoch so a late
   * spawn cannot become a hidden recording after a newer Start reset renderer state.
   */
  function shouldIssueCompensatingCancelAfterStart({
    discardRequested = false,
    startEpoch = 0,
    currentEpoch = 0,
    result = null,
  } = {}) {
    const staleEpoch = startEpoch !== currentEpoch;
    return Boolean(
      (discardRequested || staleEpoch)
      && result
      && result.success
      && !result.cancelled
    );
  }

  /**
   * Compensating cancel must confirm discard; rejection/false success is not "discarded".
   */
  function resolveCompensatingCancelOutcome(cancelResult) {
    if (cancelResult?.cancelled === true && cancelResult?.success !== false) {
      return { ok: true, confirmed: true };
    }
    return {
      ok: false,
      confirmed: false,
      message: cancelResult?.message
        || cancelResult?.error
        || 'Cancel did not confirm that the recording was discarded.',
      code: cancelResult?.code || null,
    };
  }

  /**
   * After countdown settles, abort into cancel when Discard won or countdown was cancelled.
   */
  function shouldAbortStartAfterCountdown({
    discardRequested = false,
    countdownResult = null,
  } = {}) {
    return Boolean(discardRequested || countdownResult?.cancelled);
  }

  /**
   * Electron ipcRenderer.invoke strips custom Error.code; match message text
   * (same pattern as isGpuRuntimeActionBusyError).
   */
  function isRecordingStopInProgressError(error) {
    const code = String(error && error.code ? error.code : '').toUpperCase();
    const message = String(error && error.message ? error.message : '').toUpperCase();
    return code === 'RECORDING_STOP_IN_PROGRESS'
      || message.includes('RECORDING_STOP_IN_PROGRESS')
      || message.includes('ALREADY STOPPING AND CANNOT BE DISCARDED');
  }

  function isRecordingCancelFinalizedError(error) {
    const code = String(error && error.code ? error.code : '').toUpperCase();
    const message = String(error && error.message ? error.message : '').toUpperCase();
    return code === 'RECORDING_CANCEL_FINALIZED'
      || message.includes('RECORDING_CANCEL_FINALIZED')
      || message.includes('PRODUCED A SAVED AUDIO FILE INSTEAD OF DISCARDING');
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

    if (recordingState === 'cancelling') {
      return {
        visible: true,
        label: 'Cancelling recording...',
        timeText: elapsedText || null,
        modifier: 'cancelling',
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
    shouldShowDiscardRecordingControl,
    isStartRecordingResultDiscarded,
    shouldIssueCompensatingCancelAfterStart,
    resolveCompensatingCancelOutcome,
    shouldAbortStartAfterCountdown,
    isRecordingStopInProgressError,
    isRecordingCancelFinalizedError,
    canHydratedRendererStopRecording,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }

  root.recordingStateHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
