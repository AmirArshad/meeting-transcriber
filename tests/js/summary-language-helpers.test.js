'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  reusableSummaryLanguage,
  resolveLanguageDisplayName,
  formatTranscriptLanguageCaption,
  formatSummaryLanguageCaption,
} = require('../../src/renderer/summary-language-helpers');
const { getSummaryLanguagePolicy, SUMMARY_LANGUAGE_NAMES } = require('../../src/summary-language-policy');
const { meetingIdsEqual } = require('../../src/renderer/meeting-helpers');
const modelId = 'qwen3.5-9b-q4-k-m';
const policy = getSummaryLanguagePolicy(modelId, 'win32', 'x64');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractTopLevelFunctionSource } = require('./source-scan-helpers');

test('checked language policy retains product languages and rejects replacements and unsupported runtimes', () => {
  assert.deepEqual(policy.languages, ['en', 'es', 'fr', 'de', 'zh', 'ja', 'it', 'pa', 'hi', 'ko', 'pt']);
  assert.equal(policy.languages.includes('fa'), false);
  for (const id of ['unknown', 'qwen3.5-4b-q4-k-m', 'qwen3-14b-q4-k-m']) {
    assert.deepEqual(getSummaryLanguagePolicy(id, 'win32', 'x64').languages, []);
  }
  assert.deepEqual(getSummaryLanguagePolicy(modelId, 'darwin', 'x64').languages, []);
  assert.deepEqual(getSummaryLanguagePolicy(modelId, 'linux', 'x64').languages, policy.languages);
  for (const id of ['gemma-4-e4b', 'gemma-4-12b']) {
    assert.deepEqual(getSummaryLanguagePolicy(id, 'darwin', 'arm64').languages, ['en']);
    assert.deepEqual(getSummaryLanguagePolicy(id, 'linux', 'x64').languages, []);
  }
});

test('real composition-root CLI builder propagates language and hash without changing setup validation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const context = vm.createContext({ process: { platform: 'win32', arch: 'x64' }, getBackendModuleArgs: (name, args) => ['-m', name, ...args] });
  vm.runInContext(extractTopLevelFunctionSource(source, 'buildSummaryArgs'), context);
  const args = context.buildSummaryArgs({ meetingId: 'id', transcriptPath: 'meeting.md', runtimeDir: 'runtime', modelPath: 'model.gguf', modelId, transcriptLanguage: 'es', sourceTranscriptHash: 'sha256:fixture' });
  assert.equal(args[args.indexOf('--language') + 1], 'es');
  assert.equal(args[args.indexOf('--source-transcript-hash') + 1], 'sha256:fixture');
  assert.equal(args[args.indexOf('--model-id') + 1], modelId);
  const validation = context.buildSummaryArgs({ meetingId: 'setup', runtimeDir: 'runtime', modelPath: 'model.gguf', validateRuntime: true });
  assert.ok(validation.includes('--validate-runtime'));
  assert.equal(validation.includes('--language'), false);
  assert.equal(validation.includes(undefined), false);
});

test('confirmation belongs to unchanged transcript, model and policy; legacy output is unconfirmed', () => {
  const summary = { language: 'es', languageSource: 'userConfirmed', sourceTranscriptHash: 'hash', modelId, languagePolicyVersion: policy.version };
  assert.equal(reusableSummaryLanguage({ ai: { summary } }, 'hash', policy), 'es');
  assert.equal(reusableSummaryLanguage({ ai: { summary } }, 'new-hash', policy), null);
  assert.equal(reusableSummaryLanguage({}, 'hash', policy), null);
  for (const [key, value] of Object.entries({ language: 'fa', languageSource: null, modelId: 'other', languagePolicyVersion: 'old' })) {
    assert.equal(reusableSummaryLanguage({ ai: { summary: { ...summary, [key]: value } } }, 'hash', policy), null);
  }
});

function buildDialogElements(onFocus) {
  const elements = {};
  for (const id of [
    'summary-language-modal', 'summary-transcript-language', 'summary-language-form',
    'summary-language-cancel', 'summary-language-confirm', 'summary-language-message',
    'summary-speaker-fieldset', 'summary-speaker-rows', 'summary-recording-type',
    'summary-recording-tag', 'summary-format-preview',
  ]) {
    const listeners = new Map();
    elements[id] = {
      value: '', disabled: false, children: [], hidden: true,
      replaceChildren(...children) { this.children = children; },
      appendChild(child) { this.children.push(child); },
      add(child) { this.appendChild(child); },
      closest() { return null; },
      focus() { onFocus(id, this); },
      classList: { add() { elements[id].hidden = true; }, remove() { elements[id].hidden = false; } },
      addEventListener(event, listener) { listeners.set(event, listener); },
      removeEventListener(event) { listeners.delete(event); },
      dispatch(event, options = {}) {
        return listeners.get(event)?.({ preventDefault() {}, stopPropagation() {}, ...options });
      },
      listeners,
    };
  }
  elements['summary-language-modal'].querySelectorAll = () => [
    elements['summary-transcript-language'],
    elements['summary-language-cancel'],
    elements['summary-language-confirm'],
  ].filter((element) => !element.disabled);
  return elements;
}

const prepareSummaryDialogGlobals = {
  ...require('../../src/renderer/tag-helpers'),
  ...require('../../src/renderer/speaker-label-helpers'),
  ...require('../../src/renderer/summary-ui-helpers'),
  ...require('../../src/renderer/history-detail-helpers'),
  Option: class { constructor(label, value) { Object.assign(this, { label, value }); } },
  AbortController,
  meetingIdsEqual,
  stopSpeakerPreview: null,
  historySpeakers: null,
};

