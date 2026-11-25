'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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
  getSummaryArtifactForPlatform = null,
  getSummaryDeviceMemory = async () => null,
  ensureSummaryProcessExited = async () => {},
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
    getSummaryDeviceMemory,
    ensureSummaryProcessExited,
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
    getSummaryArtifactForPlatform: getSummaryArtifactForPlatform || (() => ({ id: 'qwen-artifact', fileName: 'Qwen3.5-9B-Q4_K_M.gguf' })),
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

test('scope changes exclude whole mixed-citation turns from history and retrieval context', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-scoped-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const payloads = [];
  const h = makeQaHarness({ tmpDir, onQaRunnerPayload(payload, proc) {
    payloads.push(payload);
    proc.stdout.emit('data', JSON.stringify({ status: 'answered', answerMarkdown: 'Answer [E1]', citations: payload.evidence }));
    proc.emit('close', 0);
  } });
  const citation = (id, tag, date) => ({ evidenceId: id, meetingId: id, tag, meetingDate: date, text: 'text', excerpt: 'text' });
  h.setRetrievalEvidence([citation('m1', 'call', '2026-11-18'), citation('m2', 'lecture', '2026-10-01')]);
  const first = await h.handlers.get('ask-history')({}, { question: 'First?' });
  h.setRetrievalEvidence([citation('m1', 'call', '2026-11-18')]);
  await h.handlers.get('ask-history')({}, { threadId: first.thread.id, question: 'Follow up?', scope: { type: 'all', tags: ['call'], dateFrom: '2026-11-01', dateTo: '2026-11-30' } });
  assert.deepEqual(payloads[1].history, []);
  const retrieval = h.spawnedPython.filter((entry) => entry.args.includes('history_qa.retrieval'));
  assert.equal(JSON.parse(retrieval[1].proc._stdinText).threadContext, undefined);
});

test('live memory is checked after server exit, and exact reuse does not reallocate', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-live-fit-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  let id = 'qwen3.5-9b-q4-k-m';
  let memoryChecks = 0;
  let gates = 0;
  const h = makeQaHarness({
    tmpDir,
    getSummaryArtifactPath: () => path.join(tmpDir, `${id}.gguf`),
    ensureSummaryProcessExited: async () => { gates += 1; },
    getSummaryDeviceMemory: async () => { memoryChecks += 1; return { availableBytes: 100 }; },
    checkStatus: async () => ({ features: { summary: {
      status: 'ready', setupComplete: true, modelId: id,
      cache: { valid: true }, runtimeCache: { valid: true }, fit: { blocked: false },
    } } }),
  });
  await h.service.askHistory({ question: 'First?' });
  await h.service.askHistory({ question: 'Reuse?' });
  assert.equal(memoryChecks, 1);
  id = 'qwen3.5-4b-q4-k-m';
  await h.service.askHistory({ question: 'Switch?' });
  assert.equal(memoryChecks, 2);
  assert.ok(h.spawnedServers[0].proc.killedSignal);
  assert.ok(gates >= 3);
  await h.service.unloadModel('manual');
  assert.ok(gates >= 4);
});

test('failed process exit or blocked live fit prevents a new model load', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-live-block-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  let failGate = true;
  const h = makeQaHarness({
    tmpDir,
    ensureSummaryProcessExited: async () => { if (failGate) throw new Error('Process exit unconfirmed'); },
    getSummaryDeviceMemory: async () => ({ availableBytes: 1 }),
    checkStatus: async (opts) => ({ features: { summary: {
      status: 'ready', setupComplete: true, modelId: 'qwen3.5-9b-q4-k-m',
      cache: { valid: true }, runtimeCache: { valid: true },
      fit: { blocked: Boolean(opts.deviceMemory), reason: 'Not enough memory' },
    } } }),
  });
  await assert.rejects(h.service.askHistory({ question: 'First?' }), /Process exit unconfirmed/);
  failGate = false;
  await assert.rejects(h.service.askHistory({ question: 'Second?' }), /Not enough memory/);
  assert.equal(h.spawnedServers.length, 0);
});

