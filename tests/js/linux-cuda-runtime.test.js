'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  LINUX_CUDA12_RUNTIME_CATALOG,
  assertLinuxCudaCatalogIntegrity,
  getLinuxCuda12RuntimeCatalog,
  getLinuxCudaDriverLibraryAllowlist,
  getLinuxCudaProbeLibraryFileNames,
  getLinuxCudaRequiredLibraries,
  getLinuxCudaWheelPins,
} = require('../../src/main-process/linux-cuda-runtime-catalog');
const { comparableFsPath, comparableLinuxLibraryPathParts } = require('./comparable-fs-path');
const {
  buildContainedLinuxCudaLibraryPath,
  buildLinuxCudaOfflineInstallArgs,
  collectUnexpectedLinuxCudaLoaderFiles,
  detectUnsupportedLinuxCudaMajor,
  getLinuxCudaRuntimeStagingPath,
  getLinuxCudaTombstonePath,
  getLinuxCudaWheelStagePath,
  getLinuxCudaWheelhousePath,
  isLinuxCudaStatusReadyForAdmission,
  parseLinuxCheckCudaStatus,
  resolveLinuxCudaDriverLibraryDirs,
  stageVerifiedLinuxCudaWheels,
  stageVerifiedLinuxCudaWheelsInWorker,
  swapLinuxCudaRuntimeAtomically,
  verifyDownloadedLinuxCudaWheel,
  verifyDownloadedLinuxCudaWheelInWorker,
  HASH_READ_CHUNK_BYTES,
  hashFileSha256,
  hashFileSha256Sync,
  verifyLinuxCudaRuntimeIntegrity,
  isAcceptedLinuxCudaProfileHost,
  isLinuxCudaOffered,
  detectLinuxNvidiaGpu,
  hasLinuxNvidiaGpu,
  managedLinuxCudaRuntimeExists,
  parseOsReleaseId,
} = require('../../src/main-process/linux-cuda-runtime-helpers');

function makeRuntimeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-rt-'));
  const cublas = path.join(root, 'nvidia', 'cublas', 'lib');
  const cudnn = path.join(root, 'nvidia', 'cudnn', 'lib');
  fs.mkdirSync(cublas, { recursive: true });
  fs.mkdirSync(cudnn, { recursive: true });
  return { root, cublas, cudnn };
}

