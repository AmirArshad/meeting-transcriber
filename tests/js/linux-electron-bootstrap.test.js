'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createGpuRuntimeService } = require('../../src/main/gpu-runtime-service');

const {
  applyLinuxElectronCommandLineSwitches,
  getSelectedStorageBackend,
  probeSecretStorage,
  resolveLinuxPasswordStore,
  runLinuxSafeStorageSmoke,
  SAFESTORAGE_SMOKE_CANARY,
} = require('../../src/main-process/linux-electron-bootstrap');

test('Linux password-store is gnome-libsecret except KDE → kwallet6', () => {
  assert.equal(resolveLinuxPasswordStore({ XDG_CURRENT_DESKTOP: 'Hyprland' }), 'gnome-libsecret');
  assert.equal(resolveLinuxPasswordStore({ XDG_CURRENT_DESKTOP: 'sway:wlroots' }), 'gnome-libsecret');
  assert.equal(resolveLinuxPasswordStore({}), 'gnome-libsecret');
  assert.equal(resolveLinuxPasswordStore({ XDG_CURRENT_DESKTOP: 'KDE' }), 'kwallet6');
  assert.equal(resolveLinuxPasswordStore({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), 'gnome-libsecret');
  assert.equal(resolveLinuxPasswordStore({ KDE_FULL_SESSION: 'true' }), 'kwallet6');
});

test('Linux command-line switches append password-store and ozone-platform-hint=auto', () => {
  const switches = [];
  const commandLine = {
    appendSwitch(name, value) {
      switches.push([name, value]);
    },
  };
  const result = applyLinuxElectronCommandLineSwitches(commandLine, {
    XDG_CURRENT_DESKTOP: 'Hyprland',
  });
  assert.deepEqual(switches, [
    ['password-store', 'gnome-libsecret'],
    ['ozone-platform-hint', 'auto'],
  ]);
  assert.equal(result.passwordStore, 'gnome-libsecret');
  assert.equal(result.ozonePlatformHint, 'auto');
});

test('getSelectedStorageBackend is exposed for later preflights and rejects basic_text probes', () => {
  assert.equal(getSelectedStorageBackend(null), null);
  assert.equal(getSelectedStorageBackend({}), null);
  assert.equal(getSelectedStorageBackend({
    getSelectedStorageBackend: () => 'gnome_libsecret',
  }), 'gnome_libsecret');

  const probe = probeSecretStorage({
    getSelectedStorageBackend: () => 'basic_text',
    isEncryptionAvailable: () => true,
  });
  assert.equal(probe.backend, 'basic_text');
  assert.equal(probe.encryptionAvailable, true);
  assert.equal(probe.isBasicText, true);

  const real = probeSecretStorage({
    getSelectedStorageBackend: () => 'gnome_libsecret',
    isEncryptionAvailable: () => true,
  });
  assert.equal(real.isBasicText, false);
});

test('Linux safeStorage smoke requires a real backend and a successful encrypt/decrypt round-trip', () => {
  const basic = runLinuxSafeStorageSmoke({
    getSelectedStorageBackend: () => 'basic_text',
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from('x'),
    decryptString: () => SAFESTORAGE_SMOKE_CANARY,
  });
  assert.equal(basic.ok, false);
  assert.equal(basic.isBasicText, true);
  assert.equal(basic.roundTrip, false);

  const good = runLinuxSafeStorageSmoke({
    getSelectedStorageBackend: () => 'gnome_libsecret',
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  });
  assert.equal(good.ok, true);
  assert.equal(good.roundTrip, true);
  assert.equal(good.isBasicText, false);
});

const {
  getUnsupportedPlatformCudaProbeError,
  buildUnsupportedPlatformCudaStatus,
} = require('../../src/main-process/cuda-runtime-helpers');

test('Linux CUDA probe reports unavailable and does not advertise install', () => {
  const linux = buildUnsupportedPlatformCudaStatus('linux');
  assert.equal(linux.installed, false);
  assert.equal(linux.deviceAvailable, false);
  assert.equal(linux.runtimeLoadable, false);
  assert.equal(linux.statusCode, 'unsupportedPlatform');
  assert.deepEqual(linux.supportedProfiles, []);
  assert.equal(linux.recommendedInstallProfile, null);
  assert.match(linux.error, /not available on Linux in this version/);
  assert.match(linux.error, /CPU faster-whisper/);
  assert.equal(
    getUnsupportedPlatformCudaProbeError('linux'),
    'CUDA is not available on Linux in this version. Transcription uses the CPU faster-whisper runtime.',
  );
  assert.match(getUnsupportedPlatformCudaProbeError('darwin'), /only supported on Windows/);
});

test('Linux GPU IPC fails closed before Python probing or GPU runtime queue admission', async () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const handlers = {};
  let pythonVersionCalls = 0;
  let gpuQueueAdmissions = 0;

  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  try {
    const service = createGpuRuntimeService({
      app: { getPath: () => '/tmp/avanevis-test' },
      path,
      fs,
      pythonConfig: { pythonExe: '/fake/python', backendPath: '/fake/backend' },
      spawnTrackedPython: () => {
        throw new Error('Linux GPU IPC must not spawn Python');
      },
      getBackendModuleArgs: () => [],
      appendSpawnLogBuffer: (buffer, data) => `${buffer}${data}`,
      sendRedactedProgress: () => {},
      flushRedactedProgress: () => {},
      getActivePythonVersion: async () => {
        pythonVersionCalls += 1;
        return { output: 'Python 3.11.9', parsed: { version: '3.11.9', major: 3, minor: 11 } };
      },
      terminateProcessBestEffort: () => {},
      assertTrustedRendererSender: () => {},
      getDiarizationDependencySitePackagesPath: () => null,
      enqueueGpuResourceAction: async (action) => {
        gpuQueueAdmissions += 1;
        return action();
      },
    });
    service.registerIpc({
      handle(channel, handler) {
        handlers[channel] = handler;
      },
    });

    const status = await handlers['check-cuda']({ sender: {} });
    assert.equal(status.statusCode, 'unsupportedPlatform');
    assert.deepEqual(status.packages, []);
    assert.equal(status.pythonVersion, null);
    assert.equal(status.pythonExecutable, null);
    assert.equal(pythonVersionCalls, 0);

    await assert.rejects(
      handlers['ensure-compatible-gpu-runtime']({ sender: {} }),
      (error) => error && error.code === 'unsupportedPlatform',
    );
    assert.equal(gpuQueueAdmissions, 0);
    assert.equal(pythonVersionCalls, 0);
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});
