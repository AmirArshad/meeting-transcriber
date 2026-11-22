const fs = require('fs');
const path = require('path');
const { getSummaryLanguagePolicy } = require('./summary-language-policy');

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
const MiB = 1024 ** 2;
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
    description: 'Short overview with key points and next steps.',
    outputBudget: 'small',
  },
  {
    id: DEFAULT_SUMMARY_PROFILE,
    label: 'Balanced',
    description: 'Standard summary with topics, decisions, action items, risks, and open questions.',
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
          { path: 'cuda-12.8/libllama-batched-bench-impl.so', sha256: 'bfc7f5b06489b32cb7571aae17e00a38d9183053866ec62f8f31acd07170876e', sizeBytes: 48728 },
          { path: 'cuda-12.8/libllama-bench-impl.so', sha256: '13fdf38028578f8589772083bfdf2f633e4c165b21422eccd664b7a90eacd35f', sizeBytes: 477232 },
          { path: 'cuda-12.8/libllama-completion-impl.so', sha256: 'ab47d089a8caa591361fe65adb3b740ecfac1fa3470932962b5b414619ddfd34', sizeBytes: 118040 },
          { path: 'cuda-12.8/libllama-fit-params-impl.so', sha256: '971a049515b1a05a475a966387165331989ac16acb69946ae595884a39f0fe49', sizeBytes: 39632 },
          { path: 'cuda-12.8/libllama-perplexity-impl.so', sha256: '83c9756a557010e3f3761b36650602061c61dd4a14aa9ebd037b8d1efc01cc34', sizeBytes: 171400 },
          { path: 'cuda-12.8/libllama-quantize-impl.so', sha256: 'f9e42108824d145d263027399c5a06a125e67875e3277abfe021440dbd598142', sizeBytes: 85928 },
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
    id: 'pyannote-audio-4.0.7-win32-x64-cuda-12.6',
    label: 'pyannote.audio 4.0.7 for Windows CUDA 12.6',
    platform: 'win32',
    arch: 'x64',
    acceleration: 'cuda',
    package: 'pyannote.audio',
    version: '4.0.7',
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
        'pyannote.audio==4.0.7',
        'torch==2.13.0+cu126',
        'torchvision==0.28.0+cu126',
        'torchaudio==2.11.0+cu126',
        'torchcodec==0.16.0',
        'julius==0.2.7',
        'certifi==2026.10.19',
      ],
    },
    validationStatus: 'ready',
  },
  'darwin-arm64': {
    id: 'pyannote-audio-4.0.7-darwin-arm64-mps',
    label: 'pyannote.audio 4.0.7 for macOS Metal/MPS',
    platform: 'darwin',
    arch: 'arm64',
    acceleration: 'mps',
    package: 'pyannote.audio',
    version: '4.0.7',
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
        'pyannote.audio==4.0.7',
        'torch==2.13.0',
        'torchaudio==2.11.0',
        'torchcodec==0.16.0',
        'julius==0.2.7',
        'certifi==2026.10.19',
      ],
    },
    validationStatus: 'ready',
  },
});

const LEGACY_GEMMA_LLAMA_CPP_RUNTIME = deepFreeze({
  runtime: 'llama.cpp',
  version: 'b12606',
  repository: 'ggml-org/llama.cpp',
  commit: 'e412c6f468b7b9e0f16f2540244236f8ad68e9ae',
  releaseUrl: 'https://github.com/ggml-org/llama.cpp/releases/tag/b12606',
});

const B12631_LLAMA_CPP_RUNTIME = deepFreeze({
  runtime: 'llama.cpp',
  version: 'b12631',
  repository: 'ggml-org/llama.cpp',
  commit: 'e300919cc704ddde3a8a8346a8714f57eeeee71b',
  releaseUrl: 'https://github.com/ggml-org/llama.cpp/releases/tag/b12631',
});

function llamaRuntimeArchive(fileName, sizeBytes, sha256, expandedBytes, downloadUrl) {
  return {
    fileName, sizeBytes, sha256, expandedBytes, downloadUrl,
    archiveFormat: fileName.endsWith('.zip') ? 'zip' : 'tar.gz',
  };
}

function b12631RuntimeArchive(assetId, fileName, sizeBytes, sha256, expandedBytes) {
  return llamaRuntimeArchive(fileName, sizeBytes, sha256, expandedBytes,
    `https://api.github.com/repos/ggml-org/llama.cpp/releases/assets/${assetId}`);
}

