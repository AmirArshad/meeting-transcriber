'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture(api) {
  const input = { value: '', style: {}, scrollHeight: 24, focus() {} };
  const context = vm.createContext({
    window: { electronAPI: api },
    document: { getElementById: (id) => id === 'chat-input' ? input : null },
    console, confirm: () => true, meetings: [],
    summaryLibrary: () => null,
  });
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  const start = source.indexOf('const chatState = {');
  const end = source.indexOf('function setupChatWorkspace()', start);
  vm.runInContext(source.slice(start, end) + `
    renderChatThreadSidebar = () => {};
    renderChatOnboardingAndComposer = () => {};
    renderChatStream = () => {};
    closeChatMobileSidebar = () => {};
    showAppToast = () => {};
    globalThis.chat = { chatState, selectChatThread, startNewChatThread, refreshChatThreadList, sendCurrentChatQuestion, deleteChatThreadWithConfirm };
  `, context);
  return { ...context.chat, input };
}

test('late thread detail and list responses cannot replace a newer selection', async () => {
  const a = deferred();
  const list = deferred();
  const f = fixture({
    getChatThread: (id) => id === 'a' ? a.promise : Promise.resolve({ thread: { id } }),
    listChatThreads: () => list.promise,
  });
  const loadingA = f.selectChatThread('a');
  const loadingList = f.refreshChatThreadList({ selectThreadId: 'a' });
  await f.selectChatThread('b');
  a.resolve({ thread: { id: 'a' } });
  list.resolve({ threads: [{ id: 'a' }, { id: 'b' }] });
  await Promise.all([loadingA, loadingList]);
  assert.equal(f.chatState.activeThread.id, 'b');
});

test('failed send restores its originating new-chat draft without replacing another draft', async () => {
  const ask = deferred();
  const f = fixture({ askHistory: () => ask.promise, getChatThread: async (id) => ({ thread: { id } }) });
  f.input.value = 'original question';
  const sending = f.sendCurrentChatQuestion();
  f.input.value = 'additional text';
  await f.selectChatThread('b');
  f.input.value = 'other thread draft';
  ask.reject(new Error('failed'));
  await sending;
  assert.equal(f.input.value, 'other thread draft');
  await f.startNewChatThread();
  assert.equal(f.input.value, 'original question\nadditional text');
});

test('late successful send leaves a newer selection intact', async () => {
  const ask = deferred();
  const f = fixture({
    askHistory: () => ask.promise,
    getChatThread: async (id) => ({ thread: { id } }),
    listChatThreads: async () => ({ threads: [{ id: 'a' }, { id: 'b' }] }),
  });
  await f.selectChatThread('a');
  f.input.value = 'question';
  const sending = f.sendCurrentChatQuestion();
  await f.selectChatThread('b');
  ask.resolve({ thread: { id: 'a', messages: [] } });
  await sending;
  assert.equal(f.chatState.activeThread.id, 'b');
});

test('sending waits for the selected thread detail and uses its scope', async () => {
  const detail = deferred();
  const requests = [];
  const scope = { type: 'selected_meetings', meetingIds: ['m'] };
  const f = fixture({
    getChatThread: () => detail.promise,
    askHistory: async (request) => { requests.push(request); return {}; },
  });
  const loading = f.selectChatThread('a');
  f.input.value = 'question';
  await f.sendCurrentChatQuestion();
  assert.equal(requests.length, 0);
  assert.equal(f.input.value, 'question');
  detail.resolve({ thread: { id: 'a', scope } });
  await loading;
  await f.sendCurrentChatQuestion();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].threadId, 'a');
  assert.equal(requests[0].scope, scope);
});

test('deleting a selected thread while detail is loading invalidates it and removes its draft', async () => {
  const detail = deferred();
  const deletion = deferred();
  const f = fixture({
    getChatThread: () => detail.promise,
    deleteChatThread: () => deletion.promise,
    listChatThreads: async () => ({ threads: [] }),
  });
  const loading = f.selectChatThread('a');
  f.input.value = 'deleted draft';
  const deleting = f.deleteChatThreadWithConfirm('a', 'A');
  deletion.resolve();
  await deleting;
  detail.resolve({ thread: { id: 'a' } });
  await loading;
  assert.equal(f.chatState.activeThread, null);
  assert.equal(f.chatState.drafts.has('thread:a'), false);
  assert.ok(f.chatState.draftKey.startsWith('new:'));
});