test('CLI fallback waits for model exit and Free memory retries an orphan without stopping an active summary', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cli-slot-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  let exitWaits = 0;
  const h = makeQaHarness({
    tmpDir,
    createServerSibling: false,
    ensureSummaryProcessExited: async () => { exitWaits += 1; },
    onQaRunnerPayload(_payload, proc) {
      proc.stdout.emit('data', JSON.stringify({ status: 'answered', answerMarkdown: 'CLI answer [E1]', citations: [{ evidenceId: 'E1', meetingId: 'm1' }] }));
      proc.emit('close', 0);
    },
  });
  await h.service.askHistory({ question: 'CLI?' });
  assert.ok(exitWaits >= 2);

  let raced = false;
  let activeSummary = true;
  let terminations = 0;
  let orphan = createFakeProcess();
  const { createHistoryQaService } = require('../../src/main/history-qa-service');
  const { createChatThreadStore } = require('../../src/main/chat-thread-store');
  const guarded = createHistoryQaService({
    app: { getPath: () => tmpDir },
    path,
    fs,
    pythonConfig: { backendPath: tmpDir },
    spawnTrackedPython: () => assert.fail('unused'),
    getBackendModuleArgs: (m, a) => ['-m', m, ...a],
    collectPythonProcessOutput: () => ({}),
    enqueueAiComputeAction: (fn) => fn(),
    getAiAddonRuntimeOptions: () => ({}),
    ensureSummaryProcessExited: async () => {
      raced = true;
      if (terminations === 1) throw new Error('exit unconfirmed');
      orphan = null;
    },
    getOutstandingSummaryProcess: () => orphan,
    hasActiveSummaryGeneration: () => activeSummary,
    terminateProcessBestEffort: async (proc) => { assert.equal(proc, orphan); terminations += 1; },
    historySearchService: { getGeneration: () => 1, ensureSynced: async () => {}, enqueueOperation: (fn) => fn(), getIndexPath: () => path.join(tmpDir, 'idx.sqlite') },
    chatThreadStore: createChatThreadStore({ app: { getPath: () => tmpDir }, path, fs }),
  });
  const res = await guarded.unloadModel('competing_gpu_work');
  assert.equal(res.alreadyUnloaded, true);
  assert.equal(raced, false);
  assert.equal(guarded.getModelState().status, 'unloaded');

  activeSummary = false;
  await assert.rejects(guarded.unloadModel(), /exit unconfirmed/);
  assert.equal(terminations, 1);
  assert.equal(guarded.getModelState().status, 'release_error');
  assert.equal(guarded.getModelState().modelId, null);

  assert.deepEqual(await guarded.unloadModel(), { unloaded: true, alreadyUnloaded: false });
  assert.equal(terminations, 2);
  assert.equal(orphan, null);
  assert.equal(guarded.getModelState().status, 'unloaded');
});

test('get-history-qa-eligibility accepts modelId and falls back to usable library models; askHistory creates thread atomically', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-elig-fallback-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const modelPath = path.join(tmpDir, 'gemma.gguf');
  fs.writeFileSync(modelPath, 'gguf');
  const h = makeQaHarness({
    tmpDir,
    getSummaryArtifactPath: () => modelPath,
    checkStatus: async (opts) => {
      if (opts.summaryModelId === 'gemma-4-e4b') {
        return {
          features: { summary: { status: 'ready', setupComplete: true, modelId: 'gemma-4-e4b', cache: { valid: true }, runtimeCache: { valid: true } } },
          summaryLibrary: { defaultModelId: 'qwen3.5-9b-q4-k-m', models: [{ modelId: 'gemma-4-e4b', installed: true, setupComplete: true, status: 'ready', fit: { blocked: false } }] },
        };
      }
      return {
        features: { summary: { status: 'error', setupComplete: false, modelId: 'qwen3.5-9b-q4-k-m', cache: { valid: false }, runtimeCache: { valid: true } } },
        summaryLibrary: {
          defaultModelId: 'qwen3.5-9b-q4-k-m',
          models: [
            { modelId: 'qwen3.5-9b-q4-k-m', installed: false, setupComplete: false, status: 'error' },
            { modelId: 'gemma-4-e4b', installed: true, setupComplete: true, status: 'ready', fit: { blocked: false } },
          ],
        },
      };
    },
  });
  const fallbackElig = await h.handlers.get('get-history-qa-eligibility')({}, {});
  assert.equal(fallbackElig.eligible, true);
  assert.equal(fallbackElig.modelId, 'gemma-4-e4b');

  const explicitElig = await h.handlers.get('get-history-qa-eligibility')({}, { modelId: 'gemma-4-e4b' });
  assert.equal(explicitElig.eligible, true);
  assert.equal(explicitElig.modelId, 'gemma-4-e4b');

  // Failed default askHistory must not create an orphan empty thread.
  await assert.rejects(() => h.handlers.get('ask-history')({}, { question: 'Fail default?' }));
  const threadsAfterFail = await h.handlers.get('list-chat-threads')({});
  assert.equal(threadsAfterFail.threads.length, 0);

  const ok = await h.handlers.get('ask-history')({}, { question: 'Use override?', threadModelId: 'gemma-4-e4b', modelId: 'gemma-4-e4b' });
  assert.equal(ok.thread.modelId, 'gemma-4-e4b');
});

