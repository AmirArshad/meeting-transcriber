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
  PINNED_LLAMA_CPP_RUNTIME,
  SUMMARY_PROFILES,
  SUMMARY_RUNTIME_ARTIFACTS,
  buildAiAddonStatus,
  getDefaultModelId,
  getAiAddonPaths,
  getAiAddonStatus,
  getDiarizationAvailability,
  getDiarizationDependencyArtifactForPlatform,
  getDiarizationModelRef,
  getModelById,
  getSummaryArtifactForPlatform,
  getSummaryRuntimeArtifactForPlatform,
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

test('supports macOS diarization only on Apple Silicon MPS policy', () => {
  const availability = getDiarizationAvailability('darwin', 'arm64');
  const intelAvailability = getDiarizationAvailability('darwin', 'x64');

  assert.equal(availability.supported, true);
  assert.equal(availability.acceleration, 'mps');
  assert.equal(availability.runtimeDevice, 'mps');
  assert.equal(availability.automaticAfterTranscription, true);
  assert.equal(intelAvailability.supported, false);
  assert.match(intelAvailability.reason, /Apple Silicon.*Metal\/MPS/);
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
  assert.equal(status.features.diarization.availability.runtimeDevice, 'cuda');
  assert.equal(status.features.diarization.availability.automaticAfterTranscription, true);
  assert.equal(status.features.diarization.speakerCount, 3);
});

test('catalog exposes managed diarization dependency artifacts for Windows CUDA and macOS MPS', () => {
  const windowsArtifact = getDiarizationDependencyArtifactForPlatform('win32', 'x64');
  const macArtifact = getDiarizationDependencyArtifactForPlatform('darwin', 'arm64');

  assert.equal(windowsArtifact.id, 'pyannote-audio-4.0.1-win32-x64-cuda-12.6');
  assert.equal(windowsArtifact.acceleration, 'cuda');
  assert.deepEqual(windowsArtifact.runtimeFamilies, ['pytorch-cuda']);
  assert.equal(windowsArtifact.pip.allowSourceBuilds, false);
  assert.ok(windowsArtifact.pip.requirements.includes('torch==2.8.0+cu126'));
  assert.ok(windowsArtifact.pip.requirements.includes('torchvision==0.23.0+cu126'));
  assert.ok(windowsArtifact.pip.requirements.includes('torchaudio==2.8.0+cu126'));
  assert.ok(windowsArtifact.pip.sourceArtifacts.some((artifact) => artifact.package === 'julius' && artifact.sha256));
  assert.equal(macArtifact.id, 'pyannote-audio-4.0.1-darwin-arm64-mps');
  assert.equal(macArtifact.acceleration, 'mps');
  assert.deepEqual(macArtifact.runtimeFamilies, ['pytorch-mps']);
  assert.equal(macArtifact.pip.allowSourceBuilds, false);
  assert.ok(macArtifact.pip.requirements.includes('torch==2.8.0'));
  assert.ok(macArtifact.pip.requirements.includes('torchcodec==0.7.0'));
  assert.ok(macArtifact.pip.sourceArtifacts.some((artifact) => artifact.package === 'julius' && artifact.sha256));
  assert.equal(getDiarizationDependencyArtifactForPlatform('darwin', 'x64'), null);
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
  assert.equal(getDiarizationModelRef('renderer-supplied-id'), 'pyannote/speaker-diarization-community-1');
  assert.equal(diarizationModel.supportedPlatforms.darwin.status, 'enabled');
  assert.equal(diarizationModel.supportedPlatforms.darwin.acceleration, 'mps');
  assert.equal(summaryModel.inference.runtime, 'llama.cpp');
  assert.equal(summaryModel.inference.windowsAcceleration, 'cuda');
  assert.equal(summaryModel.inference.macosAcceleration, 'metal');
  assert.equal(summaryModel.inference.disableThinking, true);
  assert.equal(summaryModel.artifact.distribution, 'optional-setup-artifact');
  assert.equal(summaryModel.artifact.fileName, 'Qwen3.5-9B-Q4_K_M.gguf');
  assert.equal(summaryModel.artifact.source.repo, 'unsloth/Qwen3.5-9B-GGUF');
  assert.equal(summaryModel.artifact.source.revision, '3885219b6810b007914f3a7950a8d1b469d598a5');
  assert.equal(summaryModel.artifact.source.license, 'apache-2.0');
  assert.equal(summaryModel.artifact.source.gated, false);
  assert.equal(summaryModel.artifact.source.sizeBytes, 5680522464);
  assert.equal(summaryModel.artifact.platformArtifacts['win32-x64'].acceleration, 'cuda');
  assert.equal(summaryModel.artifact.platformArtifacts['darwin-arm64'].acceleration, 'metal');
});

