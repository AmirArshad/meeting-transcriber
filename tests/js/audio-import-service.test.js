'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createAudioImportService } = require('../../src/main/audio-import-service');
const ffmpegPath = process.env.AVANEVIS_TEST_FFMPEG
  ? path.resolve(process.env.AVANEVIS_TEST_FFMPEG) : 'ffmpeg';

test('imports real WAV, MP3 and Opus as playable owned copies and preserves sources', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avanevis-import-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let source;
  const phases = [];
  const service = createAudioImportService({
    dialog: { showOpenDialog: async () => ({ filePaths: [source] }) },
    getMainWindow: () => null, getRecordingsDir: () => path.join(root, 'recordings'),
    ffmpegPath, isQuitCommitted: () => false, validateImportSelection: async () => {},
    sendToRenderer: (_channel, payload) => phases.push(payload.phase),
    finalizeRecordingTranscription: async ({ audioPath, duration, title }) => {
      assert.ok(duration > 0);
      assert.equal(title, 'sample');
      execFileSync(ffmpegPath, ['-v', 'error', '-i', audioPath, '-f', 'null', '-']);
      return { success: true, meeting: { id: '1' } };
    },
  });
  for (const ext of ['wav', 'mp3', 'opus']) {
    source = path.join(root, `sample.${ext}`);
    execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2', '-y', source]);
    const original = await fs.readFile(source);
    assert.equal((await service.select()).name, `sample.${ext}`);
    assert.equal((await service.start({})).success, true);
    assert.deepEqual(await fs.readFile(source), original);
    assert.deepEqual(await fs.readdir(path.join(root, 'recordings')), []);
  }
  assert.deepEqual(phases, ['preparing', 'saving', 'preparing', 'saving', 'preparing', 'saving']);
  source = path.join(root, 'bad.wav');
  await fs.writeFile(source, 'bad');
  await service.select();
  assert.equal((await service.start({})).code, 'IMPORT_INVALID_AUDIO');
  assert.equal(await fs.readFile(source, 'utf8'), 'bad');
  assert.deepEqual(await fs.readdir(path.join(root, 'recordings')), []);
  source = path.join(root, 'empty.wav');
  await fs.writeFile(source, '');
  await service.select();
  assert.equal((await service.start({})).code, 'IMPORT_INVALID_AUDIO');
  assert.equal((await fs.stat(source)).size, 0);
  assert.deepEqual(await fs.readdir(path.join(root, 'recordings')), []);
});

test('busy and cancellation settle before staging and never commit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avanevis-import-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'sample.wav');
  await fs.writeFile(source, 'source');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let commits = 0;
  const service = createAudioImportService({
    dialog: { showOpenDialog: async () => ({ filePaths: [source] }) },
    getMainWindow: () => null, getRecordingsDir: () => path.join(root, 'recordings'),
    ffmpegPath, isQuitCommitted: () => false,
    validateImportSelection: () => gate, sendToRenderer: () => {},
    finalizeRecordingTranscription: async () => { commits += 1; },
  });
  await service.select();
  const started = service.start({});
  assert.equal((await service.start({})).code, 'IMPORT_BUSY');
  const cancelled = service.cancel();
  release();
  assert.equal((await started).code, 'IMPORT_CANCELLED');
  assert.equal((await cancelled).success, true);
  assert.equal(commits, 0);
  assert.equal(await fs.readFile(source, 'utf8'), 'source');
});

test('failed save can retry the same source; a saved admission failure clears it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avanevis-import-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'private.wav');
  execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', '-y', source]);
  let calls = 0;
  const service = createAudioImportService({
    dialog: { showOpenDialog: async () => ({ filePaths: [source] }) }, getMainWindow: () => null,
    getRecordingsDir: () => path.join(root, 'recordings'), ffmpegPath,
    isQuitCommitted: () => false, validateImportSelection: async () => {}, sendToRenderer: () => {},
    finalizeRecordingTranscription: async () => ++calls === 1
      ? { success: false, code: 'ENOSPC', error: `/secret/path ${source}` }
      : { success: false, code: 'TRANSCRIPTION_ADMISSION_FAILED', error: `/secret/path ${source}`, meeting: { id: 'saved' } },
  });
  await service.select();
  const first = await service.start({});
  assert.equal(first.code, 'ENOSPC');
  assert.doesNotMatch(first.error, /secret|private/);
  const second = await service.start({});
  assert.equal(second.meeting.id, 'saved');
  assert.doesNotMatch(second.error, /secret|private/);
  assert.equal((await service.start({})).success, false);
  assert.equal(calls, 2);
});

test('picker cannot race start, and cancel invalidates a pending picker', async () => {
  let resolvePicker;
  const service = createAudioImportService({
    dialog: { showOpenDialog: () => new Promise((resolve) => { resolvePicker = resolve; }) },
    getMainWindow: () => null, isQuitCommitted: () => false,
  });
  const picking = service.select();
  assert.equal((await service.start({})).code, 'IMPORT_BUSY');
  await service.cancel();
  resolvePicker({ filePaths: ['/private/chosen.wav'] });
  assert.equal((await picking).code, 'IMPORT_CANCELLED');
  assert.equal((await service.start({})).success, false);
});

test('rejects Ogg Vorbis renamed Opus without exposing paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avanevis-import-format-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'private.opus');
  execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', '-c:a', 'libvorbis', '-f', 'ogg', '-y', source]);
  let commits = 0;
  const service = createAudioImportService({
    dialog: { showOpenDialog: async () => ({ filePaths: [source] }) }, getMainWindow: () => null,
    getRecordingsDir: () => path.join(root, 'recordings'), ffmpegPath,
    isQuitCommitted: () => false, validateImportSelection: async () => {}, sendToRenderer: () => {},
    finalizeRecordingTranscription: async () => { commits++; },
  });
  await service.select();
  const result = await service.start({});
  assert.equal(result.code, 'IMPORT_INVALID_AUDIO');
  assert.doesNotMatch(result.error, /private|avanevis-import-format/);
  assert.equal(commits, 0);
});

test('late cancel cannot interrupt the commit', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'avanevis-import-commit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'test.wav');
  execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=0.1', '-y', source]);
  let release, entered;
  const inCommit = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createAudioImportService({
    dialog: { showOpenDialog: async () => ({ filePaths: [source] }) }, getMainWindow: () => null,
    getRecordingsDir: () => path.join(root, 'recordings'), ffmpegPath,
    isQuitCommitted: () => false, validateImportSelection: async () => {}, sendToRenderer: () => {},
    finalizeRecordingTranscription: async () => { entered(); await gate; return { success: true, meeting: { id: 'saved' } }; },
  });
  await service.select();
  const started = service.start({});
  await inCommit;
  assert.equal((await service.cancel()).code, 'IMPORT_COMMITTING');
  release();
  assert.equal((await started).meeting.id, 'saved');
});
