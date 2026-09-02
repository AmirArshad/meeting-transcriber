const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PYANNOTE_DIARIZATION_MODEL_ID,
  SPEAKRS_DIARIZATION_MODEL_ID,
  SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES,
  SPEAKRS_MODEL_PACK_REVISION,
  SPEAKRS_MODEL_PACK_REVISION_SHORT,
  SPEAKRS_MODELS_REPO,
  SPEAKRS_ORT_RUNTIME_ARTIFACTS,
  assertSpeakrsLinuxRequiredDynamicLibraryClosure,
  buildSpeakrsSourceDownloadUrl,
  getSpeakrsRuntimeArtifacts,
  getSpeakrsSetupProgressCopy,
  getSpeakrsSourceFiles,
  getSpeakrsSourceTotalBytes,
  getSpeakrsExtractedRuntimeDllPins,
  getSpeakrsRequiredRuntimeLibraryNames,
  normalizeSpeakrsRelativePath,
  resolveContainedSpeakrsPath,
} = require('../../src/ai-addon/speakrs-pack-spec');
const {
  BINDING_REVISION,
  REQUIRED_MODEL_PACK_LEGAL_FILES,
  assertBindingPins,
  createPackArchive,
  selectPackFiles,
  stagePackFiles,
  stageLegalFiles,
  validateSourceTree,
} = require('../../scripts/build-speakrs-model-pack');

