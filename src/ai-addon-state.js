const fs = require('fs');
const path = require('path');

const {
  PYANNOTE_DIARIZATION_MODEL_ID,
  SPEAKRS_DIARIZATION_ENGINES,
  SPEAKRS_DIARIZATION_MODEL_ID,
  SPEAKRS_MODEL_PACK_REVISION,
  SPEAKRS_MODEL_PACK_REVISION_SHORT,
  SPEAKRS_MODELS_REPO,
  getSpeakrsModelPackArtifact,
  getSpeakrsRuntimeArtifacts,
} = require('./ai-addon/speakrs-pack-spec');

const MANIFEST_VERSION = 1;
const DEFAULT_SUMMARY_PROFILE = 'balanced';
const DEFAULT_DIARIZATION_MODEL_ID = SPEAKRS_DIARIZATION_MODEL_ID;
const DEFAULT_SUMMARY_MODEL_ID = 'qwen3.5-9b-q4-k-m';
const DIARIZATION_ENGINE_SET = new Set(SPEAKRS_DIARIZATION_ENGINES);

const AI_ADDON_STATUS_STATES = Object.freeze([
  'notConfigured',
  'needsAccount',
  'downloading',
  'validating',
  'ready',
  'error',
  'unsupported',
]);

const STATUS_SET = new Set(AI_ADDON_STATUS_STATES);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

const SUMMARY_PROFILES = Object.freeze([
  {
    id: 'concise',
    label: 'Concise',
    description: 'Short overview with the most important decisions and next steps.',
    outputBudget: 'small',
  },
  {
    id: DEFAULT_SUMMARY_PROFILE,
    label: 'Balanced',
    description: 'Default meeting notes with topics, decisions, actions, risks, and questions.',
    outputBudget: 'medium',
  },
  {
    id: 'detailed',
    label: 'Detailed',
    description: 'More topic coverage and supporting timestamps for longer reviews.',
    outputBudget: 'large',
  },
  {
    id: 'action-items',
    label: 'Action items',
    description: 'Prioritizes owners, tasks, due dates, blockers, and follow-up questions.',
    outputBudget: 'medium',
  },
]);

const SUMMARY_PROFILE_IDS = new Set(SUMMARY_PROFILES.map((profile) => profile.id));

const PINNED_LLAMA_CPP_RUNTIME = deepFreeze({
  runtime: 'llama.cpp',
  version: 'b9173',
  repository: 'ggml-org/llama.cpp',
  commit: '49d1701bd24e4cedf6dfec9e50e185111203946b',
  releaseUrl: 'https://github.com/ggml-org/llama.cpp/releases/tag/b9173',
});

