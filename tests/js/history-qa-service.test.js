'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');

const { createChatThreadStore } = require('../../src/main/chat-thread-store');
const {
  createHistoryQaService,
  resolveLlamaServerBinary,
  HISTORY_QA_CANCEL_CODE,
} = require('../../src/main/history-qa-service');

function createFakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    chunks: [],
    end(data) {
      if (data !== undefined) {
        this.chunks.push(String(data));
      }
      proc._stdinText = this.chunks.join('');
    },
  };
  proc.kill = (signal = 'SIGTERM') => {
    proc.killedSignal = signal;
    setImmediate(() => proc.emit('close', 0));
  };
  return proc;
}

function makeQaHarness({
  tmpDir,
  platform = 'linux',
  arch = 'x64',
  aiStatus = null,
  cudaReady = true,
  createServerSibling = true,
  serverShaOverride = null,
  idleTimeoutMs = 60 * 1000,
  onQaRunnerPayload = null,
  checkStatus = null,
  queueAction = null,
  getSummaryArtifactPath = null,
} = {}) {
  const recordingsDir = path.join(tmpDir, 'recordings');
  const extractDir = path.join(tmpDir, 'ai-addons', 'models', 'summary', 'qwen3.5-9b-q4-k-m', 'runtime', `${platform}-${arch}`, 'extract', 'cuda-12.8');
  const modelDir = path.join(tmpDir, 'ai-addons', 'models', 'summary', 'qwen3.5-9b-q4-k-m');
  fs.mkdirSync(recordingsDir, { recursive: true });
  fs.mkdirSync(extractDir, { recursive: true });
  if (platform === 'linux') {
    fs.mkdirSync(path.join(tmpDir, 'ai-addons', 'cuda', 'python'), { recursive: true });
  }
  const cliPath = path.join(extractDir, platform === 'win32' ? 'llama-cli.exe' : 'llama-cli');
  fs.writeFileSync(cliPath, 'cli-binary');
  const serverPath = path.join(extractDir, platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  if (createServerSibling) {
    fs.writeFileSync(serverPath, 'fake-llama-server-binary');
  }
  const serverBytes = fs.existsSync(serverPath) ? fs.readFileSync(serverPath) : Buffer.alloc(0);
  const pinnedLinuxServer = {
    runtimeId: 'llama-cpp-v0.3.0-linux-x64-cuda-12.8',
    sha256: serverShaOverride || createHash('sha256').update(serverBytes).digest('hex'),
    sizeBytes: serverBytes.length,
  };

  const modelPath = path.join(modelDir, 'Qwen3.5-9B-Q4_K_M.gguf');
  fs.writeFileSync(modelPath, 'gguf');

  const events = [];
  const handlers = new Map();
  const spawnedServers = [];
  const spawnedPython = [];
  let queueRuns = 0;

  const chatThreadStore = createChatThreadStore({ app: { getPath: () => tmpDir }, path, fs });
  let syncCalls = 0;
  const historySearchService = {
    getGeneration: () => 1,
    enqueueOperation: (action) => action(),
    retainProcessUntilExit: () => {},
    getIndexPath: () => path.join(tmpDir, 'search', 'history-index.sqlite'),
    async ensureSynced() {
      syncCalls += 1;
      return { synced: true };
    },
  };

  let retrievalEvidence = [
    {
      evidenceId: 'E1',
      meetingId: 'm1',
      meetingTitle: 'Launch Sync',
      meetingDate: '2026-11-18T10:00:00',
      startSec: 65,
      endSec: 80,
      speaker: 'Alice',
      excerpt: 'Beta launches December 4.',
      text: 'Beta launches December 4.',
      sourceTranscriptHash: 'sha256:123',
    },
  ];
  let searchedMeetingCount = 1;
  let healthHealthy = true;
  let computeBusy = false;
  const getModelByIdCalls = [];

  const service = createHistoryQaService({
    app: { getPath: () => tmpDir },
    path,
    fs,
    platform,
    arch,
    idleTimeoutMs,
    pinnedLinuxServer,
    pythonConfig: { backendPath: path.join(tmpDir, 'backend') },
    getBackendModuleArgs: (mod, args) => ['-m', mod, ...args],
    getAiAddonRuntimeOptions: (opts) => opts || {},
    checkAiAddonSetupStatus: checkStatus || (async () => aiStatus || ({
      features: {
        summary: {
          status: 'ready',
          setupComplete: true,
          modelId: 'qwen3.5-9b-q4-k-m',
          cache: { valid: true },
          runtimeCache: { valid: true },
        },
      },
    })),
    getSummaryArtifactForPlatform: () => ({ id: 'qwen-artifact', fileName: 'Qwen3.5-9B-Q4_K_M.gguf' }),
    getSummaryRuntimeArtifactForPlatform: () => ({ id: 'llama-cpp-v0.3.0-linux-x64-cuda-12.8' }),
    getModelById: (feature, modelId) => {
      getModelByIdCalls.push([feature, modelId]);
      return { id: modelId, label: 'Qwen 3.5 9B (Q4_K_M)' };
    },
    getSummaryArtifactPath: getSummaryArtifactPath || (() => modelPath),
    getSummaryRuntimeDir: () => path.dirname(path.dirname(extractDir)),
    buildSummaryRuntimeEnv: () => ({ LD_LIBRARY_PATH: extractDir }),
    resolveCudaStatusForTranscription: async () => (cudaReady ? {
      statusCode: 'ready',
      installed: true,
      deviceAvailable: true,
      runtimeLoadable: true,
      missingLibraries: [],
      matchedProfile: 'cuda12',
    } : {
      statusCode: 'missing',
      installed: false,
      deviceAvailable: false,
      runtimeLoadable: false,
      missingLibraries: ['libcublas.so.12'],
      matchedProfile: null,
    }),
    historySearchService,
    chatThreadStore,
    enqueueAiComputeAction: async (action) => {
      queueRuns += 1;
      return queueAction ? queueAction(action) : action();
    },
    enqueueGpuResourceActionForQa: async (action) => action(),
    hasPendingAiComputeWork: () => computeBusy,
    sendToRenderer(channel, payload) {
      events.push({ channel, payload });
    },
    assertTrustedRendererSender(event) {
      if (event && event.untrusted) {
        throw new Error('Untrusted IPC sender');
      }
    },
    allocateLoopbackPort: async () => 45678,
    probeServerHealth: async () => healthHealthy,
    spawnServerProcess(exePath, args, opts) {
      const proc = createFakeProcess();
      spawnedServers.push({ exePath, args, env: opts.env, cwd: opts.cwd, proc });
      return proc;
    },
    spawnTrackedPython(args) {
      const proc = createFakeProcess();
      spawnedPython.push({ args, proc });
      setImmediate(() => {
        if (args.includes('history_qa.retrieval')) {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({
            searchedMeetingCount,
            evidence: retrievalEvidence,
          })));
          proc.emit('close', 0);
        } else if (args.includes('history_qa.qa_runner')) {
          const stdinPayload = JSON.parse(proc._stdinText || '{}');
          if (onQaRunnerPayload) {
            onQaRunnerPayload(stdinPayload, proc);
            return;
          }
          proc.stderr.emit('data', Buffer.from(`${JSON.stringify({
            type: 'progress',
            feature: 'history-qa',
            phase: 'generating',
            percent: 60,
            message: 'Synthesizing locally…',
          })}\n`));
          proc.stdout.emit('data', Buffer.from(JSON.stringify({
            status: 'answered',
            answerMarkdown: 'Beta launches on December 4 [E1].',
            citations: retrievalEvidence,
            searchedMeetingCount,
            evidenceCount: retrievalEvidence.length,
          })));
          proc.emit('close', 0);
        }
      });
      return proc;
    },
    collectPythonProcessOutput(python) {
      let stdout = '';
      let stderr = '';
      python.stdout.on('data', (d) => { stdout += String(d); });
      python.stderr.on('data', (d) => { stderr += String(d); });
      return {
        getStdout: () => stdout,
        getStderr: () => stderr,
        assertStdoutWithinLimit() {},
      };
    },
    terminateProcessBestEffort: async (proc) => {
      if (proc && typeof proc.kill === 'function') {
        proc.kill('SIGTERM');
      }
    },
  });

  service.registerIpc({
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  });

  return {
    service,
    handlers,
    events,
    spawnedServers,
    spawnedPython,
    getQueueRuns: () => queueRuns,
    getSyncCalls: () => syncCalls,
    setRetrievalEvidence(next, count = 1) {
      retrievalEvidence = next;
      searchedMeetingCount = count;
    },
    setHealthHealthy(val) {
      healthHealthy = val;
    },
    setComputeBusy(val) {
      computeBusy = val;
    },
    getModelByIdCalls: () => getModelByIdCalls,
  };
}

