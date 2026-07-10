'use strict';

/**
 * Transcription, model download, diarization, and retry IPC service for the
 * AvaNevis main process.
 *
 * Owns Whisper model download/preload, transcription, speaker-guided
 * transcription, diarization, and retry-transcription IPC channels plus
 * related spawn helpers. Handler/helper bodies are moved verbatim; cross-module
 * dependencies are injected via `deps`.
 */

const {
  buildModelDownloadCheck,
  buildDiarizationOutputPath,
  buildGuidedTranscriptTempPath,
  buildTranscriptionCliArgs,
  buildTranscriberArgs,
  buildTranscriptionRuntimeEnv,
  cacheContainsCompleteTranscriptionModel,
  isSafeRecordingsJsonPath,
  isSafeRecordingsMarkdownPath,
  resolveTranscriptionAudioFile,
  parseAiBackendProgressLine,
  createLineChunkRedactor,
  isModelDownloadErrorOutput,
  isRetryableCudaTranscriptionError,
  shouldForceCpuTranscriptionFromCudaStatus,
  redactSensitiveText,
  AI_COMPUTE_TIMEOUT_MS,
  getTranscriptionComputeTimeoutMs,
  getGuidedTranscriptionComputeTimeoutMs,
  runWallClockComputeAction,
  runGuidedTranscriptionProcess,
  buildClearedHuggingFaceTokenEnv,
} = require('../main-process-helpers');
const { checkAiAddonSetupStatus } = require('../ai-addon-setup');
const {
  getDiarizationAvailability,
  getDiarizationModelRef,
} = require('../ai-addon-state');

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {typeof import('os')} deps.os
 * @param {object} deps.pythonConfig
 * @param {Function} deps.spawnTrackedPython
 * @param {Function} deps.getBackendModuleArgs
 * @param {Function} deps.enqueueAiComputeAction
 * @param {Function} deps.resolveCudaStatusForTranscription
 * @param {Function} deps.buildCudaRuntimeEnv
 * @param {Function} deps.getAiAddonRuntimeOptions
 * @param {Function} deps.getDiarizationDependencyEnv
 * @param {Function} deps.getDiarizationCacheEnv
 * @param {Function} deps.getDiarizationDependencySitePackagesPath
 * @param {Function} deps.requireAllowedModelSize
 * @param {Function} deps.collectPythonProcessOutput
 * @param {Function} deps.sendToRenderer
 * @param {Function} deps.sendRedactedProgress
 * @param {Function} deps.flushRedactedProgress
 * @param {Function} deps.appendSpawnLogBuffer
 * @param {Function} deps.appendSpawnJsonStdout
 * @param {Function} deps.assertTrustedRendererSender
 * @param {Function} deps.getRecordingsDir
 * @param {Function} deps.assertSafeExistingRecordingAudioPath
 * @param {Function} deps.assertSafeExistingSegmentsPath
 * @param {Function} deps.assertSafeExistingTranscriptPath
 * @param {Function} deps.terminateProcessBestEffort
 * @param {Function} deps.summarizeDiarizationError
 * @param {Function} deps.sanitizeTranscriptionError
 * @param {Function} deps.buildTranscriptionPlaceholderMarkdown
 * @param {Function} deps.formatDurationForTranscript
 * @param {Function} [deps.enqueueGpuResourceAction]
 */
