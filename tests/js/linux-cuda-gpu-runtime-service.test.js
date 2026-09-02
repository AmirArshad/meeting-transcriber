'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const { createGpuRuntimeService } = require('../../src/main/gpu-runtime-service');
const { getManagedLinuxCudaRuntimeTarget } = require('../../src/main-process/cuda-runtime-helpers');

function withProcess({ platform = process.platform, arch = process.arch }, fn) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  Object.defineProperty(process, 'arch', { configurable: true, value: arch });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      Object.defineProperty(process, 'platform', platformDescriptor);
      Object.defineProperty(process, 'arch', archDescriptor);
    });
}

function createFakeProcess({ stdoutText = '', exitCode = 0, emitError = null } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  queueMicrotask(() => {
    if (emitError) {
      proc.emit('error', emitError);
      return;
    }
    if (stdoutText) {
      proc.stdout.emit('data', Buffer.from(stdoutText));
    }
    proc.emit('close', exitCode);
  });
  return proc;
}

function readyProbeJson() {
  return JSON.stringify({
    deviceAvailable: true,
    runtimeLoadable: true,
    missingLibraries: [],
    runtime: 'ctranslate2',
    matchedProfile: 'cuda12',
    installedProfile: 'cuda12',
    unsupportedDetectedProfiles: [],
    supportedProfiles: ['cuda12'],
    recommendedInstallProfile: 'cuda12',
    statusCode: 'ready',
    error: '',
    deviceProbe: {
      driverVersion: '610.57.04',
      devices: [{ name: 'NVIDIA GeForce RTX 4070', driverVersion: '610.57.04', computeCapability: '8.9' }],
    },
  });
}

function makeFixtureCatalog(root) {
  const files = [
    { fileName: 'libcublas.so.12', relativePath: 'nvidia/cublas/lib/libcublas.so.12', body: 'cublas' },
    { fileName: 'libcublasLt.so.12', relativePath: 'nvidia/cublas/lib/libcublasLt.so.12', body: 'cublaslt' },
    { fileName: 'libcudnn.so.9', relativePath: 'nvidia/cudnn/lib/libcudnn.so.9', body: 'cudnn' },
  ];
  const requiredLibraries = files.map((file) => {
    const fullPath = path.join(root, ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.body);
    return {
      fileName: file.fileName,
      relativePath: file.relativePath,
      sha256: crypto.createHash('sha256').update(file.body).digest('hex'),
      sizeBytes: file.body.length,
    };
  });
  return {
    architecture: 'x64',
    platform: 'linux',
    wheels: [{
      id: 'fixture-cublas',
      packageName: 'nvidia-cublas-cu12',
      version: '12.9.2.10',
      fileName: 'fixture.whl',
      sha256: 'a'.repeat(64),
      sizeBytes: 4,
      downloadUrl: 'https://files.pythonhosted.org/packages/fixture.whl',
    }],
    requiredLibraries,
    unsupportedLibraryPrefixes: ['libcublas.so.13', 'libcublaslt.so.13'],
  };
}

