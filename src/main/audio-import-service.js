'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { normalizeTagStrict } = require('../renderer/tag-helpers');

// Import staging is nested so the recording scanner cannot discover unfinished files.
function createAudioImportService({ dialog, getMainWindow, getRecordingsDir, ffmpegPath,
  finalizeRecordingTranscription, validateImportSelection, assertTrustedRendererSender, sendToRenderer, isQuitCommitted }) {
  let selected = null;
  let active = null;
  let picking = false;
  let pickerGeneration = 0;
  const prefix = '.audio-import-';
  const formats = { '.wav': 'wav', '.mp3': 'mp3', '.opus': 'ogg' };

  async function cleanupStaging() {
    const root = getRecordingsDir();
    await fs.promises.mkdir(root, { recursive: true });
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => fs.promises.rm(path.join(root, entry.name), { recursive: true, force: true })));
  }

  async function select() {
    if (active || picking || isQuitCommitted()) return { success: false, code: 'IMPORT_BUSY', error: 'An import is already in progress.' };
    selected = null;
    picking = true;
    const generation = ++pickerGeneration;
    let result;
    try {
      result = await dialog.showOpenDialog(getMainWindow(), {
        properties: ['openFile'], filters: [{ name: 'Audio files', extensions: ['mp3', 'wav', 'opus'] }],
      });
    } finally { picking = false; }
    if (generation !== pickerGeneration || isQuitCommitted()) return { success: false, code: 'IMPORT_CANCELLED', error: 'Import cancelled.' };
    if (result.canceled || !result.filePaths || result.filePaths.length !== 1) return { success: false, canceled: true };
    const source = result.filePaths[0];
    if (!formats[path.extname(source).toLowerCase()]) return { success: false, error: 'Choose an MP3, WAV or Opus file.' };
    selected = source;
    return { success: true, name: path.basename(source) };
  }

  async function convert(source, output, operation) {
    const ext = path.extname(source).toLowerCase();
    const stat = await fs.promises.stat(source);
    if (!stat.isFile() || !stat.size) {
      throw Object.assign(new Error('Could not decode the selected audio.'), { code: 'IMPORT_INVALID_AUDIO' });
    }
    if (operation.cancelled) throw Object.assign(new Error('Import cancelled.'), { code: 'IMPORT_CANCELLED' });
    return new Promise((resolve, reject) => {
      let progress = '';
      let diagnostic = '';
      const child = spawn(ffmpegPath, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror',
        '-protocol_whitelist', 'file,pipe', '-f', formats[ext],
        ...(ext === '.opus' ? ['-c:a', 'opus'] : []), '-i', source,
        '-map', '0:a:0', '-vn', '-c:a', 'libopus', '-f', 'opus', '-y',
        '-progress', 'pipe:1', output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      operation.child = child;
      child.stdout.on('data', (data) => { progress = (progress + data.toString()).slice(-16384); });
      child.stderr.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-4096); });
      child.once('error', () => {
        operation.child = null;
        reject(Object.assign(new Error('The audio decoder could not start.'), { code: 'IMPORT_DECODER_UNAVAILABLE' }));
      });
      child.once('close', async (code) => {
        operation.child = null;
        if (operation.cancelled) return reject(Object.assign(new Error('Import cancelled.'), { code: 'IMPORT_CANCELLED' }));
        const times = [...progress.matchAll(/^out_time_us=(\d+)$/gm)];
        const duration = times.length ? Number(times[times.length - 1][1]) / 1000000 : 0;
        try {
          if (code !== 0 || !duration) {
            if (/no space left on device|disk full/i.test(diagnostic)) throw Object.assign(new Error('Not enough disk space to import audio.'), { code: 'ENOSPC' });
            throw Object.assign(new Error('Could not decode the selected audio.'), { code: 'IMPORT_INVALID_AUDIO' });
          }
          const outputStat = await fs.promises.stat(output);
          if (!outputStat.size) throw Object.assign(new Error('Could not decode the selected audio.'), { code: 'IMPORT_INVALID_AUDIO' });
          resolve(duration);
        } catch (error) { reject(error); }
      });
      if (operation.cancelled) child.kill();
    });
  }

  async function start(options = {}) {
    if (active || picking || isQuitCommitted()) return { success: false, code: 'IMPORT_BUSY', error: 'An import is already in progress.' };
    if (!selected) return { success: false, error: 'Choose an audio file first.' };
    let normalizedTag = null;
    try {
      if (options && Object.hasOwn(options, 'tag') && options.tag !== undefined && options.tag !== null
        && (typeof options.tag !== 'string' || options.tag.trim())) {
        normalizedTag = normalizeTagStrict(options.tag);
      }
    } catch (tagError) {
      return { success: false, code: 'IMPORT_INVALID_TAG', error: tagError.message || 'Unsupported recording tag.' };
    }
    const source = selected;
    const operation = { cancelled: false, child: null, phase: 'preparing', promise: null };
    active = operation;
    operation.promise = (async () => {
      let staging;
      try {
        await validateImportSelection(options);
        sendToRenderer('import-audio-progress', { phase: 'preparing' });
        await fs.promises.mkdir(getRecordingsDir(), { recursive: true });
        staging = await fs.promises.mkdtemp(path.join(getRecordingsDir(), prefix));
        const output = path.join(staging, 'audio.opus');
        const duration = await convert(source, output, operation);
        if (operation.cancelled || isQuitCommitted()) throw Object.assign(new Error('Import cancelled.'), { code: 'IMPORT_CANCELLED' });
        await validateImportSelection(options);
        if (operation.cancelled || isQuitCommitted()) throw Object.assign(new Error('Import cancelled.'), { code: 'IMPORT_CANCELLED' });
        operation.phase = 'saving';
        sendToRenderer('import-audio-progress', { phase: 'saving' });
        const result = await finalizeRecordingTranscription({ audioPath: output, duration,
          title: path.basename(source, path.extname(source)), language: options.language,
          modelSize: options.modelSize, transcriptionSelection: options.transcriptionSelection,
          ...(normalizedTag ? { tag: normalizedTag } : {}) });
        if (result && (result.success || result.meeting || result.pendingMeeting)) selected = null;
        if (result && !result.success) {
          return { ...result, error: result.code === 'ENOSPC'
            ? 'Not enough disk space to import audio.'
            : result.meeting || result.pendingMeeting
              ? 'Saved in History, but transcription could not be queued.'
              : 'Could not save the imported audio.' };
        }
        return result;
      } catch (error) {
        if (operation.cancelled || error.code === 'IMPORT_CANCELLED') {
          selected = null;
          return { success: false, code: 'IMPORT_CANCELLED', error: 'Import cancelled.' };
        }
        const messages = {
          ENOSPC: 'Not enough disk space to import audio.',
          IMPORT_SETUP_REQUIRED: 'The selected transcription engine or model needs setup in Settings.',
          IMPORT_DECODER_UNAVAILABLE: 'The audio decoder could not start.',
          IMPORT_INVALID_AUDIO: 'Could not decode the selected audio.',
        };
        const code = Object.hasOwn(messages, error.code) ? error.code : 'IMPORT_FAILED';
        return { success: false, code, error: messages[code] || 'Could not import the selected audio.' };
      } finally {
        try {
          if (staging) await fs.promises.rm(staging, { recursive: true, force: true });
        } catch (error) {
          console.warn('Could not remove import staging:', error.message);
        } finally { active = null; }
      }
    })();
    return operation.promise;
  }

  async function cancel() {
    if (!active) {
      selected = null;
      pickerGeneration += 1;
      return { success: true };
    }
    if (active.phase === 'saving') return { success: false, code: 'IMPORT_COMMITTING' };
    selected = null;
    active.cancelled = true;
    if (active.child) active.child.kill();
    await active.promise;
    return { success: true };
  }
  async function drain() {
    if (!active) return;
    if (active.phase !== 'saving') await cancel();
    else await active.promise;
  }
  function registerIpc(ipcMain) {
    ipcMain.handle('select-import-audio', (event) => { assertTrustedRendererSender(event); return select(); });
    ipcMain.handle('start-import-audio', (event, options) => { assertTrustedRendererSender(event); return start(options); });
    ipcMain.handle('cancel-import-audio', (event) => { assertTrustedRendererSender(event); return cancel(); });
  }
  return { registerIpc, cleanupStaging, select, start, cancel, drain, hasActive: () => Boolean(active) };
}
module.exports = { createAudioImportService };