test('ai-addon-ipc checks live VRAM, pre-validates removal, awaits process exit on smoke, and returns status on validate cancel', async (t) => {
  const { EventEmitter } = require('node:events');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-addon-ipc-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const { createAiAddonIpc, AI_ADDON_CANCEL_CODE } = require('../../src/main/ai-addon-ipc');
  const { saveAiAddonManifest } = require('../../src/ai-addon/manifest-store');
  const { getModelById } = require('../../src/ai-addon-state');
  saveAiAddonManifest({
    userDataDir: tmpDir,
    manifest: {
      features: { summary: { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' } },
      summaryLibrary: {
        defaultModelId: 'qwen3.5-9b-q4-k-m',
        models: {
          'qwen3.5-9b-q4-k-m': { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' },
          'qwen3.5-4b-q4-k-m': { status: 'ready', modelId: 'qwen3.5-4b-q4-k-m' },
          'gemma-4-e4b': { status: 'ready', modelId: 'gemma-4-e4b' },
        },
      },
    },
  });
  const memoryCalls = [];
  let exclusiveRemovalCalls = 0;
  let exitWaits = 0;
  let pauseValidationMemory = null;
  let notifyValidationMemoryStarted = null;
  const handlers = new Map();
  const svc = createAiAddonIpc({
    app: { getPath: () => tmpDir },
    path,
    fs,
    pythonConfig: { pythonExe: 'python', backendPath: tmpDir },
    spawnTrackedPython: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      process.nextTick(() => {
        proc.stdout.emit('data', JSON.stringify({ ok: true }));
        proc.emit('close', 0);
      });
      return proc;
    },
    ensureSummaryProcessExited: async () => { exitWaits += 1; },
    appendSpawnLogBuffer: (a, b) => a + b.toString(),
    sendToRenderer: () => {},
    getSafeStorage: () => ({}),
    assertTrustedRendererSender: () => {},
    buildCudaRuntimeEnv: () => ({}),
    resolveCudaStatusForTranscription: async () => ({
      statusCode: 'ready',
      installed: true,
      deviceAvailable: true,
      runtimeLoadable: true,
      missingLibraries: [],
      matchedProfile: 'cuda12',
    }),
    createAbortableComputeAction: ({ action }) => action(),
    terminateProcessBestEffort: () => {},
    buildManagedDiarizationValidationArgs: () => [],
    buildSummaryArgs: () => ['-m', 'summaries.summary_runner', '--validate-runtime'],
    summarizeDiarizationError: (s) => s,
    summarizeSummaryValidationError: (s) => s,
    getSummaryDeviceMemory: async (opts = {}) => {
      memoryCalls.push(opts);
      if (pauseValidationMemory) {
        notifyValidationMemoryStarted?.();
        await pauseValidationMemory;
      }
      return { totalBytes: 32 * 1024 ** 3, availableBytes: 24 * 1024 ** 3 };
    },
    enqueueGpuExclusiveRemovalAction: (fn) => { exclusiveRemovalCalls += 1; return fn(); },
    checkAiAddonSetupStatus: async (opts = {}) => ({
      summaryLibrary: { defaultModelId: 'qwen3.5-9b-q4-k-m', models: [] },
      features: { summary: { status: 'notConfigured', modelId: opts.summaryModelId || 'qwen3.5-9b-q4-k-m', setupComplete: false } },
    }),
  });
  svc.registerIpc({ handle: (ch, fn) => handlers.set(ch, fn) });

  // remove-summary-model rejects before acquiring GPU exclusive removal queue when replacementModelId is missing.
  await assert.rejects(() => handlers.get('remove-summary-model')({}, { modelId: 'qwen3.5-9b-q4-k-m' }), /replacement default/);
  assert.equal(exclusiveRemovalCalls, 0);

  // set-default-summary-model calls getSummaryDeviceMemory({ live: true }).
  await assert.rejects(() => handlers.get('set-default-summary-model')({}, { modelId: getModelById('summary', 'qwen3.5-4b-q4-k-m').id }));
  assert.equal(memoryCalls.at(-1)?.live, true);

  // validateSummaryRuntimeSmoke awaits ensureSummaryProcessExited().
  const smokeRuntimeDir = path.join(tmpDir, 'smoke-runtime');
  fs.mkdirSync(path.join(smokeRuntimeDir, 'extract'), { recursive: true });
  fs.writeFileSync(path.join(smokeRuntimeDir, 'extract', 'llama-cli'), 'fixture');
  for (const library of ['cublas', 'cudnn']) {
    fs.mkdirSync(path.join(tmpDir, 'ai-addons', 'cuda', 'python', 'nvidia', library, 'lib'), { recursive: true });
  }
  await svc.validateSummaryRuntimeSmoke({
    modelId: 'qwen3.5-9b-q4-k-m',
    runtimeArtifact: { executableName: 'llama-cli' },
    runtimeDir: smokeRuntimeDir,
    cudaStatus: { statusCode: 'ready', installed: true, deviceAvailable: true, runtimeLoadable: true, missingLibraries: [], matchedProfile: 'cuda12' },
  });
  assert.equal(exitWaits, 1);

  // validate-summary-model cancel returns status snapshot (not { canceled: true }) and uses live memory.
  let releaseMemory;
  pauseValidationMemory = new Promise((resolve) => { releaseMemory = resolve; });
  const memoryStarted = new Promise((resolve) => { notifyValidationMemoryStarted = resolve; });
  const pendingValidate = handlers.get('validate-summary-model')({}, { modelId: 'qwen3.5-9b-q4-k-m' });
  await memoryStarted;
  await handlers.get('cancel-summary-model-setup')({});
  pauseValidationMemory = null;
  releaseMemory();
  const canceledStatus = await pendingValidate;
  assert.ok(canceledStatus.summaryLibrary);
  assert.equal(canceledStatus.canceled, undefined);
  assert.ok(memoryCalls.some((c) => c.live === true));
});

test('general chat (scope.type = none) bypasses FTS5/zero-hit gate, enforces CUDA gate, passes contextTokens, and isolates history across mode switches', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-general-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const runnerPayloads = [];
  let turn = 0;
  const h = makeQaHarness({
    tmpDir,
    onQaRunnerPayload(payload, proc) {
      runnerPayloads.push(payload);
      turn += 1;
      if (payload.chatMode === 'general') {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          status: 'answered',
          chatMode: 'general',
          answerMarkdown: `General answer ${turn}.`,
          citations: [{ evidenceId: 'E1', meetingId: 'should-be-dropped' }],
          searchedMeetingCount: 99,
          evidenceCount: 99,
        })));
      } else {
        // Cross the production verifier boundary before persisting the turn and testing its follow-up.
        const root = path.resolve(__dirname, '../..');
        const venv = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        const python = fs.existsSync(venv) ? venv : (process.platform === 'win32' ? 'python' : 'python3');
        const modelReply = {
          answerMarkdown: `Grounded answer ${turn} [E1].`,
          insufficientEvidence: false,
          citations: [{ evidenceId: 'E1', passageKey: 'invented:7', startSec: 999 }],
        };
        const verified = JSON.parse(execFileSync(python, ['-c', [
          'import json, sys',
          'from backend.history_qa.citation_verifier import verify_grounded_response',
          'reply, evidence = json.load(sys.stdin)',
          'print(json.dumps(verify_grounded_response(json.dumps(reply), evidence)))',
        ].join('\n')], { cwd: root, input: JSON.stringify([modelReply, payload.evidence]), encoding: 'utf8' }));
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          ...verified,
          chatMode: 'grounded',
          retrievalMode: 'direct_full',
          searchedMeetingCount: 1,
          evidenceCount: payload.evidence.length,
        })));
      }
      proc.emit('close', 0);
    },
  });

  // 1. General chat with 0 indexed recordings / 0 evidence bypasses FTS5 sync and retrieval completely.
  h.setRetrievalEvidence([], 0);
  const gen1 = await h.handlers.get('ask-history')({}, {
    question: 'Explain closures in JavaScript',
    scope: { type: 'none' },
  });
  assert.equal(gen1.status, 'answered');
  assert.equal(gen1.chatMode, 'general');
  assert.equal(gen1.searchedMeetingCount, 0);
  assert.equal(gen1.evidenceCount, 0);
  assert.deepEqual(gen1.assistantMessage.citations, []);
  assert.equal(gen1.assistantMessage.chatMode, 'general');
  assert.equal(h.getSyncCalls(), 0);
  assert.equal(h.spawnedPython.filter((e) => e.args.includes('history_qa.retrieval')).length, 0);
  assert.equal(runnerPayloads[0].chatMode, 'general');
  assert.equal(runnerPayloads[0].contextTokens, 32768);
  assert.deepEqual(runnerPayloads[0].evidence, []);
  assert.deepEqual(runnerPayloads[0].history, []);
  assert.equal(
    h.events.some((e) => e.channel === 'history-qa-progress' && e.payload.phase === 'retrieving'),
    false,
  );

  // 2. Follow-up in general mode carries prior general turn cleanly.
  const gen2 = await h.handlers.get('ask-history')({}, {
    threadId: gen1.thread.id,
    question: 'Give a short example',
  });
  assert.equal(gen2.chatMode, 'general');
  assert.equal(h.getSyncCalls(), 0);
  assert.equal(runnerPayloads[1].chatMode, 'general');
  assert.equal(runnerPayloads[1].history.length, 2);
  assert.equal(runnerPayloads[1].history[0].content, 'Explain closures in JavaScript');

  // 3. Switching thread to grounded mode isolates prior general turns from history and retrieval context.
  h.setRetrievalEvidence([
    {
      evidenceId: 'E1',
      meetingId: 'm1',
      meetingTitle: 'Launch Sync',
      meetingDate: '2026-11-18T10:00:00',
      startSec: 65,
      endSec: 80,
      speaker: 'Alice',
      passageKey: 'm1:3',
      kind: 'transcript',
      excerpt: 'Beta launches December 4.',
      text: 'Beta launches December 4.',
      sourceTranscriptHash: 'sha256:123',
    },
  ], 1);
  const gr1 = await h.handlers.get('ask-history')({}, {
    threadId: gen1.thread.id,
    question: 'When does beta launch?',
    scope: { type: 'all' },
  });
  assert.equal(gr1.chatMode, 'grounded');
  assert.equal(gr1.assistantMessage.chatMode, 'grounded');
  assert.equal(gr1.assistantMessage.retrievalMode, 'direct_full');
  assert.equal(gr1.assistantMessage.citations[0].startSec, 65);
  assert.equal(h.getSyncCalls(), 1);
  assert.equal(runnerPayloads[2].chatMode, 'grounded');
  assert.deepEqual(runnerPayloads[2].history, []);
  const retrievalSpawns = () => h.spawnedPython.filter((e) => e.args.includes('history_qa.retrieval'));
  const firstGroundedRetrieval = JSON.parse(retrievalSpawns()[0].proc._stdinText);
  assert.equal(firstGroundedRetrieval.contextTokens, 32768);
  assert.equal(firstGroundedRetrieval.threadContext, undefined);
  assert.equal(firstGroundedRetrieval.priorTurnContext, undefined);

  // 4. Second grounded turn passes priorTurnContext (passageKey, speaker, summary) and grounded history.
  const gr2 = await h.handlers.get('ask-history')({}, {
    threadId: gen1.thread.id,
    question: 'What else did she say?',
  });
  assert.equal(gr2.chatMode, 'grounded');
  assert.equal(runnerPayloads[3].history.length, 2);
  const secondGroundedRetrieval = JSON.parse(retrievalSpawns()[1].proc._stdinText);
  assert.deepEqual(secondGroundedRetrieval.priorTurnContext, {
    lastQuestion: 'When does beta launch?',
    lastCitedMeetingIds: ['m1'],
    lastCitedPassageKeys: ['m1:3'],
    speakers: ['Alice'],
    lastAssistantSummary: 'Grounded answer 3.',
  });

  // 5. Switching back to scope.type = none clears grounded history from the prompt and skips retrieval again.
  const gen3 = await h.handlers.get('ask-history')({}, {
    threadId: gen1.thread.id,
    question: 'Write a haiku about snow',
    scope: { type: 'none' },
  });
  assert.equal(gen3.chatMode, 'general');
  assert.equal(h.getSyncCalls(), 2);
  assert.equal(retrievalSpawns().length, 2);
  assert.equal(runnerPayloads[4].chatMode, 'general');
  assert.deepEqual(runnerPayloads[4].history, []);

  // 6. General chat still fails closed on Linux when CUDA 12 runtime is not ready.
  const tmpNoCuda = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-gen-nocuda-'));
  t.after(() => fs.rmSync(tmpNoCuda, { recursive: true, force: true }));
  const badCuda = makeQaHarness({ tmpDir: tmpNoCuda, cudaReady: false });
  await assert.rejects(
    () => badCuda.handlers.get('ask-history')({}, { question: 'Hello', scope: { type: 'none' } }),
    /CUDA 12 runtime/,
  );
  assert.equal(badCuda.spawnedServers.length, 0);
});