test('catalog pins llama.cpp runtime release artifacts', () => {
  assert.equal(PINNED_LLAMA_CPP_RUNTIME.version, 'b9173');
  assert.equal(PINNED_LLAMA_CPP_RUNTIME.repository, 'ggml-org/llama.cpp');
  assert.equal(PINNED_LLAMA_CPP_RUNTIME.commit, '49d1701bd24e4cedf6dfec9e50e185111203946b');

  const windowsRuntime = getSummaryRuntimeArtifactForPlatform('win32', 'x64');
  const macRuntime = getSummaryRuntimeArtifactForPlatform('darwin', 'arm64');

  assert.deepEqual(windowsRuntime, SUMMARY_RUNTIME_ARTIFACTS['win32-x64']);
  assert.equal(windowsRuntime.executableName, 'llama-cli.exe');
  assert.deepEqual(windowsRuntime.artifacts.map((artifact) => artifact.fileName), [
    'llama-b9173-bin-win-cuda-12.4-x64.zip',
    'cudart-llama-bin-win-cuda-12.4-x64.zip',
  ]);
  assert.equal(windowsRuntime.artifacts[0].sha256, 'b8bdbe94f84579b0ba70c909b2b4aae5e31b38bd301edca37fc9ad10884e7a2b');
  assert.equal(windowsRuntime.artifacts[1].sha256, '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6');
  assert.equal(macRuntime.executableName, 'llama-cli');
  assert.equal(macRuntime.artifacts[0].fileName, 'llama-b9173-bin-macos-arm64.tar.gz');
  assert.equal(macRuntime.artifacts[0].sha256, '18764a5a179e023a3007a3a32b309febbe249f63c5716a6827428435f7439ff8');
});

test('selects platform-specific summary setup artifacts from the catalog', () => {
  const windowsArtifact = getSummaryArtifactForPlatform(DEFAULT_SUMMARY_MODEL_ID, 'win32', 'x64');
  const macArtifact = getSummaryArtifactForPlatform(DEFAULT_SUMMARY_MODEL_ID, 'darwin', 'arm64');

  assert.equal(windowsArtifact.artifactId, `${DEFAULT_SUMMARY_MODEL_ID}-gguf-win32-x64-cuda`);
  assert.equal(windowsArtifact.fileName, 'Qwen3.5-9B-Q4_K_M.gguf');
  assert.equal(windowsArtifact.acceleration, 'cuda');
  assert.equal(windowsArtifact.runtime, 'llama.cpp');
  assert.equal(windowsArtifact.sha256, '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8');
  assert.equal(windowsArtifact.downloadUrl, 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf');
  assert.equal(windowsArtifact.validationStatus, 'ready');
  assert.equal(macArtifact.artifactId, `${DEFAULT_SUMMARY_MODEL_ID}-gguf-darwin-arm64-metal`);
  assert.equal(macArtifact.acceleration, 'metal');
  assert.equal(getSummaryArtifactForPlatform(DEFAULT_SUMMARY_MODEL_ID, 'linux', 'x64'), null);
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
