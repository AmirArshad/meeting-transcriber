'use strict';

/**
 * GPU / CUDA runtime service for the AvaNevis main process.
 *
 * Owns `cachedCudaStatus` and `gpuRuntimeActionPromise` (GPU install/probe
 * serialization — separate from aiAddonActionQueue and aiComputeActionQueue).
 * Registers: check-gpu, check-cuda, install-gpu, ensure-compatible-gpu-runtime,
 * uninstall-gpu.
 */

const {
  buildTranscriptionCudaInstallArgs,
  buildTranscriptionCudaUninstallArgs,
  buildUnsupportedCudaPythonMessage,
  getGpuRuntimeEnsurePlan,
  getPythonSitePackagesCandidates,
  getPyTorchCudaBinCandidates,
  isSupportedCudaInstallPythonVersion,
  parseCheckCudaStatus,
  getCudaRuntimeProfiles,
  getSupportedTranscriptionCudaProfileIds,
  getTranscriptionCudaPackages,
  createLineChunkRedactor,
  GPU_RUNTIME_ACTION_TIMEOUT_MS,
  AI_COMPUTE_TIMEOUT_MS,
  runWallClockComputeAction,
} = require('../main-process-helpers');
const {
  buildUnsupportedPlatformCudaStatus,
  getUnsupportedPlatformCudaProbeError,
  getManagedLinuxCudaRuntimeTarget,
  getManagedLinuxCudaLibraryDirs,
  buildManagedLinuxCudaLibraryPath,
  getRequiredCudaRuntimeLibraries,
} = require('../main-process/cuda-runtime-helpers');
const {
  assertLinuxCudaCatalogIntegrity,
  getLinuxCuda12RuntimeCatalog,
} = require('../main-process/linux-cuda-runtime-catalog');
const {
  buildLinuxCudaOfflineInstallArgs,
  buildProbeErrorStatus,
  detectLinuxNvidiaGpu,
  getLinuxCudaRuntimeStagingPath,
  getLinuxCudaTombstonePath,
  getLinuxCudaWheelhousePath,
  getLinuxCudaWheelStagePath,
  managedLinuxCudaRuntimeExists,
  parseLinuxCheckCudaStatus,
  resolveLinuxCudaDriverLibraryDirs,
  resolveRequiredLinuxCudaLibraryPath,
  stageVerifiedLinuxCudaWheels,
  swapLinuxCudaRuntimeAtomically,
  verifyDownloadedLinuxCudaWheel,
  verifyLinuxCudaRuntimeIntegrity,
} = require('../main-process/linux-cuda-runtime-helpers');
const { execFileSync: defaultExecFileSync } = require('child_process');
const { downloadFile } = require('../ai-addon/download-helpers');

/**
 * @param {object} deps
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {object} deps.pythonConfig
 * @param {Function} deps.spawnTrackedPython
 * @param {Function} deps.getBackendModuleArgs
 * @param {Function} deps.appendSpawnLogBuffer
 * @param {Function} deps.sendRedactedProgress
 * @param {Function} deps.flushRedactedProgress
 * @param {Function} deps.getActivePythonVersion
 * @param {Function} deps.terminateProcessBestEffort
 * @param {Function} deps.assertTrustedRendererSender
 * @param {Function} deps.getDiarizationDependencySitePackagesPath
 * @param {Function} [deps.waitForAiComputeQueueIdle]
 * @param {Function} [deps.hasPendingAiComputeWork]
 * @param {Function} [deps.getBusyTranscriptionJobCount]
 * @param {Function} [deps.formatQueuedTranscriptionBusyMessage]
 * @param {Function} [deps.enqueueGpuResourceAction]
 * @param {Function} [deps.isQuitCommitted]
 */