function createDialogHarness() {
  const focused = [];
  const elements = buildDialogElements((id, element) => {
    focused.push(id);
    context.document.activeElement = element;
  });
  const priorFocus = { isConnected: true, focus() { focused.push('prior'); } };
  const context = vm.createContext({
    ...prepareSummaryDialogGlobals,
    document: { getElementById: (id) => elements[id], createElement: () => ({}), activeElement: priorFocus },
    currentMeetingId: null,
    closeSummaryLanguageConfirmation: null,
  });
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  const dialogSource = source.slice(source.indexOf('function confirmSummaryTranscriptLanguage('), source.indexOf('async function generateSummaryForMeeting('));
  vm.runInContext(dialogSource, context);
  return { context, elements, focused };
}

test('real confirmation dialog prefills meeting language, explains unavailability, and cleans up on cancellation', async () => {
  const { context, elements, focused } = createDialogHarness();
  const pending = context.confirmSummaryTranscriptLanguage({ language: 'es' }, { ...policy, languages: ['en'] });
  assert.equal(elements['summary-transcript-language'].value, 'es');
  assert.equal(elements['summary-language-confirm'].disabled, true);
  assert.match(elements['summary-language-message'].textContent, /not available for Spanish/);
  elements['summary-language-form'].dispatch('submit');
  assert.equal(elements['summary-language-modal'].hidden, false);
  elements['summary-language-modal'].dispatch('keydown', { key: 'Escape' });
  assert.equal(await pending, null);
  assert.equal(elements['summary-language-modal'].hidden, true);
  assert.equal(elements['summary-language-form'].listeners.size, 0);
  assert.equal(context.closeSummaryLanguageConfirmation, null);
  assert.equal(focused.at(-1), 'prior');
});

test('real dialog accepts only explicit supported submission and traps focus', async () => {
  const { context, elements } = createDialogHarness();
  const pending = context.confirmSummaryTranscriptLanguage({ language: 'unknown' }, policy);
  assert.equal(elements['summary-transcript-language'].value, '');
  assert.equal(elements['summary-language-confirm'].disabled, true);
  elements['summary-transcript-language'].value = 'es';
  elements['summary-transcript-language'].dispatch('change');
  assert.match(elements['summary-language-message'].textContent, /Summary will use Spanish/);
  elements['summary-language-confirm'].focus();
  elements['summary-language-modal'].dispatch('keydown', { key: 'Tab' });
  assert.equal(context.document.activeElement, elements['summary-transcript-language']);
  elements['summary-language-form'].dispatch('submit');
  assert.equal(await pending, 'es');
});

const prepareMeeting = {
  id: 'meeting-a',
  language: 'en',
  transcript: '**Speaker 1:** Hello\n**Speaker 2:** Hi',
  transcriptionResult: { attemptId: 'attempt-1' },
};

function createPrepareSaveHarness(updateMeeting, withHistorySpeakers) {
  const { context, elements } = createDialogHarness();
  const historyFields = new Map([['Speaker 1', { value: '' }], ['Speaker 2', { value: 'old draft' }]]);
  const refreshed = [];
  elements['meeting-tag-btn'] = {};
  elements['meeting-tag-btn-label'] = {};
  Object.assign(context, {
    window: { electronAPI: { updateMeeting } },
    currentMeetingId: prepareMeeting.id,
    meetingTagMutationVersions: new Map([[prepareMeeting.id, 1]]),
    historySpeakers: withHistorySpeakers ? {
      meeting: prepareMeeting,
      names: {},
      requestedNames: new Map([['Speaker 1', ''], ['Speaker 2', 'old draft']]),
      fields: historyFields,
      samples: [{ speaker: 'Speaker 1' }, { speaker: 'Speaker 2' }],
    } : null,
    buildSpeakerRow: (prefix, sample) => {
      const field = { value: '' };
      return { row: { speaker: sample.speaker, field }, field };
    },
    syncMeetingInList: (updated) => refreshed.push(['meeting', updated.id]),
    applyTagPillView: (button, label, tag) => {
      assert.equal(button, elements['meeting-tag-btn']);
      assert.equal(label, elements['meeting-tag-btn-label']);
      refreshed.push(['tag', tag]);
    },
    updateHistorySpeakerLabels: (state, updated) => refreshed.push(['speakers', state.names, updated.id]),
    updateSummaryTagMismatchBanner: (updated) => refreshed.push(['banner', updated.id]),
    setHistorySpeakersExpanded: (expanded) => refreshed.push(['expanded', expanded]),
    renderHistoryTagFilterBar: () => refreshed.push(['filters']),
    renderActivityList: () => refreshed.push(['activity']),
    chatState: { popoverOpen: true },
    renderScopePopover: () => refreshed.push(['scope']),
    meetingSearchQuery: 'Alice',
    meetingSearchQueryNormalized: '',
    meetingSearchDebounceTimer: 9,
    clearTimeout: (timer) => refreshed.push(['clear', timer]),
    runHistorySearch: (query) => refreshed.push(['search', query]),
  });
  const pending = context.confirmSummaryTranscriptLanguage(prepareMeeting, policy, 'en', 'transcript-hash');
  const rows = elements['summary-speaker-rows'].children;
  elements['summary-recording-tag'].value = 'interview';
  return { context, elements, pending, rows, historyFields, refreshed };
}

