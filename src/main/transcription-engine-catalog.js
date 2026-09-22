'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { LINUX_CUDA12_RUNTIME_CATALOG } = require('../main-process/linux-cuda-runtime-catalog');

const ENGINE_WHISPER = 'whisper';
const ENGINE_PARAKEET = 'parakeet';
const PARAKEET_MODEL_ID = 'parakeet-tdt-0.6b-v2';
const BOUNDARY_POLICY = 'parakeet-boundaries-v1';
const EXECUTION_PRECISION = 'float32';
const SCHEMA_VERSION = 1;

const ADAPTERS = Object.freeze({
  WINDOWS_CUDA: 'parakeet-onnx-win-cuda-v1',
  LINUX_CUDA: 'parakeet-onnx-linux-cuda-v1',
  MACOS_METAL: 'parakeet-mlx-metal-v1',
});

const ONNX_MODEL_REVISION = '0bbb45a3365852604aef28b538a8f066f4ccaa85';
const ONNX_MODEL_REPOSITORY = 'istupakov/parakeet-tdt-0.6b-v2-onnx';
const VAD_REVISION = 'b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6';
const VAD_REPOSITORY = 'istupakov/silero-vad-onnx';
const MLX_MODEL_REVISION = '8ae155301e23d820d82aa60d24817c900e69e487';
const MLX_MODEL_REPOSITORY = 'mlx-community/parakeet-tdt-0.6b-v2';

