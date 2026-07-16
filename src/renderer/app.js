/**
 * Renderer process - UI logic for AvaNevis (Redesigned)
 */

const COPY_SUCCESS_TIMEOUT_MS = 2000;
const DEFAULT_SUMMARY_PROFILE = 'balanced';
const MAX_PROGRESS_LOG_ENTRIES = 250;
const AI_ADDON_PROGRESS_LOG_INTERVAL_MS = 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const {
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
  shouldApplyTranscriptionQueueState,
  buildCompletionToastView,
  buildBackgroundTranscriptionTipView,
  buildSoftQueueDepthWarningView,
  resolveActivityRenameCommit,
} = window.transcriptionActivityHelpers;
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
  getDiarizationSetupMessage,
  getSummaryGenerationButtonView,
  getSummarySetupMessage,
  normalizeHistoryDetailTab,
  parseTranscriptMarkdownSegments,
} = window.historyDetailHelpers;
const {
  hideUpdateNotificationBanner,
  replayPendingUpdateNotification,
  showUpdateNotificationBanner,
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
} = window.summaryUiHelpers;
const {
  isAiAddonProgressPhase,
  isAiAddonTerminalStatus,
} = window.aiAddonUiHelpers;
const { clearElement } = window.domHelpers;
const { meetingIdsEqual } = window.meetingHelpers;
const { isGpuRuntimeActionBusyError, formatGpuRuntimeBusyAlertMessage } = window.gpuSettingsHelpers;
const { roundedBar } = window.canvasHelpers;

// UI Elements
const micSelect = document.getElementById('mic-select');
const desktopSelect = document.getElementById('desktop-select');
const languageSelect = document.getElementById('language-select');
const modelSelect = document.getElementById('model-select');
const refreshBtn = document.getElementById('refresh-devices');
const recordBtn = document.getElementById('record-btn');
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
// Tracks the meeting saved from the most recent recording (post-transcription).
// Powers the in-place rename on the post-recording transcript card and the
// default filename used by the "Save" button.
let currentRecordingMeeting = null;
let currentRecordingTranscriptMarkdown = '';
let pendingMeetingTranscriptId = null;
let summaryGenerationMeetingId = null;
let summaryGenerationCancelling = false;
let activeHistoryDetailTab = 'transcript';
let homePromptContext = { platform: null, hasNvidiaGpu: false, cudaInstalled: false };
let startupCudaCheckPromise = null;
let meetings = [];
let audioVisualizer = null;
let isFirstRecording = true; // Track if this is first recording (for longer timeout)
let isInitializing = true; // Track if app is still initializing
const checkedMeetingIds = new Set();
let meetingSearchQuery = '';
let meetingSearchQueryNormalized = '';
let meetingSearchDebounceTimer = null;
const MEETING_SEARCH_DEBOUNCE_MS = 200;
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

async function restoreCurrentHistorySummary(meetingId) {
  if (!meetingId || !meetingIdsEqual(currentMeetingId, meetingId)) {
    return false;
  }

  try {
    const fullMeeting = await window.electronAPI.getMeeting(meetingId);
    if (fullMeeting && fullMeeting.summary) {
      renderSummaryMarkdown(fullMeeting.summary, { stale: fullMeeting.summaryStale });
      return true;
    }
  } catch (error) {
    console.warn(`Could not restore saved summary: ${error.message}`);
  }

  return false;
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
    option.textContent = `${device.name} (${device.sample_rate} Hz)`;
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
  button.setAttribute('aria-label', 'Delete meeting');

  button.appendChild(createDeleteIcon());

  return button;
}

function createMeetingCheckbox(meetingId) {
  const box = document.createElement('div');
  box.className = 'meeting-checkbox';
  box.setAttribute('role', 'checkbox');
  box.setAttribute('aria-checked', 'false');
  box.setAttribute('tabindex', '0');
  box.title = 'Select meeting';
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

  const info = document.createElement('div');
  info.className = 'meeting-info';

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

  if (meeting && meeting.transcriptionStatus && meeting.transcriptionStatus !== 'completed') {
    const statusTag = document.createElement('span');
    statusTag.className = 'meeting-item-duration';
    statusTag.textContent = meeting.transcriptionStatus === 'failed' ? 'Transcription failed' : 'Awaiting transcription';
    metaRow.append(date, duration, statusTag);
  } else {
    metaRow.append(date, duration);
  }
  info.append(title, metaRow);

  const deleteBtn = createDeleteButton();

  item.append(checkbox, info, deleteBtn);

  item.addEventListener('click', (e) => {
    if (e.target.closest('.delete-btn-list')) return;
    if (e.target.closest('.meeting-checkbox')) return;
    selectMeeting(meeting.id);
  });

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
  clearElement(activityListEl);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'placeholder';
    empty.id = 'activity-empty';
    empty.textContent = getActivityEmptyStateText();
    activityListEl.appendChild(empty);
    updateResumePendingBanner();
    refreshIdleStatusPill();
    updateSoftQueueDepthWarning();
    updateBackgroundTranscriptionTip();
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

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'activity-rename-input';
      input.value = activityRenameDraft;
      input.maxLength = 120;
      input.setAttribute('aria-label', 'Meeting title');
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
    const selector = `.activity-row[data-meeting-id="${CSS.escape(id)}"] .activity-rename-input`;
    const input = activityListEl && activityListEl.querySelector(selector);
    if (input) {
      input.focus();
      input.select();
    }
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
      throw new Error('Meeting was not found.');
    }
    activityRenameMeetingId = null;
    activityRenameDraft = '';
    activityRenameOriginal = '';
    applyMeetingTitleLocally(updated);
    addLog(`Renamed meeting to "${updated.title}"`);
  } catch (error) {
    addLog(`Failed to rename meeting: ${error.message}`, 'error');
    alert(`Failed to rename meeting: ${error.message}`);
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
  toastEl.textContent = view.message;
  toastEl.hidden = false;
  toastEl.classList.add('is-visible');
  clearTimeout(showCompletionToast._timer);
  showCompletionToast._timer = setTimeout(() => {
    toastEl.classList.remove('is-visible');
    toastEl.hidden = true;
  }, 4500);
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
  void selectMeeting(meetingId);
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
    const resultPromise = window.electronAPI.retryTranscription({
      meetingId: id,
      language: languageSelect.value,
      modelSize: modelSelect.value,
    });
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
    await loadMeetingHistory();
  } catch (error) {
    addLog(`Resume failed: ${error.message}`, 'error');
  } finally {
    updateResumePendingBanner();
  }
}

function setMeetingAudioSource(audioPath) {
  const audioPlayer = document.getElementById('audio-player');
  audioPlayer.src = window.electronAPI.buildFileUrl(audioPath);
  audioPlayer.load();
  // Reset custom player UI when a new source loads
  if (typeof window.__resetCustomAudioPlayer === 'function') {
    window.__resetCustomAudioPlayer();
  }
}

