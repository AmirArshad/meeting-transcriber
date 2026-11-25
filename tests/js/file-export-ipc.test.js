'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createFileExportIpc,
  computeSpeakerNamesHash,
} = require('../../src/main/file-export-ipc');
const {
  isSafeRecordingsJsonPath,
  isSafeRecordingsMarkdownPath,
} = require('../../src/main-process/path-safety-helpers');
const {
  ROOT,
  extractTopLevelFunctionSource,
  readUtf8,
} = require('./source-scan-helpers');

function sha256Hash(text) {
  return `sha256:${crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')}`;
}

function createHarness(t, { getMeeting = null, showSaveDialogImpl = null } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-file-export-'));
  const userDataDir = path.join(rootDir, 'userData');
  const recordingsDir = path.join(userDataDir, 'recordings');
  const exportsDir = path.join(rootDir, 'exports');
  fs.mkdirSync(recordingsDir, { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });
  t.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const dialogCalls = [];
  const handlers = {};
  const fakeWindow = { id: 101 };
  const fakeEvent = { sender: { id: 202 } };
  let trustedCalls = 0;

  const service = createFileExportIpc({
    app: {
      getPath: (name) => {
        assert.equal(name, 'userData');
        return userDataDir;
      },
      isPackaged: false,
    },
    path,
    fs,
    dialog: {
      showSaveDialog: async (win, options) => {
        dialogCalls.push({ win, options });
        if (typeof showSaveDialogImpl === 'function') {
          return showSaveDialogImpl(win, options, exportsDir);
        }
        return {
          canceled: false,
          filePath: path.join(exportsDir, options.defaultPath),
        };
      },
    },
    BrowserWindow: {
      fromWebContents: (sender) => (sender === fakeEvent.sender ? fakeWindow : null),
    },
    shell: {
      openPath: async () => '',
    },
    isSafeRecordingsMarkdownPath,
    isSafeRecordingsJsonPath,
    getLegalNoticesPath: () => null,
    getMeeting,
    assertTrustedRendererSender: (event) => {
      assert.equal(event, fakeEvent);
      trustedCalls += 1;
    },
    dirname: path.join(ROOT, 'src'),
  });

  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  return {
    rootDir,
    userDataDir,
    recordingsDir,
    exportsDir,
    dialogCalls,
    handlers,
    fakeWindow,
    fakeEvent,
    getTrustedCalls: () => trustedCalls,
    service,
  };
}

test('buildSafeSaveDialogDefaultPath handles extensions, reserved names, illegal chars, and truncation', (t) => {
  const { service } = createHarness(t);
  const { buildSafeSaveDialogDefaultPath } = service;

  assert.equal(buildSafeSaveDialogDefaultPath('Weekly Sync', '.md'), 'Weekly Sync.md');
  assert.equal(buildSafeSaveDialogDefaultPath('Weekly Sync', 'txt'), 'Weekly Sync.txt');
  assert.equal(buildSafeSaveDialogDefaultPath('Weekly Sync', '.json'), 'Weekly Sync.json');
  assert.equal(buildSafeSaveDialogDefaultPath('Weekly Sync', '.srt'), 'Weekly Sync.srt');
  assert.equal(buildSafeSaveDialogDefaultPath('Weekly Sync', 'vtt'), 'Weekly Sync.vtt');

  assert.equal(buildSafeSaveDialogDefaultPath('CON', '.md'), 'file CON.md');
  assert.equal(buildSafeSaveDialogDefaultPath('CON', '.json'), 'file CON.json');
  assert.equal(buildSafeSaveDialogDefaultPath('nul', '.txt'), 'file nul.txt');
  assert.equal(buildSafeSaveDialogDefaultPath('COM1', '.srt'), 'file COM1.srt');
  assert.equal(buildSafeSaveDialogDefaultPath('LPT9', '.vtt'), 'file LPT9.vtt');
  assert.equal(buildSafeSaveDialogDefaultPath('con.txt', '.vtt'), 'file con.vtt');
  assert.equal(buildSafeSaveDialogDefaultPath('con.json', '.json'), 'file con.json');

  assert.equal(buildSafeSaveDialogDefaultPath('Team Sync.md', '.srt'), 'Team Sync.srt');
  assert.equal(buildSafeSaveDialogDefaultPath('Team Sync.TXT', '.vtt'), 'Team Sync.vtt');
  assert.equal(buildSafeSaveDialogDefaultPath('Sync.json', '.json'), 'Sync.json');
  assert.equal(buildSafeSaveDialogDefaultPath('Sync.json', '.md'), 'Sync.md');
  assert.equal(buildSafeSaveDialogDefaultPath('Team Sync.srt', '.md'), 'Team Sync.md');
  assert.equal(buildSafeSaveDialogDefaultPath('Team Sync.vtt', '.txt'), 'Team Sync.txt');

  assert.equal(
    buildSafeSaveDialogDefaultPath('Q4: <Plan> / "Alpha"?*\x01  .. ', '.srt'),
    'Q4 Plan Alpha.srt',
  );
  assert.equal(buildSafeSaveDialogDefaultPath('<>:"/\\|?*', '.vtt'), 'transcript.vtt');
  assert.equal(
    buildSafeSaveDialogDefaultPath('x'.repeat(150), '.srt'),
    `${'x'.repeat(120)}.srt`,
  );
});

