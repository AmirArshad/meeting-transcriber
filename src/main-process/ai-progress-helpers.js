'use strict';

const {
  redactSensitiveText,
  createLineChunkRedactor,
  SENSITIVE_PROGRESS_KEY_SET,
} = require('../ai-progress-sanitizer');

function sanitizeAiProgressMessage(message) {
  return redactSensitiveText(message)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function summarizeAiBackendError({ errorOutput, userDataDir = '', homeDir = '', genericMessage = '' } = {}) {
  const lines = String(errorOutput || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) {
    let cleaned = redactSensitiveText(line)
      .replace(/^ERROR:\s*/i, '')
      .trim();
    if (userDataDir) {
      cleaned = cleaned.replaceAll(userDataDir, '<userData>');
    }
    if (homeDir) {
      cleaned = cleaned.replaceAll(homeDir, '<home>');
    }
    cleaned = cleaned.trim();
    if (!cleaned
      || cleaned === genericMessage
      || /RuntimeWarning:.*found in sys\.modules.*prior to execution/.test(cleaned)) {
      continue;
    }
    return cleaned;
  }
  return '';
}

function parseAiBackendProgressLine(line, expectedFeature = null) {
  let parsed;
  try {
    parsed = JSON.parse(String(line || '').trim());
  } catch (error) {
    return null;
  }

  if (!parsed || parsed.type !== 'progress') {
    return null;
  }

  const feature = String(parsed.feature || '').trim();
  if (!feature || (expectedFeature && feature !== expectedFeature)) {
    return null;
  }

  const event = {
    feature,
    phase: String(parsed.phase || 'status').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
    message: sanitizeAiProgressMessage(parsed.message),
  };

  if (Number.isFinite(parsed.percent)) {
    event.percent = Math.max(0, Math.min(100, Number(parsed.percent)));
  }
  if (Number.isFinite(parsed.downloadedBytes) && parsed.downloadedBytes >= 0) {
    event.downloadedBytes = Math.floor(parsed.downloadedBytes);
  }
  if (Number.isFinite(parsed.totalBytes) && parsed.totalBytes > 0) {
    event.totalBytes = Math.floor(parsed.totalBytes);
  }
  if (event.totalBytes && event.downloadedBytes > event.totalBytes) {
    event.downloadedBytes = event.totalBytes;
  }
  if (Number.isInteger(parsed.chunkIndex)) {
    event.chunkIndex = parsed.chunkIndex;
  }
  if (Number.isInteger(parsed.chunkTotal)) {
    event.chunkTotal = parsed.chunkTotal;
  }
  if (typeof parsed.status === 'string' && parsed.status.trim()) {
    event.status = parsed.status.trim().slice(0, 80);
  }

  for (const key of Object.keys(parsed)) {
    if (SENSITIVE_PROGRESS_KEY_SET.has(key)) {
      delete event[key];
    }
  }

  return event;
}

function splitBufferedLines(output, pendingBuffer = '') {
  const combined = `${pendingBuffer}${output}`;
  const normalized = combined.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');

  return {
    lines: parts.slice(0, -1),
    remainder: parts.at(-1) || ''
  };
}

function dedupeMessages(messages = []) {
  const seen = new Set();
  const unique = [];

  for (const message of messages) {
    const normalized = String(message || '').trim();

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

module.exports = {
  parseAiBackendProgressLine,
  summarizeAiBackendError,
  redactSensitiveText,
  createLineChunkRedactor,
  splitBufferedLines,
  dedupeMessages,
};
