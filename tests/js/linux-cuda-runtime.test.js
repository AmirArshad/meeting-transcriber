'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  LINUX_CUDA12_RUNTIME_CATALOG,
  assertLinuxCudaCatalogIntegrity,
  getLinuxCuda12RuntimeCatalog,
  getLinuxCudaDriverLibraryAllowlist,
  getLinuxCudaProbeLibraryFileNames,
  getLinuxCudaRequiredLibraries,
  getLinuxCudaWheelPins,
} = require('../../src/main-process/linux-cuda-runtime-catalog');
const {
  buildContainedLinuxCudaLibraryPath,
  buildLinuxCudaOfflineInstallArgs,
  detectUnsupportedLinuxCudaMajor,
  getLinuxCudaTombstonePath,
  getLinuxCudaWheelhousePath,
  resolveLinuxCudaDriverLibraryDirs,
  verifyDownloadedLinuxCudaWheel,
  verifyLinuxCudaRuntimeIntegrity,
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
  assert.equal(
    buildContainedLinuxCudaLibraryPath({
      managedRoot: root,
      libraryDirs: [cublas, cudnn],
    }),
    `${cublas}:${cudnn}`,
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
  assert.throws(
    () => buildContainedLinuxCudaLibraryPath({
      managedRoot: root,
      libraryDirs: ['/usr'],
    }),
    /escapes the managed CUDA runtime root/,
  );
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
  fs.writeFileSync(path.join(cudnn, 'libcudnn.so.9'), 'x');
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

test('Linux CUDA offline install args never use an unpinned pip package name', () => {
  const args = buildLinuxCudaOfflineInstallArgs({
    wheelhouse: '/tmp/avanevis/ai-addons/cuda/wheelhouse',
    target: '/tmp/avanevis/ai-addons/cuda/python',
  });
  assert.ok(args.includes('--no-index'));
  assert.ok(args.includes('--find-links'));
  assert.ok(args.includes('--target'));
  assert.ok(args.includes('nvidia-cublas-cu12==12.9.2.10'));
  assert.ok(args.includes('nvidia-cudnn-cu12==9.22.0.52'));
  assert.equal(args.includes('nvidia-cublas-cu12'), false);
});

test('Linux CUDA tombstone path is beside the active runtime, not inside it', () => {
  const active = '/home/alice/.config/AvaNevis/ai-addons/cuda/python';
  const tombstone = getLinuxCudaTombstonePath(active, { now: 42, pid: 7 });
  assert.equal(tombstone, `${active}.tombstone-42-7`);
  assert.equal(getLinuxCudaWheelhousePath('/home/alice/.config/AvaNevis'),
    '/home/alice/.config/AvaNevis/ai-addons/cuda/wheelhouse');
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