test('save-transcript-as without format preserves legacy Summary Save As filters and return shape', async (t) => {
  const harness = createHarness(t);
  const summaryContent = '# Summary\n\n- Action item 1\n';

  const result = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Weekly Sync Summary',
    content: summaryContent,
    title: 'Save Summary',
  });

  assert.equal(harness.getTrustedCalls(), 1);
  assert.equal(harness.dialogCalls.length, 1);
  assert.equal(harness.dialogCalls[0].win, harness.fakeWindow);
  assert.equal(harness.dialogCalls[0].options.title, 'Save Summary');
  assert.equal(harness.dialogCalls[0].options.defaultPath, 'Weekly Sync Summary.md');
  assert.deepEqual(harness.dialogCalls[0].options.filters, [
    { name: 'Markdown', extensions: ['md'] },
    { name: 'Text', extensions: ['txt'] },
    { name: 'All Files', extensions: ['*'] },
  ]);
  assert.deepEqual(result, {
    canceled: false,
    filePath: path.join(harness.exportsDir, 'Weekly Sync Summary.md'),
  });
  assert.equal(fs.readFileSync(result.filePath, 'utf8'), summaryContent);
});

test('save-transcript-as with format md and txt works for Windows-style names and legacy meetings without captions', async (t) => {
  const legacyMeetingId = 'legacy-meeting-1';
  const harness = createHarness(t, {
    getMeeting: async () => ({ ai: { diarization: { speakerNames: { 'Speaker 1': 'Alice' } } } }),
  });

  const markdown = [
    '# Standup Notes',
    '',
    '**Date:** 2026-11-20',
    '---',
    '## Transcript',
    '[00:00 - 00:05] **Speaker 1:** Hello **world**.',
  ].join('\r\n');

  const mdResult = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'C:\\Meetings\\Standup?.md',
    content: markdown,
    format: 'md',
    meetingId: legacyMeetingId,
  });
  assert.equal(mdResult.canceled, false);
  assert.equal(mdResult.ok, true);
  assert.equal(mdResult.format, 'md');
  assert.equal(path.basename(mdResult.filePath), 'C Meetings Standup.md');
  assert.equal(fs.readFileSync(mdResult.filePath, 'utf8'), markdown.replace('**Speaker 1:**', '**Alice:**'));

  const txtResult = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'CON.md',
    content: markdown,
    format: 'txt',
    meetingId: legacyMeetingId,
  });
  assert.equal(txtResult.canceled, false);
  assert.equal(txtResult.ok, true);
  assert.equal(txtResult.format, 'txt');
  assert.equal(path.basename(txtResult.filePath), 'file CON.txt');
  assert.equal(
    fs.readFileSync(txtResult.filePath, 'utf8'),
    'Standup Notes\n\nDate: 2026-11-20\nTranscript\n[00:00 - 00:05] Alice: Hello world.\n',
  );

  const plainPassthrough = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Plain',
    content: '# keep raw markdown header',
    format: 'txt',
    isPlainText: true,
  });
  assert.equal(fs.readFileSync(plainPassthrough.filePath, 'utf8'), '# keep raw markdown header');
});

test('save-transcript-as exports legacy and attempt-scoped captions with CRLF markdown and a dotted parent dir', async (t) => {
  let activeMeeting = null;
  const harness = createHarness(t, {
    getMeeting: async (id) => (activeMeeting && activeMeeting.id === id ? activeMeeting : null),
  });

  const dottedSubdir = path.join(harness.recordingsDir, 'v3.0.recordings');
  fs.mkdirSync(dottedSubdir, { recursive: true });
  const audioPath = path.join(dottedSubdir, 'meet.wav');
  const transcriptPath = path.join(dottedSubdir, 'meet.md');
  const captionsPath = path.join(dottedSubdir, 'meet.captions.json');

  const crlfMarkdown = '# Meeting\r\n\r\n## Transcript\r\n\r\n**[00:00 - 00:02]** Hello team\r\n';
  const normalizedHash = sha256Hash(crlfMarkdown.replace(/\r\n/g, '\n'));

  fs.writeFileSync(audioPath, 'RIFFfake', 'utf8');
  fs.writeFileSync(transcriptPath, crlfMarkdown, 'utf8');
  fs.writeFileSync(
    captionsPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceTranscriptHash: normalizedHash,
      engine: 'faster-whisper',
      timingPrecision: 'word',
      cues: [
        { startMs: 0, endMs: 1200, text: 'Hello team', speaker: 'Speaker <1>' },
        { startMs: 1400, endMs: 2500, text: 'Let us begin.', speaker: 'Speaker 2' },
      ],
    }, null, 2),
    'utf8',
  );

  // Deliberately omit captionsPath on the meeting record so file-export-ipc derives
  // `${stem}.captions.json` from audioPath even when its parent dir contains dots.
  activeMeeting = {
    id: 'dotted-crlf-meeting',
    audioPath,
    transcriptPath,
    ai: { diarization: { speakerNames: { 'Speaker 2': 'Alice' } } },
  };

  const srtResult = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Product Review',
    content: crlfMarkdown,
    format: 'srt',
    meetingId: activeMeeting.id,
    includeSpeakers: true,
  });
  assert.equal(srtResult.ok, true);
  assert.equal(srtResult.format, 'srt');
  assert.equal(
    fs.readFileSync(srtResult.filePath, 'utf8'),
    [
      '1',
      '00:00:00,000 --> 00:00:01,200',
      'Speaker &lt;1&gt;: Hello team',
      '',
      '2',
      '00:00:01,400 --> 00:00:02,500',
      'Alice: Let us begin.',
      '',
    ].join('\n'),
  );

  const attemptStem = 'meet.transcript-11111111-1111-4111-8111-111111111111';
  activeMeeting.transcriptPath = path.join(dottedSubdir, `${attemptStem}.md`);
  activeMeeting.captionsPath = path.join(dottedSubdir, `${attemptStem}.captions.json`);
  fs.renameSync(transcriptPath, activeMeeting.transcriptPath);
  fs.renameSync(captionsPath, activeMeeting.captionsPath);

  const vttResult = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Product Review',
    content: crlfMarkdown,
    format: 'vtt',
    meetingId: activeMeeting.id,
    includeSpeakers: true,
    useVoiceTags: true,
  });
  assert.equal(vttResult.ok, true);
  assert.equal(vttResult.format, 'vtt');
  assert.equal(
    fs.readFileSync(vttResult.filePath, 'utf8'),
    [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:01.200',
      '<v Speaker 1>Hello team',
      '',
      '00:00:01.400 --> 00:00:02.500',
      '<v Alice>Let us begin.',
      '',
    ].join('\n'),
  );
  assert.equal(harness.dialogCalls.length, 2);
});

