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
const { createTranscriptionService } = require('./main/transcription-service');
const { createSummaryService } = require('./main/summary-service');
const { createRecorderService } = require('./main/recorder-service');

// Use Electron's default userData path, which handles packaging correctly
// This is typically: C:\Users\<username>\AppData\Roaming\AvaNevis
// No need to set a custom path - Electron manages this properly

let mainWindow;
let tray = null;
let isQuitting = false;
let quitWorkflowPromise = null;
let allowImmediateQuit = false;
let pendingUpdateInfo = null;
// Assigned at composition root after services are constructed.
let aiAddonIpc = null;
let gpuRuntimeService = null;
let summaryService = null;
let transcriptionService = null;
let recorderService = null;

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
    || (summaryService ? summaryService.hasActiveSummaryGeneration() : false)
    || aiComputeActionQueue.hasPendingWork();
}

function abortInFlightAiSetup() {
  if (aiAddonIpc) {
    aiAddonIpc.abortInFlightAiSetup();
  }
}

function abortInFlightAiWork() {
  abortInFlightAiSetup();
  if (summaryService) {
    summaryService.abortActiveSummaryForQuit('Summary generation was canceled because the app is quitting.');
  }
}

async function drainAiWorkBeforeQuit() {
  const metadataPhaseActive = summaryService
    && summaryService.getActiveSummaryPhase() === 'metadata';

  abortInFlightAiSetup();
  if (summaryService) {
    summaryService.abortActiveSummaryForQuit('Summary generation was canceled because the app is quitting.');
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

// ============================================================================
// Phase 3c: transcription + summary + recorder lifecycle (Pattern C)
// ============================================================================
transcriptionService = createTranscriptionService({
  app,
  path,
  fs,
  os,
  pythonConfig,
  spawnTrackedPython,
  getBackendModuleArgs,
  enqueueAiComputeAction,
  getCachedCudaStatus,
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
});
transcriptionService.registerIpc(ipcMain);
const { cleanupGuidedTranscriptTempFiles, preloadWhisperModel } = transcriptionService;

summaryService = createSummaryService({
  app,
  path,
  fs,
  pythonConfig,
  spawnTrackedPython,
  getBackendModuleArgs,
  enqueueAiComputeAction,
  createAiAddonCancelError,
  getAiAddonRuntimeOptions,
  buildSummaryArgs,
  collectPythonProcessOutput,
  sendToRenderer,
  appendSpawnLogBuffer,
  appendSpawnJsonStdout,
  assertTrustedRendererSender,
  getRecordingsDir,
  assertSafeExistingTranscriptPath,
  assertSafeExistingSegmentsPath,
  terminateProcessBestEffort,
  summarizeSummaryValidationError,
});
summaryService.registerIpc(ipcMain);

recorderService = createRecorderService({
  app,
  path,
  fs,
  dialog,
  powerSaveBlocker,
  pythonConfig,
  spawnTrackedPython,
  sendToRenderer,
  assertTrustedRendererSender,
  getMainWindow: () => mainWindow,
  setIsQuitting: (value) => { isQuitting = value; },
  getAllowImmediateQuit: () => allowImmediateQuit,
  setAllowImmediateQuit: (value) => { allowImmediateQuit = value; },
  getQuitWorkflowPromise: () => quitWorkflowPromise,
  setQuitWorkflowPromise: (value) => { quitWorkflowPromise = value; },
  validateSelectedDevices,
  checkDiskSpace,
  checkAudioOutputSupport,
  getMacOSPermissionStatus,
  addMeetingToHistory,
  formatDurationForTranscript,
  getRecordingsDir,
});
recorderService.registerIpc(ipcMain);

function getBackendModuleArgs(moduleName, extraArgs = []) {
  return buildPythonModuleArgs(moduleName, extraArgs);
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
  const quitState = getQuitInterceptState(
    recorderService
      ? recorderService.getQuitInterceptInputs()
      : { hasRecordingProcess: false, recordingStartTime: null, stopInProgress: false },
  );

  if (!allowImmediateQuit && quitState.interceptQuit) {
    event.preventDefault();
    void recorderService.handleQuitDuringRecording(quitState);
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

  if (recorderService) {
    recorderService.forceKillRecordingOnShutdown();
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
// run-recording-preflight is registered by createRecorderService above.

ipcMain.handle('get-pending-update-info', async () => pendingUpdateInfo);ipcMain.handle('get-pending-update-info', async () => pendingUpdateInfo);

function getRecordingsDir() {
  return path.join(app.getPath('userData'), 'recordings');
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

// check-model-downloaded / download-model / start-recording / stop-recording are registered by
// createTranscriptionService / createRecorderService above.

// Transcription / diarization IPC handlers are registered by createTranscriptionService above.

// generate-summary / cancel-summary-generation are registered by createSummaryService above.

// retry-transcription is registered by createTranscriptionService above.

/**
 * Update editable meeting metadata (currently: display title).
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
