'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isCanonicalSpeakerKey, extractSpeakerSamples, applySpeakerNameMapToSegments, hasUnnamedSpeakers, normalizeSpeakerName, diffSpeakerNames } = require('../../src/renderer/speaker-label-helpers');

test('samples preserve speaker appearance and use the first nonempty utterance and its timing', () => {
  const segments = [
    { speaker: 'Speaker 2', text: ' ', start: '00:01', end: '00:02' },
    { speaker: 'Speaker 1', text: 'First\n words', start: '01:02', end: '01:04' },
    { speaker: 'Speaker 2', text: '  Other  words ', startMs: 3000, endMs: 4500 },
    { speaker: 'Speaker 2', text: 'later', start: '00:09' },
    { speaker: 'Unknown', text: 'ignored' },
    { speaker: 'SPEAKER_00', text: '', start: 9 },
  ];
  const samples = extractSpeakerSamples(segments);
  assert.deepEqual(samples, [
    { speaker: 'Speaker 2', excerpt: 'Other words', startSec: 3, endSec: 4.5 },
    { speaker: 'Speaker 1', excerpt: 'First words', startSec: 62, endSec: 64 },
    { speaker: 'SPEAKER_00', excerpt: '', startSec: null, endSec: null },
  ]);
  assert.equal(hasUnnamedSpeakers({ ai: { diarization: { speakerNames: { 'Speaker 1': 'Alice', 'Speaker 2': 'Bob' } } } }, samples), true);
  assert.equal(hasUnnamedSpeakers({}, []), false);
  assert.equal(isCanonicalSpeakerKey('Speaker 99'), true);
  assert.equal(isCanonicalSpeakerKey('Speaker 100'), false);
  assert.equal(isCanonicalSpeakerKey('Unknown'), false);
});

test('names normalize, overlay without mutation, and diff as per-key patches', () => {
  const segments = [{ speaker: 'Speaker 1', text: 'Hello' }, { speaker: 'Unknown', text: 'Hi' }];
  assert.deepEqual(applySpeakerNameMapToSegments(segments, { 'Speaker 1': ' Alice*\n--> ', Unknown: 'Bad' }), [{ speaker: 'Alice', text: 'Hello' }, segments[1]]);
  assert.equal(segments[0].speaker, 'Speaker 1');
  assert.equal(normalizeSpeakerName(' A*\n--> B '), 'A B');
  assert.deepEqual(diffSpeakerNames({ 'Speaker 1': 'Alice', 'Speaker 2': 'Bob' }, { 'Speaker 1': 'Alice', 'Speaker 2': '', 'Speaker 3': ' Carol ' }), { 'Speaker 2': '', 'Speaker 3': 'Carol' });
});

test('normalization removes controls before arrows and limits Unicode code points', () => {
  assert.equal(normalizeSpeakerName('A-\u0000->B\u2028C\u200dD'), 'ABCD');
  assert.equal(normalizeSpeakerName('😀'.repeat(65)), '😀'.repeat(64));
});

test('nested timestamp arrows are fully removed from names', () => {
  assert.equal(normalizeSpeakerName('A--->->B'), 'AB');
});

test('extractSpeakerSamples prefers the first >=5s timed segment and preserves speaker order', () => {
  const segments = [
    { speaker: 'Speaker 2', text: 'Short intro', startSec: 0, endSec: 2 },
    { speaker: 'Speaker 1', text: 'Untimed first' },
    { speaker: 'Speaker 2', text: 'Exact five seconds', startSec: 10, endSec: 15 },
    { speaker: 'Speaker 2', text: 'Even longer later', startSec: 20, endSec: 32 },
    { speaker: 'Speaker 1', text: 'Start only', startSec: 4 },
    { speaker: 'Speaker 1', text: 'Short timed', startSec: 6, endSec: 9 },
    { speaker: 'Speaker 1', text: 'Full six second clip', startSec: 12, endSec: 18 },
  ];
  assert.deepEqual(extractSpeakerSamples(segments), [
    { speaker: 'Speaker 2', excerpt: 'Exact five seconds', startSec: 10, endSec: 15 },
    { speaker: 'Speaker 1', excerpt: 'Full six second clip', startSec: 12, endSec: 18 },
  ]);
});

test('extractSpeakerSamples falls back to longest timed (earliest tie-break), start-only, then untimed', () => {
  const segments = [
    { speaker: 'Speaker 1', text: 'Two sec', startSec: 0, endSec: 2 },
    { speaker: 'Speaker 1', text: 'Four sec first', startSec: 5, endSec: 9 },
    { speaker: 'Speaker 1', text: 'Four sec tie', startSec: 10, endSec: 14 },
    { speaker: 'Speaker 2', text: 'Untimed first' },
    { speaker: 'Speaker 2', text: 'Start only valid', startSec: 7, endSec: 7 },
    { speaker: 'Speaker 2', text: 'Later start only', startSec: 12 },
    { speaker: 'Speaker 3', text: 'Untimed only', endSec: 5 },
    { speaker: 'Speaker 3', text: 'Second untimed' },
  ];
  assert.deepEqual(extractSpeakerSamples(segments), [
    { speaker: 'Speaker 1', excerpt: 'Four sec first', startSec: 5, endSec: 9 },
    { speaker: 'Speaker 2', excerpt: 'Start only valid', startSec: 7, endSec: 7 },
    { speaker: 'Speaker 3', excerpt: 'Untimed only', startSec: null, endSec: null },
  ]);
});
