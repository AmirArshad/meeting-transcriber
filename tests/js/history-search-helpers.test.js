'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHighlightSegmentsFromParts,
  fallbackFilterMeetingsByTitle,
  findClosestTranscriptSegmentIndex,
  formatJumpTimestamp,
  mergeSearchResultsWithMeetings,
  normalizeHistorySearchQuery,
  parseTimestampStringToSeconds,
} = require('../../src/renderer/history-search-helpers');

test('normalizeHistorySearchQuery trims, collapses whitespace, and caps length', () => {
  assert.equal(normalizeHistorySearchQuery(null), '');
  assert.equal(normalizeHistorySearchQuery('  budget   review \n\t Q4  '), 'budget review Q4');
  assert.equal(normalizeHistorySearchQuery('a'.repeat(700)).length, 500);
});

test('parseTimestampStringToSeconds and formatJumpTimestamp handle MM:SS, HH:MM:SS, and nullish values safely', () => {
  assert.equal(parseTimestampStringToSeconds('00:45'), 45);
  assert.equal(parseTimestampStringToSeconds('01:30'), 90);
  assert.equal(parseTimestampStringToSeconds('1:02:03'), 3723);
  assert.equal(parseTimestampStringToSeconds('invalid'), null);
  assert.equal(parseTimestampStringToSeconds(''), null);

  assert.equal(formatJumpTimestamp(0), '00:00');
  assert.equal(formatJumpTimestamp(862), '14:22');
  assert.equal(formatJumpTimestamp(3661), '1:01:01');
  assert.equal(formatJumpTimestamp(null), '');
  assert.equal(formatJumpTimestamp(undefined), '');
  assert.equal(formatJumpTimestamp(''), '');
  assert.equal(formatJumpTimestamp(false), '');
  assert.equal(formatJumpTimestamp(-5), '');
  assert.equal(formatJumpTimestamp(Number.NaN), '');
});

test('buildHighlightSegmentsFromParts drops invalid entries safely', () => {
  assert.deepEqual(
    buildHighlightSegmentsFromParts([
      { text: 'Agreed on ', match: false },
      { text: 'budget', match: 1 },
      { text: '', match: true },
      null,
    ]),
    [
      { text: 'Agreed on ', match: false },
      { text: 'budget', match: true },
    ],
  );
  assert.deepEqual(buildHighlightSegmentsFromParts('not-array'), []);
});

test('mergeSearchResultsWithMeetings preserves search order and attaches searchMeta to live meetings', () => {
  const meetings = [
    { id: 'm1', title: 'Alpha' },
    { id: 'm2', title: 'Beta' },
    { id: 'm3', title: 'Gamma' },
  ];
  const merged = mergeSearchResultsWithMeetings(meetings, {
    meetings: [
      { meetingId: 'm3', score: -4.2, bestPassage: { startSec: 12, text: 'hello' }, matches: [{ startSec: 12 }] },
      { meetingId: 'm_deleted', score: -3.0, bestPassage: { text: 'gone' }, matches: [] },
      { meetingId: 'm1', score: -1.5, bestPassage: { startSec: null, text: 'world' }, matches: [] },
      { meetingId: 'm3', score: -0.5, bestPassage: { text: 'dup' }, matches: [] },
    ],
  });

  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((m) => m.id), ['m3', 'm1']);
  assert.equal(merged[0].searchMeta.bestPassage.startSec, 12);
  assert.equal(merged[0].searchMeta.score, -4.2);
});

test('fallbackFilterMeetingsByTitle matches case-insensitive titles only', () => {
  const meetings = [
    { id: '1', title: 'Q4 Launch Sync' },
    { id: '2', title: 'Design Crit' },
  ];
  assert.deepEqual(fallbackFilterMeetingsByTitle(meetings, ''), meetings);
  assert.deepEqual(fallbackFilterMeetingsByTitle(meetings, 'launch').map((m) => m.id), ['1']);
});

test('findClosestTranscriptSegmentIndex prefers containing span, supports start string fallback, and rejects null targets', () => {
  const segments = [
    { start: '00:00', end: '00:20' },
    { startSec: null, endSec: null, start: '01:00', end: '01:30' },
    { startSec: 180, endSec: 210 },
  ];

  assert.equal(findClosestTranscriptSegmentIndex(segments, 10), 0);
  assert.equal(findClosestTranscriptSegmentIndex(segments, 75), 1);
  assert.equal(findClosestTranscriptSegmentIndex(segments, 100), 1);
  assert.equal(findClosestTranscriptSegmentIndex(segments, 150), 2);
  assert.equal(findClosestTranscriptSegmentIndex(segments, 170), 2);
  assert.equal(findClosestTranscriptSegmentIndex(segments, null), -1);
  assert.equal(findClosestTranscriptSegmentIndex(segments, ''), -1);
  assert.equal(findClosestTranscriptSegmentIndex(segments, false), -1);
  assert.equal(findClosestTranscriptSegmentIndex([], 10), -1);
});

test('mergeSearchResultsWithMeetings and fallbackFilterMeetingsByTitle support optional tag filter', () => {
  const meetings = [
    { id: '1', title: 'Q4 Launch Sync', tag: 'meeting' },
    { id: '2', title: 'Q4 Design Crit', tag: 'brainstorm' },
    { id: '3', title: 'Untagged Q4' },
  ];

  const merged = mergeSearchResultsWithMeetings(
    meetings,
    {
      meetings: [
        { meetingId: '2', score: -2.0, matches: [] },
        { meetingId: '1', score: -1.0, matches: [] },
        { meetingId: '3', score: -0.5, matches: [] },
      ],
    },
    { tag: 'Brainstorm' },
  );
  assert.deepEqual(merged.map((m) => m.id), ['2']);

  assert.deepEqual(
    fallbackFilterMeetingsByTitle(meetings, 'q4', { tag: 'meeting' }).map((m) => m.id),
    ['1'],
  );
  assert.deepEqual(
    fallbackFilterMeetingsByTitle(meetings, 'q4', { tag: null }).map((m) => m.id),
    ['1', '2', '3'],
  );
});

test('History search normalizes recording tags and filter aliases', () => {
  const meetings = [
    { id: 'note', title: 'Project memo', tag: 'Voice Memo' },
    { id: 'call', title: 'Project update', tag: 'call' },
    { id: 'untagged', title: 'Project notes' },
  ];
  const hits = { meetings: meetings.map(({ id }) => ({ meetingId: id })) };

  assert.deepEqual(
    mergeSearchResultsWithMeetings(meetings, hits, { tag: ' voice_note ' }).map(({ id }) => id),
    ['note'],
  );
  assert.deepEqual(
    fallbackFilterMeetingsByTitle(meetings, 'project', { tag: 'Phone / Support Call' }).map(({ id }) => id),
    ['call'],
  );
  assert.deepEqual(fallbackFilterMeetingsByTitle(meetings, 'project', { tag: 'unknown' }), []);
});
