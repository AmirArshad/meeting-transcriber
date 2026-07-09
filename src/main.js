/**
 * Main process for AvaNevis Electron app.
 *
 * This file:
 * - Creates the application window
 * - Manages communication between UI and Python backend
 * - Handles application lifecycle
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const {
  buildRecordingPreflightReport,
  buildMacOSPermissionCheckFailureStatus,
  buildQuitRecordingDialogOptions,
  buildModelDownloadCheck,
  buildDiarizationOutputPath,
  buildGuidedTranscriptTempPath,
  buildPythonModuleArgs,
  buildTranscriptionCliArgs,
  runGuidedTranscriptionProcess,
  buildTranscriberArgs,
  buildHuggingFaceOfflineEnv,
  buildTranscriptionRuntimeEnv,
  cacheContainsCompleteTranscriptionModel,
  getQuitInterceptState,
  getRecorderCloseAction,
  getRecorderEventAction,
  getRecordingStopTimeout,
  findRecorderResultPayload,
  getRecorderResultAudioPath,
  normalizeRecordingStopPayload,
  parseRecordingStopResult,
  resolveStopTimeoutAction,
  isModelDownloadErrorOutput,
  isSafeRecordingsAudioPath,
  isSafeRecordingsJsonPath,
  isSafeRecordingsMarkdownPath,
  parseRecorderStdoutChunk,
  parsePythonVersion,
  parseAiBackendProgressLine,
  resolveExternalUrl,
  getLegalNoticesPath,
  resolveTranscriptionAudioFile,
  summarizeAiBackendError,
  appendCappedSpawnLogBuffer,
  appendSpawnJsonResultBuffer,
  createLineChunkRedactor,
  normalizeModelSize,
  buildRecorderBusyResponse,
  isRecorderBusy,
  isRetryableCudaTranscriptionError,
  shouldForceCpuTranscriptionFromCudaStatus,
  SPAWN_LOG_BUFFER_MAX_CHARS,
  SPAWN_JSON_RESULT_BUFFER_MAX_CHARS,
  redactSensitiveText,
  MACOS_PERMISSION_CHECK_TIMEOUT_MS,
  AI_COMPUTE_TIMEOUT_MS,
  getTranscriptionComputeTimeoutMs,
  runWallClockComputeAction,
} = require('./main-process-helpers');
const { checkForUpdates, openDownloadPage } = require('./updater');
const {
  checkAiAddonSetupStatus,
  getSummaryArtifactPath,
  getSummaryRuntimeDir,
} = require('./ai-addon-setup');
const {
  getDiarizationAvailability,
  getDiarizationModelRef,
  getSummaryArtifactForPlatform,
} = require('./ai-addon-state');
const { createPythonRuntime } = require('./main/python-runtime');
const { registerMeetingManagerClient } = require('./main/meeting-manager-client');
const { registerDeviceIpc } = require('./main/device-ipc');
const { registerFileExportIpc } = require('./main/file-export-ipc');
const {
  createAiComputeQueue,
} = require('./main/ai-compute-queue');
const { createGpuRuntimeService } = require('./main/gpu-runtime-service');
const {
  createAiAddonIpc,
  createAiAddonCancelErrorStandalone,
} = require('./main/ai-addon-ipc');

// Use Electron's default userData path, which handles packaging correctly
// This is typically: C:\Users\<username>\AppData\Roaming\AvaNevis
// No need to set a custom path - Electron manages this properly

let mainWindow;
let pythonProcess;
let recordingStartTime = null;
let tray = null;
let isQuitting = false;
let powerSaveId = null; // Power save blocker ID for preventing system suspension during recording
let recordingHeartbeat = null; // Heartbeat monitor to detect recording failures
let lastLevelUpdate = null; // Timestamp of last audio level update
let recordingStopPromise = null;
let stopCommandSent = false;
let quitWorkflowPromise = null;
let allowImmediateQuit = false;
let pendingUpdateInfo = null;
let recordingSessionCounter = 0;
// Summary generation cancellation handle stays in main.js until Phase 3c.
let activeSummaryGeneration = null;
// Assigned at composition root after GPU + AI-addon services are constructed.
let aiAddonIpc = null;
let gpuRuntimeService = null;

// ============================================================================
// Python runtime service (owns the shared activeProcesses tracking array)
// ============================================================================
const pythonRuntime = createPythonRuntime({ app, spawn, path, fs, dirname: __dirname });
const {
  pythonConfig,
  buildPythonProcessArgs,
  spawnTrackedPython,
} = pythonRuntime;

// ============================================================================
// AI compute queue (no IPC — consumed by transcription/summary/ai-addon)
// ============================================================================
const aiComputeQueue = createAiComputeQueue({
  createAiAddonCancelError: createAiAddonCancelErrorStandalone,
  runWallClockComputeAction,
});
const {
  aiComputeActionQueue,
  enqueueAiComputeAction,
  createAbortableComputeAction,
} = aiComputeQueue;

function getSafeStorage() {
  // On macOS, Electron safeStorage can prompt Keychain access. Keep this lazy
  // so passive startup/status checks never touch Keychain.
  return require('electron').safeStorage;
}

function firstExistingPath(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || null;
}

function getWindowIconPath() {
  if (process.platform === 'win32') {
    return firstExistingPath([
      path.join(process.resourcesPath, 'icon.ico'),
      path.join(__dirname, '../build/icon.ico'),
    ]);
  }

  return firstExistingPath([
    path.join(process.resourcesPath, 'iconTemplate.png'),
    path.join(__dirname, '../build/iconTemplate.png'),
  ]);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function appendSpawnLogBuffer(buffer, chunk) {
  return appendCappedSpawnLogBuffer(buffer, chunk, SPAWN_LOG_BUFFER_MAX_CHARS);
}

function appendSpawnJsonStdout(buffer, chunk, overflowState) {
  const result = appendSpawnJsonResultBuffer(buffer, chunk, SPAWN_JSON_RESULT_BUFFER_MAX_CHARS);
  if (result.overflowed) {
    overflowState.overflowed = true;
  }
  return result.buffer;
}

function sendRedactedProgress(channel, chunk, redactor) {
  const redacted = redactor.redactChunk(chunk);
  if (redacted) {
    sendToRenderer(channel, redacted);
  }
}

function flushRedactedProgress(channel, redactor) {
  const flushed = redactor.flush();
  if (flushed) {
    sendToRenderer(channel, flushed);
  }
}

function requireAllowedModelSize(modelSize, defaultSize = 'small') {
  const normalized = normalizeModelSize(modelSize, { defaultSize });
  if (!normalized.ok) {
    throw new Error(normalized.error);
  }
  return normalized.modelSize;
}

function collectPythonProcessOutput(python, { jsonResult = false } = {}) {
  let stdout = '';
  let stderr = '';
  const stdoutOverflow = { overflowed: false };

  python.stdout.on('data', (data) => {
    stdout = jsonResult
      ? appendSpawnJsonStdout(stdout, data, stdoutOverflow)
      : appendSpawnLogBuffer(stdout, data);
  });

  python.stderr.on('data', (data) => {
    stderr = appendSpawnLogBuffer(stderr, data);
  });

  return {
    getStdout: () => stdout,
    getStderr: () => stderr,
    assertStdoutWithinLimit: () => {
      if (stdoutOverflow.overflowed) {
        throw new Error('Process output exceeded the maximum allowed size.');
      }
    },
  };
}

function isDevToolsEnabled() {
  return !app.isPackaged || process.env.AVANEVIS_ENABLE_DEVTOOLS === '1';
}

function assertTrustedRendererSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Untrusted IPC sender.');
  }
}

function hasInFlightAiWork() {
  return (aiAddonIpc ? aiAddonIpc.hasInFlightAiAddonSetup() : false)
    || Boolean(activeSummaryGeneration)
    || aiComputeActionQueue.hasPendingWork();
}

function canAbortActiveSummaryGeneration() {
  return Boolean(
    activeSummaryGeneration?.controller
    && !activeSummaryGeneration.controller.signal.aborted
    && activeSummaryGeneration.phase !== 'metadata'
  );
}

function abortInFlightAiSetup() {
  if (aiAddonIpc) {
    aiAddonIpc.abortInFlightAiSetup();
  }
}

function abortInFlightAiWork() {
  abortInFlightAiSetup();

  if (canAbortActiveSummaryGeneration()) {
    activeSummaryGeneration.controller.abort(createAiAddonCancelErrorStandalone('Summary generation was canceled because the app is quitting.'));
    terminateProcessBestEffort(activeSummaryGeneration.process);
  }
}

async function drainAiWorkBeforeQuit() {
  const metadataPhaseActive = activeSummaryGeneration?.phase === 'metadata';

  abortInFlightAiSetup();

  if (canAbortActiveSummaryGeneration()) {
    activeSummaryGeneration.controller.abort(createAiAddonCancelErrorStandalone('Summary generation was canceled because the app is quitting.'));
    terminateProcessBestEffort(activeSummaryGeneration.process);
  }

  const drainTimeoutMs = metadataPhaseActive ? 15000 : 30000;
  try {
    const drains = [aiComputeActionQueue.drain()];
    if (aiAddonIpc) {
      drains.push(aiAddonIpc.aiAddonActionQueue.drain());
    }
    await Promise.race([
      Promise.all(drains),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timed out waiting for local AI work to finish.')), drainTimeoutMs);
      }),
    ]);
  } catch (error) {
    console.warn('Quit drain for local AI work did not finish cleanly:', error.message);
  }
}

function sendUpdateAvailable(updateInfo) {
  pendingUpdateInfo = updateInfo;
  sendToRenderer('update-available', updateInfo);
}

function openTrustedExternalUrl(url) {
  const trustedUrl = resolveExternalUrl(url);
  if (!trustedUrl) {
    return Promise.reject(new Error(`Blocked untrusted external URL: ${url}`));
  }

  return shell.openExternal(trustedUrl);
}

function clearRecordingRuntimeState(reason) {
  if (recordingHeartbeat) {
    clearInterval(recordingHeartbeat);
    recordingHeartbeat = null;
    console.log(`Recording heartbeat monitor stopped (${reason})`);
  }

  pythonProcess = null;
  recordingStartTime = null;
  disableRecordingPowerSaveBlocker(reason);
  resetStopWorkflowState();
}

function disableRecordingPowerSaveBlocker(reason = 'recording stopped') {
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
    console.log(`Power save blocker disabled (${reason})`);
  }
}

function resetStopWorkflowState() {
  recordingStopPromise = null;
  stopCommandSent = false;
}

function parseRecordingStopResultFromStdout(stdoutData) {
  return parseRecordingStopResult(stdoutData, {
    existsSync: fs.existsSync,
    getRecordingsDir,
  });
}

function stopRecordingProcess() {
  if (!pythonProcess) {
    return Promise.resolve({ success: true });
  }

  if (recordingStopPromise) {
    return recordingStopPromise;
  }

  if (recordingHeartbeat) {
    clearInterval(recordingHeartbeat);
    recordingHeartbeat = null;
    console.log('Recording heartbeat monitor stopped');
  }

  const currentProcess = pythonProcess;

  recordingStopPromise = new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    let settled = false;

    const stdoutHandler = (data) => {
      stdoutData = appendCappedSpawnLogBuffer(stdoutData, data, SPAWN_JSON_RESULT_BUFFER_MAX_CHARS);
    };

    const stderrHandler = (data) => {
      const output = data.toString();
      stderrData = appendCappedSpawnLogBuffer(stderrData, output);
      console.log(`Python status: ${output}`);
    };

    const cleanupListeners = () => {
      currentProcess.stdout.removeListener('data', stdoutHandler);
      currentProcess.stderr.removeListener('data', stderrHandler);
      currentProcess.removeListener('close', closeHandler);
    };

    const finalizeState = () => {
      if (pythonProcess === currentProcess) {
        clearRecordingRuntimeState('recording completed');
        return;
      }

      resetStopWorkflowState();
    };

    const closeHandler = (code) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanupListeners();
      finalizeState();

      if (code === 0) {
        try {
          resolve(parseRecordingStopResultFromStdout(stdoutData));
        } catch (error) {
          reject(error);
        }
        return;
      }

      reject(new Error(`Recording stopped with exit code ${code}: ${stderrData}`));
    };

    currentProcess.stdout.on('data', stdoutHandler);
    currentProcess.stderr.on('data', stderrHandler);
    currentProcess.once('close', closeHandler);

    try {
      if (stopCommandSent) {
        return;
      }

      currentProcess.stdin.write('stop\n');
      stopCommandSent = true;
    } catch (error) {
      settled = true;
      cleanupListeners();
      resetStopWorkflowState();
      reject(new Error(`Could not send stop command to recorder: ${error.message}`));
    }
  });

  return recordingStopPromise;
}

async function waitForRecordingStop({ forceKillOnTimeout, timeoutMessage }) {
  const stopPromise = stopRecordingProcess();
  const timeoutMs = getRecordingStopTimeout(recordingStartTime);

  let timeoutHandle;

  try {
    return await Promise.race([
      stopPromise,
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    const timeoutAction = resolveStopTimeoutAction({
      forceKillOnTimeout,
      errorMessage: error.message,
      timeoutMessage,
      hasRecordingProcess: Boolean(pythonProcess),
    });

    if (timeoutAction.shouldKillProcess && pythonProcess) {
      try {
        pythonProcess.kill();
        resetStopWorkflowState();
      } catch (killError) {
        console.warn('Failed to kill recorder after timeout:', killError.message);
      }
    }

    throw error;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function promptForForcedQuit(quitState, stopError) {
  const options = buildQuitRecordingDialogOptions({
    quitState,
    stopErrorMessage: stopError?.message,
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options);
  }

  return dialog.showMessageBox(options);
}

async function handleQuitDuringRecording(quitState) {
  if (quitWorkflowPromise) {
    return quitWorkflowPromise;
  }

  isQuitting = false;

  quitWorkflowPromise = (async () => {
    if (quitState.progressMessage) {
      sendToRenderer('recording-progress', quitState.progressMessage);
    }

    try {
      const result = await waitForRecordingStop({
        forceKillOnTimeout: false,
        timeoutMessage: 'Recorder stop is taking longer than expected.',
      });

      if (result?.audioPath) {
        await persistStoppedRecordingForQuit(result);
      }

      allowImmediateQuit = true;
      isQuitting = true;
      app.quit();
      return;
    } catch (error) {
      console.warn('Graceful quit stop failed:', error.message);
      const response = await promptForForcedQuit(quitState.state, error);

      if (response.response === 1) {
        allowImmediateQuit = true;
        isQuitting = true;
        app.quit();
        return;
      }

      isQuitting = false;
      const canceledMessage = quitState.state === 'stopping'
        ? 'Quit canceled. Saving continues.'
        : 'Quit canceled. Recording continues.';
      sendToRenderer('recording-progress', canceledMessage);
    }
  })();

  try {
    await quitWorkflowPromise;
  } finally {
    if (!allowImmediateQuit) {
      quitWorkflowPromise = null;
    }
  }
}

async function persistStoppedRecordingForQuit(recordingInfo) {
  const audioPath = recordingInfo.audioPath;
  const audioFile = path.basename(audioPath);
  const recordingsDir = path.dirname(audioPath);
  const transcriptPath = path.join(
    recordingsDir,
    `${path.basename(audioFile, path.extname(audioFile))}.md`
  );

  if (!fs.existsSync(transcriptPath)) {
    const transcriptContent = [
      '# Recording Saved Before Quit',
      '',
      `**Date:** ${new Date().toISOString()}`,
      `**Duration:** ${formatDurationForTranscript(recordingInfo.duration || 0)}`,
      '',
      'Transcription was not completed because the app quit while recording was active.',
      'Open AvaNevis again to keep this recording in history.',
      '',
    ].join('\n');

    fs.writeFileSync(transcriptPath, transcriptContent, 'utf8');
  }

  await addMeetingToHistory({
    audioPath,
    transcriptPath,
    duration: recordingInfo.duration || 0,
    language: 'unknown',
    model: 'not-transcribed',
    title: 'Recording saved before quit',
  });
}

function formatDurationForTranscript(durationSeconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationSeconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function sanitizeTranscriptionError(errorText) {
  return String(errorText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function buildTranscriptionPlaceholderMarkdown({
  audioPath,
  duration = 0,
  status = 'failed',
  errorMessage = '',
} = {}) {
  const statusLabel = status === 'pending' ? 'Pending' : 'Failed';
  const normalizedError = sanitizeTranscriptionError(errorMessage);
  const lines = [
    '# Recording Awaiting Transcription',
    '',
    `**File:** ${path.basename(String(audioPath || 'recording'))}`,
    `**Date:** ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `**Duration:** ${formatDurationForTranscript(duration)}`,
    `**Status:** Transcription ${statusLabel.toLowerCase()}`,
    '',
    'The recording was saved successfully, but a transcript is not available yet.',
    'Use Retry transcription in AvaNevis History to generate a transcript.',
  ];
  if (normalizedError) {
    lines.push('', `**Last error:** ${normalizedError}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ============================================================================
// Composition root: register extracted main-process IPC services
// ----------------------------------------------------------------------------
// These register* calls run once at module load (same timing as the inline
// ipcMain.handle registrations they replaced). Handler bodies live in
// src/main/*.js; cross-module helpers are injected via dependency objects.
// Hoisted function-declaration deps (getBackendModuleArgs, getRecordingsDir,
// assertSafe*, etc.) are safe to pass here even though they are defined lower in
// this file.
// ============================================================================
const meetingManagerClient = registerMeetingManagerClient(ipcMain, {
  app,
  path,
  spawnTrackedPython,
  pythonConfig,
  getBackendModuleArgs,
  collectPythonProcessOutput,
  appendSpawnLogBuffer,
  assertTrustedRendererSender,
  sanitizeTranscriptionError,
  getRecordingsDir,
  assertSafeExistingRecordingAudioPath,
  assertSafeExistingTranscriptPath,
  validateAiMetadataPaths,
});
const { addMeetingToHistory } = meetingManagerClient;

const deviceIpc = registerDeviceIpc(ipcMain, {
  app,
  path,
  fs,
  spawn,
  spawnTrackedPython,
  pythonConfig,
  getBackendModuleArgs,
  appendSpawnLogBuffer,
  runProcessWithTimeout,
  buildMacOSPermissionCheckFailureStatus,
  MACOS_PERMISSION_CHECK_TIMEOUT_MS,
});
const {
  checkDiskSpace,
  validateSelectedDevices,
  checkAudioOutputSupport,
  getMacOSPermissionStatus,
} = deviceIpc;

registerFileExportIpc(ipcMain, {
  app,
  path,
  fs,
  dialog,
  BrowserWindow,
  shell,
  isSafeRecordingsMarkdownPath,
  isSafeRecordingsJsonPath,
  getLegalNoticesPath,
  dirname: __dirname,
});

// ============================================================================
// Phase 3b: GPU runtime + AI add-on IPC (Pattern C)
// Depends on python-runtime + ai-compute-queue constructed above.
// Transcription/summary/recorder lifecycle handlers stay in this file (Phase 3c).
// ============================================================================

// Forward-declared helpers used by GPU/AI services (function declarations are hoisted).
function getDiarizationDependencySitePackagesPath(userDataDir) {
  return aiAddonIpc.getDiarizationDependencySitePackagesPath(userDataDir);
}

gpuRuntimeService = createGpuRuntimeService({
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
});
gpuRuntimeService.registerIpc(ipcMain);
const {
  getCachedCudaStatus,
  buildCudaRuntimeEnv,
} = gpuRuntimeService;

aiAddonIpc = createAiAddonIpc({
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
});
aiAddonIpc.registerIpc(ipcMain);
const {
  createAiAddonCancelError,
  getDiarizationDependencyEnv,
  getDiarizationCacheEnv,
  getAiAddonRuntimeOptions,
} = aiAddonIpc;


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

const transcriberModule = buildTranscriberArgs({
  platform: process.platform,
  arch: process.arch,
}).at(1);

function getTranscriberArgs(extraArgs = []) {
  return buildTranscriberArgs({
    platform: process.platform,
    arch: process.arch,
    extraArgs,
  });
}

function getBackendModuleArgs(moduleName, extraArgs = []) {
  return buildPythonModuleArgs(moduleName, extraArgs);
}

function buildDiarizationArgs({ audioPath, segmentsJsonPath, outputPath, modelRef, speakerCount, requiredDevice }) {
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

  return getBackendModuleArgs('diarization.diarization_pipeline', args);
}

function buildDiarizationValidationArgs(modelRef, requiredDevice) {
  const args = [
    '--validate-setup',
    '--model-ref', modelRef || 'pyannote/speaker-diarization-community-1',
  ];

  if (requiredDevice) {
    args.push('--require-device', requiredDevice);
  }

  return getBackendModuleArgs('diarization.diarization_pipeline', args);
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

function buildManagedDiarizationValidationArgs(modelRef, requiredDevice) {
  const args = [
    '--validate-setup',
    '--model-ref', modelRef || 'pyannote/speaker-diarization-community-1',
  ];

  if (requiredDevice) {
    args.push('--require-device', requiredDevice);
  }

  return buildManagedPythonModuleArgs(
    'diarization.diarization_pipeline',
    args,
    getDiarizationDependencySitePackagesPath(),
  );
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

function buildSummaryArgs({ meetingId, transcriptPath, runtimeDir, modelPath, outputJson, outputMarkdown, speakersJsonPath, profile, modelLabel, validateRuntime = false }) {
  const args = [
    '--meeting-id', meetingId,
    '--runtime-dir', runtimeDir,
    '--model-path', modelPath,
    '--profile', profile || 'balanced',
    '--model-label', modelLabel || 'local-summary-model',
    '--platform', process.platform,
    '--arch', process.arch,
  ];

  if (validateRuntime) {
    args.push('--validate-runtime');
  } else {
    args.push('--transcript', transcriptPath);
  }

  if (outputJson) {
    args.push('--output-json', outputJson);
  }
  if (outputMarkdown) {
    args.push('--output-markdown', outputMarkdown);
  }
  if (speakersJsonPath) {
    args.push('--speakers-json', speakersJsonPath);
  }

  return getBackendModuleArgs('summaries.summary_runner', args);
}

// Add ffmpeg to PATH so Python scripts can find it
if (!app.isPackaged) {
  // In dev mode, ffmpeg should already be in PATH
} else {
  // In production, add the bundled ffmpeg directory to PATH
  const ffmpegDir = path.dirname(pythonConfig.ffmpegPath);
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  process.env.PATH = `${ffmpegDir}${pathSeparator}${process.env.PATH}`;
}

// Suppress Python warnings to reduce console noise
process.env.PYTHONWARNINGS = 'ignore::DeprecationWarning,ignore::UserWarning';

console.log('Python Configuration:', pythonConfig);
console.log('userData path:', app.getPath('userData'));
console.log('Recordings will be saved to:', path.join(app.getPath('userData'), 'recordings'));
console.log('Transcriber module:', transcriberModule);

// ============================================================================
// Safety Checks and Verification Functions
// ============================================================================

/**
 * Helper to run a process with timeout.
 * Returns a promise that resolves with { stdout, stderr, code } or rejects on timeout/error.
 */