test('save-transcript-as blocks stale, missing, and invalid captions without opening save dialog', async (t) => {
  let activeMeeting = null;
  const harness = createHarness(t, {
    getMeeting: async (id) => (activeMeeting && activeMeeting.id === id ? activeMeeting : null),
  });

  const audioPath = path.join(harness.recordingsDir, 'sync.wav');
  const transcriptPath = path.join(harness.recordingsDir, 'sync.md');
  const captionsPath = path.join(harness.recordingsDir, 'sync.captions.json');
  const originalMarkdown = '# Sync\n\n## Transcript\n\nOriginal line\n';

  fs.writeFileSync(audioPath, 'wav', 'utf8');
  fs.writeFileSync(transcriptPath, originalMarkdown, 'utf8');
  activeMeeting = {
    id: 'meeting-validation',
    audioPath,
    transcriptPath,
  };

  // 1. Missing sidecar
  const missingRes = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Sync',
    content: originalMarkdown,
    format: 'srt',
    meetingId: activeMeeting.id,
  });
  assert.equal(missingRes.canceled, false);
  assert.equal(missingRes.ok, false);
  assert.equal(missingRes.code, 'CAPTIONS_MISSING');
  assert.equal(harness.dialogCalls.length, 0);

  // 2. Stale sidecar after transcript edit
  fs.writeFileSync(
    captionsPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceTranscriptHash: sha256Hash(originalMarkdown),
      engine: 'parakeet',
      timingPrecision: 'segment',
      cues: [{ startMs: 0, endMs: 1000, text: 'Original line' }],
    }),
    'utf8',
  );
  fs.writeFileSync(transcriptPath, '# Sync\n\n## Transcript\n\nEdited line\n', 'utf8');

  const staleRes = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Sync',
    content: originalMarkdown,
    format: 'vtt',
    meetingId: activeMeeting.id,
  });
  assert.equal(staleRes.canceled, false);
  assert.equal(staleRes.ok, false);
  assert.equal(staleRes.code, 'CAPTIONS_STALE');
  assert.equal(harness.dialogCalls.length, 0);

  // 3. Invalid JSON sidecar
  fs.writeFileSync(captionsPath, '{not-valid-json', 'utf8');
  const badJsonRes = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Sync',
    content: originalMarkdown,
    format: 'srt',
    meetingId: activeMeeting.id,
  });
  assert.equal(badJsonRes.canceled, false);
  assert.equal(badJsonRes.ok, false);
  assert.equal(badJsonRes.code, 'CAPTIONS_INVALID');
  assert.equal(harness.dialogCalls.length, 0);

  // 4. Non-monotonic cues in sidecar
  const editedMarkdown = fs.readFileSync(transcriptPath, 'utf8');
  fs.writeFileSync(
    captionsPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceTranscriptHash: sha256Hash(editedMarkdown),
      engine: 'faster-whisper',
      timingPrecision: 'segment',
      cues: [
        { startMs: 1000, endMs: 2000, text: 'First' },
        { startMs: 1500, endMs: 2500, text: 'Overlapping second' },
      ],
    }),
    'utf8',
  );
  const nonMonotonicRes = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Sync',
    content: editedMarkdown,
    format: 'vtt',
    meetingId: activeMeeting.id,
  });
  assert.equal(nonMonotonicRes.canceled, false);
  assert.equal(nonMonotonicRes.ok, false);
  assert.equal(nonMonotonicRes.code, 'CAPTIONS_INVALID');
  assert.equal(harness.dialogCalls.length, 0);
});

