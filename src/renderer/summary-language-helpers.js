(function initSummaryLanguageHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.summaryLanguageHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildSummaryLanguageHelpers() {
  function reusableSummaryLanguage(meeting, sourceTranscriptHash, policy) {
    const summary = meeting?.ai?.summary;
    return summary?.languageSource === 'userConfirmed'
      && summary.sourceTranscriptHash === sourceTranscriptHash
      && summary.languagePolicyVersion === policy?.version
      && summary.modelId === policy?.modelId
      && policy?.languages?.includes(summary.language)
      ? summary.language : null;
  }
  return { reusableSummaryLanguage };
}));
