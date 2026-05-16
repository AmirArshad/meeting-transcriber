/**
 * Renderer process - UI logic for AvaNevis (Redesigned)
 */

const COPY_SUCCESS_TIMEOUT_MS = 2000;
const DEFAULT_SUMMARY_PROFILE = 'balanced';
const SVG_NS = 'http://www.w3.org/2000/svg';
const { getRecordButtonAction } = window.recordingStateHelpers;
const {
  buildHomeAiAddonPrompt,
  getDiarizationSetupMessage,
  getSummarySetupMessage,
  normalizeHistoryDetailTab,
  parseTranscriptMarkdownSegments,
} = window.historyDetailHelpers;
const {
  hideUpdateNotificationBanner,
  replayPendingUpdateNotification,
  showUpdateNotificationBanner,
} = window.updateNotificationHelpers;

// UI Elements
const micSelect = document.getElementById('mic-select');
const desktopSelect = document.getElementById('desktop-select');
const languageSelect = document.getElementById('language-select');
const modelSelect = document.getElementById('model-select');
const refreshBtn = document.getElementById('refresh-devices');
const recordBtn = document.getElementById('record-btn');
const copyBtn = document.getElementById('copy-btn');
const saveBtn = document.getElementById('save-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const timer = document.getElementById('timer');
const progressLog = document.getElementById('progress-log');
const transcriptOutput = document.getElementById('transcript-output');
const transcriptActions = document.getElementById('transcript-actions');
const meetingList = document.getElementById('meeting-list');
const meetingDetails = document.getElementById('meeting-details');
const refreshHistory = document.getElementById('refresh-history');
const deleteMeeting = document.getElementById('delete-meeting');

// State
let recordingState = 'idle'; // idle, recording, stopping, transcribing, countdown
let countdownValue = 3;
let recordingStartTime = null;
let timerInterval = null;
let currentAudioFile = null;
let currentMeetingId = null;
// Tracks the meeting saved from the most recent recording (post-transcription).
// Powers the in-place rename on the post-recording transcript card and the
// default filename used by the "Save" button.
let currentRecordingMeeting = null;
let pendingMeetingTranscriptId = null;
let summaryGenerationMeetingId = null;
let activeHistoryDetailTab = 'transcript';
let homePromptContext = { platform: null, hasNvidiaGpu: false, cudaInstalled: false };
let meetings = [];
let audioVisualizer = null;
let isFirstRecording = true; // Track if this is first recording (for longer timeout)
let isInitializing = true; // Track if app is still initializing
const checkedMeetingIds = new Set();
let meetingSearchQuery = '';
const cleanupFns = [];

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

function clearElement(element) {
  element.replaceChildren();
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

function renderSummaryMarkdown(markdown, options = {}) {
  const summaryEl = document.getElementById('meeting-summary');
  if (!summaryEl) {
    return;
  }

  summaryEl.classList.remove('is-empty');
  if (markdown && markdown.trim()) {
    summaryEl.dataset.markdown = markdown;
    renderMarkdownInto(summaryEl, markdown);
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
function renderMarkdownInto(container, markdown) {
  clearElement(container);
  if (!markdown || typeof markdown !== 'string') return;

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
            // Only allow safe URL schemes
            if (/^(https?:|mailto:|#)/i.test(url) || url.startsWith('/') || url.startsWith('.')) {
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

  metaRow.append(date, duration);
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
  setPlaceholder(transcriptOutput, message, isError ? 'placeholder error' : 'placeholder');
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
    button.dataset.originalLabel = button.textContent;
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

  try {
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

    // Step 4: Load meeting history
    await loadMeetingHistory();

    await refreshHomePrompts();

    // Initialize visualizer
    audioVisualizer = new AudioVisualizer();

    setupEventListeners();

    // Mark initialization complete
    isInitializing = false;
    setRecordingState('idle');
    addLog('Ready to record!');
    statusText.textContent = 'Ready';
    console.log('App initialized');

  } catch (error) {
    console.error('Initialization error:', error);
    addLog(`Initialization error: ${error.message}`, 'error');
    isInitializing = false;
    setRecordingState('idle');

    // Hide loading screen on error
    if (loadingScreen) {
      loadingScreen.classList.add('hidden');
      setTimeout(() => loadingScreen.remove(), 300);
    }
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
  } catch (error) {
    clearInterval(progressInterval);
    progressText.textContent = 'Setup failed!';
    logOutput.textContent += `\nERROR: ${error.message}`;

    addLog('Model download failed. You can try again from Settings.', 'error');

    // Wait for user to see error, then continue anyway
    await new Promise(resolve => setTimeout(resolve, 3000));
    modal.classList.add('hidden');
  } finally {
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
async function loadMeetingHistory() {
  try {
    // Scan the filesystem for any orphaned recordings not in the database
    try {
      const scanResult = await window.electronAPI.scanRecordings();
      if (scanResult.added > 0) {
        addLog(`Found ${scanResult.added} recording(s) not in database`);
      }
    } catch (scanError) {
      console.warn('Scan failed:', scanError);
    }

    // Load the meeting list
    meetings = await window.electronAPI.listMeetings();
    renderMeetingList();
  } catch (error) {
    console.error('Failed to load meeting history:', error);
    meetings = [];
    renderMeetingList();
  }
}

// Render meeting list
function renderMeetingList() {
  const query = meetingSearchQuery.trim().toLowerCase();
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
  const meeting = meetings.find(m => m.id === meetingId);
  if (!meeting) {
    console.error(`Meeting not found: ${meetingId}`);
    return;
  }

  // Update selection - convert both to strings for reliable comparison
  const targetId = String(meetingId);
  document.querySelectorAll('.meeting-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.id === targetId);
  });

  currentMeetingId = meetingId;
  pendingMeetingTranscriptId = meetingId;

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
  transcriptEl.classList.remove('markdown-body');
  delete transcriptEl.dataset.markdown;
  clearElement(transcriptEl);
  renderSummaryMarkdown('');
  activateHistoryDetailTab(activeHistoryDetailTab);
  const loading = document.createElement('p');
  loading.className = 'placeholder';
  loading.textContent = 'Loading transcript...';
  transcriptEl.appendChild(loading);

  try {
    const fullMeeting = await window.electronAPI.getMeeting(meetingId);

    if (!fullMeeting || currentMeetingId !== meetingId || pendingMeetingTranscriptId !== meetingId) {
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

    if (fullMeeting.summary) {
      renderSummaryMarkdown(fullMeeting.summary, { stale: fullMeeting.summaryStale });
    } else {
      showSummaryMessage('No summary yet. Generate one locally when the summary model is installed.');
    }
  } catch (error) {
    console.error(`Failed to load meeting transcript: ${error.message}`);
    if (currentMeetingId === meetingId && pendingMeetingTranscriptId === meetingId) {
      clearElement(transcriptEl);
      delete transcriptEl.dataset.markdown;
      const err = document.createElement('p');
      err.className = 'placeholder error';
      err.textContent = 'Failed to load transcript. The saved recording is still available above.';
      transcriptEl.appendChild(err);
      showSummaryMessage('Summary unavailable because the meeting details could not be loaded.', true);
    }
  } finally {
    if (pendingMeetingTranscriptId === meetingId) {
      pendingMeetingTranscriptId = null;
    }
  }

}

// ============================================================================
// Inline rename: meeting title (history detail + post-recording transcript)
// ============================================================================

// Reflects currentRecordingMeeting onto the post-recording transcript card.
// When no meeting has been saved yet, the heading reads "Transcript" and the
// pencil button is hidden. After save, it shows the meeting label and lets
// the user rename it in place.
function applyCurrentRecordingTitle() {
  const heading = document.getElementById('current-meeting-title');
  const editBtn = document.getElementById('current-meeting-title-edit');
  if (!heading) return;

  closeInlineTitleEditor({
    headingId: 'current-meeting-title',
    editBtnId: 'current-meeting-title-edit',
    formId: 'current-meeting-title-form',
    editBtnDisplay: currentRecordingMeeting && currentRecordingMeeting.title ? 'inline-flex' : 'none',
  });

  if (currentRecordingMeeting && currentRecordingMeeting.title) {
    heading.textContent = currentRecordingMeeting.title;
    if (editBtn) editBtn.style.display = 'inline-flex';
  } else {
    heading.textContent = 'Transcript';
    if (editBtn) editBtn.style.display = 'none';
  }
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
      if (updated && updated.title) {
        const activeMeeting = getMeeting();
        if (activeMeeting && String(activeMeeting.id) === editedMeetingId) {
          heading.textContent = updated.title;
        }
        if (typeof onSaved === 'function') onSaved(updated);
        addLog(`Renamed meeting to "${updated.title}"`);
      }
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
    getMeeting: () => meetings.find(m => m.id === currentMeetingId) || null,
    onSaved: (updated) => {
      // Update local cache and re-render meeting list to reflect the new title
      const idx = meetings.findIndex(m => m.id === updated.id);
      if (idx !== -1) {
        meetings[idx] = { ...meetings[idx], title: updated.title };
      }
      renderMeetingList();
      // Mirror onto the post-recording card if the same meeting is shown there
      if (currentRecordingMeeting && currentRecordingMeeting.id === updated.id) {
        currentRecordingMeeting = { ...currentRecordingMeeting, title: updated.title };
        applyCurrentRecordingTitle();
      }
    },
  });

  // Post-recording transcript card
  wireInlineTitleEditor({
    rowId: 'current-transcript-title-row',
    headingId: 'current-meeting-title',
    editBtnId: 'current-meeting-title-edit',
    formId: 'current-meeting-title-form',
    inputId: 'current-meeting-title-input',
    cancelBtnId: 'current-meeting-title-cancel',
    getMeeting: () => currentRecordingMeeting,
    onSaved: (updated) => {
      currentRecordingMeeting = { ...currentRecordingMeeting, title: updated.title };
      applyCurrentRecordingTitle();
      // Also update the cached history list so the sidebar reflects the change
      const idx = meetings.findIndex(m => m.id === updated.id);
      if (idx !== -1) {
        meetings[idx] = { ...meetings[idx], title: updated.title };
        renderMeetingList();
      }
    },
  });
}

// Setup event listeners
function setupEventListeners() {
  refreshBtn.addEventListener('click', () => {
    refreshBtn.classList.add('spinning');
    setTimeout(() => refreshBtn.classList.remove('spinning'), 600);
    loadAudioDevices();
  });
  refreshHistory.addEventListener('click', () => {
    refreshHistory.classList.add('spinning');
    setTimeout(() => refreshHistory.classList.remove('spinning'), 600);
    loadMeetingHistory();
  });
  recordBtn.addEventListener('click', handleRecordButtonClick);
  copyBtn.addEventListener('click', copyTranscript);
  saveBtn.addEventListener('click', saveTranscript);
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

  const generateCurrentSummaryBtn = document.getElementById('generate-current-summary-btn');
  if (generateCurrentSummaryBtn) {
    generateCurrentSummaryBtn.addEventListener('click', () => generateSummaryForMeeting(currentRecordingMeeting && currentRecordingMeeting.id, generateCurrentSummaryBtn));
  }

  const generateSummaryBtn = document.getElementById('generate-summary-btn');
  if (generateSummaryBtn) {
    generateSummaryBtn.addEventListener('click', () => generateSummaryForMeeting(currentMeetingId, generateSummaryBtn));
  }

  const regenerateSummaryBtn = document.getElementById('regenerate-summary-btn');
  if (regenerateSummaryBtn) {
    regenerateSummaryBtn.addEventListener('click', () => generateSummaryForMeeting(currentMeetingId, regenerateSummaryBtn));
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
      renderMeetingList();
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
    addLog(data);

    // Update status text during post-processing (stopping state)
    if (recordingState === 'stopping') {
      if (data.includes('Resampling')) {
        statusText.textContent = 'Processing: Resampling audio...';
      } else if (data.includes('noise reduction')) {
        statusText.textContent = 'Processing: Applying noise reduction...';
      } else if (data.includes('Mixing')) {
        statusText.textContent = 'Processing: Mixing audio tracks...';
      }
    }
  }));

  registerCleanup(window.electronAPI.onRecordingInitProgress((progress) => {
    // Show detailed progress during recording initialization
    addLog(progress.message);
    statusText.textContent = progress.message;
  }));

  registerCleanup(window.electronAPI.onTranscriptionProgress((data) => {
    addLog(data);
  }));

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

  // Listen for audio levels
  registerCleanup(window.electronAPI.onAudioLevels((levels) => {
    if (audioVisualizer && recordingState === 'recording') {
      audioVisualizer.updateLevels(levels);
    }
  }));

  // FIX 3 & 4: Listen for recording warnings (heartbeat lost)
  registerCleanup(window.electronAPI.onRecordingWarning((warning) => {
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
function setRecordingState(state) {
  recordingState = state;
  updateButtonUI();
  updateControlsState();
}

// Update button appearance based on state
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
      text.textContent = 'Initializing...';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Initializing...';
      break;

    case 'idle':
      button.classList.add('idle');
      button.disabled = false;
      icon.textContent = '▶';
      text.textContent = 'Start Recording';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Ready';
      break;

    case 'recording':
      button.classList.add('recording');
      button.disabled = false;
      icon.textContent = '■';
      text.textContent = 'Stop & Transcribe';
      statusIndicator.classList.add('recording');
      statusText.textContent = 'Recording...';
      break;

    case 'stopping':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = 'Stopping...';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Stopping...';
      break;

    case 'transcribing':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = 'Transcribing...';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Transcribing...';
      break;

    case 'countdown':
      button.classList.add('processing'); // Use processing style (grey)
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = `Starting in ${countdownValue}...`;
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Preparing...';
      break;
  }
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
  // Reset any previous recording's saved-meeting context so the title
  // collapses back to "Transcript" until the new recording is saved.
  currentRecordingMeeting = null;
  applyCurrentRecordingTitle();

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

  const preflightPassed = await runRecordingPreflightChecks({ micId, desktopId });
  if (!preflightPassed) {
    addLog('Recording canceled by preflight checks.', 'warning');
    setRecordingState('idle');
    return;
  }

  // Try up to 2 times with exponential backoff
  const maxAttempts = 2;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;

    try {
      if (attempt > 1) {
        addLog(`Retrying recording (attempt ${attempt}/${maxAttempts})...`);
        // Wait a moment before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        addLog('Starting recording...');
      }

      // Start countdown IMMEDIATELY (don't wait for backend)
      setRecordingState('countdown');

      // Start backend initialization in parallel with countdown
      const recordingPromise = window.electronAPI.startRecording({
        micId: parseInt(micId),
        loopbackId: parseInt(desktopId),
        isFirstRecording: isFirstRecording && attempt === 1 // Only use first-recording timeout on first attempt
      });

      // Countdown runs in parallel (3 seconds)
      const countdownPromise = startCountdown();

      // Wait for both to complete
      // In most cases, countdown will finish first and backend will be ready by then
      await Promise.all([recordingPromise, countdownPromise]);

      // After first successful recording, set flag to false
      if (isFirstRecording) {
        isFirstRecording = false;
        saveSettings({ hasRecordedBefore: true });
      }

      setRecordingState('recording');
      recordingStartTime = Date.now();

      // Update UI
      startTimer();
      audioVisualizer.start();

      // Clear previous transcript
      setTranscriptMessage('Recording in progress...');
      transcriptActions.style.display = 'none';

      addLog('Recording started!');
      return; // Success! Exit the retry loop

    } catch (error) {
      console.error(`Failed to start recording (attempt ${attempt}):`, error);

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

        setRecordingState('idle');
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
  return new Promise((resolve) => {
    countdownValue = 3;
    updateButtonUI(); // Show initial "Starting in 3..."
    
    const interval = setInterval(() => {
      countdownValue--;
      
      if (countdownValue > 0) {
        updateButtonUI();
      } else {
        clearInterval(interval);
        resolve();
      }
    }, 1000);
  });
}

// Stop recording and auto-transcribe
async function stopRecording() {
  try {
    addLog('Stopping recording...');

    // Immediately update UI to show we're stopping
    setRecordingState('stopping');
    stopTimer(); // Stop timer immediately
    audioVisualizer.stop();

    const result = await window.electronAPI.stopRecording();

    // Store the audio file path for transcription
    if (result.audioPath) {
      currentAudioFile = result.audioPath;
      addLog(`Recording saved: ${currentAudioFile}`);

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

// Helper function to format seconds into MM:SS
function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function renderTranscriptSegments(segments) {
  clearElement(transcriptOutput);

  if (segments && segments.length > 0) {
    segments.forEach(segment => {
      const segmentDiv = document.createElement('div');
      segmentDiv.style.marginBottom = '12px';

      const timestamp = document.createElement('div');
      timestamp.style.fontSize = '11px';
      timestamp.style.color = '#888';
      timestamp.style.marginBottom = '4px';
      const startTime = formatTimestamp(segment.start);
      const endTime = formatTimestamp(segment.end);
      timestamp.textContent = `[${startTime} - ${endTime}]${segment.speaker ? ` ${segment.speaker}` : ''}`;

      const text = document.createElement('div');
      text.textContent = segment.text;
      text.style.lineHeight = '1.5';

      segmentDiv.appendChild(timestamp);
      segmentDiv.appendChild(text);
      transcriptOutput.appendChild(segmentDiv);
    });
    return;
  }

  const transcriptText = document.createElement('div');
  transcriptText.textContent = 'No transcription available';
  transcriptOutput.appendChild(transcriptText);
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

  return lines.join('\n');
}

async function maybeRunDiarizationAfterTranscription(savedMeeting, transcriptionResult) {
  if (!savedMeeting || !savedMeeting.id || !savedMeeting.audioPath || !transcriptionResult.segments || transcriptionResult.segments.length === 0) {
    return null;
  }

  let aiStatus;
  try {
    aiStatus = await window.electronAPI.getAiAddonStatus();
  } catch (error) {
    addLog(`Speaker identification status unavailable: ${error.message}`, 'warning');
    return null;
  }

  const diarizationStatus = aiStatus && aiStatus.features && aiStatus.features.diarization;
  if (!diarizationStatus || !diarizationStatus.setupComplete || diarizationStatus.status !== 'ready') {
    return null;
  }

  addLog('Running speaker identification...');
  try {
    const result = await window.electronAPI.diarizeTranscript({
      audioPath: savedMeeting.audioPath,
      segments: transcriptionResult.segments,
      speakerCount: diarizationStatus.speakerCount || 'auto',
      modelRef: (aiStatus.models && aiStatus.models.diarization && aiStatus.models.diarization.defaultModelId) || diarizationStatus.modelId,
    });

    if (result && Array.isArray(result.segments) && result.segments.length > 0) {
      renderTranscriptSegments(result.segments);
      if (savedMeeting.transcriptPath) {
        await window.electronAPI.saveTranscriptFile({
          filePath: savedMeeting.transcriptPath,
          content: writeTranscriptMarkdown({ meeting: savedMeeting, transcriptionResult, diarizationResult: result }),
        });
      }
    }

    await window.electronAPI.updateMeetingAi(savedMeeting.id, {
      diarization: {
        status: 'completed',
        model: result.model || diarizationStatus.modelId,
        completedAt: result.completedAt,
        speakerCount: result.speakerCount,
        segmentsPath: result.segmentsPath,
        error: null,
      },
    });
    addLog('Speaker identification complete!');
    return result;
  } catch (error) {
    addLog(`Speaker identification failed; saved normal transcript. ${error.message}`, 'warning');
    try {
      await window.electronAPI.updateMeetingAi(savedMeeting.id, {
        diarization: {
          status: 'error',
          model: diarizationStatus.modelId,
          completedAt: new Date().toISOString(),
          error: error.message,
        },
      });
    } catch (metadataError) {
      addLog(`Could not save speaker identification failure state: ${metadataError.message}`, 'warning');
    }
    return null;
  }
}

function syncMeetingInList(updatedMeeting) {
  if (!updatedMeeting || !updatedMeeting.id) {
    return;
  }

  const index = meetings.findIndex(m => m.id === updatedMeeting.id);
  if (index !== -1) {
    meetings[index] = { ...meetings[index], ...updatedMeeting };
    renderMeetingList();
  }

  if (currentRecordingMeeting && currentRecordingMeeting.id === updatedMeeting.id) {
    currentRecordingMeeting = { ...currentRecordingMeeting, ...updatedMeeting };
    applyCurrentRecordingTitle();
  }
}

async function generateSummaryForMeeting(meetingId, button) {
  if (!meetingId) {
    addLog('Save a transcript before generating a summary.', 'warning');
    return;
  }

  if (summaryGenerationMeetingId) {
    addLog('Summary generation is already running.', 'warning');
    return;
  }

  let aiStatus;
  try {
    aiStatus = await window.electronAPI.getAiAddonStatus();
  } catch (error) {
    addLog(`Summary setup status unavailable: ${error.message}`, 'error');
    return;
  }

  const summaryStatus = aiStatus && aiStatus.features && aiStatus.features.summary;
  if (!summaryStatus || !summaryStatus.setupComplete || summaryStatus.status !== 'ready') {
    const message = getSummarySetupMessage(summaryStatus);
    addLog(message, summaryStatus && summaryStatus.status === 'unsupported' ? 'error' : 'warning');
    if (currentMeetingId === meetingId) {
      showSummaryMessage(message, summaryStatus && summaryStatus.status === 'error');
      activateHistoryDetailTab('summary');
    }
    openSettingsAtAiAddons();
    return;
  }

  summaryGenerationMeetingId = meetingId;
  setButtonBusy(button, true, 'Summarizing...');
  if (currentMeetingId === meetingId) {
    showSummaryMessage('Generating local summary...');
  }

  try {
    addLog('Generating local summary...');
    const summaryProfileSelect = document.getElementById('summary-profile-select');
    const result = await window.electronAPI.generateSummary({
      meetingId,
      profile: (summaryProfileSelect && summaryProfileSelect.value) || summaryStatus.profile || DEFAULT_SUMMARY_PROFILE,
      modelId: summaryStatus.modelId,
    });

    if (currentMeetingId === meetingId) {
      const fullMeeting = await window.electronAPI.getMeeting(meetingId);
      renderSummaryMarkdown((fullMeeting && fullMeeting.summary) || '', { stale: fullMeeting && fullMeeting.summaryStale });
      syncMeetingInList((result && result.meeting) || fullMeeting);
      activateHistoryDetailTab('summary');
    } else {
      syncMeetingInList(result && result.meeting);
    }

    addLog('Summary generated!');
  } catch (error) {
    console.error('Failed to generate summary:', error);
    const message = `Summary generation failed. Transcript is unchanged. ${error.message}`;
    addLog(message, 'error');
    if (currentMeetingId === meetingId) {
      showSummaryMessage(message, true);
      activateHistoryDetailTab('summary');
    }
  } finally {
    summaryGenerationMeetingId = null;
    setButtonBusy(button, false);
  }
}

// Transcribe audio (auto-called after stop)
async function transcribeAudio() {
  const language = languageSelect.value;
  const modelSize = modelSelect.value;

  // Validate we have an audio file
  if (!currentAudioFile) {
    addLog('Error: No audio file to transcribe', 'error');
    setTranscriptMessage('No audio file available for transcription.', true);
    setRecordingState('idle');
    return;
  }

  try {
    setRecordingState('transcribing');
    setTranscriptMessage('Transcribing... This may take a moment.');

    addLog(`Language: ${language}, Model: ${modelSize}`);
    addLog(`File: ${currentAudioFile}`);

    const result = await window.electronAPI.transcribeAudio({
      audioFile: currentAudioFile,
      language,
      modelSize
    });

    // Display transcript with timestamps
    if (result.segments && result.segments.length > 0) {
      renderTranscriptSegments(result.segments);
    } else {
      clearElement(transcriptOutput);
      const transcriptText = document.createElement('div');
      transcriptText.textContent = result.text || 'No transcription available';
      transcriptOutput.appendChild(transcriptText);
    }

    // Enable actions
    transcriptActions.style.display = 'flex';

    addLog('Transcription complete!');
    addLog(`Word count: ${result.text.split(' ').length}`);

    // Save meeting to history
    try {
      addLog('Saving meeting to history...');
      const savedMeeting = await window.electronAPI.addMeeting({
        audioPath: result.audioPath || currentAudioFile,
        transcriptPath: result.output_file,
        duration: result.duration || 0,
        language: language,
        model: modelSize
      });
      if (savedMeeting && savedMeeting.audioPath) {
        currentAudioFile = savedMeeting.audioPath;
      }
      if (savedMeeting && savedMeeting.id) {
        currentRecordingMeeting = savedMeeting;
        applyCurrentRecordingTitle();
        await maybeRunDiarizationAfterTranscription(savedMeeting, result);
      }
      addLog('Meeting saved!');
    } catch (saveError) {
      console.error('Failed to save meeting:', saveError);
      addLog(`Warning: Could not save to history: ${saveError.message}`, 'warning');
    }

    // Reload meeting history
    await loadMeetingHistory();
    
    setRecordingState('idle');

  } catch (error) {
    console.error('Failed to transcribe:', error);
    addLog(`Error: ${error.message}`, 'error');
    setTranscriptMessage(`Transcription failed: ${error.message}`, true);
    setRecordingState('idle');
  }
}

// Copy transcript to clipboard (current recording)
function copyTranscript() {
  const text = transcriptOutput.textContent;
  navigator.clipboard.writeText(text);
  addLog('Transcript copied to clipboard!');
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

  const meeting = meetings.find(m => m.id === currentMeetingId);
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

  const meeting = meetings.find(m => m.id === currentMeetingId);
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

// Save transcript via native Save dialog. Default filename uses the
// current recording's display label (renamed or auto-generated) so users
// get a meaningful name without further typing.
async function saveTranscript() {
  // Prefer the rich markdown saved on disk by the backend transcriber when
  // available, falling back to whatever is currently in the transcript pane.
  let content = '';
  let suggestedName = 'Transcript';

  if (currentRecordingMeeting && currentRecordingMeeting.id) {
    suggestedName = currentRecordingMeeting.title || suggestedName;
    try {
      const fullMeeting = await window.electronAPI.getMeeting(currentRecordingMeeting.id);
      if (fullMeeting && fullMeeting.transcript) {
        content = fullMeeting.transcript;
      }
    } catch (err) {
      console.warn('Failed to load saved transcript markdown, falling back to plain text:', err);
    }
  }

  if (!content) {
    // Fallback: assemble plain text from the rendered transcript output
    content = (transcriptOutput && transcriptOutput.textContent) || '';
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
async function deleteMeetingHandler(meetingId) {
  const idToDelete = meetingId || currentMeetingId;
  if (!idToDelete) {
    console.error('No meeting ID to delete');
    return;
  }

  const meeting = meetings.find(m => m.id === idToDelete);
  if (!meeting) {
    console.error('Meeting not found:', idToDelete);
    return;
  }

  if (confirm(`Are you sure you want to delete "${meeting.title}"?`)) {
    try {
      // Release audio player file lock before deleting (Windows issue)
      const audioPlayer = document.getElementById('audio-player');
      if (audioPlayer.src) {
        audioPlayer.pause();
        audioPlayer.removeAttribute('src');
        audioPlayer.load();
      }

      addLog(`Deleting meeting: ${meeting.title}...`);

      // Small delay to ensure OS releases the file handle
      await new Promise(resolve => setTimeout(resolve, 300));

      await window.electronAPI.deleteMeeting(idToDelete);

      // Clear the view immediately
      if (currentMeetingId === idToDelete) {
        meetingDetails.style.display = 'none';
        document.getElementById('meeting-details-empty').style.display = 'flex';
        currentMeetingId = null;
      }

      // Remove from local list immediately
      meetings = meetings.filter(m => m.id !== idToDelete);
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
  timerInterval = setInterval(() => {
    const elapsed = Date.now() - recordingStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    timer.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Add log message
function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry ${type}`;
  logEntry.textContent = `[${timestamp}] ${message}`;
  progressLog.appendChild(logEntry);
  progressLog.scrollTop = progressLog.scrollHeight;
}

// Format date helper
function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Compact, Notion-style relative date for the meeting list
function formatRelativeDate(dateString) {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
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

function formatStatusLabel(status) {
  const labels = {
    notConfigured: 'Not configured',
    needsAccount: 'Needs account',
    downloading: 'Downloading',
    validating: 'Validating',
    ready: 'Ready',
    error: 'Error',
    unsupported: 'Unsupported',
  };
  return labels[status] || 'Unknown';
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

function appendAiAddonLog(text) {
  const logDiv = document.getElementById('ai-addon-log');
  const logOutput = document.getElementById('ai-addon-log-output');
  if (!logDiv || !logOutput) {
    return;
  }

  logDiv.style.display = 'block';
  logOutput.textContent += `${text}\n`;
  logOutput.scrollTop = logOutput.scrollHeight;
}

function updateAiAddonSettings(status) {
  const diarization = status && status.features && status.features.diarization;
  const summary = status && status.features && status.features.summary;
  const overallStatus = (diarization && diarization.status === 'ready') || (summary && summary.status === 'ready')
    ? 'ready'
    : ((diarization && diarization.status === 'error') || (summary && summary.status === 'error') ? 'error' : 'notConfigured');

  setStatusBadge(document.getElementById('ai-addons-status-badge'), overallStatus);

  if (diarization) {
    setStatusBadge(document.getElementById('diarization-status-badge'), diarization.status);
    const speakerCount = document.getElementById('diarization-speaker-count');
    if (speakerCount) {
      speakerCount.value = String(diarization.speakerCount || 'auto');
    }

    const statusText = document.getElementById('diarization-status-text');
    if (statusText) {
      statusText.textContent = getDiarizationSetupMessage(diarization);
    }
  }

  if (summary) {
    setStatusBadge(document.getElementById('summary-status-badge'), summary.status);
    const profileSelect = document.getElementById('summary-profile-select');
    if (profileSelect) {
      profileSelect.value = summary.profile || DEFAULT_SUMMARY_PROFILE;
    }

    const statusText = document.getElementById('summary-status-text');
    if (statusText) {
      statusText.textContent = getSummarySetupMessage(summary);
    }
  }
}

async function refreshAiAddonSettings() {
  try {
    const status = await window.electronAPI.getAiAddonStatus();
    updateAiAddonSettings(status);
    updateHomeAiAddonCTA(status);
    return status;
  } catch (error) {
    addLog(`Failed to check AI add-ons: ${error.message}`, 'error');
    setStatusBadge(document.getElementById('ai-addons-status-badge'), 'error');
    updateHomeAiAddonCTA(null);
    return null;
  }
}

async function withAiAddonAction(button, label, action) {
  setAiAddonControlsDisabled(true);
  setButtonBusy(button, true, label);
  try {
    const status = await action();
    if (status) {
      updateAiAddonSettings(status);
    } else {
      await refreshAiAddonSettings();
    }
  } catch (error) {
    console.error('AI add-on action failed:', error);
    addLog(`AI add-on action failed: ${error.message}`, 'error');
    appendAiAddonLog(`ERROR: ${error.message}`);
  } finally {
    setButtonBusy(button, false);
    setAiAddonControlsDisabled(false);
  }
}

function setupAiAddonSettingsListeners() {
  const setupDiarizationBtn = document.getElementById('setup-diarization-btn');
  const validateDiarizationBtn = document.getElementById('validate-diarization-btn');
  const removeDiarizationBtn = document.getElementById('remove-diarization-btn');
  const setupSummaryBtn = document.getElementById('setup-summary-btn');
  const validateSummaryBtn = document.getElementById('validate-summary-btn');
  const removeSummaryBtn = document.getElementById('remove-summary-btn');
  const summaryProfileSelect = document.getElementById('summary-profile-select');

  if (setupDiarizationBtn) {
    setupDiarizationBtn.addEventListener('click', () => withAiAddonAction(setupDiarizationBtn, 'Setting up...', async () => {
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
    setupSummaryBtn.addEventListener('click', () => withAiAddonAction(setupSummaryBtn, 'Installing...', async () => {
      const status = await window.electronAPI.setupSummaryModel({
        profile: summaryProfileSelect ? summaryProfileSelect.value : DEFAULT_SUMMARY_PROFILE,
      });
      addLog('Summary model setup checked.');
      return status;
    }));
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
      if (progress && progress.message) {
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
  const installBtn = document.getElementById('install-gpu-btn');
  const uninstallBtn = document.getElementById('uninstall-gpu-btn');
  const gpuActions = document.getElementById('gpu-actions');
  const ctaState = { platform: null, gpuInfo: null, cudaInfo: null };

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

        statusBadge.textContent = 'CPU Fallback';
        statusBadge.classList.add('disabled');
      }

      // Hide install/uninstall buttons on macOS (MLX is bundled)
      gpuActions.style.display = 'none';

    } else {
      // ============ Windows: Show CUDA Status ============
      gpuDescription.textContent = 'Enable GPU acceleration for 4-5x faster transcription. Requires NVIDIA GPU with CUDA support.';
      
      // Update labels for Windows
      gpuLabel1.textContent = 'GPU Detected:';
      gpuLabel2.textContent = 'CUDA Libraries:';
      gpuLabel3.textContent = 'Download Size:';

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
        statusBadge.textContent = 'Not Available';
        statusBadge.classList.add('disabled');
        installBtn.disabled = true;
        return;
      }

      // Check CUDA installation
      const cudaInfo = await window.electronAPI.checkCUDA();
      ctaState.cudaInfo = cudaInfo;

      if (cudaInfo.installed) {
        gpuValue2.textContent = `Installed (CUDA ${cudaInfo.version})`;
        gpuValue2.classList.add('success');
        gpuValue3.textContent = 'Already installed';
        statusBadge.textContent = 'Enabled';
        statusBadge.classList.add('enabled');
        installBtn.style.display = 'none';
        uninstallBtn.style.display = 'block';
      } else {
        gpuValue2.textContent = 'Not installed';
        gpuValue2.classList.add('warning');
        gpuValue3.textContent = cudaInfo.pythonSupportedForInstall === false && cudaInfo.pythonVersion
          ? `Requires Python 3.11 (current: ${cudaInfo.pythonVersion})`
          : '~2-3 GB';
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
    homePromptContext = {
      platform: ctaState.platform,
      hasNvidiaGpu: Boolean(ctaState.gpuInfo && ctaState.gpuInfo.hasGPU),
      cudaInstalled: Boolean(ctaState.cudaInfo && ctaState.cudaInfo.installed),
    };
    refreshAiAddonSettings().catch((error) => console.warn('Could not refresh AI add-on CTA:', error));
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
  if (sub && gpuInfo.gpuName) {
    sub.textContent = `${gpuInfo.gpuName} detected - enable 4-5x faster transcription`;
  }
  cta.style.display = 'flex';
}

function setupGPUCTA() {
  const cta = document.getElementById('gpu-cta');
  if (!cta) return;
  cta.addEventListener('click', () => {
    activateTab('settings');
  });
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
  const confirmed = confirm(
    'This will download and install ~2-3GB of GPU acceleration libraries.\n\n' +
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

  try {
    // Simulate progress (pip doesn't give us real progress)
    let progress = 0;
    const progressInterval = setInterval(() => {
      if (progress < 90) {
        progress += Math.random() * 5;
        progressBar.style.width = `${Math.min(progress, 90)}%`;
      }
    }, 2000);

    progressText.textContent = 'Downloading PyTorch with CUDA support...';

    // Install GPU packages
    await window.electronAPI.installGPU();

    // Complete progress
    clearInterval(progressInterval);
    progressBar.style.width = '100%';
    progressText.textContent = 'Installation complete!';

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

    alert('GPU acceleration installed successfully!\n\nFaster transcription is now available.');
  } catch (error) {
    console.error('GPU installation failed:', error);
    appendGPULog(`\nERROR: ${error.message}`);
    progressText.textContent = 'Installation failed!';
    statusBadge.textContent = 'Failed';
    statusBadge.className = 'setting-badge disabled';
    installBtn.disabled = false;
    installBtn.classList.remove('is-loading');

    alert(`GPU installation failed.\n\n${error.message}`);
  }
}

async function uninstallGPUAcceleration() {
  const confirmed = confirm(
    'This will remove all GPU acceleration libraries.\n\n' +
    'Transcription will fall back to CPU mode.\n\n' +
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
    alert('GPU acceleration uninstalled successfully.');
  } catch (error) {
    console.error('Uninstall failed:', error);
    alert('Failed to uninstall GPU acceleration.');
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
    await window.electronAPI.downloadUpdate(currentUpdateInfo.downloadUrl);
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
    this.container.style.display = 'none';
    this.warningShown = false;
  }

  updateLevels(levels) {
    this.lastUpdateTime = Date.now();
    this.warningShown = false;

    // Just update the targets — the rAF loop will smoothly pull current toward them.
    this.micTarget = Math.max(0, Math.min(1, levels.mic || 0));
    this.desktopTarget = Math.max(0, Math.min(1, levels.desktop || 0));
  }

  _decayPeaks() {
    for (let i = 0; i < this.bufferSize; i++) {
      this.micPeaks[i] *= 0.94;
      this.desktopPeaks[i] *= 0.94;
    }
  }

  _loop() {
    if (!this.isRunning) return;

    if (!document.hidden) {
      const now = performance.now();
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
      if (now - this.lastShiftTime >= this.shiftIntervalMs) {
        this.lastShiftTime = now;
        // Shift left
        for (let i = 0; i < this.bufferSize - 1; i++) {
          this.micBuffer[i] = this.micBuffer[i + 1];
          this.desktopBuffer[i] = this.desktopBuffer[i + 1];
          this.micPeaks[i] = this.micPeaks[i + 1];
          this.desktopPeaks[i] = this.desktopPeaks[i + 1];
        }
        // New column starts at current target
        this.micBuffer[lastIdx] = this.micTarget;
        this.desktopBuffer[lastIdx] = this.desktopTarget;
      }

      // Update peaks: refresh if the live value is higher; otherwise decay
      for (let i = 0; i < this.bufferSize; i++) {
        this.micPeaks[i] = Math.max(this.micPeaks[i] * 0.95, this.micBuffer[i]);
        this.desktopPeaks[i] = Math.max(this.desktopPeaks[i] * 0.95, this.desktopBuffer[i]);
      }

      // Heartbeat-lost fade
      const timeSinceUpdate = Date.now() - this.lastUpdateTime;
      if (timeSinceUpdate > 5000) {
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
    }

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

// Helper: rounded bar path (does not fill — caller decides batch fill)
function roundedBar(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
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
initSettingsTab();
setupGPUCTA();
setupHomeAiAddonCTA();
