'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createGpuRuntimeService } = require('../../src/main/gpu-runtime-service');

const {
  applyLinuxElectronCommandLineSwitches,
  buildLinuxEnvironmentDiagnostics,
  classifyLinuxDesktopEnvironment,
  getSelectedStorageBackend,
  probeSecretStorage,
  resolveLinuxPasswordStore,
  runLinuxSafeStorageSmoke,
  SAFESTORAGE_SMOKE_CANARY,
} = require('../../src/main-process/linux-electron-bootstrap');

test('Linux desktop classification covers the friend-test matrix without changing secret-store policy', () => {
  const cases = [
    ['GNOME', 'gnome'],
    ['ubuntu:GNOME', 'gnome'],
    ['KDE', 'kde'],
    ['KDE:Plasma', 'kde'],
    ['Hyprland', 'hyprland'],
    ['COSMIC', 'cosmic'],
    ['sway:wlroots', 'sway'],
    ['niri', 'niri'],
    ['X-Cinnamon', 'cinnamon'],
    ['XFCE', 'xfce'],
    ['unexpected-shell', 'other'],
    ['', 'unknown'],
  ];

  for (const [desktop, expected] of cases) {
    const env = desktop ? { XDG_CURRENT_DESKTOP: desktop } : {};
    assert.equal(classifyLinuxDesktopEnvironment(env), expected, desktop || '(unset)');
    assert.equal(
      resolveLinuxPasswordStore(env),
      expected === 'kde' ? 'kwallet6' : 'gnome-libsecret',
      desktop || '(unset)',
    );
  }
});

test('Linux diagnostics are bounded, sanitized, and do not expose display socket values', () => {
  const diagnostics = buildLinuxEnvironmentDiagnostics({
    env: {
      XDG_CURRENT_DESKTOP: 'ubuntu:GNOME\nsecret=value',
      XDG_SESSION_TYPE: 'wayland\nunsafe',
      WAYLAND_DISPLAY: 'wayland-secret-socket',
      DISPLAY: ':99-private',
    },
    safeStorage: {
      getSelectedStorageBackend: () => 'gnome_libsecret',
      isEncryptionAvailable: () => true,
    },
    commandLine: {
      getSwitchValue(name) {
        return name === 'ozone-platform-hint' ? 'auto' : '';
      },
    },
    argv: ['/opt/AvaNevis/avanevis', '--no-sandbox'],
  });

  assert.deepEqual(diagnostics, {
    desktop: 'ubuntu:GNOME secret=value',
    desktopFamily: 'gnome',
    sessionType: 'wayland unsafe',
    hasWaylandDisplay: true,
    hasX11Display: true,
    requestedPasswordStore: 'gnome-libsecret',
    selectedSecretBackend: 'gnome_libsecret',
    secretEncryptionAvailable: true,
    ozonePlatform: null,
    ozonePlatformHint: 'auto',
    sandboxDisabled: true,
  });
  assert.doesNotMatch(JSON.stringify(diagnostics), /wayland-secret-socket|:99-private/);

  const oversized = buildLinuxEnvironmentDiagnostics({
    env: { XDG_CURRENT_DESKTOP: `Hyprland${'x'.repeat(300)}` },
  });
  assert.ok(oversized.desktop.length <= 120);
});

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
  getManagedLinuxCudaRuntimeTarget,
  getManagedLinuxCudaLibraryDirs,
} = require('../../src/main-process/cuda-runtime-helpers');

test('Linux CUDA managed target is userData-scoped and has only wheel library roots', () => {
  const target = getManagedLinuxCudaRuntimeTarget('/home/alice/.config/AvaNevis');
  assert.equal(target, '/home/alice/.config/AvaNevis/ai-addons/cuda/python');
  assert.deepEqual(getManagedLinuxCudaLibraryDirs(target), [
    '/home/alice/.config/AvaNevis/ai-addons/cuda/python/nvidia/cublas/lib',
    '/home/alice/.config/AvaNevis/ai-addons/cuda/python/nvidia/cudnn/lib',
  ]);
});