test('Prepare summary retries a failed save and synchronizes History fields and tag consumers', async () => {
  const requests = [];
  const names = { 'Speaker 1': 'Alice', 'Speaker 2': 'Bob' };
  const { context, elements, pending, rows, historyFields, refreshed } = createPrepareSaveHarness(async (id, patch) => {
    requests.push([id, JSON.parse(JSON.stringify(patch))]);
    if (requests.length === 1) throw new Error('save failed');
    return { id, tag: patch.tag, ai: { diarization: { speakerNames: names } } };
  }, true);
  rows[0].field.value = ' Alice ';
  rows[1].field.value = 'Bob';
  await elements['summary-language-form'].dispatch('submit');
  assert.equal(elements['summary-language-modal'].hidden, false);
  assert.equal(elements['summary-language-confirm'].disabled, false);
  assert.match(elements['summary-language-message'].textContent, /Could not save recording details/);
  assert.equal(rows[0].field.value, ' Alice ');
  assert.deepEqual(refreshed, []);

  await elements['summary-language-form'].dispatch('submit');
  assert.equal(await pending, 'en');
  const expectedPatch = {
    speakerNames: names,
    tag: 'interview',
    expectedSourceTranscriptHash: 'transcript-hash',
    expectedTranscriptionAttemptId: 'attempt-1',
  };
  assert.deepEqual(requests, [[prepareMeeting.id, expectedPatch], [prepareMeeting.id, expectedPatch]]);
  assert.equal(context.meetingTagMutationVersions.get(prepareMeeting.id), 2);
  for (const [speaker, field] of historyFields) {
    assert.equal(field.value, names[speaker]);
    assert.equal(context.historySpeakers.requestedNames.get(speaker), names[speaker]);
  }
  assert.equal(context.meetingSearchDebounceTimer, null);
  assert.deepEqual(refreshed, [
    ['meeting', prepareMeeting.id], ['tag', 'interview'], ['speakers', names, prepareMeeting.id],
    ['expanded', false], ['filters'], ['activity'], ['scope'], ['clear', 9], ['search', 'Alice'],
  ]);
});

test('Prepare summary refreshes the tag pill and filters when the History speaker bar is absent', async () => {
  const { elements, pending, refreshed } = createPrepareSaveHarness(async (id, patch) => {
    assert.deepEqual(Object.keys(patch), ['tag']);
    return { id, tag: patch.tag };
  }, false);
  await elements['summary-language-form'].dispatch('submit');
  assert.equal(await pending, 'en');
  assert.deepEqual(refreshed, [
    ['meeting', prepareMeeting.id], ['tag', 'interview'], ['banner', prepareMeeting.id],
    ['filters'], ['activity'], ['scope'], ['clear', 9], ['search', 'Alice'],
  ]);
});

test('a Prepare summary save settling after cancellation leaves the reopened dialog alone', async () => {
  for (const fail of [false, true]) {
    let settle;
    const { context, elements, pending, refreshed } = createPrepareSaveHarness((id) =>
      new Promise((resolve, reject) => {
        settle = () => fail ? reject(new Error('late failure')) : resolve({ id, tag: 'interview' });
      }), false);
    const saving = elements['summary-language-form'].dispatch('submit');
    elements['summary-language-cancel'].dispatch('click');
    assert.equal(await pending, null);
    const reopened = context.confirmSummaryTranscriptLanguage(prepareMeeting, policy, 'es', 'transcript-hash');
    const message = elements['summary-language-message'].textContent;
    settle();
    await saving;
    assert.equal(elements['summary-language-modal'].hidden, false);
    assert.equal(elements['summary-language-message'].textContent, message);
    assert.deepEqual(refreshed, []);
    elements['summary-language-cancel'].dispatch('click');
    assert.equal(await reopened, null);
  }
});

test('Prepare summary skips allocating preview audio when all speakers are named', async () => {
  const { context, elements } = createDialogHarness();
  context.Audio = class { constructor() { assert.fail('Preview audio should stay unloaded'); } };
  const pending = context.confirmSummaryTranscriptLanguage({
    ...prepareMeeting,
    audioPath: 'recording.opus',
    ai: { diarization: { speakerNames: { 'Speaker 1': 'Alice', 'Speaker 2': 'Bob' } } },
  }, policy, 'en', 'transcript-hash');
  assert.equal(elements['summary-speaker-fieldset'].hidden, true);
  elements['summary-language-cancel'].dispatch('click');
  assert.equal(await pending, null);
});

function loadRendererFunctions(globals, ...names) {
  const context = vm.createContext(globals);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  for (const name of names) vm.runInContext(extractTopLevelFunctionSource(source, name), context);
  return context;
}

test('History speaker blur and Escape respect the latest committed field state', async () => {
  const ids = ['bar', 'rows', 'status', 'heading', 'toggle'];
  const nodes = Object.fromEntries(ids.map((id) => [id, new EventTarget()]));
  const fields = new Map();
  const expanded = [];
  const requests = [];
  const meeting = { id: 'recording', transcript: 'Hello' };
  const names = {};
  const outside = {};
  const context = loadRendererFunctions({
    ...prepareSummaryDialogGlobals,
    historySpeakers: null,
    document: {
      getElementById: (id) => nodes[id.replace('history-speaker-', '')],
      activeElement: outside,
    },
    buildSpeakerRow: (_, { speaker }) => {
      const field = Object.assign(new EventTarget(), { value: '' });
      fields.set(speaker, field);
      return { row: field, field };
    },
    window: { electronAPI: { updateMeeting: async (_, { speakerNames }) => {
      requests.push(speakerNames);
      Object.assign(names, speakerNames);
      return { ...meeting, ai: { diarization: { speakerNames: { ...names } } } };
    } } },
    hashSummaryTranscript: async () => 'hash',
    syncMeetingInList() {},
    updateHistorySpeakerLabels() {},
    meetingSearchQueryNormalized: '',
    setHistorySpeakersExpanded(value) {
      context.historySpeakers.expanded = value;
      expanded.push(value);
    },
  }, 'clearHistorySpeakers', 'renderHistorySpeakers');
  Object.assign(nodes.rows, {
    replaceChildren() {},
    appendChild() {},
    contains: (element) => [...fields.values()].includes(element),
  });
  context.renderHistorySpeakers(meeting, [{ speaker: 'Speaker 1', text: 'Hello' }]);
  const field = fields.get('Speaker 1');
  const keydown = (key) => field.dispatchEvent(Object.assign(new Event('keydown'), { key }));
  context.document.activeElement = field;
  field.value = 'Alice';
  keydown('Enter');
  await new Promise(setImmediate);
  assert.equal(context.historySpeakers.requestedNames.get('Speaker 1'), 'Alice');
  assert.deepEqual(expanded, [true]);

  field.value = 'Discard this draft';
  keydown('Escape');
  assert.equal(field.value, 'Alice');
  assert.equal(nodes.status.textContent, '');
  context.document.activeElement = outside;
  nodes.rows.dispatchEvent(Object.assign(new Event('focusout'), { relatedTarget: outside }));
  field.dispatchEvent(Object.assign(new Event('blur'), { relatedTarget: outside }));
  assert.deepEqual(expanded, [true, false]);
  assert.equal(requests.length, 1);
});

