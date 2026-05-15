const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  AI_ADDON_STATUS_STATES,
  AI_MODEL_CATALOG,
  CURATED_AI_MODELS,
  DEFAULT_DIARIZATION_MODEL_ID,
  DEFAULT_SUMMARY_MODEL_ID,
  DEFAULT_SUMMARY_PROFILE,
  SUMMARY_PROFILES,
  buildAiAddonStatus,
  getDefaultModelId,
  getAiAddonPaths,
  getAiAddonStatus,
  getDiarizationAvailability,
  getModelById,
  normalizeAiAddonManifest,
  resolveModelId,
} = require('../../src/ai-addon-state');

test('normalizes an empty AI add-on manifest with safe defaults', () => {
  const manifest = normalizeAiAddonManifest();

  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.features.diarization.status, 'notConfigured');
  assert.equal(manifest.features.diarization.modelId, DEFAULT_DIARIZATION_MODEL_ID);
  assert.equal(manifest.features.diarization.speakerCount, 'auto');
  assert.equal(manifest.features.summary.status, 'notConfigured');
  assert.equal(manifest.features.summary.modelId, DEFAULT_SUMMARY_MODEL_ID);
  assert.equal(manifest.features.summary.profile, DEFAULT_SUMMARY_PROFILE);
});

test('normalizes invalid statuses, speaker counts, profiles, and validation fields', () => {
  const manifest = normalizeAiAddonManifest({
    features: {
      diarization: {
        status: 'enabled',
        modelId: '  custom-diarizer  ',
        speakerCount: 42,
        lastValidation: {
          status: 'done',
          checkedAt: ' 2026-05-16T00:00:00Z ',
          message: '',
        },
        error: ' token missing ',
      },
      summary: {
        status: 'ready',
        modelId: '',
        profile: 'verbose',
        lastValidation: {
          status: 'validating',
          message: ' ok ',
        },
      },
    },
  });

  assert.equal(manifest.features.diarization.status, 'notConfigured');
  assert.equal(manifest.features.diarization.modelId, DEFAULT_DIARIZATION_MODEL_ID);
  assert.equal(manifest.features.diarization.speakerCount, 'auto');
  assert.equal(manifest.features.diarization.lastValidation.status, 'notConfigured');
  assert.equal(manifest.features.diarization.lastValidation.checkedAt, '2026-05-16T00:00:00Z');
  assert.equal(manifest.features.diarization.lastValidation.message, null);
  assert.equal(manifest.features.diarization.error, 'token missing');
  assert.equal(manifest.features.summary.status, 'ready');
  assert.equal(manifest.features.summary.modelId, DEFAULT_SUMMARY_MODEL_ID);
  assert.equal(manifest.features.summary.profile, DEFAULT_SUMMARY_PROFILE);
  assert.equal(manifest.features.summary.lastValidation.status, 'validating');
  assert.equal(manifest.features.summary.lastValidation.message, 'ok');
});

test('returns AI add-on paths under Electron userData', () => {
  const paths = getAiAddonPaths('/Users/tester/AppData/AvaNevis');

  assert.equal(paths.rootDir, path.join('/Users/tester/AppData/AvaNevis', 'ai-addons'));
  assert.equal(paths.manifestPath, path.join('/Users/tester/AppData/AvaNevis', 'ai-addons', 'manifest.json'));
  assert.equal(paths.modelCacheDir, path.join('/Users/tester/AppData/AvaNevis', 'ai-addons', 'models'));
  assert.equal(paths.diarizationModelCacheDir, path.join('/Users/tester/AppData/AvaNevis', 'ai-addons', 'models', 'diarization'));
  assert.equal(paths.summaryModelCacheDir, path.join('/Users/tester/AppData/AvaNevis', 'ai-addons', 'models', 'summary'));
});

test('marks macOS diarization unsupported until accelerated validation exists', () => {
  const availability = getDiarizationAvailability('darwin', 'arm64');

  assert.equal(availability.supported, false);
  assert.equal(availability.automaticAfterTranscription, false);
  assert.match(availability.reason, /accelerated Apple Silicon diarization/);
});

