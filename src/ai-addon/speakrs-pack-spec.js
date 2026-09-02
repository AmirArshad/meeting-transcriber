'use strict';

const path = require('path');

const SPEAKRS_MODEL_FILES = require('./speakrs-model-files.json');
const { getLinuxCudaRequiredLibraries } = require('../main-process/linux-cuda-runtime-catalog');

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

const SPEAKRS_ORT_SO_NAMES = Object.freeze([
  'libonnxruntime.so.1.27.1',
  'libonnxruntime_providers_shared.so',
  'libonnxruntime_providers_cuda.so',
]);

const SPEAKRS_CUDA_RUNTIME_SO_NAMES = Object.freeze([
  'libcudart.so.12',
  'libcufft.so.11',
  'libcurand.so.10',
  'libnvrtc.so.12',
]);

const SPEAKRS_REQUIRED_LIBRARY_SOURCE_KINDS = Object.freeze({
  'ort-archive': 'ort-archive',
  'cuda-runtime-wheel': 'cuda-runtime-wheel',
  'cufft-wheel': 'cufft-wheel',
  'curand-wheel': 'curand-wheel',
  'nvrtc-wheel': 'nvrtc-wheel',
});

function pinManagedCudaRequiredLibrary(name) {
  const library = getLinuxCudaRequiredLibraries().find((entry) => entry.fileName === name);
  if (
    !library
    || typeof library.relativePath !== 'string'
    || !library.relativePath
    || !/^[a-f0-9]{64}$/.test(String(library.sha256 || ''))
    || !Number.isInteger(library.sizeBytes)
    || library.sizeBytes <= 0
  ) {
    throw new Error(`Speakrs required library is missing from the managed CUDA catalog: ${name}`);
  }
  return Object.freeze({
    name,
    source: 'managed-cuda-runtime',
    relativePath: library.relativePath,
    sha256: library.sha256,
    sizeBytes: library.sizeBytes,
  });
}

const SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES = Object.freeze([
  Object.freeze({
    name: 'libonnxruntime.so.1.27.1',
    source: 'ort-archive',
    relativePath: 'lib/libonnxruntime.so.1.27.1',
  }),
  Object.freeze({
    name: 'libonnxruntime_providers_shared.so',
    source: 'ort-archive',
    relativePath: 'lib/libonnxruntime_providers_shared.so',
  }),
  Object.freeze({
    name: 'libonnxruntime_providers_cuda.so',
    source: 'ort-archive',
    relativePath: 'lib/libonnxruntime_providers_cuda.so',
  }),
  Object.freeze({
    name: 'libcudart.so.12',
    source: 'cuda-runtime-wheel',
    relativePath: 'nvidia/cuda_runtime/lib/libcudart.so.12',
  }),
  Object.freeze({
    name: 'libcufft.so.11',
    source: 'cufft-wheel',
    relativePath: 'nvidia/cufft/lib/libcufft.so.11',
  }),
  Object.freeze({
    name: 'libcurand.so.10',
    source: 'curand-wheel',
    relativePath: 'nvidia/curand/lib/libcurand.so.10',
  }),
  Object.freeze({
    name: 'libnvrtc.so.12',
    source: 'nvrtc-wheel',
    relativePath: 'nvidia/cuda_nvrtc/lib/libnvrtc.so.12',
  }),
  pinManagedCudaRequiredLibrary('libcublas.so.12'),
  pinManagedCudaRequiredLibrary('libcublasLt.so.12'),
  pinManagedCudaRequiredLibrary('libcudnn.so.9'),
  Object.freeze({ name: 'libcuda.so.1', source: 'nvidia-driver' }),
  Object.freeze({ name: 'libz.so.1', source: 'system' }),
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
  'linux-x64': Object.freeze([
    Object.freeze({
      id: 'onnxruntime-linux-x64-gpu-cuda12-1.27.1',
      kind: 'ort-archive',
      fileName: 'onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz',
      archiveFormat: 'tar.gz',
      architecture: 'x64',
      cudaMajor: 12,
      dynamicLibraryDir: 'lib',
      sha256: '08b568bd69500c36606aff7c3896ee4fa7d3531719f6b00f43e6a34db41dc4bf',
      sizeBytes: 244763765,
      downloadUrl: 'https://github.com/microsoft/onnxruntime/releases/download/v1.27.1/onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz',
      keepFileNames: SPEAKRS_ORT_SO_NAMES,
      requiredDynamicLibraries: SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES,
      extractedFiles: Object.freeze({
        'libonnxruntime.so.1.27.1': Object.freeze({
          sha256: '67eda041546eb01cf5606add5467d8bb7305b2aedb5cf37fdc6b055c7adfc094',
          sizeBytes: 27000912,
        }),
        'libonnxruntime_providers_shared.so': Object.freeze({
          sha256: 'c6a12593396095f5670160e284c35d1700b7708cf3037b7042e2a5200ccae772',
          sizeBytes: 14632,
        }),
        'libonnxruntime_providers_cuda.so': Object.freeze({
          sha256: 'cffff5fe3aac14fe50eed1113757ac8318ee12ef307fcb9def35a24398ec0ce3',
          sizeBytes: 373925672,
        }),
      }),
    }),
    Object.freeze({
      id: 'nvidia-cuda-runtime-cu12-12.9.79-linux-x64',
      kind: 'cuda-runtime-wheel',
      fileName: 'nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
      archiveFormat: 'zip',
      architecture: 'x64',
      cudaMajor: 12,
      dynamicLibraryDir: 'nvidia/cuda_runtime/lib',
      sha256: '25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3',
      sizeBytes: 3493179,
      downloadUrl: 'https://files.pythonhosted.org/packages/bc/46/a92db19b8309581092a3add7e6fceb4c301a3fd233969856a8cbf042cd3c/nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
      keepFileNames: Object.freeze(['libcudart.so.12']),
      extractedFiles: Object.freeze({
        'libcudart.so.12': Object.freeze({
          sha256: '256e6409e4f06f618e1fb53d4844a6b81cdded1013afa8ade40c22f99eb133b7',
          sizeBytes: 741088,
        }),
      }),
    }),
    Object.freeze({
      id: 'nvidia-cufft-cu12-11.4.1.4-linux-x64',
      kind: 'cufft-wheel',
      fileName: 'nvidia_cufft_cu12-11.4.1.4-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
      archiveFormat: 'zip',
      architecture: 'x64',
      cudaMajor: 12,
      dynamicLibraryDir: 'nvidia/cufft/lib',
      sha256: 'c67884f2a7d276b4b80eb56a79322a95df592ae5e765cf1243693365ccab4e28',
      sizeBytes: 200877592,
      downloadUrl: 'https://files.pythonhosted.org/packages/95/f4/61e6996dd20481ee834f57a8e9dca28b1869366a135e0d42e2aa8493bdd4/nvidia_cufft_cu12-11.4.1.4-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
      keepFileNames: Object.freeze(['libcufft.so.11']),
      extractedFiles: Object.freeze({
        'libcufft.so.11': Object.freeze({
          sha256: 'e1d65ebd08895f9d9883f848f3974f89e0130416252477b18835ba7f15d159bc',
          sizeBytes: 291507928,
        }),
      }),
    }),
    Object.freeze({
      id: 'nvidia-curand-cu12-10.3.10.19-linux-x64',
      kind: 'curand-wheel',
      fileName: 'nvidia_curand_cu12-10.3.10.19-py3-none-manylinux_2_27_x86_64.whl',
      archiveFormat: 'zip',
      architecture: 'x64',
      cudaMajor: 12,
      dynamicLibraryDir: 'nvidia/curand/lib',
      sha256: '49b274db4780d421bd2ccd362e1415c13887c53c214f0d4b761752b8f9f6aa1e',
      sizeBytes: 68295626,
      downloadUrl: 'https://files.pythonhosted.org/packages/31/44/193a0e171750ca9f8320626e8a1f2381e4077a65e69e2fb9708bd479e34a/nvidia_curand_cu12-10.3.10.19-py3-none-manylinux_2_27_x86_64.whl',
      keepFileNames: Object.freeze(['libcurand.so.10']),
      extractedFiles: Object.freeze({
        'libcurand.so.10': Object.freeze({
          sha256: 'ab8c07338fa663c018b16df5b3f3878c84aaae98bda930e9e8bad340427b0faa',
          sizeBytes: 166965432,
        }),
      }),
    }),
    Object.freeze({
      id: 'nvidia-cuda-nvrtc-cu12-12.9.86-linux-x64',
      kind: 'nvrtc-wheel',
      fileName: 'nvidia_cuda_nvrtc_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl',
      archiveFormat: 'zip',
      architecture: 'x64',
      cudaMajor: 12,
      dynamicLibraryDir: 'nvidia/cuda_nvrtc/lib',
      sha256: '210cf05005a447e29214e9ce50851e83fc5f4358df8b453155d5e1918094dcb4',
      sizeBytes: 89568129,
      downloadUrl: 'https://files.pythonhosted.org/packages/b8/85/e4af82cc9202023862090bfca4ea827d533329e925c758f0cde964cb54b7/nvidia_cuda_nvrtc_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl',
      keepFileNames: Object.freeze(['libnvrtc.so.12']),
      extractedFiles: Object.freeze({
        'libnvrtc.so.12': Object.freeze({
          sha256: '7c67c6b51ea0e0279634cebd676ff7efda1674806444520c84430ad5c35fe625',
          sizeBytes: 106244480,
        }),
      }),
    }),
  ]),
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
  'linux-x64': Object.freeze({
    id: `speakrs-models-${SPEAKRS_MODEL_PACK_REVISION_SHORT}-linux-x64-cuda`,
    kind: 'model-pack',
    fileName: `speakrs-models-${SPEAKRS_MODEL_PACK_REVISION_SHORT}-win32-x64-cuda.tar.gz`,
    archiveFormat: 'tar.gz',
    architecture: 'x64',
    cudaMajor: 12,
    downloadUrl: 'https://github.com/AmirArshad/meeting-transcriber/releases/download/speakrs-models-5d24ffe-r1/speakrs-models-5d24ffe-win32-x64-cuda.tar.gz',
    sha256: 'a79973647cb787bf2aebd31acc2668d282735e41d451e244308bcf04ea77ad20',
    sizeBytes: 208765985,
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
  if (key === 'win32-x64' || key === 'linux-x64') {
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
    requiredDynamicLibraries: Array.isArray(artifact.requiredDynamicLibraries)
      ? artifact.requiredDynamicLibraries.map((entry) => ({ ...entry }))
      : undefined,
  }));
}

function getSpeakrsRequiredRuntimeLibraryNames(platformOrKey, arch) {
  const key = arch ? platformKey(platformOrKey, arch) : platformOrKey;
  if (key === 'linux-x64') {
    return [...SPEAKRS_ORT_SO_NAMES, ...SPEAKRS_CUDA_RUNTIME_SO_NAMES];
  }
  if (key === 'win32-x64' || !platformOrKey) {
    return [...SPEAKRS_ORT_DLL_NAMES, ...SPEAKRS_CUDA_RUNTIME_DLL_NAMES];
  }
  return [];
}

function getSpeakrsRequiredRuntimeDllNames() {
  return getSpeakrsRequiredRuntimeLibraryNames('win32-x64');
}

function getSpeakrsSetupTimeArtifactBasenames(artifacts = SPEAKRS_ORT_RUNTIME_ARTIFACTS) {
  const names = [];
  for (const platformArtifacts of Object.values(artifacts || {})) {
    for (const artifact of platformArtifacts || []) {
      if (artifact && typeof artifact.fileName === 'string' && artifact.fileName) {
        names.push(artifact.fileName);
      }
    }
  }
  return [...new Set(names)].sort();
}

function assertSpeakrsLinuxRequiredDynamicLibraryClosure({
  runtimeArtifacts = getSpeakrsRuntimeArtifacts('linux-x64'),
  requiredLibraries,
  managedLibraries = getLinuxCudaRequiredLibraries(),
} = {}) {
  const artifacts = Array.isArray(runtimeArtifacts) ? runtimeArtifacts : [];
  const fromArtifacts = artifacts
    .map((artifact) => artifact && artifact.requiredDynamicLibraries)
    .find((list) => Array.isArray(list));
  const required = requiredLibraries || fromArtifacts;
  if (!Array.isArray(required) || required.length === 0) {
    throw new Error('Linux Speakrs runtime pin is missing requiredDynamicLibraries.');
  }

  const extractedByName = new Map();
  for (const artifact of artifacts) {
    const keepFileNames = Array.isArray(artifact && artifact.keepFileNames) ? artifact.keepFileNames : [];
    const files = artifact && artifact.extractedFiles;
    for (const name of keepFileNames) {
      extractedByName.set(name, {
        kind: artifact.kind,
        relativePath: artifact.dynamicLibraryDir
          ? path.posix.join(artifact.dynamicLibraryDir, name)
          : name,
        pin: files && files[name],
      });
    }
  }

  const requiredNames = new Set();
  for (const entry of required) {
    if (!entry || typeof entry.name !== 'string' || !entry.name || typeof entry.source !== 'string') {
      throw new Error('Speakrs required dynamic library entry is incomplete.');
    }
    if (requiredNames.has(entry.name)) {
      throw new Error(`Speakrs required dynamic library is duplicated: ${entry.name}`);
    }
    requiredNames.add(entry.name);
    if (entry.source === 'cuda-provider-needed') {
      throw new Error(`Speakrs required library is missing a pinned artifact: ${entry.name}`);
    }
    if (entry.source === 'system' || entry.source === 'nvidia-driver') {
      continue;
    }
    if (entry.source === 'managed-cuda-runtime') {
      const managed = (managedLibraries || []).find((library) => library.fileName === entry.name);
      if (
        !managed
        || typeof managed.relativePath !== 'string'
        || !managed.relativePath
        || !isPinnedSha256(managed.sha256)
        || !Number.isInteger(managed.sizeBytes)
        || managed.sizeBytes <= 0
      ) {
        throw new Error(`Speakrs required library is missing from the managed CUDA catalog: ${entry.name}`);
      }
      if (entry.relativePath && entry.relativePath !== managed.relativePath) {
        throw new Error(`Speakrs managed CUDA library path mismatch: ${entry.name}`);
      }
      if (entry.sha256 && entry.sha256 !== managed.sha256) {
        throw new Error(`Speakrs managed CUDA library hash mismatch: ${entry.name}`);
      }
      if (
        entry.sizeBytes != null
        && (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes !== managed.sizeBytes)
      ) {
        throw new Error(`Speakrs managed CUDA library size mismatch: ${entry.name}`);
      }
      continue;
    }
    const expectedKind = SPEAKRS_REQUIRED_LIBRARY_SOURCE_KINDS[entry.source];
    const extracted = extractedByName.get(entry.name);
    if (
      !expectedKind
      || !extracted
      || extracted.kind !== expectedKind
      || !extracted.pin
      || !isPinnedSha256(extracted.pin.sha256)
      || !Number.isInteger(extracted.pin.sizeBytes)
      || extracted.pin.sizeBytes <= 0
    ) {
      throw new Error(`Speakrs required library is missing a pinned artifact: ${entry.name}`);
    }
    if (entry.relativePath && entry.relativePath !== extracted.relativePath) {
      throw new Error(`Speakrs required library path mismatch: ${entry.name}`);
    }
  }

  for (const name of extractedByName.keys()) {
    if (!requiredNames.has(name)) {
      throw new Error(`Speakrs extracted library is missing from requiredDynamicLibraries: ${name}`);
    }
  }
}

function getSpeakrsExtractedRuntimeDllPins(runtimeArtifacts, platformOrKey, arch) {
  const expectedNames = getSpeakrsRequiredRuntimeLibraryNames(platformOrKey, arch);
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

function formatSpeakrsProgressSize(sizeBytes) {
  const bytes = Number(sizeBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) {
    const rounded = mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10;
    return `${rounded} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function getSpeakrsSetupProgressCopy(artifact = {}) {
  const sizeLabel = formatSpeakrsProgressSize(artifact.sizeBytes);
  const sized = (label) => (sizeLabel ? `${label} (${sizeLabel}).` : `${label}.`);
  switch (artifact.kind) {
    case 'model-pack':
      return {
        downloading: sized('Downloading Speakrs speaker model'),
        installing: 'Installing Speakrs speaker model.',
      };
    case 'ort-archive':
      return {
        downloading: sized('Downloading ONNX Runtime for Speakrs CUDA'),
        installing: 'Installing ONNX Runtime for Speakrs CUDA.',
      };
    case 'cuda-runtime-wheel':
      return {
        downloading: sized('Downloading CUDA runtime library (cudart)'),
        installing: 'Installing CUDA runtime library (cudart).',
      };
    case 'cufft-wheel':
      return {
        downloading: sized('Downloading CUDA FFT library (cufft)'),
        installing: 'Installing CUDA FFT library (cufft).',
      };
    case 'curand-wheel':
      return {
        downloading: sized('Downloading CUDA random library (curand)'),
        installing: 'Installing CUDA random library (curand).',
      };
    case 'nvrtc-wheel':
      return {
        downloading: sized('Downloading CUDA compiler library (nvrtc)'),
        installing: 'Installing CUDA compiler library (nvrtc).',
      };
    default:
      return {
        downloading: sized('Downloading Speakrs runtime'),
        installing: 'Installing Speakrs runtime.',
      };
  }
}

assertPinnedRevision();
assertSpeakrsLinuxRequiredDynamicLibraryClosure();

module.exports = {
  PYANNOTE_DIARIZATION_MODEL_ID,
  SPEAKRS_CUDA_RUNTIME_DLL_NAMES,
  SPEAKRS_CUDA_RUNTIME_SO_NAMES,
  SPEAKRS_DIARIZATION_ENGINES,
  SPEAKRS_DIARIZATION_MODEL_ID,
  SPEAKRS_LINUX_REQUIRED_DYNAMIC_LIBRARIES,
  SPEAKRS_MODEL_FILES,
  SPEAKRS_MODEL_PACK_REVISION,
  SPEAKRS_MODEL_PACK_REVISION_SHORT,
  SPEAKRS_MODELS_REPO,
  SPEAKRS_MODEL_PACK_ARTIFACTS,
  SPEAKRS_ORT_DLL_NAMES,
  SPEAKRS_ORT_RUNTIME_ARTIFACTS,
  SPEAKRS_ORT_SO_NAMES,
  buildSpeakrsSourceArtifacts,
  buildSpeakrsSourceDownloadUrl,
  assertSpeakrsLinuxRequiredDynamicLibraryClosure,
  getSpeakrsExtractedRuntimeDllPins,
  getSpeakrsPackFileName,
  getSpeakrsModelPackArtifact,
  getSpeakrsRequiredRuntimeDllNames,
  getSpeakrsRequiredRuntimeLibraryNames,
  getSpeakrsRuntimeArtifacts,
  getSpeakrsSetupProgressCopy,
  getSpeakrsSetupTimeArtifactBasenames,
  getSpeakrsSourceFiles,
  getSpeakrsPackFileName,
  getSpeakrsModelPackArtifact,
  getSpeakrsRequiredRuntimeDllNames,
  getSpeakrsRequiredRuntimeLibraryNames,
  getSpeakrsRuntimeArtifacts,
  getSpeakrsSetupProgressCopy,
  getSpeakrsSourceFiles,
  getSpeakrsSourceTotalBytes,
  isPinnedSha256,
  normalizeSpeakrsRelativePath,
  platformKey,
  resolveContainedSpeakrsPath,
};
