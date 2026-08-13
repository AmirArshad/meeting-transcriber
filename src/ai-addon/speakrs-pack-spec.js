'use strict';

const path = require('path');

const SPEAKRS_MODEL_FILES = require('./speakrs-model-files.json');

const SPEAKRS_MODELS_REPO = 'avencera/speakrs-models';
const SPEAKRS_MODEL_PACK_REVISION = '5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f';
const SPEAKRS_MODEL_PACK_REVISION_SHORT = '5d24ffe';
const SPEAKRS_DIARIZATION_MODEL_ID = 'speakrs-community1-vbx';
const PYANNOTE_DIARIZATION_MODEL_ID = 'pyannote/speaker-diarization-community-1';
const SPEAKRS_DIARIZATION_ENGINES = Object.freeze(['speakrs', 'pyannote']);

const SPEAKRS_ORT_DLL_NAMES = Object.freeze([
  'onnxruntime.dll',
  'onnxruntime_providers_shared.dll',
  'onnxruntime_providers_cuda.dll',
]);

const SPEAKRS_CUDA_RUNTIME_DLL_NAMES = Object.freeze([
  'cudart64_12.dll',
  'cufft64_11.dll',
]);

function normalizeSpeakrsRelativePath(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error('Speakrs model-pack paths must be non-empty relative paths.');
  }
  if (
    value.includes('\0')
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
    || path.posix.isAbsolute(value)
  ) {
    throw new Error(`Unsafe Speakrs model-pack path: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`Unsafe Speakrs model-pack path: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../')) {
    throw new Error(`Unsafe Speakrs model-pack path: ${value}`);
  }
  return normalized;
}

function resolveContainedSpeakrsPath(rootDir, relativePath) {
  const normalized = normalizeSpeakrsRelativePath(relativePath);
  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(resolvedRoot, ...normalized.split('/'));
  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (resolvedPath === resolvedRoot) {
      throw new Error('Speakrs model-pack path must identify a file below its root.');
    }
    throw new Error(`Speakrs model-pack path escapes its root: ${relativePath}`);
  }
  return resolvedPath;
}

const SPEAKRS_ORT_RUNTIME_ARTIFACTS = Object.freeze({
  'win32-x64': Object.freeze([
    Object.freeze({
      id: 'onnxruntime-win-x64-gpu-cuda12-1.27.1',
      kind: 'ort-archive',
      fileName: 'onnxruntime-win-x64-gpu_cuda12-1.27.1.zip',
      archiveFormat: 'zip',
      sha256: '78d4de5ab262f79ac5dd59f08ff0d049b1cea605497f375f8df5ba1a52f26111',
      sizeBytes: 325895374,
      downloadUrl: 'https://github.com/microsoft/onnxruntime/releases/download/v1.27.1/onnxruntime-win-x64-gpu_cuda12-1.27.1.zip',
      keepFileNames: SPEAKRS_ORT_DLL_NAMES,
      extractedFiles: Object.freeze({
        'onnxruntime.dll': Object.freeze({
          sha256: '27c4d97f66eade25bb3202c09ace2c674e7ecbe139f9956c80272306409385d6',
          sizeBytes: 15839544,
        }),
        'onnxruntime_providers_shared.dll': Object.freeze({
          sha256: 'a5585d5e782e0f9626c05591184d68a5a1aaf43c2c82a051dd351809c5c828b7',
          sizeBytes: 21816,
        }),
        'onnxruntime_providers_cuda.dll': Object.freeze({
          sha256: 'ffdbf04ad2dbdb435a30df9bc280fa9bad819ceec02b27cdb5a193cdabc44248',
          sizeBytes: 328539448,
        }),
      }),
    }),
    Object.freeze({
      id: 'nvidia-cuda-runtime-cu12-12.9.79',
      kind: 'cuda-runtime-wheel',
      fileName: 'nvidia_cuda_runtime_cu12-12.9.79-py3-none-win_amd64.whl',
      archiveFormat: 'zip',
      sha256: '8e018af8fa02363876860388bd10ccb89eb9ab8fb0aa749aaf58430a9f7c4891',
      sizeBytes: 3591604,
      downloadUrl: 'https://files.pythonhosted.org/packages/59/df/e7c3a360be4f7b93cee39271b792669baeb3846c58a4df6dfcf187a7ffab/nvidia_cuda_runtime_cu12-12.9.79-py3-none-win_amd64.whl',
      keepFileNames: Object.freeze(['cudart64_12.dll']),
      extractedFiles: Object.freeze({
        'cudart64_12.dll': Object.freeze({
          sha256: '760c38928bbe5759f7b31ed6692599eb7ec83cedd5702e84c2b72028a89837e1',
          sizeBytes: 583680,
        }),
      }),
    }),
    Object.freeze({
      id: 'nvidia-cufft-cu12-11.4.1.4',
      kind: 'cufft-wheel',
      fileName: 'nvidia_cufft_cu12-11.4.1.4-py3-none-win_amd64.whl',
      archiveFormat: 'zip',
      sha256: '8e5bfaac795e93f80611f807d42844e8e27e340e0cde270dcb6c65386d795b80',
      sizeBytes: 200067309,
      downloadUrl: 'https://files.pythonhosted.org/packages/20/ee/29955203338515b940bd4f60ffdbc073428f25ef9bfbce44c9a066aedc5c/nvidia_cufft_cu12-11.4.1.4-py3-none-win_amd64.whl',
      keepFileNames: Object.freeze(['cufft64_11.dll']),
      extractedFiles: Object.freeze({
        'cufft64_11.dll': Object.freeze({
          sha256: '5b90655ca9cdf5d91cbdf2c72b995ec937eed0aef2d6954370c711b45c929b35',
          sizeBytes: 287136768,
        }),
      }),
    }),
  ]),
  'darwin-arm64': Object.freeze([]),
});

