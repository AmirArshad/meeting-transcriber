(function attachRecoveryUiHelpers(root) {
  const FINISHING_RECORDING_LABEL = 'Finishing recording...';
  const RECOVERING_BANNER_LABEL = 'Recovering interrupted recording…';

  function formatApproxDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    const totalMinutes = Math.max(1, Math.round(seconds / 60));
    if (totalMinutes < 60) {
      return `about ${totalMinutes} min`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (minutes === 0) {
      return `about ${hours} h`;
    }
    return `about ${hours} h ${minutes} min`;
  }

  function formatStartedAt(iso) {
    if (!iso || typeof iso !== 'string') {
      return null;
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    try {
      return date.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_) {
      return iso;
    }
  }

  function formatBytesSafe(formatBytes, bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return null;
    }
    if (typeof formatBytes === 'function') {
      return formatBytes(bytes);
    }
    return `${Math.round(bytes)} B`;
  }

  function buildCandidateDetailLine(candidate, formatBytes) {
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }
    const parts = [];
    const started = formatStartedAt(candidate.startedAtIso);
    if (started) {
      parts.push(`Started ${started}`);
    }
    const duration = formatApproxDuration(candidate.approxDurationSeconds);
    if (duration) {
      parts.push(duration);
    }
    const size = formatBytesSafe(formatBytes, candidate.approxBytes);
    if (size) {
      parts.push(size);
    }
    if (parts.length === 0) {
      return null;
    }
    return parts.join(' — ');
  }

  /**
   * Pure view model for the once-per-launch recovery prompt.
   * @returns {{ visible: boolean, title: string|null, body: string|null, detail: string|null, candidateLines: string[], footer: string|null, primaryLabel: string|null, secondaryLabel: string|null }}
   */
  function getRecoveryPromptView(recoveryState, formatBytes) {
    const hidden = {
      visible: false,
      title: null,
      body: null,
      detail: null,
      candidateLines: [],
      footer: null,
      primaryLabel: null,
      secondaryLabel: null,
    };

    if (!recoveryState || recoveryState.status !== 'available' || !recoveryState.promptEligible) {
      return hidden;
    }

    const count = Number(recoveryState.totals?.count) || 0;
    if (count <= 0) {
      return hidden;
    }

    const sizeText = formatBytesSafe(formatBytes, recoveryState.totals?.approxBytes);
    const body = count === 1
      ? 'AvaNevis closed before it finished saving a recording. The audio is safe on this computer and can still be turned into a meeting.'
      : `AvaNevis closed before it finished saving ${count} recordings. The audio is safe on this computer and can still be turned into meetings.`;

    let detail = `Interrupted recordings: ${count}`;
    if (sizeText) {
      detail += ` — about ${sizeText} on disk`;
    }

    const candidateLines = (recoveryState.candidates || [])
      .map((candidate) => buildCandidateDetailLine(candidate, formatBytes))
      .filter(Boolean);

    return {
      visible: true,
      title: 'Finish an interrupted recording?',
      body,
      detail,
      candidateLines,
      footer: 'Recovery runs entirely on this computer. "Later" keeps the files safe and asks again next time.',
      primaryLabel: 'Recover Now',
      secondaryLabel: 'Later',
    };
  }

  /**
   * Pure view model for the persistent recovery banner (never the live-capture pill).
   * @returns {{ visible: boolean, text: string|null, showSpinner: boolean, primaryAction: string|null, secondaryAction: string|null, modifier: string|null }}
   */
  function getRecoveryBannerView(recoveryState, captureState, formatBytes) {
    const hidden = {
      visible: false,
      text: null,
      showSpinner: false,
      primaryAction: null,
      secondaryAction: null,
      modifier: null,
    };

    const CAPTURE_BUSY_STATES = new Set(['starting', 'recording', 'stopping']);
    const capture = captureState && typeof captureState === 'object'
      ? captureState.state
      : captureState;
    if (CAPTURE_BUSY_STATES.has(capture)) {
      return hidden;
    }

    if (!recoveryState || !recoveryState.status) {
      return hidden;
    }

    const status = recoveryState.status;
    if (status === 'idle' || status === 'discovering') {
      return hidden;
    }

    const count = Number(recoveryState.totals?.count) || 0;
    const sizeText = formatBytesSafe(formatBytes, recoveryState.totals?.approxBytes);

    if (status === 'available') {
      if (recoveryState.scanImportPending && count > 0) {
        const noun = count === 1 ? 'recovered recording' : 'recovered recordings';
        return {
          visible: true,
          text: `${count} ${noun} still need to be added to History`,
          showSpinner: false,
          primaryAction: 'Recover',
          secondaryAction: null,
          modifier: 'available',
        };
      }
      if (count <= 0) {
        return hidden;
      }
      const noun = count === 1 ? 'interrupted recording' : 'interrupted recordings';
      let text = `${count} ${noun}`;
      if (sizeText) {
        text += ` — about ${sizeText} on disk`;
      }
      return {
        visible: true,
        text,
        showSpinner: false,
        primaryAction: 'Recover',
        secondaryAction: null,
        modifier: 'available',
      };
    }

    if (status === 'recovering') {
      const total = Math.max(count, 1);
      const index = Number.isInteger(recoveryState.activeCandidateIndex)
        ? recoveryState.activeCandidateIndex + 1
        : 1;
      let text = `${RECOVERING_BANNER_LABEL} (${index} of ${total})`;
      if (recoveryState.progressMessage) {
        text += ` — ${recoveryState.progressMessage}`;
      }
      return {
        visible: true,
        text,
        showSpinner: true,
        primaryAction: null,
        secondaryAction: null,
        modifier: 'recovering',
      };
    }

    if (status === 'error') {
      const failedEntries = Array.isArray(recoveryState.failed) ? recoveryState.failed : [];
      const failedCount = failedEntries.filter((entry) => Number.isInteger(entry?.candidateIndex)).length;
      const scanImportOnly = recoveryState.scanImportPending
        && failedCount === 0
        && failedEntries.some((entry) => entry?.code === 'SCAN_IMPORT_FAILED');
      if (scanImportOnly) {
        return {
          visible: true,
          text: 'Recovered audio still needs to be added to History.',
          showSpinner: false,
          primaryAction: 'Retry',
          secondaryAction: 'Dismiss',
          modifier: 'error',
        };
      }
      const discoveryFailed = failedEntries.some((entry) => entry?.code === 'DISCOVERY_FAILED');
      if (discoveryFailed && failedCount === 0) {
        return {
          visible: true,
          text: "Couldn't check for interrupted recordings. Your audio files were kept safe.",
          showSpinner: false,
          primaryAction: 'Retry',
          secondaryAction: 'Dismiss',
          modifier: 'error',
        };
      }
      const batchSize = Number(recoveryState.lastBatchSize) > 0
        ? Number(recoveryState.lastBatchSize)
        : Math.max(count, failedCount);
      const finished = Number.isFinite(recoveryState.lastSuccessCount)
        ? Math.max(0, Number(recoveryState.lastSuccessCount))
        : Math.max(0, batchSize - failedCount);
      let text;
      if (failedCount > 0 && finished > 0) {
        text = `${finished} of ${batchSize} recordings was finished. ${failedCount} still needs another try. Your audio files were kept safe.`;
      } else if (failedCount > 1 || count > 1) {
        text = `${failedCount || count} recordings still need another try. Your audio files were kept safe.`;
      } else {
        text = "Couldn't finish recovering — your audio files were kept safe.";
      }
      return {
        visible: true,
        text,
        showSpinner: false,
        primaryAction: 'Retry',
        secondaryAction: 'Dismiss',
        modifier: 'error',
      };
    }

    return hidden;
  }

  /**
   * Preserve a once-claimed prompt across queued recovery-state refreshes.
   */
  function mergeClaimedPromptIntoState(state, claimedPrompt) {
    if (!state || typeof state !== 'object') {
      return state;
    }
    if (claimedPrompt && state.status === 'available') {
      return { ...state, promptEligible: true };
    }
    return state;
  }

  /**
   * Pure focus-trap decision for the recovery modal.
   * @returns {{ preventDefault: boolean, focusIndex: number|null }}
   */
  function resolveRecoveryFocusTrapAction(focusableCount, activeIndex, shiftKey) {
    const count = Number(focusableCount) || 0;
    if (count <= 0) {
      return { preventDefault: true, focusIndex: null };
    }
    const index = Number.isInteger(activeIndex) ? activeIndex : -1;
    if (shiftKey) {
      if (index <= 0) {
        return { preventDefault: true, focusIndex: count - 1 };
      }
      return { preventDefault: false, focusIndex: null };
    }
    if (index < 0 || index >= count - 1) {
      return { preventDefault: true, focusIndex: 0 };
    }
    return { preventDefault: false, focusIndex: null };
  }

  const helpers = {
    FINISHING_RECORDING_LABEL,
    RECOVERING_BANNER_LABEL,
    getRecoveryPromptView,
    getRecoveryBannerView,
    mergeClaimedPromptIntoState,
    resolveRecoveryFocusTrapAction,
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }

  root.recoveryUiHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
