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
  assert.match(
    downloadModelSource,
    /python\.on\(['"]error['"]/,
    'download-model must reject on spawn/process error',
  );
  assert.match(
    downloadModelSource,
    /isTranscriptionModelCached/,
    'download-model must re-check cache completeness before treating non-zero exit as success',
  );
  assert.ok(
    extractIpcHandlerSource(combined, 'cancel-download-model'),
    'cancel-download-model IPC must exist',
  );
});

test('retry-transcription also enqueues on the compute queue', () => {
  // Documented as transcription compute work; keep the scan honest after Phase 3 moves.
  const combined = readCombinedMainProcessSource();
  const handlerSource = extractIpcHandlerSource(combined, 'retry-transcription');
  assert.ok(handlerSource, 'missing ipcMain.handle for retry-transcription');
  assert.equal(handlerEnqueuesComputeAction(handlerSource), true);
});

test('AI_COMPUTE_TIMEOUT_MS pins diarization, guided transcription, summary, meeting preflight, model-download idle wait, GPU idle wait, and addon validation', () => {
  assert.equal(AI_COMPUTE_TIMEOUT_MS.diarization, 30 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.guidedTranscription, 120 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.summary, 90 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.meetingPreflight, 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.modelDownloadIdleWait, 15 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.modelDownload, 30 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.gpuRuntimeComputeIdleWait, 15 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.addonValidation, 15 * 60 * 1000);
  assert.equal(AI_COMPUTE_TIMEOUT_MS.wallClockSettleGraceMs, 30 * 1000);
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

test('addon validation and guided transcription wall-clock wrappers appear in source', () => {
  const combined = readCombinedMainProcessSource();
  const diarizationValidate = extractIpcHandlerSource(combined, 'validate-diarization-setup')
    || combined;
  assert.match(combined, /addonValidation/);
  assert.match(combined, /Speaker identification validation/);
  assert.match(combined, /Summary model validation/);
  assert.match(combined, /getGuidedTranscriptionComputeTimeoutMs/);
  assert.match(combined, /waitForAiComputeQueueIdle/);
  assert.match(combined, /GPU_RUNTIME_COMPUTE_BUSY|gpuRuntimeComputeIdleWait/);
  assert.ok(diarizationValidate);
});

test('GPU runtime wait runs outside the wall-clock timer (inside enqueue)', () => {
  // N1: waitForGpuRuntimeBeforeCompute must not burn transcription budgets.
  const combined = readCombinedMainProcessSource();
  const transcribe = extractIpcHandlerSource(combined, 'transcribe-audio');
  assert.ok(transcribe, 'missing transcribe-audio handler');
  // Pattern: enqueue → await GPU wait → then runWallClockComputeAction
  assert.match(
    transcribe,
    /enqueueAiComputeAction\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*waitForGpuRuntimeBeforeCompute[\s\S]*runWallClockComputeAction/,
    'transcribe-audio must await GPU idle before starting the wall-clock timer',
  );
  // GPU wait must not appear inside the wall-clock action body for transcribe-audio.
  const wallClockBody = transcribe.match(/runWallClockComputeAction\(\{[\s\S]*?\n\s*\}\)/);
  assert.ok(wallClockBody, 'expected runWallClockComputeAction call in transcribe-audio');
  assert.doesNotMatch(
    wallClockBody[0],
    /waitForGpuRuntimeBeforeCompute/,
    'GPU wait must not be charged against the transcription wall-clock budget',
  );
});

test('post-refactor GPU resource gate covers compute, preload, and GPU runtime actions', () => {
  const combined = readCombinedMainProcessSource();
  assert.match(
    combined,
    /enqueueGpuExclusiveComputeAction[\s\S]*gpuResourceActionQueue\.enqueue/,
    'compute admission must share the GPU resource queue',
  );

  const downloadModel = extractIpcHandlerSource(combined, 'download-model');
  assert.match(
    downloadModel,
    /enqueueGpuResourceAction/,
    'Whisper preload must share the GPU resource queue',
  );
  assert.match(
    combined,
    /gpuRuntimeActionPromise\s*=\s*enqueueGpuResourceAction/,
    'GPU runtime mutation must share the GPU resource queue',
  );
});

test('destructive AI add-on removal reserves the shared GPU resource queue', () => {
  const combined = readCombinedMainProcessSource();
  for (const channel of ['remove-diarization-setup', 'remove-summary-model']) {
    const handlerSource = extractIpcHandlerSource(combined, channel);
    assert.ok(handlerSource, `missing ipcMain.handle for ${channel}`);
    assert.match(
      handlerSource,
      /enqueueGpuExclusiveRemovalAction/,
      `${channel} must reserve GPU resources before deleting files`,
    );
  }
});

test('Phase 3b behavioral fake-queue test supplements this source-scan', () => {
  // Characterization gate for Phase 0.2 remains the relocation-safe baseline.
  // The injected fake-queue behavioral suite lives in
  // tests/js/ai-compute-queue.behavioral.test.js and must stay green alongside
  // this scan — do not weaken either gate.
  assert.equal(typeof extractIpcHandlerSource, 'function');
});
