'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const { ROOT, readUtf8 } = require('./source-scan-helpers');
const {
  buildWhisperRetryOptions,
} = require('../../src/renderer/transcription-engine-helpers');
const {
  isMeetingTranscriptionRetryable,
} = require('../../src/renderer/summary-ui-helpers');

const appSource = readUtf8(path.join(ROOT, 'src/renderer/app.js')).replace(/\r\n/g, '\n');

function extractBalancedSource(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, startMarker);
  const signatureEnd = source.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, startMarker);
  const open = signatureEnd + 2;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unbalanced braces after ${startMarker}`);
  return '';
}

function createClassList(initial = []) {
  const values = new Set(initial);
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    contains(value) { return values.has(value); },
    toggle(value, force) {
      if (force === undefined) {
        if (values.has(value)) values.delete(value);
        else values.add(value);
      } else if (force) {
        values.add(value);
      } else {
        values.delete(value);
      }
      return values.has(value);
    },
  };
}

function createNode({ hidden = false, value = '' } = {}) {
  return {
    hidden,
    value,
    textContent: '',
    disabled: false,
    style: {},
    attributes: {},
    classList: createClassList(),
    setAttribute(name, nextValue) { this.attributes[name] = String(nextValue); },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() {},
  };
}

test('renderTranscriptionEngineSettings reads and displays saved Whisper preferences', () => {
  const nodes = new Map([
    ['parakeet-engine-row', createNode()],
    ['use-parakeet-engine-toggle', createNode()],
    ['parakeet-status-badge', createNode()],
    ['transcription-active-engine-badge', createNode()],
    ['whisper-preferences-summary', createNode()],
    ['parakeet-status-text', createNode()],
  ]);
  const context = {
    document: { getElementById: (id) => nodes.get(id) || null },
    transcriptionEnginePreferences: {
      schemaVersion: 1,
      activeEngine: 'whisper',
      whisper: { language: 'fr', modelSize: 'medium' },
    },
    parakeetEngineStatus: { status: 'ready' },
    parakeetEngineOperation: null,
    parakeetSetupProgress: null,
    parakeetEngineOperationError: '',
    parakeetEngineSettingsBusy: false,
    parakeetSetupCancelRequested: false,
    formatBytes: (bytes) => String(bytes),
    languageSelect: { options: [{ value: 'fr', textContent: 'French' }] },
    modelSelect: { options: [{ value: 'medium', textContent: 'Medium' }] },
    ACTIVE_PARAKEET_UI_STATES: new Set(['downloading', 'verifying', 'waiting-for-validation', 'validating']),
    buildParakeetSettingsView: () => ({
      state: 'ready',
      activeUnavailable: false,
      activeEngine: 'whisper',
      statusLabel: 'Ready',
      statusText: 'Parakeet is ready.',
      progressText: '',
      progressPercent: null,
      downloadBytes: null,
      actions: [],
    }),
  };
  vm.createContext(context);
  vm.runInContext(
    extractBalancedSource(appSource, 'function renderTranscriptionEngineSettings() {'),
    context,
  );

  assert.doesNotThrow(() => context.renderTranscriptionEngineSettings());
  assert.equal(nodes.get('whisper-preferences-summary').textContent, 'French · Medium');
});

test('renderTranscriptionEngineSettings gates and reflects the Parakeet switch', () => {
  const cases = [
    { name: 'Whisper with Parakeet not installed', activeEngine: 'whisper', state: 'not-installed', actions: ['setup'], checked: false, disabled: true },
    { name: 'Whisper while status is checking', activeEngine: 'whisper', state: 'checking', actions: [], checked: false, disabled: true },
    { name: 'Whisper with Parakeet ready', activeEngine: 'whisper', state: 'ready', actions: ['use-parakeet'], checked: false, disabled: false },
    { name: 'Parakeet selected while checking', activeEngine: 'parakeet', state: 'checking', actions: ['use-whisper'], checked: true, disabled: false },
    { name: 'Parakeet selected but GPU unavailable', activeEngine: 'parakeet', state: 'device-unavailable', actions: ['recheck', 'use-whisper'], checked: true, disabled: false },
    { name: 'Parakeet selected and repair is required', activeEngine: 'parakeet', state: 'repair-required', actions: ['repair', 'remove', 'use-whisper'], checked: true, disabled: false },
    { name: 'Parakeet selected with unknown status', activeEngine: 'parakeet', state: 'unknown', actions: ['recheck', 'use-whisper'], checked: true, disabled: false },
    { name: 'Parakeet removal is in progress', activeEngine: 'parakeet', state: 'removing', actions: [], busy: true, checked: true, disabled: true },
    { name: 'Parakeet settings are busy while ready', activeEngine: 'parakeet', state: 'ready', actions: ['use-whisper'], busy: true, checked: true, disabled: true },
  ];
  const rendererSource = extractBalancedSource(
    appSource,
    'function renderTranscriptionEngineSettings() {',
  );

  for (const scenario of cases) {
    const nodes = new Map([
      ['parakeet-engine-row', createNode()],
      ['use-parakeet-engine-toggle', createNode()],
      ['parakeet-status-text', createNode()],
    ]);
    const context = {
      document: { getElementById: (id) => nodes.get(id) || null },
      transcriptionEnginePreferences: {
        schemaVersion: 1,
        activeEngine: scenario.activeEngine,
        whisper: { language: 'en', modelSize: 'small' },
      },
      parakeetEngineStatus: { status: scenario.state },
      parakeetEngineOperation: scenario.state === 'removing' ? 'remove' : null,
      parakeetSetupProgress: null,
      parakeetEngineOperationError: '',
      parakeetEngineSettingsBusy: Boolean(scenario.busy),
      parakeetSetupCancelRequested: false,
      formatBytes: (bytes) => String(bytes),
      ACTIVE_PARAKEET_UI_STATES: new Set(['downloading', 'verifying', 'waiting-for-validation', 'validating']),
      buildParakeetSettingsView: ({ activeEngine }) => ({
        state: scenario.state,
        activeUnavailable: activeEngine === 'parakeet'
          && !['ready', 'checking'].includes(scenario.state),
        activeEngine,
        statusLabel: scenario.state,
        statusText: `Parakeet ${scenario.state}`,
        progressText: '',
        progressPercent: null,
        downloadBytes: null,
        actions: scenario.actions,
      }),
    };
    vm.createContext(context);
    vm.runInContext(rendererSource, context);
    context.renderTranscriptionEngineSettings();

    const toggle = nodes.get('use-parakeet-engine-toggle');
    assert.equal(toggle.checked, scenario.checked, scenario.name);
    assert.equal(toggle.disabled, scenario.disabled, scenario.name);
  }
});

test('Whisper retry dismisses its dialog while the job continues and does not steal navigation', async () => {
  const deferred = {};
  const pendingRetry = new Promise((resolve) => { deferred.resolve = resolve; });
  const ids = [
    'whisper-retry-modal',
    'whisper-retry-language',
    'whisper-retry-model',
    'whisper-retry-error',
    'whisper-retry-submit-btn',
    'whisper-retry-cancel-btn',
    'retry-whisper-transcription-btn',
    'history-tab',
  ];
  const nodes = new Map(ids.map((id) => [id, createNode({
    hidden: id === 'whisper-retry-error',
    value: id === 'whisper-retry-language' ? 'fr' : (id === 'whisper-retry-model' ? 'medium' : ''),
  })]));
  const modal = nodes.get('whisper-retry-modal');
  modal.classList.add('open');
  const meeting = { id: 'meeting-1', title: 'Design sync', transcriptionStatus: 'failed' };
  const calls = [];
  const logs = [];
  let historyLoads = 0;
  let selectedMeetings = 0;
  const context = {
    document: { getElementById: (id) => nodes.get(id) || null },
    window: {
      electronAPI: {
        retryTranscription(options) {
          calls.push(options);
          return pendingRetry;
        },
      },
    },
    whisperRetryMeetingId: 'meeting-1',
    whisperRetryBusy: false,
    transcriptionEnginePreferences: {
      schemaVersion: 1,
      activeEngine: 'parakeet',
      whisper: { language: 'en', modelSize: 'small' },
    },
    currentMeetingId: 'another-meeting',
    parakeetEngineStatus: { status: 'ready' },
    parakeetEngineOperation: null,
    parakeetSetupProgress: null,
    parakeetEngineOperationError: '',
    parakeetEngineSettingsBusy: false,
    parakeetSetupCancelRequested: false,
    ACTIVE_PARAKEET_UI_STATES: new Set(['downloading', 'verifying', 'waiting-for-validation', 'validating']),
    languageSelect: { options: [{ value: 'fr', textContent: 'French' }] },
    modelSelect: { options: [{ value: 'medium', textContent: 'Medium' }] },
    buildParakeetSettingsView: () => ({
      state: 'ready',
      activeUnavailable: false,
      activeEngine: 'parakeet',
      statusLabel: 'Ready',
      statusText: 'Parakeet is ready.',
      progressText: '',
      progressPercent: null,
      downloadBytes: null,
      actions: [],
    }),
    formatBytes: (bytes) => String(bytes),
    findMeetingById: (id) => (id === meeting.id ? meeting : null),
    isMeetingTranscriptionRetryable,
    validateNewTranscriptionSelection: (language, modelSize) => ({
      ok: true, language, modelSize,
    }),
    persistTranscriptionEnginePreferences(updates) {
      context.transcriptionEnginePreferences.whisper = updates.whisper;
      context.renderTranscriptionEngineSettings();
    },
    buildWhisperRetryOptions,
    addLog: (message) => logs.push(message),
    syncMeetingInList() {},
    loadMeetingHistory: async () => { historyLoads += 1; },
    selectMeeting: async () => { selectedMeetings += 1; },
    console,
  };
  vm.createContext(context);
  const completionSource = appSource.includes('async function completeWhisperRetry(')
    ? extractBalancedSource(appSource, 'async function completeWhisperRetry(')
    : '';
  vm.runInContext([
    extractBalancedSource(appSource, 'function closeWhisperRetryDialog('),
    extractBalancedSource(appSource, 'function renderTranscriptionEngineSettings() {'),
    completionSource,
    extractBalancedSource(appSource, 'async function retryMeetingTranscriptionWithWhisper('),
  ].filter(Boolean).join('\n'), context);

  const backgroundJob = context.retryMeetingTranscriptionWithWhisper('meeting-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].transcriptionSelection.engine, 'whisper');
  assert.equal(nodes.get('whisper-preferences-summary').textContent, 'French · Medium');
  assert.equal(modal.classList.contains('hidden'), true);
  assert.equal(nodes.get('whisper-retry-cancel-btn').disabled, false);
  assert.equal(context.whisperRetryBusy, false);
  assert.ok(logs.some((entry) => /Activity/.test(entry)));

  deferred.resolve({ meeting });
  await backgroundJob;
  assert.ok(historyLoads > 0);
  assert.equal(selectedMeetings, 0);
});
