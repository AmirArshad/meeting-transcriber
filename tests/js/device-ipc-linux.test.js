'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createDeviceIpc } = require('../../src/main/device-ipc');

function createFakePython({ code = 0, stdout = '', stderr = '' } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  queueMicrotask(() => {
    if (stdout) {
      proc.stdout.emit('data', Buffer.from(stdout));
    }
    if (stderr) {
      proc.stderr.emit('data', Buffer.from(stderr));
    }
    proc.emit('close', code);
  });
  return proc;
}

function createService({ platform, spawnImpl, deviceManagerTimeoutMs }) {
  return createDeviceIpc({
    app: { getPath: () => '/tmp' },
    path: require('node:path'),
    fs: require('node:fs'),
    spawn: () => {
      throw new Error('spawn should not be used by these tests');
    },
    spawnTrackedPython: spawnImpl,
    pythonConfig: { backendPath: '/tmp' },
    getBackendModuleArgs: (moduleName, extra = []) => ['-m', moduleName, ...extra],
    appendSpawnLogBuffer: (current, data) => String(current || '') + String(data),
    runProcessWithTimeout: async () => {
      throw new Error('runProcessWithTimeout should not be used by these tests');
    },
    buildMacOSPermissionCheckFailureStatus: () => ({}),
    MACOS_PERMISSION_CHECK_TIMEOUT_MS: 1000,
    platform,
    deviceManagerTimeoutMs,
  });
}

const PULSE_TRACEBACK = [
  'Warning: Could not enumerate Pulse devices: ConnectionRefusedError(/run/user/1000/pulse/native)',
  'ERROR: Could not list PulseAudio/PipeWire devices. Is the session audio service running?',
  'Traceback (most recent call last):',
  '  File "device_manager.py", line 1, in <module>',
  'ConnectionRefusedError: [Errno 111] /run/user/1000/pulse/native',
].join('\n');

test('validate-devices fail-closes on Linux Pulse-down without leaking raw Pulse paths', async () => {
  const service = createService({
    platform: 'linux',
    spawnImpl: () => createFakePython({ code: 1, stderr: PULSE_TRACEBACK }),
  });

  const result = await service.validateSelectedDevices({
    micId: 'pulse-source:avanevis_mic',
    loopbackId: 'none',
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /PulseAudio\/PipeWire devices/);
  assert.equal(result.errors[0].includes('/run/user'), false);
});

test('validate-devices uses the Pulse fallback when Linux stderr has no ERROR line', async () => {
  const service = createService({
    platform: 'linux',
    spawnImpl: () => createFakePython({
      code: 1,
      stderr: 'Traceback: ConnectionRefusedError(/run/user/1000/pulse/native)\n',
    }),
  });

  const result = await service.validateSelectedDevices({
    micId: 'pulse-source:avanevis_mic',
    loopbackId: 'none',
  });

  assert.equal(result.valid, false);
  assert.match(result.errors[0], /install pipewire-pulse/i);
  assert.match(result.errors[0], /user audio session/i);
  assert.equal(result.errors[0].includes('/run/user'), false);
});

test('validate-devices still warn-and-proceeds on Windows enumerate failure', async () => {
  const service = createService({
    platform: 'win32',
    spawnImpl: () => createFakePython({ code: 1, stderr: PULSE_TRACEBACK }),
  });

  const result = await service.validateSelectedDevices({
    micId: '0',
    loopbackId: '1',
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, ['Device enumeration failed - proceeding anyway']);
});

test('validate-devices still warn-and-proceeds on macOS enumerate failure', async () => {
  const service = createService({
    platform: 'darwin',
    spawnImpl: () => createFakePython({ code: 1, stderr: 'device_manager crashed\n' }),
  });

  const result = await service.validateSelectedDevices({
    micId: '2',
    loopbackId: '-1',
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, ['Device enumeration failed - proceeding anyway']);
});

test('get-audio-devices sanitizes Linux Pulse-down stderr', async () => {
  const service = createService({
    platform: 'linux',
    spawnImpl: () => createFakePython({ code: 1, stderr: PULSE_TRACEBACK }),
  });
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  await assert.rejects(
    () => handlers['get-audio-devices'](),
    (error) => error instanceof Error
      && /PulseAudio\/PipeWire devices/.test(error.message)
      && !error.message.includes('/run/user')
      && !error.message.includes('Traceback'),
  );
});

test('get-audio-devices keeps Windows stderr on enumerate failure', async () => {
  const service = createService({
    platform: 'win32',
    spawnImpl: () => createFakePython({ code: 1, stderr: 'pyaudio exploded\n' }),
  });
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  await assert.rejects(
    () => handlers['get-audio-devices'](),
    (error) => error instanceof Error && error.message.includes('pyaudio exploded'),
  );
});

function createHangingPython() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killCalls = 0;
  proc.kill = () => {
    proc.killCalls += 1;
  };
  return proc;
}

test('get-audio-devices times out instead of hanging on Linux', { timeout: 2000 }, async () => {
  const hanging = createHangingPython();
  const service = createService({
    platform: 'linux',
    spawnImpl: () => hanging,
    deviceManagerTimeoutMs: 20,
  });
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  await assert.rejects(
    () => handlers['get-audio-devices'](),
    (error) => error instanceof Error
      && /install pipewire-pulse/i.test(error.message)
      && /user audio session/i.test(error.message)
      && !error.message.includes('/run/user'),
  );
  assert.equal(hanging.killCalls >= 1, true);
});

test('warm-up-audio-system times out without leaving the IPC pending', { timeout: 2000 }, async () => {
  const hanging = createHangingPython();
  const service = createService({
    platform: 'linux',
    spawnImpl: () => hanging,
    deviceManagerTimeoutMs: 20,
  });
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  const result = await handlers['warm-up-audio-system']();
  assert.equal(result.success, true);
  assert.equal(result.deviceCount, 0);
  assert.equal(hanging.killCalls >= 1, true);
});
