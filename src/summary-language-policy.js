'use strict';

// Keep this matrix aligned with backend/summaries/summary_language.py and the
// bounded checks recorded in the model qualification documents.
const SUMMARY_LANGUAGE_POLICY_VERSION = 'summary-language-v3';
const SUMMARY_LANGUAGE_NAMES = Object.freeze({
  en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  zh: 'Chinese', ja: 'Japanese', it: 'Italian', pa: 'Panjabi',
  hi: 'Hindi', ko: 'Korean', pt: 'Portuguese',
});

function getSummaryLanguagePolicy(modelId, platform, arch) {
  const supportedRuntime = (platform === 'win32' && arch === 'x64')
    || (platform === 'darwin' && arch === 'arm64')
    || (platform === 'linux' && arch === 'x64');
  const gemmaEnglish = platform === 'darwin' && arch === 'arm64' && ['gemma-4-e4b', 'gemma-4-12b'].includes(modelId);
  return {
    version: SUMMARY_LANGUAGE_POLICY_VERSION,
    modelId,
    languages: modelId === 'qwen3.5-9b-q4-k-m' && supportedRuntime
      ? Object.keys(SUMMARY_LANGUAGE_NAMES)
      : gemmaEnglish ? ['en'] : [],
    names: { ...SUMMARY_LANGUAGE_NAMES },
  };
}

module.exports = { SUMMARY_LANGUAGE_POLICY_VERSION, SUMMARY_LANGUAGE_NAMES, getSummaryLanguagePolicy };
