'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createChatThreadStore, DEFAULT_THREAD_TITLE } = require('../../src/main/chat-thread-store');

function makeStore(tmpDir) {
  return createChatThreadStore({
    app: { getPath: () => tmpDir },
    path,
    fs,
  });
}

test('chat thread store persists atomically under userData/chat and supports full CRUD + auto-title', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-chat-store-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = makeStore(tmpDir);
  assert.equal(store.getThreadsPath(), path.join(tmpDir, 'chat', 'threads.json'));
  assert.deepEqual(await store.listThreads(), []);

  const created = await store.createThread({
    scope: { type: 'selected_meetings', meetingIds: ['m1', 'm1', 'm2'], dateFrom: '2026-11-01' },
  });
  assert.equal(created.title, DEFAULT_THREAD_TITLE);
  assert.deepEqual(created.scope, {
    type: 'selected_meetings',
    meetingIds: ['m1', 'm2'],
    dateFrom: '2026-11-01',
    dateTo: null,
    tags: [],
  });

  const turned = await store.appendTurn(created.id, {
    question: 'What did Alice decide about December launch budgets and hiring?',
    status: 'answered',
    answerMarkdown: 'Budget approved [E1].',
    citations: [
      {
        evidenceId: 'E1',
        meetingId: 'm1',
        meetingTitle: 'Budget Sync',
        meetingDate: '2026-11-10T10:00:00',
        startSec: 90,
        endSec: 110,
        speaker: 'Alice',
        excerpt: 'Approved budget.',
        sourceTranscriptHash: 'sha256:aaa',
      },
    ],
    searchedMeetingCount: 2,
    evidenceCount: 1,
  });
  assert.match(turned.thread.title, /^What did Alice decide/);
  assert.equal(turned.thread.messages.length, 2);

  const renamed = await store.renameThread(created.id, '  Q4 Budget Thread  ');
  assert.equal(renamed.title, 'Q4 Budget Thread');

  const scoped = await store.updateThreadScope(created.id, { type: 'all' });
  assert.deepEqual(scoped.scope, {
    type: 'all',
    meetingIds: [],
    dateFrom: null,
    dateTo: null,
    tags: [],
  });

  const fetched = await store.getThread(created.id);
  assert.equal(fetched.title, 'Q4 Budget Thread');
  assert.equal(fetched.messages.length, 2);

  const listed = await store.listThreads();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messageCount, 2);

  // Re-instantiate store from disk to verify persistence.
  const reloadedStore = makeStore(tmpDir);
  assert.equal((await reloadedStore.listThreads()).length, 1);

  const del = await reloadedStore.deleteThread(created.id);
  assert.equal(del.deleted, true);
  assert.deepEqual(await reloadedStore.listThreads(), []);
});

test('chat thread store backs up corrupt threads.json and serializes concurrent writes', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-chat-corrupt-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = makeStore(tmpDir);
  fs.mkdirSync(store.getChatDir(), { recursive: true });
  fs.writeFileSync(store.getThreadsPath(), '{broken json!!!', 'utf8');

  assert.deepEqual(await store.listThreads(), []);
  const files = fs.readdirSync(store.getChatDir());
  assert.ok(files.some((name) => /^threads\.corrupt\.\d+\.json$/.test(name)));

  const created = await Promise.all([
    store.createThread({ title: 'First' }),
    store.createThread({ title: 'Second' }),
    store.createThread({ title: 'Third' }),
  ]);
  assert.equal(created.length, 3);
  assert.equal((await store.listThreads()).length, 3);
});

test('invalid scope is rejected and legacy invalid scope retains history but matches nothing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-chat-scope-'));
  const store = createChatThreadStore({ app: { getPath: () => tmpDir }, path, fs });
  assert.throws(() => store.sanitizeScope({ type: 'unknown' }), /scope/);
  await assert.rejects(store.createThread({ scope: { type: 'unknown' } }), /scope/);
  fs.mkdirSync(path.join(tmpDir, 'chat'), { recursive: true });
  fs.writeFileSync(store.getThreadsPath(), JSON.stringify({ threads: [{ id: 'old', scope: { type: 'unknown' }, messages: [{ role: 'user', content: 'kept' }] }] }));
  const thread = await store.getThread('old');
  assert.equal(thread.messages[0].content, 'kept');
  assert.deepEqual(thread.scope.meetingIds, []);
  assert.equal(thread.scope.type, 'selected_meetings');
});