test('ensureServerRunning passes valid reasoningEffort before reasoningBudget and retrieval preflight receives grounded history', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-effort-hist-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const runnerPayloads = [];
  const h = makeQaHarness({
    tmpDir,
    getSummaryArtifactForPlatform: () => ({
      id: 'qwen-artifact',
      fileName: 'Qwen3.5-9B-Q4_K_M.gguf',
      inference: {
        contextTokens: 32768,
        family: 'qwen',
        promptFormat: 'chatml',
        disableThinking: false,
        reasoningEffort: 'low',
        reasoningBudget: 256,
      },
    }),
    onQaRunnerPayload(payload, proc) {
      runnerPayloads.push(payload);
      proc.stdout.emit('data', Buffer.from(JSON.stringify({
        status: 'answered',
        chatMode: 'grounded',
        retrievalMode: 'direct_full',
        answerMarkdown: `Answer ${runnerPayloads.length} [E1].`,
        citations: payload.evidence,
        searchedMeetingCount: 1,
        evidenceCount: payload.evidence.length,
      })));
      proc.emit('close', 0);
    },
  });

  const turn1 = await h.handlers.get('ask-history')({}, { question: 'When does beta launch?' });
  assert.equal(turn1.status, 'answered');
  const serverArgs = h.spawnedServers[0].args;
  const effortIdx = serverArgs.indexOf('--reasoning-effort');
  const budgetIdx = serverArgs.indexOf('--reasoning-budget');
  assert.notEqual(effortIdx, -1);
  assert.equal(serverArgs[effortIdx + 1], 'low');
  assert.ok(effortIdx < budgetIdx);
  assert.equal(serverArgs[budgetIdx + 1], '256');

  const retrievalSpawns = () => h.spawnedPython.filter((e) => e.args.includes('history_qa.retrieval'));
  const firstRetrievalPayload = JSON.parse(retrievalSpawns()[0].proc._stdinText);
  assert.equal(firstRetrievalPayload.history, undefined);

  await h.handlers.get('ask-history')({}, {
    threadId: turn1.thread.id,
    question: 'What else did Alice mention?',
  });
  const secondRetrievalPayload = JSON.parse(retrievalSpawns()[1].proc._stdinText);
  assert.deepEqual(secondRetrievalPayload.history, runnerPayloads[1].history);
  assert.equal(secondRetrievalPayload.history.length, 2);
  assert.equal(secondRetrievalPayload.history[0].content, 'When does beta launch?');
  assert.deepEqual(secondRetrievalPayload.history[1].citations, [{ meetingTitle: 'Launch Sync' }]);

  // Invalid or missing reasoningEffort must not emit --reasoning-effort.
  const tmpBad = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-effort-bad-'));
  t.after(() => fs.rmSync(tmpBad, { recursive: true, force: true }));
  const hBad = makeQaHarness({
    tmpDir: tmpBad,
    getSummaryArtifactForPlatform: () => ({
      id: 'qwen-artifact',
      fileName: 'Qwen3.5-9B-Q4_K_M.gguf',
      inference: {
        contextTokens: 32768,
        family: 'qwen',
        promptFormat: 'chatml',
        reasoningEffort: 'extreme',
      },
    }),
  });
  await hBad.handlers.get('ask-history')({}, { question: 'Hello', scope: { type: 'none' } });
  assert.equal(hBad.spawnedServers[0].args.includes('--reasoning-effort'), false);
});