test('speaker preview ignores a queued pause and pre-seek updates, then stops at the fallback bound', async () => {
  const player = new EventTarget();
  player.currentTime = 99;
  player.pause = () => {};
  let resolvePlay;
  player.play = () => new Promise((resolve) => { resolvePlay = resolve; });
  let afterSeek;
  const context = loadRendererFunctions({
    stopSpeakerPreview: null,
    historySpeakers: null,
    pendingAudioSeekCleanup: null,
    document: { getElementById: () => null },
    seekMeetingAudio(_, options) { afterSeek = options.afterSeek; },
  }, 'playSpeakerSample', 'clearHistorySpeakers');
  const pressed = [];
  const button = { getAttribute: () => 'false' };
  const preview = (endSec) => context.playSpeakerSample(button, player, { startSec: 8, endSec }, (value) => pressed.push(value));
  preview(9);
  preview(8);
  player.dispatchEvent(new Event('timeupdate'));
  player.currentTime = 8;
  const playing = afterSeek();
  player.dispatchEvent(new Event('pause'));
  resolvePlay();
  await playing;
  player.currentTime = 12.99;
  player.dispatchEvent(new Event('timeupdate'));
  assert.deepEqual(pressed, [true, false, true]);
  player.currentTime = 13;
  player.dispatchEvent(new Event('timeupdate'));
  assert.equal(pressed.at(-1), false);

  pressed.length = 0;
  context.playSpeakerSample(button, player, { startSec: 10, endSec: 55 }, (value) => pressed.push(value));
  player.currentTime = 10;
  const capped = afterSeek();
  resolvePlay();
  await capped;
  player.currentTime = 21.99;
  player.dispatchEvent(new Event('timeupdate'));
  assert.deepEqual(pressed, [true]);
  player.currentTime = 22;
  player.dispatchEvent(new Event('timeupdate'));
  assert.deepEqual(pressed, [true, false]);

  preview(undefined);
  context.clearHistorySpeakers();
  assert.equal(pressed.at(-1), false);
  assert.equal(context.stopSpeakerPreview, null);
});

test('buildSpeakerRow wraps the preview button with a Sample label and updated aria-label', () => {
  const createElement = (tag) => {
    const attrs = new Map();
    return {
      tagName: tag.toUpperCase(),
      className: '',
      children: [],
      attributes: attrs,
      append(...nodes) { this.children.push(...nodes); },
      appendChild(node) { this.children.push(node); return node; },
      setAttribute(name, value) { attrs.set(name, String(value)); },
      getAttribute(name) { return attrs.get(name) ?? null; },
      addEventListener() {},
    };
  };
  const player = Object.assign(new EventTarget(), {
    error: null,
    getAttribute: (name) => (name === 'src' ? 'file:///recording.opus' : null),
  });
  const context = loadRendererFunctions({
    document: { createElement },
    formatJumpTimestamp: (sec) => `00:${String(sec).padStart(2, '0')}`,
    playSpeakerSample() {},
  }, 'buildSpeakerRow');
  const { row } = context.buildSpeakerRow(
    'history',
    { speaker: 'Speaker 1', excerpt: 'Hello there', startSec: 12, endSec: 18 },
    {},
    player,
    new AbortController().signal,
  );
  const control = row.children.find((child) => child.className === 'speaker-preview-control');
  assert.ok(control);
  assert.equal(control.children.length, 2);
  const [button, label] = control.children;
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.className, 'btn btn-small speaker-preview');
  assert.equal(button.getAttribute('aria-label'), 'Play voice sample for Speaker 1 at 00:12');
  assert.equal(button.textContent, '▶ 00:12');
  assert.equal(label.tagName, 'SPAN');
  assert.equal(label.className, 'speaker-preview-label');
  assert.equal(label.getAttribute('aria-hidden'), 'true');
  assert.equal(label.textContent, 'Sample');
});

test('Name speakers refreshes the selected recording before focus and respects a changed selection', async () => {
  const calls = [];
  let resolveRefresh;
  const context = loadRendererFunctions({
    currentMeetingId: '1',
    meetingIdsEqual,
    findMeetingById: () => true,
    activateTab() {},
    activateHistoryDetailTab() {},
    selectMeeting: () => assert.fail('Already selected'),
    refreshMeetingDetails: () => new Promise((resolve) => { resolveRefresh = resolve; }),
    focusHistorySpeaker: (speaker) => calls.push(speaker),
    historySpeakers: { samples: [{ speaker: 'Speaker 1' }], names: {} },
  }, 'openHistorySpeakerNames');
  const opening = context.openHistorySpeakerNames(1);
  assert.deepEqual(calls, []);
  context.historySpeakers = { samples: [{ speaker: 'Speaker 2' }], names: {} };
  resolveRefresh();
  await opening;
  assert.deepEqual(calls, ['Speaker 2']);

  const changing = context.openHistorySpeakerNames(1);
  context.currentMeetingId = '2';
  resolveRefresh();
  await changing;
  assert.deepEqual(calls, ['Speaker 2']);
});

