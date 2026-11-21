'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tagHelpers = require('../../src/renderer/tag-helpers');

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');

function loadRendererFunctions(context, ranges) {
  vm.createContext(context);
  for (const [first, next] of ranges) {
    const start = source.indexOf(first);
    const end = source.indexOf(next, start + first.length);
    assert.ok(start >= 0 && end > start, first);
    vm.runInContext(source.slice(start, end), context);
  }
}

test('newer tag update wins and refreshes a pending search without a second read', async () => {
  const pending = [];
  const searches = [];
  const context = {
    meetings: [{ id: '1', tag: 'meeting', title: 'Original' }],
    meetingTagMutationVersions: new Map(),
    meetingSearchQueryNormalized: '', meetingSearchDebounceTimer: 7, meetingSearchQuery: 'notes',
    currentRecordingMeeting: null, currentMeetingId: '1', chatState: { popoverOpen: false },
    window: { electronAPI: { updateMeeting: () => new Promise((resolve) => pending.push(resolve)) } },
    document: { getElementById: () => null },
    findMeetingIndexById: () => 0, normalizeTag: (value) => value,
    meetingIdsEqual: (a, b) => a === b, applyTagPillView() {},
    updateSummaryTagMismatchBanner: (meeting) => { context.banner = meeting; },
    renderHistoryTagFilterBar() {}, renderMeetingList() {}, renderActivityList() {},
    clearTimeout: (id) => { context.cleared = id; },
    runHistorySearch: (query) => searches.push(query), console,
  };
  loadRendererFunctions(context, [['async function commitMeetingTagChange(', '\nasync function runHistorySearch(']]);
  const first = context.commitMeetingTagChange('1', 'lecture');
  const second = context.commitMeetingTagChange('1', 'podcast');
  pending[1]({ tag: 'podcast', title: 'Updated' });
  await second;
  pending[0]({ tag: 'lecture' });
  await first;
  assert.equal(context.meetings[0].tag, 'podcast');
  assert.equal(context.banner.title, 'Updated');
  assert.equal(context.cleared, 7);
  assert.deepEqual(searches, ['notes']);
});

function makeElement() {
  const events = new Map();
  const classes = new Set();
  return {
    children: [],
    dataset: {},
    style: {},
    classList: {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
      toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
    },
    addEventListener: (name, callback) => events.set(name, callback),
    fire: (name) => events.get(name)(),
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    setAttribute() {},
  };
}

test('History tag chips including All immediately refresh a pending search', () => {
  const bar = makeElement();
  const searches = [];
  const cleared = [];
  const context = {
    ...tagHelpers,
    ...require('../../src/renderer/history-search-helpers'),
    meetings: [{ tag: 'lecture' }],
    activeHistoryTagFilter: 'lecture',
    meetingSearchDebounceTimer: 7,
    meetingSearchQuery: 'notes',
    document: { getElementById: () => bar, createElement: makeElement },
    clearElement: (element) => { element.children.length = 0; },
    clearTimeout: (id) => cleared.push(id),
    runHistorySearch: (query) => searches.push([query, context.activeHistoryTagFilter]),
  };
  loadRendererFunctions(context, [['function renderHistoryTagFilterBar()', '\nfunction updateSummaryTagMismatchBanner(']]);
  context.renderHistoryTagFilterBar();
  bar.children[0].fire('click');
  context.meetingSearchDebounceTimer = 8;
  bar.children[1].fire('click');
  assert.deepEqual(cleared, [7, 8]);
  assert.deepEqual(searches, [['notes', null], ['notes', 'lecture']]);
  assert.equal(context.meetingSearchDebounceTimer, null);
});