function createLinuxGpuService(overrides = {}) {
  const userData = overrides.userData || fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-gpu-'));
  const catalog = overrides.catalog || makeFixtureCatalog(getManagedLinuxCudaRuntimeTarget(userData));
  const spawnCalls = [];
  const downloads = [];
  const renamed = [];
  const removed = [];
  const realFs = fs;
  const serviceFs = {
    ...realFs,
    existsSync: realFs.existsSync.bind(realFs),
    mkdirSync: realFs.mkdirSync.bind(realFs),
    lstatSync: realFs.lstatSync.bind(realFs),
    statSync: realFs.statSync.bind(realFs),
    readFileSync: realFs.readFileSync.bind(realFs),
    writeFileSync: realFs.writeFileSync.bind(realFs),
    createReadStream: realFs.createReadStream.bind(realFs),
    realpathSync: realFs.realpathSync.bind(realFs),
    accessSync: realFs.accessSync.bind(realFs),
    constants: realFs.constants,
    renameSync(from, to) {
      renamed.push({ from, to });
      return realFs.renameSync(from, to);
    },
    promises: {
      ...realFs.promises,
      rm(target, options) {
        removed.push(target);
        return realFs.promises.rm(target, options);
      },
    },
  };
  const service = createGpuRuntimeService({
    app: { getPath: () => userData },
    path,
    fs: serviceFs,
    pythonConfig: { pythonExe: '/fake/python', backendPath: '/fake/backend' },
    getBackendModuleArgs: (moduleName, extra = []) => ['-m', moduleName, ...extra],
    appendSpawnLogBuffer: (buffer, data) => `${buffer}${data}`,
    sendRedactedProgress: () => {},
    flushRedactedProgress: () => {},
    getActivePythonVersion: async () => ({
      output: 'Python 3.11.9',
      parsed: { version: '3.11.9', major: 3, minor: 11 },
    }),
    terminateProcessBestEffort: () => {},
    assertTrustedRendererSender: () => {},
    getDiarizationDependencySitePackagesPath: () => null,
    enqueueGpuResourceAction: async (action) => action(),
    isLinuxCudaProfileEnabled: () => true,
    getLinuxCudaCatalog: () => catalog,
    downloadLinuxCudaWheel: async ({ url, destinationPath, expectedSizeBytes }) => {
      downloads.push({ url, destinationPath, expectedSizeBytes });
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, 'whl');
    },
    ...overrides,
    app: (overrides.app) || { getPath: () => userData },
    fs: serviceFs,
    getLinuxCudaCatalog: overrides.getLinuxCudaCatalog || (() => catalog),
    spawnTrackedPython: (args, options) => {
      spawnCalls.push({ args, env: options && options.env });
      if (typeof overrides.spawnTrackedPython === 'function') {
        return overrides.spawnTrackedPython(args, options);
      }
      return createFakeProcess({ stdoutText: readyProbeJson(), exitCode: 0 });
    },
  });
  return { service, userData, catalog, spawnCalls, downloads, renamed, removed, cleanup() {
    fs.rmSync(userData, { recursive: true, force: true });
  } };
}

test('Linux CUDA stays unsupported when the profile is disabled by default', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, spawnCalls, cleanup } = createLinuxGpuService({ isLinuxCudaProfileEnabled: () => false });
    try {
      const status = await service.checkCudaRuntimeStatus();
      assert.equal(status.statusCode, 'unsupportedPlatform');
      assert.equal(spawnCalls.length, 0);
    } finally {
      cleanup();
    }
  });
});

test('Linux arm64 is rejected even when the CUDA profile is enabled', async () => {
  await withProcess({ platform: 'linux', arch: 'arm64' }, async () => {
    const { service, spawnCalls, cleanup } = createLinuxGpuService();
    try {
      const status = await service.checkCudaRuntimeStatus();
      assert.equal(status.statusCode, 'unsupportedPlatform');
      assert.equal(spawnCalls.length, 0);
    } finally {
      cleanup();
    }
  });
});

test('Linux CUDA probe reports ready after integrity and a successful child', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const previousLibraryPath = process.env.LD_LIBRARY_PATH;
    process.env.LD_LIBRARY_PATH = '/tmp/hostile:/lib';
    const { service, spawnCalls, cleanup } = createLinuxGpuService();
    try {
      const status = await service.checkCudaRuntimeStatus();
      assert.equal(status.statusCode, 'ready');
      assert.equal(status.installed, true);
      assert.ok(spawnCalls[0].args.includes('--validate-ctranslate2-cuda'));
      assert.ok(spawnCalls[0].args.includes('--library-search-dirs-json'));
      assert.equal(String(spawnCalls[0].env && spawnCalls[0].env.LD_LIBRARY_PATH || '').includes('/tmp/hostile'), false);
    } finally {
      if (previousLibraryPath === undefined) {
        delete process.env.LD_LIBRARY_PATH;
      } else {
        process.env.LD_LIBRARY_PATH = previousLibraryPath;
      }
      cleanup();
    }
  });
});

