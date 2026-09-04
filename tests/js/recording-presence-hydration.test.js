'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractTopLevelFunctionSource, ROOT } = require('./source-scan-helpers');

test('presence poll restores capture mode when starting transitions to recording', async () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const pollSource = extractTopLevelFunctionSource(appSource, 'startRecordingPresencePoll');
  assert.ok(pollSource);

  let intervalCallback;
  const startedModes = [];
  const hydrate = new Function('window', 'audioVisualizer', 'setInterval', `
    const states = [];
    let recordingPresencePollTimer = null;
    let recordingState = 'starting';
    let activeRecordingSessionId = null;
    let recordingStartTime = null;
    let frozenPresenceElapsedText = null;
    let activeCaptureMode = 'mic-and-desktop';
    function stopRecordingPresencePoll() { recordingPresencePollTimer = null; }
    function normalizeCaptureMode(value) { return value === 'desktop-only' ? value : 'mic-and-desktop'; }
    function setRecordingState(value) { states.push(value); recordingState = value; }
    function startTimer() {}
    function addLog() {}
    const console = { warn() {} };
    ${pollSource}
    return {
      start: startRecordingPresencePoll,
      snapshot: () => ({ activeCaptureMode, activeRecordingSessionId, states }),
    };
  `)(
    { electronAPI: { getRecordingState: async () => ({
      state: 'recording', sessionId: 12, startedAt: 100, captureMode: 'desktop-only',
    }) } },
    { start: (mode) => startedModes.push(mode) },
    (callback) => { intervalCallback = callback; return 1; },
  );

  hydrate.start();
  await intervalCallback();

  assert.deepEqual(hydrate.snapshot(), {
    activeCaptureMode: 'desktop-only',
    activeRecordingSessionId: 12,
    states: ['recording'],
  });
  assert.deepEqual(startedModes, ['desktop-only']);
});
