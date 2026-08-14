const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAiAddonControlState,
  getDiarizationSetupMessage,
  getSummaryGenerationButtonView,
  getSummarySetupMessage,
  buildHomeAiAddonPrompt,
  hasDiarizationLocalState,
  normalizeHistoryDetailTab,
  parseTranscriptMarkdownSegments,
  shouldShowSpeakerSetupPrompt,
} = require('../../src/renderer/history-detail-helpers');
const { SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE, shouldConfirmDiarizationEngineSwitch } = require('../../src/renderer/ai-addon-ui-helpers');

test('parseTranscriptMarkdownSegments renders saved speaker labels from Markdown', () => {
  const segments = parseTranscriptMarkdownSegments(`# Meeting Transcription

## Transcript

**[00:00 - 00:08]** **Speaker 1:**
Hello from the first person.

**[00:08 - 00:16]**
**Speaker 2:** The second person responds.

**[00:16 - 00:20]**
No label here.
`);

  assert.deepEqual(segments, [
    {
      start: '00:00',
      end: '00:08',
      speaker: 'Speaker 1',
      text: 'Hello from the first person.',
    },
    {
      start: '00:08',
      end: '00:16',
      speaker: 'Speaker 2',
      text: 'The second person responds.',
    },
    {
      start: '00:16',
      end: '00:20',
      speaker: '',
      text: 'No label here.',
    },
  ]);
});

test('normalizeHistoryDetailTab falls back to transcript', () => {
  assert.equal(normalizeHistoryDetailTab('summary'), 'summary');
  assert.equal(normalizeHistoryDetailTab('transcript'), 'transcript');
  assert.equal(normalizeHistoryDetailTab('notes'), 'transcript');
});

test('setup messages explain graceful degradation paths', () => {
  assert.match(
    getDiarizationSetupMessage({ status: 'needsAccount' }),
    /own Hugging Face token.*model terms/i,
  );
  assert.doesNotMatch(
    getDiarizationSetupMessage({
      status: 'needsAccount',
      tokenStatus: { hasToken: true, encryptionAvailable: false },
    }),
    /secure storage is unavailable/i,
  );
  assert.match(
    getDiarizationSetupMessage({
      status: 'unsupported',
      availability: { reason: 'Speaker identification on macOS requires Apple Silicon with PyTorch Metal/MPS acceleration. CPU-only diarization is not supported.' },
    }),
    /Apple Silicon.*Metal\/MPS/i,
  );
  assert.match(
    getSummarySetupMessage({
      status: 'error',
      runtimeCache: { reason: 'llama.cpp runtime is not installed.' },
    }),
    /llama\.cpp runtime is not installed.*install model.*validate.*remove/i,
  );
  assert.doesNotMatch(
    getSummarySetupMessage({ status: 'error' }),
    /Open Settings/i,
  );
  assert.match(
    getSummarySetupMessage({ status: 'notConfigured' }),
    /Install the local summary model/i,
  );
  assert.match(
    getDiarizationSetupMessage({ status: 'notConfigured' }),
    /supported platforms/i,
  );
  const runtimeFailure = getDiarizationSetupMessage({
    status: 'error',
    error: "partially initialized module 'torchvision' has no attribute 'extension'",
  });
  assert.match(runtimeFailure, /remove and reinstall speaker identification setup/i);
  assert.doesNotMatch(runtimeFailure, /token.*model terms/i);
  const localCacheFailure = getDiarizationSetupMessage({
    status: 'error',
    error: 'Could not access local cache directory.',
  });
  assert.match(localCacheFailure, /validate again or remove and reinstall/i);
  assert.doesNotMatch(localCacheFailure, /token.*model terms/i);
});