const ONNX_MODEL_FILES = Object.freeze([
  Object.freeze({ path: 'config.json', sizeBytes: 97, sha256: '666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466' }),
  Object.freeze({ path: 'vocab.txt', sizeBytes: 9384, sha256: 'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d' }),
  Object.freeze({ path: 'nemo128.onnx', sizeBytes: 139764, sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f' }),
  Object.freeze({ path: 'decoder_joint-model.onnx', sizeBytes: 35792059, sha256: 'cbb52a07bd70ab5b67f8439d4b3cd8704b18467b4430bcacb5adabe154b8d191' }),
  Object.freeze({ path: 'encoder-model.onnx', sizeBytes: 41770866, sha256: '3987bcd28175d829d12888a996a84e8f62a0e374d9ffd640662c1515adc679d3' }),
  Object.freeze({ path: 'encoder-model.onnx.data', sizeBytes: 2435420160, sha256: '4dab7362d4874d85965045b1e41b2d61dd2cc0fb25671a7f6b3dc47bf120cc41' }),
]);

const VAD_FILES = Object.freeze([
  Object.freeze({ path: 'silero_vad.onnx', sizeBytes: 2327524, sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3' }),
]);

const MLX_MODEL_FILES = Object.freeze([
  Object.freeze({ path: 'config.json', sizeBytes: 36176, sha256: '9bd323e60afe2615c983a5d9fc3a2c0470df2a03edf90c0f861bd59509d07264' }),
  Object.freeze({ path: 'model.safetensors', sizeBytes: 2471559904, sha256: 'b958c37a6baa6874a279108755c8f2818e27bf647d72d54800a234a421341dfe' }),
]);

const REQUIRED_WHEEL_HASHES = Object.freeze({
  [ADAPTERS.LINUX_CUDA]: Object.freeze({
    'onnx-asr': '5e7ceca454609819ea7833f61e2302e0c8f6ece4f8a78b66c5daba53cb51de4a',
    'onnxruntime-gpu': 'd76d1ac7a479ecc3ac54482eea4ba3b10d68e888a0f8b5f420f0bdf82c5eec59',
    'nvidia-cublas-cu12': 'e4f53a8ca8c5d6e8c492d0d0a3d565ecb59a751b19cfdaa4f6da0ab2104c1702',
    'nvidia-cudnn-cu12': 'ce8603d4ea88d134be5a92c5e0833d513bea1ce0ee4bbc5d649fcb8718d51cbf',
    'nvidia-cuda-runtime-cu12': '25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3',
    'nvidia-cuda-nvrtc-cu12': '210cf05005a447e29214e9ce50851e83fc5f4358df8b453155d5e1918094dcb4',
    'nvidia-cufft-cu12': 'c67884f2a7d276b4b80eb56a79322a95df592ae5e765cf1243693365ccab4e28',
    'nvidia-curand-cu12': '49b274db4780d421bd2ccd362e1415c13887c53c214f0d4b761752b8f9f6aa1e',
    'nvidia-nvjitlink-cu12': 'e3f1171dbdc83c5932a45f0f4c99180a70de9bd2718c1ab77d14104f6d7147f9',
    numpy: '89cd468399cfd2504718f0ba50e410dca55a170b61a02ad92bb18c8a65186e93',
    protobuf: '89f23aa53c24553a2416fd4fd1ec06f74fa42b14b546d8883128813f775bbfd2',
    flatbuffers: '7634f50c427838bb021c2d66a3d1168e9d199b0607e6329399f04846d42e20b4',
    packaging: 'd7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c',
    coloredlogs: '612ee75c546f53e92e70049c9dbfcc18c935a2b9a53b66085ce9ef6a6e5c0934',
    humanfriendly: '1697e1a8a8f550fd43c2865cd84542fc175a61dcb779b6fee18cf6b6ccba1477',
    sympy: 'e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5',
    mpmath: 'a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c',
  }),
  [ADAPTERS.WINDOWS_CUDA]: Object.freeze({
    'onnxruntime-gpu': '054282614c2fc9a4a27d74242afbae706a410f1f63cc35bc72f99709029a5ba4',
    'nvidia-cudnn-cu12': '010abb90f513fc6e2b6e9278d56f594b87922fff80737434ab415da609db8311',
  }),
  [ADAPTERS.MACOS_METAL]: Object.freeze({
    'parakeet-mlx': '50afb6ddb62237a6486e214482c25ef12759832fda3cd514e159938fa5970d9c',
    mlx: '238b50d2ee3917c836e73f9446011518b79ff094940eb0107fa6cd17d02a2eca',
    'mlx-metal': '3825fff379dbc107dd3413e564a06caeaa24819910ec49c0439e454c06a1b9b8',
  }),
});

const LOCK_FILE_NAMES = Object.freeze({
  [ADAPTERS.WINDOWS_CUDA]: 'windows-cuda.lock.json',
  [ADAPTERS.LINUX_CUDA]: 'linux-cuda.lock.json',
  [ADAPTERS.MACOS_METAL]: 'macos-metal.lock.json',
});

const TARGETS = Object.freeze([
  Object.freeze({ platform: 'win32', arch: 'x64', adapterId: ADAPTERS.WINDOWS_CUDA, device: 'cuda' }),
  Object.freeze({ platform: 'linux', arch: 'x64', adapterId: ADAPTERS.LINUX_CUDA, device: 'cuda' }),
  Object.freeze({ platform: 'darwin', arch: 'arm64', adapterId: ADAPTERS.MACOS_METAL, device: 'metal', minimumOsMajor: 14 }),
]);

const WHISPER_MANAGED_CUDA_ROOT = 'ai-addons/cuda/python';
const SPEAKRS_ORT_MARKERS = Object.freeze(['onnxruntime-1.27.1', 'libonnxruntime.so.1.27.1']);

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    freezeDeep(nested);
  }
  return Object.freeze(value);
}

function isPinnedSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function lockFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function whisperCudnnWheel() {
  return (LINUX_CUDA12_RUNTIME_CATALOG.wheels || []).find((wheel) => wheel.packageName === 'nvidia-cudnn-cu12') || null;
}

function filesMatch(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    return false;
  }
  return expected.every((file, index) => {
    const candidate = actual[index];
    return candidate
      && candidate.path === file.path
      && candidate.sizeBytes === file.sizeBytes
      && candidate.sha256 === file.sha256;
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalLockDigest(lock) {
  const payload = {
    adapterId: lock.adapterId,
    modelRevision: lock.model && lock.model.revision,
    vadRevision: lock.vad ? lock.vad.revision : null,
    wheels: (lock.wheels || []).map((wheel) => ({
      fileName: wheel.fileName,
      sha256: wheel.sha256,
      sizeBytes: wheel.sizeBytes,
    })),
  };
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function assertNoSharedCudnn(wheel) {
  const whisper = whisperCudnnWheel();
  const haystack = `${wheel.packageName || ''} ${wheel.version || ''} ${wheel.fileName || ''} ${wheel.url || ''} ${wheel.sha256 || ''}`;
  if (wheel.version === '9.22.0.52' || haystack.includes('9.22.0.52')) {
    throw lockFailure('LOCK_SHARED_CUDNN', 'Parakeet must not pin Whisper cuDNN 9.22.0.52.');
  }
  if (whisper && wheel.sha256 === whisper.sha256) {
    throw lockFailure('LOCK_SHARED_CUDNN', 'Parakeet must not reuse the Whisper cuDNN wheel hash.');
  }
  if (String(wheel.url || '').includes(WHISPER_MANAGED_CUDA_ROOT)) {
    throw lockFailure('LOCK_SHARED_CUDNN', 'Parakeet wheel URL must not point at the Whisper CUDA tree.');
  }
}

function assertWheelClosed(wheel, adapterId) {
  if (!wheel || typeof wheel !== 'object') {
    throw lockFailure('LOCK_WHEEL_INCOMPLETE', 'Parakeet lock wheel is missing.');
  }
  const fileName = String(wheel.fileName || '');
  const packageName = String(wheel.packageName || '');
  const identity = `${packageName} ${wheel.version || ''} ${fileName}`.toLowerCase();
  if (!fileName.endsWith('.whl') || fileName.endsWith('.tar.gz') || fileName.endsWith('.zip')) {
    throw lockFailure('LOCK_SDIST', `Parakeet lock refuses non-wheel artifact ${fileName || packageName}.`);
  }
  if (/cu13|cuda[-_]?13|cudnn[-_]?cu13/.test(identity)) {
    throw lockFailure('LOCK_CUDA13', `Parakeet lock refuses CUDA 13 artifact ${fileName || packageName}.`);
  }
  for (const marker of SPEAKRS_ORT_MARKERS) {
    if (identity.includes(marker)) {
      throw lockFailure('LOCK_SHARED_ORT', 'Parakeet lock must not use the Speakrs ONNX Runtime tree.');
    }
  }
  if (!isPinnedSha256(wheel.sha256) || !Number.isInteger(wheel.sizeBytes) || wheel.sizeBytes <= 0) {
    throw lockFailure('LOCK_MISSING_HASH', `Parakeet wheel is missing a size or SHA-256: ${fileName || packageName}.`);
  }
  if (!String(wheel.url || '').startsWith('https://files.pythonhosted.org/')) {
    throw lockFailure('LOCK_URL', `Parakeet wheel URL must be a direct PyPI object: ${fileName || packageName}.`);
  }
  if (!String(wheel.license || '').trim()) {
    throw lockFailure('LOCK_LICENSE', `Parakeet wheel is missing a license: ${fileName || packageName}.`);
  }
  if (!Array.isArray(wheel.extractedFiles) || wheel.extractedFiles.length === 0) {
    throw lockFailure('LOCK_MISSING_HASH', `Parakeet wheel is missing extracted-file hashes: ${fileName || packageName}.`);
  }
  for (const extracted of wheel.extractedFiles) {
    const member = String(extracted && extracted.path || '');
    if (!member || member.startsWith('/') || member.split('/').includes('..')) {
      throw lockFailure('LOCK_PATH', `Parakeet extracted path is unsafe: ${member || fileName}.`);
    }
    if (member === WHISPER_MANAGED_CUDA_ROOT || member.startsWith(`${WHISPER_MANAGED_CUDA_ROOT}/`)) {
      throw lockFailure('LOCK_SHARED_CUDNN', 'Parakeet extracted files must not live in the Whisper CUDA tree.');
    }
    if (!isPinnedSha256(extracted.sha256) || !Number.isInteger(extracted.sizeBytes) || extracted.sizeBytes < 0) {
      throw lockFailure('LOCK_MISSING_HASH', `Parakeet extracted file is missing a hash: ${member}.`);
    }
  }
  if (packageName === 'nvidia-cudnn-cu12' && wheel.version !== '9.26.0.51') {
    throw lockFailure('LOCK_SHARED_CUDNN', 'Parakeet cuDNN must be the isolated 9.26.0.51 pin.');
  }
  if (packageName === 'onnxruntime-gpu' && wheel.version !== '1.23.2') {
    throw lockFailure('LOCK_ORT', 'Parakeet ONNX Runtime GPU must stay pinned to 1.23.2.');
  }
  assertNoSharedCudnn(wheel);
  const required = REQUIRED_WHEEL_HASHES[adapterId] && REQUIRED_WHEEL_HASHES[adapterId][packageName];
  if (required && wheel.sha256 !== required) {
    throw lockFailure('LOCK_HASH_MISMATCH', `Parakeet wheel hash drifted for ${packageName}.`);
  }
}

function assertParakeetLockIntegrity(lock) {
  if (!lock || lock.schemaVersion !== SCHEMA_VERSION) {
    throw lockFailure('LOCK_SCHEMA', 'Parakeet lock schema is not version 1.');
  }
  if (!Object.values(ADAPTERS).includes(lock.adapterId)) {
    throw lockFailure('LOCK_ADAPTER', 'Parakeet lock adapter is unknown.');
  }
  if (lock.executionPrecision !== EXECUTION_PRECISION) {
    throw lockFailure('LOCK_PRECISION', 'Parakeet execution precision must be float32.');
  }
  if (!Array.isArray(lock.wheels) || lock.wheels.length === 0) {
    throw lockFailure('LOCK_WHEEL_INCOMPLETE', 'Parakeet lock has no wheels.');
  }
  const names = new Set();
  for (const wheel of lock.wheels) {
    assertWheelClosed(wheel, lock.adapterId);
    if (names.has(wheel.packageName)) {
      throw lockFailure('LOCK_WHEEL_INCOMPLETE', `Duplicate Parakeet wheel ${wheel.packageName}.`);
    }
    names.add(wheel.packageName);
  }
  const requiredHashes = REQUIRED_WHEEL_HASHES[lock.adapterId] || {};
  for (const packageName of Object.keys(requiredHashes)) {
    if (!names.has(packageName)) {
      throw lockFailure('LOCK_WHEEL_INCOMPLETE', `Parakeet lock is missing ${packageName}.`);
    }
  }
  if (lock.adapterId === ADAPTERS.MACOS_METAL) {
    if (lock.platform !== 'darwin' || lock.arch !== 'arm64' || lock.device !== 'metal' || lock.cudaMajor != null) {
      throw lockFailure('LOCK_TARGET', 'macOS Parakeet lock must target arm64 Metal.');
    }
    if (lock.decoding !== 'greedy' || lock.attention !== 'full') {
      throw lockFailure('LOCK_DECODING', 'macOS Parakeet decoding must stay greedy full attention.');
    }
    if (lock.vad != null) {
      throw lockFailure('LOCK_VAD', 'macOS Parakeet does not use the ONNX VAD.');
    }
    if (!lock.model || lock.model.repository !== MLX_MODEL_REPOSITORY || lock.model.revision !== MLX_MODEL_REVISION) {
      throw lockFailure('LOCK_REVISION', 'macOS Parakeet model revision is not the pinned MLX tree.');
    }
    if (!filesMatch(lock.model.files, MLX_MODEL_FILES)) {
      throw lockFailure('LOCK_REVISION', 'macOS Parakeet model files do not match the pinned MLX tree.');
    }
    for (const packageName of ['mlx', 'mlx-metal']) {
      const wheel = lock.wheels.find((item) => item.packageName === packageName);
      if (!wheel || !wheel.fileName.includes('macosx_14_0_arm64')) {
        throw lockFailure('LOCK_TARGET', `${packageName} must use a macOS 14 arm64 wheel.`);
      }
    }
    const parakeetWheel = lock.wheels.find((item) => item.packageName === 'parakeet-mlx');
    if (!parakeetWheel || parakeetWheel.version !== '0.5.2') {
      throw lockFailure('LOCK_TARGET', 'parakeet-mlx must stay pinned to 0.5.2.');
    }
  } else {
    if (lock.device !== 'cuda' || lock.cudaMajor !== 12 || lock.executionPrecision !== 'float32') {
      throw lockFailure('LOCK_TARGET', 'ONNX Parakeet locks must target CUDA 12 float32.');
    }
    if (!lock.model || lock.model.repository !== ONNX_MODEL_REPOSITORY || lock.model.revision !== ONNX_MODEL_REVISION) {
      throw lockFailure('LOCK_REVISION', 'ONNX Parakeet model revision is not the pinned community tree.');
    }
    if (!filesMatch(lock.model.files, ONNX_MODEL_FILES)) {
      throw lockFailure('LOCK_REVISION', 'ONNX Parakeet model files do not match the pinned community tree.');
    }
    if (!lock.vad || lock.vad.repository !== VAD_REPOSITORY || lock.vad.revision !== VAD_REVISION) {
      throw lockFailure('LOCK_VAD', 'ONNX Parakeet VAD revision is not the pinned Silero tree.');
    }
    if (!filesMatch(lock.vad.files, VAD_FILES)) {
      throw lockFailure('LOCK_VAD', 'ONNX Parakeet VAD file does not match the pinned Silero tree.');
    }
    if (lock.adapterId === ADAPTERS.WINDOWS_CUDA && !names.has('pyreadline3')) {
      throw lockFailure('LOCK_WHEEL_INCOMPLETE', 'Windows Parakeet lock must include pyreadline3.');
    }
    if (lock.adapterId === ADAPTERS.LINUX_CUDA && names.has('pyreadline3')) {
      throw lockFailure('LOCK_WHEEL_INCOMPLETE', 'Linux Parakeet lock must not include pyreadline3.');
    }
  }
  if (lock.model.id !== PARAKEET_MODEL_ID) {
    throw lockFailure('LOCK_REVISION', 'Parakeet model id drifted.');
  }
  if (canonicalLockDigest(lock) !== lock.lockDigest) {
    throw lockFailure('LOCK_DIGEST', 'Parakeet lock digest does not match its wheel closure.');
  }
  return lock;
}

function locksDirectory() {
  return path.join(__dirname, '..', '..', 'build', 'parakeet');
}

const loadedLocks = new Map();

function loadLock(adapterId) {
  if (loadedLocks.has(adapterId)) {
    return loadedLocks.get(adapterId);
  }
  const fileName = LOCK_FILE_NAMES[adapterId];
  if (!fileName) {
    throw lockFailure('LOCK_ADAPTER', `Unknown Parakeet adapter ${adapterId}.`);
  }
  const raw = JSON.parse(fs.readFileSync(path.join(locksDirectory(), fileName), 'utf8'));
  const lock = freezeDeep(assertParakeetLockIntegrity(raw));
  loadedLocks.set(adapterId, lock);
  return lock;
}

function listSupportedTargets() {
  return TARGETS.map((target) => ({ ...target }));
}

function resolveAdapterForTarget({ platform, arch, osRelease } = {}) {
  const normalizedPlatform = String(platform || '');
  const normalizedArch = String(arch || '');
  const match = TARGETS.find((target) => target.platform === normalizedPlatform && target.arch === normalizedArch);
  if (!match) {
    return {
      ok: false,
      code: 'PARAKEET_UNSUPPORTED_TARGET',
      message: unsupportedTargetMessage(normalizedPlatform, normalizedArch),
    };
  }
  if (match.minimumOsMajor && osRelease != null && osRelease !== '') {
    const major = Number.parseInt(String(osRelease).split('.')[0], 10);
    if (!Number.isFinite(major) || major < match.minimumOsMajor) {
      return {
        ok: false,
        code: 'PARAKEET_UNSUPPORTED_TARGET',
        message: 'Parakeet requires macOS 14 or newer on Apple Silicon.',
      };
    }
  }
  return {
    ok: true,
    adapterId: match.adapterId,
    device: match.device,
    platform: match.platform,
    arch: match.arch,
  };
}

function unsupportedTargetMessage(platform, arch) {
  if (platform === 'darwin') {
    return 'Parakeet requires Apple Silicon (arm64) on macOS 14 or newer.';
  }
  if (platform === 'win32') {
    return 'Parakeet requires Windows 10/11 x64.';
  }
  if (platform === 'linux') {
    return 'Parakeet requires Linux x86_64.';
  }
  return `Parakeet is not available on ${platform || 'this'} ${arch || 'system'}.`;
}

function modelRelativeDir(revision) {
  return path.posix.join('ai-addons/models/transcription/parakeet', String(revision || ''));
}

function runtimeRelativeDir(adapterId, lockDigest) {
  return path.posix.join('ai-addons/runtimes/parakeet', String(adapterId || ''), String(lockDigest || ''));
}

function getAdapterSpec(adapterId) {
  const lock = loadLock(adapterId);
  const target = TARGETS.find((item) => item.adapterId === adapterId);
  return freezeDeep({
    adapterId,
    engine: ENGINE_PARAKEET,
    modelId: PARAKEET_MODEL_ID,
    device: target.device,
    platform: target.platform,
    arch: target.arch,
    artifactRevision: lock.model.revision,
    runtimeLockId: lock.lockDigest,
    boundaryPolicy: BOUNDARY_POLICY,
    executionPrecision: EXECUTION_PRECISION,
    modelRepository: lock.model.repository,
    modelRelativeDir: modelRelativeDir(lock.model.revision),
    runtimeRelativeDir: runtimeRelativeDir(adapterId, lock.lockDigest),
    lock,
  });
}

module.exports = {
  ADAPTERS,
  BOUNDARY_POLICY,
  ENGINE_PARAKEET,
  ENGINE_WHISPER,
  EXECUTION_PRECISION,
  MLX_MODEL_REVISION,
  ONNX_MODEL_REVISION,
  PARAKEET_MODEL_ID,
  TARGETS,
  VAD_REVISION,
  WHISPER_MANAGED_CUDA_ROOT,
  assertParakeetLockIntegrity,
  canonicalLockDigest,
  getAdapterSpec,
  listSupportedTargets,
  loadLock,
  modelRelativeDir,
  resolveAdapterForTarget,
  runtimeRelativeDir,
};