test('zero-hit preflight never acquires compute queue or loads llama-server', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-zero-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const h = makeQaHarness({ tmpDir });
  assert.equal(h.service.getModelState().status, 'unloaded');

  h.setRetrievalEvidence([], 3);
  const res = await h.handlers.get('ask-history')({}, { question: 'Where is Atlantis?' });
  assert.equal(res.status, 'no_matching_excerpts');
  assert.equal(res.failureReason, 'no_matching_excerpts');
  assert.equal(res.modelLoaded, false);
  assert.equal(h.getQueueRuns(), 0);
  assert.equal(h.spawnedServers.length, 0);
  assert.equal(h.service.getModelState().status, 'unloaded');
  assert.equal(h.getSyncCalls(), 1);
});

test('lazy llama-server boots with 127.0.0.1 + LLAMA_API_KEY env, reuses warm session, and manual unload clears VRAM', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-warm-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let capturedRunnerPayloads = [];
  const h = makeQaHarness({
    tmpDir,
    onQaRunnerPayload(payload, proc) {
      capturedRunnerPayloads.push(payload);
      proc.stdout.emit('data', Buffer.from(JSON.stringify({
        status: 'answered',
        answerMarkdown: 'Grounded [E1].',
        citations: payload.evidence,
        searchedMeetingCount: 1,
        evidenceCount: 1,
      })));
      proc.emit('close', 0);
    },
  });

  const first = await h.handlers.get('ask-history')({}, { question: 'When is launch?' });
  assert.equal(first.status, 'answered');
  assert.equal(first.modelLoaded, true);
  assert.equal(h.spawnedServers.length, 1);
  assert.deepEqual(h.getModelByIdCalls()[0], ['summary', 'qwen3.5-9b-q4-k-m']);
  assert.equal(h.service.getModelState().modelName, 'Qwen 3.5 9B (Q4_K_M)');

  h.setComputeBusy(true);

  const srv = h.spawnedServers[0];
  assert.ok(srv.args.includes('127.0.0.1'));
  assert.ok(srv.args.includes('--no-webui'));
  assert.ok(!srv.args.some((a) => a.includes('LLAMA_API_KEY') || a.length === 64));
  const token = srv.env.LLAMA_API_KEY;
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(capturedRunnerPayloads[0].executionMode, 'server');
  assert.equal(capturedRunnerPayloads[0].serverUrl, 'http://127.0.0.1:45678');
  assert.equal(capturedRunnerPayloads[0].serverToken, token);

  // Model state pushed to renderer must NEVER contain token or port!
  const modelEvents = h.events.filter((e) => e.channel === 'history-qa-model-state');
  assert.ok(modelEvents.some((e) => e.payload.status === 'loading'));
  assert.ok(modelEvents.some((e) => e.payload.status === 'loaded'));
  for (const evt of modelEvents) {
    assert.equal(JSON.stringify(evt).includes(token), false);
    assert.equal(JSON.stringify(evt).includes('45678'), false);
  }

  // Second question in same thread reuses warm server cleanly & surfaces queued copy when busy.
  const second = await h.handlers.get('ask-history')({}, {
    threadId: first.thread.id,
    question: 'Remind me who spoke?',
  });
  assert.equal(second.status, 'answered');
  assert.equal(h.spawnedServers.length, 1);
  assert.equal(capturedRunnerPayloads[1].history.length, 2);
  assert.ok(
    h.events.some((e) => e.channel === 'history-qa-progress' && /Queued behind active local AI work/.test(e.payload.message)),
  );

  // Manual unload kills server and transitions cleanly to unloaded.
  const unloadRes = await h.handlers.get('unload-history-qa-model')({});
  assert.equal(unloadRes.unloaded, true);
  assert.equal(h.service.getModelState().status, 'unloaded');
  assert.equal(srv.proc.killedSignal, 'SIGTERM');
});