test('Linux CUDA catalog is a complete linux-x64 pin set', () => {
  const catalog = assertLinuxCudaCatalogIntegrity(getLinuxCuda12RuntimeCatalog());
  assert.equal(catalog.architecture, 'x64');
  assert.equal(catalog.platform, 'linux');
  assert.equal(LINUX_CUDA12_RUNTIME_CATALOG.cudaMajor, 12);
  const wheels = getLinuxCudaWheelPins();
  assert.equal(wheels.length, 2);
  for (const wheel of wheels) {
    assert.match(wheel.downloadUrl, /^https:\/\/files\.pythonhosted\.org\//);
    assert.match(wheel.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number(wheel.sizeBytes) > 0);
    assert.ok(wheel.fileName.endsWith('.whl'));
  }
  assert.deepEqual(getLinuxCudaProbeLibraryFileNames(), [
    'libcublas.so.12',
    'libcublasLt.so.12',
    'libcudnn.so.9',
  ]);
  assert.ok(getLinuxCudaRequiredLibraries().length >= 3);
  assert.deepEqual(getLinuxCudaDriverLibraryAllowlist(), [
    '/usr/lib',
    '/usr/lib64',
    '/usr/lib/x86_64-linux-gnu',
  ]);
});

test('contained Linux CUDA loader rejects empty, relative, duplicate, and escaped directories', () => {
  const { root, cublas, cudnn } = makeRuntimeTree();
  assert.deepEqual(
    comparableLinuxLibraryPathParts(buildContainedLinuxCudaLibraryPath({
      managedRoot: root,
      libraryDirs: [cublas, cudnn],
    })),
    [cublas, cudnn].map(comparableFsPath),
  );
  assert.throws(
    () => buildContainedLinuxCudaLibraryPath({ managedRoot: root, libraryDirs: [] }),
    /must not be empty/,
  );
  assert.throws(
    () => buildContainedLinuxCudaLibraryPath({
      managedRoot: root,
      libraryDirs: ['nvidia/cublas/lib'],
    }),
    /absolute/,
  );
  assert.throws(
    () => buildContainedLinuxCudaLibraryPath({
      managedRoot: root,
      libraryDirs: [cublas, cublas],
    }),
    /duplicate/,
  );
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-escape-'));
  try {
    assert.throws(
      () => buildContainedLinuxCudaLibraryPath({
        managedRoot: root,
        libraryDirs: [outside],
      }),
      /escapes the managed CUDA runtime root/,
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('contained Linux CUDA loader rejects a symlink library directory escape', () => {
  const { root, cublas, cudnn } = makeRuntimeTree();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-out-'));
  const escape = path.join(root, 'nvidia', 'cublas', 'lib-link');
  fs.symlinkSync(outside, escape);
  assert.throws(
    () => buildContainedLinuxCudaLibraryPath({
      managedRoot: root,
      libraryDirs: [escape, cudnn],
    }),
    /symbolic link/,
  );
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('Linux CUDA integrity full-hashes required libraries and reports hash mismatch', async () => {
  const { root, cublas, cudnn } = makeRuntimeTree();
  const good = Buffer.from('good-library');
  const catalog = {
    architecture: 'x64',
    platform: 'linux',
    wheels: [{
      id: 'fixture',
      packageName: 'fixture',
      version: '1',
      fileName: 'fixture.whl',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      downloadUrl: 'https://files.pythonhosted.org/packages/fixture.whl',
    }],
    requiredLibraries: [{
      fileName: 'libcublas.so.12',
      relativePath: 'nvidia/cublas/lib/libcublas.so.12',
      sha256: crypto.createHash('sha256').update(good).digest('hex'),
      sizeBytes: good.length,
    }],
  };
  fs.writeFileSync(path.join(cublas, 'libcublas.so.12'), good);
  const ok = await verifyLinuxCudaRuntimeIntegrity({ managedRoot: root, catalog, fsModule: fs });
  assert.equal(ok.ok, true);

  fs.writeFileSync(path.join(cublas, 'libcublas.so.12'), Buffer.alloc(good.length, 0x78));
  const failed = await verifyLinuxCudaRuntimeIntegrity({ managedRoot: root, catalog, fsModule: fs });
  assert.equal(failed.ok, false);
  assert.equal(failed.statusCode, 'runtimeIntegrityFailed');
  assert.match(failed.error, /hash mismatch/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Linux CUDA wheel verification rejects size and hash mismatches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-whl-'));
  const filePath = path.join(dir, 'wheel.whl');
  const body = Buffer.from('wheel-bytes');
  fs.writeFileSync(filePath, body);
  const wheel = {
    fileName: 'wheel.whl',
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    sizeBytes: body.length,
  };
  assert.equal(verifyDownloadedLinuxCudaWheel(filePath, wheel, fs), true);
  assert.throws(
    () => verifyDownloadedLinuxCudaWheel(filePath, { ...wheel, sizeBytes: 1 }, fs),
    /size mismatch/,
  );
  assert.throws(
    () => verifyDownloadedLinuxCudaWheel(filePath, { ...wheel, sha256: 'b'.repeat(64) }, fs),
    /hash mismatch/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CUDA wheel hashing uses bounded reads instead of a whole-file slurp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-hash-'));
  const filePath = path.join(dir, 'large.whl');
  const size = HASH_READ_CHUNK_BYTES * 2 + 4096;
  fs.writeFileSync(filePath, Buffer.alloc(size, 0x61));
  let slurped = false;
  const spyFs = {
    ...fs,
    readFileSync(...args) {
      if (String(args[0]) === filePath) {
        slurped = true;
      }
      return fs.readFileSync(...args);
    },
  };
  const digest = hashFileSha256Sync(filePath, spyFs);
  assert.equal(slurped, false);
  assert.equal(digest, crypto.createHash('sha256').update(Buffer.alloc(size, 0x61)).digest('hex'));
  const wheel = {
    fileName: 'large.whl',
    sha256: digest,
    sizeBytes: size,
  };
  assert.equal(verifyDownloadedLinuxCudaWheel(filePath, wheel, spyFs), true);
  assert.equal(slurped, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CUDA hashing waits for stream close so Windows can rename the parent directory', async () => {
  const body = Buffer.from('libcublas');
  const expected = crypto.createHash('sha256').update(body).digest('hex');
  const stream = new EventEmitter();
  stream.destroy = () => {};
  let resolved = false;
  const promise = hashFileSha256('/managed/nvidia/cublas/lib/libcublas.so.12', {
    createReadStream: () => stream,
  }).then((digest) => {
    resolved = true;
    return digest;
  });
  stream.emit('data', body);
  stream.emit('end');
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
  assert.equal(resolved, false, 'must not resolve on end while the file handle is still open');
  stream.emit('close');
  assert.equal(await promise, expected);
});

test('CUDA wheel staging worker copies and re-hashes a multi-chunk file off the main thread', async () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-whsrc-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-whstg-'));
  const size = HASH_READ_CHUNK_BYTES + 2048;
  const body = Buffer.alloc(size, 0x62);
  const fileName = 'fixture-large.whl';
  fs.writeFileSync(path.join(source, fileName), body);
  const catalog = {
    architecture: 'x64',
    platform: 'linux',
    wheels: [{
      id: 'fixture',
      packageName: 'nvidia-cublas-cu12',
      version: '1',
      fileName,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      sizeBytes: size,
      downloadUrl: 'https://files.pythonhosted.org/packages/fixture-large.whl',
    }],
    requiredLibraries: [{
      fileName: 'libcublas.so.12',
      relativePath: 'nvidia/cublas/lib/libcublas.so.12',
      sha256: 'b'.repeat(64),
      sizeBytes: 1,
    }],
  };
  const staged = await stageVerifiedLinuxCudaWheelsInWorker({
    sourceDir: source,
    stagingDir: staging,
    catalog,
  });
  assert.deepEqual(staged, [path.join(staging, fileName)]);
  assert.equal(verifyDownloadedLinuxCudaWheel(path.join(staging, fileName), catalog.wheels[0], fs), true);
  await verifyDownloadedLinuxCudaWheelInWorker(path.join(source, fileName), catalog.wheels[0]);
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test('Linux CUDA offline install args pass exact verified wheel paths, not package names', () => {
  const wheelPaths = [
    '/tmp/avanevis/ai-addons/cuda/wheel-stage/nvidia_cublas_cu12-12.9.2.10-py3-none-manylinux_2_27_x86_64.whl',
    '/tmp/avanevis/ai-addons/cuda/wheel-stage/nvidia_cudnn_cu12-9.22.0.52-py3-none-manylinux_2_27_x86_64.whl',
  ];
  const args = buildLinuxCudaOfflineInstallArgs({
    wheelPaths,
    target: '/tmp/avanevis/ai-addons/cuda/python.staging-1',
  });
  assert.ok(args.includes('--no-index'));
  assert.ok(args.includes('--target'));
  assert.ok(args.includes('--no-cache-dir'));
  assert.equal(args.includes('--find-links'), false);
  assert.equal(args.some((item) => String(item).startsWith('nvidia-cublas-cu12')), false);
  assert.equal(args.some((item) => String(item).startsWith('nvidia-cudnn-cu12')), false);
  assert.ok(wheelPaths.every((wheelPath) => args.includes(wheelPath)));
});

test('Linux CUDA tombstone path is beside the active runtime, not inside it', () => {
  const active = '/home/alice/.config/AvaNevis/ai-addons/cuda/python';
  const tombstone = getLinuxCudaTombstonePath(active, { now: 42, pid: 7 });
  assert.equal(tombstone, `${active}.tombstone-42-7`);
  assert.equal(getLinuxCudaRuntimeStagingPath(active, { now: 42, pid: 7 }), `${active}.staging-42-7`);
  assert.equal(getLinuxCudaWheelhousePath('/home/alice/.config/AvaNevis'),
    '/home/alice/.config/AvaNevis/ai-addons/cuda/wheelhouse');
  assert.equal(
    getLinuxCudaWheelStagePath('/home/alice/.config/AvaNevis', { now: 42, pid: 7 }),
    '/home/alice/.config/AvaNevis/ai-addons/cuda/wheel-stage-42-7',
  );
});

test('unsupported CUDA major is detected only from managed library directories', () => {
  const { root, cublas } = makeRuntimeTree();
  fs.writeFileSync(path.join(cublas, 'libcublas.so.13'), 'x');
  assert.deepEqual(detectUnsupportedLinuxCudaMajor({ libraryDirs: [cublas] }), ['cuda13']);
  assert.deepEqual(detectUnsupportedLinuxCudaMajor({ libraryDirs: [root] }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('driver allowlist rejects a writable directory even when the basename matches', () => {
  const writable = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-drv-'));
  assert.throws(
    () => resolveLinuxCudaDriverLibraryDirs({
      fsModule: fs,
      allowlist: [writable],
    }),
    /writable CUDA driver library directory/,
  );
  fs.rmSync(writable, { recursive: true, force: true });
});

test('Linux CUDA integrity rejects an unexpected shared library in a loader directory', async () => {
  const { root, cublas } = makeRuntimeTree();
  const good = Buffer.from('good-library');
  const catalog = {
    architecture: 'x64',
    platform: 'linux',
    libraryRelativeDirs: ['nvidia/cublas/lib'],
    wheels: [{
      id: 'fixture',
      packageName: 'fixture',
      version: '1',
      fileName: 'fixture.whl',
      sha256: 'a'.repeat(64),
      sizeBytes: 1,
      downloadUrl: 'https://files.pythonhosted.org/packages/fixture.whl',
    }],
    requiredLibraries: [{
      fileName: 'libcublas.so.12',
      relativePath: 'nvidia/cublas/lib/libcublas.so.12',
      sha256: crypto.createHash('sha256').update(good).digest('hex'),
      sizeBytes: good.length,
    }],
  };
  fs.writeFileSync(path.join(cublas, 'libcublas.so.12'), good);
  fs.writeFileSync(path.join(cublas, 'libhostile.so.12'), 'hostile');
  const unexpected = collectUnexpectedLinuxCudaLoaderFiles({
    managedRoot: root,
    catalog,
    fsModule: fs,
  });
  assert.deepEqual(unexpected, ['nvidia/cublas/lib/libhostile.so.12']);
  const failed = await verifyLinuxCudaRuntimeIntegrity({ managedRoot: root, catalog, fsModule: fs });
  assert.equal(failed.ok, false);
  assert.equal(failed.statusCode, 'runtimeIntegrityFailed');
  assert.match(failed.error, /libhostile\.so\.12/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Linux CUDA wheel staging copies only catalog names and re-hashes the copies', () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-whsrc-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-whstg-'));
  const body = Buffer.from('pinned-wheel');
  const extra = Buffer.from('unverified-extra-wheel');
  const catalog = {
    architecture: 'x64',
    platform: 'linux',
    wheels: [{
      id: 'fixture',
      packageName: 'nvidia-cublas-cu12',
      version: '1',
      fileName: 'fixture.whl',
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      sizeBytes: body.length,
      downloadUrl: 'https://files.pythonhosted.org/packages/fixture.whl',
    }],
    requiredLibraries: [{
      fileName: 'libcublas.so.12',
      relativePath: 'nvidia/cublas/lib/libcublas.so.12',
      sha256: 'b'.repeat(64),
      sizeBytes: 1,
    }],
  };
  fs.writeFileSync(path.join(source, 'fixture.whl'), body);
  fs.writeFileSync(path.join(source, 'nvidia_cublas_cu12-1-py3-none-any.whl'), extra);
  const staged = stageVerifiedLinuxCudaWheels({
    sourceDir: source,
    stagingDir: staging,
    catalog,
    fsModule: fs,
  });
  assert.deepEqual(staged, [path.join(staging, 'fixture.whl')]);
  assert.equal(fs.existsSync(path.join(staging, 'nvidia_cublas_cu12-1-py3-none-any.whl')), false);
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test('Linux CUDA runtime swap tombstones the active path then promotes staging', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-swap-'));
  const active = path.join(parent, 'python');
  const staging = path.join(parent, 'python.staging-1');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(active, 'old.txt'), 'old');
  fs.writeFileSync(path.join(staging, 'new.txt'), 'new');
  const result = swapLinuxCudaRuntimeAtomically({
    activePath: active,
    stagingPath: staging,
    fsModule: fs,
    now: 9,
    pid: 3,
  });
  assert.equal(fs.existsSync(path.join(active, 'new.txt')), true);
  assert.equal(fs.existsSync(path.join(active, 'old.txt')), false);
  assert.equal(fs.existsSync(path.join(result.tombstonePath, 'old.txt')), true);
  assert.equal(result.renamedActive, true);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('Linux CUDA runtime swap retries a transient EPERM rename before promotion', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-swap-retry-'));
  const active = path.join(parent, 'python');
  const staging = path.join(parent, 'python.staging-1');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(active, 'old.txt'), 'old');
  fs.writeFileSync(path.join(staging, 'new.txt'), 'new');
  let stagingPromoteAttempts = 0;
  const fsModule = {
    ...fs,
    existsSync: fs.existsSync.bind(fs),
    renameSync(from, to) {
      if (path.resolve(from) === path.resolve(staging) && path.resolve(to) === path.resolve(active)) {
        stagingPromoteAttempts += 1;
        if (stagingPromoteAttempts === 1) {
          const error = new Error('simulated transient directory lock');
          error.code = 'EPERM';
          throw error;
        }
      }
      return fs.renameSync(from, to);
    },
  };
  const result = swapLinuxCudaRuntimeAtomically({
    activePath: active,
    stagingPath: staging,
    fsModule,
    now: 9,
    pid: 3,
  });
  assert.equal(stagingPromoteAttempts, 2);
  assert.equal(fs.existsSync(path.join(active, 'new.txt')), true);
  assert.equal(result.renamedActive, true);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('Linux CUDA probe parser requires a single JSON object and ready invariants', () => {
  assert.equal(parseLinuxCheckCudaStatus('').statusCode, 'probeError');
  assert.equal(parseLinuxCheckCudaStatus('not json').statusCode, 'probeError');
  assert.equal(parseLinuxCheckCudaStatus('{"statusCode":"ready"}').statusCode, 'probeError');
  assert.equal(parseLinuxCheckCudaStatus(JSON.stringify({
    statusCode: 'ready',
    deviceAvailable: true,
    runtimeLoadable: false,
    missingLibraries: [],
    matchedProfile: 'cuda12',
  })).statusCode, 'probeError');

  const ready = parseLinuxCheckCudaStatus(JSON.stringify({
    statusCode: 'ready',
    deviceAvailable: true,
    runtimeLoadable: true,
    missingLibraries: [],
    runtime: 'ctranslate2',
    matchedProfile: 'cuda12',
    installedProfile: 'cuda12',
    unsupportedDetectedProfiles: [],
    supportedProfiles: ['cuda12'],
    recommendedInstallProfile: 'cuda12',
    error: '',
  }));
  assert.equal(ready.statusCode, 'ready');
  assert.equal(ready.installed, true);
  assert.equal(isLinuxCudaStatusReadyForAdmission(ready), true);
  assert.equal(isLinuxCudaStatusReadyForAdmission({ statusCode: 'ready' }), false);
});

test('Linux CUDA offer is NVIDIA-visible on any linux x64 distro, not CachyOS/4070-only', () => {
  const nvidia = {
    platform: 'linux',
    arch: 'x64',
    gpuName: 'NVIDIA GeForce RTX 3060',
  };
  assert.equal(isLinuxCudaOffered({ ...nvidia, osReleaseText: 'ID=ubuntu\n' }), true);
  assert.equal(isLinuxCudaOffered({ ...nvidia, gpuName: 'NVIDIA GeForce RTX 4070 Ti' }), true);
  assert.equal(isLinuxCudaOffered({
    platform: 'linux',
    arch: 'x64',
    osReleaseText: 'ID=omarchy\n',
    gpuName: 'NVIDIA GeForce RTX 4070',
  }), true);
  assert.equal(isLinuxCudaOffered({
    platform: 'linux',
    arch: 'x64',
    gpuNames: [],
    gpuName: '',
  }), false);
  assert.equal(hasLinuxNvidiaGpu({ gpuName: 'NVIDIA GeForce RTX 4090' }), true);
  assert.equal(hasLinuxNvidiaGpu({ gpuNames: [] }), false);
  assert.equal(isLinuxCudaOffered({ ...nvidia, arch: 'arm64' }), false);
  const procOnly = detectLinuxNvidiaGpu({
    fsModule: {
      readdirSync: () => ['0000:01:00.0'],
      readFileSync: () => 'Model: \t\t NVIDIA GeForce RTX 3060\nIRQ: 77\n',
    },
    execFileSyncFn: () => { throw new Error('nvidia-smi missing'); },
  });
  assert.equal(procOnly.hasGPU, true);
  assert.match(procOnly.gpuName, /RTX 3060/);
  assert.equal(isLinuxCudaOffered({
    platform: 'linux',
    arch: 'x64',
    fsModule: {
      readdirSync: () => ['0000:01:00.0'],
      readFileSync: () => 'Model: \t\t NVIDIA GeForce RTX 3060\nIRQ: 77\n',
    },
    execFileSyncFn: () => { throw new Error('nvidia-smi missing'); },
  }), true);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-cuda-offer-'));
  try {
    const managedRoot = path.join(userData, 'ai-addons', 'cuda', 'python');
    assert.equal(managedLinuxCudaRuntimeExists(userData), false);
    fs.mkdirSync(managedRoot, { recursive: true });
    assert.equal(managedLinuxCudaRuntimeExists(userData), true);
    assert.equal(isLinuxCudaOffered({
      platform: 'linux',
      arch: 'x64',
      userDataPath: userData,
      gpuNames: [],
    }), true);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('Linux CUDA tested-host record remains CachyOS x86_64 + exact RTX 4070', () => {
  const accepted = {
    platform: 'linux',
    arch: 'x64',
    osReleaseText: 'NAME="CachyOS Linux"\nID=cachyos\n',
    gpuName: 'NVIDIA GeForce RTX 4070',
  };
  assert.equal(isAcceptedLinuxCudaProfileHost(accepted), true);
  assert.equal(isAcceptedLinuxCudaProfileHost({
    ...accepted,
    osReleaseText: 'ID="cachyos"\n',
  }), true);
  assert.equal(parseOsReleaseId('ID="cachyos"\n'), 'cachyos');

  assert.equal(isAcceptedLinuxCudaProfileHost({ ...accepted, gpuName: 'NVIDIA GeForce RTX 4070 Ti' }), false);
  assert.equal(isAcceptedLinuxCudaProfileHost({ ...accepted, gpuName: 'NVIDIA GeForce RTX 4070 Super' }), false);
  assert.equal(isAcceptedLinuxCudaProfileHost({
    ...accepted,
    osReleaseText: 'ID=omarchy\n',
  }), false);
  assert.equal(isAcceptedLinuxCudaProfileHost({
    ...accepted,
    osReleaseText: 'ID=ubuntu\n',
  }), false);
  assert.equal(isAcceptedLinuxCudaProfileHost({ ...accepted, arch: 'arm64' }), false);
  assert.equal(isAcceptedLinuxCudaProfileHost({ ...accepted, platform: 'win32' }), false);
  assert.equal(isAcceptedLinuxCudaProfileHost({
    ...accepted,
    gpuNames: [],
  }), false);
  const missingFs = {
    readdirSync() { throw new Error('no proc nvidia'); },
    readFileSync() { throw new Error('no proc nvidia'); },
  };
  assert.equal(isAcceptedLinuxCudaProfileHost({
    ...accepted,
    gpuName: undefined,
    gpuNames: undefined,
    fsModule: missingFs,
    execFileSyncFn: () => { throw new Error('nvidia-smi missing'); },
  }), false);
  assert.equal(isAcceptedLinuxCudaProfileHost({
    ...accepted,
    gpuName: undefined,
    gpuNames: undefined,
    fsModule: {
      readdirSync: () => ['0000:01:00.0'],
      readFileSync: () => 'Model: \t\t NVIDIA GeForce RTX 4070\nIRQ: 77\n',
    },
    execFileSyncFn: () => { throw new Error('nvidia-smi missing'); },
  }), true);
});