test('save-transcript-as rejects symlinked transcript/sidecar and paths outside recordings directory', async (t) => {
  let activeMeeting = null;
  const harness = createHarness(t, {
    getMeeting: async (id) => (activeMeeting && activeMeeting.id === id ? activeMeeting : null),
  });

  const realMd = path.join(harness.recordingsDir, 'real.md');
  const realJson = path.join(harness.recordingsDir, 'real.captions.json');
  const outsideMd = path.join(harness.rootDir, 'outside.md');
  const outsideJson = path.join(harness.rootDir, 'outside.captions.json');
  const mdText = '# Symlink test\n\n## Transcript\n\nHi\n';

  fs.writeFileSync(realMd, mdText, 'utf8');
  fs.writeFileSync(outsideMd, mdText, 'utf8');
  const validSidecar = JSON.stringify({
    schemaVersion: 1,
    sourceTranscriptHash: sha256Hash(mdText),
    engine: 'faster-whisper',
    timingPrecision: 'segment',
    cues: [{ startMs: 0, endMs: 1000, text: 'Hi' }],
  });
  fs.writeFileSync(realJson, validSidecar, 'utf8');
  fs.writeFileSync(outsideJson, validSidecar, 'utf8');

  // Path outside recordings directory (transcriptPath)
  activeMeeting = {
    id: 'outside-md',
    transcriptPath: outsideMd,
    captionsPath: realJson,
  };
  await assert.rejects(
    harness.handlers['save-transcript-as'](harness.fakeEvent, {
      suggestedName: 'Out',
      content: mdText,
      format: 'srt',
      meetingId: activeMeeting.id,
    }),
    /Transcript file must remain inside the recordings directory/,
  );

  // Path outside recordings directory (captionsPath)
  activeMeeting = {
    id: 'outside-json',
    transcriptPath: realMd,
    captionsPath: outsideJson,
  };
  await assert.rejects(
    harness.handlers['save-transcript-as'](harness.fakeEvent, {
      suggestedName: 'Out',
      content: mdText,
      format: 'vtt',
      meetingId: activeMeeting.id,
    }),
    /Captions sidecar must remain inside the recordings directory/,
  );

  // Symlinked transcript inside recordingsDir
  const symlinkMd = path.join(harness.recordingsDir, 'link.md');
  fs.symlinkSync(realMd, symlinkMd);
  activeMeeting = {
    id: 'symlink-md',
    transcriptPath: symlinkMd,
    captionsPath: realJson,
  };
  await assert.rejects(
    harness.handlers['save-transcript-as'](harness.fakeEvent, {
      suggestedName: 'Link',
      content: mdText,
      format: 'srt',
      meetingId: activeMeeting.id,
    }),
    /Invalid transcript file/,
  );

  // Symlinked captions sidecar inside recordingsDir
  const symlinkJson = path.join(harness.recordingsDir, 'link.captions.json');
  fs.symlinkSync(realJson, symlinkJson);
  activeMeeting = {
    id: 'symlink-json',
    transcriptPath: realMd,
    captionsPath: symlinkJson,
  };
  await assert.rejects(
    harness.handlers['save-transcript-as'](harness.fakeEvent, {
      suggestedName: 'Link',
      content: mdText,
      format: 'vtt',
      meetingId: activeMeeting.id,
    }),
    /Invalid captions sidecar file/,
  );

  assert.equal(harness.dialogCalls.length, 0);
});

test('renderer export modal markup, script order, and summary/transcript save wiring stay intact', () => {
  const indexHtml = readUtf8(path.join(ROOT, 'src', 'renderer', 'index.html'));
  const appJs = readUtf8(path.join(ROOT, 'src', 'renderer', 'app.js'));

  assert.match(indexHtml, /id="transcript-export-modal"/);
  assert.match(indexHtml, /id="transcript-export-options"/);
  assert.match(indexHtml, /id="transcript-export-include-speakers"/);
  assert.match(indexHtml, /id="transcript-export-use-voice-tags"/);
  assert.match(indexHtml, /id="transcript-export-retranscribe-btn"/);

  const helperIdx = indexHtml.indexOf('subtitle-export-helpers.js');
  const appIdx = indexHtml.indexOf('app.js');
  assert.notEqual(helperIdx, -1, 'expected subtitle-export-helpers.js script tag');
  assert.notEqual(appIdx, -1, 'expected app.js script tag');
  assert.ok(helperIdx < appIdx, 'subtitle-export-helpers.js must load before app.js');

  const summarySaveFn = extractTopLevelFunctionSource(appJs, 'saveMeetingSummaryToFile');
  assert.ok(summarySaveFn, 'missing saveMeetingSummaryToFile');
  assert.match(summarySaveFn, /window\.electronAPI\.saveTranscriptAs\(/);
  assert.doesNotMatch(summarySaveFn, /openTranscriptExportDialog/);
  assert.doesNotMatch(summarySaveFn, /\bformat\s*:/);

  const meetingTranscriptSaveFn = extractTopLevelFunctionSource(appJs, 'saveMeetingTranscriptToFile');
  assert.ok(meetingTranscriptSaveFn, 'missing saveMeetingTranscriptToFile');
  assert.match(meetingTranscriptSaveFn, /openTranscriptExportDialog\(/);

  const activeTranscriptSaveFn = extractTopLevelFunctionSource(appJs, 'saveTranscript');
  assert.ok(activeTranscriptSaveFn, 'missing saveTranscript');
  assert.match(activeTranscriptSaveFn, /openTranscriptExportDialog\(/);

  const controlsFn = extractTopLevelFunctionSource(appJs, 'updateTranscriptExportSubtitleControls');
  assert.ok(controlsFn, 'missing updateTranscriptExportSubtitleControls');
  assert.match(controlsFn, /format === 'json'/);
  assert.match(controlsFn, /vttVoiceRow\.hidden = format !== 'vtt'/);
});


test('markdown and text exports survive meeting lookup failure', async (t) => {
  const harness = createHarness(t, { getMeeting: async () => { throw new Error('unavailable'); } });
  const content = '[00:01 - 00:03] **Speaker 1:** Hello';
  for (const format of ['md', 'txt']) {
    const result = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
      suggestedName: `fallback.${format}`, content, format, meetingId: 'meeting-1',
    });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(result.filePath, 'utf8'), format === 'md' ? content : '[00:01 - 00:03] Speaker 1: Hello\n');
  }
});

