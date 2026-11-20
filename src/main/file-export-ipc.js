'use strict';

/**
 * File-export IPC service for the AvaNevis main process.
 *
 * Registers the transcript/speaker-segment save channels plus the legal-notices
 * opener, and owns the safe save-dialog default-name helper. Handler bodies are
 * moved verbatim from `src/main.js`; cross-module dependencies (including the
 * main entrypoint `__dirname` as `dirname`) are injected via `deps`.
 */

const crypto = require('crypto');
const {
  VALID_EXPORT_FORMATS,
  convertTranscriptMarkdownToPlainText,
  serializeCuesToSrt,
  serializeCuesToVtt,
  validateCaptionsSidecar,
} = require('../renderer/subtitle-export-helpers');

const WINDOWS_RESERVED_FILE_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const EXPORT_TRANSCRIPT_EXTENSIONS_RE = /\.(?:md|txt|srt|vtt)$/i;
const EXPORT_FORMAT_FILTERS = Object.freeze({
  md: [
    { name: 'Markdown', extensions: ['md'] },
    { name: 'All Files', extensions: ['*'] },
  ],
  txt: [
    { name: 'Plain Text', extensions: ['txt'] },
    { name: 'All Files', extensions: ['*'] },
  ],
  srt: [
    { name: 'SubRip Subtitles', extensions: ['srt'] },
    { name: 'All Files', extensions: ['*'] },
  ],
  vtt: [
    { name: 'WebVTT Subtitles', extensions: ['vtt'] },
    { name: 'All Files', extensions: ['*'] },
  ],
});

function normalizeExportExtension(extension = '.md') {
  const raw = String(extension || '.md').trim().toLowerCase();
  if (!raw) {
    return '.md';
  }
  return raw.startsWith('.') ? raw : `.${raw}`;
}

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {import('electron').Dialog} deps.dialog
 * @param {typeof import('electron').BrowserWindow} deps.BrowserWindow
 * @param {import('electron').Shell} deps.shell
 * @param {Function} deps.isSafeRecordingsMarkdownPath
 * @param {Function} deps.isSafeRecordingsJsonPath
 * @param {Function} deps.getLegalNoticesPath
 * @param {Function} [deps.getMeeting]
 * @param {Function} [deps.assertTrustedRendererSender]
 * @param {string} deps.dirname - Value of `__dirname` from the main entrypoint.
 */