test('idle timeout and competing GPU work trigger automatic safety unloads', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-auto-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const h = makeQaHarness({ tmpDir, idleTimeoutMs: 60 });
  await h.handlers.get('ask-history')({}, { question: 'Launch date?' });
  assert.equal(h.service.isModelLoaded(), true);

  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.service.isModelLoaded(), false);
  assert.equal(h.service.getModelState().status, 'unloaded');

  // Re-load, then unload for competing work.
  await h.handlers.get('ask-history')({}, { question: 'Launch date again?' });
  assert.equal(h.service.isModelLoaded(), true);
  await h.service.ensureUnloadedForCompetingWork('competing_compute');
  assert.equal(h.service.isModelLoaded(), false);
  assert.equal(h.service.getModelState().reason, 'competing_compute');
});

test('Linux falls back to llama-cli when llama-server sibling is absent or checksum fails, and eligibility fails closed without CUDA', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-fallback-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let capturedPayload = null;
  const h = makeQaHarness({
    tmpDir,
    createServerSibling: false,
    onQaRunnerPayload(payload, proc) {
      capturedPayload = payload;
      proc.stdout.emit('data', Buffer.from(JSON.stringify({
        status: 'answered',
        answerMarkdown: 'From CLI [E1].',
        citations: payload.evidence,
        searchedMeetingCount: 1,
        evidenceCount: 1,
      })));
      proc.emit('close', 0);
    },
  });

  const res = await h.handlers.get('ask-history')({}, { question: 'Launch?' });
  assert.equal(res.status, 'answered');
  assert.equal(capturedPayload.executionMode, 'cli');
  assert.equal(h.spawnedServers.length, 0);
  assert.equal(h.service.getModelState().status, 'unloaded');

  // Checksum mismatch also forces cli fallback cleanly.
  const mismatchBin = resolveLlamaServerBinary({
    runtimeDir: path.dirname(path.dirname(path.join(tmpDir, 'ai-addons', 'models', 'summary', 'qwen3.5-9b-q4-k-m', 'runtime', 'linux-x64', 'extract', 'cuda-12.8'))),
    runtimeArtifact: { id: 'llama-cpp-v0.3.0-linux-x64-cuda-12.8' },
    platform: 'linux',
    fsModule: fs,
    pathModule: path,
    pinnedLinuxServer: { runtimeId: 'llama-cpp-v0.3.0-linux-x64-cuda-12.8', sha256: '0'.repeat(64), sizeBytes: 1 },
  });
  assert.equal(mismatchBin.mode, 'cli');

  // Remove CUDA runtime dir -> fail closed on Linux eligibility.
  fs.rmSync(path.join(tmpDir, 'ai-addons', 'cuda'), { recursive: true, force: true });
  const elig = await h.handlers.get('get-history-qa-eligibility')({});
  assert.equal(elig.eligible, false);
  await assert.rejects(() => h.handlers.get('ask-history')({}, { question: 'Hi' }), /CUDA/);

  // Even when dir exists, live CUDA resolver returning not-ready fails closed before spawning llama-server.
  const tmpBadCuda = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-badcuda-'));
  t.after(() => fs.rmSync(tmpBadCuda, { recursive: true, force: true }));
  const badCudaHarness = makeQaHarness({ tmpDir: tmpBadCuda, cudaReady: false });
  await assert.rejects(() => badCudaHarness.handlers.get('ask-history')({}, { question: 'Launch?' }), /CUDA 12 runtime/);
  assert.equal(badCudaHarness.spawnedServers.length, 0);
});

