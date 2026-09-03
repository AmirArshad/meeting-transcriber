const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAiAddonControlState,
  canRunAiAddonControlAction,
  getUnsupportedAiAddonFootprintRows,
  getDiarizationSetupMessage,
  getSummaryActionControlState,
  getSummaryGenerationButtonView,
  getSummarySetupMessage,
  buildHomeAiAddonPrompt,
  hasDiarizationLocalState,
  normalizeHistoryDetailTab,
  parseTranscriptMarkdownSegments,
  shouldRestoreInlineEditorFocus,
  shouldSkipMeetingReselect,
  shouldShowSpeakerSetupPrompt,
} = require('../../src/renderer/history-detail-helpers');
const {
  SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
  shouldConfirmDiarizationEngineSwitch,
  shouldOfferDiarizationSetupFields,
} = require('../../src/renderer/ai-addon-ui-helpers');
const {
  LINUX_DIARIZATION_UNAVAILABLE_REASON,
  LINUX_SUMMARY_UNAVAILABLE_REASON,
} = require('../../src/ai-addon-state');

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
  assert.equal(
    getDiarizationSetupMessage({
      status: 'unsupported',
      lastValidation: {
        status: 'ready',
        message: 'Speaker identification setup is ready.',
      },
      availability: {
        reason: 'Speaker identification on Linux requires the managed CUDA 12 runtime and a working NVIDIA GPU. CPU-only speaker identification is not supported.',
      },
    }),
    'Speaker identification on Linux requires the managed CUDA 12 runtime and a working NVIDIA GPU. CPU-only speaker identification is not supported.',
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

test('AI add-on controls fail closed until setup status is known', () => {
  const unknownSummary = buildAiAddonControlState({
    type: 'summary',
    feature: null,
  });
  assert.equal(unknownSummary.canConfigure, false);
  assert.equal(unknownSummary.canValidate, false);
  assert.equal(unknownSummary.canRemove, false);
  assert.equal(unknownSummary.canSelectEngine, false);
  assert.deepEqual(getSummaryActionControlState(null, { platformSupportsSummaries: false }), {
    enabled: false,
    title: 'Summary setup status is unavailable. Open Settings to validate the local summary model.',
  });
});

test('unknown summary status stays clickable where the platform supports summaries', () => {
  // A single failed getAiAddonStatus() call must not leave Generate Summary
  // permanently dead on Windows/macOS. Clicking re-fetches status and routes
  // the user into Settings, which beats an inert control.
  assert.deepEqual(getSummaryActionControlState(null, { platformSupportsSummaries: true }), {
    enabled: true,
    title: '',
  });
  assert.deepEqual(getSummaryActionControlState(undefined), {
    enabled: true,
    title: '',
  });
  // An authoritative unsupported verdict still wins over the optimistic default.
  const unsupported = getSummaryActionControlState(
    { status: 'unsupported', availability: { reason: LINUX_SUMMARY_UNAVAILABLE_REASON } },
    { platformSupportsSummaries: true },
  );
  assert.equal(unsupported.enabled, false);
  assert.equal(unsupported.title, LINUX_SUMMARY_UNAVAILABLE_REASON);
});

test('AI add-on action guard follows the fail-closed control state', () => {
  assert.equal(canRunAiAddonControlAction({ type: 'summary', feature: null, action: 'configure' }), false);
  assert.equal(canRunAiAddonControlAction({
    type: 'summary',
    feature: { status: 'unsupported' },
    action: 'configure',
  }), false);
  assert.equal(canRunAiAddonControlAction({
    type: 'summary',
    feature: { status: 'notConfigured' },
    action: 'configure',
  }), true);
  assert.equal(canRunAiAddonControlAction({
    type: 'diarization',
    feature: { status: 'unsupported' },
    action: 'select',
  }), false);
  assert.equal(canRunAiAddonControlAction({
    type: 'diarization',
    feature: { status: 'notConfigured' },
    action: 'select',
  }), true);
  assert.equal(canRunAiAddonControlAction({
    type: 'summary',
    feature: { status: 'ready', setupComplete: true, cache: { installed: true } },
    action: 'validate',
  }), true);
  assert.equal(canRunAiAddonControlAction({
    type: 'summary',
    feature: { status: 'ready', setupComplete: true, cache: { installed: true } },
    action: 'remove',
  }), true);
});

test('unsupported add-on footprints advertise a disabled runtime', () => {
  assert.deepEqual(
    getUnsupportedAiAddonFootprintRows({ status: 'unsupported' }),
    [
      { label: 'Platform', value: 'unsupported' },
      { label: 'Runtime', value: 'disabled' },
    ],
  );
  assert.equal(getUnsupportedAiAddonFootprintRows({ status: 'ready' }), null);
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

test('buildHomeAiAddonPrompt hides unsupported Linux diarization and summary prompts', () => {
  const prompt = buildHomeAiAddonPrompt({
    platform: 'linux',
    aiStatus: {
      features: {
        diarization: {
          status: 'notConfigured',
          setupComplete: false,
          availability: { supported: false },
        },
        summary: {
          status: 'notConfigured',
          setupComplete: false,
          availability: { supported: false },
        },
      },
    },
  });

  assert.equal(prompt, null);
});

test('Linux add-on control state is fully disabled and shows future-version copy', () => {
  const diarization = {
    status: 'unsupported',
    availability: { supported: false, reason: LINUX_DIARIZATION_UNAVAILABLE_REASON },
  };
  const summary = {
    status: 'unsupported',
    availability: { supported: false, reason: LINUX_SUMMARY_UNAVAILABLE_REASON },
  };

  const diarizationControls = buildAiAddonControlState({
    type: 'diarization',
    feature: diarization,
    unsupported: true,
  });
  const summaryControls = buildAiAddonControlState({
    type: 'summary',
    feature: summary,
  });
  const summaryAction = getSummaryActionControlState(summary);
  const fields = shouldOfferDiarizationSetupFields({ engine: 'pyannote', unsupported: true });

  assert.equal(diarizationControls.canConfigure, false);
  assert.equal(diarizationControls.canValidate, false);
  assert.equal(diarizationControls.canRemove, false);
  assert.equal(diarizationControls.canSelectEngine, false);
  assert.equal(diarizationControls.isUnsupported, true);
  assert.equal(summaryControls.canConfigure, false);
  assert.equal(summaryControls.canValidate, false);
  assert.equal(summaryControls.canRemove, false);
  assert.equal(summaryAction.enabled, false);
  assert.equal(summaryAction.title, LINUX_SUMMARY_UNAVAILABLE_REASON);
  assert.equal(getDiarizationSetupMessage(diarization), LINUX_DIARIZATION_UNAVAILABLE_REASON);
  assert.equal(getSummarySetupMessage(summary), LINUX_SUMMARY_UNAVAILABLE_REASON);
  assert.deepEqual(fields, { showToken: false, showSpeakerCount: false });
});

test('startup status refresh reapplies History summary availability', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'app.js'), 'utf8');
  const refreshStart = appSource.indexOf('async function refreshHomeAiAddonPrompt()');
  const refreshEnd = appSource.indexOf('\n}', refreshStart);
  const refreshSource = appSource.slice(refreshStart, refreshEnd + 2);
  assert.match(refreshSource, /aiAddonStatusSnapshot\s*=\s*status/);
  assert.match(refreshSource, /updateSummaryGenerationButtons\(\)/);
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

test('inline rename restores focus only after Chromium steals it to the document', () => {
  const doc = { body: { id: 'body' }, documentElement: { id: 'html' } };
  const titleInput = { id: 'title-input' };
  const searchInput = { id: 'search' };

  assert.equal(shouldRestoreInlineEditorFocus({
    editorOpen: true,
    activeElement: doc.body,
    doc,
  }), true);
  assert.equal(shouldRestoreInlineEditorFocus({
    editorOpen: true,
    activeElement: titleInput,
    isEditorControl: true,
    doc,
  }), true);
  assert.equal(shouldRestoreInlineEditorFocus({
    editorOpen: true,
    activeElement: searchInput,
    doc,
  }), false);
  assert.equal(shouldRestoreInlineEditorFocus({
    editorOpen: false,
    activeElement: doc.body,
    doc,
  }), false);
});

test('re-clicking the selected History row does not close an in-progress title edit', () => {
  assert.equal(shouldSkipMeetingReselect({
    currentMeetingId: 'meeting_1',
    nextMeetingId: 'meeting_1',
    titleEditorOpen: true,
  }), true);
  assert.equal(shouldSkipMeetingReselect({
    currentMeetingId: 'meeting_1',
    nextMeetingId: 'meeting_2',
    titleEditorOpen: true,
  }), false);
  assert.equal(shouldSkipMeetingReselect({
    currentMeetingId: 'meeting_1',
    nextMeetingId: 'meeting_1',
    titleEditorOpen: false,
  }), false);
});