function createGpuRuntimeService(deps) {
  const {
    app,
    path,
    fs,
    pythonConfig,
    spawnTrackedPython,
    getBackendModuleArgs,
    appendSpawnLogBuffer,
    sendRedactedProgress,
    flushRedactedProgress,
    getActivePythonVersion,
    terminateProcessBestEffort,
    assertTrustedRendererSender,
    getDiarizationDependencySitePackagesPath,
    waitForAiComputeQueueIdle = async () => {},
    hasPendingAiComputeWork = () => false,
    getBusyTranscriptionJobCount = () => 0,
    formatQueuedTranscriptionBusyMessage = (count, action) => (
      `Local AI work is still running. Finish or cancel it before ${action}.`
    ),
    enqueueGpuResourceAction = (action) => action(),
    isQuitCommitted = () => false,
    // Default remains false. The composition root offers Linux CUDA when an
    // NVIDIA GPU (or leftover managed runtime) is present on linux x64.
    isLinuxCudaProfileEnabled = () => false,
    downloadLinuxCudaWheel = downloadFile,
    verifyLinuxCudaIntegrity = verifyLinuxCudaRuntimeIntegrity,
    getLinuxCudaCatalog = getLinuxCuda12RuntimeCatalog,
    execFileSyncFn = defaultExecFileSync,
  } = deps;

  // Single shared CUDA status cache + GPU runtime lock. Never copy these lets
  // into a local that can go stale — mutate the closed-over bindings only.
  let cachedCudaStatus = null;
  let gpuRuntimeActionPromise = null;
  let cachedActivePythonVersion = null;

  function isSupportedCudaPlatform() {
    return process.platform === 'win32'
      || (process.platform === 'linux' && process.arch === 'x64' && isLinuxCudaProfileEnabled() === true);
  }

  function getLinuxCudaRuntimeTarget() {
    return getManagedLinuxCudaRuntimeTarget(app.getPath('userData'));
  }

  function updateCachedCudaStatus(status) {
    if (!status || typeof status !== 'object') {
      return;
    }
    cachedCudaStatus = {
      ...status,
      checkedAt: Date.now(),
    };
  }

  function invalidateCachedCudaStatus() {
    cachedCudaStatus = null;
  }

  function getCachedCudaStatus() {
    if (!cachedCudaStatus || typeof cachedCudaStatus !== 'object') {
      return null;
    }
    const maxAgeMs = 5 * 60 * 1000;
    if (!Number.isFinite(cachedCudaStatus.checkedAt) || Date.now() - cachedCudaStatus.checkedAt > maxAgeMs) {
      return null;
    }
    return cachedCudaStatus;
  }

  /**
   * Fresh CUDA probe for transcription preemption. UI `check-cuda` keeps a
   * 5-minute TTL; compute jobs must not silently skip preemptive CPU when that
   * cache has expired. The composition-root resource queue keeps GPU actions idle
   * while this probe runs, so a ~1–2s probe is safe relative to the job budget.
   *
   * Linux: a missing managed runtime is Core Beta CPU. A present runtime is
   * fail-closed CUDA until the user repairs or uninstalls.
   */
  async function resolveCudaStatusForTranscription({ registerProcess } = {}) {
    if (process.platform === 'linux') {
      if (process.arch !== 'x64') {
        return null;
      }
      try {
        if (!fs.existsSync(getLinuxCudaRuntimeTarget())) {
          return null;
        }
      } catch (_error) {
        return null;
      }
      return checkCudaRuntimeStatus({ registerProcess });
    }
    if (!isSupportedCudaPlatform()) {
      return null;
    }
    // Transcription enters through gpuResourceActionQueue, so any runtime action
    // is either already finished or parked behind this probe. Always re-probe.
    return checkCudaRuntimeStatus({ registerProcess });
  }

  async function getCachedActivePythonVersion() {
    if (cachedActivePythonVersion) {
      return cachedActivePythonVersion;
    }
    cachedActivePythonVersion = await getActivePythonVersion();
    return cachedActivePythonVersion;
  }

  function buildCudaRuntimeEnv(extra = {}, { includeManagedDiarization = false } = {}) {
    if (process.platform !== 'win32' && process.platform !== 'linux') {
      return extra;
    }

    if (process.platform === 'linux') {
      const rest = { ...extra };
      delete rest.LD_LIBRARY_PATH;
      // Explicit undefined unsets inherited LD_LIBRARY_PATH in buildPythonEnv.
      // Always clear it for Linux children, including CPU-default and arm64.
      const cleared = { ...rest, LD_LIBRARY_PATH: undefined };
      if (process.arch !== 'x64') {
        return cleared;
      }
      try {
        const managedRoot = getLinuxCudaRuntimeTarget();
        if (!fs.existsSync(managedRoot)) {
          return cleared;
        }
        const libraryDirs = getManagedLinuxCudaLibraryDirs(managedRoot)
          .filter((candidate) => fs.existsSync(candidate));
        if (libraryDirs.length === 0) {
          return cleared;
        }
        let driverLibraryDirs = [];
        try {
          driverLibraryDirs = resolveLinuxCudaDriverLibraryDirs({ fsModule: fs });
        } catch (_driverError) {
          driverLibraryDirs = [];
        }
        return {
          ...rest,
          LD_LIBRARY_PATH: buildManagedLinuxCudaLibraryPath({
            managedRoot,
            libraryDirs,
            driverLibraryDirs,
            fsModule: fs,
          }),
        };
      } catch (_error) {
        return cleared;
      }
    }

    const candidateSitePackagesDirs = [
      ...getPythonSitePackagesCandidates({
        pythonExe: pythonConfig.pythonExe,
        virtualEnv: pythonConfig.virtualEnv || process.env.VIRTUAL_ENV,
        appData: process.env.APPDATA,
        platform: process.platform,
      }),
      includeManagedDiarization ? getDiarizationDependencySitePackagesPath() : null,
    ].filter(Boolean);

    const cudaBinDirs = getPyTorchCudaBinCandidates(candidateSitePackagesDirs)
      .filter((candidate, index, candidates) => fs.existsSync(candidate) && candidates.indexOf(candidate) === index);

    if (!cudaBinDirs.length) {
      return extra;
    }

    return {
      ...extra,
      PATH: `${cudaBinDirs.join(path.delimiter)}${path.delimiter}${extra.PATH || process.env.PATH || ''}`,
    };
  }

  function getDefaultTranscriptionCudaPackages() {
    return getTranscriptionCudaPackages();
  }

  async function runGpuRuntimeAction(actionFn) {
    // Transcription jobs serialize through gpuResourceActionQueue, so installs
    // run between compute jobs (Phase 2) without overlapping loaded CUDA DLLs.
    if (gpuRuntimeActionPromise) {
      const error = new Error('A GPU runtime action is already in progress. Please wait for it to finish.');
      error.code = 'GPU_RUNTIME_ACTION_BUSY';
      return Promise.reject(error);
    }

    if (isQuitCommitted()) {
      const error = new Error('Cannot change the GPU runtime while the app is quitting.');
      error.code = 'QUIT_IN_PROGRESS';
      return Promise.reject(error);
    }

    gpuRuntimeActionPromise = enqueueGpuResourceAction(() => {
      if (isQuitCommitted()) {
        const error = new Error('GPU runtime setup was skipped because the app is quitting.');
        error.code = 'QUIT_IN_PROGRESS';
        throw error;
      }
      return runWallClockComputeAction({
        action: (registerProcess) => actionFn(registerProcess),
        timeoutMs: GPU_RUNTIME_ACTION_TIMEOUT_MS,
        label: 'GPU runtime setup',
        terminateProcess: terminateProcessBestEffort,
      });
    })
      .finally(() => {
        gpuRuntimeActionPromise = null;
      });
    return gpuRuntimeActionPromise;
  }

  function hasInFlightGpuRuntimeAction() {
    return Boolean(gpuRuntimeActionPromise);
  }

  function waitForGpuRuntimeIdle() {
    return gpuRuntimeActionPromise ? gpuRuntimeActionPromise.catch(() => {}) : Promise.resolve();
  }

  function getGpuRepairRecommendedMarkerPath() {
    return path.join(app.getPath('userData'), 'gpu-runtime-repair-recommended.json');
  }

  function markGpuRepairRecommendedAfterQuitKill(reason = 'GPU runtime setup was interrupted because the app quit.') {
    try {
      const markerPath = getGpuRepairRecommendedMarkerPath();
      fs.writeFileSync(markerPath, JSON.stringify({
        recommended: true,
        reason: String(reason || '').slice(0, 500),
        markedAt: new Date().toISOString(),
      }), 'utf8');
    } catch (error) {
      console.warn('Failed to persist GPU repair-recommended marker:', error.message);
    }
  }

  function consumeGpuRepairRecommendedMarker() {
    const markerPath = getGpuRepairRecommendedMarkerPath();
    try {
      if (!fs.existsSync(markerPath)) {
        return null;
      }
      const raw = fs.readFileSync(markerPath, 'utf8');
      fs.rmSync(markerPath, { force: true });
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.recommended !== true) {
        return null;
      }
      return {
        recommended: true,
        reason: parsed.reason || 'GPU runtime setup was interrupted by a previous quit.',
        markedAt: parsed.markedAt || null,
      };
    } catch (error) {
      try {
        fs.rmSync(markerPath, { force: true });
      } catch (_cleanupError) {
        // ignore
      }
      return null;
    }
  }

  function attachManagedRuntimePresence(status) {
    if (!status || typeof status !== 'object') {
      return status;
    }
    let managedRuntimePresent = false;
    if (process.platform === 'linux') {
      try {
        managedRuntimePresent = managedLinuxCudaRuntimeExists(app.getPath('userData'), fs);
      } catch (_error) {
        managedRuntimePresent = false;
      }
    }
    return {
      ...status,
      managedRuntimePresent,
    };
  }

  function checkNvidiaGpuAvailability({ registerProcess = (proc) => proc } = {}) {
    if (process.platform === 'linux') {
      try {
        const detected = detectLinuxNvidiaGpu({
          fsModule: fs,
          execFileSyncFn,
        });
        return Promise.resolve({
          hasGPU: detected.hasGPU,
          gpuName: detected.gpuName,
        });
      } catch (_error) {
        return Promise.resolve({
          hasGPU: false,
          gpuName: null,
        });
      }
    }

    return new Promise((resolve) => {
      const python = registerProcess(spawnTrackedPython([
        '-c',
        'import subprocess; result = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True); print(result.stdout.strip() if result.returncode == 0 else "None")'
      ]));

      let output = '';
      python.stdout.on('data', (data) => {
        output = appendSpawnLogBuffer(output, data);
      });
      python.on('close', () => {
        const gpuName = output.trim();
        resolve({
          hasGPU: gpuName !== 'None' && gpuName !== '',
          gpuName: gpuName !== 'None' ? gpuName : null,
        });
      });
      python.on('error', () => {
        resolve({
          hasGPU: false,
          gpuName: null,
        });
      });
    });
  }

  async function enrichCheckCudaStatus(parsedStatus) {
    if (parsedStatus && parsedStatus.statusCode === 'unsupportedPlatform') {
      return attachManagedRuntimePresence({
        ...parsedStatus,
        version: null,
        packages: [],
        pythonVersion: null,
        pythonSupportedForInstall: false,
        pythonExecutable: null,
      });
    }
    try {
      const pythonVersion = await getCachedActivePythonVersion();
      return attachManagedRuntimePresence({
        ...parsedStatus,
        version: null,
        packages: getDefaultTranscriptionCudaPackages(),
        pythonVersion: pythonVersion.parsed ? pythonVersion.parsed.version : pythonVersion.output,
        pythonSupportedForInstall: isSupportedCudaInstallPythonVersion(pythonVersion.parsed),
        pythonExecutable: pythonConfig.pythonExe,
      });
    } catch (error) {
      return attachManagedRuntimePresence({
        ...parsedStatus,
        version: null,
        packages: getDefaultTranscriptionCudaPackages(),
        pythonVersion: null,
        pythonSupportedForInstall: false,
        pythonExecutable: pythonConfig.pythonExe,
      });
    }
  }

  function bestEffortRemovePath(targetPath) {
    if (!targetPath) {
      return;
    }
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } catch (_error) {
      fs.promises.rm(targetPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function runLinuxCudaPackageInstall({ mode = 'install', registerProcess = (proc) => proc } = {}) {
    const catalog = assertLinuxCudaCatalogIntegrity(getLinuxCudaCatalog());
    const userData = app.getPath('userData');
    const wheelhouse = getLinuxCudaWheelhousePath(userData);
    const activeTarget = getLinuxCudaRuntimeTarget();
    const now = Date.now();
    const pid = process.pid;
    const wheelStage = getLinuxCudaWheelStagePath(userData, { now, pid });
    const runtimeStage = getLinuxCudaRuntimeStagingPath(activeTarget, { now, pid });
    let promoted = false;
    fs.mkdirSync(wheelhouse, { recursive: true });
    fs.mkdirSync(path.dirname(activeTarget), { recursive: true });

    try {
      for (const wheel of catalog.wheels) {
        const destinationPath = path.join(wheelhouse, wheel.fileName);
        await downloadLinuxCudaWheel({
          url: wheel.downloadUrl,
          destinationPath,
          expectedSizeBytes: wheel.sizeBytes,
        });
        verifyDownloadedLinuxCudaWheel(destinationPath, wheel, fs);
      }

      const verifiedWheelPaths = stageVerifiedLinuxCudaWheels({
        sourceDir: wheelhouse,
        stagingDir: wheelStage,
        catalog,
        fsModule: fs,
      });
      const pipArgs = buildLinuxCudaOfflineInstallArgs({
        wheelPaths: verifiedWheelPaths,
        target: runtimeStage,
        catalog,
      });
      console.log('Linux CUDA pip install:', JSON.stringify({
        wheelPaths: verifiedWheelPaths,
        stagingTarget: runtimeStage,
        activeTarget,
        pipArgs,
      }));

      await new Promise((resolve, reject) => {
        const python = registerProcess(spawnTrackedPython(pipArgs));
        let errorOutput = '';
        const progressRedactor = createLineChunkRedactor();
        python.stdout.on('data', (data) => {
          sendRedactedProgress('gpu-install-progress', data.toString(), progressRedactor);
        });
        python.stderr.on('data', (data) => {
          const text = data.toString();
          errorOutput = appendSpawnLogBuffer(errorOutput, text);
          sendRedactedProgress('gpu-install-progress', text, progressRedactor);
        });
        python.on('close', (code) => {
          flushRedactedProgress('gpu-install-progress', progressRedactor);
          if (code === 0) {
            resolve();
            return;
          }
          invalidateCachedCudaStatus();
          reject(new Error(`Failed to install CUDA libraries: ${errorOutput}`));
        });
        python.on('error', (error) => {
          flushRedactedProgress('gpu-install-progress', progressRedactor);
          invalidateCachedCudaStatus();
          reject(error);
        });
      });

      const integrity = await verifyLinuxCudaIntegrity({
        managedRoot: runtimeStage,
        catalog,
        fsModule: fs,
      });
      if (!integrity.ok) {
        invalidateCachedCudaStatus();
        const error = new Error(integrity.error || 'Managed CUDA runtime failed integrity verification.');
        error.code = integrity.statusCode;
        throw error;
      }

      const { tombstonePath, renamedActive } = swapLinuxCudaRuntimeAtomically({
        activePath: activeTarget,
        stagingPath: runtimeStage,
        fsModule: fs,
        now,
        pid,
      });
      console.log('Linux CUDA runtime swapped:', JSON.stringify({
        activeTarget,
        stagingTarget: runtimeStage,
        tombstonePath,
        renamedActive,
      }));
      promoted = true;
      invalidateCachedCudaStatus();
      if (renamedActive) {
        try {
          fs.rmSync(tombstonePath, { recursive: true, force: true });
        } catch (_error) {
          await fs.promises.rm(tombstonePath, { recursive: true, force: true });
        }
      }
    } finally {
      bestEffortRemovePath(wheelStage);
      if (!promoted) {
        bestEffortRemovePath(runtimeStage);
      }
    }

    return {
      success: true,
      mode,
      message: mode === 'repair'
        ? 'GPU runtime repair completed successfully.'
        : 'GPU acceleration installed successfully.',
    };
  }

  function runGpuPackageInstall({ mode = 'install', registerProcess = (proc) => proc } = {}) {
    const normalizedMode = String(mode || 'install').trim().toLowerCase() === 'repair' ? 'repair' : 'install';
    const isRepairMode = normalizedMode === 'repair';

    if (process.platform === 'linux') {
      return runLinuxCudaPackageInstall({ mode: normalizedMode, registerProcess });
    }

    return new Promise((resolve, reject) => {
      const python = registerProcess(spawnTrackedPython(buildTranscriptionCudaInstallArgs({
        forceReinstall: isRepairMode,
        noCache: isRepairMode,
      })));

      let errorOutput = '';
      const progressRedactor = createLineChunkRedactor();

      python.stdout.on('data', (data) => {
        const text = data.toString();
        sendRedactedProgress('gpu-install-progress', text, progressRedactor);
      });

      python.stderr.on('data', (data) => {
        const text = data.toString();
        errorOutput = appendSpawnLogBuffer(errorOutput, text);
        sendRedactedProgress('gpu-install-progress', text, progressRedactor);
      });

      python.on('close', (code) => {
        flushRedactedProgress('gpu-install-progress', progressRedactor);
        if (code === 0) {
          resolve({
            success: true,
            mode: normalizedMode,
            message: isRepairMode
              ? 'GPU runtime repair completed successfully.'
              : 'GPU acceleration installed successfully.',
          });
          return;
        }
        invalidateCachedCudaStatus();
        reject(new Error(`Failed to install CUDA libraries: ${errorOutput}`));
      });

      python.on('error', (error) => {
        flushRedactedProgress('gpu-install-progress', progressRedactor);
        invalidateCachedCudaStatus();
        reject(error);
      });
    });
  }

  async function checkCudaRuntimeStatus({ registerProcess = (proc) => proc } = {}) {
    if (!isSupportedCudaPlatform()) {
      return attachManagedRuntimePresence(buildUnsupportedPlatformCudaStatus(process.platform));
    }

    if (process.platform === 'linux') {
      const catalog = getLinuxCudaCatalog();
      const integrity = await verifyLinuxCudaIntegrity({
        managedRoot: getLinuxCudaRuntimeTarget(),
        catalog,
        fsModule: fs,
      });
      if (!integrity.ok) {
        const status = attachManagedRuntimePresence({
          installed: false,
          deviceAvailable: false,
          runtimeLoadable: false,
          missingLibraries: integrity.missingLibraries || [],
          runtime: 'ctranslate2',
          statusCode: integrity.statusCode,
          supportedProfiles: getSupportedTranscriptionCudaProfileIds(),
          unsupportedDetectedProfiles: [],
          recommendedInstallProfile: getSupportedTranscriptionCudaProfileIds()[0] || 'cuda12',
          error: integrity.error,
        });
        updateCachedCudaStatus(status);
        return status;
      }
    }

    return new Promise((resolve) => {
      const finish = (status) => {
        const withPresence = attachManagedRuntimePresence(status);
        updateCachedCudaStatus(withPresence);
        resolve(withPresence);
      };
      let probeProfiles;
      let unsupportedDllHints;
      let managedDirs = [];
      let linuxCatalog = null;
      let supportedProfileIds = [];
      try {
        const knownProfiles = getCudaRuntimeProfiles();
        supportedProfileIds = getSupportedTranscriptionCudaProfileIds();
        const supportedProfiles = knownProfiles.filter((profile) => supportedProfileIds.includes(profile.id));
        const unsupportedProfiles = knownProfiles.filter((profile) => !supportedProfileIds.includes(profile.id));
        linuxCatalog = process.platform === 'linux' ? getLinuxCudaCatalog() : null;
        managedDirs = process.platform === 'linux'
          ? getManagedLinuxCudaLibraryDirs(getLinuxCudaRuntimeTarget())
          : [];
        probeProfiles = supportedProfiles.map((profile) => {
          const libraries = getRequiredCudaRuntimeLibraries(profile.id, { platform: process.platform });
          if (process.platform !== 'linux') return { id: profile.id, requiredDlls: libraries };
          return {
            id: profile.id,
            requiredDlls: libraries.map((libraryName) => {
              const pin = linuxCatalog.requiredLibraries.find((item) => item.fileName === libraryName)
                || { fileName: libraryName, relativePath: `nvidia/cublas/lib/${libraryName}` };
              return resolveRequiredLinuxCudaLibraryPath(getLinuxCudaRuntimeTarget(), pin, fs);
            }),
          };
        });
        unsupportedDllHints = process.platform === 'linux'
          ? [{
            id: 'cuda13',
            expectedDllPrefixes: [...linuxCatalog.unsupportedLibraryPrefixes],
          }]
          : unsupportedProfiles.map((profile) => ({
            id: profile.id,
            expectedDllPrefixes: Array.isArray(profile.expectedDllPrefixes) ? profile.expectedDllPrefixes : [],
          }));
      } catch (error) {
        finish(buildProbeErrorStatus(String(error && error.message ? error.message : error)));
        return;
      }

      const probeArgs = [
        '--profiles-json', JSON.stringify(probeProfiles),
        '--supported-profiles', supportedProfileIds.join(','),
        '--unsupported-hints-json', JSON.stringify(unsupportedDllHints),
        '--platform', process.platform,
        '--device-check', process.platform === 'linux' ? 'nvidia-smi' : 'ctranslate2',
      ];
      if (process.platform === 'linux') {
        probeArgs.push(
          '--library-search-dirs-json',
          JSON.stringify(managedDirs),
          '--validate-ctranslate2-cuda',
        );
      }

      const python = registerProcess(spawnTrackedPython(
        getBackendModuleArgs('transcription.cuda_probe', probeArgs),
        { env: buildCudaRuntimeEnv() },
      ));

      let output = '';
      python.stdout.on('data', (data) => {
        output = appendSpawnLogBuffer(output, data);
      });
      python.on('close', (code) => {
        if (code !== 0) {
          finish(buildProbeErrorStatus(`CUDA probe exited with code ${code}.`));
          return;
        }
        finish(process.platform === 'linux'
          ? parseLinuxCheckCudaStatus(output)
          : parseCheckCudaStatus(output));
      });
      python.on('error', (error) => {
        finish(buildProbeErrorStatus(String(error && error.message ? error.message : error)));
      });
    });
  }

  async function ensureCompatibleGpuRuntime(options = {}) {
    const skipInstallIfReady = options.skipInstallIfReady !== false;
    const forceRepair = Boolean(options.forceRepair);
    const registerProcess = typeof options.registerProcess === 'function'
      ? options.registerProcess
      : (proc) => proc;

    if (!isSupportedCudaPlatform()) {
      const finalStatus = await enrichCheckCudaStatus(buildUnsupportedPlatformCudaStatus(process.platform));
      return {
        success: false,
        action: 'none',
        initialStatus: finalStatus,
        finalStatus,
        message: finalStatus.error,
      };
    }

    const initialStatus = await enrichCheckCudaStatus(await checkCudaRuntimeStatus({ registerProcess }));
    const gpuInfo = await checkNvidiaGpuAvailability({ registerProcess });

    const ensurePlan = getGpuRuntimeEnsurePlan(initialStatus, { forceRepair, skipInstallIfReady });
    if (!ensurePlan.shouldInstall && ensurePlan.success) {
      return {
        success: true,
        action: ensurePlan.action,
        initialStatus,
        finalStatus: initialStatus,
        message: ensurePlan.message,
      };
    }

    if (!initialStatus.pythonSupportedForInstall) {
      return {
        success: false,
        action: 'none',
        initialStatus,
        finalStatus: initialStatus,
        message: buildUnsupportedCudaPythonMessage(initialStatus.pythonVersion || ''),
      };
    }

    if (!gpuInfo.hasGPU) {
      return {
        success: false,
        action: 'none',
        initialStatus,
        finalStatus: initialStatus,
        message: 'No NVIDIA GPU was detected on this system. GPU acceleration cannot be enabled.',
      };
    }

    if (!ensurePlan.shouldInstall) {
      return {
        success: false,
        action: ensurePlan.action,
        initialStatus,
        finalStatus: initialStatus,
        message: ensurePlan.message,
      };
    }

    const installMode = ensurePlan.action;
    await runGpuPackageInstall({ mode: installMode, registerProcess });
    const finalStatus = await enrichCheckCudaStatus(await checkCudaRuntimeStatus({ registerProcess }));

    return {
      success: Boolean(finalStatus.installed),
      action: installMode,
      initialStatus,
      finalStatus,
      message: finalStatus.installed
        ? 'CUDA runtime is installed and loadable.'
        : `CUDA runtime is still not loadable (${finalStatus.statusCode || 'unknown'}).`,
    };
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('check-gpu', async (event) => {
      assertTrustedRendererSender(event);
      return checkNvidiaGpuAvailability();
    });

    ipcMain.handle('check-cuda', async (event) => {
      assertTrustedRendererSender(event);
      try {
        if (!isSupportedCudaPlatform()) {
          return enrichCheckCudaStatus(buildUnsupportedPlatformCudaStatus(process.platform));
        }
        // Avoid caching a transient "not loadable" probe while pip is rewriting DLLs.
        // When no cache exists yet (first-run install), still defer — return a
        // probe-deferred placeholder instead of racing the install.
        if (hasInFlightGpuRuntimeAction()) {
          const cached = getCachedCudaStatus();
          if (cached) {
            return {
              ...cached,
              probeDeferredDuringGpuAction: true,
            };
          }
          return enrichCheckCudaStatus({
            installed: false,
            deviceAvailable: false,
            runtimeLoadable: false,
            missingLibraries: [],
            runtime: 'ctranslate2',
            statusCode: 'probeDeferredDuringGpuAction',
            supportedProfiles: getSupportedTranscriptionCudaProfileIds(),
            unsupportedDetectedProfiles: [],
            recommendedInstallProfile: getSupportedTranscriptionCudaProfileIds()[0] || 'cuda12',
            error: 'CUDA status check is deferred while a GPU runtime install or repair is in progress.',
            probeDeferredDuringGpuAction: true,
          });
        }
        const status = await enrichCheckCudaStatus(await checkCudaRuntimeStatus());
        const quitInterrupted = consumeGpuRepairRecommendedMarker();
        if (quitInterrupted && !status.runtimeLoadable) {
          return {
            ...status,
            repairRecommendedAfterQuit: true,
            repairRecommendedReason: quitInterrupted.reason,
            statusCode: status.statusCode === 'ok' ? 'repairRecommendedAfterQuit' : status.statusCode,
          };
        }
        return status;
      } catch (error) {
        return enrichCheckCudaStatus({
          installed: false,
          deviceAvailable: false,
          runtimeLoadable: false,
          missingLibraries: [],
          runtime: 'ctranslate2',
          statusCode: 'probeError',
          supportedProfiles: getSupportedTranscriptionCudaProfileIds(),
          unsupportedDetectedProfiles: [],
          recommendedInstallProfile: getSupportedTranscriptionCudaProfileIds()[0] || 'cuda12',
          error: String(error && error.message ? error.message : error),
        });
      }
    });

    ipcMain.handle('install-gpu', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      if (!isSupportedCudaPlatform()) {
        const error = new Error(getUnsupportedPlatformCudaProbeError(process.platform));
        error.code = 'unsupportedPlatform';
        throw error;
      }
      return runGpuRuntimeAction(async (registerProcess) => {
        const requestedMode = String(options && options.mode ? options.mode : 'install').trim().toLowerCase();
        const ensureResult = await ensureCompatibleGpuRuntime({
          skipInstallIfReady: false,
          forceRepair: requestedMode === 'repair',
          registerProcess,
        });
        if (!ensureResult.success) {
          throw new Error(ensureResult.message || 'GPU runtime is still not loadable.');
        }
        return ensureResult;
      });
    });

    ipcMain.handle('ensure-compatible-gpu-runtime', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      if (!isSupportedCudaPlatform()) {
        const error = new Error(getUnsupportedPlatformCudaProbeError(process.platform));
        error.code = 'unsupportedPlatform';
        throw error;
      }
      return runGpuRuntimeAction((registerProcess) => ensureCompatibleGpuRuntime({
        ...options,
        registerProcess,
      }));
    });

    ipcMain.handle('uninstall-gpu', async (event) => {
      assertTrustedRendererSender(event);
      if (!isSupportedCudaPlatform()) {
        const error = new Error(getUnsupportedPlatformCudaProbeError(process.platform));
        error.code = 'unsupportedPlatform';
        throw error;
      }
      return runGpuRuntimeAction((registerProcess) => new Promise((resolve, reject) => {
        if (process.platform === 'linux') {
          const activePath = getLinuxCudaRuntimeTarget();
          if (!fs.existsSync(activePath)) {
            invalidateCachedCudaStatus();
            resolve({ success: true });
            return;
          }
          const tombstonePath = getLinuxCudaTombstonePath(activePath);
          try {
            fs.renameSync(activePath, tombstonePath);
          } catch (error) {
            invalidateCachedCudaStatus();
            reject(error);
            return;
          }
          console.log('Linux CUDA uninstall tombstoned:', JSON.stringify({
            activePath,
            tombstonePath,
          }));
          invalidateCachedCudaStatus();
          fs.promises.rm(tombstonePath, { recursive: true, force: true })
            .then(() => resolve({ success: true, tombstonePath }))
            .catch((error) => {
              // Active path is already renamed away. Report the tombstone cleanup
              // failure without targeting the live runtime again.
              reject(error);
            });
          return;
        }
        const python = registerProcess(spawnTrackedPython(buildTranscriptionCudaUninstallArgs()));

        let errorOutput = '';

        python.stderr.on('data', (data) => {
          errorOutput = appendSpawnLogBuffer(errorOutput, data);
        });

        python.on('close', (code) => {
          // Always drop the cache: a successful uninstall leaves a stale
          // "loadable" status, and a failed uninstall may have partially removed packages.
          invalidateCachedCudaStatus();
          if (code === 0) {
            resolve({ success: true });
          } else {
            const errorMsg = errorOutput.trim() || 'Unknown error';
            reject(new Error(`Failed to uninstall GPU packages: ${errorMsg}`));
          }
        });

        python.on('error', (error) => {
          invalidateCachedCudaStatus();
          reject(error);
        });
      }));
    });
  }

  return {
    updateCachedCudaStatus,
    invalidateCachedCudaStatus,
    getCachedCudaStatus,
    resolveCudaStatusForTranscription,
    buildCudaRuntimeEnv,
    getDefaultTranscriptionCudaPackages,
    runGpuRuntimeAction,
    hasInFlightGpuRuntimeAction,
    waitForGpuRuntimeIdle,
    markGpuRepairRecommendedAfterQuitKill,
    consumeGpuRepairRecommendedMarker,
    checkNvidiaGpuAvailability,
    enrichCheckCudaStatus,
    getCachedActivePythonVersion,
    runGpuPackageInstall,
    checkCudaRuntimeStatus,
    ensureCompatibleGpuRuntime,
    registerIpc,
  };
}

/**
 * Convenience wiring helper: build the GPU runtime service and register IPC.
 * Returns the service so transcription handlers (still in main.js) can call
 * getCachedCudaStatus / buildCudaRuntimeEnv.
 */
function registerGpuRuntimeService(ipcMain, deps) {
  const service = createGpuRuntimeService(deps);
  service.registerIpc(ipcMain);
  return service;
}

module.exports = { createGpuRuntimeService, registerGpuRuntimeService };
