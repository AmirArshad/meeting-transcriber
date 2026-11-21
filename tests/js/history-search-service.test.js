'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createHistorySearchService } = require('../../src/main/history-search-service');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-search-svc-'));
}

function makeHarness({ userDataDir, spawnImpl, isQuitCommitted = () => false, assertTrustedRendererSender } = {}) {
  const handlers = new Map();
  const spawned = [];

  const service = createHistorySearchService({
    app: { getPath: () => userDataDir },
    path,
    fs,
    pythonConfig: { backendPath: path.join(userDataDir, 'backend') },
    getBackendModuleArgs: (mod, args) => ['-m', mod, ...args],
    getRecordingsDir: () => path.join(userDataDir, 'recordings'),
    assertTrustedRendererSender: assertTrustedRendererSender || (() => {}),
    isQuitCommitted,
    spawnTrackedPython(args) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => { proc.killed = true; };
      spawned.push({ args, proc });
      if (spawnImpl) {
        spawnImpl(args, proc, spawned.length);
      }
      return proc;
    },
    collectPythonProcessOutput(python) {
      let stdout = '';
      let stderr = '';
      python.stdout.on('data', (chunk) => { stdout += String(chunk); });
      python.stderr.on('data', (chunk) => { stderr += String(chunk); });
      return {
        getStdout: () => stdout,
        getStderr: () => stderr,
        assertStdoutWithinLimit() {},
      };
    },
    commandTimeoutMs: 500,
  });

  service.registerIpc({
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  });

  return { service, handlers, spawned };
}

test('search-history stores index strictly under userData/search and skips redundant sync via dirtyGeneration', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { service, handlers, spawned } = makeHarness({
    userDataDir: tmpDir,
    spawnImpl(args, proc) {
      setImmediate(() => {
        if (args.includes('sync')) {
          fs.mkdirSync(path.dirname(service.getIndexPath()), { recursive: true });
          fs.writeFileSync(service.getIndexPath(), 'sqlite-placeholder');
          proc.stdout.emit('data', Buffer.from(JSON.stringify({ totalMeetings: 2, totalPassages: 4 })));
        } else if (args.includes('search')) {
          if (!args.includes('--no-sync')) {
            fs.mkdirSync(path.dirname(service.getIndexPath()), { recursive: true });
            fs.writeFileSync(service.getIndexPath(), 'sqlite-placeholder');
          }
          proc.stdout.emit('data', Buffer.from(JSON.stringify({ query: 'budget', matchedMeetingCount: 1, meetings: [{ meetingId: 'm1' }] })));
        }
        proc.emit('close', 0);
      });
    },
  });

  assert.equal(service.getIndexPath(), path.join(tmpDir, 'search', 'history-index.sqlite'));

  // 1st search syncs (no --no-sync).
  const first = await handlers.get('search-history')({}, { query: '  budget  ', limit: 200 });
  assert.equal(first.matchedMeetingCount, 1);
  assert.equal(spawned[0].args.includes('--no-sync'), false);
  // Clamped limit <= 100
  const limitIdx = spawned[0].args.indexOf('--limit');
  assert.equal(spawned[0].args[limitIdx + 1], '100');

  // 2nd search with no mutations since 1st search passes --no-sync.
  await handlers.get('search-history')({}, { query: 'budget' });
  assert.equal(spawned[1].args.includes('--no-sync'), true);

  // Marking dirty resets sync flag so 3rd search syncs again.
  service.markDirty();
  await handlers.get('search-history')({}, { query: 'budget' });
  assert.equal(spawned[2].args.includes('--no-sync'), false);
});

