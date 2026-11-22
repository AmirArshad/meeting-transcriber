'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  CAPTIONS_SCHEMA_VERSION,
  MIN_CUE_DURATION_MS,
  VALID_CAPTION_ENGINES,
  VALID_EXPORT_FORMATS,
  VALID_TIMING_PRECISIONS,
  buildExportFormatOptions,
  convertTranscriptMarkdownToPlainText,
  formatSrtTimestamp,
  formatVttTimestamp,
  normalizeSubtitleCues,
  serializeCuesToSrt,
  serializeCuesToVtt,
  validateCaptionsSidecar,
} = require('../../src/renderer/subtitle-export-helpers');

function sha256Hash(text) {
  return `sha256:${crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

test('formatSrtTimestamp uses comma decimal and clamps invalid/negative values', () => {
  assert.equal(formatSrtTimestamp(0), '00:00:00,000');
  assert.equal(formatSrtTimestamp(3723045), '01:02:03,045');
  assert.equal(formatSrtTimestamp(3723044.6), '01:02:03,045');
  assert.equal(formatSrtTimestamp(-1), '00:00:00,000');
  assert.equal(formatSrtTimestamp(-5000), '00:00:00,000');
  assert.equal(formatSrtTimestamp(Number.NaN), '00:00:00,000');
  assert.equal(formatSrtTimestamp(Number.POSITIVE_INFINITY), '00:00:00,000');
  assert.equal(formatSrtTimestamp(undefined), '00:00:00,000');
});

test('formatVttTimestamp uses dot decimal and clamps invalid/negative values', () => {
  assert.equal(formatVttTimestamp(0), '00:00:00.000');
  assert.equal(formatVttTimestamp(3723045), '01:02:03.045');
  assert.equal(formatVttTimestamp(-100), '00:00:00.000');
  assert.equal(formatVttTimestamp(Number.NaN), '00:00:00.000');
  assert.equal(formatVttTimestamp('not-a-number'), '00:00:00.000');
});

test('normalizeSubtitleCues enforces strict monotonic bounds, min duration, sanitization, and blank skipping', () => {
  const cues = normalizeSubtitleCues([
    null,
    'invalid',
    { startMs: 0, endMs: 500, text: '   \n\t  ' },
    { startMs: 2000, endMs: 2500, text: 'Second   line\r\nwith --> arrow', speaker: '  Speaker   2 ' },
    { startMs: 500, endMs: 1200, text: 'First cue' },
    { startMs: 1000, endMs: 1600, text: 'Overlaps first' },
    { startMs: 1600, endMs: 1620, text: 'Too short' },
    { start: 3.0, end: 4.5, text: 'From seconds' },
  ]);

  assert.equal(cues.length, 5);
  assert.deepEqual(cues[0], { startMs: 500, endMs: 1000, text: 'First cue' });
  assert.deepEqual(cues[1], { startMs: 1000, endMs: 1600, text: 'Overlaps first' });
  assert.deepEqual(cues[2], { startMs: 1600, endMs: 1600 + MIN_CUE_DURATION_MS, text: 'Too short' });
  assert.deepEqual(cues[3], {
    startMs: 2000,
    endMs: 2500,
    text: 'Second line with -> arrow',
    speaker: 'Speaker 2',
  });
  assert.deepEqual(cues[4], { startMs: 3000, endMs: 4500, text: 'From seconds' });

  for (let i = 0; i < cues.length; i += 1) {
    assert.ok(cues[i].endMs - cues[i].startMs >= MIN_CUE_DURATION_MS);
    if (i > 0) {
      assert.ok(cues[i].startMs >= cues[i - 1].endMs);
    }
  }
});

test('normalizeSubtitleCues shifts next cue start when previous cue cannot shrink below MIN_CUE_DURATION_MS', () => {
  const cues = normalizeSubtitleCues([
    { startMs: 100, endMs: 500, text: 'Cue A' },
    { startMs: 150, endMs: 400, text: 'Cue B' },
  ]);

  assert.deepEqual(cues, [
    { startMs: 100, endMs: 500, text: 'Cue A' },
    { startMs: 500, endMs: 500 + MIN_CUE_DURATION_MS, text: 'Cue B' },
  ]);
  assert.deepEqual(normalizeSubtitleCues([]), []);
  assert.deepEqual(normalizeSubtitleCues(null), []);
});

test('serializeCuesToSrt emits 1-based blocks and toggles speaker prefixes', () => {
  const cues = [
    { startMs: 0, endMs: 1250, text: 'Hello there.', speaker: 'Speaker 1' },
    { startMs: 1500, endMs: 3723045, text: 'General Kenobi.' },
  ];

  const withSpeakers = serializeCuesToSrt(cues, { includeSpeakers: true });
  assert.equal(
    withSpeakers,
    [
      '1',
      '00:00:00,000 --> 00:00:01,250',
      'Speaker 1: Hello there.',
      '',
      '2',
      '00:00:01,500 --> 01:02:03,045',
      'General Kenobi.',
      '',
    ].join('\n'),
  );

  const withoutSpeakers = serializeCuesToSrt(cues, { includeSpeakers: false });
  assert.equal(
    withoutSpeakers,
    [
      '1',
      '00:00:00,000 --> 00:00:01,250',
      'Hello there.',
      '',
      '2',
      '00:00:01,500 --> 01:02:03,045',
      'General Kenobi.',
      '',
    ].join('\n'),
  );

  assert.equal(serializeCuesToSrt([]), '');
});

test('serializeCuesToVtt formats WEBVTT header, plain speaker prefixes, and sanitized <v> voice tags', () => {
  assert.equal(serializeCuesToVtt([]), 'WEBVTT\n');

  const cues = [
    { startMs: 0, endMs: 1200, text: 'Welcome everyone.', speaker: 'Speaker <1> & "Host"\r\n' },
    { startMs: 1500, endMs: 2600, text: 'Ready to begin.', speaker: '<>&' },
  ];

  const plainVtt = serializeCuesToVtt(cues, { includeSpeakers: true, useVoiceTags: false });
  assert.equal(
    plainVtt,
    [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.200',
      'Speaker &lt;1&gt; &amp; "Host": Welcome everyone.',
      '',
      '00:00:01.500 --> 00:00:02.600',
      '&lt;&gt;&amp;: Ready to begin.',
      '',
    ].join('\n'),
  );

  const voicedVtt = serializeCuesToVtt(cues, { includeSpeakers: true, useVoiceTags: true });
  assert.equal(
    voicedVtt,
    [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.200',
      '<v Speaker 1 "Host">Welcome everyone.',
      '',
      '00:00:01.500 --> 00:00:02.600',
      'Ready to begin.',
      '',
    ].join('\n'),
  );

  const noSpeakerVtt = serializeCuesToVtt(cues, { includeSpeakers: false, useVoiceTags: true });
  assert.equal(
    noSpeakerVtt,
    [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.200',
      'Welcome everyone.',
      '',
      '00:00:01.500 --> 00:00:02.600',
      'Ready to begin.',
      '',
    ].join('\n'),
  );
});

test('convertTranscriptMarkdownToPlainText strips Markdown formatting and normalizes timestamps', () => {
  const markdown = [
    '# Weekly Sync',
    '',
    '**Date:** 2026-11-20',
    '**Language:** en',
    '',
    '---',
    '',
    '## Transcript',
    '',
    '**[00:00 - 00:13]** **Speaker 1:** We should **ship** this today.',
    '**[01:02:03 - 01:02:15]** Sounds good.',
    '***',
    '___',
    '### Notes',
    'Follow-up with **Alex** tomorrow.',
  ].join('\r\n');

  const plain = convertTranscriptMarkdownToPlainText(markdown);
  assert.equal(
    plain,
    [
      'Weekly Sync',
      '',
      'Date: 2026-11-20',
      'Language: en',
      '',
      'Transcript',
      '',
      '[00:00 - 00:13] Speaker 1: We should ship this today.',
      '[01:02:03 - 01:02:15] Sounds good.',
      'Notes',
      'Follow-up with Alex tomorrow.',
      '',
    ].join('\n'),
  );
});

test('validateCaptionsSidecar validates schema-v1 payloads and reports exact failure codes', () => {
  const expectedHash = sha256Hash('# Meeting\n\n## Transcript\n\nHello world');
  const validPayload = {
    schemaVersion: CAPTIONS_SCHEMA_VERSION,
    sourceTranscriptHash: expectedHash,
    engine: 'faster-whisper',
    timingPrecision: 'segment',
    cues: [
      { startMs: 0, endMs: 1000, text: 'Hello world', speaker: 'Speaker 1' },
      { startMs: 1000, endMs: 2200, text: 'Second cue' },
    ],
  };

  assert.deepEqual(VALID_EXPORT_FORMATS, ['md', 'txt', 'srt', 'vtt']);
  assert.ok(VALID_CAPTION_ENGINES.includes('parakeet'));
  assert.ok(VALID_TIMING_PRECISIONS.includes('word'));

  const okResult = validateCaptionsSidecar(validPayload, expectedHash);
  assert.equal(okResult.valid, true);
  assert.equal(okResult.code, 'ok');
  assert.equal(okResult.engine, 'faster-whisper');
  assert.equal(okResult.timingPrecision, 'segment');
  assert.equal(okResult.cues.length, 2);

  assert.equal(validateCaptionsSidecar(null, expectedHash).code, 'CAPTIONS_MISSING');
  assert.equal(validateCaptionsSidecar(undefined, expectedHash).code, 'CAPTIONS_MISSING');
  assert.equal(validateCaptionsSidecar([], expectedHash).code, 'CAPTIONS_INVALID');
  assert.equal(
    validateCaptionsSidecar({ ...validPayload, schemaVersion: 2 }, expectedHash).code,
    'CAPTIONS_INVALID',
  );
  assert.equal(
    validateCaptionsSidecar({ ...validPayload, sourceTranscriptHash: 'sha256:bad' }, expectedHash).code,
    'CAPTIONS_INVALID',
  );
  assert.equal(
    validateCaptionsSidecar({ ...validPayload, engine: 'unknown-engine' }, expectedHash).code,
    'CAPTIONS_INVALID',
  );
  assert.equal(
    validateCaptionsSidecar({ ...validPayload, timingPrecision: 'char' }, expectedHash).code,
    'CAPTIONS_INVALID',
  );
  assert.equal(
    validateCaptionsSidecar({ ...validPayload, cues: 'not-array' }, expectedHash).code,
    'CAPTIONS_INVALID',
  );
  assert.equal(
    validateCaptionsSidecar({
      ...validPayload,
      cues: [
        { startMs: 1000, endMs: 2000, text: 'A' },
        { startMs: 1500, endMs: 2500, text: 'B' },
      ],
    }, expectedHash).code,
    'CAPTIONS_INVALID',
  );
  assert.equal(
    validateCaptionsSidecar({
      ...validPayload,
      cues: [{ startMs: 0, endMs: 1000, text: '   ' }],
    }, expectedHash).code,
    'CAPTIONS_INVALID',
  );
  assert.equal(
    validateCaptionsSidecar({
      ...validPayload,
      cues: [{ startMs: 0, endMs: 1000, text: 'Hi', speaker: '   ' }],
    }, expectedHash).code,
    'CAPTIONS_INVALID',
  );
  assert.equal(
    validateCaptionsSidecar({
      ...validPayload,
      cues: [{ startMs: 0, endMs: 1000, text: 'Hi', speaker: 123 }],
    }, expectedHash).code,
    'CAPTIONS_INVALID',
  );
  assert.equal(
    validateCaptionsSidecar(validPayload, sha256Hash('different transcript')).code,
    'CAPTIONS_STALE',
  );
  assert.equal(
    validateCaptionsSidecar({ ...validPayload, cues: [] }, expectedHash).code,
    'CAPTIONS_MISSING',
  );
});

test('buildExportFormatOptions sets format availability, notices, and canRetranscribe correctly', () => {
  const ready = buildExportFormatOptions({
    captionsAvailable: true,
    captionsStatus: 'ready',
    hasAudio: true,
  });
  assert.equal(ready.defaultFormat, 'md');
  assert.equal(ready.captionsUnavailableNotice, '');
  assert.equal(ready.canRetranscribe, false);
  assert.deepEqual(
    ready.options.map((opt) => ({ format: opt.format, available: opt.available })),
    [
      { format: 'md', available: true },
      { format: 'txt', available: true },
      { format: 'srt', available: true },
      { format: 'vtt', available: true },
    ],
  );

  const missingWithAudio = buildExportFormatOptions({
    captionsAvailable: false,
    captionsStatus: 'missing',
    hasAudio: true,
  });
  assert.equal(missingWithAudio.canRetranscribe, true);
  assert.match(missingWithAudio.captionsUnavailableNotice, /exact segment timings/i);
  assert.deepEqual(
    missingWithAudio.options.map((opt) => ({ format: opt.format, available: opt.available })),
    [
      { format: 'md', available: true },
      { format: 'txt', available: true },
      { format: 'srt', available: false },
      { format: 'vtt', available: false },
    ],
  );
  assert.ok(missingWithAudio.options.find((opt) => opt.format === 'srt').disabledReason);
  assert.ok(missingWithAudio.options.find((opt) => opt.format === 'vtt').disabledReason);

  const staleWithoutAudio = buildExportFormatOptions({
    captionsAvailable: false,
    captionsStatus: 'stale',
    hasAudio: false,
  });
  assert.equal(staleWithoutAudio.canRetranscribe, false);
  assert.match(staleWithoutAudio.captionsUnavailableNotice, /changed after its subtitle timings/i);
  assert.equal(staleWithoutAudio.options.find((opt) => opt.format === 'md').available, true);
  assert.equal(staleWithoutAudio.options.find((opt) => opt.format === 'txt').available, true);
  assert.equal(staleWithoutAudio.options.find((opt) => opt.format === 'srt').available, false);
  assert.equal(staleWithoutAudio.options.find((opt) => opt.format === 'vtt').available, false);
});

test('speaker overlays are applied to markdown and subtitle formats without changing inputs', () => {
  const helpers = require('../../src/renderer/subtitle-export-helpers');
  const names = { 'Speaker 1': 'Alice' };
  const markdown = '**[00:01 - 00:02]**\n**Speaker 1:** Hello';
  assert.equal(helpers.applySpeakerNamesToMarkdown(markdown, names), '**[00:01 - 00:02]**\n**Alice:** Hello');
  const cues = [{ startMs: 1000, endMs: 2000, speaker: 'Speaker 1', text: 'Hello' }];
  assert.match(helpers.serializeCuesToSrt(cues, { speakerNames: names }), /Alice: Hello/);
  assert.match(helpers.serializeCuesToVtt(cues, { speakerNames: names, useVoiceTags: true }), /<v Alice>Hello/);
  assert.equal(cues[0].speaker, 'Speaker 1');
});

test('speaker replacement only touches label positions and escapes output markup', () => {
  const helpers = require('../../src/renderer/subtitle-export-helpers');
  const source = '**[00:01 - 00:02]** **Speaker 1:** Mention **Speaker 1:** in speech.\n**Speaker 1:** More';
  const names = { 'Speaker 1': 'A_[x]<tag>&' };
  const result = helpers.applySpeakerNamesToMarkdown(source, names);
  assert.match(result, /Mention \*\*Speaker 1:\*\*/);
  assert.match(result, /A\\_\\\[x\\\]\\<tag\\>&/);
  assert.match(helpers.convertTranscriptMarkdownToPlainText(result), /A_\[x\]<tag>&: Mention/);
  const cues = [{ startMs: 0, endMs: 1000, speaker: 'Speaker 1', text: 'Hi' }];
  assert.match(helpers.serializeCuesToSrt(cues, { speakerNames: names }), /A_\[x\]&lt;tag&gt;&amp;: Hi/);
  assert.doesNotMatch(helpers.serializeCuesToVtt(cues, { speakerNames: names, useVoiceTags: true }), /<tag>/);
});


test('speaker exports handle unbolded timestamps, nested arrows and inherited names', () => {
  const { applySpeakerNamesToMarkdown } = require('../../src/renderer/subtitle-export-helpers');
  const transcript = '[00:01 - 00:03] **Speaker 1:** Hello';
  const named = applySpeakerNamesToMarkdown(transcript, { 'Speaker 1': 'A--->->B' });
  assert.equal(named, '[00:01 - 00:03] **AB:** Hello');
  assert.equal(convertTranscriptMarkdownToPlainText(named), '[00:01 - 00:03] AB: Hello\n');
  assert.equal(applySpeakerNamesToMarkdown(transcript, Object.create({ 'Speaker 1': 'Inherited' })), transcript);
  const cues = [{ start: 0, end: 1, text: 'Hi', speaker: 'Speaker 1' }];
  assert.match(serializeCuesToVtt(cues, { useVoiceTags: true, speakerNames: { 'Speaker 1': 'A--->->B' } }), /<v AB>Hi/);
  assert.match(serializeCuesToSrt(cues, { speakerNames: Object.create({ 'Speaker 1': 'Inherited' }) }), /Speaker 1: Hi/);
  assert.match(serializeCuesToVtt([{ ...cues[0], speaker: 'A--->->B' }], { useVoiceTags: true }), /<v AB>Hi/);
});
