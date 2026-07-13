'use strict';

/**
 * Regression coverage for Phase 3c recorder-service DI wiring.
 *
 * Successful stop builds `{ existsSync, getRecordingsDir }` before calling
 * parseRecordingStopResult. A missing getRecordingsDir binding is a
 * ReferenceError that Phase 0 source-scans cannot see.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { createRecorderService } = require('../../src/main/recorder-service');

function createMinimalDeps(overrides = {}) {
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-recorder-deps-'));
  return {
    deps: {
      app: { getPath: () => path.dirname(recordingsDir), quit() {} },
      path,
      fs,
      dialog: { showMessageBox: async () => ({ response: 0 }) },
      powerSaveBlocker: { start: () => 1, stop() {} },
      pythonConfig: { pythonExe: 'python', backendPath: recordingsDir, ffmpegPath: 'ffmpeg' },
      spawnTrackedPython() {
        throw new Error('spawnTrackedPython should not run in this unit test');
      },
      sendToRenderer() {},
      assertTrustedRendererSender() {},
      getMainWindow: () => null,
      setIsQuitting() {},
      getAllowImmediateQuit: () => false,
      setAllowImmediateQuit() {},
      getQuitWorkflowPromise: () => null,
      setQuitWorkflowPromise() {},
      validateSelectedDevices: async () => ({ ok: true }),
      checkDiskSpace: async () => ({ ok: true }),
      checkAudioOutputSupport: async () => ({ ok: true }),
      getMacOSPermissionStatus: async () => ({ ok: true }),
      addMeetingToHistory: async () => ({}),
      formatDurationForTranscript: () => '0:00',
      getRecordingsDir: () => recordingsDir,
      ...overrides,
    },
    recordingsDir,
  };
}

test('createRecorderService requires getRecordingsDir', () => {
  const { deps } = createMinimalDeps();
  delete deps.getRecordingsDir;
  assert.throws(() => createRecorderService(deps), /getRecordingsDir/);
});

test('parseRecordingStopResultFromStdout resolves with injected getRecordingsDir', () => {
  const { deps, recordingsDir } = createMinimalDeps();
  const audioPath = path.join(recordingsDir, 'meeting_test.wav');
  fs.writeFileSync(audioPath, 'fake');

  const service = createRecorderService(deps);
  const result = service.parseRecordingStopResultFromStdout(JSON.stringify({
    success: true,
    audioPath,
    duration: 1.25,
  }));

  assert.equal(result.success, true);
  assert.equal(result.audioPath, audioPath);
});

test('parseRecordingStopResultFromStdout does not throw ReferenceError for getRecordingsDir', () => {
  // Even when the payload is empty, building the options object must evaluate
  // the getRecordingsDir binding. Missing wiring used to throw here.
  const { deps } = createMinimalDeps();
  const service = createRecorderService(deps);
  assert.throws(
    () => service.parseRecordingStopResultFromStdout(''),
    (error) => error instanceof Error && error.name !== 'ReferenceError',
  );
});

test('recorder publishes starting/recording/stopping/idle lifecycle and returns startedAt', async () => {
  const { EventEmitter } = require('node:events');
  const captureStates = [];
  const { deps } = createMinimalDeps({
    onCaptureStateChanged: (state) => captureStates.push(state),
    isQuitCommitted: () => false,
  });

  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {} };
  proc.killed = false;
  proc.pid = 4242;
  proc.kill = () => { proc.killed = true; };
  deps.spawnTrackedPython = () => proc;

  const service = createRecorderService(deps);
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  const startPromise = handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captureStates[0].state, 'starting');
  assert.equal(typeof captureStates[0].sessionId, 'number');

  proc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));
  const startResult = await startPromise;
  assert.equal(startResult.success, true);
  assert.equal(Number.isFinite(startResult.startedAt), true);
  assert.equal(captureStates.at(-1).state, 'recording');
  assert.equal(captureStates.at(-1).startedAt, startResult.startedAt);

  const hydrated = await handlers['get-recording-state']({ sender: {} });
  assert.equal(hydrated.state, 'recording');
  assert.equal(hydrated.startedAt, startResult.startedAt);

  const stopPromise = handlers['stop-recording']({ sender: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captureStates.at(-1).state, 'stopping');

  const audioPath = path.join(deps.getRecordingsDir(), 'lifecycle.wav');
  fs.writeFileSync(audioPath, 'x');
  proc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    success: true,
    audioPath,
    duration: 1,
  })}\n`));
  proc.emit('close', 0);
  await stopPromise;
  assert.equal(captureStates.at(-1).state, 'idle');
  assert.equal(captureStates.at(-1).sessionId, null);
});

test('stale process close cannot publish idle over a newer recording session', async () => {
  const { EventEmitter } = require('node:events');
  const captureStates = [];
  const { deps } = createMinimalDeps({
    onCaptureStateChanged: (state) => captureStates.push(state),
    isQuitCommitted: () => false,
  });

  function makeProc() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write() {} };
    proc.killed = false;
    proc.pid = Math.floor(Math.random() * 100000) + 1;
    proc.kill = () => { proc.killed = true; };
    return proc;
  }

  const firstProc = makeProc();
  const secondProc = makeProc();
  let spawnCount = 0;
  deps.spawnTrackedPython = () => {
    spawnCount += 1;
    return spawnCount === 1 ? firstProc : secondProc;
  };

  const service = createRecorderService(deps);
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  // Start first session then force-clear runtime without going idle through stop,
  // simulating a replacement start after the first child is abandoned.
  const firstStart = handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );
  await new Promise((resolve) => setImmediate(resolve));
  firstProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));
  await firstStart;

  // Simulate busy check bypass by clearing process pointer is not allowed;
  // instead stop the first session to idle, then start second, then emit stale close.
  const stopFirst = handlers['stop-recording']({ sender: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const audioPath = path.join(deps.getRecordingsDir(), 'first.wav');
  fs.writeFileSync(audioPath, 'x');
  firstProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    success: true,
    audioPath,
    duration: 1,
  })}\n`));
  firstProc.emit('close', 0);
  await stopFirst;

  const secondStart = handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );
  await new Promise((resolve) => setImmediate(resolve));
  secondProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));
  const secondResult = await secondStart;
  assert.equal(secondResult.success, true);
  const statesBeforeStale = captureStates.length;

  // Stale close from the first process must not clear the second session.
  firstProc.emit('close', 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captureStates.length, statesBeforeStale);
  assert.equal(service.getCaptureState().state, 'recording');
  assert.equal(service.getCaptureState().sessionId, secondResult.sessionId);

  const stopSecond = handlers['stop-recording']({ sender: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const secondAudio = path.join(deps.getRecordingsDir(), 'second.wav');
  fs.writeFileSync(secondAudio, 'x');
  secondProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    success: true,
    audioPath: secondAudio,
    duration: 1,
  })}\n`));
  secondProc.emit('close', 0);
  await stopSecond;
  assert.equal(service.getCaptureState().state, 'idle');
});

test('synchronous start setup failure clears starting state and power-save blocker', async () => {
  const captureStates = [];
  let powerSaveStopped = false;
  const { deps } = createMinimalDeps({
    onCaptureStateChanged: (state) => captureStates.push(state),
    isQuitCommitted: () => false,
    powerSaveBlocker: {
      start: () => 7,
      stop() {
        powerSaveStopped = true;
      },
    },
    spawnTrackedPython() {
      throw new Error('spawn exploded');
    },
  });

  const service = createRecorderService(deps);
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  const result = await handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );
  assert.equal(result.success, false);
  assert.equal(result.code, 'STARTUP_FAILED');
  assert.equal(captureStates[0].state, 'starting');
  assert.equal(captureStates.at(-1).state, 'idle');
  assert.equal(service.getCaptureState().state, 'idle');
  assert.equal(powerSaveStopped, true);
});

test('late recording_started from a timed-out startup cannot overwrite a newer session', async () => {
  const { EventEmitter } = require('node:events');
  const captureStates = [];
  const { deps } = createMinimalDeps({
    onCaptureStateChanged: (state) => captureStates.push(state),
    isQuitCommitted: () => false,
  });

  function makeProc() {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write() {} };
    proc.killed = false;
    proc.pid = Math.floor(Math.random() * 100000) + 1;
    proc.kill = () => { proc.killed = true; };
    return proc;
  }

  const firstProc = makeProc();
  const secondProc = makeProc();
  let spawnCount = 0;
  deps.spawnTrackedPython = () => {
    spawnCount += 1;
    return spawnCount === 1 ? firstProc : secondProc;
  };

  const service = createRecorderService(deps);
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  const firstStart = handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );
  await new Promise((resolve) => setImmediate(resolve));

  // Force-settle the first attempt as a startup failure (timeout path).
  firstProc.kill();
  firstProc.emit('close', 1);
  const firstResult = await firstStart;
  assert.equal(firstResult.success, false);
  assert.equal(service.getCaptureState().state, 'idle');

  const secondStart = handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );
  await new Promise((resolve) => setImmediate(resolve));
  secondProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));
  const secondResult = await secondStart;
  assert.equal(secondResult.success, true);
  const secondSessionId = secondResult.sessionId;
  const statesBeforeStale = captureStates.length;

  // Late stdout from the abandoned first child must not republish its session.
  firstProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captureStates.length, statesBeforeStale);
  assert.equal(service.getCaptureState().state, 'recording');
  assert.equal(service.getCaptureState().sessionId, secondSessionId);

  const stopSecond = handlers['stop-recording']({ sender: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const secondAudio = path.join(deps.getRecordingsDir(), 'stale-stdout.wav');
  fs.writeFileSync(secondAudio, 'x');
  secondProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    success: true,
    audioPath: secondAudio,
    duration: 1,
  })}\n`));
  secondProc.emit('close', 0);
  await stopSecond;
});

test('disk space monitor warns once on escalation and never auto-stops', async () => {
  const { EventEmitter } = require('node:events');
  const rendererEvents = [];
  const safetyNotifications = [];
  const intervals = [];
  let diskProbe = {
    success: true,
    availableBytes: 20 * 1024 * 1024 * 1024,
    availableGB: '20.00',
    warning: null,
    level: null,
  };

  const { deps } = createMinimalDeps({
    isQuitCommitted: () => false,
    sendToRenderer: (channel, payload) => {
      rendererEvents.push({ channel, payload });
    },
    checkDiskSpace: async () => diskProbe,
    notifyRecordingSafety: (copy) => {
      safetyNotifications.push(copy);
    },
    diskSpaceCheckIntervalMs: 1,
    setIntervalFn: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    },
  });

  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {} };
  proc.killed = false;
  proc.pid = 9001;
  proc.kill = () => { proc.killed = true; };
  deps.spawnTrackedPython = () => proc;

  const service = createRecorderService(deps);
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  const startPromise = handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );
  await new Promise((resolve) => setImmediate(resolve));
  proc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));
  await startPromise;

  const diskInterval = intervals.find((timer) => timer.delay === 1);
  assert.ok(diskInterval, 'disk space monitor interval should be scheduled');

  // Healthy → no warning.
  await diskInterval.fn();
  assert.equal(
    rendererEvents.filter((event) => event.payload?.type === 'disk_space').length,
    0,
  );

  // Cross into warning once.
  diskProbe = {
    success: true,
    availableBytes: 5 * 1024 * 1024 * 1024,
    availableGB: '5.00',
    warning: 'Less than 10 GB is available. Long recordings may run out of space.',
    level: 'warning',
  };
  await diskInterval.fn();
  await diskInterval.fn(); // same level — no duplicate
  const warningEvents = rendererEvents.filter(
    (event) => event.channel === 'recording-warning' && event.payload?.type === 'disk_space',
  );
  assert.equal(warningEvents.length, 1);
  assert.equal(warningEvents[0].payload.level, 'warning');
  assert.equal(safetyNotifications.length, 1);

  // Escalate to critical once.
  diskProbe = {
    success: true,
    availableBytes: 1 * 1024 * 1024 * 1024,
    availableGB: '1.00',
    warning: 'Less than 2 GB is available. Long recordings may run out of space.',
    level: 'critical',
  };
  await diskInterval.fn();
  await diskInterval.fn();
  const diskWarnings = rendererEvents.filter(
    (event) => event.channel === 'recording-warning' && event.payload?.type === 'disk_space',
  );
  assert.equal(diskWarnings.length, 2);
  assert.equal(diskWarnings[1].payload.level, 'critical');
  assert.equal(safetyNotifications.length, 2);
  assert.equal(service.getCaptureState().state, 'recording');
  assert.equal(proc.killed, false);

  const stopPromise = handlers['stop-recording']({ sender: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const audioPath = path.join(deps.getRecordingsDir(), 'disk-monitor.wav');
  fs.writeFileSync(audioPath, 'x');
  proc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    success: true,
    audioPath,
    duration: 1,
  })}\n`));
  proc.emit('close', 0);
  await stopPromise;
  assert.equal(diskInterval.cleared, true);
});
