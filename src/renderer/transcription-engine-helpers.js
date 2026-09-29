(function attachTranscriptionEngineHelpers(root) {
  const helpers = buildTranscriptionEngineHelpers();

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }
  root.transcriptionEngineHelpers = helpers;

  function buildTranscriptionEngineHelpers() {
    'use strict';

    const ENGINE_NAMES = Object.freeze(['whisper', 'parakeet']);
    const ACTIVE_SETUP_STATES = new Set([
      'downloading',
      'verifying',
      'waiting-for-validation',
      'validating',
    ]);

    function normalizeTranscriptionEnginePreferences(savedSettings = {}, policy = null) {
      const settings = savedSettings && typeof savedSettings === 'object' ? savedSettings : {};
      const migrated = policy && typeof policy.migrateEnginePreferences === 'function'
        ? policy.migrateEnginePreferences(settings)
        : fallbackMigration(settings);
      const whisperSource = settings.whisper && typeof settings.whisper === 'object'
        ? settings.whisper
        : settings;
      const rawLanguage = String(whisperSource.language == null ? '' : whisperSource.language)
        .trim()
        .toLowerCase();
      const preferences = {
        schemaVersion: 1,
        activeEngine: ENGINE_NAMES.includes(migrated.activeEngine) ? migrated.activeEngine : 'whisper',
        whisper: {
          // Keep a retired value durable so policy can keep requiring a choice
          // after restart instead of treating an empty saved value as a fresh default.
          language: migrated.requiresChoice && rawLanguage
            ? rawLanguage
            : (migrated.whisper?.language == null ? 'en' : migrated.whisper.language),
          modelSize: migrated.whisper?.modelSize == null ? 'small' : migrated.whisper.modelSize,
        },
      };
      const alreadyVersioned = Number(settings.schemaVersion) === 1
        && settings.whisper
        && typeof settings.whisper === 'object';
      const shouldPersist = !alreadyVersioned
        || Boolean(migrated.whisperMigrated)
        || !ENGINE_NAMES.includes(settings.activeEngine)
        || settings.whisper.language !== preferences.whisper.language
        || settings.whisper.modelSize !== preferences.whisper.modelSize;

      return {
        preferences,
        shouldPersist,
        requiresChoice: Boolean(migrated.requiresChoice),
        normalizedLarge: Boolean(migrated.normalizedLarge),
        whisperMigrated: Boolean(migrated.whisperMigrated),
      };
    }

    function fallbackMigration(settings) {
      const versioned = Number(settings.schemaVersion) === 1
        && settings.whisper && typeof settings.whisper === 'object';
      const source = versioned ? settings.whisper : settings;
      const rawModel = String(source.modelSize || source.model || '').trim().toLowerCase();
      const modelSize = rawModel === 'medium' ? 'medium' : 'small';
      return {
        activeEngine: versioned && settings.activeEngine === 'parakeet' ? 'parakeet' : 'whisper',
        whisper: {
          language: String(source.language || 'en').trim().toLowerCase(),
          modelSize,
        },
        requiresChoice: false,
        normalizedLarge: false,
        whisperMigrated: Boolean(rawModel && rawModel !== modelSize),
      };
    }

    function updateTranscriptionEnginePreferences(current = {}, updates = {}) {
      const activeEngine = ENGINE_NAMES.includes(updates.activeEngine)
        ? updates.activeEngine
        : (ENGINE_NAMES.includes(current.activeEngine) ? current.activeEngine : 'whisper');
      const currentWhisper = current.whisper && typeof current.whisper === 'object'
        ? current.whisper
        : {};
      const updateWhisper = updates.whisper && typeof updates.whisper === 'object'
        ? updates.whisper
        : {};
      return {
        schemaVersion: 1,
        activeEngine,
        whisper: {
          language: updateWhisper.language == null
            ? (currentWhisper.language == null ? 'en' : String(currentWhisper.language))
            : String(updateWhisper.language),
          modelSize: updateWhisper.modelSize == null
            ? (currentWhisper.modelSize == null ? 'small' : String(currentWhisper.modelSize))
            : String(updateWhisper.modelSize),
        },
      };
    }

    function snapshotTranscriptionSelection(preferences = {}) {
      const activeEngine = ENGINE_NAMES.includes(preferences.activeEngine)
        ? preferences.activeEngine
        : 'whisper';
      if (activeEngine === 'parakeet') {
        return { engine: 'parakeet', language: 'en' };
      }
      const whisper = preferences.whisper && typeof preferences.whisper === 'object'
        ? preferences.whisper
        : {};
      return {
        engine: 'whisper',
        language: String(whisper.language == null ? 'en' : whisper.language),
        modelSize: String(whisper.modelSize == null ? 'small' : whisper.modelSize),
      };
    }

    function buildOrdinaryRetryOptions(meetingId) {
      return { meetingId: String(meetingId || '').trim() };
    }

    function buildWhisperRetryOptions(meetingId, selection = {}) {
      return {
        meetingId: String(meetingId || '').trim(),
        transcriptionSelection: {
          engine: 'whisper',
          language: String(selection.language || ''),
          modelSize: String(selection.modelSize || ''),
        },
      };
    }

    function buildSetupCancellationOptions(operationId) {
      return { operationId: operationId || null };
    }

    function buildParakeetSettingsView({
      status = null,
      activeEngine = 'whisper',
      operation = null,
      progress = null,
      error = null,
      formatBytes = formatBytesFallback,
    } = {}) {
      const sourceStatus = status && typeof status === 'object' ? status : {};
      const currentEngine = ENGINE_NAMES.includes(activeEngine) ? activeEngine : 'whisper';
      const phase = String(progress && progress.phase || '').toLowerCase();
      let state = String(sourceStatus.status || 'checking').toLowerCase();

      if (operation === 'remove' || operation === 'removing') {
        state = 'removing';
      } else if (operation === 'validate' || operation === 'validating') {
        state = 'validating';
      } else if (ACTIVE_SETUP_STATES.has(phase)) {
        state = phase;
      } else if ((operation === 'install' || operation === 'repair') && !phase) {
        state = 'downloading';
      }

      const labels = {
        checking: 'Checking',
        unsupported: 'Unsupported',
        'device-unavailable': 'GPU unavailable',
        'not-installed': 'Not set up',
        downloading: 'Downloading',
        verifying: 'Verifying',
        'waiting-for-validation': 'Waiting for AI work',
        validating: 'Testing GPU',
        ready: 'Ready',
        'repair-required': 'Repair required',
        removing: 'Removing',
      };
      const statusTexts = {
        checking: 'Checking Parakeet…',
        unsupported: sourceStatus.message || 'Parakeet is not supported on this OS and architecture.',
        'device-unavailable': 'The required GPU is unavailable. Recheck or repair Parakeet to continue.',
        'not-installed': 'Set up the pinned model and GPU runtime on this device.',
        downloading: 'Downloading the Parakeet model and GPU runtime…',
        verifying: 'Verifying the downloaded model and runtime…',
        'waiting-for-validation': 'Waiting for current AI work to finish…',
        validating: 'Testing Parakeet on the GPU…',
        ready: 'Parakeet is ready. It transcribes English only.',
        'repair-required': sourceStatus.message || 'A Parakeet file is missing or failed its integrity check.',
        removing: 'Removing Parakeet…',
      };
      if (!Object.hasOwn(statusTexts, state)) {
        state = 'unknown';
      }

      const actions = [];
      if (state === 'device-unavailable') {
        actions.push('recheck');
        if (sourceStatus.installed) actions.push('repair', 'remove');
      } else if (state === 'not-installed') {
        actions.push('setup');
      } else if (ACTIVE_SETUP_STATES.has(state)) {
        actions.push('cancel');
      } else if (state === 'ready') {
        if (currentEngine !== 'parakeet') actions.push('use-parakeet');
        actions.push('validate', 'repair', 'remove');
      } else if (state === 'repair-required') {
        actions.push('repair', 'remove');
      } else if (state === 'unknown') {
        actions.push('recheck');
      }
      if (currentEngine === 'parakeet' && state !== 'removing' && !actions.includes('use-whisper')) {
        actions.push('use-whisper');
      }

      const downloadedBytes = Number(progress && progress.downloadedBytes);
      const totalBytes = Number(progress && progress.totalBytes);
      const hasDownloadProgress = state === 'downloading'
        && Number.isFinite(downloadedBytes)
        && Number.isFinite(totalBytes)
        && totalBytes > 0;
      const progressPercent = hasDownloadProgress
        ? Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)))
        : null;
      let progressText = statusTexts[state] || 'Could not check Parakeet. Recheck its status.';
      if (hasDownloadProgress) {
        progressText = `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)} downloaded`;
      }
      const activeUnavailable = currentEngine === 'parakeet'
        && state !== 'ready'
        && state !== 'checking';

      return {
        state,
        statusLabel: labels[state] || 'Unavailable',
        statusText: error && state === 'unknown'
          ? String(error.message || error)
          : (statusTexts[state] || 'Could not check Parakeet. Recheck its status.'),
        progressText,
        progressPercent,
        downloadBytes: Number.isFinite(Number(sourceStatus.downloadBytes))
          ? Number(sourceStatus.downloadBytes)
          : null,
        activeEngine: currentEngine,
        activeUnavailable,
        actions,
      };
    }

    function formatBytesFallback(value) {
      const bytes = Math.max(0, Number(value) || 0);
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    return {
      ENGINE_NAMES,
      normalizeTranscriptionEnginePreferences,
      updateTranscriptionEnginePreferences,
      snapshotTranscriptionSelection,
      buildOrdinaryRetryOptions,
      buildWhisperRetryOptions,
      buildSetupCancellationOptions,
      buildParakeetSettingsView,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