const SPEAKRS_MODEL_PACK_ARTIFACTS = Object.freeze({
  'win32-x64': Object.freeze({
    id: `speakrs-models-${SPEAKRS_MODEL_PACK_REVISION_SHORT}-win32-x64-cuda`,
    kind: 'model-pack',
    fileName: `speakrs-models-${SPEAKRS_MODEL_PACK_REVISION_SHORT}-win32-x64-cuda.tar.gz`,
    archiveFormat: 'tar.gz',
    downloadUrl: 'https://github.com/AmirArshad/meeting-transcriber/releases/download/speakrs-models-5d24ffe-r1/speakrs-models-5d24ffe-win32-x64-cuda.tar.gz',
    sha256: 'a79973647cb787bf2aebd31acc2668d282735e41d451e244308bcf04ea77ad20',
    sizeBytes: 208765985,
    validationStatus: 'ready',
  }),
  'darwin-arm64': Object.freeze({
    id: `speakrs-models-${SPEAKRS_MODEL_PACK_REVISION_SHORT}-darwin-arm64-coreml`,
    kind: 'model-pack',
    fileName: `speakrs-models-${SPEAKRS_MODEL_PACK_REVISION_SHORT}-darwin-arm64-coreml.tar.gz`,
    archiveFormat: 'tar.gz',
    downloadUrl: 'https://github.com/AmirArshad/meeting-transcriber/releases/download/speakrs-models-5d24ffe-r1/speakrs-models-5d24ffe-darwin-arm64-coreml.tar.gz',
    sha256: '0677b5eee394402ddd4cbdb991afd0736c24e955b145d4b98f69d63523cc8d50',
    sizeBytes: 375813778,
    validationStatus: 'ready',
  }),
});

function assertPinnedRevision() {
  if (SPEAKRS_MODEL_PACK_REVISION !== '5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f') {
    throw new Error('Speakrs model-pack revision does not match the binding plan.');
  }
  if (!SPEAKRS_MODEL_PACK_REVISION.startsWith(SPEAKRS_MODEL_PACK_REVISION_SHORT)) {
    throw new Error('Speakrs short revision does not match the full pinned revision.');
  }
}

function platformKey(platform, arch) {
  return `${platform}-${arch}`;
}

function clonePinnedFile(file) {
  const relativePath = normalizeSpeakrsRelativePath(file.path);
  return {
    path: relativePath,
    fileName: path.posix.basename(relativePath),
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  };
}

function getSpeakrsSourceFiles(platformOrKey, arch) {
  const key = arch ? platformKey(platformOrKey, arch) : platformOrKey;
  if (key === 'win32-x64') {
    return SPEAKRS_MODEL_FILES.cudaPins.map(clonePinnedFile);
  }
  if (key === 'darwin-arm64') {
    return SPEAKRS_MODEL_FILES.coremlPins.map(clonePinnedFile);
  }
  return [];
}

function isPinnedSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function cloneExtractedFiles(files) {
  if (!files || typeof files !== 'object') {
    return {};
  }
  const cloned = {};
  for (const [name, pin] of Object.entries(files)) {
    cloned[name] = {
      sha256: pin && pin.sha256,
      sizeBytes: pin && pin.sizeBytes,
    };
  }
  return cloned;
}