const B12631_SUMMARY_RUNTIME_ARTIFACTS = deepFreeze({
  'win32-x64': {
    ...SUMMARY_RUNTIME_ARTIFACTS['win32-x64'], ...B12631_LLAMA_CPP_RUNTIME,
    id: 'llama-cpp-b12631-win32-x64-cuda-12.4',
    label: 'llama.cpp b12631 for Windows CUDA 12.4',
    artifacts: [
      b12631RuntimeArchive(778480590, 'llama-b12631-bin-win-cuda-12.4-x64.zip', 357975625, '2c0a950896f370185f704ef0bc4085278462c444049c47158007af870515aef5', 833394973),
      b12631RuntimeArchive(778477150, 'cudart-llama-bin-win-cuda-12.4-x64.zip', 391443627, '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6', 574138880),
    ],
  },
  'darwin-arm64': {
    ...SUMMARY_RUNTIME_ARTIFACTS['darwin-arm64'], ...B12631_LLAMA_CPP_RUNTIME,
    id: 'llama-cpp-b12631-darwin-arm64-metal',
    label: 'llama.cpp b12631 for macOS Metal',
    artifacts: [
      b12631RuntimeArchive(778478489, 'llama-b12631-bin-macos-arm64.tar.gz', 16599970, '8de65a20e743b27405f05e6f89c636b879fd040fdd2c9abd4730fc0632ca49a5', 42656342),
    ],
  },
  'linux-x64': {
    id: 'llama-cpp-b12631-linux-x64-cuda-12.8',
    label: 'llama.cpp b12631 for Linux CUDA 12.8',
    ...B12631_LLAMA_CPP_RUNTIME,
    platform: 'linux',
    arch: 'x64',
    acceleration: 'cuda',
    cudaMajor: 12,
    executableName: 'llama-cli',
    runtimeFamilies: ['llama-cpp-cuda'],
    artifacts: [
      {
        id: 'ggml-llama-cpp-b12631-linux-x64-cuda-12.8',
        ...b12631RuntimeArchive(778478682, 'llama-b12631-bin-ubuntu-cuda-12.8-x64.tar.gz', 220074287, '7d5cbac777defa888ed81bd7095da5d8eff780538254faed50ab4303eeaa7408', 281493150),
        license: 'MIT',
        licenseUrl: `https://github.com/ggml-org/llama.cpp/blob/${B12631_LLAMA_CPP_RUNTIME.commit}/LICENSE`,
        architecture: 'x64',
        cudaMajor: 12,
        requiredFiles: [
          { path: 'llama-b12631/LICENSE', sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d', sizeBytes: 1078 },
          { path: 'llama-b12631/libggml-base.so.1.0.0', sha256: 'b89fc3461bf5b9838253977a48a58d7afa7534a3d592df31217cbb3fb225c546', sizeBytes: 966176 },
          { path: 'llama-b12631/libggml-cpu-alderlake.so', sha256: '6d817558f7269f46d9e9da0e7daa876e3f8b457d3afa427808da3bb6e2fa6239', sizeBytes: 1467072 },
          { path: 'llama-b12631/libggml-cpu-cannonlake.so', sha256: 'b8d829247ed3f4b1f46eacd7d6a4f7a5927f095b2e34bd56fd9a4e37480bde66', sizeBytes: 1658768 },
          { path: 'llama-b12631/libggml-cpu-cascadelake.so', sha256: '625474ea20f41cb56ef9ca1ec0a56f32293f5d4f6b49e8ae4efa512d142d0037', sizeBytes: 1670760 },
          { path: 'llama-b12631/libggml-cpu-cooperlake.so', sha256: 'da3dcb7b1ca1bf4cf5c762c48736f3d93f357b8c08bd96158577c211da23d1b2', sizeBytes: 1670928 },
          { path: 'llama-b12631/libggml-cpu-haswell.so', sha256: '68575ce4c322a01337b51e619cb05dd9a6e689c0e08fa48a2b229820c2fa732e', sizeBytes: 1467072 },
          { path: 'llama-b12631/libggml-cpu-icelake.so', sha256: '28a87dbe24532571e2eaa723e3104d57b577adf9e94250f14da61197fc1e7177', sizeBytes: 1670760 },
          { path: 'llama-b12631/libggml-cpu-ivybridge.so', sha256: 'acc0c5cee38f5e0c32d2de04cb15370b272b0273aef37395d4f92230e52a9f67', sizeBytes: 1390448 },
          { path: 'llama-b12631/libggml-cpu-piledriver.so', sha256: 'd817ad67b7f21cdbe3a879d4135d02c1eb5ce0f899d4d4ade1f7d2e368bffac6', sizeBytes: 1386352 },
          { path: 'llama-b12631/libggml-cpu-sandybridge.so', sha256: 'c4160dc6e3a1caed4b70c541d28434ec556545c37f0183934a604f1f8a8c46c1', sizeBytes: 1367888 },
          { path: 'llama-b12631/libggml-cpu-sapphirerapids.so', sha256: 'e9183dfb0f414c025c9d7302f7eb0577ff7bfdf7e268d6d4f4e2f5ec80084a92', sizeBytes: 1908552 },
          { path: 'llama-b12631/libggml-cpu-skylakex.so', sha256: 'c0bc665dfcd3a1993e53d34ffbeade191842456a19793ee6ded6011dbefe44b4', sizeBytes: 1658768 },
          { path: 'llama-b12631/libggml-cpu-sse42.so', sha256: '0df6daff2f4833a9c8637f0f9057cf07c5cdc2c4558037206eac1b6ea0af9021', sizeBytes: 1041072 },
          { path: 'llama-b12631/libggml-cpu-x64.so', sha256: '2de33a1cb7cb68f7c8ad9334b2957c5ce52edc4c953f3ea2e6f29a48fbc25fd7', sizeBytes: 1041032 },
          { path: 'llama-b12631/libggml-cpu-zen4.so', sha256: '0e321797776f08e6622db5e7139a9cd80aac02a4e33e2c31ab7bcaa5d84c0dc4', sizeBytes: 1670928 },
          { path: 'llama-b12631/libggml-cuda.so', sha256: '4b92fb5e27706888483990d00adeb2285b2e8cd833acc8bdb6469dbeccc2ccf7', sizeBytes: 222094192 },
          { path: 'llama-b12631/libggml-rpc.so', sha256: '1f291405edbd170e88e058521ccb2487ac99528198559512f1b3625303bc0781', sizeBytes: 328096 },
          { path: 'llama-b12631/libggml.so.1.0.0', sha256: '543a065a12a6bfa7a99e0d98ea35fe68c7944c404e1f3d1849292e7b29812db7', sizeBytes: 55960 },
          { path: 'llama-b12631/libllama-batched-bench-impl.so', sha256: '97b0a82b2446fcd79b98ccb9aee20d516d1a3d1e902412f746d2c89600dce9b6', sizeBytes: 44656 },
          { path: 'llama-b12631/libllama-bench-impl.so', sha256: 'e0b28764fea076c9ac95c352f112dd418df92f7cc50186f2711f1e6d19007802', sizeBytes: 490056 },
          { path: 'llama-b12631/libllama-cli-impl.so', sha256: '4837b21b843ec47eb633fb1a796adaea26d55aeddb25c7f45af9060af4d18459', sizeBytes: 268744 },
          { path: 'llama-b12631/libllama-common.so.1.0.0', sha256: 'c82a1e35a8c9224a0ca0ae377bfbabcbc408d14a234588422f6674e2394dc36c', sizeBytes: 6922664 },
          { path: 'llama-b12631/libllama-completion-impl.so', sha256: '52a8c0ae67d5ebfe1def7e6acd45d30dfc448fe0d32f1a5029fa0b81ab13e6f7', sizeBytes: 137912 },
          { path: 'llama-b12631/libllama-fit-params-impl.so', sha256: '7287ec8e2e63c11df4620f94b03748a196fc1f1ed48ec445521932632206e9a7', sizeBytes: 44344 },
          { path: 'llama-b12631/libllama-perplexity-impl.so', sha256: '2e970cff073bd3c4292c34c0556b7f39b0b2cfbf587d0003bcfb384367c3e6f3', sizeBytes: 164776 },
          { path: 'llama-b12631/libllama-quantize-impl.so', sha256: 'e165409b432cacd4c61c4e2c1031a220b5f0207a2710731c5a15a6061901cc38', sizeBytes: 94344 },
          { path: 'llama-b12631/libllama-server-impl.so', sha256: '2d388ce24422ebeb201d8addc4dd8ff3bc42381062e64dbf1b1291e9c0afc6b2', sizeBytes: 7739360 },
          { path: 'llama-b12631/libllama.so.1.0.0', sha256: '2e1d3d2de3e177f2da1c62d953379f96b1dabffdb91b6baed90672fe0399b06b', sizeBytes: 5780248 },
          { path: 'llama-b12631/libmtmd.so.1.0.0', sha256: '53897ca3e0f4f60a4b3718a4b7b7d40163bdd9e80c765ec1fdec585f88729c00', sizeBytes: 3015248 },
          { path: 'llama-b12631/llama-cli', sha256: 'a530e7d98d8102c891387ef054778c482afdb187f16ce057170b0fefb9e2ccde', sizeBytes: 1493760 },
          { path: 'llama-b12631/llama-server', sha256: '9b62f53a7aeb67ce4c91a11589c4af3bbbcf6fd1da5c80682c286045cbffac79', sizeBytes: 30872 },
        ],
      },
      {
        id: 'ggml-llama-cpp-b12631-cudart-linux-x64-cuda-12.8',
        kind: 'cuda-runtime-archive',
        ...b12631RuntimeArchive(778475193, 'cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64.tar.gz', 594376039, '5e921d59295bc67642055b73d348a6c488e375a910185523bf89fca9fb795cc6', 868893264),
        architecture: 'x64',
        cudaMajor: 12,
        dynamicLibraryDir: 'cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64',
        license: 'NVIDIA proprietary',
        licenseUrl: 'https://docs.nvidia.com/cuda/eula/index.html',
        requiredFiles: [
          { path: 'cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64/libcublas.so.12', sha256: '18a5df540d156e9aff0363776fefab7884b614f122847b51c3eb1da772048e5c', sizeBytes: 116388640 },
          { path: 'cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64/libcublasLt.so.12', sha256: '974927b9af78cadc0412ea3ab296da791af02c2dd0de5a35b5f0fbb8dc5d0a4d', sizeBytes: 751775824 },
          { path: 'cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64/libcudart.so.12', sha256: 'c3a75b33af334a3486d197dbd1584a2985183ba4688d237a2be5f2f679329920', sizeBytes: 728800 },
        ],
      },
    ],
    requiredDynamicLibraries: [
      { fileName: 'libcudart.so.12', source: 'summary-runtime', relativePath: 'cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64/libcudart.so.12' },
      { fileName: 'libcublas.so.12', source: 'summary-runtime', relativePath: 'cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64/libcublas.so.12' },
      { fileName: 'libcublasLt.so.12', source: 'summary-runtime', relativePath: 'cudart-llama-b12631-bin-ubuntu-cuda-12.8-x64/libcublasLt.so.12' },
      { fileName: 'libcuda.so.1', source: 'nvidia-driver', relativePath: null },
      { fileName: 'libssl.so.3', source: 'system', relativePath: null },
      { fileName: 'libcrypto.so.3', source: 'system', relativePath: null },
      { fileName: 'libstdc++.so.6', source: 'system', relativePath: null },
      { fileName: 'libgcc_s.so.1', source: 'system', relativePath: null },
      { fileName: 'libm.so.6', source: 'system', relativePath: null },
      { fileName: 'libgomp.so.1', source: 'system', relativePath: null },
      { fileName: 'libpthread.so.0', source: 'system', relativePath: null },
      { fileName: 'libdl.so.2', source: 'system', relativePath: null },
      { fileName: 'librt.so.1', source: 'system', relativePath: null },
    ],
    validationStatus: 'ready',
  },
});

const GEMMA_SUMMARY_RUNTIME_ARTIFACTS = deepFreeze({
  'win32-x64': {
    ...SUMMARY_RUNTIME_ARTIFACTS['win32-x64'], ...LEGACY_GEMMA_LLAMA_CPP_RUNTIME,
    id: 'llama-cpp-b12606-win32-x64-cuda-12.4',
    label: 'llama.cpp b12606 for Windows CUDA 12.4',
    artifacts: [
      llamaRuntimeArchive('llama-b12606-bin-win-cuda-12.4-x64.zip', 357938811, '23d08378e6771e5a4b8daf139d6ee53191d0ab2acd2cf7777ae9cefc74c9d958', 833257245,
        'https://github.com/ggml-org/llama.cpp/releases/download/b12606/llama-b12606-bin-win-cuda-12.4-x64.zip'),
      { ...SUMMARY_RUNTIME_ARTIFACTS['win32-x64'].artifacts[1], expandedBytes: 574138880 },
    ],
  },
  'darwin-arm64': {
    ...SUMMARY_RUNTIME_ARTIFACTS['darwin-arm64'], ...LEGACY_GEMMA_LLAMA_CPP_RUNTIME,
    id: 'llama-cpp-b12606-darwin-arm64-metal',
    label: 'llama.cpp b12606 for macOS Metal',
    artifacts: [
      llamaRuntimeArchive('llama-b12606-bin-macos-arm64.tar.gz', 16576375, '8d277d8a1289202e0553cf6489801303624973807ae6d07c666a61ea70a0e1c4', 42612678,
        'https://github.com/ggml-org/llama.cpp/releases/download/b12606/llama-b12606-bin-macos-arm64.tar.gz'),
    ],
  },
  'linux-x64': B12631_SUMMARY_RUNTIME_ARTIFACTS['linux-x64'],
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
  'gemma-4-e4b': buildHuggingFaceModelSource({
    repo: 'ggml-org/gemma-4-E4B-it-GGUF', revision: '8903cb408c7df39cde2ed15fac397e6d7be92951',
    fileName: 'gemma-4-E4B-it-Q4_0.gguf', sha256: 'a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2', sizeBytes: 4590807392,
  }),
  'gemma-4-12b': buildHuggingFaceModelSource({
    repo: 'ggml-org/gemma-4-12B-it-GGUF', revision: '501d13dba70e3c02b1b12c78fd9e6b08ad413960',
    fileName: 'gemma-4-12B-it-Q4_0.gguf', sha256: '3712b9bd32cae83a22f67ee7a4466d8d7a4f21646ac8a07d19bf9418e8767a70', sizeBytes: 7219673216,
  }),
  'inkling-2-mini': buildHuggingFaceModelSource({
    repo: 'ggml-org/Inkling-2-Mini-GGUF', revision: 'e8a2cecf0e78914f07cc27b9be711a9b2c7561d9',
    fileName: 'Inkling-2-Mini-IQ4_NL.gguf', sha256: 'cbdf3fa9dc50a4124977980f37da4f1fa764b0cfe800d275cd43d26ce2a81af4', sizeBytes: 17627940768,
  }),
  'bonsai-2-9b-q2-0': buildHuggingFaceModelSource({
    repo: 'prism-ml/Ternary-Bonsai-2-9B-gguf', revision: '82265ccc78ddaac4700286a35e9badcc32376dd9',
    fileName: 'Ternary-Bonsai-2-9B-Q2_0.gguf', sha256: '1f884aa56aacd2bbbb2e4b7abaead2b1102b74a9c75a23fc33dab916813a384d', sizeBytes: 2556640128,
  }),
  'bonsai-2-27b-q2-0': buildHuggingFaceModelSource({
    repo: 'prism-ml/Ternary-Bonsai-2-27B-gguf', revision: '839bd57023c1558945afea70a74fa83c054f35f9',
    fileName: 'Ternary-Bonsai-2-27B-Q2_0.gguf', sha256: '4f99aed01b8a877e153f9aa6569a4440fe17c59701cc0953e36d7f460549e70e', sizeBytes: 7626008928,
  }),
  'ministral-3-14b': buildHuggingFaceModelSource({
    repo: 'unsloth/Ministral-3-14B-Instruct-2512-GGUF', revision: '9b948841b705cc11285ff274b84ba6c885908b19',
    fileName: 'Ministral-3-14B-Instruct-2512-Q4_K_M.gguf', sha256: '76ce697c065f2e40f1e8e958118b02cab38e2c10a6015f7d7908036a292dc8c8', sizeBytes: 8239067840,
  }),
  'gemma-4-26b-a4b': buildHuggingFaceModelSource({
    repo: 'ggml-org/gemma-4-26B-A4B-it-GGUF', revision: '1ca99aae748b4b01f609fa51eb23682ee5f00b85',
    fileName: 'gemma-4-26B-A4B-it-Q4_0.gguf', sha256: 'd208665ab1cd3a69f7a9a4bc59430e8448c8093d9b06334f566ac59d6d504a03', sizeBytes: 14618145824,
  }),
  'qwen3.8-27b': buildHuggingFaceModelSource({
    repo: 'unsloth/Qwen3.8-27B-GGUF', revision: '4af51b3542f775b0a8e4b310bfb3f17e01c306c9',
    fileName: 'Qwen3.8-27B-UD-Q4_K_M.gguf', sha256: '1bce504dfecd84153666928a41d8a66706f0158d3a317bc5196b72819d7dc529', sizeBytes: 16564259744,
  }),
});

function buildSummaryArtifact({ modelId, label, runtimeArchitecture, runtimeCatalog = null }) {
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
      ...(runtimeCatalog === 'b12631' || runtimeArchitecture === 'gemma4' || runtimeArchitecture === 'inkling2_loop'
        ? B12631_LLAMA_CPP_RUNTIME
        : PINNED_LLAMA_CPP_RUNTIME),
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

function gemmaSummaryModel(id, label, description, memoryGuidance, { tier = 'balanced', runtimeCatalog = 'gemma' } = {}) {
  return {
    id, label, description, memoryGuidance,
    tier,
    family: 'Gemma 4',
    runtime: 'llama.cpp',
    runtimeCatalog,
    artifact: buildSummaryArtifact({ modelId: id, label, runtimeArchitecture: 'gemma4', runtimeCatalog }),
    inference: { contextTokens: 32768, family: 'gemma', promptFormat: 'gemma', disableThinking: true, singleTurnOnly: true },
    profiles: SUMMARY_PROFILES.map((profile) => profile.id),
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
    gemmaRuntimeArtifacts: GEMMA_SUMMARY_RUNTIME_ARTIFACTS,
    b12631RuntimeArtifacts: B12631_SUMMARY_RUNTIME_ARTIFACTS,
    models: [
      {
        id: DEFAULT_SUMMARY_MODEL_ID,
        label: 'Qwen3.5 9B',
        description: 'Balanced choice for everyday questions and summaries.',
        tier: 'balanced',
        memoryGuidance: { gpu: 8, unified: 16 },
        family: 'Qwen3.5',
        runtime: 'llama.cpp',
        role: 'default',
        inference: {
          contextTokens: 32768,
          family: 'qwen',
          promptFormat: 'chatml',
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
        label: 'Qwen3.5 4B',
        description: 'Uses less memory for quick recaps and simple questions.',
        tier: 'compact',
        memoryGuidance: { gpu: 6, unified: 8 },
        family: 'Qwen3.5',
        runtime: 'llama.cpp',
        role: 'lowMemoryReplacement',
        inference: {
          contextTokens: 32768,
          family: 'qwen',
          promptFormat: 'chatml',
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
        id: 'bonsai-2-9b-q2-0',
        label: 'Bonsai 2 9B',
        description: 'Compact ternary 9B model for quick questions on lower-memory devices.',
        tier: 'compact',
        memoryGuidance: { gpu: 6, unified: 8, minLinuxCudaRuntimeBytes: 3429 * MiB },
        family: 'Bonsai 2',
        runtime: 'llama.cpp',
        runtimeCatalog: 'b12631',
        inference: {
          contextTokens: 32768,
          family: 'qwen',
          promptFormat: 'chatml',
          architecture: 'qwen35',
          disableThinking: true,
          singleTurnOnly: true,
          reasoningEffort: 'none',
          reasoningBudget: 0,
        },
        artifact: buildSummaryArtifact({
          modelId: 'bonsai-2-9b-q2-0',
          label: 'Bonsai 2 9B Q2_0 GGUF',
          runtimeArchitecture: 'qwen35',
          runtimeCatalog: 'b12631',
        }),
        profiles: SUMMARY_PROFILES.map((profile) => profile.id),
      },
      gemmaSummaryModel('gemma-4-e4b', 'Gemma 4 E4B', 'An option for follow-up questions about details across recordings.', { gpu: 8, unified: 16, minRuntimeBytes: 5331582976 }, { tier: 'balanced', runtimeCatalog: 'gemma' }),
      gemmaSummaryModel('gemma-4-12b', 'Gemma 4 12B', 'An option for pulling together themes and decisions from longer recordings.', { gpu: 12, unified: 16, minRuntimeBytes: 8409792512 }, { tier: 'balanced', runtimeCatalog: 'gemma' }),
      {
        id: 'bonsai-2-27b-q2-0',
        label: 'Bonsai 2 27B',
        description: 'Ternary model for more involved questions and longer recordings.',
        tier: 'balanced',
        memoryGuidance: { gpu: 12, unified: 16, minLinuxCudaRuntimeBytes: 9306 * MiB },
        family: 'Bonsai 2',
        runtime: 'llama.cpp',
        runtimeCatalog: 'b12631',
        inference: {
          contextTokens: 32768,
          family: 'qwen',
          promptFormat: 'chatml',
          architecture: 'qwen35',
          disableThinking: true,
          singleTurnOnly: true,
          reasoningEffort: 'none',
          reasoningBudget: 0,
        },
        artifact: buildSummaryArtifact({
          modelId: 'bonsai-2-27b-q2-0',
          label: 'Bonsai 2 27B Q2_0 GGUF',
          runtimeArchitecture: 'qwen35',
          runtimeCatalog: 'b12631',
        }),
        profiles: SUMMARY_PROFILES.map((profile) => profile.id),
      },
      {
        id: 'ministral-3-14b',
        label: 'Ministral 3 14B',
        description: 'Fast non-reasoning 14B instruction model for crisp answers and recaps.',
        tier: 'balanced',
        memoryGuidance: { gpu: 16, unified: 24 },
        family: 'Ministral 3',
        runtime: 'llama.cpp',
        runtimeCatalog: 'b12631',
        inference: {
          contextTokens: 32768,
          family: 'mistral',
          promptFormat: 'mistral',
          architecture: 'mistral3',
          disableThinking: true,
          singleTurnOnly: true,
        },
        artifact: buildSummaryArtifact({
          modelId: 'ministral-3-14b',
          label: 'Ministral 3 14B Q4_K_M GGUF',
          runtimeArchitecture: 'mistral3',
          runtimeCatalog: 'b12631',
        }),
        profiles: SUMMARY_PROFILES.map((profile) => profile.id),
      },
      gemmaSummaryModel('gemma-4-26b-a4b', 'Gemma 4 26B-A4B', 'Mixture-of-experts model with fast 4B-active decode for deeper cross-recording questions.', { gpu: 16, unified: 24 }, { tier: 'high-capability', runtimeCatalog: 'b12631' }),
      {
        id: 'qwen3.8-27b',
        label: 'Qwen 3.8 27B',
        description: 'High-capability 27B hybrid-attention model for demanding analysis on workstation hardware.',
        tier: 'high-capability',
        memoryGuidance: { gpu: 24, unified: 32 },
        family: 'Qwen3.8',
        runtime: 'llama.cpp',
        runtimeCatalog: 'b12631',
        inference: {
          contextTokens: 32768,
          family: 'qwen',
          promptFormat: 'chatml',
          architecture: 'qwen38',
          disableThinking: true,
          singleTurnOnly: true,
          reasoningEffort: 'none',
          reasoningBudget: 0,
        },
        artifact: buildSummaryArtifact({
          modelId: 'qwen3.8-27b',
          label: 'Qwen 3.8 27B UD-Q4_K_M GGUF',
          runtimeArchitecture: 'qwen38',
          runtimeCatalog: 'b12631',
        }),
        profiles: SUMMARY_PROFILES.map((profile) => profile.id),
      },
      {
        id: 'inkling-2-mini',
        label: 'Inkling 2 Mini',
        description: 'Intended for longer, more involved questions on high-memory devices.',
        tier: 'high-capability',
        memoryGuidance: { gpu: 24, unified: 32, minRuntimeBytes: 19217088512 },
        family: 'Inkling 2',
        runtime: 'llama.cpp',
        runtimeCatalog: 'b12631',
        inference: {
          contextTokens: 32768,
          family: 'inkling',
          promptFormat: 'chatml',
          disableThinking: true,
          singleTurnOnly: true,
          reasoningEffort: 'none',
          reasoningBudget: 0,
        },
        artifact: buildSummaryArtifact({ modelId: 'inkling-2-mini', label: 'Inkling 2 Mini', runtimeArchitecture: 'inkling2_loop', runtimeCatalog: 'b12631' }),
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

  if (!model || !artifact || !platformArtifact || (model.supportedPlatforms && model.supportedPlatforms[platform]?.status !== 'enabled')) {
    return null;
  }

  const selectedRuntime = (model.runtimeCatalog === 'gemma' && catalog.summary.gemmaRuntimeArtifacts?.[platformKey])
    || (model.runtimeCatalog === 'b12631' && catalog.summary.b12631RuntimeArtifacts?.[platformKey]);
  const llamaCpp = selectedRuntime ? {
    runtime: selectedRuntime.runtime,
    version: selectedRuntime.version,
    repository: selectedRuntime.repository,
    commit: selectedRuntime.commit,
    releaseUrl: selectedRuntime.releaseUrl,
    validationStatus: selectedRuntime.validationStatus,
  } : artifact.llamaCpp || null;

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
    llamaCpp,
    platform: platformArtifact.platform || platform,
    arch: platformArtifact.arch || arch,
    acceleration: platformArtifact.acceleration || null,
    runtime: platformArtifact.runtime || model.runtime || null,
    runtimeArchitecture: platformArtifact.runtimeArchitecture || model.inference?.architecture || null,
    inference: model.inference ? { ...model.inference } : null,
    artifactId: platformArtifact.id || `${model.id}-${platformKey}`,
    label: platformArtifact.label || model.label,
  };
}

function getSummaryRuntimeArtifactForPlatform(platform = process.platform, arch = process.arch, catalog = AI_MODEL_CATALOG, modelId) {
  const model = modelId && getModelById('summary', modelId, catalog);
  if (model?.supportedPlatforms && model.supportedPlatforms[platform]?.status !== 'enabled') return null;
  let runtimeArtifacts = catalog?.summary?.runtimeArtifacts || SUMMARY_RUNTIME_ARTIFACTS;
  if (model?.runtimeCatalog === 'gemma') {
    runtimeArtifacts = catalog.summary.gemmaRuntimeArtifacts;
  } else if (model?.runtimeCatalog === 'b12631') {
    runtimeArtifacts = catalog.summary.b12631RuntimeArtifacts;
  }
  const runtimeArtifact = runtimeArtifacts?.[`${platform}-${arch}`];
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
    ...(typeof state.speakrsInstallId === 'string' && /^[0-9a-f]{32}$/.test(state.speakrsInstallId)
      ? { speakrsInstallId: state.speakrsInstallId }
      : {}),
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
    ...(state.removalPending === true ? { removalPending: true, replacementModelId: normalizeNullableString(state.replacementModelId) } : {}),
  };
}

function normalizeAiAddonManifest(value = {}, catalog = AI_MODEL_CATALOG) {
  const manifest = asPlainObject(value);
  const features = asPlainObject(manifest.features);

  const summary = normalizeSummaryState(features.summary || manifest.summary, catalog);
  const sourceLibrary = asPlainObject(manifest.summaryLibrary);
  const sourceModels = asPlainObject(sourceLibrary.models);
  const models = {};
  for (const model of getModelList('summary', catalog)) {
    if (sourceModels[model.id]) models[model.id] = normalizeSummaryState(sourceModels[model.id], catalog);
  }
  // A legacy ready installation remains available without downloading it again.
  if (!Object.hasOwn(manifest, 'summaryLibrary') && summary.status === 'ready') models[summary.modelId] = summary;
  const requestedDefault = normalizeNullableString(sourceLibrary.defaultModelId);
  const defaultModelId = requestedDefault && models[requestedDefault] ? requestedDefault
    : (!Object.hasOwn(manifest, 'summaryLibrary') && summary.status === 'ready' ? summary.modelId : null);
  const syncedSummary = defaultModelId && models[defaultModelId]
    ? { ...models[defaultModelId], profile: models[defaultModelId].profile || summary.profile }
    : summary;
  return {
    manifestVersion: MANIFEST_VERSION,
    features: {
      diarization: normalizeDiarizationState(features.diarization || manifest.diarization, catalog),
      summary: syncedSummary,
    },
    summaryLibrary: { defaultModelId, models },
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

const LINUX_DIARIZATION_UNAVAILABLE_REASON = 'Speaker identification on Linux requires an NVIDIA GPU (x86_64) and the CUDA 12 runtime installed in GPU Acceleration. CPU mode is not supported.';
const LINUX_SUMMARY_UNAVAILABLE_REASON = 'Summaries and Chat on Linux require an NVIDIA GPU (x86_64) and the CUDA 12 runtime installed in GPU Acceleration. CPU and cloud modes are not supported.';
const LINUX_PYANNOTE_UNAVAILABLE_REASON = 'Pyannote is not available on Linux. Use Speakrs instead.';

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
  return `Speaker identification on Linux requires an NVIDIA GPU and the CUDA 12 runtime.${detail} CPU mode is not supported.`;
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
      reason: 'Speaker identification on macOS requires Apple Silicon. Intel Macs are not supported.',
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
      summary: {
        ...applyAvailability(normalizedManifest.features.summary, summaryAvailability),
        languagePolicy: getSummaryLanguagePolicy(normalizedManifest.features.summary.modelId, platform, arch),
      },
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