test('computeSpeakerNamesHash matches Python speaker_names_hash byte-for-byte', () => {
  assert.equal(computeSpeakerNamesHash(null), '');
  assert.equal(computeSpeakerNamesHash({ 'Speaker 1': '' }), '');
  assert.equal(
    computeSpeakerNamesHash({ 'Speaker 2': 'Bob', 'Speaker 1': 'Alice' }),
    'sha256:f0adfc0ce64849b8bcba846b675c12f0f93ef13b4837c25773f926ddbeee3426',
  );
  assert.equal(
    computeSpeakerNamesHash({ 'Speaker 1': '  *Alice* -->\n ', 'SPEAKER_01': 'José 😀!', 'Bad': 'Skip' }),
    'sha256:406f561721816761bd80bc256261ef72b0e881328c9d365b62395b819dc10c83',
  );
});

test('save-transcript-as exports structured JSON with sidecars, speaker overlays, and zero leaked paths', async (t) => {
  let activeMeeting = null;
  const harness = createHarness(t, {
    getMeeting: async (id) => (activeMeeting && activeMeeting.id === id ? activeMeeting : null),
  });

  const audioPath = path.join(harness.recordingsDir, 'meeting_20261125_120000.opus');
  const transcriptPath = path.join(harness.recordingsDir, 'meeting_20261125_120000.md');
  const captionsPath = path.join(harness.recordingsDir, 'meeting_20261125_120000.captions.json');
  const segmentsPath = path.join(harness.recordingsDir, 'meeting_20261125_120000.speakers.json');
  const summaryJsonPath = path.join(harness.recordingsDir, 'meeting_20261125_120000.summary.json');
  const summaryMdPath = path.join(harness.recordingsDir, 'meeting_20261125_120000.summary.md');

  const markdown = [
    '# Audio Transcript',
    '',
    '**Date:** 2026-11-25 12:00:00',
    '---',
    '## Transcript',
    '',
    '**[00:00 - 00:04]** **Speaker 1:** Welcome everyone.',
    '**[00:04 - 00:08]** **Speaker 2:** Let us review the plan.',
    '',
  ].join('\r\n');
  const transcriptHash = sha256Hash(markdown.replace(/\r\n/g, '\n'));
  const speakerNames = { 'Speaker 1': 'Alice', 'Speaker 2': 'Bob' };
  const speakerNamesHash = computeSpeakerNamesHash(speakerNames);
  const summaryMdText = '# Summary\n\nAlice welcomed everyone and Bob reviewed the plan.\n';
  const summaryStructured = {
    summary: 'Alice welcomed everyone and Bob reviewed the plan.',
    template: 'meeting',
    decisions: [{ decision: 'Proceed with release' }],
  };

  fs.writeFileSync(audioPath, 'opus-bytes', 'utf8');
  fs.writeFileSync(transcriptPath, markdown, 'utf8');
  fs.writeFileSync(segmentsPath, JSON.stringify({ segments: [] }), 'utf8');
  fs.writeFileSync(
    captionsPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceTranscriptHash: transcriptHash,
      engine: 'faster-whisper',
      timingPrecision: 'word',
      cues: [
        { startMs: 0, endMs: 4000, speaker: 'Speaker 1', text: 'Welcome everyone.' },
        { startMs: 4000, endMs: 8000, speaker: 'Speaker 2', text: 'Let us review the plan.' },
      ],
    }),
    'utf8',
  );
  fs.writeFileSync(
    summaryJsonPath,
    JSON.stringify({
      summary: summaryStructured,
      metadata: {
        profile: 'balanced',
        model: 'Gemma 3 4B',
        generatedAt: '2026-11-25T12:05:00Z',
        sourceTranscriptHash: transcriptHash,
        speakerNamesHash,
        tag: 'meeting',
        template: 'meeting',
        templateVersion: '1',
        language: 'en',
        languageSource: 'userConfirmed',
        modelId: 'gemma-3-4b',
      },
    }),
    'utf8',
  );
  fs.writeFileSync(summaryMdPath, summaryMdText, 'utf8');

  activeMeeting = {
    id: '20261125_120000',
    title: 'Release Sync',
    date: '2026-11-25T12:00:00',
    duration: '0:08',
    durationSeconds: 8,
    tag: 'meeting',
    language: 'en',
    model: 'large-v3',
    transcriptionStatus: 'completed',
    transcriptionDevice: 'cuda',
    transcriptionComputeType: 'float16',
    transcriptionResult: { engine: 'faster-whisper', device: 'cuda', computeType: 'float16' },
    audioPath,
    transcriptPath,
    captionsPath,
    speakerNamesHash,
    ai: {
      diarization: {
        speakerCount: 2,
        speakerNames,
        segmentsPath,
      },
      summary: {
        status: 'completed',
        language: 'en',
        languageSource: 'userConfirmed',
        modelId: 'gemma-3-4b',
        model: 'Gemma 3 4B',
        modelProfile: 'balanced',
        tag: 'meeting',
        template: 'meeting',
        templateVersion: '1',
        generatedAt: '2026-11-25T12:05:00Z',
        sourceTranscriptHash: transcriptHash,
        speakerNamesHash,
        jsonPath: summaryJsonPath,
        markdownPath: summaryMdPath,
      },
    },
  };

  const result = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'CON',
    content: markdown,
    format: 'json',
    meetingId: activeMeeting.id,
    includeSpeakers: true,
  });

  assert.equal(result.canceled, false);
  assert.equal(result.ok, true);
  assert.equal(result.format, 'json');
  assert.equal(path.basename(result.filePath), 'file CON.json');
  assert.deepEqual(harness.dialogCalls[0].options.filters, [
    { name: 'JSON', extensions: ['json'] },
    { name: 'All Files', extensions: ['*'] },
  ]);

  const rawOut = fs.readFileSync(result.filePath, 'utf8');
  assert.equal(rawOut.endsWith('\n'), true);
  for (const leaked of [
    harness.rootDir,
    harness.recordingsDir,
    audioPath,
    transcriptPath,
    captionsPath,
    segmentsPath,
    summaryJsonPath,
    summaryMdPath,
    'audioPath',
    'transcriptPath',
    'captionsPath',
    'segmentsPath',
    'jsonPath',
    'markdownPath',
  ]) {
    assert.equal(rawOut.includes(leaked), false, `exported JSON leaked ${leaked}`);
  }

  const parsed = JSON.parse(rawOut);
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.format, 'avanevis-transcript');
  assert.deepEqual(parsed.recording, {
    id: '20261125_120000',
    title: 'Release Sync',
    date: '2026-11-25T12:00:00',
    duration: '0:08',
    durationSeconds: 8,
    tag: 'meeting',
    language: 'en',
    model: 'large-v3',
    engine: 'faster-whisper',
    transcriptionStatus: 'completed',
    transcriptionDevice: 'cuda',
    transcriptionComputeType: 'float16',
  });
  assert.deepEqual(parsed.speakers, {
    included: true,
    names: speakerNames,
    speakerNamesHash,
    count: 2,
  });
  assert.match(parsed.transcript.markdown, /\*\*Alice:\*\* Welcome everyone\./);
  assert.match(parsed.transcript.plainText, /\[00:04 - 00:08\] Bob: Let us review the plan\./);
  assert.equal(parsed.transcript.sourceTranscriptHash, transcriptHash);
  assert.equal(parsed.captions.available, true);
  assert.equal(parsed.captions.status, 'ready');
  assert.deepEqual(parsed.captions.cues, [
    { index: 1, startMs: 0, endMs: 4000, speaker: 'Alice', text: 'Welcome everyone.' },
    { index: 2, startMs: 4000, endMs: 8000, speaker: 'Bob', text: 'Let us review the plan.' },
  ]);
  assert.deepEqual(parsed.summary, {
    status: 'completed',
    markdown: summaryMdText,
    structured: summaryStructured,
    language: 'en',
    languageSource: 'userConfirmed',
    modelId: 'gemma-3-4b',
    model: 'Gemma 3 4B',
    modelProfile: 'balanced',
    tag: 'meeting',
    template: 'meeting',
    templateVersion: '1',
    generatedAt: '2026-11-25T12:05:00Z',
    sourceTranscriptHash: transcriptHash,
    speakerNamesHash,
    stale: false,
  });

  // includeSpeakers: false omits speakers across transcript, cues, and speakers section
  const noSpeakerResult = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Sync.json',
    content: markdown,
    format: 'json',
    meetingId: activeMeeting.id,
    includeSpeakers: false,
  });
  assert.equal(path.basename(noSpeakerResult.filePath), 'Sync.json');
  const noSpeakerParsed = JSON.parse(fs.readFileSync(noSpeakerResult.filePath, 'utf8'));
  assert.deepEqual(noSpeakerParsed.speakers, {
    included: false,
    names: {},
    speakerNamesHash: null,
    count: 0,
  });
  assert.doesNotMatch(noSpeakerParsed.transcript.markdown, /\*\*Speaker 1:\*\*|\*\*Alice:\*\*/);
  assert.doesNotMatch(noSpeakerParsed.transcript.plainText, /Speaker 1:|Alice:/);
  assert.deepEqual(noSpeakerParsed.captions.cues, [
    { index: 1, startMs: 0, endMs: 4000, speaker: null, text: 'Welcome everyone.' },
    { index: 2, startMs: 4000, endMs: 8000, speaker: null, text: 'Let us review the plan.' },
  ]);
});

