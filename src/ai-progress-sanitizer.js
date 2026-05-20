const SENSITIVE_PROGRESS_KEYS = Object.freeze([
  'hfToken',
  'llmOutput',
  'prompt',
  'rawOutput',
  'text',
  'token',
  'transcript',
  'transcriptText',
]);

const SENSITIVE_PROGRESS_KEY_SET = new Set(SENSITIVE_PROGRESS_KEYS);
const PROGRESS_LINE_REMAINDER_MAX_CHARS = 64 * 1024;

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/hf_[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted-token]')
    .replace(/(Authorization:\s*token\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted-token]')
    .replace(/((?:access_)?token=|api_key=)[^&#\s]+/gi, '$1[redacted-token]')
    .replace(/(X-Api-Key:\s*)[^\r\n\s]+/gi, '$1[redacted-token]')
    .replace(/(https?:\/\/)[^/?#@\s]+@/gi, '$1[redacted]@');
}

function createLineChunkRedactor({ maxRemainderChars = PROGRESS_LINE_REMAINDER_MAX_CHARS } = {}) {
  let lineRemainder = '';

  const capRemainder = () => {
    if (lineRemainder.length > maxRemainderChars) {
      lineRemainder = lineRemainder.slice(lineRemainder.length - maxRemainderChars);
    }
  };

  return {
    redactChunk(chunk) {
      const text = `${lineRemainder}${String(chunk || '')}`;
      const parts = text.split(/\r?\n/);
      lineRemainder = parts.pop() || '';
      capRemainder();
      if (parts.length === 0) {
        return '';
      }
      return `${parts.map((line) => redactSensitiveText(line)).join('\n')}\n`;
    },
    flush() {
      if (!lineRemainder) {
        return '';
      }
      const flushed = redactSensitiveText(lineRemainder);
      lineRemainder = '';
      return flushed;
    },
  };
}

module.exports = {
  redactSensitiveText,
  createLineChunkRedactor,
  PROGRESS_LINE_REMAINDER_MAX_CHARS,
  SENSITIVE_PROGRESS_KEYS,
  SENSITIVE_PROGRESS_KEY_SET,
};