test('dirtyGeneration stays dirty when mutation arrives while sync is in-flight', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let holdProc = null;
  const { service } = makeHarness({
    userDataDir: tmpDir,
    spawnImpl(_args, proc) {
      holdProc = proc;
    },
  });

  const syncPromise = service.ensureSynced();
  await new Promise((r) => setImmediate(r));
  assert.ok(holdProc);

  // Mutation happens while sync subprocess is still running!
  service.markDirty();

  fs.mkdirSync(path.dirname(service.getIndexPath()), { recursive: true });
  fs.writeFileSync(service.getIndexPath(), 'sqlite');
  holdProc.stdout.emit('data', Buffer.from(JSON.stringify({ totalMeetings: 1 })));
  holdProc.emit('close', 0);
  await syncPromise;

  assert.equal(service.isDirty(), true);
});

test('IPC handlers enforce sender check and register all 3 search channels', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { handlers } = makeHarness({
    userDataDir: tmpDir,
    assertTrustedRendererSender(event) {
      if (!event || !event.trusted) {
        throw new Error('Untrusted IPC sender');
      }
    },
    spawnImpl(_args, proc) {
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true })));
        proc.emit('close', 0);
      });
    },
  });

  assert.deepEqual([...handlers.keys()].sort(), [
    'get-history-index-status',
    'rebuild-history-index',
    'search-history',
  ]);

  await assert.rejects(() => handlers.get('search-history')({ trusted: false }, { query: 'hi' }), /Untrusted IPC sender/);
  await assert.rejects(() => handlers.get('rebuild-history-index')({ trusted: false }), /Untrusted IPC sender/);
  await assert.rejects(() => handlers.get('get-history-index-status')({ trusted: false }), /Untrusted IPC sender/);

  const status = await handlers.get('get-history-index-status')({ trusted: true });
  assert.deepEqual(status, { ok: true });
});

test('ensureSynced and rebuildIndex refuse new work once quit is committed', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const { service } = makeHarness({
    userDataDir: tmpDir,
    isQuitCommitted: () => true,
  });

  await assert.rejects(() => service.ensureSynced(), /while the app is quitting/);
  await assert.rejects(() => service.rebuildIndex(), /while the app is quitting/);
});

test('private query is passed on stdin and stale search results are rejected', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  let child;
  let input;
  const { service, spawned } = makeHarness({ userDataDir: tmpDir, spawnImpl(_args, proc) {
    child = proc;
    proc.stdin = { end(value) { input = JSON.parse(value); } };
  } });
  const pending = service.searchHistory({ query: '-private meeting' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned[0].args.includes('-private meeting'), false);
  assert.equal(input.query, '-private meeting');
  service.markDirty();
  child.stdout.emit('data', JSON.stringify({ meetings: [] }));
  child.emit('close', 0);
  await assert.rejects(pending, /History changed/);
});

test('searchHistory forwards normalized tags via --tags and --stdin-json and rejects invalid tags', async (t) => {
  const tmpDir = makeTempDir();
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const stdinPayloads = [];
  const { handlers, service, spawned } = makeHarness({
    userDataDir: tmpDir,
    spawnImpl(_args, proc) {
      proc.stdin = {
        end(value) {
          stdinPayloads.push(JSON.parse(value));
        },
      };
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ matchedMeetingCount: 0, meetings: [] })));
        proc.emit('close', 0);
      });
    },
  });

  await handlers.get('search-history')({}, { query: 'roadmap', tags: ['Voice Memo', 'call', 'voice-note'] });
  const tagsIdx = spawned[0].args.indexOf('--tags');
  assert.notEqual(tagsIdx, -1);
  assert.equal(spawned[0].args[tagsIdx + 1], 'voice-note,call');

  await service.searchHistory({ query: '-private roadmap', tags: ['Lecture / Study'] });
  assert.equal(stdinPayloads.at(-1).query, '-private roadmap');
  assert.deepEqual(stdinPayloads.at(-1).tags, ['lecture']);

  await assert.rejects(
    () => handlers.get('search-history')({}, { query: 'roadmap', tags: ['invalid-tag'] }),
    /Unsupported recording tag/,
  );
});