test('save-transcript-as JSON degrades gracefully for missing/stale/malformed captions and marks stale summaries', async (t) => {
  let activeMeeting = null;
  const harness = createHarness(t, {
    getMeeting: async (id) => (activeMeeting && activeMeeting.id === id ? activeMeeting : null),
  });

  const audioPath = path.join(harness.recordingsDir, 'degrade.wav');
  const transcriptPath = path.join(harness.recordingsDir, 'degrade.md');
  const captionsPath = path.join(harness.recordingsDir, 'degrade.captions.json');
  const originalMd = '# Sync\n\n## Transcript\n\nOriginal line\n';
  const editedMd = '# Sync\n\n## Transcript\n\nEdited line\n';

  fs.writeFileSync(audioPath, 'wav', 'utf8');
  fs.writeFileSync(transcriptPath, originalMd, 'utf8');
  activeMeeting = {
    id: 'degrade-1',
    audioPath,
    transcriptPath,
    summary: '# Summary\n\nInitial summary.\n',
    ai: {
      summary: {
        status: 'completed',
        sourceTranscriptHash: sha256Hash(originalMd),
        speakerNamesHash: '',
      },
    },
  };

  // 1. Missing captions -> succeeds with captions.status === 'missing'
  const missingRes = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Degrade Missing',
    content: originalMd,
    format: 'json',
    meetingId: activeMeeting.id,
  });
  assert.equal(missingRes.ok, true);
  let parsed = JSON.parse(fs.readFileSync(missingRes.filePath, 'utf8'));
  assert.deepEqual(parsed.captions, {
    available: false,
    status: 'missing',
    engine: null,
    timingPrecision: null,
    cues: [],
  });
  assert.equal(parsed.summary.stale, false);
  assert.equal(parsed.summary.markdown, '# Summary\n\nInitial summary.\n');

  // 2. Stale captions + stale summary after transcript edit
  fs.writeFileSync(
    captionsPath,
    JSON.stringify({
      schemaVersion: 1,
      sourceTranscriptHash: sha256Hash(originalMd),
      engine: 'parakeet',
      timingPrecision: 'segment',
      cues: [{ startMs: 0, endMs: 1000, text: 'Original line' }],
    }),
    'utf8',
  );
  fs.writeFileSync(transcriptPath, editedMd, 'utf8');

  const staleRes = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Degrade Stale',
    content: originalMd,
    format: 'json',
    meetingId: activeMeeting.id,
  });
  assert.equal(staleRes.ok, true);
  parsed = JSON.parse(fs.readFileSync(staleRes.filePath, 'utf8'));
  assert.deepEqual(parsed.captions, {
    available: false,
    status: 'stale',
    engine: null,
    timingPrecision: null,
    cues: [],
  });
  assert.equal(parsed.summary.stale, true);

  // 3. Malformed captions JSON -> succeeds with captions.status === 'invalid'
  fs.writeFileSync(captionsPath, '{not-valid-json', 'utf8');
  const invalidRes = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Degrade Invalid',
    content: editedMd,
    format: 'json',
    meetingId: activeMeeting.id,
  });
  assert.equal(invalidRes.ok, true);
  parsed = JSON.parse(fs.readFileSync(invalidRes.filePath, 'utf8'));
  assert.deepEqual(parsed.captions, {
    available: false,
    status: 'invalid',
    engine: null,
    timingPrecision: null,
    cues: [],
  });
});

