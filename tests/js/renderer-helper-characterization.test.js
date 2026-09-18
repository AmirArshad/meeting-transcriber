'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const {
  ROOT,
  readUtf8,
} = require('./source-scan-helpers');

const {
  getRecordButtonAction,
} = require('../../src/renderer/recording-state-helpers');

const {
  formatAiAddonProgressText,
  formatBytes,
  formatStatusLabel,
  formatTimestamp,
} = require('../../src/renderer/formatters');

const {
  getMeetingTranscriptionStatusMessage,
  isMeetingTranscriptionRetryable,
} = require('../../src/renderer/summary-ui-helpers');

const {
  isAiAddonProgressPhase,
  isAiAddonTerminalStatus,
} = require('../../src/renderer/ai-addon-ui-helpers');

const { clearElement } = require('../../src/renderer/dom-helpers');
const { meetingIdsEqual } = require('../../src/renderer/meeting-helpers');
const { isGpuRuntimeActionBusyError, formatGpuRuntimeBusyAlertMessage } = require('../../src/renderer/gpu-settings-helpers');
const { roundedBar } = require('../../src/renderer/canvas-helpers');

const APP_JS = path.join(ROOT, 'src', 'renderer', 'app.js');
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');
// Windows checkouts use CRLF, which breaks the LF slice markers below.
// Normalize once at the read site so character offsets stay platform-stable.
const readAppSource = () => readUtf8(APP_JS).replace(/\r\n/g, '\n');
const STYLES_CSS = path.join(ROOT, 'src', 'renderer', 'styles.css');

const EXPECTED_RENDERER_GLOBALS = [
  'recordingStateHelpers',
  'transcriptionActivityHelpers',
  'recoveryUiHelpers',
  'updateNotificationHelpers',
  'historyDetailHelpers',
  'formatters',
  'summaryUiHelpers',
  'aiAddonUiHelpers',
  'domHelpers',
  'meetingHelpers',
  'gpuSettingsHelpers',
  'platformSelectionHelpers',
  'canvasHelpers',
  'keyboardShortcutHelpers',
  // v2.10 Slice A shared policy (src/transcription-policy.js, UMD) loads
  // before app.js so Record UI + main use one curated source of truth.
  'transcriptionPolicy',
];

const EXPECTED_SCRIPT_ORDER = [
  'recording-state-helpers.js',
  'transcription-activity-helpers.js',
  'recovery-ui-helpers.js',
  'update-notification-helpers.js',
  'history-detail-helpers.js',
  'formatters.js',
  'summary-ui-helpers.js',
  'ai-addon-ui-helpers.js',
  'dom-helpers.js',
  'meeting-helpers.js',
  'gpu-settings-helpers.js',
  'platform-selection-helpers.js',
  'canvas-helpers.js',
  'keyboard-shortcut-helpers.js',
  '../transcription-policy.js',
  'app.js',
];

const EXTRACTED_PURE_HELPER_NAMES = [
  'isMeetingTranscriptionRetryable',
  'getMeetingTranscriptionStatusMessage',
  'formatTimestamp',
  'formatDate',
  'formatRelativeDate',
  'formatStatusLabel',
  'formatBytes',
  'isAiAddonTerminalStatus',
  'isAiAddonProgressPhase',
  'isAiAddonSetupLockingControls',
  'formatAiAddonProgressText',
  'clearElement',
  'meetingIdsEqual',
  'isGpuRuntimeActionBusyError',
  'formatGpuRuntimeBusyAlertMessage',
  'inferRendererHostFamily',
  'getEmptyMicrophoneDeviceGuidance',
  'getRecordingPermissionFailureGuidance',
  'roundedBar',
  'getIdleStatusPillText',
  'buildActivityRows',
  'buildResumePendingBannerView',
];

test('recording-state-helpers remain characterized for record-button gating', () => {
  assert.equal(getRecordButtonAction('idle'), 'start');
  assert.equal(getRecordButtonAction('recording'), 'stop');
  assert.equal(getRecordButtonAction('transcribing'), 'ignore');
});

test('extracted pure helpers characterize summary/AI gating without DOM access', () => {
  assert.equal(isMeetingTranscriptionRetryable({ transcriptionStatus: 'failed' }), true);
  assert.equal(isMeetingTranscriptionRetryable({ transcriptionStatus: 'pending' }), true);
  assert.equal(isMeetingTranscriptionRetryable({ transcriptionStatus: 'completed' }), false);
  assert.equal(isMeetingTranscriptionRetryable(null), false);

  assert.equal(
    getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'failed', transcriptionError: 'boom' }),
    'Transcription failed: boom',
  );
  assert.equal(
    getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'pending' }),
    'This recording has not been transcribed yet.',
  );
  assert.equal(getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'completed' }), '');

  assert.equal(formatTimestamp(65), '01:05');
  assert.equal(formatTimestamp(0), '00:00');

  assert.equal(formatStatusLabel('ready'), 'Ready');
  assert.equal(formatStatusLabel('needsAccount'), 'Needs account');
  assert.equal(formatStatusLabel('nope'), 'Unknown');

  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');

  assert.equal(isAiAddonTerminalStatus('ready'), true);
  assert.equal(isAiAddonTerminalStatus('downloading'), false);
  assert.equal(isAiAddonProgressPhase({ phase: 'downloading' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'extracting' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'idle' }), false);

  assert.equal(
    formatAiAddonProgressText({ message: 'Downloading', percent: 42 }),
    'Downloading 42%',
  );
  assert.match(
    formatAiAddonProgressText({
      message: 'Downloading',
      downloadedBytes: 1024,
      totalBytes: 2048,
      percent: 50,
    }),
    /Downloading 1 KB of 2 KB \(50%\)/,
  );
});