function createFileExportIpc(deps) {
  const {
    app,
    path,
    fs,
    dialog,
    BrowserWindow,
    shell,
    isSafeRecordingsMarkdownPath,
    isSafeRecordingsJsonPath,
    getLegalNoticesPath,
    getMeeting = null,
    assertTrustedRendererSender = null,
    dirname,
  } = deps;

  function buildSafeSaveDialogDefaultPath(suggestedName, extension = '.md') {
    const normalizedExt = normalizeExportExtension(extension);
    let safeName = String(suggestedName || '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
      .replace(/[. ]+$/g, '');

    if (EXPORT_TRANSCRIPT_EXTENSIONS_RE.test(safeName)) {
      safeName = safeName.replace(EXPORT_TRANSCRIPT_EXTENSIONS_RE, '').replace(/[. ]+$/g, '');
    }

    if (!safeName) {
      safeName = 'transcript';
    }

    let baseName = safeName;
    if (WINDOWS_RESERVED_FILE_BASENAME.test(baseName)) {
      baseName = `file ${baseName}`;
    }

    return `${baseName}${normalizedExt}`;
  }

  async function assertNonSymlinkExistingFile(targetPath, label) {
    if (typeof fs?.promises?.lstat !== 'function') {
      return;
    }
    const stats = await fs.promises.lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Invalid ${label} file.`);
    }
  }

  async function resolveValidatedSubtitleContent({
    meetingId,
    format,
    includeSpeakers = true,
    useVoiceTags = false,
  }) {
    if (!meetingId || typeof getMeeting !== 'function') {
      return {
        ok: false,
        code: 'CAPTIONS_MISSING',
        error: 'Accurate subtitles require a saved meeting with caption-scale timing.',
      };
    }

    const meeting = await getMeeting(meetingId);
    if (!meeting || !meeting.transcriptPath) {
      return {
        ok: false,
        code: 'CAPTIONS_MISSING',
        error: 'Meeting transcript could not be found on disk.',
      };
    }

    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    if (!isSafeRecordingsMarkdownPath({ filePath: meeting.transcriptPath, recordingsDir })) {
      throw new Error('Transcript file must remain inside the recordings directory.');
    }
    const resolvedTranscriptPath = path.resolve(meeting.transcriptPath);
    await assertNonSymlinkExistingFile(resolvedTranscriptPath, 'transcript');

    const transcriptText = await fs.promises.readFile(resolvedTranscriptPath, 'utf8');
    const normalizedTranscript = transcriptText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const currentTranscriptHash = `sha256:${crypto.createHash('sha256').update(normalizedTranscript, 'utf8').digest('hex')}`;

    const rawCaptionsPath = meeting.captionsPath
      || (meeting.audioPath
        ? path.join(path.dirname(meeting.audioPath), `${path.parse(meeting.audioPath).name}.captions.json`)
        : '');
    if (!rawCaptionsPath) {
      return {
        ok: false,
        code: 'CAPTIONS_MISSING',
        error: 'Accurate subtitles require caption-scale timing. Re-transcribe from the saved audio to generate cue timings.',
      };
    }
    if (!isSafeRecordingsJsonPath({ filePath: rawCaptionsPath, recordingsDir })) {
      throw new Error('Captions sidecar must remain inside the recordings directory.');
    }
    const resolvedCaptionsPath = path.resolve(rawCaptionsPath);
    try {
      await assertNonSymlinkExistingFile(resolvedCaptionsPath, 'captions sidecar');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return {
          ok: false,
          code: 'CAPTIONS_MISSING',
          error: 'Accurate subtitles require caption-scale timing. Re-transcribe from the saved audio to generate cue timings.',
        };
      }
      throw error;
    }

    let sidecar;
    try {
      const rawJson = await fs.promises.readFile(resolvedCaptionsPath, 'utf8');
      sidecar = JSON.parse(rawJson);
    } catch (_error) {
      return {
        ok: false,
        code: 'CAPTIONS_INVALID',
        error: 'Saved caption timing data could not be read. Re-transcribe from the saved audio to regenerate subtitle timings.',
      };
    }

    const validation = validateCaptionsSidecar(sidecar, currentTranscriptHash);
    if (!validation.valid) {
      return {
        ok: false,
        code: validation.code,
        error: validation.reason,
      };
    }

    const content = format === 'srt'
      ? serializeCuesToSrt(validation.cues, { includeSpeakers })
      : serializeCuesToVtt(validation.cues, { includeSpeakers, useVoiceTags });

    return {
      ok: true,
      content,
    };
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('save-transcript-file', async (event, options = {}) => {
      const { filePath, content } = options;
      if (!filePath || typeof content !== 'string') {
        throw new Error('save-transcript-file requires filePath and content');
      }

      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      if (!isSafeRecordingsMarkdownPath({ filePath, recordingsDir })) {
        throw new Error('Transcript file must be a Markdown file in the recordings directory.');
      }

      const resolvedPath = path.resolve(filePath);
      await fs.promises.writeFile(resolvedPath, content, 'utf8');
      return { success: true, filePath: resolvedPath };
    });

    ipcMain.handle('save-speaker-segments-file', async (event, options = {}) => {
      const { filePath, content } = options;
      if (!filePath || typeof content !== 'string') {
        throw new Error('save-speaker-segments-file requires filePath and content');
      }

      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      if (!isSafeRecordingsJsonPath({ filePath, recordingsDir })) {
        throw new Error('Speaker segment file must be a JSON file in the recordings directory.');
      }

      const resolvedPath = path.resolve(filePath);
      const parsed = JSON.parse(content);
      await fs.promises.writeFile(resolvedPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      return { success: true, filePath: resolvedPath };
    });

    /**
     * Show a Save dialog and write the supplied transcript text to disk.
     *
     * The renderer chooses the suggested filename (typically derived from the
     * meeting's display label) so users get a meaningful default name.
     */
    ipcMain.handle('save-transcript-as', async (event, options) => {
      if (typeof assertTrustedRendererSender === 'function') {
        assertTrustedRendererSender(event);
      }
      const opts = options || {};
      const suggestedName = (opts.suggestedName || 'transcript').toString();
      const content = typeof opts.content === 'string' ? opts.content : '';
      const title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : 'Save Transcript';
      const hasExplicitFormat = Object.prototype.hasOwnProperty.call(opts, 'format') && opts.format != null && opts.format !== '';

      if (!hasExplicitFormat) {
        const window = BrowserWindow.fromWebContents(event.sender);
        const result = await dialog.showSaveDialog(window, {
          title,
          defaultPath: buildSafeSaveDialogDefaultPath(suggestedName, '.md'),
          filters: [
            { name: 'Markdown', extensions: ['md'] },
            { name: 'Text', extensions: ['txt'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });

        if (result.canceled || !result.filePath) {
          return { canceled: true };
        }

        await fs.promises.writeFile(result.filePath, content, 'utf8');
        return { canceled: false, filePath: result.filePath };
      }

      const format = String(opts.format).trim().toLowerCase();
      if (!VALID_EXPORT_FORMATS.includes(format)) {
        throw new Error(`Unsupported export format: ${opts.format}`);
      }

      let outputText = content;
      if (format === 'txt') {
        outputText = opts.isPlainText === true ? content : convertTranscriptMarkdownToPlainText(content);
      } else if (format === 'srt' || format === 'vtt') {
        const subtitleResult = await resolveValidatedSubtitleContent({
          meetingId: typeof opts.meetingId === 'string' ? opts.meetingId.trim() : '',
          format,
          includeSpeakers: opts.includeSpeakers !== false,
          useVoiceTags: Boolean(opts.useVoiceTags),
        });
        if (!subtitleResult.ok) {
          return {
            canceled: false,
            ok: false,
            code: subtitleResult.code,
            error: subtitleResult.error,
          };
        }
        outputText = subtitleResult.content;
      }

      const window = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showSaveDialog(window, {
        title,
        defaultPath: buildSafeSaveDialogDefaultPath(suggestedName, `.${format}`),
        filters: EXPORT_FORMAT_FILTERS[format],
      });

      if (result.canceled || !result.filePath) {
        return { canceled: true };
      }

      await fs.promises.writeFile(result.filePath, outputText, 'utf8');
      return { canceled: false, ok: true, filePath: result.filePath, format };
    });

    ipcMain.handle('open-legal-notices', async () => {
      const noticesPath = getLegalNoticesPath({
        resourcesPath: app.isPackaged ? process.resourcesPath : null,
        devRoot: path.join(dirname, '..'),
      });

      if (!noticesPath) {
        return {
          success: false,
          error: 'Third-party notices file is not available.',
        };
      }

      const openError = await shell.openPath(noticesPath);
      if (openError) {
        return {
          success: false,
          path: noticesPath,
          error: openError,
        };
      }

      return {
        success: true,
        path: noticesPath,
      };
    });
  }

  return { buildSafeSaveDialogDefaultPath, registerIpc };
}

/**
 * Convenience wiring helper: build the file-export service and register IPC.
 */
function registerFileExportIpc(ipcMain, deps) {
  const service = createFileExportIpc(deps);
  service.registerIpc(ipcMain);
  return service;
}

module.exports = {
  createFileExportIpc,
  registerFileExportIpc,
  WINDOWS_RESERVED_FILE_BASENAME,
};
