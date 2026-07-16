const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRecordButtonAction,
  getRecordingPresenceView,
  canHydratedRendererStopRecording,
} = require('../../src/renderer/recording-state-helpers');


test('getRecordButtonAction starts from idle', () => {
  assert.equal(getRecordButtonAction('idle'), 'start');
});


test('getRecordButtonAction stops from recording', () => {
  assert.equal(getRecordButtonAction('recording'), 'stop');
});


test('getRecordButtonAction ignores busy renderer states', () => {
  for (const state of ['starting', 'initializing', 'countdown', 'stopping', 'cancelling']) {
    assert.equal(getRecordButtonAction(state), 'ignore');
  }
});

test('shouldShowDiscardRecordingControl only while capturing or countdown', () => {
  const { shouldShowDiscardRecordingControl } = require('../../src/renderer/recording-state-helpers');
  assert.equal(shouldShowDiscardRecordingControl('recording'), true);
  assert.equal(shouldShowDiscardRecordingControl('countdown'), true);
  assert.equal(shouldShowDiscardRecordingControl('starting'), true);
  assert.equal(shouldShowDiscardRecordingControl('stopping'), false);
  assert.equal(shouldShowDiscardRecordingControl('cancelling'), false);
  assert.equal(shouldShowDiscardRecordingControl('idle'), false);
});

test('isStartRecordingResultDiscarded covers epoch, flag, and cancelled IPC results', () => {
  const {
    isStartRecordingResultDiscarded,
    shouldIssueCompensatingCancelAfterStart,
  } = require('../../src/renderer/recording-state-helpers');

  assert.equal(isStartRecordingResultDiscarded({
    discardRequested: true,
    startEpoch: 1,
    currentEpoch: 1,
    result: { success: true },
  }), true);
  assert.equal(isStartRecordingResultDiscarded({
    discardRequested: false,
    startEpoch: 1,
    currentEpoch: 2,
    result: { success: true },
  }), true);
  assert.equal(isStartRecordingResultDiscarded({
    discardRequested: false,
    startEpoch: 1,
    currentEpoch: 1,
    result: { success: false, cancelled: true, code: 'RECORDING_CANCELLED' },
  }), true);
  assert.equal(isStartRecordingResultDiscarded({
    discardRequested: false,
    startEpoch: 1,
    currentEpoch: 1,
    result: { success: true, sessionId: 3 },
  }), false);

  assert.equal(shouldIssueCompensatingCancelAfterStart({
    discardRequested: true,
    result: { success: true },
  }), true);
  assert.equal(shouldIssueCompensatingCancelAfterStart({
    discardRequested: false,
    startEpoch: 1,
    currentEpoch: 2,
    result: { success: true },
  }), true);
  assert.equal(shouldIssueCompensatingCancelAfterStart({
    discardRequested: true,
    result: { success: false, cancelled: true },
  }), false);
  assert.equal(shouldIssueCompensatingCancelAfterStart({
    discardRequested: false,
    startEpoch: 1,
    currentEpoch: 1,
    result: { success: true },
  }), false);
});

test('resolveCompensatingCancelOutcome only confirms cancelled success', () => {
  const { resolveCompensatingCancelOutcome } = require('../../src/renderer/recording-state-helpers');
  assert.deepEqual(
    resolveCompensatingCancelOutcome({ success: true, cancelled: true }),
    { ok: true, confirmed: true },
  );
  assert.equal(resolveCompensatingCancelOutcome({ success: false }).ok, false);
  assert.equal(resolveCompensatingCancelOutcome(null).ok, false);
  assert.match(
    resolveCompensatingCancelOutcome({ message: 'finalized' }).message,
    /finalized/,
  );
});

test('shouldAbortStartAfterCountdown covers discard and cancelled countdown', () => {
  const { shouldAbortStartAfterCountdown } = require('../../src/renderer/recording-state-helpers');
  assert.equal(shouldAbortStartAfterCountdown({
    discardRequested: true,
    countdownResult: { cancelled: false },
  }), true);
  assert.equal(shouldAbortStartAfterCountdown({
    discardRequested: false,
    countdownResult: { cancelled: true },
  }), true);
  assert.equal(shouldAbortStartAfterCountdown({
    discardRequested: false,
    countdownResult: { cancelled: false },
  }), false);
});

test('getRecordingPresenceView shows recording, stopping, and cancelling pills', () => {
  assert.deepEqual(getRecordingPresenceView('recording', '1:02:03'), {
    visible: true,
    label: 'Recording',
    timeText: '1:02:03',
    modifier: 'recording',
  });
  assert.deepEqual(getRecordingPresenceView('stopping', '1:02:03'), {
    visible: true,
    label: 'Finishing recording...',
    timeText: '1:02:03',
    modifier: 'stopping',
  });
  assert.deepEqual(getRecordingPresenceView('cancelling', '1:02:03'), {
    visible: true,
    label: 'Cancelling recording...',
    timeText: '1:02:03',
    modifier: 'cancelling',
  });
  assert.deepEqual(getRecordingPresenceView('stopping', null), {
    visible: true,
    label: 'Finishing recording...',
    timeText: null,
    modifier: 'stopping',
  });
  for (const state of ['starting', 'initializing', 'countdown', 'transcribing', 'idle']) {
    assert.equal(getRecordingPresenceView(state, '00:10').visible, false);
  }
});

test('hydrated Stop & Transcribe only needs main recording session state', () => {
  assert.equal(
    canHydratedRendererStopRecording({ state: 'recording', sessionId: 7, startedAt: 1 }),
    true,
  );
  assert.equal(
    canHydratedRendererStopRecording({ state: 'stopping', sessionId: 7, startedAt: 1 }),
    false,
  );
  assert.equal(canHydratedRendererStopRecording({ state: 'recording', sessionId: null }), false);
});

test('isRecordingStopInProgressError matches IPC-stripped errors by message', () => {
  const {
    isRecordingStopInProgressError,
    isRecordingCancelFinalizedError,
  } = require('../../src/renderer/recording-state-helpers');

  assert.equal(
    isRecordingStopInProgressError({
      message: 'Recording is already stopping and cannot be discarded. (RECORDING_STOP_IN_PROGRESS)',
    }),
    true,
  );
  assert.equal(
    isRecordingStopInProgressError({
      message: 'Recording is already stopping and cannot be discarded.',
    }),
    true,
  );
  assert.equal(
    isRecordingStopInProgressError({ code: 'RECORDING_STOP_IN_PROGRESS', message: 'x' }),
    true,
  );
  assert.equal(isRecordingStopInProgressError({ message: 'something else' }), false);

  assert.equal(
    isRecordingCancelFinalizedError({
      message: 'Recording cancel produced a saved audio file instead of discarding. (RECORDING_CANCEL_FINALIZED)',
    }),
    true,
  );
  assert.equal(isRecordingCancelFinalizedError({ message: 'Cancel failed' }), false);
});
