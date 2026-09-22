'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../../src/main/transcription-engine-catalog');
const { LINUX_CUDA12_RUNTIME_CATALOG } = require('../../src/main-process/linux-cuda-runtime-catalog');

function cloneLock(adapterId) {
  return JSON.parse(JSON.stringify(catalog.loadLock(adapterId)));
}

test('shipped locks are complete closures with immutable revisions', () => {
  for (const adapterId of Object.values(catalog.ADAPTERS)) {
    const lock = catalog.loadLock(adapterId);
    assert.equal(catalog.assertParakeetLockIntegrity(lock), lock);
    assert.equal(lock.executionPrecision, 'float32');
    assert.equal(lock.model.id, catalog.PARAKEET_MODEL_ID);
    assert.ok(lock.wheels.every((wheel) => wheel.fileName.endsWith('.whl')));
    assert.ok(lock.wheels.every((wheel) => wheel.extractedFiles.length > 0));
  }
  assert.equal(catalog.loadLock(catalog.ADAPTERS.LINUX_CUDA).model.revision, catalog.ONNX_MODEL_REVISION);
  assert.equal(catalog.loadLock(catalog.ADAPTERS.MACOS_METAL).model.revision, catalog.MLX_MODEL_REVISION);
  assert.equal(catalog.loadLock(catalog.ADAPTERS.WINDOWS_CUDA).wheels.some((wheel) => wheel.packageName === 'pyreadline3'), true);
});

test('missing hashes, sdists, CUDA 13, and shared cuDNN are rejected', () => {
  const missing = cloneLock(catalog.ADAPTERS.LINUX_CUDA);
  delete missing.wheels[0].sha256;
  assert.throws(() => catalog.assertParakeetLockIntegrity(missing), /SHA-256/);

  const sdist = cloneLock(catalog.ADAPTERS.LINUX_CUDA);
  sdist.wheels[0].fileName = 'onnx_asr-0.12.0.tar.gz';
  assert.throws(() => catalog.assertParakeetLockIntegrity(sdist), /non-wheel/);

  const cuda13 = cloneLock(catalog.ADAPTERS.LINUX_CUDA);
  cuda13.wheels.push({
    ...cuda13.wheels[0],
    packageName: 'nvidia-cudnn-cu13',
    version: '9.99.0',
    fileName: 'nvidia_cudnn_cu13-9.99.0-py3-none-manylinux_2_27_x86_64.whl',
  });
  assert.throws(() => catalog.assertParakeetLockIntegrity(cuda13), /CUDA 13/);

  const whisperCudnn = LINUX_CUDA12_RUNTIME_CATALOG.wheels.find((wheel) => wheel.packageName === 'nvidia-cudnn-cu12');
  const shared = cloneLock(catalog.ADAPTERS.LINUX_CUDA);
  const cudnn = shared.wheels.find((wheel) => wheel.packageName === 'nvidia-cudnn-cu12');
  cudnn.version = '9.22.0.52';
  cudnn.sha256 = whisperCudnn.sha256;
  cudnn.fileName = whisperCudnn.fileName;
  cudnn.url = whisperCudnn.downloadUrl;
  assert.throws(() => catalog.assertParakeetLockIntegrity(shared), /cuDNN/);
  assert.notEqual(
    catalog.loadLock(catalog.ADAPTERS.LINUX_CUDA).wheels.find((wheel) => wheel.packageName === 'nvidia-cudnn-cu12').sha256,
    whisperCudnn.sha256,
  );
});
