'use strict';

/**
 * Main-process service for grounded local History Q&A and resident `llama-server` lifecycle.
 *
 * Invariants:
 * - Never starts a model on app startup or when opening the Chat tab (`unloaded` until first hit).
 * - Syncs SQLite FTS5 index & runs `history_qa.retrieval` preflight BEFORE queuing GPU compute or
 *   allocating VRAM; 0-hit queries return `insufficient_evidence` without starting `llama-server`.
 * - Launches `llama-server` strictly on `127.0.0.1:<ephemeralPort>` authenticated with a per-launch
 *   256-bit `LLAMA_API_KEY` env var (never argv, never logged, never exposed to renderer).
 * - Automatically unloads before any competing GPU/CUDA/summary-mutation job, after 10 minutes idle,
 *   and during quit drain / force-quit.
 */

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const childProcess = require('child_process');

const {
  AI_COMPUTE_TIMEOUT_MS,
  runWallClockComputeAction,
  createCancellableProcessRegistrar,
  buildClearedHuggingFaceTokenEnv,
  buildHuggingFaceOfflineEnv,
  parseAiBackendProgressLine,
  splitBufferedLines,
  signalProcessTree,
} = require('../main-process-helpers');
const {
  checkAiAddonSetupStatus: defaultCheckAiAddonSetupStatus,
  getSummaryArtifactPath: defaultGetSummaryArtifactPath,
  getSummaryRuntimeDir: defaultGetSummaryRuntimeDir,
} = require('../ai-addon-setup');
const {
  getSummaryArtifactForPlatform: defaultGetSummaryArtifactForPlatform,
  getSummaryRuntimeArtifactForPlatform: defaultGetSummaryRuntimeArtifactForPlatform,
  getModelById: defaultGetModelById,
} = require('../ai-addon-state');
const {
  buildSummaryRuntimeEnv: defaultBuildSummaryRuntimeEnv,
} = require('../ai-addon/manifest-store');
const { isLinuxCudaStatusReadyForAdmission } = require('../main-process/linux-cuda-runtime-helpers');
const { redactSensitiveText } = require('../ai-progress-sanitizer');

const HISTORY_QA_MODEL_STATE_CHANNEL = 'history-qa-model-state';
const HISTORY_QA_PROGRESS_CHANNEL = 'history-qa-progress';
const HISTORY_QA_CANCEL_CODE = 'HISTORY_QA_CANCELLED';
const DEFAULT_IDLE_UNLOAD_MS = 10 * 60 * 1000;
const DEFAULT_SERVER_STARTUP_TIMEOUT_MS = 120 * 1000;
const GENERIC_SPEAKER_RE = /^(?:speaker(?:\s+|_)\d+|unknown)$/i;
const INLINE_CITATION_RE = /\[E\d+(?:\s*[,;/]\s*E\d+)*\]/g;

function getMessageChatMode(message) {
  return message && message.chatMode === 'general' ? 'general' : 'grounded';
}

function sliceMessagesSinceModeSwitch(messages, chatMode) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  let boundaryIndex = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant' && getMessageChatMode(messages[i]) !== chatMode) {
      boundaryIndex = i + 1;
      break;
    }
  }
  return messages.slice(boundaryIndex);
}

function summarizeAssistantForContext(content) {
  return String(content || '')
    .replace(INLINE_CITATION_RE, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
    .slice(0, 280);
}

const PINNED_LINUX_LLAMA_SERVER = Object.freeze({
  runtimeId: 'llama-cpp-v0.3.0-linux-x64-cuda-12.8',
  relativePath: 'cuda-12.8/llama-server',
  sha256: 'e24d8686017f6dc7be39c7563a24cf9383e54aca6627af53a3898f1e4b736d19',
  sizeBytes: 14592,
});

function createQaCancelError(message = 'Response generation was stopped.') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = HISTORY_QA_CANCEL_CODE;
  return err;
}

function defaultAllocateLoopbackPort(netModule = net) {
  return new Promise((resolve, reject) => {
    const server = netModule.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        if (!port || port < 1 || port > 65535) {
          reject(new Error('Failed to allocate loopback port for local Q&A server.'));
          return;
        }
        resolve(port);
      });
    });
  });
}

