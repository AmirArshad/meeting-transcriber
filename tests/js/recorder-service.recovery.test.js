'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const { createRecorderService } = require('../../src/main/recorder-service');
const { createRecordingsMaintenanceGate } = require('../../src/main/recordings-maintenance-gate');

function createProc(stdoutPayload, { exitCode = 0, delayMs = 0 } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {} };
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 100000);
  proc.kill = () => { proc.killed = true; };
  setTimeout(() => {
    proc.stdout.emit('data', Buffer.from(typeof stdoutPayload === 'string'
      ? stdoutPayload
      : JSON.stringify(stdoutPayload)));
    proc.emit('close', exitCode);
  }, delayMs);
  return proc;
}

function createRecoveryService(overrides = {}) {
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-recovery-'));
  const gate = createRecordingsMaintenanceGate({ scanWaitMs: 200 });
  const sent = [];
  let quitCommitted = false;
  const service = createRecorderService({
    app: { getPath: () => path.dirname(recordingsDir), quit() {} },
    path,
    fs,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    powerSaveBlocker: { start: () => 1, stop() {} },
    pythonConfig: { pythonExe: 'python', backendPath: recordingsDir, ffmpegPath: 'ffmpeg' },
    spawnTrackedPython: overrides.spawnTrackedPython || (() => {
      throw new Error('spawnTrackedPython not stubbed');
    }),
    sendToRenderer: (channel, payload) => sent.push({ channel, payload }),
    assertTrustedRendererSender() {},
    getMainWindow: () => null,
    setIsQuitting() {},
    getAllowImmediateQuit: () => false,
    setAllowImmediateQuit() {},
    getQuitWorkflowPromise: () => null,
    setQuitWorkflowPromise() {},
    isQuitCommitted: () => quitCommitted,
    validateSelectedDevices: async () => ({ ok: true }),
    checkDiskSpace: async () => ({ ok: true }),
    checkAudioOutputSupport: async () => ({ ok: true }),
    getMacOSPermissionStatus: async () => ({ ok: true }),
    addMeetingToHistory: async () => ({}),
    formatDurationForTranscript: () => '0:00',
    getRecordingsDir: () => recordingsDir,
    recordingsMaintenanceGate: gate,
    getBackendModuleArgs: (moduleName, extra = []) => ['-m', moduleName, ...extra],
    collectPythonProcessOutput(python) {
      let stdout = '';
      python.stdout.on('data', (data) => { stdout += data.toString(); });
      return {
        getStdout: () => stdout,
        getStderr: () => '',
        assertStdoutWithinLimit() {},
      };
    },
    scanRecordings: overrides.scanRecordings || (async () => ({ scanned: 0, added: 0, skipped: 0 })),
    ...overrides,
  });

  return {
    service,
    gate,
    sent,
    recordingsDir,
    setQuitCommitted: (value) => { quitCommitted = value; },
  };
}

const sampleCandidate = {
  captureDir: '/tmp/recordings/recording_a.capture',
  outputStem: 'recording_a',
  startedAtIso: '2026-07-13T10:00:00.000Z',
  approxDurationSeconds: 60,
  approxBytes: 1024,
  state: 'recording',
};

test('first getRecordingRecoveryState claims prompt; later queries do not', async () => {
  const { service } = createRecoveryService({
    spawnTrackedPython: () => createProc({ success: true, candidates: [sampleCandidate] }),
  });
  await service.discoverInterruptedCaptures();
  const first = service.getRecordingRecoveryState();
  assert.equal(first.status, 'available');
  assert.equal(first.promptEligible, true);
  assert.equal(first.candidates[0].captureDir, undefined);
  const second = service.getRecordingRecoveryState();
  assert.equal(second.promptEligible, false);
});