const SUMMARY_RUNTIME_ARTIFACTS = deepFreeze({
  'win32-x64': {
    id: 'llama-cpp-b9173-win32-x64-cuda-12.4',
    label: 'llama.cpp b9173 for Windows CUDA 12.4',
    runtime: 'llama.cpp',
    version: PINNED_LLAMA_CPP_RUNTIME.version,
    repository: PINNED_LLAMA_CPP_RUNTIME.repository,
    commit: PINNED_LLAMA_CPP_RUNTIME.commit,
    platform: 'win32',
    arch: 'x64',
    acceleration: 'cuda',
    executableName: 'llama-cli.exe',
    runtimeFamilies: ['llama-cpp-cuda'],
    artifacts: [
      {
        fileName: 'llama-b9173-bin-win-cuda-12.4-x64.zip',
        archiveFormat: 'zip',
        sha256: 'b8bdbe94f84579b0ba70c909b2b4aae5e31b38bd301edca37fc9ad10884e7a2b',
        sizeBytes: 218285832,
        downloadUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b9173/llama-b9173-bin-win-cuda-12.4-x64.zip',
      },
      {
        fileName: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
        archiveFormat: 'zip',
        sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
        sizeBytes: 391443627,
        downloadUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b9173/cudart-llama-bin-win-cuda-12.4-x64.zip',
      },
    ],
    validationStatus: 'ready',
  },
  'darwin-arm64': {
    id: 'llama-cpp-b9173-darwin-arm64-metal',
    label: 'llama.cpp b9173 for macOS Metal',
    runtime: 'llama.cpp',
    version: PINNED_LLAMA_CPP_RUNTIME.version,
    repository: PINNED_LLAMA_CPP_RUNTIME.repository,
    commit: PINNED_LLAMA_CPP_RUNTIME.commit,
    platform: 'darwin',
    arch: 'arm64',
    acceleration: 'metal',
    executableName: 'llama-cli',
    runtimeFamilies: ['llama-cpp-metal'],
    artifacts: [
      {
        fileName: 'llama-b9173-bin-macos-arm64.tar.gz',
        archiveFormat: 'tar.gz',
        sha256: '18764a5a179e023a3007a3a32b309febbe249f63c5716a6827428435f7439ff8',
        sizeBytes: 8467310,
        downloadUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b9173/llama-b9173-bin-macos-arm64.tar.gz',
      },
    ],
    validationStatus: 'ready',
  },
  'linux-x64': {
    id: 'llama-cpp-v0.3.0-linux-x64-cuda-12.8',
    label: 'llama.cpp v0.3.0 for Linux CUDA 12.8',
    runtime: 'llama.cpp',
    version: 'v0.3.0',
    repository: 'ai-dock/llama.cpp-cuda',
    sourceCommit: 'c1d0e7a004015f23bc0233470b747b596f29b264',
    upstreamRepository: 'ggml-org/llama.cpp',
    upstreamCommit: 'c1d0e7a004015f23bc0233470b747b596f29b264',
    releaseUrl: 'https://github.com/ai-dock/llama.cpp-cuda/releases/tag/v0.3.0',
    platform: 'linux',
    arch: 'x64',
    acceleration: 'cuda',
    cudaMajor: 12,
    executableName: 'llama-cli',
    runtimeFamilies: ['llama-cpp-cuda'],
    artifacts: [
      {
        id: 'ai-dock-llama-cpp-v0.3.0-linux-x64-cuda-12.8',
        fileName: 'llama.cpp-v0.3.0-cuda-12.8-amd64.tar.gz',
        archiveFormat: 'tar.gz',
        sha256: '37616f0271e82717eb8ddcd5d2319fd845ddcf93c83fd3943d0a1a539c1d0a99',
        sizeBytes: 150794376,
        downloadUrl: 'https://github.com/ai-dock/llama.cpp-cuda/releases/download/v0.3.0/llama.cpp-v0.3.0-cuda-12.8-amd64.tar.gz',
        license: 'llama.cpp MIT; ai-dock build scripts MIT',
        licenseUrl: 'https://github.com/ai-dock/llama.cpp-cuda/blob/main/LICENSE',
        architecture: 'x64',
        cudaMajor: 12,
        requiredFiles: [
          { path: 'cuda-12.8/llama-cli', sha256: '9ae3a204f56b5218073e74684f49acdb7d84ed1ef234e3123fc7d21c32a2b373', sizeBytes: 1056232 },
          { path: 'cuda-12.8/libllama-cli-impl.so', sha256: 'a8b81f3c2008ce7f9c25468fdbd8af35deb6bfe6675fd3fc55bd41354e11ae76', sizeBytes: 259416 },
          { path: 'cuda-12.8/libllama-server-impl.so', sha256: '5559f96a135980886ceddd05b11e5fe9afc334a02eede5b72c41533fa5939873', sizeBytes: 7096728 },
          { path: 'cuda-12.8/libllama-common.so.0.3.0', sha256: '105f5c906c38198380f40bff0cbda9cee42409b7beb9fe38597a6b95e0c0b091', sizeBytes: 6027112 },
          { path: 'cuda-12.8/libllama.so.0.3.0', sha256: '65928a659c17d319ecfb63ae502ae0780e9db7829f9c5eb89127505835016b12', sizeBytes: 4394216 },
          { path: 'cuda-12.8/libmtmd.so.0.3.0', sha256: 'dd2c69476ea7151a1171a0437280c449ae6a2deccf686e186650a1a24ef3bad9', sizeBytes: 1846792 },
          { path: 'cuda-12.8/libggml.so.0.22.0', sha256: '80f07c76209b5cb2c09e88626291740ffae86c02ba2264cb0208dcff65d13a4c', sizeBytes: 55184 },
          { path: 'cuda-12.8/libggml-base.so.0.22.0', sha256: '9bfb6ffbb21c541f33da770bd3cc0668284fe59a34c2aeae1012d67e97d39ae1', sizeBytes: 919464 },
          { path: 'cuda-12.8/libggml-cpu.so.0.22.0', sha256: '4ce9f1238a99726061b50d0990890c7c927134495a0d7ceb426f3e47652601bb', sizeBytes: 1140744 },
          { path: 'cuda-12.8/libggml-cuda.so.0.22.0', sha256: '2b639645c6fd9584a8b9facccfde737ddb0a713d8b584ccd6f1af032c8768fb6', sizeBytes: 162060960 },
          { path: 'cuda-12.8/VERSION.txt', sha256: '60c4ffeeab994decbb52291518d291768634170d05bcd07329b7b08c21333853', sizeBytes: 217 },
        ],
      },
      {
        id: 'nvidia-cuda-runtime-cu12-12.9.79-linux-x64-summary',
        kind: 'cuda-runtime-wheel',
        fileName: 'nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
        archiveFormat: 'zip',
        architecture: 'x64',
        cudaMajor: 12,
        dynamicLibraryDir: 'nvidia/cuda_runtime/lib',
        sha256: '25bba2dfb01d48a9b59ca474a1ac43c6ebf7011f1b0b8cc44f54eb6ac48a96c3',
        sizeBytes: 3493179,
        downloadUrl: 'https://files.pythonhosted.org/packages/bc/46/a92db19b8309581092a3add7e6fceb4c301a3fd233969856a8cbf042cd3c/nvidia_cuda_runtime_cu12-12.9.79-py3-none-manylinux2014_x86_64.manylinux_2_17_x86_64.whl',
        license: 'NVIDIA proprietary',
        licenseUrl: 'https://docs.nvidia.com/cuda/eula/index.html',
        extractedFiles: {
          'libcudart.so.12': {
            path: 'nvidia/cuda_runtime/lib/libcudart.so.12',
            sha256: '256e6409e4f06f618e1fb53d4844a6b81cdded1013afa8ade40c22f99eb133b7',
            sizeBytes: 741088,
          },
        },
      },
      {
        id: 'nvidia-nccl-cu12-2.31.2-linux-x64-summary',
        kind: 'nccl-wheel',
        fileName: 'nvidia_nccl_cu12-2.31.2-py3-none-manylinux_2_18_x86_64.whl',
        archiveFormat: 'zip',
        architecture: 'x64',
        cudaMajor: 12,
        dynamicLibraryDir: 'nvidia/nccl/lib',
        sha256: 'f9b1dc3c2a7e20176054144ebb3b32fea83b40402ee5d7ac7045cd11ecc956c0',
        sizeBytes: 342105414,
        downloadUrl: 'https://files.pythonhosted.org/packages/0f/36/104de52d6368f5b7f886e8fd252e0a438fe73a215e59b1b47f93a80ae2ea/nvidia_nccl_cu12-2.31.2-py3-none-manylinux_2_18_x86_64.whl',
        license: 'NVIDIA Software License Agreement (wheel LICENSE.txt)',
        licenseUrl: 'https://files.pythonhosted.org/packages/0f/36/104de52d6368f5b7f886e8fd252e0a438fe73a215e59b1b47f93a80ae2ea/nvidia_nccl_cu12-2.31.2-py3-none-manylinux_2_18_x86_64.whl#nvidia/nccl/lib/LICENSE.txt',
        licenseFile: 'nvidia/nccl/lib/LICENSE.txt',
        extractedFiles: {
          'libnccl.so.2': {
            path: 'nvidia/nccl/lib/libnccl.so.2',
            sha256: 'dba12e429fe11268b895d0531ba96a7f679f35227d5b1ec77c5febbcd02281bd',
            sizeBytes: 473266472,
          },
        },
      },
    ],
    requiredDynamicLibraries: [
      { fileName: 'libcudart.so.12', source: 'summary-runtime', relativePath: 'nvidia/cuda_runtime/lib/libcudart.so.12' },
      { fileName: 'libcublas.so.12', source: 'managed-cuda12', relativePath: 'nvidia/cublas/lib/libcublas.so.12' },
      { fileName: 'libcublasLt.so.12', source: 'managed-cuda12', relativePath: 'nvidia/cublas/lib/libcublasLt.so.12' },
      { fileName: 'libnccl.so.2', source: 'summary-runtime', relativePath: 'nvidia/nccl/lib/libnccl.so.2' },
      { fileName: 'libcuda.so.1', source: 'nvidia-driver', relativePath: null },
      { fileName: 'libssl.so.3', source: 'system', relativePath: null },
      { fileName: 'libcrypto.so.3', source: 'system', relativePath: null },
      { fileName: 'libz.so.1', source: 'system', relativePath: null },
      { fileName: 'libstdc++.so.6', source: 'system', relativePath: null },
      { fileName: 'libgcc_s.so.1', source: 'system', relativePath: null },
      { fileName: 'libm.so.6', source: 'system', relativePath: null },
      { fileName: 'libbrotlienc.so.1', source: 'system', relativePath: null },
      { fileName: 'libbrotlidec.so.1', source: 'system', relativePath: null },
      { fileName: 'libbrotlicommon.so.1', source: 'system', relativePath: null },
      { fileName: 'libzstd.so.1', source: 'system', relativePath: null },
      { fileName: 'libgomp.so.1', source: 'system', relativePath: null },
      { fileName: 'libpthread.so.0', source: 'system', relativePath: null },
      { fileName: 'libdl.so.2', source: 'system', relativePath: null },
      { fileName: 'librt.so.1', source: 'system', relativePath: null },
    ],
    validationStatus: 'ready',
  },
});