function runProcessWithTimeout(command, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try { proc.kill(); } catch (e) { /* ignore */ }
      }
    };

    // Set timeout
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ stdout, stderr, code: -1, timedOut: true });
    }, timeoutMs);

    let proc;
    try {
      proc = spawn(command, args);
    } catch (e) {
      clearTimeout(timeout);
      resolve({ stdout: '', stderr: e.message, code: -1, error: e });
      return;
    }

    proc.stdout.on('data', (data) => { stdout = appendSpawnLogBuffer(stdout, data); });
    proc.stderr.on('data', (data) => { stderr = appendSpawnLogBuffer(stderr, data); });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout, stderr, code: code ?? 0 });
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout, stderr, code: -1, error: err });
      }
    });
  });
}

/**
 * Verify Python executable exists and runs correctly.
 * Returns object with success status and version info.
 * GRACEFUL: Always returns, never throws. Failure is non-fatal in dev mode.
 */
async function verifyPythonInstallation() {
  try {
    const pythonPath = pythonConfig.pythonExe;

    // Check if file exists (only for packaged app)
    if (app.isPackaged && !fs.existsSync(pythonPath)) {
      return {
        success: false,
        error: `Python runtime not found at: ${pythonPath}`,
        help: 'Please reinstall the application.'
      };
    }

    const result = await runProcessWithTimeout(pythonPath, buildPythonProcessArgs(['--version']), 10000);

    if (result.timedOut) {
      return {
        success: false,
        error: 'Python check timed out',
        help: 'The Python runtime is not responding. Try restarting the application.'
      };
    }

    if (result.error) {
      return {
        success: false,
        error: `Python failed to start: ${result.error.message}`,
        help: 'The Python runtime may be missing or corrupted.'
      };
    }

    if (result.code === 0) {
      const version = (result.stdout + result.stderr).replace('Python ', '').trim();
      return { success: true, version };
    } else {
      return {
        success: false,
        error: `Python failed to start (exit code ${result.code})`,
        help: 'The Python runtime may be corrupted. Please reinstall the application.'
      };
    }
  } catch (e) {
    // Catch any unexpected errors - fail gracefully
    console.error('Unexpected error in verifyPythonInstallation:', e);
    return {
      success: false,
      error: `Unexpected error: ${e.message}`,
      help: 'An unexpected error occurred during startup checks.'
    };
  }
}

