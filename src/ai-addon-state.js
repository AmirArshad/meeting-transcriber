const fs = require('fs');
const path = require('path');

const MANIFEST_VERSION = 1;
const DEFAULT_SUMMARY_PROFILE = 'balanced';
const DEFAULT_DIARIZATION_MODEL_ID = 'pyannote/speaker-diarization-community-1';
const DEFAULT_SUMMARY_MODEL_ID = 'qwen3.5-9b-q4-k-m';

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
    pip: {
      indexUrl: 'https://pypi.org/simple',
      extraIndexUrls: ['https://download.pytorch.org/whl/cu126'],
      allowSourceBuilds: true,
      requirements: [
        'pyannote.audio==4.0.1',
        'torch==2.8.0+cu126',
        'torchaudio==2.8.0+cu126',
        'torchcodec==0.7.0',
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
        id: DEFAULT_DIARIZATION_MODEL_ID,
        label: 'pyannote Speaker Diarization Community-1',
        provider: 'huggingface',
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
          darwin: { acceleration: 'apple-silicon', status: 'disabledUntilValidated' },
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

function normalizeDiarizationState(value, catalog = AI_MODEL_CATALOG) {
  const state = asPlainObject(value);

  return {
    status: normalizeStatus(state.status),
    modelId: resolveModelId('diarization', state.modelId, catalog),
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
    summaryModelCacheDir: path.join(modelCacheDir, 'summary'),
  };
}

function getDiarizationAvailability(platform, arch) {
  if (platform === 'win32' && arch === 'x64') {
    return {
      supported: true,
      reason: null,
      acceleration: 'cuda',
      automaticAfterTranscription: true,
    };
  }

  if (platform === 'darwin') {
    return {
      supported: false,
      reason: 'macOS speaker identification is unavailable until accelerated Apple Silicon diarization is validated.',
      acceleration: arch === 'arm64' ? 'apple-silicon-pending-validation' : 'unsupported',
      automaticAfterTranscription: false,
    };
  }

  return {
    supported: false,
    reason: 'Speaker identification is not supported on this platform.',
    acceleration: 'unsupported',
    automaticAfterTranscription: false,
  };
}

function getSummaryAvailability(platform, arch) {
  if ((platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64')) {
    return {
      supported: true,
      reason: null,
      runtime: 'llama.cpp',
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

function buildAiAddonStatus({ userDataDir, platform = process.platform, arch = process.arch, manifest, readError = null, catalog = AI_MODEL_CATALOG } = {}) {
  const paths = getAiAddonPaths(userDataDir);
  const normalizedManifest = normalizeAiAddonManifest(manifest, catalog);
  const diarizationAvailability = getDiarizationAvailability(platform, arch);
  const summaryAvailability = getSummaryAvailability(platform, arch);

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
      diarization: applyAvailability(normalizedManifest.features.diarization, diarizationAvailability),
      summary: applyAvailability(normalizedManifest.features.summary, summaryAvailability),
    },
  };
}

function getAiAddonStatus({ userDataDir, platform = process.platform, arch = process.arch, existsSync, readFileSync, catalog = AI_MODEL_CATALOG } = {}) {
  const { manifest, readError } = loadAiAddonManifest({ userDataDir, existsSync, readFileSync, catalog });

  return buildAiAddonStatus({
    userDataDir,
    platform,
    arch,
    manifest,
    readError,
    catalog,
  });
}

module.exports = {
  AI_ADDON_STATUS_STATES,
  AI_MODEL_CATALOG,
  CURATED_AI_MODELS,
  DEFAULT_DIARIZATION_MODEL_ID,
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
  getDiarizationAvailability,
  getDiarizationDependencyArtifactForPlatform,
  getModelById,
  getModelList,
  getSummaryArtifactForPlatform,
  getSummaryRuntimeArtifactForPlatform,
  getSummaryAvailability,
  loadAiAddonManifest,
  normalizeAiAddonManifest,
  resolveModelId,
};
