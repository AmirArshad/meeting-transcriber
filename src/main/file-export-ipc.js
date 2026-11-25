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
  applySpeakerNamesToMarkdown,
  convertTranscriptMarkdownToPlainText,
  serializeCuesToSrt,
  serializeCuesToVtt,
  serializeTranscriptToJson,
  validateCaptionsSidecar,
} = require('../renderer/subtitle-export-helpers');
const {
  isCanonicalSpeakerKey,
  normalizeSpeakerName,
} = require('../renderer/speaker-label-helpers');

const WINDOWS_RESERVED_FILE_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const EXPORT_TRANSCRIPT_EXTENSIONS_RE = /\.(?:md|txt|json|srt|vtt)$/i;
const EXPORT_FORMAT_FILTERS = Object.freeze({
  md: [
    { name: 'Markdown', extensions: ['md'] },
    { name: 'All Files', extensions: ['*'] },
  ],
  txt: [
    { name: 'Plain Text', extensions: ['txt'] },
    { name: 'All Files', extensions: ['*'] },
  ],
  json: [
    { name: 'JSON', extensions: ['json'] },
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

/**
 * Compute the canonical SHA-256 speaker-names hash matching Python
 * `backend/meetings/speaker_names.py:speaker_names_hash` byte-for-byte.
 */
function computeSpeakerNamesHash(speakerNames) {
  if (!speakerNames || typeof speakerNames !== 'object' || Array.isArray(speakerNames)) {
    return '';
  }
  const normalized = {};
  for (const key of Object.keys(speakerNames).sort()) {
    if (!isCanonicalSpeakerKey(key) || typeof speakerNames[key] !== 'string') {
      continue;
    }
    const clean = normalizeSpeakerName(speakerNames[key]);
    if (clean) {
      normalized[key] = clean;
    }
  }
  const keys = Object.keys(normalized);
  if (keys.length === 0) {
    return '';
  }
  // Python json.dumps(..., sort_keys=True, ensure_ascii=False) uses ', ' and ': '.
  const serialized = `{${keys.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(normalized[key])}`).join(', ')}}`;
  return `sha256:${crypto.createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

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

  function computeTranscriptHash(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return `sha256:${crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
  }

  function resolveMeetingCaptionsSidecarPath(meeting) {
    if (!meeting || typeof meeting !== 'object') {
      return '';
    }
    if (meeting.captionsPath) {
      return String(meeting.captionsPath);
    }
    if (meeting.audioPath) {
      return path.join(path.dirname(meeting.audioPath), `${path.parse(meeting.audioPath).name}.captions.json`);
    }
    return '';
  }

  async function readValidatedTranscriptFile(transcriptPath, recordingsDir) {
    if (!isSafeRecordingsMarkdownPath({ filePath: transcriptPath, recordingsDir })) {
      throw new Error('Transcript file must remain inside the recordings directory.');
    }
    const resolvedTranscriptPath = path.resolve(transcriptPath);
    await assertNonSymlinkExistingFile(resolvedTranscriptPath, 'transcript');
    const transcriptText = await fs.promises.readFile(resolvedTranscriptPath, 'utf8');
    return {
      text: transcriptText,
      hash: computeTranscriptHash(transcriptText),
    };
  }

  async function readSafeSidecarFile(targetPath, {
    recordingsDir,
    isSafePath,
    pathErrorMessage,
    symlinkErrorMessage,
  }) {
    if (!isSafePath({ filePath: targetPath, recordingsDir })) {
      throw new Error(pathErrorMessage);
    }
    const resolvedPath = path.resolve(targetPath);
    if (typeof fs?.promises?.lstat === 'function') {
      let stats;
      try {
        stats = await fs.promises.lstat(resolvedPath);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          return { exists: false, content: null };
        }
        throw error;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(symlinkErrorMessage);
      }
    }
    try {
      const content = await fs.promises.readFile(resolvedPath, 'utf8');
      return { exists: true, content };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { exists: false, content: null };
      }
      throw error;
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
        error: 'Subtitles require a saved recording with exact segment timings.',
      };
    }

    const meeting = await getMeeting(meetingId);
    if (!meeting || !meeting.transcriptPath) {
      return {
        ok: false,
        code: 'CAPTIONS_MISSING',
        error: 'Transcript file could not be found on disk.',
      };
    }

    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const { hash: currentTranscriptHash } = await readValidatedTranscriptFile(
      meeting.transcriptPath,
      recordingsDir,
    );

    const rawCaptionsPath = resolveMeetingCaptionsSidecarPath(meeting);
    if (!rawCaptionsPath) {
      return {
        ok: false,
        code: 'CAPTIONS_MISSING',
        error: 'Subtitles require exact segment timings. Re-transcribe from the saved audio to generate them.',
      };
    }

    const captionsFile = await readSafeSidecarFile(rawCaptionsPath, {
      recordingsDir,
      isSafePath: isSafeRecordingsJsonPath,
      pathErrorMessage: 'Captions sidecar must remain inside the recordings directory.',
      symlinkErrorMessage: 'Invalid captions sidecar file.',
    });
    if (!captionsFile.exists) {
      return {
        ok: false,
        code: 'CAPTIONS_MISSING',
        error: 'Subtitles require exact segment timings. Re-transcribe from the saved audio to generate them.',
      };
    }

    let sidecar;
    try {
      sidecar = JSON.parse(captionsFile.content);
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

    const speakerNames = meeting.ai?.diarization?.speakerNames || {};
    const content = format === 'srt'
      ? serializeCuesToSrt(validation.cues, { includeSpeakers, speakerNames })
      : serializeCuesToVtt(validation.cues, { includeSpeakers, useVoiceTags, speakerNames });

    return {
      ok: true,
      content,
    };
  }

  async function resolveJsonExportContent({
    meetingId,
    fallbackContent = '',
    includeSpeakers = true,
  }) {
    const meeting = meetingId && typeof getMeeting === 'function'
      ? await getMeeting(meetingId).catch(() => null)
      : null;

    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    let transcriptMarkdown = fallbackContent || (typeof meeting?.transcript === 'string' ? meeting.transcript : '');
    let sourceTranscriptHash = transcriptMarkdown ? computeTranscriptHash(transcriptMarkdown) : null;

    if (meeting?.transcriptPath) {
      const readResult = await readValidatedTranscriptFile(meeting.transcriptPath, recordingsDir);
      transcriptMarkdown = readResult.text;
      sourceTranscriptHash = readResult.hash;
    }

    let captionsInfo = {
      available: false,
      status: 'missing',
      engine: null,
      timingPrecision: null,
      cues: [],
    };
    const rawCaptionsPath = resolveMeetingCaptionsSidecarPath(meeting);
    if (rawCaptionsPath) {
      const captionsFile = await readSafeSidecarFile(rawCaptionsPath, {
        recordingsDir,
        isSafePath: isSafeRecordingsJsonPath,
        pathErrorMessage: 'Invalid captions sidecar path.',
        symlinkErrorMessage: 'Refusing to read symlinked captions sidecar.',
      });
      if (captionsFile.exists) {
        try {
          const parsedCaptions = JSON.parse(captionsFile.content);
          const validation = validateCaptionsSidecar(parsedCaptions, sourceTranscriptHash);
          if (validation.valid) {
            captionsInfo = {
              available: true,
              status: 'ready',
              engine: validation.engine,
              timingPrecision: validation.timingPrecision,
              cues: validation.cues,
            };
          } else {
            const status = validation.code === 'CAPTIONS_STALE'
              ? 'stale'
              : (validation.code === 'CAPTIONS_MISSING' ? 'missing' : 'invalid');
            captionsInfo = {
              available: false,
              status,
              engine: null,
              timingPrecision: null,
              cues: [],
            };
          }
        } catch (_error) {
          captionsInfo = {
            available: false,
            status: 'invalid',
            engine: null,
            timingPrecision: null,
            cues: [],
          };
        }
      }
    }

    const aiSummary = meeting?.ai?.summary && typeof meeting.ai.summary === 'object'
      ? meeting.ai.summary
      : null;
    let summaryStructured = null;
    let summarySidecarMeta = null;
    let summaryMarkdown = typeof meeting?.summary === 'string' ? meeting.summary : '';

    if (aiSummary?.jsonPath) {
      const summaryJsonFile = await readSafeSidecarFile(aiSummary.jsonPath, {
        recordingsDir,
        isSafePath: isSafeRecordingsJsonPath,
        pathErrorMessage: 'Invalid summary JSON sidecar path.',
        symlinkErrorMessage: 'Refusing to read symlinked summary JSON sidecar.',
      });
      if (summaryJsonFile.exists) {
        try {
          const parsedSummaryJson = JSON.parse(summaryJsonFile.content);
          if (parsedSummaryJson && typeof parsedSummaryJson === 'object' && !Array.isArray(parsedSummaryJson)) {
            if (
              parsedSummaryJson.summary
              && typeof parsedSummaryJson.summary === 'object'
              && !Array.isArray(parsedSummaryJson.summary)
            ) {
              summaryStructured = parsedSummaryJson.summary;
            }
            if (
              parsedSummaryJson.metadata
              && typeof parsedSummaryJson.metadata === 'object'
              && !Array.isArray(parsedSummaryJson.metadata)
            ) {
              summarySidecarMeta = parsedSummaryJson.metadata;
            }
          }
        } catch (_error) {
          // Corrupt summary JSON sidecar degrades without blocking transcript JSON export.
        }
      }
    }

    if (aiSummary?.markdownPath) {
      const summaryMdFile = await readSafeSidecarFile(aiSummary.markdownPath, {
        recordingsDir,
        isSafePath: isSafeRecordingsMarkdownPath,
        pathErrorMessage: 'Invalid summary Markdown sidecar path.',
        symlinkErrorMessage: 'Refusing to read symlinked summary Markdown sidecar.',
      });
      if (summaryMdFile.exists) {
        summaryMarkdown = summaryMdFile.content;
      }
    }

    const speakerNames = meeting?.ai?.diarization?.speakerNames || {};
    const currentSpeakerNamesHash = computeSpeakerNamesHash(speakerNames);

    const hasCompletedSummary = Boolean(
      aiSummary?.status === 'completed'
      || (!aiSummary?.status && ((summaryMarkdown && summaryMarkdown.trim()) || summaryStructured)),
    );
    let summaryInput = null;
    if (hasCompletedSummary) {
      const meta = aiSummary || {};
      const sidecarMeta = summarySidecarMeta || {};
      const summarySourceHash = meta.sourceTranscriptHash ?? sidecarMeta.sourceTranscriptHash ?? null;
      const summarySpeakerNamesHash = meta.speakerNamesHash ?? sidecarMeta.speakerNamesHash ?? null;
      const transcriptStale = Boolean(
        summarySourceHash
        && sourceTranscriptHash
        && summarySourceHash !== sourceTranscriptHash,
      );
      const speakerNamesStale = (summarySpeakerNamesHash || '') !== currentSpeakerNamesHash;
      summaryInput = {
        status: 'completed',
        markdown: summaryMarkdown,
        structured: summaryStructured,
        language: meta.language ?? sidecarMeta.language ?? null,
        languageSource: meta.languageSource ?? sidecarMeta.languageSource ?? null,
        modelId: meta.modelId ?? sidecarMeta.modelId ?? null,
        model: meta.model ?? sidecarMeta.model ?? null,
        modelProfile: meta.modelProfile ?? sidecarMeta.profile ?? null,
        tag: meta.tag ?? sidecarMeta.tag ?? null,
        template: meta.template ?? sidecarMeta.template ?? summaryStructured?.template ?? null,
        templateVersion: meta.templateVersion ?? sidecarMeta.templateVersion ?? null,
        generatedAt: meta.generatedAt ?? sidecarMeta.generatedAt ?? null,
        sourceTranscriptHash: summarySourceHash,
        speakerNamesHash: summarySpeakerNamesHash,
        stale: Boolean(meeting?.summaryStale) || transcriptStale || speakerNamesStale,
      };
    }

    const content = serializeTranscriptToJson({
      recording: meeting,
      includeSpeakers: includeSpeakers !== false,
      speakerNames,
      speakerNamesHash: currentSpeakerNamesHash,
      speakerCount: meeting?.ai?.diarization?.speakerCount,
      transcriptMarkdown,
      sourceTranscriptHash,
      captions: captionsInfo,
      summary: summaryInput,
    });

    return { ok: true, content };
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
      const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      const rawSuggestedName = typeof opts.suggestedName === 'string' && opts.suggestedName.trim()
        ? opts.suggestedName
        : 'transcript';
      const suggestedName = rawSuggestedName;
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

      if (typeof opts.format !== 'string') {
        throw new Error(`Unsupported export format: ${opts.format}`);
      }
      const format = opts.format.trim().toLowerCase();
      if (!VALID_EXPORT_FORMATS.includes(format)) {
        throw new Error(`Unsupported export format: ${opts.format}`);
      }

      let outputText = content;
      if ((format === 'md' || format === 'txt') && opts.meetingId && typeof getMeeting === 'function') {
        try {
          const meeting = await getMeeting(opts.meetingId);
          outputText = applySpeakerNamesToMarkdown(outputText, meeting?.ai?.diarization?.speakerNames);
        } catch {
          // Export the supplied transcript when metadata is unavailable.
        }
      }
      if (format === 'txt') {
        outputText = opts.isPlainText === true ? outputText : convertTranscriptMarkdownToPlainText(outputText);
      } else if (format === 'json') {
        const jsonResult = await resolveJsonExportContent({
          meetingId: typeof opts.meetingId === 'string' ? opts.meetingId.trim() : '',
          fallbackContent: content,
          includeSpeakers: opts.includeSpeakers !== false,
        });
        outputText = jsonResult.content;
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
  computeSpeakerNamesHash,
  WINDOWS_RESERVED_FILE_BASENAME,
};