const DIARIZATION_DEPENDENCY_ARTIFACTS = deepFreeze({
  'win32-x64': {
    id: 'pyannote-audio-4.0.1-win32-x64-cuda-12.6',
    label: 'pyannote.audio 4.0.1 for Windows CUDA 12.6',
    platform: 'win32',
    arch: 'x64',
    acceleration: 'cuda',
    package: 'pyannote.audio',
    version: '4.0.1',
    installTarget: 'userData',
    runtimeFamilies: ['pytorch-cuda'],
    estimatedDownloadBytes: 4 * 1024 * 1024 * 1024,
    pip: {
      indexUrl: 'https://pypi.org/simple',
      extraIndexUrls: ['https://download.pytorch.org/whl/cu126'],
      allowSourceBuilds: false,
      sourceArtifacts: [
        {
          package: 'julius',
          version: '0.2.7',
          fileName: 'julius-0.2.7.tar.gz',
          url: 'https://files.pythonhosted.org/packages/a1/19/c9e1596b5572c786b93428d0904280e964c930fae7e6c9368ed9e1b63922/julius-0.2.7.tar.gz',
          sha256: '3c0f5f5306d7d6016fcc95196b274cae6f07e2c9596eed314e4e7641554fbb08',
        },
      ],
      requirements: [
        'pyannote.audio==4.0.1',
        'torch==2.8.0+cu126',
        'torchvision==0.23.0+cu126',
        'torchaudio==2.8.0+cu126',
        'torchcodec==0.7.0',
        'julius==0.2.7',
      ],
    },
    validationStatus: 'ready',
  },
  'darwin-arm64': {
    id: 'pyannote-audio-4.0.1-darwin-arm64-mps',
    label: 'pyannote.audio 4.0.1 for macOS Metal/MPS',
    platform: 'darwin',
    arch: 'arm64',
    acceleration: 'mps',
    package: 'pyannote.audio',
    version: '4.0.1',
    installTarget: 'userData',
    runtimeFamilies: ['pytorch-mps'],
    estimatedDownloadBytes: 2 * 1024 * 1024 * 1024,
    pip: {
      indexUrl: 'https://pypi.org/simple',
      extraIndexUrls: [],
      allowSourceBuilds: false,
      sourceArtifacts: [
        {
          package: 'julius',
          version: '0.2.7',
          fileName: 'julius-0.2.7.tar.gz',
          url: 'https://files.pythonhosted.org/packages/a1/19/c9e1596b5572c786b93428d0904280e964c930fae7e6c9368ed9e1b63922/julius-0.2.7.tar.gz',
          sha256: '3c0f5f5306d7d6016fcc95196b274cae6f07e2c9596eed314e4e7641554fbb08',
        },
      ],
      requirements: [
        'pyannote.audio==4.0.1',
        'torch==2.8.0',
        'torchaudio==2.8.0',
        'torchcodec==0.7.0',
        'julius==0.2.7',
      ],
    },
    validationStatus: 'ready',
  },
});

function buildHuggingFaceModelSource({ repo, revision, fileName, sha256, sizeBytes }) {
  return {
    provider: 'huggingface',
    repo,
    revision,
    fileName,
    gated: false,
    license: 'apache-2.0',
    lfsSha256: sha256,
    sizeBytes,
    downloadUrl: `https://huggingface.co/${repo}/resolve/${revision}/${fileName}`,
  };
}

const SUMMARY_MODEL_SOURCES = deepFreeze({
  'qwen3.5-9b-q4-k-m': buildHuggingFaceModelSource({
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    revision: '3885219b6810b007914f3a7950a8d1b469d598a5',
    fileName: 'Qwen3.5-9B-Q4_K_M.gguf',
    sha256: '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
    sizeBytes: 5680522464,
  }),
  'qwen3.5-4b-q4-k-m': buildHuggingFaceModelSource({
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    revision: 'e87f176479d0855a907a41277aca2f8ee7a09523',
    fileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    sizeBytes: 2740937888,
  }),
  'qwen3-14b-q4-k-m': buildHuggingFaceModelSource({
    repo: 'Qwen/Qwen3-14B-GGUF',
    revision: '530227a7d994db8eca5ab5ced2fb692b614357fd',
    fileName: 'Qwen3-14B-Q4_K_M.gguf',
    sha256: '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0',
    sizeBytes: 9001752960,
  }),
});

