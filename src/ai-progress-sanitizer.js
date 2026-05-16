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

module.exports = {
  SENSITIVE_PROGRESS_KEYS,
  SENSITIVE_PROGRESS_KEY_SET,
};
