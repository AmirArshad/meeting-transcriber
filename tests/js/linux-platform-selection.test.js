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
const { createAiAddonIpc } = require('../../src/main/ai-addon-ipc');
const {
  getSummaryRuntimeDir,
} = require('../../src/ai-addon-setup');
const {
  buildSummaryRuntimeEnv,
  validateSummaryRuntimeArtifact,
} = require('../../src/ai-addon/manifest-store');
const {
  getDiarizationAvailability,
  getSummaryAvailability,
  getSpeakrsSetupArtifactsForPlatform,
  getSummaryRuntimeArtifactForPlatform,
  getDiarizationDependencyArtifactForPlatform,
  buildAiAddonStatus,
  LINUX_DIARIZATION_UNAVAILABLE_REASON,
  LINUX_PYANNOTE_UNAVAILABLE_REASON,
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

async function withProcessRuntimeAsync({ platform, arch }, fn) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  Object.defineProperty(process, 'arch', { configurable: true, value: arch });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', platformDescriptor);
    Object.defineProperty(process, 'arch', archDescriptor);
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

test('Linux Python test wrappers prefer python3.11 before python3 (CachyOS python3 is 3.14)', () => {
  const runPythonTests = fs.readFileSync(path.join(__dirname, '../../scripts/run-python-tests.js'), 'utf8');
  const checkPythonSyntax = fs.readFileSync(path.join(__dirname, '../../scripts/check-python-syntax.js'), 'utf8');
  for (const source of [runPythonTests, checkPythonSyntax]) {
    const python311 = source.indexOf("command: 'python3.11'");
    const python3 = source.indexOf("command: 'python3'");
    assert.ok(python311 >= 0, 'missing python3.11 candidate');
    assert.ok(python3 >= 0, 'missing python3 candidate');
    assert.ok(python311 < python3, 'python3.11 must be tried before python3');
  }
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

test('Linux Speakrs and Qwen summary catalogs are present and CUDA-gated', () => {
  const diarization = getDiarizationAvailability('linux', 'x64');
  const summary = getSummaryAvailability('linux', 'x64');
  assert.equal(diarization.supported, false);
  assert.equal(diarization.acceleration, 'unsupported');
  assert.equal(diarization.reason, LINUX_DIARIZATION_UNAVAILABLE_REASON);
  assert.equal(summary.supported, false);
  assert.equal(summary.runtime, 'unsupported');
  assert.equal(summary.reason, LINUX_SUMMARY_UNAVAILABLE_REASON);

  const linuxArtifacts = getSpeakrsSetupArtifactsForPlatform('linux', 'x64');
  assert.equal(linuxArtifacts.modelPack.id, 'speakrs-models-5d24ffe-linux-x64-cuda');
  assert.equal(linuxArtifacts.runtime.modeByPlatform['linux-x64'], 'cuda');
  assert.ok(linuxArtifacts.runtimeArtifacts.some((entry) => entry.kind === 'ort-archive'));
  assert.ok(linuxArtifacts.runtimeArtifacts.some((entry) => entry.kind === 'curand-wheel'));
  assert.ok(linuxArtifacts.runtimeArtifacts.some((entry) => entry.kind === 'nvrtc-wheel'));
  const summaryRuntime = getSummaryRuntimeArtifactForPlatform('linux', 'x64');
  assert.equal(summaryRuntime.platform, 'linux');
  assert.equal(summaryRuntime.arch, 'x64');
  assert.equal(summaryRuntime.acceleration, 'cuda');
  assert.equal(summaryRuntime.artifacts.length, 3);
  assert.deepEqual(
    summaryRuntime.artifacts.map(({ fileName, sizeBytes, sha256 }) => ({ fileName, sizeBytes, sha256 })),
    [
      {
        fileName: 'llama.cpp-v0.3.0-cuda-12.8-amd64.tar.gz',
        sizeBytes: 150794376,
        sha256: '37616f0271e82717eb8ddcd5d2319fd845ddcf93c83fd3943d0a1a539c1d0a99',
      },
      {
        fileName: 'nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
        sizeBytes: 3493179,
        sha256: '25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3',
      },
      {
        fileName: 'nvidia_nccl_cu12-2.31.2-py3-none-manylinux_2_18_x86_64.whl',
        sizeBytes: 342105414,
        sha256: 'f9b1dc3c2a7e20176054144ebb3b32fea83b40402ee5d7ac7045cd11ecc956c0',
      },
    ],
  );
  assert.equal(validateSummaryRuntimeArtifact(summaryRuntime), null);
  const missingNccl = JSON.parse(JSON.stringify(summaryRuntime));
  missingNccl.artifacts = missingNccl.artifacts.filter((archive) => archive.kind !== 'nccl-wheel');
  assert.match(validateSummaryRuntimeArtifact(missingNccl), /NCCL/);
  assert.equal(getDiarizationDependencyArtifactForPlatform('linux', 'x64'), null);

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

  const readyCuda = {
    statusCode: 'ready',
    installed: true,
    deviceAvailable: true,
    runtimeLoadable: true,
    missingLibraries: [],
    matchedProfile: 'cuda12',
  };
  const admitted = getDiarizationAvailability('linux', 'x64', { cudaStatus: readyCuda });
  assert.equal(admitted.supported, true);
  assert.equal(admitted.acceleration, 'cuda');
  assert.equal(admitted.runtimeDevice, 'cuda');
  assert.equal(admitted.automaticAfterTranscription, true);

  const admittedStatus = buildAiAddonStatus({
    userDataDir: '/tmp/avanevis-linux-addons',
    platform: 'linux',
    arch: 'x64',
    cudaStatus: readyCuda,
    manifest: {
      features: {
        diarization: { status: 'notConfigured' },
        summary: { status: 'ready' },
      },
    },
  });
  assert.equal(admittedStatus.features.diarization.status, 'notConfigured');
  assert.equal(admittedStatus.features.diarization.availability.supported, true);
  assert.equal(admittedStatus.features.summary.status, 'ready');
  assert.equal(admittedStatus.features.summary.availability.supported, true);
  assert.match(LINUX_PYANNOTE_UNAVAILABLE_REASON, /Pyannote/);

  const stalePyannoteStatus = buildAiAddonStatus({
    userDataDir: '/tmp/avanevis-linux-addons',
    platform: 'linux',
    arch: 'x64',
    cudaStatus: readyCuda,
    manifest: {
      features: {
        diarization: { status: 'ready', engine: 'pyannote' },
      },
    },
  });
  assert.equal(stalePyannoteStatus.features.diarization.engine, 'speakrs');
  assert.equal(stalePyannoteStatus.features.diarization.status, 'notConfigured');

  const arm64 = getDiarizationAvailability('linux', 'arm64');
  assert.equal(arm64.supported, false);
  assert.match(arm64.reason, /x86_64|CUDA 12/);
});

test('Linux summary runtime environment is explicit and excludes ambient loader paths', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-summary-env-'));
  const artifact = require('../../src/ai-addon-state').getSummaryArtifactForPlatform(
    'qwen3.5-9b-q4-k-m',
    'linux',
    'x64',
  );
  const runtimeDir = getSummaryRuntimeDir(userDataDir, artifact);
  const extractDir = path.join(runtimeDir, 'extract', 'cuda-12.8');
  const managedRoot = path.join(userDataDir, 'ai-addons', 'cuda', 'python');
  fs.mkdirSync(extractDir, { recursive: true });
  fs.writeFileSync(path.join(extractDir, 'llama-cli'), '');
  for (const relativeDir of ['nvidia/cuda_runtime/lib', 'nvidia/nccl/lib']) {
    fs.mkdirSync(path.join(runtimeDir, 'extract', relativeDir), { recursive: true });
  }
  for (const relativeDir of ['nvidia/cublas/lib', 'nvidia/cudnn/lib']) {
    fs.mkdirSync(path.join(managedRoot, relativeDir), { recursive: true });
  }

  const originalLoaderPath = process.env.LD_LIBRARY_PATH;
  process.env.LD_LIBRARY_PATH = '/untrusted/ambient/path';
  try {
    const env = buildSummaryRuntimeEnv({
      userDataDir,
      artifact,
      platform: 'linux',
      arch: 'x64',
      driverLibraryDirs: [],
    });
    assert.ok(env.LD_LIBRARY_PATH.includes(path.join(runtimeDir, 'extract', 'cuda-12.8')));
    assert.ok(env.LD_LIBRARY_PATH.includes(path.join(runtimeDir, 'extract', 'nvidia', 'nccl', 'lib')));
    assert.ok(!env.LD_LIBRARY_PATH.includes('/untrusted/ambient/path'));
  } finally {
    if (originalLoaderPath === undefined) {
      delete process.env.LD_LIBRARY_PATH;
    } else {
      process.env.LD_LIBRARY_PATH = originalLoaderPath;
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Linux summary runtime rejects unexpected loaders and unsafe executable directories', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-summary-loader-'));
  const artifact = require('../../src/ai-addon-state').getSummaryArtifactForPlatform(
    'qwen3.5-9b-q4-k-m',
    'linux',
    'x64',
  );
  const runtimeDir = getSummaryRuntimeDir(userDataDir, artifact);
  const extractDir = path.join(runtimeDir, 'extract', 'cuda-12.8');
  const managedRoot = path.join(userDataDir, 'ai-addons', 'cuda', 'python');
  fs.mkdirSync(extractDir, { recursive: true });
  fs.writeFileSync(path.join(extractDir, 'llama-cli'), '');
  for (const relativeDir of ['nvidia/cuda_runtime/lib', 'nvidia/nccl/lib']) {
    fs.mkdirSync(path.join(runtimeDir, 'extract', relativeDir), { recursive: true });
  }
  for (const relativeDir of ['nvidia/cublas/lib', 'nvidia/cudnn/lib']) {
    fs.mkdirSync(path.join(managedRoot, relativeDir), { recursive: true });
  }

  try {
    fs.writeFileSync(path.join(extractDir, 'libhostile.so.6'), '');
    assert.throws(
      () => buildSummaryRuntimeEnv({
        userDataDir,
        artifact,
        platform: 'linux',
        arch: 'x64',
        driverLibraryDirs: [],
      }),
      /Unexpected summary runtime loader files/,
    );
    fs.rmSync(path.join(extractDir, 'libhostile.so.6'));

    if (os.type() !== 'Windows_NT') {
      fs.chmodSync(extractDir, 0o777);
      assert.throws(
        () => buildSummaryRuntimeEnv({
          userDataDir,
          artifact,
          platform: 'linux',
          arch: 'x64',
          driverLibraryDirs: [],
        }),
        /executable directory must not be world-writable/,
      );
    }
  } finally {
    if (os.type() !== 'Windows_NT') {
      fs.chmodSync(extractDir, 0o755);
    }
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Linux add-on status re-primes expired CUDA state when managed runtime exists', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-status-'));
  fs.mkdirSync(path.join(userDataDir, 'ai-addons', 'cuda', 'python'), { recursive: true });
  const readyCuda = {
    statusCode: 'ready',
    installed: true,
    deviceAvailable: true,
    runtimeLoadable: true,
    missingLibraries: [],
    matchedProfile: 'cuda12',
  };
  let observedCudaStatus = null;
  let liveProbeCount = 0;
  const service = createAiAddonIpc({
    app: { getPath: () => userDataDir },
    path,
    fs,
    pythonConfig: { backendPath: userDataDir },
    sendToRenderer() {},
    checkAiAddonSetupStatus: async (options) => {
      observedCudaStatus = options.cudaStatus;
      return { features: { summary: { status: 'unsupported' } } };
    },
    getCachedCudaStatus: () => null,
    resolveCudaStatusForTranscription: async () => {
      liveProbeCount += 1;
      return readyCuda;
    },
    enqueueGpuResourceAction: (action) => action(),
    terminateProcessBestEffort: () => {},
  });
  const handlers = {};
  try {
    service.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });
    await withProcessRuntimeAsync({ platform: 'linux', arch: 'x64' }, () => (
      handlers['get-ai-addon-status']({ sender: {} }, { verifyChecksumsIfChanged: true })
    ));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  assert.equal(liveProbeCount, 1);
  assert.equal(observedCudaStatus, readyCuda);
});