function buildSummaryArtifact({ modelId, label, runtimeArchitecture }) {
  const artifactBaseId = `${modelId}-gguf`;
  const source = SUMMARY_MODEL_SOURCES[modelId];
  const validationStatus = source && source.lfsSha256 && source.downloadUrl ? 'ready' : 'pendingPinnedArtifact';

  return {
    format: 'gguf',
    distribution: 'optional-setup-artifact',
    fileName: source ? source.fileName : null,
    sha256: source ? source.lfsSha256 : null,
    downloadUrl: source ? source.downloadUrl : null,
    estimatedSizeBytes: source ? source.sizeBytes : null,
    source: source || null,
    validationStatus,
    llamaCpp: {
      ...PINNED_LLAMA_CPP_RUNTIME,
      validationStatus: 'ready',
    },
    platformArtifacts: {
      'win32-x64': {
        id: `${artifactBaseId}-win32-x64-cuda`,
        label: `${label} for Windows CUDA`,
        platform: 'win32',
        arch: 'x64',
        acceleration: 'cuda',
        runtime: 'llama.cpp',
        runtimeArchitecture,
        fileName: source ? source.fileName : null,
        sha256: source ? source.lfsSha256 : null,
        downloadUrl: source ? source.downloadUrl : null,
        source: source || null,
        validationStatus,
      },
      'darwin-arm64': {
        id: `${artifactBaseId}-darwin-arm64-metal`,
        label: `${label} for macOS Metal`,
        platform: 'darwin',
        arch: 'arm64',
        acceleration: 'metal',
        runtime: 'llama.cpp',
        runtimeArchitecture,
        fileName: source ? source.fileName : null,
        sha256: source ? source.lfsSha256 : null,
        downloadUrl: source ? source.downloadUrl : null,
        source: source || null,
        validationStatus,
      },
      'linux-x64': {
        id: `${artifactBaseId}-linux-x64-cuda`,
        label: `${label} for Linux CUDA`,
        platform: 'linux',
        arch: 'x64',
        acceleration: 'cuda',
        runtime: 'llama.cpp',
        runtimeArchitecture,
        fileName: source ? source.fileName : null,
        sha256: source ? source.lfsSha256 : null,
        downloadUrl: source ? source.downloadUrl : null,
        source: source || null,
        validationStatus,
      },
    },
  };
}

const AI_MODEL_CATALOG = deepFreeze({
  version: 1,
  diarization: {
    defaultModelId: DEFAULT_DIARIZATION_MODEL_ID,
    dependencyArtifacts: DIARIZATION_DEPENDENCY_ARTIFACTS,
    models: [
      {
        id: SPEAKRS_DIARIZATION_MODEL_ID,
        engine: 'speakrs',
        label: 'Speaker identification (speakrs)',
        provider: 'huggingface',
        license: 'MIT + CC-BY-4.0 + Apache-2.0 (see pack ATTRIBUTION.md)',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        licenseUrls: {
          segmentation: 'https://github.com/pyannote/pyannote-audio/blob/develop/LICENSE',
          embeddingAndPlda: 'https://creativecommons.org/licenses/by/4.0/',
          speakrs: 'https://github.com/avencera/speakrs/blob/v0.5.0/LICENSE',
          onnxRuntime: 'https://github.com/microsoft/onnxruntime/blob/v1.27.1/LICENSE',
        },
        gated: false,
        tokenRequired: false,
        termsRequired: false,
        runtime: {
          type: 'native-cli',
          executableName: 'speakrs-cli',
          modeByPlatform: {
            'win32-x64': 'cuda',
            'darwin-arm64': 'coreml',
            'linux-x64': 'cuda',
          },
        },
        packRevision: SPEAKRS_MODEL_PACK_REVISION,
        packRevisionShort: SPEAKRS_MODEL_PACK_REVISION_SHORT,
        sourceRepo: SPEAKRS_MODELS_REPO,
        packArtifacts: {
          'win32-x64': [
            {
              ...getSpeakrsModelPackArtifact('win32-x64'),
            },
            ...getSpeakrsRuntimeArtifacts('win32-x64'),
          ],
          'darwin-arm64': [
            {
              ...getSpeakrsModelPackArtifact('darwin-arm64'),
            },
          ],
          'linux-x64': [
            {
              ...getSpeakrsModelPackArtifact('linux-x64'),
            },
            ...getSpeakrsRuntimeArtifacts('linux-x64'),
          ],
        },
        supportedPlatforms: {
          win32: { acceleration: 'cuda', status: 'enabled' },
          darwin: { acceleration: 'coreml', arch: 'arm64', status: 'enabled' },
          linux: { acceleration: 'cuda', arch: 'x64', status: 'enabled' },
        },
      },
      {
        id: PYANNOTE_DIARIZATION_MODEL_ID,
        engine: 'pyannote',
        label: 'pyannote Speaker Diarization Community-1',
        provider: 'huggingface',
        license: 'cc-by-4.0',
        licenseUrl: 'https://huggingface.co/pyannote/speaker-diarization-community-1',
        gated: true,
        tokenRequired: true,
        termsRequired: true,
        telemetryEnvironment: { PYANNOTE_METRICS_ENABLED: '0' },
        runtime: {
          type: 'python-module',
          package: 'pyannote.audio',
          modelRef: 'pyannote/speaker-diarization-community-1',
        },
        cache: {
          provider: 'huggingface',
          gated: true,
          tokenKey: 'diarization-huggingface-token',
        },
        supportedPlatforms: {
          win32: { acceleration: 'cuda', status: 'enabled' },
          darwin: { acceleration: 'mps', arch: 'arm64', status: 'enabled' },
        },
      },
    ],
  },
  summary: {
    defaultModelId: DEFAULT_SUMMARY_MODEL_ID,
    runtimeArtifacts: SUMMARY_RUNTIME_ARTIFACTS,
    models: [
      {
        id: DEFAULT_SUMMARY_MODEL_ID,
        label: 'Qwen3.5 9B 4-bit GGUF',
        family: 'Qwen3.5',
        runtime: 'llama.cpp',
        role: 'default',
        inference: {
          runtime: 'llama.cpp',
          architecture: 'qwen35',
          disableThinking: true,
          structuredOutput: 'json',
          windowsAcceleration: 'cuda',
          macosAcceleration: 'metal',
        },
        artifact: buildSummaryArtifact({
          modelId: DEFAULT_SUMMARY_MODEL_ID,
          label: 'Qwen3.5 9B Q4_K_M GGUF',
          runtimeArchitecture: 'qwen35',
        }),
        profiles: SUMMARY_PROFILES.map((profile) => profile.id),
      },
      {
        id: 'qwen3.5-4b-q4-k-m',
        label: 'Qwen3.5 4B 4-bit GGUF',
        family: 'Qwen3.5',
        runtime: 'llama.cpp',
        role: 'lowMemoryReplacement',
        inference: {
          runtime: 'llama.cpp',
          architecture: 'qwen35',
          disableThinking: true,
          structuredOutput: 'json',
          windowsAcceleration: 'cuda',
          macosAcceleration: 'metal',
        },
        artifact: buildSummaryArtifact({
          modelId: 'qwen3.5-4b-q4-k-m',
          label: 'Qwen3.5 4B Q4_K_M GGUF',
          runtimeArchitecture: 'qwen35',
        }),
        profiles: SUMMARY_PROFILES.map((profile) => profile.id),
      },
      {
        id: 'qwen3-14b-q4-k-m',
        label: 'Qwen3 14B 4-bit GGUF',
        family: 'Qwen3',
        runtime: 'llama.cpp',
        role: 'matureRuntimeReplacement',
        inference: {
          runtime: 'llama.cpp',
          architecture: 'qwen3',
          disableThinking: true,
          structuredOutput: 'json',
          windowsAcceleration: 'cuda',
          macosAcceleration: 'metal',
        },
        artifact: buildSummaryArtifact({
          modelId: 'qwen3-14b-q4-k-m',
          label: 'Qwen3 14B Q4_K_M GGUF',
          runtimeArchitecture: 'qwen3',
        }),
        profiles: SUMMARY_PROFILES.map((profile) => profile.id),
      },
    ],
  },
});