test('app.js no longer defines extracted pure helpers inline', () => {
  const appSource = readAppSource();
  for (const name of EXTRACTED_PURE_HELPER_NAMES) {
    assert.equal(
      appSource.includes(`function ${name}`),
      false,
      `expected ${name} to be removed from app.js after Pattern B extraction`,
    );
  }

  assert.match(appSource, /window\.formatters/);
  assert.match(appSource, /window\.summaryUiHelpers/);
  assert.match(appSource, /window\.aiAddonUiHelpers/);
  assert.match(appSource, /window\.domHelpers/);
  assert.match(appSource, /window\.meetingHelpers/);
  assert.match(appSource, /window\.gpuSettingsHelpers/);
  assert.match(appSource, /window\.platformSelectionHelpers/);
  assert.match(appSource, /window\.canvasHelpers/);
});

test('phase 2b pure helpers remain argument-driven', () => {
  const removed = [];
  clearElement({
    replaceChildren(...nodes) {
      removed.push(nodes);
    },
  });
  assert.deepEqual(removed, [[]]);

  assert.equal(meetingIdsEqual('1', 1), true);
  assert.equal(meetingIdsEqual(null, '1'), false);
  assert.equal(isGpuRuntimeActionBusyError({ message: 'GPU_RUNTIME_ACTION_BUSY' }), true);
  assert.equal(isGpuRuntimeActionBusyError({ message: 'other' }), false);
  assert.match(
    formatGpuRuntimeBusyAlertMessage({
      code: 'GPU_RUNTIME_COMPUTE_BUSY',
      message: '1 recording is queued for transcription — finish or cancel them before installing or repairing the GPU runtime.',
    }),
    /queued for transcription/,
  );

  const calls = [];
  roundedBar({
    moveTo(...args) { calls.push(['moveTo', ...args]); },
    lineTo() {},
    quadraticCurveTo() {},
    closePath() { calls.push(['closePath']); },
  }, 0, 0, 10, 4, 2);
  assert.equal(calls[0][0], 'moveTo');
  assert.equal(calls[calls.length - 1][0], 'closePath');
});

test('index.html loads renderer helpers before app.js with unique globals', () => {
  const html = readUtf8(INDEX_HTML);
  const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(scriptSrcs, EXPECTED_SCRIPT_ORDER);

  const helperFiles = EXPECTED_SCRIPT_ORDER.slice(0, -1);
  const globals = [];
  for (const fileName of helperFiles) {
    const source = readUtf8(path.join(ROOT, 'src', 'renderer', fileName));
    const match = source.match(/root\.([A-Za-z0-9_]+)\s*=/);
    assert.ok(match, `${fileName} must attach a root.<global>`);
    globals.push(match[1]);
  }

  assert.deepEqual(globals, EXPECTED_RENDERER_GLOBALS);
  assert.equal(new Set(globals).size, globals.length);
});

test('Phase 0.3 does not mislabel DOM helpers as pure', () => {
  const appSource = readAppSource();
  const expectations = {
    setStatusBadge: (snippet) => /\b(?:textContent|className|classList)\b/.test(snippet),
    populateSelect: (snippet) => /\bdocument\./.test(snippet),
    renderMarkdownInto: (snippet) => /\bdocument\./.test(snippet),
    getSummaryButtonMeetingId: (snippet) => (
      /\bcurrentMeetingId\b/.test(snippet) || /\bcurrentRecordingMeeting\b/.test(snippet)
    ),
  };

  for (const [name, predicate] of Object.entries(expectations)) {
    const start = appSource.indexOf(`function ${name}`);
    assert.ok(start >= 0, `expected ${name} to exist in app.js`);
    const snippet = appSource.slice(start, start + 800);
    assert.equal(
      predicate(snippet),
      true,
      `${name} should remain classified as stateful/DOM (not extracted as pure in Phase 0)`,
    );
  }
});