test('speakrs pack spec keeps the binding revision and source file counts', () => {
  assert.equal(SPEAKRS_MODELS_REPO, 'avencera/speakrs-models');
  assert.equal(SPEAKRS_MODEL_PACK_REVISION, '5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f');
  assert.equal(SPEAKRS_MODEL_PACK_REVISION_SHORT, '5d24ffe');
  assert.equal(BINDING_REVISION, SPEAKRS_MODEL_PACK_REVISION);
  assert.doesNotThrow(() => assertBindingPins());

  const cudaFiles = selectPackFiles('win32-x64');
  const linuxCudaFiles = selectPackFiles('linux-x64');
  const coremlFiles = selectPackFiles('darwin-arm64');
  assert.equal(cudaFiles.length, 19);
  assert.equal(linuxCudaFiles.length, 19);
  assert.deepEqual(linuxCudaFiles.map((file) => file.path), cudaFiles.map((file) => file.path));
  assert.equal(coremlFiles.length, 76);
  assert.equal(getSpeakrsSourceTotalBytes('win32-x64'), 230677218);
  assert.equal(getSpeakrsSourceTotalBytes('linux-x64'), 230677218);
  assert.equal(getSpeakrsSourceTotalBytes('darwin-arm64'), 419482724);
  assert.ok(cudaFiles.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(coremlFiles.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.ok(cudaFiles.some((file) => file.path === 'wespeaker-voxceleb-resnet34-tail.onnx'));
  assert.ok(coremlFiles.some((file) => file.path === 'wespeaker-chunk-emb-s12-w116.mlmodelc/weights/weight.bin'));
});

test('speakrs pack spec pins the official ORT 1.27.1 cuda12 archive and NVIDIA wheels', () => {
  const runtime = getSpeakrsRuntimeArtifacts('win32-x64');
  assert.equal(runtime.length, 3);
  assert.equal(runtime[0].fileName, 'onnxruntime-win-x64-gpu_cuda12-1.27.1.zip');
  assert.equal(runtime[0].sha256, '78d4de5ab262f79ac5dd59f08ff0d049b1cea605497f375f8df5ba1a52f26111');
  assert.equal(runtime[0].sizeBytes, 325895374);
  assert.equal(runtime[1].fileName, 'nvidia_cuda_runtime_cu12-12.9.79-py3-none-win_amd64.whl');
  assert.equal(runtime[1].sha256, '8e018af8fa02363876860388bd10ccb89eb9ab8fb0aa749aaf58430a9f7c4891');
  assert.equal(runtime[2].fileName, 'nvidia_cufft_cu12-11.4.1.4-py3-none-win_amd64.whl');
  assert.equal(runtime[2].sha256, '8e5bfaac795e93f80611f807d42844e8e27e340e0cde270dcb6c65386d795b80');
  assert.deepEqual(SPEAKRS_ORT_RUNTIME_ARTIFACTS['darwin-arm64'], []);
  const linuxRuntime = getSpeakrsRuntimeArtifacts('linux-x64');
  assert.equal(linuxRuntime.length, 5);
  assert.equal(linuxRuntime[0].fileName, 'onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz');
  assert.equal(linuxRuntime[0].sha256, '08b568bd69500c36606aff7c3896ee4fa7d3531719f6b00f43e6a34db41dc4bf');
  assert.equal(linuxRuntime[0].sizeBytes, 244763765);
  assert.equal(linuxRuntime[0].architecture, 'x64');
  assert.equal(linuxRuntime[0].cudaMajor, 12);
  assert.equal(linuxRuntime[0].dynamicLibraryDir, 'lib');
  assert.equal(
    linuxRuntime[0].extractedFiles['libonnxruntime.so.1.27.1'].sha256,
    '67eda041546eb01cf5606add5467d8bb7305b2aedb5cf37fdc6b055c7adfc094',
  );
  assert.equal(linuxRuntime[0].extractedFiles['libonnxruntime.so.1.27.1'].sizeBytes, 27000912);
  assert.equal(
    linuxRuntime[0].extractedFiles['libonnxruntime_providers_shared.so'].sha256,
    'c6a12593396095f5670160e284c35d1700b7708cf3037b7042e2a5200ccae772',
  );
  assert.equal(linuxRuntime[0].extractedFiles['libonnxruntime_providers_cuda.so'].sizeBytes, 373925672);
  assert.equal(linuxRuntime[1].fileName, 'nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl');
  assert.equal(linuxRuntime[1].extractedFiles['libcudart.so.12'].sha256, '256e6409e4f06f618e1fb53d4844a6b81cdded1013afa8ade40c22f99eb133b7');
  assert.equal(linuxRuntime[2].fileName, 'nvidia_cufft_cu12-11.4.1.4-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl');
  assert.equal(linuxRuntime[2].extractedFiles['libcufft.so.11'].sizeBytes, 291507928);
  assert.equal(linuxRuntime[3].fileName, 'nvidia_curand_cu12-10.3.10.19-py3-none-manylinux_2_27_x86_64.whl');
  assert.equal(linuxRuntime[3].extractedFiles['libcurand.so.10'].sha256, 'ab8c07338fa663c018b16df5b3f3878c84aaae98bda930e9e8bad340427b0faa');
  assert.equal(linuxRuntime[3].extractedFiles['libcurand.so.10'].sizeBytes, 166965432);
  assert.equal(linuxRuntime[4].fileName, 'nvidia_cuda_nvrtc_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl');
  assert.equal(linuxRuntime[4].extractedFiles['libnvrtc.so.12'].sha256, '7c67c6b51ea0e0279634cebd676ff7efda1674806444520c84430ad5c35fe625');
  assert.equal(linuxRuntime[4].extractedFiles['libnvrtc.so.12'].sizeBytes, 106244480);
  assert.ok(getSpeakrsExtractedRuntimeDllPins(linuxRuntime, 'linux-x64'));
  assert.deepEqual(
    getSpeakrsRequiredRuntimeLibraryNames('linux-x64'),
    [
      'libonnxruntime.so.1.27.1',
      'libonnxruntime_providers_shared.so',
      'libonnxruntime_providers_cuda.so',
      'libcudart.so.12',
      'libcufft.so.11',
      'libcurand.so.10',
      'libnvrtc.so.12',
    ],
  );
  const linuxPack = require('../../src/ai-addon/speakrs-pack-spec').getSpeakrsModelPackArtifact('linux-x64');
  assert.equal(linuxPack.architecture, 'x64');
  assert.equal(linuxPack.cudaMajor, 12);
  assert.equal(linuxPack.sha256, 'a79973647cb787bf2aebd31acc2668d282735e41d451e244308bcf04ea77ad20');
  assert.equal(linuxPack.sizeBytes, 208765985);
  assert.match(
    buildSpeakrsSourceDownloadUrl('wespeaker-fbank.onnx'),
    /huggingface\.co\/avencera\/speakrs-models\/resolve\/5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f\/wespeaker-fbank\.onnx$/,
  );
});

test('Linux Speakrs requiredDynamicLibraries map every non-system library to a pin or managed CUDA catalog', () => {
  assert.doesNotThrow(() => assertSpeakrsLinuxRequiredDynamicLibraryClosure());
  assert.equal(
    SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES.some((entry) => entry.source === 'cuda-provider-needed'),
    false,
  );
  const curand = SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES.find((entry) => entry.name === 'libcurand.so.10');
  const nvrtc = SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES.find((entry) => entry.name === 'libnvrtc.so.12');
  const cublas = SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES.find((entry) => entry.name === 'libcublas.so.12');
  assert.equal(curand.source, 'curand-wheel');
  assert.equal(nvrtc.source, 'nvrtc-wheel');
  assert.equal(cublas.source, 'managed-cuda-runtime');
  assert.match(cublas.sha256, /^[a-f0-9]{64}$/);
  assert.equal(cublas.relativePath, 'nvidia/cublas/lib/libcublas.so.12');

  const linuxRuntime = getSpeakrsRuntimeArtifacts('linux-x64');
  assert.throws(
    () => assertSpeakrsLinuxRequiredDynamicLibraryClosure({
      runtimeArtifacts: linuxRuntime.map((artifact, index) => (
        index === 0 ? { ...artifact, requiredDynamicLibraries: undefined } : artifact
      )),
    }),
    /missing requiredDynamicLibraries/,
  );
  assert.throws(
    () => assertSpeakrsLinuxRequiredDynamicLibraryClosure({
      runtimeArtifacts: linuxRuntime,
      requiredLibraries: SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES.map((entry) => (
        entry.name === 'libcurand.so.10'
          ? { ...entry, name: 'libcurand.so.99' }
          : { ...entry }
      )),
    }),
    /missing a pinned artifact|missing from requiredDynamicLibraries/,
  );
  assert.throws(
    () => assertSpeakrsLinuxRequiredDynamicLibraryClosure({
      runtimeArtifacts: linuxRuntime,
      requiredLibraries: SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES.map((entry) => (
        entry.name === 'libnvrtc.so.12'
          ? { ...entry, source: 'cuda-provider-needed' }
          : { ...entry }
      )),
    }),
    /missing a pinned artifact/,
  );
  assert.throws(
    () => assertSpeakrsLinuxRequiredDynamicLibraryClosure({
      runtimeArtifacts: linuxRuntime,
      requiredLibraries: SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES.map((entry) => (
        entry.name === 'libcublas.so.12'
          ? { ...entry, name: 'libcublas.so.99' }
          : { ...entry }
      )),
    }),
    /missing from the managed CUDA catalog/,
  );
});

test('Speakrs setup progress copy names each Windows runtime artifact', () => {
  const runtime = getSpeakrsRuntimeArtifacts('win32-x64');
  const modelCopy = getSpeakrsSetupProgressCopy({ kind: 'model-pack', sizeBytes: 208765985 });
  const ortCopy = getSpeakrsSetupProgressCopy(runtime[0]);
  const cudartCopy = getSpeakrsSetupProgressCopy(runtime[1]);
  const cufftCopy = getSpeakrsSetupProgressCopy(runtime[2]);

  assert.match(modelCopy.downloading, /speaker model \(199 MB\)/);
  assert.equal(modelCopy.installing, 'Installing Speakrs speaker model.');
  assert.match(ortCopy.downloading, /ONNX Runtime for Speakrs CUDA \(311 MB\)/);
  assert.equal(ortCopy.installing, 'Installing ONNX Runtime for Speakrs CUDA.');
  assert.match(cudartCopy.downloading, /CUDA runtime library \(cudart\) \(3\.4 MB\)/);
  assert.equal(cudartCopy.installing, 'Installing CUDA runtime library (cudart).');
  assert.match(cufftCopy.downloading, /CUDA FFT library \(cufft\) \(191 MB\)/);
  assert.equal(cufftCopy.installing, 'Installing CUDA FFT library (cufft).');
  assert.notEqual(ortCopy.downloading, modelCopy.downloading);
  assert.notEqual(cudartCopy.downloading, ortCopy.downloading);
});

test('speakrs pack script refuses a source tree that does not match pinned checksums', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-pack-'));
  try {
    const files = getSpeakrsSourceFiles('win32-x64').slice(0, 1);
    fs.writeFileSync(path.join(tempDir, files[0].path), Buffer.alloc(files[0].sizeBytes, 7));
    const mismatches = validateSourceTree(tempDir, files);
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].reason, 'sha256');
    assert.notEqual(mismatches[0].actual, files[0].sha256);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('speakrs and pyannote model ids stay distinct', () => {
  assert.equal(SPEAKRS_DIARIZATION_MODEL_ID, 'speakrs-community1-vbx');
  assert.equal(PYANNOTE_DIARIZATION_MODEL_ID, 'pyannote/speaker-diarization-community-1');
});

test('speakrs model-pack paths reject absolute traversal and separator tricks', () => {
  for (const unsafePath of [
    '',
    '/absolute/model.bin',
    'C:/absolute/model.bin',
    '../model.bin',
    'models/../model.bin',
    'models//model.bin',
    './model.bin',
    'models\\model.bin',
    'models/model.bin/',
    'models/file:stream',
  ]) {
    assert.throws(() => normalizeSpeakrsRelativePath(unsafePath), /Speakrs model-pack path|Unsafe Speakrs/);
  }
});

test('speakrs model-pack paths preserve nested mlmodelc files within their root', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-paths-'));
  const sourceDir = path.join(tempDir, 'source');
  const stagingDir = path.join(tempDir, 'staging');
  const relativePath = 'speaker.mlmodelc/weights/weight.bin';
  const sourcePath = resolveContainedSpeakrsPath(sourceDir, relativePath);
  try {
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, 'weights');
    stagePackFiles(sourceDir, stagingDir, [{ path: relativePath }]);
    assert.equal(
      fs.readFileSync(resolveContainedSpeakrsPath(stagingDir, relativePath), 'utf8'),
      'weights',
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('speakrs source validation rejects unsafe catalog paths before filesystem access', () => {
  assert.throws(
    () => validateSourceTree('/tmp/source', [{
      path: '../escape.bin',
      sizeBytes: 1,
      sha256: '0'.repeat(64),
    }]),
    /Unsafe Speakrs model-pack path/,
  );
});

test('speakrs pack staging injects complete attribution and license files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-legal-'));
  try {
    stageLegalFiles(tempDir);
    for (const relativePath of REQUIRED_MODEL_PACK_LEGAL_FILES) {
      const filePath = resolveContainedSpeakrsPath(tempDir, relativePath);
      assert.ok(fs.statSync(filePath).size > 0, `${relativePath} should be staged`);
    }
    assert.match(fs.readFileSync(path.join(tempDir, 'ATTRIBUTION.md'), 'utf8'), /weights are unmodified by AvaNevis/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('speakrs pack archive bytes are reproducible across creation times', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-reproducible-'));
  const stagingDir = path.join(tempDir, 'staging');
  try {
    fs.mkdirSync(stagingDir);
    fs.writeFileSync(path.join(stagingDir, 'model.bin'), 'model');
    fs.utimesSync(path.join(stagingDir, 'model.bin'), 0, 0);

    const firstPath = path.join(tempDir, 'first.tar.gz');
    const secondPath = path.join(tempDir, 'second.tar.gz');
    createPackArchive({
      stagingDir,
      archivePath: firstPath,
      files: [{ path: 'model.bin' }],
      legalFiles: [],
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    createPackArchive({
      stagingDir,
      archivePath: secondPath,
      files: [{ path: 'model.bin' }],
      legalFiles: [],
    });

    const digest = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    assert.equal(digest(firstPath), digest(secondPath));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