const CURATED_AI_MODELS = AI_MODEL_CATALOG;

function getModelList(feature, catalog = AI_MODEL_CATALOG) {
  const featureCatalog = catalog && catalog[feature];
  return Array.isArray(featureCatalog && featureCatalog.models) ? featureCatalog.models : [];
}

function getDefaultModelId(feature, catalog = AI_MODEL_CATALOG) {
  const featureCatalog = catalog && catalog[feature];
  const configuredDefault = featureCatalog && featureCatalog.defaultModelId;
  const models = getModelList(feature, catalog);

  if (configuredDefault && models.some((model) => model.id === configuredDefault)) {
    return configuredDefault;
  }

  return models[0] ? models[0].id : null;
}

function getModelById(feature, modelId, catalog = AI_MODEL_CATALOG) {
  return getModelList(feature, catalog).find((model) => model.id === modelId) || null;
}

function getDiarizationModelRef(modelId, catalog = AI_MODEL_CATALOG) {
  const resolvedModelId = resolveModelId('diarization', modelId, catalog);
  const model = getModelById('diarization', resolvedModelId, catalog);
  if (!model || !model.runtime) {
    return null;
  }
  if (model.runtime.modelRef) {
    return model.runtime.modelRef;
  }
  if (model.runtime.type === 'native-cli') {
    return resolvedModelId;
  }
  return null;
}

function getSpeakrsModelFromCatalog(catalog = AI_MODEL_CATALOG) {
  return getModelById('diarization', SPEAKRS_DIARIZATION_MODEL_ID, catalog)
    || getModelList('diarization', catalog).find((model) => model.engine === 'speakrs' || model.runtime?.type === 'native-cli')
    || null;
}

function getSpeakrsSetupArtifactsForPlatform(platform = process.platform, arch = process.arch, catalog = AI_MODEL_CATALOG) {
  const model = getSpeakrsModelFromCatalog(catalog);
  if (!model) {
    return null;
  }
  const key = `${platform}-${arch}`;
  const packEntries = Array.isArray(model.packArtifacts && model.packArtifacts[key])
    ? model.packArtifacts[key]
    : [];
  const modelPack = packEntries.find((entry) => entry.kind === 'model-pack') || null;
  const modelFiles = Array.isArray(modelPack?.requiredFiles)
    ? modelPack.requiredFiles.map((file) => ({ ...file }))
    : [];
  const runtimeArtifacts = packEntries
    .filter((entry) => entry && entry.kind && entry.kind !== 'model-pack')
    .map((entry) => ({
      ...entry,
      keepFileNames: Array.isArray(entry.keepFileNames) ? [...entry.keepFileNames] : [],
    }));

  return {
    modelId: model.id,
    engine: 'speakrs',
    revision: model.packRevision || SPEAKRS_MODEL_PACK_REVISION,
    runtime: model.runtime ? { ...model.runtime, modeByPlatform: { ...(model.runtime.modeByPlatform || {}) } } : null,
    modelPack: modelPack ? {
      ...modelPack,
      requiredFiles: modelFiles.map((file) => ({ ...file })),
    } : null,
    modelFiles,
    runtimeArtifacts,
    packEntries: packEntries.map((entry) => ({ ...entry })),
  };
}