test('meeting detail exposes semantic header and labelled action region without changing control IDs', () => {
  const html = readUtf8(INDEX_HTML);

  assert.match(html, /<header\s+class="meeting-header meeting-detail-header"/);
  assert.match(
    html,
    /<div\s+class="meeting-detail-actions"\s+role="group"\s+aria-label="Meeting actions">[\s\S]*?id="delete-meeting"[\s\S]*?<\/div>/,
  );
  for (const id of [
    'meeting-title',
    'meeting-title-edit',
    'meeting-title-edit-form',
    'meeting-title-input',
    'meeting-title-cancel',
    'delete-meeting',
  ]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} remains unique`);
  }
});

test('renderer visual foundation includes responsive History and reduced-motion behavior', () => {
  const css = readUtf8(STYLES_CSS);

  assert.match(css, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.history-layout\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /\.recording-section::before/);
  assert.match(css, /--accent:\s*#b8a8c9/);
  assert.match(css, /--rail-width:\s*56px/);
  assert.match(
    css,
    /\.rail-btn\.active::before\s*\{[\s\S]*?left:\s*calc\(-0\.5 \* \(var\(--rail-width\) - var\(--rail-btn-size\)\)\)/,
  );
});

test('responsive recording controls stay grouped when the visualizer stacks', () => {
  const css = readUtf8(STYLES_CSS);

  assert.match(
    css,
    /@media\s*\(max-width:\s*880px\)[\s\S]*?\.controls-group\s*\{\s*justify-content:\s*flex-start;\s*width:\s*100%;\s*\}/,
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.controls-group\s*\{[\s\S]*?justify-content:\s*flex-start;/,
  );
});

test('activateTab synchronizes active navigation styling and accessibility state', () => {
  const appSource = readAppSource();
  const start = appSource.indexOf('function activateTab(targetTab)');
  const end = appSource.indexOf('\nfunction getPreferredScrollBehavior()', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const makeClassList = () => {
    const values = new Set();
    return {
      contains: (value) => values.has(value),
      toggle: (value, force) => (force ? values.add(value) : values.delete(value)),
    };
  };
  const makeButton = (tab, rail = false) => ({
    dataset: { tab },
    classList: makeClassList(),
    attributes: {},
    matches: (selector) => rail && selector === '.rail-btn[data-tab]',
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
  });
  const recordTab = makeButton('record');
  const historyTab = makeButton('history');
  const recordRail = makeButton('record', true);
  const historyRail = makeButton('history', true);
  const panes = ['record', 'history'].map((tab) => ({ id: `${tab}-tab`, classList: makeClassList() }));
  const document = {
    querySelectorAll(selector) {
      if (selector === '.tab-btn') return [recordTab, historyTab];
      if (selector === '.rail-btn[data-tab]') return [recordRail, historyRail];
      if (selector === '.tab-pane') return panes;
      return [];
    },
  };

  const activateTab = vm.runInNewContext(`(${appSource.slice(start, end)})`, {
    document,
    initSettingsTab: async () => {},
    console,
  });
  activateTab('history');

  assert.equal(historyTab.classList.contains('active'), true);
  assert.equal(historyTab.attributes['aria-selected'], 'true');
  assert.equal(recordTab.attributes['aria-selected'], 'false');
  assert.equal(historyRail.attributes['aria-current'], 'page');
  assert.equal(recordRail.attributes['aria-current'], undefined);
  assert.equal(panes[1].classList.contains('active'), true);
});

test('Settings navigation disables explicit smooth scrolling for reduced motion', () => {
  const appSource = readAppSource();
  const start = appSource.indexOf('function getPreferredScrollBehavior()');
  const end = appSource.indexOf('\nfunction openSettingsAtAiAddons()', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const functionSource = appSource.slice(start, end);
  const reduceMotion = vm.runInNewContext(`(${functionSource})`, {
    window: { matchMedia: () => ({ matches: true }) },
  });
  const allowMotion = vm.runInNewContext(`(${functionSource})`, {
    window: { matchMedia: () => ({ matches: false }) },
  });
  assert.equal(reduceMotion(), 'auto');
  assert.equal(allowMotion(), 'smooth');
});

test('AI Add-on Log prefixes receipt timestamps and enforces the bounded cap', () => {
  const appSource = readAppSource();
  assert.match(appSource, /function appendAiAddonLog\(text\)/);
  assert.match(appSource, /toLocaleDateString\(\).*toLocaleTimeString\(\)|toLocaleTimeString\(\).*toLocaleDateString\(\)/);
  assert.match(appSource, /split\('\\n'\)\.map\(.*\[.*timestamp.*\]/);
  assert.match(appSource, /MAX_PROGRESS_LOG_ENTRIES/);
});

test('Record navigation uses the microphone treatment and Record page naming', () => {
  const html = readUtf8(INDEX_HTML);
  assert.doesNotMatch(html, /class="rail-logo"/);
  const railButtons = [...html.matchAll(/<button[^>]+class="rail-btn[^"]*"[^>]*data-tab="([^"]+)"[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)];
  assert.ok(railButtons.length >= 3);
  assert.equal(railButtons[0][1], 'record');
  assert.equal(railButtons[0][2], 'Record page');
  assert.match(railButtons[0][3], /M12 2a3 3/);
  assert.doesNotMatch(railButtons[0][3], /circle cx="12" cy="12" r="6"/);
  assert.match(html, /<span class="rail-tooltip">Record page<\/span>/);
});

test('keyboard shortcuts dispatch through guarded actions without new IPC', () => {
  const appSource = readAppSource();
  assert.match(appSource, /function handleKeyboardShortcut\(event\)/);
  assert.match(appSource, /resolveKeyboardShortcutAction\(event/);
  assert.match(appSource, /shouldSuppressKeyboardShortcut\(event/);
  assert.match(appSource, /function canRunKeyboardRecordingCommand\(action\)/);
  assert.match(appSource, /getRecordButtonAction\(recordingState\) === 'start'/);
  assert.match(appSource, /getRecordButtonAction\(recordingState\) === 'stop'/);
  assert.match(appSource, /void startRecording\('mic-and-desktop'\)/);
  assert.match(appSource, /void stopRecording\(\)/);
  assert.match(appSource, /activateTabAndFocusHeading/);
  assert.match(appSource, /function setupKeyboardShortcuts\(\)/);
  assert.match(appSource, /document\.addEventListener\('keydown', handleKeyboardShortcut\)/);
  assert.match(appSource, /function applyKeyboardShortcutDiscovery\(\)/);
  assert.match(appSource, /aria-keyshortcuts/);
  assert.match(appSource, /data-shortcut-display/);
});

test('Settings exposes Keyboard Shortcuts discovery and section links', () => {
  const html = readUtf8(INDEX_HTML);
  assert.match(html, /id="keyboard-shortcuts-settings"/);
  assert.match(html, /id="gpu-settings"/);
  assert.match(html, /id="about-settings"/);
  assert.match(html, /class="settings-subnav"/);
  assert.match(html, /href="#keyboard-shortcuts-settings"/);
  assert.match(html, /data-shortcut-display="start-recording"/);
  assert.match(html, /data-shortcut-display="stop-recording"/);
  assert.match(html, /id="keyboard-shortcuts-note"/);
  assert.match(html, /Works while AvaNevis is focused/);
  const appSource = readAppSource();
  assert.match(appSource, /\.settings-subnav a\[href\^="#"\]/);
  const css = readUtf8(STYLES_CSS);
  assert.match(css, /\.settings-subnav/);
});

test('meeting rename saves on click-away without changing the submit path', () => {
  const appSource = readAppSource();
  assert.match(appSource, /function wireInlineTitleEditor\(/);
  assert.match(appSource, /form\.addEventListener\('focusout'/);
  assert.match(appSource, /form\.contains\(e\.relatedTarget\)/);
  assert.match(appSource, /suppressClickAwaySave/);
  assert.match(appSource, /commitTitleEdit/);
  assert.match(appSource, /form\.addEventListener\('submit'/);
  assert.match(appSource, /activity-rename-form/);
});

test('recording commands share one hydration/quit admission guard', () => {
  const appSource = readAppSource();
  assert.match(appSource, /let recordingHydrated = false/);
  assert.match(appSource, /let rendererQuitCommitted = false/);
  assert.match(appSource, /function isRecordingCommandAdmitted\(action\)/);
  assert.match(appSource, /recordingHydrated = true/);
  assert.match(appSource, /rendererQuitCommitted = true/);
  assert.match(appSource, /if \(!recordingHydrated \|\| rendererQuitCommitted\) \{\s*\n?\s*button\.disabled = true;/);
});

test('recording shortcut dispatcher admits only hydrated idle/record states and never after quit', () => {
  const appSource = readAppSource();
  const {
    resolveKeyboardShortcutAction,
    shouldSuppressKeyboardShortcut,
  } = require('../../src/renderer/keyboard-shortcut-helpers');
  const slice = (startMarker, endMarker) => {
    const start = appSource.indexOf(startMarker);
    assert.notEqual(start, -1, startMarker);
    const end = appSource.indexOf(endMarker, start);
    assert.notEqual(end, -1, endMarker);
    return appSource.slice(start, end + 2);
  };
  const guardSrc = slice('function canRunKeyboardRecordingCommand(action) {', '\n}\n\nfunction applyKeyboardShortcutDiscovery()');
  const clickSrc = slice('function handleRecordButtonClick() {', '\n}\n\n// Set recording state and update UI');

  const context = {
    recordingState: 'idle',
    recordBtn: { disabled: false },
    recoveryPromptOpen: false,
    recordingHydrated: false,
    rendererQuitCommitted: false,
    isInitializing: false,
    recordModeMenu: { hidden: true },
    getRecordButtonAction,
    resolveKeyboardShortcutAction,
    shouldSuppressKeyboardShortcut,
    getRendererPlatform: () => 'win32',
    isHistoryTitleEditorOpen: () => false,
    document: { querySelectorAll: () => [] },
    activateCalls: [],
    startCalls: 0,
    stopCalls: 0,
    console,
  };
  context.activateTabAndFocusHeading = (tab) => context.activateCalls.push(tab);
  context.startRecording = () => { context.startCalls += 1; };
  context.stopRecording = () => { context.stopCalls += 1; };
  vm.createContext(context);
  vm.runInContext(`${guardSrc}\n${clickSrc}`, context);
  const keyEvent = ({ code }) => ({
    code, key: code === 'KeyR' ? 'r' : code === 'KeyS' ? 's' : code,
    ctrlKey: true, metaKey: false, shiftKey: true, altKey: false,
    repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false,
    getModifierState: () => false, target: { tagName: 'BODY' },
    preventDefault() {},
  });

  // Deferred hydration: idle renderer blocks Start via keyboard AND mouse.
  context.keyEvent = keyEvent;
  vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyR" }))', context);
  assert.equal(context.startCalls, 0);
  vm.runInContext('handleRecordButtonClick()', context);
  assert.equal(context.startCalls, 0);

  // Hydrated idle admits exactly one Start; rapid duplicate sees starting.
  context.recordingHydrated = true;
  vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyR" }))', context);
  assert.equal(context.startCalls, 1);
  context.recordingState = 'starting';
  vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyR" }))', context);
  vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyS" }))', context);
  assert.equal(context.startCalls, 1);
  assert.equal(context.stopCalls, 0);

  // Every non-capture state rejects both commands.
  for (const state of ['starting', 'countdown', 'stopping', 'cancelling', 'initializing']) {
    context.recordingState = state;
    const before = context.startCalls + context.stopCalls;
    vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyR" }))', context);
    vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyS" }))', context);
    assert.equal(context.startCalls + context.stopCalls, before, `blocked in ${state}`);
  }

  // Recording admits Stop only, never Start; mouse agrees.
  context.recordingState = 'recording';
  vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyR" }))', context);
  assert.equal(context.startCalls, 1);
  vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyS" }))', context);
  assert.equal(context.stopCalls, 1);
  vm.runInContext('handleRecordButtonClick()', context);
  assert.equal(context.stopCalls, 2);

  // Quit commitment closes both, keyboard and mouse.
  context.recordingState = 'idle';
  context.rendererQuitCommitted = true;
  vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyR" }))', context);
  context.recordingState = 'recording';
  vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "KeyS" }))', context);
  vm.runInContext('handleRecordButtonClick()', context);
  assert.equal(context.startCalls, 1);
  assert.equal(context.stopCalls, 2);

  // Navigation still works while recording commands are blocked.
  context.activateCalls.length = 0;
  vm.runInContext('handleKeyboardShortcut(keyEvent({ code: "Digit1" }))', context);
  assert.deepEqual(context.activateCalls, ['record']);
});

// Round-two harness: execute the shipped hydration/quit composition (real
// ensureRecordingHydration + hydrateRecordingStateFromMain + admission
// predicate + UI updates) against deferred/rejected IPC and emitted quit
// events, instead of hand-flipping lifecycle flags.
const extractBalancedSource = (appSource, startMarker) => {
  const start = appSource.indexOf(startMarker);
  assert.notEqual(start, -1, startMarker);
  const open = appSource.indexOf('{', start);
  assert.notEqual(open, -1, startMarker);
  let depth = 0;
  for (let i = open; i < appSource.length; i += 1) {
    if (appSource[i] === '{') {
      depth += 1;
    } else if (appSource[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return appSource.slice(start, i + 1);
      }
    }
  }
  assert.fail(`unbalanced braces after ${startMarker}`);
  return '';
};

const {
  canHydratedRendererStopRecording: realCanHydratedRendererStopRecording,
  normalizeCaptureMode: realNormalizeCaptureMode,
  getRecordingSourceStatusText: realGetRecordingSourceStatusText,
} = require('../../src/renderer/recording-state-helpers');
const {
  getIdleStatusPillText: realGetIdleStatusPillText,
  getRecordButtonLabel: realGetRecordButtonLabel,
} = require('../../src/renderer/transcription-activity-helpers');

function createHydrationCompositionContext({ mainProbe, recoveryProbe } = {}) {
  const appSource = readAppSource();
  const context = {
    console,
    hydratedCaptureState: false,
    recordingHydrated: false,
    recordingHydrationFailed: false,
    rendererQuitCommitted: false,
    isInitializing: false,
    recoveryPromptOpen: false,
    recordingState: 'idle',
    activeRecordingSessionId: null,
    recordingStartTime: null,
    activeCaptureMode: 'mic-and-desktop',
    frozenPresenceElapsedText: null,
    lastStopProgressMessage: '',
    countdownValue: 0,
    transcriptionQueueState: {},
    audioVisualizer: null,
    logged: [],
    recordBtn: {
      disabled: true,
      className: '',
      classList: { add() {}, remove() {} },
      querySelector: () => ({ textContent: '' }),
    },
    statusText: { textContent: 'Initializing...' },
    statusIndicator: { classList: { add() {}, remove() {} } },
    micSelect: { disabled: true },
    desktopSelect: { disabled: true },
    languageSelect: { disabled: true },
    modelSelect: { disabled: true },
    refreshBtn: { disabled: true },
    recordModeToggle: null,
    quitCallbacks: [],
    AudioVisualizer: function AudioVisualizer() {
      this.start = () => {};
      this.stop = () => {};
    },
    setupEventListeners: () => {},
    setupRecordingRecoveryUi: () => {},
    updateDiscardRecordingButtonVisibility: () => {},
    setRecordingState: (state) => { context.recordingState = state; },
    startTimer: () => {},
    startRecordingPresencePoll: () => {},
    formatElapsedDuration: () => '00:00',
    canHydratedRendererStopRecording: realCanHydratedRendererStopRecording,
    normalizeCaptureMode: realNormalizeCaptureMode,
    getRecordingSourceStatusText: realGetRecordingSourceStatusText,
    getIdleStatusPillText: realGetIdleStatusPillText,
    getRecordButtonLabel: realGetRecordButtonLabel,
    getRecordButtonAction,
    addLog: (message) => { context.logged.push(String(message)); },
    registerCleanup: (cleanup) => { context.cleanups.push(cleanup); },
    cleanups: [],
  };
  context.window = {
    electronAPI: {
      getRecordingState: mainProbe || (async () => ({ state: 'idle' })),
      getRecordingRecoveryState: recoveryProbe || (async () => ({ status: 'idle' })),
      onAppQuitProgress: (callback) => { context.quitCallbacks.push(callback); },
    },
  };
  vm.createContext(context);
  const sources = [
    extractBalancedSource(appSource, 'async function ensureRecordingHydration() {'),
    extractBalancedSource(appSource, 'async function hydrateRecordingStateFromMain() {'),
    extractBalancedSource(appSource, 'function isRecordingCommandAdmitted(action) {'),
    extractBalancedSource(appSource, 'function updateButtonUI() {'),
    extractBalancedSource(appSource, 'function updateControlsState() {'),
    `${extractBalancedSource(appSource, 'registerCleanup(window.electronAPI.onAppQuitProgress((payload) => {')}));`,
  ];
  vm.runInContext(sources.join('\n'), context);
  vm.runInContext('this.__ensure = ensureRecordingHydration; this.__admitted = isRecordingCommandAdmitted;', context);
  return context;
}

test('shipped hydration composition keeps Start blocked after a rejected capture probe', async () => {
  const context = createHydrationCompositionContext({
    mainProbe: async () => { throw new Error('probe down'); },
    recoveryProbe: async () => { throw new Error('recovery down'); },
  });
  const ensure = vm.runInContext('__ensure', context);
  const admitted = vm.runInContext('__admitted', context);

  // Deferred probe: admission closed while the authoritative query is in flight.
  let releaseProbe;
  const gated = createHydrationCompositionContext({
    mainProbe: () => new Promise((resolve) => { releaseProbe = () => resolve({ state: 'idle' }); }),
  });
  const gatedEnsure = vm.runInContext('__ensure', gated);
  const gatedAdmitted = vm.runInContext('__admitted', gated);
  const flight = gatedEnsure.call(gated);
  assert.equal(gatedAdmitted.call(gated, 'start'), false);
  assert.equal(gatedAdmitted.call(gated, 'stop'), false);
  releaseProbe();
  await flight;
  assert.equal(gated.recordingHydrated, true);
  // Real UI transition: the shipped updateButtonUI enables the Start control.
  assert.equal(gated.recordBtn.disabled, false);
  assert.equal(gated.micSelect.disabled, false);
  assert.equal(gatedAdmitted.call(gated, 'start'), true);

  // Rejected probe: gate stays closed, failure is surfaced, controls frozen.
  await ensure.call(context);
  assert.equal(context.recordingHydrated, false);
  assert.equal(admitted.call(context, 'start'), false);
  assert.equal(admitted.call(context, 'stop'), false);
  assert.equal(context.recordBtn.disabled, true);
  assert.ok(context.logged.some((line) => line.includes('Could not confirm whether a recording is in progress')));
});

test('shipped hydration composition admits capture despite recovery failures, then recovers', async () => {
  let recoveryCalls = 0;
  const context = createHydrationCompositionContext({
    mainProbe: async () => ({ state: 'idle' }),
    recoveryProbe: async () => {
      recoveryCalls += 1;
      if (recoveryCalls <= 2) {
        throw new Error(`recovery down (${recoveryCalls})`);
      }
      return { status: 'idle' };
    },
  });
  const ensure = vm.runInContext('__ensure', context);
  const admitted = vm.runInContext('__admitted', context);

  // Recovery fails but capture succeeds: admission opens (P1-B decoupling).
  await ensure.call(context);
  assert.equal(context.recordingHydrated, true);
  assert.equal(context.recordBtn.disabled, false);
  assert.equal(admitted.call(context, 'start'), true);
  assert.ok(context.logged.some((line) => line.includes('Could not check for interrupted recordings')));

  // Two failures then success across attempts: a later retry still recovers.
  let attempt = 0;
  const retryCtx = createHydrationCompositionContext({
    mainProbe: async () => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error('capture down');
      }
      return { state: 'idle' };
    },
    recoveryProbe: async () => { throw new Error('recovery down'); },
  });
  const retryEnsure = vm.runInContext('__ensure', retryCtx);
  const retryAdmitted = vm.runInContext('__admitted', retryCtx);
  await retryEnsure.call(retryCtx);
  assert.equal(retryCtx.recordingHydrated, false);
  assert.equal(retryAdmitted.call(retryCtx, 'start'), false);
  // Hydration failure resets the one-shot guard so the init finally can retry.
  assert.equal(retryCtx.hydratedCaptureState, false);
  await retryEnsure.call(retryCtx);
  assert.equal(retryCtx.recordingHydrated, true);
  assert.equal(retryAdmitted.call(retryCtx, 'start'), true);
  assert.ok(retryCtx.logged.some((line) => line.includes('Recording state confirmed')));
});

test('real quit-progress wiring closes and reopens admission with UI transitions', () => {
  const context = createHydrationCompositionContext({
    mainProbe: async () => ({ state: 'idle' }),
  });
  const admitted = vm.runInContext('__admitted', context);
  assert.equal(context.quitCallbacks.length, 1);
  const onQuitProgress = context.quitCallbacks[0];

  // Hydrated idle admits Start with an enabled control (mirrors init's
  // pre-hydration setRecordingState('idle') before the gate opens).
  context.recordingHydrated = true;
  context.recordingState = 'idle';
  vm.runInContext('updateButtonUI(); updateControlsState();', context);
  assert.equal(context.recordBtn.disabled, false);
  assert.equal(admitted.call(context, 'start'), true);

  // QUIT_RECORDING (emitted by the async recording-quit path) closes admission.
  onQuitProgress({ message: 'Stopping and saving the current recording before quitting...', code: 'QUIT_RECORDING' });
  assert.equal(context.rendererQuitCommitted, true);
  assert.equal(context.recordBtn.disabled, true);
  assert.equal(context.micSelect.disabled, true);
  assert.equal(admitted.call(context, 'start'), false);
  assert.equal(admitted.call(context, 'stop'), false);

  // QUIT_CANCELLED reopens admission without logging.
  const logsBefore = context.logged.length;
  onQuitProgress({ code: 'QUIT_CANCELLED', message: '' });
  assert.equal(context.rendererQuitCommitted, false);
  assert.equal(context.recordBtn.disabled, false);
  assert.equal(admitted.call(context, 'start'), true);
  assert.equal(context.logged.length, logsBefore);
});

test('AI status failure renders a single-flight inline retry', async () => {
  const appSource = readAppSource();
  assert.match(appSource, /ai-addon-retry-row/);
  assert.match(appSource, /retry-ai-addon-status-btn/);
  assert.match(appSource, /retryAiAddonStatusBtn\.addEventListener\('click'/);
  assert.match(appSource, /if \(aiAddonStatusRefreshPromise\) \{\s*\n?\s*return aiAddonStatusRefreshPromise;/);

  const html = readUtf8(path.join(ROOT, 'src', 'renderer', 'index.html'));
  assert.match(html, /id="ai-addon-retry-row"[^>]*hidden/);
  assert.match(html, /id="retry-ai-addon-status-btn"/);

  const start = appSource.indexOf('async function refreshAiAddonSettings() {');
  assert.notEqual(start, -1);
  const end = appSource.indexOf('\n}\n\nasync function refreshHomeAiAddonPrompt()', start);
  assert.notEqual(end, -1);
  const refreshSrc = appSource.slice(start, end + 2);
  const context = {
    aiAddonStatusRefreshPromise: null,
    aiAddonStatusSnapshot: null,
    getAiAddonStatusCalls: 0,
    failNext: true,
    logged: [],
    badges: [],
    retryHidden: [],
    console,
  };
  context.window = {
    electronAPI: {
      getAiAddonStatus: async () => {
        context.getAiAddonStatusCalls += 1;
        if (context.failNext) {
          throw new Error('status probe failed');
        }
        return { features: {} };
      },
    },
  };
  context.document = {
    getElementById: (id) => {
      if (id === 'ai-addons-status-badge') {
        return { id };
      }
      if (id === 'ai-addon-retry-row') {
        return {
          set hidden(value) { context.retryHidden.push(value); },
          get hidden() { return context.retryHidden[context.retryHidden.length - 1]; },
        };
      }
      return { id };
    },
  };
  context.addLog = (message) => context.logged.push(message);
  context.setStatusBadge = (badge, status) => context.badges.push(status);
  context.updateAiAddonSettings = () => {};
  context.updateHomeAiAddonCTA = () => {};
  vm.createContext(context);
  vm.runInContext(`${refreshSrc}\nthis.__refresh = refreshAiAddonSettings;`, context);
  const refresh = vm.runInContext('__refresh', context);

  // First read fails: error badge, visible retry.
  const first = await refresh.call(context);
  assert.equal(first, null);
  assert.ok(context.badges.includes('error'));
  assert.equal(context.retryHidden[context.retryHidden.length - 1], false);

  // Single-flight: two concurrent retries share one probe.
  context.failNext = false;
  context.getAiAddonStatusCalls = 0;
  const [a, b] = await Promise.all([refresh.call(context), refresh.call(context)]);
  assert.ok(a && b);
  assert.equal(context.getAiAddonStatusCalls, 1);
  assert.equal(context.retryHidden[context.retryHidden.length - 1], true);
});

test('settings listener setup binds the status retry button exactly once across repeated opens', () => {
  const appSource = readAppSource();
  const listenersById = new Map();
  const context = {
    aiAddonSettingsListenersBound: false,
    console,
    window: { electronAPI: {} },
    document: {
      getElementById: (id) => {
        if (!listenersById.has(id)) {
          listenersById.set(id, []);
        }
        return {
          id,
          addEventListener: (type) => { listenersById.get(id).push(type); },
        };
      },
      querySelectorAll: () => [],
    },
    registerCleanup: () => {},
  };
  vm.createContext(context);
  vm.runInContext(extractBalancedSource(appSource, 'function setupAiAddonSettingsListeners() {'), context);

  // Repeated Settings opens (first paint + every revisit) re-invoke setup.
  vm.runInContext('setupAiAddonSettingsListeners()', context);
  const afterFirst = new Map([...listenersById].map(([id, types]) => [id, [...types]]));
  vm.runInContext('setupAiAddonSettingsListeners(); setupAiAddonSettingsListeners()', context);

  // No listener growth on any control, and the retry button has exactly one click.
  assert.deepEqual(
    [...listenersById].map(([id, types]) => [id, [...types]]),
    [...afterFirst],
  );
  assert.deepEqual(listenersById.get('retry-ai-addon-status-btn'), ['click']);
});

test('AI Add-on Log keeps exactly 250 entries across single and multiline appends', () => {
  const appSource = readAppSource();
  const start = appSource.indexOf('function appendAiAddonLog(text) {');
  assert.notEqual(start, -1);
  const end = appSource.indexOf('\n}\n\nfunction shouldLogAiAddonProgress(', start);
  assert.notEqual(end, -1);
  const appendSrc = appSource.slice(start, end + 2);
  const context = {
    MAX_PROGRESS_LOG_ENTRIES: 250,
    logDiv: { style: {} },
    logOutput: { textContent: '', scrollTop: 0, scrollHeight: 0 },
    document: null,
    console,
  };
  context.document = {
    getElementById: (id) => {
      if (id === 'ai-addon-log') {
        return context.logDiv;
      }
      if (id === 'ai-addon-log-output') {
        return context.logOutput;
      }
      return null;
    },
  };
  vm.createContext(context);
  vm.runInContext(`${appendSrc}\nthis.__append = appendAiAddonLog;`, context);
  const append = vm.runInContext('__append', context);
  const physicalLines = () => {
    const parts = context.logOutput.textContent.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') {
      parts.pop();
    }
    return parts;
  };
  for (let index = 0; index < 251; index += 1) {
    vm.runInContext(`__append(${JSON.stringify(`entry-${index}`)})`, context);
  }
  assert.equal(physicalLines().length, 250);
  assert.match(physicalLines()[0], /entry-1/);
  assert.match(physicalLines()[249], /entry-250/);
  vm.runInContext('__append("line-a\\nline-b\\nline-c")', context);
  const afterMultiline = physicalLines();
  assert.equal(afterMultiline.length, 250);
  assert.match(afterMultiline[247], /line-a/);
  assert.match(afterMultiline[248], /line-b/);
  assert.match(afterMultiline[249], /line-c/);
  const timestamped = afterMultiline[249].match(/^\[(.+?)\] line-c$/);
  assert.ok(timestamped);
  assert.match(afterMultiline[247], new RegExp(`^\\[${timestamped[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] line-a$`));
});

test('removal confirmations and surfaced reasons use disable/enable wording', () => {
  const appSource = readAppSource();
  assert.match(appSource, /Disable and remove the local summary model from this device\?/);
  assert.doesNotMatch(appSource, /confirm\('Remove the local summary model/);
  const manifestSource = readUtf8(path.join(ROOT, 'src', 'ai-addon', 'manifest-store.js'));
  assert.match(manifestSource, /Disable and remove speaker identification setup, then enable it again\./);
  assert.doesNotMatch(manifestSource, /Remove and reinstall speaker identification setup/);
});