test('save-transcript-as JSON rejects symlinked or out-of-jail transcript/captions/summary paths without opening dialog', async (t) => {
  let activeMeeting = null;
  const harness = createHarness(t, {
    getMeeting: async (id) => (activeMeeting && activeMeeting.id === id ? activeMeeting : null),
  });

  const realMd = path.join(harness.recordingsDir, 'real.md');
  const realCaptions = path.join(harness.recordingsDir, 'real.captions.json');
  const realSummaryJson = path.join(harness.recordingsDir, 'real.summary.json');
  const realSummaryMd = path.join(harness.recordingsDir, 'real.summary.md');

  const outsideMd = path.join(harness.rootDir, 'outside.md');
  const outsideCaptions = path.join(harness.rootDir, 'outside.captions.json');
  const outsideSummaryJson = path.join(harness.rootDir, 'outside.summary.json');
  const outsideSummaryMd = path.join(harness.rootDir, 'outside.summary.md');

  const mdText = '# Jail\n\n## Transcript\n\nHi\n';
  fs.writeFileSync(realMd, mdText, 'utf8');
  fs.writeFileSync(outsideMd, mdText, 'utf8');
  fs.writeFileSync(realCaptions, '{}', 'utf8');
  fs.writeFileSync(outsideCaptions, '{}', 'utf8');
  fs.writeFileSync(realSummaryJson, '{}', 'utf8');
  fs.writeFileSync(outsideSummaryJson, '{}', 'utf8');
  fs.writeFileSync(realSummaryMd, '# S\n', 'utf8');
  fs.writeFileSync(outsideSummaryMd, '# S\n', 'utf8');

  const symlinkMd = path.join(harness.recordingsDir, 'link.md');
  const symlinkCaptions = path.join(harness.recordingsDir, 'link.captions.json');
  const symlinkSummaryJson = path.join(harness.recordingsDir, 'link.summary.json');
  const symlinkSummaryMd = path.join(harness.recordingsDir, 'link.summary.md');
  fs.symlinkSync(realMd, symlinkMd);
  fs.symlinkSync(realCaptions, symlinkCaptions);
  fs.symlinkSync(realSummaryJson, symlinkSummaryJson);
  fs.symlinkSync(realSummaryMd, symlinkSummaryMd);

  const cases = [
    { meeting: { id: '1', transcriptPath: outsideMd }, errorRe: /Transcript file must remain inside the recordings directory/ },
    { meeting: { id: '2', transcriptPath: symlinkMd }, errorRe: /Invalid transcript file/ },
    { meeting: { id: '3', transcriptPath: realMd, captionsPath: outsideCaptions }, errorRe: /Invalid captions sidecar path/ },
    { meeting: { id: '4', transcriptPath: realMd, captionsPath: symlinkCaptions }, errorRe: /Refusing to read symlinked captions sidecar/ },
    { meeting: { id: '5', transcriptPath: realMd, ai: { summary: { status: 'completed', jsonPath: outsideSummaryJson } } }, errorRe: /Invalid summary JSON sidecar path/ },
    { meeting: { id: '6', transcriptPath: realMd, ai: { summary: { status: 'completed', jsonPath: symlinkSummaryJson } } }, errorRe: /Refusing to read symlinked summary JSON sidecar/ },
    { meeting: { id: '7', transcriptPath: realMd, ai: { summary: { status: 'completed', markdownPath: outsideSummaryMd } } }, errorRe: /Invalid summary Markdown sidecar path/ },
    { meeting: { id: '8', transcriptPath: realMd, ai: { summary: { status: 'completed', markdownPath: symlinkSummaryMd } } }, errorRe: /Refusing to read symlinked summary Markdown sidecar/ },
  ];

  for (const testCase of cases) {
    activeMeeting = testCase.meeting;
    await assert.rejects(
      harness.handlers['save-transcript-as'](harness.fakeEvent, {
        suggestedName: 'Bad',
        content: mdText,
        format: 'json',
        meetingId: activeMeeting.id,
      }),
      testCase.errorRe,
    );
  }

  assert.equal(harness.dialogCalls.length, 0);
});

