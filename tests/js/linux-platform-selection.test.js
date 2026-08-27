'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const {
  getRecorderModule,
  getTranscriberModule,
} = require('../../src/main-process-helpers');
const {
  getDiarizationAvailability,
  getSummaryAvailability,
  getSpeakrsSetupArtifactsForPlatform,
  getSummaryRuntimeArtifactForPlatform,
  buildAiAddonStatus,
  LINUX_DIARIZATION_UNAVAILABLE_REASON,
  LINUX_SUMMARY_UNAVAILABLE_REASON,
} = require('../../src/ai-addon-state');
const {
  createPythonRuntime,
  resolvePythonRuntimeLayout,
} = require('../../src/main/python-runtime');
const {
  getSpeakrsCargoTargetTriple,
  getSpeakrsResourceManifestTarget,
  isSpeakrsPackagingSupported,
  buildResourceManifest,
} = require('../../build/prepare-resources');

const electronModulePath = require.resolve('electron');
const updaterModulePath = require.resolve('../../src/updater');

function withProcessPlatform(platform, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}

function loadUpdater() {
  const originalElectronModule = require.cache[electronModulePath];
  delete require.cache[updaterModulePath];
  require.cache[electronModulePath] = {
    id: electronModulePath,
    filename: electronModulePath,
    loaded: true,
    exports: {
      app: { getVersion: () => '2.7.0' },
      shell: { openExternal: () => Promise.resolve() },
    },
  };
  try {
    return require(updaterModulePath);
  } finally {
    if (originalElectronModule) {
      require.cache[electronModulePath] = originalElectronModule;
    } else {
      delete require.cache[electronModulePath];
    }
  }
}

test('getRecorderModule selects explicit platform modules including Linux', () => {
  assert.equal(getRecorderModule('darwin'), 'audio.macos_recorder');
  assert.equal(getRecorderModule('win32'), 'audio.windows_recorder');
  assert.equal(getRecorderModule('linux'), 'audio.linux_recorder');
  assert.throws(
    () => getRecorderModule('freebsd'),
    /Supported platforms: Windows, macOS, Linux/,
  );
});

test('getTranscriberModule uses faster-whisper on Linux and Windows, MLX only on Apple Silicon', () => {
  assert.equal(getTranscriberModule('linux', 'x64'), 'transcription.faster_whisper_transcriber');
  assert.equal(getTranscriberModule('win32', 'x64'), 'transcription.faster_whisper_transcriber');
  assert.equal(getTranscriberModule('darwin', 'x64'), 'transcription.faster_whisper_transcriber');
  assert.equal(getTranscriberModule('darwin', 'arm64'), 'transcription.mlx_whisper_transcriber');
});

test('Python runtime layout is POSIX on Linux and does not inherit Windows paths', () => {
  const linux = resolvePythonRuntimeLayout('linux');
  const mac = resolvePythonRuntimeLayout('darwin');
  const windows = resolvePythonRuntimeLayout('win32');

  assert.equal(linux.family, 'posix');
  assert.deepEqual(linux, mac);
  assert.equal(linux.venvBinDir, 'bin');
  assert.equal(linux.pythonFileName, 'python3');
  assert.equal(linux.systemPython, 'python3');
  assert.deepEqual(linux.packagedPythonSegments, ['python', 'bin', 'python3']);
  assert.deepEqual(linux.packagedFfmpegSegments, ['ffmpeg', 'ffmpeg']);

  assert.equal(windows.family, 'windows');
  assert.equal(windows.venvBinDir, 'Scripts');
  assert.equal(windows.pythonFileName, 'python.exe');
  assert.deepEqual(windows.packagedPythonSegments, ['python', 'python.exe']);
  assert.throws(() => resolvePythonRuntimeLayout('freebsd'), /Unsupported Python runtime platform/);
});