async function getActivePythonVersion() {
  const result = await runProcessWithTimeout(pythonConfig.pythonExe, buildPythonProcessArgs(['--version']), 10000);
  if (result.timedOut || result.error || result.code !== 0) {
    throw new Error(result.error ? result.error.message : 'Could not determine Python version.');
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  return {
    output,
    parsed: parsePythonVersion(output),
  };
}

/**
 * Verify FFmpeg is available for audio compression.
 * Returns object with success status.
 * GRACEFUL: Always returns, never throws. Failure is non-fatal.
 */
async function verifyFFmpegInstallation() {
  try {
    const ffmpegPath = pythonConfig.ffmpegPath;

    // Check if file exists (only for packaged app)
    if (app.isPackaged && !fs.existsSync(ffmpegPath)) {
      return {
        success: false,
        error: `FFmpeg not found at: ${ffmpegPath}`,
        help: 'Audio compression will not work. Please reinstall the application.'
      };
    }

    const result = await runProcessWithTimeout(ffmpegPath, ['-version'], 10000);

    if (result.timedOut || result.error) {
      return {
        success: false,
        error: result.timedOut ? 'FFmpeg check timed out' : `FFmpeg error: ${result.error?.message}`,
        help: 'Audio compression may not work correctly.'
      };
    }

    if (result.code === 0) {
      const versionMatch = result.stdout.match(/ffmpeg version ([^\s]+)/);
      return {
        success: true,
        version: versionMatch ? versionMatch[1] : 'unknown'
      };
    } else {
      return {
        success: false,
        error: 'FFmpeg failed to run',
        help: 'Audio compression may not work correctly.'
      };
    }
  } catch (e) {
    console.error('Unexpected error in verifyFFmpegInstallation:', e);
    return { success: false, error: `Unexpected error: ${e.message}` };
  }
}

/**
 * Check available disk space in recordings directory.
 * Returns object with available space in bytes and warnings.
 * GRACEFUL: Always returns success (with unknown space) if check fails.
 */
/**
 * Run all startup verification checks.
 * Shows dialog if critical checks fail in packaged app.
 * GRACEFUL: In dev mode, failures are warnings only. Never crashes the app.
 */
async function runStartupChecks() {
  console.log('=== Running Startup Safety Checks ===');

  try {
    // Check Python
    const pythonCheck = await verifyPythonInstallation();
    if (pythonCheck.success) {
      console.log(`✓ Python verified: ${pythonCheck.version}`);
    } else {
      console.error(`✗ Python check failed: ${pythonCheck.error}`);

      // Only fatal in packaged app - in dev mode, system Python might work
      if (app.isPackaged) {
        dialog.showErrorBox('Installation Error', `${pythonCheck.error}\n\n${pythonCheck.help}`);
        app.quit();
        return false;
      } else {
        console.warn('⚠ Continuing in dev mode despite Python check failure');
      }
    }

    // Check FFmpeg (non-fatal)
    const ffmpegCheck = await verifyFFmpegInstallation();
    if (ffmpegCheck.success) {
      console.log(`✓ FFmpeg verified: ${ffmpegCheck.version}`);
    } else {
      console.warn(`⚠ FFmpeg check failed: ${ffmpegCheck.error}`);
    }

    // Check disk space (non-fatal)
    const diskCheck = await checkDiskSpace();
    if (diskCheck.success) {
      if (diskCheck.availableGB && diskCheck.availableBytes > 0) {
        console.log(`✓ Disk space: ${diskCheck.availableGB} GB available`);
      }
      if (diskCheck.warning) {
        console.warn(`⚠ ${diskCheck.warning}`);
      }
    }

    console.log('=== Startup Checks Complete ===');
    return true;
  } catch (e) {
    // Catch any unexpected errors - don't crash the app
    console.error('Unexpected error during startup checks:', e);
    console.warn('⚠ Continuing despite startup check errors');
    return true; // Continue anyway
  }
}

// Create the system tray
function createTray() {
  // Platform-specific icon paths
  // macOS: Uses template PNG images that adapt to light/dark mode
  // Windows: Uses ICO file
  let iconPath;

  if (process.platform === 'darwin') {
    // macOS: Use template image for menu bar
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'iconTemplate.png')
      : path.join(__dirname, '../build/iconTemplate.png');
  } else {
    // Windows/Linux: Use ICO file
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.ico')
      : path.join(__dirname, '../build/icon.ico');
  }

  tray = new Tray(iconPath);

  // macOS: Mark as template image for automatic dark mode support
  if (process.platform === 'darwin') {
    tray.setImage(iconPath);  // Ensure template image is used
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide Window',
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setToolTip('AvaNevis');
  tray.setContextMenu(contextMenu);

  // Show/hide window on tray icon click
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Create the main application window
function createWindow() {
  const windowIcon = getWindowIconPath();
  const rendererEntryPath = path.join(__dirname, 'renderer', 'index.html');
  const rendererEntryUrl = pathToFileURL(rendererEntryPath).toString();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'default',
    icon: windowIcon || undefined
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openTrustedExternalUrl(url).catch((error) => {
      console.warn(error.message);
    });

    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (url === currentUrl || url === rendererEntryUrl) {
      return;
    }

    event.preventDefault();
    void openTrustedExternalUrl(url).catch((error) => {
      console.warn(error.message);
    });
  });

  // Load the HTML file
  mainWindow.loadFile(rendererEntryPath);

  // Open DevTools in development mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Prevent window from closing, minimize to tray instead
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();

      // Show dialog to ask user what they want to do
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Minimize to Tray',
        message: 'Would you like to close the app or minimize it to the system tray?',
        detail: 'Minimizing to tray keeps the app running in the background.',
        buttons: ['Minimize to Tray', 'Close App', 'Cancel'],
        defaultId: 0,
        cancelId: 2
      }).then(result => {
        if (result.response === 0) {
          // Minimize to tray
          mainWindow.hide();
        } else if (result.response === 1) {
          // Close app
          app.quit();
        }
        // Cancel does nothing
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Set up application menu
  createApplicationMenu();
}

/**
 * Create application menu with Help > Check for Updates
 */
function createApplicationMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        ...(isDevToolsEnabled() ? [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
        ] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: async () => {
            const updateInfo = await checkForUpdates();
            if (updateInfo && mainWindow) {
              sendUpdateAvailable(updateInfo);
            } else if (mainWindow) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'No Updates Available',
                message: 'You\'re up to date!',
                detail: `AvaNevis v${app.getVersion()} is the latest version.`,
                buttons: ['OK']
              });
            }
          }
        },
        { type: 'separator' },
        {
          label: 'View on GitHub',
          click: () => {
            void openTrustedExternalUrl('https://github.com/AmirArshad/meeting-transcriber').catch((error) => {
              console.warn(error.message);
            });
          }
        },
        {
          label: 'Report Issue',
          click: () => {
            void openTrustedExternalUrl('https://github.com/AmirArshad/meeting-transcriber/issues').catch((error) => {
              console.warn(error.message);
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * Preload Whisper model in background to improve first-time experience
 * Uses 'small' model by default as it balances quality and speed
 */
function preloadWhisperModel() {
  const modelSize = 'small'; // Default model size
  console.log(`Preloading Whisper model (${modelSize})...`);

  const downloadCheck = getTranscriptionModelDownloadCheck(modelSize);
  const preloadProcess = spawnTrackedPython(getTranscriberArgs([
    '--preload',
    '--model', modelSize
  ]), {
    cwd: pythonConfig.backendPath,
    env: buildTranscriptionRuntimeEnv({
      cacheDir: downloadCheck.cacheDir,
      modelCached: false,
      baseEnv: buildCudaRuntimeEnv(),
    }),
  });

  preloadProcess.stderr.on('data', (data) => {
    console.log(`[Model Preload] ${data.toString().trim()}`);
  });

  preloadProcess.on('close', (code) => {
    if (code === 0) {
      console.log('Whisper model preloaded successfully');
    } else {
      console.warn(`Model preload failed with code ${code} (non-critical)`);
    }
  });
}

/**
 * Check macOS permissions (microphone and screen recording).
 *
 * This runs asynchronously in the background and shows a notification
 * if permissions are missing. The permission prompts will be triggered
 * when the user first tries to record.
 */
function checkMacOSPermissions() {
  console.log('Checking macOS permissions...');

  const proc = spawnTrackedPython(getBackendModuleArgs('check_permissions'), {
    cwd: pythonConfig.backendPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (data) => {
    stdout = appendSpawnLogBuffer(stdout, data);
  });

  proc.stderr.on('data', (data) => {
    stderr = appendSpawnLogBuffer(stderr, data);
  });

  proc.on('close', (code) => {
    try {
      const result = JSON.parse(stdout);

      // Log permission status
      console.log('Permission check result:', result);

      // If any permission is missing, the app will still work - permissions
      // will be requested when the user first tries to use the feature
      if (!result.all_granted) {
        console.warn('Some permissions are missing - will request on first use');

        if (!result.microphone.granted) {
          console.warn('Microphone permission:', result.microphone.error);
        }

        if (!result.screen_recording.granted) {
          console.warn('Screen Recording permission:', result.screen_recording.error);
        }
      } else {
        console.log('All permissions granted!');
      }
    } catch (error) {
      // If we can't parse the result, it's not critical - permissions
      // will be requested when needed
      console.warn('Could not parse permission check result:', error);
      if (stderr) {
        console.warn('Permission check stderr:', stderr);
      }
    }
  });
}

// Initialize app
app.whenReady().then(async () => {
  // IMPORTANT: Log all app paths for debugging
  console.log('=== App Path Configuration ===');
  console.log('app.getPath("userData"):', app.getPath('userData'));
  console.log('app.getPath("appData"):', app.getPath('appData'));
  console.log('app.getPath("cache"):', app.getPath('cache'));
  console.log('app.getName():', app.getName());
  console.log('app.isPackaged:', app.isPackaged);
  console.log('process.resourcesPath:', process.resourcesPath);
  console.log('==============================');

  // Set cache paths to userData to avoid permission issues
  const cacheDir = path.join(app.getPath('userData'), 'Cache');
  app.setPath('cache', cacheDir);

  // Run startup safety checks (Python, FFmpeg, disk space)
  const checksOk = await runStartupChecks();
  if (!checksOk) {
    return; // App will quit if critical checks fail
  }
  await cleanupGuidedTranscriptTempFiles();

  createTray();
  createWindow();

  // macOS Screen Recording checks can trigger OS prompts, so they run only as
  // part of recording preflight when the user explicitly starts recording.

  // Don't preload model in background anymore - the renderer will handle it during init
  // This prevents double-downloading and gives better UX with progress feedback
  // preloadWhisperModel(); // REMOVED

  // Check for updates after app loads (5 second delay to not slow startup)
  setTimeout(async () => {
    const updateInfo = await checkForUpdates();
    if (updateInfo && mainWindow) {
      sendUpdateAvailable(updateInfo);
    }
  }, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Don't quit when all windows are closed (allow running in tray)
app.on('window-all-closed', () => {
  // Keep app running in tray even when window is closed
  // User must explicitly quit from tray menu
});

// Clean up on quit
app.on('before-quit', (event) => {
  const quitState = getQuitInterceptState({
    hasRecordingProcess: Boolean(pythonProcess),
    recordingStartTime,
    stopInProgress: Boolean(recordingStopPromise),
  });

  if (!allowImmediateQuit && quitState.interceptQuit) {
    event.preventDefault();
    void handleQuitDuringRecording(quitState);
    return;
  }

  if (!allowImmediateQuit && hasInFlightAiWork()) {
    event.preventDefault();
    void (async () => {
      await drainAiWorkBeforeQuit();
      allowImmediateQuit = true;
      app.quit();
    })();
    return;
  }

  isQuitting = true;
  abortInFlightAiWork();

  if (recordingHeartbeat) {
    clearInterval(recordingHeartbeat);
    recordingHeartbeat = null;
  }

  // Kill the main recording process
  if (pythonProcess) {
    try {
      pythonProcess.kill();
    } catch (e) {
      // Process might already be dead, ignore
    }
  }

  // Kill all other spawned Python processes
  pythonRuntime.getActiveProcesses().forEach(proc => {
    try {
      if (!proc.killed) {
        proc.kill();
      }
    } catch (e) {
      // Process might already be dead, ignore
    }
  });

  pythonRuntime.drainActiveProcesses();

  // Clean up tray
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// ============================================================================
// IPC Handlers - Communication between UI and Python backend
// ============================================================================

// Device probes (validate-devices, check-disk-space, check-audio-output,
// get-audio-devices, warm-up-audio-system, get-macos-permission-status) are
// registered by registerDeviceIpc above. run-recording-preflight stays here and
// calls the exported probe helpers (checkDiskSpace, validateSelectedDevices,
// checkAudioOutputSupport, getMacOSPermissionStatus).
ipcMain.handle('run-recording-preflight', async (event, { micId, loopbackId }) => {
  const [deviceCheck, diskCheck, audioOutputCheck, permissionCheck] = await Promise.all([
    validateSelectedDevices({ micId, loopbackId }),
    checkDiskSpace(),
    checkAudioOutputSupport(),
    getMacOSPermissionStatus(Number.isInteger(micId) ? micId : null),
  ]);

  return buildRecordingPreflightReport({
    platform: process.platform,
    deviceCheck,
    diskCheck,
    audioOutputCheck,
    permissionCheck,
  });
});

ipcMain.handle('get-pending-update-info', async () => pendingUpdateInfo);

async function removeSummarySidecarFiles(filePaths = []) {
  await Promise.all(filePaths.filter(Boolean).map((filePath) => (
    fs.promises.rm(filePath, { force: true }).catch(() => {})
  )));
}

function getRecordingsDir() {
  return path.join(app.getPath('userData'), 'recordings');
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

function assertSafeExistingRecordingAudioPath(audioPath) {
  const recordingsDir = getRecordingsDir();
  if (!isSafeRecordingsAudioPath({ filePath: audioPath, recordingsDir })) {
    throw new Error('Audio file must be in the recordings directory.');
  }

  const resolvedPath = path.resolve(audioPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error('Audio file was not found.');
  }

  return resolvedPath;
}

function assertSafeExistingSegmentsPath(segmentsJsonPath) {
  const recordingsDir = getRecordingsDir();
  if (!isSafeRecordingsJsonPath({ filePath: segmentsJsonPath, recordingsDir })) {
    throw new Error('Speaker segment file must be in the recordings directory.');
  }

  const resolvedPath = path.resolve(segmentsJsonPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error('Speaker segment file was not found.');
  }

  return resolvedPath;
}

function assertSafeExistingTranscriptPath(transcriptPath) {
  const recordingsDir = getRecordingsDir();
  if (!isSafeRecordingsMarkdownPath({ filePath: transcriptPath, recordingsDir })) {
    throw new Error('Meeting transcript must be a Markdown file in the recordings directory.');
  }

  const resolvedPath = path.resolve(transcriptPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error('Meeting transcript file was not found.');
  }

  return resolvedPath;
}

function validateAiMetadataPaths(updates = {}) {
  const recordingsDir = getRecordingsDir();
  const validated = { ...updates };

  for (const key of Object.keys(validated)) {
    if (key !== 'diarization' && key !== 'summary') {
      throw new Error('AI metadata updates may only include diarization or summary.');
    }
  }

  if (validated.diarization && typeof validated.diarization === 'object') {
    validated.diarization = { ...validated.diarization };
    if (validated.diarization.segmentsPath) {
      if (!isSafeRecordingsJsonPath({ filePath: validated.diarization.segmentsPath, recordingsDir })) {
        throw new Error('Speaker labels metadata must reference a JSON file in the recordings directory.');
      }
      validated.diarization.segmentsPath = path.resolve(validated.diarization.segmentsPath);
    }
  }

  if (validated.summary && typeof validated.summary === 'object') {
    validated.summary = { ...validated.summary };
    if (validated.summary.jsonPath) {
      if (!isSafeRecordingsJsonPath({ filePath: validated.summary.jsonPath, recordingsDir })) {
        throw new Error('Summary metadata must reference a JSON file in the recordings directory.');
      }
      validated.summary.jsonPath = path.resolve(validated.summary.jsonPath);
    }
    if (validated.summary.markdownPath) {
      if (!isSafeRecordingsMarkdownPath({ filePath: validated.summary.markdownPath, recordingsDir })) {
        throw new Error('Summary metadata must reference a Markdown file in the recordings directory.');
      }
      validated.summary.markdownPath = path.resolve(validated.summary.markdownPath);
    }
  }

  return validated;
}

function summarizeDiarizationError(errorOutput) {
  return summarizeAiBackendError({
    errorOutput,
    userDataDir: app.getPath('userData'),
    homeDir: os.homedir(),
    genericMessage: 'Speaker diarization failed.',
  });
}

function summarizeSummaryValidationError(errorOutput) {
  return summarizeAiBackendError({
    errorOutput,
    userDataDir: app.getPath('userData'),
    homeDir: os.homedir(),
    genericMessage: 'Local summary generation failed.',
  });
}

function terminateProcessBestEffort(proc) {
  if (!proc || proc.killed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(waitTimeout);
      resolve();
    };

    if (typeof proc.once === 'function') {
      proc.once('close', finish);
      proc.once('error', finish);
    }

    const waitTimeout = setTimeout(finish, 15000);
    waitTimeout.unref?.();

    try {
      if (process.platform === 'win32' && proc.pid) {
        execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
        return;
      }

      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!settled && proc && !proc.killed && typeof proc.kill === 'function') {
          try {
            proc.kill('SIGKILL');
          } catch (error) {
            // Best effort cleanup.
          }
        }
      }, 3000).unref?.();
    } catch (error) {
      finish();
    }
  });
}

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
  const model = requireAllowedModelSize(modelSize);
  return new Promise((resolve, reject) => {
    console.log(`Downloading Whisper model: ${model}`);

    const downloadCheck = getTranscriptionModelDownloadCheck(model);
    const python = spawnTrackedPython(getTranscriberArgs([
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

    let hasError = false;
    const progressRedactor = createLineChunkRedactor();

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
      flushRedactedProgress('model-download-progress', progressRedactor);
      if (code === 0) {
        console.log('Model downloaded successfully');
        resolve({ success: true });
      } else if (!hasError) {
        // Non-zero exit but no explicit error - might be OK
        console.log('Model download completed with warnings');
        resolve({ success: true });
      } else {
        reject(new Error('Failed to download model'));
      }
    });
  });
});

/**
 * Start recording with improved timeout and progress feedback
 */
ipcMain.handle('start-recording', async (event, options) => {
  assertTrustedRendererSender(event);

  if (isRecorderBusy({ pythonProcess, recordingStopPromise })) {
    return buildRecorderBusyResponse();
  }

  const sessionId = ++recordingSessionCounter;

  return new Promise((resolve, reject) => {
    const { micId, loopbackId, isFirstRecording } = options;

    // Generate unique filename with timestamp
    const timestamp = new Date().toISOString()
      .replace(/:/g, '-')  // Replace : with - for Windows compatibility
      .replace(/\..+/, ''); // Remove milliseconds
    const filename = `recording_${timestamp}.wav`;

    // Note: audio_recorder.py will compress and save as .opus, not .wav
    // But we pass .wav as the base path - the recorder will change extension
    // Use userData path which is always writable (in AppData/Roaming)
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }
    const outputPath = path.join(recordingsDir, filename);

    // FIX 1: Enable power save blocker to keep recording running
    // Platform-specific approach:
    // - macOS: Use 'prevent-app-suspension' to prevent App Nap from pausing recording
    // - Windows: Use 'prevent-display-sleep' for better battery life (Python process is separate)
    if (powerSaveId === null) {
      const isMacForPower = process.platform === 'darwin';
      const blockerType = isMacForPower ? 'prevent-app-suspension' : 'prevent-display-sleep';

      powerSaveId = powerSaveBlocker.start(blockerType);
      console.log(
        `Power save blocker enabled (${blockerType}) - recording will continue in background`
      );
    }

    // Start Python recording process (platform-specific recorder)
    // Run as module (-m) to support relative imports within the audio package
    const isMac = process.platform === 'darwin';
    const recorderModule = isMac ? 'audio.macos_recorder' : 'audio.windows_recorder';

    const proc = spawnTrackedPython([
      '-m', recorderModule,
      '--mic', micId.toString(),
      '--loopback', loopbackId.toString(),
      '--output', outputPath
    ], { cwd: pythonConfig.backendPath });
    pythonProcess = proc;

    // FIX 2 (REFINED): Set high priority for Python recording process on Windows
    // Use small delay to ensure process is fully initialized before setting priority
    if (process.platform === 'win32' && proc.pid) {
      const procPid = proc.pid;
      setTimeout(() => {
        if (pythonProcess !== proc || !procPid) {
          return;
        }

        try {
          const { exec } = require('child_process');
          exec(`wmic process where processid="${procPid}" CALL setpriority "high priority"`, (error) => {
            if (error) {
              console.warn('Failed to set high priority:', error.message);
            } else {
              console.log('Recording process set to HIGH priority');
            }
          });
        } catch (e) {
          console.warn('Could not set process priority:', e.message);
        }
      }, 100); // 100ms delay to ensure process initialization
    }

    let recordingStarted = false;
    let progressStage = 'initializing';
    let stdoutRemainder = '';
    let startupFailureMessage = null;
    let startupSettled = false;

    const sendInitProgress = (stage, message) => {
      progressStage = stage;
      mainWindow.webContents.send('recording-init-progress', { stage, message });
    };

    const settleStartupFailure = (errorMessage) => {
      if (startupSettled) {
        return;
      }

      startupSettled = true;
      if (pythonProcess === proc) {
        clearRecordingRuntimeState('recording startup failure');
      }

      resolve({
        success: false,
        code: 'STARTUP_FAILED',
        sessionId,
        message: errorMessage,
      });
    };

    const failActiveRecording = (warning) => {
      const payload = {
        type: warning.type || 'recorder_exited',
        code: warning.code || 'RECORDER_EXITED',
        message: warning.message,
        help: warning.help,
        level: warning.level || 'error',
      };

      if (pythonProcess === proc) {
        clearRecordingRuntimeState('recording failed');
      }

      sendToRenderer('recording-warning', payload);
      sendToRenderer('recording-failed', {
        sessionId,
        message: payload.message,
        code: payload.code,
        help: payload.help,
      });
      sendToRenderer('recording-progress', payload.message);
      if (payload.help) {
        sendToRenderer('recording-progress', payload.help);
      }
    };

    const sendStructuredWarning = (warning, level = 'warning') => {
      const message = warning.message || warning.error || 'Recorder warning';
      const payload = {
        type: warning.type || (warning.code ? warning.code.toLowerCase() : level),
        code: warning.code,
        message,
        help: warning.help,
        level,
      };

      mainWindow.webContents.send('recording-warning', payload);
      mainWindow.webContents.send('recording-progress', message);
      if (payload.help) {
        mainWindow.webContents.send('recording-progress', payload.help);
      }

      return payload;
    };

    const markRecordingStarted = (message = 'Recording started!') => {
      if (recordingStarted) {
        return;
      }

      recordingStarted = true;
      recordingStartTime = Date.now();

      // FIX 3: Start heartbeat monitor to detect recording failures
      lastLevelUpdate = Date.now();
      recordingHeartbeat = setInterval(() => {
        const timeSinceUpdate = Date.now() - lastLevelUpdate;

        // If no audio level updates for 10 seconds, something is wrong
        if (timeSinceUpdate > 10000 && pythonProcess === proc && !proc.killed) {
          console.error(`Recording heartbeat lost - no audio levels for ${timeSinceUpdate / 1000}s`);
          mainWindow.webContents.send('recording-warning', {
            type: 'heartbeat_lost',
            message: 'Recording may have stopped unexpectedly. No audio data received for 10+ seconds.'
          });

          // Continue monitoring - don't auto-kill, let user decide
        }
      }, 5000);

      sendInitProgress('started', message);
      startupSettled = true;
      resolve({ success: true, message: 'Recording started', sessionId });
    };

    // PERFORMANCE FIX: Throttle audio level updates to reduce IPC overhead
    // Only send updates if window is visible AND we haven't sent one recently
    let lastLevelSentTime = 0;
    const LEVEL_UPDATE_THROTTLE_MS = 100; // Max 10 updates/sec instead of 20

    proc.stdout.on('data', (data) => {
      const parsedChunk = parseRecorderStdoutChunk(data.toString(), stdoutRemainder);
      stdoutRemainder = parsedChunk.remainder;

      for (const message of parsedChunk.messages) {
        switch (message.kind) {
          case 'levels': {
            lastLevelUpdate = Date.now();

            const now = Date.now();
            const shouldSendUpdate = (now - lastLevelSentTime) >= LEVEL_UPDATE_THROTTLE_MS;

            if (shouldSendUpdate && mainWindow && !mainWindow.isMinimized() && mainWindow.isVisible()) {
              mainWindow.webContents.send('audio-levels', message.payload);
              lastLevelSentTime = now;
            }
            break;
          }

          case 'event': {
            const eventAction = getRecorderEventAction(message.payload);

            if (eventAction.initProgress) {
              sendInitProgress(eventAction.initProgress.stage, eventAction.initProgress.message);
            }

            if (eventAction.warning) {
              sendStructuredWarning(eventAction.warning);
            }

            if (eventAction.recordingStartedMessage) {
              markRecordingStarted(eventAction.recordingStartedMessage);
            } else if (eventAction.progressMessage) {
              mainWindow.webContents.send('recording-progress', eventAction.progressMessage);
            }
            break;
          }

          case 'warning':
            sendStructuredWarning(message.payload, 'warning');
            break;

          case 'error': {
            const errorPayload = sendStructuredWarning({
              code: message.payload.code,
              message: message.payload.message || message.payload.error,
              help: message.payload.help,
              type: message.payload.type,
            }, 'error');

            if (!recordingStarted && !startupFailureMessage) {
              startupFailureMessage = errorPayload.message;
            }
            progressStage = 'error';
            break;
          }

          case 'status':
            if (message.payload.message) {
              mainWindow.webContents.send('recording-progress', message.payload.message);
            }
            break;

          case 'text':
            mainWindow.webContents.send('recording-progress', message.payload.message);
            break;

          case 'result':
            break;

          case 'json':
            if (message.payload.message) {
              mainWindow.webContents.send('recording-progress', message.payload.message);
            }
            break;

          default:
            break;
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`Python status: ${output}`);
    });

    const handleProcessClosed = (code) => {
      clearTimeout(timeoutHandle);

      const closeAction = getRecorderCloseAction({
        recordingStarted,
        stopInProgress: Boolean(recordingStopPromise),
        startupSettled,
        startupFailureMessage,
        progressStage,
        exitCode: code,
      });

      if (closeAction.type === 'stop_in_progress') {
        return;
      }

      if (closeAction.type === 'startup_already_settled') {
        if (pythonProcess === proc) {
          clearRecordingRuntimeState('recording startup already settled');
        }
        return;
      }

      clearRecordingRuntimeState(
        closeAction.type === 'unexpected_exit'
          ? 'recorder exited unexpectedly'
          : 'recording failed'
      );
      recordingStarted = false;

      if (closeAction.warning) {
        failActiveRecording(closeAction.warning);
        startupSettled = true;
        return;
      }

      if (closeAction.errorMessage) {
        settleStartupFailure(closeAction.errorMessage);
      }
    };

    proc.on('close', handleProcessClosed);

    proc.on('error', (spawnError) => {
      if (proc !== pythonProcess) {
        return;
      }

      clearTimeout(timeoutHandle);

      if (recordingStopPromise) {
        return;
      }

      const wasRecording = recordingStarted;
      recordingStarted = false;
      clearRecordingRuntimeState(spawnError?.message || 'recorder process error');

      if (wasRecording) {
        failActiveRecording({
          type: 'recorder_error',
          code: 'RECORDER_PROCESS_ERROR',
          message: spawnError?.message || 'Recorder process failed.',
        });
        return;
      }

      settleStartupFailure(spawnError?.message || 'Recorder process failed to start.');
    });

    // Longer timeout for first recording (15s), shorter for subsequent (10s)
    const timeout = isFirstRecording ? 15000 : 10000;
    const timeoutHandle = setTimeout(() => {
      if (!recordingStarted) {
        let errorMessage = startupFailureMessage || `Recording failed to start within ${timeout / 1000} seconds.`;

        // Provide specific guidance based on what stage failed
        if (!startupFailureMessage && progressStage === 'initializing') {
          errorMessage += '\n\nThe audio system is taking longer than expected to initialize.';
          errorMessage += '\nThis can happen on first launch. Please try again.';
        } else if (!startupFailureMessage && progressStage === 'configuring') {
          errorMessage += '\n\nAudio device configuration is taking too long.';
          errorMessage += '\nCheck that your devices are properly connected and not in use.';
        } else if (!startupFailureMessage && (progressStage === 'mic_opened' || progressStage === 'desktop_opened')) {
          errorMessage += '\n\nAudio streams are opening but not fully ready.';
          errorMessage += '\nTry selecting different audio devices or restarting the app.';
        }

        if (pythonProcess === proc && !proc.killed) {
          proc.kill();
        }
        settleStartupFailure(errorMessage);
      }
    }, timeout);
  });
});

/**
 * Stop recording
 */
ipcMain.handle('stop-recording', async (event) => {
  assertTrustedRendererSender(event);
  return waitForRecordingStop({
    forceKillOnTimeout: true,
    timeoutMessage: 'Recording stop timeout - process took too long to finish',
  });
});

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
            resolve({ ...result, transcriptionDevice: device });
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

  const shouldPreemptiveCpuRetry = process.platform === 'win32'
    && shouldForceCpuTranscriptionFromCudaStatus(getCachedCudaStatus());

  return enqueueAiComputeAction(() => runWallClockComputeAction({
    timeoutMs: getTranscriptionComputeTimeoutMs(modelSize),
    label: 'Transcription',
    terminateProcess: terminateProcessBestEffort,
    action: async (registerProcess) => {
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
  }));
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

  return enqueueAiComputeAction(() => runWallClockComputeAction({
    timeoutMs: AI_COMPUTE_TIMEOUT_MS.guidedTranscription,
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
      HF_TOKEN: '',
      HUGGINGFACE_HUB_TOKEN: '',
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
  }));
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
  return enqueueAiComputeAction(() => runWallClockComputeAction({
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
        HF_TOKEN: '',
        HUGGINGFACE_HUB_TOKEN: '',
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
  }));
});

ipcMain.handle('generate-summary', async (event, options = {}) => {
  assertTrustedRendererSender(event);

  const { meetingId, profile, modelId } = options;
  if (!meetingId) {
    throw new Error('generate-summary requires a meetingId');
  }
  const normalizedMeetingId = String(meetingId);

  if (activeSummaryGeneration) {
    throw new Error('Summary generation is already running. Cancel it or wait for it to finish.');
  }

  const controller = new AbortController();
  activeSummaryGeneration = {
    meetingId: normalizedMeetingId,
    controller,
    phase: 'preflight',
    process: null,
  };

  const clearActiveSummaryGeneration = () => {
    if (activeSummaryGeneration && activeSummaryGeneration.controller === controller) {
      activeSummaryGeneration = null;
    }
  };

  const meeting = await new Promise((resolve, reject) => {
    let preflightSettled = false;
    let cleanupPreflightCancel = () => {};
    const finishPreflight = (callback, value) => {
      if (preflightSettled) {
        return;
      }
      preflightSettled = true;
      cleanupPreflightCancel();
      callback(value);
    };
    const cleanupCancel = (() => {
      const handleAbort = () => {
        finishPreflight(reject, createAiAddonCancelError('Summary generation was canceled.'));
      };
      controller.signal.addEventListener('abort', handleAbort, { once: true });
      return () => controller.signal.removeEventListener('abort', handleAbort);
    })();
    cleanupPreflightCancel = cleanupCancel;

    if (controller.signal.aborted) {
      finishPreflight(reject, createAiAddonCancelError('Summary generation was canceled.'));
      return;
    }

    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
      '--recordings-dir', recordingsDir,
      'get',
      normalizedMeetingId,
    ]), { cwd: pythonConfig.backendPath });
    activeSummaryGeneration.process = python;
    const preflightOutput = collectPythonProcessOutput(python, { jsonResult: true });
    python.on('close', (code) => {
      if (controller.signal.aborted) {
        finishPreflight(reject, createAiAddonCancelError('Summary generation was canceled.'));
        return;
      }
      try {
        preflightOutput.assertStdoutWithinLimit();
      } catch (error) {
        finishPreflight(reject, error);
        return;
      }
      if (code === 0) {
        try {
          finishPreflight(resolve, JSON.parse(preflightOutput.getStdout()));
        } catch (error) {
          finishPreflight(reject, new Error(`Failed to parse meeting before summary generation: ${error.message}`));
        }
        return;
      }
      finishPreflight(reject, new Error(preflightOutput.getStderr().trim() || 'Meeting not found'));
    });
    python.on('error', (error) => finishPreflight(reject, controller.signal.aborted ? createAiAddonCancelError('Summary generation was canceled.') : error));
  }).catch((error) => {
    clearActiveSummaryGeneration();
    throw error;
  });

  if (controller.signal.aborted) {
    clearActiveSummaryGeneration();
    throw createAiAddonCancelError('Summary generation was canceled.');
  }

  if (!meeting || !meeting.transcriptPath) {
    clearActiveSummaryGeneration();
    throw new Error('Meeting transcript is not available for summary generation.');
  }
  if (meeting.transcriptionStatus && meeting.transcriptionStatus !== 'completed') {
    clearActiveSummaryGeneration();
    throw new Error('Summary generation is available after transcription completes. Retry transcription from History first.');
  }

  let aiStatus;
  try {
    aiStatus = await checkAiAddonSetupStatus(getAiAddonRuntimeOptions({ verifyChecksums: true }));
  } catch (error) {
    clearActiveSummaryGeneration();
    throw error;
  }

  if (controller.signal.aborted) {
    clearActiveSummaryGeneration();
    throw createAiAddonCancelError('Summary generation was canceled.');
  }
  if (aiStatus.features.summary.status !== 'ready' || !aiStatus.features.summary.setupComplete) {
    clearActiveSummaryGeneration();
    throw new Error('Summary model setup is not ready.');
  }

  const selectedModelId = aiStatus.features.summary.modelId;
  if (modelId && modelId !== selectedModelId) {
    clearActiveSummaryGeneration();
    throw new Error('Summary model selection is managed by local setup. Validate or reinstall the selected model in Settings.');
  }
  const artifact = getSummaryArtifactForPlatform(selectedModelId, process.platform, process.arch);
  if (!artifact) {
    clearActiveSummaryGeneration();
    throw new Error('No summary model artifact is available for this platform.');
  }

  let modelPath;
  let runtimeDir;
  let transcriptPath;
  try {
    modelPath = getSummaryArtifactPath(app.getPath('userData'), artifact);
    runtimeDir = getSummaryRuntimeDir(app.getPath('userData'), artifact);
    transcriptPath = assertSafeExistingTranscriptPath(meeting.transcriptPath);
  } catch (error) {
    clearActiveSummaryGeneration();
    throw error;
  }

  const transcriptBase = transcriptPath.replace(/\.md$/i, '');
  const outputJson = `${transcriptBase}.summary.json`;
  const outputMarkdown = `${transcriptBase}.summary.md`;
  const outputJsonTemp = `${outputJson}.tmp`;
  const outputMarkdownTemp = `${outputMarkdown}.tmp`;
  const speakerMetadataPath = meeting.ai && meeting.ai.diarization && meeting.ai.diarization.segmentsPath;
  let speakersJsonPath;
  try {
    speakersJsonPath = speakerMetadataPath ? assertSafeExistingSegmentsPath(speakerMetadataPath) : null;
  } catch (error) {
    clearActiveSummaryGeneration();
    throw error;
  }

  return enqueueAiComputeAction(() => runWallClockComputeAction({
    timeoutMs: AI_COMPUTE_TIMEOUT_MS.summary,
    label: 'Summary generation',
    terminateProcess: terminateProcessBestEffort,
    action: (registerProcess) => new Promise((resolve, reject) => {
    if (!activeSummaryGeneration || activeSummaryGeneration.controller !== controller || controller.signal.aborted) {
      clearActiveSummaryGeneration();
      reject(createAiAddonCancelError('Summary generation was canceled.'));
      return;
    }

    let summarySettled = false;
    activeSummaryGeneration.phase = 'summary';
    // While assigning the actual subprocess, cancellation relies on the shared
    // AbortController. terminateProcessBestEffort is best-effort for null.
    activeSummaryGeneration.process = null;
    const python = spawnTrackedPython(buildSummaryArgs({
      meetingId: normalizedMeetingId,
      transcriptPath,
      runtimeDir,
      modelPath,
      outputJson: outputJsonTemp,
      outputMarkdown: outputMarkdownTemp,
      speakersJsonPath,
      profile: profile || 'balanced',
      modelLabel: artifact.modelLabel || artifact.modelId,
    }), { cwd: pythonConfig.backendPath, env: buildHuggingFaceOfflineEnv() });
    activeSummaryGeneration.process = python;
    registerProcess(python);

    let output = '';
    let errorOutput = '';
    const stdoutOverflow = { overflowed: false };
    const cleanupCancel = (() => {
      const handleAbort = () => {
        if (summarySettled) {
          return;
        }
        terminateProcessBestEffort(python);
      };
      controller.signal.addEventListener('abort', handleAbort, { once: true });
      return () => controller.signal.removeEventListener('abort', handleAbort);
    })();
    const finish = (callback, value) => {
      if (summarySettled) {
        return;
      }
      summarySettled = true;
      cleanupCancel();
      clearActiveSummaryGeneration();
      callback(value);
    };

    python.stdout.on('data', (data) => {
      output = appendSpawnJsonStdout(output, data, stdoutOverflow);
    });

    python.stderr.on('data', (data) => {
      const stderrChunk = data.toString();
      errorOutput = appendSpawnLogBuffer(errorOutput, stderrChunk);
      for (const line of stderrChunk.split(/\r?\n/)) {
        const progressEvent = parseAiBackendProgressLine(line, 'summary');
        if (progressEvent) {
          sendToRenderer('summary-progress', progressEvent);
        }
      }
    });

    python.on('close', async (code) => {
      const cleanupSummarySidecars = () => removeSummarySidecarFiles([
        outputJsonTemp,
        outputMarkdownTemp,
        outputJson,
        outputMarkdown,
      ]);

      try {
        if (controller.signal.aborted) {
          await cleanupSummarySidecars();
          finish(reject, createAiAddonCancelError('Summary generation was canceled.'));
          return;
        }
        if (stdoutOverflow.overflowed) {
          await cleanupSummarySidecars();
          finish(reject, new Error('Summary generation output exceeded the maximum allowed size.'));
          return;
        }
        if (code !== 0) {
          await cleanupSummarySidecars();
          finish(reject, new Error(summarizeSummaryValidationError(errorOutput)));
          return;
        }

        const result = JSON.parse(output);
        if (!result || typeof result !== 'object' || !result.metadata || typeof result.metadata !== 'object') {
          throw new Error('Summary generation returned an invalid result payload.');
        }
        if (controller.signal.aborted) {
          await cleanupSummarySidecars();
          finish(reject, createAiAddonCancelError('Summary generation was canceled.'));
          return;
        }

        await fs.promises.rename(outputJsonTemp, outputJson);
        try {
          await fs.promises.rename(outputMarkdownTemp, outputMarkdown);
        } catch (renameError) {
          await cleanupSummarySidecars();
          throw renameError;
        }

        activeSummaryGeneration.phase = 'metadata';
        const summaryMetadata = {
          status: 'completed',
          modelProfile: result.metadata.profile,
          model: result.metadata.model,
          generatedAt: result.metadata.generatedAt,
          sourceTranscriptHash: result.metadata.sourceTranscriptHash,
          jsonPath: outputJson,
          markdownPath: outputMarkdown,
          error: null,
        };

        const updatedMeeting = await new Promise((metadataResolve, metadataReject) => {
          const recordingsDir = path.join(app.getPath('userData'), 'recordings');
          const pythonUpdate = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
            '--recordings-dir', recordingsDir,
            'update-ai',
            normalizedMeetingId,
            '--summary-json', JSON.stringify(summaryMetadata),
          ]), { cwd: pythonConfig.backendPath });
          activeSummaryGeneration.process = pythonUpdate;
          registerProcess(pythonUpdate);

          let metadataOutput = '';
          let metadataErrorOutput = '';
          const metadataStdoutOverflow = { overflowed: false };
          pythonUpdate.stdout.on('data', (data) => {
            metadataOutput = appendSpawnJsonStdout(metadataOutput, data, metadataStdoutOverflow);
          });
          pythonUpdate.stderr.on('data', (data) => { metadataErrorOutput = appendSpawnLogBuffer(metadataErrorOutput, data); });
          pythonUpdate.on('close', (updateCode) => {
            if (controller.signal.aborted) {
              metadataReject(createAiAddonCancelError('Summary generation was canceled.'));
              return;
            }
            if (metadataStdoutOverflow.overflowed) {
              metadataReject(new Error('Summary metadata update output exceeded the maximum allowed size.'));
              return;
            }
            if (updateCode === 0) {
              try {
                metadataResolve(JSON.parse(metadataOutput));
              } catch (error) {
                metadataReject(new Error(`Failed to parse summary metadata update: ${error.message}`));
              }
              return;
            }
            metadataReject(new Error(summarizeSummaryValidationError(metadataErrorOutput) || 'Failed to update summary metadata'));
          });
          pythonUpdate.on('error', (error) => metadataReject(controller.signal.aborted ? createAiAddonCancelError('Summary generation was canceled.') : error));
        });

        finish(resolve, {
          ...result,
          jsonPath: outputJson,
          markdownPath: outputMarkdown,
          meeting: updatedMeeting,
        });
      } catch (error) {
        await cleanupSummarySidecars();
        finish(reject, error);
      }
    });

    python.on('error', async (error) => {
      if (summarySettled) {
        return;
      }
      await removeSummarySidecarFiles([
        outputJsonTemp,
        outputMarkdownTemp,
        outputJson,
        outputMarkdown,
      ]);
      finish(reject, controller.signal.aborted ? createAiAddonCancelError('Summary generation was canceled.') : error);
    });
  }),
  }));
});

