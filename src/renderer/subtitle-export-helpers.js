(function initSubtitleExportHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.subtitleExportHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildSubtitleExportHelpers() {
  const CAPTIONS_SCHEMA_VERSION = 1;
  const VALID_EXPORT_FORMATS = Object.freeze(['md', 'txt', 'srt', 'vtt']);
  const VALID_CAPTION_ENGINES = new Set(['faster-whisper', 'mlx-whisper', 'parakeet']);
  const VALID_TIMING_PRECISIONS = new Set(['segment', 'word']);
  const MIN_CUE_DURATION_MS = 100;
  const SHA256_HASH_RE = /^sha256:[a-f0-9]{64}$/;

  function padNumber(value, width) {
    return String(Math.max(0, Math.floor(value))).padStart(width, '0');
  }

  function formatSubtitleTimestamp(ms, decimalSeparator) {
    const safeMs = Number.isFinite(Number(ms)) ? Math.max(0, Math.round(Number(ms))) : 0;
    const hours = Math.floor(safeMs / 3600000);
    const minutes = Math.floor((safeMs % 3600000) / 60000);
    const seconds = Math.floor((safeMs % 60000) / 1000);
    const millis = safeMs % 1000;
    return `${padNumber(hours, 2)}:${padNumber(minutes, 2)}:${padNumber(seconds, 2)}${decimalSeparator}${padNumber(millis, 3)}`;
  }

  function formatSrtTimestamp(ms) {
    return formatSubtitleTimestamp(ms, ',');
  }

  function formatVttTimestamp(ms) {
    return formatSubtitleTimestamp(ms, '.');
  }

  function sanitizeCueText(text) {
    return String(text || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/-->/g, '->')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function sanitizeVttVoiceName(speaker) {
    return String(speaker || '')
      .replace(/[<>&\r\n]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseCueBoundMs(cue, msKey, secKey, fallbackMs = 0) {
    if (cue && cue[msKey] != null && Number.isFinite(Number(cue[msKey]))) {
      return Math.max(0, Math.round(Number(cue[msKey])));
    }
    if (cue && cue[secKey] != null && Number.isFinite(Number(cue[secKey]))) {
      return Math.max(0, Math.round(Number(cue[secKey]) * 1000));
    }
    return Math.max(0, fallbackMs);
  }

  function normalizeSubtitleCues(cues) {
    if (!Array.isArray(cues) || cues.length === 0) {
      return [];
    }

    const parsed = [];
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index];
      if (!cue || typeof cue !== 'object') {
        continue;
      }
      const text = sanitizeCueText(cue.text);
      if (!text) {
        continue;
      }
      const startMs = parseCueBoundMs(cue, 'startMs', 'start', 0);
      const endMs = Math.max(startMs, parseCueBoundMs(cue, 'endMs', 'end', startMs));
      const speaker = typeof cue.speaker === 'string' ? cue.speaker.replace(/\s+/g, ' ').trim() : '';
      parsed.push({
        startMs,
        endMs,
        text,
        speaker,
        index,
      });
    }

    parsed.sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs) || (a.index - b.index));

    const normalized = [];
    let prevEndMs = 0;
    for (const item of parsed) {
      let startMs = item.startMs;
      let endMs = item.endMs;
      if (normalized.length > 0 && startMs < prevEndMs) {
        const prev = normalized[normalized.length - 1];
        if (startMs - prev.startMs >= MIN_CUE_DURATION_MS) {
          prev.endMs = startMs;
          prevEndMs = startMs;
        } else {
          startMs = prevEndMs;
        }
      }
      if (endMs < startMs + MIN_CUE_DURATION_MS) {
        endMs = startMs + MIN_CUE_DURATION_MS;
      }
      const entry = {
        startMs,
        endMs,
        text: item.text,
      };
      if (item.speaker) {
        entry.speaker = item.speaker;
      }
      normalized.push(entry);
      prevEndMs = endMs;
    }

    return normalized;
  }

  function formatCueBodyText(cue, { includeSpeakers = true, useVoiceTags = false } = {}) {
    if (!includeSpeakers || !cue.speaker) {
      return cue.text;
    }
    if (useVoiceTags) {
      const voice = sanitizeVttVoiceName(cue.speaker);
      return voice ? `<v ${voice}>${cue.text}` : cue.text;
    }
    return `${cue.speaker}: ${cue.text}`;
  }

  function serializeCuesToSrt(cues, { includeSpeakers = true } = {}) {
    const normalized = normalizeSubtitleCues(cues);
    if (normalized.length === 0) {
      return '';
    }

    const blocks = normalized.map((cue, index) => {
      const start = formatSrtTimestamp(cue.startMs);
      const end = formatSrtTimestamp(cue.endMs);
      const body = formatCueBodyText(cue, { includeSpeakers, useVoiceTags: false });
      return `${index + 1}\n${start} --> ${end}\n${body}`;
    });
    return `${blocks.join('\n\n')}\n`;
  }

  function serializeCuesToVtt(cues, { includeSpeakers = true, useVoiceTags = false } = {}) {
    const normalized = normalizeSubtitleCues(cues);
    if (normalized.length === 0) {
      return 'WEBVTT\n';
    }

    const blocks = normalized.map((cue) => {
      const start = formatVttTimestamp(cue.startMs);
      const end = formatVttTimestamp(cue.endMs);
      const body = formatCueBodyText(cue, { includeSpeakers, useVoiceTags });
      return `${start} --> ${end}\n${body}`;
    });
    return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
  }

  function convertTranscriptMarkdownToPlainText(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const output = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
        continue;
      }
      const headingMatch = /^#{1,6}\s+(.*)$/.exec(trimmed);
      if (headingMatch) {
        output.push(headingMatch[1].trim());
        continue;
      }
      const tsMatch = /^\*\*\[(\d{1,2}:\d{2}(?::\d{2})?\s+-\s+\d{1,2}:\d{2}(?::\d{2})?)\]\*\*\s*(.*)$/.exec(trimmed);
      if (tsMatch) {
        const range = `[${tsMatch[1]}]`;
        const rest = tsMatch[2].replace(/\*\*([^*]+)\*\*/g, '$1').trim();
        output.push(rest ? `${range} ${rest}` : range);
        continue;
      }
      const metaMatch = /^\*\*([^*]+):\*\*\s*(.*)$/.exec(trimmed);
      if (metaMatch) {
        const label = metaMatch[1].trim();
        const value = metaMatch[2].trim();
        output.push(value ? `${label}: ${value}` : `${label}:`);
        continue;
      }
      output.push(rawLine.replace(/\*\*([^*]+)\*\*/g, '$1').trimEnd());
    }

    return `${output.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
  }

  function validateCaptionsSidecar(payload, expectedTranscriptHash = null) {
    if (!payload) {
      return {
        valid: false,
        code: 'CAPTIONS_MISSING',
        reason: 'Accurate subtitles require caption-scale timing. Re-transcribe from the saved audio to generate cue timings.',
        cues: [],
      };
    }

    if (typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved caption timing data is invalid. Re-transcribe from the saved audio to regenerate subtitle timings.',
        cues: [],
      };
    }

    if (payload.schemaVersion !== CAPTIONS_SCHEMA_VERSION) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved caption timing schema is unsupported. Re-transcribe from the saved audio to regenerate subtitle timings.',
        cues: [],
      };
    }

    if (typeof payload.sourceTranscriptHash !== 'string' || !SHA256_HASH_RE.test(payload.sourceTranscriptHash)) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved caption timing data is missing a transcript checksum. Re-transcribe from the saved audio to regenerate subtitle timings.',
        cues: [],
      };
    }

    if (!VALID_CAPTION_ENGINES.has(payload.engine) || !VALID_TIMING_PRECISIONS.has(payload.timingPrecision)) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved caption timing provenance is invalid. Re-transcribe from the saved audio to regenerate subtitle timings.',
        cues: [],
      };
    }

    if (!Array.isArray(payload.cues)) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved caption timing cues are invalid. Re-transcribe from the saved audio to regenerate subtitle timings.',
        cues: [],
      };
    }

    let prevEndMs = 0;
    for (let index = 0; index < payload.cues.length; index += 1) {
      const cue = payload.cues[index];
      if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
        return {
          valid: false,
          code: 'CAPTIONS_INVALID',
          reason: 'Saved caption cue data is malformed. Re-transcribe from the saved audio to regenerate subtitle timings.',
          cues: [],
        };
      }
      if (!Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs)
        || cue.startMs < 0 || cue.endMs <= cue.startMs || cue.startMs < prevEndMs) {
        return {
          valid: false,
          code: 'CAPTIONS_INVALID',
          reason: 'Saved caption cue timestamps are invalid. Re-transcribe from the saved audio to regenerate subtitle timings.',
          cues: [],
        };
      }
      if (typeof cue.text !== 'string' || !cue.text.trim()) {
        return {
          valid: false,
          code: 'CAPTIONS_INVALID',
          reason: 'Saved caption cue text is invalid. Re-transcribe from the saved audio to regenerate subtitle timings.',
          cues: [],
        };
      }
      if (cue.speaker !== undefined && cue.speaker !== null && (typeof cue.speaker !== 'string' || !cue.speaker.trim())) {
        return {
          valid: false,
          code: 'CAPTIONS_INVALID',
          reason: 'Saved caption speaker label is invalid. Re-transcribe from the saved audio to regenerate subtitle timings.',
          cues: [],
        };
      }
      prevEndMs = cue.endMs;
    }

    if (expectedTranscriptHash && payload.sourceTranscriptHash !== expectedTranscriptHash) {
      return {
        valid: false,
        code: 'CAPTIONS_STALE',
        reason: 'This transcript changed after caption timings were created. Re-transcribe from the saved audio to regenerate subtitle timings.',
        cues: [],
      };
    }

    const normalizedCues = normalizeSubtitleCues(payload.cues);
    if (normalizedCues.length === 0) {
      return {
        valid: false,
        code: 'CAPTIONS_MISSING',
        reason: 'Accurate subtitles require caption-scale timing. Re-transcribe from the saved audio to generate cue timings.',
        cues: [],
      };
    }

    return {
      valid: true,
      code: 'ok',
      reason: '',
      cues: normalizedCues,
      engine: payload.engine,
      timingPrecision: payload.timingPrecision,
    };
  }

  function buildExportFormatOptions({
    captionsAvailable = false,
    captionsStatus = 'missing',
    hasAudio = false,
  } = {}) {
    const subtitlesReady = Boolean(captionsAvailable);
    const unavailableReason = captionsStatus === 'stale'
      ? 'This transcript changed after its caption timings were generated. Re-transcribe from the saved audio to regenerate cue timings.'
      : 'Accurate subtitles require caption-scale timing. Re-transcribe from the saved audio to generate cue timings.';

    return {
      defaultFormat: 'md',
      captionsUnavailableNotice: subtitlesReady ? '' : unavailableReason,
      canRetranscribe: Boolean(hasAudio && !subtitlesReady),
      options: [
        {
          format: 'md',
          label: 'Markdown',
          extLabel: '.md',
          description: 'Full meeting metadata, speaker headings, and transcript sections.',
          available: true,
          disabledReason: '',
        },
        {
          format: 'txt',
          label: 'Plain Text',
          extLabel: '.txt',
          description: 'Clean readable text with timestamps and no Markdown syntax.',
          available: true,
          disabledReason: '',
        },
        {
          format: 'srt',
          label: 'SubRip Subtitles',
          extLabel: '.srt',
          description: subtitlesReady
            ? 'Standard caption file with millisecond comma timestamps (HH:MM:SS,mmm).'
            : 'Requires caption-scale timing from audio transcription.',
          available: subtitlesReady,
          disabledReason: subtitlesReady ? '' : unavailableReason,
        },
        {
          format: 'vtt',
          label: 'WebVTT Subtitles',
          extLabel: '.vtt',
          description: subtitlesReady
            ? 'Modern web/player caption file with millisecond dot timestamps (HH:MM:SS.mmm).'
            : 'Requires caption-scale timing from audio transcription.',
          available: subtitlesReady,
          disabledReason: subtitlesReady ? '' : unavailableReason,
        },
      ],
    };
  }

  return {
    CAPTIONS_SCHEMA_VERSION,
    MIN_CUE_DURATION_MS,
    VALID_CAPTION_ENGINES: Array.from(VALID_CAPTION_ENGINES),
    VALID_EXPORT_FORMATS,
    VALID_TIMING_PRECISIONS: Array.from(VALID_TIMING_PRECISIONS),
    buildExportFormatOptions,
    convertTranscriptMarkdownToPlainText,
    formatSrtTimestamp,
    formatVttTimestamp,
    normalizeSubtitleCues,
    serializeCuesToSrt,
    serializeCuesToVtt,
    validateCaptionsSidecar,
  };
}));