test('allows Windows x64 diarization candidate without changing transcription paths', () => {
  const status = buildAiAddonStatus({
    userDataDir: 'C:/Users/tester/AppData/Roaming/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    manifest: {
      features: {
        diarization: { status: 'ready', speakerCount: 3 },
      },
    },
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(status.features.diarization.availability.supported, true);
  assert.equal(status.features.diarization.availability.acceleration, 'cuda');
  assert.equal(status.features.diarization.availability.automaticAfterTranscription, true);
  assert.equal(status.features.diarization.speakerCount, 3);
});

test('summary profiles reuse the curated default summary model', () => {
  const defaultSummaryModel = getModelById('summary', DEFAULT_SUMMARY_MODEL_ID);
  const profileIds = SUMMARY_PROFILES.map((profile) => profile.id);

  assert.ok(defaultSummaryModel);
  assert.deepEqual(defaultSummaryModel.profiles, profileIds);
  assert.deepEqual(profileIds, ['concise', 'balanced', 'detailed', 'action-items']);
});

test('model catalog exposes swappable v1 defaults', () => {
  assert.equal(CURATED_AI_MODELS, AI_MODEL_CATALOG);
  assert.equal(getDefaultModelId('diarization'), DEFAULT_DIARIZATION_MODEL_ID);
  assert.equal(getDefaultModelId('summary'), DEFAULT_SUMMARY_MODEL_ID);

  const diarizationModel = getModelById('diarization', DEFAULT_DIARIZATION_MODEL_ID);
  const summaryModel = getModelById('summary', DEFAULT_SUMMARY_MODEL_ID);

  assert.equal(diarizationModel.runtime.modelRef, 'pyannote/speaker-diarization-community-1');
  assert.equal(diarizationModel.supportedPlatforms.darwin.status, 'disabledUntilValidated');
  assert.equal(summaryModel.inference.runtime, 'llama.cpp');
  assert.equal(summaryModel.inference.windowsAcceleration, 'cuda');
  assert.equal(summaryModel.inference.macosAcceleration, 'metal');
  assert.equal(summaryModel.inference.disableThinking, true);
  assert.equal(summaryModel.artifact.distribution, 'optional-setup-artifact');
});

test('model selection falls back when a manifest references a retired model', () => {
  const manifest = normalizeAiAddonManifest({
    features: {
      diarization: { modelId: 'old-diarizer' },
      summary: { modelId: 'old-summary-model' },
    },
  });

  assert.equal(manifest.features.diarization.modelId, DEFAULT_DIARIZATION_MODEL_ID);
  assert.equal(manifest.features.summary.modelId, DEFAULT_SUMMARY_MODEL_ID);
});

test('model catalog can swap defaults without changing state normalization code', () => {
  const customCatalog = {
    version: 2,
    diarization: {
      defaultModelId: 'future-diarizer',
      models: [{ id: 'future-diarizer' }],
    },
    summary: {
      defaultModelId: 'future-summary',
      models: [
        { id: 'future-summary' },
        { id: 'future-summary-small' },
      ],
    },
  };

  assert.equal(resolveModelId('summary', 'future-summary-small', customCatalog), 'future-summary-small');
  assert.equal(resolveModelId('summary', 'retired-model', customCatalog), 'future-summary');

  const status = buildAiAddonStatus({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    catalog: customCatalog,
    manifest: {
      features: {
        diarization: { modelId: 'retired-diarizer' },
        summary: { modelId: 'future-summary-small' },
      },
    },
  });

  assert.equal(status.models, customCatalog);
  assert.equal(status.features.diarization.modelId, 'future-diarizer');
  assert.equal(status.features.summary.modelId, 'future-summary-small');
});

test('status exposes only setup metadata and no token fields', () => {
  const status = buildAiAddonStatus({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    manifest: {
      features: {
        diarization: {
          status: 'needsAccount',
          token: 'hf_secret',
          hfToken: 'hf_secret',
        },
      },
    },
  });
  const serialized = JSON.stringify(status);

  assert.equal(status.features.diarization.status, 'needsAccount');
  assert.equal(serialized.includes('hf_secret'), false);
  assert.equal(serialized.includes('tokenRequired'), true);
  assert.equal(serialized.includes('hfToken'), false);
});

test('reads missing manifest as default status', () => {
  const status = getAiAddonStatus({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    existsSync: () => false,
  });

  assert.equal(status.readError, null);
  assert.equal(status.features.diarization.status, 'notConfigured');
  assert.equal(status.features.summary.status, 'notConfigured');
});

test('reports corrupt manifest without exposing raw contents', () => {
  const status = getAiAddonStatus({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    existsSync: () => true,
    readFileSync: () => '{bad json with hf_secret}',
  });

  assert.equal(status.readError, 'AI add-on setup state could not be read.');
  assert.equal(status.features.diarization.status, 'error');
  assert.equal(status.features.summary.status, 'error');
  assert.equal(JSON.stringify(status).includes('hf_secret'), false);
});

test('status states include the design states', () => {
  assert.deepEqual(AI_ADDON_STATUS_STATES, [
    'notConfigured',
    'needsAccount',
    'downloading',
    'validating',
    'ready',
    'error',
    'unsupported',
  ]);
});
