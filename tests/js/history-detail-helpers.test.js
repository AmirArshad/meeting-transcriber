const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAiAddonControlState,
  getDiarizationSetupMessage,
  getSummaryGenerationButtonView,
  getSummarySetupMessage,
  buildHomeAiAddonPrompt,
  normalizeHistoryDetailTab,
  parseTranscriptMarkdownSegments,
} = require('../../src/renderer/history-detail-helpers');

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
  assert.match(
    getDiarizationSetupMessage({
      status: 'needsAccount',
      tokenStatus: { hasToken: true, encryptionAvailable: false },
    }),
    /token is still stored.*secure storage is unavailable/i,
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

  const unsupportedDiarization = buildAiAddonControlState({
    type: 'diarization',
    feature: { status: 'unsupported', tokenStatus: { hasToken: true }, dependencyCache: { installed: true } },
  });
  assert.equal(unsupportedDiarization.hasLocalState, true);
  assert.equal(unsupportedDiarization.canConfigure, false);
  assert.equal(unsupportedDiarization.canValidate, false);
  assert.equal(unsupportedDiarization.canRemove, false);
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
