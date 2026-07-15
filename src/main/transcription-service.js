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
  getActiveWallClockComputeJobs,
  runGuidedTranscriptionProcess,
  buildClearedHuggingFaceTokenEnv,
  USER_CANCELLED_TRANSCRIPTION_ERROR,
  QUEUE_JOB_STATUSES,
  QUEUE_JOB_PHASES,
  createTranscriptionQueueState,
  upsertQueueJob,
  removeQueueJob,
  setActiveQueueMeeting,
  markTranscriptionJobCancelled,
  isTranscriptionJobCancelled,
  clearTranscriptionJobCancelFlag,
  shouldSkipJobAtHead,
  countBusyTranscriptionJobs,
  trimSessionReadyJobs,
  formatQueuedTranscriptionBusyMessage,
  buildTranscriptionQueueStatePayload,
  buildMeetingTranscriptMarkdown,
  buildSpeakerSidecarPayload,
  buildGuidedDiarizationAiMetadata,
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
 * @param {Function} [deps.addMeetingToHistory]
 * @param {Function} [deps.updateMeetingAiMetadata]
 * @param {Function} [deps.listMeetings]
 * @param {Function} [deps.hasPendingAiComputeWork]
 * @param {Function} [deps.isQuitCommitted]
 * @param {Function} [deps.validateAiMetadataPaths]
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
    hasPendingAiComputeWork = () => false,
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
    addMeetingToHistory = null,
    updateMeetingAiMetadata = null,
    listMeetings = async () => [],
    isQuitCommitted = () => false,
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

  const transcriptionQueueState = createTranscriptionQueueState();

  function publishTranscriptionQueueState() {
    // String literal keeps Phase 0 push-channel source scans honest.
    sendToRenderer(
      'transcription-queue-state',
      buildTranscriptionQueueStatePayload(transcriptionQueueState),
    );
  }

  function getBusyTranscriptionJobCount() {
    return countBusyTranscriptionJobs(transcriptionQueueState);
  }

  function getTranscriptionQueueStatePayload() {
    return buildTranscriptionQueueStatePayload(transcriptionQueueState);
  }

  async function terminateActiveTranscriptionComputeJobs() {
    const jobs = getActiveWallClockComputeJobs().filter((job) => {
      if (!job || typeof job.label !== 'string') {
        return false;
      }
      return /^(Transcription|Speaker-guided transcription|Speaker identification|Transcription retry)(\b|$)/i
        .test(job.label.trim());
    });
    await Promise.all(jobs.map(async (job) => {
      if (typeof job.terminate !== 'function') {
        return;
      }
      try {
        await job.terminate();
      } catch (_error) {
        // Best-effort.
      }
    }));
    return jobs.length;
  }

  /**
   * Cancel a queued/active job without writing durable failed status.
   * Used before delete so tombstone cannot race a late transcript write.
   */
  async function cancelJobForDelete(meetingId) {
    const id = String(meetingId || '').trim();
    if (!id) {
      return { cancelled: false };
    }
    const job = transcriptionQueueState.jobsByMeetingId.get(id);
    if (!job) {
      return { cancelled: false };
    }
    markTranscriptionJobCancelled(transcriptionQueueState, id);
    if (job.status === QUEUE_JOB_STATUSES.active
      || transcriptionQueueState.activeMeetingId === id) {
      await terminateActiveTranscriptionComputeJobs();
    }
    removeQueueJob(transcriptionQueueState, id);
    publishTranscriptionQueueState();
    return { cancelled: true };
  }

  function getMeetingDetails(meetingId, registerProcess = null) {
    const recordingsDir = getRecordingsDir();
    return new Promise((resolve, reject) => {
      let python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
        '--recordings-dir', recordingsDir,
        'get',
        meetingId,
      ]), { cwd: pythonConfig.backendPath });
      if (typeof registerProcess === 'function') {
        python = registerProcess(python);
      }
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
    });
  }

  /**
   * Bounded meeting lookup. Every meeting_manager child spawned inside the
   * compute-queue slot must be wall-clocked so a hung child cannot wedge the
   * queue (AGENTS.md compute-queue invariant).
   */
  function lookupMeetingById(meetingId) {
    return runWallClockComputeAction({
      timeoutMs: AI_COMPUTE_TIMEOUT_MS.meetingPreflight,
      label: 'Meeting lookup',
      terminateProcess: terminateProcessBestEffort,
      action: (registerProcess) => getMeetingDetails(meetingId, registerProcess),
    });
  }

  function updateMeetingTranscriptionStatus(meetingId, {
    status,
    language,
    model,
    duration,
    transcriptionDevice,
    transcriptionComputeType,
    transcriptionError,
    clearError = false,
  } = {}, registerProcess = null) {
    const recordingsDir = getRecordingsDir();
    const args = [
      '--recordings-dir', recordingsDir,
      'update-transcription',
      meetingId,
      '--status', status,
    ];
    if (language) {
      args.push('--language', String(language));
    }
    if (model) {
      args.push('--model', String(model));
    }
    if (duration !== undefined && duration !== null) {
      args.push('--duration', String(duration || 0));
    }
    if (transcriptionDevice) {
      args.push('--device', String(transcriptionDevice));
    }
    if (transcriptionComputeType) {
      args.push('--compute-type', String(transcriptionComputeType));
    }
    if (clearError) {
      args.push('--clear-error');
    } else if (transcriptionError) {
      args.push('--error', sanitizeTranscriptionError(transcriptionError));
    }

    return new Promise((resolve, reject) => {
      let python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', args), {
        cwd: pythonConfig.backendPath,
      });
      if (typeof registerProcess === 'function') {
        python = registerProcess(python);
      }
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
  }

  /**
   * Bounded durable-status write for use inside the compute-queue slot.
   * Same invariant as lookupMeetingById: no unbounded meeting_manager child
   * may run while holding the queue.
   */
  function updateMeetingTranscriptionStatusBounded(meetingId, updates) {
    return runWallClockComputeAction({
      timeoutMs: AI_COMPUTE_TIMEOUT_MS.meetingPreflight,
      label: 'Meeting status update',
      terminateProcess: terminateProcessBestEffort,
      action: (registerProcess) => updateMeetingTranscriptionStatus(meetingId, updates, registerProcess),
    });
  }

  async function resolveGuidedDiarizationStatus() {
    const diarizationAvailability = getDiarizationAvailability(process.platform, process.arch);
    if (!diarizationAvailability.supported || !diarizationAvailability.runtimeDevice) {
      return null;
    }
    try {
      const aiStatus = await checkAiAddonSetupStatus(getAiAddonRuntimeOptions());
      const diarizationStatus = aiStatus && aiStatus.features && aiStatus.features.diarization;
      const catalogModelRef = diarizationStatus ? getDiarizationModelRef(diarizationStatus.modelId) : null;
      if (diarizationStatus && diarizationStatus.status === 'ready' && diarizationStatus.setupComplete && catalogModelRef) {
        return {
          modelId: diarizationStatus.modelId,
          speakerCount: diarizationStatus.speakerCount || 'auto',
          modelRef: catalogModelRef,
          requiredDevice: diarizationAvailability.runtimeDevice,
        };
      }
    } catch (error) {
      sendToRenderer(
        'transcription-progress',
        `Speaker identification status unavailable; continuing with normal transcription. ${error.message}\n`,
      );
    }
    return null;
  }

  async function persistGuidedDiarizationArtifacts(meeting, diarizationStatus, diarizationResult) {
    if (!meeting || !meeting.id || !meeting.audioPath || !diarizationResult || typeof updateMeetingAiMetadata !== 'function') {
      return null;
    }

    const speakerSidecarPath = meeting.audioPath.replace(/\.[^/.]+$/, '.speakers.json');
    if (!isSafeRecordingsJsonPath({ filePath: speakerSidecarPath, recordingsDir: getRecordingsDir() })) {
      throw new Error('Speaker segment file must be a JSON file in the recordings directory.');
    }

    const sidecarPayload = buildSpeakerSidecarPayload({
      diarizationResult,
      audioPath: meeting.audioPath,
      segmentsPath: speakerSidecarPath,
    });
    await fs.promises.writeFile(
      path.resolve(speakerSidecarPath),
      `${JSON.stringify(sidecarPayload, null, 2)}\n`,
      'utf8',
    );

    const updatedMeeting = await updateMeetingAiMetadata(meeting.id, {
      diarization: buildGuidedDiarizationAiMetadata({
        diarizationResult,
        diarizationStatus,
        segmentsPath: speakerSidecarPath,
        status: 'completed',
      }),
    });
    return { speakerSidecarPath, meeting: updatedMeeting };
  }

  async function persistDiarizationFailureArtifacts(meeting, diarizationStatus, errorMessage) {
    if (!meeting || !meeting.id || typeof updateMeetingAiMetadata !== 'function') {
      return meeting;
    }
    return updateMeetingAiMetadata(meeting.id, {
      diarization: buildGuidedDiarizationAiMetadata({
        diarizationStatus,
        status: 'error',
        error: errorMessage,
      }),
    });
  }

  function runPostPassDiarizationProcess({
    audioPath,
    segments,
    outputPath,
    modelRef,
    speakerCount,
    requiredDevice,
    registerProcess,
  }) {
    return new Promise(async (resolve, reject) => {
      let tempSegmentsPath = null;
      try {
        const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'avanevis-diarization-segments-'));
        tempSegmentsPath = path.join(tempDir, 'segments.json');
        await fs.promises.writeFile(tempSegmentsPath, JSON.stringify({ segments }, null, 2), 'utf8');

        const python = spawnTrackedPython(buildManagedDiarizationArgs({
          audioPath,
          segmentsJsonPath: tempSegmentsPath,
          outputPath,
          modelRef,
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
      } catch (error) {
        if (tempSegmentsPath) {
          fs.promises.rm(path.dirname(tempSegmentsPath), { recursive: true, force: true }).catch(() => {});
        }
        reject(error);
      }
    });
  }

  async function runNormalTranscriptionWithCudaFallback({
    audioFile,
    language,
    modelSize,
    registerProcess,
  }) {
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
  }

  /**
   * Per-meeting composite job: guided-or-normal Whisper → optional post-pass
   * diarization → persist transcript + AI sidecars. Owned by main (queue Phase 1).
   */
  async function runMeetingTranscriptionJob({
    meetingId,
    language,
    modelSize,
    speakerCount = '',
    clearPriorDiarization = false,
    jobLabel = 'Transcription',
  }) {
    const preferredSpeakerCount = String(speakerCount || '').trim();
    let guidedDiarizationStatus = null;
    let guidedDiarizationResult = null;
    let guidedTranscriptionError = null;
    let postPassDiarizationResult = null;
    let result = null;
    let updatedMeeting = null;
    // Once durable `completed` is written, the job must never downgrade the
    // meeting to `failed` — the transcript on disk is already good.
    let completedPersisted = false;

    upsertQueueJob(transcriptionQueueState, {
      meetingId,
      status: QUEUE_JOB_STATUSES.queued,
      phase: QUEUE_JOB_PHASES.queued,
    });
    publishTranscriptionQueueState();

    try {
      result = await enqueueAiComputeAction(async () => {
        if (shouldSkipJobAtHead({
          isQuitCommitted: isQuitCommitted(),
          isCancelled: isTranscriptionJobCancelled(transcriptionQueueState, meetingId),
        })) {
          const cancelled = isTranscriptionJobCancelled(transcriptionQueueState, meetingId);
          if (cancelled && !isQuitCommitted()) {
            // Consume the flag — a leaked flag would make every future job for
            // this meeting (e.g. Retry from History) self-cancel.
            clearTranscriptionJobCancelFlag(transcriptionQueueState, meetingId);
            updatedMeeting = await updateMeetingTranscriptionStatusBounded(meetingId, {
              status: 'failed',
              language,
              model: modelSize,
              transcriptionError: USER_CANCELLED_TRANSCRIPTION_ERROR,
            });
            upsertQueueJob(transcriptionQueueState, {
              meetingId,
              status: QUEUE_JOB_STATUSES.failed,
              phase: QUEUE_JOB_PHASES.cancelled,
            });
            publishTranscriptionQueueState();
            const cancelError = new Error(USER_CANCELLED_TRANSCRIPTION_ERROR);
            cancelError.code = 'TRANSCRIPTION_CANCELLED';
            throw cancelError;
          }
          // Quit: leave durable pending; do not spawn Whisper.
          removeQueueJob(transcriptionQueueState, meetingId);
          publishTranscriptionQueueState();
          const quitError = new Error('Transcription was skipped because the app is quitting.');
          quitError.code = 'TRANSCRIPTION_QUIT_SKIPPED';
          throw quitError;
        }

        // Gate passed: consume any stale cancel flag so it cannot leak into a
        // later job for the same meeting.
        clearTranscriptionJobCancelFlag(transcriptionQueueState, meetingId);
        setActiveQueueMeeting(transcriptionQueueState, meetingId);
        upsertQueueJob(transcriptionQueueState, {
          meetingId,
          status: QUEUE_JOB_STATUSES.active,
          phase: QUEUE_JOB_PHASES.waiting_resource,
        });
        publishTranscriptionQueueState();

        await waitForGpuRuntimeBeforeCompute(jobLabel);

        // Fresh get inside the queue slot so post-add audioPath / title stay
        // current. Bounded: a hung meeting_manager child must not wedge the queue.
        const meeting = await lookupMeetingById(meetingId);
        if (!meeting || !meeting.audioPath || !meeting.transcriptPath) {
          throw new Error('Meeting is missing audio or transcript path.');
        }

        const audioFile = assertSafeExistingRecordingAudioPath(meeting.audioPath);
        const transcriptPath = assertSafeExistingTranscriptPath(meeting.transcriptPath);
        upsertQueueJob(transcriptionQueueState, {
          meetingId,
          title: meeting.title || '',
          durationSeconds: Number(meeting.duration) || 0,
        });
        publishTranscriptionQueueState();

        guidedDiarizationStatus = await resolveGuidedDiarizationStatus();
        const timeoutMs = guidedDiarizationStatus
          ? getGuidedTranscriptionComputeTimeoutMs(modelSize)
          : getTranscriptionComputeTimeoutMs(modelSize);

        // Wall clock #1: transcription only (guided path includes pyannote and
        // budgets for it). Persistence and any post-pass run after this with
        // their own bounds so a slow speaker pass cannot burn the transcript's
        // budget or downgrade a finished transcript to `failed`.
        let transcriptionResult = await runWallClockComputeAction({
          timeoutMs,
          label: jobLabel,
          terminateProcess: terminateProcessBestEffort,
          action: async (registerProcess) => {
            upsertQueueJob(transcriptionQueueState, {
              meetingId,
              status: QUEUE_JOB_STATUSES.active,
              phase: guidedDiarizationStatus
                ? QUEUE_JOB_PHASES.identifying_speakers
                : QUEUE_JOB_PHASES.transcribing,
            });
            publishTranscriptionQueueState();

            if (guidedDiarizationStatus) {
              try {
                const tempTranscriptPath = buildGuidedTranscriptTempPath({ finalTranscriptPath: transcriptPath });
                guidedDiarizationResult = await runGuidedTranscriptionProcess({
                  spawnProcess: spawnTrackedPython,
                  args: buildManagedDiarizationGuidedTranscriptionArgs({
                    audioPath: audioFile,
                    outputTranscript: tempTranscriptPath,
                    language,
                    modelSize,
                    modelRef: guidedDiarizationStatus.modelRef,
                    speakerCount: preferredSpeakerCount || guidedDiarizationStatus.speakerCount || 'auto',
                    requiredDevice: guidedDiarizationStatus.requiredDevice,
                  }),
                  cwd: pythonConfig.backendPath,
                  env: {
                    ...getDiarizationDependencyEnv(),
                    ...getDiarizationCacheEnv(),
                    ...getTranscriptionRuntimeEnv(modelSize, { includeManagedDiarization: true }),
                    ...buildClearedHuggingFaceTokenEnv(),
                  },
                  finalTranscriptPath: transcriptPath,
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
                });
              } catch (error) {
                guidedTranscriptionError = error;
                guidedDiarizationResult = null;
                sendToRenderer(
                  'transcription-progress',
                  `Speaker-guided transcription failed; retrying with standard transcription. ${error.message}\n`,
                );
                upsertQueueJob(transcriptionQueueState, {
                  meetingId,
                  phase: QUEUE_JOB_PHASES.transcribing,
                });
                publishTranscriptionQueueState();
              }
            }

            const innerResult = guidedDiarizationResult || await runNormalTranscriptionWithCudaFallback({
              audioFile,
              language,
              modelSize,
              registerProcess,
            });

            const transcribedPath = assertSafeExistingTranscriptPath(
              innerResult.output_file || transcriptPath,
            );
            if (path.resolve(transcribedPath) !== path.resolve(transcriptPath)) {
              const transcriptContent = await fs.promises.readFile(transcribedPath, 'utf8');
              await fs.promises.writeFile(transcriptPath, transcriptContent, 'utf8');
            }

            return innerResult;
          },
        });

        // Persist durable `completed` BEFORE the optional post-pass: the
        // transcript on disk is final here, and a failed or timed-out speaker
        // pass must never convert a finished transcript into durable `failed`.
        upsertQueueJob(transcriptionQueueState, {
          meetingId,
          phase: QUEUE_JOB_PHASES.persisting,
        });
        publishTranscriptionQueueState();
        updatedMeeting = await updateMeetingTranscriptionStatusBounded(meetingId, {
          status: 'completed',
          language,
          model: modelSize,
          duration: transcriptionResult.duration || 0,
          transcriptionDevice: transcriptionResult.transcriptionDevice || transcriptionResult.device,
          transcriptionComputeType: transcriptionResult.transcriptionComputeType || transcriptionResult.computeType,
          clearError: true,
        });
        completedPersisted = true;

        // Optional post-pass speaker labels: guided failed at head, or
        // diarization became ready while the job was queued. Runs on its own
        // wall clock with the diarization budget (like the pre-queue design),
        // and failures degrade to diarization error metadata.
        if (!guidedDiarizationResult) {
          const postPassStatus = guidedDiarizationStatus || await resolveGuidedDiarizationStatus();
          if (
            postPassStatus
            && Array.isArray(transcriptionResult.segments)
            && transcriptionResult.segments.length > 0
          ) {
            upsertQueueJob(transcriptionQueueState, {
              meetingId,
              phase: QUEUE_JOB_PHASES.identifying_speakers,
            });
            publishTranscriptionQueueState();
            try {
              const outputPath = buildDiarizationOutputPath({ audioPath: audioFile });
              postPassDiarizationResult = await runWallClockComputeAction({
                timeoutMs: AI_COMPUTE_TIMEOUT_MS.diarization,
                label: 'Speaker identification',
                terminateProcess: terminateProcessBestEffort,
                action: (registerProcess) => runPostPassDiarizationProcess({
                  audioPath: audioFile,
                  segments: transcriptionResult.segments,
                  outputPath,
                  modelRef: postPassStatus.modelRef,
                  speakerCount: preferredSpeakerCount || postPassStatus.speakerCount || 'auto',
                  requiredDevice: postPassStatus.requiredDevice,
                  registerProcess,
                }),
              });
              guidedDiarizationStatus = postPassStatus;
              if (postPassDiarizationResult && Array.isArray(postPassDiarizationResult.segments)) {
                const updatedMarkdown = buildMeetingTranscriptMarkdown({
                  audioPath: audioFile,
                  language,
                  duration: transcriptionResult.duration || meeting.duration || 0,
                  transcriptionResult,
                  diarizationResult: postPassDiarizationResult,
                });
                await fs.promises.writeFile(transcriptPath, updatedMarkdown, 'utf8');
                transcriptionResult = {
                  ...transcriptionResult,
                  segments: postPassDiarizationResult.segments,
                  transcriptContent: updatedMarkdown,
                };
              }
            } catch (postPassError) {
              postPassDiarizationResult = null;
              guidedDiarizationStatus = postPassStatus;
              if (!isQuitCommitted()) {
                guidedTranscriptionError = guidedTranscriptionError || postPassError;
                sendToRenderer(
                  'transcription-progress',
                  `Speaker identification failed; saved normal transcript. ${postPassError.message}\n`,
                );
              }
            }
          }
        }

        // Sidecar / AI-metadata persistence. Contained: the transcript is
        // already durable `completed`, so metadata problems degrade to error
        // metadata + progress warnings instead of failing the job. Skipped on
        // quit so teardown never spawns fresh meeting_manager children.
        upsertQueueJob(transcriptionQueueState, {
          meetingId,
          phase: QUEUE_JOB_PHASES.persisting,
        });
        publishTranscriptionQueueState();

        if (clearPriorDiarization && typeof updateMeetingAiMetadata === 'function' && !guidedDiarizationResult && !postPassDiarizationResult && !isQuitCommitted()) {
          try {
            await updateMeetingAiMetadata(meetingId, { diarization: null });
          } catch (clearError) {
            sendToRenderer(
              'transcription-progress',
              `Could not clear previous speaker identification metadata: ${clearError.message}\n`,
            );
          }
        }

        try {
          if (guidedDiarizationResult) {
            const persisted = await persistGuidedDiarizationArtifacts(
              updatedMeeting,
              guidedDiarizationStatus,
              guidedDiarizationResult.diarization || guidedDiarizationResult,
            );
            if (persisted && persisted.meeting) {
              updatedMeeting = persisted.meeting;
            }
          } else if (postPassDiarizationResult) {
            const persisted = await persistGuidedDiarizationArtifacts(
              updatedMeeting,
              guidedDiarizationStatus,
              postPassDiarizationResult,
            );
            if (persisted && persisted.meeting) {
              updatedMeeting = persisted.meeting;
            }
          } else if (guidedTranscriptionError && guidedDiarizationStatus && !isQuitCommitted()) {
            updatedMeeting = await persistDiarizationFailureArtifacts(
              updatedMeeting,
              guidedDiarizationStatus,
              guidedTranscriptionError.message,
            ) || updatedMeeting;
          }
        } catch (sidecarError) {
          if (!isQuitCommitted()) {
            guidedTranscriptionError = guidedTranscriptionError || sidecarError;
            sendToRenderer(
              'transcription-progress',
              `Could not save speaker identification metadata; the transcript itself is saved. ${sidecarError.message}\n`,
            );
            try {
              updatedMeeting = await persistDiarizationFailureArtifacts(
                updatedMeeting,
                guidedDiarizationStatus,
                sidecarError.message,
              ) || updatedMeeting;
            } catch (metadataError) {
              // Best-effort only; the meeting is already completed.
            }
          }
        }

        return {
          ...transcriptionResult,
          output_file: transcriptPath,
          transcriptPath,
          meeting: updatedMeeting,
          audioPath: audioFile,
        };
      });

      clearTranscriptionJobCancelFlag(transcriptionQueueState, meetingId);
      upsertQueueJob(transcriptionQueueState, {
        meetingId,
        status: QUEUE_JOB_STATUSES.ready,
        phase: QUEUE_JOB_PHASES.completed,
      });
      trimSessionReadyJobs(transcriptionQueueState);
      setActiveQueueMeeting(transcriptionQueueState, null);
      publishTranscriptionQueueState();

      return {
        ...result,
        output_file: result.transcriptPath || result.output_file,
        transcriptPath: result.transcriptPath || result.output_file,
        diarization: guidedDiarizationResult
          ? (guidedDiarizationResult.diarization || guidedDiarizationResult)
          : postPassDiarizationResult,
        diarizationStatus: guidedDiarizationStatus,
        diarizationError: guidedTranscriptionError ? guidedTranscriptionError.message : null,
        meeting: result.meeting || updatedMeeting,
      };
    } catch (error) {
      setActiveQueueMeeting(transcriptionQueueState, null);

      if (isQuitCommitted() || (error && error.code === 'TRANSCRIPTION_QUIT_SKIPPED')) {
        // Quit-killed or head-of-queue quit skip: keep durable pending.
        removeQueueJob(transcriptionQueueState, meetingId);
        publishTranscriptionQueueState();
        throw error;
      }

      if (error && error.code === 'TRANSCRIPTION_CANCELLED') {
        throw error;
      }

      // Active cancel: terminate kills the child; remap to user-cancelled failed.
      if (isTranscriptionJobCancelled(transcriptionQueueState, meetingId)) {
        clearTranscriptionJobCancelFlag(transcriptionQueueState, meetingId);
        if (!completedPersisted) {
          try {
            updatedMeeting = await updateMeetingTranscriptionStatus(meetingId, {
              status: 'failed',
              language,
              model: modelSize,
              transcriptionError: USER_CANCELLED_TRANSCRIPTION_ERROR,
            });
          } catch (statusError) {
            sendToRenderer(
              'transcription-progress',
              `Could not persist cancellation status: ${statusError.message}\n`,
            );
          }
        }
        upsertQueueJob(transcriptionQueueState, {
          meetingId,
          status: QUEUE_JOB_STATUSES.failed,
          phase: QUEUE_JOB_PHASES.cancelled,
        });
        publishTranscriptionQueueState();
        const cancelError = new Error(USER_CANCELLED_TRANSCRIPTION_ERROR);
        cancelError.code = 'TRANSCRIPTION_CANCELLED';
        if (updatedMeeting) {
          cancelError.meeting = updatedMeeting;
        }
        throw cancelError;
      }

      clearTranscriptionJobCancelFlag(transcriptionQueueState, meetingId);

      if (completedPersisted) {
        // The transcript is durable `completed`; a late metadata/post-pass
        // error must not downgrade it. Report the job as ready with the error
        // carried as a diarization-level warning.
        upsertQueueJob(transcriptionQueueState, {
          meetingId,
          status: QUEUE_JOB_STATUSES.ready,
          phase: QUEUE_JOB_PHASES.completed,
        });
        publishTranscriptionQueueState();
        return {
          output_file: null,
          transcriptPath: null,
          diarization: null,
          diarizationStatus: guidedDiarizationStatus,
          diarizationError: (error && error.message) || null,
          meeting: updatedMeeting,
        };
      }

      try {
        updatedMeeting = await updateMeetingTranscriptionStatus(meetingId, {
          status: 'failed',
          language,
          model: modelSize,
          transcriptionError: (error && error.message) || 'Transcription failed.',
        });
      } catch (statusError) {
        sendToRenderer(
          'transcription-progress',
          `Could not persist transcription failure status: ${statusError.message}\n`,
        );
      }

      upsertQueueJob(transcriptionQueueState, {
        meetingId,
        status: QUEUE_JOB_STATUSES.failed,
        phase: QUEUE_JOB_PHASES.failed,
      });
      publishTranscriptionQueueState();
      if (updatedMeeting) {
        error.meeting = updatedMeeting;
      }
      throw error;
    }
  }

  async function finalizeRecordingTranscription({
    audioPath,
    duration = 0,
    language = 'en',
    modelSize = 'small',
    transcriptionErrorNote = '',
    title = '',
  } = {}) {
    if (typeof addMeetingToHistory !== 'function') {
      throw new Error('finalize-recording-transcription requires addMeetingToHistory');
    }

    const normalizedModel = requireAllowedModelSize(modelSize);
    const normalizedLanguage = String(language || 'en');
    const resolvedAudioPath = assertSafeExistingRecordingAudioPath(audioPath);
    const transcriptPath = resolvedAudioPath.replace(/\.[^/.]+$/, '.md');
    if (!isSafeRecordingsMarkdownPath({ filePath: transcriptPath, recordingsDir: getRecordingsDir() })) {
      throw new Error('Transcript must be a Markdown file in the recordings directory.');
    }

    const placeholderMarkdown = buildTranscriptionPlaceholderMarkdown({
      audioPath: resolvedAudioPath,
      duration,
      status: 'pending',
      errorMessage: transcriptionErrorNote,
    });
    await fs.promises.writeFile(transcriptPath, placeholderMarkdown, 'utf8');

    let savedMeeting;
    try {
      savedMeeting = await addMeetingToHistory({
        audioPath: resolvedAudioPath,
        transcriptPath,
        duration: Number(duration) || 0,
        language: normalizedLanguage,
        model: normalizedModel,
        title: title || undefined,
        transcriptionStatus: 'pending',
        transcriptionError: transcriptionErrorNote || undefined,
      });
    } catch (persistError) {
      return {
        success: false,
        code: 'PENDING_MEETING_PERSIST_FAILED',
        error: (persistError && persistError.message) || 'Failed to save pending meeting.',
      };
    }

    if (!savedMeeting || !savedMeeting.id || !savedMeeting.audioPath) {
      return {
        success: false,
        code: 'PENDING_MEETING_PERSIST_FAILED',
        error: 'Pending meeting save returned an incomplete meeting record.',
      };
    }

    upsertQueueJob(transcriptionQueueState, {
      meetingId: savedMeeting.id,
      status: QUEUE_JOB_STATUSES.queued,
      phase: QUEUE_JOB_PHASES.queued,
      title: savedMeeting.title || '',
      durationSeconds: Number(savedMeeting.duration) || Number(duration) || 0,
    });
    publishTranscriptionQueueState();

    // PR2: return as soon as pending persist succeeds so Start unlocks.
    // The composite job continues in main; failures update durable status + queue-state.
    void runMeetingTranscriptionJob({
      meetingId: savedMeeting.id,
      language: normalizedLanguage,
      modelSize: normalizedModel,
      jobLabel: 'Transcription',
    }).catch((jobError) => {
      if (jobError && (jobError.code === 'TRANSCRIPTION_QUIT_SKIPPED' || jobError.code === 'TRANSCRIPTION_CANCELLED')) {
        return;
      }
      console.warn(
        'Background transcription job failed:',
        (jobError && jobError.message) || jobError,
      );
    });

    return {
      success: true,
      enqueued: true,
      meeting: savedMeeting,
      pendingMeeting: savedMeeting,
    };
  }

  async function resumePendingTranscriptions({ language = null, modelSize = null } = {}) {
    const meetings = await listMeetings();
    const pending = (Array.isArray(meetings) ? meetings : []).filter((meeting) => (
      meeting
      && meeting.id
      && String(meeting.transcriptionStatus || '') === 'pending'
    ));

    const enqueued = [];
    for (const meeting of pending) {
      const meetingId = String(meeting.id);
      const existing = transcriptionQueueState.jobsByMeetingId.get(meetingId);
      if (existing && (existing.status === QUEUE_JOB_STATUSES.queued
        || existing.status === QUEUE_JOB_STATUSES.active)) {
        continue;
      }

      const normalizedModel = requireAllowedModelSize(modelSize || meeting.model || 'small');
      const normalizedLanguage = String(language || meeting.language || 'en');

      upsertQueueJob(transcriptionQueueState, {
        meetingId,
        status: QUEUE_JOB_STATUSES.queued,
        phase: QUEUE_JOB_PHASES.queued,
        title: meeting.title || '',
        durationSeconds: Number(meeting.duration) || 0,
      });
      enqueued.push(meetingId);

      void runMeetingTranscriptionJob({
        meetingId,
        language: normalizedLanguage,
        modelSize: normalizedModel,
        jobLabel: 'Transcription',
      }).catch((jobError) => {
        if (jobError && (jobError.code === 'TRANSCRIPTION_QUIT_SKIPPED' || jobError.code === 'TRANSCRIPTION_CANCELLED')) {
          return;
        }
        console.warn(
          'Resumed transcription job failed:',
          (jobError && jobError.message) || jobError,
        );
      });
    }

    if (enqueued.length) {
      publishTranscriptionQueueState();
    }

    return {
      success: true,
      enqueuedCount: enqueued.length,
      meetingIds: enqueued,
    };
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
      // Stay off the compute queue. Fail fast when transcription/compute is busy —
      // a 15-minute idle wait is routinely exceedable with a real queue (PR2).
      if (hasPendingAiComputeWork()) {
        const busyCount = getBusyTranscriptionJobCount();
        const error = new Error(formatQueuedTranscriptionBusyMessage(
          busyCount,
          'downloading the Whisper model',
        ));
        error.code = 'MODEL_DOWNLOAD_COMPUTE_BUSY';
        throw error;
      }

      const idleController = new AbortController();
      activeModelDownload = { process: null, controller: idleController, model };

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

    ipcMain.handle('finalize-recording-transcription', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      return finalizeRecordingTranscription(options || {});
    });

    ipcMain.handle('cancel-pending-transcription', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      const meetingId = String((options && options.meetingId) || '').trim();
      if (!meetingId) {
        throw new Error('cancel-pending-transcription requires a meetingId');
      }
      const job = transcriptionQueueState.jobsByMeetingId.get(meetingId);
      if (!job) {
        // Durable pending from a prior session may not have an in-memory job yet.
        // Mark failed so resume banner does not keep offering cancelled work.
        try {
          const meeting = await lookupMeetingById(meetingId);
          if (meeting && String(meeting.transcriptionStatus || '') === 'pending') {
            const updatedMeeting = await updateMeetingTranscriptionStatus(meetingId, {
              status: 'failed',
              transcriptionError: USER_CANCELLED_TRANSCRIPTION_ERROR,
            });
            return { success: true, cancelled: true, meeting: updatedMeeting, durableOnly: true };
          }
        } catch (_lookupError) {
          // Fall through to NO_SUCH_JOB.
        }
        return {
          success: false,
          cancelled: false,
          code: 'NO_SUCH_JOB',
          message: 'No queued transcription job exists for that meeting.',
        };
      }
      markTranscriptionJobCancelled(transcriptionQueueState, meetingId);
      if (job.status === QUEUE_JOB_STATUSES.queued) {
        const updatedMeeting = await updateMeetingTranscriptionStatus(meetingId, {
          status: 'failed',
          transcriptionError: USER_CANCELLED_TRANSCRIPTION_ERROR,
        });
        upsertQueueJob(transcriptionQueueState, {
          meetingId,
          status: QUEUE_JOB_STATUSES.failed,
          phase: QUEUE_JOB_PHASES.cancelled,
        });
        publishTranscriptionQueueState();
        return { success: true, cancelled: true, meeting: updatedMeeting };
      }
      // Active: terminate the compute child; catch path writes durable failed.
      if (job.status === QUEUE_JOB_STATUSES.active
        || transcriptionQueueState.activeMeetingId === meetingId) {
        await terminateActiveTranscriptionComputeJobs();
      }
      publishTranscriptionQueueState();
      return { success: true, cancelled: true, active: true };
    });

    ipcMain.handle('resume-pending-transcriptions', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      return resumePendingTranscriptions(options || {});
    });

    ipcMain.handle('get-transcription-queue-state', async (event) => {
      assertTrustedRendererSender(event);
      return getTranscriptionQueueStatePayload();
    });

    ipcMain.handle('retry-transcription', async (event, options = {}) => {
      assertTrustedRendererSender(event);

      const meetingId = String(options.meetingId || '').trim();
      if (!meetingId) {
        throw new Error('retry-transcription requires a meetingId');
      }

      const meeting = await lookupMeetingById(meetingId);
      if (!meeting || !meeting.audioPath || !meeting.transcriptPath) {
        throw new Error('Meeting is missing audio or transcript path.');
      }

      const normalizedModel = requireAllowedModelSize(options.modelSize || meeting.model || 'small');
      const normalizedLanguage = String(options.language || meeting.language || 'en');
      assertSafeExistingRecordingAudioPath(meeting.audioPath);
      assertSafeExistingTranscriptPath(meeting.transcriptPath);

      upsertQueueJob(transcriptionQueueState, {
        meetingId,
        status: QUEUE_JOB_STATUSES.queued,
        phase: QUEUE_JOB_PHASES.queued,
        title: meeting.title || '',
        durationSeconds: Number(meeting.duration) || 0,
      });
      publishTranscriptionQueueState();

      return runMeetingTranscriptionJob({
        meetingId,
        language: normalizedLanguage,
        modelSize: normalizedModel,
        speakerCount: options.speakerCount,
        clearPriorDiarization: true,
        jobLabel: 'Transcription retry',
      });
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
    runMeetingTranscriptionJob,
    finalizeRecordingTranscription,
    resumePendingTranscriptions,
    cancelJobForDelete,
    getBusyTranscriptionJobCount,
    getTranscriptionQueueStatePayload,
    publishTranscriptionQueueState,
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
