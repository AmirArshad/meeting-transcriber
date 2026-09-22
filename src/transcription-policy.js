(function initTranscriptionPolicy(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.transcriptionPolicy = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildTranscriptionPolicy() {
  'use strict';

  // v2.10 slice A curated choices. Large v3 exposure waits on slice B
  // qualification; retained-language evaluation (slice C) has not removed
  // anything beyond Persian yet. Pending-job resume keeps legacy compat.
  var SELECTABLE_LANGUAGES = Object.freeze(['en', 'es', 'fr', 'de', 'zh', 'ja', 'it', 'pa', 'hi', 'ko', 'pt']);
  var SELECTABLE_MODEL_SIZES = Object.freeze(['small', 'medium']);
  var LEGACY_MODEL_SIZES = Object.freeze(['tiny', 'base', 'small', 'medium', 'large', 'large-v3']);
  var LEGACY_LANGUAGES = Object.freeze(['en', 'es', 'fr', 'de', 'zh', 'ja', 'fa', 'it', 'pa', 'hi', 'ko', 'pt']);
  var DEFAULT_LANGUAGE = 'en';
  var DEFAULT_MODEL_SIZE = 'small';

  function normalizeString(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
  }

  function isSelectableLanguage(language) {
    return SELECTABLE_LANGUAGES.indexOf(normalizeString(language)) !== -1;
  }

  function isSelectableModelSize(modelSize) {
    return SELECTABLE_MODEL_SIZES.indexOf(normalizeString(modelSize)) !== -1;
  }

  function isCompatibleLanguage(language) {
    return LEGACY_LANGUAGES.indexOf(normalizeString(language)) !== -1;
  }

  function isCompatibleModelSize(modelSize) {
    return LEGACY_MODEL_SIZES.indexOf(normalizeString(modelSize)) !== -1;
  }

  // Normalize saved/new preferences for NEW work. Legacy pending jobs keep
  // their saved values via isCompatible* above and must not pass through here.
  // Returns { language, modelSize, migrated, requiresChoice, normalizedLarge }.
  // - Tiny/Base migrate to Small once with migrated=true + visible explanation.
  // - Saved `large` normalizes to canonical `large-v3` (still gated by slice B).
  // - Removed/unknown language yields requiresChoice=true (no silent English).
  // - Failed/empty inputs fall back to safe in-memory defaults, never blanks.
  function normalizePreferences(preferences) {
    var input = preferences || {};
    var rawLanguage = normalizeString(input.language);
    var rawModel = normalizeString(input.modelSize || input.model);
    var migrated = false;
    var requiresChoice = false;
    var normalizedLarge = false;
    var language;
    var modelSize;

    if (!rawLanguage || !isSelectableLanguage(rawLanguage)) {
      if (rawLanguage && isCompatibleLanguage(rawLanguage)) {
        // Legacy retained choice (e.g. Persian) no longer offered for new work.
        requiresChoice = true;
        language = '';
      } else if (!rawLanguage) {
        language = DEFAULT_LANGUAGE;
      } else {
        requiresChoice = true;
        language = '';
      }
    } else {
      language = rawLanguage;
    }

    if (rawModel === 'tiny' || rawModel === 'base') {
      modelSize = DEFAULT_MODEL_SIZE;
      migrated = true;
    } else if (rawModel === 'large') {
      modelSize = 'large-v3';
      normalizedLarge = true;
    } else if (isSelectableModelSize(rawModel)) {
      modelSize = rawModel;
    } else if (rawModel === 'large-v3') {
      // Canonical Large identity preserved but still gated in Slice A: park
      // new work on Small via normalizedLarge like saved `large`.
      modelSize = 'large-v3';
      normalizedLarge = true;
    } else if (!rawModel) {
      modelSize = DEFAULT_MODEL_SIZE;
    } else {
      modelSize = DEFAULT_MODEL_SIZE;
      migrated = true;
    }

    if (!language) {
      requiresChoice = true;
    }

    return {
      language: language || '',
      modelSize: modelSize || DEFAULT_MODEL_SIZE,
      migrated: migrated,
      requiresChoice: requiresChoice,
      normalizedLarge: normalizedLarge,
    };
  }

  // Validate NEW selections before compute/spawn. No renderer bypass accepted.
  function validateNewSelection(selection) {
    var input = selection || {};
    var language = normalizeString(input.language);
    var modelSize = normalizeString(input.modelSize || input.model);
    if (!isSelectableLanguage(language)) {
      return { ok: false, code: 'UNSUPPORTED_LANGUAGE', message: 'Choose a supported transcription language.' };
    }
    if (!isSelectableModelSize(modelSize)) {
      return { ok: false, code: 'UNSUPPORTED_MODEL', message: 'Choose a supported Whisper model.' };
    }
    return { ok: true, language: language, modelSize: modelSize };
  }

  // Versioned engine preferences. Parakeet is never a Whisper size. Migrating a
  // pre-engine profile keeps Whisper active; installation does not activate it.
  function migrateEnginePreferences(preferences) {
    var input = preferences || {};
    var whisperSource = input.whisper && typeof input.whisper === 'object' ? input.whisper : input;
    var versioned = Number(input.schemaVersion) === 1 && input.whisper && typeof input.whisper === 'object';
    var normalized = normalizePreferences(whisperSource);
    var requestedEngine = normalizeString(input.activeEngine);
    var activeEngine = 'whisper';
    if (versioned && (requestedEngine === 'whisper' || requestedEngine === 'parakeet')) {
      activeEngine = requestedEngine;
    }
    return {
      schemaVersion: 1,
      activeEngine: activeEngine,
      whisper: {
        language: normalized.language,
        modelSize: normalized.modelSize,
      },
      migrated: !versioned,
      requiresChoice: normalized.requiresChoice,
      normalizedLarge: normalized.normalizedLarge,
      whisperMigrated: normalized.migrated,
    };
  }

  return {
    SELECTABLE_LANGUAGES: SELECTABLE_LANGUAGES,
    SELECTABLE_MODEL_SIZES: SELECTABLE_MODEL_SIZES,
    LEGACY_LANGUAGES: LEGACY_LANGUAGES,
    LEGACY_MODEL_SIZES: LEGACY_MODEL_SIZES,
    DEFAULT_LANGUAGE: DEFAULT_LANGUAGE,
    DEFAULT_MODEL_SIZE: DEFAULT_MODEL_SIZE,
    isSelectableLanguage: isSelectableLanguage,
    isSelectableModelSize: isSelectableModelSize,
    isCompatibleLanguage: isCompatibleLanguage,
    isCompatibleModelSize: isCompatibleModelSize,
    normalizePreferences: normalizePreferences,
    validateNewSelection: validateNewSelection,
    migrateEnginePreferences: migrateEnginePreferences,
  };
}));
