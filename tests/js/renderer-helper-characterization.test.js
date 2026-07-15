'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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
  'canvasHelpers',
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
  'canvas-helpers.js',
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
  'formatAiAddonProgressText',
  'clearElement',
  'meetingIdsEqual',
  'isGpuRuntimeActionBusyError',
  'formatGpuRuntimeBusyAlertMessage',
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
  const appSource = readUtf8(APP_JS);
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
  const appSource = readUtf8(APP_JS);
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
