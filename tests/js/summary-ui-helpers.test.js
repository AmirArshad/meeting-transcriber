'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getMeetingTranscriptionStatusMessage,
  shouldPromptSpeakerNamesBeforeSummary,
  haveSummarySpeakerNamesChanged,
  isMeetingTranscriptionRetryable,
  shouldAbortSummaryGenerationAfterPreflight,
} = require('../../src/renderer/summary-ui-helpers');

test('isMeetingTranscriptionRetryable only for failed or pending', () => {
  assert.equal(isMeetingTranscriptionRetryable({ transcriptionStatus: 'failed' }), true);
  assert.equal(isMeetingTranscriptionRetryable({ transcriptionStatus: 'pending' }), true);
  assert.equal(isMeetingTranscriptionRetryable({ transcriptionStatus: 'completed' }), false);
  assert.equal(isMeetingTranscriptionRetryable(null), false);
});

test('getMeetingTranscriptionStatusMessage covers failed, pending, and completed', () => {
  assert.equal(
    getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'failed', transcriptionError: 'boom' }),
    'Transcription failed: boom',
  );
  assert.equal(
    getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'failed' }),
    'Transcription failed for this recording.',
  );
  assert.equal(
    getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'pending' }),
    'This recording has not been transcribed yet.',
  );
  assert.equal(getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'completed' }), '');
  assert.equal(getMeetingTranscriptionStatusMessage(null), '');
});

test('shouldAbortSummaryGenerationAfterPreflight keeps a local cancel across status checks', () => {
  assert.equal(shouldAbortSummaryGenerationAfterPreflight({
    requestedMeetingId: 'meeting-1',
    activeMeetingId: 'meeting-1',
    cancelling: true,
  }), true);
  assert.equal(shouldAbortSummaryGenerationAfterPreflight({
    requestedMeetingId: 'meeting-1',
    activeMeetingId: 'meeting-2',
    cancelling: false,
  }), true);
  assert.equal(shouldAbortSummaryGenerationAfterPreflight({
    requestedMeetingId: 'meeting-1',
    activeMeetingId: 'meeting-1',
    cancelling: false,
  }), false);
});


test('speaker prompt uses canonical samples and existing overrides', () => {
  const meeting = { ai: { diarization: { speakerNames: { 'Speaker 1': 'Alice' } } } };
  assert.equal(shouldPromptSpeakerNamesBeforeSummary(meeting, [{ speaker: 'Speaker 1' }]), false);
  assert.equal(shouldPromptSpeakerNamesBeforeSummary(meeting, [{ speaker: 'Speaker 1' }, { speaker: 'SPEAKER_02' }]), true);
  assert.equal(shouldPromptSpeakerNamesBeforeSummary(meeting, [{ speaker: 'Unknown' }]), false);
  assert.equal(shouldPromptSpeakerNamesBeforeSummary(meeting, [null, undefined, { speaker: 'Speaker 1' }]), false);
  meeting.ai.diarization.speakerNames['Speaker 1'] = ' *--> ';
  assert.equal(shouldPromptSpeakerNamesBeforeSummary(meeting, [{ speaker: 'Speaker 1' }]), true);
});

test('completed summary compares snapshot hash with current names', () => {
  const meeting = { ai: { summary: { status: 'completed', speakerNamesHash: 'sha256:old' } } };
  assert.equal(haveSummarySpeakerNamesChanged(meeting, 'sha256:old'), false);
  assert.equal(haveSummarySpeakerNamesChanged(meeting, 'sha256:new'), true);
  assert.equal(haveSummarySpeakerNamesChanged(meeting), false);
  assert.equal(haveSummarySpeakerNamesChanged({ ai: { summary: { status: 'completed' } } }, ''), false);
});
