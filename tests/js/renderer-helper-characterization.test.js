'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  ROOT,
  readUtf8,
  loadExtractedFunctions,
} = require('./source-scan-helpers');

const {
  getRecordButtonAction,
} = require('../../src/renderer/recording-state-helpers');

const APP_JS = path.join(ROOT, 'src', 'renderer', 'app.js');
const INDEX_HTML = path.join(ROOT, 'src', 'renderer', 'index.html');

const PURE_HELPER_NAMES = [
  'isMeetingTranscriptionRetryable',
  'getMeetingTranscriptionStatusMessage',
  'formatTimestamp',
  'formatStatusLabel',
  'formatBytes',
  'isAiAddonTerminalStatus',
  'isAiAddonProgressPhase',
  'formatAiAddonProgressText',
];

const EXPECTED_RENDERER_GLOBALS = [
  'recordingStateHelpers',
  'updateNotificationHelpers',
  'historyDetailHelpers',
];

const EXPECTED_SCRIPT_ORDER = [
  'recording-state-helpers.js',
  'update-notification-helpers.js',
  'history-detail-helpers.js',
  'app.js',
];

test('recording-state-helpers remain characterized for record-button gating', () => {
  assert.equal(getRecordButtonAction('idle'), 'start');
  assert.equal(getRecordButtonAction('recording'), 'stop');
  assert.equal(getRecordButtonAction('transcribing'), 'ignore');
});

test('pure app.js helpers characterize summary/AI gating without DOM access', () => {
  const appSource = readUtf8(APP_JS);
  const helpers = loadExtractedFunctions(appSource, PURE_HELPER_NAMES);

  assert.equal(helpers.isMeetingTranscriptionRetryable({ transcriptionStatus: 'failed' }), true);
  assert.equal(helpers.isMeetingTranscriptionRetryable({ transcriptionStatus: 'pending' }), true);
  assert.equal(helpers.isMeetingTranscriptionRetryable({ transcriptionStatus: 'completed' }), false);
  assert.equal(helpers.isMeetingTranscriptionRetryable(null), false);

  assert.equal(
    helpers.getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'failed', transcriptionError: 'boom' }),
    'Transcription failed: boom',
  );
  assert.equal(
    helpers.getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'pending' }),
    'This recording has not been transcribed yet.',
  );
  assert.equal(helpers.getMeetingTranscriptionStatusMessage({ transcriptionStatus: 'completed' }), '');

  assert.equal(helpers.formatTimestamp(65), '01:05');
  assert.equal(helpers.formatTimestamp(0), '00:00');

  assert.equal(helpers.formatStatusLabel('ready'), 'Ready');
  assert.equal(helpers.formatStatusLabel('needsAccount'), 'Needs account');
  assert.equal(helpers.formatStatusLabel('nope'), 'Unknown');

  assert.equal(helpers.formatBytes(0), '0 MB');
  assert.equal(helpers.formatBytes(1024), '1 KB');
  assert.equal(helpers.formatBytes(5 * 1024 * 1024), '5 MB');

  assert.equal(helpers.isAiAddonTerminalStatus('ready'), true);
  assert.equal(helpers.isAiAddonTerminalStatus('downloading'), false);
  assert.equal(helpers.isAiAddonProgressPhase({ phase: 'downloading' }), true);
  assert.equal(helpers.isAiAddonProgressPhase({ phase: 'idle' }), false);

  assert.equal(
    helpers.formatAiAddonProgressText({ message: 'Downloading', percent: 42 }),
    'Downloading 42%',
  );
  assert.match(
    helpers.formatAiAddonProgressText({
      message: 'Downloading',
      downloadedBytes: 1024,
      totalBytes: 2048,
      percent: 50,
    }),
    /Downloading 1 KB of 2 KB \(50%\)/,
  );
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