test('Linux CUDA loader env ignores inherited hostile LD_LIBRARY_PATH', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, userData, cleanup } = createLinuxGpuService();
    try {
      const env = service.buildCudaRuntimeEnv({ LD_LIBRARY_PATH: '/tmp/hostile:/lib' });
      const managed = getManagedLinuxCudaRuntimeTarget(userData);
      assert.ok(String(env.LD_LIBRARY_PATH).startsWith(path.join(managed, 'nvidia')));
      assert.doesNotMatch(String(env.LD_LIBRARY_PATH), /\/tmp\/hostile/);
    } finally {
      cleanup();
    }
  });
});

test('Linux CUDA probe surfaces non-ready integrity statuses without spawning', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const cases = [
      ['missingLibraries', { ok: false, statusCode: 'missingLibraries', missingLibraries: ['libcublas.so.12'], error: 'missing' }],
      ['runtimeIntegrityFailed', { ok: false, statusCode: 'runtimeIntegrityFailed', missingLibraries: [], error: 'hash mismatch' }],
    ];
    for (const [statusCode, integrity] of cases) {
      const { service, spawnCalls, cleanup } = createLinuxGpuService({
        verifyLinuxCudaIntegrity: async () => integrity,
      });
      try {
        const status = await service.checkCudaRuntimeStatus();
        assert.equal(status.statusCode, statusCode);
        assert.equal(status.installed, false);
        assert.equal(spawnCalls.length, 0);
      } finally {
        cleanup();
      }
    }
  });
});

test('Linux CUDA probe preserves backend status codes from valid JSON', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    for (const statusCode of ['deviceUnavailable', 'unsupportedRuntimeMajor', 'runtimeUnavailable', 'probeError']) {
      const payload = {
        deviceAvailable: statusCode !== 'deviceUnavailable' && statusCode !== 'probeError',
        runtimeLoadable: false,
        missingLibraries: [],
        runtime: 'ctranslate2',
        matchedProfile: '',
        installedProfile: statusCode === 'unsupportedRuntimeMajor' ? 'cuda13' : '',
        unsupportedDetectedProfiles: statusCode === 'unsupportedRuntimeMajor' ? ['cuda13'] : [],
        supportedProfiles: ['cuda12'],
        recommendedInstallProfile: 'cuda12',
        statusCode,
        error: statusCode,
      };
      const { service, cleanup } = createLinuxGpuService({
        spawnTrackedPython: () => createFakeProcess({ stdoutText: JSON.stringify(payload), exitCode: 0 }),
      });
      try {
        const status = await service.checkCudaRuntimeStatus();
        assert.equal(status.statusCode, statusCode, statusCode);
        assert.equal(status.installed, false);
      } finally {
        cleanup();
      }
    }
  });
});

test('Linux CUDA probe treats a nonzero child exit as probeError', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, cleanup } = createLinuxGpuService({
      spawnTrackedPython: () => createFakeProcess({ stdoutText: readyProbeJson(), exitCode: 1 }),
    });
    try {
      const status = await service.checkCudaRuntimeStatus();
      assert.equal(status.statusCode, 'probeError');
      assert.match(status.error, /exited with code 1/);
    } finally {
      cleanup();
    }
  });
});

test('Linux CUDA probe treats invalid child JSON as probeError', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, cleanup } = createLinuxGpuService({
      spawnTrackedPython: () => createFakeProcess({ stdoutText: '{nope', exitCode: 0 }),
    });
    try {
      const status = await service.checkCudaRuntimeStatus();
      assert.equal(status.statusCode, 'probeError');
    } finally {
      cleanup();
    }
  });
});