function createTranscriptionService(deps) {
  const {
    app,
    path,
    fs,
    os,
    pythonConfig,
    spawnTrackedPython,
    getBackendModuleArgs,
    enqueueAiComputeAction,
    waitForAiComputeQueueIdle = async () => {},
    hasInFlightGpuRuntimeAction = () => false,
    waitForGpuRuntimeIdle = async () => {},
    enqueueGpuResourceAction = (action) => action(),
    getCachedCudaStatus,
    resolveCudaStatusForTranscription = null,
    buildCudaRuntimeEnv,
    getAiAddonRuntimeOptions,
    getDiarizationDependencyEnv,
    getDiarizationCacheEnv,
    getDiarizationDependencySitePackagesPath,
    requireAllowedModelSize,
    collectPythonProcessOutput,
    sendToRenderer,
    sendRedactedProgress,
    flushRedactedProgress,
    appendSpawnLogBuffer,
    appendSpawnJsonStdout,
    assertTrustedRendererSender,
    getRecordingsDir,
    assertSafeExistingRecordingAudioPath,
    assertSafeExistingSegmentsPath,
    assertSafeExistingTranscriptPath,
    terminateProcessBestEffort,
    summarizeDiarizationError,
    sanitizeTranscriptionError,
    buildTranscriptionPlaceholderMarkdown,
    formatDurationForTranscript,
  } = deps;

  function getTranscriptionModelDownloadCheck(modelSize) {
    return buildModelDownloadCheck({
      platform: process.platform,
      arch: process.arch,
      homeDir: os.homedir(),
      modelSize,
    });
  }

  function isTranscriptionModelCached(modelSize, downloadCheck = getTranscriptionModelDownloadCheck(modelSize)) {
    const { cacheDir, modelPatterns } = downloadCheck;
    try {
      return cacheContainsCompleteTranscriptionModel({
        cacheDir,
        modelPatterns,
        platform: process.platform,
        arch: process.arch,
      });
    } catch (error) {
      return false;
    }
  }

  function getTranscriptionRuntimeEnv(modelSize, cudaOptions = {}) {
    const downloadCheck = getTranscriptionModelDownloadCheck(modelSize);
    return buildTranscriptionRuntimeEnv({
      cacheDir: downloadCheck.cacheDir,
      modelCached: isTranscriptionModelCached(modelSize, downloadCheck),
      baseEnv: buildCudaRuntimeEnv({}, cudaOptions),
    });
  }

  function getTranscriberArgs(extraArgs = []) {
    return buildTranscriberArgs({
      platform: process.platform,
      arch: process.arch,
      extraArgs,
    });
  }

  function buildManagedModuleShim() {
    return 'import runpy, sys; sys.path.insert(0, sys.argv[1]); sys.argv = [sys.argv[2]] + sys.argv[3:]; runpy.run_module(sys.argv[0], run_name="__main__", alter_sys=False)';
  }

  function buildManagedPythonModuleArgs(moduleName, extraArgs = [], managedSitePackagesPath = null) {
    if (!managedSitePackagesPath) {
      return getBackendModuleArgs(moduleName, extraArgs);
    }

    return [
      '-c',
      buildManagedModuleShim(),
      managedSitePackagesPath,
      moduleName,
      ...extraArgs,
    ];
  }

  function buildManagedDiarizationArgs({ audioPath, segmentsJsonPath, outputPath, modelRef, speakerCount, requiredDevice }) {
    const args = [
      '--audio', audioPath,
      '--segments-json', segmentsJsonPath,
      '--output-json', outputPath,
      '--model-ref', modelRef || 'pyannote/speaker-diarization-community-1',
      '--speaker-count', speakerCount === undefined || speakerCount === null ? 'auto' : String(speakerCount),
      '--ffmpeg', pythonConfig.ffmpegPath,
    ];

    if (requiredDevice) {
      args.push('--require-device', requiredDevice);
    }

    return buildManagedPythonModuleArgs('diarization.diarization_pipeline', args, getDiarizationDependencySitePackagesPath());
  }

  function getTranscriberBackendName() {
    // Keep aligned with backend/diarization/guided_transcription.py resolve_transcriber_backend.
    if (process.platform === 'darwin' && process.arch === 'arm64') {
      return 'mlx';
    }
    return 'faster';
  }

  function buildManagedDiarizationGuidedTranscriptionArgs({ audioPath, outputTranscript, outputJson, language, modelSize, modelRef, speakerCount, requiredDevice }) {
    const args = [
      '--audio', audioPath,
      '--output-transcript', outputTranscript,
      '--language', language || 'en',
      '--model', modelSize || 'small',
      '--transcriber-backend', getTranscriberBackendName(),
      '--model-ref', modelRef || 'pyannote/speaker-diarization-community-1',
      '--speaker-count', speakerCount === undefined || speakerCount === null ? 'auto' : String(speakerCount),
      '--ffmpeg', pythonConfig.ffmpegPath,
    ];

    if (outputJson) {
      args.push('--output-json', outputJson);
    }

    if (requiredDevice) {
      args.push('--require-device', requiredDevice);
    }

    return buildManagedPythonModuleArgs('diarization.guided_transcription', args, getDiarizationDependencySitePackagesPath());
  }

  function runTranscriptionProcess({
    audioFile,
    language,
    modelSize,
    device = 'auto',
    registerProcess,
  } = {}) {
    return new Promise((resolve, reject) => {
      const python = spawnTrackedPython(buildTranscriptionCliArgs({
        platform: process.platform,
        arch: process.arch,
        audioFile,
        language: language || 'en',
        modelSize,
        device,
      }), { cwd: pythonConfig.backendPath, env: getTranscriptionRuntimeEnv(modelSize) });

      if (typeof registerProcess === 'function') {
        registerProcess(python);
      }

      let output = '';
      let errorOutput = '';
      let hasCompleted = false;
      const stdoutOverflow = { overflowed: false };
      const progressRedactor = createLineChunkRedactor();

      python.stdout.on('data', (data) => {
        output = appendSpawnJsonStdout(output, data, stdoutOverflow);
      });

      python.stderr.on('data', (data) => {
        const stderrChunk = data.toString();
        errorOutput = appendSpawnLogBuffer(errorOutput, stderrChunk);
        sendRedactedProgress('transcription-progress', stderrChunk, progressRedactor);
      });

      python.on('close', (code) => {
        if (hasCompleted) return;
        hasCompleted = true;
        flushRedactedProgress('transcription-progress', progressRedactor);

        if (stdoutOverflow.overflowed) {
          reject(new Error('Transcription output exceeded the maximum allowed size.'));
          return;
        }

        if (output.trim()) {
          try {
            const result = JSON.parse(output);
            if (result.text !== undefined || result.segments !== undefined) {
              const actualDevice = typeof result.device === 'string' && result.device.trim()
                ? result.device.trim().toLowerCase()
                : device;
              if (actualDevice !== device) {
                sendToRenderer(
                  'transcription-progress',
                  `Transcription ran on ${actualDevice.toUpperCase()} (requested ${device}).\n`,
                );
              } else if (actualDevice === 'cpu' && device === 'auto') {
                sendToRenderer(
                  'transcription-progress',
                  'Transcription completed on CPU.\n',
                );
              }
              resolve({
                ...result,
                transcriptionDevice: actualDevice,
                requestedDevice: device,
              });
              return;
            }
          } catch (error) {
            // Continue to stderr/error classification.
          }
        }

        if (code === 0) {
          reject(new Error('Transcription produced no valid output'));
          return;
        }

        reject(new Error(`Transcription failed: ${errorOutput || 'Unknown error'}`));
      });

      python.on('error', (error) => {
        if (hasCompleted) {
          return;
        }
        hasCompleted = true;
        reject(error);
      });
    });
  }

  async function cleanupGuidedTranscriptTempFiles() {
    const recordingsDir = getRecordingsDir();
    try {
      const entries = await fs.promises.readdir(recordingsDir, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.isFile() && /^\..+\.guided\.\d+\.tmp\.md$/i.test(entry.name))
        .map((entry) => fs.promises.rm(path.join(recordingsDir, entry.name), { force: true })));
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.warn('Could not clean up stale speaker-guided transcript temp files:', error.message);
      }
    }
  }

  async function shouldPreemptiveCpuAtJobStart(registerProcess) {
    if (process.platform !== 'win32') {
      return false;
    }
    let status = null;
    if (typeof resolveCudaStatusForTranscription === 'function') {
      status = await resolveCudaStatusForTranscription({ registerProcess });
    } else if (typeof getCachedCudaStatus === 'function') {
      status = getCachedCudaStatus();
    }
    return shouldForceCpuTranscriptionFromCudaStatus(status);
  }

  // Single in-flight Whisper download (FTUE / Settings). Cancel clears this ref.
  let activeModelDownload = null;

  async function waitForGpuRuntimeBeforeCompute(label = 'Transcription') {
    if (!hasInFlightGpuRuntimeAction()) {
      return;
    }
    sendToRenderer(
      'transcription-progress',
      `Waiting for GPU runtime setup to finish before starting ${label.toLowerCase()}...\n`,
    );
    await waitForGpuRuntimeIdle();
  }

  function registerIpc(ipcMain) {
    /**
     * Check if Whisper model is downloaded
     */
    ipcMain.handle('check-model-downloaded', async (event, modelSize) => {
      const size = requireAllowedModelSize(modelSize);
      return new Promise((resolve) => {
        const { cacheDir, modelPatterns } = buildModelDownloadCheck({
          platform: process.platform,
          arch: process.arch,
          homeDir: os.homedir(),
          modelSize: size,
        });

        try {
          const modelExists = cacheContainsCompleteTranscriptionModel({
            cacheDir,
            modelPatterns,
            platform: process.platform,
            arch: process.arch,
          });
          resolve({ downloaded: modelExists, modelSize: size });
        } catch (e) {
          // If we can't check, assume not downloaded
          resolve({ downloaded: false, modelSize: size });
        }
      });
    });

    /**
     * Download Whisper model (preload)
     */
    ipcMain.handle('download-model', async (event, modelSize) => {
      assertTrustedRendererSender(event);
      const model = requireAllowedModelSize(modelSize);
      if (activeModelDownload) {
        throw new Error('A Whisper model download is already in progress. Cancel it or wait for it to finish.');
      }
      // Stay off the compute queue (downloads must not block transcription),
      // but wait for idle GPU compute first to avoid VRAM contention/OOM.
      // Bound the wait so a long transcription queue cannot hang the UI forever.
      const idleController = new AbortController();
      activeModelDownload = { process: null, controller: idleController, model };
      try {
        await waitForAiComputeQueueIdle({
          cancelSignal: idleController.signal,
          cancelMessage: 'Model download was canceled while waiting for local AI work to finish.',
          timeoutMs: AI_COMPUTE_TIMEOUT_MS.modelDownloadIdleWait,
          timeoutMessage: 'Timed out waiting for local AI work to finish before downloading the Whisper model. Try again when transcription is idle.',
          onWaiting: () => {
            sendToRenderer(
              'model-download-progress',
              'Waiting for local AI work to finish before downloading the Whisper model...\n',
            );
          },
        });
      } catch (error) {
        if (activeModelDownload && activeModelDownload.controller === idleController) {
          activeModelDownload = null;
        }
        throw error;
      }

      if (idleController.signal.aborted) {
        if (activeModelDownload && activeModelDownload.controller === idleController) {
          activeModelDownload = null;
        }
        throw new Error('Model download was canceled.');
      }

      return enqueueGpuResourceAction(() => {
        if (idleController.signal.aborted) {
          throw new Error('Model download was canceled.');
        }
        return runWallClockComputeAction({
        timeoutMs: AI_COMPUTE_TIMEOUT_MS.modelDownload,
        label: 'Whisper model download',
        terminateProcess: terminateProcessBestEffort,
        action: (registerProcess) => new Promise((resolve, reject) => {
        console.log(`Downloading Whisper model: ${model}`);

        const downloadCheck = getTranscriptionModelDownloadCheck(model);
        let settled = false;
        const finish = (callback, value) => {
          if (settled) {
            return;
          }
          settled = true;
          if (activeModelDownload && activeModelDownload.controller === idleController) {
            activeModelDownload = null;
          }
          callback(value);
        };

        let python;
        try {
          python = spawnTrackedPython(getTranscriberArgs([
            '--preload',
            '--model', model
          ]), {
            cwd: pythonConfig.backendPath,
            env: buildTranscriptionRuntimeEnv({
              cacheDir: downloadCheck.cacheDir,
              modelCached: false,
              baseEnv: buildCudaRuntimeEnv(),
            }),
          });
        } catch (error) {
          finish(reject, error);
          return;
        }

        if (activeModelDownload && activeModelDownload.controller === idleController) {
          activeModelDownload.process = python;
        }
        registerProcess(python);

        let hasError = false;
        const progressRedactor = createLineChunkRedactor();

        const handleAbort = () => {
          terminateProcessBestEffort(python);
        };
        idleController.signal.addEventListener('abort', handleAbort, { once: true });

        python.stderr.on('data', (data) => {
          const output = data.toString();
          console.log(`[Model Download] ${output}`);

          sendRedactedProgress('model-download-progress', output, progressRedactor);

          // Check for errors
          if (isModelDownloadErrorOutput(output)) {
            hasError = true;
          }
        });

        python.on('close', (code) => {
          idleController.signal.removeEventListener('abort', handleAbort);
          flushRedactedProgress('model-download-progress', progressRedactor);
          if (idleController.signal.aborted) {
            finish(reject, new Error('Model download was canceled.'));
            return;
          }
          if (code === 0) {
            console.log('Model downloaded successfully');
            finish(resolve, { success: true });
            return;
          }
          // Non-zero exit (taskkill/quit/partial): only report success if the cache is complete.
          if (!hasError && isTranscriptionModelCached(model, downloadCheck)) {
            console.log('Model download completed with warnings; cache is complete');
            finish(resolve, { success: true });
            return;
          }
          finish(reject, new Error(
            hasError
              ? 'Failed to download model'
              : `Model download exited with code ${code} before the cache was complete.`,
          ));
        });

        python.on('error', (error) => {
          idleController.signal.removeEventListener('abort', handleAbort);
          flushRedactedProgress('model-download-progress', progressRedactor);
          finish(reject, idleController.signal.aborted
            ? new Error('Model download was canceled.')
            : error);
        });
        }),
        });
      }).finally(() => {
        if (activeModelDownload && activeModelDownload.controller === idleController) {
          activeModelDownload = null;
        }
      });
    });

    ipcMain.handle('cancel-download-model', async (event) => {
      assertTrustedRendererSender(event);
      if (!activeModelDownload) {
        return { canceled: false, message: 'No Whisper model download is currently running.' };
      }
      activeModelDownload.controller.abort();
      terminateProcessBestEffort(activeModelDownload.process);
      return { canceled: true };
    });

    /**
     * Transcribe audio file
     */
    ipcMain.handle('transcribe-audio', async (event, options) => {
      assertTrustedRendererSender(event);

      let { audioFile, language, modelSize } = options;

      modelSize = requireAllowedModelSize(modelSize);

      const recordingsDir = getRecordingsDir();
      audioFile = resolveTranscriptionAudioFile({
        audioFile,
        recordingsDir,
        existsSync: fs.existsSync,
      });
      audioFile = assertSafeExistingRecordingAudioPath(audioFile);

      // GPU wait stays inside the enqueue (serialized) but outside the wall clock
      // so a long pip install cannot burn a tiny/base transcription budget.
      return enqueueAiComputeAction(async () => {
        await waitForGpuRuntimeBeforeCompute('Transcription');
        return runWallClockComputeAction({
          timeoutMs: getTranscriptionComputeTimeoutMs(modelSize),
          label: 'Transcription',
          terminateProcess: terminateProcessBestEffort,
          action: async (registerProcess) => {
            // Decide CPU preemption when the job starts, not at enqueue (CUDA may have been repaired).
            // Re-probe when the UI cache is stale so broken-CUDA boxes get the CPU UX message.
            const shouldPreemptiveCpuRetry = await shouldPreemptiveCpuAtJobStart(registerProcess);
            if (shouldPreemptiveCpuRetry) {
              sendToRenderer(
                'transcription-progress',
                'CUDA runtime is not loadable on this system. Starting transcription on CPU.\n',
              );
            }
            try {
              return await runTranscriptionProcess({
                audioFile,
                language,
                modelSize,
                device: shouldPreemptiveCpuRetry ? 'cpu' : 'auto',
                registerProcess,
              });
            } catch (error) {
              if (!isRetryableCudaTranscriptionError(error && error.message)) {
                throw error;
              }
              sendToRenderer(
                'transcription-progress',
                'GPU transcription failed because CUDA runtime libraries could not be loaded. Retrying on CPU; this may take significantly longer.\n',
              );
              return runTranscriptionProcess({
                audioFile,
                language,
                modelSize,
                device: 'cpu',
                registerProcess,
              });
            }
          },
        });
      });
    });

    ipcMain.handle('transcribe-audio-with-speakers', async (event, options = {}) => {
      assertTrustedRendererSender(event);

      let { audioFile, language, modelSize, speakerCount } = options;
      modelSize = requireAllowedModelSize(modelSize);

      if (!audioFile) {
        throw new Error('transcribe-audio-with-speakers requires an audioFile');
      }

      audioFile = resolveTranscriptionAudioFile({
        audioFile,
        recordingsDir: getRecordingsDir(),
        existsSync: fs.existsSync,
      });

      const resolvedAudioPath = assertSafeExistingRecordingAudioPath(audioFile);
      const availability = getDiarizationAvailability(process.platform, process.arch);
      if (!availability.supported) {
        throw new Error(availability.reason || 'Speaker identification is not supported on this platform.');
      }
      const requiredDevice = availability.runtimeDevice;
      if (!requiredDevice) {
        throw new Error('Speaker identification accelerator policy is not configured for this platform.');
      }

      const aiStatus = await checkAiAddonSetupStatus(getAiAddonRuntimeOptions());
      const diarizationStatus = aiStatus && aiStatus.features && aiStatus.features.diarization;
      if (!diarizationStatus || diarizationStatus.status !== 'ready' || !diarizationStatus.setupComplete) {
        throw new Error('Speaker identification setup is not ready.');
      }
      const catalogModelRef = getDiarizationModelRef(diarizationStatus.modelId);
      if (!catalogModelRef) {
        throw new Error('Speaker identification model is not configured.');
      }

      const recordingsDir = getRecordingsDir();
      const finalTranscriptPath = resolvedAudioPath.replace(/\.[^/.]+$/, '.md');
      if (!isSafeRecordingsMarkdownPath({ filePath: finalTranscriptPath, recordingsDir })) {
        throw new Error('Speaker-guided transcript must be a Markdown file in the recordings directory.');
      }
      // The temporary file keeps a .md suffix so the existing Markdown path guard can
      // validate it; startup cleanup removes orphaned hidden guided temp files.
      const tempTranscriptPath = buildGuidedTranscriptTempPath({ finalTranscriptPath });
      if (!isSafeRecordingsMarkdownPath({ filePath: tempTranscriptPath, recordingsDir })) {
        throw new Error('Temporary speaker-guided transcript path is invalid.');
      }

      return enqueueAiComputeAction(async () => {
        await waitForGpuRuntimeBeforeCompute('Speaker-guided transcription');
        return runWallClockComputeAction({
          timeoutMs: getGuidedTranscriptionComputeTimeoutMs(modelSize),
          label: 'Speaker-guided transcription',
          terminateProcess: terminateProcessBestEffort,
          action: (registerProcess) => runGuidedTranscriptionProcess({
            spawnProcess: spawnTrackedPython,
            args: buildManagedDiarizationGuidedTranscriptionArgs({
              audioPath: resolvedAudioPath,
              outputTranscript: tempTranscriptPath,
              language,
              modelSize,
              modelRef: catalogModelRef,
              speakerCount: speakerCount || diarizationStatus.speakerCount || 'auto',
              requiredDevice,
            }),
            cwd: pythonConfig.backendPath,
            env: {
              ...getDiarizationDependencyEnv(),
              ...getDiarizationCacheEnv(),
              ...getTranscriptionRuntimeEnv(modelSize, { includeManagedDiarization: true }),
              ...buildClearedHuggingFaceTokenEnv(),
            },
            finalTranscriptPath,
            tempTranscriptPath,
            modelSize,
            fsPromises: fs.promises,
            registerProcess,
            terminateProcess: terminateProcessBestEffort,
            summarizeError: summarizeDiarizationError,
            onProgressLine: (line) => {
              const progressEvent = parseAiBackendProgressLine(line, 'diarization');
              if (progressEvent) {
                sendToRenderer('diarization-progress', progressEvent);
              } else if (line.trim()) {
                sendToRenderer('transcription-progress', `${redactSensitiveText(line)}\n`);
              }
            },
          }),
        });
      });
    });

    ipcMain.handle('diarize-transcript', async (event, options = {}) => {
      assertTrustedRendererSender(event);

      const { audioPath, segments, segmentsJsonPath, speakerCount } = options;

      if (!audioPath) {
        throw new Error('diarize-transcript requires an audioPath');
      }

      const availability = getDiarizationAvailability(process.platform, process.arch);
      if (!availability.supported) {
        throw new Error(availability.reason || 'Speaker identification is not supported on this platform.');
      }
      const requiredDevice = availability.runtimeDevice;
      if (!requiredDevice) {
        throw new Error('Speaker identification accelerator policy is not configured for this platform.');
      }

      const aiStatus = await checkAiAddonSetupStatus(getAiAddonRuntimeOptions());
      const diarizationStatus = aiStatus && aiStatus.features && aiStatus.features.diarization;
      if (!diarizationStatus || diarizationStatus.status !== 'ready' || !diarizationStatus.setupComplete) {
        throw new Error('Speaker identification setup is not ready.');
      }
      const catalogModelRef = getDiarizationModelRef(diarizationStatus.modelId);
      if (!catalogModelRef) {
        throw new Error('Speaker identification model is not configured.');
      }

      const resolvedAudioPath = assertSafeExistingRecordingAudioPath(audioPath);

      let tempSegmentsPath = null;
      let resolvedSegmentsJsonPath = segmentsJsonPath;
      if (!resolvedSegmentsJsonPath) {
        if (!Array.isArray(segments)) {
          throw new Error('diarize-transcript requires transcript segments');
        }
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'avanevis-diarization-segments-'));
        tempSegmentsPath = path.join(tempDir, 'segments.json');
        await fs.promises.writeFile(tempSegmentsPath, JSON.stringify({ segments }, null, 2), 'utf8');
        resolvedSegmentsJsonPath = tempSegmentsPath;
      } else {
        resolvedSegmentsJsonPath = assertSafeExistingSegmentsPath(resolvedSegmentsJsonPath);
      }

      const resolvedOutputPath = buildDiarizationOutputPath({ audioPath: resolvedAudioPath });
      if (!isSafeRecordingsJsonPath({ filePath: resolvedOutputPath, recordingsDir: getRecordingsDir() })) {
        throw new Error('Speaker labels output must be a JSON file in the recordings directory.');
      }
      return enqueueAiComputeAction(async () => {
        await waitForGpuRuntimeBeforeCompute('Speaker identification');
        return runWallClockComputeAction({
          timeoutMs: AI_COMPUTE_TIMEOUT_MS.diarization,
          label: 'Speaker identification',
          terminateProcess: terminateProcessBestEffort,
          action: (registerProcess) => new Promise((resolve, reject) => {
            const python = spawnTrackedPython(buildManagedDiarizationArgs({
              audioPath: resolvedAudioPath,
              segmentsJsonPath: resolvedSegmentsJsonPath,
              outputPath: resolvedOutputPath,
              modelRef: catalogModelRef,
              speakerCount,
              requiredDevice,
            }), {
              cwd: pythonConfig.backendPath,
              env: {
                ...getDiarizationDependencyEnv(),
                ...getDiarizationCacheEnv(),
                ...buildCudaRuntimeEnv({}, { includeManagedDiarization: true }),
                ...buildClearedHuggingFaceTokenEnv(),
              },
            });
            registerProcess(python);

            let output = '';
            let errorOutput = '';
            const stdoutOverflow = { overflowed: false };

            python.stdout.on('data', (data) => {
              output = appendSpawnJsonStdout(output, data, stdoutOverflow);
            });

            python.stderr.on('data', (data) => {
              const stderrChunk = data.toString();
              errorOutput = appendSpawnLogBuffer(errorOutput, stderrChunk);
              for (const line of stderrChunk.split(/\r?\n/)) {
                const progressEvent = parseAiBackendProgressLine(line, 'diarization');
                if (progressEvent) {
                  sendToRenderer('diarization-progress', progressEvent);
                }
              }
            });

            python.on('close', (code) => {
              if (tempSegmentsPath) {
                fs.promises.rm(path.dirname(tempSegmentsPath), { recursive: true, force: true }).catch(() => {});
              }

              if (stdoutOverflow.overflowed) {
                reject(new Error('Speaker diarization output exceeded the maximum allowed size.'));
                return;
              }

              if (code === 0) {
                try {
                  resolve(JSON.parse(output));
                } catch (error) {
                  reject(new Error(`Failed to parse diarization result: ${error.message}`));
                }
                return;
              }

              const reason = summarizeDiarizationError(errorOutput);
              reject(new Error(reason || 'Speaker diarization failed.'));
            });

            python.on('error', (error) => {
              if (tempSegmentsPath) {
                fs.promises.rm(path.dirname(tempSegmentsPath), { recursive: true, force: true }).catch(() => {});
              }
              reject(error);
            });
          }),
        });
      });
    });

    ipcMain.handle('retry-transcription', async (event, options = {}) => {
      assertTrustedRendererSender(event);

      const meetingId = String(options.meetingId || '').trim();
      if (!meetingId) {
        throw new Error('retry-transcription requires a meetingId');
      }

      const recordingsDir = getRecordingsDir();
      const meeting = await runWallClockComputeAction({
        timeoutMs: AI_COMPUTE_TIMEOUT_MS.meetingPreflight,
        label: 'Meeting lookup',
        terminateProcess: terminateProcessBestEffort,
        action: (registerProcess) => new Promise((resolve, reject) => {
          const python = registerProcess(spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
            '--recordings-dir', recordingsDir,
            'get',
            meetingId,
          ]), { cwd: pythonConfig.backendPath }));
          const processOutput = collectPythonProcessOutput(python, { jsonResult: true });

          python.on('close', (code) => {
            try {
              processOutput.assertStdoutWithinLimit();
            } catch (error) {
              reject(error);
              return;
            }
            if (code !== 0) {
              reject(new Error(processOutput.getStderr().trim() || 'Meeting not found.'));
              return;
            }
            try {
              resolve(JSON.parse(processOutput.getStdout()));
            } catch (error) {
              reject(new Error(`Failed to parse meeting details: ${error.message}`));
            }
          });
          python.on('error', reject);
        }),
      });

      if (!meeting || !meeting.audioPath || !meeting.transcriptPath) {
        throw new Error('Meeting is missing audio or transcript path.');
      }

      const normalizedModel = requireAllowedModelSize(options.modelSize || meeting.model || 'small');
      const normalizedLanguage = String(options.language || meeting.language || 'en');
      const audioFile = assertSafeExistingRecordingAudioPath(meeting.audioPath);
      const transcriptPath = assertSafeExistingTranscriptPath(meeting.transcriptPath);
      const preferredSpeakerCount = String(options.speakerCount || '').trim();
      let guidedDiarizationStatus = null;
      let guidedDiarizationResult = null;
      let guidedTranscriptionError = null;

      const diarizationAvailability = getDiarizationAvailability(process.platform, process.arch);
      if (diarizationAvailability.supported && diarizationAvailability.runtimeDevice) {
        try {
          const aiStatus = await checkAiAddonSetupStatus(getAiAddonRuntimeOptions());
          const diarizationStatus = aiStatus && aiStatus.features && aiStatus.features.diarization;
          const catalogModelRef = diarizationStatus ? getDiarizationModelRef(diarizationStatus.modelId) : null;
          if (diarizationStatus && diarizationStatus.status === 'ready' && diarizationStatus.setupComplete && catalogModelRef) {
            guidedDiarizationStatus = {
              modelId: diarizationStatus.modelId,
              speakerCount: diarizationStatus.speakerCount || 'auto',
              modelRef: catalogModelRef,
              requiredDevice: diarizationAvailability.runtimeDevice,
            };
          }
        } catch (error) {
          sendToRenderer(
            'transcription-progress',
            `Speaker identification status unavailable; continuing with normal retry transcription. ${error.message}\n`,
          );
        }
      }

      const result = await enqueueAiComputeAction(async () => {
        await waitForGpuRuntimeBeforeCompute('Transcription retry');
        return runWallClockComputeAction({
        timeoutMs: guidedDiarizationStatus
          ? getGuidedTranscriptionComputeTimeoutMs(normalizedModel)
          : getTranscriptionComputeTimeoutMs(normalizedModel),
        label: 'Transcription retry',
        terminateProcess: terminateProcessBestEffort,
        action: async (registerProcess) => {
          if (guidedDiarizationStatus) {
            try {
              const tempTranscriptPath = buildGuidedTranscriptTempPath({ finalTranscriptPath: transcriptPath });
              guidedDiarizationResult = await runGuidedTranscriptionProcess({
                spawnProcess: spawnTrackedPython,
                args: buildManagedDiarizationGuidedTranscriptionArgs({
                  audioPath: audioFile,
                  outputTranscript: tempTranscriptPath,
                  language: normalizedLanguage,
                  modelSize: normalizedModel,
                  modelRef: guidedDiarizationStatus.modelRef,
                  speakerCount: preferredSpeakerCount || guidedDiarizationStatus.speakerCount || 'auto',
                  requiredDevice: guidedDiarizationStatus.requiredDevice,
                }),
                cwd: pythonConfig.backendPath,
                env: {
                  ...getDiarizationDependencyEnv(),
                  ...getDiarizationCacheEnv(),
                  ...getTranscriptionRuntimeEnv(normalizedModel, { includeManagedDiarization: true }),
                  ...buildClearedHuggingFaceTokenEnv(),
                },
                finalTranscriptPath: transcriptPath,
                tempTranscriptPath,
                modelSize: normalizedModel,
                fsPromises: fs.promises,
                registerProcess,
                terminateProcess: terminateProcessBestEffort,
                summarizeError: summarizeDiarizationError,
                onProgressLine: (line) => {
                  const progressEvent = parseAiBackendProgressLine(line, 'diarization');
                  if (progressEvent) {
                    sendToRenderer('diarization-progress', progressEvent);
                  } else if (line.trim()) {
                    sendToRenderer('transcription-progress', `${redactSensitiveText(line)}\n`);
                  }
                },
              });
              return guidedDiarizationResult;
            } catch (error) {
              guidedTranscriptionError = error;
              sendToRenderer(
                'transcription-progress',
                `Speaker-guided transcription failed; retrying with standard transcription. ${error.message}\n`,
              );
            }
          }

          const shouldPreemptiveCpuRetry = await shouldPreemptiveCpuAtJobStart(registerProcess);
          if (shouldPreemptiveCpuRetry) {
            sendToRenderer(
              'transcription-progress',
              'CUDA runtime is not loadable on this system. Starting transcription retry on CPU.\n',
            );
          }
          try {
            return await runTranscriptionProcess({
              audioFile,
              language: normalizedLanguage,
              modelSize: normalizedModel,
              device: shouldPreemptiveCpuRetry ? 'cpu' : 'auto',
              registerProcess,
            });
          } catch (error) {
            if (!isRetryableCudaTranscriptionError(error && error.message)) {
              throw error;
            }
            sendToRenderer(
              'transcription-progress',
              'GPU transcription failed because CUDA runtime libraries could not be loaded. Retrying on CPU; this may take significantly longer.\n',
            );
            return runTranscriptionProcess({
              audioFile,
              language: normalizedLanguage,
              modelSize: normalizedModel,
              device: 'cpu',
              registerProcess,
            });
          }
        },
        });
      });

      const transcribedPath = assertSafeExistingTranscriptPath(result.output_file || transcriptPath);
      if (path.resolve(transcribedPath) !== path.resolve(transcriptPath)) {
        const transcriptContent = await fs.promises.readFile(transcribedPath, 'utf8');
        await fs.promises.writeFile(transcriptPath, transcriptContent, 'utf8');
      }

      const updatedMeeting = await new Promise((resolve, reject) => {
        const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
          '--recordings-dir', recordingsDir,
          'update-transcription',
          meetingId,
          '--status', 'completed',
          '--language', normalizedLanguage,
          '--model', normalizedModel,
          '--duration', String(result.duration || 0),
          '--clear-error',
        ]), { cwd: pythonConfig.backendPath });
        const processOutput = collectPythonProcessOutput(python, { jsonResult: true });
        python.on('close', (code) => {
          try {
            processOutput.assertStdoutWithinLimit();
          } catch (error) {
            reject(error);
            return;
          }
          if (code !== 0) {
            reject(new Error(processOutput.getStderr().trim() || 'Failed to update meeting status.'));
            return;
          }
          try {
            resolve(JSON.parse(processOutput.getStdout()));
          } catch (error) {
            reject(new Error(`Failed to parse updated meeting: ${error.message}`));
          }
        });
        python.on('error', reject);
      });

      return {
        ...result,
        output_file: transcriptPath,
        transcriptPath,
        diarization: guidedDiarizationResult,
        diarizationStatus: guidedDiarizationStatus,
        diarizationError: guidedTranscriptionError ? guidedTranscriptionError.message : null,
        meeting: updatedMeeting,
      };
    });
  }

  return {
    getTranscriptionModelDownloadCheck,
    isTranscriptionModelCached,
    getTranscriptionRuntimeEnv,
    getTranscriberArgs,
    getTranscriberBackendName,
    buildManagedModuleShim,
    buildManagedPythonModuleArgs,
    buildManagedDiarizationArgs,
    buildManagedDiarizationGuidedTranscriptionArgs,
    runTranscriptionProcess,
    cleanupGuidedTranscriptTempFiles,
    registerIpc,
  };
}

/**
 * Convenience wiring helper: build the transcription service and register IPC.
 */
function registerTranscriptionService(ipcMain, deps) {
  const service = createTranscriptionService(deps);
  service.registerIpc(ipcMain);
  return service;
}

module.exports = { createTranscriptionService, registerTranscriptionService };