test('AI add-on validate and remove buttons require local setup state', () => {
  assert.deepEqual(
    buildAiAddonControlState({
      type: 'summary',
      feature: { status: 'notConfigured', availability: { supported: true }, cache: { installed: false }, runtimeCache: { installed: false } },
    }),
    {
      canConfigure: true,
      canValidate: false,
      canRemove: false,
      canSelectEngine: true,
      hasLocalState: false,
      isBusy: false,
      isUnsupported: false,
    },
  );

  const partialSummary = buildAiAddonControlState({
    type: 'summary',
    feature: { status: 'error', cache: { installed: false, partial: true }, runtimeCache: { installed: false } },
  });
  assert.equal(partialSummary.canConfigure, true);
  assert.equal(partialSummary.canValidate, true);
  assert.equal(partialSummary.canRemove, true);

  const readySummary = buildAiAddonControlState({
    type: 'summary',
    feature: { status: 'ready', setupComplete: true, cache: { installed: true }, runtimeCache: { installed: true } },
  });
  assert.equal(readySummary.canConfigure, false);
  assert.equal(readySummary.canValidate, true);
  assert.equal(readySummary.canRemove, true);

  const removedDiarization = buildAiAddonControlState({
    type: 'diarization',
    feature: { status: 'notConfigured', tokenStatus: { hasToken: false }, dependencyCache: { installed: false } },
  });
  assert.equal(removedDiarization.canRemove, false);
  assert.equal(removedDiarization.canValidate, false);

  const partialDiarization = buildAiAddonControlState({
    type: 'diarization',
    feature: { status: 'needsAccount', tokenStatus: { hasToken: false }, dependencyCache: { installed: false, partial: true } },
  });
  assert.equal(partialDiarization.canRemove, true);
  assert.equal(partialDiarization.canValidate, true);

  const removedSummary = buildAiAddonControlState({
    type: 'summary',
    feature: { status: 'notConfigured', cache: { installed: false, partial: false }, runtimeCache: { installed: false, partial: false } },
  });
  assert.equal(removedSummary.canRemove, false);
  assert.equal(removedSummary.canValidate, false);
});

test('AI add-on controls are disabled during active setup or unsupported state', () => {
  const downloadingSummary = buildAiAddonControlState({
    type: 'summary',
    setupActive: true,
    feature: { status: 'downloading', cache: { installed: true } },
  });
  assert.equal(downloadingSummary.hasLocalState, true);
  assert.equal(downloadingSummary.canConfigure, false);
  assert.equal(downloadingSummary.canValidate, false);
  assert.equal(downloadingSummary.canRemove, false);
  assert.equal(downloadingSummary.canSelectEngine, false);

  const unsupportedDiarization = buildAiAddonControlState({
    type: 'diarization',
    feature: { status: 'unsupported', tokenStatus: { hasToken: true }, dependencyCache: { installed: true } },
  });
  assert.equal(unsupportedDiarization.hasLocalState, true);
  assert.equal(unsupportedDiarization.canConfigure, false);
  assert.equal(unsupportedDiarization.canValidate, false);
  assert.equal(unsupportedDiarization.canRemove, false);
  assert.equal(unsupportedDiarization.canSelectEngine, false);
});

test('summary generation button view exposes spinner and cancel hover copy', () => {
  assert.deepEqual(getSummaryGenerationButtonView({ active: false }), {
    active: false,
    label: null,
    hoverLabel: null,
    title: null,
    ariaBusy: false,
  });

  assert.deepEqual(getSummaryGenerationButtonView({ active: true }), {
    active: true,
    label: 'Summarising...',
    hoverLabel: 'Cancel Summarisation',
    title: 'Click to cancel summary generation',
    ariaBusy: true,
  });

  assert.deepEqual(getSummaryGenerationButtonView({ active: true, cancelling: true }), {
    active: true,
    label: 'Cancelling...',
    hoverLabel: 'Cancelling...',
    title: 'Cancelling summary generation...',
    ariaBusy: true,
  });
});

