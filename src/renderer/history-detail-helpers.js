(function initHistoryDetailHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.historyDetailHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildHistoryDetailHelpers() {
  const HISTORY_DETAIL_TABS = new Set(['transcript', 'summary']);
  const TRANSCRIPT_TIMESTAMP_LINE_RE = /^(?:\*\*)?\[(\d{1,2}:\d{2}(?::\d{2})?)\s+-\s+(\d{1,2}:\d{2}(?::\d{2})?)\](?:\*\*)?\s*(.*)$/;
  const SPEAKER_PREFIX_RE = /^(Speaker\s+\d+|Unknown):\s*(.*)$/i;

  function normalizeHistoryDetailTab(tab) {
    const normalized = String(tab || '').trim();
    return HISTORY_DETAIL_TABS.has(normalized) ? normalized : 'transcript';
  }

  function cleanMarkdownText(value) {
    return String(value || '')
      .trim()
      .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeSpeakerLabel(label) {
    const cleaned = cleanMarkdownText(label);
    const speakerMatch = /^speaker\s+(\d+)$/i.exec(cleaned);
    if (speakerMatch) {
      return `Speaker ${speakerMatch[1]}`;
    }
    return /^unknown$/i.test(cleaned) ? 'Unknown' : cleaned;
  }

  function splitSpeakerPrefix(value) {
    const cleaned = cleanMarkdownText(value);
    const match = SPEAKER_PREFIX_RE.exec(cleaned);
    if (!match) {
      return { speaker: '', text: cleaned };
    }

    return {
      speaker: normalizeSpeakerLabel(match[1]),
      text: cleanMarkdownText(match[2]),
    };
  }

  function isMarkdownBoundaryLine(line) {
    const trimmed = String(line || '').trim();
    return TRANSCRIPT_TIMESTAMP_LINE_RE.test(trimmed)
      || /^(#{1,6})\s+/.test(trimmed)
      || trimmed === '---'
      || trimmed === '***'
      || trimmed === '___';
  }

  function parseTranscriptMarkdownSegments(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const segments = [];

    for (let index = 0; index < lines.length; index++) {
      const timestampMatch = TRANSCRIPT_TIMESTAMP_LINE_RE.exec(lines[index].trim());
      if (!timestampMatch) {
        continue;
      }

      const [, start, end, tail] = timestampMatch;
      const textParts = [];
      let speaker = '';

      const inline = splitSpeakerPrefix(tail);
      if (inline.speaker) {
        speaker = inline.speaker;
      }
      if (inline.text) {
        textParts.push(inline.text);
      }

      let cursor = index + 1;
      while (cursor < lines.length) {
        const rawLine = lines[cursor];
        const trimmed = rawLine.trim();
        if (TRANSCRIPT_TIMESTAMP_LINE_RE.test(trimmed)) {
          break;
        }
        if (trimmed && isMarkdownBoundaryLine(trimmed)) {
          break;
        }
        if (trimmed) {
          const line = splitSpeakerPrefix(trimmed);
          if (!speaker && line.speaker) {
            speaker = line.speaker;
          }
          if (line.text) {
            textParts.push(line.text);
          }
        }
        cursor += 1;
      }

      segments.push({
        start,
        end,
        speaker,
        text: textParts.join(' ').trim(),
      });
      index = cursor - 1;
    }

    return segments.filter((segment) => segment.text || segment.speaker);
  }

  function featureValidationMessage(feature) {
    return feature && feature.lastValidation && feature.lastValidation.message;
  }

  function featureReason(feature) {
    if (!feature) {
      return '';
    }
    return feature.error
      || featureValidationMessage(feature)
      || (feature.cache && feature.cache.reason)
      || (feature.runtimeCache && feature.runtimeCache.reason)
      || (feature.availability && feature.availability.reason)
      || '';
  }

  function isSpeakrsPackagedCliMissingMessage(value) {
    const text = String(value || '');
    return /incomplete/i.test(text) && /Reinstall AvaNevis/.test(text);
  }

  function getDiarizationErrorRecoveryHint(reason) {
    if (isSpeakrsPackagedCliMissingMessage(reason)) {
      return '';
    }
    const text = String(reason || '').toLowerCase();
    if (/\b(?:token|model terms|unauthorized|forbidden|gated|authenticated|authentication|permission)\b/.test(text)
      || /\b(?:model|repository) access\b/.test(text)
      || /\baccess (?:denied|token|to (?:the )?(?:model|repository))\b/.test(text)) {
      return 'Check your Hugging Face token and accepted pyannote model terms, then validate again.';
    }
    if (/dependency|runtime|pyannote\.audio|torch|torchvision|torchaudio|module|import|installed/.test(text)) {
      return 'Remove and reinstall speaker identification setup, then validate again.';
    }
    return 'Validate again or remove and reinstall speaker identification setup.';
  }

  function getDiarizationSetupMessage(feature) {
    const status = feature && feature.status;
    const reason = featureReason(feature);
    if (isSpeakrsPackagedCliMissingMessage(reason) || (feature && feature.engine === 'speakrs' && feature.cliPresent === false && isSpeakrsPackagedCliMissingMessage(feature.cliMissingMessage))) {
      return reason || feature.cliMissingMessage;
    }
    if (status === 'ready' && feature && feature.setupComplete) {
      return 'Speaker labels will run automatically after transcription.';
    }
    if (status === 'unsupported') {
      return reason || 'Speaker identification is not supported on this platform.';
    }
    if (status === 'needsAccount') {
      return 'Use your own Hugging Face token and accept the pyannote model terms before enabling local speaker labels.';
    }
    if (status === 'validating') {
      return 'Validating local speaker identification setup.';
    }
    if (status === 'error') {
      const hint = getDiarizationErrorRecoveryHint(reason);
      return `${reason || 'Speaker identification setup failed.'}${hint ? ` ${hint}` : ''}`;
    }
    return reason || 'Speaker identification setup is available only on supported platforms.';
  }

  function getSummarySetupMessage(feature) {
    if (!feature) {
      return 'Summary setup status is unavailable. Open Settings to validate the local summary model.';
    }

    const status = feature && feature.status;
    const reason = featureReason(feature);
    if (status === 'ready' && feature && feature.setupComplete) {
      return 'Generate summaries from a saved transcript when you choose.';
    }
    if (status === 'unsupported') {
      return reason || 'Local summaries are not supported on this platform.';
    }
    if (status === 'downloading') {
      return 'The local summary model is still downloading. Wait for setup to finish before generating a summary.';
    }
    if (status === 'validating') {
      return reason || 'The local summary model is being validated. Try again after validation finishes.';
    }
    if (status === 'error') {
      return `${reason || 'Summary model setup failed.'} Try Install Model again, Validate, or Remove and reinstall the local model.`;
    }
    if (status === 'ready') {
      return reason || 'Summary setup is incomplete. Validate the local model and llama.cpp runtime in Settings.';
    }
    return reason || 'Install the local summary model in Settings before generating summaries.';
  }

  function hasPositiveSize(value) {
    return Number(value) > 0;
  }

  function hasDiarizationLocalState(feature) {
    if (!feature) {
      return false;
    }
    return Boolean(
      feature.setupComplete
      || feature.status === 'ready'
      || feature.status === 'downloading'
      || feature.status === 'validating'
      || (feature.tokenStatus && feature.tokenStatus.hasToken)
      || (feature.dependencyCache && feature.dependencyCache.installed)
      || (feature.dependencyCache && feature.dependencyCache.partial)
      || (feature.packCache && (feature.packCache.installed || feature.packCache.partial))
      || (feature.runtimeCache && (feature.runtimeCache.installed || feature.runtimeCache.partial))
      || (feature.storage && hasPositiveSize(feature.storage.dependencyBytes))
      || (feature.storage && hasPositiveSize(feature.storage.installedBytes))
    );
  }

  function hasSummaryLocalState(feature) {
    if (!feature) {
      return false;
    }
    return Boolean(
      feature.setupComplete
      || feature.status === 'ready'
      || feature.status === 'downloading'
      || feature.status === 'validating'
      || (feature.cache && feature.cache.installed)
      || (feature.cache && feature.cache.partial)
      || (feature.runtimeCache && feature.runtimeCache.installed)
      || (feature.runtimeCache && feature.runtimeCache.partial)
      || (feature.storage && hasPositiveSize(feature.storage.modelBytes))
      || (feature.storage && hasPositiveSize(feature.storage.runtimeBytes))
      || (feature.storage && hasPositiveSize(feature.storage.installedBytes))
    );
  }

  function buildAiAddonControlState({ feature, type, setupActive = false, unsupported = false, selectedEngine } = {}) {
    const hasLocalState = type === 'summary'
      ? hasSummaryLocalState(feature)
      : hasDiarizationLocalState(feature);
    const isBusy = Boolean(setupActive || (feature && (feature.status === 'downloading' || feature.status === 'validating')));
    const isUnsupported = Boolean(unsupported || (feature && feature.status === 'unsupported'));
    const activeEngine = feature && typeof feature.engine === 'string' ? feature.engine : null;
    const effectiveEngine = selectedEngine || activeEngine;
    const packagedCliUnrepairable = type !== 'summary'
      && effectiveEngine === 'speakrs'
      && feature
      && feature.cliPresent === false
      && isSpeakrsPackagedCliMissingMessage(feature.cliMissingMessage || feature.error);
    const selectedIsReady = Boolean(
      feature
      && (feature.setupComplete || feature.status === 'ready')
      && (!selectedEngine || selectedEngine === activeEngine),
    );

    return {
      canConfigure: !isUnsupported && !isBusy && !selectedIsReady && !packagedCliUnrepairable,
      canValidate: !isUnsupported && !isBusy && hasLocalState,
      canRemove: !isUnsupported && !isBusy && hasLocalState,
      canSelectEngine: !isUnsupported && !isBusy,
      hasLocalState,
      isBusy,
      isUnsupported,
    };
  }

  function getSummaryActionControlState(feature) {
    if (feature && feature.status === 'unsupported') {
      return {
        enabled: false,
        title: getSummarySetupMessage(feature),
      };
    }
    return {
      enabled: true,
      title: '',
    };
  }

  function getSummaryGenerationButtonView({ active = false, cancelling = false } = {}) {
    if (!active) {
      return {
        active: false,
        label: null,
        hoverLabel: null,
        title: null,
        ariaBusy: false,
      };
    }

    return {
      active: true,
      label: cancelling ? 'Cancelling...' : 'Summarising...',
      hoverLabel: cancelling ? 'Cancelling...' : 'Cancel Summarisation',
      title: cancelling ? 'Cancelling summary generation...' : 'Click to cancel summary generation',
      ariaBusy: true,
    };
  }

  function shouldShowSpeakerSetupPrompt({ diarization, platform, cudaInstalled, hasNvidiaGpu }) {
    if (!diarization || diarization.status === 'ready' || diarization.setupComplete) {
      return false;
    }
    if (!diarization.availability || diarization.availability.supported !== true) {
      return false;
    }
    if (platform === 'win32' && (!hasNvidiaGpu || !cudaInstalled)) {
      return false;
    }
    return diarization.status === 'notConfigured' || diarization.status === 'needsAccount' || diarization.status === 'error';
  }

  function shouldShowSummarySetupPrompt(summary) {
    if (!summary || summary.status === 'ready' || summary.setupComplete) {
      return false;
    }
    if (!summary.availability || summary.availability.supported !== true) {
      return false;
    }
    return summary.status === 'notConfigured' || summary.status === 'error';
  }

  function buildHomeAiAddonPrompt({ aiStatus, platform, cudaInstalled = false, hasNvidiaGpu = false } = {}) {
    const diarization = aiStatus && aiStatus.features && aiStatus.features.diarization;
    const summary = aiStatus && aiStatus.features && aiStatus.features.summary;

    if (shouldShowSpeakerSetupPrompt({ diarization, platform, cudaInstalled, hasNvidiaGpu })) {
      const engine = diarization && diarization.engine === 'pyannote' ? 'pyannote' : 'speakrs';
      const missingCliMessage = diarization
        && engine === 'speakrs'
        && diarization.cliPresent === false
        && (diarization.cliMissingMessage || diarization.error);
      return {
        feature: 'diarization',
        engine,
        title: 'Add speaker labels to future transcripts',
        message: missingCliMessage
          || 'Set up local speaker identification in Settings. Once ready, it will run automatically after transcription.',
      };
    }

    if (shouldShowSummarySetupPrompt(summary)) {
      return {
        feature: 'summary',
        title: 'Generate local meeting summaries',
        message: 'Set up the local summary model to create decisions, action items, risks, and open questions on demand.',
      };
    }

    return null;
  }

  function isUnownedDocumentFocus(activeElement, doc = null) {
    if (!activeElement) {
      return true;
    }
    if (!doc) {
      return false;
    }
    return activeElement === doc.body || activeElement === doc.documentElement;
  }

  /**
   * Windows Chromium/Electron often moves keyboard focus to <body> when a
   * sibling tree is rebuilt (History transcript hydrate, Activity queue ticks).
   * Restore only when the editor is open and focus was lost, not when another
   * control (search, a different input) is genuinely focused.
   */
  function shouldRestoreInlineEditorFocus({
    editorOpen = false,
    activeElement = null,
    isEditorControl = false,
    doc = null,
  } = {}) {
    if (!editorOpen) {
      return false;
    }
    if (isEditorControl) {
      return true;
    }
    return isUnownedDocumentFocus(activeElement, doc);
  }

  function shouldSkipMeetingReselect({
    currentMeetingId = null,
    nextMeetingId = null,
    titleEditorOpen = false,
  } = {}) {
    if (!titleEditorOpen) {
      return false;
    }
    const current = String(currentMeetingId == null ? '' : currentMeetingId).trim();
    const next = String(nextMeetingId == null ? '' : nextMeetingId).trim();
    return Boolean(current) && current === next;
  }

  return {
    buildAiAddonControlState,
    buildHomeAiAddonPrompt,
    cleanMarkdownText,
    hasDiarizationLocalState,
    getDiarizationSetupMessage,
    getSummaryActionControlState,
    getSummaryGenerationButtonView,
    getSummarySetupMessage,
    isUnownedDocumentFocus,
    normalizeHistoryDetailTab,
    parseTranscriptMarkdownSegments,
    shouldRestoreInlineEditorFocus,
    shouldSkipMeetingReselect,
    shouldShowSpeakerSetupPrompt,
    shouldShowSummarySetupPrompt,
  };
}));
