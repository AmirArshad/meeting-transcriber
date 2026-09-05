'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getMeetingTranscriptionStatusMessage,
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
