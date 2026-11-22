'use strict';

// Keep this matrix aligned with backend/summaries/summary_language.py and the
// bounded checks recorded in the model qualification documents.
const SUMMARY_LANGUAGE_POLICY_VERSION = 'summary-language-v4';
const SUMMARY_LANGUAGE_NAMES = Object.freeze({
  en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  zh: 'Chinese', ja: 'Japanese', it: 'Italian', pa: 'Panjabi',
  hi: 'Hindi', ko: 'Korean', pt: 'Portuguese',
});

const EXISTING_CHAT_MODELS = new Set(['qwen3.5-9b-q4-k-m', 'qwen3.5-4b-q4-k-m', 'gemma-4-e4b', 'gemma-4-12b']);
const PEER_PLATFORM_GATES = Object.freeze({
  win32: Object.freeze({ status: 'gated', reason: 'Awaiting 32k setup and Chat verification on Windows CUDA.' }),
  darwin: Object.freeze({ status: 'gated', reason: 'Awaiting 32k setup and Chat verification on Apple Silicon.' }),
  linux: Object.freeze({ status: 'gated', reason: 'Awaiting 32k setup and Chat verification on Linux CUDA.' }),
});
const LINUX_QUALIFIED_PEER_PLATFORMS = Object.freeze({
  ...PEER_PLATFORM_GATES,
  linux: Object.freeze({ status: 'enabled' }),
});
const MODEL_PLATFORM_GATES = new Map([
  ['bonsai-2-9b-q2-0', LINUX_QUALIFIED_PEER_PLATFORMS],
  ['bonsai-2-27b-q2-0', LINUX_QUALIFIED_PEER_PLATFORMS],
  ['ministral-3-14b', PEER_PLATFORM_GATES],
  ['gemma-4-26b-a4b', PEER_PLATFORM_GATES],
  ['qwen3.8-27b', PEER_PLATFORM_GATES],
  ['inkling-2-mini', Object.freeze({
    ...PEER_PLATFORM_GATES,
    linux: Object.freeze({ status: 'gated', reason: 'Awaiting 32k setup and Chat verification on Linux CUDA with a 24+ GiB GPU.' }),
  })],
]);

function getSummaryModelPlatformGates(modelId) {
  return MODEL_PLATFORM_GATES.get(modelId);
}

function getSummaryLanguagePolicy(modelId, platform, arch) {
  const supportedRuntime = (platform === 'win32' && arch === 'x64')
    || (platform === 'darwin' && arch === 'arm64')
    || (platform === 'linux' && arch === 'x64');
  const platformGates = getSummaryModelPlatformGates(modelId);
  const chatReady = supportedRuntime && (platformGates
    ? platformGates[platform]?.status === 'enabled'
    : EXISTING_CHAT_MODELS.has(modelId));
  const gemmaEnglish = platform === 'darwin' && ['gemma-4-e4b', 'gemma-4-12b'].includes(modelId);
  const languages = chatReady && modelId === 'qwen3.5-9b-q4-k-m' ? Object.keys(SUMMARY_LANGUAGE_NAMES)
    : chatReady && gemmaEnglish ? ['en'] : [];
  return {
    version: SUMMARY_LANGUAGE_POLICY_VERSION,
    modelId,
    chatReady,
    languages,
    names: { ...SUMMARY_LANGUAGE_NAMES },
  };
}

module.exports = { SUMMARY_LANGUAGE_POLICY_VERSION, SUMMARY_LANGUAGE_NAMES, getSummaryLanguagePolicy, getSummaryModelPlatformGates };