test('cancel-history-qa aborts in-flight generation and forceKillOnShutdown cleans resident server', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-cancel-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const h = makeQaHarness({
    tmpDir,
    onQaRunnerPayload(_payload, _proc) {
      // Hold open until cancel-history-qa terminates it!
    },
  });

  const pending = h.handlers.get('ask-history')({}, { question: 'Slow answer' });
  await new Promise((r) => setTimeout(r, 30));
  const cancelRes = await h.handlers.get('cancel-history-qa')({});
  assert.equal(cancelRes.canceled, true);

  await assert.rejects(() => pending, (err) => err && err.code === HISTORY_QA_CANCEL_CODE);

  // Resident server stayed loaded until forceKillOnShutdown runs.
  assert.equal(h.spawnedServers.length, 1);
  h.service.forceKillOnShutdown();
  assert.equal(h.spawnedServers[0].proc.killedSignal, 'SIGKILL');
});


test('admission reserves synchronously and cancellation interrupts pending eligibility', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-admission-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const harness = makeQaHarness({ tmpDir, checkStatus: () => new Promise(() => {}) });
  const first = harness.service.askHistory({ question: 'first' });
  await assert.rejects(harness.service.askHistory({ question: 'second' }), /already being generated/);
  assert.equal(harness.service.cancelActiveQuestion().canceled, true);
  await assert.rejects(first, (error) => error.code === HISTORY_QA_CANCEL_CODE);
  assert.equal(harness.spawnedPython.length, 0);
});

