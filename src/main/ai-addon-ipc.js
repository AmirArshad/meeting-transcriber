'use strict';

/**
 * AI add-on IPC service for the AvaNevis main process.
 *
 * Owns `diarizationDependencySitePackagesCache`, the separate `aiAddonActionQueue`
 * (setup downloads — NOT the compute queue), and `aiAddonSetupAbortControllers`.
 * Registers status/token/setup/cancel/validate/remove channels for diarization
 * and summary. Runtime validators enqueue on the injected compute-queue helpers.
 */

const {
  AI_ADDON_PROGRESS_CHANNEL,
  AI_ADDON_CANCEL_CODE,
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  getSummaryArtifactPath,
  getSummaryRuntimeDir,
  removeDiarizationSetup,
  removeSummaryModel,
  setupDiarizationAddon,
  setupSummaryModel,
  validateDiarizationSetup,
  validateSummaryModel,
  isLikelyHuggingFaceToken,
} = require('../ai-addon-setup');
const {
  getSummaryArtifactForPlatform,
} = require('../ai-addon-state');
const {
  TOKEN_KEYS,
  deleteAiAddonToken,
  getAiAddonToken,
  hasAiAddonToken,
  isTokenEncryptionAvailable,
  storeAiAddonToken,
} = require('../ai-addon-token-store');
const {
  parseAiBackendProgressLine,
  AI_COMPUTE_TIMEOUT_MS,
  runWallClockComputeAction,
  splitBufferedLines,
  buildClearedHuggingFaceTokenEnv,
} = require('../main-process-helpers');
const { createAsyncActionQueue } = require('./ai-compute-queue');
const {
  buildSpeakrsSpawnEnv,
  getPackagedSpeakrsCliPreflightError,
  resolveSpawnDiarizationEngine,
} = require('../ai-addon/manifest-store');
const { SPEAKRS_DIARIZATION_ENGINES } = require('../ai-addon/speakrs-pack-spec');

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {object} deps.pythonConfig
 * @param {Function} deps.spawnTrackedPython
 * @param {Function} deps.appendSpawnLogBuffer
 * @param {Function} deps.sendToRenderer
 * @param {Function} deps.getSafeStorage
 * @param {Function} deps.assertTrustedRendererSender
 * @param {Function} deps.buildCudaRuntimeEnv
 * @param {Function} deps.createAbortableComputeAction
 * @param {Function} deps.terminateProcessBestEffort
 * @param {Function} deps.buildManagedDiarizationValidationArgs
 * @param {Function} deps.buildSummaryArgs
 * @param {Function} deps.summarizeDiarizationError
 * @param {Function} deps.summarizeSummaryValidationError
 * @param {{ enqueue: Function, drain: Function, hasPendingWork: Function }} [deps.aiAddonActionQueue]
 * @param {Function} [deps.hasInFlightGpuRuntimeAction]
 * @param {Function} [deps.waitForGpuRuntimeIdle]
 * @param {Function} [deps.hasPendingAiComputeWork]
 * @param {Function} [deps.hasPendingGpuResourceWork]
 * @param {Function} [deps.enqueueGpuExclusiveRemovalAction]
 * @param {Function} [deps.isQuitCommitted]
 */
