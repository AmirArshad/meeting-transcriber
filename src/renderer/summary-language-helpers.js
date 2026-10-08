(function initSummaryLanguageHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.summaryLanguageHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildSummaryLanguageHelpers() {
  // Primary names match the transcription control and summary language policy.
  // Region and script tags are displayed separately and are never rewritten.
  const PRIMARY_LANGUAGE_NAMES = Object.freeze({
    en: 'English', es: 'Spanish', fr: 'French', de: 'German',
    zh: 'Chinese', ja: 'Japanese', it: 'Italian', pa: 'Panjabi',
    hi: 'Hindi', ko: 'Korean', pt: 'Portuguese',
  });
  const UNIDENTIFIED_LANGUAGE = /^(?:auto|und|undetermined|unknown|zxx|mul|mis|none|null|na|n\/a)$/i;
  const SUMMARY_RECORD_FIELDS = [
    'markdownPath', 'jsonPath', 'language', 'languageSource', 'status',
    'modelId', 'sourceTranscriptHash', 'languagePolicyVersion',
  ];

  function reusableSummaryLanguage(meeting, sourceTranscriptHash, policy) {
    const summary = meeting?.ai?.summary;
    return summary?.languageSource === 'userConfirmed'
      && summary.sourceTranscriptHash === sourceTranscriptHash
      && summary.languagePolicyVersion === policy?.version
      && summary.modelId === policy?.modelId
      && policy?.languages?.includes(summary.language)
      ? summary.language : null;
  }

  function languageDisplayNames() {
    try {
      return new Intl.DisplayNames(['en'], {
        type: 'language',
        languageDisplay: 'standard',
        fallback: 'none',
      });
    } catch (error) {
      return new Intl.DisplayNames(['en'], { type: 'language' });
    }
  }

  function resolveLanguageDisplayName(code) {
    if (typeof code !== 'string') return null;
    const trimmed = code.trim();
    if (!trimmed || UNIDENTIFIED_LANGUAGE.test(trimmed)) return null;
    const hyphenated = trimmed.replace(/_/g, '-');
    if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$/.test(hyphenated)) return null;

    let canonical;
    try {
      canonical = Intl.getCanonicalLocales(hyphenated)[0];
    } catch (error) {
      return null;
    }
    if (!canonical) return null;
    const primary = canonical.split('-')[0].toLowerCase();
    if (UNIDENTIFIED_LANGUAGE.test(primary)) return null;
    if (!canonical.includes('-') && Object.hasOwn(PRIMARY_LANGUAGE_NAMES, primary)) {
      return PRIMARY_LANGUAGE_NAMES[primary];
    }

    let display;
    try {
      display = languageDisplayNames().of(canonical);
    } catch (error) {
      return null;
    }
    if (typeof display !== 'string') return null;
    const name = display.trim();
    if (!name) return null;
    if (name.toLowerCase() === canonical.toLowerCase() || name.toLowerCase() === trimmed.toLowerCase()) {
      return null;
    }
    if (/^(?:unknown|undetermined|unidentified)(?:\s+language)?$/i.test(name)) return null;
    return name;
  }

  function formatTranscriptLanguageCaption(language) {
    const name = resolveLanguageDisplayName(language);
    return {
      visible: true,
      label: 'Language',
      value: name || 'Not identified',
    };
  }

  function summaryOutputExists(meeting) {
    if (!meeting || typeof meeting !== 'object') return false;
    if (typeof meeting.summary === 'string' && meeting.summary.trim()) return true;
    const meta = meeting.ai && meeting.ai.summary;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
    return SUMMARY_RECORD_FIELDS.some((field) => typeof meta[field] === 'string' && meta[field].trim());
  }

  function formatSummaryLanguageCaption(meeting) {
    if (!summaryOutputExists(meeting)) {
      return { visible: false, label: '', value: '' };
    }
    const name = resolveLanguageDisplayName(meeting?.ai?.summary?.language);
    if (!name) {
      return { visible: true, label: 'Summary language', value: 'Not recorded' };
    }
    return { visible: true, label: 'Summary language', value: name };
  }

  return {
    reusableSummaryLanguage,
    resolveLanguageDisplayName,
    formatTranscriptLanguageCaption,
    formatSummaryLanguageCaption,
  };
}));