function renderHistoryTranscriptMarkdown(transcriptEl, markdown) {
  transcriptEl.classList.remove('markdown-body');
  clearElement(transcriptEl);

  const segments = parseTranscriptMarkdownSegments(markdown);
  if (!segments.length) {
    transcriptEl.classList.add('markdown-body');
    renderMarkdownInto(transcriptEl, markdown);
    return;
  }

  segments.forEach((segment) => {
    const segmentDiv = document.createElement('div');
    segmentDiv.className = 'history-transcript-segment';

    const meta = document.createElement('div');
    meta.className = 'history-transcript-meta';

    const timestamp = document.createElement('span');
    timestamp.className = 'history-transcript-timestamp';
    timestamp.textContent = `[${segment.start} - ${segment.end}]`;
    meta.appendChild(timestamp);

    if (segment.speaker) {
      const speaker = document.createElement('span');
      speaker.className = 'history-transcript-speaker';
      speaker.textContent = segment.speaker;
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

  button.textContent = button.dataset.originalLabel || button.textContent || 'Generate Summary';
  button.disabled = false;
  button.classList.remove('is-loading', 'summary-generation-active', 'is-cancelling');
  delete button.dataset.originalLabel;
  delete button.dataset.hoverLabel;
  button.removeAttribute('aria-busy');
  button.removeAttribute('title');
}

function updateSummaryGenerationButtons() {
  const view = getSummaryGenerationButtonView({
    active: Boolean(summaryGenerationMeetingId),
    cancelling: summaryGenerationCancelling,
  });

  for (const button of getSummaryGenerationButtons()) {
    if (!view.active) {
      restoreSummaryGenerationButton(button);
      continue;
    }

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

async function cancelSummaryGeneration(meetingId) {
  if (!summaryGenerationMeetingId || summaryGenerationCancelling) {
    return;
  }

  summaryGenerationCancelling = true;
  updateSummaryGenerationButtons();
  addLog('Cancelling summary generation...');

  try {
    const result = await window.electronAPI.cancelSummaryGeneration({ meetingId: meetingId || summaryGenerationMeetingId });
    if (result && result.message && !result.canceled) {
      addLog(result.message, 'warning');
      summaryGenerationCancelling = false;
      updateSummaryGenerationButtons();
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
  const tabButtons = document.querySelectorAll('.tab-btn');
  const railButtons = document.querySelectorAll('.rail-btn[data-tab]');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const allNavButtons = [...tabButtons, ...railButtons];

  allNavButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === targetTab);
  });
  tabPanes.forEach((pane) => {
    pane.classList.toggle('active', pane.id === `${targetTab}-tab`);
  });

  if (targetTab === 'settings') {
    initSettingsTab().catch((error) => console.error('Failed to initialize settings tab:', error));
  }
}

function openSettingsAtAiAddons() {
  activateTab('settings');
  const section = document.getElementById('ai-addons-settings');
  if (section) {
    section.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}

function updateHomeAiAddonCTA(aiStatus) {
  const cta = document.getElementById('ai-addon-cta');
  if (!cta) {
    return;
  }

  const prompt = buildHomeAiAddonPrompt({
    aiStatus,
    platform: homePromptContext.platform,
    cudaInstalled: homePromptContext.cudaInstalled,
    hasNvidiaGpu: homePromptContext.hasNvidiaGpu,
  });

  if (!prompt) {
    cta.style.display = 'none';
    return;
  }

  const title = document.getElementById('ai-addon-cta-title');
  const sub = document.getElementById('ai-addon-cta-sub');
  if (title) title.textContent = prompt.title;
  if (sub) sub.textContent = prompt.message;
  cta.dataset.feature = prompt.feature;
  cta.style.display = 'flex';
}

function setupHomeAiAddonCTA() {
  const cta = document.getElementById('ai-addon-cta');
  if (!cta) return;
  cta.addEventListener('click', openSettingsAtAiAddons);
}

function closeInlineTitleEditor({ headingId, editBtnId, formId, editBtnDisplay = '' }) {
  const heading = document.getElementById(headingId);
  const editBtn = document.getElementById(editBtnId);
  const form = document.getElementById(formId);

  if (form) form.style.display = 'none';
  if (heading) heading.style.display = '';
  if (editBtn) editBtn.style.display = editBtnDisplay;
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

// Apply saved settings to UI controls
function applySavedSettings() {
  const settings = loadSettings();

  if (settings.micId && micSelect.querySelector(`option[value="${settings.micId}"]`)) {
    micSelect.value = settings.micId;
  }

  if (settings.desktopId && desktopSelect.querySelector(`option[value="${settings.desktopId}"]`)) {
    desktopSelect.value = settings.desktopId;
  }

  if (settings.language) {
    languageSelect.value = settings.language;
  }

  if (settings.modelSize) {
    modelSelect.value = settings.modelSize;
  }

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

  let hydratedCaptureState = false;
  const ensureRecordingHydration = async () => {
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
      await hydrateRecordingStateFromMain();
      await queryRecordingRecoveryState();
    } catch (hydrateError) {
      console.error('Failed to hydrate recording state:', hydrateError);
      hydratedCaptureState = false;
    }
  };

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
    const modelSize = settings.modelSize || 'small';

    addLog('Checking system setup...');
    const modelCheck = await window.electronAPI.checkModelDownloaded(modelSize);

    if (!modelCheck.downloaded) {
      // Hide loading screen before showing first-time setup
      if (loadingScreen) {
        loadingScreen.classList.add('hidden');
        setTimeout(() => loadingScreen.remove(), 300);
      }

      // First-time setup: Download model
      await showFirstTimeSetup(modelSize);
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

    if (recordingState === 'idle') {
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
  progressText.textContent = 'Downloading Whisper AI model...';

  const cancelBtn = document.getElementById('ftue-cancel-download-btn');
  let downloadCanceled = false;
  const onCancelClick = async () => {
    downloadCanceled = true;
    if (cancelBtn) {
      cancelBtn.disabled = true;
    }
    progressText.textContent = 'Canceling download...';
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
      progressText.textContent = 'Loading model configuration...';
    } else if (data.includes('Downloading')) {
      progressText.textContent = 'Downloading model files (this may take a few minutes)...';
    } else if (data.includes('Model loaded') || data.includes('successfully')) {
      progressText.textContent = 'Model ready!';
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
    progressText.textContent = 'Setup complete!';

    addLog('AI model downloaded successfully!');

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
    progressText.textContent = canceled ? 'Download canceled' : 'Setup failed!';
    logOutput.textContent += `\nERROR: ${error.message}`;

    addLog(
      canceled
        ? 'Model download was canceled. You can download it later from Settings.'
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

    // Check if no input devices found (likely permission issue on macOS)
    if (devices.inputs.length === 0) {
      const isMac = navigator.platform.includes('Mac');

      if (isMac) {
        addLog('⚠️ No microphone devices found - permission may not be granted', 'error');

        const shouldOpenSettings = confirm(
          'No microphone devices found!\n\n' +
          'This usually means microphone permission is not granted.\n\n' +
          'Would you like to open System Settings to grant permission?\n\n' +
          '1. Go to Privacy & Security → Microphone\n' +
          '2. Grant permission to AvaNevis\n' +
          '3. Restart the app'
        );

        if (shouldOpenSettings) {
          window.electronAPI.openSystemSettings('microphone');
        }
      } else {
        addLog('⚠️ No microphone devices found', 'error');
      }
    }

    // Populate microphone dropdown
    populateSelect(micSelect, 'Select microphone...', devices.inputs);

    // Populate desktop audio dropdown
    populateSelect(desktopSelect, 'Select desktop audio...', devices.loopbacks);

    addLog(`Found ${devices.inputs.length} microphones and ${devices.loopbacks.length} loopback devices`);

    // Apply saved settings after devices are loaded
    applySavedSettings();
  } catch (error) {
    console.error('Failed to load devices:', error);
    addLog(`Error: ${error.message}`, 'error');
  }
}

// Load meeting history
async function loadMeetingHistory({ scan = false } = {}) {
  try {
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

    // Load the meeting list
    meetings = await window.electronAPI.listMeetings();
    renderMeetingList();
    renderActivityList();
  } catch (error) {
    console.error('Failed to load meeting history:', error);
    meetings = [];
    renderMeetingList();
    renderActivityList();
  }
}

// Render meeting list
function renderMeetingList() {
  const query = meetingSearchQueryNormalized;
  const filtered = query
    ? meetings.filter((m) => (m.title || '').toLowerCase().includes(query))
    : meetings;

  if (filtered.length === 0) {
    setPlaceholder(
      meetingList,
      meetings.length === 0 ? 'No meetings recorded yet' : 'No matches for your search',
    );
    updateSelectionToolbar();
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
    ? 'Delete the selected meeting? This cannot be undone.'
    : `Delete ${ids.length} selected meetings? This cannot be undone.`;
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
  }

  meetings = meetings.filter((m) => !ids.includes(String(m.id)));
  checkedMeetingIds.clear();
  renderMeetingList();

  await loadMeetingHistory();

  if (failures.length === 0) {
    addLog(`Deleted ${ids.length} meeting${ids.length === 1 ? '' : 's'}.`);
  } else {
    addLog(
      `Deleted ${ids.length - failures.length} of ${ids.length} meetings (${failures.length} failed).`,
      'error',
    );
    alert(`Some meetings could not be deleted:\n\n${failures.map((f) => `- ${f.id}: ${f.message}`).join('\n')}`);
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

  document.querySelectorAll('.meeting-item').forEach((item) => {
    item.classList.toggle('selected', item.dataset.id === targetId);
  });

  currentMeetingId = targetId;
  pendingMeetingTranscriptId = targetId;

  // Show meeting details
  document.getElementById('meeting-title').textContent = meeting.title;
  document.getElementById('meeting-date').textContent = formatDate(meeting.date);
  document.getElementById('meeting-duration').textContent = meeting.duration;
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
  transcriptEl.classList.remove('markdown-body');
  delete transcriptEl.dataset.markdown;
  clearElement(transcriptEl);
  renderSummaryMarkdown('');
  if (retryBtn) {
    retryBtn.style.display = isMeetingTranscriptionRetryable(meeting) ? 'inline-flex' : 'none';
    retryBtn.disabled = false;
    retryBtn.textContent = 'Retry Transcription';
  }
  activateHistoryDetailTab(activeHistoryDetailTab);
  const loading = document.createElement('p');
  loading.className = 'placeholder';
  loading.textContent = 'Loading transcript...';
  transcriptEl.appendChild(loading);

  try {
    const fullMeeting = await window.electronAPI.getMeeting(targetId);

    if (!fullMeeting || currentMeetingId !== targetId || pendingMeetingTranscriptId !== targetId) {
      return;
    }

    if (fullMeeting.transcript) {
      transcriptEl.dataset.markdown = fullMeeting.transcript;
      renderHistoryTranscriptMarkdown(transcriptEl, fullMeeting.transcript);
    } else {
      delete transcriptEl.dataset.markdown;
      clearElement(transcriptEl);
      const empty = document.createElement('p');
      empty.className = 'placeholder';
      empty.textContent = 'No transcript available';
      transcriptEl.appendChild(empty);
    }
    renderMeetingDiarizationStatus(fullMeeting, transcriptEl);
    const transcriptionStatusMessage = getMeetingTranscriptionStatusMessage(fullMeeting);
    if (transcriptionStatusMessage) {
      const statusMessage = document.createElement('p');
      statusMessage.className = fullMeeting.transcriptionStatus === 'failed' ? 'placeholder error' : 'placeholder';
      statusMessage.textContent = transcriptionStatusMessage;
      transcriptEl.appendChild(statusMessage);
    }

    if (fullMeeting.summary) {
      renderSummaryMarkdown(fullMeeting.summary, { stale: fullMeeting.summaryStale });
    } else {
      showSummaryMessage('No summary yet. Generate one locally when the summary model is installed.');
    }
  } catch (error) {
    console.error(`Failed to load meeting transcript: ${error.message}`);
    if (currentMeetingId === targetId && pendingMeetingTranscriptId === targetId) {
      clearElement(transcriptEl);
      delete transcriptEl.dataset.markdown;
      const err = document.createElement('p');
      err.className = 'placeholder error';
      err.textContent = 'Failed to load transcript. The saved recording is still available above.';
      transcriptEl.appendChild(err);
      showSummaryMessage('Summary unavailable because the meeting details could not be loaded.', true);
    }
  } finally {
    if (pendingMeetingTranscriptId === targetId) {
      pendingMeetingTranscriptId = null;
    }
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

  const enterEditMode = () => {
    const meeting = getMeeting();
    if (!meeting) return;
    input.value = meeting.title || '';
    heading.style.display = 'none';
    editBtn.style.display = 'none';
    form.style.display = 'flex';
    // Defer focus + select to next tick so display change has applied
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  };

  const exitEditMode = () => {
    form.style.display = 'none';
    heading.style.display = '';
    // editBtn visibility is governed by the caller (e.g. post-recording hides
    // it until a meeting exists). We only restore it if the caller wanted it
    // visible — defer to applyCurrentRecordingTitle / selectMeeting to set it.
    editBtn.style.display = '';
  };

  editBtn.addEventListener('click', (e) => {
    e.preventDefault();
    enterEditMode();
  });

  cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    exitEditMode();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      exitEditMode();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
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
    try {
      const updated = await window.electronAPI.updateMeeting(meeting.id, { title: newTitle });
      if (!updated || !updated.title) {
        throw new Error('Meeting was not found.');
      }

      const activeMeeting = getMeeting();
      if (activeMeeting && String(activeMeeting.id) === editedMeetingId) {
        heading.textContent = updated.title;
      }
      if (typeof onSaved === 'function') onSaved(updated);
      addLog(`Renamed meeting to "${updated.title}"`);
    } catch (err) {
      console.error('Rename failed:', err);
      addLog(`Failed to rename meeting: ${err.message}`, 'error');
      alert(`Failed to rename meeting: ${err.message}`);
    } finally {
      const activeMeeting = getMeeting();
      if (activeMeeting && String(activeMeeting.id) === editedMeetingId) {
        exitEditMode();
      }
    }
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

  // Meeting search filter
  const searchInput = document.getElementById('meeting-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      meetingSearchQuery = searchInput.value || '';
      if (meetingSearchDebounceTimer) {
        clearTimeout(meetingSearchDebounceTimer);
      }
      meetingSearchDebounceTimer = setTimeout(() => {
        meetingSearchDebounceTimer = null;
        meetingSearchQueryNormalized = meetingSearchQuery.trim().toLowerCase();
        renderMeetingList();
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
    saveSettings({ language: languageSelect.value });
  });

  modelSelect.addEventListener('change', () => {
    saveSettings({ modelSize: modelSelect.value });
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
          if (status === 'ready') {
            showCompletionToast(job);
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

  registerCleanup(window.electronAPI.onUpdateAvailable((updateInfo) => {
    showUpdateNotification(updateInfo);
  }));

  if (typeof window.electronAPI.getPendingUpdateInfo === 'function') {
    replayPendingUpdateNotification({
      getPendingUpdateInfo: window.electronAPI.getPendingUpdateInfo,
      showUpdateNotification,
    }).catch((error) => console.warn('Could not replay pending update notification:', error));
  }

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
      startRecording();
      break;
    case 'stop':
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
      statusText.textContent = 'Recording...';
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
}

// Update other controls based on state
function updateControlsState() {
  const isBusy = recordingState !== 'idle' && recordingState !== 'initializing';

  micSelect.disabled = isBusy || isInitializing;
  desktopSelect.disabled = isBusy || isInitializing;
  languageSelect.disabled = isBusy || isInitializing;
  modelSelect.disabled = isBusy || isInitializing;
  refreshBtn.disabled = isBusy || isInitializing;
}

async function runRecordingPreflightChecks({ micId, desktopId }) {
  const report = await window.electronAPI.runRecordingPreflight({
    micId: parseInt(micId, 10),
    loopbackId: parseInt(desktopId, 10),
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
async function startRecording() {
  const micId = micSelect.value;
  const desktopId = desktopSelect.value;

  if (!micId) {
    alert('Please select a microphone');
    return;
  }

  if (!desktopId) {
    alert('Please select a desktop audio source');
    return;
  }

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
      setRecordingState('idle');
    }
  };

  try {
    const preflightPassed = await runRecordingPreflightChecks({ micId, desktopId });
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
        micId: parseInt(micId),
        loopbackId: parseInt(desktopId),
        isFirstRecording: isFirstRecording && attempt === 1 // Only use first-recording timeout on first attempt
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
      audioVisualizer.start();

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
          // Platform-specific permission instructions
          const isMac = navigator.platform.includes('Mac');

          if (isMac) {
            const shouldOpenSettings = confirm(
              'Recording failed. Permission might be missing.\n\n' +
              'Would you like to open System Settings to check permissions?\n\n' +
              'Check both Microphone and Screen Recording permissions.'
            );

            if (shouldOpenSettings) {
              // Open Screen Recording by default as it's the more common "silent fail"
              window.electronAPI.openSystemSettings('screen');
            }
          } else {
            alert(
              'Recording failed. Please check:\n\n' +
              '1. Microphone permissions are granted to this app\n' +
              '2. Selected devices are not in use by another application\n' +
              '3. Devices are properly connected\n\n' +
              '• Grant microphone permissions in Windows Settings\n' +
              '• Restart the application\n' +
              '• Try different audio devices'
            );
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
      await transcribeAudio();
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
    '# Meeting Transcription',
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
  message.textContent = `Speaker identification failed for this recording. ${diarization.error || 'The transcript was saved without speaker-guided chunks.'}`;
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

  let aiStatus;
  try {
    aiStatus = await window.electronAPI.getAiAddonStatus({ verifyChecksums: true });
  } catch (error) {
    addLog(`Summary setup status unavailable: ${error.message}`, 'error');
    summaryGenerationMeetingId = null;
    summaryGenerationCancelling = false;
    updateSummaryGenerationButtons();
    return;
  }

  const summaryStatus = aiStatus && aiStatus.features && aiStatus.features.summary;
  if (!summaryStatus || !summaryStatus.setupComplete || summaryStatus.status !== 'ready') {
    const message = getSummarySetupMessage(summaryStatus);
    addLog(message, summaryStatus && summaryStatus.status === 'unsupported' ? 'error' : 'warning');
    if (meetingIdsEqual(currentMeetingId, normalizedMeetingId)) {
      const restored = await restoreCurrentHistorySummary(normalizedMeetingId);
      if (!restored) {
        showSummaryMessage(message, summaryStatus && summaryStatus.status === 'error');
      }
      activateHistoryDetailTab('summary');
    }
    openSettingsAtAiAddons();
    summaryGenerationMeetingId = null;
    summaryGenerationCancelling = false;
    updateSummaryGenerationButtons();
    return;
  }

  if (meetingIdsEqual(currentMeetingId, normalizedMeetingId)) {
    showSummaryMessage('Generating local summary...');
  }

  try {
    addLog('Generating local summary...');
    const summaryProfileSelect = document.getElementById('summary-profile-select');
    const result = await window.electronAPI.generateSummary({
      meetingId: normalizedMeetingId,
      profile: (summaryProfileSelect && summaryProfileSelect.value) || summaryStatus.profile || DEFAULT_SUMMARY_PROFILE,
    });

    if (meetingIdsEqual(currentMeetingId, normalizedMeetingId)) {
      const fullMeeting = await window.electronAPI.getMeeting(normalizedMeetingId);
      renderSummaryMarkdown((fullMeeting && fullMeeting.summary) || '', { stale: fullMeeting && fullMeeting.summaryStale });
      syncMeetingInList((result && result.meeting) || fullMeeting);
      activateHistoryDetailTab('summary');
    } else if (currentRecordingMeeting && meetingIdsEqual(currentRecordingMeeting.id, normalizedMeetingId)) {
      syncMeetingInList(result && result.meeting);
      activateTab('history');
      await selectMeeting(normalizedMeetingId);
      activateHistoryDetailTab('summary');
    } else {
      syncMeetingInList(result && result.meeting);
    }

    addLog('Summary generated!');
  } catch (error) {
    console.error('Failed to generate summary:', error);
    const wasCancelled = error && (error.code === 'AI_ADDON_SETUP_CANCELLED' || error.name === 'AbortError' || /cancell?ed/i.test(error.message || ''));
    if (wasCancelled) {
      addLog('Summary generation cancelled. Transcript is unchanged.', 'warning');
      if (meetingIdsEqual(currentMeetingId, normalizedMeetingId)) {
        const restored = await restoreCurrentHistorySummary(normalizedMeetingId);
        if (!restored) {
          showSummaryMessage('Summary generation cancelled. Transcript is unchanged.');
        }
        activateHistoryDetailTab('summary');
      }
      return;
    }

    const message = `Summary generation failed. Transcript is unchanged. ${error.message}`;
    addLog(message, 'error');
    if (meetingIdsEqual(currentMeetingId, normalizedMeetingId)) {
      const restored = await restoreCurrentHistorySummary(normalizedMeetingId);
      if (!restored) {
        showSummaryMessage(message, true);
      }
      activateHistoryDetailTab('summary');
    }
  } finally {
    summaryGenerationMeetingId = null;
    summaryGenerationCancelling = false;
    updateSummaryGenerationButtons();
  }
}

// Enqueue transcription after stop. PR2: unlock Start as soon as pending persist
// succeeds; main owns the composite job and Activity is driven by queue-state.
async function transcribeAudio(options = {}) {
  const language = languageSelect.value;
  const modelSize = modelSelect.value;
  const stopErrorNote = typeof options.stopErrorNote === 'string' ? options.stopErrorNote : '';

  if (!currentAudioFile) {
    addLog('Error: No audio file to transcribe', 'error');
    setTranscriptMessage('No audio file available for transcription.', true);
    setRecordingState('idle');
    return;
  }

  try {
    addLog(`Saving recording and queuing transcription (${language}, ${modelSize})…`);
    addLog(`File: ${currentAudioFile}`);

    const result = await window.electronAPI.finalizeRecordingTranscription({
      audioPath: currentAudioFile,
      duration: currentRecordingDurationSeconds || 0,
      language,
      modelSize,
      transcriptionErrorNote: stopErrorNote,
    });

    if (result && result.success === false) {
      throw Object.assign(new Error(result.error || 'Could not save pending meeting.'), {
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
  }
}

async function retryMeetingTranscription() {
  if (!currentMeetingId) {
    addLog('Select a meeting first.', 'warning');
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
    const result = await window.electronAPI.retryTranscription({
      meetingId: currentMeetingId,
      language: languageSelect.value,
      modelSize: modelSelect.value,
    });
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
      retryBtn.textContent = 'Retry Transcription';
    }
  }
}

// Copy transcript to clipboard (legacy Home panel removed)
function copyTranscript() {
  addLog('Open the meeting in History to copy its transcript.', 'warning');
}

// Copy meeting transcript to clipboard
function copyMeetingTranscript() {
  const transcriptEl = document.getElementById('meeting-transcript');
  // Prefer the original markdown source so users get the .md they expect.
  const text = transcriptEl.dataset.markdown || transcriptEl.textContent;

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
  if (!currentMeetingId) {
    addLog('No meeting selected to save.', 'warning');
    return;
  }

  const meeting = findMeetingById(currentMeetingId);
  const suggestedName = `${(meeting && meeting.title) || 'Summary'} Summary`;
  let content = getCurrentSummaryMarkdown();

  if (!content) {
    try {
      const fullMeeting = await window.electronAPI.getMeeting(currentMeetingId);
      content = (fullMeeting && fullMeeting.summary) || '';
    } catch (err) {
      console.error('Failed to load summary for save:', err);
      addLog(`Failed to load summary: ${err.message}`, 'error');
      return;
    }
  }

  if (!content.trim()) {
    addLog('No summary available to save.', 'warning');
    return;
  }

  try {
    const result = await window.electronAPI.saveTranscriptAs({
      suggestedName,
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

// Save the currently selected history meeting's transcript via native dialog.
// Defaults the filename to the meeting's display label so renamed meetings
// save with the user-friendly name they chose.
async function saveMeetingTranscriptToFile() {
  if (!currentMeetingId) {
    addLog('No meeting selected to save.', 'warning');
    return;
  }

  const meeting = findMeetingById(currentMeetingId);
  const suggestedName = (meeting && meeting.title) || 'Transcript';
  const transcriptEl = document.getElementById('meeting-transcript');
  let content = (transcriptEl && transcriptEl.dataset.markdown) || '';

  if (!content) {
    try {
      const fullMeeting = await window.electronAPI.getMeeting(currentMeetingId);
      content = (fullMeeting && fullMeeting.transcript) || '';
    } catch (err) {
      console.error('Failed to load transcript for save:', err);
      addLog(`Failed to load transcript: ${err.message}`, 'error');
      return;
    }
  }

  if (!content.trim()) {
    addLog('Transcript is empty.', 'warning');
    return;
  }

  try {
    const result = await window.electronAPI.saveTranscriptAs({ suggestedName, content });
    if (result && !result.canceled && result.filePath) {
      addLog(`Transcript saved to ${result.filePath}`);
    }
  } catch (err) {
    console.error('Save failed:', err);
    addLog(`Failed to save transcript: ${err.message}`, 'error');
    alert(`Failed to save transcript: ${err.message}`);
  }
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

  if (currentRecordingMeeting && currentRecordingMeeting.id) {
    suggestedName = currentRecordingMeeting.title || suggestedName;
    if (!content) {
      try {
        const fullMeeting = await window.electronAPI.getMeeting(currentRecordingMeeting.id);
        if (fullMeeting && fullMeeting.transcript) {
          content = fullMeeting.transcript;
          currentRecordingTranscriptMarkdown = fullMeeting.transcript;
        }
      } catch (err) {
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

  try {
    const result = await window.electronAPI.saveTranscriptAs({
      suggestedName,
      content,
    });
    if (result && !result.canceled && result.filePath) {
      addLog(`Transcript saved to ${result.filePath}`);
    }
  } catch (err) {
    console.error('Save failed:', err);
    addLog(`Failed to save transcript: ${err.message}`, 'error');
    alert(`Failed to save transcript: ${err.message}`);
  }
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

  if (confirm(`Are you sure you want to delete "${displayTitle}"?`)) {
    try {
      // Release audio player file lock before deleting (Windows issue)
      const audioPlayer = document.getElementById('audio-player');
      if (audioPlayer.src) {
        audioPlayer.pause();
        audioPlayer.removeAttribute('src');
        audioPlayer.load();
      }

      addLog(`Deleting meeting: ${displayTitle}...`);

      // Small delay to ensure OS releases the file handle
      await new Promise(resolve => setTimeout(resolve, 300));

      await window.electronAPI.deleteMeeting(idToDelete);

      // Clear the view immediately
      if (meetingIdsEqual(currentMeetingId, idToDelete)) {
        meetingDetails.style.display = 'none';
        document.getElementById('meeting-details-empty').style.display = 'flex';
        currentMeetingId = null;
      }

      // Remove from local list immediately
      meetings = meetings.filter((m) => !meetingIdsEqual(m.id, idToDelete));
      renderMeetingList();
      await loadMeetingHistory();

      addLog('Meeting deleted successfully!');
    } catch (error) {
      console.error('Delete failed:', error);
      addLog(`Error: ${error.message}`, 'error');
      alert('Failed to delete meeting: ' + error.message);
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

async function hydrateRecordingStateFromMain() {
  if (!window.electronAPI?.getRecordingState) {
    return;
  }

  let mainState;
  try {
    mainState = await window.electronAPI.getRecordingState();
  } catch (error) {
    console.error('Failed to hydrate recording state from main:', error);
    return;
  }

  if (!mainState || mainState.state === 'idle') {
    return;
  }

  if (mainState.state === 'recording' && canHydratedRendererStopRecording(mainState)) {
    activeRecordingSessionId = mainState.sessionId;
    recordingStartTime = Number(mainState.startedAt) || Date.now();
    setRecordingState('recording');
    startTimer();
    if (audioVisualizer) {
      audioVisualizer.start();
    }
    addLog('Resumed an in-progress recording after window reload.');
    return;
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
    setRecordingState(mainState.state);
    startRecordingPresencePoll();
  }
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
      setRecordingState('recording');
      startTimer();
      if (audioVisualizer) {
        audioVisualizer.start();
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
      cancelling: false,
      percent: terminalPercent,
      message: progress.message || '',
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
      cancelling: false,
      percent: Math.max(0, Math.min(100, fallbackPercent || 0)),
      message: formatAiAddonProgressText(progress),
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
  if (diarization && diarization.status === 'unsupported') {
    renderFootprintRows(document.getElementById('diarization-footprint'), [
      { label: 'Platform', value: 'unsupported' },
      { label: 'Runtime', value: 'disabled' },
    ]);
    return;
  }

  const storage = diarization && diarization.storage;
  const estimatedDownload = storage && storage.estimatedDownloadBytes;
  const installed = storage && storage.installedBytes;
  const estimatedInstalled = storage && storage.estimatedInstalledBytes;
  const runtimeLabel = diarization && diarization.availability && diarization.availability.acceleration === 'mps'
    ? 'PyTorch Metal/MPS, isolated under user data'
    : 'PyTorch CUDA, isolated under user data';
  const downloadFallback = diarization && diarization.availability && diarization.availability.acceleration === 'mps'
    ? 'depends on PyTorch MPS wheels'
    : 'depends on PyTorch CUDA wheels';
  const downloadState = aiAddonDownloadState.diarization;
  renderFootprintRows(document.getElementById('diarization-footprint'), [
    { label: 'Download', value: estimatedDownload ? `up to ${formatBytes(estimatedDownload)}` : downloadFallback },
    { label: 'Progress', value: downloadState.active ? `${Math.round(downloadState.percent || 0)}%` : null },
    { label: 'Installed', value: installed ? formatBytes(installed) : (estimatedInstalled ? `about ${formatBytes(estimatedInstalled)}` : 'not installed') },
    { label: 'Runtime', value: runtimeLabel },
  ]);
}

function updateSummaryFootprint(summary) {
  const storage = summary && summary.storage;
  const estimatedModel = storage && storage.estimatedModelBytes;
  const estimatedRuntime = storage && storage.estimatedRuntimeBytes;
  const installed = storage && storage.installedBytes;
  const estimatedInstalled = storage && storage.estimatedInstalledBytes;
  const runtimeLabel = summary && summary.artifact && summary.artifact.acceleration === 'metal'
    ? 'llama.cpp Metal'
    : 'llama.cpp CUDA';
  const downloadState = aiAddonDownloadState.summary;
  renderFootprintRows(document.getElementById('summary-footprint'), [
    { label: 'Model', value: summary && summary.artifact && summary.artifact.label },
    { label: 'Model download', value: estimatedModel ? formatBytes(estimatedModel) : null },
    { label: 'Runtime download', value: estimatedRuntime ? formatBytes(estimatedRuntime) : null },
    { label: 'Progress', value: downloadState.active ? `${Math.round(downloadState.percent || 0)}%` : null },
    { label: 'Installed', value: installed ? formatBytes(installed) : (estimatedInstalled ? `about ${formatBytes(estimatedInstalled)}` : 'not installed') },
    { label: 'Runtime', value: runtimeLabel },
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
    'diarization-speaker-count',
    'setup-diarization-btn',
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
}

function applyAiAddonButtonState({ setupButton, validateButton, removeButton, controlState }) {
  const state = controlState || { canConfigure: false, canValidate: false, canRemove: false };
  if (setupButton) {
    setupButton.disabled = !state.canConfigure;
  }
  if (validateButton) {
    validateButton.disabled = !state.canValidate;
  }
  if (removeButton) {
    removeButton.disabled = !state.canRemove;
  }
}

function appendAiAddonLog(text) {
  const logDiv = document.getElementById('ai-addon-log');
  const logOutput = document.getElementById('ai-addon-log-output');
  if (!logDiv || !logOutput) {
    return;
  }

  logDiv.style.display = 'block';
  logOutput.textContent += `${text}\n`;
  const lines = logOutput.textContent.split('\n');
  if (lines.length > MAX_PROGRESS_LOG_ENTRIES) {
    logOutput.textContent = lines.slice(-MAX_PROGRESS_LOG_ENTRIES).join('\n');
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

function updateAiAddonSettings(status) {
  const diarization = status && status.features && status.features.diarization;
  const summary = status && status.features && status.features.summary;
  const diarizationUnsupported = diarization && diarization.status === 'unsupported';
  const hasActiveSetup = aiAddonDownloadState.diarization.active || aiAddonDownloadState.summary.active
    || (diarization && (diarization.status === 'downloading' || diarization.status === 'validating'))
    || (summary && (summary.status === 'downloading' || summary.status === 'validating'));
  const overallStatus = hasActiveSetup
    ? 'downloading'
    : ((diarization && diarization.status === 'ready') || (summary && summary.status === 'ready')
      ? 'ready'
      : ((diarization && diarization.status === 'error') || (summary && summary.status === 'error') ? 'error' : 'notConfigured'));

  setStatusBadge(document.getElementById('ai-addons-status-badge'), overallStatus);

  if (diarization) {
    setStatusBadge(document.getElementById('diarization-status-badge'), diarization.status);
    const diarizationControlState = buildAiAddonControlState({
      feature: diarization,
      type: 'diarization',
      setupActive: aiAddonDownloadState.diarization.active,
      unsupported: diarizationUnsupported,
    });
    const speakerCount = document.getElementById('diarization-speaker-count');
    if (speakerCount) {
      speakerCount.value = String(diarization.speakerCount || 'auto');
      speakerCount.disabled = !diarizationControlState.canConfigure;
    }

    const tokenInput = document.getElementById('diarization-token-input');
    if (tokenInput) {
      tokenInput.disabled = !diarizationControlState.canConfigure;
      tokenInput.placeholder = diarizationUnsupported ? 'Unavailable on this platform' : 'hf_...';
    }

    applyAiAddonButtonState({
      setupButton: document.getElementById('setup-diarization-btn'),
      validateButton: document.getElementById('validate-diarization-btn'),
      removeButton: document.getElementById('remove-diarization-btn'),
      controlState: diarizationControlState,
    });

    const statusText = document.getElementById('diarization-status-text');
    if (statusText) {
      statusText.textContent = getDiarizationSetupMessage(diarization);
    }
    if (!aiAddonDownloadState.diarization.active && isAiAddonTerminalStatus(diarization.status)) {
      setAiAddonProgressState('diarization', { active: false, cancelling: false });
    }
    updateDiarizationFootprint(diarization);
  }

  if (summary) {
    setStatusBadge(document.getElementById('summary-status-badge'), summary.status);
    const summaryControlState = buildAiAddonControlState({
      feature: summary,
      type: 'summary',
      setupActive: aiAddonDownloadState.summary.active,
    });
    const profileSelect = document.getElementById('summary-profile-select');
    if (profileSelect) {
      const savedProfile = loadSettings().summaryProfile;
      profileSelect.value = savedProfile || summary.profile || DEFAULT_SUMMARY_PROFILE;
      profileSelect.disabled = !summaryControlState.canConfigure;
    }

    applyAiAddonButtonState({
      setupButton: document.getElementById('setup-summary-btn'),
      validateButton: document.getElementById('validate-summary-btn'),
      removeButton: document.getElementById('remove-summary-btn'),
      controlState: summaryControlState,
    });

    const statusText = document.getElementById('summary-status-text');
    if (statusText) {
      statusText.textContent = getSummarySetupMessage(summary);
    }
    if (!aiAddonDownloadState.summary.active && isAiAddonTerminalStatus(summary.status)) {
      setAiAddonProgressState('summary', { active: false, cancelling: false });
    }
    updateSummaryFootprint(summary);
  }

  renderAiAddonProgress('diarization');
  renderAiAddonProgress('summary');

  updateAiAddonFootprintWarning(status);
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
      return status;
    } catch (error) {
      addLog(`Failed to check AI add-ons: ${error.message}`, 'error');
      setStatusBadge(document.getElementById('ai-addons-status-badge'), 'error');
      updateHomeAiAddonCTA(null);
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
    updateHomeAiAddonCTA(status);
    return status;
  } catch (error) {
    console.warn('Could not refresh home AI add-on prompt:', error);
    updateHomeAiAddonCTA(null);
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

function setupAiAddonSettingsListeners() {
  const setupDiarizationBtn = document.getElementById('setup-diarization-btn');
  const cancelDiarizationBtn = document.getElementById('cancel-diarization-btn');
  const validateDiarizationBtn = document.getElementById('validate-diarization-btn');
  const removeDiarizationBtn = document.getElementById('remove-diarization-btn');
  const setupSummaryBtn = document.getElementById('setup-summary-btn');
  const cancelSummaryBtn = document.getElementById('cancel-summary-btn');
  const validateSummaryBtn = document.getElementById('validate-summary-btn');
  const removeSummaryBtn = document.getElementById('remove-summary-btn');
  const summaryProfileSelect = document.getElementById('summary-profile-select');

  if (setupDiarizationBtn) {
    setupDiarizationBtn.addEventListener('click', () => withAiAddonSetupAction('diarization', setupDiarizationBtn, 'Setting up...', 'Speaker identification setup', async () => {
      const tokenInput = document.getElementById('diarization-token-input');
      const speakerCount = document.getElementById('diarization-speaker-count');
      const status = await window.electronAPI.setupDiarization({
        token: tokenInput ? tokenInput.value.trim() : '',
        speakerCount: speakerCount ? speakerCount.value : 'auto',
      });
      if (tokenInput) {
        tokenInput.value = '';
      }
      addLog('Speaker identification setup checked.');
      return status;
    }));
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
    validateDiarizationBtn.addEventListener('click', () => withAiAddonAction(validateDiarizationBtn, 'Validating...', async () => {
      const status = await window.electronAPI.validateDiarizationSetup();
      addLog('Speaker identification validation complete.');
      return status;
    }));
  }

  if (removeDiarizationBtn) {
    removeDiarizationBtn.addEventListener('click', () => {
      if (!confirm('Remove speaker identification setup and stored token?')) {
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
    setupSummaryBtn.addEventListener('click', () => withAiAddonSetupAction('summary', setupSummaryBtn, 'Installing...', 'Summary model setup', async () => {
      const status = await window.electronAPI.setupSummaryModel({
        profile: summaryProfileSelect ? summaryProfileSelect.value : DEFAULT_SUMMARY_PROFILE,
      });
      addLog('Summary model setup checked.');
      return status;
    }));
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
    validateSummaryBtn.addEventListener('click', () => withAiAddonAction(validateSummaryBtn, 'Validating...', async () => {
      const status = await window.electronAPI.validateSummaryModel({});
      addLog('Summary model validation complete.');
      return status;
    }));
  }

  if (removeSummaryBtn) {
    removeSummaryBtn.addEventListener('click', () => {
      if (!confirm('Remove the local summary model from this device?')) {
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

  setupAiAddonSettingsListeners();
  await refreshAiAddonSettings();

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
    installBtn.textContent = 'Install GPU Acceleration';
    installBtn.dataset.mode = 'install';
    installBtn.title = 'Install AvaNevis-compatible CUDA runtime libraries';
  };
  const setRepairInstallButton = () => {
    installBtn.textContent = 'Repair GPU Runtime (Recommended)';
    installBtn.dataset.mode = 'repair';
    installBtn.title = 'Reinstall AvaNevis-compatible CUDA runtime libraries';
  };
  resetInstallButton();

  statusBadge.textContent = 'Checking...';
  statusBadge.className = 'setting-badge';

  try {
    // Get platform info
    const platform = await window.electronAPI.getPlatform();
    ctaState.platform = platform;
    const isMac = platform === 'darwin';

    if (isMac) {
      // ============ macOS: Show Metal/MLX Status ============
      gpuDescription.textContent = 'GPU acceleration using Apple\'s Metal framework for Apple Silicon Macs. Provides 3-5x faster transcription.';
      
      // Check if Apple Silicon
      const arch = await window.electronAPI.getArch();
      const isAppleSilicon = arch === 'arm64';

      if (isAppleSilicon) {
        // Apple Silicon - Metal always available
        gpuLabel1.textContent = 'GPU:';
        gpuValue1.textContent = 'Apple Silicon (Metal GPU)';
        gpuValue1.className = 'info-value success';

        gpuLabel2.textContent = 'Framework:';
        gpuValue2.textContent = 'MLX (Metal acceleration)';
        gpuValue2.className = 'info-value success';

        gpuLabel3.textContent = 'Status:';
        gpuValue3.textContent = 'Enabled by default';
        gpuValue3.className = 'info-value success';
        if (gpuLabel4) gpuLabel4.textContent = 'Diagnostics:';
        if (gpuValue4) {
          gpuValue4.textContent = 'No CUDA runtime required on Apple Silicon (MLX/Metal).';
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
          gpuValue4.textContent = 'CUDA diagnostics are not applicable on Intel macOS.';
          gpuValue4.className = 'info-value';
        }
        if (gpuRow4) gpuRow4.style.display = 'flex';

        statusBadge.textContent = 'CPU Fallback';
        statusBadge.classList.add('disabled');
      }

      // Hide install/uninstall buttons on macOS (MLX is bundled)
      gpuActions.style.display = 'none';

    } else {
      // ============ Windows: Show CUDA Status ============
      gpuDescription.textContent = 'Enable faster-whisper GPU acceleration for 4-5x faster transcription. Installs only the CUDA runtime libraries needed by CTranslate2.';
      
      // Update labels for Windows
      gpuLabel1.textContent = 'GPU Detected:';
      gpuLabel2.textContent = 'CUDA Libraries:';
      gpuLabel3.textContent = 'Download Size:';
      if (gpuLabel4) gpuLabel4.textContent = 'Diagnostics:';

      // Check if GPU exists
      const gpuInfo = await window.electronAPI.checkGPU();
      ctaState.gpuInfo = gpuInfo;

      if (gpuInfo.hasGPU) {
        gpuValue1.textContent = gpuInfo.gpuName;
        gpuValue1.classList.add('success');
      } else {
        gpuValue1.textContent = 'No NVIDIA GPU detected';
        gpuValue1.classList.add('error');
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

      // Check CUDA installation
      const cudaInfo = await window.electronAPI.checkCUDA();
      ctaState.cudaInfo = cudaInfo;

      if (cudaInfo.installed) {
        gpuValue2.textContent = 'Installed and loadable';
        gpuValue2.classList.add('success');
        gpuValue3.textContent = 'Already installed';
        if (gpuValue4) {
          gpuValue4.textContent = 'CUDA runtime libraries are healthy and loadable.';
          gpuValue4.className = 'info-value success';
        }
        if (gpuRow4) gpuRow4.style.display = 'flex';
        statusBadge.textContent = 'Enabled';
        statusBadge.classList.add('enabled');
        installBtn.style.display = 'none';
        uninstallBtn.style.display = 'block';
        resetInstallButton();
      } else {
        const statusCode = String(cudaInfo.statusCode || '').trim();
        if (cudaInfo.repairRecommendedAfterQuit) {
          setRepairInstallButton();
          gpuValue2.textContent = 'Repair recommended (previous quit interrupted GPU setup)';
        } else if (statusCode === 'unsupportedRuntimeMajor') {
          setRepairInstallButton();
          const unsupportedProfiles = Array.isArray(cudaInfo.unsupportedDetectedProfiles)
            ? cudaInfo.unsupportedDetectedProfiles.filter(Boolean)
            : [];
          gpuValue2.textContent = unsupportedProfiles.length
            ? `Unsupported runtime detected (${unsupportedProfiles.join(', ')})`
            : 'Unsupported CUDA runtime detected';
        } else if (cudaInfo.deviceAvailable && cudaInfo.runtimeLoadable === false) {
          resetInstallButton();
          const missing = Array.isArray(cudaInfo.missingLibraries) && cudaInfo.missingLibraries.length
            ? `Missing: ${cudaInfo.missingLibraries.join(', ')}`
            : 'CUDA runtime libraries are not loadable';
          gpuValue2.textContent = missing;
        } else if (cudaInfo.deviceAvailable) {
          resetInstallButton();
          gpuValue2.textContent = 'CUDA runtime not ready';
        } else {
          resetInstallButton();
          gpuValue2.textContent = 'No CUDA device available';
        }
        gpuValue2.classList.add('warning');
        gpuValue3.textContent = cudaInfo.pythonSupportedForInstall === false && cudaInfo.pythonVersion
          ? `Requires Python 3.11 (current: ${cudaInfo.pythonVersion})`
          : '~1 GB';
        if (gpuValue4) {
          const diagnostics = [];
          if (cudaInfo.repairRecommendedAfterQuit) {
            diagnostics.push(cudaInfo.repairRecommendedReason
              || 'GPU runtime setup was interrupted by a previous quit. Repair before relying on CUDA.');
          }
          if (statusCode === 'unsupportedRuntimeMajor') {
            const unsupportedProfiles = Array.isArray(cudaInfo.unsupportedDetectedProfiles)
              ? cudaInfo.unsupportedDetectedProfiles.filter(Boolean)
              : [];
            diagnostics.push(
              unsupportedProfiles.length
                ? `Detected newer CUDA runtime (${unsupportedProfiles.join(', ')}), but packaged transcription currently supports ${Array.isArray(cudaInfo.supportedProfiles) ? cudaInfo.supportedProfiles.join(', ') : 'cuda12'}.`
                : 'Detected CUDA runtime is newer than the packaged transcription stack currently supports.',
            );
          }
          if (cudaInfo.deviceAvailable === false) {
            diagnostics.push('CUDA device not available to CTranslate2.');
          }
          if (Array.isArray(cudaInfo.missingLibraries) && cudaInfo.missingLibraries.length > 0) {
            diagnostics.push(`Missing runtime DLLs: ${cudaInfo.missingLibraries.join(', ')}`);
          }
          if (cudaInfo.error) {
            diagnostics.push(`Probe error: ${String(cudaInfo.error).replace(/\s+/g, ' ').trim().slice(0, 180)}`);
          }
          gpuValue4.textContent = diagnostics.length
            ? diagnostics.join(' ')
            : 'CUDA runtime is not ready. Reinstall CUDA libraries from this page.';
          gpuValue4.className = 'info-value warning';
        }
        if (gpuRow4) gpuRow4.style.display = 'flex';
        statusBadge.textContent = 'Available';
        statusBadge.classList.add('disabled');
        installBtn.disabled = cudaInfo.pythonSupportedForInstall === false;
        installBtn.style.display = 'block';
        uninstallBtn.style.display = 'none';
      }

      gpuActions.style.display = 'block';
    }
  } catch (error) {
    console.error('Failed to check GPU status:', error);
    statusBadge.textContent = 'Error';
    statusBadge.classList.add('disabled');
    gpuDescription.textContent = 'Failed to detect system configuration.';
  } finally {
    updateGPUCTA(ctaState);
    updateCudaRuntimeWarning(ctaState);
    homePromptContext = {
      platform: ctaState.platform,
      hasNvidiaGpu: Boolean(ctaState.gpuInfo && ctaState.gpuInfo.hasGPU),
      cudaInstalled: Boolean(ctaState.cudaInfo && ctaState.cudaInfo.installed),
    };
    updateHomeAiAddonCTA(aiAddonStatusSnapshot);
  }
}

// Show or hide the "Install CUDA" CTA on the Record (home) tab.
// Only shown on Windows when an NVIDIA GPU is present and CUDA is not installed.
function updateGPUCTA({ platform, gpuInfo, cudaInfo }) {
  const cta = document.getElementById('gpu-cta');
  if (!cta) return;

  if (platform !== 'win32' || !gpuInfo || !gpuInfo.hasGPU || !cudaInfo || cudaInfo.installed) {
    cta.style.display = 'none';
    return;
  }

  const sub = cta.querySelector('.gpu-cta-sub');
  const title = cta.querySelector('strong');
  const statusCode = String((cudaInfo && cudaInfo.statusCode) || '').trim();
  if (statusCode === 'unsupportedRuntimeMajor') {
    if (title) {
      title.textContent = 'Repair GPU runtime compatibility';
    }
    if (sub) {
      sub.textContent = `${gpuInfo.gpuName || 'NVIDIA GPU'} detected - keep newer CUDA for other apps and add AvaNevis-compatible runtime libs`;
    }
    cta.style.display = 'flex';
    return;
  }
  if (title) {
    title.textContent = 'Install CUDA for faster transcription';
  }
  if (sub && gpuInfo.gpuName) {
    sub.textContent = `${gpuInfo.gpuName} detected - enable 4-5x faster transcription`;
  }
  cta.style.display = 'flex';
}

function updateCudaRuntimeWarning({ platform, gpuInfo, cudaInfo }) {
  const warning = document.getElementById('cuda-runtime-warning');
  const warningSub = document.getElementById('cuda-runtime-warning-sub');
  if (!warning || !warningSub) {
    return;
  }

  const hasBrokenRuntime = platform === 'win32'
    && gpuInfo
    && gpuInfo.hasGPU
    && cudaInfo
    && (
      cudaInfo.repairRecommendedAfterQuit === true
      || (cudaInfo.deviceAvailable && cudaInfo.runtimeLoadable === false)
    );

  if (!hasBrokenRuntime) {
    warning.style.display = 'none';
    return;
  }

  const missing = Array.isArray(cudaInfo.missingLibraries) ? cudaInfo.missingLibraries.filter(Boolean) : [];
  const statusCode = String(cudaInfo.statusCode || '').trim();
  if (cudaInfo.repairRecommendedAfterQuit) {
    warningSub.textContent = cudaInfo.repairRecommendedReason
      || 'GPU runtime setup was interrupted by a previous quit. Repair GPU compatibility in Settings before relying on CUDA transcription.';
  } else if (statusCode === 'unsupportedRuntimeMajor') {
    const unsupportedProfiles = Array.isArray(cudaInfo.unsupportedDetectedProfiles)
      ? cudaInfo.unsupportedDetectedProfiles.filter(Boolean)
      : [];
    warningSub.textContent = unsupportedProfiles.length
      ? `Detected ${unsupportedProfiles.join(', ')} runtime libraries, but this AvaNevis build currently supports ${Array.isArray(cudaInfo.supportedProfiles) ? cudaInfo.supportedProfiles.join(', ') : 'cuda12'}. Transcription will fall back to CPU until supported GPU runtime libraries are installed.`
      : 'Detected a newer CUDA runtime than this AvaNevis build currently supports. Transcription will fall back to CPU until supported GPU runtime libraries are installed.';
  } else {
    warningSub.textContent = missing.length
      ? `Missing CUDA runtime libraries: ${missing.join(', ')}. Transcription will automatically fall back to CPU until CUDA is fixed.`
      : 'CUDA runtime libraries are not loadable. Transcription will automatically fall back to CPU until CUDA is fixed.';
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
      ? 'This will repair AvaNevis GPU compatibility by adding the app-supported CUDA runtime libraries (about 1GB).\n\n'
      : 'This will download and install about 1GB of CUDA runtime libraries for faster transcription.\n\n') +
    'This does not remove newer CUDA runtime libraries used by other applications.\n\n' +
    'Speaker identification uses its own managed PyTorch CUDA setup only if you explicitly enable it.\n\n' +
    'The download may take 10-30 minutes depending on your internet speed.\n\n' +
    'Continue?'
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
  const confirmed = confirm(
    'This will remove AvaNevis-installed GPU runtime libraries used for transcription acceleration.\n\n' +
    'It does not remove newer system CUDA runtimes used by other applications.\n\n' +
    'AvaNevis transcription will fall back to CPU mode.\n\n' +
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
// Update Notification
// ============================================================================

let currentUpdateInfo = null;

function showUpdateNotification(updateInfo) {
  currentUpdateInfo = showUpdateNotificationBanner({
    banner: document.getElementById('update-banner'),
    title: document.getElementById('update-title'),
    description: document.getElementById('update-description'),
    downloadBtn: document.getElementById('download-update'),
    dismissBtn: document.getElementById('dismiss-update'),
    updateInfo,
    onDownload: handleDownloadUpdate,
    onDismiss: handleDismissUpdate,
    addLog,
  });
}

async function handleDownloadUpdate() {
  if (!currentUpdateInfo) return;

  try {
    addLog('Opening download page...');
    await window.electronAPI.downloadUpdate();
    addLog('Download started in your browser. Install when ready!');

    // Keep banner visible so user remembers to install
  } catch (error) {
    console.error('Failed to open download:', error);
    addLog('Failed to open download page', 'error');
  }
}

function handleDismissUpdate() {
  hideUpdateNotificationBanner({
    banner: document.getElementById('update-banner'),
    addLog,
  });
  currentUpdateInfo = null;
}

// ============================================================================
// Audio Visualizer Class — dramatic, interpolated, dual-channel
// ============================================================================

class AudioVisualizer {
  constructor() {
    this.container = document.getElementById('audio-visualizer');
    this.micCanvas = document.getElementById('mic-waveform');
    this.desktopCanvas = document.getElementById('desktop-waveform');

    this.micCtx = this.micCanvas.getContext('2d');
    this.desktopCtx = this.desktopCanvas.getContext('2d');

    // History buffers — current displayed values (smoothly interpolated)
    this.bufferSize = 96;
    this.micBuffer = new Array(this.bufferSize).fill(0);
    this.desktopBuffer = new Array(this.bufferSize).fill(0);

    // Per-channel "current incoming sample" target. Each draw frame the
    // newest column lerps toward this target so the wave keeps moving even
    // between the recorder's 5 Hz updates.
    this.micTarget = 0;
    this.desktopTarget = 0;

    // Peak-hold values (decay over time)
    this.micPeaks = new Array(this.bufferSize).fill(0);
    this.desktopPeaks = new Array(this.bufferSize).fill(0);

    // Sample-arrival metering — decides when to "shift" a new column in.
    // The recorder emits at ~5 Hz (every 200ms); we shift at that cadence.
    this.lastShiftTime = 0;
    this.shiftIntervalMs = 80; // visual shift cadence — denser than recorder for fluidity

    this.rafId = null;
    this.fallbackIntervalId = null;
    this.isRunning = false;

    this.lastUpdateTime = 0;
    this.warningShown = false;
    this._lastDrawnMicTarget = null;
    this._lastDrawnDesktopTarget = null;
    this._visibilityHandler = null;

    // For subtle ambient motion when input is near-silent
    this.phase = 0;
  }

  _setupCanvas(canvas, ctx) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }

  start() {
    this.isRunning = true;
    this.container.style.display = 'flex';
    this.micBuffer.fill(0);
    this.desktopBuffer.fill(0);
    this.micPeaks.fill(0);
    this.desktopPeaks.fill(0);
    this.micTarget = 0;
    this.desktopTarget = 0;
    this.lastUpdateTime = Date.now();
    this.lastShiftTime = performance.now();
    this.warningShown = false;
    this._lastDrawnMicTarget = null;
    this._lastDrawnDesktopTarget = null;

    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (!this.isRunning || document.hidden || this.rafId !== null) {
          return;
        }
        this._loop();
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    // Defer a tick so the container is visible and has layout
    requestAnimationFrame(() => {
      this._setupCanvas(this.micCanvas, this.micCtx);
      this._setupCanvas(this.desktopCanvas, this.desktopCtx);
      this._loop();
    });

    // Background safety: if document is hidden, rAF is throttled to ~1 Hz.
    // Use a setInterval to ensure visualization keeps ticking near hidden too.
    this.fallbackIntervalId = setInterval(() => {
      if (document.hidden && this.isRunning) {
        // No need to draw, but keep peak decay current so when window
        // returns to focus the state is consistent.
        this._decayPeaks();
      }
    }, 200);
  }

  stop() {
    this.isRunning = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.fallbackIntervalId !== null) {
      clearInterval(this.fallbackIntervalId);
      this.fallbackIntervalId = null;
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

    const nextMicTarget = Math.max(0, Math.min(1, levels.mic || 0));
    const nextDesktopTarget = Math.max(0, Math.min(1, levels.desktop || 0));
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

  _decayPeaks() {
    for (let i = 0; i < this.bufferSize; i++) {
      this.micPeaks[i] *= 0.94;
      this.desktopPeaks[i] *= 0.94;
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

    this.phase = (this.phase + 0.06) % (Math.PI * 2);

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
      for (let i = 0; i < this.bufferSize - 1; i++) {
        this.micBuffer[i] = this.micBuffer[i + 1];
        this.desktopBuffer[i] = this.desktopBuffer[i + 1];
        this.micPeaks[i] = this.micPeaks[i + 1];
        this.desktopPeaks[i] = this.desktopPeaks[i + 1];
      }
      this.micBuffer[lastIdx] = this.micTarget;
      this.desktopBuffer[lastIdx] = this.desktopTarget;
    }

    for (let i = 0; i < this.bufferSize; i++) {
      this.micPeaks[i] = Math.max(this.micPeaks[i] * 0.95, this.micBuffer[i]);
      this.desktopPeaks[i] = Math.max(this.desktopPeaks[i] * 0.95, this.desktopBuffer[i]);
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

    this._draw(this.micCtx, this.micBuffer, this.micPeaks, [139, 124, 246]);
    this._draw(this.desktopCtx, this.desktopBuffer, this.desktopPeaks, [56, 189, 248]);
    this._lastDrawnMicTarget = this.micTarget;
    this._lastDrawnDesktopTarget = this.desktopTarget;

    this.rafId = requestAnimationFrame(() => this._loop());
  }

  // Aggressive perceptual scaling to make speech visible without crushing peaks.
  _shape(level) {
    const x = Math.max(0, Math.min(1, level));
    // Soft expander: emphasize mid + boost low signal visibility
    const shaped = Math.pow(x, 0.38);
    return shaped;
  }

  _draw(ctx, buffer, peaks, rgb) {
    const canvas = ctx.canvas;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const midY = height / 2;
    const n = this.bufferSize;
    const [r, g, b] = rgb;
    const colorBase = `${r}, ${g}, ${b}`;

    ctx.clearRect(0, 0, width, height);

    const colWidth = width / n;
    const barWidth = Math.max(1.2, colWidth - 1.4);
    const radius = Math.min(barWidth / 2, 1.6);

    // Background midline (subtle baseline)
    ctx.strokeStyle = `rgba(${colorBase}, 0.10)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();

    // Compute per-bar shaped amplitudes
    const amps = new Array(n);
    const peakAmps = new Array(n);
    let maxAmp = 0;
    const ampScale = height * 0.40;
    for (let i = 0; i < n; i++) {
      const a = this._shape(buffer[i]) * ampScale;
      amps[i] = Math.max(1.0, a);
      peakAmps[i] = Math.max(amps[i], this._shape(peaks[i]) * ampScale);
      if (amps[i] > maxAmp) maxAmp = amps[i];
    }

    // Vertical gradient for the bars
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0.0, `rgba(${colorBase}, 0.95)`);
    grad.addColorStop(0.5, `rgba(${colorBase}, 0.55)`);
    grad.addColorStop(1.0, `rgba(${colorBase}, 0.95)`);

    // Soft glow underlay (proportional to overall energy)
    const energy = Math.min(1, maxAmp / ampScale);
    if (energy > 0.05) {
      ctx.save();
      ctx.shadowColor = `rgba(${colorBase}, ${0.3 + energy * 0.4})`;
      ctx.shadowBlur = 4 + energy * 8;
      ctx.fillStyle = grad;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = i * colWidth + (colWidth - barWidth) / 2;
        const h = amps[i] * 2;
        const y = midY - amps[i];
        roundedBar(ctx, x, y, barWidth, h, radius);
      }
      ctx.fill();
      ctx.restore();
    } else {
      // Quiet state: just draw bars without glow for performance
      ctx.fillStyle = grad;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = i * colWidth + (colWidth - barWidth) / 2;
        const h = amps[i] * 2;
        const y = midY - amps[i];
        roundedBar(ctx, x, y, barWidth, h, radius);
      }
      ctx.fill();
    }

    // Peak-hold caps (bright crest leftover from loud moments)
    ctx.fillStyle = `rgba(${colorBase}, 0.95)`;
    for (let i = 0; i < n; i++) {
      const peak = peakAmps[i];
      if (peak <= amps[i] + 0.5) continue;
      const x = i * colWidth + (colWidth - barWidth) / 2;
      const capH = 1.0;
      // top cap
      ctx.fillRect(x, midY - peak - capH / 2, barWidth, capH);
      // bottom cap (mirrored)
      ctx.fillRect(x, midY + peak - capH / 2, barWidth, capH);
    }

    // Crisp envelope outline (smooth curve over the bar tops)
    ctx.strokeStyle = `rgba(${colorBase}, 0.9)`;
    ctx.lineWidth = 1.1;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = i * colWidth + colWidth / 2;
      const y = midY - amps[i];
      if (i === 0) ctx.moveTo(x, y);
      else {
        const px = (i - 1) * colWidth + colWidth / 2;
        const py = midY - amps[i - 1];
        const cx = (px + x) / 2;
        const cy = (py + y) / 2;
        ctx.quadraticCurveTo(px, py, cx, cy);
      }
    }
    ctx.stroke();

    // When near-silent, add a tiny breathing shimmer so the UI feels alive
    if (energy < 0.04) {
      const shimmer = (Math.sin(this.phase) + 1) / 2; // 0..1
      const sa = 0.2 + shimmer * 0.8;
      ctx.fillStyle = `rgba(${colorBase}, ${0.18 * sa})`;
      const dotR = 1.2;
      ctx.beginPath();
      ctx.arc(width / 2, midY, dotR, 0, Math.PI * 2);
      ctx.fill();
    }
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

  // Reset hook used by setMeetingAudioSource()
  window.__resetCustomAudioPlayer = () => {
    setIcon(PLAY_PATH);
    fill.style.width = '0%';
    thumb.style.left = '0%';
    currentEl.textContent = '0:00';
    durationEl.textContent = '0:00';
    track.setAttribute('aria-valuenow', '0');
  };
}

// Start the app
init();
setupTabs();
setupDevConsole();
setupCustomAudioPlayer();
setupTitleEditors();
setupGPUCTA();
setupHomeAiAddonCTA();