function getSummaryArtifactForPlatform(modelId, platform = process.platform, arch = process.arch, catalog = AI_MODEL_CATALOG) {
  const resolvedModelId = resolveModelId('summary', modelId, catalog);
  const model = getModelById('summary', resolvedModelId, catalog);
  const artifact = model && model.artifact;
  const platformKey = `${platform}-${arch}`;
  const platformArtifact = artifact && artifact.platformArtifacts && artifact.platformArtifacts[platformKey];

  if (!model || !artifact || !platformArtifact) {
    return null;
  }

  return {
    modelId: model.id,
    modelLabel: model.label,
    format: artifact.format,
    distribution: artifact.distribution,
    fileName: platformArtifact.fileName || artifact.fileName,
    sha256: platformArtifact.sha256 || artifact.sha256 || null,
    downloadUrl: platformArtifact.downloadUrl || null,
    estimatedSizeBytes: artifact.estimatedSizeBytes || null,
    source: platformArtifact.source || artifact.source || null,
    validationStatus: platformArtifact.validationStatus || artifact.validationStatus || null,
    llamaCpp: artifact.llamaCpp || null,
    platform: platformArtifact.platform || platform,
    arch: platformArtifact.arch || arch,
    acceleration: platformArtifact.acceleration || null,
    runtime: platformArtifact.runtime || model.runtime || null,
    runtimeArchitecture: platformArtifact.runtimeArchitecture || model.inference?.architecture || null,
    artifactId: platformArtifact.id || `${model.id}-${platformKey}`,
    label: platformArtifact.label || model.label,
  };
}

function getSummaryRuntimeArtifactForPlatform(platform = process.platform, arch = process.arch, catalog = AI_MODEL_CATALOG) {
  const runtimeArtifacts = catalog?.summary?.runtimeArtifacts || SUMMARY_RUNTIME_ARTIFACTS;
  const runtimeArtifact = runtimeArtifacts[`${platform}-${arch}`];
  if (!runtimeArtifact) {
    return null;
  }

  return {
    ...runtimeArtifact,
    artifacts: Array.isArray(runtimeArtifact.artifacts)
      ? runtimeArtifact.artifacts.map((artifact) => ({ ...artifact }))
      : [],
  };
}

function getDiarizationDependencyArtifactForPlatform(platform = process.platform, arch = process.arch, catalog = AI_MODEL_CATALOG) {
  const dependencyArtifacts = catalog?.diarization?.dependencyArtifacts || DIARIZATION_DEPENDENCY_ARTIFACTS;
  const artifact = dependencyArtifacts[`${platform}-${arch}`];
  if (!artifact) {
    return null;
  }

  return {
    ...artifact,
    pip: {
      ...(artifact.pip || {}),
      extraIndexUrls: Array.isArray(artifact.pip?.extraIndexUrls) ? [...artifact.pip.extraIndexUrls] : [],
      sourceArtifacts: Array.isArray(artifact.pip?.sourceArtifacts) ? artifact.pip.sourceArtifacts.map((sourceArtifact) => ({ ...sourceArtifact })) : [],
      requirements: Array.isArray(artifact.pip?.requirements) ? [...artifact.pip.requirements] : [],
    },
  };
}