test('push invalidation channel does not claim prompt eligibility', async () => {
  const { service, sent } = createRecoveryService({
    spawnTrackedPython: () => createProc({ success: true, candidates: [sampleCandidate] }),
  });
  await service.discoverInterruptedCaptures();
  assert.ok(sent.some((entry) => entry.channel === 'recording-recovery-state-changed'));
  // Eligibility is only claimed by getRecordingRecoveryState.
  const state = service.getRecordingRecoveryState();
  assert.equal(state.promptEligible, true);
});

test('duplicate recover calls join one recoveryActionPromise', async () => {
  let spawnCount = 0;
  const { service } = createRecoveryService({
    spawnTrackedPython: (args) => {
      spawnCount += 1;
      if (args.includes('--list')) {
        return createProc({ success: true, candidates: [sampleCandidate] });
      }
      return createProc({
        success: true,
        recovered: [{ captureDir: sampleCandidate.captureDir, audioPath: '/tmp/a.wav', duration: 1 }],
        failed: [],
      }, { delayMs: 30 });
    },
  });
  await service.discoverInterruptedCaptures();
  const first = service.recoverInterruptedCaptures();
  const second = service.recoverInterruptedCaptures();
  assert.equal(first, second);
  await first;
  // list + one recover (not two recovers)
  assert.equal(spawnCount, 2);
});

test('recover refuses while capture state is not idle and leaves gate idle', async () => {
  const { EventEmitter: EE } = require('node:events');
  let mode = 'list';
  const recorderProc = new EE();
  recorderProc.stdout = new EE();
  recorderProc.stderr = new EE();
  recorderProc.stdin = { write() {} };
  recorderProc.kill = () => {};

  const { service, gate } = createRecoveryService({
    spawnTrackedPython: () => {
      if (mode === 'list') {
        return createProc({ success: true, candidates: [sampleCandidate] });
      }
      return recorderProc;
    },
  });
  await service.discoverInterruptedCaptures();
  mode = 'record';

  const handlers = {};
  service.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });
  const startPromise = handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );
  await new Promise((resolve) => setImmediate(resolve));
  recorderProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));
  const startResult = await startPromise;
  assert.equal(startResult.success, true);
  assert.equal(service.getCaptureState().state, 'recording');

  const result = await service.recoverInterruptedCaptures();
  assert.equal(result.success, false);
  assert.equal(result.code, 'RECORDING_IN_PROGRESS');
  assert.equal(gate.getOwner(), 'idle');

  // Tear down the live recorder stub so heartbeat timers do not keep the process alive.
  recorderProc.emit('close', 1);
  await new Promise((resolve) => setImmediate(resolve));
});

test('partial success followed by failed-only Retry', async () => {
  const candidates = [
    { ...sampleCandidate, captureDir: '/tmp/a.capture', outputStem: 'a' },
    { ...sampleCandidate, captureDir: '/tmp/b.capture', outputStem: 'b', startedAtIso: '2026-07-13T11:00:00.000Z' },
  ];
  let recoverCalls = 0;
  const { service } = createRecoveryService({
    spawnTrackedPython: (args) => {
      if (args.includes('--list')) {
        return createProc({ success: true, candidates });
      }
      recoverCalls += 1;
      const target = args[args.indexOf('--recover') + 1];
      if (String(target).includes('a.capture')) {
        return createProc({
          success: true,
          recovered: [{ captureDir: target, audioPath: '/tmp/a.wav', duration: 1 }],
          failed: [],
        });
      }
      return createProc({
        success: false,
        recovered: [],
        failed: [{ captureDir: target, code: 'RECOVERY_FAILED', message: 'boom' }],
      }, { exitCode: 1 });
    },
  });
  await service.discoverInterruptedCaptures();
  const first = await service.recoverInterruptedCaptures();
  assert.equal(first.success, false);
  assert.equal(first.recovered, 1);
  assert.equal(recoverCalls, 2);

  const state = service.getRecordingRecoveryState();
  assert.equal(state.status, 'error');
  assert.equal(state.candidates.length, 1);
  assert.equal(state.candidates[0].outputStem, 'b');
  assert.equal(state.lastSuccessCount, 1);
  assert.equal(state.lastBatchSize, 2);

  recoverCalls = 0;
  await service.recoverInterruptedCaptures();
  assert.equal(recoverCalls, 1);
});

