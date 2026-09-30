'use strict';

// Enabled only after the bounded local checks recorded in
// docs/development/V2_10_SUMMARY_QUALIFICATION.md. Runtime admission is separate.
const SUMMARY_LANGUAGE_POLICY_VERSION = 'qwen-language-v2';
const SUMMARY_LANGUAGE_NAMES = Object.freeze({
  en: 'English', es: 'Spanish', fr: 'French', de: 'German',
  zh: 'Chinese', ja: 'Japanese', it: 'Italian', pa: 'Panjabi',
  hi: 'Hindi', ko: 'Korean', pt: 'Portuguese',
});

function getSummaryLanguagePolicy(modelId, platform, arch) {
  const supportedRuntime = (platform === 'win32' && arch === 'x64')
    || (platform === 'darwin' && arch === 'arm64')
    || (platform === 'linux' && arch === 'x64');
  return {
    version: SUMMARY_LANGUAGE_POLICY_VERSION,
    modelId,
    languages: modelId === 'qwen3.5-9b-q4-k-m' && supportedRuntime ? Object.keys(SUMMARY_LANGUAGE_NAMES) : [],
    names: { ...SUMMARY_LANGUAGE_NAMES },
  };
}

module.exports = { SUMMARY_LANGUAGE_POLICY_VERSION, SUMMARY_LANGUAGE_NAMES, getSummaryLanguagePolicy };
