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
  runWallClockComputeAction,
} = require('../main-process-helpers');

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
 */
function createGpuRuntimeService(deps) {
  const {
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
  } = deps;

  // Single shared CUDA status cache + GPU runtime lock. Never copy these lets
  // into a local that can go stale — mutate the closed-over bindings only.
  let cachedCudaStatus = null;
  let gpuRuntimeActionPromise = null;

  function updateCachedCudaStatus(status) {
    if (!status || typeof status !== 'object') {
      return;
    }
    cachedCudaStatus = {
      ...status,
      checkedAt: Date.now(),
    };
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

  function buildCudaRuntimeEnv(extra = {}, { includeManagedDiarization = false } = {}) {
    if (process.platform !== 'win32') {
      return extra;
    }

    const candidateSitePackagesDirs = [
      ...getPythonSitePackagesCandidates({
        pythonExe: pythonConfig.pythonExe,
        virtualEnv: process.env.VIRTUAL_ENV,
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

  function runGpuRuntimeAction(actionFn) {
    if (gpuRuntimeActionPromise) {
      const error = new Error('A GPU runtime action is already in progress. Please wait for it to finish.');
      error.code = 'GPU_RUNTIME_ACTION_BUSY';
      return Promise.reject(error);
    }

    gpuRuntimeActionPromise = runWallClockComputeAction({
      action: (registerProcess) => actionFn(registerProcess),
      timeoutMs: GPU_RUNTIME_ACTION_TIMEOUT_MS,
      label: 'GPU runtime setup',
      terminateProcess: terminateProcessBestEffort,
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

  function checkNvidiaGpuAvailability({ registerProcess = (proc) => proc } = {}) {
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
    try {
      const pythonVersion = await getActivePythonVersion();
      return {
        ...parsedStatus,
        version: null,
        packages: getDefaultTranscriptionCudaPackages(),
        pythonVersion: pythonVersion.parsed ? pythonVersion.parsed.version : pythonVersion.output,
        pythonSupportedForInstall: isSupportedCudaInstallPythonVersion(pythonVersion.parsed),
        pythonExecutable: pythonConfig.pythonExe,
      };
    } catch (error) {
      return {
        ...parsedStatus,
        version: null,
        packages: getDefaultTranscriptionCudaPackages(),
        pythonVersion: null,
        pythonSupportedForInstall: false,
        pythonExecutable: pythonConfig.pythonExe,
      };
    }
  }

  function runGpuPackageInstall({ mode = 'install', registerProcess = (proc) => proc } = {}) {
    const normalizedMode = String(mode || 'install').trim().toLowerCase() === 'repair' ? 'repair' : 'install';
    const isRepairMode = normalizedMode === 'repair';

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
        reject(new Error(`Failed to install CUDA libraries: ${errorOutput}`));
      });

      python.on('error', (error) => {
        flushRedactedProgress('gpu-install-progress', progressRedactor);
        reject(error);
      });
    });
  }

  function checkCudaRuntimeStatus({ registerProcess = (proc) => proc } = {}) {
    return new Promise((resolve) => {
      if (process.platform !== 'win32') {
        resolve({
          installed: false,
          deviceAvailable: false,
          runtimeLoadable: false,
          missingLibraries: [],
          runtime: 'ctranslate2',
          statusCode: 'unsupportedPlatform',
          supportedProfiles: getSupportedTranscriptionCudaProfileIds(),
          unsupportedDetectedProfiles: [],
          recommendedInstallProfile: getSupportedTranscriptionCudaProfileIds()[0] || 'cuda12',
          error: 'CUDA runtime checks are only supported on Windows.',
        });
        return;
      }

      const knownProfiles = getCudaRuntimeProfiles();
      const supportedProfileIds = getSupportedTranscriptionCudaProfileIds();
      const supportedProfiles = knownProfiles.filter((profile) => supportedProfileIds.includes(profile.id));
      const unsupportedProfiles = knownProfiles.filter((profile) => !supportedProfileIds.includes(profile.id));
      const probeProfiles = supportedProfiles.map((profile) => ({
        id: profile.id,
        requiredDlls: profile.requiredDlls,
      }));
      const unsupportedDllHints = unsupportedProfiles.map((profile) => ({
        id: profile.id,
        expectedDllPrefixes: Array.isArray(profile.expectedDllPrefixes) ? profile.expectedDllPrefixes : [],
      }));

      const python = registerProcess(spawnTrackedPython(getBackendModuleArgs('transcription.cuda_probe', [
        '--profiles-json', JSON.stringify(probeProfiles),
        '--supported-profiles', supportedProfileIds.join(','),
        '--unsupported-hints-json', JSON.stringify(unsupportedDllHints),
      ]), { env: buildCudaRuntimeEnv() }));

      let output = '';
      python.stdout.on('data', (data) => {
        output = appendSpawnLogBuffer(output, data);
      });
      python.on('close', () => {
        const status = parseCheckCudaStatus(output);
        updateCachedCudaStatus(status);
        resolve(status);
      });
      python.on('error', (error) => {
        const status = {
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
        };
        updateCachedCudaStatus(status);
        resolve(status);
      });
    });
  }

  async function ensureCompatibleGpuRuntime(options = {}) {
    const skipInstallIfReady = options.skipInstallIfReady !== false;
    const forceRepair = Boolean(options.forceRepair);
    const registerProcess = typeof options.registerProcess === 'function'
      ? options.registerProcess
      : (proc) => proc;

    if (process.platform !== 'win32') {
      const finalStatus = await enrichCheckCudaStatus({
        installed: false,
        deviceAvailable: false,
        runtimeLoadable: false,
        missingLibraries: [],
        runtime: 'ctranslate2',
        statusCode: 'unsupportedPlatform',
        supportedProfiles: getSupportedTranscriptionCudaProfileIds(),
        unsupportedDetectedProfiles: [],
        recommendedInstallProfile: getSupportedTranscriptionCudaProfileIds()[0] || 'cuda12',
        error: 'CUDA runtime checks are only supported on Windows.',
      });
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
        if (process.platform !== 'win32') {
          return enrichCheckCudaStatus({
            installed: false,
            deviceAvailable: false,
            runtimeLoadable: false,
            missingLibraries: [],
            runtime: 'ctranslate2',
            statusCode: 'unsupportedPlatform',
            supportedProfiles: getSupportedTranscriptionCudaProfileIds(),
            unsupportedDetectedProfiles: [],
            recommendedInstallProfile: getSupportedTranscriptionCudaProfileIds()[0] || 'cuda12',
            error: 'CUDA runtime checks are only supported on Windows.',
          });
        }
        return enrichCheckCudaStatus(await checkCudaRuntimeStatus());
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
      return runGpuRuntimeAction((registerProcess) => ensureCompatibleGpuRuntime({
        ...options,
        registerProcess,
      }));
    });

    ipcMain.handle('uninstall-gpu', async (event) => {
      assertTrustedRendererSender(event);
      return runGpuRuntimeAction((registerProcess) => new Promise((resolve, reject) => {
        const python = registerProcess(spawnTrackedPython(buildTranscriptionCudaUninstallArgs()));

        let errorOutput = '';

        python.stderr.on('data', (data) => {
          errorOutput = appendSpawnLogBuffer(errorOutput, data);
        });

        python.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            const errorMsg = errorOutput.trim() || 'Unknown error';
            reject(new Error(`Failed to uninstall GPU packages: ${errorMsg}`));
          }
        });

        python.on('error', (error) => {
          reject(error);
        });
      }));
    });
  }

  return {
    updateCachedCudaStatus,
    getCachedCudaStatus,
    buildCudaRuntimeEnv,
    getDefaultTranscriptionCudaPackages,
    runGpuRuntimeAction,
    hasInFlightGpuRuntimeAction,
    waitForGpuRuntimeIdle,
    checkNvidiaGpuAvailability,
    enrichCheckCudaStatus,
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