ipcMain.handle('cancel-summary-generation', async (event, options = {}) => {
  if (!activeSummaryGeneration) {
    return { canceled: false, message: 'No summary generation is currently running.' };
  }

  const requestedMeetingId = options && options.meetingId ? String(options.meetingId) : null;
  if (requestedMeetingId && requestedMeetingId !== activeSummaryGeneration.meetingId) {
    return { canceled: false, message: 'A different meeting summary is currently running.' };
  }

  // The preflight/summary phases are safe to terminate. Once sidecars are
  // written, let the quick metadata update finish so summary files are tracked.
  if (activeSummaryGeneration.phase === 'metadata') {
    return { canceled: false, message: 'Summary output is being saved and can no longer be canceled.' };
  }

  activeSummaryGeneration.controller.abort(createAiAddonCancelError('Summary generation was canceled.'));
  terminateProcessBestEffort(activeSummaryGeneration.process);
  return { canceled: true };
});

// list-meetings, get-meeting, delete-meeting, scan-recordings, and add-meeting
// are registered by registerMeetingManagerClient above.

ipcMain.handle('retry-transcription', async (event, options = {}) => {
  assertTrustedRendererSender(event);

  const meetingId = String(options.meetingId || '').trim();
  if (!meetingId) {
    throw new Error('retry-transcription requires a meetingId');
  }

  const recordingsDir = getRecordingsDir();
  const meeting = await new Promise((resolve, reject) => {
    const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
      '--recordings-dir', recordingsDir,
      'get',
      meetingId,
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

  const shouldPreemptiveCpuRetry = process.platform === 'win32'
    && shouldForceCpuTranscriptionFromCudaStatus(getCachedCudaStatus());

  const result = await enqueueAiComputeAction(() => runWallClockComputeAction({
    timeoutMs: guidedDiarizationStatus
      ? AI_COMPUTE_TIMEOUT_MS.guidedTranscription
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
              HF_TOKEN: '',
              HUGGINGFACE_HUB_TOKEN: '',
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
  }));

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

/**
 * Update editable meeting metadata (currently: display title).
 *
 * Audio/transcript filenames stay anchored to the meeting ID; only the
 * label that the UI shows changes.
 */
// update-meeting and update-meeting-ai are registered by
// registerMeetingManagerClient above. save-transcript-file,
// save-speaker-segments-file, and save-transcript-as are registered by
// registerFileExportIpc above.

/**
 * Get platform information (for UI platform detection)
 */
ipcMain.handle('get-platform', async () => {
  return process.platform;
});

ipcMain.handle('get-arch', async () => {
  return process.arch;
});

/**
 * Open system settings (macOS only)
 * @param {string} type - 'microphone' or 'screen'
 */
ipcMain.handle('open-system-settings', async (event, type) => {
  if (process.platform === 'darwin') {
    const urls = {
      'privacy': 'x-apple.systempreferences:com.apple.preference.security?Privacy',
      'microphone': 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      'screen': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    };
    await openTrustedExternalUrl(urls[type] || urls.microphone);
    return { success: true };
  }
  return { success: false, error: 'Only supported on macOS' };
});

/**
 * Get system info (versions)
 */
ipcMain.handle('get-system-info', async () => {
  return new Promise((resolve) => {
    const python = spawnTrackedPython(['--version']);

    let pythonVersion = '';

    python.stdout.on('data', (data) => {
      pythonVersion += data.toString();
    });

    python.stderr.on('data', (data) => {
      pythonVersion += data.toString();
    });

    python.on('close', () => {
      resolve({
        app: app.getVersion(),
        electron: process.versions.electron,
        python: pythonVersion.replace('Python ', '').trim()
      });
    });
  });
});

// open-legal-notices is registered by registerFileExportIpc above.
// check-gpu / check-cuda / install-gpu / ensure-compatible-gpu-runtime /
// uninstall-gpu are registered by createGpuRuntimeService above.

/**
 * Open update download page in browser
 */
ipcMain.handle('download-update', async (event) => {
  assertTrustedRendererSender(event);

  if (!pendingUpdateInfo || !pendingUpdateInfo.downloadUrl) {
    throw new Error('No pending update is available to download.');
  }

  await openDownloadPage(pendingUpdateInfo.downloadUrl);
  return { success: true };
});

console.log('AvaNevis - Main process started');