test('canceled queued question never starts model work', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-queue-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  let release;
  let queued;
  const waiting = new Promise((resolve) => { queued = resolve; });
  const harness = makeQaHarness({ tmpDir, queueAction: (action) => new Promise((resolve, reject) => {
    release = () => Promise.resolve().then(action).then(resolve, reject);
    queued();
  }) });
  const pending = harness.service.askHistory({ question: 'when?' });
  await waiting;
  harness.service.cancelActiveQuestion();
  release();
  await assert.rejects(pending, (error) => error.code === HISTORY_QA_CANCEL_CODE);
  assert.equal(harness.spawnedServers.length, 0);
  assert.equal(harness.spawnedPython.filter((entry) => entry.args.includes('history_qa.qa_runner')).length, 0);
});

test('idle unload waits until an active warm question finishes', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-warm-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  let count = 0;
  let finish;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const harness = makeQaHarness({ tmpDir, idleTimeoutMs: 30, onQaRunnerPayload(_payload, proc) {
    count += 1;
    const respond = () => {
      proc.stdout.emit('data', JSON.stringify({ status: 'answered', answerMarkdown: 'answer', citations: [], evidenceCount: 1 }));
      proc.emit('close', 0);
    };
    if (count === 1) respond();
    else { finish = respond; signalStarted(); }
  } });
  await harness.service.askHistory({ question: 'first' });
  const pending = harness.service.askHistory({ question: 'second' });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(harness.spawnedServers[0].proc.killedSignal, undefined);
  finish();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(harness.spawnedServers[0].proc.killedSignal);
});