test('retired bonsai-2-27b-q2-0 threads stay usable when installed, migrate to bonsai-2.5-27b-q2-0 when replaced, and cannot be newly created uninstalled', async (t) => {
  const { getModelById, getRetiredSummaryModelById, getSummaryArtifactForPlatform } = require('../../src/ai-addon-state');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-bonsai-mig-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const model2Path = path.join(tmpDir, 'Ternary-Bonsai-2-27B-Q2_0.gguf');
  const model25Path = path.join(tmpDir, 'Ternary-Bonsai-2.5-27B-Q2_0.gguf');
  fs.writeFileSync(model2Path, 'gguf2');
  fs.writeFileSync(model25Path, 'gguf25');

  const extractDir = path.join(tmpDir, 'runtime', 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'ai-addons', 'cuda', 'python'), { recursive: true });
  fs.writeFileSync(path.join(extractDir, 'llama-cli'), 'cli');
  const serverPath = path.join(extractDir, 'llama-server');
  fs.writeFileSync(serverPath, 'srv');
  const serverBytes = fs.readFileSync(serverPath);

  let installedModels = new Set(['bonsai-2-27b-q2-0']);
  const chatThreadStore = createChatThreadStore({ app: { getPath: () => tmpDir }, path, fs });
  const handlers = new Map();
  const service = createHistoryQaService({
    app: { getPath: () => tmpDir },
    path,
    fs,
    platform: 'linux',
    arch: 'x64',
    pinnedLinuxServer: {
      runtimeId: 'llama-cpp-b12631-linux-x64-cuda-12.8',
      sha256: createHash('sha256').update(serverBytes).digest('hex'),
      sizeBytes: serverBytes.length,
    },
    pythonConfig: { backendPath: path.join(tmpDir, 'backend') },
    getBackendModuleArgs: (mod, args) => ['-m', mod, ...args],
    getAiAddonRuntimeOptions: (opts) => opts || {},
    checkAiAddonSetupStatus: async (opts = {}) => {
      const id = opts.summaryModelId || 'qwen3.5-9b-q4-k-m';
      const ready = installedModels.has(id);
      return {
        features: {
          summary: {
            status: ready ? 'ready' : 'notConfigured',
            setupComplete: ready,
            modelId: id,
            cache: { valid: ready },
            runtimeCache: {
              valid: true,
              runtimeDir: path.dirname(extractDir),
              runtimeArtifact: { id: 'llama-cpp-b12631-linux-x64-cuda-12.8' },
            },
          },
        },
        summaryLibrary: { defaultModelId: 'qwen3.5-9b-q4-k-m', models: [] },
      };
    },
    getSummaryArtifactForPlatform: (id, p, a) => getSummaryArtifactForPlatform(id, p, a),
    getSummaryRuntimeArtifactForPlatform: () => ({ id: 'llama-cpp-b12631-linux-x64-cuda-12.8' }),
    getModelById: (feature, id) => getModelById(feature, id),
    getRetiredSummaryModelById: (id) => getRetiredSummaryModelById(id),
    getSummaryArtifactPath: (_dir, artifact) => (artifact.modelId === 'bonsai-2-27b-q2-0' ? model2Path : model25Path),
    getSummaryRuntimeDir: () => path.dirname(extractDir),
    buildSummaryRuntimeEnv: () => ({}),
    resolveCudaStatusForTranscription: async () => ({
      statusCode: 'ready',
      installed: true,
      deviceAvailable: true,
      runtimeLoadable: true,
      missingLibraries: [],
      matchedProfile: 'cuda12',
    }),
    historySearchService: {
      getGeneration: () => 1,
      enqueueOperation: (action) => action(),
      retainProcessUntilExit: () => {},
      getIndexPath: () => path.join(tmpDir, 'search.sqlite'),
      async ensureSynced() { return { synced: true }; },
    },
    chatThreadStore,
    enqueueAiComputeAction: (fn) => fn(),
    allocateLoopbackPort: async () => 45123,
    probeServerHealth: async () => true,
    spawnServerProcess: () => {
      const proc = createFakeProcess();
      proc.pid = 4242;
      return proc;
    },
    spawnTrackedPython: (_args) => {
      const proc = createFakeProcess();
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          status: 'answered',
          chatMode: 'general',
          answerMarkdown: 'OK',
          citations: [],
        })));
        proc.emit('close', 0);
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
  service.registerIpc({ handle: (ch, fn) => handlers.set(ch, fn) });

  // Installed legacy Bonsai 2 27B thread continues to run without migration.
  const created = await handlers.get('create-chat-thread')({}, { modelId: 'bonsai-2-27b-q2-0', scope: { type: 'none' } });
  assert.equal(created.thread.modelId, 'bonsai-2-27b-q2-0');
  const turn1 = await handlers.get('ask-history')({}, {
    threadId: created.thread.id,
    modelId: 'bonsai-2-27b-q2-0',
    question: 'Hi',
  });
  assert.equal(turn1.thread.modelId, 'bonsai-2-27b-q2-0');
  assert.equal(turn1.thread.messages.at(-1).modelId, 'bonsai-2-27b-q2-0');

  // After removing Bonsai 2 27B and installing Bonsai 2.5 27B, eligibility and thread migrate cleanly.
  installedModels = new Set(['bonsai-2.5-27b-q2-0']);
  const elig = await handlers.get('get-history-qa-eligibility')({}, { modelId: 'bonsai-2-27b-q2-0' });
  assert.equal(elig.eligible, true);
  assert.equal(elig.modelId, 'bonsai-2.5-27b-q2-0');

  const turn2 = await handlers.get('ask-history')({}, {
    threadId: created.thread.id,
    modelId: 'bonsai-2-27b-q2-0',
    question: 'Follow up',
  });
  assert.equal(turn2.thread.modelId, 'bonsai-2.5-27b-q2-0');
  assert.equal(turn2.thread.messages.at(-1).modelId, 'bonsai-2.5-27b-q2-0');

  // Creating or updating a thread to an uninstalled retired ID is rejected.
  await assert.rejects(() => handlers.get('create-chat-thread')({}, { modelId: 'bonsai-2-27b-q2-0' }), /Invalid Chat model selection/);
  await assert.rejects(() => handlers.get('update-chat-thread-model')({}, { threadId: created.thread.id, modelId: 'bonsai-2-27b-q2-0' }), /Invalid Chat model selection/);

  await service.unloadModel('test_cleanup');
});

