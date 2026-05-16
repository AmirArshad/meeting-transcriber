const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDiarizationSetupMessage,
  getSummarySetupMessage,
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
      availability: { reason: 'macOS speaker identification is unavailable until accelerated Apple Silicon diarization is validated.' },
    }),
    /macOS speaker identification is unavailable/i,
  );
  assert.match(
    getSummarySetupMessage({
      status: 'error',
      runtimeCache: { reason: 'llama.cpp runtime is not installed.' },
    }),
    /llama\.cpp runtime is not installed.*validate or reinstall/i,
  );
  assert.match(
    getSummarySetupMessage({ status: 'notConfigured' }),
    /Install the local summary model/i,
  );
});