test('switching models unloads prior resident server with model_changed without self-canceling the new turn', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-model-switch-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const modelPathA = path.join(tmpDir, 'model-a.gguf');
  const modelPathB = path.join(tmpDir, 'model-b.gguf');
  fs.writeFileSync(modelPathA, 'gguf-a');
  fs.writeFileSync(modelPathB, 'gguf-b');

  let activeModelId = 'qwen3.5-9b-q4-k-m';
  let activeModelPath = modelPathA;
  const h = makeQaHarness({
    tmpDir,
    getSummaryArtifactPath: () => activeModelPath,
    checkStatus: async () => ({
      features: {
        summary: {
          status: 'ready',
          setupComplete: true,
          modelId: activeModelId,
          cache: { valid: true },
          runtimeCache: { valid: true },
        },
      },
    }),
  });

  const first = await h.service.askHistory({ question: 'First model question?' });
  assert.equal(first.status, 'answered');
  assert.equal(h.spawnedServers.length, 1);

  activeModelId = 'qwen3.5-4b-q4-k-m';
  activeModelPath = modelPathB;
  const second = await h.service.askHistory({ question: 'Second model question?' });
  assert.equal(second.status, 'answered');
  assert.equal(h.spawnedServers.length, 2);
  assert.equal(h.spawnedServers[0].proc.killedSignal, 'SIGTERM');

  const modelStates = h.events
    .filter((e) => e.channel === 'history-qa-model-state')
    .map((e) => ({ status: e.payload.status, reason: e.payload.reason }));
  assert.ok(modelStates.some((s) => s.status === 'unloading' && s.reason === 'model_changed'));
  assert.ok(modelStates.some((s) => s.status === 'unloaded' && s.reason === 'model_changed'));
});


test('ask-history forwards draftMarkdown streaming progress, threadContext, shifted citations history, and failure metadata', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-v31-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const runnerPayloads = [];
  let turn = 0;
  const h = makeQaHarness({
    tmpDir,
    onQaRunnerPayload(payload, proc) {
      runnerPayloads.push(payload);
      turn += 1;
      if (turn === 1) {
        proc.stderr.emit('data', Buffer.from(`${JSON.stringify({
          type: 'progress',
          feature: 'history-qa',
          phase: 'streaming',
          percent: 65,
          message: 'Writing answer locally…',
          draftMarkdown: 'Draft citing hf_secret_token and Beta',
        })}\n`));
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          status: 'answered',
          answerMarkdown: 'Beta launches December 4 [E1].',
          citations: payload.evidence,
          retrievalMode: 'targeted',
          detectedDateFilter: '2026-11-18',
          searchedMeetingCount: 2,
          evidenceCount: 1,
        })));
        proc.emit('close', 0);
        return;
      }
      proc.stdout.emit('data', Buffer.from(JSON.stringify({
        status: 'verification_failed',
        failureReason: 'missing_citations',
        answerMarkdown: 'Unverified output',
        citations: [],
        inspectedSources: payload.evidence,
        retrievalMode: 'overview',
        searchedMeetingCount: 2,
        evidenceCount: 1,
      })));
      proc.emit('close', 0);
    },
  });

  const first = await h.handlers.get('ask-history')({}, { question: 'When does beta launch?' });
  assert.equal(first.status, 'answered');
  assert.equal(first.retrievalMode, 'targeted');
  assert.equal(first.detectedDateFilter, '2026-11-18');
  assert.equal(runnerPayloads[0].stream, true);

  const streamEvt = h.events.find((e) => e.channel === 'history-qa-progress' && e.payload.phase === 'streaming');
  assert.ok(streamEvt);
  assert.equal(streamEvt.payload.draftMarkdown, 'Draft citing [redacted-token] and Beta');

  // Switch evidence to m2 in "All recordings" scope and ask a follow-up.
  h.setRetrievalEvidence([
    {
      evidenceId: 'E1',
      meetingId: 'm2',
      meetingTitle: 'Vendor Sync',
      meetingDate: '2026-11-19T10:00:00',
      startSec: 12,
      endSec: 25,
      speaker: 'Bob',
      tag: 'call',
      kind: 'transcript',
      excerpt: 'Vendor contract signed.',
      text: 'Vendor contract signed.',
      sourceTranscriptHash: 'sha256:456',
    },
  ], 2);

  const second = await h.handlers.get('ask-history')({}, {
    threadId: first.thread.id,
    question: 'What else did he say about that?',
  });
  assert.equal(second.status, 'verification_failed');
  assert.equal(second.failureReason, 'missing_citations');
  assert.equal(second.assistantMessage.inspectedSources.length, 1);
  assert.equal(second.assistantMessage.inspectedSources[0].meetingId, 'm2');

  // Conversation history retained across shifted cited meeting IDs in All scope!
  assert.equal(runnerPayloads[1].history.length, 2);

  // threadContext was forwarded to retrieval preflight on the follow-up turn.
  const retrievalSpawns = h.spawnedPython.filter((entry) => entry.args.includes('history_qa.retrieval'));
  const secondRetrievalPayload = JSON.parse(retrievalSpawns[1].proc._stdinText);
  assert.deepEqual(secondRetrievalPayload.threadContext, {
    lastCitedMeetingIds: ['m1'],
    lastQuestion: 'When does beta launch?',
  });

  // Turn 3 after Turn 2 verification_failed still captures lastQuestion from Turn 1 (preceding most recent answered turn).
  await h.handlers.get('ask-history')({}, {
    threadId: first.thread.id,
    question: 'Clarify the timeline?',
  });
  const thirdRetrievalPayload = JSON.parse(
    h.spawnedPython.filter((entry) => entry.args.includes('history_qa.retrieval'))[2].proc._stdinText,
  );
  assert.deepEqual(thirdRetrievalPayload.threadContext, {
    lastCitedMeetingIds: ['m1'],
    lastQuestion: 'When does beta launch?',
  });
});