test('replacing a completion toast cleans up focusout and Name speakers hides it before navigation', () => {
  const timers = new Map();
  const listeners = new Map();
  const button = {};
  const toast = {
    classList: { add() {}, remove() {} },
    contains: (element) => element === button,
    addEventListener: (name, listener) => listeners.set(listener, name),
    removeEventListener: (_, listener) => listeners.delete(listener),
  };
  const opened = [];
  const context = loadRendererFunctions({
    document: {
      getElementById: (id) => ({
        'activity-completion-toast': toast, 'activity-completion-name-speakers': button,
      }[id]),
      activeElement: button,
    },
    buildCompletionToastView: () => ({ visible: true }),
    setTimeout(callback) {
      const id = Symbol();
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    openHistorySpeakerNames(id) {
      assert.equal(toast.hidden, true);
      assert.equal(timers.size, 0);
      assert.equal(listeners.size, 0);
      opened.push(id);
    },
  }, 'showCompletionToast');
  for (const meetingId of ['old', 'new']) {
    context.showCompletionToast({ meetingId, speakerCount: 1 });
    assert.equal(listeners.size, 0);
    timers.get(context.showCompletionToast._timer)();
    assert.equal(listeners.size, 1);
  }
  button.onclick();
  assert.deepEqual(opened, ['new']);
  assert.equal(context.showCompletionToast._timer, null);
});

test('a ready Activity row can name speakers from the queue even with completed recording metadata', () => {
  const created = [];
  const createElement = () => {
    const element = {
      classList: { add() {} }, dataset: {},
      append() {}, appendChild() {}, setAttribute() {}, addEventListener() {},
    };
    created.push(element);
    return element;
  };
  const row = { meetingId: '1', status: 'ready', title: 'Recording', actions: [] };
  const context = loadRendererFunctions({
    document: { createElement },
    activityListEl: createElement(),
    transcriptionQueueState: { jobs: [{ meetingId: 1, speakerCount: 2 }] },
    meetings: [],
    buildActivityRows: () => [row],
    shouldRestoreInlineEditorFocus: () => false,
    activeOpenTagPopover: null,
    activityActionBusyMeetingId: null,
    activityRenameMeetingId: null,
    findMeetingById: () => ({ transcriptionStatus: 'completed' }),
    applyTagPillView() {},
    clearElement() {},
    updateResumePendingBanner() {},
    refreshIdleStatusPill() {},
    updateSoftQueueDepthWarning() {},
    updateBackgroundTranscriptionTip() {},
    restoreInlineTitleEditorFocus() {},
  }, 'renderActivityList');
  context.renderActivityList();
  assert.ok(created.some(({ textContent }) => textContent === 'Name speakers'));
  created.length = 0;
  row.status = 'pending';
  context.renderActivityList();
  assert.ok(!created.some(({ textContent }) => textContent === 'Name speakers'));
});

test('single and bulk deletion clear the selected speaker bar and stop its preview', async () => {
  for (const deleteMethod of ['deleteMeetingHandler', 'deleteCheckedMeetings']) {
    const meetingId = 'recording';
    const bar = { hidden: false };
    let stopped = false;
    const controller = new AbortController();
    const context = loadRendererFunctions({
      meetingIdsEqual,
      currentMeetingId: meetingId,
      meetings: [{ id: meetingId }],
      checkedMeetingIds: new Set([meetingId]),
      meetingDetails: { style: {} },
      window: { electronAPI: { deleteMeeting: async (id) => assert.equal(id, meetingId) } },
      document: { getElementById: (id) => id === 'history-speaker-bar' ? bar : { style: {} } },
      findMeetingById: () => ({ id: meetingId }),
      confirm: () => true,
      setTimeout: (callback) => callback(),
      addLog() {},
      renderMeetingList() {},
      loadMeetingHistory: async () => {},
      historySpeakers: { controller },
      stopSpeakerPreview: () => { stopped = true; },
    }, deleteMethod, 'clearHistorySpeakers');
    await context[deleteMethod](meetingId);
    assert.equal(context.currentMeetingId, null);
    assert.equal(context.historySpeakers, null);
    assert.equal(bar.hidden, true);
    assert.equal(stopped, true);
    assert.equal(controller.signal.aborted, true);
  }
});

test('summary messages hide the mismatch banner and restoring a summary refreshes it after rendering', async () => {
  const meeting = { id: 'recording', summary: 'Saved summary' };
  const summaryEl = { dataset: { markdown: meeting.summary }, classList: { add() {} } };
  const updates = [];
  const context = loadRendererFunctions({
    document: { getElementById: () => summaryEl },
    currentMeetingId: meeting.id,
    window: { electronAPI: { getMeeting: async () => meeting } },
    meetingIdsEqual,
    setPlaceholder() {},
    updateSummaryActionState() {},
    updateSummaryTagMismatchBanner: (value) => updates.push([value, summaryEl.dataset.markdown]),
    renderSummaryMarkdown: (markdown) => { summaryEl.dataset.markdown = markdown; },
  }, 'showSummaryMessage', 'restoreCurrentHistorySummary');
  context.showSummaryMessage('Generating local summary…');
  await context.restoreCurrentHistorySummary(meeting.id, 'Cancelled', { showTab: false });
  assert.deepEqual(updates, [[null, 'Saved summary'], [meeting, 'Saved summary']]);
});

test('language captions use readable names without an add-on snapshot', () => {
  for (const [code, name] of Object.entries(SUMMARY_LANGUAGE_NAMES)) {
    assert.equal(resolveLanguageDisplayName(code), name);
    assert.deepEqual(formatTranscriptLanguageCaption(code), {
      visible: true,
      label: 'Language',
      value: name,
    });
  }
  assert.equal(formatTranscriptLanguageCaption('en').value, 'English');
  assert.equal(formatTranscriptLanguageCaption('ES').value, 'Spanish');
  assert.equal(formatTranscriptLanguageCaption('pa').value, 'Panjabi');

  const hongKong = formatTranscriptLanguageCaption('zh-HK');
  const simplified = formatTranscriptLanguageCaption('zh-Hans');
  const unitedStates = formatTranscriptLanguageCaption('en_US');
  assert.equal(hongKong.value.includes('zh-HK'), false);
  assert.match(hongKong.value, /^Chinese\b/);
  assert.match(hongKong.value, /Hong Kong/);
  assert.match(simplified.value, /Simplified/);
  assert.equal(resolveLanguageDisplayName('zh_HK'), hongKong.value);
  assert.match(unitedStates.value, /English/);
  assert.match(unitedStates.value, /United States/);
  assert.notEqual(unitedStates.value, 'en_US');

  for (const code of [null, undefined, '', '   ', 'auto', 'und', 'undetermined', 'unknown', 'xyz', 'not a language', 12]) {
    assert.deepEqual(formatTranscriptLanguageCaption(code), {
      visible: true,
      label: 'Language',
      value: 'Not identified',
    });
  }
});

test('summary captions stay distinct from transcript language and clear when absent', () => {
  const stored = {
    language: 'en',
    summary: 'Decisions were recorded.',
    summaryStale: true,
    ai: { summary: { language: 'fr', languageSource: 'userConfirmed', markdownPath: 'summary.md' } },
  };
  assert.equal(formatTranscriptLanguageCaption(stored.language).value, 'English');
  assert.deepEqual(formatSummaryLanguageCaption(stored), {
    visible: true,
    label: 'Summary language',
    value: 'French',
  });
  assert.deepEqual(formatSummaryLanguageCaption({ language: 'en' }), {
    visible: false,
    label: '',
    value: '',
  });
  assert.deepEqual(formatSummaryLanguageCaption({ language: 'es', summary: '   ' }), {
    visible: false,
    label: '',
    value: '',
  });
  assert.equal(formatSummaryLanguageCaption({
    language: 'en',
    summary: 'Legacy summary prose.',
    ai: { summary: { markdownPath: 'legacy.md' } },
  }).value, 'Not recorded');
  assert.equal(formatSummaryLanguageCaption({
    summary: 'Legacy summary prose.',
    ai: { summary: { language: 'nope' } },
  }).value, 'Not recorded');

  const first = formatSummaryLanguageCaption(stored);
  const second = formatSummaryLanguageCaption({ language: 'de' });
  assert.equal(first.value, 'French');
  assert.equal(second.visible, false);
});

test('rendered history captions replace previous meetings and ignore add-on names', () => {
  const elements = {};
  for (const id of ['transcript-summary-language-caption', 'summary-language-caption']) {
    const label = { textContent: 'Transcript language:' };
    const value = { textContent: 'confirm when generating' };
    elements[id] = {
      hidden: false,
      querySelector(selector) {
        if (selector === '.history-language-label') return label;
        if (selector === '.history-language-value') return value;
        return null;
      },
      label,
      value,
    };
  }
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] || null },
    window: { summaryLanguageHelpers: require('../../src/renderer/summary-language-helpers') },
    aiAddonStatusSnapshot: {
      features: { summary: { languagePolicy: { names: { en: 'Should not appear', fr: 'Pas français' } } } },
    },
    historyLanguageCaptionMeeting: null,
    currentMeetingId: null,
    meetingIdsEqual,
  });
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  vm.runInContext(extractTopLevelFunctionSource(source, 'updateSummaryLanguageCaptions'), context);

  context.updateSummaryLanguageCaptions({
    language: 'en',
    summary: 'Saved summary',
    ai: { summary: { language: 'zh-HK', markdownPath: 'summary.md' } },
  });
  assert.equal(elements['transcript-summary-language-caption'].hidden, false);
  assert.equal(elements['transcript-summary-language-caption'].label.textContent, 'Language:');
  assert.equal(elements['transcript-summary-language-caption'].value.textContent, 'English');
  assert.equal(elements['summary-language-caption'].hidden, false);
  assert.equal(elements['summary-language-caption'].label.textContent, 'Summary language:');
  assert.match(elements['summary-language-caption'].value.textContent, /Chinese/);
  assert.match(elements['summary-language-caption'].value.textContent, /Hong Kong/);
  assert.equal(elements['summary-language-caption'].value.textContent.includes('Should not appear'), false);

  context.updateSummaryLanguageCaptions({ language: 'und' });
  assert.equal(elements['transcript-summary-language-caption'].value.textContent, 'Not identified');
  assert.equal(elements['summary-language-caption'].hidden, true);
  assert.equal(elements['summary-language-caption'].label.textContent, '');
  assert.equal(elements['summary-language-caption'].value.textContent, '');
  assert.equal(context.historyLanguageCaptionMeeting.language, 'und');
});