test('Linux CUDA hash mismatch fails closed before the probe child', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, catalog, spawnCalls, userData, cleanup } = createLinuxGpuService();
    try {
      const libraryPath = path.join(getManagedLinuxCudaRuntimeTarget(userData), catalog.requiredLibraries[0].relativePath);
      const original = fs.readFileSync(libraryPath);
      fs.writeFileSync(libraryPath, Buffer.alloc(original.length, 0x41));
      const status = await service.checkCudaRuntimeStatus();
      assert.equal(status.statusCode, 'runtimeIntegrityFailed');
      assert.match(status.error, /hash mismatch/);
      assert.equal(spawnCalls.length, 0);
    } finally {
      cleanup();
    }
  });
});

test('Linux CUDA symlink library escape is not treated as ready', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, catalog, spawnCalls, userData, cleanup } = createLinuxGpuService();
    try {
      const libraryPath = path.join(getManagedLinuxCudaRuntimeTarget(userData), catalog.requiredLibraries[0].relativePath);
      const outside = path.join(os.tmpdir(), `avanevis-linux-cuda-escape-${process.pid}`);
      fs.writeFileSync(outside, 'outside');
      fs.rmSync(libraryPath);
      fs.symlinkSync(outside, libraryPath);
      const status = await service.checkCudaRuntimeStatus();
      assert.notEqual(status.statusCode, 'ready');
      assert.equal(status.installed, false);
      assert.equal(spawnCalls.length, 0);
      fs.rmSync(outside, { force: true });
    } finally {
      cleanup();
    }
  });
});

test('Linux CUDA uninstall tombstones the active path then deletes only the tombstone', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, userData, renamed, removed, cleanup } = createLinuxGpuService();
    try {
      const handlers = {};
      service.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });
      const active = getManagedLinuxCudaRuntimeTarget(userData);
      assert.equal(fs.existsSync(active), true);
      const result = await handlers['uninstall-gpu']({ sender: {} });
      assert.equal(result.success, true);
      assert.equal(renamed.length, 1);
      assert.equal(renamed[0].from, active);
      assert.match(renamed[0].to, /\.tombstone-/);
      assert.deepEqual(removed, [renamed[0].to]);
      assert.equal(fs.existsSync(active), false);
    } finally {
      cleanup();
    }
  });
});

test('Linux CUDA uninstall rejects quit before touching the active runtime', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, userData, renamed, removed, cleanup } = createLinuxGpuService({
      isQuitCommitted: () => true,
    });
    try {
      const handlers = {};
      service.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });
      await assert.rejects(
        handlers['uninstall-gpu']({ sender: {} }),
        (error) => error && error.code === 'QUIT_IN_PROGRESS',
      );
      assert.equal(renamed.length, 0);
      assert.equal(removed.length, 0);
      assert.equal(fs.existsSync(getManagedLinuxCudaRuntimeTarget(userData)), true);
    } finally {
      cleanup();
    }
  });
});

test('Linux CUDA install downloads the pinned wheel closure and never uses unpinned pip names', async () => {
  await withProcess({ platform: 'linux', arch: 'x64' }, async () => {
    const { service, spawnCalls, downloads, catalog, cleanup } = createLinuxGpuService({
      verifyLinuxCudaIntegrity: async () => ({ ok: true, statusCode: 'ready', missingLibraries: [] }),
    });
    try {
      const body = Buffer.from('whl');
      catalog.wheels[0].sha256 = crypto.createHash('sha256').update(body).digest('hex');
      catalog.wheels[0].sizeBytes = body.length;
      await service.runGpuPackageInstall({ mode: 'install' });
      assert.equal(downloads.length, 1);
      assert.equal(downloads[0].url, catalog.wheels[0].downloadUrl);
      const pipArgs = spawnCalls.find((call) => call.args.includes('--no-index'));
      assert.ok(pipArgs, 'expected offline pip install');
      assert.ok(pipArgs.args.includes('--no-index'));
      assert.ok(pipArgs.args.includes('nvidia-cublas-cu12==12.9.2.10'));
      assert.equal(pipArgs.args.includes('nvidia-cublas-cu12'), false);
    } finally {
      cleanup();
    }
  });
});