test('Speakrs packaging builds the Linux CLI while resource manifests still fingerprint', () => {
  assert.equal(isSpeakrsPackagingSupported('linux'), true);
  assert.equal(isSpeakrsPackagingSupported('win32'), true);
  assert.equal(getSpeakrsCargoTargetTriple('linux'), 'x86_64-unknown-linux-gnu');
  assert.equal(getSpeakrsResourceManifestTarget('linux'), 'x86_64-unknown-linux-gnu');
  assert.equal(getSpeakrsResourceManifestTarget('darwin'), 'aarch64-apple-darwin');

  const manifest = withProcessPlatform('linux', () => buildResourceManifest());
  assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.inputs.speakrsCargoTarget, 'x86_64-unknown-linux-gnu');
  assert.equal(typeof manifest.inputs.speakrsCargoToml, 'string');
  assert.equal(manifest.inputs.speakrsCargoToml.length, 64);
});

test('updater matches Linux AvaNevis-Setup AppImage and ignores source archives', () => {
  const { findInstallerAsset } = loadUpdater();
  assert.deepEqual(findInstallerAsset([
    { name: 'source.tar.gz' },
    { name: 'AvaNevis-Setup-2.7.0.AppImage' },
    { name: 'AvaNevis-Setup-2.7.0.exe' },
  ], { platform: 'linux', env: {}, osReleaseText: '' }), { name: 'AvaNevis-Setup-2.7.0.AppImage' });
  assert.equal(findInstallerAsset([
    { name: 'source.tar.gz' },
    { name: 'AvaNevis-Setup-2.7.0.tar.gz' },
    { name: 'AvaNevis-2.7.0.deb' },
  ], { platform: 'linux', env: {}, osReleaseText: 'ID=ubuntu\n' }), null);
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
