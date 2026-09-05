const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRecordButtonAction,
  getRecordingPresenceView,
  canHydratedRendererStopRecording,
  normalizeCaptureMode,
  getCaptureModeSources,
  getRecordingSourceStatusText,
  resolveRecordModeMenuKeyAction,
} = require('../../src/renderer/recording-state-helpers');

test('resolveRecordModeMenuKeyAction dismisses on Escape and Tab with focus restored', () => {
  for (const key of ['Escape', 'Tab']) {
    assert.deepEqual(
      resolveRecordModeMenuKeyAction({ key, itemCount: 2, activeIndex: 0 }),
      { action: 'close', restoreFocus: true, preventDefault: true },
      key,
    );
  }
});

test('resolveRecordModeMenuKeyAction wraps arrow navigation in both directions', () => {
  const nav = (key, activeIndex) => resolveRecordModeMenuKeyAction({ key, itemCount: 2, activeIndex });

  assert.deepEqual(nav('ArrowDown', 0), { action: 'focus', focusIndex: 1, preventDefault: true });
  assert.deepEqual(nav('ArrowDown', 1), { action: 'focus', focusIndex: 0, preventDefault: true });
  assert.deepEqual(nav('ArrowUp', 1), { action: 'focus', focusIndex: 0, preventDefault: true });
  assert.deepEqual(nav('ArrowUp', 0), { action: 'focus', focusIndex: 1, preventDefault: true });

  // With focus outside the items, ArrowDown enters at the top and ArrowUp at
  // the bottom rather than skipping an entry.
  assert.equal(nav('ArrowDown', -1).focusIndex, 0);
  assert.equal(nav('ArrowUp', -1).focusIndex, 1);
});

test('resolveRecordModeMenuKeyAction supports Home and End', () => {
  assert.deepEqual(
    resolveRecordModeMenuKeyAction({ key: 'Home', itemCount: 3, activeIndex: 2 }),
    { action: 'focus', focusIndex: 0, preventDefault: true },
  );
  assert.deepEqual(
    resolveRecordModeMenuKeyAction({ key: 'End', itemCount: 3, activeIndex: 0 }),
    { action: 'focus', focusIndex: 2, preventDefault: true },
  );
});

test('resolveRecordModeMenuKeyAction ignores keys it does not own', () => {
  for (const key of ['Enter', ' ', 'a', 'ArrowLeft', 'ArrowRight', 'PageDown', undefined]) {
    assert.deepEqual(
      resolveRecordModeMenuKeyAction({ key, itemCount: 2, activeIndex: 0 }),
      { action: 'none', preventDefault: false },
      String(key),
    );
  }
});

test('resolveRecordModeMenuKeyAction never acts on a closed or empty menu', () => {
  // A closed menu must not swallow Escape/Tab from the surrounding UI.
  assert.deepEqual(
    resolveRecordModeMenuKeyAction({ key: 'Escape', itemCount: 2, activeIndex: 0, isOpen: false }),
    { action: 'none', preventDefault: false },
  );
  assert.deepEqual(
    resolveRecordModeMenuKeyAction({ key: 'ArrowDown', itemCount: 0, activeIndex: -1 }),
    { action: 'none', preventDefault: false },
  );
  assert.deepEqual(
    resolveRecordModeMenuKeyAction(),
    { action: 'none', preventDefault: false },
  );
});

test('normalizeCaptureMode keeps the closed set and defaults everything else', () => {
  assert.equal(normalizeCaptureMode('mic-and-desktop'), 'mic-and-desktop');
  assert.equal(normalizeCaptureMode('mic-only'), 'mic-only');
  assert.equal(normalizeCaptureMode('desktop-only'), 'desktop-only');

  // Anything unknown, absent, or non-string falls back to the two-source
  // default so presentation can never invent a single-source view.
  for (const value of [undefined, null, '', 'all-the-audio', 0, -1, {}, []]) {
    assert.equal(normalizeCaptureMode(value), 'mic-and-desktop');
  }
});

test('getCaptureModeSources reports exactly the requested sources', () => {
  assert.deepEqual(getCaptureModeSources('mic-and-desktop'), {
    mode: 'mic-and-desktop',
    includeMic: true,
    includeDesktop: true,
  });
  assert.deepEqual(getCaptureModeSources('mic-only'), {
    mode: 'mic-only',
    includeMic: true,
    includeDesktop: false,
  });
  assert.deepEqual(getCaptureModeSources('desktop-only'), {
    mode: 'desktop-only',
    includeMic: false,
    includeDesktop: true,
  });
  assert.deepEqual(getCaptureModeSources(undefined), {
    mode: 'mic-and-desktop',
    includeMic: true,
    includeDesktop: true,
  });
});

test('getRecordingSourceStatusText names only the captured sources', () => {
  assert.equal(getRecordingSourceStatusText('mic-and-desktop'), 'Recording mic + system audio\u2026');
  assert.equal(getRecordingSourceStatusText('mic-only'), 'Recording mic only\u2026');
  assert.equal(getRecordingSourceStatusText('desktop-only'), 'Recording system audio only\u2026');
  assert.equal(getRecordingSourceStatusText(undefined), 'Recording mic + system audio\u2026');

  // A single-source recording must never advertise the source it never opened.
  assert.doesNotMatch(getRecordingSourceStatusText('desktop-only'), /mic/i);
  assert.doesNotMatch(getRecordingSourceStatusText('mic-only'), /system/i);
});


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
