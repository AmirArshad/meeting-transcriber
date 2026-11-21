(function initSummaryUiHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./speaker-label-helpers'));
    return;
  }

  root.summaryUiHelpers = factory(root.speakerLabelHelpers);
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildSummaryUiHelpers({ hasUnnamedSpeakers }) {
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

  function shouldAbortSummaryGenerationAfterPreflight({
    requestedMeetingId,
    activeMeetingId,
    cancelling = false,
  } = {}) {
    if (cancelling) {
      return true;
    }
    if (!requestedMeetingId || !activeMeetingId) {
      return true;
    }
    return String(activeMeetingId) !== String(requestedMeetingId);
  }

  function shouldPromptSpeakerNamesBeforeSummary(meeting, samples = []) {
    return hasUnnamedSpeakers(meeting, samples);
  }

  function haveSummarySpeakerNamesChanged(meeting, currentSpeakerNamesHash) {
    const summary = meeting?.ai?.summary;
    return summary?.status === 'completed'
      && typeof currentSpeakerNamesHash === 'string'
      && (summary.speakerNamesHash || '') !== currentSpeakerNamesHash;
  }

  return {
    shouldPromptSpeakerNamesBeforeSummary,
    haveSummarySpeakerNamesChanged,
    getMeetingTranscriptionStatusMessage,
    isMeetingTranscriptionRetryable,
    shouldAbortSummaryGenerationAfterPreflight,
  };
}));
