'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const { createPythonRuntime, resolveVirtualEnvFromPythonExe } = require('../../src/main/python-runtime');
const { createGpuRuntimeService } = require('../../src/main/gpu-runtime-service');

function makeFakeApp({ isPackaged = false } = {}) {
  return { isPackaged };
}

test('resolveVirtualEnvFromPythonExe finds pyvenv.cfg root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-venv-'));
  const binDir = path.join(root, process.platform === 'win32' ? 'Scripts' : 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'pyvenv.cfg'), 'home = /usr\n');
  const pythonExe = path.join(binDir, process.platform === 'win32' ? 'python.exe' : 'python3');
  fs.writeFileSync(pythonExe, '');

  assert.equal(resolveVirtualEnvFromPythonExe(pythonExe, { path, fs }), root);
});

test('dev python resolution skips stale VIRTUAL_ENV and uses repo .venv', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-pyrt-'));
  const srcDir = path.join(repoRoot, 'src');
  const venvBin = path.join(repoRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(venvBin, { recursive: true });
  fs.writeFileSync(path.join(repoRoot, '.venv', 'pyvenv.cfg'), 'home = /usr\n');
  const repoPython = path.join(venvBin, process.platform === 'win32' ? 'python.exe' : 'python3');
  fs.writeFileSync(repoPython, '');

  const previousVirtualEnv = process.env.VIRTUAL_ENV;
  const previousAvanevisPython = process.env.AVANEVIS_PYTHON;
  process.env.VIRTUAL_ENV = path.join(repoRoot, 'missing-venv');
  delete process.env.AVANEVIS_PYTHON;

  try {
    const runtime = createPythonRuntime({
      app: makeFakeApp({ isPackaged: false }),
      spawn: () => new EventEmitter(),
      path,
      fs,
      dirname: srcDir,
    });
    assert.equal(runtime.pythonConfig.pythonExe, repoPython);
    assert.equal(runtime.pythonConfig.pythonSource, '.venv');
    assert.equal(runtime.pythonConfig.virtualEnv, path.join(repoRoot, '.venv'));
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
  }
});

test('AVANEVIS_PYTHON does not inherit an unrelated VIRTUAL_ENV for site-packages hints', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-pyrt-explicit-'));
  const srcDir = path.join(repoRoot, 'src');
  const otherVenv = path.join(repoRoot, 'other-venv');
  const otherBin = path.join(otherVenv, process.platform === 'win32' ? 'Scripts' : 'bin');
  const explicitPython = path.join(repoRoot, 'custom-python');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(otherBin, { recursive: true });
  fs.writeFileSync(path.join(otherVenv, 'pyvenv.cfg'), 'home = /usr\n');
  fs.writeFileSync(
    path.join(otherBin, process.platform === 'win32' ? 'python.exe' : 'python3'),
    '',
  );
  fs.writeFileSync(explicitPython, '');

  const previousVirtualEnv = process.env.VIRTUAL_ENV;
  const previousAvanevisPython = process.env.AVANEVIS_PYTHON;
  process.env.VIRTUAL_ENV = otherVenv;
  process.env.AVANEVIS_PYTHON = explicitPython;

  try {
    const runtime = createPythonRuntime({
      app: makeFakeApp({ isPackaged: false }),
      spawn: () => new EventEmitter(),
      path,
      fs,
      dirname: srcDir,
    });
    assert.equal(runtime.pythonConfig.pythonExe, explicitPython);
    assert.equal(runtime.pythonConfig.pythonSource, 'AVANEVIS_PYTHON');
    assert.equal(runtime.pythonConfig.virtualEnv, null);
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
  }
});

test('enrichCheckCudaStatus caches active Python version after first success', async () => {
  let versionCalls = 0;
  const service = createGpuRuntimeService({
    app: makeFakeApp(),
    path,
    fs,
    pythonConfig: { pythonExe: '/fake/python', backendPath: '/fake/backend' },
    spawnTrackedPython: () => {
      throw new Error('unexpected spawn');
    },
    getBackendModuleArgs: () => [],
    appendSpawnLogBuffer: (buf, data) => `${buf}${data}`,
    sendRedactedProgress: () => {},
    flushRedactedProgress: () => {},
    getActivePythonVersion: async () => {
      versionCalls += 1;
      return { output: 'Python 3.11.9', parsed: { version: '3.11.9', major: 3, minor: 11 } };
    },
    terminateProcessBestEffort: () => {},
    assertTrustedRendererSender: () => {},
    getDiarizationDependencySitePackagesPath: () => null,
  });

  const first = await service.enrichCheckCudaStatus({
    installed: false,
    deviceAvailable: false,
    runtimeLoadable: false,
    missingLibraries: [],
    runtime: 'ctranslate2',
    statusCode: 'deviceUnavailable',
  });
  const second = await service.enrichCheckCudaStatus({
    installed: false,
    deviceAvailable: false,
    runtimeLoadable: false,
    missingLibraries: [],
    runtime: 'ctranslate2',
    statusCode: 'deviceUnavailable',
  });

  assert.equal(versionCalls, 1);
  assert.equal(first.pythonVersion, '3.11.9');
  assert.equal(second.pythonVersion, '3.11.9');
});