function defaultSpawnServerProcess(executablePath, args, options = {}) {
  const usePosixGroup = process.platform !== 'win32' && options.detached !== false;
  const proc = childProcess.spawn(executablePath, args, {
    ...options,
    detached: usePosixGroup,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.avanevisProcessGroup = usePosixGroup;
  return proc;
}

function sha256File(fsModule, filePath) {
  const hash = crypto.createHash('sha256');
  const data = fsModule.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function findRegularExecutableInExtractRoot({ fsModule, pathModule, realExtractRoot, executableName }) {
  const stack = [realExtractRoot];
  while (stack.length > 0) {
    const dir = stack.shift();
    let entries;
    try {
      entries = fsModule.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      const candidate = pathModule.join(dir, entry.name);
      let lstat;
      try {
        lstat = fsModule.lstatSync(candidate);
      } catch (_error) {
        continue;
      }
      if (lstat.isSymbolicLink()) {
        continue;
      }
      if (lstat.isDirectory()) {
        stack.push(candidate);
        continue;
      }
      if (lstat.isFile() && entry.name === executableName) {
        try {
          const realCandidate = pathModule.resolve(fsModule.realpathSync(candidate));
          const rel = pathModule.relative(realExtractRoot, realCandidate);
          if (rel && !rel.startsWith('..') && !pathModule.isAbsolute(rel)) {
            return realCandidate;
          }
        } catch (_error) {
          continue;
        }
      }
    }
  }
  return null;
}

function resolveLlamaServerBinary({
  runtimeDir,
  runtimeArtifact = null,
  platform = process.platform,
  fsModule,
  pathModule,
  pinnedLinuxServer = PINNED_LINUX_LLAMA_SERVER,
} = {}) {
  const extractRoot = pathModule.join(runtimeDir, 'extract');
  if (!fsModule.existsSync(extractRoot)) {
    return { mode: 'none', executablePath: null, workingDir: null, reason: 'Runtime extract directory missing.' };
  }

  let realExtractRoot;
  try {
    realExtractRoot = pathModule.resolve(fsModule.realpathSync(extractRoot));
  } catch (_error) {
    return { mode: 'none', executablePath: null, workingDir: null, reason: 'Cannot resolve extract directory.' };
  }

  const cliName = platform === 'win32' ? 'llama-cli.exe' : 'llama-cli';
  const serverName = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const cliPath = findRegularExecutableInExtractRoot({
    fsModule,
    pathModule,
    realExtractRoot,
    executableName: cliName,
  });

  if (!cliPath) {
    return { mode: 'none', executablePath: null, workingDir: null, reason: 'llama-cli executable missing.' };
  }

  const executableDir = pathModule.dirname(cliPath);
  const candidateServer = pathModule.join(executableDir, serverName);
  try {
    const stat = fsModule.lstatSync(candidateServer);
    if (!stat.isSymbolicLink() && stat.isFile()) {
      const realServer = pathModule.resolve(fsModule.realpathSync(candidateServer));
      const rel = pathModule.relative(realExtractRoot, realServer);
      if (rel && !rel.startsWith('..') && !pathModule.isAbsolute(rel)) {
        if (platform === 'linux') {
          const requiredFiles = [
            ...(runtimeArtifact?.requiredFiles || []),
            ...(runtimeArtifact?.artifacts || []).flatMap((archive) => archive.requiredFiles || []),
          ];
          const catalogPin = requiredFiles.find((entry) =>
            typeof entry === 'object' && pathModule.basename(entry.path || entry.relativePath || '') === serverName);
          const pin = catalogPin || (runtimeArtifact?.id === pinnedLinuxServer.runtimeId ? pinnedLinuxServer : null);
          const actualDigest = pin?.sha256 ? sha256File(fsModule, realServer) : null;
          if (!pin?.sha256 || stat.size !== pin.sizeBytes || actualDigest !== pin.sha256) {
            return {
              mode: 'cli',
              executablePath: cliPath,
              workingDir: executableDir,
              reason: 'Linux llama-server checksum mismatch; falling back to single-turn llama-cli.',
            };
          }
        }
        return {
          mode: 'server',
          executablePath: realServer,
          workingDir: executableDir,
          reason: null,
        };
      }
    }
  } catch (_error) {
    // Fall back gracefully to llama-cli below.
  }

  return {
    mode: 'cli',
    executablePath: cliPath,
    workingDir: executableDir,
    reason: 'llama-server sibling not found; using single-turn llama-cli.',
  };
}

function defaultHttpHealthProbe({ port, token, httpModule = http, timeoutMs = 1500 }) {
  return new Promise((resolve) => {
    const req = httpModule.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        agent: false,
        timeout: timeoutMs,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function waitAbortableMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : createQaCancelError());
      return;
    }
    const timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : createQaCancelError());
    };
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function awaitAbortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || createQaCancelError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || createQaCancelError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * @param {object} deps
 */
function createHistoryQaService(deps) {
  const {
    app,
    path,
    fs,
    net: netModule = net,
    http: httpModule = http,
    pythonConfig,
    spawnTrackedPython,
    spawnSummaryPython = spawnTrackedPython,
    ensureSummaryProcessExited = async () => {},
    getOutstandingSummaryProcess = () => null,
    hasActiveSummaryGeneration = () => false,
    getSummaryDeviceMemory = async () => null,
    spawnServerProcess = defaultSpawnServerProcess,
    getBackendModuleArgs,
    collectPythonProcessOutput,
    enqueueAiComputeAction,
    enqueueGpuResourceActionForQa = (action) => action(),
    hasPendingAiComputeWork = () => false,
    getAiAddonRuntimeOptions,
    checkAiAddonSetupStatus = defaultCheckAiAddonSetupStatus,
    getSummaryArtifactForPlatform = defaultGetSummaryArtifactForPlatform,
    getSummaryRuntimeArtifactForPlatform = defaultGetSummaryRuntimeArtifactForPlatform,
    getModelById = defaultGetModelById,
    getSummaryArtifactPath = defaultGetSummaryArtifactPath,
    getSummaryRuntimeDir = defaultGetSummaryRuntimeDir,
    buildSummaryRuntimeEnv = defaultBuildSummaryRuntimeEnv,
    resolveCudaStatusForTranscription = null,
    historySearchService,
    chatThreadStore,
    sendToRenderer = () => {},
    assertTrustedRendererSender = () => {},
    terminateProcessBestEffort = async (proc) => proc?.kill?.(),
    isQuitCommitted = () => false,
    hasInFlightAiAddonSetup = () => false,
    platform = process.platform,
    arch = process.arch,
    idleTimeoutMs = DEFAULT_IDLE_UNLOAD_MS,
    serverStartupTimeoutMs = DEFAULT_SERVER_STARTUP_TIMEOUT_MS,
    serverStopTimeoutMs = 6000,
    allocateLoopbackPort = () => defaultAllocateLoopbackPort(netModule),
    probeServerHealth = ({ port, token }) => defaultHttpHealthProbe({ port, token, httpModule }),
    pinnedLinuxServer = PINNED_LINUX_LLAMA_SERVER,
    baseEnv = process.env,
    retrievalTimeoutMs = 30 * 1000,
    qaTimeoutMs = AI_COMPUTE_TIMEOUT_MS.historyQa,
  } = deps;

  let modelState = {
    status: 'unloaded',
    modelId: null,
    modelName: null,
    backend: null,
    loadedAt: null,
    reason: 'initial',
  };

  let residentServer = null;
  let idleTimer = null;
  let activeUnloadPromise = null;
  let activeQaRequest = null;

  function sanitizeModelStatePayload(state) {
    return {
      status: state.status,
      modelId: state.modelId || null,
      modelName: state.modelName || null,
      backend: state.backend || null,
      loadedAt: state.loadedAt || null,
      reason: state.reason || null,
    };
  }

  function emitModelState(patch) {
    modelState = {
      ...modelState,
      ...patch,
    };
    sendToRenderer('history-qa-model-state', sanitizeModelStatePayload(modelState));
  }

  function emitQaProgress(payload) {
    sendToRenderer('history-qa-progress', {
      threadId: payload.threadId || null,
      phase: String(payload.phase || 'status'),
      message: redactSensitiveText(String(payload.message || '')).slice(0, 300),
      ...(Number.isFinite(payload.percent) ? { percent: payload.percent } : {}),
      ...(typeof payload.draftMarkdown === 'string' && payload.draftMarkdown
        ? { draftMarkdown: redactSensitiveText(payload.draftMarkdown).slice(0, 16000) }
        : {}),
    });
  }

  function getModelState() {
    return sanitizeModelStatePayload(modelState);
  }

  function isModelLoaded() {
    return modelState.status === 'loaded' && Boolean(residentServer);
  }

  function hasLoadedOrActiveWork() {
    return Boolean(residentServer || activeQaRequest || modelState.status !== 'unloaded');
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function resetIdleTimer() {
    clearIdleTimer();
    if (!residentServer || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void unloadModel('idle_timeout').catch((err) => {
        console.warn('Idle unload of local Q&A model failed:', err?.message || err);
      });
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  async function resolveEligibility({
    verifyChecksums = false,
    verifyChecksumsIfChanged = true,
    summaryModelId = null,
    deviceMemory,
    cudaStatus,
    checkFit = false,
    fallbackToUsableLibraryModel = false,
  } = {}) {
    const status = await checkAiAddonSetupStatus(
      getAiAddonRuntimeOptions({
        verifySelectedSummaryOnly: true,
        verifyChecksums,
        verifyChecksumsIfChanged,
        ...(summaryModelId ? { summaryModelId } : {}),
        ...(deviceMemory !== undefined ? { deviceMemory } : {}),
        ...(cudaStatus !== undefined ? { cudaStatus } : {}),
      }),
    );
    const evaluateStatus = (targetStatus) => {
      const summaryStatus = targetStatus && targetStatus.features && targetStatus.features.summary;
      if (!summaryStatus) {
        return {
          eligible: false,
          reason: 'Chat uses the Summaries & Chat add-on, which is not set up.',
          setupTarget: 'ai-addons',
          modelId: null,
          modelName: null,
          artifactId: null,
        };
      }

      const modelId = summaryStatus.modelId || null;
      const modelFit = summaryStatus.fit || targetStatus.summaryLibrary?.models?.find((item) => item.modelId === modelId)?.fit;
      if (checkFit && modelFit?.blocked === true) {
        return { eligible: false, reason: modelFit.reason || 'This model cannot run safely on this device.', setupTarget: 'ai-addons', modelId };
      }
      const modelMeta = modelId ? getModelById('summary', modelId) : null;
      const modelName = (modelMeta && (modelMeta.label || modelMeta.name)) || modelId || null;
      const artifact = modelId ? getSummaryArtifactForPlatform(modelId, platform, arch) : null;
      const runtimeArtifact = summaryStatus.runtimeCache?.runtimeArtifact || getSummaryRuntimeArtifactForPlatform(platform, arch, undefined, modelId);
      const runtimeDir = summaryStatus.runtimeCache?.runtimeDir || null;

      if (platform === 'linux') {
        const managedRuntimePath = path.join(app.getPath('userData'), 'ai-addons', 'cuda', 'python');
        if (!fs.existsSync(managedRuntimePath)) {
          return {
            eligible: false,
            reason: 'Chat on Linux requires the CUDA 12 runtime and the Summaries & Chat add-on.',
            setupTarget: 'ai-addons',
            modelId,
            modelName,
            artifactId: artifact ? (artifact.artifactId || artifact.id) : null,
          };
        }
        const cacheReady = summaryStatus.cache?.valid === true && summaryStatus.runtimeCache?.valid === true;
        if (!cacheReady || !artifact || !runtimeArtifact) {
          return {
            eligible: false,
            reason: 'Install or repair the Summaries & Chat add-on in Settings before using Chat.',
            setupTarget: 'ai-addons',
            modelId,
            modelName,
            artifactId: artifact ? (artifact.artifactId || artifact.id) : null,
          };
        }
        return {
          eligible: true,
          reason: null,
          setupTarget: null,
          modelId,
          modelName,
          artifactId: artifact.artifactId || artifact.id,
          artifact,
          runtimeArtifact,
          runtimeDir,
        };
      }

      if (summaryStatus.status === 'unsupported') {
        return {
          eligible: false,
          reason: (summaryStatus.availability && summaryStatus.availability.reason)
            || summaryStatus.error
            || 'Chat is not supported on this platform.',
          setupTarget: 'ai-addons',
          modelId,
          modelName,
          artifactId: artifact ? (artifact.artifactId || artifact.id) : null,
        };
      }

      if (summaryStatus.status !== 'ready' || !summaryStatus.setupComplete || !artifact) {
        return {
          eligible: false,
          reason: 'Enable the Summaries & Chat add-on in Settings to use Chat.',
          setupTarget: 'ai-addons',
          modelId,
          modelName,
          artifactId: artifact ? (artifact.artifactId || artifact.id) : null,
        };
      }

      return {
        eligible: true,
        reason: null,
        setupTarget: null,
        modelId,
        modelName,
        artifactId: artifact.artifactId || artifact.id,
        artifact,
        runtimeArtifact,
        runtimeDir,
      };
    };

    const primary = evaluateStatus(status);
    if (!primary.eligible && !summaryModelId && fallbackToUsableLibraryModel) {
      const candidates = (status?.summaryLibrary?.models || []).filter(
        (item) => item.installed && item.setupComplete && item.status === 'ready' && item.fit?.blocked !== true,
      );
      for (const candidate of candidates) {
        const candidateStatus = await checkAiAddonSetupStatus(
          getAiAddonRuntimeOptions({
            verifySelectedSummaryOnly: true,
            verifyChecksums,
            verifyChecksumsIfChanged,
            summaryModelId: candidate.modelId,
            ...(deviceMemory !== undefined ? { deviceMemory } : {}),
            ...(cudaStatus !== undefined ? { cudaStatus } : {}),
          }),
        );
        const evaluated = evaluateStatus(candidateStatus);
        if (evaluated.eligible) {
          return evaluated;
        }
      }
    }
    return primary;
  }

  function sanitizeEligibilityResponse(full) {
    return {
      eligible: Boolean(full.eligible),
      reason: full.reason || null,
      setupTarget: full.setupTarget || null,
      modelId: full.modelId || null,
      modelName: full.modelName || null,
      artifactId: full.artifactId || null,
    };
  }

  function cancelActiveQuestion(reason = 'Response generation was stopped.') {
    if (!activeQaRequest) {
      return { canceled: false };
    }
    const req = activeQaRequest;
    if (!req.controller.signal.aborted) {
      req.controller.abort(createQaCancelError(reason));
    }
    if (req.process) {
      void Promise.resolve(terminateProcessBestEffort(req.process)).catch(() => {});
    }
    return { canceled: true, threadId: req.threadId || null };
  }

  async function stopServer(server) {
    void Promise.resolve().then(() => terminateProcessBestEffort(server.proc)).catch(() => {});
    let timer;
    try {
      await Promise.race([
        server.exitPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Local Q&A model server did not stop; please retry.')), serverStopTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function reportUnloaded(reason) {
    emitModelState({ status: 'unloaded', modelId: null, modelName: null, backend: null, loadedAt: null, reason });
  }

  async function confirmSummaryProcessExit() {
    const modelId = modelState.modelId;
    try {
      await ensureSummaryProcessExited();
    } catch (error) {
      emitModelState({ status: 'release_error', modelId: modelState.modelId || modelId, reason: 'exit_unconfirmed' });
      throw error;
    }
  }

  async function unloadModel(reason = 'manual', { cancelActive = true } = {}) {
    if (activeUnloadPromise) {
      return activeUnloadPromise;
    }

    const lastModelId = modelState.modelId;
    activeUnloadPromise = (async () => {
      clearIdleTimer();
      if (cancelActive) {
        cancelActiveQuestion('Response generation stopped because the local model is unloading.');
      }

      const server = residentServer;
      if (!server) {
        const outstanding = getOutstandingSummaryProcess();
        if (outstanding && (hasActiveSummaryGeneration(outstanding) || hasInFlightAiAddonSetup())) {
          return { unloaded: true, alreadyUnloaded: true };
        }
        if (outstanding) await terminateProcessBestEffort(outstanding);
        await ensureSummaryProcessExited();
        if (modelState.status !== 'unloaded') reportUnloaded(reason);
        return { unloaded: true, alreadyUnloaded: !outstanding };
      }

      emitModelState({ status: 'unloading', reason });
      server.unloading = true;
      server.token = null;

      await stopServer(server);
      await ensureSummaryProcessExited();
      reportUnloaded(reason);

      return { unloaded: true, alreadyUnloaded: false };
    })().catch((error) => {
      emitModelState({ status: 'release_error', modelId: modelState.modelId || lastModelId, reason: 'exit_unconfirmed' });
      throw error;
    }).finally(() => {
      activeUnloadPromise = null;
    });

    return activeUnloadPromise;
  }

  async function ensureUnloadedForCompetingWork(reason = 'competing_gpu_work') {
    if (!residentServer && modelState.status === 'unloaded') {
      return { unloaded: true, alreadyUnloaded: true };
    }
    return unloadModel(reason);
  }

  async function abortActiveAndUnloadForQuit() {
    cancelActiveQuestion('Local Q&A canceled because the app is quitting.');
    return unloadModel('app_quit');
  }

  function forceKillOnShutdown() {
    clearIdleTimer();
    if (activeQaRequest) {
      try {
        activeQaRequest.controller.abort(createQaCancelError('App is quitting.'));
      } catch (_error) {
        // Ignore abort error during shutdown.
      }
      if (activeQaRequest.process) {
        try {
          signalProcessTree(activeQaRequest.process, 'SIGKILL');
        } catch (_error) {
          // Best-effort force kill.
        }
      }
    }
    if (residentServer && residentServer.proc) {
      try {
        signalProcessTree(residentServer.proc, 'SIGKILL');
      } catch (_error) {
        try {
          residentServer.proc.kill('SIGKILL');
        } catch (_innerErr) {
          // Best-effort force kill.
        }
      }
      residentServer.token = null;
    }
  }

  function buildRuntimeSpawnEnv({ userDataDir, artifact, runtimeArtifact, runtimeDir, serverToken = null }) {
    let runtimeEnv = {};
    if (platform === 'linux') {
      runtimeEnv = buildSummaryRuntimeEnv({
        userDataDir,
        artifact,
        runtimeArtifact,
        runtimeDir,
        platform,
        arch,
      });
    }
    const merged = buildClearedHuggingFaceTokenEnv({
      ...baseEnv,
      ...buildHuggingFaceOfflineEnv(),
      ...runtimeEnv,
    });
    if (serverToken) {
      merged.LLAMA_API_KEY = serverToken;
    }
    return merged;
  }

  async function ensureServerRunning({
    modelId,
    modelName,
    modelPath,
    runtimeDir,
    artifact,
    runtimeArtifact,
    binaryInfo,
    cancelSignal,
    checkLiveAdmission,
  }) {
    if (
      residentServer
      && residentServer.modelId === modelId
      && residentServer.artifactIdentity === JSON.stringify([artifact, runtimeArtifact])
      && residentServer.modelPath === modelPath
      && residentServer.runtimeDir === runtimeDir
      && !residentServer.exited
      && !residentServer.unloading
    ) {
      return residentServer;
    }

    if (residentServer) {
      await unloadModel('model_changed', { cancelActive: false });
    }

    if (cancelSignal && cancelSignal.aborted) {
      throw cancelSignal.reason instanceof Error ? cancelSignal.reason : createQaCancelError();
    }

    await confirmSummaryProcessExit();
    await checkLiveAdmission();
    if (cancelSignal?.aborted || isQuitCommitted()) throw cancelSignal?.reason || createQaCancelError();
    const userDataDir = app.getPath('userData');
    const token = crypto.randomBytes(32).toString('hex');
    const port = await awaitAbortable(allocateLoopbackPort(), cancelSignal);
    if (cancelSignal?.aborted || isQuitCommitted() || hasInFlightAiAddonSetup()) throw cancelSignal?.reason || createQaCancelError();
    const args = [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--model',
      modelPath,
      '--ctx-size',
      String(artifact.inference?.contextTokens || 32768),
      '--n-gpu-layers',
      artifact.inference?.singleTurnOnly ? '999' : '-1',
      '--parallel',
      '1',
      '--no-webui',
      '--reasoning',
      artifact.inference?.disableThinking === false ? 'auto' : 'off',
    ];
    if (Number.isInteger(artifact.inference?.reasoningBudget)) {
      args.push('--reasoning-budget', String(artifact.inference.reasoningBudget));
    }
    if (artifact.inference?.singleTurnOnly) args.push('--fit', 'off');
    const spawnEnv = buildRuntimeSpawnEnv({
      userDataDir,
      artifact,
      runtimeArtifact,
      runtimeDir,
      serverToken: token,
    });

    emitModelState({
      status: 'loading',
      modelId,
      modelName,
      backend: 'llama-server',
      loadedAt: null,
      reason: 'lazy_start',
    });

    const proc = spawnServerProcess(binaryInfo.executablePath, args, {
      cwd: binaryInfo.workingDir,
      env: spawnEnv,
    });

    let exited = false;
    let exitCode = null;
    const recentStderr = [];
    if (proc.stderr && typeof proc.stderr.on === 'function') {
      let buf = '';
      proc.stderr.on('data', (chunk) => {
        const split = splitBufferedLines(String(chunk), buf);
        buf = split.remainder;
        for (const line of split.lines) {
          const safe = redactSensitiveText(line).replaceAll(token, '<redacted>').trim();
          if (safe) {
            recentStderr.push(safe);
            if (recentStderr.length > 25) {
              recentStderr.shift();
            }
          }
        }
      });
    }
    if (proc.stdout && typeof proc.stdout.on === 'function') {
      proc.stdout.on('data', () => {});
    }

    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });

    const serverEntry = {
      proc,
      port,
      url: `http://127.0.0.1:${port}`,
      token,
      modelId,
      modelName,
      modelPath,
      runtimeDir,
      artifactIdentity: JSON.stringify([artifact, runtimeArtifact]),
      exited: false,
      unloading: false,
      exitPromise,
    };

    residentServer = serverEntry;
    proc.on('error', (err) => {
      exited = true;
      serverEntry.exited = true;
      serverEntry.token = null;
      if (residentServer === serverEntry) {
        residentServer = null;
        clearIdleTimer();
        if (!serverEntry.unloading) reportUnloaded(`server_error:${err?.message || 'spawn_failed'}`);
      }
      resolveExit();
    });

    proc.on('close', (code) => {
      exited = true;
      exitCode = code;
      serverEntry.exited = true;
      serverEntry.token = null;
      if (residentServer === serverEntry) {
        residentServer = null;
        clearIdleTimer();
        if (!serverEntry.unloading) reportUnloaded(`process_exited_${code}`);
      }
      resolveExit();
    });

    try {
      const deadline = Date.now() + serverStartupTimeoutMs;
      while (Date.now() < deadline) {
        if (cancelSignal && cancelSignal.aborted) {
          throw cancelSignal.reason instanceof Error ? cancelSignal.reason : createQaCancelError();
        }
        if (exited) {
          const detail = recentStderr.slice(-3).join(' | ');
          throw new Error(
            detail
              ? `Local Q&A model server exited before becoming ready (code ${exitCode}): ${detail}`
              : `Local Q&A model server exited before becoming ready (code ${exitCode}).`,
          );
        }
        const healthy = await awaitAbortable(probeServerHealth({ port, token }), cancelSignal);
        if (cancelSignal?.aborted || serverEntry.unloading || isQuitCommitted()) throw cancelSignal?.reason || createQaCancelError();
        if (exited || residentServer !== serverEntry) throw new Error('Local Q&A model server exited during startup.');
        if (healthy) {
          emitModelState({
            status: 'loaded',
            modelId,
            modelName,
            backend: 'llama-server',
            loadedAt: new Date().toISOString(),
            reason: 'ready',
          });
          return serverEntry;
        }
        await waitAbortableMs(120, cancelSignal);
      }
      throw new Error('Timed out waiting for local Q&A model server to finish loading.');
    } catch (error) {
      try {
        await unloadModel('startup_aborted', { cancelActive: false });
      } catch (_stopError) {
        // Keep ownership until the child actually exits; later unloads can retry.
      }
      throw error;
    }
  }

  async function runPythonStdinJson({ moduleName, args = [], payload, env = {}, timeoutMs, registrar, threadId, emitProgressEvents = false, modelBearing = false }) {
    let spawnedModelBearing = false;
    try {
      return await new Promise((resolve, reject) => {
      try {
        registrar.throwIfCancelled();
      } catch (err) {
        reject(err);
        return;
      }

      const python = (modelBearing ? spawnSummaryPython : spawnTrackedPython)(
        getBackendModuleArgs(moduleName, args),
        {
          cwd: pythonConfig.backendPath,
          env,
        },
      );
      if (modelBearing) {
        spawnedModelBearing = true;
      }

      let registered = false;
      try {
        registrar.register(python);
        registered = true;
      } catch (err) {
        reject(err);
        return;
      }

      const processOutput = collectPythonProcessOutput(python, { jsonResult: true });
      let settled = false;
      let timedOut = false;
      let stderrRemainder = '';
      if (emitProgressEvents && python.stderr && typeof python.stderr.on === 'function') {
        python.stderr.on('data', (chunk) => {
          if (settled || timedOut || registrar.isCancelled()) {
            return;
          }
          const split = splitBufferedLines(String(chunk), stderrRemainder);
          stderrRemainder = split.remainder;
          for (const line of split.lines) {
            if (settled || timedOut || registrar.isCancelled()) {
              return;
            }
            const parsed = parseAiBackendProgressLine(line, 'history-qa');
            if (parsed) {
              emitQaProgress({
                threadId,
                phase: parsed.phase,
                message: parsed.message,
                percent: parsed.percent,
                ...(parsed.draftMarkdown ? { draftMarkdown: parsed.draftMarkdown } : {}),
              });
            }
          }
        });
      }

      const finish = (cb, val) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        if (activeQaRequest && activeQaRequest.process === python) {
          activeQaRequest.process = null;
        }
        cb(val);
      };

      const timeoutHandle = setTimeout(() => {
        void Promise.resolve(terminateProcessBestEffort(python)).catch(() => {});
        timedOut = true;
        if (moduleName === 'history_qa.retrieval') historySearchService.retainProcessUntilExit(python);
        finish(reject, new Error(`${moduleName} timed out.`));
      }, timeoutMs);
      timeoutHandle.unref?.();

      python.on('close', (code) => {
        if (timedOut) { finish(reject, new Error(`${moduleName} timed out.`)); return; }
        if (registrar.isCancelled()) {
          finish(reject, createQaCancelError());
          return;
        }
        try {
          processOutput.assertStdoutWithinLimit();
        } catch (err) {
          finish(reject, err);
          return;
        }
        if (code === 0) {
          try {
            finish(resolve, JSON.parse(processOutput.getStdout()));
          } catch (err) {
            finish(reject, new Error(`Failed to parse ${moduleName} output: ${err.message}`));
          }
          return;
        }
        const safeErr = redactSensitiveText(processOutput.getStderr().trim());
        finish(reject, new Error(safeErr || `${moduleName} exited with code ${code}.`));
      });

      python.on('error', (err) => {
        finish(reject, registrar.isCancelled() ? createQaCancelError() : err);
      });

      if (registered && python.stdin) {
        python.stdin.on?.('error', () => {});
        try {
          python.stdin.end(JSON.stringify(payload || {}));
        } catch (_writeErr) {
          // Child closed before stdin write; close/error handler will settle.
        }
      }
      });
    } finally {
      if (spawnedModelBearing) {
        await confirmSummaryProcessExit().catch(() => {});
      }
    }
  }

  async function askHistory(options = {}, { runQueuedCompute = null } = {}) {
    if (isQuitCommitted()) {
      throw new Error('Cannot answer questions while the app is quitting.');
    }
    if (activeQaRequest) {
      throw new Error('A local Q&A response is already being generated. Stop it or wait for it to finish.');
    }

    const question = typeof options.question === 'string'
      ? options.question.replace(/\s+/g, ' ').trim().slice(0, 2000)
      : '';
    if (!question) {
      throw new Error('Enter a question to search your recordings.');
    }

    const requestedScope = options.scope == null ? null : chatThreadStore.sanitizeScope(options.scope);
    const controller = new AbortController();
    activeQaRequest = { threadId: null, controller, phase: 'admitting', process: null };
    clearIdleTimer();
    let thread = null;
    const checkCurrent = () => {
      if (controller.signal.aborted || isQuitCommitted()) throw controller.signal.reason || createQaCancelError();
      if (hasInFlightAiAddonSetup()) throw new Error('Local AI setup is in progress; please retry.');
    };
    try {
    checkCurrent();
    const requestedThreadModelId = options.threadModelId == null ? null : String(options.threadModelId).trim() || null;
    if (requestedThreadModelId !== null && (typeof options.threadModelId !== 'string' || !getModelById('summary', requestedThreadModelId))) {
      throw new Error('Invalid Chat model selection.');
    }
    if (options.threadId) {
      thread = await chatThreadStore.getThread(options.threadId);
    }
    const targetModelId = (thread ? thread.modelId : requestedThreadModelId) || null;
    const eligibility = await awaitAbortable(resolveEligibility({
      verifyChecksums: true,
      verifyChecksumsIfChanged: true,
      summaryModelId: targetModelId,
    }), controller.signal);
    if (!eligibility.eligible || (targetModelId && eligibility.modelId !== targetModelId)) {
      throw new Error(eligibility.reason || 'The selected Chat model is unavailable. Choose another model in Settings.');
    }
    if (options.modelId && options.modelId !== eligibility.modelId) {
      throw new Error('The Chat model changed. Review the model selection and retry.');
    }
    if (!thread) {
      thread = await chatThreadStore.createThread({ scope: requestedScope, modelId: requestedThreadModelId });
    }
    const frozenModelId = eligibility.modelId;
    const frozenArtifact = JSON.stringify([eligibility.artifact, eligibility.runtimeArtifact, eligibility.runtimeDir]);
    const activeContextTokens = Number(eligibility.artifact?.inference?.contextTokens) || 32768;
    checkCurrent();
    const effectiveScope = requestedScope ?? thread.scope;
    const isGeneralChat = effectiveScope?.type === 'none';
    const chatMode = isGeneralChat ? 'general' : 'grounded';

    activeQaRequest.threadId = thread.id;

      const messages = Array.isArray(thread.messages) ? thread.messages : [];
      const modeIsolatedMessages = sliceMessagesSinceModeSwitch(messages, chatMode);

      let assertFresh = () => {
        checkCurrent();
      };
      let existingMessages = modeIsolatedMessages;
      let evidence = [];
      let searchedMeetingCount = 0;
      let detectedDateFilter = '';
      let retrievalMode = '';

      if (!isGeneralChat) {
        activeQaRequest.phase = 'retrieving';
        const preflightRegistrar = createCancellableProcessRegistrar({
          cancelSignal: controller.signal,
          terminateProcess: terminateProcessBestEffort,
          registerProcess: (proc) => {
            if (activeQaRequest && activeQaRequest.controller === controller) {
              activeQaRequest.process = proc;
            }
            return proc;
          },
          createCancelError: () => createQaCancelError(),
        });

        emitQaProgress({
          threadId: thread.id,
          phase: 'retrieving',
          message: 'Searching your transcripts…',
          percent: 10,
        });

        const generation = historySearchService.getGeneration();
        await historySearchService.ensureSynced();
        preflightRegistrar.throwIfCancelled();
        assertFresh = () => {
          checkCurrent();
          if (historySearchService.getGeneration() !== generation) throw new Error('History changed while answering; please retry.');
        };
        const scopedSelectedIds = effectiveScope && effectiveScope.type === 'selected_meetings'
          ? new Set((effectiveScope.meetingIds || []).map(String))
          : null;
        const scopedTags = Array.isArray(effectiveScope?.tags) && effectiveScope.tags.length
          ? new Set(effectiveScope.tags)
          : null;
        const dateFrom = effectiveScope?.dateFrom || '';
        const dateTo = effectiveScope?.dateTo || '';
        const hasScopeFilter = scopedSelectedIds || scopedTags || dateFrom || dateTo;
        const turnMatchesScope = (assistant) => {
          if (!hasScopeFilter) return true;
          if (!Array.isArray(assistant.citations) || !assistant.citations.length) return false;
          return assistant.citations.every((citation) => {
            if (!citation || typeof citation !== 'object') return false;
            if (scopedSelectedIds && !scopedSelectedIds.has(String(citation.meetingId))) return false;
            if (scopedTags && !scopedTags.has(citation.tag)) return false;
            if (dateFrom || dateTo) {
              const day = typeof citation.meetingDate === 'string' ? citation.meetingDate.slice(0, 10) : '';
              if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
              if ((dateFrom && day < dateFrom) || (dateTo && day > dateTo)) return false;
            }
            return true;
          });
        };
        existingMessages = hasScopeFilter ? modeIsolatedMessages.filter((message, index) => {
          if (message.role === 'user') {
            const next = modeIsolatedMessages[index + 1];
            return next?.role === 'assistant' && next.status === 'answered' && turnMatchesScope(next);
          }
          return message.role === 'assistant' && message.status === 'answered'
            && modeIsolatedMessages[index - 1]?.role === 'user' && turnMatchesScope(message);
        }) : modeIsolatedMessages;

        let lastCitedMeetingIds = [];
        let lastCitedPassageKeys = [];
        let lastCitedSpeakers = [];
        let lastAssistantSummary = '';
        let lastQuestion = '';
        let lastAnsweredIdx = -1;
        let lastCitedMsg = null;
        for (let i = existingMessages.length - 1; i >= 0; i -= 1) {
          const msg = existingMessages[i];
          if (msg.role === 'assistant' && msg.status === 'answered') {
            lastAnsweredIdx = i;
            lastAssistantSummary = summarizeAssistantForContext(msg.content);
            if (Array.isArray(msg.citations) && msg.citations.length > 0) {
              lastCitedMsg = msg;
              lastCitedMeetingIds = [...new Set(msg.citations.map((c) => c.meetingId).filter(Boolean))];
            }
            break;
          }
        }
        if (lastAnsweredIdx !== -1) {
          for (let i = lastAnsweredIdx - 1; i >= 0; i -= 1) {
            const msg = existingMessages[i];
            if (msg.role === 'user' && msg.content) {
              lastQuestion = String(msg.content);
              break;
            }
          }
          if (lastCitedMeetingIds.length === 0) {
            for (let i = lastAnsweredIdx - 1; i >= 0; i -= 1) {
              const msg = existingMessages[i];
              if (
                msg.role === 'assistant'
                && msg.status === 'answered'
                && Array.isArray(msg.citations)
                && msg.citations.length > 0
              ) {
                lastCitedMsg = msg;
                lastCitedMeetingIds = [...new Set(msg.citations.map((c) => c.meetingId).filter(Boolean))];
                break;
              }
            }
          }
        } else {
          for (let i = existingMessages.length - 1; i >= 0; i -= 1) {
            const msg = existingMessages[i];
            if (msg.role === 'user' && msg.content) {
              lastQuestion = String(msg.content);
              break;
            }
          }
        }
        if (lastCitedMsg && Array.isArray(lastCitedMsg.citations)) {
          lastCitedPassageKeys = [...new Set(
            lastCitedMsg.citations
              .map((c) => (typeof c?.passageKey === 'string' ? c.passageKey.trim() : ''))
              .filter(Boolean),
          )];
          lastCitedSpeakers = [...new Set(
            lastCitedMsg.citations
              .map((c) => (typeof c?.speaker === 'string' ? c.speaker.trim() : ''))
              .filter((spk) => spk && !GENERIC_SPEAKER_RE.test(spk)),
          )];
        }
        const mentionedText = `${lastQuestion} ${lastAssistantSummary}`.toLowerCase();
        const hasOtherNamedSubject = /\s[A-Z][a-z]{2,}/.test(lastQuestion)
          && !lastCitedSpeakers.some((spk) => mentionedText.includes(spk.toLowerCase()));
        const hintedSpeakers = hasOtherNamedSubject ? [] : lastCitedSpeakers;
        const threadContext = (lastCitedMeetingIds.length > 0 || lastQuestion)
          ? { lastCitedMeetingIds, lastQuestion }
          : null;
        const hasPriorTurnHints = (
          lastCitedPassageKeys.length > 0
          || hintedSpeakers.length > 0
          || Boolean(lastAssistantSummary)
        );
        const priorTurnContext = hasPriorTurnHints
          ? {
              ...(lastQuestion ? { lastQuestion } : {}),
              ...(lastCitedMeetingIds.length > 0 ? { lastCitedMeetingIds } : {}),
              ...(lastCitedPassageKeys.length > 0 ? { lastCitedPassageKeys } : {}),
              ...(hintedSpeakers.length > 0 ? { speakers: hintedSpeakers } : {}),
              ...(lastAssistantSummary ? { lastAssistantSummary } : {}),
            }
          : null;

        const runRetrieval = () => runPythonStdinJson({
          moduleName: 'history_qa.retrieval',
          args: [
            '--recordings-dir',
            path.join(app.getPath('userData'), 'recordings'),
            '--index-path',
            historySearchService.getIndexPath(),
            '--stdin-json',
          ],
          payload: {
            question,
            scope: effectiveScope,
            contextTokens: activeContextTokens,
            ...(threadContext ? { threadContext } : {}),
            ...(priorTurnContext ? { priorTurnContext } : {}),
            sync: false,
          },
          timeoutMs: retrievalTimeoutMs,
          registrar: preflightRegistrar,
          threadId: thread.id,
        });
        const retrieval = await historySearchService.enqueueOperation(async () => {
          assertFresh();
          return runRetrieval();
        });
        assertFresh();
        preflightRegistrar.cleanup();
        preflightRegistrar.throwIfCancelled();

        evidence = Array.isArray(retrieval.evidence) ? retrieval.evidence : [];
        searchedMeetingCount = Number(retrieval.searchedMeetingCount) || 0;
        detectedDateFilter = typeof retrieval.detectedDateFilter === 'string'
          ? retrieval.detectedDateFilter
          : '';
        retrievalMode = typeof retrieval.retrievalMode === 'string'
          ? retrieval.retrievalMode
          : '';

        // Zero-hit preflight gate: NEVER acquire compute queue or allocate VRAM!
        if (evidence.length === 0) {
          assertFresh();
          const noMatchAnswer = searchedMeetingCount === 0
            ? 'No indexed recordings match the selected filter yet.'
            : (detectedDateFilter
              ? `No matching excerpts were found for ${detectedDateFilter} in the selected recordings.`
              : 'No matching excerpts were found in the selected recordings for that question.');
          const persisted = await chatThreadStore.appendTurn(thread.id, {
            question,
            status: 'no_matching_excerpts',
            failureReason: 'no_matching_excerpts',
            detectedDateFilter: detectedDateFilter || null,
            chatMode: 'grounded',
            retrievalMode: retrievalMode || null,
            answerMarkdown: noMatchAnswer,
            citations: [],
            searchedMeetingCount,
            evidenceCount: 0,
            scope: options.scope || null,
          }, { beforeCommit: assertFresh });
          assertFresh();
          emitQaProgress({
            threadId: thread.id,
            phase: 'completed',
            message: 'Done.',
            percent: 100,
          });
          return {
            ...persisted,
            status: 'no_matching_excerpts',
            chatMode: 'grounded',
            failureReason: 'no_matching_excerpts',
            detectedDateFilter: detectedDateFilter || null,
            retrievalMode: retrievalMode || null,
            modelLoaded: isModelLoaded(),
            searchedMeetingCount,
            evidenceCount: 0,
          };
        }
      }

      if (activeQaRequest && activeQaRequest.controller === controller) {
        activeQaRequest.phase = 'queued';
      }
      emitQaProgress({
        threadId: thread.id,
        phase: 'queued',
        message: hasPendingAiComputeWork()
          ? 'Queued behind active local AI work…'
          : 'Preparing local AI model…',
        percent: 20,
      });

      const queueRunner = runQueuedCompute || ((action) => enqueueAiComputeAction(() => enqueueGpuResourceActionForQa(action)));
      const historyTurns = [];
      for (let i = 0; i + 1 < existingMessages.length; i += 2) {
        const user = existingMessages[i];
        const assistant = existingMessages[i + 1];
        if (
          user.role === 'user'
          && assistant.role === 'assistant'
          && assistant.status === 'answered'
          && getMessageChatMode(assistant) === chatMode
          && user.content
          && assistant.content
        ) {
          const assistantTurn = { role: 'assistant', content: assistant.content };
          if (!isGeneralChat && Array.isArray(assistant.citations) && assistant.citations.length > 0) {
            const citationTitles = assistant.citations
              .map((c) => (typeof c?.meetingTitle === 'string' && c.meetingTitle ? { meetingTitle: c.meetingTitle } : null))
              .filter(Boolean);
            if (citationTitles.length > 0) {
              assistantTurn.citations = citationTitles;
            }
          }
          historyTurns.push({ role: 'user', content: user.content }, assistantTurn);
        }
      }

      const qaResult = await awaitAbortable(queueRunner(async () => runWallClockComputeAction({
        timeoutMs: qaTimeoutMs,
        label: 'Local history Q&A',
        terminateProcess: terminateProcessBestEffort,
        action: async (wallClockRegister, wallClockOpts) => {
          assertFresh();
          const combinedController = new AbortController();
          const forwardAbort = (srcSignal) => {
            if (!combinedController.signal.aborted) {
              combinedController.abort(srcSignal?.reason || createQaCancelError());
            }
          };
          controller.signal.addEventListener('abort', () => forwardAbort(controller.signal), { once: true });
          if (controller.signal.aborted) forwardAbort(controller.signal);
          if (wallClockOpts && wallClockOpts.signal) {
            wallClockOpts.signal.addEventListener('abort', () => forwardAbort(wallClockOpts.signal), { once: true });
            if (wallClockOpts.signal.aborted) forwardAbort(wallClockOpts.signal);
          }

          const registrar = createCancellableProcessRegistrar({
            cancelSignal: combinedController.signal,
            terminateProcess: terminateProcessBestEffort,
            registerProcess: (proc) => {
              const reg = wallClockRegister(proc);
              if (activeQaRequest && activeQaRequest.controller === controller) {
                activeQaRequest.process = reg;
              }
              return reg;
            },
            createCancelError: () => createQaCancelError(),
          });

          try {
            registrar.throwIfCancelled();

            const admitted = await resolveEligibility({
              verifyChecksums: true,
              verifyChecksumsIfChanged: true,
              summaryModelId: frozenModelId,
            });
            if (!admitted.eligible || admitted.modelId !== frozenModelId || JSON.stringify([admitted.artifact, admitted.runtimeArtifact, admitted.runtimeDir]) !== frozenArtifact) {
              throw new Error(admitted.reason || 'Local Summary AI add-on changed while queued.');
            }
            registrar.throwIfCancelled();

            const userDataDir = app.getPath('userData');
            const modelPath = getSummaryArtifactPath(userDataDir, admitted.artifact);
            const runtimeDir = admitted.runtimeDir || getSummaryRuntimeDir(userDataDir, admitted.artifact);

            let cudaStatus;
            if (platform === 'linux') {
              if (typeof resolveCudaStatusForTranscription !== 'function') {
                throw new Error('Linux local Q&A requires the live CUDA runtime resolver.');
              }
              cudaStatus = await resolveCudaStatusForTranscription({
                registerProcess: (proc) => registrar.register(proc),
              });
              registrar.throwIfCancelled();
              if (!isLinuxCudaStatusReadyForAdmission(cudaStatus)) {
                throw new Error('Linux local Q&A requires an admitted managed CUDA 12 runtime and NVIDIA GPU.');
              }
            }

            const binaryInfo = resolveLlamaServerBinary({
              runtimeDir,
              runtimeArtifact: admitted.runtimeArtifact,
              platform,
              fsModule: fs,
              pathModule: path,
              pinnedLinuxServer,
            });
            if (binaryInfo.mode === 'none') {
              throw new Error('Local Q&A runtime executable could not be verified.');
            }

            const checkLiveAdmission = async () => {
              registrar.throwIfCancelled();
              const deviceMemory = await getSummaryDeviceMemory({ live: true });
              registrar.throwIfCancelled();
              const live = await resolveEligibility({
                verifyChecksums: true, verifyChecksumsIfChanged: true,
                summaryModelId: frozenModelId, deviceMemory, cudaStatus, checkFit: true,
              });
              if (!live.eligible || live.modelId !== frozenModelId
                || JSON.stringify([live.artifact, live.runtimeArtifact, live.runtimeDir]) !== frozenArtifact) {
                throw new Error(live.reason || 'The selected Chat model changed or no longer fits. Check Settings and retry.');
              }
              registrar.throwIfCancelled();
            };
            let executionMode = 'cli';
            let serverUrl = null;
            let serverToken = null;
            let transientCliState = false;

            if (binaryInfo.mode === 'server') {
              if (activeQaRequest && activeQaRequest.controller === controller) {
                activeQaRequest.phase = 'loading_model';
              }
              const wasLoaded = isModelLoaded();
              emitQaProgress({
                threadId: thread.id,
                phase: 'loading_model',
                message: wasLoaded ? 'Using loaded local model…' : 'Loading local model into memory…',
                percent: wasLoaded ? 45 : 30,
              });
              const server = await ensureServerRunning({
                modelId: admitted.modelId,
                modelName: admitted.modelName,
                modelPath,
                runtimeDir,
                artifact: admitted.artifact,
                runtimeArtifact: admitted.runtimeArtifact,
                binaryInfo,
                cancelSignal: combinedController.signal,
                checkLiveAdmission,
              });
              executionMode = 'server';
              serverUrl = server.url;
              serverToken = server.token;
            } else {
              await unloadModel('cli_fallback', { cancelActive: false });
              await confirmSummaryProcessExit();
              await checkLiveAdmission();
              registrar.throwIfCancelled();
              transientCliState = true;
              emitModelState({
                status: 'loading',
                modelId: admitted.modelId,
                modelName: admitted.modelName,
                backend: 'llama-cli',
                loadedAt: null,
                reason: 'cli_fallback_turn',
              });
            }

            if (activeQaRequest && activeQaRequest.controller === controller) {
              activeQaRequest.phase = 'generating';
            }

            const runnerEnv = buildRuntimeSpawnEnv({
              userDataDir,
              artifact: admitted.artifact,
              runtimeArtifact: admitted.runtimeArtifact,
              runtimeDir,
              serverToken: null,
            });

            try {
              assertFresh();
              const runnerContextTokens = Number(admitted.artifact?.inference?.contextTokens) || activeContextTokens || 32768;
              const output = await runPythonStdinJson({
                moduleName: 'history_qa.qa_runner',
                args: ['--stdin-json'],
                payload: {
                  question,
                  chatMode,
                  evidence,
                  history: historyTurns,
                  searchedMeetingCount,
                  detectedDateFilter,
                  retrievalMode,
                  contextTokens: runnerContextTokens,
                  executionMode,
                  inferenceDescriptor: admitted.artifact.inference || { contextTokens: 32768, family: 'qwen', promptFormat: 'chatml', disableThinking: true },
                  stream: executionMode === 'server',
                  ...(executionMode === 'server' ? { serverUrl, serverToken } : { runtimeDir, modelPath }),
                },
                env: runnerEnv,
                timeoutMs: qaTimeoutMs,
                registrar,
                threadId: thread.id,
                emitProgressEvents: true,
                modelBearing: executionMode === 'cli',
              });
              return output;
            } finally {
              if (transientCliState && modelState.status === 'loading') {
                reportUnloaded('cli_turn_finished');
              }
            }
          } finally {
            registrar.cleanup();
          }
        },
      })), controller.signal);

      assertFresh();
      const finalStatus = qaResult.status || 'answered';
      const finalFailureReason = qaResult.failureReason || null;
      const finalDateFilter = isGeneralChat ? null : (qaResult.detectedDateFilter || detectedDateFilter || null);
      const finalRetrievalMode = isGeneralChat ? null : (qaResult.retrievalMode || retrievalMode || null);
      const finalInspectedSources = isGeneralChat
        ? []
        : (Array.isArray(qaResult.inspectedSources) ? qaResult.inspectedSources : []);
      const finalCitations = isGeneralChat
        ? []
        : (Array.isArray(qaResult.citations) ? qaResult.citations : []);
      const finalSearchedMeetingCount = isGeneralChat
        ? 0
        : (Number(qaResult.searchedMeetingCount) || searchedMeetingCount);
      const finalEvidenceCount = isGeneralChat
        ? 0
        : (Number(qaResult.evidenceCount) || evidence.length);
      const persisted = await chatThreadStore.appendTurn(thread.id, {
        question,
        status: finalStatus,
        chatMode,
        failureReason: finalFailureReason,
        detectedDateFilter: finalDateFilter,
        retrievalMode: finalRetrievalMode,
        answerMarkdown: qaResult.answerMarkdown || '',
        citations: finalCitations,
        inspectedSources: finalInspectedSources,
        modelId: frozenModelId,
        modelName: eligibility.modelName,
        searchedMeetingCount: finalSearchedMeetingCount,
        evidenceCount: finalEvidenceCount,
        scope: options.scope || null,
      }, { beforeCommit: assertFresh });
      assertFresh();

      emitQaProgress({
        threadId: thread.id,
        phase: 'completed',
        message: 'Done.',
        percent: 100,
      });

      return {
        ...persisted,
        status: finalStatus,
        chatMode,
        failureReason: finalFailureReason,
        detectedDateFilter: finalDateFilter,
        retrievalMode: finalRetrievalMode,
        modelLoaded: isModelLoaded(),
        searchedMeetingCount: finalSearchedMeetingCount,
        evidenceCount: finalEvidenceCount,
      };
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.code === HISTORY_QA_CANCEL_CODE)) {
        emitQaProgress({
          threadId: thread?.id || null,
          phase: 'cancelled',
          message: 'Response generation was stopped.',
        });
      } else {
        emitQaProgress({
          threadId: thread?.id || null,
          phase: 'error',
          message: redactSensitiveText(error?.message || 'Local Q&A failed.'),
        });
      }
      throw error;
    } finally {
      if (activeQaRequest?.controller === controller) activeQaRequest = null;
      if (!activeQaRequest && residentServer && !residentServer.unloading && !residentServer.exited) resetIdleTimer();
    }
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('get-history-qa-eligibility', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const requestedModelId = typeof options?.modelId === 'string' && options.modelId.trim()
        ? options.modelId.trim()
        : null;
      if (requestedModelId !== null && !getModelById('summary', requestedModelId)) {
        throw new Error('Invalid Chat model selection.');
      }
      const result = await resolveEligibility({
        verifyChecksums: false,
        verifyChecksumsIfChanged: true,
        summaryModelId: requestedModelId,
        fallbackToUsableLibraryModel: !requestedModelId,
      });
      return sanitizeEligibilityResponse(result);
    });

    ipcMain.handle('get-history-qa-model-state', async (event) => {
      assertTrustedRendererSender(event);
      return getModelState();
    });

    ipcMain.handle('unload-history-qa-model', async (event) => {
      assertTrustedRendererSender(event);
      await unloadModel('manual');
      return { unloaded: true, modelState: getModelState() };
    });

    ipcMain.handle('ask-history', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      return askHistory(options || {}, {
        runQueuedCompute: (action) => enqueueAiComputeAction(() => enqueueGpuResourceActionForQa(action)),
      });
    });

    ipcMain.handle('cancel-history-qa', async (event) => {
      assertTrustedRendererSender(event);
      return cancelActiveQuestion('Response generation was stopped.');
    });

    ipcMain.handle('list-chat-threads', async (event) => {
      assertTrustedRendererSender(event);
      const threads = await chatThreadStore.listThreads();
      return { threads };
    });

    ipcMain.handle('get-chat-thread', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const threadId = typeof options === 'string' ? options : options?.threadId;
      const thread = await chatThreadStore.getThread(threadId);
      return { thread };
    });

    ipcMain.handle('create-chat-thread', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const modelId = options?.modelId ?? null;
      if (modelId !== null && (typeof modelId !== 'string' || !getModelById('summary', modelId))) {
        throw new Error('Invalid Chat model selection.');
      }
      const thread = await chatThreadStore.createThread({ ...(options || {}), modelId });
      return { thread };
    });

    ipcMain.handle('rename-chat-thread', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const thread = await chatThreadStore.renameThread(options?.threadId, options?.title);
      return { thread };
    });

    ipcMain.handle('delete-chat-thread', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const threadId = typeof options === 'string' ? options : options?.threadId;
      return chatThreadStore.deleteThread(threadId);
    });

    ipcMain.handle('update-chat-thread-model', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const modelId = options?.modelId;
      if (modelId !== null && (typeof modelId !== 'string' || !getModelById('summary', modelId))) {
        throw new Error('Invalid Chat model selection.');
      }
      const thread = await chatThreadStore.updateThreadModel(options?.threadId, modelId);
      return { thread };
    });

    ipcMain.handle('update-chat-thread-scope', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const thread = await chatThreadStore.updateThreadScope(options?.threadId, options?.scope);
      return { thread };
    });
  }

  return {
    getModelState,
    isModelLoaded,
    hasLoadedOrActiveWork,
    unloadModel,
    ensureUnloadedForCompetingWork,
    abortActiveAndUnloadForQuit,
    forceKillOnShutdown,
    cancelActiveQuestion,
    askHistory,
    registerIpc,
  };
}

module.exports = {
  createHistoryQaService,
  resolveLlamaServerBinary,
  HISTORY_QA_MODEL_STATE_CHANNEL,
  HISTORY_QA_PROGRESS_CHANNEL,
  HISTORY_QA_CANCEL_CODE,
  PINNED_LINUX_LLAMA_SERVER,
};