function getSpeakrsRuntimeArtifacts(platformOrKey, arch) {
  const key = arch ? platformKey(platformOrKey, arch) : platformOrKey;
  const artifacts = SPEAKRS_ORT_RUNTIME_ARTIFACTS[key] || [];
  return artifacts.map((artifact) => ({
    ...artifact,
    keepFileNames: Array.isArray(artifact.keepFileNames) ? [...artifact.keepFileNames] : [],
    extractedFiles: cloneExtractedFiles(artifact.extractedFiles),
  }));
}

function getSpeakrsRequiredRuntimeDllNames() {
  return [...SPEAKRS_ORT_DLL_NAMES, ...SPEAKRS_CUDA_RUNTIME_DLL_NAMES];
}

function getSpeakrsExtractedRuntimeDllPins(runtimeArtifacts) {
  const expectedNames = getSpeakrsRequiredRuntimeDllNames();
  const pins = {};
  if (!Array.isArray(runtimeArtifacts) || runtimeArtifacts.length === 0) {
    return null;
  }
  for (const artifact of runtimeArtifacts) {
    const files = artifact && artifact.extractedFiles;
    const keepFileNames = Array.isArray(artifact && artifact.keepFileNames) ? artifact.keepFileNames : [];
    if (!files || keepFileNames.length === 0) {
      return null;
    }
    for (const name of keepFileNames) {
      const pin = files[name];
      if (
        !pin
        || !isPinnedSha256(pin.sha256)
        || !Number.isInteger(pin.sizeBytes)
        || pin.sizeBytes <= 0
        || Object.prototype.hasOwnProperty.call(pins, name)
      ) {
        return null;
      }
      pins[name] = {
        sha256: pin.sha256,
        sizeBytes: pin.sizeBytes,
      };
    }
  }
  if (expectedNames.some((name) => !pins[name]) || Object.keys(pins).length !== expectedNames.length) {
    return null;
  }
  return pins;
}

function getSpeakrsModelPackArtifact(platformOrKey, arch) {
  const key = arch ? platformKey(platformOrKey, arch) : platformOrKey;
  const artifact = SPEAKRS_MODEL_PACK_ARTIFACTS[key];
  if (!artifact) {
    return null;
  }
  return {
    ...artifact,
    requiredFiles: getSpeakrsSourceFiles(key),
  };
}

function getSpeakrsSourceTotalBytes(platformOrKey, arch) {
  return getSpeakrsSourceFiles(platformOrKey, arch)
    .reduce((total, file) => total + (Number(file.sizeBytes) || 0), 0);
}

function buildSpeakrsSourceDownloadUrl(filePath) {
  const encodedPath = String(filePath || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `https://huggingface.co/${SPEAKRS_MODELS_REPO}/resolve/${SPEAKRS_MODEL_PACK_REVISION}/${encodedPath}`;
}

function getSpeakrsPackFileName(platformOrKey, arch) {
  return getSpeakrsModelPackArtifact(platformOrKey, arch)?.fileName || null;
}

function buildSpeakrsSourceArtifacts(platformOrKey, arch) {
  return getSpeakrsSourceFiles(platformOrKey, arch).map((file) => ({
    ...file,
    id: `speakrs-source-${file.path.replace(/[^A-Za-z0-9._-]+/g, '_')}`,
    downloadUrl: buildSpeakrsSourceDownloadUrl(file.path),
  }));
}

assertPinnedRevision();

module.exports = {
  PYANNOTE_DIARIZATION_MODEL_ID,
  SPEAKRS_CUDA_RUNTIME_DLL_NAMES,
  SPEAKRS_DIARIZATION_ENGINES,
  SPEAKRS_DIARIZATION_MODEL_ID,
  SPEAKRS_MODEL_FILES,
  SPEAKRS_MODEL_PACK_REVISION,
  SPEAKRS_MODEL_PACK_REVISION_SHORT,
  SPEAKRS_MODELS_REPO,
  SPEAKRS_MODEL_PACK_ARTIFACTS,
  SPEAKRS_ORT_DLL_NAMES,
  SPEAKRS_ORT_RUNTIME_ARTIFACTS,
  buildSpeakrsSourceArtifacts,
  buildSpeakrsSourceDownloadUrl,
  getSpeakrsExtractedRuntimeDllPins,
  getSpeakrsPackFileName,
  getSpeakrsModelPackArtifact,
  getSpeakrsRequiredRuntimeDllNames,
  getSpeakrsRuntimeArtifacts,
  getSpeakrsSourceFiles,
  getSpeakrsSourceTotalBytes,
  isPinnedSha256,
  normalizeSpeakrsRelativePath,
  platformKey,
  resolveContainedSpeakrsPath,
};