test('a failed list refresh after a successful send does not restore the sent question', async () => {
  const ask = deferred();
  const list = deferred();
  const f = fixture({ askHistory: () => ask.promise, listChatThreads: () => list.promise });
  f.input.value = 'sent question';
  const sending = f.sendCurrentChatQuestion();
  ask.resolve({ thread: { id: 'a' } });
  await Promise.resolve();
  list.reject(new Error('list failed'));
  await sending;
  assert.equal(f.input.value, '');
  assert.equal(f.chatState.activeThread.id, 'a');
});

test('sendCurrentChatQuestion sends thread override even when default eligibility is false and avoids pre-send createThread', async () => {
  const requests = [];
  let createCalls = 0;
  const f = fixture({
    createChatThread: async () => { createCalls += 1; return { thread: { id: 'orphan' } }; },
    askHistory: async (req) => { requests.push(req); return { thread: { id: 'new-t', modelId: 'gemma-4-e4b', messages: [] } }; },
    listChatThreads: async () => ({ threads: [] }),
  });
  f.chatState.eligibility = { eligible: false, reason: 'Default unavailable' };
  f.chatState.pendingModelId = 'gemma-4-e4b';
  // Inject summaryLibrary in the VM context so usableSummaryModels sees gemma-4-e4b.
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  const libHelpers = source.slice(source.indexOf('function usableSummaryModels('), source.indexOf('function summaryModelHasFiles('));
  const ctx = vm.createContext({
    window: { electronAPI: {
      createChatThread: async () => { createCalls += 1; return { thread: { id: 'orphan' } }; },
      askHistory: async (req) => { requests.push(req); return { thread: { id: 'new-t', modelId: 'gemma-4-e4b', messages: [] } }; },
      listChatThreads: async () => ({ threads: [] }),
    } },
    document: { getElementById: (id) => id === 'chat-input' ? f.input : null },
    console, confirm: () => true, meetings: [],
    summaryLibrary: () => ({
      defaultModelId: 'qwen3.5-9b-q4-k-m',
      models: [
        { modelId: 'qwen3.5-9b-q4-k-m', installed: false, setupComplete: false, status: 'notConfigured' },
        { modelId: 'gemma-4-e4b', modelName: 'Gemma 4 E4B', installed: true, setupComplete: true, status: 'ready' },
      ],
    }),
  });
  const start = source.indexOf('const chatState = {');
  const end = source.indexOf('function setupChatWorkspace()', start);
  vm.runInContext(libHelpers + '\n' + source.slice(start, end) + `
    renderChatThreadSidebar = () => {};
    renderChatOnboardingAndComposer = () => {};
    renderChatStream = () => {};
    closeChatMobileSidebar = () => {};
    showAppToast = () => {};
    globalThis.chat = { chatState, sendCurrentChatQuestion };
  `, ctx);
  ctx.chat.chatState.eligibility = { eligible: false, reason: 'Default unavailable' };
  ctx.chat.chatState.pendingModelId = 'gemma-4-e4b';
  f.input.value = 'Override question';
  await ctx.chat.sendCurrentChatQuestion();
  assert.equal(createCalls, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].threadModelId, 'gemma-4-e4b');
  assert.equal(requests[0].modelId, 'gemma-4-e4b');
});

test('renderChatOnboardingAndComposer does not flash onboarding while resetting removed thread override', () => {
  const onboarding = { hidden: true };
  const sendBtn = { textContent: '', disabled: false, classList: { add() {}, remove() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  const fnSource = source.slice(source.indexOf('function isChatModelEligible('), source.indexOf('function renderChatThreadSidebar('));
  const ctx = vm.createContext({
    document: { getElementById: (id) => (id === 'chat-onboarding-card' ? onboarding : id === 'chat-send-btn' ? sendBtn : null) },
    chatState: {
      activeThread: { id: 't1', title: 'Chat', modelId: 'removed-model' },
      pendingModelId: null,
      resettingRemovedModelThreadId: 't1',
      sending: false,
      eligibility: { eligible: true },
    },
    renderChatModelChoice: () => {},
    summaryLibrary: () => ({
      defaultModelId: 'qwen3.5-9b-q4-k-m',
      models: [{ modelId: 'qwen3.5-9b-q4-k-m', installed: true, setupComplete: true, status: 'ready' }],
    }),
    usableSummaryModels: (lib) => lib.models.filter((m) => m.status === 'ready'),
    formatChatScopeLabel: () => 'All recordings',
    getCurrentChatScope: () => ({ type: 'all' }),
    getMeetingsMapById: () => new Map(),
    getTagMeta: () => null,
    chatThreadDetailPending: () => false,
  });
  vm.runInContext(fnSource, ctx);
  ctx.renderChatOnboardingAndComposer();
  assert.equal(onboarding.hidden, true);
  assert.equal(sendBtn.disabled, true);
});
