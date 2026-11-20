'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFileExportIpc } = require('../../src/main/file-export-ipc');
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
  assert.equal(buildSafeSaveDialogDefaultPath('Weekly Sync', '.srt'), 'Weekly Sync.srt');
  assert.equal(buildSafeSaveDialogDefaultPath('Weekly Sync', 'vtt'), 'Weekly Sync.vtt');

  assert.equal(buildSafeSaveDialogDefaultPath('CON', '.md'), 'file CON.md');
  assert.equal(buildSafeSaveDialogDefaultPath('nul', '.txt'), 'file nul.txt');
  assert.equal(buildSafeSaveDialogDefaultPath('COM1', '.srt'), 'file COM1.srt');
  assert.equal(buildSafeSaveDialogDefaultPath('LPT9', '.vtt'), 'file LPT9.vtt');
  assert.equal(buildSafeSaveDialogDefaultPath('con.txt', '.vtt'), 'file con.vtt');

  assert.equal(buildSafeSaveDialogDefaultPath('Team Sync.md', '.srt'), 'Team Sync.srt');
  assert.equal(buildSafeSaveDialogDefaultPath('Team Sync.TXT', '.vtt'), 'Team Sync.vtt');
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
    getMeeting: async () => {
      throw new Error('getMeeting should not be required for md/txt exports');
    },
  });

  const markdown = [
    '# Standup Notes',
    '',
    '**Date:** 2026-11-20',
    '---',
    '## Transcript',
    '**[00:00 - 00:05]** **Speaker 1:** Hello **world**.',
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
  assert.equal(fs.readFileSync(mdResult.filePath, 'utf8'), markdown);

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
    'Standup Notes\n\nDate: 2026-11-20\nTranscript\n[00:00 - 00:05] Speaker 1: Hello world.\n',
  );

  const plainPassthrough = await harness.handlers['save-transcript-as'](harness.fakeEvent, {
    suggestedName: 'Plain',
    content: '# keep raw markdown header',
    format: 'txt',
    isPlainText: true,
  });
  assert.equal(fs.readFileSync(plainPassthrough.filePath, 'utf8'), '# keep raw markdown header');
});

test('save-transcript-as exports valid srt and vtt from disk sidecar including CRLF markdown and dotted parent dir', async (t) => {
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
      'Speaker <1>: Hello team',
      '',
      '2',
      '00:00:01,400 --> 00:00:02,500',
      'Speaker 2: Let us begin.',
      '',
    ].join('\n'),
  );

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
      '<v Speaker 2>Let us begin.',
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
});