function resolveModelId(feature, requestedModelId, catalog = AI_MODEL_CATALOG) {
  const requested = typeof requestedModelId === 'string' && requestedModelId.trim()
    ? requestedModelId.trim()
    : null;

  if (requested && getModelById(feature, requested, catalog)) {
    return requested;
  }

  return getDefaultModelId(feature, catalog);
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeStatus(value, fallback = 'notConfigured') {
  return STATUS_SET.has(value) ? value : fallback;
}

function normalizeNullableString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeLastValidation(value) {
  const validation = asPlainObject(value);

  return {
    status: normalizeStatus(validation.status),
    checkedAt: normalizeNullableString(validation.checkedAt),
    message: normalizeNullableString(validation.message),
  };
}

function normalizeSpeakerCount(value) {
  if (value === 'auto' || value === undefined || value === null || value === '') {
    return 'auto';
  }

  const count = Number(value);
  return Number.isInteger(count) && count >= 2 && count <= 10 ? count : 'auto';
}

function normalizeSummaryProfile(value) {
  return SUMMARY_PROFILE_IDS.has(value) ? value : DEFAULT_SUMMARY_PROFILE;
}

function getCatalogDiarizationEngine(model) {
  if (!model) {
    return null;
  }
  if (DIARIZATION_ENGINE_SET.has(model.engine)) {
    return model.engine;
  }
  if (model.runtime?.type === 'native-cli') {
    return 'speakrs';
  }
  return 'pyannote';
}

function getDiarizationModelForEngine(engine, catalog = AI_MODEL_CATALOG) {
  return getModelList('diarization', catalog)
    .find((model) => getCatalogDiarizationEngine(model) === engine) || null;
}

function normalizeDiarizationSelection(state, catalog = AI_MODEL_CATALOG) {
  const requestedEngine = typeof state.engine === 'string' ? state.engine.trim().toLowerCase() : '';
  const requestedModelId = typeof state.modelId === 'string' && state.modelId.trim()
    ? state.modelId.trim()
    : null;
  const requestedModel = requestedModelId
    ? getModelById('diarization', requestedModelId, catalog)
    : null;
  const requestedModelEngine = getCatalogDiarizationEngine(requestedModel);
  const hasRequestedEngine = DIARIZATION_ENGINE_SET.has(requestedEngine)
    && Boolean(getDiarizationModelForEngine(requestedEngine, catalog));

  if (hasRequestedEngine) {
    return {
      engine: requestedEngine,
      modelId: requestedModel && requestedModelEngine === requestedEngine
        ? requestedModel.id
        : getDiarizationModelForEngine(requestedEngine, catalog).id,
    };
  }
  if (requestedModel && requestedModelEngine) {
    return { engine: requestedModelEngine, modelId: requestedModel.id };
  }

  const defaultModelId = getDefaultModelId('diarization', catalog);
  const defaultModel = getModelById('diarization', defaultModelId, catalog)
    || getModelList('diarization', catalog)[0]
    || null;
  const defaultEngine = getCatalogDiarizationEngine(defaultModel) || 'speakrs';
  return {
    engine: defaultEngine,
    modelId: defaultModel?.id || defaultModelId,
  };
}

function normalizeDiarizationState(value, catalog = AI_MODEL_CATALOG) {
  const state = asPlainObject(value);
  const selection = normalizeDiarizationSelection(state, catalog);

  return {
    status: normalizeStatus(state.status),
    engine: selection.engine,
    modelId: selection.modelId,
    speakerCount: normalizeSpeakerCount(state.speakerCount),
    lastValidation: normalizeLastValidation(state.lastValidation),
    error: normalizeNullableString(state.error),
  };
}

function normalizeSummaryState(value, catalog = AI_MODEL_CATALOG) {
  const state = asPlainObject(value);

  return {
    status: normalizeStatus(state.status),
    modelId: resolveModelId('summary', state.modelId, catalog),
    artifactId: normalizeNullableString(state.artifactId),
    profile: normalizeSummaryProfile(state.profile),
    lastValidation: normalizeLastValidation(state.lastValidation),
    error: normalizeNullableString(state.error),
  };
}

function normalizeAiAddonManifest(value = {}, catalog = AI_MODEL_CATALOG) {
  const manifest = asPlainObject(value);
  const features = asPlainObject(manifest.features);

  return {
    manifestVersion: MANIFEST_VERSION,
    features: {
      diarization: normalizeDiarizationState(features.diarization || manifest.diarization, catalog),
      summary: normalizeSummaryState(features.summary || manifest.summary, catalog),
    },
  };
}

function getAiAddonPaths(userDataDir) {
  const rootDir = path.join(String(userDataDir || ''), 'ai-addons');
  const modelCacheDir = path.join(rootDir, 'models');
  const dependencyCacheDir = path.join(rootDir, 'dependencies');

  return {
    rootDir,
    manifestPath: path.join(rootDir, 'manifest.json'),
    modelCacheDir,
    dependencyCacheDir,
    diarizationModelCacheDir: path.join(modelCacheDir, 'diarization'),
    diarizationDependencyCacheDir: path.join(dependencyCacheDir, 'diarization'),
    speakrsModelCacheDir: path.join(modelCacheDir, 'diarization', 'speakrs'),
    speakrsOrtRuntimeDir: path.join(rootDir, 'runtimes', 'speakrs-ort'),
    summaryModelCacheDir: path.join(modelCacheDir, 'summary'),
  };
}

const LINUX_DIARIZATION_UNAVAILABLE_REASON = 'Speaker identification on Linux requires the managed CUDA 12 runtime, an NVIDIA GPU, and x86_64. CPU-only speaker identification is not supported.';
const LINUX_SUMMARY_UNAVAILABLE_REASON = 'Local Qwen summaries on Linux require the managed CUDA 12 runtime, an NVIDIA GPU, verified x86_64 artifacts, and the packaged CUDA-only path. CPU, Vulkan, SYCL, ROCm, and cloud summaries are not supported.';
const LINUX_PYANNOTE_UNAVAILABLE_REASON = 'Pyannote speaker identification is not available on Linux in this version.';

function getLinuxSpeakrsUnavailableReason({ arch, cudaStatus } = {}) {
  if (arch !== 'x64') {
    return LINUX_DIARIZATION_UNAVAILABLE_REASON;
  }
  const { isLinuxCudaStatusReadyForAdmission } = require('./main-process/linux-cuda-runtime-helpers');
  if (isLinuxCudaStatusReadyForAdmission(cudaStatus)) {
    return null;
  }
  const detail = cudaStatus && (cudaStatus.error || cudaStatus.statusCode)
    ? ` ${String(cudaStatus.error || cudaStatus.statusCode).trim()}`
    : '';
  if (!detail) {
    return LINUX_DIARIZATION_UNAVAILABLE_REASON;
  }
  return `Speaker identification on Linux requires the managed CUDA 12 runtime and a working NVIDIA GPU.${detail} CPU-only speaker identification is not supported.`;
}

function getDiarizationAvailability(platform, arch, options = {}) {
  if (platform === 'win32' && arch === 'x64') {
    return {
      supported: true,
      reason: null,
      acceleration: 'cuda',
      runtimeDevice: 'cuda',
      automaticAfterTranscription: true,
    };
  }

  if (platform === 'darwin' && arch === 'arm64') {
    return {
      supported: true,
      reason: null,
      acceleration: 'mps',
      runtimeDevice: 'mps',
      automaticAfterTranscription: true,
    };
  }

  if (platform === 'darwin') {
    return {
      supported: false,
      reason: 'Speaker identification on macOS requires Apple Silicon with PyTorch Metal/MPS acceleration. CPU-only diarization is not supported.',
      acceleration: 'unsupported',
      runtimeDevice: null,
      automaticAfterTranscription: false,
    };
  }

  if (platform === 'linux') {
    const reason = getLinuxSpeakrsUnavailableReason({
      arch,
      cudaStatus: options && options.cudaStatus,
    });
    if (!reason) {
      return {
        supported: true,
        reason: null,
        acceleration: 'cuda',
        runtimeDevice: 'cuda',
        automaticAfterTranscription: true,
      };
    }
    return {
      supported: false,
      reason,
      acceleration: 'unsupported',
      runtimeDevice: null,
      automaticAfterTranscription: false,
    };
  }

  return {
    supported: false,
    reason: 'Speaker identification is not supported on this platform.',
    acceleration: 'unsupported',
    runtimeDevice: null,
    automaticAfterTranscription: false,
  };
}

function getLinuxSummaryUnavailableReason({ arch, cudaStatus } = {}) {
  if (arch !== 'x64') {
    return LINUX_SUMMARY_UNAVAILABLE_REASON;
  }
  const { isLinuxCudaStatusReadyForAdmission } = require('./main-process/linux-cuda-runtime-helpers');
  if (isLinuxCudaStatusReadyForAdmission(cudaStatus)) {
    return null;
  }
  const detail = cudaStatus && (cudaStatus.error || cudaStatus.statusCode)
    ? ` ${String(cudaStatus.error || cudaStatus.statusCode).trim()}`
    : '';
  return `${LINUX_SUMMARY_UNAVAILABLE_REASON}${detail}`;
}

function getSummaryAvailability(platform, arch, options = {}) {
  if ((platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64')) {
    return {
      supported: true,
      reason: null,
      runtime: 'llama.cpp',
      userTriggeredOnly: true,
    };
  }

  if (platform === 'linux') {
    const reason = getLinuxSummaryUnavailableReason({
      arch,
      cudaStatus: options && options.cudaStatus,
    });
    if (!reason) {
      return {
        supported: true,
        reason: null,
        runtime: 'llama.cpp',
        acceleration: 'cuda',
        runtimeDevice: 'cuda',
        userTriggeredOnly: true,
      };
    }
    return {
      supported: false,
      reason,
      runtime: 'unsupported',
      userTriggeredOnly: true,
    };
  }

  return {
    supported: false,
    reason: 'Local summaries are not supported on this platform.',
    runtime: 'unsupported',
    userTriggeredOnly: true,
  };
}

function applyAvailability(state, availability) {
  return {
    ...state,
    status: availability.supported ? state.status : 'unsupported',
    availability,
  };
}

function normalizeLinuxDiarizationState(state, platform) {
  if (platform !== 'linux' || state?.engine !== 'pyannote') {
    return state;
  }

  // A profile may have been created on Windows/macOS before it was opened on
  // Linux. Do not leave the sole visible Speakrs card tied to that hidden,
  // unsupported selection. This is a status projection only: setup still owns
  // the exclusive-engine migration and its cleanup.
  return {
    ...state,
    engine: 'speakrs',
    modelId: SPEAKRS_DIARIZATION_MODEL_ID,
    status: 'notConfigured',
    setupComplete: false,
    error: null,
    lastValidation: null,
  };
}

function buildManifestReadError(message, catalog = AI_MODEL_CATALOG) {
  return normalizeAiAddonManifest({
    features: {
      diarization: { status: 'error', error: message },
      summary: { status: 'error', error: message },
    },
  }, catalog);
}

function loadAiAddonManifest({ userDataDir, existsSync = fs.existsSync, readFileSync = fs.readFileSync, catalog = AI_MODEL_CATALOG } = {}) {
  const paths = getAiAddonPaths(userDataDir);

  if (!existsSync(paths.manifestPath)) {
    return {
      manifest: normalizeAiAddonManifest({}, catalog),
      readError: null,
      manifestPath: paths.manifestPath,
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(paths.manifestPath, 'utf8'));
    return {
      manifest: normalizeAiAddonManifest(parsed, catalog),
      readError: null,
      manifestPath: paths.manifestPath,
    };
  } catch (error) {
    const message = 'AI add-on setup state could not be read.';
    return {
      manifest: buildManifestReadError(message, catalog),
      readError: message,
      manifestPath: paths.manifestPath,
    };
  }
}

function buildAiAddonStatus({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  manifest,
  readError = null,
  catalog = AI_MODEL_CATALOG,
  cudaStatus = null,
} = {}) {
  const paths = getAiAddonPaths(userDataDir);
  const normalizedManifest = normalizeAiAddonManifest(manifest, catalog);
  const diarizationAvailability = getDiarizationAvailability(platform, arch, { cudaStatus });
  const summaryAvailability = getSummaryAvailability(platform, arch, { cudaStatus });
  const diarizationState = normalizeLinuxDiarizationState(
    normalizedManifest.features.diarization,
    platform,
  );

  return {
    manifestVersion: MANIFEST_VERSION,
    manifestPath: paths.manifestPath,
    modelCacheDir: paths.modelCacheDir,
    dependencyCacheDir: paths.dependencyCacheDir,
    modelCacheDirs: {
      diarization: paths.diarizationModelCacheDir,
      summary: paths.summaryModelCacheDir,
    },
    dependencyCacheDirs: {
      diarization: paths.diarizationDependencyCacheDir,
    },
    readError,
    statusStates: AI_ADDON_STATUS_STATES,
    summaryProfiles: SUMMARY_PROFILES,
    models: catalog,
    features: {
      diarization: applyAvailability(diarizationState, diarizationAvailability),
      summary: applyAvailability(normalizedManifest.features.summary, summaryAvailability),
    },
  };
}

function getAiAddonStatus({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  existsSync,
  readFileSync,
  catalog = AI_MODEL_CATALOG,
  cudaStatus = null,
} = {}) {
  const { manifest, readError } = loadAiAddonManifest({ userDataDir, existsSync, readFileSync, catalog });

  return buildAiAddonStatus({
    userDataDir,
    platform,
    arch,
    manifest,
    readError,
    catalog,
    cudaStatus,
  });
}

module.exports = {
  AI_ADDON_STATUS_STATES,
  AI_MODEL_CATALOG,
  CURATED_AI_MODELS,
  DEFAULT_DIARIZATION_MODEL_ID,
  PYANNOTE_DIARIZATION_MODEL_ID,
  SPEAKRS_DIARIZATION_MODEL_ID,
  DEFAULT_SUMMARY_MODEL_ID,
  DEFAULT_SUMMARY_PROFILE,
  DIARIZATION_DEPENDENCY_ARTIFACTS,
  MANIFEST_VERSION,
  PINNED_LLAMA_CPP_RUNTIME,
  SUMMARY_PROFILES,
  SUMMARY_RUNTIME_ARTIFACTS,
  buildAiAddonStatus,
  getAiAddonPaths,
  getAiAddonStatus,
  getDefaultModelId,
  LINUX_DIARIZATION_UNAVAILABLE_REASON,
  getLinuxSummaryUnavailableReason,
  LINUX_PYANNOTE_UNAVAILABLE_REASON,
  LINUX_SUMMARY_UNAVAILABLE_REASON,
  getDiarizationAvailability,
  getDiarizationDependencyArtifactForPlatform,
  getDiarizationModelRef,
  getSpeakrsSetupArtifactsForPlatform,
  getModelById,
  getModelList,
  getSummaryArtifactForPlatform,
  getSummaryRuntimeArtifactForPlatform,
  getSummaryAvailability,
  loadAiAddonManifest,
  normalizeAiAddonManifest,
  resolveModelId,
};