test('read and quarantine failures preserve the original store', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-chat-io-'));
  const dir = path.join(tmpDir, 'chat');
  fs.mkdirSync(dir);
  const target = path.join(dir, 'threads.json');
  fs.writeFileSync(target, 'broken');
  const fakeFs = { ...fs, promises: { ...fs.promises, rename: async () => { throw new Error('denied'); } } };
  const store = createChatThreadStore({ app: { getPath: () => tmpDir }, path, fs: fakeFs });
  await assert.rejects(store.createThread(), /denied/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'broken');
  fakeFs.promises.readFile = async () => { throw new Error('read denied'); };
  await assert.rejects(store.createThread(), /read denied/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'broken');
});

test('appendTurn rejects stale evidence before committing and removes its temp file', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-stale-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = createChatThreadStore({ app: { getPath: () => tmpDir }, path, fs });
  const thread = await store.createThread();
  await assert.rejects(store.appendTurn(thread.id, { question: 'q', answerMarkdown: 'old' }, {
    beforeCommit() { throw new Error('stale'); },
  }), /stale/);
  assert.equal((await store.getThread(thread.id)).messages.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(tmpDir, 'chat')), ['threads.json']);
});


test('chat thread store preserves extended v3.1 failure statuses, inspectedSources, and citation tag/kind', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-chat-v31-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = makeStore(tmpDir);
  const thread = await store.createThread();

  const noMatch = await store.appendTurn(thread.id, {
    question: 'What happened on 05/09/2026?',
    status: 'no_matching_excerpts',
    failureReason: 'no_matching_excerpts',
    detectedDateFilter: '2026-09-05',
    retrievalMode: 'targeted',
    answerMarkdown: 'No matching excerpts were found for 2026-09-05.',
    citations: [],
    searchedMeetingCount: 4,
    evidenceCount: 0,
  });
  assert.equal(noMatch.assistantMessage.status, 'no_matching_excerpts');
  assert.equal(noMatch.assistantMessage.detectedDateFilter, '2026-09-05');
  assert.equal(noMatch.assistantMessage.retrievalMode, 'targeted');

  const verFail = await store.appendTurn(thread.id, {
    question: 'Summarize points',
    status: 'verification_failed',
    failureReason: 'missing_citations',
    retrievalMode: 'overview',
    answerMarkdown: 'Unverified',
    citations: [],
    inspectedSources: [
      {
        evidenceId: 'E1',
        meetingId: 'm1',
        meetingTitle: 'Sync',
        tag: 'interview',
        kind: 'summary',
        excerpt: 'Key point',
      },
    ],
    searchedMeetingCount: 1,
    evidenceCount: 1,
  });
  assert.equal(verFail.assistantMessage.status, 'verification_failed');
  assert.equal(verFail.assistantMessage.failureReason, 'missing_citations');
  assert.equal(verFail.assistantMessage.inspectedSources[0].tag, 'interview');
  assert.equal(verFail.assistantMessage.inspectedSources[0].kind, 'summary');

  const reloaded = await makeStore(tmpDir).getThread(thread.id);
  assert.equal(reloaded.messages[1].status, 'no_matching_excerpts');
  assert.equal(reloaded.messages[3].status, 'verification_failed');
  assert.equal(reloaded.messages[3].inspectedSources[0].tag, 'interview');
});

test('chat thread store normalizes, dedupes, persists, and validates scope.tags', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-chat-tags-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = makeStore(tmpDir);
  const created = await store.createThread({
    scope: { type: 'all', tags: ['Voice Note', 'call', 'voice-note'] },
  });
  assert.deepEqual(created.scope.tags, ['voice-note', 'call']);

  const updated = await store.updateThreadScope(created.id, {
    type: 'selected_meetings',
    meetingIds: ['m1'],
    tags: ['Lecture / Study', 'music'],
  });
  assert.deepEqual(updated.scope, {
    type: 'selected_meetings',
    meetingIds: ['m1'],
    dateFrom: null,
    dateTo: null,
    tags: ['lecture', 'music'],
  });

  const reloaded = await makeStore(tmpDir).getThread(created.id);
  assert.deepEqual(reloaded.scope.tags, ['lecture', 'music']);

  await assert.rejects(
    store.createThread({ scope: { type: 'all', tags: ['not-a-tag'] } }),
    /Invalid chat scope tags/,
  );
  assert.throws(
    () => store.updateThreadScope(created.id, { type: 'all', tags: ['invalid'] }),
    /Invalid chat scope tags/,
  );
});