test('Dismiss returns to available with unresolved candidates', async () => {
  const { service } = createRecoveryService({
    spawnTrackedPython: (args) => {
      if (args.includes('--list')) {
        return createProc({ success: true, candidates: [sampleCandidate] });
      }
      return createProc({
        success: false,
        recovered: [],
        failed: [{ captureDir: sampleCandidate.captureDir, code: 'RECOVERY_FAILED', message: 'nope' }],
      }, { exitCode: 1 });
    },
  });
  await service.discoverInterruptedCaptures();
  await service.recoverInterruptedCaptures();
  assert.equal(service.getRecordingRecoveryState().status, 'error');
  const deferred = service.deferRecordingRecovery();
  assert.equal(deferred.status, 'available');
  assert.equal(deferred.totals.count, 1);
  assert.equal(deferred.promptEligible, false);
});

test('quitCommitted refuses recovery before acquiring gate', async () => {
  const { service, gate, setQuitCommitted } = createRecoveryService({
    spawnTrackedPython: () => createProc({ success: true, candidates: [sampleCandidate] }),
  });
  await service.discoverInterruptedCaptures();
  setQuitCommitted(true);
  const result = await service.recoverInterruptedCaptures();
  assert.equal(result.code, 'QUIT_IN_PROGRESS');
  assert.equal(gate.getOwner(), 'idle');
});

test('successful recovery transfers to scan and releases gate', async () => {
  let scanCalls = 0;
  let sawAlreadyHolding = false;
  const { service, gate } = createRecoveryService({
    spawnTrackedPython: (args) => {
      if (args.includes('--list')) {
        return createProc({ success: true, candidates: [sampleCandidate] });
      }
      return createProc({
        success: true,
        recovered: [{ captureDir: sampleCandidate.captureDir, audioPath: '/tmp/a.wav', duration: 1 }],
        failed: [],
      });
    },
    async scanRecordings(options = {}) {
      scanCalls += 1;
      sawAlreadyHolding = Boolean(options.alreadyHoldingScan);
      assert.equal(gate.getOwner(), 'scan');
      return { scanned: 1, added: 1, skipped: 0 };
    },
  });
  await service.discoverInterruptedCaptures();
  const result = await service.recoverInterruptedCaptures();
  assert.equal(result.success, true);
  assert.equal(scanCalls, 1);
  assert.equal(sawAlreadyHolding, true);
  assert.equal(gate.getOwner(), 'idle');
  assert.equal(service.getRecordingRecoveryState().status, 'idle');
});

test('Dismiss after scan-import-only failure keeps banner-visible available state', async () => {
  const { service } = createRecoveryService({
    spawnTrackedPython: (args) => {
      if (args.includes('--list')) {
        return createProc({ success: true, candidates: [sampleCandidate] });
      }
      return createProc({
        success: true,
        recovered: [{ captureDir: sampleCandidate.captureDir, audioPath: '/tmp/a.wav', duration: 1 }],
        failed: [],
      });
    },
    async scanRecordings() {
      throw new Error('scan blew up');
    },
  });
  await service.discoverInterruptedCaptures();
  const first = await service.recoverInterruptedCaptures();
  assert.equal(first.success, false);
  const errorState = service.getRecordingRecoveryState();
  assert.equal(errorState.status, 'error');
  assert.equal(errorState.scanImportPending, true);

  const deferred = service.deferRecordingRecovery();
  assert.equal(deferred.status, 'available');
  assert.equal(deferred.scanImportPending, true);
  assert.ok(deferred.totals.count >= 1);
});