test('dev Python resolution on Linux uses repo .venv/bin/python3', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-pyrt-'));
  const srcDir = path.join(repoRoot, 'src');
  const venvBin = path.join(repoRoot, '.venv', 'bin');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(venvBin, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.venv', 'pyvenv.cfg'), 'home = /usr\n');
  const repoPython = path.join(venvBin, 'python3');
  fs.writeFileSync(repoPython, '');

  const previousVirtualEnv = process.env.VIRTUAL_ENV;
  const previousAvanevisPython = process.env.AVANEVIS_PYTHON;
  delete process.env.VIRTUAL_ENV;
  delete process.env.AVANEVIS_PYTHON;

  try {
    const runtime = withProcessPlatform('linux', () => createPythonRuntime({
      app: { isPackaged: false },
      spawn: () => new EventEmitter(),
      path,
      fs,
      dirname: srcDir,
    }));
    assert.equal(runtime.pythonConfig.pythonExe, repoPython);
    assert.equal(runtime.pythonConfig.pythonSource, '.venv');
    assert.equal(runtime.pythonConfig.ffmpegPath, 'ffmpeg');
  } finally {
    if (previousVirtualEnv === undefined) {
      delete process.env.VIRTUAL_ENV;
    } else {
      process.env.VIRTUAL_ENV = previousVirtualEnv;
    }
    if (previousAvanevisPython === undefined) {
      delete process.env.AVANEVIS_PYTHON;
    } else {
      process.env.AVANEVIS_PYTHON = previousAvanevisPython;
    }
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('packaged Python on Linux uses the POSIX python-build-standalone layout', () => {
  const previousResources = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/opt/AvaNevis/resources' });
  try {
    const runtime = withProcessPlatform('linux', () => createPythonRuntime({
      app: { isPackaged: true },
      spawn: () => new EventEmitter(),
      path,
      fs,
      dirname: '/opt/AvaNevis/src',
    }));
    assert.equal(
      runtime.pythonConfig.pythonExe,
      path.join('/opt/AvaNevis/resources', 'python', 'bin', 'python3'),
    );
    assert.equal(
      runtime.pythonConfig.ffmpegPath,
      path.join('/opt/AvaNevis/resources', 'ffmpeg', 'ffmpeg'),
    );
    assert.equal(runtime.pythonConfig.pythonSource, 'packaged');
  } finally {
    if (previousResources === undefined) {
      delete process.resourcesPath;
    } else {
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: previousResources });
    }
  }
});

test('packaged buildPythonEnv isolates PYTHONPATH and disables user site', () => {
  const previousResources = process.resourcesPath;
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/opt/AvaNevis/resources' });
  const previousPythonPath = process.env.PYTHONPATH;
  const previousPythonHome = process.env.PYTHONHOME;
  const previousUserBase = process.env.PYTHONUSERBASE;
  process.env.PYTHONPATH = '/tmp/hostile-pythonpath';
  process.env.PYTHONHOME = '/tmp/hostile-pythonhome';
  process.env.PYTHONUSERBASE = '/tmp/hostile-userbase';
  try {
    const runtime = withProcessPlatform('linux', () => createPythonRuntime({
      app: { isPackaged: true },
      spawn: () => new EventEmitter(),
      path,
      fs,
      dirname: '/opt/AvaNevis/src',
    }));
    const env = runtime.buildPythonEnv({ PYTHONHOME: '/tmp/caller-pythonhome' });
    assert.equal(env.PYTHONPATH, runtime.pythonConfig.backendPath);
    assert.equal(env.PYTHONPATH.includes('hostile-pythonpath'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'PYTHONHOME'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'PYTHONUSERBASE'), false);
    assert.equal(env.PYTHONNOUSERSITE, '1');
    assert.equal(env.AVANEVIS_PACKAGED, '1');

    const extra = path.join(os.tmpdir(), 'avanevis-managed-site');
    const withExtra = runtime.buildPythonEnv({ PYTHONPATH: extra });
    assert.equal(withExtra.PYTHONPATH.startsWith(`${extra}${path.delimiter}`), true);
    assert.equal(withExtra.PYTHONPATH.includes('hostile-pythonpath'), false);
  } finally {
    if (previousResources === undefined) {
      delete process.resourcesPath;
    } else {
      Object.defineProperty(process, 'resourcesPath', { configurable: true, value: previousResources });
    }
    if (previousPythonPath === undefined) {
      delete process.env.PYTHONPATH;
    } else {
      process.env.PYTHONPATH = previousPythonPath;
    }
    if (previousPythonHome === undefined) {
      delete process.env.PYTHONHOME;
    } else {
      process.env.PYTHONHOME = previousPythonHome;
    }
    if (previousUserBase === undefined) {
      delete process.env.PYTHONUSERBASE;
    } else {
      process.env.PYTHONUSERBASE = previousUserBase;
    }
  }
});

test('Linux add-on catalog paths stay unsupported until later phases', () => {
  const diarization = getDiarizationAvailability('linux', 'x64');
  const summary = getSummaryAvailability('linux', 'x64');
  assert.equal(diarization.supported, false);
  assert.equal(diarization.acceleration, 'unsupported');
  assert.equal(diarization.reason, LINUX_DIARIZATION_UNAVAILABLE_REASON);
  assert.equal(summary.supported, false);
  assert.equal(summary.runtime, 'unsupported');
  assert.equal(summary.reason, LINUX_SUMMARY_UNAVAILABLE_REASON);
  assert.equal(getSpeakrsSetupArtifactsForPlatform('linux', 'x64').modelPack, null);
  assert.deepEqual(getSpeakrsSetupArtifactsForPlatform('linux', 'x64').packEntries, []);
  assert.equal(getSummaryRuntimeArtifactForPlatform('linux', 'x64'), null);

  const status = buildAiAddonStatus({
    userDataDir: '/tmp/avanevis-linux-addons',
    platform: 'linux',
    arch: 'x64',
    manifest: {
      features: {
        diarization: { status: 'ready' },
        summary: { status: 'ready' },
      },
    },
  });
  assert.equal(status.features.diarization.status, 'unsupported');
  assert.equal(status.features.summary.status, 'unsupported');
});

test('Speakrs packaging stays fail-closed on Linux while resource manifests still fingerprint', () => {
  assert.equal(isSpeakrsPackagingSupported('linux'), false);
  assert.equal(isSpeakrsPackagingSupported('win32'), true);
  assert.throws(() => getSpeakrsCargoTargetTriple('linux'), /Unsupported Speakrs packaging platform/);
  assert.equal(getSpeakrsResourceManifestTarget('linux'), null);
  assert.equal(getSpeakrsResourceManifestTarget('darwin'), 'aarch64-apple-darwin');

  const manifest = withProcessPlatform('linux', () => buildResourceManifest());
  assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.inputs.speakrsCargoTarget, null);
  assert.equal(typeof manifest.inputs.speakrsCargoToml, 'string');
  assert.equal(manifest.inputs.speakrsCargoToml.length, 64);
});

test('updater does not treat Linux source archives as installers before Phase 5', () => {
  const { findInstallerAsset } = loadUpdater();
  withProcessPlatform('linux', () => {
    assert.equal(findInstallerAsset([
      { name: 'source.tar.gz' },
      { name: 'AvaNevis-Setup-2.7.0.AppImage' },
      { name: 'AvaNevis-Setup-2.7.0.exe' },
    ]), null);
  });
});

test('opaque Pulse device IDs round-trip as strings (Phase 2)', () => {
  const {
    toOpaqueDeviceId,
    decorateDesktopDevices,
  } = require('../../src/renderer/platform-selection-helpers');
  assert.equal(toOpaqueDeviceId('pulse-source:alsa_input.usb-mic'), 'pulse-source:alsa_input.usb-mic');
  assert.equal(Number.isNaN(parseInt(toOpaqueDeviceId('pulse-source:alsa_input.usb-mic'), 10)), true);
  assert.equal(decorateDesktopDevices([], 'linux')[0].id, 'none');
});
