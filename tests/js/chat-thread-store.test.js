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