test('buildHomeAiAddonPrompt gates speaker setup behind Windows CUDA', () => {
  const aiStatus = {
    features: {
      diarization: {
        status: 'notConfigured',
        setupComplete: false,
        availability: { supported: true },
      },
      summary: {
        status: 'notConfigured',
        setupComplete: false,
        availability: { supported: true },
      },
    },
  };

  assert.equal(buildHomeAiAddonPrompt({ aiStatus, platform: 'win32', hasNvidiaGpu: true, cudaInstalled: false }).feature, 'summary');
  assert.equal(buildHomeAiAddonPrompt({ aiStatus, platform: 'win32', hasNvidiaGpu: false, cudaInstalled: false }).feature, 'summary');
  assert.equal(buildHomeAiAddonPrompt({ aiStatus, platform: 'win32', hasNvidiaGpu: true, cudaInstalled: true }).feature, 'diarization');
});

test('buildHomeAiAddonPrompt hides unsupported macOS diarization prompt', () => {
  const prompt = buildHomeAiAddonPrompt({
    platform: 'darwin',
    aiStatus: {
      features: {
        diarization: {
          status: 'unsupported',
          setupComplete: false,
          availability: { supported: false },
        },
        summary: {
          status: 'notConfigured',
          setupComplete: false,
          availability: { supported: true },
        },
      },
    },
  });

  assert.equal(prompt.feature, 'summary');
});

test('buildHomeAiAddonPrompt offers macOS speaker setup when MPS policy is supported', () => {
  const prompt = buildHomeAiAddonPrompt({
    platform: 'darwin',
    aiStatus: {
      features: {
        diarization: {
          status: 'notConfigured',
          setupComplete: false,
          availability: { supported: true, acceleration: 'mps' },
        },
        summary: {
          status: 'notConfigured',
          setupComplete: false,
          availability: { supported: true },
        },
      },
    },
  });

  assert.equal(prompt.feature, 'diarization');
});

test('shouldShowSpeakerSetupPrompt keeps the Windows CUDA gate', () => {
  const diarization = {
    status: 'notConfigured',
    setupComplete: false,
    availability: { supported: true },
  };
  assert.equal(shouldShowSpeakerSetupPrompt({
    diarization,
    platform: 'win32',
    hasNvidiaGpu: true,
    cudaInstalled: true,
  }), true);
  assert.equal(shouldShowSpeakerSetupPrompt({
    diarization,
    platform: 'win32',
    hasNvidiaGpu: true,
    cudaInstalled: false,
  }), false);
  assert.equal(shouldShowSpeakerSetupPrompt({
    diarization,
    platform: 'win32',
    hasNvidiaGpu: false,
    cudaInstalled: true,
  }), false);
});

test('new-user home speaker prompt selects Speakrs and existing pyannote stays', () => {
  const newUser = buildHomeAiAddonPrompt({
    platform: 'darwin',
    aiStatus: {
      features: {
        diarization: {
          status: 'notConfigured',
          setupComplete: false,
          availability: { supported: true },
        },
        summary: { status: 'ready', setupComplete: true },
      },
    },
  });
  assert.equal(newUser.feature, 'diarization');
  assert.equal(newUser.engine, 'speakrs');

  const existingPyannote = buildHomeAiAddonPrompt({
    platform: 'win32',
    cudaInstalled: true,
    hasNvidiaGpu: true,
    aiStatus: {
      features: {
        diarization: {
          engine: 'pyannote',
          status: 'needsAccount',
          setupComplete: false,
          availability: { supported: true },
        },
      },
    },
  });
  assert.equal(existingPyannote.feature, 'diarization');
  assert.equal(existingPyannote.engine, 'pyannote');
});

test('needsAccount copy stays for pyannote and is not used for Speakrs', () => {
  assert.match(
    getDiarizationSetupMessage({ engine: 'pyannote', status: 'needsAccount' }),
    /own Hugging Face token.*model terms/i,
  );
  assert.doesNotMatch(
    getDiarizationSetupMessage({
      engine: 'speakrs',
      status: 'notConfigured',
      error: SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
      cliPresent: false,
    }),
    /Hugging Face token|needs account/i,
  );
});

test('packaged missing CLI status does not tell the user to re-run setup', () => {
  const message = getDiarizationSetupMessage({
    engine: 'speakrs',
    status: 'error',
    error: SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
    cliPresent: false,
  });
  assert.equal(message, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE);
  assert.doesNotMatch(message, /re-run speaker setup|validate again or remove and reinstall/i);
});

