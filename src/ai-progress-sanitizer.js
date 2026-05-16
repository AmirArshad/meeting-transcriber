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

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/hf_[A-Za-z0-9_-]+/g, '[redacted-token]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted-token]')
    .replace(/(https?:\/\/)[^/?#@\s]+@/gi, '$1[redacted]@');
}

module.exports = {
  redactSensitiveText,
  SENSITIVE_PROGRESS_KEYS,
  SENSITIVE_PROGRESS_KEY_SET,
};