function createAiAddonIpc(deps) {
  const {
    app,
    path,
    fs,
    pythonConfig,
    spawnTrackedPython,
    appendSpawnLogBuffer,
    sendToRenderer,
    getSafeStorage,
    assertTrustedRendererSender,
    buildCudaRuntimeEnv,
    createAbortableComputeAction,
    terminateProcessBestEffort,
    buildManagedDiarizationValidationArgs,
    buildSummaryArgs,
    summarizeDiarizationError,
    summarizeSummaryValidationError,
    aiAddonActionQueue: injectedAiAddonActionQueue,
    hasInFlightGpuRuntimeAction = () => false,
    waitForGpuRuntimeIdle = async () => {},
    hasPendingAiComputeWork = () => false,
    hasPendingGpuResourceWork = () => false,
    enqueueGpuExclusiveRemovalAction = (action) => action(),
    isQuitCommitted = () => false,
    resolveSpeakrsCliPath = null,
    resourcesPath = process.resourcesPath,
    getCachedCudaStatus = () => null,
    resolveCudaStatusForTranscription = null,
  } = deps;

  // Single shared cache reference — never copy this let into a stale local.
  let diarizationDependencySitePackagesCache = null;

  const aiAddonActionQueue = injectedAiAddonActionQueue || createAsyncActionQueue();
  const enqueueAiAddonAction = aiAddonActionQueue.enqueue;
  const aiAddonSetupAbortControllers = new Map();

  function createAiAddonCancelError(message = 'AI add-on setup was canceled.') {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = AI_ADDON_CANCEL_CODE;
    return error;
  }

  function emitAiAddonProgress(payload) {
    sendToRenderer(AI_ADDON_PROGRESS_CHANNEL, payload);
  }

  function runCancellableAiAddonSetup(feature, action) {
    if (aiAddonSetupAbortControllers.has(feature)) {
      return Promise.reject(new Error(`${feature === 'summary' ? 'Summary model' : 'Speaker identification'} setup is already running.`));
    }

    const controller = new AbortController();
    aiAddonSetupAbortControllers.set(feature, controller);

    return enqueueAiAddonAction(async () => {
      try {
        return await action(controller.signal);
      } finally {
        if (aiAddonSetupAbortControllers.get(feature) === controller) {
          aiAddonSetupAbortControllers.delete(feature);
        }
      }
    });
  }

  function cancelAiAddonSetup(feature) {
    const controller = aiAddonSetupAbortControllers.get(feature);
    if (!controller) {
      return { canceled: false, message: 'No setup download is currently running.' };
    }

    controller.abort(createAiAddonCancelError());
    return { canceled: true };
  }

  function abortInFlightAiSetup(message = 'Local AI work was canceled because the app is quitting.') {
    for (const controller of aiAddonSetupAbortControllers.values()) {
      try {
        controller.abort(createAiAddonCancelError(message));
      } catch (error) {
        // Best effort abort.
      }
    }
  }

  function hasInFlightAiAddonSetup() {
    return aiAddonSetupAbortControllers.size > 0 || aiAddonActionQueue.hasPendingWork();
  }

  function clearDiarizationDependencySitePackagesCache() {
    diarizationDependencySitePackagesCache = null;
  }

  function getDiarizationDependencySitePackagesCacheKey(userDataDir) {
    return [userDataDir, process.platform, process.arch].join('\0');
  }

  function getDiarizationDependencyEnv(userDataDir = app.getPath('userData')) {
    const sitePackagesDir = getDiarizationDependencySitePackagesPath(userDataDir);
    return sitePackagesDir ? { PYTHONPATH: sitePackagesDir } : {};
  }

  function getDiarizationDependencySitePackagesPath(userDataDir = app.getPath('userData')) {
    if (process.env.AVANEVIS_SKIP_MANAGED_DIARIZATION_DEPS === '1') {
      return null;
    }

    const cacheKey = getDiarizationDependencySitePackagesCacheKey(userDataDir);
    if (diarizationDependencySitePackagesCache && diarizationDependencySitePackagesCache.key === cacheKey) {
      const cachedPath = diarizationDependencySitePackagesCache.sitePackagesDir;
      if (!cachedPath || fs.existsSync(cachedPath)) {
        return cachedPath;
      }
      clearDiarizationDependencySitePackagesCache();
    }

    const cache = checkDiarizationDependencyCache({
      userDataDir,
      platform: process.platform,
      arch: process.arch,
    });

    const sitePackagesDir = cache.valid ? cache.sitePackagesDir : null;
    diarizationDependencySitePackagesCache = { key: cacheKey, sitePackagesDir };
    return sitePackagesDir;
  }

  function getDiarizationCacheEnv(userDataDir = app.getPath('userData')) {
    const cacheRoot = path.join(userDataDir, 'ai-addons', 'models', 'diarization');
    const hubCache = path.join(cacheRoot, 'hub');
    return {
      HF_HOME: cacheRoot,
      HF_HUB_CACHE: hubCache,
      HUGGINGFACE_HUB_CACHE: hubCache,
      TRANSFORMERS_CACHE: hubCache,
      PYANNOTE_METRICS_ENABLED: '0',
    };
  }

  function getAiAddonRuntimeOptions(extra = {}) {
    const options = {
      userDataDir: app.getPath('userData'),
      platform: process.platform,
      arch: process.arch,
      emitProgress: emitAiAddonProgress,
      cudaStatus: typeof getCachedCudaStatus === 'function' ? getCachedCudaStatus() : null,
      ...extra,
    };

    if (extra.includeSafeStorage) {
      options.safeStorage = getSafeStorage();
      delete options.includeSafeStorage;
    }

    return options;
  }

  async function resolveLinuxSpeakrsCudaStatus({ registerProcess, cancelSignal } = {}) {
    if (process.platform !== 'linux') {
      return typeof getCachedCudaStatus === 'function' ? getCachedCudaStatus() : null;
    }
    if (typeof resolveCudaStatusForTranscription !== 'function') {
      const error = new Error('Linux CUDA admission requires the live CUDA runtime resolver.');
      error.code = 'LINUX_CUDA_RESOLVER_UNAVAILABLE';
      throw error;
    }
    let activeProcess = null;
    const register = (child) => {
      activeProcess = typeof registerProcess === 'function' ? registerProcess(child) : child;
      return activeProcess;
    };
    const abort = () => {
      if (activeProcess) {
        terminateProcessBestEffort(activeProcess);
      }
    };
    cancelSignal?.addEventListener?.('abort', abort, { once: true });
    try {
      if (cancelSignal?.aborted) {
        throw createAiAddonCancelError('Speaker identification setup was canceled.');
      }
      const status = await resolveCudaStatusForTranscription({ registerProcess: register });
      if (cancelSignal?.aborted) {
        throw createAiAddonCancelError('Speaker identification setup was canceled.');
      }
      return status;
    } finally {
      cancelSignal?.removeEventListener?.('abort', abort);
    }
  }

  function createRemovalBusyError(feature) {
    const label = feature === 'summary' ? 'summary model' : 'speaker identification setup';
    const error = new Error(`Wait for local AI work to finish before removing the ${label}.`);
    error.code = 'AI_ADDON_REMOVE_COMPUTE_BUSY';
    return error;
  }

  function createSetupBusyError() {
    const error = new Error('Wait for local AI work to finish before changing speaker identification setup.');
    error.code = 'AI_ADDON_SETUP_COMPUTE_BUSY';
    return error;
  }

  function createUnknownDiarizationEngineError() {
    const error = new Error('Unknown speaker engine.');
    error.code = 'UNKNOWN_DIARIZATION_ENGINE';
    return error;
  }

  function resolveRequestedDiarizationEngine(options = {}) {
    const engine = typeof options.engine === 'string' ? options.engine.trim().toLowerCase() : '';
    if (!SPEAKRS_DIARIZATION_ENGINES.includes(engine)) {
      throw createUnknownDiarizationEngineError();
    }
    return engine;
  }

  function assertAddonDiskMutationCanRun(feature, action = 'remove') {
    if (isQuitCommitted()) {
      const error = new Error(
        action === 'setup'
          ? 'Cannot change speaker identification setup while the app is quitting.'
          : 'Cannot remove local AI files while the app is quitting.',
      );
      error.code = 'QUIT_IN_PROGRESS';
      throw error;
    }
    if (hasPendingAiComputeWork() || hasPendingGpuResourceWork()) {
      if (action === 'setup') {
        throw createSetupBusyError();
      }
      throw createRemovalBusyError(feature);
    }
  }

  function assertRemovalCanRun(feature) {
    assertAddonDiskMutationCanRun(feature, 'remove');
  }

  function buildDiarizationValidationEnv(engine, requiredDevice) {
    const resolvedEngine = resolveSpawnDiarizationEngine(engine);
    if (resolvedEngine === 'speakrs') {
      const preflightError = getPackagedSpeakrsCliPreflightError({
        engine: resolvedEngine,
        env: process.env,
        platform: process.platform,
        resourcesPath,
        fsModule: fs,
      });
      if (preflightError) {
        throw preflightError;
      }
    }
    const clearedTokens = buildClearedHuggingFaceTokenEnv();
    if (engine === 'speakrs') {
      const cudaEnv = buildCudaRuntimeEnv({ AVANEVIS_LINUX_CUDA_REQUIRED: undefined }, { includeManagedDiarization: false });
      return {
        ...buildSpeakrsSpawnEnv({
          userDataDir: app.getPath('userData'),
          requiredDevice,
          extra: cudaEnv,
          cliPath: typeof resolveSpeakrsCliPath === 'function' ? resolveSpeakrsCliPath() : null,
        }),
        ...clearedTokens,
      };
    }
    return {
      ...getDiarizationDependencyEnv(),
      ...getDiarizationCacheEnv(),
      ...buildCudaRuntimeEnv({ AVANEVIS_LINUX_CUDA_REQUIRED: undefined }, { includeManagedDiarization: true }),
      ...clearedTokens,
    };
  }

  function validateDiarizationRuntime({ modelRef, token, requiredDevice, cancelSignal, engine } = {}) {
    clearDiarizationDependencySitePackagesCache();
    const resolvedEngine = resolveSpawnDiarizationEngine(engine);
    if (resolvedEngine === 'speakrs') {
      const preflightError = getPackagedSpeakrsCliPreflightError({
        engine: resolvedEngine,
        env: process.env,
        platform: process.platform,
        resourcesPath,
        fsModule: fs,
      });
      if (preflightError) {
        return Promise.reject(preflightError);
      }
    }
    const isSpeakrs = resolvedEngine === 'speakrs';
    const resolvedToken = isSpeakrs
      ? null
      : (token || getAiAddonToken({
        userDataDir: app.getPath('userData'),
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
        safeStorage: getSafeStorage(),
      }));

    return createAbortableComputeAction({
      cancelSignal,
      cancelMessage: 'Speaker identification setup was canceled.',
      action: async () => {
        if (hasInFlightGpuRuntimeAction()) {
          await waitForGpuRuntimeIdle();
        }
        return runWallClockComputeAction({
        timeoutMs: AI_COMPUTE_TIMEOUT_MS.addonValidation,
        label: 'Speaker identification validation',
        terminateProcess: terminateProcessBestEffort,
        action: (registerProcess) => new Promise((resolve, reject) => {
          if (cancelSignal && cancelSignal.aborted) {
            reject(createAiAddonCancelError('Speaker identification setup was canceled.'));
            return;
          }

          const python = registerProcess(spawnTrackedPython(
            buildManagedDiarizationValidationArgs(modelRef, requiredDevice, resolvedEngine),
            {
              cwd: pythonConfig.backendPath,
              env: buildDiarizationValidationEnv(resolvedEngine, requiredDevice),
            },
          ));

          let output = '';
          let errorOutput = '';
          let stderrRemainder = '';
          let settled = false;
          const cleanupCancel = cancelSignal && typeof cancelSignal.addEventListener === 'function'
            ? (() => {
              const handleAbort = () => {
                if (settled) {
                  return;
                }
                settled = true;
                terminateProcessBestEffort(python);
                reject(createAiAddonCancelError('Speaker identification setup was canceled.'));
              };
              cancelSignal.addEventListener('abort', handleAbort, { once: true });
              return () => cancelSignal.removeEventListener('abort', handleAbort);
            })()
            : () => {};
          const finish = (callback, value) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanupCancel();
            callback(value);
          };
          const failTokenDelivery = (error, messagePrefix) => {
            // Late EPIPE after a successful close must not taskkill a recycled PID.
            if (settled) {
              return;
            }
            // Stdin failure settles the job; wall-clock timeout will not fire, so kill the
            // child that is otherwise blocked forever on sys.stdin.readline().
            terminateProcessBestEffort(python);
            finish(reject, new Error(`${messagePrefix}: ${error.message}`));
          };
          if (isSpeakrs) {
            try {
              python.stdin.end();
            } catch (_error) {
            }
          } else {
            // Async EPIPE if the child dies before reading stdin is not caught by try/catch.
            python.stdin.on('error', (error) => {
              failTokenDelivery(error, 'Failed to deliver Hugging Face token');
            });
            try {
              python.stdin.write(resolvedToken ? `${resolvedToken}\n` : '\n');
              python.stdin.end();
            } catch (error) {
              failTokenDelivery(error, 'Failed to deliver Hugging Face token to validation process');
              return;
            }
          }
          python.stdout.on('data', (data) => { output = appendSpawnLogBuffer(output, data); });
          python.stderr.on('data', (data) => {
            const stderrChunk = data.toString();
            errorOutput = appendSpawnLogBuffer(errorOutput, stderrChunk);
            const { lines, remainder } = splitBufferedLines(stderrChunk, stderrRemainder);
            stderrRemainder = remainder;
            for (const line of lines) {
              const progressEvent = parseAiBackendProgressLine(line, 'diarization');
              if (progressEvent) {
                emitAiAddonProgress(progressEvent);
              }
            }
          });
          python.on('close', (code) => {
            if (stderrRemainder) {
              const progressEvent = parseAiBackendProgressLine(stderrRemainder, 'diarization');
              if (progressEvent) {
                emitAiAddonProgress(progressEvent);
              }
              stderrRemainder = '';
            }
            if (code === 0) {
              try {
                finish(resolve, JSON.parse(output));
              } catch (error) {
                finish(reject, new Error(`Failed to parse diarization setup validation: ${error.message}`));
              }
              return;
            }
            const reason = summarizeDiarizationError(errorOutput);
            finish(reject, new Error(reason || 'Speaker identification runtime validation failed.'));
          });
          python.on('error', (error) => finish(reject, error));
        }),
        });
      },
    });
  }

  function validateSummaryRuntimeSmoke({ modelId, cache, cancelSignal }) {
    const artifact = getSummaryArtifactForPlatform(modelId, process.platform, process.arch);
    if (!artifact) {
      return Promise.reject(new Error('No summary model artifact is available for this platform.'));
    }

    const modelPath = cache && cache.artifactPath ? cache.artifactPath : getSummaryArtifactPath(app.getPath('userData'), artifact);
    const runtimeDir = getSummaryRuntimeDir(app.getPath('userData'), artifact);

    return createAbortableComputeAction({
      cancelSignal,
      cancelMessage: 'Summary model setup was canceled.',
      action: async () => {
        if (hasInFlightGpuRuntimeAction()) {
          await waitForGpuRuntimeIdle();
        }
        return runWallClockComputeAction({
        timeoutMs: AI_COMPUTE_TIMEOUT_MS.addonValidation,
        label: 'Summary model validation',
        terminateProcess: terminateProcessBestEffort,
        action: (registerProcess) => new Promise((resolve, reject) => {
          if (cancelSignal && cancelSignal.aborted) {
            reject(createAiAddonCancelError('Summary model setup was canceled.'));
            return;
          }

          const python = registerProcess(spawnTrackedPython(buildSummaryArgs({
            meetingId: 'setup-validation',
            runtimeDir,
            modelPath,
            validateRuntime: true,
            modelLabel: artifact.modelLabel || artifact.modelId,
          }), { cwd: pythonConfig.backendPath }));

          let output = '';
          let errorOutput = '';
          let settled = false;
          const cleanupCancel = cancelSignal && typeof cancelSignal.addEventListener === 'function'
            ? (() => {
              const handleAbort = () => {
                if (settled) {
                  return;
                }
                settled = true;
                terminateProcessBestEffort(python);
                reject(createAiAddonCancelError('Summary model setup was canceled.'));
              };
              cancelSignal.addEventListener('abort', handleAbort, { once: true });
              return () => cancelSignal.removeEventListener('abort', handleAbort);
            })()
            : () => {};
          const finish = (callback, value) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanupCancel();
            callback(value);
          };
          python.stdout.on('data', (data) => { output = appendSpawnLogBuffer(output, data); });
          python.stderr.on('data', (data) => { errorOutput = appendSpawnLogBuffer(errorOutput, data); });
          python.on('close', (code) => {
            if (code === 0) {
              try {
                finish(resolve, JSON.parse(output));
              } catch (error) {
                finish(reject, new Error(`Failed to parse summary runtime validation: ${error.message}`));
              }
              return;
            }
            const reason = summarizeSummaryValidationError(errorOutput);
            const message = reason && /^local summary runtime validation failed/i.test(reason)
              ? reason
              : `Local summary runtime validation failed${reason ? `: ${reason}` : '.'}`;
            finish(reject, new Error(message));
          });
          python.on('error', (error) => finish(reject, error));
        }),
        });
      },
    });
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('get-ai-addon-status', async (event, options = {}) => checkAiAddonSetupStatus({
      userDataDir: app.getPath('userData'),
      platform: process.platform,
      arch: process.arch,
      includeStorageSizes: Boolean(options && options.includeStorageSizes),
      verifyChecksums: Boolean(options && options.verifyChecksums),
      checkTokenEncryption: false,
      cudaStatus: typeof getCachedCudaStatus === 'function' ? getCachedCudaStatus() : null,
    }));

    ipcMain.handle('store-diarization-token', async (event, token) => {
      assertTrustedRendererSender(event);

      const trimmedToken = typeof token === 'string' ? token.trim() : '';
      if (!trimmedToken) {
        return { success: false, code: 'EMPTY_TOKEN', message: 'Token must not be empty.' };
      }
      if (!isLikelyHuggingFaceToken(trimmedToken)) {
        return {
          success: false,
          code: 'INVALID_TOKEN',
          message: 'Hugging Face token does not match the expected token format.',
        };
      }

      try {
        return await storeAiAddonToken({
          userDataDir: app.getPath('userData'),
          tokenKey: TOKEN_KEYS.diarizationHuggingFace,
          token: trimmedToken,
          safeStorage: getSafeStorage(),
        });
      } catch (error) {
        return {
          success: false,
          code: 'STORAGE_ERROR',
          message: error.message || 'Secure token storage is unavailable.',
        };
      }
    });

    ipcMain.handle('get-diarization-token-status', async () => ({
      hasToken: hasAiAddonToken({
        userDataDir: app.getPath('userData'),
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
      }),
      encryptionAvailable: isTokenEncryptionAvailable({ safeStorage: getSafeStorage() }),
    }));

    ipcMain.handle('delete-diarization-token', async (event) => {
      assertTrustedRendererSender(event);
      return deleteAiAddonToken({
        userDataDir: app.getPath('userData'),
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
      });
    });

    ipcMain.handle('setup-diarization', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const engine = resolveRequestedDiarizationEngine(options);
      assertAddonDiskMutationCanRun('diarization', 'setup');
      return runCancellableAiAddonSetup('diarization', async (cancelSignal) => {
        // Re-check when the queued setup begins so a job that started after IPC
        // admission cannot race exclusive deletion. Fail-fast: do not wait.
        assertAddonDiskMutationCanRun('diarization', 'setup');
        const cudaStatus = await runWallClockComputeAction({
          timeoutMs: AI_COMPUTE_TIMEOUT_MS.addonValidation,
          label: 'Linux CUDA admission',
          terminateProcess: terminateProcessBestEffort,
          action: (registerProcess) => resolveLinuxSpeakrsCudaStatus({ registerProcess, cancelSignal }),
        });
        return setupDiarizationAddon(getAiAddonRuntimeOptions({
          includeSafeStorage: true,
          engine,
          modelId: options.modelId,
          speakerCount: options.speakerCount,
          token: options.token,
          pythonExe: pythonConfig.pythonExe,
          runtimeValidator: validateDiarizationRuntime,
          cancelSignal,
          cudaStatus,
          resourcesPath,
          withExclusiveDiskMutation: (action) => {
            assertAddonDiskMutationCanRun('diarization', 'setup');
            try {
              return enqueueGpuExclusiveRemovalAction(action);
            } catch (error) {
              if (error && error.code === 'AI_ADDON_REMOVE_COMPUTE_BUSY') {
                throw createSetupBusyError();
              }
              if (error && error.code === 'QUIT_IN_PROGRESS') {
                const mapped = new Error('Cannot change speaker identification setup while the app is quitting.');
                mapped.code = 'QUIT_IN_PROGRESS';
                throw mapped;
              }
              throw error;
            }
          },
        }));
      });
    });

    ipcMain.handle('cancel-diarization-setup', async (event) => {
      assertTrustedRendererSender(event);
      return cancelAiAddonSetup('diarization');
    });

    ipcMain.handle('validate-diarization-setup', async (event) => {
      assertTrustedRendererSender(event);
      if (aiAddonSetupAbortControllers.has('diarization')) {
        throw new Error('Speaker identification setup is already running. Cancel it or wait for it to finish before validating.');
      }

      return enqueueAiAddonAction(async () => validateDiarizationSetup(getAiAddonRuntimeOptions({
        includeSafeStorage: true,
        runtimeValidator: validateDiarizationRuntime,
        cudaStatus: await runWallClockComputeAction({
          timeoutMs: AI_COMPUTE_TIMEOUT_MS.addonValidation,
          label: 'Linux CUDA admission',
          terminateProcess: terminateProcessBestEffort,
          action: (registerProcess) => resolveLinuxSpeakrsCudaStatus({ registerProcess }),
        }),
      })));
    });

    ipcMain.handle('remove-diarization-setup', async (event) => {
      assertTrustedRendererSender(event);
      if (aiAddonSetupAbortControllers.has('diarization')) {
        throw new Error('Speaker identification setup is already running. Cancel it before removing setup.');
      }
      assertRemovalCanRun('diarization');

      return enqueueAiAddonAction(() => {
        // Re-check after earlier add-on setup work releases this queue slot.
        // Do not wait behind compute: removals have no cancel UI and must not
        // begin later during quit teardown.
        assertRemovalCanRun('diarization');
        return enqueueGpuExclusiveRemovalAction(async () => {
          try {
            return await removeDiarizationSetup(getAiAddonRuntimeOptions());
          } finally {
            clearDiarizationDependencySitePackagesCache();
          }
        });
      });
    });

    ipcMain.handle('setup-summary-model', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      return runCancellableAiAddonSetup('summary', (cancelSignal) => setupSummaryModel(getAiAddonRuntimeOptions({
        modelId: options.modelId,
        profile: options.profile,
        pythonExe: pythonConfig.pythonExe,
        backendPath: pythonConfig.backendPath,
        runtimeValidator: validateSummaryRuntimeSmoke,
        cancelSignal,
      })));
    });

    ipcMain.handle('cancel-summary-model-setup', async (event) => {
      assertTrustedRendererSender(event);
      return cancelAiAddonSetup('summary');
    });

    ipcMain.handle('validate-summary-model', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      if (aiAddonSetupAbortControllers.has('summary')) {
        throw new Error('Summary model setup is already running. Cancel it or wait for it to finish before validating.');
      }

      return enqueueAiAddonAction(() => validateSummaryModel(getAiAddonRuntimeOptions({
        modelId: options.modelId,
        profile: options.profile,
        runtimeValidator: validateSummaryRuntimeSmoke,
      })));
    });

    ipcMain.handle('remove-summary-model', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      if (aiAddonSetupAbortControllers.has('summary')) {
        throw new Error('Summary model setup is already running. Cancel it before removing the model.');
      }
      assertRemovalCanRun('summary');

      return enqueueAiAddonAction(() => {
        assertRemovalCanRun('summary');
        return enqueueGpuExclusiveRemovalAction(() => removeSummaryModel(getAiAddonRuntimeOptions({
          modelId: options.modelId,
        })));
      });
    });
  }

  return {
    createAiAddonCancelError,
    emitAiAddonProgress,
    runCancellableAiAddonSetup,
    cancelAiAddonSetup,
    abortInFlightAiSetup,
    hasInFlightAiAddonSetup,
    aiAddonActionQueue,
    enqueueAiAddonAction,
    clearDiarizationDependencySitePackagesCache,
    getDiarizationDependencyEnv,
    getDiarizationDependencySitePackagesPath,
    getDiarizationCacheEnv,
    getAiAddonRuntimeOptions,
    validateDiarizationRuntime,
    validateSummaryRuntimeSmoke,
    registerIpc,
  };
}

/**
 * Convenience wiring helper: build the AI add-on service and register IPC.
 * Returns the service so quit/transcription paths can reach shared helpers.
 */
function registerAiAddonIpc(ipcMain, deps) {
  const service = createAiAddonIpc(deps);
  service.registerIpc(ipcMain);
  return service;
}

/**
 * Standalone cancel-error factory for composition-root wiring before the
 * full AI add-on service exists (e.g. createAiComputeQueue deps).
 */
function createAiAddonCancelErrorStandalone(message = 'AI add-on setup was canceled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = AI_ADDON_CANCEL_CODE;
  return error;
}

module.exports = {
  createAiAddonIpc,
  registerAiAddonIpc,
  createAiAddonCancelErrorStandalone,
};
