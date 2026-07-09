'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readCombinedMainProcessSource,
  extractIpcHandlerSource,
  handlerEnqueuesComputeAction,
} = require('./source-scan-helpers');

const {
  AI_COMPUTE_TIMEOUT_MS,
  getTranscriptionComputeTimeoutMs,
  formatComputeTimeoutLabel,
} = require('../../src/main-process-helpers');

/** Handlers that MUST run on aiComputeActionQueue (AGENTS.md). */
const COMPUTE_QUEUE_HANDLERS = [
  'transcribe-audio',
  'transcribe-audio-with-speakers',
  'diarize-transcript',
  'generate-summary',
];

/** Handlers / setup paths that must NOT enqueue on the compute queue. */
const NON_COMPUTE_QUEUE_HANDLERS = [
  'download-model',
  'setup-diarization',
  'setup-summary-model',
];

test('compute-queue handlers enqueue via enqueueAiComputeAction', () => {
  const combined = readCombinedMainProcessSource();

  for (const channel of COMPUTE_QUEUE_HANDLERS) {
    const handlerSource = extractIpcHandlerSource(combined, channel);
    assert.ok(handlerSource, `missing ipcMain.handle for ${channel}`);
    assert.equal(
      handlerEnqueuesComputeAction(handlerSource),
      true,
      `${channel} must call enqueueAiComputeAction (or aiComputeActionQueue.enqueue)`,
    );
  }
});

test('download-model and AI add-on setup handlers stay off the compute queue', () => {
  const combined = readCombinedMainProcessSource();

  for (const channel of NON_COMPUTE_QUEUE_HANDLERS) {
    const handlerSource = extractIpcHandlerSource(combined, channel);
    assert.ok(handlerSource, `missing ipcMain.handle for ${channel}`);
    assert.equal(
      handlerEnqueuesComputeAction(handlerSource),
      false,
      `${channel} must not enqueue on aiComputeActionQueue`,
    );
  }

  const downloadModelSource = extractIpcHandlerSource(combined, 'download-model');
  assert.match(
    downloadModelSource,
    /waitForAiComputeQueueIdle/,
    'download-model must wait for compute-queue idle before spawning preload',
  );
});

test('retry-transcription also enqueues on the compute queue', () => {
  // Documented as transcription compute work; keep the scan honest after Phase 3 moves.
  const combined = readCombinedMainProcessSource();
  const handlerSource = extractIpcHandlerSource(combined, 'retry-transcription');
  assert.ok(handlerSource, 'missing ipcMain.handle for retry-transcription');
  assert.equal(handlerEnqueuesComputeAction(handlerSource), true);
});

test('AI_COMPUTE_TIMEOUT_MS pins diarization, guided transcription, summary, meeting preflight, and model-download idle wait', () => {
  assert.equal(AI_COMPUTE_TIMEOUT_MS.diarization, 30 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.guidedTranscription, 120 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.summary, 90 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.meetingPreflight, 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.modelDownloadIdleWait, 15 * 60 * 1000);
});

test('getTranscriptionComputeTimeoutMs scales within the documented 30–120 minute band', () => {
  const small = getTranscriptionComputeTimeoutMs('small');
  const large = getTranscriptionComputeTimeoutMs('large-v3');
  assert.ok(small >= 30 * 60 * 1000);
  assert.ok(small <= 120 * 60 * 1000);
  assert.ok(large >= small);
  assert.ok(large <= 120 * 60 * 1000);
  assert.match(formatComputeTimeoutLabel(small), /minute/);
});

test('Phase 3b behavioral fake-queue test supplements this source-scan', () => {
  // Characterization gate for Phase 0.2 remains the relocation-safe baseline.
  // The injected fake-queue behavioral suite lives in
  // tests/js/ai-compute-queue.behavioral.test.js and must stay green alongside
  // this scan — do not weaken either gate.
  assert.equal(typeof extractIpcHandlerSource, 'function');
});
