(function initSubtitleExportHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.subtitleExportHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildSubtitleExportHelpers() {
  const CAPTIONS_SCHEMA_VERSION = 1;
  const TRANSCRIPT_EXPORT_JSON_SCHEMA_VERSION = 1;
  const VALID_EXPORT_FORMATS = Object.freeze(['md', 'txt', 'json', 'srt', 'vtt']);
  const VALID_CAPTION_ENGINES = new Set(['faster-whisper', 'mlx-whisper', 'parakeet']);
  const VALID_TIMING_PRECISIONS = new Set(['segment', 'word']);
  const MIN_CUE_DURATION_MS = 100;
  const SHA256_HASH_RE = /^sha256:[a-f0-9]{64}$/;
  const SPEAKER_LABEL_PATTERN_SOURCE = '(?:Speaker (?:[1-9]|[1-9]\\d)|SPEAKER_\\d{2})';
  const CANONICAL_SPEAKER_KEY_RE = new RegExp(`^${SPEAKER_LABEL_PATTERN_SOURCE}$`);

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
    let clean = String(speaker || '');
    while (clean.includes('-->')) clean = clean.replace(/-->/g, '');
    return clean
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
    const speaker = cue.speaker.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `${speaker}: ${cue.text}`;
  }

  function normalizeExportSpeakerName(value) {
    if (typeof value !== 'string') return '';
    let clean = value.replace(/[\p{C}\p{Zl}\p{Zp}*]/gu, '');
    while (clean.includes('-->')) clean = clean.replace(/-->/g, '');
    return Array.from(clean.trim()).slice(0, 64).join('').trim();
  }

  function applySpeakerNamesToCues(cues, names) {
    return (Array.isArray(cues) ? cues : []).map((cue) => {
      if (!cue || typeof cue !== 'object') return cue;
      const name = names && Object.hasOwn(names, cue.speaker) && names[cue.speaker];
      const safeName = normalizeExportSpeakerName(name);
      return safeName ? { ...cue, speaker: safeName } : cue;
    });
  }

  function applySpeakerNamesToMarkdown(markdown, names) {
    const pattern = new RegExp(
      `^(\\s*(?:(?:\\*\\*)?\\[\\d{1,2}:\\d{2}(?::\\d{2})?\\s+-\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\](?:\\*\\*)?\\s*)?)\\*\\*(${SPEAKER_LABEL_PATTERN_SOURCE}):\\*\\*`,
      'gm',
    );
    return String(markdown || '').replace(pattern, (match, prefix, speaker) => {
      const name = names && Object.hasOwn(names, speaker) && names[speaker];
      const safeName = normalizeExportSpeakerName(name);
      return safeName ? `${prefix}**${safeName.replace(/([\\`_{}\[\]<>!#~|])/g, '\\$1')}:**` : match;
    });
  }

  function stripSpeakerPrefixesFromMarkdown(markdown) {
    const pattern = new RegExp(
      `^([ \\t]*(?:(?:\\*\\*)?\\[\\d{1,2}:\\d{2}(?::\\d{2})?\\s+-\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\](?:\\*\\*)?[ \\t]*)?)\\*\\*${SPEAKER_LABEL_PATTERN_SOURCE}:\\*\\*[ \\t]*([^\\r\\n]*)`,
      'gm',
    );
    return String(markdown || '').replace(pattern, (_match, prefix, rest) => {
      const trimmedPrefix = prefix.trimEnd();
      if (trimmedPrefix && rest) {
        return `${trimmedPrefix} ${rest}`;
      }
      if (trimmedPrefix) {
        return trimmedPrefix;
      }
      return rest;
    });
  }

  function serializeCuesToSrt(cues, { includeSpeakers = true, speakerNames = {} } = {}) {
    const normalized = normalizeSubtitleCues(applySpeakerNamesToCues(cues, speakerNames));
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

  function serializeCuesToVtt(cues, { includeSpeakers = true, useVoiceTags = false, speakerNames = {} } = {}) {
    const normalized = normalizeSubtitleCues(applySpeakerNamesToCues(cues, speakerNames));
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

    for (const sourceLine of lines) {
      const rawLine = sourceLine.replace(/^(\s*(?:(?:\*\*)?\[[^\n]+?\](?:\*\*)?\s*)?\*\*)([^*\n]+)(:\*\*)/, (match, prefix, label, suffix) => `${prefix}${label.replace(/\\([\\`_{}\[\]<>!#~|])/g, '$1')}${suffix}`);
      const trimmed = rawLine.trim();
      if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
        continue;
      }
      const headingMatch = /^#{1,6}\s+(.*)$/.exec(trimmed);
      if (headingMatch) {
        output.push(headingMatch[1].trim());
        continue;
      }
      const tsMatch = /^(?:\*\*)?\[(\d{1,2}:\d{2}(?::\d{2})?\s+-\s+\d{1,2}:\d{2}(?::\d{2})?)\](?:\*\*)?\s*(.*)$/.exec(trimmed);
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
        reason: 'Subtitles require exact segment timings. Re-transcribe from the saved audio to generate them.',
        cues: [],
      };
    }

    if (typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved subtitle timing data is invalid. Re-transcribe from the saved audio to regenerate timings.',
        cues: [],
      };
    }

    if (payload.schemaVersion !== CAPTIONS_SCHEMA_VERSION) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved subtitle timing format is unsupported. Re-transcribe from the saved audio to regenerate timings.',
        cues: [],
      };
    }

    if (typeof payload.sourceTranscriptHash !== 'string' || !SHA256_HASH_RE.test(payload.sourceTranscriptHash)) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved subtitle timing data is missing a transcript checksum. Re-transcribe from the saved audio to regenerate timings.',
        cues: [],
      };
    }

    if (!VALID_CAPTION_ENGINES.has(payload.engine) || !VALID_TIMING_PRECISIONS.has(payload.timingPrecision)) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved subtitle timing metadata is invalid. Re-transcribe from the saved audio to regenerate timings.',
        cues: [],
      };
    }

    if (!Array.isArray(payload.cues)) {
      return {
        valid: false,
        code: 'CAPTIONS_INVALID',
        reason: 'Saved subtitle timing entries are invalid. Re-transcribe from the saved audio to regenerate timings.',
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
          reason: 'Saved subtitle timing data is damaged. Re-transcribe from the saved audio to regenerate timings.',
          cues: [],
        };
      }
      if (!Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs)
        || cue.startMs < 0 || cue.endMs <= cue.startMs || cue.startMs < prevEndMs) {
        return {
          valid: false,
          code: 'CAPTIONS_INVALID',
          reason: 'Saved subtitle timestamps are invalid. Re-transcribe from the saved audio to regenerate timings.',
          cues: [],
        };
      }
      if (typeof cue.text !== 'string' || !cue.text.trim()) {
        return {
          valid: false,
          code: 'CAPTIONS_INVALID',
          reason: 'Saved subtitle text is invalid. Re-transcribe from the saved audio to regenerate timings.',
          cues: [],
        };
      }
      if (cue.speaker !== undefined && cue.speaker !== null && (typeof cue.speaker !== 'string' || !cue.speaker.trim())) {
        return {
          valid: false,
          code: 'CAPTIONS_INVALID',
          reason: 'Saved subtitle speaker label is invalid. Re-transcribe from the saved audio to regenerate timings.',
          cues: [],
        };
      }
      prevEndMs = cue.endMs;
    }

    if (expectedTranscriptHash && payload.sourceTranscriptHash !== expectedTranscriptHash) {
      return {
        valid: false,
        code: 'CAPTIONS_STALE',
        reason: 'This transcript changed after its subtitle timings were created. Re-transcribe from the saved audio to update them.',
        cues: [],
      };
    }

    const normalizedCues = normalizeSubtitleCues(payload.cues);
    if (normalizedCues.length === 0) {
      return {
        valid: false,
        code: 'CAPTIONS_MISSING',
        reason: 'Subtitles require exact segment timings. Re-transcribe from the saved audio to generate them.',
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

  function normalizeOptionalString(value) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const trimmed = String(value).trim();
    return trimmed ? trimmed : null;
  }

  function normalizeOptionalNumber(value) {
    if (value === null || value === undefined || typeof value === 'boolean') {
      return null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const num = Number(trimmed);
      return Number.isFinite(num) ? num : null;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    return null;
  }

  function normalizeLfText(value) {
    return String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function normalizeExportSpeakerNamesMap(names) {
    if (!names || typeof names !== 'object' || Array.isArray(names)) {
      return {};
    }
    const normalized = {};
    for (const key of Object.keys(names).sort()) {
      if (!CANONICAL_SPEAKER_KEY_RE.test(key) || typeof names[key] !== 'string') {
        continue;
      }
      const clean = normalizeExportSpeakerName(names[key]);
      if (clean) {
        normalized[key] = clean;
      }
    }
    return normalized;
  }

  function extractDistinctSpeakerLabelsFromMarkdown(markdown) {
    const labels = new Set();
    const pattern = new RegExp(
      `^(\\s*(?:(?:\\*\\*)?\\[\\d{1,2}:\\d{2}(?::\\d{2})?\\s+-\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\](?:\\*\\*)?\\s*)?)\\*\\*(${SPEAKER_LABEL_PATTERN_SOURCE}):\\*\\*`,
      'gm',
    );
    for (const match of String(markdown || '').matchAll(pattern)) {
      if (match[2]) {
        labels.add(match[2]);
      }
    }
    return labels;
  }

  function normalizeCaptionsExportStatus(status, available) {
    if (available) {
      return 'ready';
    }
    const raw = String(status || '').trim().toLowerCase();
    if (raw === 'stale' || raw === 'captions_stale') {
      return 'stale';
    }
    if (raw === 'invalid' || raw === 'captions_invalid') {
      return 'invalid';
    }
    return 'missing';
  }

  function buildCaptionsExportSection(captions, { includeSpeakers, speakerNames }) {
    const raw = captions && typeof captions === 'object' && !Array.isArray(captions) ? captions : null;
    const rawStatus = String(raw?.status || '').trim().toLowerCase();
    const isMarkedAvailable = Boolean(
      raw
      && raw.available !== false
      && (!rawStatus || rawStatus === 'ready' || rawStatus === 'ok')
    );
    const rawCues = Array.isArray(raw?.cues) ? raw.cues : [];

    if (!isMarkedAvailable || rawCues.length === 0) {
      return {
        available: false,
        status: normalizeCaptionsExportStatus(raw?.status, false),
        engine: null,
        timingPrecision: null,
        cues: [],
      };
    }

    const overlaidCues = includeSpeakers ? applySpeakerNamesToCues(rawCues, speakerNames) : rawCues;
    const normalizedCues = normalizeSubtitleCues(overlaidCues);
    if (normalizedCues.length === 0) {
      return {
        available: false,
        status: normalizeCaptionsExportStatus(raw?.status, false),
        engine: null,
        timingPrecision: null,
        cues: [],
      };
    }

    return {
      available: true,
      status: 'ready',
      engine: normalizeOptionalString(raw.engine),
      timingPrecision: normalizeOptionalString(raw.timingPrecision),
      cues: normalizedCues.map((cue, index) => ({
        index: index + 1,
        startMs: cue.startMs,
        endMs: cue.endMs,
        speaker: includeSpeakers ? (normalizeOptionalString(cue.speaker) || null) : null,
        text: cue.text,
      })),
    };
  }

  function buildSummaryExportSection(summary, { rec, resolvedTranscriptHash, speakerNamesHash }) {
    const rawSummary = summary !== undefined
      ? summary
      : (rec?.ai?.summary || (typeof rec?.summary === 'string' && rec.summary.trim()
        ? { status: 'completed', markdown: rec.summary }
        : null));

    if (!rawSummary || typeof rawSummary !== 'object' || Array.isArray(rawSummary)) {
      return null;
    }

    const rawMarkdown = typeof rawSummary.markdown === 'string'
      ? normalizeLfText(rawSummary.markdown)
      : (typeof rec?.summary === 'string' ? normalizeLfText(rec.summary) : '');
    const structured = rawSummary.structured && typeof rawSummary.structured === 'object' && !Array.isArray(rawSummary.structured)
      ? rawSummary.structured
      : null;

    if (rawSummary.status && rawSummary.status !== 'completed') {
      return null;
    }
    if (!rawSummary.status && !rawMarkdown.trim() && !structured) {
      return null;
    }

    const summarySourceHash = normalizeOptionalString(rawSummary.sourceTranscriptHash);
    const summarySpeakersHash = normalizeOptionalString(rawSummary.speakerNamesHash);
    const transcriptStale = Boolean(
      summarySourceHash
      && resolvedTranscriptHash
      && summarySourceHash !== resolvedTranscriptHash
    );
    const speakerNamesStale = typeof speakerNamesHash === 'string'
      ? (summarySpeakersHash || '') !== speakerNamesHash
      : false;
    const stale = typeof rawSummary.stale === 'boolean'
      ? rawSummary.stale
      : Boolean(rec?.summaryStale || transcriptStale || speakerNamesStale);

    return {
      status: 'completed',
      markdown: rawMarkdown.trim() ? rawMarkdown : null,
      structured,
      language: normalizeOptionalString(rawSummary.language),
      languageSource: normalizeOptionalString(rawSummary.languageSource),
      modelId: normalizeOptionalString(rawSummary.modelId),
      model: normalizeOptionalString(rawSummary.model),
      modelProfile: normalizeOptionalString(rawSummary.modelProfile ?? rawSummary.profile),
      tag: normalizeOptionalString(rawSummary.tag),
      template: normalizeOptionalString(rawSummary.template ?? structured?.template),
      templateVersion: normalizeOptionalString(rawSummary.templateVersion),
      generatedAt: normalizeOptionalString(rawSummary.generatedAt),
      sourceTranscriptHash: summarySourceHash,
      speakerNamesHash: summarySpeakersHash,
      stale,
    };
  }

  /**
   * Serialize recording metadata, speaker overlays, transcript, validated cues,
   * and summary data into schema-v1 `avanevis-transcript` JSON.
   * Never emits raw host filesystem paths.
   */
  function serializeTranscriptToJson(options = {}) {
    const {
      exportedAt = null,
      recording = null,
      meeting = null,
      includeSpeakers = true,
      speakerNames = undefined,
      speakerNamesHash = undefined,
      speakerCount = undefined,
      transcriptMarkdown = undefined,
      transcript = undefined,
      sourceTranscriptHash = undefined,
      captions = null,
      summary = undefined,
    } = options || {};

    const rec = recording && typeof recording === 'object'
      ? recording
      : (meeting && typeof meeting === 'object' ? meeting : {});
    const includeSpeakerLabels = includeSpeakers !== false;

    const rawSpeakerNames = speakerNames !== undefined
      ? speakerNames
      : (meeting?.ai?.diarization?.speakerNames || rec?.ai?.diarization?.speakerNames || {});
    const normalizedNames = normalizeExportSpeakerNamesMap(rawSpeakerNames);

    let rawMarkdownInput = '';
    if (typeof transcriptMarkdown === 'string') {
      rawMarkdownInput = transcriptMarkdown;
    } else if (typeof transcript === 'string') {
      rawMarkdownInput = transcript;
    } else if (transcript && typeof transcript === 'object' && typeof transcript.markdown === 'string') {
      rawMarkdownInput = transcript.markdown;
    }
    const rawMarkdownLf = normalizeLfText(rawMarkdownInput);
    const resolvedTranscriptHash = normalizeOptionalString(
      sourceTranscriptHash !== undefined
        ? sourceTranscriptHash
        : (transcript && typeof transcript === 'object' ? transcript.sourceTranscriptHash : null),
    );

    const resolvedMarkdown = includeSpeakerLabels
      ? applySpeakerNamesToMarkdown(rawMarkdownLf, normalizedNames)
      : stripSpeakerPrefixesFromMarkdown(rawMarkdownLf);
    const plainText = resolvedMarkdown.trim()
      ? convertTranscriptMarkdownToPlainText(resolvedMarkdown)
      : '';

    const captionsSection = buildCaptionsExportSection(captions, {
      includeSpeakers: includeSpeakerLabels,
      speakerNames: normalizedNames,
    });

    let speakersSection;
    if (!includeSpeakerLabels) {
      speakersSection = {
        included: false,
        names: {},
        speakerNamesHash: null,
        count: 0,
      };
    } else {
      const distinctSpeakers = extractDistinctSpeakerLabelsFromMarkdown(rawMarkdownLf);
      for (const key of Object.keys(normalizedNames)) {
        distinctSpeakers.add(key);
      }
      if (captionsSection.available) {
        for (const cue of captions.cues) {
          const cueSpeaker = normalizeOptionalString(cue?.speaker);
          if (cueSpeaker) {
            distinctSpeakers.add(cueSpeaker);
          }
        }
      }
      const explicitCount = normalizeOptionalNumber(
        speakerCount !== undefined
          ? speakerCount
          : (meeting?.ai?.diarization?.speakerCount ?? rec?.ai?.diarization?.speakerCount),
      );
      const safeExplicitCount = explicitCount !== null && explicitCount >= 0
        ? Math.floor(explicitCount)
        : 0;
      const resolvedNamesHash = normalizeOptionalString(
        speakerNamesHash !== undefined ? speakerNamesHash : rec?.speakerNamesHash,
      );
      speakersSection = {
        included: true,
        names: normalizedNames,
        speakerNamesHash: resolvedNamesHash,
        count: Math.max(safeExplicitCount, distinctSpeakers.size),
      };
    }

    const summarySection = buildSummaryExportSection(summary, {
      rec,
      resolvedTranscriptHash,
      speakerNamesHash,
    });

    const payload = {
      schemaVersion: TRANSCRIPT_EXPORT_JSON_SCHEMA_VERSION,
      format: 'avanevis-transcript',
      exportedAt: normalizeOptionalString(exportedAt) || new Date().toISOString(),
      recording: {
        id: normalizeOptionalString(rec.id),
        title: normalizeOptionalString(rec.title),
        date: normalizeOptionalString(rec.date),
        duration: normalizeOptionalString(rec.duration),
        durationSeconds: normalizeOptionalNumber(rec.durationSeconds),
        tag: normalizeOptionalString(rec.tag),
        language: normalizeOptionalString(rec.language ?? rec.transcriptionResult?.language),
        model: normalizeOptionalString(
          rec.model ?? rec.transcriptionResult?.modelSize ?? rec.transcriptionResult?.modelId,
        ),
        engine: normalizeOptionalString(rec.engine ?? rec.transcriptionResult?.engine),
        transcriptionStatus: normalizeOptionalString(rec.transcriptionStatus),
        transcriptionDevice: normalizeOptionalString(
          rec.transcriptionDevice ?? rec.transcriptionResult?.device,
        ),
        transcriptionComputeType: normalizeOptionalString(
          rec.transcriptionComputeType ?? rec.transcriptionResult?.computeType,
        ),
      },
      speakers: speakersSection,
      transcript: {
        markdown: resolvedMarkdown,
        plainText,
        sourceTranscriptHash: resolvedTranscriptHash,
      },
      captions: captionsSection,
      summary: summarySection,
    };

    return `${JSON.stringify(payload, null, 2)}\n`;
  }

  function buildExportFormatOptions({
    captionsAvailable = false,
    captionsStatus = 'missing',
    hasAudio = false,
  } = {}) {
    const subtitlesReady = Boolean(captionsAvailable);
    const unavailableReason = captionsStatus === 'stale'
      ? 'This transcript changed after its subtitle timings were created. Re-transcribe from the saved audio to update them.'
      : 'Subtitles require exact segment timings. Re-transcribe from the saved audio to generate them.';

    return {
      defaultFormat: 'md',
      captionsUnavailableNotice: subtitlesReady ? '' : unavailableReason,
      canRetranscribe: Boolean(hasAudio && !subtitlesReady),
      options: [
        {
          format: 'md',
          label: 'Markdown',
          extLabel: '.md',
          description: 'Recording details, speaker headings, and formatted transcript.',
          available: true,
          disabledReason: '',
        },
        {
          format: 'txt',
          label: 'Plain Text',
          extLabel: '.txt',
          description: 'Readable plain text with timestamps and no Markdown.',
          available: true,
          disabledReason: '',
        },
        {
          format: 'json',
          label: 'Structured JSON',
          extLabel: '.json',
          description: 'Recording details, speaker-resolved transcript, timings, and summary data.',
          available: true,
          disabledReason: '',
        },
        {
          format: 'srt',
          label: 'SubRip Subtitles',
          extLabel: '.srt',
          description: subtitlesReady
            ? 'SubRip captions with millisecond timestamps (HH:MM:SS,mmm).'
            : 'Needs subtitle timings from audio transcription.',
          available: subtitlesReady,
          disabledReason: subtitlesReady ? '' : unavailableReason,
        },
        {
          format: 'vtt',
          label: 'WebVTT Subtitles',
          extLabel: '.vtt',
          description: subtitlesReady
            ? 'WebVTT captions for web and video players (HH:MM:SS.mmm).'
            : 'Needs subtitle timings from audio transcription.',
          available: subtitlesReady,
          disabledReason: subtitlesReady ? '' : unavailableReason,
        },
      ],
    };
  }

  return {
    CAPTIONS_SCHEMA_VERSION,
    MIN_CUE_DURATION_MS,
    TRANSCRIPT_EXPORT_JSON_SCHEMA_VERSION,
    VALID_CAPTION_ENGINES: Array.from(VALID_CAPTION_ENGINES),
    VALID_EXPORT_FORMATS,
    VALID_TIMING_PRECISIONS: Array.from(VALID_TIMING_PRECISIONS),
    applySpeakerNamesToMarkdown,
    buildExportFormatOptions,
    convertTranscriptMarkdownToPlainText,
    formatSrtTimestamp,
    formatVttTimestamp,
    normalizeSubtitleCues,
    serializeCuesToSrt,
    serializeCuesToVtt,
    serializeTranscriptToJson,
    stripSpeakerPrefixesFromMarkdown,
    validateCaptionsSidecar,
  };
}));
