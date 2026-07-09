(function initSummaryUiHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.summaryUiHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildSummaryUiHelpers() {
  function isMeetingTranscriptionRetryable(meeting) {
    const status = meeting && meeting.transcriptionStatus;
    return status === 'failed' || status === 'pending';
  }

  function getMeetingTranscriptionStatusMessage(meeting) {
    if (!meeting) {
      return '';
    }
    if (meeting.transcriptionStatus === 'failed') {
      return meeting.transcriptionError
        ? `Transcription failed: ${meeting.transcriptionError}`
        : 'Transcription failed for this recording.';
    }
    if (meeting.transcriptionStatus === 'pending') {
      return 'This recording has not been transcribed yet.';
    }
    return '';
  }

  return {
    getMeetingTranscriptionStatusMessage,
    isMeetingTranscriptionRetryable,
  };
}));
