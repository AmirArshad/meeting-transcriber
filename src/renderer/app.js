/**
 * Renderer process - UI logic for AvaNevis (Redesigned)
 */

const COPY_SUCCESS_TIMEOUT_MS = 2000;
const DEFAULT_SUMMARY_PROFILE = 'balanced';
const MAX_PROGRESS_LOG_ENTRIES = 250;
const AI_ADDON_PROGRESS_LOG_INTERVAL_MS = 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const {
  normalizeCaptureMode,
  getCaptureModeSources,
  getRecordingSourceStatusText,
  resolveRecordModeMenuKeyAction,
  getRecordButtonAction,
  getRecordingPresenceView,
  shouldShowDiscardRecordingControl,
  isStartRecordingResultDiscarded,
  shouldIssueCompensatingCancelAfterStart,
  resolveCompensatingCancelOutcome,
  shouldAbortStartAfterCountdown,
  isRecordingStopInProgressError,
  isRecordingCancelFinalizedError,
  canHydratedRendererStopRecording,
} = window.recordingStateHelpers;
const {
  getIdleStatusPillText,
  getRecordButtonLabel,
  buildResumePendingBannerView,
  countResumablePendingMeetings,
  buildActivityRows,
  getActivityEmptyStateText,
  getActivityChipLabel,
  shouldApplyTranscriptionQueueState,
  buildCompletionToastView,
  buildBackgroundTranscriptionTipView,
  buildSoftQueueDepthWarningView,
  resolveActivityRenameCommit,
} = window.transcriptionActivityHelpers;
const {
  normalizeTranscriptionEnginePreferences,
  updateTranscriptionEnginePreferences,
  snapshotTranscriptionSelection: snapshotEngineSelection,
  buildOrdinaryRetryOptions,
  buildWhisperRetryOptions,
  buildSetupCancellationOptions,
  buildParakeetSettingsView,
} = window.transcriptionEngineHelpers;
const {
  getRecoveryPromptView,
  getRecoveryBannerView,
  mergeClaimedPromptIntoState,
  shouldRequeryRecoveryAfterCaptureIdle,
  resolveRecoveryFocusTrapAction,
} = window.recoveryUiHelpers;
const {
  buildAiAddonControlState,
  buildHomeAiAddonPrompt,
  canRunAiAddonControlAction,
  getDiarizationSetupMessage,
  hasDiarizationLocalState,
  getSummaryActionControlState,
  getSummaryGenerationButtonView,
  getSummarySetupMessage,
  getUnsupportedAiAddonFootprintRows,
  normalizeHistoryDetailTab,
  parseTranscriptMarkdownSegments,
  shouldRestoreInlineEditorFocus,
  shouldSkipMeetingReselect,
} = window.historyDetailHelpers;
const {
  isCanonicalSpeakerKey,
  extractSpeakerSamples,
  hasUnnamedSpeakers,
  normalizeSpeakerName,
  diffSpeakerNames,
} = window.speakerLabelHelpers;
const {
  buildHighlightSegmentsFromParts,
  fallbackFilterMeetingsByTitle,
  findClosestTranscriptSegmentIndex,
  formatJumpTimestamp,
  mergeSearchResultsWithMeetings,
  normalizeHistorySearchQuery,
  parseTimestampStringToSeconds,
} = window.historySearchHelpers;
const {
  RECORDING_TAGS,
  normalizeTag,
  getTagMeta,
  getUsedRecordingTags,
  filterMeetingsByTag,
  getSummaryTagMismatch,
} = window.tagHelpers;
const {
  buildUpdateViewModel,
  renderSafeReleaseNotes,
  shouldAcceptUpdateState,
  shouldAutoSurfaceUpdatePopover,
} = window.updateNotificationHelpers;
const {
  formatAiAddonProgressText,
  formatBytes,
  formatDate,
  formatElapsedDuration,
  formatRelativeDate,
  formatStatusLabel,
  formatTimestamp,
} = window.formatters;
const {
  getMeetingTranscriptionStatusMessage,
  isMeetingTranscriptionRetryable,
  shouldAbortSummaryGenerationAfterPreflight,
  shouldPromptSpeakerNamesBeforeSummary,
  haveSummarySpeakerNamesChanged,
} = window.summaryUiHelpers;
const {
  applyDiarizationEngineCardDomState,
  buildDiarizationEngineCards,
  coerceDiarizationEngineForPlatform,
  getAiAddonRemoveButtonLabel,
  getAiAddonValidateButtonLabel,
  getDiarizationRemoveConfirmMessage,
  getDiarizationSetupButtonLabel,
  getDiarizationSwitchConfirmMessage,
  getDiarizationTokenInputPlaceholder,
  getSummarySetupButtonLabel,
  isAiAddonProgressPhase,
  isAiAddonSetupLockingControls,
  isAiAddonTerminalStatus,
  readDiarizationSetupToken,
  resolveDiarizationSetupSource,
  resolveSelectedDiarizationEngine,
  shouldClearDiarizationTokenFields,
  shouldConfirmDiarizationEngineSwitch,
  shouldOfferDiarizationSetupFields,
  shouldUseStaticSpeakrsEngineText,
} = window.aiAddonUiHelpers;
const { clearElement } = window.domHelpers;
const { meetingIdsEqual } = window.meetingHelpers;
const { isGpuRuntimeActionBusyError, formatGpuRuntimeBusyAlertMessage, getUnsupportedGpuSettingsCopy, isCudaRuntimeSettingsSurface, getLinuxCudaSettingsDescription, getLinuxCudaBrokenRuntimeCopy, getLinuxCudaUninstallConfirmSuffix, shouldShowGpuUninstallButton, shouldShowGpuInstallOrRepairButton, shouldUseGpuRepairButton, shouldShowGpuHomeCta, shouldShowCudaRuntimeWarning } = window.gpuSettingsHelpers;
const {
  inferRendererHostFamily,
  getEmptyMicrophoneDeviceGuidance,
  getRecordingPermissionFailureGuidance,
  toOpaqueDeviceId,
  decorateDesktopDevices,
  isDesktopCaptureDisabledSelection,
  resolveInitialDeviceSelection,
} = window.platformSelectionHelpers;
const { writeSignalTrace } = window.canvasHelpers;
const {
  getKeyboardShortcutAria,
  getKeyboardShortcutDisplay,
  resolveKeyboardShortcutAction,
  shouldSuppressKeyboardShortcut,
} = window.keyboardShortcutHelpers;
const {
  buildExportFormatOptions,
} = window.subtitleExportHelpers;
const {
  renderGroundedMarkdown,
} = window.markdownRenderHelpers;
const {
  buildAssistantNoticeView,
  buildModelMemoryPillView,
  buildStarterPrompts,
  filterChatThreads,
  formatChatScopeLabel,
  groupThreadsByRecency,
  resolveNoticeActionScope,
  shouldShowChatProgressBanner,
} = window.chatHelpers;

// UI Elements
const micSelect = document.getElementById('mic-select');
const desktopSelect = document.getElementById('desktop-select');
const languageSelect = document.getElementById('language-select');
const modelSelect = document.getElementById('model-select');
const whisperLanguageSetup = document.getElementById('whisper-language-setup');
const whisperModelSetup = document.getElementById('whisper-model-setup');
const transcriptionEngineStatic = document.getElementById('transcription-engine-static');
const refreshBtn = document.getElementById('refresh-devices');
const recordBtn = document.getElementById('record-btn');
const recordModeToggle = document.getElementById('record-mode-toggle');
const recordModeMenu = document.getElementById('record-mode-menu');
/**
 * Capture mode of the current/most recent start attempt. Drives source-accurate
 * status copy and visualizer tracks. Always an explicit closed value.
 */
let activeCaptureMode = 'mic-and-desktop';
const discardRecordingBtn = document.getElementById('discard-recording-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const timer = document.getElementById('timer');
const recordingPresenceEl = document.getElementById('recording-presence');
const recordingPresenceLabel = document.getElementById('recording-presence-label');
const recordingPresenceTime = document.getElementById('recording-presence-time');
const recoveryBannerEl = document.getElementById('recording-recovery-banner');
const recoveryBannerText = document.getElementById('recording-recovery-banner-text');
const recoveryBannerSpinner = document.getElementById('recording-recovery-banner-spinner');
const recoveryBannerPrimary = document.getElementById('recording-recovery-banner-primary');
const recoveryBannerSecondary = document.getElementById('recording-recovery-banner-secondary');
const recoveryModalEl = document.getElementById('recording-recovery-modal');
const recoveryModalTitle = document.getElementById('recording-recovery-title');
const recoveryModalBody = document.getElementById('recording-recovery-body');
const recoveryModalDetail = document.getElementById('recording-recovery-detail');
const recoveryModalCandidateList = document.getElementById('recording-recovery-candidate-list');
const recoveryModalFooter = document.getElementById('recording-recovery-footer');
const recoveryModalNowBtn = document.getElementById('recording-recovery-now-btn');
const recoveryModalLaterBtn = document.getElementById('recording-recovery-later-btn');
const progressLog = document.getElementById('progress-log');
const activityListEl = document.getElementById('activity-list');
const resumePendingBannerEl = document.getElementById('resume-pending-banner');
const resumePendingBannerText = document.getElementById('resume-pending-banner-text');
const resumePendingBtn = document.getElementById('resume-pending-btn');
const meetingList = document.getElementById('meeting-list');
const meetingDetails = document.getElementById('meeting-details');
const refreshHistory = document.getElementById('refresh-history');
const deleteMeeting = document.getElementById('delete-meeting');

// State
let recordingState = 'idle'; // idle, starting, recording, stopping, cancelling, countdown (transcribing no longer blocks capture)
let lastStopProgressMessage = '';
let transcriptionQueueState = { jobs: [], activeMeetingId: null, busyCount: 0, seq: 0 };
/** Last applied queue-state seq; ignore stale init snapshots / out-of-order pushes. */
let lastAppliedTranscriptionQueueSeq = 0;
/** meetingId → last-seen terminal status; used to reload History only on new transitions. */
let lastSeenTerminalTranscriptionStatuses = new Map();
let activityActionBusyMeetingId = null;
/** Activity-row inline rename (Electron does not support window.prompt). */
let activityRenameMeetingId = null;
let activityRenameDraft = '';
let activityRenameOriginal = '';
let countdownValue = 3;
let recordingStartTime = null;
let activeRecordingSessionId = null;
/** Capture-time engine/language/model. Stop and finalize use this, not live Settings. */
let activeRecordingTranscriptionSelection = null;
let transcriptionEnginePreferences = {
  schemaVersion: 1,
  activeEngine: 'whisper',
  whisper: { language: 'en', modelSize: 'small' },
};
let parakeetEngineStatus = null;
let parakeetEngineOperation = null;
let parakeetSetupProgress = null;
let parakeetSetupOperationId = null;
let parakeetSetupCancelRequested = false;
let parakeetSetupCancelSent = false;
let parakeetEngineOperationError = '';
let parakeetEngineSettingsBusy = false;
let transcriptionEngineSettingsListenersBound = false;
let whisperRetryMeetingId = null;
let whisperRetryBusy = false;
let activeCountdownCancel = null;
/** Bumped to invalidate an in-flight startRecording() when Discard wins during starting/countdown. */
let startRecordingEpoch = 0;
/** Set when the user confirms Discard during starting/countdown/preflight. */
let discardRequestedForStart = false;
let timerInterval = null;
let recordingPresencePollTimer = null;
let frozenPresenceElapsedText = null;
let recoveryState = {
  status: 'idle',
  candidates: [],
  totals: { count: 0, approxBytes: 0 },
  activeCandidateIndex: null,
  failed: [],
  promptEligible: false,
};
let recoveryQueryPromise = null;
let recoveryQueryNeedsRefresh = false;
let recoveryPromptQueued = false;
let recoveryPromptOpen = false;
let recoveryPromptClaimHeld = false;
let recoveryFocusRestoreEl = null;
let recoveryActionBusy = false;
let currentAudioFile = null;
let currentRecordingDurationSeconds = 0;
let currentMeetingId = null;
let historySpeakers = null;
let stopSpeakerPreview = null;
// Tracks the meeting saved from the most recent recording (post-transcription).
// Powers the in-place rename on the post-recording transcript card and the
// default filename used by the "Save" button.
let currentRecordingMeeting = null;
let currentRecordingTranscriptMarkdown = '';
let meetingDetailRequestEpoch = 0;
let summaryGenerationMeetingId = null;
let summaryGenerationCancelling = false;
let historyLanguageCaptionMeeting = null;
let activeHistoryDetailTab = 'transcript';
let homePromptContext = { platform: null, arch: null, hasNvidiaGpu: false, cudaInstalled: false };
let selectedDiarizationEngine = null;
let startupCudaCheckPromise = null;
let meetings = [];
let meetingHistoryRequestEpoch = 0;
let audioVisualizer = null;
let isFirstRecording = true; // Track if this is first recording (for longer timeout)
let isInitializing = true; // Track if app is still initializing
let recordingHydrated = false; // Authoritative main capture state loaded; gates Start/Stop
let recordingHydrationFailed = false; // Prior capture probe failed; next success logs recovery
let hydratedCaptureState = false; // ensureRecordingHydration ran to completion; false allows retry
let rendererQuitCommitted = false; // Set on app-quit-progress; rejects new Start/Stop
const checkedMeetingIds = new Set();
let meetingSearchQuery = '';
let meetingSearchQueryNormalized = '';
let meetingSearchDebounceTimer = null;
let meetingSearchResults = null;
let meetingSearchEpoch = 0;
let activeHistoryTagFilter = null;
let selectedRecordingTag = null;
let activeRecordingTag = null;
let activeOpenTagPopover = null;
const meetingTagMutationVersions = new Map();
let pendingAudioSeekCleanup = null;
let activeCitationHighlightTimer = null;
const MEETING_SEARCH_DEBOUNCE_MS = 180;
const cleanupFns = [];
let aiAddonStatusRefreshPromise = null;
let aiAddonStatusSnapshot = null;
const aiAddonDownloadState = {
  diarization: { active: false, cancelling: false, percent: 0, message: '' },
  summary: { active: false, cancelling: false, percent: 0, message: '' },
};
const aiAddonProgressLogState = {
  diarization: { lastKey: '', lastPercent: -1, lastAt: 0 },
  summary: { lastKey: '', lastPercent: -1, lastAt: 0 },
};

function registerCleanup(cleanupFn) {
  if (typeof cleanupFn !== 'function') {
    return () => {};
  }

  let isActive = true;

  const wrappedCleanup = () => {
    if (!isActive) {
      return;
    }

    isActive = false;

    const index = cleanupFns.indexOf(wrappedCleanup);
    if (index !== -1) {
      cleanupFns.splice(index, 1);
    }

    cleanupFn();
  };

  cleanupFns.push(wrappedCleanup);
  return wrappedCleanup;
}

function runCleanup() {
  while (cleanupFns.length > 0) {
    const cleanupFn = cleanupFns.pop();
    try {
      cleanupFn();
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
  }
}

function setPlaceholder(container, message, className = 'placeholder') {
  const node = document.createElement('p');
  node.className = className;
  node.textContent = message;
  container.replaceChildren(node);
}

function showSummaryMessage(message, isError = false) {
  updateSummaryTagMismatchBanner(null);
  const summaryEl = document.getElementById('meeting-summary');
  if (!summaryEl) {
    return;
  }

  summaryEl.classList.add('is-empty');
  delete summaryEl.dataset.markdown;
  setPlaceholder(summaryEl, message, isError ? 'placeholder error' : 'placeholder');
  updateSummaryActionState();
}

function findMeetingById(meetingId) {
  if (meetingId == null) {
    return null;
  }
  const targetId = String(meetingId);
  return meetings.find((meeting) => String(meeting.id) === targetId) || null;
}

function findMeetingIndexById(meetingId) {
  if (meetingId == null) {
    return -1;
  }
  const targetId = String(meetingId);
  return meetings.findIndex((meeting) => String(meeting.id) === targetId);
}

async function restoreCurrentHistorySummary(meetingId, message, { isError = false, showTab = true } = {}) {
  if (!meetingId || !meetingIdsEqual(currentMeetingId, meetingId)) {
    return;
  }

  let fullMeeting;
  try {
    fullMeeting = await window.electronAPI.getMeeting(meetingId);
  } catch (error) {
    console.warn(`Could not restore saved summary: ${error.message}`);
  }

  if (!meetingIdsEqual(currentMeetingId, meetingId)) return;
  if (fullMeeting?.summary) {
    renderSummaryMarkdown(fullMeeting.summary, { stale: fullMeeting.summaryStale });
  } else {
    showSummaryMessage(message, isError);
  }
  updateSummaryTagMismatchBanner(fullMeeting);
  if (showTab) activateHistoryDetailTab('summary');
}

function renderSummaryMarkdown(markdown, options = {}) {
  const summaryEl = document.getElementById('meeting-summary');
  if (!summaryEl) {
    return;
  }

  summaryEl.classList.remove('is-empty');
  if (markdown && markdown.trim()) {
    summaryEl.dataset.markdown = markdown;
    renderMarkdownInto(summaryEl, markdown, { aiLinkPolicy: true });
    if (options.stale) {
      const warning = document.createElement('p');
      warning.className = 'summary-stale-warning';
      warning.textContent = 'This summary may be stale because the transcript changed after it was generated. Regenerate it for the latest transcript.';
      summaryEl.prepend(warning);
    }
    updateSummaryActionState();
    return;
  }

  delete summaryEl.dataset.markdown;
  showSummaryMessage('No summary generated yet');
}

function updateSummaryActionState() {
  const summaryEl = document.getElementById('meeting-summary');
  const hasSummary = Boolean(summaryEl && summaryEl.dataset.markdown && summaryEl.dataset.markdown.trim());

  ['copy-summary-btn', 'save-summary-btn'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) {
      button.disabled = !hasSummary;
    }
  });
}

function populateSelect(select, placeholder, devices) {
  clearElement(select);

  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = placeholder;
  select.appendChild(defaultOption);

  devices.forEach((device) => {
    const option = document.createElement('option');
    option.value = device.id;
    // Synthetic entries (the Linux "None (microphone only)" desktop option)
    // carry no sample rate and must not render "(48000 Hz)".
    option.textContent = device.sample_rate
      ? `${device.name} (${device.sample_rate} Hz)`
      : device.name;
    select.appendChild(option);
  });
}

function createSvgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);

  Object.entries(attributes).forEach(([name, value]) => {
    element.setAttribute(name, value);
  });

  return element;
}

function createDeleteIcon() {
  const svg = createSvgElement('svg', {
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });

  svg.appendChild(createSvgElement('polyline', { points: '3 6 5 6 21 6' }));
  svg.appendChild(createSvgElement('path', {
    d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  }));

  return svg;
}

function createDeleteButton() {
  const button = document.createElement('button');
  button.className = 'delete-btn-list';
  button.title = 'Delete';
  button.setAttribute('aria-label', 'Delete recording');

  button.appendChild(createDeleteIcon());

  return button;
}

function createMeetingCheckbox(meetingId) {
  const box = document.createElement('div');
  box.className = 'meeting-checkbox';
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', 'false');
  box.setAttribute('tabindex', '0');
  box.title = 'Select recording';
  box.dataset.id = meetingId;

  const svg = createSvgElement('svg', {
    width: '11',
    height: '11',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '3.2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  svg.appendChild(createSvgElement('polyline', { points: '5 12 10 17 19 7' }));
  box.appendChild(svg);

  return box;
}

// ============================================================================
// Lightweight, safe markdown renderer for transcript .md files.
// Supports: # / ## / ### headings, ---/=== horizontal rules, blockquotes,
// - / * / 1. lists, **bold**, *italic*, _italic_, `code`, [text](url),
// and paragraphs separated by blank lines. Does NOT support raw HTML.
// All output goes through textContent so injection is impossible.
// ============================================================================
function renderMarkdownInto(container, markdown, options = {}) {
  clearElement(container);
  if (!markdown || typeof markdown !== 'string') return;

  const aiLinkPolicy = options.aiLinkPolicy === true;
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  // Inline parser: returns an array of DOM nodes for a line of text.
  function renderInline(text) {
    const nodes = [];
    const len = text.length;
    let buf = '';
    const flushText = () => {
      if (buf) {
        nodes.push(document.createTextNode(buf));
        buf = '';
      }
    };

    let j = 0;
    while (j < len) {
      const ch = text[j];

      // Inline code: `...`
      if (ch === '`') {
        const end = text.indexOf('`', j + 1);
        if (end > j) {
          flushText();
          const code = document.createElement('code');
          code.textContent = text.slice(j + 1, end);
          nodes.push(code);
          j = end + 1;
          continue;
        }
      }

      // Bold: **...**
      if (ch === '*' && text[j + 1] === '*') {
        const end = text.indexOf('**', j + 2);
        if (end > j + 1) {
          flushText();
          const strong = document.createElement('strong');
          strong.append(...renderInline(text.slice(j + 2, end)));
          nodes.push(strong);
          j = end + 2;
          continue;
        }
      }

      // Italic: *...* or _..._  (must not consume bold)
      if ((ch === '*' || ch === '_') && text[j + 1] !== ch) {
        const end = text.indexOf(ch, j + 1);
        if (end > j) {
          flushText();
          const em = document.createElement('em');
          em.append(...renderInline(text.slice(j + 1, end)));
          nodes.push(em);
          j = end + 1;
          continue;
        }
      }

      // Link: [text](url)
      if (ch === '[') {
        const closeBracket = text.indexOf(']', j + 1);
        if (closeBracket > j && text[closeBracket + 1] === '(') {
          const closeParen = text.indexOf(')', closeBracket + 2);
          if (closeParen > closeBracket) {
            const linkText = text.slice(j + 1, closeBracket);
            const url = text.slice(closeBracket + 2, closeParen).trim();
            const linkAllowed = aiLinkPolicy
              ? /^(https:|mailto:)/i.test(url)
              : (/^(https?:|mailto:|#)/i.test(url) || url.startsWith('/') || url.startsWith('.'));
            if (linkAllowed) {
              flushText();
              const a = document.createElement('a');
              a.href = url;
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
              a.append(...renderInline(linkText));
              nodes.push(a);
              j = closeParen + 1;
              continue;
            }
          }
        }
      }

      buf += ch;
      j++;
    }
    flushText();
    return nodes;
  }

  function isHr(line) {
    const t = line.trim();
    return t === '---' || t === '***' || t === '___';
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line
    if (trimmed === '') { i++; continue; }

    // Headings
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(trimmed);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      const h = document.createElement('h' + level);
      h.append(...renderInline(headingMatch[2]));
      container.appendChild(h);
      i++;
      continue;
    }

    // Horizontal rule
    if (isHr(line)) {
      container.appendChild(document.createElement('hr'));
      i++;
      continue;
    }

    // Blockquote (collapse consecutive lines)
    if (/^>\s?/.test(trimmed)) {
      const bq = document.createElement('blockquote');
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      const p = document.createElement('p');
      p.append(...renderInline(buf.join(' ')));
      bq.appendChild(p);
      container.appendChild(bq);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(trimmed)) {
      const ul = document.createElement('ul');
      while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
        const li = document.createElement('li');
        li.append(...renderInline(lines[i].trim().replace(/^[-*+]\s+/, '')));
        ul.appendChild(li);
        i++;
      }
      container.appendChild(ul);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(trimmed)) {
      const ol = document.createElement('ol');
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        const li = document.createElement('li');
        li.append(...renderInline(lines[i].trim().replace(/^\d+\.\s+/, '')));
        ol.appendChild(li);
        i++;
      }
      container.appendChild(ol);
      continue;
    }

    // Paragraph: collapse consecutive non-blank lines, preserving "  \n" hard breaks
    const buf = [];
    while (i < lines.length) {
      const cur = lines[i];
      const curTrim = cur.trim();
      if (curTrim === '' || isHr(cur) || /^(#{1,6})\s+/.test(curTrim) ||
          /^[-*+]\s+/.test(curTrim) || /^\d+\.\s+/.test(curTrim) ||
          /^>\s?/.test(curTrim)) break;
      // Two trailing spaces = hard break
      const hardBreak = /  $/.test(cur);
      buf.push({ text: curTrim, hardBreak });
      i++;
    }
    if (buf.length) {
      const p = document.createElement('p');
      buf.forEach((item, idx) => {
        p.append(...renderInline(item.text));
        if (item.hardBreak && idx < buf.length - 1) {
          p.appendChild(document.createElement('br'));
        } else if (idx < buf.length - 1) {
          p.appendChild(document.createTextNode(' '));
        }
      });
      container.appendChild(p);
    }
  }
}

function createMeetingListItem(meeting) {
  const item = document.createElement('div');
  item.className = 'meeting-item';
  item.dataset.id = meeting.id;

  const checkbox = createMeetingCheckbox(meeting.id);
  checkbox.setAttribute('aria-label', `Select ${meeting.title}`);

  const body = document.createElement('div');
  body.className = 'meeting-item-body';

  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'meeting-info';
  info.setAttribute('aria-label', meeting.title);
  info.addEventListener('click', () => selectMeeting(meeting.id));

  const title = document.createElement('div');
  title.className = 'meeting-item-title';
  title.textContent = meeting.title;

  const metaRow = document.createElement('div');
  metaRow.className = 'meeting-meta-row';

  const date = document.createElement('span');
  date.className = 'meeting-item-date';
  date.textContent = formatRelativeDate(meeting.date);
  date.title = formatDate(meeting.date);

  const duration = document.createElement('span');
  duration.className = 'meeting-item-duration';
  duration.textContent = meeting.duration;

  const tagMeta = getTagMeta(meeting && meeting.tag);
  const tagPill = tagMeta ? document.createElement('span') : null;
  if (tagPill) {
    tagPill.className = 'meeting-item-tag-pill';
    tagPill.dataset.tag = tagMeta.slug;
    const dot = document.createElement('span');
    dot.className = 'recording-tag-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = tagMeta.shortLabel;
    tagPill.append(dot, label);
  }

  if (meeting && meeting.transcriptionStatus && meeting.transcriptionStatus !== 'completed') {
    const statusTag = document.createElement('span');
    statusTag.className = 'meeting-item-duration';
    statusTag.textContent = meeting.transcriptionStatus === 'failed' ? 'Transcription failed' : 'Awaiting transcription';
    metaRow.append(date, duration, statusTag);
    if (tagPill) metaRow.appendChild(tagPill);
  } else {
    metaRow.append(date, duration);
    if (tagPill) metaRow.appendChild(tagPill);
  }
  info.append(title, metaRow);
  body.appendChild(info);

  const bestPassage = meeting && meeting.searchMeta && meeting.searchMeta.bestPassage;
  if (bestPassage) {
    const snippetRow = document.createElement('div');
    snippetRow.className = 'meeting-item-snippet-row';

    const snippetEl = document.createElement('div');
    snippetEl.className = 'meeting-item-snippet';
    const parts = buildHighlightSegmentsFromParts(bestPassage.snippetParts);
    if (parts.length > 0) {
      for (const part of parts) {
        if (part.match) {
          const mark = document.createElement('mark');
          mark.textContent = part.text;
          snippetEl.appendChild(mark);
        } else {
          snippetEl.appendChild(document.createTextNode(part.text));
        }
      }
    } else if (bestPassage.excerpt || bestPassage.text) {
      snippetEl.textContent = bestPassage.excerpt || bestPassage.text;
    }

    if (snippetEl.childNodes.length > 0) {
      snippetRow.appendChild(snippetEl);
    }

    const jumpTimeLabel = formatJumpTimestamp(bestPassage.startSec);
    if (jumpTimeLabel) {
      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'meeting-item-jump-pill';
      jumpBtn.textContent = jumpTimeLabel;
      jumpBtn.title = `Jump to ${jumpTimeLabel} in transcript`;
      jumpBtn.setAttribute('aria-label', `Jump to ${jumpTimeLabel} in ${meeting.title}`);
      jumpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void openMeetingAtTimestamp(meeting.id, bestPassage.startSec);
      });
      snippetRow.appendChild(jumpBtn);
    }

    if (snippetRow.childNodes.length > 0) {
      body.appendChild(snippetRow);
    }
  }

  const deleteBtn = createDeleteButton();

  item.append(checkbox, body, deleteBtn);

  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMeetingChecked(meeting.id);
  });

  checkbox.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleMeetingChecked(meeting.id);
    }
  });

  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteMeetingHandler(meeting.id);
  });

  return item;
}

function setTranscriptMessage(message, isError = false) {
  // Home Activity replaced the inline transcript panel; keep messages in the log.
  addLog(message, isError ? 'error' : 'info');
}

function refreshIdleStatusPill() {
  if (recordingState !== 'idle') {
    return;
  }
  statusIndicator.classList.remove('recording');
  statusText.textContent = getIdleStatusPillText(transcriptionQueueState);
}

function updateResumePendingBanner() {
  if (!resumePendingBannerEl || !resumePendingBtn) {
    return;
  }
  const count = countResumablePendingMeetings(meetings, transcriptionQueueState);
  const view = buildResumePendingBannerView(count);
  resumePendingBannerEl.style.display = view.visible ? 'flex' : 'none';
  if (resumePendingBannerText) {
    resumePendingBannerText.textContent = view.label;
  }
  resumePendingBtn.textContent = view.buttonLabel || 'Resume pending transcriptions';
  resumePendingBtn.disabled = !view.visible || recordingState === 'recording'
    || recordingState === 'starting' || recordingState === 'stopping'
    || recordingState === 'cancelling';
}

function renderActivityList() {
  if (!activityListEl) {
    return;
  }
  const rows = buildActivityRows({
    queueState: transcriptionQueueState,
    meetings,
  });
  const activeBeforeRender = typeof document !== 'undefined' ? document.activeElement : null;
  const focusedRow = activeBeforeRender?.closest?.('.activity-row');
  const focusedRowId = focusedRow?.dataset.meetingId;
  const focusedAction = activeBeforeRender?.tagName === 'BUTTON' ? activeBeforeRender.textContent : null;
  const restoreActivityRenameFocus = shouldRestoreInlineEditorFocus({
    editorOpen: Boolean(activityRenameMeetingId),
    activeElement: activeBeforeRender,
    isEditorControl: Boolean(
      activeBeforeRender
      && activeBeforeRender.classList
      && activeBeforeRender.classList.contains('activity-rename-input')
    ),
    doc: typeof document !== 'undefined' ? document : null,
  });

  const openActivityMeetingId = activeOpenTagPopover?.activityMeetingId;
  if (openActivityMeetingId != null) closeActiveTagPopover();
  clearElement(activityListEl);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'placeholder';
    empty.id = 'activity-empty';
    empty.textContent = getActivityEmptyStateText();
    activityListEl.appendChild(empty);
    const importLink = document.createElement('button');
    importLink.type = 'button';
    importLink.className = 'btn btn-small';
    importLink.textContent = 'Import audio in History';
    importLink.addEventListener('click', () => { activateTab('history'); document.getElementById('import-audio-button').focus(); });
    activityListEl.appendChild(importLink);
    updateResumePendingBanner();
    refreshIdleStatusPill();
    updateSoftQueueDepthWarning();
    updateBackgroundTranscriptionTip();
    restoreInlineTitleEditorFocus();
    return;
  }

  rows.forEach((row) => {
    const item = document.createElement('div');
    item.className = 'activity-row';
    item.setAttribute('role', 'listitem');
    item.dataset.meetingId = row.meetingId;
    if (row.status === 'active') item.classList.add('is-active');
    if (row.status === 'failed' || row.status === 'cancelled') item.classList.add('is-failed');
    if (row.status === 'ready') item.classList.add('is-ready');

    const main = document.createElement('div');
    main.className = 'activity-row-main';
    const busy = activityActionBusyMeetingId === row.meetingId;
    const isRenaming = activityRenameMeetingId === row.meetingId;

    if (isRenaming) {
      const form = document.createElement('form');
      form.className = 'activity-rename-form';
      form.addEventListener('click', (event) => event.stopPropagation());
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void commitActivityRename(row.meetingId);
      });
      form.addEventListener('focusout', (event) => {
        if (event.relatedTarget && form.contains(event.relatedTarget)) {
          return;
        }
        void commitActivityRename(row.meetingId);
      });

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'activity-rename-input';
      input.value = activityRenameDraft;
      input.maxLength = 120;
      input.setAttribute('aria-label', 'Recording title');
      input.disabled = busy;
      input.addEventListener('input', () => {
        activityRenameDraft = input.value;
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelActivityRename();
        }
      });

      const saveBtn = document.createElement('button');
      saveBtn.type = 'submit';
      saveBtn.className = 'btn btn-small btn-primary';
      saveBtn.textContent = busy ? 'Saving…' : 'Save';
      saveBtn.disabled = busy;

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-small';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.disabled = busy;
      cancelBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancelActivityRename();
      });

      form.appendChild(input);
      form.appendChild(saveBtn);
      form.appendChild(cancelBtn);
      main.appendChild(form);
    } else {
      const title = document.createElement('div');
      title.className = 'activity-row-title';
      title.tabIndex = -1;
      title.textContent = row.title;
      main.appendChild(title);
    }

    const meta = document.createElement('div');
    meta.className = 'activity-row-meta';
    const chip = document.createElement('span');
    chip.className = `activity-chip ${row.status === 'active' ? (row.phase || 'transcribing') : row.status}`;
    chip.textContent = row.chip;
    meta.appendChild(chip);
    if (row.durationLabel) {
      const duration = document.createElement('span');
      duration.className = 'activity-row-duration';
      duration.textContent = row.durationLabel;
      meta.appendChild(duration);
    }
    const rowMeeting = findMeetingById(row.meetingId);
    if (rowMeeting) {
      const rowTagAnchor = document.createElement('div');
      rowTagAnchor.className = 'activity-row-tag-anchor';
      const rowTagBtn = document.createElement('button');
      rowTagBtn.type = 'button';
      rowTagBtn.className = 'recording-tag-pill activity-tag-btn';
      const rowTagDot = document.createElement('span');
      rowTagDot.className = 'recording-tag-dot';
      rowTagDot.setAttribute('aria-hidden', 'true');
      const rowTagLabel = document.createElement('span');
      const rowTagCaret = document.createElement('span');
      rowTagCaret.className = 'recording-tag-caret';
      rowTagCaret.setAttribute('aria-hidden', 'true');
      rowTagCaret.textContent = '▾';
      rowTagBtn.append(rowTagDot, rowTagLabel, rowTagCaret);
      rowTagBtn.setAttribute('aria-haspopup', 'listbox');
      rowTagBtn.setAttribute('aria-expanded', 'false');
      applyTagPillView(rowTagBtn, rowTagLabel, rowMeeting.tag, { untaggedLabel: 'Tag' });

      const rowTagPopover = document.createElement('div');
      rowTagPopover.className = 'recording-tag-popover';
      rowTagPopover.setAttribute('role', 'listbox');
      rowTagPopover.setAttribute('aria-label', `Tag for ${row.title}`);
      rowTagPopover.hidden = true;

      rowTagBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleTagPickerPopover({
          triggerBtn: rowTagBtn,
          popoverEl: rowTagPopover,
          activityMeetingId: row.meetingId,
          currentTag: normalizeTag(findMeetingById(row.meetingId)?.tag),
          onSelect: async (nextTag) => {
            await commitMeetingTagChange(row.meetingId, nextTag);
          },
        });
      });

      rowTagAnchor.append(rowTagBtn, rowTagPopover);
      if (openActivityMeetingId != null && meetingIdsEqual(openActivityMeetingId, row.meetingId)) {
        toggleTagPickerPopover({
          triggerBtn: rowTagBtn, popoverEl: rowTagPopover, activityMeetingId: row.meetingId,
          currentTag: normalizeTag(rowMeeting.tag),
          onSelect: (nextTag) => commitMeetingTagChange(row.meetingId, nextTag),
        });
      }
      meta.appendChild(rowTagAnchor);
    }
    main.appendChild(meta);
    item.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'activity-row-actions';

    if (row.actions.includes('rename') && !isRenaming) {
      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'btn btn-small';
      renameBtn.textContent = 'Rename';
      renameBtn.disabled = busy;
      renameBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        beginActivityRename(row.meetingId, row.title);
      });
      actions.appendChild(renameBtn);
    }
    if (row.actions.includes('delete')) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-small';
      deleteBtn.textContent = busy ? 'Deleting…' : 'Delete';
      deleteBtn.disabled = busy || isRenaming;
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void deleteActivityMeeting(row.meetingId, row.title);
      });
      actions.appendChild(deleteBtn);
    }
    if (row.actions.includes('cancel')) {
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-small';
      cancelBtn.textContent = busy ? 'Cancelling…' : 'Cancel';
      cancelBtn.disabled = busy || isRenaming;
      cancelBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void cancelActivityTranscription(row.meetingId);
      });
      actions.appendChild(cancelBtn);
    }
    if (row.actions.includes('retry')) {
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn btn-small btn-primary';
      retryBtn.textContent = busy ? 'Retrying…' : 'Retry';
      retryBtn.disabled = busy || isRenaming;
      retryBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void retryActivityTranscription(row.meetingId);
      });
      actions.appendChild(retryBtn);
    }
    if (row.actions.includes('open')) {
      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-small';
      openBtn.textContent = 'Open in History';
      openBtn.disabled = isRenaming;
      openBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        openMeetingInHistory(row.meetingId);
      });
      actions.appendChild(openBtn);
    }
    if (row.status === 'ready' && !isRenaming
        && (rowMeeting?.ai?.diarization?.speakerCount > 0
          || transcriptionQueueState.jobs.some((job) => String(job.meetingId) === String(row.meetingId) && job.speakerCount > 0))) {
      const nameButton = document.createElement('button');
      nameButton.type = 'button';
      nameButton.className = 'btn btn-small';
      nameButton.textContent = 'Name speakers';
      nameButton.addEventListener('click', (event) => {
        event.stopPropagation();
        void openHistorySpeakerNames(row.meetingId);
      });
      actions.appendChild(nameButton);
    }
    item.appendChild(actions);

    if (row.actions.includes('open') && !row.actions.includes('cancel') && !isRenaming) {
      item.style.cursor = 'pointer';
      item.addEventListener('click', () => openMeetingInHistory(row.meetingId));
    }

    activityListEl.appendChild(item);
  });

  updateResumePendingBanner();
  refreshIdleStatusPill();
  updateSoftQueueDepthWarning();
  updateBackgroundTranscriptionTip();
  if (restoreActivityRenameFocus) {
    focusActivityRenameInput({ select: false });
  } else if (focusedRowId) {
    const row = activityListEl.querySelector(`.activity-row[data-meeting-id="${CSS.escape(focusedRowId)}"]`);
    const action = focusedAction && [...(row?.querySelectorAll('button') || [])]
      .find((button) => button.textContent === focusedAction && !button.disabled);
    (action || row?.querySelector('.activity-row-title'))?.focus({ preventScroll: true });
  }
  restoreInlineTitleEditorFocus();
}

function applyMeetingTitleLocally(updated) {
  if (!updated || !updated.id) {
    return;
  }
  const idx = findMeetingIndexById(updated.id);
  if (idx !== -1) {
    meetings[idx] = { ...meetings[idx], title: updated.title };
  }
  if (currentRecordingMeeting && meetingIdsEqual(currentRecordingMeeting.id, updated.id)) {
    currentRecordingMeeting = { ...currentRecordingMeeting, title: updated.title };
  }
  const queueJobs = Array.isArray(transcriptionQueueState.jobs) ? transcriptionQueueState.jobs : [];
  transcriptionQueueState = {
    ...transcriptionQueueState,
    jobs: queueJobs.map((job) => (
      String(job.meetingId) === String(updated.id)
        ? { ...job, title: updated.title }
        : job
    )),
  };
  renderMeetingList();
  renderActivityList();
}

function beginActivityRename(meetingId, currentTitle = '') {
  const id = String(meetingId || '').trim();
  if (!id || activityActionBusyMeetingId) {
    return;
  }
  const meeting = findMeetingById(id);
  activityRenameMeetingId = id;
  activityRenameDraft = (meeting && meeting.title) || currentTitle || '';
  activityRenameOriginal = activityRenameDraft;
  renderActivityList();
  requestAnimationFrame(() => {
    focusActivityRenameInput({ select: true });
  });
}

function cancelActivityRename() {
  if (activityActionBusyMeetingId && activityActionBusyMeetingId === activityRenameMeetingId) {
    return;
  }
  activityRenameMeetingId = null;
  activityRenameDraft = '';
  activityRenameOriginal = '';
  renderActivityList();
}

async function commitActivityRename(meetingId) {
  const id = String(meetingId || '').trim();
  if (!id || activityActionBusyMeetingId) {
    return;
  }
  const decision = resolveActivityRenameCommit({
    draft: activityRenameDraft,
    original: activityRenameOriginal,
  });
  if (decision.action !== 'save') {
    cancelActivityRename();
    return;
  }
  activityActionBusyMeetingId = id;
  renderActivityList();
  try {
    const updated = await window.electronAPI.updateMeeting(id, { title: decision.title });
    if (!updated || !updated.title) {
      throw new Error('Recording was not found.');
    }
    activityRenameMeetingId = null;
    activityRenameDraft = '';
    activityRenameOriginal = '';
    applyMeetingTitleLocally(updated);
    addLog(`Renamed recording to "${updated.title}"`);
  } catch (error) {
    addLog(`Could not rename recording: ${error.message}`, 'error');
    alert(`Could not rename recording: ${error.message}`);
  } finally {
    activityActionBusyMeetingId = null;
    renderActivityList();
  }
}

async function deleteActivityMeeting(meetingId, currentTitle = '') {
  const id = String(meetingId || '').trim();
  if (!id || activityActionBusyMeetingId) {
    return;
  }
  activityActionBusyMeetingId = id;
  renderActivityList();
  try {
    await deleteMeetingHandler(id, currentTitle);
  } finally {
    activityActionBusyMeetingId = null;
    renderActivityList();
  }
}

function showCompletionToast(job) {
  const toastEl = document.getElementById('activity-completion-toast');
  if (!toastEl || !job) {
    return;
  }
  const view = buildCompletionToastView({
    title: job.title,
    durationSeconds: job.durationSeconds,
  });
  if (!view.visible) {
    return;
  }
  const message = document.getElementById('activity-completion-message');
  const nameButton = document.getElementById('activity-completion-name-speakers');
  showCompletionToast._cleanup?.();
  const cleanup = () => {
    clearTimeout(showCompletionToast._timer);
    showCompletionToast._timer = null;
    showCompletionToast._cleanup = null;
    toastEl.removeEventListener('focusout', onFocusOut);
  };
  const hide = () => {
    cleanup();
    toastEl.classList.remove('is-visible');
    toastEl.hidden = true;
  };
  const onFocusOut = (event) => {
    if (!toastEl.contains(event.relatedTarget)) hide();
  };
  showCompletionToast._cleanup = cleanup;
  if (message) message.textContent = view.message;
  if (nameButton) {
    nameButton.hidden = !(job.speakerCount > 0);
    nameButton.onclick = () => {
      hide();
      void openHistorySpeakerNames(job.meetingId);
    };
  }
  toastEl.hidden = false;
  toastEl.classList.add('is-visible');
  showCompletionToast._timer = setTimeout(() => {
    if (toastEl.contains(document.activeElement)) {
      toastEl.addEventListener('focusout', onFocusOut);
    } else {
      hide();
    }
  }, job.speakerCount > 0 ? 8000 : 4500);
}

function updateBackgroundTranscriptionTip() {
  const tipEl = document.getElementById('background-transcription-tip');
  const tipText = document.getElementById('background-transcription-tip-text');
  const dismissBtn = document.getElementById('background-transcription-tip-dismiss');
  if (!tipEl || !tipText) {
    return;
  }
  const busy = Number(transcriptionQueueState.busyCount) || 0;
  const view = buildBackgroundTranscriptionTipView(loadSettings());
  const shouldShow = view.visible && busy > 0;
  tipEl.hidden = !shouldShow;
  tipEl.style.display = shouldShow ? 'flex' : 'none';
  tipText.textContent = view.message;
  if (dismissBtn && !dismissBtn.dataset.bound) {
    dismissBtn.dataset.bound = '1';
    dismissBtn.addEventListener('click', () => {
      saveSettings({ backgroundTranscriptionTipSeen: true });
      updateBackgroundTranscriptionTip();
    });
  }
}

function updateSoftQueueDepthWarning() {
  const warningEl = document.getElementById('soft-queue-depth-warning');
  if (!warningEl) {
    return;
  }
  const view = buildSoftQueueDepthWarningView(transcriptionQueueState.busyCount);
  warningEl.hidden = !view.visible;
  warningEl.style.display = view.visible ? 'block' : 'none';
  warningEl.textContent = view.message || '';
}

function applyTranscriptionQueueState(payload) {
  const seq = Number(payload && payload.seq) || 0;
  // Reject stale snapshots (e.g. init await completing after a fresher push).
  if (!shouldApplyTranscriptionQueueState(payload, lastAppliedTranscriptionQueueSeq)) {
    return false;
  }
  if (seq > 0) {
    lastAppliedTranscriptionQueueSeq = seq;
  }
  transcriptionQueueState = {
    jobs: Array.isArray(payload && payload.jobs) ? payload.jobs : [],
    activeMeetingId: payload && payload.activeMeetingId ? String(payload.activeMeetingId) : null,
    busyCount: Number(payload && payload.busyCount) || 0,
    seq,
  };
  renderActivityList();
  return true;
}

function openMeetingInHistory(meetingId) {
  activateTab('history');
  activateHistoryDetailTab('transcript');
  void selectMeeting(meetingId);
}

async function openHistorySpeakerNames(meetingId) {
  const id = String(meetingId);
  if (!findMeetingById(id)) await loadMeetingHistory();
  activateTab('history');
  activateHistoryDetailTab('transcript');
  if (meetingIdsEqual(currentMeetingId, id)) await refreshMeetingDetails(id);
  else await selectMeeting(id);
  if (!meetingIdsEqual(currentMeetingId, id)) return;
  const samples = historySpeakers?.samples || [];
  const speaker = samples.find((sample) => !historySpeakers.names[sample.speaker]) || samples[0];
  if (speaker) focusHistorySpeaker(speaker.speaker);
}

async function cancelActivityTranscription(meetingId) {
  const id = String(meetingId || '').trim();
  if (!id || activityActionBusyMeetingId) {
    return;
  }
  activityActionBusyMeetingId = id;
  renderActivityList();
  try {
    const result = await window.electronAPI.cancelPendingTranscription({ meetingId: id });
    if (!result || result.success === false) {
      addLog((result && result.message) || 'Could not cancel transcription.', 'warning');
    } else {
      addLog('Transcription cancelled.', 'warning');
    }
    await loadMeetingHistory();
  } catch (error) {
    addLog(`Cancel failed: ${error.message}`, 'error');
  } finally {
    activityActionBusyMeetingId = null;
    renderActivityList();
  }
}

async function retryActivityTranscription(meetingId) {
  const id = String(meetingId || '').trim();
  if (!id || activityActionBusyMeetingId) {
    return;
  }
  activityActionBusyMeetingId = id;
  renderActivityList();
  addLog(`Retrying transcription for ${id}...`);
  try {
    // Fire-and-forget from Home: do not block Start. Retry IPC still awaits in main;
    // we intentionally do not await here beyond enqueue acknowledgment if available.
    const resultPromise = window.electronAPI.retryTranscription(buildOrdinaryRetryOptions(id));
    // Mark busy briefly then clear so Start stays usable; queue-state drives chips.
    activityActionBusyMeetingId = null;
    renderActivityList();
    const result = await resultPromise;
    if (result && result.meeting) {
      syncMeetingInList(result.meeting);
    }
    await loadMeetingHistory();
    addLog('Transcription retry completed.');
  } catch (error) {
    addLog(`Retry failed: ${error.message}`, 'error');
    await loadMeetingHistory().catch(() => {});
  } finally {
    activityActionBusyMeetingId = null;
    renderActivityList();
  }
}

async function resumePendingTranscriptionsFromBanner() {
  if (!resumePendingBtn) {
    return;
  }
  resumePendingBtn.disabled = true;
  resumePendingBtn.textContent = 'Resuming…';
  try {
    const result = await window.electronAPI.resumePendingTranscriptions();
    const count = result && result.enqueuedCount ? result.enqueuedCount : 0;
    addLog(count
      ? `Resumed ${count} pending transcription${count === 1 ? '' : 's'}.`
      : 'No pending transcriptions to resume.');
    const skipped = result && Array.isArray(result.skipped) ? result.skipped : [];
    for (const entry of skipped) {
      addLog(
        `Skipped pending meeting ${entry.meetingId || '?'}: ${entry.error || entry.code || 'unsupported saved options'}.`,
        'warning',
      );
    }
    await loadMeetingHistory();
  } catch (error) {
    addLog(`Resume failed: ${error.message}`, 'error');
  } finally {
    updateResumePendingBanner();
  }
}

function setMeetingAudioSource(audioPath) {
  stopSpeakerPreview?.();
  if (typeof pendingAudioSeekCleanup === 'function') {
    pendingAudioSeekCleanup();
    pendingAudioSeekCleanup = null;
  }
  const audioPlayer = document.getElementById('audio-player');
  if (audioPath) audioPlayer.src = window.electronAPI.buildFileUrl(audioPath);
  else audioPlayer.removeAttribute('src');
  audioPlayer.load();
  // Reset custom player UI when a new source loads
  if (typeof window.__resetCustomAudioPlayer === 'function') {
    window.__resetCustomAudioPlayer();
  }
}

function seekMeetingAudio(targetSeconds, { player, afterSeek } = {}) {
  const numeric = Number(targetSeconds);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return;
  }
  const audioPlayer = player || document.getElementById('audio-player');
  if (!audioPlayer || !audioPlayer.getAttribute('src')) {
    return;
  }

  if (!afterSeek) stopSpeakerPreview?.();
  if (typeof pendingAudioSeekCleanup === 'function') {
    pendingAudioSeekCleanup();
    pendingAudioSeekCleanup = null;
  }

  const applySeek = () => {
    const duration = Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0
      ? audioPlayer.duration
      : null;
    const clamped = duration !== null
      ? Math.max(0, Math.min(duration, numeric))
      : Math.max(0, numeric);
    audioPlayer.currentTime = clamped;
    if (!player && typeof window.__syncCustomAudioPlayer === 'function') {
      window.__syncCustomAudioPlayer();
    }
    afterSeek?.();
  };

  if (audioPlayer.readyState >= 1) {
    applySeek();
    return;
  }

  const onLoadedMetadata = () => {
    pendingAudioSeekCleanup = null;
    applySeek();
  };
  audioPlayer.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
  pendingAudioSeekCleanup = () => {
    audioPlayer.removeEventListener('loadedmetadata', onLoadedMetadata);
  };
}

function playSpeakerSample(button, player, sample, updateButton) {
  if (button.getAttribute('aria-pressed') === 'true') {
    stopSpeakerPreview?.();
    return;
  }
  stopSpeakerPreview?.();
  const endSec = Number.isFinite(sample.endSec) && sample.endSec > sample.startSec
    ? sample.endSec : sample.startSec + 4;
  const stop = () => {
    stopSpeakerPreview = null;
    pendingAudioSeekCleanup?.();
    pendingAudioSeekCleanup = null;
    player.removeEventListener('timeupdate', onTime);
    player.removeEventListener('pause', stop);
    player.removeEventListener('ended', stop);
    player.removeEventListener('error', stop);
    player.pause();
    updateButton(false);
  };
  const onTime = () => {
    if (player.currentTime >= endSec) stop();
  };
  stopSpeakerPreview = stop;
  updateButton(true);
  player.addEventListener('ended', stop);
  player.addEventListener('error', stop);
  seekMeetingAudio(sample.startSec, {
    player: player.id === 'audio-player' ? undefined : player,
    afterSeek: async () => {
      if (stopSpeakerPreview !== stop) return;
      player.addEventListener('timeupdate', onTime);
      try {
        await player.play();
        if (stopSpeakerPreview === stop) player.addEventListener('pause', stop);
      } catch {
        if (stopSpeakerPreview === stop) stop();
      }
    },
  });
}

function buildSpeakerRow(prefix, sample, names, player, signal) {
  const row = document.createElement('div');
  row.className = 'speaker-row';
  const label = document.createElement('label');
  label.htmlFor = `${prefix}-name-${sample.speaker.replace(' ', '-')}`;
  label.textContent = sample.speaker;
  const field = document.createElement('input');
  field.type = 'text';
  field.id = label.htmlFor;
  field.className = 'speaker-name-input';
  field.maxLength = 64;
  field.autocomplete = 'off';
  field.placeholder = 'Add a name';
  field.value = names[sample.speaker] || '';
  row.append(label, field);
  if (player?.getAttribute('src') && !player.error && sample.startSec !== null) {
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'btn btn-small speaker-preview';
    const timestamp = formatJumpTimestamp(sample.startSec);
    const update = (playing) => {
      preview.setAttribute('aria-pressed', String(playing));
      preview.setAttribute('aria-label', `Voice preview for ${sample.speaker} at ${timestamp}`);
      preview.textContent = `${playing ? '❚❚' : '▶'} ${timestamp}`;
    };
    update(false);
    preview.addEventListener('click', () => playSpeakerSample(preview, player, sample, update));
    player.addEventListener('error', () => {
      preview.disabled = true;
      preview.title = 'Recording audio is unavailable';
    }, { once: true, signal });
    row.appendChild(preview);
  }
  if (sample.excerpt) {
    const excerpt = document.createElement('p');
    excerpt.className = 'speaker-excerpt';
    excerpt.id = `${field.id}-excerpt`;
    excerpt.textContent = `“${sample.excerpt}”`;
    excerpt.title = sample.excerpt;
    field.setAttribute('aria-describedby', excerpt.id);
    row.appendChild(excerpt);
  }
  return { row, field };
}

function setHistorySpeakerLabel(button, speaker, names) {
  const name = names[speaker] || speaker;
  button.textContent = name;
  button.setAttribute('aria-label', `Edit name for ${name}`);
}

function setHistorySpeakersExpanded(expanded) {
  const toggle = document.getElementById('history-speaker-toggle');
  const chips = document.getElementById('history-speaker-chips');
  if (!historySpeakers || !toggle || !chips) return;
  historySpeakers.expanded = expanded;
  document.getElementById('history-speaker-rows').hidden = !expanded;
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.textContent = expanded ? 'Hide names' : 'Edit names';
  chips.hidden = expanded;
  chips.replaceChildren();
  if (expanded) return;
  for (const { speaker } of historySpeakers.samples) {
    const chip = document.createElement('button');
    chip.className = 'history-transcript-speaker';
    chip.type = 'button';
    setHistorySpeakerLabel(chip, speaker, historySpeakers.names);
    chip.addEventListener('click', () => focusHistorySpeaker(speaker));
    chips.appendChild(chip);
  }
}

function focusHistorySpeaker(speaker) {
  if (!historySpeakers) return;
  setHistorySpeakersExpanded(true);
  historySpeakers.fields.get(speaker)?.focus();
}

function clearHistorySpeakers() {
  stopSpeakerPreview?.();
  historySpeakers?.controller.abort();
  historySpeakers = null;
  const bar = document.getElementById('history-speaker-bar');
  if (bar) bar.hidden = true;
}

function renderHistorySpeakers(meeting, segments) {
  clearHistorySpeakers();
  const bar = document.getElementById('history-speaker-bar');
  const samples = extractSpeakerSamples(segments);
  if (!bar || !samples.length) return;
  const rows = document.getElementById('history-speaker-rows');
  const status = document.getElementById('history-speaker-status');
  const player = document.getElementById('audio-player');
  const state = {
    meeting,
    samples,
    names: meeting.ai?.diarization?.speakerNames || {},
    fields: new Map(),
    requestedNames: new Map(),
    controller: new AbortController(),
    transcriptHash: null,
  };
  historySpeakers = state;
  status.textContent = '';
  rows.replaceChildren();
  document.getElementById('history-speaker-heading').textContent = `Speakers (${samples.length})`;
  document.getElementById('history-speaker-toggle').onclick = () => setHistorySpeakersExpanded(!state.expanded);
  const collapseIfNamed = (nextFocus) => {
    if (historySpeakers === state && state.expanded && !rows.contains(nextFocus)
        && !hasUnnamedSpeakers({ ai: { diarization: { speakerNames: state.names } } }, samples)) {
      setHistorySpeakersExpanded(false);
    }
  };
  rows.addEventListener('focusout', (event) => collapseIfNamed(event.relatedTarget), { signal: state.controller.signal });
  for (const sample of samples) {
    const { speaker } = sample;
    const { row, field } = buildSpeakerRow('history-speaker', sample, state.names, player, state.controller.signal);
    state.fields.set(speaker, field);
    rows.appendChild(row);
    state.requestedNames.set(speaker, state.names[speaker] || '');
    const save = async (nextFocus = document.activeElement) => {
      const name = normalizeSpeakerName(field.value);
      if (name === state.requestedNames.get(speaker)) {
        collapseIfNamed(nextFocus);
        return;
      }
      state.requestedNames.set(speaker, name);
      field.value = name;
      status.textContent = 'Saving speaker name…';
      try {
        const updated = await window.electronAPI.updateMeeting(meeting.id, {
          speakerNames: { [speaker]: name },
          expectedSourceTranscriptHash: await (state.transcriptHash ||= hashSummaryTranscript(meeting.transcript)),
          expectedTranscriptionAttemptId: meeting.transcriptionResult?.attemptId || '',
        });
        syncMeetingInList(updated);
        if (historySpeakers !== state) return;
        state.names = updated.ai?.diarization?.speakerNames || {};
        if (state.requestedNames.get(speaker) === name) {
          if (field.value === name) field.value = state.names[speaker] || '';
          state.requestedNames.set(speaker, state.names[speaker] || '');
          status.textContent = 'Speaker name saved.';
        }
        updateHistorySpeakerLabels(state, updated);
        collapseIfNamed(document.activeElement);
        if (meetingSearchQueryNormalized) void runHistorySearch(meetingSearchQuery);
      } catch (error) {
        if (historySpeakers !== state || state.requestedNames.get(speaker) !== name) return;
        state.requestedNames.set(speaker, state.names[speaker] || '');
        status.textContent = 'Could not save the name. Press Enter to try again or Escape to restore it.';
        console.warn('Speaker name update failed:', error.message);
      }
    };
    field.addEventListener('blur', (event) => void save(event.relatedTarget));
    field.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void save();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        field.value = state.names[speaker] || '';
        state.requestedNames.set(speaker, field.value);
        status.textContent = '';
      }
    });
  }
  bar.hidden = false;
  setHistorySpeakersExpanded(hasUnnamedSpeakers(meeting, samples));
}

function updateHistorySpeakerLabels(state, meeting) {
  for (const badge of document.querySelectorAll('#meeting-transcript [data-speaker-key]')) {
    setHistorySpeakerLabel(badge, badge.dataset.speakerKey, state.names);
  }
  updateSummaryTagMismatchBanner(meeting);
  if (!state.expanded) setHistorySpeakersExpanded(false);
}

function renderHistoryTranscriptMarkdown(transcriptEl, markdown, segments = parseTranscriptMarkdownSegments(markdown)) {
  transcriptEl.classList.remove('markdown-body');
  clearElement(transcriptEl);

  if (!segments.length) {
    transcriptEl.classList.add('markdown-body');
    renderMarkdownInto(transcriptEl, markdown);
    return;
  }

  segments.forEach((segment) => {
    const segmentDiv = document.createElement('div');
    segmentDiv.className = 'history-transcript-segment';
    const startSec = parseTimestampStringToSeconds(segment.start);
    const endSec = parseTimestampStringToSeconds(segment.end);
    if (startSec !== null) {
      segmentDiv.dataset.startSec = String(startSec);
    }
    if (endSec !== null) {
      segmentDiv.dataset.endSec = String(endSec);
    }

    const meta = document.createElement('div');
    meta.className = 'history-transcript-meta';

    if (startSec !== null) {
      const timestamp = document.createElement('button');
      timestamp.type = 'button';
      timestamp.title = `Jump audio to ${segment.start}`;
      timestamp.setAttribute('aria-label', `Jump audio to ${segment.start}`);
      timestamp.addEventListener('click', () => seekMeetingAudio(startSec));
      timestamp.className = 'history-transcript-timestamp';
      timestamp.textContent = `[${segment.start} - ${segment.end}]`;
      meta.appendChild(timestamp);
    }

    if (segment.speaker) {
      const editable = historySpeakers && isCanonicalSpeakerKey(segment.speaker);
      const speaker = document.createElement(editable ? 'button' : 'span');
      speaker.className = 'history-transcript-speaker';
      if (editable) {
        speaker.type = 'button';
        speaker.dataset.speakerKey = segment.speaker;
        setHistorySpeakerLabel(speaker, segment.speaker, historySpeakers.names);
        speaker.addEventListener('click', () => focusHistorySpeaker(segment.speaker));
      } else {
        speaker.textContent = segment.speaker;
      }
      meta.appendChild(speaker);
    }

    const text = document.createElement('div');
    text.className = 'history-transcript-text';
    text.textContent = segment.text || '';

    segmentDiv.append(meta, text);
    transcriptEl.appendChild(segmentDiv);
  });
}

function handleMacOSPermissionFailure(permissionStatus) {
  const missingMicrophone = permissionStatus?.missingMicrophone;
  const missingScreenRecording = permissionStatus?.missingScreenRecording;
  const missingDesktopAudio = permissionStatus?.missingDesktopAudio;

  if (!missingMicrophone && !missingScreenRecording && !missingDesktopAudio) {
    return false;
  }

  if (missingDesktopAudio && !missingMicrophone && !missingScreenRecording) {
    alert(
      'Recording cannot start because macOS desktop audio capture is unavailable.\n\n' +
      'Please reinstall AvaNevis or rebuild the app so the bundled audiocapture-helper is present and signed.'
    );
    return true;
  }

  let message = 'Recording cannot start until macOS permissions are granted.\n\n';

  if (missingMicrophone) {
    message += '- Grant Microphone access in System Settings > Privacy & Security > Microphone\n';
  }

  if (missingScreenRecording) {
    message += '- Grant Screen Recording access in System Settings > Privacy & Security > Screen Recording\n';
    message += '- Restart AvaNevis after granting Screen Recording access\n';
  }

  if (missingDesktopAudio) {
    message += '- Reinstall AvaNevis or rebuild the app so desktop audio capture is bundled correctly\n';
  }

  message += '\nOpen System Settings now?';

  const shouldOpenSettings = confirm(message);
  if (shouldOpenSettings && permissionStatus.settingsTarget) {
    window.electronAPI.openSystemSettings(permissionStatus.settingsTarget);
  }

  return true;
}

function setCopyButtonState(button, label, disabled) {
  clearElement(button);

  if (label === 'Copied!') {
    const icon = document.createElement('span');
    icon.className = 'btn-icon';
    icon.textContent = '✓';
    button.appendChild(icon);
    button.append(` ${label}`);
  } else {
    button.textContent = label;
  }

  button.disabled = disabled;
}

function setButtonBusy(button, busy, busyLabel = 'Working...') {
  if (!button) {
    return;
  }

  if (busy) {
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.textContent;
    }
    button.textContent = busyLabel;
    button.disabled = true;
    button.classList.add('is-loading');
    return;
  }

  button.textContent = button.dataset.originalLabel || button.textContent;
  delete button.dataset.originalLabel;
  button.disabled = false;
  button.classList.remove('is-loading');
}

function getSummaryButtonMeetingId(button) {
  if (!button) {
    return null;
  }
  if (button.id === 'generate-current-summary-btn') {
    return currentRecordingMeeting && currentRecordingMeeting.id ? String(currentRecordingMeeting.id) : null;
  }
  return currentMeetingId ? String(currentMeetingId) : null;
}

function getSummaryGenerationButtons() {
  return [
    document.getElementById('generate-summary-btn'),
    document.getElementById('regenerate-summary-btn'),
  ].filter(Boolean);
}

function restoreSummaryGenerationButton(button) {
  if (!button) {
    return;
  }

  button.textContent = button.dataset.originalLabel || button.textContent || 'Generate summary';
  button.classList.remove('is-loading', 'summary-generation-active', 'is-cancelling');
  delete button.dataset.originalLabel;
  delete button.dataset.hoverLabel;
  button.removeAttribute('aria-busy');
}

function applySummaryActionAvailability() {
  const summary = aiAddonStatusSnapshot && aiAddonStatusSnapshot.features
    ? aiAddonStatusSnapshot.features.summary
    : null;
  // homePromptContext.platform is the authoritative main-process platform.
  // Until it arrives, fall back to the renderer host family so a slow first
  // status fetch cannot leave Generate Summary dead on Windows/macOS.
  const platform = homePromptContext.platform || inferRendererHostFamily(navigator.platform);
  const control = getSummaryActionControlState(summary, {
    platformSupportsSummaries: platform === 'win32' || platform === 'darwin',
  });
  if (aiAddonStatusSnapshot?.summaryLibrary && usableSummaryModels().length) { control.enabled = true; control.title = ''; }
  const mismatchButton = document.getElementById('summary-tag-mismatch-regenerate');
  if (mismatchButton) mismatchButton.disabled = !control.enabled || Boolean(summaryGenerationMeetingId);
  for (const button of getSummaryGenerationButtons()) {
    button.disabled = !control.enabled;
    if (control.title) {
      button.title = control.title;
    } else {
      button.removeAttribute('title');
    }
  }
}

function updateSummaryGenerationButtons() {
  const mismatchButton = document.getElementById('summary-tag-mismatch-regenerate');
  if (mismatchButton) mismatchButton.disabled = Boolean(summaryGenerationMeetingId);
  const view = getSummaryGenerationButtonView({
    active: Boolean(summaryGenerationMeetingId),
    cancelling: summaryGenerationCancelling,
  });

  if (!view.active) {
    for (const button of getSummaryGenerationButtons()) {
      restoreSummaryGenerationButton(button);
    }
    applySummaryActionAvailability();
    return;
  }

  for (const button of getSummaryGenerationButtons()) {
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.textContent;
    }
    button.textContent = view.label;
    button.dataset.hoverLabel = view.hoverLabel || view.label;
    button.title = view.title || '';
    button.disabled = getSummaryButtonMeetingId(button) !== summaryGenerationMeetingId || summaryGenerationCancelling;
    button.setAttribute('aria-busy', view.ariaBusy ? 'true' : 'false');
    button.classList.add('is-loading', 'summary-generation-active');
    button.classList.toggle('is-cancelling', summaryGenerationCancelling);
  }
}

let closeSummaryLanguageConfirmation = null;

async function cancelSummaryGeneration(meetingId) {
  if (!summaryGenerationMeetingId || summaryGenerationCancelling) {
    return;
  }

  summaryGenerationCancelling = true;
  updateSummaryGenerationButtons();
  addLog('Cancelling summary generation...');
  if (closeSummaryLanguageConfirmation) {
    closeSummaryLanguageConfirmation(null);
    return;
  }

  try {
    const result = await window.electronAPI.cancelSummaryGeneration({ meetingId: meetingId || summaryGenerationMeetingId });
    if (result && result.message && !result.canceled) {
      addLog(result.message, 'warning');
    }
  } catch (error) {
    summaryGenerationCancelling = false;
    updateSummaryGenerationButtons();
    addLog(`Failed to cancel summary generation: ${error.message}`, 'error');
  }
}

function activateHistoryDetailTab(targetTab) {
  activeHistoryDetailTab = normalizeHistoryDetailTab(targetTab);

  document.querySelectorAll('[data-history-detail-tab]').forEach((button) => {
    const isActive = button.dataset.historyDetailTab === activeHistoryDetailTab;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  document.querySelectorAll('.history-detail-panel').forEach((panel) => {
    const isActive = panel.id === `history-${activeHistoryDetailTab}-panel`;
    panel.classList.toggle('active', isActive);
    panel.hidden = !isActive;
  });
}

function setupHistoryDetailTabs() {
  document.querySelectorAll('[data-history-detail-tab]').forEach((button) => {
    button.addEventListener('click', () => activateHistoryDetailTab(button.dataset.historyDetailTab));
  });
}

function activateTab(targetTab) {
  closeActiveTagPopover();
  const tabButtons = document.querySelectorAll('.tab-btn');
  const railButtons = document.querySelectorAll('.rail-btn[data-tab]');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const allNavButtons = [...tabButtons, ...railButtons];

  allNavButtons.forEach((btn) => {
    const isActive = btn.dataset.tab === targetTab;
    btn.classList.toggle('active', isActive);
    if (btn.matches('.rail-btn[data-tab]')) {
      if (isActive) {
        btn.setAttribute('aria-current', 'page');
      } else {
        btn.removeAttribute('aria-current');
      }
    } else {
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  });
  tabPanes.forEach((pane) => {
    pane.classList.toggle('active', pane.id === `${targetTab}-tab`);
  });

  if (targetTab === 'settings') {
    initSettingsTab().catch((error) => console.error('Failed to initialize settings tab:', error));
  }
  if (targetTab === 'chat' && typeof initChatTab === 'function') {
    initChatTab().catch((error) => console.error('Failed to initialize chat tab:', error));
  }
}

function getPreferredScrollBehavior() {
  const prefersReducedMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return prefersReducedMotion ? 'auto' : 'smooth';
}

function openSettingsAtAiAddons() {
  activateTab('settings');
  const section = document.getElementById('ai-addons-settings');
  if (section) {
    section.scrollIntoView({ block: 'start', behavior: getPreferredScrollBehavior() });
  }
}

function showAppToast(message, variant = 'info', durationMs = 4000) {
  const text = String(message || '').trim();
  if (!text) {
    return;
  }
  const toastEl = document.getElementById('app-toast');
  if (!toastEl) {
    return;
  }
  toastEl.textContent = text;
  toastEl.classList.remove('is-warning', 'is-error', 'is-success');
  if (variant === 'warning' || variant === 'error' || variant === 'success') {
    toastEl.classList.add(`is-${variant}`);
  }
  toastEl.hidden = false;
  toastEl.classList.add('is-visible');
  clearTimeout(showAppToast._timer);
  showAppToast._timer = setTimeout(() => {
    toastEl.classList.remove('is-visible');
    toastEl.hidden = true;
  }, durationMs);
}

function highlightTranscriptSegmentAtTime(startSec) {
  const transcriptEl = document.getElementById('meeting-transcript');
  if (!transcriptEl) {
    return;
  }
  transcriptEl.querySelectorAll('.history-transcript-segment.is-citation-highlight').forEach((el) => {
    el.classList.remove('is-citation-highlight');
  });
  if (activeCitationHighlightTimer) {
    clearTimeout(activeCitationHighlightTimer);
    activeCitationHighlightTimer = null;
  }

  const segmentNodes = [...transcriptEl.querySelectorAll('.history-transcript-segment')];
  if (!segmentNodes.length) {
    return;
  }

  const descriptors = segmentNodes.map((node) => ({
    startSec: node.dataset.startSec !== undefined && node.dataset.startSec !== ''
      ? Number(node.dataset.startSec)
      : null,
    endSec: node.dataset.endSec !== undefined && node.dataset.endSec !== ''
      ? Number(node.dataset.endSec)
      : null,
    node,
  }));

  const matchIdx = findClosestTranscriptSegmentIndex(descriptors, startSec);
  if (matchIdx === -1 || !descriptors[matchIdx]) {
    return;
  }

  const matchedNode = descriptors[matchIdx].node;
  matchedNode.classList.add('is-citation-highlight');
  matchedNode.scrollIntoView({ behavior: getPreferredScrollBehavior(), block: 'center' });
  activeCitationHighlightTimer = setTimeout(() => {
    matchedNode.classList.remove('is-citation-highlight');
    activeCitationHighlightTimer = null;
  }, 3600);
}

async function openMeetingAtTimestamp(meetingId, startSec = null) {
  const targetId = String(meetingId || '').trim();
  if (!targetId) {
    return false;
  }

  let meeting = meetings.find((item) => String(item.id) === targetId);
  if (!meeting) {
    await loadMeetingHistory();
    meeting = meetings.find((item) => String(item.id) === targetId);
  }
  if (!meeting) {
    showAppToast('This recording is no longer in History.', 'warning');
    return false;
  }

  activateTab('history');
  activateHistoryDetailTab('transcript');

  if (String(currentMeetingId || '') !== targetId) {
    await selectMeeting(targetId);
  } else {
    const transcriptEl = document.getElementById('meeting-transcript');
    if (transcriptEl && !transcriptEl.querySelector('.history-transcript-segment')) {
      await refreshMeetingDetails(targetId);
    }
  }

  if (String(currentMeetingId || '') !== targetId) {
    return false;
  }

  meetingList.querySelector(`.meeting-item[data-id="${CSS.escape(targetId)}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: getPreferredScrollBehavior() });

  const numericStart = startSec !== null && startSec !== undefined && startSec !== ''
    ? Number(startSec)
    : null;
  if (numericStart !== null && Number.isFinite(numericStart) && numericStart >= 0) {
    highlightTranscriptSegmentAtTime(numericStart);
    seekMeetingAudio(numericStart);
  }
  return true;
}

function focusTabHeading(targetTab) {
  const pane = document.getElementById(`${targetTab}-tab`);
  if (!pane) {
    return;
  }
  const heading = pane.querySelector('h2, h3');
  if (!heading) {
    return;
  }
  if (!heading.hasAttribute('tabindex')) {
    heading.setAttribute('tabindex', '-1');
  }
  heading.focus({ preventScroll: true });
}

function activateTabAndFocusHeading(targetTab) {
  activateTab(targetTab);
  focusTabHeading(targetTab);
}

function canRunKeyboardRecordingCommand(action) {
  if (action === 'start-recording') {
    return isRecordingCommandAdmitted('start');
  }
  if (action === 'stop-recording') {
    return isRecordingCommandAdmitted('stop');
  }
  return false;
}

function isRecordingCommandAdmitted(action) {
  if (!recordingHydrated || rendererQuitCommitted || isInitializing) {
    return false;
  }
  if (recoveryPromptOpen) {
    return false;
  }
  if (!recordBtn || recordBtn.disabled) {
    return false;
  }
  if (action === 'start') {
    return getRecordButtonAction(recordingState) === 'start';
  }
  if (action === 'stop') {
    return getRecordButtonAction(recordingState) === 'stop';
  }
  return false;
}

function isKeyboardShortcutDialogOpen() {
  if (recoveryPromptOpen || isHistoryTitleEditorOpen()) {
    return true;
  }
  if (recordModeMenu && !recordModeMenu.hidden) {
    return true;
  }
  if (typeof document === 'undefined' || !document.querySelectorAll) {
    return false;
  }
  const openModal = Array.from(document.querySelectorAll('.modal-overlay')).some(
    (modal) => !modal.classList.contains('hidden'),
  );
  return openModal;
}

function handleKeyboardShortcut(event) {
  const action = resolveKeyboardShortcutAction(event, { platform: getRendererPlatform() });
  if (!action) {
    return;
  }
  if (shouldSuppressKeyboardShortcut(event, {
    isMenuOpen: Boolean(recordModeMenu && !recordModeMenu.hidden),
    isDialogOpen: isKeyboardShortcutDialogOpen(),
  })) {
    return;
  }
  if (action === 'goto-record' || action === 'goto-history' || action === 'goto-chat' || action === 'goto-settings') {
    event.preventDefault();
    const targetTab = action === 'goto-record'
      ? 'record'
      : action === 'goto-history'
        ? 'history'
        : action === 'goto-chat'
          ? 'chat'
          : 'settings';
    activateTabAndFocusHeading(targetTab);
    return;
  }
  if (action === 'start-recording' || action === 'stop-recording') {
    if (!canRunKeyboardRecordingCommand(action)) {
      return;
    }
    event.preventDefault();
    if (action === 'start-recording') {
      void startRecording('mic-and-desktop');
    } else {
      void stopRecording();
    }
  }
}

function applyKeyboardShortcutDiscovery() {
  const platform = getRendererPlatform();
  const displays = {
    'goto-record': getKeyboardShortcutDisplay('goto-record', { platform }),
    'goto-history': getKeyboardShortcutDisplay('goto-history', { platform }),
    'goto-chat': getKeyboardShortcutDisplay('goto-chat', { platform }),
    'goto-settings': getKeyboardShortcutDisplay('goto-settings', { platform }),
    'start-recording': getKeyboardShortcutDisplay('start-recording', { platform }),
    'stop-recording': getKeyboardShortcutDisplay('stop-recording', { platform }),
  };
  const railRecord = document.querySelector('.rail-btn[data-tab="record"]');
  if (railRecord) {
    railRecord.setAttribute('aria-keyshortcuts', getKeyboardShortcutAria('goto-record', { platform }));
    railRecord.title = `Record page (${displays['goto-record']})`;
  }
  const railHistory = document.querySelector('.rail-btn[data-tab="history"]');
  if (railHistory) {
    railHistory.setAttribute('aria-keyshortcuts', getKeyboardShortcutAria('goto-history', { platform }));
    railHistory.title = `History (${displays['goto-history']})`;
  }
  const railChat = document.querySelector('.rail-btn[data-tab="chat"]');
  if (railChat) {
    railChat.setAttribute('aria-keyshortcuts', getKeyboardShortcutAria('goto-chat', { platform }));
    railChat.title = `Chat (${displays['goto-chat']})`;
  }
  const railSettings = document.querySelector('.rail-btn[data-tab="settings"]');
  if (railSettings) {
    railSettings.setAttribute('aria-keyshortcuts', getKeyboardShortcutAria('goto-settings', { platform }));
    railSettings.title = `Settings (${displays['goto-settings']})`;
  }
  if (recordBtn) {
    const startDisplay = displays['start-recording'];
    const stopDisplay = displays['stop-recording'];
    recordBtn.setAttribute('aria-keyshortcuts', `${getKeyboardShortcutAria('start-recording', { platform })} ${getKeyboardShortcutAria('stop-recording', { platform })}`);
    recordBtn.title = `Start Recording (${startDisplay}) / Stop (${stopDisplay})`;
  }
  document.querySelectorAll('[data-shortcut-display]').forEach((el) => {
    const action = el.getAttribute('data-shortcut-display');
    if (action && displays[action]) {
      el.textContent = displays[action];
    }
  });
  const note = document.getElementById('keyboard-shortcuts-note');
  if (note) {
    note.textContent = 'Works while AvaNevis is focused. Start Recording captures mic and desktop audio; use its dropdown menu for single-source modes.';
  }
}

function setupKeyboardShortcuts() {
  if (setupKeyboardShortcuts._bound) {
    return;
  }
  setupKeyboardShortcuts._bound = true;
  document.addEventListener('keydown', handleKeyboardShortcut);
  applyKeyboardShortcutDiscovery();
  document.querySelectorAll('.settings-subnav a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (event) => {
      const targetId = link.getAttribute('href').slice(1);
      const section = document.getElementById(targetId);
      if (!section) {
        return;
      }
      event.preventDefault();
      activateTab('settings');
      section.scrollIntoView({ block: 'start', behavior: getPreferredScrollBehavior() });
      const heading = section.querySelector('h3');
      if (heading) {
        if (!heading.hasAttribute('tabindex')) {
          heading.setAttribute('tabindex', '-1');
        }
        heading.focus({ preventScroll: true });
      }
    });
  });
}

function getRendererPlatform() {
  return homePromptContext.platform || inferRendererHostFamily(navigator.platform);
}

function getSelectedDiarizationEngine(diarization) {
  return coerceDiarizationEngineForPlatform(
    selectedDiarizationEngine || resolveSelectedDiarizationEngine(diarization),
    getRendererPlatform(),
  );
}

function applyDiarizationEngineCards({ selectedEngine, platform, arch }) {
  const resolvedPlatform = platform || getRendererPlatform();
  const useStaticSpeakrsText = shouldUseStaticSpeakrsEngineText({ platform: resolvedPlatform });
  const cardNodes = Array.from(document.querySelectorAll('.diarization-engine-card'));
  const states = applyDiarizationEngineCardDomState(
    cardNodes.map((card) => ({ engine: card.dataset.engine })),
    { selectedEngine, platform: resolvedPlatform, arch },
  );
  const catalog = buildDiarizationEngineCards({ platform: resolvedPlatform, arch });
  document.querySelectorAll('.diarization-engine-selector').forEach((selector) => {
    selector.classList.toggle('is-single-engine', catalog.length < 2);
  });
  document.querySelectorAll('[data-speakrs-static]').forEach((staticEl) => {
    staticEl.hidden = !useStaticSpeakrsText;
  });
  cardNodes.forEach((card, index) => {
    const state = states[index];
    const radio = card.querySelector('.diarization-engine-radio');
    if (useStaticSpeakrsText) {
      card.hidden = true;
      card.classList.remove('selected');
      if (radio) {
        radio.checked = false;
        radio.disabled = true;
        radio.tabIndex = -1;
      }
      return;
    }
    card.hidden = Boolean(state && state.hidden);
    if (!state || state.hidden) {
      card.classList.remove('selected');
      if (radio) {
        radio.checked = false;
        radio.disabled = true;
        radio.tabIndex = -1;
      }
      return;
    }
    card.classList.toggle('selected', state.selected);
    if (radio) {
      radio.checked = state.selected;
      radio.removeAttribute('tabIndex');
    }
    const subtitle = card.querySelector('[data-engine-sub], .diarization-engine-card-sub');
    const entry = catalog.find((item) => item.engine === state.engine);
    if (subtitle && entry) {
      subtitle.textContent = entry.subtitle;
    }
  });
  document.querySelectorAll('[data-speakrs-recommended]').forEach((badge) => {
    const speakrsCard = catalog.find((entry) => entry.engine === 'speakrs');
    badge.hidden = !(speakrsCard && speakrsCard.recommended);
  });
}

function applyDiarizationEngineFields(selectedEngine, { unsupported = false } = {}) {
  const fields = shouldOfferDiarizationSetupFields({ engine: selectedEngine, unsupported });
  const showToken = fields.showToken;
  const showSpeakerCount = fields.showSpeakerCount;
  ['diarization-token-field', 'home-diarization-token-field'].forEach((id) => {
    const field = document.getElementById(id);
    if (field) {
      field.hidden = !showToken;
    }
  });
  if (shouldClearDiarizationTokenFields({ selectedEngine })) {
    ['diarization-token-input', 'home-diarization-token-input'].forEach((id) => {
      const input = document.getElementById(id);
      if (input) {
        input.value = '';
      }
    });
  }
  const speakerCountField = document.getElementById('diarization-speaker-count-field');
  if (speakerCountField) {
    speakerCountField.hidden = !showSpeakerCount;
  }
}

function updateHomeAiAddonCTA(aiStatus) {
  const cta = document.getElementById('ai-addon-cta');
  const speakerPrompt = document.getElementById('diarization-setup-prompt');
  const prompt = buildHomeAiAddonPrompt({
    aiStatus,
    platform: getRendererPlatform(),
    cudaInstalled: homePromptContext.cudaInstalled,
    hasNvidiaGpu: homePromptContext.hasNvidiaGpu,
  });

  if (!prompt) {
    if (cta) {
      cta.disabled = true;
      cta.style.display = 'none';
    }
    if (speakerPrompt) speakerPrompt.style.display = 'none';
    return;
  }

  if (prompt.feature === 'diarization' && speakerPrompt) {
    if (cta) {
      cta.disabled = true;
      cta.style.display = 'none';
    }
    const title = document.getElementById('diarization-setup-prompt-title');
    const message = document.getElementById('diarization-setup-prompt-message');
    if (title) title.textContent = prompt.title;
    if (message) message.textContent = prompt.message;
    const selectedEngine = getSelectedDiarizationEngine({ engine: prompt.engine });
    const diarization = aiStatus && aiStatus.features ? aiStatus.features.diarization : null;
    applyDiarizationEngineCards({
      selectedEngine,
      platform: getRendererPlatform(),
      arch: homePromptContext.arch,
    });
    applyDiarizationEngineFields(selectedEngine, {
      unsupported: diarization && diarization.status === 'unsupported',
    });
    const diarizationControlState = buildAiAddonControlState({
      feature: diarization,
      type: 'diarization',
      setupActive: isAiAddonSetupLockingControls({
        featureStatus: diarization && diarization.status,
        progressActive: aiAddonDownloadState.diarization.active,
      }),
      unsupported: diarization && diarization.status === 'unsupported',
      selectedEngine,
    });
    applyDiarizationEngineRadioState(diarizationControlState.canSelectEngine);
    applyAiAddonButtonState({
      setupButton: document.getElementById('home-setup-diarization-btn'),
      controlState: diarizationControlState,
      setupLabel: getActiveDiarizationSetupLabel(diarization, selectedEngine),
      validateLabel: getAiAddonValidateButtonLabel(),
      removeLabel: getAiAddonRemoveButtonLabel(),
    });
    speakerPrompt.style.display = 'flex';
    return;
  }

  if (speakerPrompt) speakerPrompt.style.display = 'none';
  if (!cta) {
    return;
  }
  const title = document.getElementById('ai-addon-cta-title');
  const sub = document.getElementById('ai-addon-cta-sub');
  if (title) title.textContent = prompt.title;
  if (sub) sub.textContent = prompt.message;
  cta.dataset.feature = prompt.feature;
  cta.disabled = false;
  cta.style.display = 'flex';
}

function setupHomeAiAddonCTA() {
  const cta = document.getElementById('ai-addon-cta');
  if (cta) {
    cta.addEventListener('click', openSettingsAtAiAddons);
  }
  setupAiAddonSettingsListeners();
}

function closeInlineTitleEditor({ headingId, editBtnId, formId, editBtnDisplay = '' }) {
  const heading = document.getElementById(headingId);
  const editBtn = document.getElementById(editBtnId);
  const form = document.getElementById(formId);

  if (form) form.style.display = 'none';
  if (heading) heading.style.display = '';
  if (editBtn) editBtn.style.display = editBtnDisplay;
}

function isHistoryTitleEditorOpen() {
  const form = document.getElementById('meeting-title-edit-form');
  return Boolean(form && form.style.display === 'flex');
}

function focusActivityRenameInput({ select = false } = {}) {
  if (!activityRenameMeetingId || !activityListEl) {
    return;
  }
  const selector = `.activity-row[data-meeting-id="${CSS.escape(activityRenameMeetingId)}"] .activity-rename-input`;
  const input = activityListEl.querySelector(selector);
  if (!input) {
    return;
  }
  input.focus({ preventScroll: true });
  if (select) {
    input.select();
  }
}

function restoreInlineTitleEditorFocus() {
  const historyInput = document.getElementById('meeting-title-input');
  if (
    historyInput
    && shouldRestoreInlineEditorFocus({
      editorOpen: isHistoryTitleEditorOpen(),
      activeElement: document.activeElement,
      isEditorControl: document.activeElement === historyInput,
      doc: document,
    })
  ) {
    historyInput.focus({ preventScroll: true });
  }
}

// Settings persistence
const SETTINGS_KEY = 'avanevis-settings';

// Load settings from localStorage
function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch (error) {
    console.error('Failed to load settings:', error);
    return {};
  }
}

// Save settings to localStorage
function saveSettings(settings) {
  try {
    const current = loadSettings();
    const updated = { ...current, ...settings };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

function saveTranscriptionEnginePreferences(preferences) {
  // Remove the retired flat fields as part of the one-time settings migration.
  saveSettings({ ...preferences, language: undefined, modelSize: undefined });
}

// v2.10 transcription policy (Small/Medium/Large v3 + 11 languages).
// Loaded from src/transcription-policy.js via script tag; falls back to the
// same curated defaults when the global is unavailable (e.g. syntax checks).
function resolveTranscriptionPolicy() {
  if (typeof window !== 'undefined' && window.transcriptionPolicy) {
    return window.transcriptionPolicy;
  }
  return null;
}

function ensureLanguageChoiceOption() {
  if (!languageSelect || languageSelect.querySelector('option[value=""]')) {
    return;
  }
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose language…';
  languageSelect.prepend(placeholder);
}

function snapshotTranscriptionSelection() {
  return snapshotEngineSelection(transcriptionEnginePreferences);
}

function validateNewTranscriptionSelection(language, modelSize) {
  const policy = resolveTranscriptionPolicy();
  if (!policy || typeof policy.validateNewSelection !== 'function') {
    return { ok: true, language, modelSize };
  }
  return policy.validateNewSelection({ language, modelSize });
}

function reportUnsupportedTranscriptionSelection(validation) {
  const message = (validation && validation.message)
    || 'Choose a supported transcription language and Whisper model.';
  addLog(`Error: ${message}`, 'error');
  setTranscriptMessage(message, true);
}

function persistTranscriptionEnginePreferences(updates = {}) {
  transcriptionEnginePreferences = updateTranscriptionEnginePreferences(
    transcriptionEnginePreferences,
    updates,
  );
  saveTranscriptionEnginePreferences(transcriptionEnginePreferences);
  syncWhisperPreferencesToControls();
  renderRecordingEngineControls();
  renderTranscriptionEngineSettings();
  return transcriptionEnginePreferences;
}

function syncWhisperPreferencesToControls() {
  const preferences = transcriptionEnginePreferences.whisper || {};
  if (!preferences.language) {
    ensureLanguageChoiceOption();
    languageSelect.value = '';
  } else {
    languageSelect.value = preferences.language;
  }
  modelSelect.value = preferences.modelSize || 'small';
}

function renderRecordingEngineControls() {
  const parakeetActive = transcriptionEnginePreferences.activeEngine === 'parakeet';
  if (whisperLanguageSetup) whisperLanguageSetup.hidden = parakeetActive;
  if (whisperModelSetup) whisperModelSetup.hidden = parakeetActive;
  if (transcriptionEngineStatic) transcriptionEngineStatic.hidden = !parakeetActive;
}

// Apply saved settings to UI controls
function applySavedSettings(devices = {}, hostFamily = 'unknown') {
  const settings = loadSettings();
  const policy = resolveTranscriptionPolicy();
  const enginePreferences = normalizeTranscriptionEnginePreferences(settings, policy);
  transcriptionEnginePreferences = enginePreferences.preferences;
  if (enginePreferences.shouldPersist) {
    saveTranscriptionEnginePreferences(transcriptionEnginePreferences);
  }
  const normalized = policy && typeof policy.normalizePreferences === 'function'
    ? policy.normalizePreferences(transcriptionEnginePreferences.whisper)
    : {
      language: transcriptionEnginePreferences.whisper.language || 'en',
      modelSize: transcriptionEnginePreferences.whisper.modelSize || 'small',
      migrated: false,
      requiresChoice: false,
      normalizedLarge: false,
    };

  micSelect.value = resolveInitialDeviceSelection({
    savedId: settings.micId,
    defaultId: devices.defaults?.default_input,
    devices: devices.inputs,
  });
  desktopSelect.value = resolveInitialDeviceSelection({
    savedId: settings.desktopId,
    defaultId: devices.defaults?.default_output,
    devices: decorateDesktopDevices(devices.loopbacks, hostFamily),
  });

  if (normalized.requiresChoice || !normalized.language) {
    // Removed/unknown language (e.g. saved Persian) must not silently fall
    // back to English: force an explicit choice for new work.
    ensureLanguageChoiceOption();
    languageSelect.value = '';
    addLog('Saved transcription language is no longer offered; choose a supported language.', 'warning');
    setTranscriptMessage('Saved transcription language is no longer offered; choose a supported language.', false);
  } else {
    languageSelect.value = normalized.language;
  }

  modelSelect.value = normalized.modelSize || 'small';
  if (normalized.migrated) {
    // Tiny/Base retire once to Small with a visible explanation.
    persistTranscriptionEnginePreferences({ whisper: {
      language: transcriptionEnginePreferences.whisper.language,
      modelSize: 'small',
    } });
    addLog('Tiny/Base Whisper models retired; migrated saved preference to Small.', 'warning');
  }

  // A retired language remains an explicit choice for Whisper even while
  // Parakeet is active; do not silently replace that saved preference.
  if (!normalized.requiresChoice && normalized.language
      && normalized.language !== transcriptionEnginePreferences.whisper.language) {
    transcriptionEnginePreferences = updateTranscriptionEnginePreferences(transcriptionEnginePreferences, {
      whisper: { language: normalized.language },
    });
    saveTranscriptionEnginePreferences(transcriptionEnginePreferences);
  }
  renderRecordingEngineControls();
  renderTranscriptionEngineSettings();

  const summaryProfileSelect = document.getElementById('summary-profile-select');
  if (summaryProfileSelect && settings.summaryProfile) {
    summaryProfileSelect.value = settings.summaryProfile;
  }
}

// Initialize app with first-time setup
// Initialize app with first-time setup
async function init() {
  const loadingScreen = document.getElementById('loading-screen');
  const loadingMessage = document.getElementById('loading-message');

  // Helper to update loading message
  const updateLoading = (message) => {
    if (loadingMessage) {
      loadingMessage.textContent = message;
    }
  };

  // Show initializing state
  setRecordingState('initializing');
  statusText.textContent = 'Initializing...';

  try {
    startupCudaCheckPromise = checkGPUStatus().catch((error) => {
      console.warn('Startup CUDA/GPU check failed:', error);
    });

    // Start audio warm-up in background immediately
    const warmUpPromise = window.electronAPI.warmUpAudioSystem()
      .catch(err => console.error('Audio warm-up failed:', err));

    // Step 1: Check if model is downloaded
    updateLoading('Checking system setup...');
    const settings = loadSettings();
    const startupPolicy = resolveTranscriptionPolicy();
    const startupEnginePreferences = normalizeTranscriptionEnginePreferences(settings, startupPolicy);
    if (startupEnginePreferences.shouldPersist) {
      saveTranscriptionEnginePreferences(startupEnginePreferences.preferences);
    }
    if (startupEnginePreferences.preferences.activeEngine === 'whisper') {
      const startupNormalized = startupPolicy && typeof startupPolicy.normalizePreferences === 'function'
        ? startupPolicy.normalizePreferences(startupEnginePreferences.preferences.whisper)
        : {
          language: startupEnginePreferences.preferences.whisper.language,
          modelSize: startupEnginePreferences.preferences.whisper.modelSize,
          normalizedLarge: false,
        };
      const modelSize = startupNormalized.modelSize || 'small';

      addLog('Checking system setup...');
      const modelCheck = await window.electronAPI.checkModelDownloaded(modelSize);

      if (!modelCheck.downloaded) {
        // Hide loading screen before showing first-time setup
        if (loadingScreen) {
          loadingScreen.classList.add('hidden');
          setTimeout(() => loadingScreen.remove(), 300);
        }

        // First-time setup: Download the selected Whisper model.
        await showFirstTimeSetup(modelSize);
      }
    } else {
      addLog('Parakeet is selected. Its readiness is checked in Settings; setup never starts automatically.');
    }

    // Hide loading screen immediately to show UI
    if (loadingScreen && !loadingScreen.classList.contains('hidden')) {
      updateLoading('Ready!');
      loadingScreen.classList.add('hidden');
      setTimeout(() => loadingScreen.remove(), 300);
    }

    // Step 2: Wait for audio system warm-up (while UI is visible)
    addLog('Initializing audio system...');
    statusText.textContent = 'Initializing audio...';
    
    await warmUpPromise;

    // Step 3: Load audio devices
    addLog('Loading audio devices...');
    await loadAudioDevices();

    // Resume an in-progress capture before slower history/AI work so a reload
    // mid-init still exposes Stop & Transcribe.
    isInitializing = false;
    if (recordingState === 'initializing') {
      setRecordingState('idle');
    }
    await ensureRecordingHydration();

    // Step 4: Load meeting history + Activity queue snapshot
    await loadMeetingHistory({ scan: true });
    if (typeof window.electronAPI.getTranscriptionQueueState === 'function') {
      try {
        const queueState = await window.electronAPI.getTranscriptionQueueState();
        applyTranscriptionQueueState(queueState);
      } catch (queueError) {
        console.warn('Could not load transcription queue state:', queueError);
        renderActivityList();
      }
    } else {
      renderActivityList();
    }

    if (startupCudaCheckPromise) {
      await startupCudaCheckPromise;
      startupCudaCheckPromise = null;
    } else {
      await refreshHomePrompts();
    }
    await refreshHomeAiAddonPrompt();

    if (recordingState === 'idle' && recordingHydrated) {
      addLog('Ready to record!');
      refreshIdleStatusPill();
    }
    console.log('App initialized');

  } catch (error) {
    console.error('Initialization error:', error);
    addLog(`Initialization error: ${error.message}`, 'error');
    isInitializing = false;
    if (recordingState === 'initializing') {
      setRecordingState('idle');
    }

    // Hide loading screen on error
    if (loadingScreen) {
      loadingScreen.classList.add('hidden');
      setTimeout(() => loadingScreen.remove(), 300);
    }
  } finally {
    // Never leave a recreated renderer idle while main is still capturing.
    isInitializing = false;
    await ensureRecordingHydration();
  }
}

// First-time setup: Download model with progress UI
// First-time setup: Download model with progress UI
async function showFirstTimeSetup(modelSize) {
  addLog(`First-time setup: Downloading AI model (${modelSize})...`);

  const modal = document.getElementById('ftue-modal');
  const progressBar = document.getElementById('ftue-progress-bar');
  const progressText = document.getElementById('ftue-progress-text');
  const logOutput = document.getElementById('ftue-log-output');

  if (!modal) return;

  modal.classList.remove('hidden');
  progressText.textContent = 'Downloading Whisper model…';

  const cancelBtn = document.getElementById('ftue-cancel-download-btn');
  let downloadCanceled = false;
  const onCancelClick = async () => {
    downloadCanceled = true;
    if (cancelBtn) {
      cancelBtn.disabled = true;
    }
    progressText.textContent = 'Cancelling download…';
    try {
      await window.electronAPI.cancelDownloadModel();
    } catch (_error) {
      // Best-effort; the download promise will settle with a cancel error.
    }
  };
  if (cancelBtn) {
    cancelBtn.disabled = false;
    cancelBtn.addEventListener('click', onCancelClick);
  }

  // Listen for progress updates
  const cleanupModelDownloadProgress = registerCleanup(window.electronAPI.onModelDownloadProgress((data) => {
    logOutput.textContent += data;
    logOutput.scrollTop = logOutput.scrollHeight;

    // Update progress text with meaningful messages
    if (data.includes('Loading')) {
      progressText.textContent = 'Loading model configuration…';
    } else if (data.includes('Downloading')) {
      progressText.textContent = 'Downloading model files (this may take a few minutes)…';
    } else if (data.includes('Model loaded') || data.includes('successfully')) {
      progressText.textContent = 'Model ready.';
    }
  }));

  // Simulate progress (we don't get real download progress)
  let progress = 0;
  const progressInterval = setInterval(() => {
    if (progress < 90) {
      progress += Math.random() * 3;
      progressBar.style.width = `${Math.min(progress, 90)}%`;
    }
  }, 1000);

  try {
    // Download model
    await window.electronAPI.downloadModel(modelSize);

    // Complete
    clearInterval(progressInterval);
    progressBar.style.width = '100%';
    progressText.textContent = 'Setup complete.';

    addLog('Whisper model downloaded.');

    // Wait a moment then remove overlay
    await new Promise(resolve => setTimeout(resolve, 1500));
    modal.classList.add('hidden');
    if (recoveryPromptQueued) {
      applyRecoveryPromptView();
    }
  } catch (error) {
    clearInterval(progressInterval);
    const canceled = downloadCanceled
      || /canceled|cancelled/i.test(String(error && error.message ? error.message : error));
    progressText.textContent = canceled ? 'Download cancelled' : 'Setup failed.';
    logOutput.textContent += `\nERROR: ${error.message}`;

    addLog(
      canceled
        ? 'Model download was cancelled. You can download it later from Settings.'
        : 'Model download failed. You can try again from Settings.',
      canceled ? 'warning' : 'error',
    );

    // Wait for user to see error, then continue anyway
    await new Promise(resolve => setTimeout(resolve, 3000));
    modal.classList.add('hidden');
    if (recoveryPromptQueued) {
      applyRecoveryPromptView();
    }
  } finally {
    clearInterval(progressInterval);
    if (cancelBtn) {
      cancelBtn.removeEventListener('click', onCancelClick);
      cancelBtn.disabled = false;
    }
    cleanupModelDownloadProgress();
  }
}

// Create setup overlay UI (similar to GPU installation)


// Load audio devices
async function loadAudioDevices() {
  try {
    addLog('Loading audio devices...');
    const devices = await window.electronAPI.getAudioDevices();
    const hostFamily = inferRendererHostFamily(navigator.platform);

    // Check if no input devices found (likely permission issue on macOS)
    if (devices.inputs.length === 0) {
      const guidance = getEmptyMicrophoneDeviceGuidance(hostFamily);

      addLog(guidance.logMessage, 'error');
      if (guidance.openSettings && guidance.confirmMessage) {
        const shouldOpenSettings = confirm(guidance.confirmMessage);
        if (shouldOpenSettings) {
          window.electronAPI.openSystemSettings(guidance.openSettings);
        }
      }
    }

    // Populate microphone dropdown
    populateSelect(micSelect, 'Select microphone...', devices.inputs);
    populateSelect(
      desktopSelect,
      'Select desktop audio...',
      decorateDesktopDevices(devices.loopbacks, hostFamily),
    );

    addLog(`Found ${devices.inputs.length} microphones and ${devices.loopbacks.length} loopback devices`);

    // Restore a persisted choice when present; otherwise initialize from the
    // host default only if that exact device is available in this refresh.
    applySavedSettings(devices, hostFamily);
  } catch (error) {
    console.error('Failed to load devices:', error);
    addLog(`Error: ${error.message}`, 'error');
  }
}

// Load meeting history
async function loadMeetingHistory({ scan = false } = {}) {
  if (scan) {
    try {
      const scanResult = await window.electronAPI.scanRecordings();
      if (scanResult.added > 0) {
        addLog(`Found ${scanResult.added} recording(s) not in database`);
      }
    } catch (scanError) {
      console.warn('Scan failed:', scanError);
    }
  }

  const requestEpoch = ++meetingHistoryRequestEpoch;
  try {
    const loadedMeetings = await window.electronAPI.listMeetings();
    if (requestEpoch !== meetingHistoryRequestEpoch) return;
    meetings = loadedMeetings;
    if (meetingSearchQueryNormalized) {
      void runHistorySearch(meetingSearchQuery);
    } else {
      renderMeetingList();
    }
    renderActivityList();
    const emptyDetail = document.getElementById('meeting-details-empty');
    if (!currentMeetingId && emptyDetail) emptyDetail.style.display = meetings.length ? 'flex' : 'none';
  } catch (error) {
    if (requestEpoch !== meetingHistoryRequestEpoch) return;
    console.error('Failed to load meeting history:', error);
    setPlaceholder(meetingList, 'Could not load recordings. Refresh to try again.');
    renderActivityList();
    return;
  }
}

function applyTagPillView(btn, labelEl, rawTag, { untaggedLabel = 'Add tag' } = {}) {
  if (!btn || !labelEl) return;
  const meta = getTagMeta(rawTag);
  if (meta) {
    btn.classList.remove('is-untagged');
    btn.dataset.tag = meta.slug;
    labelEl.textContent = meta.label;
    btn.title = `Tag: ${meta.label}`;
  } else {
    btn.classList.add('is-untagged');
    delete btn.dataset.tag;
    labelEl.textContent = untaggedLabel;
    btn.title = 'Add a recording tag';
  }
}

function closeActiveTagPopover({ restoreFocus = false } = {}) {
  if (!activeOpenTagPopover) return;
  const { triggerBtn, popoverEl } = activeOpenTagPopover;
  activeOpenTagPopover = null;
  if (popoverEl) popoverEl.hidden = true;
  if (triggerBtn) {
    triggerBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus && triggerBtn.isConnected) {
      triggerBtn.focus({ preventScroll: true });
    }
  }
}

function toggleTagPickerPopover({ triggerBtn, popoverEl, currentTag = null, rightAlign = false, activityMeetingId = null, onSelect }) {
  if (!triggerBtn || !popoverEl) return;
  if (activeOpenTagPopover && activeOpenTagPopover.popoverEl === popoverEl && !popoverEl.hidden) {
    closeActiveTagPopover({ restoreFocus: false });
    return;
  }
  closeActiveTagPopover({ restoreFocus: false });

  clearElement(popoverEl);
  popoverEl.classList.toggle('is-right-aligned', Boolean(rightAlign));

  const optionButtons = [];
  for (const tag of RECORDING_TAGS) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'recording-tag-option';
    opt.dataset.tag = tag.slug;
    opt.setAttribute('role', 'option');
    const selected = currentTag === tag.slug;
    opt.classList.toggle('is-selected', selected);
    opt.setAttribute('aria-selected', String(selected));
    const dot = document.createElement('span');
    dot.className = 'recording-tag-dot';
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'recording-tag-option-label';
    text.textContent = tag.label;
    opt.append(dot, text);
    opt.addEventListener('click', (event) => {
      event.stopPropagation();
      closeActiveTagPopover({ restoreFocus: true });
      void Promise.resolve(onSelect(tag.slug));
    });
    popoverEl.appendChild(opt);
    optionButtons.push(opt);
  }

  if (currentTag) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'recording-tag-clear-btn';
    clearBtn.setAttribute('role', 'option');
    clearBtn.setAttribute('aria-selected', 'false');
    clearBtn.textContent = 'Clear tag';
    clearBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeActiveTagPopover({ restoreFocus: true });
      void Promise.resolve(onSelect(null));
    });
    popoverEl.appendChild(clearBtn);
    optionButtons.push(clearBtn);
  }

  popoverEl.onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeActiveTagPopover({ restoreFocus: true });
      return;
    }
    const idx = optionButtons.indexOf(document.activeElement);
    if (!optionButtons.length) return;
    let nextIdx = -1;
    if (event.key === 'ArrowRight') nextIdx = (idx + 1) % optionButtons.length;
    else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + optionButtons.length) % optionButtons.length;
    else if (event.key === 'ArrowDown') nextIdx = Math.min(optionButtons.length - 1, idx < 0 ? 0 : idx + 2);
    else if (event.key === 'ArrowUp') nextIdx = Math.max(0, idx < 0 ? 0 : idx - 2);
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = optionButtons.length - 1;
    if (nextIdx >= 0) {
      event.preventDefault();
      optionButtons[nextIdx]?.focus({ preventScroll: true });
    }
  };

  popoverEl.hidden = false;
  triggerBtn.setAttribute('aria-expanded', 'true');
  activeOpenTagPopover = { triggerBtn, popoverEl, activityMeetingId };
  const positionPopover = () => {
    if (activeOpenTagPopover?.popoverEl !== popoverEl) return;
    const trigger = triggerBtn.getBoundingClientRect();
    const popup = popoverEl.getBoundingClientRect();
    const left = rightAlign ? trigger.right - popup.width : trigger.left;
    const below = trigger.bottom + 6;
    const top = below + popup.height <= window.innerHeight - 12 ? below : trigger.top - popup.height - 6;
    popoverEl.style.left = `${Math.max(12, Math.min(left, window.innerWidth - popup.width - 12))}px`;
    popoverEl.style.top = `${Math.max(12, Math.min(top, window.innerHeight - popup.height - 12))}px`;
  };
  positionPopover();
  requestAnimationFrame(positionPopover);
  const initialFocus = optionButtons.find((btn) => btn.classList.contains('is-selected')) || optionButtons[0];
  requestAnimationFrame(() => {
    if (activeOpenTagPopover?.popoverEl === popoverEl && initialFocus?.isConnected) {
      initialFocus.focus({ preventScroll: true });
    }
  });
}

function renderRecordingTagControl() {
  const btn = document.getElementById('recording-tag-btn');
  const label = document.getElementById('recording-tag-btn-label');
  applyTagPillView(btn, label, selectedRecordingTag, { untaggedLabel: 'Add tag' });
}

function renderHistoryTagFilterBar() {
  const bar = document.getElementById('history-tag-filter-bar');
  if (!bar) return;

  const used = getUsedRecordingTags(meetings);
  if (activeHistoryTagFilter && !used.some((entry) => entry.slug === activeHistoryTagFilter)) {
    activeHistoryTagFilter = null;
  }

  if (used.length === 0) {
    bar.hidden = true;
    clearElement(bar);
    return;
  }

  bar.hidden = false;
  clearElement(bar);

  const applyFilter = (tag) => {
    activeHistoryTagFilter = tag;
    renderHistoryTagFilterBar();
    if (normalizeHistorySearchQuery(meetingSearchQuery)) {
      clearTimeout(meetingSearchDebounceTimer);
      meetingSearchDebounceTimer = null;
      void runHistorySearch(meetingSearchQuery);
    } else {
      renderMeetingList();
    }
  };

  const allChip = document.createElement('button');
  allChip.type = 'button';
  allChip.className = 'history-tag-filter-chip';
  allChip.classList.toggle('is-active', !activeHistoryTagFilter);
  allChip.setAttribute('aria-pressed', String(!activeHistoryTagFilter));
  allChip.textContent = 'All';
  allChip.addEventListener('click', () => applyFilter(null));
  bar.appendChild(allChip);

  for (const tag of used) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'history-tag-filter-chip';
    chip.dataset.tag = tag.slug;
    const isActive = activeHistoryTagFilter === tag.slug;
    chip.classList.toggle('is-active', isActive);
    chip.setAttribute('aria-pressed', String(isActive));
    const dot = document.createElement('span');
    dot.className = 'recording-tag-dot';
    dot.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.textContent = tag.shortLabel;
    chip.append(dot, text);
    chip.addEventListener('click', () => applyFilter(isActive ? null : tag.slug));
    bar.appendChild(chip);
  }
}

function updateSummaryTagMismatchBanner(meeting) {
  const banner = document.getElementById('summary-tag-mismatch-banner');
  const textEl = document.getElementById('summary-tag-mismatch-text');
  const regenBtn = document.getElementById('summary-tag-mismatch-regenerate');
  if (!banner || !textEl || !regenBtn) return;

  const displayedSummary = document.getElementById('meeting-summary')?.dataset.markdown || '';
  const mismatch = getSummaryTagMismatch(
    meeting && typeof meeting.summary !== 'string'
      ? { ...meeting, summary: displayedSummary }
      : meeting,
  );
  const namesChanged = Boolean((meeting?.summary || displayedSummary)
    && haveSummarySpeakerNamesChanged(meeting, meeting?.speakerNamesHash));
  if (!mismatch && !namesChanged) {
    banner.hidden = true;
    return;
  }

  textEl.textContent = [
    mismatch && `Tag changed to ${mismatch.currentLabel}.`,
    namesChanged && 'Speaker names changed since this summary was generated.',
  ].filter(Boolean).join(' ');
  regenBtn.textContent = mismatch ? `Regenerate with ${mismatch.currentLabel} format` : 'Regenerate with current names';
  banner.hidden = false;
}

async function commitMeetingTagChange(meetingId, nextTag) {
  const targetId = String(meetingId || '');
  if (!targetId) return;
  const version = (meetingTagMutationVersions.get(targetId) || 0) + 1;
  meetingTagMutationVersions.set(targetId, version);
  try {
    const updated = await window.electronAPI.updateMeeting(targetId, { tag: nextTag });
    if (meetingTagMutationVersions.get(targetId) !== version) return;
    const resolvedTag = updated ? normalizeTag(updated.tag) : normalizeTag(nextTag);
    const idx = findMeetingIndexById(targetId);
    const merged = { ...(idx !== -1 ? meetings[idx] : {}), ...updated, tag: resolvedTag };
    if (idx !== -1) meetings[idx] = merged;
    if (currentRecordingMeeting && meetingIdsEqual(currentRecordingMeeting.id, targetId)) {
      currentRecordingMeeting = { ...currentRecordingMeeting, ...updated, tag: resolvedTag };
    }
    if (meetingIdsEqual(currentMeetingId, targetId)) {
      applyTagPillView(document.getElementById('meeting-tag-btn'), document.getElementById('meeting-tag-btn-label'), resolvedTag);
      updateSummaryTagMismatchBanner(merged);
    }
    renderHistoryTagFilterBar();
    renderMeetingList();
    renderActivityList();
    if (meetingSearchQueryNormalized || meetingSearchDebounceTimer) {
      clearTimeout(meetingSearchDebounceTimer);
      meetingSearchDebounceTimer = null;
      void runHistorySearch(meetingSearchQuery);
    }
    if (chatState.popoverOpen) renderScopePopover();
  } catch (error) {
    if (meetingTagMutationVersions.get(targetId) !== version) return;
    console.error('Failed to update recording tag:', error);
    showAppToast(`Could not update tag: ${error.message}`, 'error');
  }
}

async function runHistorySearch(rawQuery) {
  const normalized = normalizeHistorySearchQuery(rawQuery);
  meetingSearchQuery = rawQuery || '';
  meetingSearchQueryNormalized = normalized.toLowerCase();
  const epoch = ++meetingSearchEpoch;

  if (!normalized) {
    meetingSearchResults = null;
    renderMeetingList();
    return;
  }

  try {
    if (window.electronAPI && typeof window.electronAPI.searchHistory === 'function') {
      const response = await window.electronAPI.searchHistory({
        query: normalized,
        limit: 50,
        maxMatches: 3,
        ...(activeHistoryTagFilter ? { tags: [activeHistoryTagFilter] } : {}),
      });
      if (epoch !== meetingSearchEpoch) {
        return;
      }
      meetingSearchResults = Array.isArray(response && response.meetings)
        ? response.meetings
        : [];
      renderMeetingList();
      return;
    }
  } catch (error) {
    console.warn('History search failed, falling back to title filter:', error);
  }

  if (epoch !== meetingSearchEpoch) {
    return;
  }
  meetingSearchResults = null;
  renderMeetingList();
}

// Render meeting list
function renderMeetingList() {
  renderHistoryTagFilterBar();
  const query = meetingSearchQueryNormalized;
  const filtered = !query
    ? filterMeetingsByTag(meetings, activeHistoryTagFilter)
    : (Array.isArray(meetingSearchResults)
      ? mergeSearchResultsWithMeetings(meetings, { meetings: meetingSearchResults }, { tag: activeHistoryTagFilter })
      : fallbackFilterMeetingsByTitle(meetings, query, { tag: activeHistoryTagFilter }));

  if (filtered.length === 0) {
    setPlaceholder(
      meetingList,
      meetings.length === 0 ? 'No recordings yet. Record audio or import a file.' : 'No matching recordings',
    );
    updateSelectionToolbar();
    restoreInlineTitleEditorFocus();
    return;
  }

  clearElement(meetingList);

  // Defense-in-depth: Track rendered IDs to skip duplicates from backend
  const renderedIds = new Set();

  filtered.forEach((meeting) => {
    if (renderedIds.has(meeting.id)) {
      console.warn(`Skipping duplicate meeting ID in render: ${meeting.id}`);
      return;
    }
    renderedIds.add(meeting.id);

    const item = createMeetingListItem(meeting);
    if (checkedMeetingIds.has(String(meeting.id))) {
      item.classList.add('checked');
      const cb = item.querySelector('.meeting-checkbox');
      if (cb) {
        cb.classList.add('checked');
        cb.setAttribute('aria-checked', 'true');
      }
    }
    if (currentMeetingId !== null && String(currentMeetingId) === String(meeting.id)) {
      item.classList.add('selected');
    }
    meetingList.appendChild(item);
  });

  updateSelectionToolbar();
  restoreInlineTitleEditorFocus();
}

// ---- Multi-select state for meetings ----
function toggleMeetingChecked(meetingId) {
  const id = String(meetingId);
  if (checkedMeetingIds.has(id)) {
    checkedMeetingIds.delete(id);
  } else {
    checkedMeetingIds.add(id);
  }

  const item = meetingList.querySelector(`.meeting-item[data-id="${CSS.escape(id)}"]`);
  if (item) {
    const isChecked = checkedMeetingIds.has(id);
    item.classList.toggle('checked', isChecked);
    const cb = item.querySelector('.meeting-checkbox');
    if (cb) {
      cb.classList.toggle('checked', isChecked);
      cb.setAttribute('aria-checked', String(isChecked));
    }
  }

  updateSelectionToolbar();
}

function clearMeetingSelection() {
  checkedMeetingIds.clear();
  meetingList.querySelectorAll('.meeting-item.checked').forEach((el) => {
    el.classList.remove('checked');
    const cb = el.querySelector('.meeting-checkbox');
    if (cb) {
      cb.classList.remove('checked');
      cb.setAttribute('aria-checked', 'false');
    }
  });
  updateSelectionToolbar();
}

function updateSelectionToolbar() {
  const toolbar = document.getElementById('selection-toolbar');
  const countEl = document.getElementById('selection-count-text');
  if (!toolbar || !countEl) return;

  const count = checkedMeetingIds.size;
  toolbar.classList.toggle('visible', count > 0);
  meetingList.classList.toggle('selection-mode', count > 0);
  countEl.textContent = `${count} selected`;
}

async function deleteCheckedMeetings() {
  if (checkedMeetingIds.size === 0) return;

  const ids = [...checkedMeetingIds];
  const confirmMsg = ids.length === 1
    ? 'Delete the selected recording? This cannot be undone.'
    : `Delete ${ids.length} selected recordings? This cannot be undone.`;
  if (!confirm(confirmMsg)) return;

  // Release audio player file lock if a checked meeting is currently playing
  const audioPlayer = document.getElementById('audio-player');
  if (audioPlayer && audioPlayer.src) {
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
    if (typeof window.__resetCustomAudioPlayer === 'function') {
      window.__resetCustomAudioPlayer();
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 300));

  const failures = [];
  for (const id of ids) {
    try {
      await window.electronAPI.deleteMeeting(id);
    } catch (error) {
      console.error(`Failed to delete meeting ${id}:`, error);
      failures.push({ id, message: error.message });
    }
  }

  if (currentMeetingId && ids.includes(String(currentMeetingId))) {
    meetingDetails.style.display = 'none';
    document.getElementById('meeting-details-empty').style.display = 'flex';
    currentMeetingId = null;
    clearHistorySpeakers();
  }

  meetings = meetings.filter((m) => !ids.includes(String(m.id)));
  checkedMeetingIds.clear();
  renderMeetingList();

  await loadMeetingHistory();

  if (failures.length === 0) {
    addLog(`Deleted ${ids.length} recording${ids.length === 1 ? '' : 's'}.`);
  } else {
    addLog(
      `Deleted ${ids.length - failures.length} of ${ids.length} recordings (${failures.length} failed).`,
      'error',
    );
    alert(`Some recordings could not be deleted:\n\n${failures.map((f) => `- ${f.id}: ${f.message}`).join('\n')}`);
  }
}

// Select meeting from history
async function selectMeeting(meetingId) {
  const targetId = String(meetingId);
  const meeting = meetings.find((m) => String(m.id) === targetId);
  if (!meeting) {
    console.error(`Meeting not found: ${targetId}`);
    return;
  }

  if (shouldSkipMeetingReselect({
    currentMeetingId,
    nextMeetingId: targetId,
    titleEditorOpen: isHistoryTitleEditorOpen(),
  })) {
    return;
  }

  if (currentMeetingId !== null && String(currentMeetingId) !== targetId) {
    document.dispatchEvent(new Event('history-selection-changed'));
  }

  document.querySelectorAll('.meeting-item').forEach((item) => {
    item.classList.toggle('selected', item.dataset.id === targetId);
  });

  currentMeetingId = targetId;
  updateSummaryLanguageCaptions(meeting);

  // Show meeting details
  closeActiveTagPopover({ restoreFocus: false });
  document.getElementById('meeting-title').textContent = meeting.title;
  document.getElementById('meeting-date').textContent = formatDate(meeting.date);
  document.getElementById('meeting-duration').textContent = meeting.duration;
  applyTagPillView(
    document.getElementById('meeting-tag-btn'),
    document.getElementById('meeting-tag-btn-label'),
    meeting.tag,
  );
  closeInlineTitleEditor({
    headingId: 'meeting-title',
    editBtnId: 'meeting-title-edit',
    formId: 'meeting-title-edit-form',
  });

  setMeetingAudioSource(meeting.audioPath);

  // Show details panel immediately while transcript loads in the background
  document.getElementById('meeting-details-empty').style.display = 'none';
  meetingDetails.style.display = 'flex';

  const transcriptEl = document.getElementById('meeting-transcript');
  const retryBtn = document.getElementById('retry-transcription-btn');
  const retryWhisperBtn = document.getElementById('retry-whisper-transcription-btn');
  transcriptEl.classList.remove('markdown-body');
  clearHistorySpeakers();
  delete transcriptEl.dataset.markdown;
  clearElement(transcriptEl);
  renderSummaryMarkdown('');
  updateSummaryTagMismatchBanner(null);
  if (retryBtn) {
    retryBtn.style.display = isMeetingTranscriptionRetryable(meeting) ? 'inline-flex' : 'none';
    retryBtn.disabled = false;
    retryBtn.textContent = 'Retry transcription';
  }
  if (retryWhisperBtn) {
    retryWhisperBtn.hidden = !isMeetingTranscriptionRetryable(meeting);
    retryWhisperBtn.disabled = false;
  }
  activateHistoryDetailTab(activeHistoryDetailTab);
  const loading = document.createElement('p');
  loading.className = 'placeholder';
  loading.textContent = 'Loading transcript...';
  transcriptEl.appendChild(loading);
  await refreshMeetingDetails(targetId);
}

async function refreshMeetingDetails(targetId) {
  const requestEpoch = ++meetingDetailRequestEpoch;
  const transcriptEl = document.getElementById('meeting-transcript');
  const retryBtn = document.getElementById('retry-transcription-btn');
  const retryWhisperBtn = document.getElementById('retry-whisper-transcription-btn');
  try {
    const fullMeeting = await window.electronAPI.getMeeting(targetId);

    if (!fullMeeting || currentMeetingId !== targetId || requestEpoch !== meetingDetailRequestEpoch) {
      return;
    }
    applyTagPillView(
      document.getElementById('meeting-tag-btn'),
      document.getElementById('meeting-tag-btn-label'),
      fullMeeting.tag,
    );
    updateSummaryLanguageCaptions(fullMeeting);
    if (retryBtn) {
      retryBtn.style.display = isMeetingTranscriptionRetryable(fullMeeting) ? 'inline-flex' : 'none';
      retryBtn.disabled = false;
      retryBtn.textContent = 'Retry transcription';
    }
    if (retryWhisperBtn) {
      retryWhisperBtn.hidden = !isMeetingTranscriptionRetryable(fullMeeting);
      retryWhisperBtn.disabled = false;
    }
    clearElement(transcriptEl);

    const pending = fullMeeting.transcriptionStatus === 'pending';
    const transcript = String(fullMeeting.transcript || '');
    const generatedPlaceholder = /^# Recording Awaiting Transcription\s*\n/.test(transcript)
      && transcript.includes('The recording was saved successfully, but a transcript is not available yet.');
    if (transcript && !(pending && generatedPlaceholder)) {
      transcriptEl.dataset.markdown = transcript;
      const segments = parseTranscriptMarkdownSegments(transcript);
      renderHistorySpeakers(fullMeeting, segments);
      renderHistoryTranscriptMarkdown(transcriptEl, transcript, segments);
    } else {
      clearHistorySpeakers();
      delete transcriptEl.dataset.markdown;
      clearElement(transcriptEl);
      if (!pending) {
        const empty = document.createElement('p');
        empty.className = 'placeholder';
        empty.textContent = 'No transcript available';
        transcriptEl.appendChild(empty);
      }
    }
    if (pending) {
      const waiting = document.createElement('p');
      waiting.className = 'placeholder'; waiting.textContent = 'Awaiting transcription';
      transcriptEl.appendChild(waiting);
      const activity = document.createElement('button');
      activity.type = 'button'; activity.className = 'btn btn-small'; activity.textContent = 'View in Activity';
      activity.addEventListener('click', () => {
        activateTab('record');
        const row = activityListEl.querySelector(`.activity-row[data-meeting-id="${CSS.escape(targetId)}"]`);
        const title = row?.querySelector('.activity-row-title');
        if (title) { title.scrollIntoView({ block: 'nearest', behavior: getPreferredScrollBehavior() }); title.focus(); }
      });
      transcriptEl.appendChild(activity);
    }
    renderMeetingDiarizationStatus(fullMeeting, transcriptEl);
    const transcriptionStatusMessage = getMeetingTranscriptionStatusMessage(fullMeeting);
    if (transcriptionStatusMessage && !pending) {
      const statusMessage = document.createElement('p');
      statusMessage.className = fullMeeting.transcriptionStatus === 'failed' ? 'placeholder error' : 'placeholder';
      statusMessage.textContent = transcriptionStatusMessage;
      transcriptEl.appendChild(statusMessage);
    }

    if (fullMeeting.summary) {
      renderSummaryMarkdown(fullMeeting.summary, { stale: fullMeeting.summaryStale });
    } else {
      showSummaryMessage('No summary yet. Click Generate summary once Summaries & Chat is set up in Settings.');
    }
    updateSummaryTagMismatchBanner(fullMeeting);
  } catch (error) {
    console.error(`Failed to load meeting transcript: ${error.message}`);
    if (currentMeetingId === targetId && requestEpoch === meetingDetailRequestEpoch) {
      clearHistorySpeakers();
      clearElement(transcriptEl);
      delete transcriptEl.dataset.markdown;
      const err = document.createElement('p');
      err.className = 'placeholder error';
      err.textContent = 'Failed to load transcript. The saved recording is still available above.';
      transcriptEl.appendChild(err);
      showSummaryMessage('Summary unavailable because this recording could not be loaded.', true);
    }
  } finally {
    restoreInlineTitleEditorFocus();
  }

}

// ============================================================================
// Inline rename: meeting title (history detail + post-recording transcript)
// ============================================================================

// Reflects currentRecordingMeeting (kept for summary/history sync after enqueue).
function applyCurrentRecordingTitle() {
  // Home Activity replaced the post-recording transcript title card.
}

// Wires an inline-rename UI for a heading + pencil button + form trio.
// `getMeeting()` returns the meeting being renamed (history detail uses
// `currentMeetingId`, post-recording uses `currentRecordingMeeting`).
// `onSaved(updated)` fires after a successful update so callers can refresh
// any local caches and the meeting list.
function wireInlineTitleEditor({
  rowId, headingId, editBtnId, formId, inputId, cancelBtnId,
  getMeeting, onSaved,
}) {
  const row = document.getElementById(rowId);
  const heading = document.getElementById(headingId);
  const editBtn = document.getElementById(editBtnId);
  const form = document.getElementById(formId);
  const input = document.getElementById(inputId);
  const cancelBtn = document.getElementById(cancelBtnId);

  if (!row || !heading || !editBtn || !form || !input || !cancelBtn) return;

  let suppressClickAwaySave = false;
  let commitInFlight = false;

  const enterEditMode = () => {
    const meeting = getMeeting();
    if (!meeting) return;
    suppressClickAwaySave = false;
    input.value = meeting.title || '';
    heading.style.display = 'none';
    editBtn.style.display = 'none';
    form.style.display = 'flex';
    // Two frames: a just-shown input is not reliably focusable on Windows Electron.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        input.focus({ preventScroll: true });
        input.select();
      });
    });
  };

  const exitEditMode = () => {
    form.style.display = 'none';
    heading.style.display = '';
    // editBtn visibility is governed by the caller (e.g. post-recording hides
    // it until a meeting exists). We only restore it if the caller wanted it
    // visible — defer to applyCurrentRecordingTitle / selectMeeting to set it.
    editBtn.style.display = '';
    if (formId === 'meeting-title-edit-form') document.dispatchEvent(new Event('history-title-edit-finished'));
  };

  editBtn.addEventListener('click', (e) => {
    e.preventDefault();
    enterEditMode();
  });

  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    suppressClickAwaySave = true;
    exitEditMode();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      suppressClickAwaySave = true;
      exitEditMode();
    }
  });

  const commitTitleEdit = async () => {
    if (commitInFlight) {
      return;
    }
    const meeting = getMeeting();
    if (!meeting) {
      exitEditMode();
      return;
    }
    const editedMeetingId = String(meeting.id);
    const newTitle = (input.value || '').trim();
    if (!newTitle || newTitle === meeting.title) {
      exitEditMode();
      return;
    }
    commitInFlight = true;
    try {
      const updated = await window.electronAPI.updateMeeting(meeting.id, { title: newTitle });
      if (!updated || !updated.title) {
        throw new Error('Recording was not found.');
      }

      const activeMeeting = getMeeting();
      if (activeMeeting && String(activeMeeting.id) === editedMeetingId) {
        heading.textContent = updated.title;
      }
      if (typeof onSaved === 'function') onSaved(updated);
      addLog(`Renamed recording to "${updated.title}"`);
    } catch (err) {
      console.error('Rename failed:', err);
      addLog(`Could not rename recording: ${err.message}`, 'error');
      alert(`Could not rename recording: ${err.message}`);
    } finally {
      commitInFlight = false;
      const activeMeeting = getMeeting();
      if (activeMeeting && String(activeMeeting.id) === editedMeetingId) {
        exitEditMode();
      }
    }
  };

  form.addEventListener('focusout', (e) => {
    if (suppressClickAwaySave) {
      return;
    }
    if (form.style.display !== 'flex') {
      return;
    }
    if (e.relatedTarget && (form.contains(e.relatedTarget) || e.relatedTarget.id === 'import-audio-button'
      || (formId === 'meeting-title-edit-form' && e.relatedTarget.id === 'import-audio-rail-button'))) {
      return;
    }
    void commitTitleEdit();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await commitTitleEdit();
  });
}

function setupTitleEditors() {
  // History detail panel
  wireInlineTitleEditor({
    rowId: 'meeting-title-row',
    headingId: 'meeting-title',
    editBtnId: 'meeting-title-edit',
    formId: 'meeting-title-edit-form',
    inputId: 'meeting-title-input',
    cancelBtnId: 'meeting-title-cancel',
    getMeeting: () => findMeetingById(currentMeetingId),
    onSaved: (updated) => {
      applyMeetingTitleLocally(updated);
      const titleEl = document.getElementById('meeting-title');
      if (titleEl && meetingIdsEqual(currentMeetingId, updated.id)) {
        titleEl.textContent = updated.title;
      }
    },
  });
}

// Setup event listeners
function setupEventListeners() {
  if (setupEventListeners._bound) {
    return;
  }
  setupEventListeners._bound = true;

  refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
    setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
    loadAudioDevices();
  });
  refreshHistory.addEventListener('click', () => {
    refreshHistory.classList.add('spinning');
    setTimeout(() => refreshHistory.classList.remove('spinning'), 600);
    loadMeetingHistory({ scan: true });
  });
  recordBtn.addEventListener('click', handleRecordButtonClick);
  if (recordModeToggle && recordModeMenu) {
    recordModeToggle.addEventListener('click', () => {
      if (recordingState !== 'idle') return;
      if (recordModeMenu.hidden) {
        openRecordModeMenu();
      } else {
        closeRecordModeMenu({ restoreFocus: true });
      }
    });

    // Escape must work with focus on the toggle too, not only inside the menu.
    recordModeToggle.addEventListener('keydown', (event) => {
      if (recordModeMenu.hidden) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRecordModeMenu({ restoreFocus: true });
      }
    });

    recordModeMenu.addEventListener('click', (event) => {
      const mode = event.target?.closest?.('[data-capture-mode]')?.dataset?.captureMode;
      if (!mode) return;
      // Lifecycle guard: a menu left open by a state change must never start a
      // recording. The toggle is also disabled and the menu force-closed by
      // updateControlsState() for every non-idle state.
      if (recordingState !== 'idle') {
        closeRecordModeMenu({ restoreFocus: true });
        return;
      }
      closeRecordModeMenu({ restoreFocus: true });
      void startRecording(mode);
    });

    recordModeMenu.addEventListener('keydown', (event) => {
      const items = getRecordModeMenuItems();
      const decision = resolveRecordModeMenuKeyAction({
        key: event.key,
        itemCount: items.length,
        activeIndex: items.indexOf(document.activeElement),
        isOpen: !recordModeMenu.hidden,
      });

      if (decision.preventDefault) {
        event.preventDefault();
      }
      if (decision.action === 'close') {
        closeRecordModeMenu({ restoreFocus: decision.restoreFocus });
      } else if (decision.action === 'focus') {
        items[decision.focusIndex]?.focus();
      }
    });

    // Dismiss on any outside interaction, and whenever focus leaves the split
    // control entirely (click-away, window blur, programmatic focus moves).
    document.addEventListener('pointerdown', (event) => {
      if (recordModeMenu.hidden) return;
      if (recordModeMenu.contains(event.target) || recordModeToggle.contains(event.target)) {
        return;
      }
      closeRecordModeMenu({ restoreFocus: false });
    });
    document.addEventListener('focusin', (event) => {
      if (recordModeMenu.hidden) return;
      if (recordModeMenu.contains(event.target) || recordModeToggle.contains(event.target)) {
        return;
      }
      closeRecordModeMenu({ restoreFocus: false });
    });
    window.addEventListener('blur', () => closeRecordModeMenu({ restoreFocus: false }));
  }
  if (discardRecordingBtn) {
    discardRecordingBtn.addEventListener('click', () => {
      void discardRecording();
    });
  }
  if (resumePendingBtn) {
    resumePendingBtn.addEventListener('click', () => {
      void resumePendingTranscriptionsFromBanner();
    });
  }
  if (deleteMeeting) {
    deleteMeeting.addEventListener('click', () => deleteMeetingHandler(currentMeetingId));
  }

  // Copy transcript from meeting details
  const copyTranscriptBtn = document.getElementById('copy-transcript-btn');
  if (copyTranscriptBtn) {
    copyTranscriptBtn.addEventListener('click', copyMeetingTranscript);
  }

  // Save transcript from meeting details (history)
  const saveMeetingTranscriptBtn = document.getElementById('save-meeting-transcript-btn');
  if (saveMeetingTranscriptBtn) {
    saveMeetingTranscriptBtn.addEventListener('click', saveMeetingTranscriptToFile);
  }

  const retryTranscriptionBtn = document.getElementById('retry-transcription-btn');
  if (retryTranscriptionBtn) {
    retryTranscriptionBtn.addEventListener('click', retryMeetingTranscription);
  }
  setupWhisperRetryDialog();
  setupTranscriptExportDialog();

  const generateSummaryBtn = document.getElementById('generate-summary-btn');
  if (generateSummaryBtn) {
    generateSummaryBtn.addEventListener('click', () => handleSummaryGenerationButtonClick(currentMeetingId, generateSummaryBtn));
  }

  const regenerateSummaryBtn = document.getElementById('regenerate-summary-btn');
  if (regenerateSummaryBtn) {
    regenerateSummaryBtn.addEventListener('click', () => handleSummaryGenerationButtonClick(currentMeetingId, regenerateSummaryBtn));
  }

  const copySummaryBtn = document.getElementById('copy-summary-btn');
  if (copySummaryBtn) {
    copySummaryBtn.addEventListener('click', copyMeetingSummary);
  }

  const saveSummaryBtn = document.getElementById('save-summary-btn');
  if (saveSummaryBtn) {
    saveSummaryBtn.addEventListener('click', saveMeetingSummaryToFile);
  }

  setupHistoryDetailTabs();

  const meetingTagBtn = document.getElementById('meeting-tag-btn');
  const meetingTagPopover = document.getElementById('meeting-tag-popover');
  if (meetingTagBtn && meetingTagPopover) {
    meetingTagBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const active = findMeetingById(currentMeetingId);
      toggleTagPickerPopover({
        triggerBtn: meetingTagBtn,
        popoverEl: meetingTagPopover,
        currentTag: normalizeTag(active && active.tag),
        onSelect: async (nextTag) => {
          if (currentMeetingId) {
            await commitMeetingTagChange(currentMeetingId, nextTag);
          }
        },
      });
    });
  }

  const recordingTagBtn = document.getElementById('recording-tag-btn');
  const recordingTagPopover = document.getElementById('recording-tag-popover');
  if (recordingTagBtn && recordingTagPopover) {
    renderRecordingTagControl();
    recordingTagBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleTagPickerPopover({
        triggerBtn: recordingTagBtn,
        popoverEl: recordingTagPopover,
        currentTag: selectedRecordingTag,
        rightAlign: true,
        onSelect: (nextTag) => {
          selectedRecordingTag = nextTag;
          if (recordingState !== 'idle') {
            activeRecordingTag = nextTag;
          }
          renderRecordingTagControl();
        },
      });
    });
  }

  const summaryMismatchRegenBtn = document.getElementById('summary-tag-mismatch-regenerate');
  if (summaryMismatchRegenBtn) {
    summaryMismatchRegenBtn.addEventListener('click', () => {
      if (summaryGenerationMeetingId || summaryMismatchRegenBtn.disabled) return;
      const targetBtn = document.getElementById('regenerate-summary-btn') || summaryMismatchRegenBtn;
      void handleSummaryGenerationButtonClick(currentMeetingId, targetBtn);
    });
  }

  document.addEventListener('pointerdown', (event) => {
    if (!activeOpenTagPopover) return;
    const { triggerBtn, popoverEl } = activeOpenTagPopover;
    if (popoverEl?.contains(event.target) || triggerBtn?.contains(event.target)) {
      return;
    }
    closeActiveTagPopover({ restoreFocus: false });
  });

  window.addEventListener('resize', () => closeActiveTagPopover());
  window.addEventListener('scroll', (event) => {
    if (activeOpenTagPopover && !activeOpenTagPopover.popoverEl.contains(event.target)) closeActiveTagPopover();
  }, true);
  document.addEventListener('focusout', (event) => {
    if (!activeOpenTagPopover || !event.relatedTarget) return;
    const { triggerBtn, popoverEl } = activeOpenTagPopover;
    if (!triggerBtn.contains(event.relatedTarget) && !popoverEl.contains(event.relatedTarget)) closeActiveTagPopover();
  });

  // Meeting search filter
  const searchInput = document.getElementById('meeting-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const rawValue = searchInput.value || '';
      const normalized = normalizeHistorySearchQuery(rawValue);
      meetingSearchQuery = rawValue;
      if (meetingSearchDebounceTimer) {
        clearTimeout(meetingSearchDebounceTimer);
        meetingSearchDebounceTimer = null;
      }
      if (!normalized) {
        meetingSearchEpoch += 1;
        meetingSearchQueryNormalized = '';
        meetingSearchResults = null;
        renderMeetingList();
        return;
      }
      meetingSearchDebounceTimer = setTimeout(() => {
        meetingSearchDebounceTimer = null;
        void runHistorySearch(rawValue);
      }, MEETING_SEARCH_DEBOUNCE_MS);
    });
  }

  // Selection toolbar
  const selClear = document.getElementById('selection-clear');
  if (selClear) selClear.addEventListener('click', clearMeetingSelection);
  const selDelete = document.getElementById('selection-delete');
  if (selDelete) selDelete.addEventListener('click', deleteCheckedMeetings);

  // Save settings when selections change
  micSelect.addEventListener('change', () => {
    saveSettings({ micId: micSelect.value });
  });

  desktopSelect.addEventListener('change', () => {
    saveSettings({ desktopId: desktopSelect.value });
  });

  languageSelect.addEventListener('change', () => {
    persistTranscriptionEnginePreferences({ whisper: { language: languageSelect.value } });
  });

  modelSelect.addEventListener('change', () => {
    persistTranscriptionEnginePreferences({ whisper: { modelSize: modelSelect.value } });
  });

  // Listen for progress updates
  registerCleanup(window.electronAPI.onRecordingProgress((data) => {
    const message = typeof data === 'string' ? data : data && data.message;
    if (!message) {
      return;
    }

    addLog(message);

    // Update status + button honesty during post-processing (stopping state)
    if (recordingState === 'stopping') {
      lastStopProgressMessage = message;
      statusText.textContent = message;
      const textEl = recordBtn && recordBtn.querySelector('.button-text');
      if (textEl) {
        textEl.textContent = getRecordButtonLabel('stopping', message);
      }
    }
  }));

  if (typeof window.electronAPI.onAppQuitProgress === 'function') {
  registerCleanup(window.electronAPI.onAppQuitProgress((payload) => {
    // Quit cancellation reopens recording admission; the cancelled payload
    // carries no log message by design.
    if (payload && payload.code === 'QUIT_CANCELLED') {
      rendererQuitCommitted = false;
      updateButtonUI();
      updateControlsState();
      return;
    }
    rendererQuitCommitted = true;
    if (closeSummaryLanguageConfirmation) closeSummaryLanguageConfirmation(null);
      updateButtonUI();
      updateControlsState();
      const message = typeof payload === 'string' ? payload : payload && payload.message;
      if (!message) {
        return;
      }
      addLog(message);
      if (recordingState === 'idle' || recordingState === 'stopping') {
        statusText.textContent = message;
      }
    }));
  }

  if (typeof window.electronAPI.onRecordingSavedDuringQuit === 'function') {
    registerCleanup(window.electronAPI.onRecordingSavedDuringQuit((payload) => {
      const message = payload && payload.message
        ? payload.message
        : 'Recording saved during quit attempt. Open History to continue.';
      addLog(message, 'warning');
      stopTimer();
      if (audioVisualizer) {
        audioVisualizer.stop();
      }
      setTranscriptMessage(message, false);
      setRecordingState('idle');
      loadMeetingHistory({ scan: true }).catch((error) => {
        console.warn('Could not refresh history after quit-saved recording:', error);
      });
    }));
  }

  registerCleanup(window.electronAPI.onRecordingInitProgress((progress) => {
    if (progress.stage === 'started') {
      return;
    }

    // Show detailed progress during recording initialization
    addLog(progress.message);
    statusText.textContent = progress.message;
  }));

  registerCleanup(window.electronAPI.onTranscriptionProgress((data) => {
    // Payload remains a raw string (IPC contract). Attribute via activeMeetingId.
    const activeId = transcriptionQueueState.activeMeetingId;
    if (activeId) {
      addLog(`[${activeId}] ${data}`);
    } else {
      addLog(data);
    }
  }));

  if (typeof window.electronAPI.onTranscriptionQueueState === 'function') {
    registerCleanup(window.electronAPI.onTranscriptionQueueState((payload) => {
      if (!applyTranscriptionQueueState(payload)) {
        return;
      }
      // Reload History only when a job newly reaches a terminal status — main
      // keeps terminal rows in the session payload, so a naive "any terminal"
      // check reloads on every publish after the first completion.
      const jobs = payload && Array.isArray(payload.jobs) ? payload.jobs : [];
      const seenIds = new Set();
      let hasNewTerminalTransition = false;
      for (const job of jobs) {
        const meetingId = String(job && job.meetingId || '').trim();
        const status = String(job && job.status || '');
        if (!meetingId) {
          continue;
        }
        seenIds.add(meetingId);
        const isTerminal = status === 'ready' || status === 'failed' || status === 'cancelled';
        if (!isTerminal) {
          lastSeenTerminalTranscriptionStatuses.delete(meetingId);
          continue;
        }
        if (lastSeenTerminalTranscriptionStatuses.get(meetingId) !== status) {
          hasNewTerminalTransition = true;
          lastSeenTerminalTranscriptionStatuses.set(meetingId, status);
          if (status === 'ready') showCompletionToast(job);
          if (String(currentMeetingId) === meetingId) {
            void refreshMeetingDetails(meetingId);
          }
        }
      }
      for (const meetingId of [...lastSeenTerminalTranscriptionStatuses.keys()]) {
        if (!seenIds.has(meetingId)) {
          lastSeenTerminalTranscriptionStatuses.delete(meetingId);
        }
      }
      if (hasNewTerminalTransition) {
        loadMeetingHistory().catch((error) => {
          console.warn('Could not refresh history after queue-state update:', error);
        });
      }
    }));
  }

  if (window.electronAPI.onDiarizationProgress) {
    registerCleanup(window.electronAPI.onDiarizationProgress((progress) => {
      if (progress && progress.message) {
        addLog(progress.message);
      }
    }));
  }

  if (window.electronAPI.onSummaryProgress) {
    registerCleanup(window.electronAPI.onSummaryProgress((progress) => {
      if (progress && progress.message) {
        addLog(progress.message);
      }
    }));
  }

  registerCleanup(window.electronAPI.onAudioLevels((levels) => {
    if (levels?.sessionId != null && activeRecordingSessionId != null && levels.sessionId !== activeRecordingSessionId) {
      return;
    }
    if (audioVisualizer && recordingState === 'recording') {
      audioVisualizer.updateLevels(levels);
    }
  }));

  // FIX 3 & 4: Listen for recording warnings (heartbeat lost)
  registerCleanup(window.electronAPI.onRecordingWarning((warning) => {
    if (warning?.sessionId != null && activeRecordingSessionId != null && warning.sessionId !== activeRecordingSessionId) {
      console.warn('Ignoring stale recording warning:', warning);
      return;
    }
    console.error('Recording warning:', warning);
    addLog(`⚠️ ${warning.message}`, warning.level === 'error' ? 'error' : 'warning');

    if (warning.help) {
      addLog(warning.help, 'warning');
    }

    if (warning.type === 'heartbeat_lost') {
      statusText.textContent = 'Warning: Recording may be paused';
      statusIndicator.style.backgroundColor = '#f59e0b';
    } else if (recordingState === 'initializing' || recordingState === 'countdown') {
      statusText.textContent = warning.message;
    }
  }));

  registerCleanup(window.electronAPI.onRecordingFailed((failure) => {
    if (failure?.sessionId != null && activeRecordingSessionId != null && failure.sessionId !== activeRecordingSessionId) {
      console.warn('Ignoring stale recording failure:', failure);
      return;
    }

    if (recordingState === 'stopping' || recordingState === 'cancelling') {
      console.warn('Ignoring recording failure during stop/cancel flow:', failure);
      return;
    }

    console.error('Recording failed:', failure);
    addLog(`Recording failed: ${failure.message}`, 'error');
    if (failure.help) {
      addLog(failure.help, 'warning');
    }

    stopTimer();
    if (audioVisualizer) {
      audioVisualizer.stop();
    }
    setTranscriptMessage(`Recording failed: ${failure.message}`, true);
    setRecordingState('idle');
  }));

  initUpdateUi();

  // Check if user has recorded before (for timeout settings)
  const settings = loadSettings();
  if (settings.hasRecordedBefore) {
    isFirstRecording = false;
  }
}

// Handle record button click
function handleRecordButtonClick() {
  switch (getRecordButtonAction(recordingState)) {
    case 'start':
      if (!isRecordingCommandAdmitted('start')) {
        return;
      }
      startRecording('mic-and-desktop');
      break;
    case 'stop':
      if (!isRecordingCommandAdmitted('stop')) {
        return;
      }
      stopRecording();
      break;
    default:
      break;
  }
}

// Set recording state and update UI
function cancelActiveCountdown() {
  if (typeof activeCountdownCancel === 'function') {
    activeCountdownCancel();
    activeCountdownCancel = null;
  }
}

function setRecordingState(state) {
  const previousState = recordingState;
  if (state === 'idle') {
    cancelActiveCountdown();
    activeRecordingSessionId = null;
    recordingStartTime = null;
    frozenPresenceElapsedText = null;
    stopTimer();
    if (timer) {
      timer.textContent = '00:00';
    }
  }

  recordingState = state;
  updateButtonUI();
  updateControlsState();
  updateRecordingPresenceUI();
  if (typeof renderUpdateUi === 'function') {
    renderUpdateUi();
  }

  // Capture returned to idle: re-query so a deferred once-per-launch prompt can claim.
  if (shouldRequeryRecoveryAfterCaptureIdle(previousState, state)) {
    void queryRecordingRecoveryState();
  }
}

function updateRecordingPresenceUI(elapsedTextOverride = null) {
  if (!recordingPresenceEl) {
    return;
  }

  let elapsedText = elapsedTextOverride;
  if (elapsedText == null) {
    if (recordingState === 'stopping' || recordingState === 'cancelling') {
      // Prefer a frozen clock; omit the time entirely when startedAt is unknown
      // so hydration does not invent a cosmetic 00:00.
      elapsedText = frozenPresenceElapsedText || null;
    } else if (recordingState === 'recording' && Number.isFinite(recordingStartTime)) {
      elapsedText = formatElapsedDuration((Date.now() - recordingStartTime) / 1000);
    } else if (recordingState === 'recording') {
      elapsedText = '00:00';
    } else {
      elapsedText = null;
    }
  }

  const view = getRecordingPresenceView(recordingState, elapsedText);
  recordingPresenceEl.hidden = !view.visible;
  recordingPresenceEl.classList.remove('recording', 'stopping', 'cancelling');
  if (view.modifier) {
    recordingPresenceEl.classList.add(view.modifier);
  }
  if (recordingPresenceLabel) {
    recordingPresenceLabel.textContent = view.label;
  }
  if (recordingPresenceTime) {
    if (view.timeText) {
      recordingPresenceTime.hidden = false;
      recordingPresenceTime.textContent = view.timeText;
    } else {
      recordingPresenceTime.hidden = true;
    }
  }

  updateRecordingRecoveryBanner();
  applyRecoveryPromptView();
}

function isFtueModalOpen() {
  const modal = document.getElementById('ftue-modal');
  return Boolean(modal && !modal.classList.contains('hidden'));
}

function updateRecordingRecoveryBanner() {
  if (!recoveryBannerEl) {
    return;
  }
  const view = getRecoveryBannerView(recoveryState, recordingState, formatBytes);
  recoveryBannerEl.hidden = !view.visible;
  recoveryBannerEl.classList.remove('available', 'recovering', 'error');
  if (view.modifier) {
    recoveryBannerEl.classList.add(view.modifier);
  }
  if (recoveryBannerText) {
    recoveryBannerText.textContent = view.text || '';
  }
  if (recoveryBannerSpinner) {
    recoveryBannerSpinner.hidden = !view.showSpinner;
  }
  if (recoveryBannerPrimary) {
    if (view.primaryAction) {
      recoveryBannerPrimary.hidden = false;
      recoveryBannerPrimary.textContent = view.primaryAction;
      recoveryBannerPrimary.disabled = recoveryActionBusy || recordingState !== 'idle';
    } else {
      recoveryBannerPrimary.hidden = true;
    }
  }
  if (recoveryBannerSecondary) {
    if (view.secondaryAction) {
      recoveryBannerSecondary.hidden = false;
      recoveryBannerSecondary.textContent = view.secondaryAction;
      recoveryBannerSecondary.disabled = recoveryActionBusy;
    } else {
      recoveryBannerSecondary.hidden = true;
    }
  }
}

function applyRecoveryPromptView() {
  if (!recoveryModalEl) {
    return;
  }
  const view = getRecoveryPromptView(recoveryState, formatBytes);
  if (!view.visible) {
    if (recoveryPromptOpen) {
      closeRecoveryPrompt({ deferred: false });
    }
    return;
  }
  // Queue behind FTUE or live capture — do not burn/show a blocking modal mid-recording.
  if (isFtueModalOpen() || recordingState !== 'idle') {
    recoveryPromptQueued = true;
    if (recoveryPromptOpen) {
      closeRecoveryPrompt({ deferred: true });
    }
    return;
  }
  openRecoveryPrompt(view);
}

function openRecoveryPrompt(view) {
  if (!recoveryModalEl || recoveryPromptOpen) {
    return;
  }
  recoveryPromptQueued = false;
  recoveryPromptOpen = true;
  recoveryFocusRestoreEl = document.activeElement;
  if (recoveryModalTitle) recoveryModalTitle.textContent = view.title || '';
  if (recoveryModalBody) recoveryModalBody.textContent = view.body || '';
  if (recoveryModalDetail) recoveryModalDetail.textContent = view.detail || '';
  if (recoveryModalFooter) recoveryModalFooter.textContent = view.footer || '';
  if (recoveryModalCandidateList) {
    recoveryModalCandidateList.replaceChildren();
    (view.candidateLines || []).forEach((line) => {
      const item = document.createElement('li');
      item.textContent = line;
      recoveryModalCandidateList.appendChild(item);
    });
  }
  if (recoveryModalNowBtn) {
    recoveryModalNowBtn.textContent = view.primaryLabel || 'Recover Now';
    recoveryModalNowBtn.disabled = recoveryActionBusy || recordingState !== 'idle';
  }
  if (recoveryModalLaterBtn) {
    recoveryModalLaterBtn.textContent = view.secondaryLabel || 'Later';
    recoveryModalLaterBtn.disabled = recoveryActionBusy;
  }
  recoveryModalEl.classList.remove('hidden');
  const focusables = getRecoveryModalFocusables();
  (focusables[0] || recoveryModalLaterBtn || recoveryModalNowBtn)?.focus();
}

function getRecoveryModalFocusables() {
  if (!recoveryModalEl) {
    return [];
  }
  return [
    recoveryModalLaterBtn,
    recoveryModalNowBtn,
  ].filter((el) => el && !el.disabled && el.offsetParent !== null);
}

function trapRecoveryModalFocus(event) {
  if (!recoveryPromptOpen || event.key !== 'Tab') {
    return;
  }
  const focusables = getRecoveryModalFocusables();
  const activeIndex = focusables.indexOf(document.activeElement);
  const action = resolveRecoveryFocusTrapAction(focusables.length, activeIndex, event.shiftKey);
  if (!action.preventDefault) {
    return;
  }
  event.preventDefault();
  if (Number.isInteger(action.focusIndex) && focusables[action.focusIndex]) {
    focusables[action.focusIndex].focus();
  }
}

function closeRecoveryPrompt({ deferred = false } = {}) {
  if (!recoveryModalEl) {
    return;
  }
  recoveryModalEl.classList.add('hidden');
  recoveryPromptOpen = false;
  if (!deferred) {
    recoveryPromptQueued = false;
  }
  const restore = recoveryFocusRestoreEl;
  recoveryFocusRestoreEl = null;
  if (restore && typeof restore.focus === 'function') {
    try {
      restore.focus();
    } catch (_) {
      // Element may be gone after navigation.
    }
  }
}

function applyRecoveryState(nextState) {
  recoveryState = nextState && typeof nextState === 'object'
    ? nextState
    : {
      status: 'idle',
      candidates: [],
      totals: { count: 0, approxBytes: 0 },
      activeCandidateIndex: null,
      failed: [],
      promptEligible: false,
    };
  updateRecordingRecoveryBanner();
  applyRecoveryPromptView();
}

async function queryRecordingRecoveryState() {
  if (!window.electronAPI?.getRecordingRecoveryState) {
    return recoveryState;
  }
  // Single-flight coalesce: concurrent callers share one in-flight query.
  // Only apply the final response, preserving a claimed prompt across refreshes
  // while status remains available.
  if (recoveryQueryPromise) {
    recoveryQueryNeedsRefresh = true;
    return recoveryQueryPromise;
  }

  recoveryQueryPromise = (async () => {
    try {
      let latest = null;
      do {
        recoveryQueryNeedsRefresh = false;
        // eslint-disable-next-line no-await-in-loop
        latest = await window.electronAPI.getRecordingRecoveryState();
        if (latest && latest.promptEligible) {
          recoveryPromptClaimHeld = true;
        }
      } while (recoveryQueryNeedsRefresh);

      applyRecoveryState(mergeClaimedPromptIntoState(latest, recoveryPromptClaimHeld));
      return recoveryState;
    } finally {
      recoveryQueryPromise = null;
    }
  })();
  return recoveryQueryPromise;
}

function invalidateRecordingRecoveryState() {
  // Push payloads are ignored; treat as invalidation only.
  void queryRecordingRecoveryState();
}

async function handleRecoverRecordingAction() {
  if (recoveryActionBusy || recordingState !== 'idle') {
    return;
  }
  recoveryActionBusy = true;
  recoveryPromptClaimHeld = false;
  updateRecordingRecoveryBanner();
  if (recoveryModalNowBtn) recoveryModalNowBtn.disabled = true;
  if (recoveryPromptOpen) {
    closeRecoveryPrompt();
  }
  try {
    const result = await window.electronAPI.recoverRecording();
    if (result && result.success === false) {
      const message = result.message || result.code || 'Recovery could not start.';
      console.warn('Recover recording refused:', message);
      if (typeof addLog === 'function') {
        addLog(message, 'warning');
      }
    }
  } catch (error) {
    console.warn('Recover recording failed:', error);
    if (typeof addLog === 'function') {
      addLog(error?.message || 'Recovery failed', 'warning');
    }
  } finally {
    recoveryActionBusy = false;
    await queryRecordingRecoveryState();
    try {
      await loadMeetingHistory();
    } catch (_) {
      // History refresh is best-effort after recovery.
    }
  }
}

async function handleDeferRecordingRecoveryAction() {
  if (recoveryActionBusy) {
    return;
  }
  recoveryActionBusy = true;
  recoveryPromptClaimHeld = false;
  if (recoveryPromptOpen) {
    closeRecoveryPrompt();
  }
  try {
    const state = await window.electronAPI.deferRecordingRecovery();
    applyRecoveryState(state);
  } catch (error) {
    console.warn('Defer recording recovery failed:', error);
    await queryRecordingRecoveryState();
  } finally {
    recoveryActionBusy = false;
    updateRecordingRecoveryBanner();
  }
}

function setupRecordingRecoveryUi() {
  if (setupRecordingRecoveryUi._bound) {
    return;
  }
  setupRecordingRecoveryUi._bound = true;

  recoveryBannerPrimary?.addEventListener('click', () => {
    void handleRecoverRecordingAction();
  });
  recoveryBannerSecondary?.addEventListener('click', () => {
    void handleDeferRecordingRecoveryAction();
  });
  recoveryModalNowBtn?.addEventListener('click', () => {
    void handleRecoverRecordingAction();
  });
  recoveryModalLaterBtn?.addEventListener('click', () => {
    void handleDeferRecordingRecoveryAction();
  });
  // Backdrop clicks do not consume the once-per-launch prompt (require Later).
  recoveryModalEl?.addEventListener('click', (event) => {
    if (event.target === recoveryModalEl) {
      event.stopPropagation();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (!recoveryPromptOpen) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      void handleDeferRecordingRecoveryAction();
      return;
    }
    trapRecoveryModalFocus(event);
  });
  if (window.electronAPI?.onRecordingRecoveryStateChanged) {
    window.electronAPI.onRecordingRecoveryStateChanged(() => {
      invalidateRecordingRecoveryState();
    });
  }
}

// Update button appearance based on state
function updateDiscardRecordingButtonVisibility() {
  if (!discardRecordingBtn) {
    return;
  }
  const show = shouldShowDiscardRecordingControl(recordingState);
  discardRecordingBtn.hidden = !show;
  discardRecordingBtn.disabled = !show;
}

function updateButtonUI() {
  const button = recordBtn;
  const icon = button.querySelector('.button-icon');
  const text = button.querySelector('.button-text');

  // Remove all state classes
  button.className = 'record-button';

  switch (recordingState) {
    case 'initializing':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = getRecordButtonLabel('initializing') || 'Initializing...';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Initializing...';
      break;

    case 'starting':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = getRecordButtonLabel('starting') || 'Starting...';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Running checks...';
      break;

    case 'idle':
      button.classList.add('idle');
      button.disabled = false;
      icon.textContent = '▶';
      text.textContent = getRecordButtonLabel('idle');
      statusIndicator.classList.remove('recording');
      statusText.textContent = getIdleStatusPillText(transcriptionQueueState);
      break;

    case 'recording':
      button.classList.add('recording');
      button.disabled = false;
      icon.textContent = '■';
      text.textContent = getRecordButtonLabel('recording');
      statusIndicator.classList.add('recording');
      statusText.textContent = getRecordingSourceStatusText(activeCaptureMode);
      lastStopProgressMessage = '';
      break;

    case 'stopping':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = getRecordButtonLabel('stopping', lastStopProgressMessage);
      statusIndicator.classList.remove('recording');
      statusText.textContent = lastStopProgressMessage || 'Saving recording…';
      break;

    case 'cancelling':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = 'Cancelling...';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Cancelling recording…';
      break;

    case 'countdown':
      button.classList.add('processing'); // Use processing style (grey)
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = `Starting in ${countdownValue}...`;
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Preparing...';
      break;

    default:
      // Legacy `transcribing` must not block Start (PR2 unlock).
      button.classList.add('idle');
      button.disabled = false;
      icon.textContent = '▶';
      text.textContent = getRecordButtonLabel('idle');
      statusIndicator.classList.remove('recording');
      statusText.textContent = getIdleStatusPillText(transcriptionQueueState);
      break;
  }

  updateDiscardRecordingButtonVisibility();
  if (!recordingHydrated || rendererQuitCommitted) {
    button.disabled = true;
  }
}

function getRecordModeMenuItems() {
  if (!recordModeMenu) {
    return [];
  }
  return [...recordModeMenu.querySelectorAll('[role="menuitem"]')];
}

function openRecordModeMenu() {
  if (!recordModeToggle || !recordModeMenu || recordModeToggle.disabled) {
    return;
  }
  recordModeMenu.hidden = false;
  recordModeToggle.setAttribute('aria-expanded', 'true');
  getRecordModeMenuItems()[0]?.focus();
}

/**
 * Close the record-source menu. `restoreFocus` returns focus to the disclosure
 * button for keyboard/activation dismissals; it is skipped for click-away and
 * blur so we never steal focus from wherever the user actually went.
 */
function closeRecordModeMenu({ restoreFocus = false } = {}) {
  if (!recordModeToggle || !recordModeMenu || recordModeMenu.hidden) {
    return;
  }
  recordModeMenu.hidden = true;
  recordModeToggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus && !recordModeToggle.disabled) {
    recordModeToggle.focus();
  }
}

// Update other controls based on state
function updateControlsState() {
  const isBusy = recordingState !== 'idle' && recordingState !== 'initializing';
  const lifecycleBlocked = !recordingHydrated || rendererQuitCommitted;

  micSelect.disabled = isBusy || isInitializing || lifecycleBlocked;
  desktopSelect.disabled = isBusy || isInitializing || lifecycleBlocked;
  languageSelect.disabled = isBusy || isInitializing || lifecycleBlocked;
  modelSelect.disabled = isBusy || isInitializing || lifecycleBlocked;
  refreshBtn.disabled = isBusy || isInitializing || lifecycleBlocked;
  if (recordModeToggle) {
    recordModeToggle.disabled = isBusy || isInitializing || lifecycleBlocked;
    if (recordModeToggle.disabled) {
      // Never leave an actionable menu open once the lifecycle leaves idle.
      closeRecordModeMenu({ restoreFocus: false });
    }
  }
}

async function runRecordingPreflightChecks({ micId, desktopId, captureMode }) {
  const report = await window.electronAPI.runRecordingPreflight({
    micId: toOpaqueDeviceId(micId),
    loopbackId: toOpaqueDeviceId(desktopId),
    captureMode,
  });

  report.errors.forEach((message) => addLog(`Preflight error: ${message}`, 'error'));
  report.warnings.forEach((message) => addLog(`Preflight warning: ${message}`, 'warning'));

  if (!report.canStart) {
    if (handleMacOSPermissionFailure(report.permissionStatus)) {
      return false;
    }

    alert(report.errorMessage || 'Recording checks failed.');
    return false;
  }

  if (report.warningMessage) {
    return confirm(report.warningMessage);
  }

  return true;
}

// Start recording with retry logic
async function startRecording(requestedCaptureMode = 'mic-and-desktop') {
  // Normalize once at the renderer boundary so every downstream consumer
  // (device validation, preflight, start IPC, status copy, visualizer) sees the
  // same explicit closed value. Main normalizes and validates again.
  const captureMode = normalizeCaptureMode(requestedCaptureMode);
  const { includeMic, includeDesktop } = getCaptureModeSources(captureMode);
  const micId = micSelect.value;
  const desktopId = desktopSelect.value;

  if (includeMic && !micId) {
    alert('Please select a microphone');
    return;
  }

  if (includeDesktop && !desktopId) {
    alert('Please select a desktop audio source');
    return;
  }

  if (includeDesktop && !includeMic && isDesktopCaptureDisabledSelection(desktopId)) {
    alert('Please select a desktop audio source for a desktop-only recording.');
    return;
  }

  activeCaptureMode = captureMode;
  activeRecordingTag = selectedRecordingTag;

  setRecordingState('starting');

  const epoch = ++startRecordingEpoch;
  discardRequestedForStart = false;
  const isCurrentStartAttempt = () => epoch === startRecordingEpoch;
  const startWasDiscarded = () => (
    discardRequestedForStart || !isCurrentStartAttempt()
  );
  // Stale start continuations must not touch shared UI (countdown / session
  // owned by a newer Start B). Main scopes cancel by generation; mirror that.
  const setIdleIfCurrentStart = () => {
    if (isCurrentStartAttempt()) {
      activeRecordingTag = null;
      setRecordingState('idle');
    }
  };

  try {
    const preflightPassed = await runRecordingPreflightChecks({ micId, desktopId, captureMode });
    if (startWasDiscarded()) {
      addLog('Recording discarded during startup checks.', 'warning');
      setIdleIfCurrentStart();
      return;
    }
    if (!preflightPassed) {
      addLog('Recording canceled by preflight checks.', 'warning');
      setIdleIfCurrentStart();
      return;
    }
  } catch (error) {
    if (startWasDiscarded()) {
      setIdleIfCurrentStart();
      return;
    }
    console.error('Preflight checks failed:', error);
    addLog(`Preflight checks failed: ${error.message}`, 'error');
    setIdleIfCurrentStart();
    return;
  }

  activeRecordingTranscriptionSelection = snapshotTranscriptionSelection();
  const selectionCheck = activeRecordingTranscriptionSelection.engine === 'parakeet'
    ? { ok: true }
    : validateNewTranscriptionSelection(
      activeRecordingTranscriptionSelection.language,
      activeRecordingTranscriptionSelection.modelSize,
    );
  if (!selectionCheck.ok) {
    reportUnsupportedTranscriptionSelection(selectionCheck);
    setIdleIfCurrentStart();
    return;
  }

  // Try up to 2 times with exponential backoff
  const maxAttempts = 2;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;

    try {
      if (startWasDiscarded()) {
        addLog('Recording discarded before start.', 'warning');
        setIdleIfCurrentStart();
        return;
      }

      if (attempt > 1) {
        addLog(`Retrying recording (attempt ${attempt}/${maxAttempts})...`);
        // Wait a moment before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (startWasDiscarded()) {
          setIdleIfCurrentStart();
          return;
        }
      } else {
        addLog('Starting recording...');
      }

      // Start countdown in parallel with backend initialization
      setRecordingState('countdown');

      const { promise: countdownPromise, cancel: cancelCountdown } = startCountdown();
      const recordingPromise = window.electronAPI.startRecording({
        micId: toOpaqueDeviceId(micId),
        loopbackId: toOpaqueDeviceId(desktopId),
        captureMode,
        isFirstRecording: isFirstRecording && attempt === 1, // Only use first-recording timeout on first attempt
        transcriptionSelection: activeRecordingTranscriptionSelection,
      });

      const recordingResult = await recordingPromise;

      if (isStartRecordingResultDiscarded({
        discardRequested: discardRequestedForStart,
        startEpoch: epoch,
        currentEpoch: startRecordingEpoch,
        result: recordingResult,
      })) {
        cancelCountdown();
        // Compensating cancel: Cancel may have won while main was still idle
        // (gate wait), then start later returned success — including when a newer
        // Start B reset discardRequestedForStart (use stale epoch).
        if (shouldIssueCompensatingCancelAfterStart({
          discardRequested: discardRequestedForStart,
          startEpoch: epoch,
          currentEpoch: startRecordingEpoch,
          result: recordingResult,
        })) {
          try {
            const cancelResult = await window.electronAPI.cancelRecording({
              sessionId: recordingResult.sessionId,
            });
            const cancelOutcome = resolveCompensatingCancelOutcome(cancelResult);
            if (!cancelOutcome.ok) {
              if (!isCurrentStartAttempt()) {
                return;
              }
              addLog(
                `Could not confirm cancel after a discarded start: ${cancelOutcome.message}`,
                'error',
              );
              setTranscriptMessage(cancelOutcome.message, true);
              currentAudioFile = null;
              currentRecordingDurationSeconds = 0;
              setRecordingState('cancelling');
              startRecordingPresencePoll();
              return;
            }
          } catch (error) {
            if (!isCurrentStartAttempt()) {
              return;
            }
            addLog(
              `Could not confirm cancel after a discarded start: ${error.message}`,
              'error',
            );
            setTranscriptMessage(
              error.message || 'Could not confirm that the recording was cancelled.',
              true,
            );
            currentAudioFile = null;
            currentRecordingDurationSeconds = 0;
            if (isRecordingStopInProgressError(error)) {
              setRecordingState('stopping');
              startRecordingPresencePoll();
              return;
            }
            setRecordingState('cancelling');
            startRecordingPresencePoll();
            return;
          }
        }
        if (!isCurrentStartAttempt()) {
          return;
        }
        addLog('Recording cancelled during startup.', 'warning');
        currentAudioFile = null;
        currentRecordingDurationSeconds = 0;
        setIdleIfCurrentStart();
        return;
      }

      if (recordingResult?.code === 'RECORDER_BUSY') {
        cancelCountdown();
        addLog('Recording start ignored because the recorder is already busy.', 'warning');
        setIdleIfCurrentStart();
        return;
      }

      if (recordingResult?.success === false) {
        cancelCountdown();
        if (recordingResult.sessionId != null) {
          activeRecordingSessionId = recordingResult.sessionId;
        }
        throw new Error(recordingResult.message || 'Recording failed to start.');
      }

      // Bind session ID before countdown so stale events from a prior attempt are ignored.
      if (recordingResult?.sessionId != null) {
        activeRecordingSessionId = recordingResult.sessionId;
      }

      const countdownResult = await countdownPromise;
      if (shouldAbortStartAfterCountdown({
        discardRequested: startWasDiscarded(),
        countdownResult,
      })) {
        // Only cancel/tear down UI for this attempt — never a newer Start B.
        if (isCurrentStartAttempt()) {
          addLog('Recording discarded during countdown.', 'warning');
          try {
            await window.electronAPI.cancelRecording({
              sessionId: recordingResult.sessionId,
            });
          } catch (_) {
            // Main may already be idle / cancelling.
          }
          currentAudioFile = null;
          currentRecordingDurationSeconds = 0;
          setIdleIfCurrentStart();
        }
        return;
      }

      if (!isCurrentStartAttempt()) {
        return;
      }

      // After first successful recording, set flag to false
      if (isFirstRecording) {
        isFirstRecording = false;
        saveSettings({ hasRecordedBefore: true });
      }

      recordingStartTime = Number(recordingResult.startedAt) || Date.now();
      setRecordingState('recording');

      // Update UI
      startTimer();
      audioVisualizer.start(captureMode);

      // Clear previous session meeting pointer; Activity shows queue rows.
      currentRecordingMeeting = null;
      currentRecordingTranscriptMarkdown = '';
      currentRecordingDurationSeconds = 0;
      applyCurrentRecordingTitle();
      addLog('Recording started!');
      return; // Success! Exit the retry loop

    } catch (error) {
      console.error(`Failed to start recording (attempt ${attempt}):`, error);
      if (isCurrentStartAttempt()) {
        cancelActiveCountdown();
      }

      if (startWasDiscarded()) {
        setIdleIfCurrentStart();
        return;
      }

      if (attempt >= maxAttempts) {
        // All attempts failed
        const errorMsg = error.message || 'Unknown error';
        addLog(`Recording failed after ${maxAttempts} attempts: ${errorMsg}`, 'error');

        // Show helpful error dialog
        const shouldCheckPermissions = errorMsg.toLowerCase().includes('permission') ||
                                        errorMsg.toLowerCase().includes('access') ||
                                        errorMsg.toLowerCase().includes('device');

        if (shouldCheckPermissions) {
          const hostFamily = inferRendererHostFamily(navigator.platform);
          const guidance = getRecordingPermissionFailureGuidance(hostFamily);

          if (guidance.kind === 'macos-settings') {
            const shouldOpenSettings = confirm(guidance.confirmMessage);
            if (shouldOpenSettings) {
              window.electronAPI.openSystemSettings(guidance.openSettings);
            }
          } else {
            alert(guidance.alertMessage);
          }
        } else {
          if (errorMsg.toLowerCase().includes('desktop audio failed to start')) {
            addLog(`Desktop audio startup details: ${errorMsg}`, 'error');
          }
          alert(
            `Recording failed: ${errorMsg}\n\n` +
            'Try refreshing your audio devices or restarting the app.'
          );
        }

        setIdleIfCurrentStart();
        return; // Give up
      } else {
        // Try again
        addLog(`Attempt ${attempt} failed. Retrying...`, 'warning');
      }
    }
  }
}

// Countdown function
function startCountdown() {
  let interval = null;
  let settled = false;
  let resolveCountdown = null;

  const promise = new Promise((resolve) => {
    resolveCountdown = resolve;
    countdownValue = 3;
    updateButtonUI();

    interval = setInterval(() => {
      countdownValue -= 1;

      if (countdownValue > 0) {
        updateButtonUI();
      } else {
        settled = true;
        clearInterval(interval);
        interval = null;
        activeCountdownCancel = null;
        resolve({ cancelled: false });
      }
    }, 1000);
  });

  const cancel = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    if (!settled) {
      settled = true;
      if (typeof resolveCountdown === 'function') {
        resolveCountdown({ cancelled: true });
      }
    }
    activeCountdownCancel = null;
  };

  activeCountdownCancel = cancel;
  return { promise, cancel };
}

// Stop recording and auto-transcribe
async function stopRecording() {
  try {
    addLog('Stopping recording...');

    // Immediately update UI to show we're stopping
    if (Number.isFinite(recordingStartTime)) {
      frozenPresenceElapsedText = formatElapsedDuration((Date.now() - recordingStartTime) / 1000);
    }
    setRecordingState('stopping');
    stopTimer(); // Stop timer immediately
    audioVisualizer.stop();

    const result = await window.electronAPI.stopRecording();
    if (result?.transcriptionSelection) {
      activeRecordingTranscriptionSelection = result.transcriptionSelection;
    }

    // Quit-cancel recovery already persisted this recording into History.
    // Do not run the normal transcribe-and-save path on the same stop result.
    if (result?.alreadyPersistedForQuit) {
      addLog('Recording was already saved during quit cancel. Open History to continue.', 'warning');
      setTranscriptMessage('Recording finished and saved. Open History to continue.', false);
      setRecordingState('idle');
      loadMeetingHistory({ scan: true }).catch((error) => {
        console.warn('Could not refresh history after quit-persisted stop:', error);
      });
      return;
    }

    if (result?.success === false) {
      // Windows/macOS may still return a recoverable audioPath/outputPath after a processing failure.
      if (result.audioPath) {
        currentAudioFile = result.audioPath;
        currentRecordingDurationSeconds = Number(result.duration || 0);
        addLog(`Recording saved with errors: ${currentAudioFile}`, 'warning');
        addLog(`Recording failed: ${result.message || result.code}`, 'error');
        setTranscriptMessage(result.message || 'Recording failed.', true);
        addLog('Starting transcription for recovered recording...');
        await transcribeAudio({
          stopErrorNote: result.message || result.code || 'Recording saved with processing errors.',
          transcriptionSelection: activeRecordingTranscriptionSelection,
        });
        return;
      }
      addLog(`Recording failed: ${result.message || result.code}`, 'error');
      setTranscriptMessage(result.message || 'Recording failed.', true);
      setRecordingState('idle');
      return;
    }

    // Store the audio file path for transcription
    if (result.audioPath) {
      currentAudioFile = result.audioPath;
      currentRecordingDurationSeconds = Number(result.duration || 0);
      addLog(`Recording saved: ${currentAudioFile}`);
      if (result.desktopDiagnostics) {
        const diag = result.desktopDiagnostics;
        addLog(
          `Desktop capture diagnostics: type=${diag.captureType || 'unknown'}, ` +
          `backend=${diag.helperCaptureBackend || 'unknown'}, ` +
          `chunks=${diag.bufferChunks || 0}, samples=${diag.bufferSamples || 0}, ` +
          `peak=${Number(diag.peakLevel || 0).toFixed(6)}, ` +
          `helperBytes=${diag.helperBytes || 0}, helperScreenFrames=${diag.helperScreenFrames || 0}`,
          (diag.bufferSamples || 0) > 0 ? 'info' : 'warning'
        );
      }

      // Auto-transcribe
      addLog('Starting transcription...');
      await transcribeAudio({
        transcriptionSelection: activeRecordingTranscriptionSelection,
      });
    } else {
      addLog('Warning: Recording stopped but no audio file path returned', 'warning');
      setTranscriptMessage('Recording completed but file not found. The recording may have failed.', true);
      setRecordingState('idle');
    }

  } catch (error) {
    console.error('Failed to stop recording:', error);
    addLog(`Error: ${error.message}`, 'error');
    setTranscriptMessage(`Recording failed: ${error.message}`, true);
    
    stopTimer();
    audioVisualizer.stop();
    setRecordingState('idle');
  }
}

async function discardRecording() {
  if (!shouldShowDiscardRecordingControl(recordingState)) {
    return;
  }

  const confirmed = window.confirm(
    'Cancel this recording? The audio will not be saved.',
  );
  if (!confirmed) {
    return;
  }

  try {
    addLog('Cancelling recording...');
    discardRequestedForStart = true;
    startRecordingEpoch += 1;
    cancelActiveCountdown();
    if (Number.isFinite(recordingStartTime)) {
      frozenPresenceElapsedText = formatElapsedDuration((Date.now() - recordingStartTime) / 1000);
    }
    setRecordingState('cancelling');
    stopTimer();
    if (audioVisualizer) {
      audioVisualizer.stop();
    }

    const result = await window.electronAPI.cancelRecording({
      sessionId: activeRecordingSessionId,
    });
    if (result?.cancelled === true && result?.success !== false) {
      addLog('Recording cancelled. Nothing was saved.', 'warning');
      setTranscriptMessage('Recording cancelled. Nothing was saved.', false);
      currentAudioFile = null;
      currentRecordingDurationSeconds = 0;
      activeRecordingTranscriptionSelection = null;
      activeRecordingTag = null;
      setRecordingState('idle');
      return;
    }

    addLog('Cancel finished without a confirmation from the recorder.', 'warning');
    setRecordingState('idle');
  } catch (error) {
    console.error('Failed to discard recording:', error);
    addLog(`Cancel failed: ${error.message}`, 'error');
    if (isRecordingStopInProgressError(error)) {
      setTranscriptMessage('Recording is already stopping and cannot be cancelled.', true);
      // First-wins: stop owns the UI — move to stopping and poll until idle.
      if (Number.isFinite(recordingStartTime)) {
        frozenPresenceElapsedText = formatElapsedDuration((Date.now() - recordingStartTime) / 1000);
      }
      setRecordingState('stopping');
      startRecordingPresencePoll();
      return;
    }
    if (isRecordingCancelFinalizedError(error)) {
      // Stop-vs-cancel race saved audio instead of discarding — surface it and refresh History.
      const result = error && error.result;
      const audioPath = result && (result.audioPath || result.outputPath);
      setTranscriptMessage(
        'Cancel could not discard the recording because a file was already saved. Check History.',
        true,
      );
      if (audioPath) {
        currentAudioFile = audioPath;
        currentRecordingDurationSeconds = Number(result.duration || 0);
      }
      setRecordingState('idle');
      loadMeetingHistory({ scan: true }).catch((historyError) => {
        console.warn('Could not refresh history after cancel-finalized race:', historyError);
      });
      return;
    }
    stopTimer();
    if (audioVisualizer) {
      audioVisualizer.stop();
    }
    setRecordingState('idle');
  }
}

function renderTranscriptSegments(_segments) {
  // Home Activity replaced the inline transcript panel (PR2).
}

function writeTranscriptMarkdown({ meeting, transcriptionResult, diarizationResult }) {
  const sourceSegments = diarizationResult && Array.isArray(diarizationResult.segments)
    ? diarizationResult.segments
    : (transcriptionResult.segments || []);
  const lines = [
    '# Audio Transcript',
    '',
    `**File:** ${meeting && meeting.audioPath ? meeting.audioPath.split(/[\\/]/).pop() : 'recording'}`,
    `**Date:** ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `**Duration:** ${formatTimestamp(transcriptionResult.duration || 0)}`,
    `**Language:** ${languageSelect.value || transcriptionResult.language || 'en'}`,
    '',
    '---',
    '',
    '## Transcript',
    '',
  ];

  sourceSegments.forEach((segment) => {
    const startTime = formatTimestamp(segment.start || 0);
    const endTime = formatTimestamp(segment.end || 0);
    const speaker = segment.speaker ? ` **${segment.speaker}:**` : '';
    lines.push(`**[${startTime} - ${endTime}]**${speaker}`);
    lines.push(segment.text || '');
    lines.push('');
  });

  if (!sourceSegments.length && transcriptionResult && transcriptionResult.text) {
    lines.push(transcriptionResult.text);
    lines.push('');
  }

  return lines.join('\n');
}

function renderMeetingDiarizationStatus(meeting, container) {
  const diarization = meeting && meeting.ai && meeting.ai.diarization;
  if (!diarization || diarization.status !== 'error') {
    return;
  }

  const message = document.createElement('p');
  message.className = 'placeholder error';
  message.textContent = `Speaker identification failed for this recording. ${diarization.error || 'The transcript was saved without speaker labels.'}`;
  container.appendChild(message);
}

function syncMeetingInList(updatedMeeting) {
  if (!updatedMeeting || !updatedMeeting.id) {
    return;
  }

  const index = findMeetingIndexById(updatedMeeting.id);
  if (index !== -1) {
    meetings[index] = { ...meetings[index], ...updatedMeeting };
    renderMeetingList();
  }

  if (currentRecordingMeeting && meetingIdsEqual(currentRecordingMeeting.id, updatedMeeting.id)) {
    currentRecordingMeeting = { ...currentRecordingMeeting, ...updatedMeeting };
    applyCurrentRecordingTitle();
  }
}

function handleSummaryGenerationButtonClick(meetingId, button) {
  if (summaryGenerationMeetingId && String(summaryGenerationMeetingId) === String(meetingId || '')) {
    cancelSummaryGeneration(meetingId);
    return;
  }

  generateSummaryForMeeting(meetingId);
}

async function hashSummaryTranscript(text) {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode((text || '').replace(/\r\n?/g, '\n')));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function updateSummaryLanguageCaptions(meeting) {
  // A summary fetch can resolve after another meeting is selected. Reject that
  // result before it rewrites the visible captions or the refresh cache.
  if (currentMeetingId != null && currentMeetingId !== ''
      && !meetingIdsEqual(meeting && meeting.id, currentMeetingId)) {
    return;
  }
  historyLanguageCaptionMeeting = meeting || null;
  const helpers = window.summaryLanguageHelpers;
  if (!helpers) return;
  const captions = [
    ['transcript-summary-language-caption', helpers.formatTranscriptLanguageCaption(meeting && meeting.language)],
    ['summary-language-caption', (() => {
      const caption = helpers.formatSummaryLanguageCaption(meeting);
      const modelId = meeting?.ai?.summary?.modelId;
      if (caption.visible && modelId && typeof summaryModelName === 'function') caption.value += ` · ${summaryModelName(modelId)}`;
      return caption;
    })()],
  ];
  for (const [id, caption] of captions) {
    const element = document.getElementById(id);
    if (!element) continue;
    const label = element.querySelector('.history-language-label');
    const value = element.querySelector('.history-language-value');
    if (!caption || !caption.visible) {
      element.hidden = true;
      if (label) label.textContent = '';
      if (value) value.textContent = '';
      continue;
    }
    element.hidden = false;
    if (label) label.textContent = `${caption.label}:`;
    if (value) value.textContent = caption.value;
  }
}

function confirmSummaryTranscriptLanguage(meeting, policy, preferredLanguage, sourceTranscriptHash, library = null) {
  const modelSelect = document.getElementById('summary-model-select');
  const modelField = document.getElementById('summary-model-field');
  const manageModels = document.getElementById('summary-manage-models');
  const staticModelLabel = document.getElementById('summary-model-static-label');
  const usableModels = library ? usableSummaryModels(library) : [];
  const defaultLanguage = preferredLanguage || meeting.language;
  const modelLanguages = (item) => item?.qualifiedLanguages || item?.languagePolicy?.languages || [];
  let chatOnlyDefaultName = null;
  let autoSelectedModelId = null;
  if (modelField) modelField.hidden = !library;
  if (!library && staticModelLabel) staticModelLabel.hidden = true;
  if (library && modelSelect) {
    modelSelect.replaceChildren();
    const defaultUsable = usableModels.some((model) => model.modelId === library.defaultModelId);
    if (!defaultUsable && usableModels.length !== 1) modelSelect.add(new Option('Choose an available model', ''));
    for (const model of usableModels) modelSelect.add(new Option(`${model.modelName}${model.modelId === library.defaultModelId ? ' · Default' : ''}`, model.modelId));
    let initialModelId = defaultUsable ? library.defaultModelId : '';
    const defaultModel = defaultUsable ? usableModels.find((item) => item.modelId === library.defaultModelId) : null;
    if (defaultModel && modelLanguages(defaultModel).length === 0) {
      const capable = usableModels.find((item) => modelLanguages(item).includes(defaultLanguage))
        || usableModels.find((item) => modelLanguages(item).length > 0);
      if (capable) {
        initialModelId = capable.modelId;
        autoSelectedModelId = capable.modelId;
        chatOnlyDefaultName = defaultModel.modelName;
      }
    }
    if (usableModels.length === 1) {
      modelSelect.value = usableModels[0].modelId;
      modelSelect.hidden = true;
      modelSelect.disabled = false;
      if (staticModelLabel) {
        staticModelLabel.hidden = false;
        staticModelLabel.textContent = `${usableModels[0].modelName}${usableModels[0].modelId === library.defaultModelId ? ' · Default' : ''}`;
      }
    } else if (usableModels.length === 0) {
      modelSelect.value = '';
      modelSelect.hidden = true;
      modelSelect.disabled = true;
      if (staticModelLabel) staticModelLabel.hidden = true;
    } else {
      modelSelect.value = initialModelId;
      modelSelect.hidden = false;
      modelSelect.disabled = false;
      if (staticModelLabel) staticModelLabel.hidden = true;
    }
  }
  if (manageModels && library) {
    manageModels.hidden = false;
    manageModels.textContent = usableModels.length
      ? 'Manage models'
      : (library.models?.some((m) => m.installed) ? 'Manage models' : 'Set up a model');
  }
  const modal = document.getElementById('summary-language-modal');
  const select = document.getElementById('summary-transcript-language');
  const form = document.getElementById('summary-language-form');
  const cancel = document.getElementById('summary-language-cancel');
  const submit = document.getElementById('summary-language-confirm');
  const message = document.getElementById('summary-language-message');
  const speakerFieldset = document.getElementById('summary-speaker-fieldset');
  const speakerRows = document.getElementById('summary-speaker-rows');
  const tagField = document.getElementById('summary-recording-type');
  const tagSelect = document.getElementById('summary-recording-tag');
  const formatPreview = document.getElementById('summary-format-preview');
  const fields = new Map();
  const names = meeting.ai?.diarization?.speakerNames || {};
  const samples = extractSpeakerSamples(parseTranscriptMarkdownSegments(meeting.transcript));
  const showSpeakers = shouldPromptSpeakerNamesBeforeSummary(meeting, samples);
  const controller = new AbortController();
  const historyPlayer = document.getElementById('audio-player');
  const useHistoryPlayer = meeting.id && meetingIdsEqual(meeting.id, currentMeetingId);
  const dedicatedPlayer = showSpeakers && !useHistoryPlayer && meeting.audioPath ? new Audio() : null;
  if (dedicatedPlayer) dedicatedPlayer.src = window.electronAPI.buildFileUrl(meeting.audioPath);
  speakerRows.replaceChildren();
  speakerFieldset.hidden = !showSpeakers;
  tagField.hidden = Boolean(normalizeTag(meeting.tag));
  tagSelect.replaceChildren(new Option('Choose recording type', ''));
  for (const tag of RECORDING_TAGS) tagSelect.add(new Option(tag.label, tag.slug));
  const updateFormat = () => {
    const tag = getTagMeta(tagSelect.value || 'other');
    formatPreview.textContent = `${tag.label} format · ${tag.formatPreview}`;
  };
  tagSelect.addEventListener('change', updateFormat, { signal: controller.signal });
  updateFormat();
  if (!speakerFieldset.hidden) {
    const player = useHistoryPlayer ? historyPlayer : dedicatedPlayer;
    for (const sample of samples) {
      const { row, field } = buildSpeakerRow('summary-speaker', sample, names, player, controller.signal);
      fields.set(sample.speaker, field);
      speakerRows.appendChild(row);
    }
  }
  const previousFocus = document.activeElement;
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose transcript language…';
  select.appendChild(placeholder);
  for (const [id, name] of Object.entries(policy.names || {})) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${name}${policy.languages.includes(id) ? '' : ' — summaries unavailable'}`;
    select.appendChild(option);
  }
  select.value = Object.hasOwn(policy.names || {}, defaultLanguage) ? defaultLanguage : '';
  let saving = false;
  const selectedModel = () => usableModels.find((item) => item.modelId === modelSelect?.value);
  const selectedLanguages = (model) => model?.qualifiedLanguages || model?.languagePolicy?.languages || (model && model.modelId !== library?.defaultModelId ? [] : policy.languages);
  const update = () => {
    const model = selectedModel();
    const languages = selectedLanguages(model);
    for (const option of (select.options || [])) {
      if (option.value && policy.names?.[option.value]) option.textContent = `${policy.names[option.value]}${languages.includes(option.value) ? '' : ' — summaries unavailable'}`;
    }
    const name = policy.names?.[select.value];
    const available = languages.includes(select.value) && (!library || Boolean(model));
    submit.disabled = saving || !available;
    message.textContent = library && !model ? 'The default model is unavailable. Choose an installed model.'
      : !languages.length ? 'This model has no checked summary languages. Choose another model.'
      : !name ? 'Choose the main language spoken in this recording.'
      : available
        ? (chatOnlyDefaultName && model?.modelId === autoSelectedModelId
          ? `Summary will use ${name}. (${chatOnlyDefaultName} is Chat-only on this device.)`
          : `Summary will use ${name}.`)
        : `Summaries are not available for ${name} with this model.`;
  };
  update();
  modal.classList.remove('hidden');
  select.focus();
  return new Promise((resolve) => {
    let closed = false;
    const close = (language) => {
      if (closed) return;
      closed = true;
      stopSpeakerPreview?.();
      controller.abort();
      if (dedicatedPlayer) {
        dedicatedPlayer.removeAttribute('src');
        dedicatedPlayer.load();
      }
      modal.classList.add('hidden');
      form.removeEventListener('submit', onSubmit);
      select.removeEventListener('change', update);
      cancel.removeEventListener('click', onCancel);
      modal.removeEventListener('keydown', onKey);
      closeSummaryLanguageConfirmation = null;
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(language);
    };
    const onSubmit = async (event) => {
      event.preventDefault();
      if (saving || submit.disabled) return;
      const transcriptLanguage = select.value;
      const selectedModelId = modelSelect?.value || null;
      const editedNames = { ...names };
      for (const [speaker, field] of fields) editedNames[speaker] = field.value;
      const speakerNames = diffSpeakerNames(names, editedNames);
      const updates = {};
      if (Object.keys(speakerNames).length) {
        updates.speakerNames = speakerNames;
        updates.expectedSourceTranscriptHash = sourceTranscriptHash;
        updates.expectedTranscriptionAttemptId = meeting.transcriptionResult?.attemptId || '';
      }
      if (!tagField.hidden && tagSelect.value) updates.tag = tagSelect.value;
      if (Object.keys(updates).length) {
        saving = true;
        submit.disabled = true;
        message.textContent = 'Saving recording details…';
        try {
          const updated = await window.electronAPI.updateMeeting(meeting.id, updates);
          if (closed) return;
          if (Object.hasOwn(updates, 'tag')) {
            const id = String(updated.id);
            meetingTagMutationVersions.set(id, (meetingTagMutationVersions.get(id) || 0) + 1);
          }
          syncMeetingInList(updated);
          if (meetingIdsEqual(currentMeetingId, updated.id)) {
            applyTagPillView(document.getElementById('meeting-tag-btn'), document.getElementById('meeting-tag-btn-label'), updated.tag);
            if (!historySpeakers) updateSummaryTagMismatchBanner(updated);
          }
          if (historySpeakers && meetingIdsEqual(historySpeakers.meeting.id, updated.id)) {
            historySpeakers.names = updated.ai?.diarization?.speakerNames || {};
            for (const [speaker, field] of historySpeakers.fields) {
              field.value = historySpeakers.names[speaker] || '';
              historySpeakers.requestedNames.set(speaker, field.value);
            }
            updateHistorySpeakerLabels(historySpeakers, updated);
            if (!hasUnnamedSpeakers(updated, historySpeakers.samples)) setHistorySpeakersExpanded(false);
          }
          renderHistoryTagFilterBar();
          renderActivityList();
          if (chatState.popoverOpen) renderScopePopover();
          if (meetingSearchQueryNormalized || meetingSearchDebounceTimer) {
            clearTimeout(meetingSearchDebounceTimer);
            meetingSearchDebounceTimer = null;
            void runHistorySearch(meetingSearchQuery);
          }
        } catch (error) {
          if (closed) return;
          saving = false;
          update();
          message.textContent = 'Could not save recording details. Try again, or reopen Prepare summary if the transcript changed.';
          console.warn('Summary preparation update failed:', error.message);
          return;
        }
      }
      close(library ? { transcriptLanguage, modelId: selectedModelId } : transcriptLanguage);
    };
    const onCancel = () => close(null);
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(null); }
      if (event.key !== 'Tab') return;
      const elements = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
        .filter((element) => !element.closest('[hidden]'));
      const index = elements.indexOf(document.activeElement);
      const next = event.shiftKey ? index - 1 : index + 1;
      if (elements.length && (index === -1 || next < 0 || next >= elements.length)) {
        event.preventDefault();
        elements[event.shiftKey ? elements.length - 1 : 0].focus();
      }
    };
    closeSummaryLanguageConfirmation = close;
    form.addEventListener('submit', onSubmit);
    select.addEventListener('change', update);
    modelSelect?.addEventListener('change', () => {
      if (!selectedLanguages(selectedModel()).includes(select.value)) select.value = '';
      update();
    }, { signal: controller.signal });
    manageModels?.addEventListener('click', () => {
      close(null);
      openSettingsAtAiAddons();
    }, { signal: controller.signal });
    cancel.addEventListener('click', onCancel);
    modal.addEventListener('keydown', onKey);
  });
}

async function generateSummaryForMeeting(meetingId) {
  if (!meetingId) {
    addLog('Save a transcript before generating a summary.', 'warning');
    return;
  }

  const normalizedMeetingId = String(meetingId);

  if (summaryGenerationMeetingId) {
    addLog('Summary generation is already running.', 'warning');
    return;
  }

  summaryGenerationMeetingId = normalizedMeetingId;
  summaryGenerationCancelling = false;
  updateSummaryGenerationButtons();

  addLog('Checking summary availability…');
  let aiStatus;
  try {
    aiStatus = await window.electronAPI.getAiAddonStatus({
      verifyChecksums: true,
      verifyChecksumsIfChanged: true,
    });
  } catch (error) {
    addLog(`Summary setup status unavailable: ${error.message}`, 'error');
    summaryGenerationMeetingId = null;
    summaryGenerationCancelling = false;
    updateSummaryGenerationButtons();
    return;
  }

  if (shouldAbortSummaryGenerationAfterPreflight({
    requestedMeetingId: normalizedMeetingId,
    activeMeetingId: summaryGenerationMeetingId,
    cancelling: summaryGenerationCancelling,
  })) {
    addLog('Summary generation cancelled. Transcript is unchanged.', 'warning');
    await restoreCurrentHistorySummary(normalizedMeetingId, 'Summary generation cancelled. Transcript is unchanged.');
    summaryGenerationMeetingId = null;
    summaryGenerationCancelling = false;
    updateSummaryGenerationButtons();
    return;
  }

  const summaryStatus = aiStatus && aiStatus.features && aiStatus.features.summary;
  const library = aiStatus?.summaryLibrary;
  aiAddonStatusSnapshot = aiStatus;
  if (library ? !usableSummaryModels(library).length : (!summaryStatus || !summaryStatus.setupComplete || summaryStatus.status !== 'ready')) {
    const message = getSummarySetupMessage(summaryStatus);
    addLog(message, summaryStatus && summaryStatus.status === 'unsupported' ? 'error' : 'warning');
    await restoreCurrentHistorySummary(normalizedMeetingId, message, { isError: summaryStatus?.status === 'error' });
    openSettingsAtAiAddons();
    summaryGenerationMeetingId = null;
    summaryGenerationCancelling = false;
    updateSummaryGenerationButtons();
    return;
  }

  try {
    const policy = summaryStatus?.languagePolicy || usableSummaryModels(library)[0]?.languagePolicy;
    if (!policy || (!library && !policy.languages?.length)) throw new Error('No transcript languages have been checked for the installed model.');
    const meeting = await window.electronAPI.getMeeting(normalizedMeetingId);
    const sourceTranscriptHash = await hashSummaryTranscript(meeting?.transcript);
    if (summaryGenerationCancelling || summaryGenerationMeetingId !== normalizedMeetingId || rendererQuitCommitted) throw new Error('Summary generation cancelled.');
    const preferredLanguage = window.summaryLanguageHelpers.reusableSummaryLanguage(meeting, sourceTranscriptHash, policy);
    const selection = await confirmSummaryTranscriptLanguage(meeting, policy, preferredLanguage, sourceTranscriptHash, library);
    const transcriptLanguage = typeof selection === 'string' ? selection : selection?.transcriptLanguage;
    if (!transcriptLanguage || summaryGenerationCancelling || summaryGenerationMeetingId !== normalizedMeetingId || rendererQuitCommitted) {
      await restoreCurrentHistorySummary(normalizedMeetingId, 'Summary generation cancelled. Transcript is unchanged.', { showTab: false });
      return;
    }
    if (meetingIdsEqual(currentMeetingId, normalizedMeetingId)) showSummaryMessage(`Generating local summary in ${policy.names[transcriptLanguage]}…`);
    addLog(`Generating local summary in ${policy.names[transcriptLanguage]}...`);
    const summaryProfileSelect = document.getElementById('summary-profile-select');
    const result = await window.electronAPI.generateSummary({
      meetingId: normalizedMeetingId,
      transcriptLanguage,
      sourceTranscriptHash,
      modelId: selection?.modelId || undefined,
      profile: (summaryProfileSelect && summaryProfileSelect.value) || summaryStatus.profile || DEFAULT_SUMMARY_PROFILE,
    });

    if (meetingIdsEqual(currentMeetingId, normalizedMeetingId)) {
      const fullMeeting = await window.electronAPI.getMeeting(normalizedMeetingId);
      syncMeetingInList((result && result.meeting) || fullMeeting);
      if (meetingIdsEqual(currentMeetingId, normalizedMeetingId)) {
        updateSummaryLanguageCaptions(fullMeeting);
        renderSummaryMarkdown((fullMeeting && fullMeeting.summary) || '', { stale: fullMeeting && fullMeeting.summaryStale });
        updateSummaryTagMismatchBanner(fullMeeting);
        activateHistoryDetailTab('summary');
      }
    } else if (currentRecordingMeeting && meetingIdsEqual(currentRecordingMeeting.id, normalizedMeetingId)) {
      syncMeetingInList(result && result.meeting);
      activateTab('history');
      await selectMeeting(normalizedMeetingId);
      if (meetingIdsEqual(currentMeetingId, normalizedMeetingId)) activateHistoryDetailTab('summary');
    } else {
      syncMeetingInList(result && result.meeting);
    }

    addLog('Summary generated!');
  } catch (error) {
    console.error('Failed to generate summary:', error);
    const wasCancelled = error && (error.code === 'AI_ADDON_SETUP_CANCELLED' || error.name === 'AbortError' || /cancell?ed/i.test(error.message || ''));
    if (wasCancelled) {
      addLog('Summary generation cancelled. Transcript is unchanged.', 'warning');
      await restoreCurrentHistorySummary(normalizedMeetingId, 'Summary generation cancelled. Transcript is unchanged.');
      return;
    }

    const message = `Summary generation failed. Transcript is unchanged. ${error.message}`;
    addLog(message, 'error');
    await restoreCurrentHistorySummary(normalizedMeetingId, message, { isError: true });
  } finally {
    summaryGenerationMeetingId = null;
    summaryGenerationCancelling = false;
    updateSummaryGenerationButtons();
  }
}

// Enqueue transcription after stop. PR2: unlock Start as soon as pending persist
// succeeds; main owns the composite job and Activity is driven by queue-state.
async function transcribeAudio(options = {}) {
  const capturedSelection = options.transcriptionSelection || activeRecordingTranscriptionSelection;
  const language = capturedSelection?.engine === 'parakeet'
    ? 'en'
    : (capturedSelection?.language || languageSelect.value);
  const modelSize = capturedSelection?.engine === 'parakeet'
    ? 'Parakeet v2'
    : (capturedSelection?.modelSize || capturedSelection?.model || modelSelect.value);
  const stopErrorNote = typeof options.stopErrorNote === 'string' ? options.stopErrorNote : '';

  const selection = capturedSelection?.engine === 'parakeet'
    ? { ok: true }
    : validateNewTranscriptionSelection(language, modelSize);
  if (!selection.ok) {
    reportUnsupportedTranscriptionSelection(selection);
    activeRecordingTranscriptionSelection = null;
    setRecordingState('idle');
    return;
  }

  if (!currentAudioFile) {
    addLog('Error: No audio file to transcribe', 'error');
    setTranscriptMessage('No audio file available for transcription.', true);
    activeRecordingTranscriptionSelection = null;
    setRecordingState('idle');
    return;
  }

  try {
    const capturedTag = activeRecordingTag;
    addLog(`Saving recording and queuing transcription (${language}, ${modelSize})…`);
    addLog(`File: ${currentAudioFile}`);

    const result = await window.electronAPI.finalizeRecordingTranscription({
      audioPath: currentAudioFile,
      duration: currentRecordingDurationSeconds || 0,
      language,
      modelSize,
      ...(capturedTag ? { tag: capturedTag } : {}),
      transcriptionErrorNote: stopErrorNote,
      transcriptionSelection: capturedSelection || null,
    });
    if (!result || result.success !== false || result.meeting || result.pendingMeeting) {
      activeRecordingTag = null;
      selectedRecordingTag = null;
      renderRecordingTagControl();
    }

    if (result && result.success === false) {
      throw Object.assign(new Error(result.error || 'Could not save recording.'), {
        code: result.code || 'TRANSCRIPTION_FAILED',
        meeting: result.meeting || result.pendingMeeting || null,
      });
    }

    const meeting = result && result.meeting;
    if (meeting && meeting.audioPath) {
      currentAudioFile = meeting.audioPath;
    }
    if (meeting && meeting.id) {
      currentRecordingMeeting = meeting;
      applyCurrentRecordingTitle();
      addLog(`Queued transcription for ${meeting.title || meeting.id}`);
      // Merge locally so History/Activity update without blocking Start on list-meetings.
      const existingIdx = meetings.findIndex((entry) => meetingIdsEqual(entry.id, meeting.id));
      if (existingIdx >= 0) {
        meetings[existingIdx] = { ...meetings[existingIdx], ...meeting };
      } else {
        meetings = [meeting, ...meetings];
      }
      renderMeetingList();
      renderActivityList();
    } else {
      addLog('Recording saved; transcription queued.');
    }

    // Unlock Start immediately after pending persist; refresh History in the background.
    setRecordingState('idle');
    void loadMeetingHistory().catch((historyError) => {
      console.warn('Background history refresh after enqueue failed:', historyError);
    });
  } catch (error) {
    console.error('Failed to enqueue transcription:', error);

    if (error && (error.code === 'UNSUPPORTED_LANGUAGE' || error.code === 'UNSUPPORTED_MODEL')) {
      // Stale/policy-skewed selection rejected by main: show the supported-
      // selection explanation instead of a generic enqueue failure.
      reportUnsupportedTranscriptionSelection({ message: error.message });
      try {
        await loadMeetingHistory();
      } catch (historyError) {
        console.warn('Could not refresh history after enqueue failure:', historyError);
      }
      setRecordingState('idle');
      return;
    }

    addLog(`Error: ${error.message}`, 'error');

    if (error && error.code === 'PENDING_MEETING_PERSIST_FAILED') {
      setTranscriptMessage(
        `Recording was saved on disk, but could not be added to History yet. Scanning for it now. ${error.message}`,
        true,
      );
      loadMeetingHistory({ scan: true }).catch((scanError) => {
        console.warn('Could not scan recordings after pending persist failure:', scanError);
      });
      setRecordingState('idle');
      return;
    }

    if (error && error.meeting) {
      currentRecordingMeeting = error.meeting;
      applyCurrentRecordingTitle();
    }
    try {
      await loadMeetingHistory();
    } catch (historyError) {
      console.warn('Could not refresh history after enqueue failure:', historyError);
    }
    setRecordingState('idle');
  } finally {
    activeRecordingTranscriptionSelection = null;
  }
}

async function retryMeetingTranscription() {
  if (!currentMeetingId) {
    addLog('Select a recording first.', 'warning');
    return;
  }

  const retryBtn = document.getElementById('retry-transcription-btn');
  const meeting = findMeetingById(currentMeetingId);
  if (!meeting || !isMeetingTranscriptionRetryable(meeting)) {
    return;
  }

  if (retryBtn) {
    retryBtn.disabled = true;
    retryBtn.textContent = 'Retrying...';
  }
  addLog(`Retrying transcription for ${meeting.title}...`);

  try {
    const result = await window.electronAPI.retryTranscription(
      buildOrdinaryRetryOptions(currentMeetingId),
    );
    addLog('Transcription retry completed.');
    if (result && result.diarization) {
      addLog('Speaker-guided transcript saved!');
    } else if (result && result.diarizationError) {
      addLog(`Speaker identification noted an error; transcript was saved. ${result.diarizationError}`, 'warning');
    }
    if (result && result.meeting) {
      syncMeetingInList(result.meeting);
    }
    await loadMeetingHistory();
    await selectMeeting(currentMeetingId);
  } catch (error) {
    addLog(`Retry transcription failed: ${error.message}`, 'error');
  } finally {
    if (retryBtn) {
      retryBtn.disabled = false;
      retryBtn.textContent = 'Retry transcription';
    }
  }
}

function openWhisperRetryDialog(meetingId = currentMeetingId) {
  const id = String(meetingId || '').trim();
  const meeting = findMeetingById(id);
  const modal = document.getElementById('whisper-retry-modal');
  if (!modal || !meeting || !isMeetingTranscriptionRetryable(meeting)) {
    return;
  }
  whisperRetryMeetingId = id;
  const language = document.getElementById('whisper-retry-language');
  const model = document.getElementById('whisper-retry-model');
  const error = document.getElementById('whisper-retry-error');
  language.value = transcriptionEnginePreferences.whisper.language || '';
  model.value = transcriptionEnginePreferences.whisper.modelSize || 'small';
  error.textContent = '';
  error.hidden = true;
  modal.classList.remove('hidden');
  language.focus();
}

function closeWhisperRetryDialog({ restoreFocus = true } = {}) {
  const modal = document.getElementById('whisper-retry-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  whisperRetryMeetingId = null;
  if (restoreFocus) {
    const retryButton = document.getElementById('retry-whisper-transcription-btn');
    if (retryButton && !retryButton.hidden) retryButton.focus();
  }
}

async function completeWhisperRetry(meetingId, meetingTitle, retryPromise) {
  let result;
  try {
    result = await retryPromise;
  } catch (error) {
    const canceled = error && (
      error.code === 'TRANSCRIPTION_CANCELLED'
      || error.code === 'USER_CANCELLED_TRANSCRIPTION'
      || error.name === 'AbortError'
    );
    addLog(canceled
      ? 'Whisper retry was canceled from Activity.'
      : `Whisper retry failed: ${error && error.message ? error.message : error}`, canceled ? 'warning' : 'error');
    await loadMeetingHistory().catch(() => {});
    return;
  }

  if (result && result.diarization) {
    addLog('Speaker-guided transcript saved!');
  } else if (result && result.diarizationError) {
    addLog(`Speaker identification noted an error; transcript was saved. ${result.diarizationError}`, 'warning');
  }
  if (result && result.meeting) syncMeetingInList(result.meeting);
  try {
    await loadMeetingHistory();
  } catch (error) {
    addLog(`Whisper retry completed, but History could not refresh: ${error.message}`, 'warning');
  }
  const historyTab = document.getElementById('history-tab');
  if (historyTab && historyTab.classList.contains('active')
      && String(currentMeetingId || '') === String(meetingId)) {
    try {
      await selectMeeting(meetingId);
    } catch (error) {
      addLog(`Whisper retry completed, but its transcript could not be displayed: ${error.message}`, 'warning');
    }
  }
  addLog(`Whisper retry completed for ${meetingTitle}. The active engine was not changed.`);
}

async function retryMeetingTranscriptionWithWhisper(meetingId = whisperRetryMeetingId) {
  const id = String(meetingId || '').trim();
  const meeting = findMeetingById(id);
  if (!id || !meeting || !isMeetingTranscriptionRetryable(meeting) || whisperRetryBusy) {
    return;
  }

  const language = document.getElementById('whisper-retry-language').value;
  const modelSize = document.getElementById('whisper-retry-model').value;
  const validation = validateNewTranscriptionSelection(language, modelSize);
  const errorMessage = document.getElementById('whisper-retry-error');
  if (!validation.ok) {
    errorMessage.textContent = validation.message || 'Choose a supported Whisper language and model.';
    errorMessage.hidden = false;
    return;
  }

  persistTranscriptionEnginePreferences({
    whisper: { language: validation.language, modelSize: validation.modelSize },
  });
  const submitButton = document.getElementById('whisper-retry-submit-btn');
  const cancelButton = document.getElementById('whisper-retry-cancel-btn');
  whisperRetryBusy = true;
  submitButton.disabled = true;
  submitButton.textContent = 'Submitting…';
  cancelButton.disabled = true;
  errorMessage.hidden = true;
  addLog(`Retrying ${meeting.title} with Whisper…`);

  let retryPromise;
  try {
    retryPromise = window.electronAPI.retryTranscription(buildWhisperRetryOptions(id, {
      language: validation.language,
      modelSize: validation.modelSize,
    }));
  } catch (error) {
    whisperRetryBusy = false;
    submitButton.disabled = false;
    submitButton.textContent = 'Retry with Whisper';
    cancelButton.disabled = false;
    errorMessage.textContent = error.message || 'Whisper retry failed.';
    errorMessage.hidden = false;
    return;
  }

  // The retry IPC Promise covers the queued and running transcription. Close
  // Settings now so the user can keep using AvaNevis and track/cancel the job
  // from Activity while the background operation continues.
  closeWhisperRetryDialog({ restoreFocus: true });
  whisperRetryBusy = false;
  submitButton.disabled = false;
  submitButton.textContent = 'Retry with Whisper';
  cancelButton.disabled = false;
  addLog('Whisper retry submitted. Track progress and cancel it in Activity.');
  return completeWhisperRetry(id, meeting.title, retryPromise);
}

function setupWhisperRetryDialog() {
  const modal = document.getElementById('whisper-retry-modal');
  const form = document.getElementById('whisper-retry-form');
  const cancelButton = document.getElementById('whisper-retry-cancel-btn');
  const openButton = document.getElementById('retry-whisper-transcription-btn');
  if (!modal || !form || modal.dataset.bound === 'true') return;
  modal.dataset.bound = 'true';
  openButton?.addEventListener('click', () => openWhisperRetryDialog());
  cancelButton?.addEventListener('click', () => closeWhisperRetryDialog());
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void retryMeetingTranscriptionWithWhisper();
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeWhisperRetryDialog({ restoreFocus: false });
  });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeWhisperRetryDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [...modal.querySelectorAll('select:not(:disabled), button:not(:disabled)')]
      .filter((element) => !element.hidden);
    if (focusables.length === 0) return;
    const activeIndex = focusables.indexOf(document.activeElement);
    if (event.shiftKey && activeIndex <= 0) {
      event.preventDefault();
      focusables[focusables.length - 1].focus();
    } else if (!event.shiftKey && activeIndex === focusables.length - 1) {
      event.preventDefault();
      focusables[0].focus();
    }
  });
}

// Copy transcript to clipboard (legacy Home panel removed)
function copyTranscript() {
  addLog('Open the recording in History to copy its transcript.', 'warning');
}

// Copy meeting transcript to clipboard
function copyMeetingTranscript() {
  const transcriptEl = document.getElementById('meeting-transcript');
  const text = transcriptEl.dataset.markdown
    ? window.subtitleExportHelpers.applySpeakerNamesToMarkdown(transcriptEl.dataset.markdown, historySpeakers?.names)
    : transcriptEl.textContent;

  navigator.clipboard.writeText(text).then(() => {
    // Visual feedback
    const btn = document.getElementById('copy-transcript-btn');
    setCopyButtonState(btn, 'Copied!', true);

    setTimeout(() => {
      setCopyButtonState(btn, 'Copy', false);
    }, COPY_SUCCESS_TIMEOUT_MS);
  }).catch(err => {
    console.error('Failed to copy:', err);
    alert('Failed to copy transcript to clipboard');
  });
}

function getCurrentSummaryMarkdown() {
  const summaryEl = document.getElementById('meeting-summary');
  return (summaryEl && summaryEl.dataset.markdown) || '';
}

function copyMeetingSummary() {
  const text = getCurrentSummaryMarkdown();
  if (!text.trim()) {
    addLog('No summary available to copy.', 'warning');
    return;
  }

  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-summary-btn');
    setCopyButtonState(btn, 'Copied!', true);

    setTimeout(() => {
      setCopyButtonState(btn, 'Copy', false);
      updateSummaryActionState();
    }, COPY_SUCCESS_TIMEOUT_MS);
  }).catch(err => {
    console.error('Failed to copy summary:', err);
    addLog(`Failed to copy summary: ${err.message}`, 'error');
    alert('Failed to copy summary to clipboard');
  });
}

async function saveMeetingSummaryToFile() {
  const meetingId = currentMeetingId;
  if (!meetingId) {
    addLog('Select a recording first.', 'warning');
    return;
  }

  let meeting;
  try {
    meeting = await window.electronAPI.getMeeting(meetingId);
  } catch (err) {
    console.error('Failed to load summary for save:', err);
    addLog(`Failed to load summary: ${err.message}`, 'error');
    return;
  }

  const content = meeting?.summary || '';
  if (!content.trim()) {
    addLog('No summary available to save.', 'warning');
    return;
  }

  try {
    const result = await window.electronAPI.saveTranscriptAs({
      suggestedName: `${meeting.title || 'Summary'} Summary`,
      content,
      title: 'Save Summary',
    });
    if (result && !result.canceled && result.filePath) {
      addLog(`Summary saved to ${result.filePath}`);
    }
  } catch (err) {
    console.error('Summary save failed:', err);
    addLog(`Failed to save summary: ${err.message}`, 'error');
    alert(`Failed to save summary: ${err.message}`);
  }
}

let activeTranscriptExportContext = null;
let transcriptExportTriggerElement = null;
let transcriptExportBusy = false;

function updateTranscriptExportSubtitleControls() {
  const form = document.getElementById('transcript-export-form');
  const prefsEl = document.getElementById('transcript-export-subtitle-prefs');
  const vttVoiceRow = document.getElementById('transcript-export-vtt-voice-row');
  if (!form || !prefsEl) return;
  const selected = form.querySelector('input[name="transcript-export-format"]:checked');
  const format = selected ? selected.value : 'md';
  const isSubtitle = format === 'srt' || format === 'vtt';
  prefsEl.hidden = !isSubtitle;
  if (vttVoiceRow) {
    vttVoiceRow.hidden = format !== 'vtt';
  }
}

function renderTranscriptExportFormatOptions(config, selectedFormat = 'md') {
  const optionsContainer = document.getElementById('transcript-export-options');
  const noticeEl = document.getElementById('transcript-export-notice');
  const noticeTextEl = document.getElementById('transcript-export-notice-text');
  const retranscribeBtn = document.getElementById('transcript-export-retranscribe-btn');
  if (!optionsContainer) return;

  clearElement(optionsContainer);
  const availableFormats = new Set(
    config.options.filter((opt) => opt.available).map((opt) => opt.format),
  );
  const chosenFormat = availableFormats.has(selectedFormat) ? selectedFormat : config.defaultFormat;

  for (const option of config.options) {
    const label = document.createElement('label');
    label.className = 'transcript-export-option';
    if (!option.available) label.classList.add('is-disabled');
    if (option.format === chosenFormat) label.classList.add('is-selected');

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'transcript-export-format';
    input.value = option.format;
    input.disabled = !option.available;
    input.checked = option.format === chosenFormat;
    if (!option.available && option.disabledReason) {
      input.title = option.disabledReason;
    }

    const body = document.createElement('span');
    body.className = 'transcript-export-option-body';

    const header = document.createElement('span');
    header.className = 'transcript-export-option-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'transcript-export-option-label';
    nameEl.textContent = option.label;
    header.appendChild(nameEl);

    const extEl = document.createElement('span');
    extEl.className = 'transcript-export-option-ext';
    extEl.textContent = option.extLabel;
    header.appendChild(extEl);

    if (!option.available) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'transcript-export-option-badge';
      badgeEl.textContent = 'Unavailable';
      header.appendChild(badgeEl);
    }

    const descEl = document.createElement('span');
    descEl.className = 'transcript-export-option-desc';
    descEl.textContent = option.description;

    body.appendChild(header);
    body.appendChild(descEl);
    label.appendChild(input);
    label.appendChild(body);
    optionsContainer.appendChild(label);
  }

  if (noticeEl && noticeTextEl) {
    const noticeText = config.captionsUnavailableNotice || '';
    noticeTextEl.textContent = noticeText;
    noticeEl.hidden = !noticeText;
  }
  if (retranscribeBtn) {
    retranscribeBtn.hidden = !config.canRetranscribe;
    retranscribeBtn.disabled = false;
  }
  updateTranscriptExportSubtitleControls();
}

function closeTranscriptExportDialog({ restoreFocus = true } = {}) {
  const modal = document.getElementById('transcript-export-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  activeTranscriptExportContext = null;
  transcriptExportBusy = false;
  const trigger = transcriptExportTriggerElement;
  transcriptExportTriggerElement = null;
  if (restoreFocus && trigger && typeof trigger.focus === 'function' && !trigger.disabled) {
    trigger.focus();
  }
}

function openTranscriptExportDialog({ suggestedName, content, meeting = null, triggerElement = null }) {
  const modal = document.getElementById('transcript-export-modal');
  const form = document.getElementById('transcript-export-form');
  const nameEl = document.getElementById('transcript-export-meeting-name');
  const errorEl = document.getElementById('transcript-export-error');
  const includeSpeakersEl = document.getElementById('transcript-export-include-speakers');
  const useVoiceTagsEl = document.getElementById('transcript-export-use-voice-tags');
  const confirmBtn = document.getElementById('transcript-export-confirm');
  if (!modal || !form) return false;

  const meetingId = meeting && meeting.id ? String(meeting.id).trim() : '';
  const config = buildExportFormatOptions({
    captionsAvailable: Boolean(meeting && meeting.captionsAvailable),
    captionsStatus: (meeting && meeting.captionsStatus) || 'missing',
    hasAudio: Boolean(meetingId && meeting && meeting.audioPath),
  });

  activeTranscriptExportContext = {
    suggestedName,
    content,
    meetingId,
    config,
  };
  transcriptExportTriggerElement = triggerElement || document.activeElement;
  transcriptExportBusy = false;

  if (nameEl) nameEl.textContent = suggestedName || 'Transcript';
  if (includeSpeakersEl) includeSpeakersEl.checked = true;
  if (useVoiceTagsEl) useVoiceTagsEl.checked = false;
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Save as…';
  }

  renderTranscriptExportFormatOptions(config, config.defaultFormat);
  modal.classList.remove('hidden');

  const checkedRadio = form.querySelector('input[name="transcript-export-format"]:checked');
  if (checkedRadio) {
    checkedRadio.focus();
  }
  return true;
}

async function retranscribeMeetingForCaptions(meetingId) {
  const id = String(meetingId || '').trim();
  if (!id || transcriptExportBusy) return;
  const retranscribeBtn = document.getElementById('transcript-export-retranscribe-btn');
  const errorEl = document.getElementById('transcript-export-error');
  transcriptExportBusy = true;
  if (retranscribeBtn) {
    retranscribeBtn.disabled = true;
    retranscribeBtn.textContent = 'Re-transcribing…';
  }
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
  addLog(`Re-transcribing recording ${id} to generate subtitle timings...`);
  try {
    const result = await window.electronAPI.retryTranscription(buildOrdinaryRetryOptions(id));
    if (result && result.meeting) {
      syncMeetingInList(result.meeting);
    }
    await loadMeetingHistory();
    if (String(currentMeetingId || '') === id) {
      await selectMeeting(id);
    }
    const refreshed = await window.electronAPI.getMeeting(id).catch(() => null);
    if (activeTranscriptExportContext && activeTranscriptExportContext.meetingId === id && refreshed) {
      activeTranscriptExportContext.content = refreshed.transcript || activeTranscriptExportContext.content;
      activeTranscriptExportContext.suggestedName = refreshed.title || activeTranscriptExportContext.suggestedName;
      activeTranscriptExportContext.config = buildExportFormatOptions({
        captionsAvailable: Boolean(refreshed.captionsAvailable),
        captionsStatus: refreshed.captionsStatus || 'missing',
        hasAudio: Boolean(refreshed.audioPath),
      });
      renderTranscriptExportFormatOptions(
        activeTranscriptExportContext.config,
        refreshed.captionsAvailable ? 'srt' : 'md',
      );
    }
    addLog('Re-transcription completed.');
  } catch (error) {
    if (errorEl) {
      errorEl.textContent = `Re-transcription failed: ${error && error.message ? error.message : error}`;
      errorEl.hidden = false;
    }
    addLog(`Re-transcription failed: ${error && error.message ? error.message : error}`, 'error');
  } finally {
    transcriptExportBusy = false;
    if (retranscribeBtn) {
      retranscribeBtn.disabled = false;
      retranscribeBtn.textContent = 'Re-transcribe from audio';
    }
  }
}

function setupTranscriptExportDialog() {
  const modal = document.getElementById('transcript-export-modal');
  const form = document.getElementById('transcript-export-form');
  const optionsEl = document.getElementById('transcript-export-options');
  const cancelBtn = document.getElementById('transcript-export-cancel');
  const retranscribeBtn = document.getElementById('transcript-export-retranscribe-btn');
  const confirmBtn = document.getElementById('transcript-export-confirm');
  const errorEl = document.getElementById('transcript-export-error');
  if (!modal || !form || modal.dataset.bound === 'true') return;
  modal.dataset.bound = 'true';

  optionsEl?.addEventListener('change', () => {
    for (const label of optionsEl.querySelectorAll('.transcript-export-option')) {
      const radio = label.querySelector('input[type="radio"]');
      label.classList.toggle('is-selected', Boolean(radio && radio.checked));
    }
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
    updateTranscriptExportSubtitleControls();
  });

  cancelBtn?.addEventListener('click', () => {
    closeTranscriptExportDialog();
  });

  retranscribeBtn?.addEventListener('click', () => {
    if (activeTranscriptExportContext && activeTranscriptExportContext.meetingId) {
      void retranscribeMeetingForCaptions(activeTranscriptExportContext.meetingId);
    }
  });

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeTranscriptExportDialog({ restoreFocus: false });
    }
  });

  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeTranscriptExportDialog();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusables = [...modal.querySelectorAll('input:not(:disabled), button:not(:disabled)')]
      .filter((element) => !element.hidden && element.offsetParent !== null);
    if (focusables.length === 0) return;
    const activeIndex = focusables.indexOf(document.activeElement);
    if (event.shiftKey && activeIndex <= 0) {
      event.preventDefault();
      focusables[focusables.length - 1].focus();
    } else if (!event.shiftKey && activeIndex === focusables.length - 1) {
      event.preventDefault();
      focusables[0].focus();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeTranscriptExportContext || transcriptExportBusy) return;
    const selectedRadio = form.querySelector('input[name="transcript-export-format"]:checked');
    const format = selectedRadio ? selectedRadio.value : 'md';
    const includeSpeakers = Boolean(document.getElementById('transcript-export-include-speakers')?.checked ?? true);
    const useVoiceTags = Boolean(document.getElementById('transcript-export-use-voice-tags')?.checked);

    transcriptExportBusy = true;
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Saving…';
    }
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }

    try {
      const result = await window.electronAPI.saveTranscriptAs({
        suggestedName: activeTranscriptExportContext.suggestedName,
        content: activeTranscriptExportContext.content,
        format,
        meetingId: activeTranscriptExportContext.meetingId || undefined,
        includeSpeakers,
        useVoiceTags,
      });

      if (result && result.ok === false) {
        const message = result.error || 'Subtitle timing data is unavailable for this recording.';
        if (errorEl) {
          errorEl.textContent = message;
          errorEl.hidden = false;
        }
        addLog(message, 'warning');
        if (activeTranscriptExportContext.config) {
          renderTranscriptExportFormatOptions({
            ...activeTranscriptExportContext.config,
            captionsUnavailableNotice: message,
            canRetranscribe: Boolean(activeTranscriptExportContext.meetingId),
            options: activeTranscriptExportContext.config.options.map((opt) => (
              opt.format === 'srt' || opt.format === 'vtt'
                ? { ...opt, available: false, disabledReason: message }
                : opt
            )),
          }, 'md');
        }
        return;
      }

      if (result && !result.canceled && result.filePath) {
        addLog(`Transcript saved to ${result.filePath}`);
        closeTranscriptExportDialog();
      } else if (result && result.canceled) {
        transcriptExportBusy = false;
      }
    } catch (err) {
      console.error('Save failed:', err);
      if (errorEl) {
        errorEl.textContent = `Failed to save transcript: ${err.message}`;
        errorEl.hidden = false;
      }
      addLog(`Failed to save transcript: ${err.message}`, 'error');
    } finally {
      transcriptExportBusy = false;
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Save as…';
      }
    }
  });
}

// Save the currently selected history meeting's transcript via native dialog.
// Defaults the filename to the meeting's display label so renamed meetings
// save with the user-friendly name they chose.
async function saveMeetingTranscriptToFile() {
  if (!currentMeetingId) {
    addLog('Select a recording first.', 'warning');
    return;
  }

  const meeting = findMeetingById(currentMeetingId);
  let fullMeeting = meeting || null;
  let suggestedName = (meeting && meeting.title) || 'Transcript';
  const transcriptEl = document.getElementById('meeting-transcript');
  let content = (transcriptEl && transcriptEl.dataset.markdown) || '';

  try {
    const loaded = await window.electronAPI.getMeeting(currentMeetingId);
    if (loaded) {
      fullMeeting = loaded;
      suggestedName = loaded.title || suggestedName;
      if (!content && loaded.transcript) {
        content = loaded.transcript;
      }
    }
  } catch (err) {
    if (!content) {
      console.error('Failed to load transcript for save:', err);
      addLog(`Failed to load transcript: ${err.message}`, 'error');
      return;
    }
  }

  if (!content.trim()) {
    addLog('Transcript is empty.', 'warning');
    return;
  }

  openTranscriptExportDialog({
    suggestedName,
    content,
    meeting: fullMeeting,
    triggerElement: document.getElementById('save-meeting-transcript-btn'),
  });
}

function getRenderedTranscriptFallbackText() {
  // Home Activity replaced the inline transcript panel (PR2).
  return '';
}

// Save transcript via native Save dialog. Default filename uses the
// current recording's display label (renamed or auto-generated) so users
// get a meaningful name without further typing.
async function saveTranscript() {
  // Prefer the rich markdown saved on disk by the backend transcriber when
  // available, falling back to whatever is currently in the transcript pane.
  let content = currentRecordingTranscriptMarkdown || '';
  let suggestedName = 'Transcript';
  let fullMeeting = currentRecordingMeeting || null;

  if (currentRecordingMeeting && currentRecordingMeeting.id) {
    suggestedName = currentRecordingMeeting.title || suggestedName;
    try {
      const loaded = await window.electronAPI.getMeeting(currentRecordingMeeting.id);
      if (loaded) {
        fullMeeting = loaded;
        suggestedName = loaded.title || suggestedName;
        if (!content && loaded.transcript) {
          content = loaded.transcript;
          currentRecordingTranscriptMarkdown = loaded.transcript;
        }
      }
    } catch (err) {
      if (!content) {
        console.warn('Failed to load saved transcript markdown, falling back to rendered text:', err);
      }
    }
  }

  if (!content) {
    // Last-resort fallback for unsaved/legacy states where only rendered text exists.
    content = getRenderedTranscriptFallbackText();
  }

  if (!content.trim()) {
    addLog('Nothing to save yet.', 'warning');
    return;
  }

  openTranscriptExportDialog({
    suggestedName,
    content,
    meeting: fullMeeting,
  });
}

// Delete meeting
async function deleteMeetingHandler(meetingId, fallbackTitle = '') {
  const idToDelete = meetingId != null ? String(meetingId) : currentMeetingId;
  if (!idToDelete) {
    console.error('No meeting ID to delete');
    return;
  }

  const meeting = findMeetingById(idToDelete);
  const displayTitle = (meeting && meeting.title) || String(fallbackTitle || '').trim() || idToDelete;

  if (confirm(`Delete "${displayTitle}"? This cannot be undone.`)) {
    try {
      // Release audio player file lock before deleting (Windows issue)
      const audioPlayer = document.getElementById('audio-player');
      if (audioPlayer.src) {
        audioPlayer.pause();
        audioPlayer.removeAttribute('src');
        audioPlayer.load();
      }

      addLog(`Deleting recording: ${displayTitle}...`);

      // Small delay to ensure OS releases the file handle
      await new Promise(resolve => setTimeout(resolve, 300));

      await window.electronAPI.deleteMeeting(idToDelete);

      // Clear the view immediately
      if (meetingIdsEqual(currentMeetingId, idToDelete)) {
        meetingDetails.style.display = 'none';
        document.getElementById('meeting-details-empty').style.display = 'flex';
        currentMeetingId = null;
        clearHistorySpeakers();
      }

      // Remove from local list immediately
      meetings = meetings.filter((m) => !meetingIdsEqual(m.id, idToDelete));
      renderMeetingList();
      await loadMeetingHistory();

      addLog('Recording deleted.');
    } catch (error) {
      console.error('Delete failed:', error);
      addLog(`Error: ${error.message}`, 'error');
      alert('Could not delete recording: ' + error.message);
    }
  }
}

// Timer functions
function startTimer() {
  stopTimer();
  const renderElapsed = () => {
    const elapsedMs = Math.max(0, Date.now() - (recordingStartTime || Date.now()));
    const elapsedText = formatElapsedDuration(elapsedMs / 1000);
    if (timer) {
      timer.textContent = elapsedText;
    }
    if (recordingState === 'recording') {
      updateRecordingPresenceUI(elapsedText);
    }
  };
  renderElapsed();
  timerInterval = setInterval(renderElapsed, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function stopRecordingPresencePoll() {
  if (recordingPresencePollTimer) {
    clearInterval(recordingPresencePollTimer);
    recordingPresencePollTimer = null;
  }
}

// Runs the shipped init hydration composition: one-shot guard, capture probe,
// recovery discovery (never gating), admission flag, and control refresh.
async function ensureRecordingHydration() {
  if (hydratedCaptureState) {
    return;
  }
  hydratedCaptureState = true;
  try {
    if (!audioVisualizer) {
      audioVisualizer = new AudioVisualizer();
    }
    setupEventListeners();
    setupRecordingRecoveryUi();
    const captureHydrated = await hydrateRecordingStateFromMain();
    try {
      await queryRecordingRecoveryState();
    } catch (recoveryError) {
      // Recovery discovery must never gate capture: recording controls stay
      // driven by the authoritative capture probe alone. Recovery retries
      // through its banner/refresh path.
      console.error('Failed to query recording recovery state:', recoveryError);
      addLog(`Could not check for interrupted recordings: ${recoveryError.message}`, 'warning');
    }
    if (!captureHydrated) {
      hydratedCaptureState = false;
      recordingHydrationFailed = true;
      addLog('Could not confirm whether a recording is in progress. Recording stays unavailable until the state can be confirmed.', 'error');
      if (typeof statusText !== 'undefined' && statusText) {
        statusText.textContent = 'Could not confirm recording state. Reload to retry.';
      }
      return;
    }
    recordingHydrated = true;
    if (recordingHydrationFailed) {
      recordingHydrationFailed = false;
      addLog('Recording state confirmed. Ready to record!');
    }
    updateButtonUI();
    updateControlsState();
  } catch (hydrateError) {
    console.error('Failed to hydrate recording state:', hydrateError);
    hydratedCaptureState = false;
  }
}

async function hydrateRecordingStateFromMain() {
  if (!window.electronAPI?.getRecordingState) {
    return false;
  }

  let mainState;
  try {
    mainState = await window.electronAPI.getRecordingState();
  } catch (error) {
    console.error('Failed to hydrate recording state from main:', error);
    return false;
  }

  if (!mainState || mainState.state === 'idle') {
    return true;
  }

  if (mainState.state === 'recording' && canHydratedRendererStopRecording(mainState)) {
    activeRecordingSessionId = mainState.sessionId;
    recordingStartTime = Number(mainState.startedAt) || Date.now();
    // Main owns the authoritative capture mode; without it a hydrated renderer
    // would show a dead meter and "mic + system audio" for a single-source run.
    activeCaptureMode = normalizeCaptureMode(mainState.captureMode);
    setRecordingState('recording');
    startTimer();
    if (audioVisualizer) {
      audioVisualizer.start(activeCaptureMode);
    }
    addLog('Resumed an in-progress recording after window reload.');
    return true;
  }

  if (mainState.state === 'starting' || mainState.state === 'stopping' || mainState.state === 'cancelling') {
    activeRecordingSessionId = Number.isInteger(mainState.sessionId) ? mainState.sessionId : null;
    recordingStartTime = Number.isFinite(mainState.startedAt) ? mainState.startedAt : null;
    if (
      (mainState.state === 'stopping' || mainState.state === 'cancelling')
      && Number.isFinite(recordingStartTime)
    ) {
      frozenPresenceElapsedText = formatElapsedDuration((Date.now() - recordingStartTime) / 1000);
    }
    activeCaptureMode = normalizeCaptureMode(mainState.captureMode);
    setRecordingState(mainState.state);
    startRecordingPresencePoll();
    return true;
  }

  return true;
}

function startRecordingPresencePoll() {
  stopRecordingPresencePoll();
  recordingPresencePollTimer = setInterval(async () => {
    if (!window.electronAPI?.getRecordingState) {
      stopRecordingPresencePoll();
      return;
    }
    if (
      recordingState !== 'starting'
      && recordingState !== 'stopping'
      && recordingState !== 'cancelling'
    ) {
      stopRecordingPresencePoll();
      return;
    }

    let mainState;
    try {
      mainState = await window.electronAPI.getRecordingState();
    } catch (error) {
      console.warn('Recording state poll failed:', error);
      return;
    }

    if (!mainState) {
      return;
    }

    if (mainState.state === 'recording') {
      stopRecordingPresencePoll();
      activeRecordingSessionId = mainState.sessionId;
      recordingStartTime = Number(mainState.startedAt) || Date.now();
      frozenPresenceElapsedText = null;
      activeCaptureMode = normalizeCaptureMode(mainState.captureMode);
      setRecordingState('recording');
      startTimer();
      if (audioVisualizer) {
        audioVisualizer.start(activeCaptureMode);
      }
      addLog('Recording became active after window reload.');
      return;
    }

    if (mainState.state === 'idle' && (recordingState === 'stopping' || recordingState === 'cancelling')) {
      const wasCancelling = recordingState === 'cancelling';
      stopRecordingPresencePoll();
      setRecordingState('idle');
      if (wasCancelling) {
        addLog('Recording discard finished while this window was reloading.');
        return;
      }
      addLog('Recording finished while this window was reloading. Refreshing History...');
      try {
        await loadMeetingHistory({ scan: true });
      } catch (error) {
        console.warn('History refresh after hydrated stop failed:', error);
      }
      return;
    }

    if (mainState.state === 'idle' && recordingState === 'starting') {
      stopRecordingPresencePoll();
      setRecordingState('idle');
    }
  }, 1000);
}

// Add log message
function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry ${type}`;
  logEntry.textContent = `[${timestamp}] ${message}`;
  progressLog.appendChild(logEntry);
  while (progressLog.children.length > MAX_PROGRESS_LOG_ENTRIES) {
    progressLog.removeChild(progressLog.firstChild);
  }
  progressLog.scrollTop = progressLog.scrollHeight;
}

// Tab switching
function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const railButtons = document.querySelectorAll('.rail-btn[data-tab]');
  const allNavButtons = [...tabButtons, ...railButtons];

  allNavButtons.forEach((button) => {
    button.addEventListener('click', () => {
      activateTab(button.dataset.tab);
    });
  });
}

function setStatusBadge(badge, status) {
  if (!badge) {
    return;
  }

  badge.textContent = formatStatusLabel(status);
  badge.className = 'setting-badge';
  if (status === 'ready') {
    badge.classList.add('enabled');
  } else if (status === 'downloading' || status === 'validating') {
    badge.classList.add('installing');
  } else {
    badge.classList.add('disabled');
  }
}

function renderAiAddonProgress(feature) {
  const state = aiAddonDownloadState[feature];
  const progressEl = document.getElementById(`${feature}-progress`);
  const progressBar = document.getElementById(`${feature}-progress-bar`);
  const progressText = document.getElementById(`${feature}-progress-text`);
  const cancelButton = document.getElementById(`cancel-${feature === 'summary' ? 'summary' : 'diarization'}-btn`);
  if (feature === 'summary' && typeof summaryLibrary === 'function' && summaryLibrary()) {
    if (progressEl) {
      if (progressEl.style) progressEl.style.display = 'none';
      progressEl.hidden = true;
    }
    if (cancelButton) {
      if (cancelButton.style) cancelButton.style.display = 'none';
      cancelButton.hidden = true;
    }
    return;
  }
  const terminalMessage = /ready|failed|error|cancel|unsupported|token|not supported/i.test((state && state.message) || '');
  const showCancel = Boolean(state && state.active && !(terminalMessage && !state.cancelling));
  if (!state || !progressEl || !progressBar || !progressText) {
    if (cancelButton) {
      cancelButton.style.display = showCancel ? 'inline-flex' : 'none';
      cancelButton.disabled = Boolean(state && state.cancelling);
      cancelButton.toggleAttribute('aria-busy', Boolean(state && state.cancelling));
    }
    return;
  }

  progressEl.style.display = state.active ? 'block' : 'none';
  progressEl.setAttribute('aria-busy', state.active && !state.cancelling ? 'true' : 'false');
  progressBar.style.width = `${Math.max(0, Math.min(100, state.percent || 0))}%`;
  progressText.textContent = state.cancelling ? 'Cancelling and cleaning up partial files...' : (state.message || 'Starting...');
  if (cancelButton) {
    cancelButton.style.display = showCancel ? 'inline-flex' : 'none';
    cancelButton.disabled = Boolean(state.cancelling);
    cancelButton.textContent = state.cancelling ? 'Cancelling...' : 'Cancel Download';
    cancelButton.toggleAttribute('aria-busy', Boolean(state.cancelling));
  }
}

function setAiAddonProgressState(feature, updates = {}) {
  if (!aiAddonDownloadState[feature]) {
    return;
  }

  aiAddonDownloadState[feature] = {
    ...aiAddonDownloadState[feature],
    ...updates,
  };
  renderAiAddonProgress(feature);
  if (feature === 'summary' && aiAddonStatusSnapshot?.summaryLibrary) {
    if (typeof updateSummaryModelLibraryProgressInPlace === 'function') {
      updateSummaryModelLibraryProgressInPlace(aiAddonStatusSnapshot.summaryLibrary);
    } else if (typeof renderSummaryModelLibrary === 'function') {
      renderSummaryModelLibrary(aiAddonStatusSnapshot.summaryLibrary);
    }
  }
}

const aiAddonProgressHideTimers = {
  diarization: null,
  summary: null,
};

function clearAiAddonProgressHideTimer(feature) {
  const timer = aiAddonProgressHideTimers[feature];
  if (timer) {
    clearTimeout(timer);
    aiAddonProgressHideTimers[feature] = null;
  }
}

function hideAiAddonProgressSoon(feature, delayMs = 2500) {
  clearAiAddonProgressHideTimer(feature);
  aiAddonProgressHideTimers[feature] = setTimeout(() => {
    aiAddonProgressHideTimers[feature] = null;
    const state = aiAddonDownloadState[feature];
    if (state && !state.cancelling) {
      setAiAddonProgressState(feature, { active: false, cancelling: false });
      if (aiAddonStatusSnapshot) {
        updateAiAddonSettings(aiAddonStatusSnapshot);
        updateHomeAiAddonCTA(aiAddonStatusSnapshot);
      }
    }
  }, delayMs);
}

function handleAiAddonProgress(progress) {
  if (!progress || (progress.feature !== 'summary' && progress.feature !== 'diarization')) {
    return;
  }

  const percent = Number.isFinite(progress.percent)
    ? progress.percent
    : aiAddonDownloadState[progress.feature].percent;
  const fallbackPercent = progress.phase === 'extracting-runtime' ? 90 : percent;
  const isActive = isAiAddonProgressPhase(progress) && progress.status !== 'ready';
  const isCancelled = progress.phase === 'cancelled';
  const isTerminal = progress.status === 'ready'
    || progress.status === 'error'
    || isCancelled
    || progress.phase === 'cancelled'
    || progress.phase === 'unsupported'
    || progress.phase === 'needsAccount';

  if (isTerminal) {
    const keepReadyProgress = progress.status === 'ready' && progress.phase !== 'cancelled';
    const holdProgress = keepReadyProgress || progress.status === 'error';
    let terminalPercent = aiAddonDownloadState[progress.feature].percent || 0;
    if (keepReadyProgress) {
      terminalPercent = 100;
    } else if (progress.status === 'error') {
      terminalPercent = Math.max(terminalPercent, 100);
    } else if (isCancelled) {
      terminalPercent = 0;
    }
    setAiAddonProgressState(progress.feature, {
      active: holdProgress || isCancelled,
      terminal: true,
      cancelling: false,
      percent: terminalPercent,
      message: progress.message || '',
      modelId: progress.modelId || aiAddonDownloadState[progress.feature].modelId || null,
    });
    if (holdProgress || isCancelled) {
      hideAiAddonProgressSoon(progress.feature, progress.status === 'ready' ? 2500 : 5000);
    }
    if (progress.status !== 'ready') {
      setTimeout(() => refreshAiAddonSettings(), 0);
    }
    return;
  }

  if (isActive) {
    clearAiAddonProgressHideTimer(progress.feature);
    setAiAddonProgressState(progress.feature, {
      active: true,
      terminal: false,
      cancelling: false,
      percent: Math.max(0, Math.min(100, fallbackPercent || 0)),
      message: formatAiAddonProgressText(progress),
      modelId: progress.modelId || aiAddonDownloadState[progress.feature].modelId || null,
    });
  }
}

function renderFootprintRows(container, rows) {
  if (!container) {
    return;
  }

  clearElement(container);
  rows.filter((row) => row && row.value).forEach((row) => {
    const item = document.createElement('div');
    item.textContent = `${row.label}: ${row.value}`;
    container.appendChild(item);
  });
}

function updateDiarizationFootprint(diarization) {
  const unsupportedRows = getUnsupportedAiAddonFootprintRows(diarization);
  if (unsupportedRows) {
    renderFootprintRows(document.getElementById('diarization-footprint'), unsupportedRows);
    return;
  }

  const storage = diarization && diarization.storage;
  const estimatedDownload = storage && storage.estimatedDownloadBytes;
  const installed = storage && storage.installedBytes;
  const estimatedInstalled = storage && storage.estimatedInstalledBytes;
  const engine = resolveSelectedDiarizationEngine(diarization);
  const runtimeLabel = engine === 'speakrs'
    ? (diarization && diarization.availability && diarization.availability.acceleration === 'mps'
      ? 'Apple Silicon (CoreML)'
      : 'NVIDIA GPU (CUDA)')
    : (diarization && diarization.availability && diarization.availability.acceleration === 'mps'
      ? 'Apple Silicon (Metal)'
      : 'NVIDIA GPU (CUDA)');
  const downloadFallback = engine === 'speakrs'
    ? 'about 800 MB'
    : (diarization && diarization.availability && diarization.availability.acceleration === 'mps'
      ? 'about 2 GB'
      : 'about 4 GB');
  const downloadState = aiAddonDownloadState.diarization;
  renderFootprintRows(document.getElementById('diarization-footprint'), [
    { label: 'Download', value: estimatedDownload ? `up to ${formatBytes(estimatedDownload)}` : downloadFallback },
    { label: 'Progress', value: downloadState.active ? `${Math.round(downloadState.percent || 0)}%` : null },
    { label: 'Installed', value: installed ? formatBytes(installed) : (estimatedInstalled ? `about ${formatBytes(estimatedInstalled)}` : 'Not installed') },
    { label: 'Hardware', value: runtimeLabel },
  ]);
}

function updateSummaryFootprint(summary) {
  const unsupportedRows = getUnsupportedAiAddonFootprintRows(summary);
  if (unsupportedRows) {
    renderFootprintRows(document.getElementById('summary-footprint'), unsupportedRows);
    return;
  }

  const storage = summary && summary.storage;
  const estimatedModel = storage && storage.estimatedModelBytes;
  const estimatedRuntime = storage && storage.estimatedRuntimeBytes;
  const installed = storage && storage.installedBytes;
  const estimatedInstalled = storage && storage.estimatedInstalledBytes;
  const runtimeLabel = summary && summary.artifact && summary.artifact.acceleration === 'metal'
    ? 'Apple Silicon (Metal)'
    : 'NVIDIA GPU (CUDA)';
  const downloadState = aiAddonDownloadState.summary;
  renderFootprintRows(document.getElementById('summary-footprint'), [
    { label: 'Model', value: summary && summary.artifact && summary.artifact.label },
    { label: 'Model download', value: estimatedModel ? formatBytes(estimatedModel) : null },
    { label: 'Runtime download', value: estimatedRuntime ? formatBytes(estimatedRuntime) : null },
    { label: 'Progress', value: downloadState.active ? `${Math.round(downloadState.percent || 0)}%` : null },
    { label: 'Installed', value: installed ? formatBytes(installed) : (estimatedInstalled ? `about ${formatBytes(estimatedInstalled)}` : 'Not installed') },
    { label: 'Hardware', value: runtimeLabel },
  ]);
}

function updateAiAddonFootprintWarning(status) {
  const warningEl = document.getElementById('ai-addon-footprint-warning');
  if (!warningEl) {
    return;
  }

  const warnings = status && status.footprint && Array.isArray(status.footprint.warnings)
    ? status.footprint.warnings
    : [];
  if (!warnings.length) {
    warningEl.style.display = 'none';
    warningEl.textContent = '';
    return;
  }

  warningEl.textContent = warnings.join(' ');
  warningEl.style.display = 'block';
}

function setAiAddonControlsDisabled(disabled) {
  [
    'diarization-token-input',
    'home-diarization-token-input',
    'diarization-speaker-count',
    'setup-diarization-btn',
    'home-setup-diarization-btn',
    'validate-diarization-btn',
    'remove-diarization-btn',
    'summary-profile-select',
    'setup-summary-btn',
    'validate-summary-btn',
    'remove-summary-btn',
  ].forEach((id) => {
    const element = document.getElementById(id);
    if (element) {
      element.disabled = disabled;
    }
  });
  document.querySelectorAll('.diarization-engine-radio').forEach((radio) => {
    radio.disabled = disabled;
  });
}

function applyAiAddonButtonState({ setupButton, validateButton, removeButton, controlState, setupLabel, validateLabel, removeLabel }) {
  const state = controlState || { canConfigure: false, canValidate: false, canRemove: false };
  if (setupButton) {
    setupButton.disabled = !state.canConfigure;
    if (setupLabel) {
      setupButton.textContent = setupLabel;
    }
  }
  if (validateButton) {
    validateButton.disabled = !state.canValidate;
    if (validateLabel) {
      validateButton.textContent = validateLabel;
    }
  }
  if (removeButton) {
    removeButton.disabled = !state.canRemove;
    if (removeLabel) {
      removeButton.textContent = removeLabel;
    }
  }
}

function applyDiarizationEngineRadioState(canSelectEngine) {
  document.querySelectorAll('.diarization-engine-radio').forEach((radio) => {
    const card = radio.closest('.diarization-engine-card');
    radio.disabled = !canSelectEngine || Boolean(card && card.hidden);
  });
}

function getActiveDiarizationSetupLabel(diarization, selectedEngine) {
  return getDiarizationSetupButtonLabel({
    selectedEngine,
    installedEngine: resolveSelectedDiarizationEngine(diarization),
    hasOtherEngineLocalState: hasDiarizationLocalState(diarization),
  });
}

function appendAiAddonLog(text) {
  const logDiv = document.getElementById('ai-addon-log');
  const logOutput = document.getElementById('ai-addon-log-output');
  if (!logDiv || !logOutput) {
    return;
  }

  const now = new Date();
  const timestamp = `${now.toLocaleDateString()} ${now.toLocaleTimeString()}`;
  const stamped = String(text ?? '').split('\n').map((line) => `[${timestamp}] ${line}`).join('\n');
  logDiv.style.display = 'block';
  logOutput.textContent += `${stamped}\n`;
  const rawLines = logOutput.textContent.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  if (rawLines.length > MAX_PROGRESS_LOG_ENTRIES) {
    logOutput.textContent = `${rawLines.slice(-MAX_PROGRESS_LOG_ENTRIES).join('\n')}\n`;
  }
  logOutput.scrollTop = logOutput.scrollHeight;
}

function shouldLogAiAddonProgress(progress) {
  if (!progress || (progress.feature !== 'summary' && progress.feature !== 'diarization') || !progress.message) {
    return false;
  }

  const state = aiAddonProgressLogState[progress.feature];
  const percent = Number.isFinite(progress.percent) ? Math.round(progress.percent) : null;
  const key = `${progress.phase || ''}:${progress.status || ''}:${progress.message}`;
  const now = Date.now();
  const terminal = progress.status === 'ready'
    || progress.status === 'error'
    || progress.phase === 'cancelled'
    || progress.phase === 'unsupported'
    || progress.phase === 'needsAccount';

  if (terminal || key !== state.lastKey) {
    state.lastKey = key;
    state.lastPercent = percent ?? state.lastPercent;
    state.lastAt = now;
    return true;
  }

  if (percent !== null && Math.abs(percent - state.lastPercent) >= 5 && now - state.lastAt >= AI_ADDON_PROGRESS_LOG_INTERVAL_MS) {
    state.lastPercent = percent;
    state.lastAt = now;
    return true;
  }

  return false;
}

function summaryLibrary() {
  return aiAddonStatusSnapshot?.summaryLibrary || null;
}

function usableSummaryModels(library = summaryLibrary()) {
  return (library?.models || []).filter((model) => model.installed && model.setupComplete && model.status === 'ready' && model.fit?.blocked !== true);
}

function summaryModelName(id, library = summaryLibrary()) {
  return library?.models?.find((model) => model.modelId === id)?.modelName || id || 'No default';
}

function summaryModelHasFiles(model) {
  return Boolean(model.installed || model.removalPending || model.installedBytes > 0 || /removal is incomplete/i.test(model.error || ''));
}

function summaryFitLabel(status) {
  return ({ fits: 'Fits this device', needs_more_memory: 'May need more memory', runtime_needed: 'Runtime setup needed', unavailable: 'Unavailable on this device', unknown: 'Couldn’t check memory' })[status] || 'Compatibility not checked';
}

function summaryDownloadConfirmation(model, library) {
  const size = (value) => value == null ? 'unknown' : formatBytes(value);
  const shortfall = library.availableBytes != null && model.peakFreeBytes != null
    ? Math.max(0, model.peakFreeBytes - library.availableBytes) : null;
  return `Download ${model.modelName}?\nModel download: ${size(model.downloadBytes)} · Runtime download: ${size(model.runtimeDownloadBytes)} · Total additional download: ${size(model.additionalDownloadBytes)}.\nPeak free space needed: ${size(model.peakFreeBytes)} · Available: ${size(library.availableBytes)}.${shortfall ? ` Free another ${formatBytes(shortfall)} before setup.` : ''}`;
}

function formatSummaryModelCapabilities(model) {
  if (!model || model.fit?.status === 'unavailable') return null;
  const languages = Array.isArray(model.qualifiedLanguages)
    ? model.qualifiedLanguages
    : Array.isArray(model.languagePolicy?.languages)
      ? model.languagePolicy.languages
      : null;
  if (!languages) return null;
  if (languages.length === 0) return 'Chat only on this platform';
  if (languages.length === 1) {
    const code = languages[0];
    const name = model.languagePolicy?.names?.[code] || code;
    return `${name} summaries & Chat`;
  }
  return `Summaries (${languages.length} languages) & Chat`;
}

function createSummaryCardCancelButton() {
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-small btn-secondary summary-library-cancel-btn';
  cancel.textContent = 'Cancel setup';
  cancel.addEventListener('click', async () => {
    setAiAddonProgressState('summary', { cancelling: true, message: 'Cancelling and cleaning up partial files…' });
    try {
      await window.electronAPI.cancelSummaryModelSetup();
    } catch (error) {
      setAiAddonProgressState('summary', { cancelling: false, message: error.message || 'Could not cancel setup.' });
      showAppToast(error.message || 'Could not cancel setup.', 'error');
    }
  });
  return cancel;
}

function createSummaryCardProgressBox(progress) {
  const box = document.createElement('div');
  box.className = 'summary-library-card-progress';
  const barWrap = document.createElement('div');
  barWrap.className = 'progress-bar-container';
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  if (bar.style) bar.style.width = `${Math.max(0, Math.min(100, progress?.percent || 0))}%`;
  barWrap.appendChild(bar);
  const progressText = document.createElement('p');
  progressText.className = 'progress-text';
  progressText.setAttribute('role', 'status');
  progressText.textContent = `${progress?.message || 'Preparing setup…'}${Number.isFinite(progress?.percent) ? ` · ${Math.round(progress.percent)}%` : ''}`;
  box.appendChild(barWrap);
  box.appendChild(progressText);
  return box;
}

function updateSummaryModelLibraryProgressInPlace(library) {
  const container = document.getElementById('summary-model-library');
  if (!container || !library) return;
  if (typeof container.querySelectorAll !== 'function') {
    renderSummaryModelLibrary(library);
    return;
  }
  const cards = [...container.querySelectorAll('.summary-library-model')];
  if (!cards.length) {
    renderSummaryModelLibrary(library);
    return;
  }
  const progress = aiAddonDownloadState.summary;
  for (const card of cards) {
    const modelId = card.dataset?.modelId;
    const model = (library.models || []).find((item) => item.modelId === modelId);
    if (!model) continue;
    const removalIncomplete = Boolean(model.removalPending || /removal is incomplete/i.test(model.error || ''));
    const activeModel = Boolean(progress.active && progress.modelId === model.modelId);
    const stateText = activeModel
      ? (progress.cancelling ? 'Cancelling…' : (progress.message || 'Preparing setup…'))
      : removalIncomplete ? 'Removal incomplete' : model.status === 'ready' ? 'Ready' : model.status === 'error' ? 'Needs attention' : model.status;
    const stateBadge = card.querySelector('.summary-library-state-badge');
    if (stateBadge) {
      stateBadge.textContent = stateText;
    }
    const actions = card.querySelector('.ai-addon-actions');
    let progressBox = card.querySelector('.summary-library-card-progress');
    if (activeModel) {
      if (!progressBox) {
        progressBox = createSummaryCardProgressBox(progress);
        if (actions && typeof card.insertBefore === 'function') card.insertBefore(progressBox, actions);
        else card.appendChild(progressBox);
      }
      progressBox.hidden = false;
      const bar = progressBox.querySelector('.progress-bar');
      if (bar?.style) bar.style.width = `${Math.max(0, Math.min(100, progress.percent || 0))}%`;
      const progressText = progressBox.querySelector('.progress-text');
      if (progressText) {
        progressText.textContent = `${progress.cancelling ? 'Cancelling and cleaning up partial files…' : (progress.message || 'Preparing setup…')}${Number.isFinite(progress.percent) ? ` · ${Math.round(progress.percent)}%` : ''}`;
      }
    } else if (progressBox) {
      progressBox.hidden = true;
    }
    if (actions) {
      let cancelBtn = actions.querySelector('.summary-library-cancel-btn');
      if (activeModel && !progress.terminal) {
        if (!cancelBtn) {
          cancelBtn = createSummaryCardCancelButton();
          if (typeof actions.insertBefore === 'function') actions.insertBefore(cancelBtn, actions.firstChild || null);
          else actions.appendChild(cancelBtn);
        }
        cancelBtn.hidden = false;
        cancelBtn.disabled = Boolean(progress.cancelling);
        cancelBtn.textContent = progress.cancelling ? 'Cancelling…' : 'Cancel setup';
      } else if (cancelBtn) {
        if (typeof cancelBtn.remove === 'function') cancelBtn.remove();
        else cancelBtn.hidden = true;
      }
      for (const button of actions.querySelectorAll('button')) {
        if (button === cancelBtn || button.className?.includes('summary-library-cancel-btn')) continue;
        const baseDisabled = button.dataset?.baseDisabled === 'true';
        button.disabled = baseDisabled || Boolean(progress.active);
      }
    }
  }
}

function renderSummaryModelLibrary(library) {
  const container = document.getElementById('summary-model-library');
  if (!container) return;
  container.replaceChildren();
  const legacySetupBtn = document.getElementById('setup-summary-btn');
  const legacyActionsRow = legacySetupBtn?.parentElement || null;
  for (const id of ['summary-footprint', 'summary-status-text', 'setup-summary-btn', 'validate-summary-btn', 'remove-summary-btn', 'summary-progress', 'cancel-summary-btn']) {
    const element = document.getElementById(id);
    if (element) {
      element.hidden = Boolean(library);
      if (library && (id === 'summary-progress' || id === 'cancel-summary-btn') && element.style) {
        element.style.display = 'none';
      }
    }
  }
  if (legacyActionsRow) {
    legacyActionsRow.hidden = Boolean(library);
  }
  if (!library) return;
  const total = document.createElement('p');
  total.className = 'setting-description';
  total.textContent = `${formatBytes(library.installedBytes || 0)} managed storage · ${formatBytes(library.sharedRuntimeBytes || 0)} shared files · ${library.availableBytes == null ? 'Free space unknown' : `${formatBytes(library.availableBytes)} free`}`;
  container.appendChild(total);
  for (const [heading, installed] of [['Installed', true], ['Available to download', false]]) {
    const models = (library.models || []).filter((model) => summaryModelHasFiles(model) === installed);
    if (!models.length) continue;
    const title = document.createElement('h4'); title.textContent = heading; container.appendChild(title);
    for (const model of models) {
      const card = document.createElement('div'); card.className = 'summary-library-model';
      if (card.dataset) card.dataset.modelId = model.modelId;
      const header = document.createElement('div'); header.className = 'summary-library-model-header';
      const name = document.createElement('strong'); name.className = 'summary-library-model-name';
      name.textContent = model.modelName;
      const removalIncomplete = Boolean(model.removalPending || /removal is incomplete/i.test(model.error || ''));
      const progress = aiAddonDownloadState.summary;
      const activeModel = Boolean(progress.active && progress.modelId === model.modelId);
      const state = activeModel
        ? (progress.cancelling ? 'Cancelling…' : (progress.message || 'Preparing setup…'))
        : removalIncomplete ? 'Removal incomplete' : model.status === 'ready' ? 'Ready' : model.status === 'error' ? 'Needs attention' : model.status;
      const badges = document.createElement('span'); badges.className = 'summary-library-badges';
      const stateBadge = document.createElement('span');
      stateBadge.className = `summary-library-badge summary-library-state-badge${model.status === 'ready' && !activeModel ? ' is-ready' : (model.status === 'error' || removalIncomplete) ? ' is-error' : ''}`;
      stateBadge.textContent = state;
      badges.appendChild(stateBadge);
      if (model.modelId === library.defaultModelId) {
        const defaultBadge = document.createElement('span');
        defaultBadge.className = 'summary-library-badge is-default';
        defaultBadge.textContent = 'Default';
        badges.appendChild(defaultBadge);
      }
      if (chatState.modelState.modelId === model.modelId && chatState.modelState.status === 'loaded') {
        const loadedBadge = document.createElement('span');
        loadedBadge.className = 'summary-library-badge is-ready';
        loadedBadge.textContent = 'In memory';
        badges.appendChild(loadedBadge);
      }
      header.appendChild(name);
      header.appendChild(badges);
      card.appendChild(header);

      const descParts = [model.description, formatSummaryModelCapabilities(model)].filter(Boolean);
      if (descParts.length) {
        const descP = document.createElement('p');
        descP.className = 'setting-description summary-library-model-desc';
        descP.textContent = descParts.join(' · ');
        card.appendChild(descP);
      }

      const memoryReading = model.fit?.totalMemoryBytes != null
        ? `${formatBytes(model.fit.totalMemoryBytes)} ${model.fit.memoryType || 'device memory'}${model.fit.availableMemoryBytes != null ? ` (${formatBytes(model.fit.availableMemoryBytes)} available)` : ''}`
        : 'Device memory reading unavailable';
      const fitParts = [
        `${summaryFitLabel(model.fit?.status)}${model.fit?.reason ? ` · ${model.fit.reason}` : ''}`,
        memoryReading,
        model.fit?.contextTokens != null ? `${Number(model.fit.contextTokens).toLocaleString()} token context` : null,
        model.fit?.workingMemoryBytes != null ? `${formatBytes(model.fit.workingMemoryBytes)} est. working memory` : null,
      ].filter(Boolean);
      const fitP = document.createElement('p');
      fitP.className = 'setting-description summary-library-model-fit';
      fitP.textContent = fitParts.join(' · ');
      card.appendChild(fitP);

      const storageLine = installed
        ? `${formatBytes(removalIncomplete ? (model.residualBytes ?? model.installedBytes ?? 0) : (model.installedBytes || 0))} ${removalIncomplete ? 'remaining after removal' : 'on disk'}`
        : `${model.downloadBytes == null ? 'Download size unknown' : `${formatBytes(model.downloadBytes)} download`} · ${model.estimatedInstalledBytes == null ? 'Installed size unknown' : `${formatBytes(model.estimatedInstalledBytes)} installed`}`;
      const storageP = document.createElement('p');
      storageP.className = 'setting-description summary-library-model-storage';
      storageP.textContent = storageLine;
      card.appendChild(storageP);

      const showError = Boolean(
        model.error
        && !(removalIncomplete && /removal is incomplete/i.test(model.error))
        && model.error !== model.fit?.reason,
      );
      if (showError) {
        const errorP = document.createElement('p');
        errorP.className = 'setting-description summary-library-card-error';
        errorP.textContent = model.error;
        card.appendChild(errorP);
      }
      if (!installed && library.availableBytes != null && model.peakFreeBytes != null && model.peakFreeBytes > library.availableBytes) {
        const warning = document.createElement('p');
        warning.className = 'setting-description summary-library-card-error';
        warning.textContent = `Free ${formatBytes(model.peakFreeBytes - library.availableBytes)} to download this model. Manage installed models above.`;
        card.appendChild(warning);
      }
      if (activeModel) {
        card.appendChild(createSummaryCardProgressBox(progress));
      }
      const actions = document.createElement('div'); actions.className = 'ai-addon-actions';
      if (activeModel && !progress.cancelling && !progress.terminal) {
        actions.appendChild(createSummaryCardCancelButton());
      }
      const addAction = (label, action, disabled = false) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-small'; button.textContent = label;
        if (button.dataset) button.dataset.baseDisabled = disabled ? 'true' : 'false';
        button.disabled = disabled || aiAddonDownloadState.summary.active;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await action(); await refreshAiAddonSettings(); await refreshChatEligibility(); }
          catch (error) { showAppToast(error.message || 'Could not update the model.', 'error'); await refreshAiAddonSettings(); }
          finally { button.disabled = false; }
        });
        actions.appendChild(button);
      };
      const confirmSetup = async () => {
        if (!window.confirm(summaryDownloadConfirmation(model, library))) return;
        setAiAddonProgressState('summary', { active: true, terminal: false, modelId: model.modelId, percent: 0, message: 'Preparing setup…' });
        try { await window.electronAPI.setupSummaryModel({ modelId: model.modelId }); }
        catch (error) {
          setAiAddonProgressState('summary', { active: true, terminal: true, modelId: model.modelId, message: error.message || 'Setup failed.' });
          hideAiAddonProgressSoon('summary', 5000);
          throw error;
        }
      };
      const setupBlocked = model.fit?.blocked === true || (library.availableBytes != null && model.peakFreeBytes != null && model.peakFreeBytes > library.availableBytes);
      if (!installed) {
        addAction(model.status === 'error' ? 'Retry download' : 'Download', confirmSetup, setupBlocked);
      } else {
        if (!removalIncomplete) {
          if (model.modelId !== library.defaultModelId) addAction('Set as default', () => window.electronAPI.setDefaultSummaryModel({ modelId: model.modelId }), !usableSummaryModels(library).includes(model));
          addAction('Check setup', () => window.electronAPI.validateSummaryModel({ modelId: model.modelId }));
          if (!model.setupComplete && model.status === 'error') addAction('Repair', confirmSetup, setupBlocked);
        }
        if (chatState.modelState.modelId === model.modelId && ['loaded', 'release_error'].includes(chatState.modelState.status)) addAction('Free memory', () => window.electronAPI.unloadHistoryQaModel());
        addAction(removalIncomplete ? 'Retry removal' : 'Remove model', async () => {
          const others = usableSummaryModels(library).filter((item) => item.modelId !== model.modelId);
          let replacementModelId = null;
          if (model.modelId === library.defaultModelId && others.length > 1) {
            replacementModelId = await chooseSummaryReplacement(model, others);
            if (!replacementModelId) return;
          } else {
            replacementModelId = others[0]?.modelId || null;
            const replacement = model.modelId === library.defaultModelId ? `\n${others.length ? `${others[0].modelName} will become the default.` : 'There will be no default model.'}` : '';
            if (!window.confirm(`Remove ${model.modelName}? About ${formatBytes(model.reclaimableBytes || 0)} can be freed. Saved summaries and conversations stay available.${replacement}`)) return;
          }
          await window.electronAPI.removeSummaryModel({ modelId: model.modelId, replacementModelId });
        });
      }
      card.appendChild(actions); container.appendChild(card);
    }
  }
}

function chooseSummaryReplacement(model, choices) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
    const dialog = document.createElement('div'); dialog.className = 'modal-content';
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'summary-replacement-title');
    const header = document.createElement('div'); header.className = 'modal-header';
    const heading = document.createElement('h2'); heading.id = 'summary-replacement-title'; heading.textContent = 'Remove model';
    header.appendChild(heading);
    const body = document.createElement('div'); body.className = 'modal-body';
    const text = document.createElement('p'); text.className = 'setting-description';
    text.textContent = `Remove ${model.modelName} and free about ${formatBytes(model.reclaimableBytes || 0)}. Saved summaries and conversations stay available. Choose a new default.`;
    const field = document.createElement('div'); field.className = 'ai-addon-field';
    const label = document.createElement('label'); label.htmlFor = 'summary-replacement-select'; label.textContent = 'New default model';
    const select = document.createElement('select'); select.id = 'summary-replacement-select'; select.className = 'device-select';
    for (const choice of choices) select.add(new Option(choice.modelName, choice.modelId));
    field.append(label, select);
    body.append(text, field);
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = 'Cancel';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-danger'; remove.textContent = 'Remove model';
    actions.append(cancel, remove);
    const finish = (value) => { overlay.remove(); if (previousFocus?.isConnected) previousFocus.focus(); resolve(value); };
    cancel.onclick = () => finish(null); remove.onclick = () => finish(select.value);
    overlay.onkeydown = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(null); return; }
      if (event.key !== 'Tab') return;
      const controls = [select, cancel, remove];
      const index = controls.indexOf(document.activeElement);
      if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === controls.length - 1)) {
        event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus();
      }
    };
    dialog.append(header, body, actions); overlay.appendChild(dialog); document.body.appendChild(overlay); select.focus();
  });
}

async function refreshChatEligibility() {
  if (!window.electronAPI?.getHistoryQaEligibility) return;
  chatState.eligibility = await window.electronAPI.getHistoryQaEligibility();
  renderChatOnboardingAndComposer();
}

function renderChatModelChoice() {
  const select = document.getElementById('chat-model-select');
  const labelPill = document.getElementById('chat-model-label');
  const manage = document.getElementById('chat-manage-models');
  const library = summaryLibrary();
  if (!select || !manage) return;
  if (!library) {
    select.hidden = true;
    if (labelPill) labelPill.hidden = true;
    manage.hidden = true;
    return;
  }
  const usable = usableSummaryModels(library);
  let saved = (chatState.activeThread ? chatState.activeThread.modelId : chatState.pendingModelId) || '';
  const savedModel = library.models?.find((model) => model.modelId === saved);
  if (saved && !summaryModelHasFiles(savedModel || {}) && usable.some((model) => model.modelId === library.defaultModelId)) {
    const thread = chatState.activeThread;
    if (thread && chatState.resettingRemovedModelThreadId !== thread.id) {
      chatState.resettingRemovedModelThreadId = thread.id;
      void window.electronAPI.updateChatThreadModel({ threadId: thread.id, modelId: null }).then((result) => {
        if (chatState.activeThread?.id === thread.id) {
          chatState.activeThread = result?.thread || { ...thread, modelId: null };
          chatState.resettingRemovedModelThreadId = null;
          showAppToast(`The removed model was replaced by the default, ${summaryModelName(library.defaultModelId, library)}.`);
          renderChatOnboardingAndComposer();
        }
      }).catch((error) => showAppToast(`Could not reset the removed model: ${error.message}`, 'error'))
        .finally(() => { chatState.resettingRemovedModelThreadId = null; });
    } else if (!thread) chatState.pendingModelId = null;
    saved = '';
  }
  const defaultUsable = usable.some((model) => model.modelId === library.defaultModelId);
  const hasUnavailableSaved = Boolean(saved && !usable.some((model) => model.modelId === saved));
  manage.hidden = false;
  manage.textContent = usable.length ? 'Manage models' : (library.models?.some((m) => m.installed) ? 'Manage models' : 'Set up a model');
  manage.onclick = openSettingsAtAiAddons;

  if (usable.length === 0 && !hasUnavailableSaved) {
    select.hidden = true;
    if (labelPill) labelPill.hidden = true;
    return;
  }
  if (usable.length === 1 && !hasUnavailableSaved) {
    select.hidden = true;
    if (labelPill) {
      labelPill.hidden = false;
      labelPill.textContent = usable[0].modelName;
    }
    return;
  }

  if (labelPill) labelPill.hidden = true;
  select.hidden = false;
  select.replaceChildren();
  if (!defaultUsable) {
    select.add(new Option('Choose an available model', ''));
  }
  for (const model of usable) {
    const isDefault = defaultUsable && model.modelId === library.defaultModelId;
    select.add(new Option(isDefault ? `${model.modelName} · Default` : model.modelName, isDefault ? '' : model.modelId));
  }
  if (hasUnavailableSaved) {
    select.add(new Option(`${summaryModelName(saved, library)} · unavailable`, saved));
  }
  select.value = (saved && (!defaultUsable || saved !== library.defaultModelId)) ? saved : '';
  select.disabled = Boolean(chatState.sending);
  select.onchange = async () => {
    const modelId = select.value || null;
    try {
      if (chatState.activeThread) {
        const result = await window.electronAPI.updateChatThreadModel({ threadId: chatState.activeThread.id, modelId });
        if (result?.thread) chatState.activeThread = result.thread;
        else chatState.activeThread.modelId = modelId;
      } else chatState.pendingModelId = modelId;
      renderChatOnboardingAndComposer();
    } catch (error) { showAppToast(`Could not change model: ${error.message}`, 'error'); renderChatModelChoice(); }
  };
}

function updateAiAddonSettings(status) {
  if (typeof renderSummaryModelLibrary === 'function') renderSummaryModelLibrary(status?.summaryLibrary);
  if (typeof renderChatModelChoice === 'function') renderChatModelChoice();
  const diarization = status && status.features && status.features.diarization;
  const summary = status && status.features && status.features.summary;
  const library = status && status.summaryLibrary;
  const usableInLibrary = library ? usableSummaryModels(library) : [];
  const hasInstalledSummaryError = Boolean(library?.models?.some((m) => summaryModelHasFiles(m) && (m.status === 'error' || m.removalPending)));
  const diarizationUnsupported = diarization && diarization.status === 'unsupported';
  const diarizationSetupLocking = isAiAddonSetupLockingControls({
    featureStatus: diarization && diarization.status,
    progressActive: aiAddonDownloadState.diarization.active,
  });
  const summarySetupLocking = isAiAddonSetupLockingControls({
    featureStatus: summary && summary.status,
    progressActive: aiAddonDownloadState.summary.active,
  });
  const effectiveSummaryStatus = summarySetupLocking
    ? 'downloading'
    : (summary && summary.status === 'unsupported'
      ? 'unsupported'
      : library
        ? (usableInLibrary.length > 0 ? 'ready' : (hasInstalledSummaryError ? 'error' : (summary?.status || 'notConfigured')))
        : (summary?.status || 'notConfigured'));
  const hasActiveSetup = diarizationSetupLocking || summarySetupLocking;
  const overallStatus = hasActiveSetup
    ? 'downloading'
    : ((diarization && diarization.status === 'ready') || effectiveSummaryStatus === 'ready'
      ? 'ready'
      : ((diarization && diarization.status === 'error') || effectiveSummaryStatus === 'error' ? 'error' : 'notConfigured'));

  setStatusBadge(document.getElementById('ai-addons-status-badge'), overallStatus);

  const diarizationCard = document.getElementById('diarization-addon-card');
  const summaryCard = document.getElementById('summary-addon-card');
  if (diarizationCard) {
    diarizationCard.classList.toggle('is-unsupported', Boolean(diarizationUnsupported));
  }
  if (summaryCard) {
    summaryCard.classList.toggle('is-unsupported', Boolean(summary && summary.status === 'unsupported'));
  }

  if (diarization) {
    setStatusBadge(document.getElementById('diarization-status-badge'), diarization.status);
    const selectedEngine = getSelectedDiarizationEngine(diarization);
    const diarizationControlState = buildAiAddonControlState({
      feature: diarization,
      type: 'diarization',
      setupActive: diarizationSetupLocking,
      unsupported: diarizationUnsupported,
      selectedEngine,
    });
    applyDiarizationEngineCards({
      selectedEngine,
      platform: getRendererPlatform(),
      arch: homePromptContext.arch,
    });
    applyDiarizationEngineFields(selectedEngine, { unsupported: diarizationUnsupported });
    applyDiarizationEngineRadioState(diarizationControlState.canSelectEngine);
    const speakerCount = document.getElementById('diarization-speaker-count');
    if (speakerCount) {
      speakerCount.value = String(diarization.speakerCount || 'auto');
      speakerCount.disabled = !diarizationControlState.canConfigure;
    }

    const tokenInput = document.getElementById('diarization-token-input');
    if (tokenInput) {
      tokenInput.disabled = !diarizationControlState.canConfigure;
      tokenInput.placeholder = diarizationUnsupported ? 'Unavailable on this platform' : getDiarizationTokenInputPlaceholder();
    }
    const homeTokenInput = document.getElementById('home-diarization-token-input');
    if (homeTokenInput) {
      homeTokenInput.disabled = !diarizationControlState.canConfigure;
      homeTokenInput.placeholder = diarizationUnsupported ? 'Unavailable on this platform' : getDiarizationTokenInputPlaceholder();
    }

    applyAiAddonButtonState({
      setupButton: document.getElementById('setup-diarization-btn'),
      validateButton: document.getElementById('validate-diarization-btn'),
      removeButton: document.getElementById('remove-diarization-btn'),
      controlState: diarizationControlState,
      setupLabel: getActiveDiarizationSetupLabel(diarization, selectedEngine),
      validateLabel: getAiAddonValidateButtonLabel(),
      removeLabel: getAiAddonRemoveButtonLabel(),
    });
    applyAiAddonButtonState({
      setupButton: document.getElementById('home-setup-diarization-btn'),
      controlState: diarizationControlState,
      setupLabel: getActiveDiarizationSetupLabel(diarization, selectedEngine),
      validateLabel: getAiAddonValidateButtonLabel(),
      removeLabel: getAiAddonRemoveButtonLabel(),
    });

    const statusText = document.getElementById('diarization-status-text');
    if (statusText) {
      statusText.textContent = getDiarizationSetupMessage(diarization);
    }
    if (aiAddonDownloadState.diarization.active && isAiAddonTerminalStatus(diarization.status) && !aiAddonProgressHideTimers.diarization) {
      hideAiAddonProgressSoon('diarization', 2500);
    }
    updateDiarizationFootprint(diarization);
  }

  if (summary) {
    setStatusBadge(document.getElementById('summary-status-badge'), effectiveSummaryStatus);
    const summaryControlState = buildAiAddonControlState({
      feature: summary,
      type: 'summary',
      setupActive: summarySetupLocking,
    });
    const profileSelect = document.getElementById('summary-profile-select');
    if (profileSelect) {
      const savedProfile = loadSettings().summaryProfile;
      profileSelect.value = savedProfile || summary.profile || DEFAULT_SUMMARY_PROFILE;
      profileSelect.disabled = summarySetupLocking
        || effectiveSummaryStatus === 'unsupported'
        || (library ? usableInLibrary.length === 0 : !summaryControlState.canConfigure);
    }

    applyAiAddonButtonState({
      setupButton: document.getElementById('setup-summary-btn'),
      validateButton: document.getElementById('validate-summary-btn'),
      removeButton: document.getElementById('remove-summary-btn'),
      controlState: summaryControlState,
      setupLabel: getSummarySetupButtonLabel(),
      validateLabel: getAiAddonValidateButtonLabel(),
      removeLabel: getAiAddonRemoveButtonLabel(),
    });

    const statusText = document.getElementById('summary-status-text');
    if (statusText) {
      statusText.textContent = getSummarySetupMessage(summary);
    }
    if (aiAddonDownloadState.summary.active && isAiAddonTerminalStatus(summary.status) && !aiAddonProgressHideTimers.summary) {
      hideAiAddonProgressSoon('summary', 2500);
    }
    updateSummaryFootprint(summary);
  }

  renderAiAddonProgress('diarization');
  renderAiAddonProgress('summary');

  updateAiAddonFootprintWarning(status);
  updateSummaryGenerationButtons();
  if (historyLanguageCaptionMeeting) {
    updateSummaryLanguageCaptions(historyLanguageCaptionMeeting);
  }
}

async function refreshAiAddonSettings() {
  if (aiAddonStatusRefreshPromise) {
    return aiAddonStatusRefreshPromise;
  }

  aiAddonStatusRefreshPromise = (async () => {
    try {
      const status = await window.electronAPI.getAiAddonStatus({ includeStorageSizes: false });
      aiAddonStatusSnapshot = status;
      updateAiAddonSettings(status);
      updateHomeAiAddonCTA(status);
      const retryRow = document.getElementById('ai-addon-retry-row');
      if (retryRow) {
        retryRow.hidden = true;
      }
      return status;
    } catch (error) {
      addLog(`Failed to check AI add-ons: ${error.message}`, 'error');
      setStatusBadge(document.getElementById('ai-addons-status-badge'), 'error');
      updateHomeAiAddonCTA(null);
      const retryRow = document.getElementById('ai-addon-retry-row');
      if (retryRow) {
        retryRow.hidden = false;
      }
      return null;
    } finally {
      aiAddonStatusRefreshPromise = null;
    }
  })();

  return aiAddonStatusRefreshPromise;
}

async function refreshHomeAiAddonPrompt() {
  try {
    const status = await window.electronAPI.getAiAddonStatus({ includeStorageSizes: false });
    aiAddonStatusSnapshot = status;
    if (typeof renderSummaryModelLibrary === 'function') renderSummaryModelLibrary(status?.summaryLibrary);
    if (typeof renderChatOnboardingAndComposer === 'function') renderChatOnboardingAndComposer();
    updateHomeAiAddonCTA(status);
    updateSummaryGenerationButtons();
    return status;
  } catch (error) {
    console.warn('Could not refresh home AI add-on prompt:', error);
    updateHomeAiAddonCTA(null);
    updateSummaryGenerationButtons();
    return null;
  }
}

async function withAiAddonAction(button, label, action) {
  setAiAddonControlsDisabled(true);
  setButtonBusy(button, true, label);
  let latestStatus = null;
  try {
    const status = await action();
    if (status) {
      latestStatus = status;
    } else {
      latestStatus = await refreshAiAddonSettings();
    }
  } catch (error) {
    console.error('AI add-on action failed:', error);
    addLog(`AI add-on action failed: ${error.message}`, 'error');
    appendAiAddonLog(`ERROR: ${error.message}`);
    latestStatus = await refreshAiAddonSettings();
  } finally {
    setButtonBusy(button, false);
    if (latestStatus) {
      aiAddonStatusSnapshot = latestStatus;
      updateAiAddonSettings(latestStatus);
      updateHomeAiAddonCTA(latestStatus);
    } else if (aiAddonStatusSnapshot) {
      updateAiAddonSettings(aiAddonStatusSnapshot);
    } else {
      setAiAddonControlsDisabled(false);
    }
  }
}

async function withAiAddonSetupAction(feature, button, label, startMessage, action) {
  setAiAddonControlsDisabled(true);
  setButtonBusy(button, true, label);
  let latestStatus = null;
  try {
    const status = await action();
    if (status) {
      latestStatus = status;
    } else {
      latestStatus = await refreshAiAddonSettings();
    }
  } catch (error) {
    console.error('AI add-on setup failed:', error);
    addLog(`AI add-on setup failed: ${error.message}`, 'error');
    appendAiAddonLog(`ERROR: ${error.message}`);
    latestStatus = await refreshAiAddonSettings();
    setAiAddonProgressState(feature, {
      active: true,
      cancelling: false,
      percent: 100,
      message: error.message || `${startMessage} failed.`,
    });
    hideAiAddonProgressSoon(feature, 5000);
  } finally {
    setButtonBusy(button, false);
    if (latestStatus) {
      aiAddonStatusSnapshot = latestStatus;
      updateAiAddonSettings(latestStatus);
      updateHomeAiAddonCTA(latestStatus);
    } else if (aiAddonStatusSnapshot) {
      updateAiAddonSettings(aiAddonStatusSnapshot);
    } else {
      setAiAddonControlsDisabled(false);
    }
  }
}

let aiAddonSettingsListenersBound = false;

function setupAiAddonSettingsListeners() {
  if (aiAddonSettingsListenersBound) {
    return;
  }
  aiAddonSettingsListenersBound = true;
  const retryAiAddonStatusBtn = document.getElementById('retry-ai-addon-status-btn');
  if (retryAiAddonStatusBtn) {
    retryAiAddonStatusBtn.addEventListener('click', () => {
      void refreshAiAddonSettings();
    });
  }
  const setupDiarizationBtn = document.getElementById('setup-diarization-btn');
  const homeSetupDiarizationBtn = document.getElementById('home-setup-diarization-btn');
  const cancelDiarizationBtn = document.getElementById('cancel-diarization-btn');
  const validateDiarizationBtn = document.getElementById('validate-diarization-btn');
  const removeDiarizationBtn = document.getElementById('remove-diarization-btn');
  const setupSummaryBtn = document.getElementById('setup-summary-btn');
  const cancelSummaryBtn = document.getElementById('cancel-summary-btn');
  const validateSummaryBtn = document.getElementById('validate-summary-btn');
  const removeSummaryBtn = document.getElementById('remove-summary-btn');
  const summaryProfileSelect = document.getElementById('summary-profile-select');

  function canRunControlAction(featureName, action, { selectedEngine } = {}) {
    const feature = aiAddonStatusSnapshot && aiAddonStatusSnapshot.features
      ? aiAddonStatusSnapshot.features[featureName]
      : null;
    return canRunAiAddonControlAction({
      action,
      feature,
      type: featureName,
      selectedEngine,
      unsupported: Boolean(feature && feature.status === 'unsupported'),
      setupActive: isAiAddonSetupLockingControls({
        featureStatus: feature && feature.status,
        progressActive: Boolean(aiAddonDownloadState[featureName] && aiAddonDownloadState[featureName].active),
      }),
    });
  }

  function selectDiarizationEngine(engine) {
    selectedDiarizationEngine = coerceDiarizationEngineForPlatform(engine, getRendererPlatform());
    const diarization = aiAddonStatusSnapshot && aiAddonStatusSnapshot.features
      ? aiAddonStatusSnapshot.features.diarization
      : { engine: selectedDiarizationEngine };
    applyDiarizationEngineCards({
      selectedEngine: selectedDiarizationEngine,
      platform: getRendererPlatform(),
      arch: homePromptContext.arch,
    });
    applyDiarizationEngineFields(selectedDiarizationEngine, {
      unsupported: Boolean(diarization && diarization.status === 'unsupported'),
    });
    if (aiAddonStatusSnapshot) {
      updateAiAddonSettings(aiAddonStatusSnapshot);
      updateHomeAiAddonCTA(aiAddonStatusSnapshot);
    }
  }

  async function startDiarizationSetup(button) {
    const diarization = aiAddonStatusSnapshot && aiAddonStatusSnapshot.features
      ? aiAddonStatusSnapshot.features.diarization
      : null;
    const engine = getSelectedDiarizationEngine(diarization);
    if (!canRunControlAction('diarization', 'configure', { selectedEngine: engine })) {
      return null;
    }
    if (shouldConfirmDiarizationEngineSwitch({
      selectedEngine: engine,
      installedEngine: resolveSelectedDiarizationEngine(diarization),
      hasOtherEngineLocalState: hasDiarizationLocalState(diarization),
    })) {
      if (!window.confirm(getDiarizationSwitchConfirmMessage({
        targetEngine: engine,
        platform: homePromptContext.platform,
      }))) {
        return null;
      }
    }
    return withAiAddonSetupAction('diarization', button, 'Setting up...', 'Speaker identification setup', async () => {
      const settingsToken = document.getElementById('diarization-token-input');
      const homeToken = document.getElementById('home-diarization-token-input');
      const source = resolveDiarizationSetupSource(button && button.id);
      const token = readDiarizationSetupToken({
        engine,
        source,
        homeToken: homeToken ? homeToken.value : '',
        settingsToken: settingsToken ? settingsToken.value : '',
      });
      const speakerCount = document.getElementById('diarization-speaker-count');
      try {
        const status = await window.electronAPI.setupDiarization({
          engine,
          token,
          speakerCount: engine === 'pyannote' && speakerCount ? speakerCount.value : 'auto',
        });
        addLog('Speaker identification setup checked.');
        return status;
      } finally {
        if (settingsToken) {
          settingsToken.value = '';
        }
        if (homeToken) {
          homeToken.value = '';
        }
      }
    });
  }

  document.querySelectorAll('.diarization-engine-radio').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked && canRunControlAction('diarization', 'select')) {
        selectDiarizationEngine(radio.value);
      }
    });
  });

  if (setupDiarizationBtn) {
    setupDiarizationBtn.addEventListener('click', () => startDiarizationSetup(setupDiarizationBtn));
  }
  if (homeSetupDiarizationBtn) {
    homeSetupDiarizationBtn.addEventListener('click', () => startDiarizationSetup(homeSetupDiarizationBtn));
  }

  if (cancelDiarizationBtn) {
    cancelDiarizationBtn.addEventListener('click', async () => {
      setAiAddonProgressState('diarization', { cancelling: true, message: 'Cancelling and cleaning up partial files...' });
      try {
        const result = await window.electronAPI.cancelDiarizationSetup();
        if (!result || !result.canceled) {
          setAiAddonProgressState('diarization', { active: false, cancelling: false });
        }
      } catch (error) {
        addLog(`Failed to cancel speaker identification setup: ${error.message}`, 'error');
        appendAiAddonLog(`ERROR: ${error.message}`);
        setAiAddonProgressState('diarization', { cancelling: false });
      }
    });
  }

  if (validateDiarizationBtn) {
    validateDiarizationBtn.addEventListener('click', () => {
      if (!canRunControlAction('diarization', 'validate')) {
        return;
      }
      withAiAddonAction(validateDiarizationBtn, 'Validating...', async () => {
        const status = await window.electronAPI.validateDiarizationSetup();
        addLog('Speaker identification validation complete.');
        return status;
      });
    });
  }

  if (removeDiarizationBtn) {
    removeDiarizationBtn.addEventListener('click', () => {
      if (!canRunControlAction('diarization', 'remove')) {
        return;
      }
      const diarization = aiAddonStatusSnapshot && aiAddonStatusSnapshot.features
        ? aiAddonStatusSnapshot.features.diarization
        : null;
      if (!confirm(getDiarizationRemoveConfirmMessage({
        engine: resolveSelectedDiarizationEngine(diarization),
      }))) {
        return;
      }
      withAiAddonAction(removeDiarizationBtn, 'Removing...', async () => {
        const status = await window.electronAPI.removeDiarizationSetup();
        addLog('Speaker identification setup removed.');
        return status;
      });
    });
  }

  if (setupSummaryBtn) {
    setupSummaryBtn.addEventListener('click', () => {
      if (!canRunControlAction('summary', 'configure')) {
        return;
      }
      withAiAddonSetupAction('summary', setupSummaryBtn, 'Installing...', 'Summary model setup', async () => {
        const status = await window.electronAPI.setupSummaryModel({
          profile: summaryProfileSelect ? summaryProfileSelect.value : DEFAULT_SUMMARY_PROFILE,
        });
        addLog('Summary model setup checked.');
        return status;
      });
    });
  }

  if (cancelSummaryBtn) {
    cancelSummaryBtn.addEventListener('click', async () => {
      setAiAddonProgressState('summary', { cancelling: true, message: 'Cancelling and cleaning up partial files...' });
      try {
        const result = await window.electronAPI.cancelSummaryModelSetup();
        if (!result || !result.canceled) {
          setAiAddonProgressState('summary', { active: false, cancelling: false });
        }
      } catch (error) {
        addLog(`Failed to cancel summary model setup: ${error.message}`, 'error');
        appendAiAddonLog(`ERROR: ${error.message}`);
        setAiAddonProgressState('summary', { cancelling: false });
      }
    });
  }

  if (validateSummaryBtn) {
    validateSummaryBtn.addEventListener('click', () => {
      if (!canRunControlAction('summary', 'validate')) {
        return;
      }
      withAiAddonAction(validateSummaryBtn, 'Validating...', async () => {
        const status = await window.electronAPI.validateSummaryModel({});
        addLog('Summary model validation complete.');
        return status;
      });
    });
  }

  if (removeSummaryBtn) {
    removeSummaryBtn.addEventListener('click', () => {
      if (!canRunControlAction('summary', 'remove')) {
        return;
      }
      if (!confirm('Disable and remove the Summaries & Chat model from this device? Summaries and Chat will stay off until you enable them again. Your recordings and transcripts are not affected.')) {
        return;
      }
      withAiAddonAction(removeSummaryBtn, 'Removing...', async () => {
        const status = await window.electronAPI.removeSummaryModel({});
        addLog('Summary model removed.');
        return status;
      });
    });
  }

  if (summaryProfileSelect) {
    summaryProfileSelect.addEventListener('change', () => {
      saveSettings({ summaryProfile: summaryProfileSelect.value });
    });
  }

  if (window.electronAPI.onAiAddonProgress) {
    registerCleanup(window.electronAPI.onAiAddonProgress((progress) => {
      handleAiAddonProgress(progress);
      if (shouldLogAiAddonProgress(progress)) {
        appendAiAddonLog(progress.message);
        addLog(progress.message);
      }
    }));
  }
}

// ============================================================================
// Transcription engine settings
// ============================================================================

function renderTranscriptionEngineSettings() {
  const whisperCard = document.getElementById('whisper-engine-card');
  const whisperBadge = document.getElementById('whisper-status-badge');
  const parakeetCard = document.getElementById('parakeet-engine-card');
  const parakeetRow = document.getElementById('parakeet-engine-row');
  const parakeetToggle = document.getElementById('use-parakeet-engine-toggle');
  const parakeetBadge = document.getElementById('parakeet-status-badge');
  const activeBadge = document.getElementById('transcription-active-engine-badge');
  const whisperSummary = document.getElementById('whisper-preferences-summary');
  const parakeetStatusText = document.getElementById('parakeet-status-text');
  const parakeetActiveWarning = document.getElementById('parakeet-active-warning');
  const operationError = document.getElementById('parakeet-operation-error');
  const progress = document.getElementById('parakeet-progress');
  const progressTrack = document.getElementById('parakeet-progress-track');
  const progressBar = document.getElementById('parakeet-progress-bar');
  const progressText = document.getElementById('parakeet-progress-text');
  const downloadSize = document.getElementById('parakeet-download-size');
  if (!parakeetRow || !parakeetToggle || !parakeetStatusText) return;

  const preferences = transcriptionEnginePreferences;
  const whisper = preferences.whisper || {};
  const activeEngine = preferences.activeEngine;
  const view = buildParakeetSettingsView({
    status: parakeetEngineStatus,
    activeEngine,
    operation: parakeetEngineOperation,
    progress: parakeetSetupProgress,
    error: parakeetEngineOperationError,
    formatBytes,
  });

  if (whisperCard) whisperCard.classList.toggle('is-active', activeEngine === 'whisper');
  if (whisperBadge) {
    whisperBadge.textContent = activeEngine === 'whisper' ? 'Active' : 'Standby';
    whisperBadge.classList.remove('enabled', 'disabled', 'installing');
    whisperBadge.classList.add(activeEngine === 'whisper' ? 'enabled' : 'disabled');
  }
  if (parakeetCard) parakeetCard.classList.toggle('is-active', activeEngine === 'parakeet');
  parakeetRow.classList.toggle('is-active', activeEngine === 'parakeet');
  parakeetToggle.checked = activeEngine === 'parakeet';
  const canSwitchAway = activeEngine === 'parakeet' && view.actions.includes('use-whisper');
  const canSwitchToParakeet = view.state === 'ready';
  parakeetToggle.disabled = parakeetEngineSettingsBusy
    || view.state === 'removing'
    || (activeEngine === 'parakeet' ? !canSwitchAway : !canSwitchToParakeet);
  if (activeBadge) {
    activeBadge.textContent = view.activeUnavailable
      ? `${activeEngine === 'parakeet' ? 'Parakeet' : 'Whisper'} selected · unavailable`
      : `${activeEngine === 'parakeet' ? 'Parakeet' : 'Whisper'} active`;
    activeBadge.classList.toggle('enabled', !view.activeUnavailable);
    activeBadge.classList.toggle('disabled', view.activeUnavailable);
  }
  if (whisperSummary) {
    const storedLanguageName = [...languageSelect.options]
      .find((option) => option.value === whisper.language)?.textContent || 'Choose language';
    const storedModelName = [...modelSelect.options]
      .find((option) => option.value === whisper.modelSize)?.textContent || 'Small';
    whisperSummary.textContent = `${storedLanguageName} · ${storedModelName}`;
  }

  if (parakeetBadge) {
    const isBusy = ACTIVE_PARAKEET_UI_STATES.has(view.state);
    parakeetBadge.textContent = activeEngine === 'parakeet' && view.activeUnavailable
      ? 'Selected · unavailable'
      : (activeEngine === 'parakeet' && view.state === 'ready' ? 'In use' : view.statusLabel);
    parakeetBadge.classList.remove('enabled', 'disabled', 'installing');
    parakeetBadge.classList.add(isBusy ? 'installing' : (view.state === 'ready' ? 'enabled' : 'disabled'));
  }

  parakeetStatusText.textContent = view.statusText;
  if (parakeetActiveWarning) parakeetActiveWarning.hidden = !view.activeUnavailable;
  if (operationError) {
    operationError.textContent = parakeetEngineOperationError;
    operationError.hidden = !parakeetEngineOperationError;
  }

  const showProgress = ACTIVE_PARAKEET_UI_STATES.has(view.state) || view.state === 'removing';
  if (progress) progress.hidden = !showProgress;
  if (progressBar) {
    progressBar.classList.toggle('is-indeterminate', view.progressPercent == null);
    progressBar.style.width = view.progressPercent == null ? '28%' : `${view.progressPercent}%`;
  }
  if (progressTrack) {
    if (view.progressPercent == null) {
      progressTrack.removeAttribute('aria-valuenow');
    } else {
      progressTrack.setAttribute('aria-valuenow', String(view.progressPercent));
    }
  }
  if (progressText) progressText.textContent = view.progressText;

  if (downloadSize) {
    downloadSize.hidden = view.state !== 'not-installed' || view.downloadBytes == null;
    downloadSize.textContent = view.downloadBytes == null
      ? ''
      : `Model and runtime download: ${formatBytes(view.downloadBytes)} total.`;
  }

  const actions = new Set(view.actions);
  const setActionVisible = (id, key) => {
    const button = document.getElementById(id);
    if (!button) return;
    button.hidden = !actions.has(key);
    button.disabled = key === 'cancel'
      ? parakeetSetupCancelRequested
      : parakeetEngineSettingsBusy;
  };
  setActionVisible('parakeet-setup-btn', 'setup');
  setActionVisible('parakeet-cancel-btn', 'cancel');
  setActionVisible('parakeet-recheck-btn', 'recheck');
  setActionVisible('parakeet-validate-btn', 'validate');
  setActionVisible('parakeet-repair-btn', 'repair');
  setActionVisible('parakeet-remove-btn', 'remove');
  const cancelButton = document.getElementById('parakeet-cancel-btn');
  if (cancelButton) {
    cancelButton.textContent = parakeetSetupCancelRequested ? 'Cancelling…' : 'Cancel';
  }
  const repairButton = document.getElementById('parakeet-repair-btn');
  if (repairButton) repairButton.textContent = 'Repair Parakeet';
}

const ACTIVE_PARAKEET_UI_STATES = new Set([
  'downloading', 'verifying', 'waiting-for-validation', 'validating',
]);

async function refreshTranscriptionEngineStatus() {
  if (parakeetEngineSettingsBusy) return parakeetEngineStatus;
  parakeetEngineStatus = null;
  parakeetEngineOperationError = '';
  renderTranscriptionEngineSettings();
  try {
    if (typeof window.electronAPI.getTranscriptionEngineStatus !== 'function') {
      throw new Error('Parakeet status is unavailable in this version.');
    }
    parakeetEngineStatus = await window.electronAPI.getTranscriptionEngineStatus({ engine: 'parakeet' });
  } catch (error) {
    parakeetEngineStatus = { status: 'unknown' };
    parakeetEngineOperationError = error.message || 'Could not check Parakeet status.';
  }
  renderTranscriptionEngineSettings();
  return parakeetEngineStatus;
}

async function sendParakeetSetupCancellation() {
  if (!parakeetSetupOperationId || parakeetSetupCancelSent) return;
  parakeetSetupCancelSent = true;
  try {
    await window.electronAPI.cancelTranscriptionEngineSetup(
      buildSetupCancellationOptions(parakeetSetupOperationId),
    );
  } catch (error) {
    parakeetEngineOperationError = error.message || 'Could not cancel Parakeet setup.';
    renderTranscriptionEngineSettings();
  }
}

function handleParakeetSetupProgress(event) {
  if (!event || !parakeetEngineSettingsBusy
      || !['install', 'repair', 'validate'].includes(parakeetEngineOperation)) {
    return;
  }
  const operationId = String(event.operationId || '');
  if (parakeetSetupOperationId && operationId && operationId !== parakeetSetupOperationId) return;
  if (operationId) parakeetSetupOperationId = operationId;
  parakeetSetupProgress = {
    phase: event.phase,
    downloadedBytes: event.downloadedBytes,
    totalBytes: event.totalBytes,
  };
  if (parakeetSetupCancelRequested) void sendParakeetSetupCancellation();
  renderTranscriptionEngineSettings();
}

async function setupParakeetEngine(operation = 'install') {
  if (parakeetEngineSettingsBusy) return;
  parakeetEngineSettingsBusy = true;
  parakeetEngineOperation = operation === 'repair' ? 'repair' : 'install';
  parakeetSetupProgress = null;
  parakeetSetupOperationId = null;
  parakeetSetupCancelRequested = false;
  parakeetSetupCancelSent = false;
  parakeetEngineOperationError = '';
  renderTranscriptionEngineSettings();
  let setupResult = null;
  try {
    setupResult = await window.electronAPI.setupTranscriptionEngine({
      engine: 'parakeet',
      operation: parakeetEngineOperation,
    });
    if (setupResult && setupResult.status) parakeetEngineStatus = setupResult;
    if (setupResult && setupResult.ok === false
        && setupResult.code !== 'PARAKEET_SETUP_CANCELLED'
        && setupResult.code !== 'AI_ADDON_SETUP_CANCELLED') {
      parakeetEngineOperationError = setupResult.message || 'Parakeet setup did not finish.';
    } else if (setupResult && setupResult.status === 'ready' && !parakeetSetupCancelRequested) {
      addLog('Parakeet is ready. Turn on its switch to use it for future recordings.');
    }
  } catch (error) {
    parakeetEngineOperationError = error.message || 'Parakeet setup failed.';
  } finally {
    parakeetEngineSettingsBusy = false;
    parakeetEngineOperation = null;
    parakeetSetupProgress = null;
    parakeetSetupOperationId = null;
    parakeetSetupCancelRequested = false;
    parakeetSetupCancelSent = false;
    const operationError = parakeetEngineOperationError;
    await refreshTranscriptionEngineStatus();
    parakeetEngineOperationError = operationError;
    renderTranscriptionEngineSettings();
  }
}

async function cancelParakeetSetup() {
  if (!parakeetEngineSettingsBusy
      || !['install', 'repair', 'validate'].includes(parakeetEngineOperation)) {
    return;
  }
  parakeetSetupCancelRequested = true;
  renderTranscriptionEngineSettings();
  await sendParakeetSetupCancellation();
}

async function validateParakeetEngine() {
  if (parakeetEngineSettingsBusy) return;
  parakeetEngineSettingsBusy = true;
  parakeetEngineOperation = 'validate';
  parakeetSetupProgress = null;
  parakeetSetupOperationId = null;
  parakeetSetupCancelRequested = false;
  parakeetSetupCancelSent = false;
  parakeetEngineOperationError = '';
  renderTranscriptionEngineSettings();
  try {
    const result = await window.electronAPI.validateTranscriptionEngine({ engine: 'parakeet' });
    if (result && result.status) parakeetEngineStatus = result;
    if (result && result.ok === false
        && result.code !== 'AI_ADDON_SETUP_CANCELLED'
        && result.code !== 'PARAKEET_SETUP_CANCELLED') {
      parakeetEngineOperationError = result.message || 'Parakeet validation failed.';
    }
  } catch (error) {
    parakeetEngineOperationError = error.message || 'Parakeet validation failed.';
  } finally {
    parakeetEngineSettingsBusy = false;
    parakeetEngineOperation = null;
    parakeetSetupProgress = null;
    parakeetSetupOperationId = null;
    parakeetSetupCancelRequested = false;
    parakeetSetupCancelSent = false;
    const operationError = parakeetEngineOperationError;
    await refreshTranscriptionEngineStatus();
    parakeetEngineOperationError = operationError;
    renderTranscriptionEngineSettings();
  }
}

async function removeParakeetEngine() {
  if (parakeetEngineSettingsBusy) return;
  const confirmed = confirm(
    'Remove Parakeet and its GPU runtime from this device? Your recordings and Whisper models will be kept. If Parakeet is active, turn off Use Parakeet to switch back to Whisper.',
  );
  if (!confirmed) return;

  parakeetEngineSettingsBusy = true;
  parakeetEngineOperation = 'remove';
  parakeetEngineOperationError = '';
  renderTranscriptionEngineSettings();
  try {
    const result = await window.electronAPI.removeTranscriptionEngine({ engine: 'parakeet' });
    if (result && result.status) parakeetEngineStatus = result;
    if (result && result.ok === false) {
      parakeetEngineOperationError = result.message || 'Parakeet could not be removed.';
    } else {
      addLog('Parakeet was removed. The active engine preference was left unchanged.');
    }
  } catch (error) {
    parakeetEngineOperationError = error.message || 'Parakeet could not be removed.';
  } finally {
    parakeetEngineSettingsBusy = false;
    parakeetEngineOperation = null;
    const operationError = parakeetEngineOperationError;
    await refreshTranscriptionEngineStatus();
    parakeetEngineOperationError = operationError;
    renderTranscriptionEngineSettings();
  }
}

function activateTranscriptionEngine(engine) {
  if (engine === 'parakeet' && parakeetEngineStatus?.status !== 'ready') return;
  if (engine !== 'whisper' && engine !== 'parakeet') return;
  persistTranscriptionEnginePreferences({ activeEngine: engine });
  addLog(`${engine === 'parakeet' ? 'Parakeet' : 'Whisper'} selected for future recordings.`);
}

function setupTranscriptionEngineSettings() {
  if (transcriptionEngineSettingsListenersBound) return;
  transcriptionEngineSettingsListenersBound = true;
  document.getElementById('use-parakeet-engine-toggle')?.addEventListener('change', (event) => {
    const requestedEngine = event.currentTarget.checked ? 'parakeet' : 'whisper';
    if (requestedEngine === 'parakeet' && parakeetEngineStatus?.status !== 'ready') {
      renderTranscriptionEngineSettings();
      return;
    }
    activateTranscriptionEngine(requestedEngine);
  });
  document.getElementById('parakeet-setup-btn')?.addEventListener('click', () => {
    void setupParakeetEngine('install');
  });
  document.getElementById('parakeet-repair-btn')?.addEventListener('click', () => {
    void setupParakeetEngine('repair');
  });
  document.getElementById('parakeet-cancel-btn')?.addEventListener('click', () => {
    void cancelParakeetSetup();
  });
  document.getElementById('parakeet-recheck-btn')?.addEventListener('click', () => {
    void refreshTranscriptionEngineStatus();
  });
  document.getElementById('parakeet-validate-btn')?.addEventListener('click', () => {
    void validateParakeetEngine();
  });
  document.getElementById('parakeet-remove-btn')?.addEventListener('click', () => {
    void removeParakeetEngine();
  });
  if (typeof window.electronAPI.onTranscriptionEngineSetupProgress === 'function') {
    registerCleanup(window.electronAPI.onTranscriptionEngineSetupProgress(handleParakeetSetupProgress));
  }
}

// ============================================================================
// Settings Tab - GPU Acceleration
// ============================================================================

async function initSettingsTab() {
  if (initSettingsTab.promise) {
    return initSettingsTab.promise;
  }

  initSettingsTab.promise = initSettingsTabOnce().catch((error) => {
    initSettingsTab.promise = null;
    throw error;
  });

  return initSettingsTab.promise;
}

async function initSettingsTabOnce() {
  // Get system info
  try {
    const systemInfo = await window.electronAPI.getSystemInfo();
    document.getElementById('app-version').textContent = systemInfo.app;
    document.getElementById('electron-version').textContent = systemInfo.electron;
    document.getElementById('python-version').textContent = systemInfo.python;
  } catch (error) {
    console.error('Failed to get system info:', error);
  }

  // Check GPU status
  await checkGPUStatus();

  // Set up event listeners
  document.getElementById('install-gpu-btn').addEventListener('click', installGPUAcceleration);
  document.getElementById('uninstall-gpu-btn').addEventListener('click', uninstallGPUAcceleration);

  // Listen for installation progress
  registerCleanup(window.electronAPI.onGPUInstallProgress((data) => {
    appendGPULog(data);
  }));

  setupTranscriptionEngineSettings();
  await refreshTranscriptionEngineStatus();

  setupAiAddonSettingsListeners();
  await refreshAiAddonSettings();

  if (typeof renderUpdateUi === 'function') {
    renderUpdateUi();
  }

  const openLegalNoticesBtn = document.getElementById('open-legal-notices-btn');
  if (openLegalNoticesBtn) {
    openLegalNoticesBtn.addEventListener('click', async () => {
      try {
        const result = await window.electronAPI.openLegalNotices();
        if (!result || !result.success) {
          addLog(`Could not open third-party notices: ${result?.error || 'unknown error'}`);
        }
      } catch (error) {
        addLog(`Could not open third-party notices: ${error.message}`);
      }
    });
  }
}

async function checkGPUStatus() {
  const statusBadge = document.getElementById('gpu-status-badge');
  const gpuDescription = document.getElementById('gpu-description');
  const gpuLabel1 = document.getElementById('gpu-label-1');
  const gpuValue1 = document.getElementById('gpu-value-1');
  const gpuLabel2 = document.getElementById('gpu-label-2');
  const gpuValue2 = document.getElementById('gpu-value-2');
  const gpuLabel3 = document.getElementById('gpu-label-3');
  const gpuValue3 = document.getElementById('gpu-value-3');
  const gpuRow3 = document.getElementById('gpu-row-3');
  const gpuLabel4 = document.getElementById('gpu-label-4');
  const gpuValue4 = document.getElementById('gpu-value-4');
  const gpuRow4 = document.getElementById('gpu-row-4');
  const installBtn = document.getElementById('install-gpu-btn');
  const uninstallBtn = document.getElementById('uninstall-gpu-btn');
  const gpuActions = document.getElementById('gpu-actions');
  const ctaState = { platform: null, gpuInfo: null, cudaInfo: null };
  const resetInstallButton = () => {
    installBtn.textContent = 'Install GPU acceleration';
    installBtn.dataset.mode = 'install';
    installBtn.title = 'Install CUDA libraries needed by AvaNevis';
  };
  const setRepairInstallButton = () => {
    installBtn.textContent = 'Repair GPU runtime';
    installBtn.dataset.mode = 'repair';
    installBtn.title = 'Reinstall CUDA libraries needed by AvaNevis';
  };
  resetInstallButton();

  statusBadge.textContent = 'Checking...';
  statusBadge.className = 'setting-badge';

  try {
    // Get platform info
    const platform = await window.electronAPI.getPlatform();
    ctaState.platform = platform;

    if (platform === 'darwin') {
      // ============ macOS: Show Metal/MLX Status ============
      gpuDescription.textContent = 'Uses Apple Silicon GPU acceleration (Metal) automatically for faster transcription.';
      
      // Check if Apple Silicon
      const arch = await window.electronAPI.getArch();
      const isAppleSilicon = arch === 'arm64';

      if (isAppleSilicon) {
        // Apple Silicon - Metal always available
        gpuLabel1.textContent = 'GPU:';
        gpuValue1.textContent = 'Apple Silicon (Metal)';
        gpuValue1.className = 'info-value success';

        gpuLabel2.textContent = 'Framework:';
        gpuValue2.textContent = 'MLX (Metal acceleration)';
        gpuValue2.className = 'info-value success';

        gpuLabel3.textContent = 'Status:';
        gpuValue3.textContent = 'Enabled by default';
        gpuValue3.className = 'info-value success';
        if (gpuLabel4) gpuLabel4.textContent = 'Diagnostics:';
        if (gpuValue4) {
          gpuValue4.textContent = 'Built in on Apple Silicon. No extra setup needed.';
          gpuValue4.className = 'info-value';
        }
        if (gpuRow4) gpuRow4.style.display = 'flex';

        statusBadge.textContent = 'Enabled (Metal)';
        statusBadge.classList.add('enabled');
      } else {
        // Intel Mac - CPU only
        gpuLabel1.textContent = 'Chip:';
        gpuValue1.textContent = 'Intel (x64)';
        gpuValue1.className = 'info-value';

        gpuLabel2.textContent = 'Acceleration:';
        gpuValue2.textContent = 'CPU only (no Metal GPU)';
        gpuValue2.className = 'info-value warning';

        gpuLabel3.textContent = 'Framework:';
        gpuValue3.textContent = 'faster-whisper (CPU)';
        gpuValue3.className = 'info-value';
        if (gpuLabel4) gpuLabel4.textContent = 'Diagnostics:';
        if (gpuValue4) {
          gpuValue4.textContent = 'GPU acceleration requires Apple Silicon on macOS.';
          gpuValue4.className = 'info-value';
        }
        if (gpuRow4) gpuRow4.style.display = 'flex';

        statusBadge.textContent = 'CPU Fallback';
        statusBadge.classList.add('disabled');
      }

      // Hide install/uninstall buttons on macOS (MLX is bundled)
      gpuActions.style.display = 'none';

    } else {
      if (platform === 'linux') {
        ctaState.cudaInfo = await window.electronAPI.checkCUDA();
      }
      const useCudaSurface = platform === 'win32'
        || isCudaRuntimeSettingsSurface(platform, ctaState.cudaInfo);

      if (!useCudaSurface) {
        const copy = getUnsupportedGpuSettingsCopy(platform);
        gpuDescription.textContent = copy.description;
        gpuLabel1.textContent = 'Platform:';
        gpuValue1.textContent = platform || 'unknown';
        gpuValue1.className = 'info-value';
        gpuLabel2.textContent = 'Acceleration:';
        gpuValue2.textContent = 'CPU only';
        gpuValue2.className = 'info-value';
        gpuLabel3.textContent = 'GPU setup:';
        gpuValue3.textContent = copy.statusLabel;
        gpuValue3.className = 'info-value warning';
        if (gpuLabel4) gpuLabel4.textContent = 'Diagnostics:';
        if (gpuValue4) {
          gpuValue4.textContent = copy.diagnostics;
          gpuValue4.className = 'info-value';
        }
        if (gpuRow4) gpuRow4.style.display = 'flex';
        statusBadge.textContent = copy.statusLabel;
        statusBadge.classList.add('disabled');
        gpuActions.style.display = 'none';
        installBtn.disabled = true;
      } else {
        gpuDescription.textContent = platform === 'linux'
          ? getLinuxCudaSettingsDescription()
          : 'Use your NVIDIA GPU for faster transcription. Downloads only the CUDA libraries AvaNevis needs; other apps are unaffected.';
        gpuLabel1.textContent = 'GPU Detected:';
        gpuLabel2.textContent = 'CUDA Libraries:';
        gpuLabel3.textContent = 'Download Size:';
        if (gpuLabel4) gpuLabel4.textContent = 'Diagnostics:';

        const gpuInfo = await window.electronAPI.checkGPU();
        ctaState.gpuInfo = gpuInfo;

        if (!gpuInfo.hasGPU) {
          gpuValue1.textContent = 'No NVIDIA GPU detected';
          gpuValue1.classList.add('error');
          if (platform !== 'linux') {
            gpuValue2.textContent = 'N/A';
            gpuValue3.textContent = 'N/A';
            if (gpuValue4) {
              gpuValue4.textContent = 'No NVIDIA GPU detected.';
              gpuValue4.className = 'info-value';
            }
            if (gpuRow4) gpuRow4.style.display = 'flex';
            statusBadge.textContent = 'Not Available';
            statusBadge.classList.add('disabled');
            installBtn.disabled = true;
            return;
          }
        } else {
          gpuValue1.textContent = gpuInfo.gpuName;
          gpuValue1.classList.add('success');
        }

        const cudaInfo = platform === 'linux' && ctaState.cudaInfo
          ? ctaState.cudaInfo
          : await window.electronAPI.checkCUDA();
        ctaState.cudaInfo = cudaInfo;

        if (cudaInfo.installed) {
          gpuValue2.textContent = 'Installed and ready';
          gpuValue2.classList.add('success');
          gpuValue3.textContent = 'Installed';
          if (gpuValue4) {
            gpuValue4.textContent = 'CUDA libraries installed and ready.';
            gpuValue4.className = 'info-value success';
          }
          if (gpuRow4) gpuRow4.style.display = 'flex';
          statusBadge.textContent = 'Enabled';
          statusBadge.classList.add('enabled');
          installBtn.style.display = 'none';
          uninstallBtn.style.display = shouldShowGpuUninstallButton(platform, cudaInfo) ? 'block' : 'none';
          resetInstallButton();
        } else {
          const statusCode = String(cudaInfo.statusCode || '').trim();
          if (shouldUseGpuRepairButton(platform, cudaInfo)) {
            setRepairInstallButton();
          } else {
            resetInstallButton();
          }
          if (cudaInfo.repairRecommendedAfterQuit) {
            gpuValue2.textContent = 'Repair recommended (previous setup was interrupted)';
          } else if (statusCode === 'unsupportedRuntimeMajor') {
            const unsupportedProfiles = Array.isArray(cudaInfo.unsupportedDetectedProfiles)
              ? cudaInfo.unsupportedDetectedProfiles.filter(Boolean)
              : [];
            gpuValue2.textContent = unsupportedProfiles.length
              ? `Unsupported runtime detected (${unsupportedProfiles.join(', ')})`
              : 'Unsupported CUDA runtime detected';
          } else if (statusCode === 'runtimeIntegrityFailed') {
            gpuValue2.textContent = 'CUDA runtime failed verification';
          } else if (cudaInfo.deviceAvailable && cudaInfo.runtimeLoadable === false) {
            const missing = Array.isArray(cudaInfo.missingLibraries) && cudaInfo.missingLibraries.length
              ? `Missing: ${cudaInfo.missingLibraries.join(', ')}`
              : 'CUDA libraries could not be loaded';
            gpuValue2.textContent = missing;
          } else if (cudaInfo.deviceAvailable) {
            gpuValue2.textContent = 'CUDA runtime not installed';
          } else {
            gpuValue2.textContent = 'No CUDA GPU available';
          }
          gpuValue2.classList.add('warning');
          gpuValue3.textContent = cudaInfo.pythonSupportedForInstall === false && cudaInfo.pythonVersion
            ? `Requires Python 3.11 (current: ${cudaInfo.pythonVersion})`
            : '~1 GB';
          if (gpuValue4) {
            const diagnostics = [];
            if (cudaInfo.repairRecommendedAfterQuit) {
              diagnostics.push(cudaInfo.repairRecommendedReason
                || 'Repair interrupted GPU setup before using CUDA.');
            }
            if (statusCode === 'unsupportedRuntimeMajor') {
              const unsupportedProfiles = Array.isArray(cudaInfo.unsupportedDetectedProfiles)
                ? cudaInfo.unsupportedDetectedProfiles.filter(Boolean)
                : [];
              diagnostics.push(
                unsupportedProfiles.length
                  ? `Detected ${unsupportedProfiles.join(', ')}, but AvaNevis requires ${Array.isArray(cudaInfo.supportedProfiles) ? cudaInfo.supportedProfiles.join(', ') : 'cuda12'}.`
                  : 'Detected CUDA version is newer than AvaNevis supports.',
              );
            }
            if (cudaInfo.deviceAvailable === false) {
              diagnostics.push('NVIDIA GPU was not available for GPU transcription.');
            }
            if (Array.isArray(cudaInfo.missingLibraries) && cudaInfo.missingLibraries.length > 0) {
              diagnostics.push(
                platform === 'linux'
                  ? `Missing libraries: ${cudaInfo.missingLibraries.join(', ')}`
                  : `Missing DLLs: ${cudaInfo.missingLibraries.join(', ')}`,
              );
            }
            if (cudaInfo.error) {
              diagnostics.push(`Error: ${String(cudaInfo.error).replace(/\s+/g, ' ').trim().slice(0, 180)}`);
            }
            if (platform === 'linux' && shouldShowGpuUninstallButton(platform, cudaInfo)) {
              diagnostics.push('Uninstall this runtime to return transcription to CPU.');
            }
            gpuValue4.textContent = diagnostics.length
              ? diagnostics.join(' ')
              : 'CUDA runtime is not ready. Install or repair CUDA libraries below.';
            gpuValue4.className = 'info-value warning';
          }
          if (gpuRow4) gpuRow4.style.display = 'flex';
          statusBadge.textContent = 'Available';
          statusBadge.classList.add('disabled');
          installBtn.disabled = cudaInfo.pythonSupportedForInstall === false;
          installBtn.style.display = shouldShowGpuInstallOrRepairButton(cudaInfo) ? 'block' : 'none';
          uninstallBtn.style.display = shouldShowGpuUninstallButton(platform, cudaInfo) ? 'block' : 'none';
        }

        gpuActions.style.display = 'flex';
      }
    }
  } catch (error) {
    console.error('Failed to check GPU status:', error);
    statusBadge.textContent = 'Error';
    statusBadge.classList.add('disabled');
    gpuDescription.textContent = 'Failed to detect system configuration.';
  } finally {
    updateGPUCTA(ctaState);
    updateCudaRuntimeWarning(ctaState);
    let arch = homePromptContext.arch;
    try {
      arch = await window.electronAPI.getArch();
    } catch (_error) {
      arch = homePromptContext.arch;
    }
    homePromptContext = {
      platform: ctaState.platform,
      arch,
      hasNvidiaGpu: Boolean(ctaState.gpuInfo && ctaState.gpuInfo.hasGPU),
      cudaInstalled: Boolean(ctaState.cudaInfo && ctaState.cudaInfo.installed),
    };
    updateHomeAiAddonCTA(aiAddonStatusSnapshot);
  }
}

// Show or hide the "Install CUDA" CTA on the Record (home) tab.
// Shown when CUDA settings are offered, an NVIDIA GPU is visible, and CUDA is
// not ready. Leftover Linux trees without a GPU stay on Settings Uninstall.
function updateGPUCTA({ platform, gpuInfo, cudaInfo }) {
  const cta = document.getElementById('gpu-cta');
  if (!cta) return;

  if (!shouldShowGpuHomeCta({ platform, gpuInfo, cudaInfo })) {
    cta.style.display = 'none';
    return;
  }

  const sub = cta.querySelector('.gpu-cta-sub');
  const title = cta.querySelector('strong');
  const statusCode = String((cudaInfo && cudaInfo.statusCode) || '').trim();
  if (statusCode === 'unsupportedRuntimeMajor' || shouldUseGpuRepairButton(platform, cudaInfo)) {
    if (title) {
      title.textContent = 'Repair GPU runtime compatibility';
    }
    if (sub) {
      sub.textContent = statusCode === 'unsupportedRuntimeMajor'
        ? `${gpuInfo.gpuName || 'NVIDIA GPU'} detected - keep newer CUDA for other apps and add AvaNevis-compatible runtime libs`
        : `${gpuInfo.gpuName || 'NVIDIA GPU'} detected - repair the managed CUDA runtime or uninstall to return to CPU`;
    }
    cta.style.display = 'flex';
    return;
  }
  if (title) {
    title.textContent = 'Install CUDA for faster transcription';
  }
  if (sub && gpuInfo.gpuName) {
    sub.textContent = `${gpuInfo.gpuName} detected — install CUDA for faster transcription`;
  }
  cta.style.display = 'flex';
}

function updateCudaRuntimeWarning({ platform, gpuInfo, cudaInfo }) {
  const warning = document.getElementById('cuda-runtime-warning');
  const warningSub = document.getElementById('cuda-runtime-warning-sub');
  if (!warning || !warningSub) {
    return;
  }

  if (!shouldShowCudaRuntimeWarning({ platform, gpuInfo, cudaInfo })) {
    warning.style.display = 'none';
    return;
  }

  const missing = Array.isArray(cudaInfo.missingLibraries) ? cudaInfo.missingLibraries.filter(Boolean) : [];
  const statusCode = String(cudaInfo.statusCode || '').trim();
  const linuxNoCpuFallback = platform === 'linux'
    ? getLinuxCudaBrokenRuntimeCopy()
    : '';
  if (cudaInfo.repairRecommendedAfterQuit) {
    warningSub.textContent = cudaInfo.repairRecommendedReason
      || 'GPU runtime setup was interrupted by a previous quit. Repair GPU compatibility in Settings before relying on CUDA transcription.';
  } else if (statusCode === 'unsupportedRuntimeMajor') {
    const unsupportedProfiles = Array.isArray(cudaInfo.unsupportedDetectedProfiles)
      ? cudaInfo.unsupportedDetectedProfiles.filter(Boolean)
      : [];
    const detected = unsupportedProfiles.length
      ? `Detected ${unsupportedProfiles.join(', ')} runtime libraries, but this AvaNevis build currently supports ${Array.isArray(cudaInfo.supportedProfiles) ? cudaInfo.supportedProfiles.join(', ') : 'cuda12'}.`
      : 'Detected a newer CUDA runtime than this AvaNevis build currently supports.';
    warningSub.textContent = platform === 'linux'
      ? `${detected}${linuxNoCpuFallback}`
      : `${detected} Transcription will fall back to CPU until supported GPU runtime libraries are installed.`;
  } else {
    const missingText = missing.length
      ? `Missing CUDA runtime libraries: ${missing.join(', ')}.`
      : 'CUDA runtime libraries are not loadable.';
    warningSub.textContent = platform === 'linux'
      ? `${missingText}${linuxNoCpuFallback}`
      : `${missingText} Transcription will automatically fall back to CPU until CUDA is fixed.`;
  }
  warning.style.display = 'flex';
}

function setupGPUCTA() {
  const cta = document.getElementById('gpu-cta');
  if (cta) {
    cta.addEventListener('click', () => {
      activateTab('settings');
    });
  }

  const warningAction = document.getElementById('cuda-runtime-warning-action');
  if (warningAction) {
    warningAction.addEventListener('click', () => {
      activateTab('settings');
    });
  }
}

async function refreshHomePrompts() {
  try {
    await checkGPUStatus();
  } catch (error) {
    console.warn('Could not refresh home setup prompts:', error);
  }
}

async function installGPUAcceleration() {
  const installBtn = document.getElementById('install-gpu-btn');
  const statusBadge = document.getElementById('gpu-status-badge');
  const progressDiv = document.getElementById('gpu-progress');
  const progressBar = document.getElementById('gpu-progress-bar');
  const progressText = document.getElementById('gpu-progress-text');
  const logDiv = document.getElementById('gpu-log');
  const logOutput = document.getElementById('gpu-log-output');

  // Show confirmation
  const isRepairFlow = installBtn.dataset.mode === 'repair';
  const confirmed = confirm(
    (isRepairFlow
      ? 'Repair AvaNevis CUDA libraries (about 1 GB)?\n\n'
      : 'Download and install CUDA libraries (about 1 GB) for faster transcription on your NVIDIA GPU?\n\n') +
    'Other CUDA versions on this computer will not be modified. This may take several minutes depending on your connection.'
  );

  if (!confirmed) return;

  // UI setup
  installBtn.disabled = true;
  installBtn.classList.add('is-loading');
  statusBadge.textContent = 'Installing...';
  statusBadge.className = 'setting-badge installing';
  progressDiv.style.display = 'block';
  logDiv.style.display = 'block';
  logOutput.textContent = '';
  progressBar.style.width = '0%';
  progressText.textContent = 'Starting installation...';

  let progressInterval = null;
  try {
    // Simulate progress (pip doesn't give us real progress)
    let progress = 0;
    progressInterval = setInterval(() => {
      if (progress < 90) {
        progress += Math.random() * 5;
        progressBar.style.width = `${Math.min(progress, 90)}%`;
      }
    }, 2000);

    progressText.textContent = isRepairFlow
      ? 'Checking GPU runtime and repairing compatibility...'
      : 'Checking GPU runtime and installing libraries...';

    const ensureResult = await window.electronAPI.ensureCompatibleGpuRuntime({
      skipInstallIfReady: true,
      forceRepair: isRepairFlow,
    });

    if (!ensureResult || !ensureResult.success) {
      throw new Error((ensureResult && ensureResult.message) || 'GPU runtime is still not loadable.');
    }

    // Complete progress
    progressBar.style.width = '100%';
    progressText.textContent = ensureResult.action === 'none'
      ? 'GPU runtime already ready.'
      : 'Installation complete!';

    // Update status
    statusBadge.textContent = 'Enabled';
    statusBadge.className = 'setting-badge enabled';
    installBtn.classList.remove('is-loading');

    // Hide progress after delay
    setTimeout(() => {
      progressDiv.style.display = 'none';
      logDiv.style.display = 'none';
    }, 3000);

    // Refresh status
    await checkGPUStatus();
    await refreshAiAddonSettings();

    const didRepair = ensureResult.action === 'repair';
    const alreadyReady = ensureResult.action === 'none';
    alert(
      alreadyReady
        ? 'GPU runtime is already installed and loadable.\n\nFaster transcription is available.'
        : (didRepair
          ? 'GPU runtime repair completed.\n\nAvaNevis verified the supported runtime profile is loadable. Other CUDA runtimes used by other apps were not removed.'
          : 'GPU acceleration installed successfully.\n\nAvaNevis verified the runtime is loadable and faster transcription is available.'),
    );
  } catch (error) {
    console.error('GPU installation failed:', error);
    appendGPULog(`\nERROR: ${error.message}`);
    progressText.textContent = 'Installation failed!';
    statusBadge.textContent = 'Failed';
    statusBadge.className = 'setting-badge disabled';
    installBtn.disabled = false;
    installBtn.classList.remove('is-loading');

    if (isGpuRuntimeActionBusyError(error)) {
      alert(formatGpuRuntimeBusyAlertMessage(error));
    } else {
      alert(`GPU installation failed.\n\n${error.message}`);
    }
  } finally {
    if (progressInterval) {
      clearInterval(progressInterval);
    }
  }
}

async function uninstallGPUAcceleration() {
  const platform = await window.electronAPI.getPlatform().catch(() => null);
  const confirmed = confirm(
    'Remove AvaNevis CUDA libraries? Other CUDA versions on this computer will not be modified.\n\n' +
    (platform === 'linux'
      ? getLinuxCudaUninstallConfirmSuffix()
      : 'Transcription will return to CPU.\n\n') +
    'Continue?'
  );

  if (!confirmed) return;

  const statusBadge = document.getElementById('gpu-status-badge');
  statusBadge.textContent = 'Uninstalling...';
  statusBadge.className = 'setting-badge';

  try {
    await window.electronAPI.uninstallGPU();
    await checkGPUStatus();
    await refreshAiAddonSettings();
    alert(
      'AvaNevis GPU acceleration libraries were uninstalled successfully.\n\n' +
      'Other CUDA runtimes used by other applications were not removed.',
    );
  } catch (error) {
    console.error('Uninstall failed:', error);
    if (isGpuRuntimeActionBusyError(error)) {
      alert(formatGpuRuntimeBusyAlertMessage(error));
    } else {
      alert(
        'Failed to uninstall AvaNevis GPU acceleration libraries.\n\n' +
        'No changes were made to system CUDA runtimes used by other applications.',
      );
    }
  }
}

function appendGPULog(text) {
  const logOutput = document.getElementById('gpu-log-output');
  logOutput.textContent += text;
  logOutput.scrollTop = logOutput.scrollHeight;
}

// ============================================================================
// Phase 3: Non-Intrusive In-App Auto-Updater UX
// ============================================================================

let updateUiState = null;
let updateStateSeq = -1;
let updatePopoverOpen = false;
let dismissedUpdateVersion = null;
let updateAiConfirmPending = false;
let lastRenderedReleaseNotesKey = null;
let lastAnnouncedUpdateStatus = null;
let updateManualCopyTimer = null;
let updateUiWired = false;

function isRecordingActiveForUpdate() {
  return recordingState !== 'idle' && recordingState !== 'transcribing';
}

function initUpdateUi() {
  if (!updateUiWired) {
    updateUiWired = true;

    const railBtn = document.getElementById('rail-update-btn');
    const popoverCloseBtn = document.getElementById('update-popover-close');
    const popoverPrimaryBtn = document.getElementById('update-popover-primary-btn');
    const popoverSecondaryBtn = document.getElementById('update-popover-secondary-btn');
    const popoverTertiaryBtn = document.getElementById('update-popover-tertiary-btn');
    const aiConfirmRestartBtn = document.getElementById('update-ai-confirm-restart');
    const aiConfirmWaitBtn = document.getElementById('update-ai-confirm-wait');
    const manualCopyBtn = document.getElementById('update-popover-manual-copy');
    const settingsPrimaryBtn = document.getElementById('update-settings-primary-btn');
    const settingsGithubBtn = document.getElementById('update-settings-github-btn');
    const autoDownloadToggle = document.getElementById('auto-download-updates-toggle');

    if (railBtn) {
      railBtn.addEventListener('click', () => {
        if (updatePopoverOpen) {
          closeUpdatePopover({ returnFocus: false });
        } else {
          openUpdatePopover({ focus: true });
        }
      });
    }

    if (popoverCloseBtn) {
      popoverCloseBtn.addEventListener('click', () => {
        closeUpdatePopover({ returnFocus: true });
      });
    }

    if (popoverPrimaryBtn) {
      popoverPrimaryBtn.addEventListener('click', () => {
        void handleUpdateAction(popoverPrimaryBtn.dataset.action || '');
      });
    }

    if (popoverSecondaryBtn) {
      popoverSecondaryBtn.addEventListener('click', () => {
        void handleUpdateAction(popoverSecondaryBtn.dataset.action || '');
      });
    }

    if (popoverTertiaryBtn) {
      popoverTertiaryBtn.addEventListener('click', () => {
        void handleUpdateAction(popoverTertiaryBtn.dataset.action || '');
      });
    }

    if (aiConfirmRestartBtn) {
      aiConfirmRestartBtn.addEventListener('click', () => {
        void handleInstallUpdateNow({ confirmAiInterrupt: true });
      });
    }

    if (aiConfirmWaitBtn) {
      aiConfirmWaitBtn.addEventListener('click', () => {
        updateAiConfirmPending = false;
        renderUpdateUi();
      });
    }

    if (manualCopyBtn) {
      manualCopyBtn.addEventListener('click', () => {
        void handleCopyManualInstallCommand();
      });
    }

    if (settingsPrimaryBtn) {
      settingsPrimaryBtn.addEventListener('click', () => {
        void handleUpdateAction(settingsPrimaryBtn.dataset.action || '');
      });
    }

    if (settingsGithubBtn) {
      settingsGithubBtn.addEventListener('click', () => {
        void handleUpdateAction('github');
      });
    }

    if (autoDownloadToggle) {
      autoDownloadToggle.addEventListener('change', (event) => {
        void handleAutoDownloadToggleChange(event);
      });
    }

    const handleGlobalKeydown = (event) => {
      if (event.key === 'Escape' && updatePopoverOpen) {
        event.preventDefault();
        closeUpdatePopover({ returnFocus: true });
      }
    };
    document.addEventListener('keydown', handleGlobalKeydown);
    registerCleanup(() => document.removeEventListener('keydown', handleGlobalKeydown));

    const handleGlobalPointerDown = (event) => {
      if (!updatePopoverOpen) {
        return;
      }
      const popover = document.getElementById('update-popover');
      const railButton = document.getElementById('rail-update-btn');
      if (popover && popover.contains(event.target)) {
        return;
      }
      if (railButton && railButton.contains(event.target)) {
        return;
      }
      closeUpdatePopover({ returnFocus: false });
    };
    document.addEventListener('mousedown', handleGlobalPointerDown);
    registerCleanup(() => document.removeEventListener('mousedown', handleGlobalPointerDown));
    registerCleanup(() => {
      if (updateManualCopyTimer) {
        clearTimeout(updateManualCopyTimer);
        updateManualCopyTimer = null;
      }
    });
  }

  if (typeof window.electronAPI?.onUpdateStateChanged === 'function') {
    registerCleanup(window.electronAPI.onUpdateStateChanged((nextState) => {
      applyIncomingUpdateState(nextState, { isHydration: false });
    }));
  }

  if (typeof window.electronAPI?.getUpdateState === 'function') {
    window.electronAPI.getUpdateState()
      .then((initialState) => {
        applyIncomingUpdateState(initialState, { isHydration: true });
      })
      .catch((error) => {
        console.warn('Could not hydrate update state:', error);
      });
  }

  renderUpdateUi();
}

function applyIncomingUpdateState(nextState, { isHydration = false } = {}) {
  if (!shouldAcceptUpdateState(updateStateSeq, nextState)) {
    return;
  }

  const prevState = updateUiState;
  updateStateSeq = Number(nextState.seq);
  updateUiState = nextState;

  if (nextState.status !== 'ready-to-install') {
    updateAiConfirmPending = false;
  }

  if (!isHydration && nextState.status === 'ready-to-install') {
    dismissedUpdateVersion = null;
  }

  if (
    !isHydration
    && shouldAutoSurfaceUpdatePopover(prevState, nextState, {
      isRecordingActive: isRecordingActiveForUpdate(),
      dismissedVersion: dismissedUpdateVersion,
    })
  ) {
    openUpdatePopover({ focus: false });
  }

  renderUpdateUi();
}

function openUpdatePopover({ focus = true } = {}) {
  const popover = document.getElementById('update-popover');
  const railBtn = document.getElementById('rail-update-btn');
  if (!popover) {
    return;
  }
  updatePopoverOpen = true;
  popover.hidden = false;
  if (railBtn) {
    railBtn.setAttribute('aria-expanded', 'true');
  }
  renderUpdateUi();
  if (focus) {
    const titleEl = document.getElementById('update-popover-title');
    if (titleEl && typeof titleEl.focus === 'function') {
      titleEl.focus();
    }
  }
}

function focusFallbackAfterUpdateSurfaceClose() {
  const settingsTab = document.getElementById('settings-tab');
  const settingsPrimaryBtn = document.getElementById('update-settings-primary-btn');
  if (
    settingsTab
    && settingsTab.classList.contains('active')
    && settingsPrimaryBtn
    && !settingsPrimaryBtn.disabled
    && typeof settingsPrimaryBtn.focus === 'function'
  ) {
    settingsPrimaryBtn.focus();
    return;
  }
  const settingsRailBtn = document.querySelector('.rail-btn[data-tab="settings"]');
  if (settingsRailBtn && typeof settingsRailBtn.focus === 'function') {
    settingsRailBtn.focus();
  }
}

function closeUpdatePopover({ returnFocus = false, markDismissed = false } = {}) {
  const popover = document.getElementById('update-popover');
  const railBtn = document.getElementById('rail-update-btn');
  updatePopoverOpen = false;
  if (popover) {
    popover.hidden = true;
  }
  if (railBtn) {
    railBtn.setAttribute('aria-expanded', 'false');
  }
  if (markDismissed && updateUiState && updateUiState.availableVersion) {
    dismissedUpdateVersion = String(updateUiState.availableVersion);
  }
  renderUpdateUi();
  if (returnFocus) {
    if (railBtn && !railBtn.hidden && typeof railBtn.focus === 'function') {
      railBtn.focus();
    } else {
      focusFallbackAfterUpdateSurfaceClose();
    }
  }
}

function applyUpdateButtonVariant(button, variant) {
  if (!button) {
    return;
  }
  button.classList.remove('btn-primary', 'btn-secondary', 'btn-update-ready');
  if (variant === 'ready') {
    button.classList.add('btn-update-ready');
  } else if (variant === 'secondary') {
    button.classList.add('btn-secondary');
  } else {
    button.classList.add('btn-primary');
  }
}

function renderUpdateUi() {
  const vm = buildUpdateViewModel(updateUiState || {}, {
    isRecordingActive: isRecordingActiveForUpdate(),
    dismissedVersion: dismissedUpdateVersion,
    aiConfirmPending: updateAiConfirmPending,
  });

  // Surface 1: Left-rail indicator
  const railBtn = document.getElementById('rail-update-btn');
  if (railBtn) {
    const shouldShowRailBtn = Boolean(vm.rail.visible || updatePopoverOpen);
    if (
      !shouldShowRailBtn
      && !railBtn.hidden
      && (document.activeElement === railBtn || (typeof railBtn.contains === 'function' && railBtn.contains(document.activeElement)))
    ) {
      focusFallbackAfterUpdateSurfaceClose();
    }
    railBtn.hidden = !shouldShowRailBtn;
    railBtn.dataset.tone = vm.rail.tone;
    railBtn.setAttribute('aria-label', vm.rail.ariaLabel);
    railBtn.setAttribute('aria-expanded', updatePopoverOpen ? 'true' : 'false');

    const tooltip = document.getElementById('rail-update-tooltip');
    if (tooltip) {
      tooltip.textContent = vm.rail.tooltip;
    }

    const dot = document.getElementById('rail-update-dot');
    if (dot) {
      dot.hidden = !vm.rail.showDot;
    }

    const ring = document.getElementById('rail-update-ring');
    const ringFill = document.getElementById('rail-update-ring-fill');
    if (ring) {
      ring.hidden = !vm.rail.showRing;
    }
    if (ringFill) {
      ringFill.setAttribute('stroke-dasharray', String(vm.progress.ringDashArray));
      ringFill.setAttribute('stroke-dashoffset', String(vm.progress.ringDashOffset));
    }

    const iconArrow = document.getElementById('rail-update-icon-arrow');
    const iconReady = document.getElementById('rail-update-icon-ready');
    const iconSpinner = document.getElementById('rail-update-icon-spinner');
    const iconAlert = document.getElementById('rail-update-icon-alert');
    if (iconArrow) iconArrow.hidden = vm.rail.iconKind !== 'arrow-up';
    if (iconReady) iconReady.hidden = vm.rail.iconKind !== 'check-restart';
    if (iconSpinner) iconSpinner.hidden = vm.rail.iconKind !== 'spinner';
    if (iconAlert) iconAlert.hidden = vm.rail.iconKind !== 'alert';
  }

  // Surface 2: Anchored popover
  const chip = document.getElementById('update-status-chip');
  const chipLabel = document.getElementById('update-status-chip-label');
  const titleEl = document.getElementById('update-popover-title');
  const versionBadge = document.getElementById('update-popover-version');
  const notesEl = document.getElementById('update-popover-notes');
  const progressBlock = document.getElementById('update-popover-progress');
  const progressTrack = document.getElementById('update-popover-progress-track');
  const progressFill = document.getElementById('update-popover-progress-fill');
  const progressPercent = document.getElementById('update-popover-progress-percent');
  const progressBytes = document.getElementById('update-popover-progress-bytes');
  const progressSpeed = document.getElementById('update-popover-progress-speed');
  const busyNotice = document.getElementById('update-popover-busy-notice');
  const aiConfirm = document.getElementById('update-popover-ai-confirm');
  const manualBlock = document.getElementById('update-popover-manual');
  const manualGuidance = document.getElementById('update-popover-manual-guidance');
  const manualCmd = document.getElementById('update-popover-manual-cmd');
  const errorBlock = document.getElementById('update-popover-error');
  const errorText = document.getElementById('update-popover-error-text');
  const primaryBtn = document.getElementById('update-popover-primary-btn');
  const secondaryBtn = document.getElementById('update-popover-secondary-btn');
  const tertiaryBtn = document.getElementById('update-popover-tertiary-btn');
  const liveRegion = document.getElementById('update-popover-live');

  if (chip) chip.dataset.tone = vm.popover.tone;
  if (chipLabel) chipLabel.textContent = vm.popover.chipLabel;
  if (titleEl) titleEl.textContent = vm.popover.title;
  if (versionBadge) {
    versionBadge.textContent = vm.popover.versionDelta;
    versionBadge.hidden = !vm.popover.versionDelta;
  }

  if (notesEl) {
    const rawNotes = updateUiState && updateUiState.releaseNotes ? String(updateUiState.releaseNotes) : '';
    const notesKey = `${vm.availableVersion || ''}:${rawNotes}`;
    if (vm.popover.hasReleaseNotes) {
      if (notesKey !== lastRenderedReleaseNotesKey) {
        renderSafeReleaseNotes(notesEl, rawNotes, {
          markdownRenderHelpers: window.markdownRenderHelpers,
        });
        lastRenderedReleaseNotesKey = notesKey;
      }
      notesEl.hidden = false;
    } else {
      notesEl.hidden = true;
    }
  }

  if (progressBlock) {
    progressBlock.hidden = !vm.popover.showProgress;
  }
  if (progressTrack) {
    progressTrack.setAttribute('aria-valuenow', String(Math.round(vm.progress.percent)));
  }
  if (progressFill) {
    progressFill.style.width = `${vm.progress.percent}%`;
  }
  if (progressPercent) progressPercent.textContent = vm.progress.percentText;
  if (progressBytes) progressBytes.textContent = vm.progress.transferredText;
  if (progressSpeed) progressSpeed.textContent = vm.progress.speedText;

  if (busyNotice) {
    busyNotice.hidden = !vm.popover.showRecordingNotice;
  }
  if (aiConfirm) {
    aiConfirm.hidden = !vm.popover.showAiConfirm;
  }
  if (manualBlock) {
    manualBlock.hidden = !vm.popover.showManualPackage;
    if (manualGuidance) manualGuidance.textContent = vm.popover.manualGuidance;
    if (manualCmd) manualCmd.textContent = vm.popover.manualInstallCommand;
  }
  if (errorBlock) {
    errorBlock.hidden = !vm.popover.showError;
    if (errorText) errorText.textContent = vm.popover.errorMessage;
  }

  if (primaryBtn) {
    primaryBtn.hidden = !vm.popover.primaryAction.visible;
    primaryBtn.textContent = vm.popover.primaryAction.label;
    primaryBtn.disabled = Boolean(vm.popover.primaryAction.disabled);
    primaryBtn.dataset.action = vm.popover.primaryAction.action || '';
    applyUpdateButtonVariant(primaryBtn, vm.popover.primaryAction.variant);
  }
  if (secondaryBtn) {
    secondaryBtn.hidden = !vm.popover.secondaryAction.visible;
    secondaryBtn.textContent = vm.popover.secondaryAction.label;
    secondaryBtn.disabled = Boolean(vm.popover.secondaryAction.disabled);
    secondaryBtn.dataset.action = vm.popover.secondaryAction.action || '';
  }
  if (tertiaryBtn) {
    tertiaryBtn.hidden = !vm.popover.tertiaryAction.visible;
    tertiaryBtn.textContent = vm.popover.tertiaryAction.label;
    tertiaryBtn.dataset.action = vm.popover.tertiaryAction.action || '';
  }

  if (liveRegion && vm.status !== lastAnnouncedUpdateStatus) {
    lastAnnouncedUpdateStatus = vm.status;
    if (vm.status !== 'idle' && vm.status !== 'downloading') {
      liveRegion.textContent = vm.popover.versionDelta
        ? `${vm.popover.title} (${vm.popover.versionDelta})`
        : vm.popover.title;
    }
  }

  // Surface 3: Settings -> Updates card
  const settingsBadge = document.getElementById('update-settings-badge');
  const settingsVersion = document.getElementById('update-settings-version');
  const settingsMode = document.getElementById('update-settings-mode');
  const settingsLastChecked = document.getElementById('update-settings-last-checked');
  const settingsProgress = document.getElementById('update-settings-progress');
  const settingsProgressTrack = document.getElementById('update-settings-progress-track');
  const settingsProgressFill = document.getElementById('update-settings-progress-fill');
  const settingsProgressPercent = document.getElementById('update-settings-progress-percent');
  const settingsProgressBytes = document.getElementById('update-settings-progress-bytes');
  const settingsProgressSpeed = document.getElementById('update-settings-progress-speed');
  const settingsBusyNotice = document.getElementById('update-settings-busy-notice');
  const settingsError = document.getElementById('update-settings-error');
  const settingsPrimaryBtn = document.getElementById('update-settings-primary-btn');
  const autoDownloadToggle = document.getElementById('auto-download-updates-toggle');
  const autoDownloadHint = document.getElementById('auto-download-updates-hint');

  if (settingsBadge) {
    settingsBadge.textContent = vm.settings.badgeText;
    settingsBadge.className = `setting-badge ${vm.settings.badgeTone}`;
  }
  if (settingsVersion) {
    settingsVersion.textContent = vm.settings.versionText;
  }
  if (settingsMode) {
    settingsMode.textContent = vm.settings.modeText;
  }
  if (settingsLastChecked) {
    settingsLastChecked.textContent = vm.settings.lastCheckedText;
  }
  if (settingsProgress) {
    settingsProgress.hidden = !vm.settings.showProgress;
  }
  if (settingsProgressTrack) {
    settingsProgressTrack.setAttribute('aria-valuenow', String(Math.round(vm.progress.percent)));
  }
  if (settingsProgressFill) {
    settingsProgressFill.style.width = `${vm.progress.percent}%`;
  }
  if (settingsProgressPercent) settingsProgressPercent.textContent = vm.progress.percentText;
  if (settingsProgressBytes) settingsProgressBytes.textContent = vm.progress.transferredText;
  if (settingsProgressSpeed) settingsProgressSpeed.textContent = vm.progress.speedText;

  if (settingsBusyNotice) {
    settingsBusyNotice.hidden = !vm.settings.showRecordingNotice;
  }
  if (settingsError) {
    settingsError.hidden = !vm.settings.showError;
    settingsError.textContent = vm.settings.errorMessage;
  }
  if (settingsPrimaryBtn) {
    settingsPrimaryBtn.textContent = vm.settings.primaryAction.label;
    settingsPrimaryBtn.disabled = Boolean(vm.settings.primaryAction.disabled);
    settingsPrimaryBtn.dataset.action = vm.settings.primaryAction.action || '';
    applyUpdateButtonVariant(settingsPrimaryBtn, vm.settings.primaryAction.variant);
  }
  if (autoDownloadToggle) {
    autoDownloadToggle.checked = vm.settings.autoDownload.checked;
    autoDownloadToggle.disabled = vm.settings.autoDownload.disabled;
  }
  if (autoDownloadHint) {
    autoDownloadHint.textContent = vm.settings.autoDownload.hint;
  }
}

async function handleUpdateAction(action) {
  try {
    switch (action) {
      case 'check':
      case 'retry': {
        if (typeof window.electronAPI?.checkForUpdates === 'function') {
          const nextState = await window.electronAPI.checkForUpdates();
          applyIncomingUpdateState(nextState, { isHydration: false });
        }
        break;
      }
      case 'download': {
        if (typeof window.electronAPI?.downloadUpdate === 'function') {
          const result = await window.electronAPI.downloadUpdate();
          if (result && result.state) {
            applyIncomingUpdateState(result.state, { isHydration: false });
          }
        }
        break;
      }
      case 'cancel': {
        if (typeof window.electronAPI?.cancelUpdateDownload === 'function') {
          const result = await window.electronAPI.cancelUpdateDownload();
          if (result && result.state) {
            applyIncomingUpdateState(result.state, { isHydration: false });
          }
        }
        break;
      }
      case 'install': {
        await handleInstallUpdateNow({ confirmAiInterrupt: false });
        break;
      }
      case 'github': {
        if (typeof window.electronAPI?.openUpdateReleasePage === 'function') {
          await window.electronAPI.openUpdateReleasePage();
        }
        break;
      }
      case 'later': {
        closeUpdatePopover({ returnFocus: true, markDismissed: true });
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error(`Update action "${action}" failed:`, error);
    addLog(`Update action failed: ${error.message || error}`, 'error');
  }
}

async function handleInstallUpdateNow({ confirmAiInterrupt = false } = {}) {
  if (isRecordingActiveForUpdate()) {
    renderUpdateUi();
    return;
  }
  if (typeof window.electronAPI?.installUpdateNow !== 'function') {
    return;
  }
  try {
    const result = await window.electronAPI.installUpdateNow({ confirmAiInterrupt });
    if (result && result.state) {
      applyIncomingUpdateState(result.state, { isHydration: false });
    }
    if (result && !result.ok) {
      if (result.code === 'UPDATE_CONFIRM_AI_INTERRUPT') {
        updateAiConfirmPending = true;
        if (!updatePopoverOpen) {
          openUpdatePopover({ focus: false });
        } else {
          renderUpdateUi();
        }
        const aiConfirmRestartBtn = document.getElementById('update-ai-confirm-restart');
        if (aiConfirmRestartBtn && typeof aiConfirmRestartBtn.focus === 'function') {
          aiConfirmRestartBtn.focus();
        }
        return;
      }
      if (result.message) {
        addLog(result.message, 'warning');
      }
    }
  } catch (error) {
    console.error('Failed to install update:', error);
    addLog(`Failed to install update: ${error.message || error}`, 'error');
  }
}

async function handleAutoDownloadToggleChange(event) {
  const toggle = event && event.target ? event.target : null;
  if (!toggle || typeof window.electronAPI?.setAutoDownloadUpdates !== 'function') {
    return;
  }
  const desired = Boolean(toggle.checked);
  toggle.disabled = true;
  try {
    const result = await window.electronAPI.setAutoDownloadUpdates(desired);
    if (result && result.state) {
      applyIncomingUpdateState(result.state, { isHydration: false });
    }
  } catch (error) {
    console.error('Failed to update auto-download preference:', error);
    toggle.checked = !desired;
  } finally {
    renderUpdateUi();
  }
}

async function handleCopyManualInstallCommand() {
  const copyBtn = document.getElementById('update-popover-manual-copy');
  const cmd = updateUiState && updateUiState.manualInstallCommand
    ? String(updateUiState.manualInstallCommand)
    : '';
  if (!cmd || !copyBtn) {
    return;
  }
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(cmd);
    }
    copyBtn.textContent = 'Copied';
    if (updateManualCopyTimer) {
      clearTimeout(updateManualCopyTimer);
    }
    updateManualCopyTimer = setTimeout(() => {
      copyBtn.textContent = 'Copy';
      updateManualCopyTimer = null;
    }, 2000);
  } catch (error) {
    console.warn('Could not copy manual install command:', error);
  }
}

// ============================================================================
// Audio Visualizer Class — restrained, interpolated, dual-channel signal monitor
// ============================================================================

class AudioVisualizer {
  constructor() {
    this.container = document.getElementById('audio-visualizer');
    this.micCanvas = document.getElementById('mic-waveform');
    this.desktopCanvas = document.getElementById('desktop-waveform');
    this.micTrackEl = document.getElementById('mic-visualizer-track');
    this.desktopTrackEl = document.getElementById('desktop-visualizer-track');

    this.micCtx = this.micCanvas.getContext('2d');
    this.desktopCtx = this.desktopCanvas.getContext('2d');

    // Which tracks this recording actually captures. A source that was never
    // opened must not be shown as a flat, permanently silent meter.
    this.includeMic = true;
    this.includeDesktop = true;

    // History buffers — current displayed values (smoothly interpolated)
    this.bufferSize = 96;
    this.micBuffer = new Array(this.bufferSize).fill(0);
    this.desktopBuffer = new Array(this.bufferSize).fill(0);
    this.micTrace = new Float32Array(this.bufferSize);
    this.desktopTrace = new Float32Array(this.bufferSize);

    // Per-channel "current incoming sample" target. Each draw frame the
    // newest column lerps toward this target so the wave keeps moving even
    // between the recorder's 5 Hz updates.
    this.micTarget = 0;
    this.desktopTarget = 0;

    // Sample-arrival metering — decides when to "shift" a new column in.
    // The recorder emits at ~5 Hz (every 200ms); we shift at that cadence.
    this.lastShiftTime = 0;
    this.shiftIntervalMs = 80; // visual shift cadence — denser than recorder for fluidity
    this.tracePhase = 0;

    this.rafId = null;
    this.isRunning = false;

    this.lastUpdateTime = 0;
    this.warningShown = false;
    this._lastDrawnMicTarget = null;
    this._lastDrawnDesktopTarget = null;
    this._visibilityHandler = null;

    this.dpr = 1;
    this.micColor = '184, 168, 201';
    this.desktopColor = '168, 176, 200';
  }

  _setupCanvas(canvas, ctx) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.dpr = dpr;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }

  start(captureMode) {
    const sources = getCaptureModeSources(captureMode);
    this.includeMic = sources.includeMic;
    this.includeDesktop = sources.includeDesktop;
    if (this.micTrackEl) {
      this.micTrackEl.hidden = !this.includeMic;
    }
    if (this.desktopTrackEl) {
      this.desktopTrackEl.hidden = !this.includeDesktop;
    }

    this.isRunning = true;
    this.container.style.display = 'flex';
    this.micBuffer.fill(0);
    this.desktopBuffer.fill(0);
    this.micTrace.fill(0);
    this.desktopTrace.fill(0);
    this.micTarget = 0;
    this.desktopTarget = 0;
    this.tracePhase = 0;
    this.lastUpdateTime = Date.now();
    this.lastShiftTime = performance.now();
    this.warningShown = false;
    this._lastDrawnMicTarget = null;
    this._lastDrawnDesktopTarget = null;

    const rootStyles = getComputedStyle(document.documentElement);
    this.micColor = rootStyles.getPropertyValue('--accent-rgb').trim() || this.micColor;
    this.desktopColor = rootStyles.getPropertyValue('--sky-rgb').trim() || this.desktopColor;

    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (!this.isRunning || document.hidden || this.rafId !== null) {
          return;
        }
        this._loop();
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    // Defer a tick so the container is visible and has layout. A hidden track
    // has no layout box, so only size the canvases actually on screen.
    requestAnimationFrame(() => {
      if (this.includeMic) {
        this._setupCanvas(this.micCanvas, this.micCtx);
      }
      if (this.includeDesktop) {
        this._setupCanvas(this.desktopCanvas, this.desktopCtx);
      }
      this._loop();
    });

  }

  stop() {
    this.isRunning = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    this.container.style.display = 'none';
    this.warningShown = false;
  }

  updateLevels(levels) {
    this.lastUpdateTime = Date.now();
    this.warningShown = false;

    // Recorders keep emitting both keys (stdout schema is unchanged), but an
    // unrequested source reports a constant 0.0 — ignore it rather than
    // rendering it as a real, silent input.
    const nextMicTarget = this.includeMic
      ? Math.max(0, Math.min(1, levels.mic || 0))
      : 0;
    const nextDesktopTarget = this.includeDesktop
      ? Math.max(0, Math.min(1, levels.desktop || 0))
      : 0;
    if (nextMicTarget !== this.micTarget || nextDesktopTarget !== this.desktopTarget) {
      this._lastDrawnMicTarget = null;
      this._lastDrawnDesktopTarget = null;
    }
    this.micTarget = nextMicTarget;
    this.desktopTarget = nextDesktopTarget;

    if (this.isRunning && this.rafId === null && !document.hidden) {
      this._loop();
    }
  }

  _loop() {
    if (!this.isRunning) return;

    if (document.hidden) {
      this.rafId = null;
      return;
    }

    const now = performance.now();
    const shouldShift = now - this.lastShiftTime >= this.shiftIntervalMs;
    const timeSinceUpdate = Date.now() - this.lastUpdateTime;
    const heartbeatFade = timeSinceUpdate > 5000;
    const targetsUnchanged = this.micTarget === this._lastDrawnMicTarget
      && this.desktopTarget === this._lastDrawnDesktopTarget;

    if (!shouldShift && targetsUnchanged && !heartbeatFade) {
      this.rafId = null;
      return;
    }

    // Smoothly lerp the newest column toward the target (fast attack, slow release)
    const lastIdx = this.bufferSize - 1;
    const lerp = (cur, target) => {
      const k = target > cur ? 0.55 : 0.18; // attack vs release
      return cur + (target - cur) * k;
    };
    this.micBuffer[lastIdx] = lerp(this.micBuffer[lastIdx], this.micTarget);
    this.desktopBuffer[lastIdx] = lerp(this.desktopBuffer[lastIdx], this.desktopTarget);

    // Periodically shift a new column in so the wave scrolls left
    if (shouldShift) {
      this.lastShiftTime = now;
      this.micBuffer.copyWithin(0, 1);
      this.desktopBuffer.copyWithin(0, 1);
      this.micBuffer[lastIdx] = this.micTarget;
      this.desktopBuffer[lastIdx] = this.desktopTarget;
      this.tracePhase = (this.tracePhase + 1) % 8;
    }

    if (heartbeatFade) {
      for (let i = 0; i < this.bufferSize; i++) {
        this.micBuffer[i] *= 0.92;
        this.desktopBuffer[i] *= 0.92;
      }
      if (!this.warningShown && recordingState === 'recording') {
        console.warn('Visualizer: No audio levels for 5s - recording may be paused');
        addLog('⚠️ Warning: Audio visualization paused (no data from recorder)', 'warning');
        this.warningShown = true;
      }
    }

    if (this.includeMic) {
      this._draw(this.micCtx, this.micBuffer, this.micTrace, this.micColor);
    }
    if (this.includeDesktop) {
      this._draw(this.desktopCtx, this.desktopBuffer, this.desktopTrace, this.desktopColor);
    }
    this._lastDrawnMicTarget = this.micTarget;
    this._lastDrawnDesktopTarget = this.desktopTarget;

    this.rafId = requestAnimationFrame(() => this._loop());
  }

  _draw(ctx, buffer, trace, colorBase) {
    const canvas = ctx.canvas;
    const dpr = this.dpr;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const midY = height / 2;
    const n = this.bufferSize;

    ctx.clearRect(0, 0, width, height);

    // A quiet datum line makes a silent source immediately legible.
    ctx.strokeStyle = `rgba(${colorBase}, 0.11)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    const energy = writeSignalTrace(buffer, trace, this.tracePhase);
    const amplitudeScale = height * 0.4;

    // Build the angular path once, then stroke it twice. The broad underlay
    // supplies presence without the cost and haze of per-frame shadow blur.
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * width;
      const y = midY - trace[i] * amplitudeScale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${colorBase}, ${0.1 + energy * 0.12})`;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'miter';
    ctx.stroke();

    ctx.strokeStyle = `rgba(${colorBase}, ${0.72 + energy * 0.23})`;
    ctx.lineWidth = 1.15;
    ctx.stroke();
  }
}

// Handle page visibility changes (for debugging backgrounded recording)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log('App backgrounded - recording should continue');
  } else {
    console.log('App foregrounded - resuming visualization');
  }
});

window.addEventListener('beforeunload', runCleanup);

// ============================================================================
// Developer Console drawer
// ============================================================================

function setupDevConsole() {
  const consoleEl = document.getElementById('dev-console');
  const toggle = document.getElementById('dev-console-toggle');
  if (!consoleEl || !toggle) return;

  const STORAGE_KEY = 'avanevis-devconsole-open';
  const setOpen = (open) => {
    consoleEl.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    try { localStorage.setItem(STORAGE_KEY, open ? '1' : '0'); } catch (_) {}
  };

  let initial = false;
  try { initial = localStorage.getItem(STORAGE_KEY) === '1'; } catch (_) {}
  setOpen(initial);

  toggle.addEventListener('click', () => {
    setOpen(!consoleEl.classList.contains('open'));
  });
}

// ============================================================================
// Custom Audio Player (drives the hidden native <audio id="audio-player">)
// ============================================================================

function setupCustomAudioPlayer() {
  const audio = document.getElementById('audio-player');
  const playBtn = document.getElementById('cap-play-btn');
  const playIcon = document.getElementById('cap-play-icon');
  const track = document.getElementById('cap-track');
  const fill = document.getElementById('cap-track-fill');
  const thumb = document.getElementById('cap-track-thumb');
  const currentEl = document.getElementById('cap-current');
  const durationEl = document.getElementById('cap-duration');
  const volume = document.getElementById('cap-volume');

  if (!audio || !playBtn || !track) return;

  const PLAY_PATH = 'M8 5v14l11-7z';
  const PAUSE_PATH = 'M6 5h4v14H6zM14 5h4v14h-4z';

  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const setIcon = (path) => {
    const svg = playIcon;
    if (!svg) return;
    svg.innerHTML = `<path d="${path}"/>`;
  };

  const updateProgress = () => {
    const dur = audio.duration || 0;
    const cur = audio.currentTime || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    fill.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
    currentEl.textContent = fmt(cur);
    track.setAttribute('aria-valuenow', String(Math.round(pct)));
  };

  // ---- Smooth, frame-driven progress (avoids the stuttery 4Hz `timeupdate` event) ----
  let rafId = null;
  const tick = () => {
    rafId = null;
    if (!audio.paused && !audio.ended) {
      updateProgress();
      rafId = requestAnimationFrame(tick);
    }
  };
  const startTicking = () => {
    if (rafId === null) rafId = requestAnimationFrame(tick);
  };
  const stopTicking = () => {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    updateProgress();
  };

  const updateDuration = () => {
    durationEl.textContent = fmt(audio.duration || 0);
  };

  audio.addEventListener('loadedmetadata', () => {
    updateDuration();
    updateProgress();
  });
  audio.addEventListener('durationchange', updateDuration);
  audio.addEventListener('play', () => {
    setIcon(PAUSE_PATH);
    startTicking();
  });
  audio.addEventListener('pause', () => {
    setIcon(PLAY_PATH);
    stopTicking();
  });
  audio.addEventListener('seeked', updateProgress);
  audio.addEventListener('ended', () => {
    setIcon(PLAY_PATH);
    stopTicking();
    audio.currentTime = 0;
    updateProgress();
  });

  playBtn.addEventListener('click', () => {
    if (!audio.src) return;
    if (audio.paused) {
      audio.play().catch((err) => console.warn('Audio play failed:', err));
    } else {
      audio.pause();
    }
  });

  // Seeking (click + drag on the track)
  let scrubbing = false;
  const seekFromEvent = (e) => {
    const rect = track.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ratio = rect.width > 0 ? x / rect.width : 0;
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = ratio * audio.duration;
      updateProgress();
    } else {
      // Allow visual feedback even before metadata loads
      fill.style.width = `${ratio * 100}%`;
      thumb.style.left = `${ratio * 100}%`;
    }
  };

  const seekBySeconds = (deltaSeconds) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + deltaSeconds));
    updateProgress();
  };

  const seekToRatio = (ratio) => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
    updateProgress();
  };

  const beginScrub = (e) => {
    scrubbing = true;
    track.classList.add('scrubbing');
    seekFromEvent(e);
  };

  const endScrub = () => {
    if (scrubbing) {
      scrubbing = false;
      track.classList.remove('scrubbing');
    }
  };

  track.addEventListener('mousedown', (e) => {
    beginScrub(e);
  });
  window.addEventListener('mousemove', (e) => {
    if (scrubbing) seekFromEvent(e);
  });
  window.addEventListener('mouseup', endScrub);

  track.addEventListener('touchstart', (e) => {
    e.preventDefault();
    beginScrub(e);
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (!scrubbing) return;
    e.preventDefault();
    seekFromEvent(e);
  }, { passive: false });
  window.addEventListener('touchend', endScrub);
  window.addEventListener('touchcancel', endScrub);

  track.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        e.preventDefault();
        seekBySeconds(-5);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        e.preventDefault();
        seekBySeconds(5);
        break;
      case 'Home':
        e.preventDefault();
        seekToRatio(0);
        break;
      case 'End':
        e.preventDefault();
        seekToRatio(1);
        break;
      case 'PageDown':
        e.preventDefault();
        seekBySeconds(-30);
        break;
      case 'PageUp':
        e.preventDefault();
        seekBySeconds(30);
        break;
      default:
        break;
    }
  });

  // Volume
  if (volume) {
    audio.volume = parseFloat(volume.value);
    volume.addEventListener('input', () => {
      audio.volume = parseFloat(volume.value);
    });
  }

  // Sync & reset hooks used by audio seeking / setMeetingAudioSource()
  window.__syncCustomAudioPlayer = () => {
    updateDuration();
    updateProgress();
  };

  window.__resetCustomAudioPlayer = () => {
    setIcon(PLAY_PATH);
    fill.style.width = '0%';
    thumb.style.left = '0%';
    currentEl.textContent = '0:00';
    durationEl.textContent = '0:00';
    track.setAttribute('aria-valuenow', '0');
  };
}

// Import runs in main; the renderer only keeps the display name and per-file draft.
function setupAudioImport() {
  const byId = (id) => document.getElementById(`import-audio-${id}`);
  const modal = byId('modal');
  const form = byId('form');
  const engine = byId('engine');
  const language = byId('language');
  const model = byId('model');
  const tagSelect = byId('tag');
  const cancel = byId('cancel');
  const submit = byId('submit');
  const retry = byId('retry');
  const open = byId('open');
  const status = byId('status');
  let phase = 'closed';
  let resultId = null;
  let invoker = null;
  let background = [];
  let modelCheckEpoch = 0;

  function setBackgroundInert(inert) {
    if (inert) {
      if (background.length) return;
      background = [...document.body.children].filter((element) => element !== modal && !element.inert);
      background.forEach((element) => { element.inert = true; });
    } else {
      background.forEach((element) => { element.inert = false; });
      background = [];
    }
  }
  function close() {
    if (phase === 'saving' || phase === 'cancelling') return;
    if (phase === 'preparing') {
      phase = 'cancelling';
      status.textContent = 'Cancelling import…';
      cancel.disabled = true;
      void window.electronAPI.cancelImportAudio();
      return;
    }
    if (phase === 'confirm' || phase === 'error') void window.electronAPI.cancelImportAudio();
    phase = 'closed';
    modal.classList.add('hidden');
    setBackgroundInert(false);
    if (invoker?.isConnected) invoker.focus();
  }
  function updateFields() {
    const isParakeet = engine.value === 'parakeet';
    byId('whisper-fields').hidden = isParakeet;
    byId('english').hidden = !isParakeet;
    const validation = isParakeet ? { ok: parakeetEngineStatus?.status === 'ready' }
      : validateNewTranscriptionSelection(language.value, model.value);
    byId('guidance').textContent = isParakeet && !validation.ok
      ? 'Parakeet needs setup in Settings. Choose Whisper or cancel to set it up.'
      : (!validation.ok ? validation.message || 'Choose a supported language and model.' : '');
    submit.disabled = !validation.ok;
    if (!isParakeet && validation.ok && typeof window.electronAPI.checkModelDownloaded === 'function') {
      const epoch = ++modelCheckEpoch;
      submit.disabled = true;
      window.electronAPI.checkModelDownloaded(model.value).then((result) => {
        if (epoch !== modelCheckEpoch || engine.value !== 'whisper' || phase !== 'confirm') return;
        submit.disabled = !result?.downloaded;
        if (!result?.downloaded) byId('guidance').textContent = 'This Whisper model needs setup in Settings before importing.';
      }).catch(() => { if (epoch === modelCheckEpoch) byId('guidance').textContent = 'Could not check the Whisper model. Check setup in Settings.'; });
    } else { modelCheckEpoch++; }
  }
  async function chooseFile() {
    const previousDraft = phase === 'error'
      ? { engine: engine.value, language: language.value, model: model.value, tag: tagSelect ? tagSelect.value : '' }
      : null;
    let selected;
    try {
      selected = await window.electronAPI.selectImportAudio();
    } catch (error) {
      selected = { success: false, error: 'Could not choose a file. Try again.' };
    }
    if (!selected || selected.canceled) { if (phase === 'closed') invoker?.focus(); return; }
    if (!selected.success) { if (phase === 'closed') { invoker?.focus(); alert(selected.error || 'Could not choose a file.'); } else status.textContent = selected.error || 'Could not choose a file.'; return; }
    byId('name').textContent = selected.name;
    byId('title').textContent = 'Import audio';
    byId('description').hidden = false;
    byId('fields').hidden = false;
    language.replaceChildren(...[...languageSelect.options].map((option) => option.cloneNode(true)));
    model.replaceChildren(...[...modelSelect.options].map((option) => option.cloneNode(true)));
    if (tagSelect) {
      const noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = 'None (untagged)';
      const tagOptions = RECORDING_TAGS.map((entry) => {
        const opt = document.createElement('option');
        opt.value = entry.slug;
        opt.textContent = entry.label;
        return opt;
      });
      tagSelect.replaceChildren(noneOption, ...tagOptions);
      tagSelect.value = previousDraft?.tag ?? '';
    }
    language.value = previousDraft?.language ?? transcriptionEnginePreferences.whisper.language;
    model.value = previousDraft?.model ?? transcriptionEnginePreferences.whisper.modelSize;
    engine.value = previousDraft?.engine ?? transcriptionEnginePreferences.activeEngine;
    status.textContent = '';
    cancel.textContent = 'Cancel'; cancel.disabled = false;
    submit.hidden = false; retry.hidden = true; open.hidden = true;
    phase = 'confirm';
    modal.classList.remove('hidden'); setBackgroundInert(true);
    updateFields(); engine.focus();
    if (typeof window.electronAPI.getTranscriptionEngineStatus === 'function') {
      await refreshTranscriptionEngineStatus();
      if (phase === 'confirm') updateFields();
    }
  }
  async function start() {
    if (phase !== 'confirm' && phase !== 'error') return;
    if (submit.disabled) return;
    const selection = engine.value === 'parakeet' ? { engine: 'parakeet', language: 'en' }
      : { engine: 'whisper', language: language.value, modelSize: model.value };
    phase = 'preparing'; byId('fields').hidden = true; submit.hidden = true; retry.hidden = true;
    cancel.textContent = 'Cancel import'; cancel.disabled = false;
    status.textContent = 'Preparing audio…'; cancel.focus();
    const selectedImportTag = tagSelect && tagSelect.value ? normalizeTag(tagSelect.value) : null;
    let result;
    try {
      result = await window.electronAPI.startImportAudio({
        language: selection.language,
        modelSize: selection.modelSize,
        ...(selectedImportTag ? { tag: selectedImportTag } : {}),
        transcriptionSelection: selection,
      });
    }
    catch (error) { result = { success: false, error: error.message }; }
    if (result?.code === 'IMPORT_CANCELLED') { phase = 'confirm'; close(); return; }
    if (!result?.success && !result?.meeting && !result?.pendingMeeting) {
      phase = 'error'; cancel.disabled = false; cancel.textContent = 'Cancel';
      const invalidAudio = result?.code === 'IMPORT_INVALID_AUDIO';
      const setupRequired = result?.code === 'IMPORT_SETUP_REQUIRED';
      status.textContent = result?.code === 'ENOSPC' ? 'There isn’t enough space to save this recording. Free up space, then try again.'
        : invalidAudio ? 'AvaNevis couldn’t read audio from this file. Choose another MP3, WAV or Opus file.'
          : setupRequired ? (result.error || 'Check transcription setup in Settings before importing.')
            : result?.code === 'IMPORT_DECODER_UNAVAILABLE' ? 'The audio decoder could not start. Check your installation, then try again.'
              : (result?.error || 'Could not import this audio. Try again.');
      retry.textContent = invalidAudio ? 'Choose another file' : 'Try again';
      retry.dataset.choose = String(invalidAudio); retry.hidden = setupRequired;
      (retry.hidden ? cancel : retry).focus(); return;
    }
    const meeting = result.meeting || result.pendingMeeting;
    resultId = meeting?.id || result.meetingId;
    if (meeting && resultId && !meetings.some((item) => String(item.id) === String(resultId))) {
      meetings.unshift(meeting);
      renderMeetingList();
    }
    resultQueueSeq = 0;
    phase = 'result'; byId('title').textContent = 'Imported into History';
    byId('name').textContent = meeting?.title || byId('name').textContent.replace(/\.[^.]+$/, '');
    byId('description').hidden = true;
    status.textContent = result.success ? 'Transcription queued. You can play the audio now.' : 'Saved in History. Transcription hasn’t started.';
    cancel.textContent = 'Done'; cancel.disabled = false; open.hidden = !resultId;
    const savedResultId = resultId;
    await loadMeetingHistory();
    if (phase !== 'result' || resultId !== savedResultId) return;
    updateResultStatus();
    (open.hidden ? cancel : open).focus();
  }
  const railButton = byId('rail-button');
  [byId('button'), railButton].forEach((button) => {
    button.addEventListener('click', () => {
      if (button === railButton) activateTab('history');
      invoker = button;
      void chooseFile();
    });
  });
  [engine, language, model].forEach((control) => control.addEventListener('change', updateFields));
  form.addEventListener('submit', (event) => { event.preventDefault(); void start(); });
  cancel.addEventListener('click', close);
  retry.addEventListener('click', () => { if (retry.dataset.choose === 'true') void chooseFile(); else { phase = 'confirm'; void start(); } });
  async function openImportedMeeting(id) {
    id = String(id);
    const meeting = meetings.find((item) => String(item.id) === id);
    if (meeting && meetingSearchQueryNormalized) {
      const search = document.getElementById('meeting-search'); search.value = '';
      clearTimeout(meetingSearchDebounceTimer); meetingSearchDebounceTimer = null;
      meetingSearchEpoch += 1; meetingSearchQuery = ''; meetingSearchQueryNormalized = ''; meetingSearchResults = null; renderMeetingList();
    }
    activateHistoryDetailTab('transcript'); await selectMeeting(id);
    meetingList.querySelector(`.meeting-item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
    document.getElementById('cap-play-btn').focus();
  }
  open.addEventListener('click', () => {
    if (!resultId) return;
    const id = resultId;
    if (isHistoryTitleEditorOpen()) {
      const cancelDeferredOpen = () => {
        document.removeEventListener('history-title-edit-finished', finishDeferredOpen);
        document.removeEventListener('history-selection-changed', cancelDeferredOpen);
      };
      const finishDeferredOpen = () => {
        cancelDeferredOpen();
        void openImportedMeeting(id);
      };
      document.addEventListener('history-title-edit-finished', finishDeferredOpen, { once: true });
      document.addEventListener('history-selection-changed', cancelDeferredOpen, { once: true });
      close(); document.getElementById('meeting-title-input')?.focus(); return;
    }
    close(); void openImportedMeeting(id);
  });
  modal.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== 'Tab') return;
    const controls = [...modal.querySelectorAll('button, select')].filter((el) => !el.disabled && !el.hidden && el.getClientRects().length);
    if (!controls.length) { event.preventDefault(); byId('title').focus(); return; }
    const index = controls.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1].focus(); }
    else if (!event.shiftKey && (index === controls.length - 1 || index < 0)) { event.preventDefault(); controls[0].focus(); }
  });
  let resultQueueSeq = 0;
  function updateResultStatus(queue = transcriptionQueueState) {
    if (phase !== 'result' || !resultId) return;
    const seq = Number(queue?.seq) || 0;
    if (seq && seq < resultQueueSeq) return;
    resultQueueSeq = Math.max(resultQueueSeq, seq);
    const job = (queue?.jobs || []).find((item) => String(item.meetingId) === String(resultId));
    if (!job) return;
    const label = getActivityChipLabel(job);
    if (label === 'Ready') status.textContent = 'Transcript ready. You can play the audio now.';
    else if (label === 'Failed' || label === 'Cancelled') status.textContent = 'Saved in History. Transcription has not completed.';
    else if (label === 'Queued') status.textContent = 'Transcription queued. You can play the audio now.';
    else if (label && label !== 'Unknown') status.textContent = `${label}. You can play the audio now.`;
  }
  if (typeof window.electronAPI.onTranscriptionQueueState === 'function') {
    registerCleanup(window.electronAPI.onTranscriptionQueueState((payload) => updateResultStatus(payload)));
  }
  if (typeof window.electronAPI.onImportAudioProgress === 'function') {
    registerCleanup(window.electronAPI.onImportAudioProgress((progress) => {
      if (phase !== 'preparing' && phase !== 'saving' && phase !== 'cancelling') return;
      if (progress.phase === 'saving') { phase = 'saving'; status.textContent = 'Saving to History…'; cancel.disabled = true; byId('title').focus(); }
    }));
  }
}

// Start the app
init();
setupTabs();
setupKeyboardShortcuts();
setupDevConsole();
setupCustomAudioPlayer();
setupTitleEditors();
setupGPUCTA();
setupHomeAiAddonCTA();
setupAudioImport();

// ============================================================================
// Left-Rail Grounded Chat Workspace
// ============================================================================

const chatState = {
  listenersBound: false,
  threads: [],
  activeThread: null,
  pendingModelId: null,
  resettingRemovedModelThreadId: null,
  pendingScope: { type: 'all', meetingIds: [], dateFrom: null, dateTo: null, tags: [] },
  eligibility: null,
  modelState: { status: 'unloaded', modelId: null, modelName: null },
  sending: false,
  noticeActionPending: false,
  optimisticQuestion: null,
  streamingDraft: '',
  progress: null,
  editingThreadId: null,
  threadFilter: '',
  scopeFilter: '',
  scopeDraft: null,
  showAllScopeTags: false,
  popoverOpen: false,
  navigation: 0,
  listRequest: 0,
  draftKey: 'new:0',
  nextDraft: 0,
  newDraftKey: 'new:0',
  drafts: new Map(),
  sendingKey: null,
};

function saveChatDraft() {
  const input = document.getElementById('chat-input');
  if (input) chatState.drafts.set(chatState.draftKey, input.value);
}

function switchChatDraft(key) {
  saveChatDraft();
  chatState.draftKey = key;
  const input = document.getElementById('chat-input');
  if (input) input.value = chatState.drafts.get(key) || '';
  autoResizeChatInput();
}

function chatThreadDetailPending() {
  return chatState.draftKey.startsWith('thread:')
    && chatState.draftKey !== `thread:${chatState.activeThread?.id}`;
}

function chatSendVisible() {
  return chatState.sending && chatState.sendingKey === chatState.draftKey;
}

function syncChatProgressBanner() {
  const progressBanner = document.getElementById('chat-progress-banner');
  const progressText = document.getElementById('chat-progress-text');
  if (!progressBanner || !progressText) return;
  const showBanner = shouldShowChatProgressBanner({
    sendVisible: chatSendVisible(),
    streamingDraft: chatState.streamingDraft,
    progress: chatState.progress,
  });
  progressBanner.hidden = !showBanner;
  if (showBanner) {
    progressText.textContent = (chatState.progress && chatState.progress.message)
      || 'Searching your transcripts…';
  }
}

function getCurrentChatScope() {
  return (chatState.activeThread && chatState.activeThread.scope)
    || chatState.pendingScope
    || { type: 'all', meetingIds: [], dateFrom: null, dateTo: null, tags: [] };
}

function getMeetingsMapById() {
  const map = new Map();
  for (const m of Array.isArray(meetings) ? meetings : []) {
    if (m && m.id != null) {
      map.set(String(m.id), m);
    }
  }
  return map;
}

function autoResizeChatInput() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(160, Math.max(24, input.scrollHeight))}px`;
}

function renderChatModelPill() {
  const pill = document.getElementById('chat-model-pill');
  const label = document.getElementById('chat-model-pill-label');
  const unloadBtn = document.getElementById('chat-unload-model-btn');
  if (!pill || !label || !unloadBtn) return;

  const view = buildModelMemoryPillView(chatState.modelState);
  pill.dataset.state = view.status;
  label.textContent = view.label;
  unloadBtn.hidden = !view.showUnload;
  unloadBtn.disabled = view.busy;
}

function renderChatOnboardingAndComposer() {
  const onboarding = document.getElementById('chat-onboarding-card');
  const reasonEl = document.getElementById('chat-onboarding-reason');
  const sendBtn = document.getElementById('chat-send-btn');
  const input = document.getElementById('chat-input');
  const headerTitle = document.getElementById('chat-thread-title');
  const headerScope = document.getElementById('chat-header-scope');
  const scopeLabel = document.getElementById('chat-scope-btn-label');

  renderChatModelChoice();
  const library = summaryLibrary();
  const selectedModelId = (chatState.activeThread ? chatState.activeThread.modelId : chatState.pendingModelId) || library?.defaultModelId;
  const resettingRemovedOverride = Boolean(
    library
    && chatState.resettingRemovedModelThreadId
    && chatState.activeThread?.id === chatState.resettingRemovedModelThreadId
    && usableSummaryModels(library).some((model) => model.modelId === library.defaultModelId),
  );
  const eligible = library
    ? (resettingRemovedOverride || usableSummaryModels(library).some((model) => model.modelId === selectedModelId))
    : (!chatState.eligibility || chatState.eligibility.eligible !== false);
  if (onboarding) {
    onboarding.hidden = eligible;
  }
  if (reasonEl) {
    const selected = library?.models?.find((model) => model.modelId === selectedModelId);
    const reason = selected?.error || selected?.fit?.reason || chatState.eligibility?.reason || 'Choose an available model in Settings.';
    reasonEl.textContent = `${reason} Keyword search in History still works anytime.`;
  }

  const scopeText = formatChatScopeLabel(
    getCurrentChatScope(),
    getMeetingsMapById(),
    (slug) => getTagMeta(slug)?.label || slug,
  );
  if (headerTitle) {
    headerTitle.textContent = chatState.activeThread ? chatState.activeThread.title : 'Ask your recordings';
  }
  if (headerScope) {
    headerScope.textContent = scopeText;
  }
  if (scopeLabel) {
    scopeLabel.textContent = scopeText;
  }

  if (sendBtn) {
    if (chatState.sending) {
      sendBtn.textContent = 'Stop';
      sendBtn.classList.remove('btn-primary');
      sendBtn.classList.add('btn-danger');
      sendBtn.disabled = false;
    } else {
      sendBtn.textContent = 'Send';
      sendBtn.classList.remove('btn-danger');
      sendBtn.classList.add('btn-primary');
      sendBtn.disabled = !eligible || resettingRemovedOverride || chatThreadDetailPending();
    }
  }
  if (input) {
    input.disabled = false;
  }
}

function renderChatThreadSidebar() {
  const container = document.getElementById('chat-thread-list');
  if (!container) return;
  clearElement(container);

  const filtered = filterChatThreads(chatState.threads, chatState.threadFilter);
  if (filtered.length === 0) {
    setPlaceholder(
      container,
      chatState.threads.length === 0 ? 'No conversations yet' : 'No matching conversations',
    );
    return;
  }

  const meetingsById = getMeetingsMapById();
  const groups = groupThreadsByRecency(filtered);
  for (const group of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'chat-thread-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'chat-thread-group-label';
    labelEl.textContent = group.label;
    groupEl.appendChild(labelEl);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'chat-thread-group-items';

    for (const thread of group.threads) {
      const row = document.createElement('div');
      row.className = 'chat-thread-item';
      row.setAttribute('role', 'listitem');
      if (chatState.activeThread && chatState.activeThread.id === thread.id) {
        row.classList.add('is-active');
      }

      if (chatState.editingThreadId === thread.id) {
        const form = document.createElement('form');
        form.className = 'chat-thread-rename-form';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'chat-thread-rename-input';
        input.maxLength = 120;
        input.value = thread.title || '';
        input.setAttribute('aria-label', 'Rename chat thread');

        let cancelled = false;
        let submitted = false;
        const commitRename = async () => {
          if (cancelled || submitted) return;
          const nextTitle = input.value.trim();
          chatState.editingThreadId = null;
          if (!nextTitle || nextTitle === thread.title) {
            renderChatThreadSidebar();
            return;
          }
          submitted = true;
          try {
            const navigation = chatState.navigation;
            await window.electronAPI.renameChatThread(thread.id, nextTitle);
            await refreshChatThreadList({ selectThreadId: navigation === chatState.navigation && chatState.activeThread?.id === thread.id ? thread.id : null });
          } catch (error) {
            showAppToast(`Could not rename chat: ${error.message}`, 'error');
            renderChatThreadSidebar();
          }
        };

        form.addEventListener('submit', (e) => {
          e.preventDefault();
          void commitRename();
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelled = true;
            chatState.editingThreadId = null;
            renderChatThreadSidebar();
          }
        });
        input.addEventListener('blur', () => {
          void commitRename();
        });

        form.appendChild(input);
        row.appendChild(form);
        itemsWrap.appendChild(row);
        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
        continue;
      }

      const selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'chat-thread-select-btn';
      selectBtn.addEventListener('click', () => {
        void selectChatThread(thread.id);
      });

      const titleEl = document.createElement('span');
      titleEl.className = 'chat-thread-item-title';
      titleEl.textContent = thread.title || 'New chat';

      const scopeEl = document.createElement('span');
      scopeEl.className = 'chat-thread-item-scope';
      scopeEl.textContent = formatChatScopeLabel(
        thread.scope,
        meetingsById,
        (slug) => getTagMeta(slug)?.label || slug,
      );

      selectBtn.append(titleEl, scopeEl);

      const actions = document.createElement('div');
      actions.className = 'chat-thread-item-actions';

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'chat-thread-action-btn';
      renameBtn.title = 'Rename chat';
      renameBtn.setAttribute('aria-label', `Rename ${thread.title || 'chat'}`);
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        chatState.editingThreadId = thread.id;
        renderChatThreadSidebar();
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'chat-thread-action-btn is-danger';
      delBtn.title = 'Delete chat';
      delBtn.setAttribute('aria-label', `Delete ${thread.title || 'chat'}`);
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void deleteChatThreadWithConfirm(thread.id, thread.title);
      });

      actions.append(renameBtn, delBtn);
      row.append(selectBtn, actions);
      itemsWrap.appendChild(row);
    }

    groupEl.appendChild(itemsWrap);
    container.appendChild(groupEl);
  }
}

function handleChatCitationClick(citation) {
  if (!citation || !citation.meetingId) {
    return;
  }
  void openMeetingAtTimestamp(citation.meetingId, citation.startSec);
}

function renderChatStream() {
  const emptyState = document.getElementById('chat-empty-state');
  const starterGrid = document.getElementById('chat-starter-prompts');
  const messagesEl = document.getElementById('chat-messages');
  const scrollContainer = document.getElementById('chat-stream-scroll');
  if (!messagesEl) return;

  clearElement(messagesEl);

  const threadMessages = chatState.activeThread && Array.isArray(chatState.activeThread.messages)
    ? chatState.activeThread.messages
    : [];
  const hasMessages = threadMessages.length > 0 || Boolean(chatSendVisible() && chatState.optimisticQuestion);

  if (emptyState) {
    emptyState.hidden = hasMessages;
  }

  if (!hasMessages && starterGrid) {
    clearElement(starterGrid);
    const eligible = !chatState.eligibility || chatState.eligibility.eligible !== false;
    const prompts = buildStarterPrompts(meetings, getCurrentChatScope());
    for (const promptText of prompts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-starter-btn';
      btn.textContent = promptText;
      btn.disabled = !eligible || meetings.length === 0 || chatThreadDetailPending();
      btn.addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        if (!input) return;
        input.value = promptText;
        autoResizeChatInput();
        void sendCurrentChatQuestion();
      });
      starterGrid.appendChild(btn);
    }
  }

  const renderUserTurn = (text) => {
    const wrap = document.createElement('div');
    wrap.className = 'chat-turn-user';
    const bubble = document.createElement('div');
    bubble.className = 'chat-user-bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
  };

  const findPrecedingUserQuestion = (idx) => {
    for (let j = idx - 1; j >= 0; j -= 1) {
      if (threadMessages[j]?.role === 'user' && threadMessages[j]?.content) {
        return String(threadMessages[j].content);
      }
    }
    return '';
  };

  const handleNoticeAction = async (actionId, precedingQuestion) => {
    if (!precedingQuestion || chatState.sending || chatState.noticeActionPending || chatThreadDetailPending()) {
      return;
    }
    if (chatState.popoverOpen) {
      toggleChatScopePopover(false);
    }
    const navigation = chatState.navigation;
    const nextScope = resolveNoticeActionScope(actionId, getCurrentChatScope());
    if (nextScope) {
      if (chatState.activeThread && window.electronAPI?.updateChatThreadScope) {
        let updated = false;
        chatState.noticeActionPending = true;
        renderChatStream();
        try {
          const res = await window.electronAPI.updateChatThreadScope(chatState.activeThread.id, nextScope);
          if (navigation !== chatState.navigation) {
            void refreshChatThreadList();
            return;
          }
          if (res && res.thread) {
            chatState.activeThread = res.thread;
          }
          updated = true;
        } catch (error) {
          if (navigation === chatState.navigation) {
            showAppToast(`Could not update scope: ${error.message}`, 'error');
          }
        } finally {
          chatState.noticeActionPending = false;
        }
        if (!updated) {
          if (navigation === chatState.navigation) {
            renderChatStream();
          }
          return;
        }
      } else {
        chatState.pendingScope = nextScope;
      }
    }
    if (navigation !== chatState.navigation) {
      return;
    }
    await sendChatQuestionText(precedingQuestion, { overrideScope: nextScope });
  };

  for (let msgIdx = 0; msgIdx < threadMessages.length; msgIdx += 1) {
    const msg = threadMessages[msgIdx];
    if (msg.role === 'user') {
      renderUserTurn(msg.content);
      continue;
    }

    const wrap = document.createElement('article');
    wrap.className = 'chat-turn-assistant';

    const notice = buildAssistantNoticeView(msg, getCurrentChatScope());
    if (notice) {
      const callout = document.createElement('div');
      callout.className = `chat-status-callout is-${notice.variant}`;

      const titleEl = document.createElement('p');
      titleEl.className = 'chat-callout-title';
      titleEl.textContent = notice.title;
      callout.appendChild(titleEl);

      if (notice.detail) {
        const detailEl = document.createElement('p');
        detailEl.className = 'chat-callout-detail';
        detailEl.textContent = notice.detail;
        callout.appendChild(detailEl);
      }

      const precedingQuestion = findPrecedingUserQuestion(msgIdx);
      if (precedingQuestion && Array.isArray(notice.actions) && notice.actions.length > 0) {
        const actionsRow = document.createElement('div');
        actionsRow.className = 'chat-callout-actions';
        for (const action of notice.actions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn btn-small btn-secondary chat-callout-action-btn';
          btn.textContent = action.label;
          btn.disabled = chatState.sending || chatState.noticeActionPending || chatThreadDetailPending();
          btn.addEventListener('click', () => {
            void handleNoticeAction(action.id, precedingQuestion);
          });
          actionsRow.appendChild(btn);
        }
        callout.appendChild(actionsRow);
      }

      wrap.appendChild(callout);
    } else {
      const prose = document.createElement('div');
      prose.className = 'chat-markdown';
      renderGroundedMarkdown(prose, msg.content || '', msg.citations || [], {
        markedLib: window.marked,
        domPurifyLib: window.DOMPurify,
        documentObj: document,
        onCitationClick: handleChatCitationClick,
      });
      wrap.appendChild(prose);
    }

    if (msg.modelId || msg.modelName) {
      const provenance = document.createElement('p'); provenance.className = 'setting-description';
      provenance.textContent = `Model: ${msg.modelName || summaryModelName(msg.modelId)}`; wrap.appendChild(provenance);
    }
    const citations = Array.isArray(msg.citations) ? msg.citations : [];
    const inspectedSources = citations.length === 0
      && notice?.showInspectedSources
      && Array.isArray(msg.inspectedSources)
      ? msg.inspectedSources
      : [];
    const drawerSources = citations.length > 0 ? citations : inspectedSources;
    if (drawerSources.length > 0) {
      const details = document.createElement('details');
      details.className = 'chat-sources-drawer';

      const summary = document.createElement('summary');
      summary.textContent = citations.length > 0
        ? `Sources (${citations.length})`
        : `Sources inspected (${inspectedSources.length})`;
      details.appendChild(summary);

      const list = document.createElement('div');
      list.className = 'chat-sources-list';
      for (const citation of drawerSources) {
        const item = document.createElement('div');
        item.className = 'chat-source-item';

        const head = document.createElement('div');
        head.className = 'chat-source-item-head';

        const jumpPill = document.createElement('button');
        jumpPill.type = 'button';
        jumpPill.className = 'chat-citation-pill';
        const tsLabel = formatJumpTimestamp(citation.startSec);
        jumpPill.textContent = tsLabel
          ? `${citation.meetingTitle || 'Recording'} · ${tsLabel}`
          : (citation.meetingTitle || 'Recording');
        jumpPill.addEventListener('click', () => handleChatCitationClick(citation));
        head.appendChild(jumpPill);

        const metaSpan = document.createElement('span');
        metaSpan.className = 'chat-turn-meta-row';
        if (citation.tag) {
          const tagMeta = getTagMeta(citation.tag);
          const tagChip = document.createElement('span');
          tagChip.className = 'chat-source-tag-chip';
          if (tagMeta) {
            tagChip.dataset.tag = tagMeta.slug;
          }
          tagChip.textContent = tagMeta ? tagMeta.label : citation.tag;
          metaSpan.appendChild(tagChip);
        }
        const parts = [];
        if (citation.speaker) parts.push(citation.speaker);
        if (citation.meetingDate) parts.push(formatDate(citation.meetingDate));
        if (parts.length > 0) {
          metaSpan.appendChild(document.createTextNode(parts.join(' · ')));
        }
        head.appendChild(metaSpan);

        const excerpt = document.createElement('p');
        excerpt.className = 'chat-source-excerpt';
        excerpt.textContent = citation.excerpt || '';

        item.append(head, excerpt);
        list.appendChild(item);
      }
      details.appendChild(list);
      wrap.appendChild(details);
    }

    if (Number.isFinite(msg.searchedMeetingCount) && msg.searchedMeetingCount > 0) {
      const meta = document.createElement('div');
      meta.className = 'chat-turn-meta-row';
      meta.textContent = `Searched ${msg.searchedMeetingCount} recording${msg.searchedMeetingCount === 1 ? '' : 's'} · ${msg.evidenceCount || 0} matching excerpt${(msg.evidenceCount || 0) === 1 ? '' : 's'}`;
      wrap.appendChild(meta);
    }

    messagesEl.appendChild(wrap);
  }

  if (chatSendVisible() && chatState.optimisticQuestion) {
    renderUserTurn(chatState.optimisticQuestion);
    if (chatState.streamingDraft) {
      const streamWrap = document.createElement('article');
      streamWrap.className = 'chat-turn-assistant is-streaming';
      const streamBody = document.createElement('div');
      streamBody.id = 'chat-streaming-draft-body';
      streamBody.className = 'chat-markdown';
      renderGroundedMarkdown(streamBody, chatState.streamingDraft, [], {
        markedLib: window.marked,
        domPurifyLib: window.DOMPurify,
        documentObj: document,
      });
      streamWrap.appendChild(streamBody);
      messagesEl.appendChild(streamWrap);
    }
  }

  syncChatProgressBanner();

  if (scrollContainer && hasMessages) {
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
  }
}

async function refreshChatThreadList({ selectThreadId = null } = {}) {
  if (!window.electronAPI || typeof window.electronAPI.listChatThreads !== 'function') return;
  const navigation = chatState.navigation;
  const request = ++chatState.listRequest;
  const res = await window.electronAPI.listChatThreads();
  if (request !== chatState.listRequest) return;
  chatState.threads = Array.isArray(res && res.threads) ? res.threads : [];
  renderChatThreadSidebar();
  if (navigation !== chatState.navigation) return;
  const targetId = selectThreadId || chatState.activeThread?.id;
  if (targetId && chatState.threads.some((t) => t.id === targetId)) {
    const detail = await window.electronAPI.getChatThread(targetId);
    if (navigation !== chatState.navigation || request !== chatState.listRequest) return;
    chatState.activeThread = detail && detail.thread ? detail.thread : null;
  } else if (chatState.activeThread && !chatState.threads.some((t) => t.id === chatState.activeThread.id)) {
    chatState.activeThread = null;
  }
  renderChatThreadSidebar();
  renderChatOnboardingAndComposer();
  renderChatStream();
}

async function selectChatThread(threadId) {
  const navigation = ++chatState.navigation;
  switchChatDraft(threadId ? `thread:${threadId}` : `new:${++chatState.nextDraft}`);
  chatState.activeThread = null;
  renderChatThreadSidebar();
  renderChatOnboardingAndComposer();
  renderChatStream();
  if (!threadId) return;
  try {
    const res = await window.electronAPI.getChatThread(threadId);
    if (navigation !== chatState.navigation) return;
    chatState.activeThread = res && res.thread ? res.thread : null;
    closeChatMobileSidebar();
    renderChatThreadSidebar();
    renderChatOnboardingAndComposer();
    renderChatStream();
  } catch (error) {
    if (navigation === chatState.navigation) showAppToast(`Could not load chat: ${error.message}`, 'error');
  }
}

async function startNewChatThread(scope = null) {
  ++chatState.navigation;
  const wasNew = chatState.draftKey.startsWith('new:');
  if (wasNew) chatState.newDraftKey = `new:${++chatState.nextDraft}`;
  switchChatDraft(chatState.newDraftKey);
  chatState.activeThread = null;
  if (scope && typeof scope === 'object') {
    chatState.pendingScope = {
      type: scope.type === 'selected_meetings' ? 'selected_meetings' : 'all',
      meetingIds: Array.isArray(scope.meetingIds) ? [...scope.meetingIds] : [],
      dateFrom: scope.dateFrom || null,
      dateTo: scope.dateTo || null,
      tags: Array.isArray(scope.tags) ? [...scope.tags] : [],
    };
  }
  closeChatMobileSidebar();
  renderChatThreadSidebar();
  renderChatOnboardingAndComposer();
  renderChatStream();
  document.getElementById('chat-input')?.focus();
}

async function deleteChatThreadWithConfirm(threadId, title) {
  if (!confirm(`Delete "${title || 'New chat'}"? This cannot be undone.`)) return;
  try {
    await window.electronAPI.deleteChatThread(threadId);
    if (chatState.draftKey === `thread:${threadId}`) {
      await startNewChatThread();
    }
    chatState.drafts.delete(`thread:${threadId}`);
    await refreshChatThreadList();
  } catch (error) {
    showAppToast(`Could not delete chat: ${error.message}`, 'error');
  }
}

function renderScopePopover() {
  const allBtn = document.getElementById('chat-scope-all-btn');
  const selBtn = document.getElementById('chat-scope-selected-btn');
  const selPanel = document.getElementById('chat-scope-selected-panel');
  const listEl = document.getElementById('chat-scope-meetings-list');
  const tagsRow = document.getElementById('chat-scope-tags-row');
  const tagsToggleBtn = document.getElementById('chat-scope-tags-toggle-btn');
  const fromEl = document.getElementById('chat-scope-date-from');
  const toEl = document.getElementById('chat-scope-date-to');
  const draft = chatState.scopeDraft || getCurrentChatScope();

  if (allBtn) allBtn.classList.toggle('is-selected', draft.type !== 'selected_meetings');
  if (selBtn) selBtn.classList.toggle('is-selected', draft.type === 'selected_meetings');
  if (selPanel) selPanel.hidden = draft.type !== 'selected_meetings';
  if (fromEl) fromEl.value = draft.dateFrom ? String(draft.dateFrom).slice(0, 10) : '';
  if (toEl) toEl.value = draft.dateTo ? String(draft.dateTo).slice(0, 10) : '';

  if (tagsRow) {
    clearElement(tagsRow);
    const usedEntries = getUsedRecordingTags(meetings);
    const usedSlugs = new Set(usedEntries.map((entry) => entry.slug));
    const selectedTags = new Set(
      (Array.isArray(draft.tags) ? draft.tags : [])
        .map((t) => normalizeTag(t))
        .filter(Boolean),
    );
    const showAll = usedEntries.length === 0 || chatState.showAllScopeTags;
    const entriesToShow = showAll
      ? RECORDING_TAGS
      : RECORDING_TAGS.filter((entry) => usedSlugs.has(entry.slug) || selectedTags.has(entry.slug));

    if (tagsToggleBtn) {
      tagsToggleBtn.hidden = usedEntries.length === 0 || usedEntries.length >= RECORDING_TAGS.length;
      tagsToggleBtn.textContent = chatState.showAllScopeTags ? 'Used tags' : 'All 11 types';
    }

    for (const entry of entriesToShow) {
      const selected = selectedTags.has(entry.slug);
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chat-scope-tag-pill';
      pill.dataset.tag = entry.slug;
      pill.setAttribute('aria-pressed', String(selected));
      if (selected) {
        pill.classList.add('is-selected');
      }

      const dot = document.createElement('span');
      dot.className = 'recording-tag-dot';
      dot.setAttribute('aria-hidden', 'true');
      pill.appendChild(dot);
      pill.appendChild(document.createTextNode(entry.shortLabel || entry.label));

      pill.addEventListener('click', () => {
        if (!chatState.scopeDraft) {
          chatState.scopeDraft = {
            type: draft.type === 'selected_meetings' ? 'selected_meetings' : 'all',
            meetingIds: Array.isArray(draft.meetingIds) ? [...draft.meetingIds] : [],
            dateFrom: draft.dateFrom || null,
            dateTo: draft.dateTo || null,
            tags: [...selectedTags],
          };
        }
        const nextSet = new Set(
          (Array.isArray(chatState.scopeDraft.tags) ? chatState.scopeDraft.tags : [])
            .map((t) => normalizeTag(t))
            .filter(Boolean),
        );
        if (nextSet.has(entry.slug)) {
          nextSet.delete(entry.slug);
        } else {
          nextSet.add(entry.slug);
        }
        chatState.scopeDraft.tags = [...nextSet];
        renderScopePopover();
      });

      tagsRow.appendChild(pill);
    }
  }

  if (listEl) {
    clearElement(listEl);
    const filterTerm = chatState.scopeFilter.trim().toLowerCase();
    const visible = filterTerm
      ? meetings.filter((m) => String(m.title || '').toLowerCase().includes(filterTerm))
      : meetings;
    if (!visible.length) {
      setPlaceholder(listEl, 'No matching recordings');
    } else {
      const selectedSet = new Set(Array.isArray(draft.meetingIds) ? draft.meetingIds.map(String) : []);
      for (const m of visible) {
        const label = document.createElement('label');
        label.className = 'chat-scope-meeting-option';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedSet.has(String(m.id));
        cb.addEventListener('change', () => {
          const nextIds = new Set(Array.isArray(chatState.scopeDraft.meetingIds) ? chatState.scopeDraft.meetingIds : []);
          if (cb.checked) nextIds.add(String(m.id));
          else nextIds.delete(String(m.id));
          chatState.scopeDraft.meetingIds = [...nextIds];
        });
        const span = document.createElement('span');
        span.className = 'chat-scope-meeting-title';
        span.textContent = m.title || 'Untitled recording';
        label.append(cb, span);
        listEl.appendChild(label);
      }
    }
  }
}

function toggleChatScopePopover(forceOpen = null) {
  const popover = document.getElementById('chat-scope-popover');
  const btn = document.getElementById('chat-scope-btn');
  if (!popover || !btn) return;
  const open = forceOpen !== null ? forceOpen : !chatState.popoverOpen;
  chatState.popoverOpen = open;
  popover.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  if (open) {
    const cur = getCurrentChatScope();
    chatState.showAllScopeTags = false;
    chatState.scopeDraft = {
      type: cur.type === 'selected_meetings' ? 'selected_meetings' : 'all',
      meetingIds: Array.isArray(cur.meetingIds) ? [...cur.meetingIds] : [],
      dateFrom: cur.dateFrom || null,
      dateTo: cur.dateTo || null,
      tags: Array.isArray(cur.tags) ? [...cur.tags] : [],
    };
    renderScopePopover();
  }
}

function closeChatMobileSidebar() {
  document.getElementById('chat-tab')?.classList.remove('is-sidebar-drawer-open');
}

async function sendChatQuestionText(rawQuestion, { overrideScope = null, restoreInputOnError = false } = {}) {
  if (chatState.sending || chatState.noticeActionPending || chatThreadDetailPending()) {
    return;
  }
  const question = String(rawQuestion || '').replace(/\s+/g, ' ').trim();
  if (!question) {
    return;
  }

  const input = document.getElementById('chat-input');
  const navigation = chatState.navigation;
  const originKey = chatState.draftKey;
  const originThreadId = chatState.activeThread?.id || null;
  const library = summaryLibrary();
  const newThreadOverride = chatState.activeThread ? null : chatState.pendingModelId;
  const effectiveModelId = (chatState.activeThread ? chatState.activeThread.modelId : newThreadOverride) || library?.defaultModelId;
  if (library ? !usableSummaryModels(library).some((model) => model.modelId === effectiveModelId) : (chatState.eligibility && chatState.eligibility.eligible === false)) {
    if (restoreInputOnError && input) {
      const currentDraft = chatState.draftKey === originKey ? input.value : (chatState.drafts.get(originKey) || '');
      const restored = currentDraft ? `${question}\n${currentDraft}` : question;
      chatState.drafts.set(originKey, restored);
      if (chatState.draftKey === originKey) {
        input.value = restored;
        if (typeof autoResizeChatInput === 'function') autoResizeChatInput();
      }
    }
    openSettingsAtAiAddons();
    return;
  }

  const scope = overrideScope || getCurrentChatScope();
  chatState.sending = true;
  chatState.sendingKey = originKey;
  chatState.optimisticQuestion = question;
  chatState.streamingDraft = '';
  chatState.progress = { phase: 'retrieving', message: 'Searching your transcripts…' };
  renderChatOnboardingAndComposer();
  renderChatStream();

  try {
    const res = await window.electronAPI.askHistory({
      threadId: originThreadId,
      question,
      scope,
      ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
      ...(!originThreadId && newThreadOverride ? { threadModelId: newThreadOverride } : {}),
    });
    if (res && res.thread) {
      const threadKey = `thread:${res.thread.id}`;
      if (originKey !== threadKey) {
        const draft = chatState.draftKey === originKey && input ? input.value : chatState.drafts.get(originKey);
        if (draft) chatState.drafts.set(threadKey, draft);
        if (chatState.draftKey === originKey) chatState.draftKey = threadKey;
        if (chatState.newDraftKey === originKey) chatState.newDraftKey = `new:${++chatState.nextDraft}`;
      }
      if (navigation === chatState.navigation) { chatState.activeThread = res.thread; chatState.pendingModelId = null; }
    }
    chatState.optimisticQuestion = null;
    chatState.streamingDraft = '';
    try {
      await refreshChatThreadList();
    } catch (error) {
      showAppToast(`Could not refresh chats: ${error.message}`, 'error');
    }
  } catch (error) {
    chatState.optimisticQuestion = null;
    chatState.streamingDraft = '';
    if (restoreInputOnError && input) {
      const currentDraft = chatState.draftKey === originKey ? input.value : (chatState.drafts.get(originKey) || '');
      const restored = currentDraft ? `${question}\n${currentDraft}` : question;
      chatState.drafts.set(originKey, restored);
      if (chatState.draftKey === originKey) {
        input.value = restored;
        autoResizeChatInput();
      }
    }
    const isCancelled = error && (error.code === 'HISTORY_QA_CANCELLED' || /stopped|canceled/i.test(error.message || ''));
    showAppToast(isCancelled ? 'Response generation stopped.' : (error?.message || 'Could not generate local answer.'), isCancelled ? 'info' : 'error');
  } finally {
    chatState.sending = false;
    chatState.sendingKey = null;
    chatState.streamingDraft = '';
    chatState.progress = null;
    renderChatOnboardingAndComposer();
    renderChatStream();
    if (navigation === chatState.navigation && input) input.focus();
  }
}

async function sendCurrentChatQuestion() {
  if (chatState.sending) {
    try {
      await window.electronAPI.cancelHistoryQa();
    } catch (_error) {
      // Ignore cancel errors.
    }
    return;
  }

  if (chatThreadDetailPending()) return;
  const input = document.getElementById('chat-input');
  if (!input) return;
  const question = input.value.replace(/\s+/g, ' ').trim();
  if (!question) {
    return;
  }

  const originKey = chatState.draftKey;
  input.value = '';
  chatState.drafts.set(originKey, '');
  autoResizeChatInput();
  await sendChatQuestionText(question, { restoreInputOnError: true });
}

async function openHistoryMeetingInChat(meetingId) {
  const targetId = String(meetingId || '').trim();
  if (!targetId) return;
  const meeting = meetings.find((m) => String(m.id) === targetId);
  const scope = { type: 'selected_meetings', meetingIds: [targetId], dateFrom: null, dateTo: null, tags: [] };

  activateTab('chat');
  const navigation = ++chatState.navigation;
  await initChatTab();
  if (navigation !== chatState.navigation) return;

  // Reuse an empty thread already scoped solely to this meeting if present, else create one.
  const reusable = chatState.threads.find((t) => (
    t.messageCount === 0
    && t.scope?.type === 'selected_meetings'
    && Array.isArray(t.scope.meetingIds)
    && t.scope.meetingIds.length === 1
    && String(t.scope.meetingIds[0]) === targetId
    && (!Array.isArray(t.scope?.tags) || t.scope.tags.length === 0)
  ));

  if (reusable) {
    await selectChatThread(reusable.id);
  } else if (window.electronAPI && typeof window.electronAPI.createChatThread === 'function') {
    const title = meeting?.title ? `Ask: ${meeting.title.slice(0, 60)}` : 'New chat';
    const created = await window.electronAPI.createChatThread({ title, scope });
    if (navigation !== chatState.navigation) { void refreshChatThreadList(); return; }
    if (created && created.thread) {
      switchChatDraft(`thread:${created.thread.id}`);
      chatState.activeThread = created.thread;
      await refreshChatThreadList({ selectThreadId: created.thread.id });
    }
  } else {
    await startNewChatThread(scope);
  }
  document.getElementById('chat-input')?.focus();
}

async function initChatTab() {
  if (!window.electronAPI || typeof window.electronAPI.getHistoryQaEligibility !== 'function') {
    return;
  }
  try {
    if (typeof summaryLibrary === 'function' && !summaryLibrary() && typeof refreshHomeAiAddonPrompt === 'function') {
      await refreshHomeAiAddonPrompt();
    }
    const [elig, mState] = await Promise.all([
      window.electronAPI.getHistoryQaEligibility(),
      window.electronAPI.getHistoryQaModelState(),
    ]);
    chatState.eligibility = elig;
    if (mState) {
      chatState.modelState = mState;
    }
  } catch (error) {
    console.warn('Could not refresh Chat eligibility/model state:', error);
  }
  renderChatModelPill();
  await refreshChatThreadList({
    selectThreadId: chatState.activeThread ? chatState.activeThread.id : undefined,
  });
}

function setupChatWorkspace() {
  if (chatState.listenersBound) {
    return;
  }
  chatState.listenersBound = true;

  if (window.electronAPI && typeof window.electronAPI.onHistoryQaModelState === 'function') {
    registerCleanup(window.electronAPI.onHistoryQaModelState((state) => {
      if (state) {
        chatState.modelState = state;
        renderChatModelPill();
        renderSummaryModelLibrary(summaryLibrary());
        if (chatState.sending && state.status === 'unloading') {
          chatState.progress = { phase: 'releasing', message: `Releasing ${state.modelName || 'model'}…` };
          syncChatProgressBanner();
        }
      }
    }));
  }

  if (window.electronAPI && typeof window.electronAPI.onHistoryQaProgress === 'function') {
    registerCleanup(window.electronAPI.onHistoryQaProgress((progress) => {
      if (!progress || !chatState.sending) {
        return;
      }
      if (progress.threadId && chatState.activeThread?.id && progress.threadId !== chatState.activeThread.id) {
        return;
      }
      const selectedId = (chatState.activeThread ? chatState.activeThread.modelId : chatState.pendingModelId) || summaryLibrary()?.defaultModelId;
      chatState.progress = progress.phase === 'loading_model'
        ? { ...progress, message: `Loading ${summaryModelName(selectedId)}…` }
        : progress.phase === 'queued' ? { ...progress, message: 'Waiting for current work…' } : progress;
      if (typeof progress.draftMarkdown === 'string' && progress.draftMarkdown) {
        const hadDraft = Boolean(chatState.streamingDraft);
        chatState.streamingDraft = progress.draftMarkdown;
        if (!chatSendVisible()) {
          return;
        }
        if (!hadDraft) {
          renderChatStream();
        } else {
          const draftEl = document.getElementById('chat-streaming-draft-body');
          if (draftEl) {
            renderGroundedMarkdown(draftEl, chatState.streamingDraft, [], {
              markedLib: window.marked,
              domPurifyLib: window.DOMPurify,
              documentObj: document,
            });
            syncChatProgressBanner();
            const scrollContainer = document.getElementById('chat-stream-scroll');
            if (scrollContainer) {
              scrollContainer.scrollTop = scrollContainer.scrollHeight;
            }
          } else {
            renderChatStream();
          }
        }
      } else if (chatSendVisible()) {
        syncChatProgressBanner();
      }
    }));
  }

  document.getElementById('chat-new-thread-btn')?.addEventListener('click', () => {
    void startNewChatThread({ type: 'all', meetingIds: [], dateFrom: null, dateTo: null, tags: [] });
  });

  document.getElementById('chat-sidebar-toggle')?.addEventListener('click', () => {
    const tab = document.getElementById('chat-tab');
    if (!tab) return;
    if (window.innerWidth <= 900) {
      tab.classList.remove('is-sidebar-drawer-open');
    } else {
      tab.classList.toggle('is-sidebar-collapsed', true);
    }
  });

  document.getElementById('chat-sidebar-open-btn')?.addEventListener('click', () => {
    const tab = document.getElementById('chat-tab');
    if (!tab) return;
    if (window.innerWidth <= 900) {
      tab.classList.toggle('is-sidebar-drawer-open');
    } else {
      tab.classList.remove('is-sidebar-collapsed');
    }
  });

  document.getElementById('chat-thread-search')?.addEventListener('input', (e) => {
    chatState.threadFilter = e.target.value || '';
    renderChatThreadSidebar();
  });

  document.getElementById('chat-unload-model-btn')?.addEventListener('click', async () => {
    try {
      const res = await window.electronAPI.unloadHistoryQaModel();
      if (res && res.modelState) {
        chatState.modelState = res.modelState;
      }
      renderChatModelPill();
      showAppToast('Local model unloaded from memory.', 'success');
    } catch (error) {
      showAppToast(`Could not unload model: ${error.message}`, 'error');
    }
  });

  document.getElementById('chat-open-ai-settings-btn')?.addEventListener('click', () => {
    openSettingsAtAiAddons();
  });

  document.getElementById('ask-meeting-in-chat-btn')?.addEventListener('click', () => {
    if (currentMeetingId) {
      void openHistoryMeetingInChat(currentMeetingId);
    }
  });

  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('input', autoResizeChatInput);
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        void sendCurrentChatQuestion();
      }
    });
  }

  document.getElementById('chat-send-btn')?.addEventListener('click', () => {
    void sendCurrentChatQuestion();
  });

  document.getElementById('chat-scope-btn')?.addEventListener('click', () => {
    toggleChatScopePopover();
  });

  document.getElementById('chat-scope-all-btn')?.addEventListener('click', () => {
    if (!chatState.scopeDraft) return;
    chatState.scopeDraft.type = 'all';
    chatState.scopeDraft.meetingIds = [];
    renderScopePopover();
  });

  document.getElementById('chat-scope-selected-btn')?.addEventListener('click', () => {
    if (!chatState.scopeDraft) return;
    chatState.scopeDraft.type = 'selected_meetings';
    renderScopePopover();
  });

  document.getElementById('chat-scope-meeting-filter')?.addEventListener('input', (e) => {
    chatState.scopeFilter = e.target.value || '';
    renderScopePopover();
  });

  for (const [id, field] of [['chat-scope-date-from', 'dateFrom'], ['chat-scope-date-to', 'dateTo']]) {
    const input = document.getElementById(id);
    const syncDraft = () => { if (chatState.scopeDraft) chatState.scopeDraft[field] = input.value || null; };
    input?.addEventListener('input', syncDraft);
    input?.addEventListener('change', syncDraft);
  }

  document.getElementById('chat-scope-tags-toggle-btn')?.addEventListener('click', () => {
    chatState.showAllScopeTags = !chatState.showAllScopeTags;
    renderScopePopover();
  });

  document.getElementById('chat-scope-clear-btn')?.addEventListener('click', () => {
    chatState.scopeDraft = { type: 'all', meetingIds: [], dateFrom: null, dateTo: null, tags: [] };
    chatState.scopeFilter = '';
    chatState.showAllScopeTags = false;
    const filterEl = document.getElementById('chat-scope-meeting-filter');
    if (filterEl) filterEl.value = '';
    renderScopePopover();
  });

  document.getElementById('chat-scope-apply-btn')?.addEventListener('click', async () => {
    const fromVal = document.getElementById('chat-scope-date-from')?.value || null;
    const toVal = document.getElementById('chat-scope-date-to')?.value || null;
    const nextScope = {
      type: chatState.scopeDraft?.type === 'selected_meetings' ? 'selected_meetings' : 'all',
      meetingIds: Array.isArray(chatState.scopeDraft?.meetingIds) ? [...chatState.scopeDraft.meetingIds] : [],
      dateFrom: fromVal || null,
      dateTo: toVal || null,
      tags: Array.isArray(chatState.scopeDraft?.tags) ? [...chatState.scopeDraft.tags] : [],
    };
    if (chatState.activeThread && window.electronAPI?.updateChatThreadScope) {
      try {
        const navigation = chatState.navigation;
        const res = await window.electronAPI.updateChatThreadScope(chatState.activeThread.id, nextScope);
        if (navigation !== chatState.navigation) { void refreshChatThreadList(); return; }
        if (res && res.thread) {
          chatState.activeThread = res.thread;
        }
        await refreshChatThreadList({ selectThreadId: chatState.activeThread?.id || null });
      } catch (error) {
        showAppToast(`Could not update scope: ${error.message}`, 'error');
      }
    } else {
      chatState.pendingScope = nextScope;
      renderChatOnboardingAndComposer();
      renderChatStream();
    }
    toggleChatScopePopover(false);
  });

  document.addEventListener('pointerdown', (e) => {
    if (!chatState.popoverOpen) return;
    const popover = document.getElementById('chat-scope-popover');
    const btn = document.getElementById('chat-scope-btn');
    if (popover?.contains(e.target) || btn?.contains(e.target)) {
      return;
    }
    toggleChatScopePopover(false);
  });
}

setupChatWorkspace();