function createCaptionElement(labelText, valueText) {
  const label = { textContent: labelText };
  const value = { textContent: valueText };
  return {
    hidden: false,
    querySelector(selector) {
      if (selector === '.history-language-label') return label;
      if (selector === '.history-language-value') return value;
      return null;
    },
    label,
    value,
  };
}

test('a deferred summary response cannot replace the selected meeting captions or their refresh replay', async () => {
  const elements = buildDialogElements((_, element) => { context.document.activeElement = element; });
  elements['transcript-summary-language-caption'] = createCaptionElement('', '');
  elements['summary-language-caption'] = createCaptionElement('', '');

  const meetingB = {
    id: 'meeting-b',
    title: 'Meeting B',
    language: 'de',
    summary: 'Legacy summary prose.',
    ai: { summary: { markdownPath: 'legacy.md' } },
  };
  let releaseLateMeeting = null;
  let meetingReads = 0;
  let refreshStatusReads = 0;
  let visibleSummary = meetingB.summary;
  const openedTabs = [];
  const savedSummaries = [];
  const context = vm.createContext({
    ...prepareSummaryDialogGlobals,
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: () => ({}),
      activeElement: { isConnected: true, focus() {} },
    },
    window: {
      summaryLanguageHelpers: require('../../src/renderer/summary-language-helpers'),
      electronAPI: {
        getAiAddonStatus: async (options = {}) => {
          if (options.includeStorageSizes === false) {
            refreshStatusReads += 1;
            return { features: {} };
          }
          return {
            features: {
              summary: { setupComplete: true, status: 'ready', languagePolicy: policy, profile: 'meeting' },
            },
          };
        },
        getMeeting: async (id) => {
          if (id === meetingB.id) return meetingB;
          assert.equal(id, 'meeting-a');
          meetingReads += 1;
          if (meetingReads === 1) {
            return { id: 'meeting-a', language: 'en', transcript: 'speech from A' };
          }
          return new Promise((resolve) => {
            releaseLateMeeting = () => resolve({
              id: 'meeting-a',
              language: 'en',
              summary: 'English decisions were recorded.',
              ai: { summary: { language: 'fr', markdownPath: 'a.md' } },
            });
          });
        },
        generateSummary: async () => ({ meeting: { id: 'meeting-a' } }),
        saveTranscriptAs: async (payload) => { savedSummaries.push(payload); },
      },
    },
    currentMeetingId: 'meeting-a',
    currentRecordingMeeting: null,
    summaryGenerationMeetingId: null,
    summaryGenerationCancelling: false,
    rendererQuitCommitted: false,
    closeSummaryLanguageConfirmation: null,
    historyLanguageCaptionMeeting: null,
    aiAddonStatusSnapshot: null,
    aiAddonStatusRefreshPromise: null,
    aiAddonDownloadState: {
      diarization: { active: false },
      summary: { active: false },
    },
    meetingIdsEqual,
    addLog() {},
    updateSummaryGenerationButtons() {},
    shouldAbortSummaryGenerationAfterPreflight: () => false,
    hashSummaryTranscript: async () => 'hash',
    showSummaryMessage() {},
    activateHistoryDetailTab(tab) { openedTabs.push(tab); },
    renderSummaryMarkdown(markdown) { visibleSummary = markdown; },
    getCurrentSummaryMarkdown: () => visibleSummary,
    findMeetingById: (id) => id === meetingB.id ? meetingB : null,
    syncMeetingInList() {},
    restoreCurrentHistorySummary: async () => false,
    openSettingsAtAiAddons() {},
    getSummarySetupMessage: () => '',
    setStatusBadge() {},
    isAiAddonSetupLockingControls: () => false,
    renderAiAddonProgress() {},
    updateAiAddonFootprintWarning() {},
    updateHomeAiAddonCTA() {},
    console,
  });
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  for (const name of [
    'confirmSummaryTranscriptLanguage',
    'updateSummaryLanguageCaptions',
    'generateSummaryForMeeting',
    'saveMeetingSummaryToFile',
    'updateAiAddonSettings',
    'refreshAiAddonSettings',
  ]) {
    vm.runInContext(extractTopLevelFunctionSource(source, name), context);
  }

  const pending = context.generateSummaryForMeeting('meeting-a');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements['summary-language-modal'].hidden, false);
  elements['summary-language-form'].dispatch('submit');
  for (let attempt = 0; attempt < 20 && !releaseLateMeeting; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(typeof releaseLateMeeting, 'function');

  context.currentMeetingId = meetingB.id;
  context.updateSummaryLanguageCaptions(meetingB);
  assert.equal(context.historyLanguageCaptionMeeting, meetingB);
  assert.equal(elements['transcript-summary-language-caption'].value.textContent, 'German');
  assert.equal(elements['summary-language-caption'].value.textContent, 'Not recorded');

  releaseLateMeeting();
  await pending;

  assert.equal(context.currentMeetingId, meetingB.id);
  assert.equal(visibleSummary, meetingB.summary);
  assert.deepEqual(openedTabs, []);
  visibleSummary = 'Old detail pane content';
  const exportPending = context.saveMeetingSummaryToFile();
  context.currentMeetingId = 'meeting-a';
  await exportPending;
  assert.deepEqual(savedSummaries.map(({ suggestedName, content }) => [suggestedName, content]), [
    ['Meeting B Summary', meetingB.summary],
  ]);
  context.currentMeetingId = meetingB.id;
  assert.equal(context.historyLanguageCaptionMeeting, meetingB);
  assert.equal(context.historyLanguageCaptionMeeting.summary, 'Legacy summary prose.');
  assert.equal(context.historyLanguageCaptionMeeting.ai.summary.markdownPath, 'legacy.md');
  assert.equal(elements['transcript-summary-language-caption'].value.textContent, 'German');
  assert.equal(elements['summary-language-caption'].hidden, false);
  assert.equal(elements['summary-language-caption'].label.textContent, 'Summary language:');
  assert.equal(elements['summary-language-caption'].value.textContent, 'Not recorded');

  elements['transcript-summary-language-caption'].value.textContent = 'CLEARED';
  elements['summary-language-caption'].value.textContent = 'CLEARED';
  await context.refreshAiAddonSettings();
  assert.equal(refreshStatusReads, 1);
  assert.equal(context.historyLanguageCaptionMeeting, meetingB);
  assert.equal(elements['transcript-summary-language-caption'].value.textContent, 'German');
  assert.equal(elements['summary-language-caption'].value.textContent, 'Not recorded');
});

