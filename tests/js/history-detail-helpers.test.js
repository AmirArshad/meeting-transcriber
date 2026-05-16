const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDiarizationSetupMessage,
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