test('model preference and answer provenance survive reload independently', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-chat-model-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const store = makeStore(tmpDir);
  const thread = await store.createThread();
  assert.equal(thread.modelId, null);
  await store.updateThreadModel(thread.id, 'qwen3.5-4b-q4-k-m');
  await store.appendTurn(thread.id, {
    question: 'What happened?', answerMarkdown: 'An answer.',
    modelId: 'qwen3.5-4b-q4-k-m', modelName: 'Qwen 4B',
  });
  await store.updateThreadModel(thread.id, null);
  const reloaded = await makeStore(tmpDir).getThread(thread.id);
  assert.equal(reloaded.modelId, null);
  assert.equal(reloaded.messages[1].modelId, 'qwen3.5-4b-q4-k-m');
  assert.equal(reloaded.messages[1].modelName, 'Qwen 4B');

  const withOverride = await store.createThread({ title: 'Override', modelId: 'gemma-4-e4b' });
  assert.equal(withOverride.modelId, 'gemma-4-e4b');
  const reloadedOverride = await makeStore(tmpDir).getThread(withOverride.id);
  assert.equal(reloadedOverride.modelId, 'gemma-4-e4b');
});

test('chat thread store supports scope.type = none, chatMode, direct_full, and passageKey while keeping corrupt scope fail-closed', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-chat-general-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const store = makeStore(tmpDir);
  assert.deepEqual(store.sanitizeScope({ type: 'none' }), {
    type: 'none',
    meetingIds: [],
    dateFrom: null,
    dateTo: null,
    tags: [],
  });
  assert.deepEqual(store.sanitizeScope({ type: 'NONE', meetingIds: ['m1'], tags: ['call'], dateFrom: '2026-11-01' }), {
    type: 'none',
    meetingIds: [],
    dateFrom: null,
    dateTo: null,
    tags: [],
  });

  const generalThread = await store.createThread({ scope: { type: 'none' } });
  assert.deepEqual(generalThread.scope, {
    type: 'none',
    meetingIds: [],
    dateFrom: null,
    dateTo: null,
    tags: [],
  });

  const generalTurn = await store.appendTurn(generalThread.id, {
    question: 'Explain Python decorators',
    status: 'answered',
    chatMode: 'general',
    answerMarkdown: 'A decorator wraps a function.',
    citations: [],
    searchedMeetingCount: 0,
    evidenceCount: 0,
  });
  assert.equal(generalTurn.assistantMessage.chatMode, 'general');

  const groundedTurn = await store.appendTurn(generalThread.id, {
    question: 'Summarize the sync',
    status: 'answered',
    chatMode: 'grounded',
    retrievalMode: 'direct_full',
    answerMarkdown: 'Shipped v3.2 [E1].',
    citations: [
      {
        evidenceId: 'E1',
        meetingId: 'm1',
        meetingTitle: 'Release Sync',
        passageKey: 'm1:4',
        speaker: 'Alice',
        kind: 'transcript',
      },
    ],
    searchedMeetingCount: 1,
    evidenceCount: 1,
    scope: { type: 'all' },
  });
  assert.equal(groundedTurn.assistantMessage.chatMode, 'grounded');
  assert.equal(groundedTurn.assistantMessage.retrievalMode, 'direct_full');
  assert.equal(groundedTurn.assistantMessage.citations[0].passageKey, 'm1:4');
  assert.equal(groundedTurn.thread.scope.type, 'all');

  const cleared = await store.updateThreadScope(generalThread.id, { type: 'none' });
  assert.equal(cleared.scope.type, 'none');

  const reloaded = await makeStore(tmpDir).getThread(generalThread.id);
  assert.equal(reloaded.scope.type, 'none');
  assert.equal(reloaded.messages[1].chatMode, 'general');
  assert.equal(reloaded.messages[3].chatMode, 'grounded');
  assert.equal(reloaded.messages[3].retrievalMode, 'direct_full');
  assert.equal(reloaded.messages[3].citations[0].passageKey, 'm1:4');

  // Corrupt saved scope must still fail closed to selected_meetings [] (never elevate to 'none').
  const storePath = store.getThreadsPath();
  const disk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  disk.threads.push({ id: 'corrupt-thread', scope: { type: 'bogus_mode' }, messages: [] });
  fs.writeFileSync(storePath, JSON.stringify(disk), 'utf8');
  const recovered = await makeStore(tmpDir).getThread('corrupt-thread');
  assert.deepEqual(recovered.scope, {
    type: 'selected_meetings',
    meetingIds: [],
    dateFrom: null,
    dateTo: null,
    tags: [],
  });
});
