'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RECORDING_TAGS,
  VALID_RECORDING_TAGS,
  filterMeetingsByTag,
  getSummaryTagMismatch,
  getTagMeta,
  getUsedRecordingTags,
  normalizeTag,
  normalizeTagStrict,
  normalizeTagsFilter,
} = require('../../src/renderer/tag-helpers');

test('RECORDING_TAGS exposes all 11 unique canonical tags and metadata', () => {
  assert.equal(RECORDING_TAGS.length, 11);
  assert.equal(VALID_RECORDING_TAGS.length, 11);
  assert.equal(new Set(VALID_RECORDING_TAGS).size, 11);
  assert.deepEqual(VALID_RECORDING_TAGS, [
    'meeting',
    'appointment',
    'call',
    'interview',
    'lecture',
    'podcast',
    'video',
    'voice-note',
    'brainstorm',
    'music',
    'other',
  ]);
  for (const entry of RECORDING_TAGS) {
    assert.ok(entry.slug && entry.label && entry.shortLabel && entry.dotColor && entry.formatPreview);
  }
});

test('normalizeTag, normalizeTagStrict, and getTagMeta resolve slugs/aliases and reject unknown values', () => {
  assert.equal(normalizeTag('Meeting'), 'meeting');
  assert.equal(normalizeTag('Phone / Support Call'), 'call');
  assert.equal(normalizeTag('voice_memo'), 'voice-note');
  assert.equal(normalizeTag('rehearsal'), 'music');
  assert.equal(normalizeTag('   '), null);
  assert.equal(normalizeTag(null), null);
  assert.equal(normalizeTag(42), null);
  assert.equal(normalizeTag('unknown-type'), null);

  assert.equal(normalizeTagStrict(null), null);
  assert.equal(normalizeTagStrict(undefined), null);
  assert.equal(normalizeTagStrict('   '), null);
  assert.equal(normalizeTagStrict('Lecture / Study'), 'lecture');
  assert.throws(() => normalizeTagStrict('unknown-type'), /Unsupported recording tag/);
  assert.throws(() => normalizeTagStrict(123), /Unsupported recording tag/);

  assert.equal(getTagMeta('call')?.label, 'Phone / Support Call');
  assert.equal(getTagMeta('unknown'), null);
});

test('normalizeTagsFilter dedupes, preserves canonical normalization, and rejects malformed inputs', () => {
  assert.deepEqual(normalizeTagsFilter(null), []);
  assert.deepEqual(normalizeTagsFilter(undefined), []);
  assert.deepEqual(normalizeTagsFilter([]), []);
  assert.deepEqual(
    normalizeTagsFilter(['Voice Memo', 'call', 'voice-note', 'Brainstorming']),
    ['voice-note', 'call', 'brainstorm'],
  );

  assert.throws(() => normalizeTagsFilter('call'), /Invalid recording tags filter/);
  assert.throws(() => normalizeTagsFilter(['']), /Unsupported recording tag/);
  assert.throws(() => normalizeTagsFilter(['meeting', 'nope']), /Unsupported recording tag/);
});

test('getUsedRecordingTags and filterMeetingsByTag follow canonical order and normalized tags', () => {
  const meetings = [
    { id: '1', title: 'Song Take', tag: 'music' },
    { id: '2', title: 'Untagged' },
    { id: '3', title: 'Daily Sync', tag: 'Meeting' },
    { id: '4', title: 'Second Music', tag: 'music' },
  ];

  const used = getUsedRecordingTags(meetings);
  assert.deepEqual(used.map((entry) => entry.slug), ['meeting', 'music']);

  assert.deepEqual(filterMeetingsByTag(meetings, null), meetings);
  assert.deepEqual(filterMeetingsByTag(meetings, 'MUSIC').map((m) => m.id), ['1', '4']);
  assert.deepEqual(filterMeetingsByTag(meetings, 'podcast'), []);
});

test('getSummaryTagMismatch detects stale template tags across v3.1 and legacy v3.0 summaries', () => {
  // Missing summary -> null
  assert.equal(getSummaryTagMismatch({ id: 'm1', tag: 'lecture' }), null);

  // Untagged recording -> null
  assert.equal(
    getSummaryTagMismatch({ id: 'm2', tag: null, summary: '# Summary', ai: { summary: { status: 'completed', templateVersion: 'tag-templates-v1', tag: null } } }),
    null,
  );

  // Matching v3.1 summary -> null
  assert.equal(
    getSummaryTagMismatch({
      id: 'm3',
      tag: 'interview',
      summary: '# Summary',
      ai: { summary: { status: 'completed', tag: 'interview', templateVersion: 'tag-templates-v1' } },
    }),
    null,
  );

  // Mismatched v3.1 summary
  assert.deepEqual(
    getSummaryTagMismatch({
      id: 'm4',
      tag: 'podcast',
      summary: '# Summary',
      ai: { summary: { status: 'completed', tag: 'interview', templateVersion: 'tag-templates-v1' } },
    }),
    {
      currentTag: 'podcast',
      currentLabel: 'Podcast',
      summaryTag: 'interview',
      summaryLabel: 'Interview',
    },
  );

  // v3.1 untagged summary (templateVersion present, tag null -> 'other') mismatch when later tagged
  assert.deepEqual(
    getSummaryTagMismatch({
      id: 'm5',
      tag: 'lecture',
      summary: '# Summary',
      ai: { summary: { status: 'completed', tag: null, templateVersion: 'tag-templates-v1' } },
    }),
    {
      currentTag: 'lecture',
      currentLabel: 'Lecture / Study',
      summaryTag: 'other',
      summaryLabel: 'Other',
    },
  );

  // Legacy v3.0 summary (no templateVersion) defaults to 'meeting':
  assert.equal(
    getSummaryTagMismatch({
      id: 'm6',
      tag: 'meeting',
      summary: '# Summary',
      ai: { summary: { status: 'completed' } },
    }),
    null,
  );
  assert.deepEqual(
    getSummaryTagMismatch({
      id: 'm7',
      tag: 'lecture',
      summary: '# Summary',
      ai: { summary: { status: 'completed' } },
    }),
    {
      currentTag: 'lecture',
      currentLabel: 'Lecture / Study',
      summaryTag: 'meeting',
      summaryLabel: 'Meeting',
    },
  );
});

test('hydrated empty summaries do not show a tag mismatch', () => {
  for (const summary of ['', '  \n']) {
    assert.equal(getSummaryTagMismatch({
      tag: 'podcast', summary,
      ai: { summary: { status: 'completed', tag: 'meeting' } },
    }), null);
  }
  assert.ok(getSummaryTagMismatch({
    tag: 'podcast', ai: { summary: { status: 'completed', tag: 'meeting' } },
  }));
});

test('a summary format override only shows a mismatch after a change to a different tag', () => {
  const summary = { status: 'completed', tag: 'interview', template: 'meeting' };
  const meeting = { tag: 'interview', ai: { summary } };
  assert.equal(getSummaryTagMismatch(meeting), null);
  assert.equal(getSummaryTagMismatch({ ...meeting, tag: 'meeting' }), null);
  assert.equal(getSummaryTagMismatch({ ...meeting, tag: 'podcast' }).currentTag, 'podcast');
  assert.equal(getSummaryTagMismatch({ tag: 'other', ai: { summary: { ...summary, tag: null } } }).currentTag, 'other');
});
