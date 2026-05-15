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

const AI_MODEL_CATALOG = deepFreeze({
  version: 1,
  diarization: {
    defaultModelId: DEFAULT_DIARIZATION_MODEL_ID,
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
        artifact: {
          format: 'gguf',
          distribution: 'optional-setup-artifact',
          filename: null,
          sha256: null,
          validationStatus: 'pendingPinnedArtifact',
        },
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
        artifact: {
          format: 'gguf',
          distribution: 'optional-setup-artifact',
          filename: null,
          sha256: null,
          validationStatus: 'pendingPinnedArtifact',
        },
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
        artifact: {
          format: 'gguf',
          distribution: 'optional-setup-artifact',
          filename: null,
          sha256: null,
          validationStatus: 'pendingPinnedArtifact',
        },
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

  return {
    rootDir,
    manifestPath: path.join(rootDir, 'manifest.json'),
    modelCacheDir,
    diarizationModelCacheDir: path.join(modelCacheDir, 'diarization'),
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
    modelCacheDirs: {
      diarization: paths.diarizationModelCacheDir,
      summary: paths.summaryModelCacheDir,
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
  MANIFEST_VERSION,
  SUMMARY_PROFILES,
  buildAiAddonStatus,
  getAiAddonPaths,
  getAiAddonStatus,
  getDefaultModelId,
  getDiarizationAvailability,
  getModelById,
  getModelList,
  getSummaryAvailability,
  loadAiAddonManifest,
  normalizeAiAddonManifest,
  resolveModelId,
};