test('save-transcript-as JSON falls back cleanly when getMeeting rejects or meetingId is omitted', async (t) => {
  const failingHarness = createHarness(t, {
    getMeeting: async () => { throw new Error('lookup failed'); },
  });
  const fallbackMd = '# Fallback\n\n**[00:00 - 00:02]** **Speaker 1:** Still works.\n';

  const errFallback = await failingHarness.handlers['save-transcript-as'](failingHarness.fakeEvent, {
    suggestedName: 'Fallback',
    content: fallbackMd,
    format: 'json',
    meetingId: 'missing-1',
  });
  assert.equal(errFallback.ok, true);
  assert.equal(errFallback.format, 'json');
  const parsedFromErr = JSON.parse(fs.readFileSync(errFallback.filePath, 'utf8'));
  assert.equal(parsedFromErr.schemaVersion, 1);
  assert.equal(parsedFromErr.transcript.markdown, fallbackMd);
  assert.equal(parsedFromErr.captions.available, false);
  assert.equal(parsedFromErr.captions.status, 'missing');
  assert.equal(parsedFromErr.summary, null);

  const omittedId = await failingHarness.handlers['save-transcript-as'](failingHarness.fakeEvent, {
    suggestedName: 'No Meeting Id',
    content: fallbackMd,
    format: 'json',
  });
  assert.equal(omittedId.ok, true);
  const parsedOmitted = JSON.parse(fs.readFileSync(omittedId.filePath, 'utf8'));
  assert.equal(parsedOmitted.recording.id, null);
  assert.equal(parsedOmitted.transcript.sourceTranscriptHash, sha256Hash(fallbackMd));
});

test('save-transcript-as JSON skips summary sidecars when summary status is not completed', async (t) => {
  const harness = createHarness(t, {
    getMeeting: async (id) => ({
      id,
      transcriptPath: undefined,
      summary: '# Stale or failed summary text',
      ai: {
        summary: {
          status: 'error',
          jsonPath: path.join(harness.rootDir, 'outside-error.summary.json'),
          markdownPath: path.join(harness.rootDir, 'outside-error.summary.md'),
        },
      },
    }),
  });

  const mdText = '# Sync\n\n## Transcript\n\nHello.\n';
  const result = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Failed Summary',
    content: mdText,
    format: 'json',
    meetingId: 'failed-summary-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.format, 'json');
  const parsed = JSON.parse(fs.readFileSync(result.filePath, 'utf8'));
  assert.equal(parsed.summary, null);
});
