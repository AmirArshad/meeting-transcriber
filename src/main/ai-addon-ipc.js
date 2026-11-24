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
  checkAiAddonSetupStatus: defaultCheckAiAddonSetupStatus,
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
  validateSummaryModelRemovalRequest,
} = require('../ai-addon/summary-setup');
const {
  buildSummaryRuntimeEnv: defaultBuildSummaryRuntimeEnv,
  loadManifest,
  setDefaultSummaryModel,
} = require('../ai-addon/manifest-store');
const {
  getDiarizationAvailability,
  getModelById,
  getSummaryAvailability,
  getSummaryArtifactForPlatform,
  getSummaryRuntimeArtifactForPlatform,
  resolveModelId,
} = require('../ai-addon-state');
const { getSummaryModelFit } = require('../ai-addon/summary-device-fit');
const { managedLinuxCudaRuntimeExists } = require('../main-process/linux-cuda-runtime-helpers');
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
  createCancellableProcessRegistrar,
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
    spawnSummaryPython = spawnTrackedPython,
    ensureSummaryProcessExited = async () => {},
    appendSpawnLogBuffer,
    sendToRenderer,
    getSafeStorage,
    assertTrustedRendererSender,
    buildCudaRuntimeEnv,
    buildSummaryRuntimeEnv = defaultBuildSummaryRuntimeEnv,
    createAbortableComputeAction,
    terminateProcessBestEffort,
    buildManagedDiarizationValidationArgs,
    buildSummaryArgs,
    summarizeDiarizationError,
    summarizeSummaryValidationError,
    aiAddonActionQueue: injectedAiAddonActionQueue,
    checkAiAddonSetupStatus = defaultCheckAiAddonSetupStatus,
    hasPendingAiComputeWork = () => false,
    hasPendingGpuResourceWork = () => false,
    enqueueGpuResourceAction = (action) => action(),
    enqueueGpuExclusiveRemovalAction = (action) => action(),
    isQuitCommitted = () => false,
    resolveSpeakrsCliPath = null,
    resourcesPath = process.resourcesPath,
    getCachedCudaStatus = () => null,
    resolveCudaStatusForTranscription = null,
    getSummaryDeviceMemory = async () => null,
    getResidentSummaryModelState = () => null,
    releaseSummaryModel = async () => ensureSummaryProcessExited(),
    runExclusiveSummaryMutation = (action) => action(),
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
      cudaStatus: typeof getCachedCudaStatus === 'function'
        ? (getCachedCudaStatus() ?? getCachedCudaStatus({ allowStale: true }))
        : null,
      ...extra,
    };

    if (extra.includeSafeStorage) {
      options.safeStorage = getSafeStorage();
      delete options.includeSafeStorage;
    }

    return options;
  }

  let passiveCudaRefresh = null;

  async function resolveCudaStatusForAddonStatus(checkDevice) {
    if (checkDevice && process.platform === 'linux' && process.arch === 'x64') {
      return enqueueGpuResourceAction(() => {
        if (isQuitCommitted()) throw new Error('Cannot check this device while AvaNevis is quitting.');
        return runWallClockComputeAction({
          timeoutMs: AI_COMPUTE_TIMEOUT_MS.addonValidation,
          label: 'Summaries & Chat device check',
          terminateProcess: terminateProcessBestEffort,
          action: (registerProcess, { signal }) => resolveLinuxSpeakrsCudaStatus({ registerProcess, cancelSignal: signal }),
        });
      });
    }
    // Passive status (Settings refresh, Generate Summary preflight) must not
    // wait behind transcription. Use the last runtime reading until an explicit check or compute admission.
    if (typeof getCachedCudaStatus === 'function') {
      return getCachedCudaStatus({ allowStale: true }) || getCachedCudaStatus();
    }
    return null;
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
    const registrar = createCancellableProcessRegistrar({
      registerProcess,
      cancelSignal,
      terminateProcess: terminateProcessBestEffort,
      createCancelError: () => createAiAddonCancelError('Speaker identification setup was canceled.'),
    });
    try {
      registrar.throwIfCancelled();
      const status = await resolveCudaStatusForTranscription({
        registerProcess: registrar.register,
        cancelSignal,
      });
      registrar.throwIfCancelled();
      return status;
    } finally {
      registrar.cleanup();
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

  function createSummaryModelLoadedInMemoryError({ loadedModelId, loadedModelName } = {}) {
    const loadedLabel = loadedModelName || loadedModelId || 'A local model';
    const error = new Error(
      `${loadedLabel} is currently loaded in memory. Unload it to free graphics memory and continue. [SUMMARY_MODEL_LOADED_IN_MEMORY${loadedModelId ? `:${loadedModelId}` : ''}]`,
    );
    error.code = 'SUMMARY_MODEL_LOADED_IN_MEMORY';
    error.loadedModelId = loadedModelId || null;
    error.loadedModelName = loadedModelName || null;
    return error;
  }

  function isFitBlockedSolelyByLowAvailableVram(fit) {
    return Boolean(
      fit
      && fit.blocked === true
      && fit.status === 'needs_more_memory'
      && fit.memoryType !== 'unified memory'
      && fit.minimumRuntimeBytes != null
      && fit.totalMemoryBytes != null
      && fit.totalMemoryBytes >= fit.minimumRuntimeBytes
      && fit.availableMemoryBytes != null
      && fit.availableMemoryBytes < fit.minimumRuntimeBytes,
    );
  }

  function resolveTargetSummaryModelId(requestedModelId) {
    if (requestedModelId) {
      return getModelById('summary', requestedModelId) ? requestedModelId : null;
    }
    const manifest = loadManifest({ userDataDir: app.getPath('userData'), fsModule: fs });
    return resolveModelId('summary', manifest.summaryLibrary.defaultModelId);
  }

  function attachResidentModelToDeviceMemory(deviceMemory) {
    if (!deviceMemory || typeof deviceMemory !== 'object') {
      return deviceMemory;
    }
    const resident = getResidentSummaryModelState();
    if (resident?.status === 'loaded') {
      return {
        ...deviceMemory,
        residentModelId: resident.modelId,
        residentModelName: resident.modelName,
      };
    }
    return deviceMemory;
  }

  function assertNotBlockedByResidentSummaryModel({ modelId, cudaStatus, deviceMemory }) {
    const resident = getResidentSummaryModelState();
    if (!resident || resident.status !== 'loaded') return;
    const targetModelId = resolveTargetSummaryModelId(modelId);
    if (!targetModelId) return;
    const model = getModelById('summary', targetModelId);
    const artifact = getSummaryArtifactForPlatform(targetModelId, process.platform, process.arch);
    const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(process.platform, process.arch, undefined, targetModelId);
    const availability = getSummaryAvailability(process.platform, process.arch, { cudaStatus });
    const fit = getSummaryModelFit({
      model,
      artifact,
      availability,
      runtimeArtifact,
      deviceMemory,
      platform: process.platform,
    });
    if (isFitBlockedSolelyByLowAvailableVram(fit)) {
      throw createSummaryModelLoadedInMemoryError({
        loadedModelId: resident.modelId,
        loadedModelName: resident.modelName,
      });
    }
  }

  function assertSummaryModelActionCanRun(cancelSignal) {
    if (isQuitCommitted()) {
      const error = new Error('Cannot change the local model while AvaNevis is quitting.');
      error.code = 'QUIT_IN_PROGRESS';
      throw error;
    }
    if (cancelSignal?.aborted) {
      throw createAiAddonCancelError('Summary model setup was canceled.');
    }
  }

  async function readSummaryModelAdmission(options, { cancelSignal, cudaProbeLabel } = {}) {
    const unloadLoadedModel = options.unloadLoadedModel === true;
    const read = async () => {
      assertSummaryModelActionCanRun(cancelSignal);
      if (unloadLoadedModel) {
        await releaseSummaryModel('summary_model_setup');
        assertSummaryModelActionCanRun(cancelSignal);
      }
      const cudaStatus = cudaProbeLabel ? await runWallClockComputeAction({
        timeoutMs: AI_COMPUTE_TIMEOUT_MS.addonValidation,
        label: cudaProbeLabel,
        terminateProcess: terminateProcessBestEffort,
        action: (registerProcess) => resolveLinuxSpeakrsCudaStatus({ registerProcess, cancelSignal }),
      }) : undefined;
      assertSummaryModelActionCanRun(cancelSignal);
      const deviceMemory = await getSummaryDeviceMemory({ live: true, fresh: true });
      assertSummaryModelActionCanRun(cancelSignal);
      return { cudaStatus, deviceMemory };
    };
    // Setup and smoke validation acquire the GPU queue separately.
    return unloadLoadedModel ? enqueueGpuResourceAction(read) : read();
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

  function buildDiarizationValidationEnv(engine, requiredDevice, stagedModelsDir) {
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
          stagedModelsDir,
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

  async function validateDiarizationRuntime({ modelRef, token, requiredDevice, cancelSignal, engine, stagedModelsDir } = {}) {
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
      : (token || await getAiAddonToken({
        userDataDir: app.getPath('userData'),
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
        safeStorage: getSafeStorage(),
      }));
    if (cancelSignal?.aborted) {
      throw createAiAddonCancelError('Speaker identification setup was canceled.');
    }

    return createAbortableComputeAction({
      cancelSignal,
      cancelMessage: 'Speaker identification setup was canceled.',
      action: async () => {
        return runWallClockComputeAction({
        timeoutMs: AI_COMPUTE_TIMEOUT_MS.addonValidation,
        label: 'Speaker identification validation',
        terminateProcess: terminateProcessBestEffort,
        action: async (registerProcess) => {
          if (isSpeakrs && process.platform === 'linux') {
            const cudaStatus = await resolveLinuxSpeakrsCudaStatus({ registerProcess, cancelSignal });
            const availability = getDiarizationAvailability(process.platform, process.arch, { cudaStatus });
            if (!availability.supported) throw new Error(availability.reason);
          }
          return new Promise((resolve, reject) => {
          if (cancelSignal && cancelSignal.aborted) {
            reject(createAiAddonCancelError('Speaker identification setup was canceled.'));
            return;
          }

          const python = registerProcess(spawnTrackedPython(
            buildManagedDiarizationValidationArgs(modelRef, requiredDevice, resolvedEngine),
            {
              cwd: pythonConfig.backendPath,
              env: buildDiarizationValidationEnv(resolvedEngine, requiredDevice, stagedModelsDir),
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
          });
        },
        });
      },
    });
  }

  function validateSummaryRuntimeSmoke({ modelId, cache, runtimeArtifact, runtimeDir: resolvedRuntimeDir, cancelSignal, cudaStatus }) {
    const artifact = getSummaryArtifactForPlatform(modelId, process.platform, process.arch);
    if (!artifact) {
      return Promise.reject(new Error('No summary model artifact is available for this platform.'));
    }

    const modelPath = cache && cache.artifactPath ? cache.artifactPath : getSummaryArtifactPath(app.getPath('userData'), artifact);
    const runtimeDir = resolvedRuntimeDir || getSummaryRuntimeDir(app.getPath('userData'), artifact);

    return createAbortableComputeAction({
      cancelSignal,
      cancelMessage: 'Summary model setup was canceled.',
      action: async () => {
        const platform = process.platform;
        if (isQuitCommitted() || cancelSignal?.aborted) {
          throw createAiAddonCancelError('Summary model setup was canceled.');
        }
        const deviceMemory = await getSummaryDeviceMemory({ live: true, fresh: true });
        if (isQuitCommitted() || cancelSignal?.aborted) {
          throw createAiAddonCancelError('Summary model setup was canceled.');
        }
        const effectiveCudaStatus = cudaStatus !== undefined
          ? cudaStatus
          : (typeof getCachedCudaStatus === 'function'
            ? (getCachedCudaStatus({ allowStale: true }) || getCachedCudaStatus())
            : null);
        const fit = getSummaryModelFit({
          model: getModelById('summary', modelId), artifact, runtimeArtifact, deviceMemory, platform,
          availability: getSummaryAvailability(platform, process.arch, { cudaStatus: effectiveCudaStatus }),
        });
        if (deviceMemory && fit.blocked) throw new Error(fit.reason);
        return runWallClockComputeAction({
        timeoutMs: AI_COMPUTE_TIMEOUT_MS.addonValidation,
        label: 'Summary model validation',
        terminateProcess: terminateProcessBestEffort,
        action: async (registerProcess) => {
          let spawned = false;
          try {
            return await new Promise((resolve, reject) => {
              if (cancelSignal && cancelSignal.aborted) {
                reject(createAiAddonCancelError('Summary model setup was canceled.'));
                return;
              }

              const summaryEnv = buildSummaryRuntimeEnv({
                userDataDir: app.getPath('userData'),
                artifact,
                runtimeArtifact,
                runtimeDir,
                platform: process.platform,
                arch: process.arch,
              });
              const python = registerProcess(spawnSummaryPython(buildSummaryArgs({
                meetingId: 'setup-validation',
                runtimeDir,
                modelPath,
                validateRuntime: true,
                modelId,
                modelLabel: artifact.modelLabel || artifact.modelId,
                inferenceDescriptor: artifact.inference,
              }), {
                cwd: pythonConfig.backendPath,
                env: buildClearedHuggingFaceTokenEnv(summaryEnv),
              }));
              spawned = true;

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
            });
          } finally {
            if (spawned) {
              await ensureSummaryProcessExited().catch(() => {});
            }
          }
        },
        });
      },
    });
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('get-ai-addon-status', async (event, options = {}) => {
      const checkDevice = options?.checkDevice === true;
      if (checkDevice) assertTrustedRendererSender(event);
      const userDataDir = app.getPath('userData');
      const cudaStatus = await resolveCudaStatusForAddonStatus(checkDevice);
      const cudaStatusPending = !checkDevice && !cudaStatus && process.platform === 'linux'
        && process.arch === 'x64' && !isQuitCommitted()
        && typeof resolveCudaStatusForTranscription === 'function'
        && managedLinuxCudaRuntimeExists(userDataDir, fs);
      if (cudaStatusPending && !passiveCudaRefresh) {
        passiveCudaRefresh = resolveCudaStatusForAddonStatus(true)
          .catch(() => {})
          .finally(() => { passiveCudaRefresh = null; });
      }
      const deviceMemory = await getSummaryDeviceMemory({ live: checkDevice });
      const resident = checkDevice ? getResidentSummaryModelState() : null;
      return checkAiAddonSetupStatus({
        userDataDir,
        platform: process.platform,
        arch: process.arch,
        includeStorageSizes: Boolean(options?.includeStorageSizes),
        verifyChecksums: Boolean(options?.verifyChecksums),
        verifyChecksumsIfChanged: Boolean(options?.verifyChecksumsIfChanged),
        checkTokenEncryption: false,
        cudaStatus,
        deviceMemory: {
          ...deviceMemory,
          cudaStatusPending,
          ...(resident?.status === 'loaded' && {
            residentModelId: resident.modelId,
            residentModelName: resident.modelName,
          }),
        },
      });
    });

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
      } catch (_error) {
        return {
          success: false,
          code: 'STORAGE_ERROR',
          message: 'Secure token storage could not save the token. Check your secure storage and try again.',
        };
      }
    });

    ipcMain.handle('get-diarization-token-status', async () => ({
      hasToken: hasAiAddonToken({
        userDataDir: app.getPath('userData'),
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
      }),
      encryptionAvailable: await isTokenEncryptionAvailable({ checkAvailability: false }),
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
      const safeOptions = options && typeof options === 'object' ? options : {};
      return runCancellableAiAddonSetup('summary', async (cancelSignal) => {
        if (safeOptions.modelId && !getModelById('summary', safeOptions.modelId)) {
          throw new Error('Unknown summary model.');
        }
        const { cudaStatus, deviceMemory } = await readSummaryModelAdmission(safeOptions, {
          cancelSignal,
          cudaProbeLabel: 'Linux CUDA summary admission',
        });
        if (safeOptions.unloadLoadedModel !== true) {
          assertNotBlockedByResidentSummaryModel({
            modelId: safeOptions.modelId,
            cudaStatus,
            deviceMemory,
          });
        }
        return setupSummaryModel(getAiAddonRuntimeOptions({
          modelId: safeOptions.modelId,
          profile: safeOptions.profile,
          pythonExe: pythonConfig.pythonExe,
          backendPath: pythonConfig.backendPath,
          runtimeValidator: validateSummaryRuntimeSmoke,
          runExclusiveMutation: runExclusiveSummaryMutation,
          deviceMemory: attachResidentModelToDeviceMemory(deviceMemory),
          getDeviceMemory: async () => attachResidentModelToDeviceMemory(await getSummaryDeviceMemory({ live: true, fresh: true })),
          cancelSignal,
          cudaStatus,
        }));
      });
    });

    ipcMain.handle('cancel-summary-model-setup', async (event) => {
      assertTrustedRendererSender(event);
      return cancelAiAddonSetup('summary');
    });

    ipcMain.handle('validate-summary-model', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const safeOptions = options && typeof options === 'object' ? options : {};
      return runCancellableAiAddonSetup('summary', async (cancelSignal) => {
        let admission;
        try {
          if (safeOptions.modelId && !getModelById('summary', safeOptions.modelId)) {
            throw new Error('Unknown summary model.');
          }
          admission = await readSummaryModelAdmission(safeOptions, {
            cancelSignal,
            cudaProbeLabel: 'Linux CUDA summary validation',
          });
          const { cudaStatus, deviceMemory } = admission;
          if (safeOptions.unloadLoadedModel !== true) {
            assertNotBlockedByResidentSummaryModel({
              modelId: safeOptions.modelId,
              cudaStatus,
              deviceMemory,
            });
          }
          return await validateSummaryModel(getAiAddonRuntimeOptions({
            modelId: safeOptions.modelId,
            profile: safeOptions.profile,
            runtimeValidator: validateSummaryRuntimeSmoke,
            runExclusiveMutation: runExclusiveSummaryMutation,
            deviceMemory: attachResidentModelToDeviceMemory(deviceMemory),
            getDeviceMemory: async () => attachResidentModelToDeviceMemory(await getSummaryDeviceMemory({ live: true, fresh: true })),
            cancelSignal,
            cudaStatus,
          }));
        } catch (error) {
          if (error.code === 'SUMMARY_MODEL_EXIT_UNCONFIRMED' || error.code === 'QUIT_IN_PROGRESS') throw error;
          if (!cancelSignal.aborted && error.code !== AI_ADDON_CANCEL_CODE) throw error;
          emitAiAddonProgress({ feature: 'summary', phase: 'cancelled', modelId: safeOptions.modelId, message: 'Setup check canceled.' });
          const fallbackDeviceMemory = isQuitCommitted() || safeOptions.unloadLoadedModel === true
            ? admission?.deviceMemory ?? null
            : await getSummaryDeviceMemory({ live: true, fresh: true });
          return checkAiAddonSetupStatus(getAiAddonRuntimeOptions({
            deviceMemory: fallbackDeviceMemory ? attachResidentModelToDeviceMemory(fallbackDeviceMemory) : fallbackDeviceMemory,
            cudaStatus: admission?.cudaStatus ?? getCachedCudaStatus(),
          }));
        }
      });
    });

    ipcMain.handle('remove-summary-model', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      if (aiAddonSetupAbortControllers.has('summary')) {
        throw new Error('Summary model setup is already running. Cancel it before removing the model.');
      }
      assertRemovalCanRun('summary');
      validateSummaryModelRemovalRequest({
        userDataDir: app.getPath('userData'),
        modelId: options.modelId,
        replacementModelId: options.replacementModelId,
        fsModule: fs,
      });

      return enqueueAiAddonAction(async () => {
        assertRemovalCanRun('summary');
        validateSummaryModelRemovalRequest({
          userDataDir: app.getPath('userData'),
          modelId: options.modelId,
          replacementModelId: options.replacementModelId,
          fsModule: fs,
        });
        const deviceMemory = await getSummaryDeviceMemory({ live: false });
        return enqueueGpuExclusiveRemovalAction(() => {
          return removeSummaryModel(getAiAddonRuntimeOptions({
            modelId: options.modelId,
            replacementModelId: options.replacementModelId,
            deviceMemory,
          }));
        });
      });
    });

    ipcMain.handle('set-default-summary-model', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const safeOptions = options && typeof options === 'object' ? options : {};
      return enqueueAiAddonAction(async () => {
        assertSummaryModelActionCanRun();
        if (!getModelById('summary', safeOptions.modelId)) throw new Error('Unknown summary model.');
        const hasCachedCudaStatus = typeof getCachedCudaStatus === 'function'
          && Boolean(getCachedCudaStatus({ allowStale: true }) || getCachedCudaStatus());
        const shouldProbeCuda = process.platform === 'linux'
          && process.arch === 'x64'
          && !hasCachedCudaStatus;
        const { cudaStatus, deviceMemory } = await readSummaryModelAdmission(
          safeOptions,
          shouldProbeCuda ? { cudaProbeLabel: 'Linux CUDA summary default selection' } : undefined,
        );
        const status = await checkAiAddonSetupStatus(getAiAddonRuntimeOptions({
          summaryModelId: safeOptions.modelId,
          ...(cudaStatus !== undefined ? { cudaStatus } : {}),
          deviceMemory,
        }));
        const model = status.features.summary;
        if (
          safeOptions.unloadLoadedModel !== true
          && model.modelId === safeOptions.modelId
          && model.setupComplete
          && isFitBlockedSolelyByLowAvailableVram(model.fit)
        ) {
          const resident = getResidentSummaryModelState();
          if (resident?.status === 'loaded') {
            throw createSummaryModelLoadedInMemoryError({
              loadedModelId: resident.modelId,
              loadedModelName: resident.modelName,
            });
          }
        }
        if (model.modelId !== safeOptions.modelId || !model.setupComplete || model.fit?.blocked) {
          throw new Error(model.fit?.reason || model.error || 'Check setup for this model before setting it as the default.');
        }
        assertSummaryModelActionCanRun();
        setDefaultSummaryModel(getAiAddonRuntimeOptions({ modelId: safeOptions.modelId, fsModule: fs }));
        return checkAiAddonSetupStatus(getAiAddonRuntimeOptions({
          ...(cudaStatus !== undefined ? { cudaStatus } : {}),
          deviceMemory: attachResidentModelToDeviceMemory(deviceMemory),
        }));
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
