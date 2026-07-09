'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getMeetingTranscriptionStatusMessage,
  isMeetingTranscriptionRetryable,
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