test('unsaved scope dates survive tag pills and the tag list toggle', () => {
  const from = makeElement();
  const to = makeElement();
  const tags = makeElement();
  const toggle = makeElement();
  const elements = {
    'chat-scope-date-from': from,
    'chat-scope-date-to': to,
    'chat-scope-tags-row': tags,
    'chat-scope-tags-toggle-btn': toggle,
  };
  const context = {
    ...tagHelpers,
    chatState: { scopeDraft: { type: 'all', tags: [] } },
    meetings: [{ tag: 'lecture' }],
    document: {
      getElementById: (id) => elements[id],
      createElement: makeElement,
      createTextNode: (label) => label,
      addEventListener() {},
    },
    window: {},
    clearElement: (element) => { element.children.length = 0; },
  };
  loadRendererFunctions(context, [
    ['function renderScopePopover()', '\nfunction toggleChatScopePopover('],
    ['function setupChatWorkspace()', '\nsetupChatWorkspace();'],
  ]);
  context.setupChatWorkspace();
  context.renderScopePopover();
  from.value = '2026-11-01';
  from.fire('input');
  to.value = '2026-11-21';
  to.fire('change');
  tags.children[0].fire('click');
  toggle.fire('click');
  assert.equal(from.value, '2026-11-01');
  assert.equal(to.value, '2026-11-21');
  assert.equal(context.chatState.scopeDraft.tags[0], 'lecture');
  assert.equal(tags.children.length, tagHelpers.RECORDING_TAGS.length);
});

test('tag popover flips and clamps against the viewport and cancels queued focus on close', () => {
  const animationFrames = [];
  const triggerBtn = makeElement();
  const popoverEl = makeElement();
  triggerBtn.getBoundingClientRect = () => ({ left: 330, right: 365, top: 260, bottom: 285 });
  popoverEl.getBoundingClientRect = () => ({ width: 200, height: 120 });
  const context = {
    ...tagHelpers,
    activeOpenTagPopover: null,
    document: { createElement: makeElement },
    window: { innerWidth: 360, innerHeight: 300 },
    clearElement() {},
    requestAnimationFrame: (callback) => animationFrames.push(callback),
  };
  loadRendererFunctions(context, [['function closeActiveTagPopover(', '\nfunction renderRecordingTagControl(']]);
  context.toggleTagPickerPopover({ triggerBtn, popoverEl, activityMeetingId: '1' });
  assert.equal(popoverEl.style.left, '148px');
  assert.equal(popoverEl.style.top, '134px');
  assert.equal(context.activeOpenTagPopover.activityMeetingId, '1');
  context.closeActiveTagPopover();
  for (const callback of animationFrames) callback();
  assert.equal(popoverEl.hidden, true);
  assert.equal(context.activeOpenTagPopover, null);
});

test('recording finalization preserves a cleared active tag and resets selection only on save', async () => {
  const requests = [];
  const context = {
    activeRecordingTag: null,
    selectedRecordingTag: 'lecture',
    activeRecordingTranscriptionSelection: null,
    currentAudioFile: '/recordings/current.opus',
    currentRecordingDurationSeconds: 12,
    languageSelect: { value: 'en' },
    modelSelect: { value: 'small' },
    validateNewTranscriptionSelection: () => ({ ok: true }),
    window: { electronAPI: { async finalizeRecordingTranscription(options) {
      requests.push(options);
      return requests.length === 1 ? { success: false, error: 'Could not save' } : { success: true };
    } } },
    addLog() {},
    console: { error() {}, warn() {} },
    setRecordingState() {},
    loadMeetingHistory: async () => {},
    renderRecordingTagControl() {},
  };
  loadRendererFunctions(context, [['async function transcribeAudio(', '\nasync function retryMeetingTranscription(']]);
  await context.transcribeAudio();
  assert.equal(Object.hasOwn(requests[0], 'tag'), false);
  assert.equal(context.selectedRecordingTag, 'lecture');
  await context.transcribeAudio();
  assert.equal(Object.hasOwn(requests[1], 'tag'), false);
  assert.equal(context.selectedRecordingTag, null);
  assert.equal(context.activeRecordingTag, null);
});
