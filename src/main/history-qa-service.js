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
        if (
          platform === 'linux'
          && runtimeArtifact
          && runtimeArtifact.id === pinnedLinuxServer.runtimeId
          && pinnedLinuxServer.sha256
        ) {
          const actualDigest = sha256File(fsModule, realServer);
          if (stat.size !== pinnedLinuxServer.sizeBytes || actualDigest !== pinnedLinuxServer.sha256) {
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
    platform = process.platform,
    arch = process.arch,
    idleTimeoutMs = DEFAULT_IDLE_UNLOAD_MS,
    serverStartupTimeoutMs = DEFAULT_SERVER_STARTUP_TIMEOUT_MS,
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

  async function resolveEligibility({ verifyChecksums = false, verifyChecksumsIfChanged = true } = {}) {
    const status = await checkAiAddonSetupStatus(
      getAiAddonRuntimeOptions({
        verifyChecksums,
        verifyChecksumsIfChanged,
      }),
    );
    const summaryStatus = status && status.features && status.features.summary;
    if (!summaryStatus) {
      return {
        eligible: false,
        reason: 'Local Q&A uses the local Summary AI add-on, which is not configured.',
        setupTarget: 'ai-addons',
        modelId: null,
        modelName: null,
        artifactId: null,
      };
    }

    const modelId = summaryStatus.modelId || null;
    const modelMeta = modelId ? getModelById('summary', modelId) : null;
    const modelName = (modelMeta && (modelMeta.label || modelMeta.name)) || modelId || null;
    const artifact = modelId ? getSummaryArtifactForPlatform(modelId, platform, arch) : null;
    const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(platform, arch);

    if (platform === 'linux') {
      const managedRuntimePath = path.join(app.getPath('userData'), 'ai-addons', 'cuda', 'python');
      if (!fs.existsSync(managedRuntimePath)) {
        return {
          eligible: false,
          reason: 'Local Q&A on Linux requires the local Summary AI add-on and managed CUDA 12 runtime.',
          setupTarget: 'ai-addons',
          modelId,
          modelName,
          artifactId: artifact ? artifact.id : null,
        };
      }
      const cacheReady = summaryStatus.cache?.valid === true && summaryStatus.runtimeCache?.valid === true;
      if (!cacheReady || !artifact || !runtimeArtifact) {
        return {
          eligible: false,
          reason: 'Install or repair the local Summary AI model in Settings before using Chat.',
          setupTarget: 'ai-addons',
          modelId,
          modelName,
          artifactId: artifact ? artifact.id : null,
        };
      }
      return {
        eligible: true,
        reason: null,
        setupTarget: null,
        modelId,
        modelName,
        artifactId: artifact.id,
        artifact,
        runtimeArtifact,
      };
    }

    if (summaryStatus.status === 'unsupported') {
      return {
        eligible: false,
        reason: (summaryStatus.availability && summaryStatus.availability.reason)
          || summaryStatus.error
          || 'Local Q&A is not supported on this platform.',
        setupTarget: 'ai-addons',
        modelId,
        modelName,
        artifactId: artifact ? artifact.id : null,
      };
    }

    if (summaryStatus.status !== 'ready' || !summaryStatus.setupComplete || !artifact) {
      return {
        eligible: false,
        reason: 'Install the local Summary AI add-on in Settings to enable private offline Chat.',
        setupTarget: 'ai-addons',
        modelId,
        modelName,
        artifactId: artifact ? artifact.id : null,
      };
    }

    return {
      eligible: true,
      reason: null,
      setupTarget: null,
      modelId,
      modelName,
      artifactId: artifact.id,
      artifact,
      runtimeArtifact,
    };
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

  async function unloadModel(reason = 'manual') {
    if (activeUnloadPromise) {
      return activeUnloadPromise;
    }

    activeUnloadPromise = (async () => {
      clearIdleTimer();
      cancelActiveQuestion('Response generation stopped because the local model is unloading.');

      const server = residentServer;
      if (!server) {
        if (modelState.status !== 'unloaded') {
          emitModelState({
            status: 'unloaded',
            modelId: null,
            modelName: null,
            backend: null,
            loadedAt: null,
            reason,
          });
        }
        return { unloaded: true, alreadyUnloaded: true };
      }

      emitModelState({ status: 'unloading', reason });
      residentServer = null;
      server.unloading = true;
      server.token = null;

      try {
        await Promise.all([
          Promise.resolve(terminateProcessBestEffort(server.proc)).catch(() => {}),
          Promise.race([
            server.exitPromise,
            new Promise((resolve) => setTimeout(resolve, 6000).unref?.()),
          ]),
        ]);
      } finally {
        emitModelState({
          status: 'unloaded',
          modelId: null,
          modelName: null,
          backend: null,
          loadedAt: null,
          reason,
        });
      }

      return { unloaded: true, alreadyUnloaded: false };
    })().finally(() => {
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
      residentServer = null;
    }
  }

  function buildRuntimeSpawnEnv({ userDataDir, artifact, runtimeArtifact, serverToken = null }) {
    let runtimeEnv = {};
    if (platform === 'linux') {
      runtimeEnv = buildSummaryRuntimeEnv({
        userDataDir,
        artifact,
        runtimeArtifact,
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
  }) {
    if (
      residentServer
      && residentServer.modelPath === modelPath
      && residentServer.runtimeDir === runtimeDir
      && !residentServer.exited
      && !residentServer.unloading
    ) {
      return residentServer;
    }

    if (residentServer) {
      await unloadModel('model_changed');
    }

    if (cancelSignal && cancelSignal.aborted) {
      throw cancelSignal.reason instanceof Error ? cancelSignal.reason : createQaCancelError();
    }

    const userDataDir = app.getPath('userData');
    const token = crypto.randomBytes(32).toString('hex');
    const port = await allocateLoopbackPort();
    const args = [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--model',
      modelPath,
      '--ctx-size',
      '32768',
      '--n-gpu-layers',
      '-1',
      '--parallel',
      '1',
      '--no-webui',
      '--reasoning',
      'off',
    ];
    const spawnEnv = buildRuntimeSpawnEnv({
      userDataDir,
      artifact,
      runtimeArtifact,
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
      exited: false,
      unloading: false,
      exitPromise,
    };

    proc.on('error', (err) => {
      exited = true;
      serverEntry.exited = true;
      serverEntry.token = null;
      if (residentServer === serverEntry) {
        residentServer = null;
        clearIdleTimer();
        emitModelState({
          status: 'unloaded',
          modelId: null,
          modelName: null,
          backend: null,
          loadedAt: null,
          reason: `server_error:${err?.message || 'spawn_failed'}`,
        });
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
        emitModelState({
          status: 'unloaded',
          modelId: null,
          modelName: null,
          backend: null,
          loadedAt: null,
          reason: serverEntry.unloading ? 'manual' : `process_exited_${code}`,
        });
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
        const healthy = await probeServerHealth({ port, token });
        if (healthy) {
          residentServer = serverEntry;
          emitModelState({
            status: 'loaded',
            modelId,
            modelName,
            backend: 'llama-server',
            loadedAt: new Date().toISOString(),
            reason: 'ready',
          });
          resetIdleTimer();
          return serverEntry;
        }
        await waitAbortableMs(120, cancelSignal);
      }
      throw new Error('Timed out waiting for local Q&A model server to finish loading.');
    } catch (error) {
      serverEntry.unloading = true;
      serverEntry.token = null;
      await Promise.all([
        Promise.resolve(terminateProcessBestEffort(proc)).catch(() => {}),
        Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 4000).unref?.())]),
      ]);
      if (modelState.status !== 'unloaded') {
        emitModelState({
          status: 'unloaded',
          modelId: null,
          modelName: null,
          backend: null,
          loadedAt: null,
          reason: 'startup_aborted',
        });
      }
      throw error;
    }
  }

  function runPythonStdinJson({ moduleName, args = [], payload, env = {}, timeoutMs, registrar, threadId, emitProgressEvents = false }) {
    return new Promise((resolve, reject) => {
      try {
        registrar.throwIfCancelled();
      } catch (err) {
        reject(err);
        return;
      }

      const python = spawnTrackedPython(
        getBackendModuleArgs(moduleName, args),
        {
          cwd: pythonConfig.backendPath,
          env,
        },
      );

      let registered = false;
      try {
        registrar.register(python);
        registered = true;
      } catch (err) {
        reject(err);
        return;
      }

      const processOutput = collectPythonProcessOutput(python, { jsonResult: true });
      let stderrRemainder = '';
      if (emitProgressEvents && python.stderr && typeof python.stderr.on === 'function') {
        python.stderr.on('data', (chunk) => {
          const split = splitBufferedLines(String(chunk), stderrRemainder);
          stderrRemainder = split.remainder;
          for (const line of split.lines) {
            const parsed = parseAiBackendProgressLine(line, 'history-qa');
            if (parsed) {
              emitQaProgress({
                threadId,
                phase: parsed.phase,
                message: parsed.message,
                percent: parsed.percent,
              });
            }
          }
        });
      }

      let settled = false;
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
        finish(reject, new Error(`${moduleName} timed out.`));
      }, timeoutMs);
      timeoutHandle.unref?.();

      python.on('close', (code) => {
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
        try {
          python.stdin.end(JSON.stringify(payload || {}));
        } catch (_writeErr) {
          // Child closed before stdin write; close/error handler will settle.
        }
      }
    });
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
      throw new Error('Please enter a question to search your local meeting history.');
    }

    const eligibility = await resolveEligibility({
      verifyChecksums: true,
      verifyChecksumsIfChanged: true,
    });
    if (!eligibility.eligible) {
      throw new Error(eligibility.reason || 'Local Q&A is not available until the local Summary AI add-on is installed.');
    }

    const controller = new AbortController();
    let thread = null;
    if (options.threadId) {
      thread = await chatThreadStore.getThread(options.threadId);
    } else {
      thread = await chatThreadStore.createThread({ scope: options.scope || null });
    }

    const effectiveScope = options.scope && typeof options.scope === 'object'
      ? chatThreadStore.sanitizeScope(options.scope)
      : thread.scope;

    activeQaRequest = {
      threadId: thread.id,
      controller,
      phase: 'retrieving',
      process: null,
    };

    const cleanupActive = () => {
      if (activeQaRequest && activeQaRequest.controller === controller) {
        activeQaRequest = null;
      }
    };

    try {
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
        message: 'Searching local meeting transcripts…',
        percent: 10,
      });

      await historySearchService.ensureSynced();
      preflightRegistrar.throwIfCancelled();

      const retrieval = await runPythonStdinJson({
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
          sync: false,
        },
        timeoutMs: retrievalTimeoutMs,
        registrar: preflightRegistrar,
        threadId: thread.id,
      });
      preflightRegistrar.cleanup();
      preflightRegistrar.throwIfCancelled();

      const evidence = Array.isArray(retrieval.evidence) ? retrieval.evidence : [];
      const searchedMeetingCount = Number(retrieval.searchedMeetingCount) || 0;

      // Zero-hit preflight gate: NEVER acquire compute queue or allocate VRAM!
      if (evidence.length === 0) {
        const persisted = await chatThreadStore.appendTurn(thread.id, {
          question,
          status: 'insufficient_evidence',
          answerMarkdown:
            searchedMeetingCount === 0
              ? 'No indexed meetings match the selected filter scope yet.'
              : "I couldn't find any matching excerpts in your selected local meeting history for that question.",
          citations: [],
          searchedMeetingCount,
          evidenceCount: 0,
          scope: options.scope || null,
        });
        emitQaProgress({
          threadId: thread.id,
          phase: 'completed',
          message: 'Done.',
          percent: 100,
        });
        return {
          ...persisted,
          status: 'insufficient_evidence',
          modelLoaded: isModelLoaded(),
          searchedMeetingCount,
          evidenceCount: 0,
        };
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
      const historyTurns = (Array.isArray(thread.messages) ? thread.messages : [])
        .map((msg) => ({ role: msg.role, content: msg.content }));

      const qaResult = await queueRunner(async () => runWallClockComputeAction({
        timeoutMs: qaTimeoutMs,
        label: 'Local history Q&A',
        terminateProcess: terminateProcessBestEffort,
        action: async (wallClockRegister, wallClockOpts) => {
          const combinedController = new AbortController();
          const forwardAbort = (srcSignal) => {
            if (!combinedController.signal.aborted) {
              combinedController.abort(srcSignal?.reason || createQaCancelError());
            }
          };
          controller.signal.addEventListener('abort', () => forwardAbort(controller.signal), { once: true });
          if (wallClockOpts && wallClockOpts.signal) {
            wallClockOpts.signal.addEventListener('abort', () => forwardAbort(wallClockOpts.signal), { once: true });
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
            });
            if (!admitted.eligible) {
              throw new Error(admitted.reason || 'Local Summary AI add-on changed while queued.');
            }
            registrar.throwIfCancelled();

            const userDataDir = app.getPath('userData');
            const modelPath = getSummaryArtifactPath(userDataDir, admitted.artifact);
            const runtimeDir = getSummaryRuntimeDir(userDataDir, admitted.artifact);

            if (platform === 'linux') {
              if (typeof resolveCudaStatusForTranscription !== 'function') {
                throw new Error('Linux local Q&A requires the live CUDA runtime resolver.');
              }
              const cudaStatus = await resolveCudaStatusForTranscription({
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
                message: wasLoaded ? 'Using loaded local Q&A model…' : 'Loading local Q&A model into memory…',
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
              });
              executionMode = 'server';
              serverUrl = server.url;
              serverToken = server.token;
            } else {
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
              serverToken: null,
            });

            try {
              const output = await runPythonStdinJson({
                moduleName: 'history_qa.qa_runner',
                args: ['--stdin-json'],
                payload: {
                  question,
                  evidence,
                  history: historyTurns,
                  searchedMeetingCount,
                  executionMode,
                  ...(executionMode === 'server' ? { serverUrl, serverToken } : { runtimeDir, modelPath }),
                },
                env: runnerEnv,
                timeoutMs: qaTimeoutMs,
                registrar,
                threadId: thread.id,
                emitProgressEvents: true,
              });
              return output;
            } finally {
              if (transientCliState) {
                emitModelState({
                  status: 'unloaded',
                  modelId: null,
                  modelName: null,
                  backend: null,
                  loadedAt: null,
                  reason: 'cli_turn_finished',
                });
              }
            }
          } finally {
            registrar.cleanup();
          }
        },
      }));

      if (residentServer) {
        resetIdleTimer();
      }

      const persisted = await chatThreadStore.appendTurn(thread.id, {
        question,
        status: qaResult.status || 'answered',
        answerMarkdown: qaResult.answerMarkdown || '',
        citations: Array.isArray(qaResult.citations) ? qaResult.citations : [],
        searchedMeetingCount: Number(qaResult.searchedMeetingCount) || searchedMeetingCount,
        evidenceCount: Number(qaResult.evidenceCount) || evidence.length,
        scope: options.scope || null,
      });

      emitQaProgress({
        threadId: thread.id,
        phase: 'completed',
        message: 'Done.',
        percent: 100,
      });

      return {
        ...persisted,
        status: qaResult.status || 'answered',
        modelLoaded: isModelLoaded(),
        searchedMeetingCount: Number(qaResult.searchedMeetingCount) || searchedMeetingCount,
        evidenceCount: Number(qaResult.evidenceCount) || evidence.length,
      };
    } catch (error) {
      if (error && (error.name === 'AbortError' || error.code === HISTORY_QA_CANCEL_CODE)) {
        emitQaProgress({
          threadId: thread.id,
          phase: 'cancelled',
          message: 'Response generation was stopped.',
        });
      } else {
        emitQaProgress({
          threadId: thread.id,
          phase: 'error',
          message: redactSensitiveText(error?.message || 'Local Q&A failed.'),
        });
      }
      throw error;
    } finally {
      cleanupActive();
    }
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('get-history-qa-eligibility', async (event) => {
      assertTrustedRendererSender(event);
      const result = await resolveEligibility({
        verifyChecksums: false,
        verifyChecksumsIfChanged: true,
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
      const thread = await chatThreadStore.createThread(options || {});
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