test('installed legacy bonsai-2-27b-q2-0 thread preserves thread.modelId on transient ineligibility and migrates only once uninstalled', async (t) => {
  const { getModelById, getRetiredSummaryModelById, getSummaryArtifactForPlatform } = require('../../src/ai-addon-state');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-qa-bonsai-repair-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const model2Path = path.join(tmpDir, 'Ternary-Bonsai-2-27B-Q2_0.gguf');
  const model25Path = path.join(tmpDir, 'Ternary-Bonsai-2.5-27B-Q2_0.gguf');
  fs.writeFileSync(model2Path, 'gguf2');
  fs.writeFileSync(model25Path, 'gguf25');

  const extractDir = path.join(tmpDir, 'runtime', 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'ai-addons', 'cuda', 'python'), { recursive: true });
  fs.writeFileSync(path.join(extractDir, 'llama-cli'), 'cli');
  const serverPath = path.join(extractDir, 'llama-server');
  fs.writeFileSync(serverPath, 'srv');
  const serverBytes = fs.readFileSync(serverPath);

  let model2State = { status: 'ready', setupComplete: true, installed: true, valid: true };
  const chatThreadStore = createChatThreadStore({ app: { getPath: () => tmpDir }, path, fs });
  const handlers = new Map();
  const service = createHistoryQaService({
    app: { getPath: () => tmpDir },
    path,
    fs,
    platform: 'linux',
    arch: 'x64',
    pinnedLinuxServer: {
      runtimeId: 'llama-cpp-b12631-linux-x64-cuda-12.8',
      sha256: createHash('sha256').update(serverBytes).digest('hex'),
      sizeBytes: serverBytes.length,
    },
    pythonConfig: { backendPath: path.join(tmpDir, 'backend') },
    getBackendModuleArgs: (mod, args) => ['-m', mod, ...args],
    getAiAddonRuntimeOptions: (opts) => opts || {},
    checkAiAddonSetupStatus: async (opts = {}) => {
      const id = opts.summaryModelId || 'qwen3.5-9b-q4-k-m';
      const isLegacy = id === 'bonsai-2-27b-q2-0';
      const summaryEntry = isLegacy
        ? {
            status: model2State.status,
            setupComplete: model2State.setupComplete,
            modelId: id,
            cache: { installed: model2State.installed, valid: model2State.valid },
            runtimeCache: {
              valid: true,
              runtimeDir: path.dirname(extractDir),
              runtimeArtifact: { id: 'llama-cpp-b12631-linux-x64-cuda-12.8' },
            },
          }
        : {
            status: 'ready',
            setupComplete: true,
            modelId: id,
            cache: { installed: true, valid: true },
            runtimeCache: {
              valid: true,
              runtimeDir: path.dirname(extractDir),
              runtimeArtifact: { id: 'llama-cpp-b12631-linux-x64-cuda-12.8' },
            },
          };
      return {
        features: { summary: summaryEntry },
        summaryLibrary: {
          defaultModelId: 'bonsai-2.5-27b-q2-0',
          models: [
            {
              modelId: 'bonsai-2-27b-q2-0',
              installed: model2State.installed,
              setupComplete: model2State.setupComplete,
              status: model2State.status,
            },
            {
              modelId: 'bonsai-2.5-27b-q2-0',
              installed: true,
              setupComplete: true,
              status: 'ready',
            },
          ],
        },
      };
    },
    getSummaryArtifactForPlatform: (id, p, a) => getSummaryArtifactForPlatform(id, p, a),
    getSummaryRuntimeArtifactForPlatform: () => ({ id: 'llama-cpp-b12631-linux-x64-cuda-12.8' }),
    getModelById: (feature, id) => getModelById(feature, id),
    getRetiredSummaryModelById: (id) => getRetiredSummaryModelById(id),
    getSummaryArtifactPath: (_dir, artifact) => (artifact.modelId === 'bonsai-2-27b-q2-0' ? model2Path : model25Path),
    getSummaryRuntimeDir: () => path.dirname(extractDir),
    buildSummaryRuntimeEnv: () => ({}),
    resolveCudaStatusForTranscription: async () => ({
      statusCode: 'ready',
      installed: true,
      deviceAvailable: true,
      runtimeLoadable: true,
      missingLibraries: [],
      matchedProfile: 'cuda12',
    }),
    historySearchService: {
      getGeneration: () => 1,
      enqueueOperation: (action) => action(),
      retainProcessUntilExit: () => {},
      getIndexPath: () => path.join(tmpDir, 'search.sqlite'),
      async ensureSynced() { return { synced: true }; },
    },
    chatThreadStore,
    enqueueAiComputeAction: (fn) => fn(),
    allocateLoopbackPort: async () => 45124,
    probeServerHealth: async () => true,
    spawnServerProcess: () => {
      const proc = createFakeProcess();
      proc.pid = 4243;
      return proc;
    },
    spawnTrackedPython: () => {
      const proc = createFakeProcess();
      process.nextTick(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          status: 'answered',
          chatMode: 'general',
          answerMarkdown: 'OK',
          citations: [],
        })));
        proc.emit('close', 0);
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
  service.registerIpc({ handle: (ch, fn) => handlers.set(ch, fn) });

  // Create a thread while legacy bonsai-2-27b-q2-0 is ready.
  const created = await handlers.get('create-chat-thread')({}, { modelId: 'bonsai-2-27b-q2-0', scope: { type: 'none' } });
  assert.equal(created.thread.modelId, 'bonsai-2-27b-q2-0');

  // Transient/repair-needed ineligibility (installed: true, valid: false, status: 'error')
  // while bonsai-2.5-27b-q2-0 is also installed must not overwrite thread.modelId.
  model2State = { status: 'error', setupComplete: false, installed: true, valid: false };

  const blockedElig = await handlers.get('get-history-qa-eligibility')({}, { modelId: 'bonsai-2-27b-q2-0' });
  assert.equal(blockedElig.eligible, false);
  assert.equal(blockedElig.modelId, 'bonsai-2-27b-q2-0');
  assert.match(blockedElig.reason, /Install or repair/i);
  assert.equal(Object.hasOwn(blockedElig, 'modelInstalled'), false);

  await assert.rejects(
    () => handlers.get('ask-history')({}, {
      threadId: created.thread.id,
      modelId: 'bonsai-2-27b-q2-0',
      question: 'Still broken?',
    }),
    /Install or repair/i,
  );
  const persistedBeforeUninstall = await chatThreadStore.getThread(created.thread.id);
  assert.equal(persistedBeforeUninstall.modelId, 'bonsai-2-27b-q2-0');

  // Draft thread with broken retired modelId must reject without creating a thread.
  await assert.rejects(
    () => handlers.get('ask-history')({}, {
      threadModelId: 'bonsai-2-27b-q2-0',
      scope: { type: 'none' },
      question: 'Draft broken?',
    }),
    /Invalid Chat model selection/,
  );
  assert.equal((await chatThreadStore.listThreads()).length, 1);

  // Once bonsai-2-27b-q2-0 is uninstalled, eligibility and existing thread migrate cleanly.
  model2State = { status: 'notConfigured', setupComplete: false, installed: false, valid: false };
  const migratedElig = await handlers.get('get-history-qa-eligibility')({}, { modelId: 'bonsai-2-27b-q2-0' });
  assert.equal(migratedElig.eligible, true);
  assert.equal(migratedElig.modelId, 'bonsai-2.5-27b-q2-0');

  const migratedTurn = await handlers.get('ask-history')({}, {
    threadId: created.thread.id,
    modelId: 'bonsai-2-27b-q2-0',
    question: 'Now uninstalled',
  });
  assert.equal(migratedTurn.thread.modelId, 'bonsai-2.5-27b-q2-0');
  assert.equal(migratedTurn.thread.messages.at(-1).modelId, 'bonsai-2.5-27b-q2-0');

  await assert.rejects(
    () => handlers.get('ask-history')({}, {
      threadModelId: 'bonsai-2-27b-q2-0',
      scope: { type: 'none' },
      question: 'Draft after uninstall?',
    }),
    /Invalid Chat model selection/,
  );

  await service.unloadModel('test_cleanup');
});