test('admitted Linux CUDA builds a controlled managed-first loader environment', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  try {
    const userData = '/tmp/avanevis-linux-cuda-test';
    const target = getManagedLinuxCudaRuntimeTarget(userData);
    const libraryDirs = getManagedLinuxCudaLibraryDirs(target);
    const service = createGpuRuntimeService({
      app: { getPath: () => userData },
      path,
      fs: { existsSync: (candidate) => libraryDirs.includes(candidate) },
      pythonConfig: { pythonExe: '/fake/python' },
      spawnTrackedPython: () => { throw new Error('not used'); },
      getBackendModuleArgs: () => [],
      appendSpawnLogBuffer: (buffer) => buffer,
      sendRedactedProgress: () => {},
      flushRedactedProgress: () => {},
      getActivePythonVersion: async () => ({ parsed: { version: '3.11.9' } }),
      terminateProcessBestEffort: () => {},
      assertTrustedRendererSender: () => {},
      getDiarizationDependencySitePackagesPath: () => null,
      isLinuxCudaProfileEnabled: () => true,
    });
    const env = service.buildCudaRuntimeEnv({ LD_LIBRARY_PATH: '/usr/lib:/lib' });
    assert.equal(env.LD_LIBRARY_PATH, `${libraryDirs.join(':')}:/usr/lib:/lib`);
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
  }
});

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

test('macOS CUDA probe shape is pinned and advertises no installable profile', () => {
  // Sharing buildUnsupportedPlatformCudaStatus with Linux changed the macOS
  // payload: it used to carry the Windows cuda12 profile list plus a
  // recommendedInstallProfile, which was never installable on macOS anyway.
  // Pin the shape so a future Linux tweak cannot silently reshape macOS.
  const mac = buildUnsupportedPlatformCudaStatus('darwin');
  assert.equal(mac.installed, false);
  assert.equal(mac.deviceAvailable, false);
  assert.equal(mac.runtimeLoadable, false);
  assert.equal(mac.runtime, 'ctranslate2');
  assert.equal(mac.statusCode, 'unsupportedPlatform');
  assert.deepEqual(mac.missingLibraries, []);
  assert.deepEqual(mac.supportedProfiles, []);
  assert.deepEqual(mac.unsupportedDetectedProfiles, []);
  assert.equal(mac.recommendedInstallProfile, null);
  assert.equal(mac.error, 'CUDA runtime checks are only supported on Windows.');
  // The renderer joins these arrays for the CUDA warning banner; empty arrays
  // (not undefined) keep that copy from rendering "undefined".
  assert.equal(mac.supportedProfiles.join(', '), '');
});

test('Linux GPU IPC fails closed before Python probing or GPU runtime queue admission', async () => {
  for (const platform of ['linux', 'darwin']) {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const handlers = {};
    let pythonVersionCalls = 0;
    let gpuQueueAdmissions = 0;

    Object.defineProperty(process, 'platform', { configurable: true, value: platform });
    try {
      const service = createGpuRuntimeService({
        app: { getPath: () => '/tmp/avanevis-test' },
        path,
        fs,
        pythonConfig: { pythonExe: '/fake/python', backendPath: '/fake/backend' },
        spawnTrackedPython: () => {
          throw new Error(`${platform} GPU IPC must not spawn Python`);
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
      assert.equal(status.statusCode, 'unsupportedPlatform', platform);
      assert.deepEqual(status.packages, []);
      assert.equal(status.pythonVersion, null);
      assert.equal(status.pythonExecutable, null);
      assert.equal(pythonVersionCalls, 0);

      // All three mutating GPU channels reject before touching the resource
      // queue. This is a deliberate contract change from the older structured
      // { success: false } resolution — pin it for macOS too, not just Linux.
      for (const channel of ['install-gpu', 'ensure-compatible-gpu-runtime', 'uninstall-gpu']) {
        await assert.rejects(
          handlers[channel]({ sender: {} }, {}),
          (error) => error && error.code === 'unsupportedPlatform',
          `${platform} ${channel} must reject`,
        );
      }
      assert.equal(gpuQueueAdmissions, 0);
      assert.equal(pythonVersionCalls, 0);
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  }
});