test('Speakrs pack or runtime local state enables Remove', () => {
  assert.equal(hasDiarizationLocalState({
    status: 'error',
    packCache: { installed: true },
  }), true);
  assert.equal(hasDiarizationLocalState({
    status: 'notConfigured',
    runtimeCache: { partial: true },
  }), true);
});

test('token-only Pyannote state requires switch confirmation and enables Remove', () => {
  const feature = {
    engine: 'pyannote',
    status: 'needsAccount',
    tokenStatus: { hasToken: true },
  };
  assert.equal(hasDiarizationLocalState(feature), true);
  assert.equal(shouldConfirmDiarizationEngineSwitch({
    selectedEngine: 'speakrs',
    installedEngine: 'pyannote',
    hasOtherEngineLocalState: hasDiarizationLocalState(feature),
  }), true);
  const controls = buildAiAddonControlState({
    type: 'diarization',
    feature,
    selectedEngine: 'pyannote',
  });
  assert.equal(controls.canRemove, true);
  assert.equal(controls.canConfigure, true);
  const switching = buildAiAddonControlState({
    type: 'diarization',
    feature,
    selectedEngine: 'speakrs',
  });
  assert.equal(switching.canConfigure, true);
  assert.equal(switching.canRemove, true);
});

test('packaged missing Speakrs CLI Home prompt uses the exact reinstall copy', () => {
  const prompt = buildHomeAiAddonPrompt({
    platform: 'win32',
    hasNvidiaGpu: true,
    cudaInstalled: true,
    aiStatus: {
      features: {
        diarization: {
          engine: 'speakrs',
          status: 'error',
          cliPresent: false,
          cliMissingMessage: SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
          error: SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
          availability: { supported: true },
        },
      },
    },
  });
  assert.equal(prompt.feature, 'diarization');
  assert.equal(prompt.message, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE);
  assert.doesNotMatch(prompt.message, /Set up local speaker identification in Settings|re-run speaker setup/i);
});

test('dev-mode missing Speakrs CLI Home prompt keeps the dev copy', () => {
  const prompt = buildHomeAiAddonPrompt({
    platform: 'darwin',
    aiStatus: {
      features: {
        diarization: {
          engine: 'speakrs',
          status: 'error',
          cliPresent: false,
          cliMissingMessage: 'Speakrs CLI is not available.',
          error: 'Speakrs CLI is not available.',
          availability: { supported: true },
        },
      },
    },
  });
  assert.equal(prompt.message, 'Speakrs CLI is not available.');
  assert.doesNotMatch(prompt.message, /Reinstall AvaNevis|Set up local speaker identification in Settings/i);
});

test('packaged missing Speakrs CLI disables Set Up that cannot repair the bundled binary', () => {
  const feature = {
    engine: 'speakrs',
    status: 'error',
    cliPresent: false,
    cliMissingMessage: SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
    error: SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
  };
  const speakrs = buildAiAddonControlState({
    type: 'diarization',
    feature,
    selectedEngine: 'speakrs',
  });
  assert.equal(speakrs.canConfigure, false);
  const pyannote = buildAiAddonControlState({
    type: 'diarization',
    feature,
    selectedEngine: 'pyannote',
  });
  assert.equal(pyannote.canConfigure, true);
});

test('switching the selected engine re-enables Set Up while the other engine is ready', () => {
  const readySpeakrs = {
    engine: 'speakrs',
    status: 'ready',
    setupComplete: true,
    packCache: { installed: true },
  };
  const sameEngine = buildAiAddonControlState({
    type: 'diarization',
    feature: readySpeakrs,
    selectedEngine: 'speakrs',
  });
  assert.equal(sameEngine.canConfigure, false);
  assert.equal(sameEngine.canSelectEngine, true);
  const switching = buildAiAddonControlState({
    type: 'diarization',
    feature: readySpeakrs,
    selectedEngine: 'pyannote',
  });
  assert.equal(switching.canConfigure, true);
  assert.equal(switching.canRemove, true);
  assert.equal(switching.canSelectEngine, true);
});