test('invalidateCachedCudaStatus clears TTL cache used by getCachedCudaStatus', () => {
  const service = createGpuRuntimeService({
    app: makeFakeApp(),
    path,
    fs,
    pythonConfig: { pythonExe: '/fake/python', backendPath: '/fake/backend' },
    spawnTrackedPython: () => new EventEmitter(),
    getBackendModuleArgs: () => [],
    appendSpawnLogBuffer: (buf, data) => `${buf}${data}`,
    sendRedactedProgress: () => {},
    flushRedactedProgress: () => {},
    getActivePythonVersion: async () => ({ output: 'Python 3.11.9', parsed: { version: '3.11.9' } }),
    terminateProcessBestEffort: () => {},
    assertTrustedRendererSender: () => {},
    getDiarizationDependencySitePackagesPath: () => null,
  });

  service.updateCachedCudaStatus({
    installed: true,
    deviceAvailable: true,
    runtimeLoadable: true,
    missingLibraries: [],
    runtime: 'ctranslate2',
    statusCode: 'ready',
  });
  assert.equal(service.getCachedCudaStatus().runtimeLoadable, true);

  service.invalidateCachedCudaStatus();
  assert.equal(service.getCachedCudaStatus(), null);
});

test('resolveCudaStatusForTranscription re-probes when GPU action is idle', async () => {
  let probeSpawns = 0;
  const service = createGpuRuntimeService({
    app: makeFakeApp(),
    path,
    fs,
    pythonConfig: { pythonExe: '/fake/python', backendPath: '/fake/backend' },
    spawnTrackedPython: () => {
      probeSpawns += 1;
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          deviceAvailable: true,
          runtimeLoadable: false,
          missingLibraries: ['cublas64_12.dll'],
          runtime: 'ctranslate2',
          matchedProfile: '',
          installedProfile: '',
          unsupportedDetectedProfiles: [],
          supportedProfiles: ['cuda12'],
          recommendedInstallProfile: 'cuda12',
          statusCode: 'missingLibraries',
          error: '',
        })));
        proc.emit('close', 0);
      });
      return proc;
    },
    getBackendModuleArgs: (_module, args) => args || [],
    appendSpawnLogBuffer: (buf, data) => `${buf}${data}`,
    sendRedactedProgress: () => {},
    flushRedactedProgress: () => {},
    getActivePythonVersion: async () => ({ output: 'Python 3.11.9', parsed: { version: '3.11.9' } }),
    terminateProcessBestEffort: () => {},
    assertTrustedRendererSender: () => {},
    getDiarizationDependencySitePackagesPath: () => null,
  });

  // Seed an expired-looking cache by writing then invalidating age via direct update
  // with an old checkedAt — getCachedCudaStatus would return null, but resolve must re-probe.
  service.updateCachedCudaStatus({
    installed: true,
    deviceAvailable: true,
    runtimeLoadable: true,
    missingLibraries: [],
    statusCode: 'ready',
  });
  // Force TTL expiry
  const cached = service.getCachedCudaStatus();
  assert.ok(cached);
  // Manually age the cache by re-writing through update then monkeypatching checkedAt
  // is not exposed; instead invalidate so UI cache is null and resolve must probe.
  service.invalidateCachedCudaStatus();
  assert.equal(service.getCachedCudaStatus(), null);

  if (process.platform !== 'win32') {
    const status = await service.resolveCudaStatusForTranscription();
    assert.equal(status, null);
    assert.equal(probeSpawns, 0);
    return;
  }

  const status = await service.resolveCudaStatusForTranscription();
  assert.equal(probeSpawns, 1);
  assert.equal(status.deviceAvailable, true);
  assert.equal(status.runtimeLoadable, false);
  assert.equal(status.statusCode, 'missingLibraries');
});
