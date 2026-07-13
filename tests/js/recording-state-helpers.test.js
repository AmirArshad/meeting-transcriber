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
  for (const state of ['starting', 'initializing', 'countdown', 'stopping', 'transcribing']) {
    assert.equal(getRecordButtonAction(state), 'ignore');
  }
});

test('getRecordingPresenceView shows recording and stopping pills only', () => {
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