test('late stderr progress events are suppressed after cancel and threadContext falls back when no answered turn exists', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-late-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  let heldProc = null;
  let turn = 0;
  const h = makeQaHarness({
    tmpDir,
    onQaRunnerPayload(payload, proc) {
      turn += 1;
      if (turn === 1) {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          status: 'verification_failed',
          failureReason: 'missing_citations',
          answerMarkdown: 'Unverified output',
          citations: [],
          inspectedSources: payload.evidence,
          searchedMeetingCount: 1,
          evidenceCount: 1,
        })));
        proc.emit('close', 0);
        return;
      }
      heldProc = proc;
    },
  });

  // Turn 1 fails verification (no answered turns in thread yet).
  const first = await h.handlers.get('ask-history')({}, { question: 'Initial failed question?' });
  assert.equal(first.status, 'verification_failed');

  // Turn 2 should fall back to Turn 1's user question because no answered turn exists yet.
  const pending = h.handlers.get('ask-history')({}, {
    threadId: first.thread.id,
    question: 'Retry question?',
  });
  await new Promise((r) => setTimeout(r, 30));
  const retrievalSpawns = h.spawnedPython.filter((entry) => entry.args.includes('history_qa.retrieval'));
  const secondRetrievalPayload = JSON.parse(retrievalSpawns[1].proc._stdinText);
  assert.deepEqual(secondRetrievalPayload.threadContext, {
    lastCitedMeetingIds: [],
    lastQuestion: 'Initial failed question?',
  });

  // Cancel Turn 2 and emit a late stderr progress line before process closes.
  const eventsBeforeCancel = h.events.length;
  await h.handlers.get('cancel-history-qa')({});
  heldProc.stderr.emit('data', Buffer.from(`${JSON.stringify({
    type: 'progress',
    feature: 'history-qa',
    phase: 'streaming',
    percent: 90,
    message: 'Late chunk after cancel',
    draftMarkdown: 'Should never be emitted',
  })}\n`));
  await assert.rejects(() => pending, (err) => err && err.code === HISTORY_QA_CANCEL_CODE);

  const lateProgress = h.events
    .slice(eventsBeforeCancel)
    .filter((e) => e.channel === 'history-qa-progress' && e.payload.message === 'Late chunk after cancel');
  assert.equal(lateProgress.length, 0);
});