test('regeneration shows the prior confirmation as an editable default', async () => {
  const { context, elements } = createDialogHarness();
  const pending = context.confirmSummaryTranscriptLanguage({ language: 'en' }, policy, 'es');
  assert.equal(elements['summary-language-modal'].hidden, false);
  assert.equal(elements['summary-transcript-language'].value, 'es');
  elements['summary-transcript-language'].value = 'pt';
  elements['summary-transcript-language'].dispatch('change');
  elements['summary-language-form'].dispatch('submit');
  assert.equal(await pending, 'pt');
});

test('real regeneration cannot bypass the dialog for a reusable language', async () => {
  const { context, elements } = createDialogHarness();
  Object.assign(context, {
    summaryGenerationMeetingId: null, summaryGenerationCancelling: false,
    rendererQuitCommitted: false, currentMeetingId: null,
    addLog() {}, updateSummaryGenerationButtons() {},
    shouldAbortSummaryGenerationAfterPreflight: () => false,
    meetingIdsEqual: (a, b) => a === b, hashSummaryTranscript: async () => 'hash',
    window: { summaryLanguageHelpers: { reusableSummaryLanguage }, electronAPI: {
      getAiAddonStatus: async () => ({ features: { summary: { setupComplete: true, status: 'ready', languagePolicy: policy } } }),
      getMeeting: async () => ({ language: 'en', transcript: 'speech', ai: { summary: {
        language: 'es', languageSource: 'userConfirmed', sourceTranscriptHash: 'hash', modelId, languagePolicyVersion: policy.version,
      } } }),
      generateSummary: () => assert.fail('Cancelling the dialog must not start inference'),
    } },
  });
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  vm.runInContext(extractTopLevelFunctionSource(source, 'restoreCurrentHistorySummary'), context);
  vm.runInContext(extractTopLevelFunctionSource(source, 'generateSummaryForMeeting'), context);
  const pending = context.generateSummaryForMeeting('meeting');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements['summary-language-modal'].hidden, false);
  assert.equal(elements['summary-transcript-language'].value, 'es');
  elements['summary-language-cancel'].dispatch('click');
  await pending;
  assert.equal(context.summaryGenerationMeetingId, null);
});