test('failed recovery messages strip Windows paths with spaces', async () => {
  const { service } = createRecoveryService({
    spawnTrackedPython: (args) => {
      if (args.includes('--list')) {
        return createProc({ success: true, candidates: [sampleCandidate] });
      }
      return createProc({
        success: false,
        recovered: [],
        failed: [{
          captureDir: sampleCandidate.captureDir,
          code: 'RECOVERY_FAILED',
          message: 'Failed at C:\\Users\\Jane Doe\\AppData\\recordings\\file.wav after compress',
        }],
      }, { exitCode: 1 });
    },
  });
  await service.discoverInterruptedCaptures();
  await service.recoverInterruptedCaptures();
  const state = service.getRecordingRecoveryState();
  assert.equal(state.status, 'error');
  assert.equal(state.failed.length, 1);
  assert.doesNotMatch(state.failed[0].message, /Jane Doe/);
  assert.match(state.failed[0].message, /\[path\]/);
});

test('failed recovery messages strip UNC paths with spaces', async () => {
  const { service } = createRecoveryService({
    spawnTrackedPython: (args) => {
      if (args.includes('--list')) {
        return createProc({ success: true, candidates: [sampleCandidate] });
      }
      return createProc({
        success: false,
        recovered: [],
        failed: [{
          captureDir: sampleCandidate.captureDir,
          code: 'RECOVERY_FAILED',
          message: 'Failed at \\\\server\\share name\\Jane Doe\\recordings\\file.wav',
        }],
      }, { exitCode: 1 });
    },
  });
  await service.discoverInterruptedCaptures();
  await service.recoverInterruptedCaptures();
  const state = service.getRecordingRecoveryState();
  assert.doesNotMatch(state.failed[0].message, /Jane Doe|share name/);
  assert.match(state.failed[0].message, /\[path\]/);
});

test('recovery waiting for scan refuses after capture starts', async () => {
  const { EventEmitter: EE } = require('node:events');
  const recorderProc = new EE();
  recorderProc.stdout = new EE();
  recorderProc.stderr = new EE();
  recorderProc.stdin = { write() {} };
  recorderProc.kill = () => {};

  const { service, gate } = createRecoveryService({
    spawnTrackedPython: (args) => {
      const joined = args.map(String).join(' ');
      if (joined.includes('--list')) {
        return createProc({ success: true, candidates: [sampleCandidate] });
      }
      if (joined.includes('capture_recovery') || joined.includes('--recover')) {
        return createProc({
          success: true,
          recovered: [{ captureDir: sampleCandidate.captureDir, audioPath: '/tmp/a.wav', duration: 1 }],
          failed: [],
        }, { delayMs: 40 });
      }
      return recorderProc;
    },
  });
  await service.discoverInterruptedCaptures();

  const handlers = {};
  service.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  await gate.acquire('scan');
  const recoverPromise = service.recoverInterruptedCaptures();
  await new Promise((resolve) => setImmediate(resolve));

  const startPromise = handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );

  gate.release('scan');
  await new Promise((resolve) => setImmediate(resolve));

  recorderProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));

  const [startResult, recoverResult] = await Promise.all([startPromise, recoverPromise]);

  const startOk = Boolean(startResult && startResult.success);
  const recoverOk = Boolean(recoverResult && recoverResult.success);
  assert.equal(startOk && recoverOk, false);

  if (startOk) {
    assert.equal(service.getCaptureState().state, 'recording');
    assert.equal(recoverResult.success, false);
    assert.equal(recoverResult.code, 'RECORDING_IN_PROGRESS');
  } else {
    assert.ok(
      startResult.code === 'RECORDING_RECOVERY_IN_PROGRESS'
      || startResult.code === 'RECORDING_START_IN_PROGRESS',
    );
  }
  assert.equal(gate.getOwner(), 'idle');

  recorderProc.emit('close', 1);
  await new Promise((resolve) => setImmediate(resolve));
});