test('Prepare summary handles 0/1/2+ usable models and pre-selects summary-capable model when default is Chat-only', async () => {
  const { context, elements } = createDialogHarness();
  const makeControl = () => ({
    value: '', hidden: true, disabled: false, textContent: '', children: [], listeners: new Map(),
    replaceChildren(...items) { this.children = [...items]; },
    add(opt) { this.children.push(opt); },
    addEventListener(ev, fn) { this.listeners.set(ev, fn); },
    removeEventListener(ev) { this.listeners.delete(ev); },
    closest() { return null; },
  });
  Object.assign(elements, {
    'summary-model-field': makeControl(),
    'summary-model-select': makeControl(),
    'summary-model-static-label': makeControl(),
    'summary-manage-models': makeControl(),
  });
  context.usableSummaryModels = (lib) => (lib?.models || []).filter((m) => m.installed && m.setupComplete && m.status === 'ready');

  // 1 usable model: select hidden, static label shown
  const oneLib = {
    defaultModelId: 'qwen3.5-9b-q4-k-m',
    models: [{ modelId: 'qwen3.5-9b-q4-k-m', modelName: 'Qwen3.5 9B', installed: true, setupComplete: true, status: 'ready', qualifiedLanguages: ['en', 'es'] }],
  };
  let pending = context.confirmSummaryTranscriptLanguage({ language: 'en' }, policy, 'en', 'hash', oneLib);
  assert.equal(elements['summary-model-select'].hidden, true);
  assert.equal(elements['summary-model-static-label'].hidden, false);
  assert.equal(elements['summary-model-static-label'].textContent, 'Qwen3.5 9B · Default');
  elements['summary-language-cancel'].dispatch('click');
  await pending;

  // 2+ usable models where default is Chat-only: pre-selects summary-capable model and notes it
  const multiLib = {
    defaultModelId: 'qwen3.5-4b-q4-k-m',
    models: [
      { modelId: 'qwen3.5-4b-q4-k-m', modelName: 'Qwen3.5 4B', installed: true, setupComplete: true, status: 'ready', qualifiedLanguages: [] },
      { modelId: 'gemma-4-e4b', modelName: 'Gemma 4 E4B', installed: true, setupComplete: true, status: 'ready', qualifiedLanguages: ['en'] },
    ],
  };
  pending = context.confirmSummaryTranscriptLanguage({ language: 'en' }, policy, 'en', 'hash', multiLib);
  assert.equal(elements['summary-model-select'].hidden, false);
  assert.equal(elements['summary-model-static-label'].hidden, true);
  assert.equal(elements['summary-model-select'].value, 'gemma-4-e4b');
  assert.match(elements['summary-language-message'].textContent, /Qwen3\.5 4B is Chat-only on this device/);
  elements['summary-language-form'].dispatch('submit');
  const submitted = await pending;
  assert.deepEqual({ ...submitted }, { transcriptLanguage: 'en', modelId: 'gemma-4-e4b' });
});
