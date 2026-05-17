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
  buildPythonModuleArgs,
  buildTranscriberArgs,
  buildTranscriptionCudaInstallArgs,
  buildTranscriptionCudaUninstallArgs,
  buildUnsupportedCudaPythonMessage,
  getPythonSitePackagesCandidates,
  getPyTorchCudaBinCandidates,
  cacheContainsModel,
  getQuitInterceptState,
  getRecorderCloseAction,
  getRecorderEventAction,
  getRecordingStopTimeout,
  findRecorderResultPayload,
  resolveStopTimeoutAction,
  isModelDownloadErrorOutput,
  isSafeRecordingsAudioPath,
  isSafeRecordingsJsonPath,
  isSafeRecordingsMarkdownPath,
  isSupportedCudaInstallPythonVersion,
  parseRecorderStdoutChunk,
  parsePythonVersion,
  parseAiBackendProgressLine,
  resolveExternalUrl,
  resolveTranscriptionAudioFile,
  summarizeAiBackendError,
  TRANSCRIPTION_CUDA_PACKAGES,
  MACOS_PERMISSION_CHECK_TIMEOUT_MS,
} = require('./main-process-helpers');
const { checkForUpdates, openDownloadPage } = require('./updater');
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
} = require('./ai-addon-setup');
const {
  getDiarizationAvailability,
  getDiarizationModelRef,
  getSummaryArtifactForPlatform,
} = require('./ai-addon-state');
const {
  TOKEN_KEYS,
  deleteAiAddonToken,
  getAiAddonToken,
  hasAiAddonToken,
  isTokenEncryptionAvailable,
  storeAiAddonToken,
} = require('./ai-addon-token-store');

// Use Electron's default userData path, which handles packaging correctly
// This is typically: C:\Users\<username>\AppData\Roaming\AvaNevis
// No need to set a custom path - Electron manages this properly

let mainWindow;
let pythonProcess;
let recordingStartTime = null;
let activeProcesses = []; // Track all spawned Python processes for cleanup
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
let diarizationDependencySitePackagesCache = null;

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

function parseRecordingStopResult(stdoutData) {
  const recordingInfo = findRecorderResultPayload(stdoutData);

  if (recordingInfo) {
    const filePath = recordingInfo.audioPath || recordingInfo.outputPath;

    if (filePath && fs.existsSync(filePath)) {
      return {
        success: true,
        audioPath: filePath,
        duration: recordingInfo.duration,
        desktopDiagnostics: recordingInfo.desktopDiagnostics,
      };
    }

    throw new Error(`Recording file not found: ${filePath}`);
  }

  const recordingsDir = path.join(app.getPath('userData'), 'recordings');
  const opusPath = path.join(recordingsDir, 'temp.opus');

  if (fs.existsSync(opusPath)) {
    return { success: true, audioPath: opusPath };
  }

  throw new Error('Recording completed but output file not found.');
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
      stdoutData += data.toString();
    };

    const stderrHandler = (data) => {
      const output = data.toString();
      stderrData += output;
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
          resolve(parseRecordingStopResult(stdoutData));
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

function addMeetingToHistory(meetingData) {
  return new Promise((resolve, reject) => {
    const { audioPath, transcriptPath, duration, language, model, title } = meetingData;
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const args = getBackendModuleArgs('meeting_manager', [
      '--recordings-dir', recordingsDir,
      'add',
      '--audio', audioPath,
      '--transcript', transcriptPath,
      '--duration', String(duration || 0),
      '--language', language || 'en',
      '--model', model || 'unknown'
    ]);

    if (title) {
      args.push('--title', title);
    }

    const python = spawnTrackedPython(args, { cwd: pythonConfig.backendPath });

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(output));
        } catch (error) {
          reject(new Error(`Failed to parse saved meeting: ${error.message}`));
        }
        return;
      }

      reject(new Error(`Failed to save meeting: ${errorOutput.trim() || 'Unknown error'}`));
    });

    python.on('error', reject);
  });
}

// ============================================================================
// Python Process Management
// ============================================================================

/**
 * Helper to spawn and track Python processes for cleanup
 * 
 * NOTE: Sets PYTHONPATH environment variable for development mode where system
 * Python is used. For production builds with embedded Python, the .pth file is
 * modified in build/prepare-resources.js to include the backend path, as embedded
 * Python ignores the PYTHONPATH environment variable.
 */
function spawnTrackedPython(args, options = {}) {
  // Merge our environment with any options.env provided by caller
  const mergedOptions = {
    ...options,
    env: buildPythonEnv(options.env || {})
  };
  
  const proc = spawn(pythonConfig.pythonExe, buildPythonProcessArgs(args), mergedOptions);
  activeProcesses.push(proc);

  // Auto-remove from tracking when process exits
  proc.on('close', () => {
    const index = activeProcesses.indexOf(proc);
    if (index > -1) {
      activeProcesses.splice(index, 1);
    }
  });

  return proc;
}

// ============================================================================
// Python Runtime Configuration
// ============================================================================

/**
 * Determine the correct Python executable and backend path based on environment
 * In production (packaged app), use bundled Python
 * In development, use system Python
 */
function getPythonConfig() {
  const isDev = !app.isPackaged;
  const isMac = process.platform === 'darwin';

  if (isDev) {
    const explicitPython = process.env.AVANEVIS_PYTHON || null;
    const venvPython = process.env.VIRTUAL_ENV
      ? path.join(process.env.VIRTUAL_ENV, isMac ? 'bin' : 'Scripts', isMac ? 'python3' : 'python.exe')
      : null;
    const repoVenvPython = path.join(__dirname, '..', '.venv', isMac ? 'bin' : 'Scripts', isMac ? 'python3' : 'python.exe');
    const detectedVenvPython = venvPython || (fs.existsSync(repoVenvPython) ? repoVenvPython : null);

    // Development mode - use system Python
    return {
      pythonExe: explicitPython || detectedVenvPython || (isMac ? 'python3' : 'python'),
      pythonArgsPrefix: [],
      backendPath: path.join(__dirname, '../backend'),
      ffmpegPath: 'ffmpeg' // Assume in PATH
    };
  } else {
    // Production mode - use bundled Python
    const resourcesPath = process.resourcesPath;

    if (isMac) {
      // macOS: Use bundled Python from resources/python/bin/
      return {
        pythonExe: path.join(resourcesPath, 'python', 'bin', 'python3'),
        pythonArgsPrefix: [],
        backendPath: path.join(resourcesPath, 'backend'),
        ffmpegPath: path.join(resourcesPath, 'ffmpeg', 'ffmpeg')
      };
    } else {
      // Windows: Use bundled Python from resources/python/
      return {
        pythonExe: path.join(resourcesPath, 'python', 'python.exe'),
        pythonArgsPrefix: [],
        backendPath: path.join(resourcesPath, 'backend'),
        ffmpegPath: path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe')
      };
    }
  }
}

const pythonConfig = getPythonConfig();

function buildPythonProcessArgs(args = []) {
  return [...(pythonConfig.pythonArgsPrefix || []), ...args];
}

function buildPythonEnv(extra = {}) {
  const { PYTHONPATH: extraPythonPath, ...restExtra } = extra || {};
  const basePythonPath = pythonConfig.backendPath + (process.env.PYTHONPATH ?
    (process.platform === 'win32' ? ';' : ':') + process.env.PYTHONPATH : '');
  const separator = process.platform === 'win32' ? ';' : ':';

  return {
    ...process.env,
    ...restExtra,
    PYTHONPATH: extraPythonPath ? `${extraPythonPath}${separator}${basePythonPath}` : basePythonPath,
  };
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

function getTranscriptionCudaPackages() {
  return [...TRANSCRIPTION_CUDA_PACKAGES];
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

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

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
async function checkDiskSpace() {
  try {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');

    // Ensure directory exists
    if (!fs.existsSync(recordingsDir)) {
      try {
        fs.mkdirSync(recordingsDir, { recursive: true });
      } catch (e) {
        // Non-fatal - directory will be created later when needed
        console.warn('Could not create recordings directory:', e.message);
        return { success: true, availableBytes: -1, warning: null };
      }
    }

    if (process.platform === 'win32') {
      // Windows: Use wmic to get free space
      const drive = recordingsDir.split(':')[0] + ':';
      const result = await runProcessWithTimeout(
        'wmic',
        ['logicaldisk', 'where', `DeviceID="${drive}"`, 'get', 'FreeSpace', '/value'],
        5000
      );

      if (result.code === 0 && !result.timedOut) {
        const match = result.stdout.match(/FreeSpace=(\d+)/);
        if (match) {
          const freeBytes = parseInt(match[1], 10);
          const freeGB = freeBytes / (1024 * 1024 * 1024);
          return {
            success: true,
            availableBytes: freeBytes,
            availableGB: freeGB.toFixed(2),
            warning: freeBytes < 500 * 1024 * 1024 ? 'Low disk space (< 500MB)' : null
          };
        }
      }
      // Fall through to return unknown
    } else {
      // macOS/Linux: Use df command
      const result = await runProcessWithTimeout('df', ['-k', recordingsDir], 5000);

      if (result.code === 0 && !result.timedOut) {
        const lines = result.stdout.trim().split('\n');
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          if (parts.length >= 4) {
            const freeKB = parseInt(parts[3], 10);
            const freeBytes = freeKB * 1024;
            const freeGB = freeBytes / (1024 * 1024 * 1024);
            return {
              success: true,
              availableBytes: freeBytes,
              availableGB: freeGB.toFixed(2),
              warning: freeBytes < 500 * 1024 * 1024 ? 'Low disk space (< 500MB)' : null
            };
          }
        }
      }
    }

    // Unknown disk space - assume OK
    return { success: true, availableBytes: -1, warning: null };
  } catch (e) {
    console.error('Unexpected error in checkDiskSpace:', e);
    return { success: true, availableBytes: -1, warning: null };
  }
}

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
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
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

  const preloadProcess = spawnTrackedPython(getTranscriberArgs([
    '--preload',
    '--model', modelSize
  ]), { cwd: pythonConfig.backendPath, env: buildCudaRuntimeEnv() });

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
    stdout += data.toString();
  });

  proc.stderr.on('data', (data) => {
    stderr += data.toString();
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

function getMacOSPermissionStatus(micId = null) {
  if (process.platform !== 'darwin') {
    return Promise.resolve({
      platform: process.platform,
      all_granted: true,
      microphone: { granted: true },
      screen_recording: { granted: true },
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeoutHandle = null;
    const args = Number.isInteger(micId)
      ? getBackendModuleArgs('check_permissions', ['--mic-device-id', String(micId), '--skip-screen-recording-check'])
      : getBackendModuleArgs('check_permissions', ['--skip-screen-recording-check']);

    const proc = spawnTrackedPython(args, {
      cwd: pythonConfig.backendPath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const settle = (status) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve(status);
    };

    timeoutHandle = setTimeout(() => {
      console.warn('macOS permission status check timed out');
      try {
        proc.kill();
      } catch (error) {
        console.warn('Failed to kill timed-out macOS permission check:', error.message);
      }
      settle(buildMacOSPermissionCheckFailureStatus('macOS permission checks timed out before recording.'));
    }, MACOS_PERMISSION_CHECK_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      if (settled) {
        return;
      }

      try {
        settle(JSON.parse(stdout));
      } catch (error) {
        console.warn('Failed to parse permission status:', error.message);
        if (stderr.trim()) {
          console.warn('Permission status stderr:', stderr.trim());
        }
        settle(buildMacOSPermissionCheckFailureStatus('Could not verify macOS permissions before recording.'));
      }
    });

    proc.on('error', (error) => {
      if (settled) {
        return;
      }

      console.warn('Permission status check failed:', error.message);
      settle(buildMacOSPermissionCheckFailureStatus('Could not run macOS permission checks before recording.'));
    });
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

  isQuitting = true;

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
  activeProcesses.forEach(proc => {
    try {
      if (!proc.killed) {
        proc.kill();
      }
    } catch (e) {
      // Process might already be dead, ignore
    }
  });

  activeProcesses = [];

  // Clean up tray
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// ============================================================================
// IPC Handlers - Communication between UI and Python backend
// ============================================================================

/**
 * Validate audio devices before recording.
 * Checks that selected devices exist and are accessible.
 * GRACEFUL: Returns valid=true with warning if check fails, allowing recording to proceed.
 */
function validateSelectedDevices({ micId, loopbackId }) {
  const TIMEOUT_MS = 10000; // 10 second timeout

  return new Promise((resolve) => {
    let resolved = false;
    let output = '';
    let errorOutput = '';

    // Timeout handler
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { python.kill(); } catch (e) { /* ignore */ }
        console.warn('validate-devices timed out - allowing recording to proceed');
        resolve({
          valid: true, // Allow recording to proceed
          warnings: ['Device validation timed out - proceeding anyway'],
          errors: []
        });
      }
    }, TIMEOUT_MS);

    let python;
    try {
      python = spawnTrackedPython(getBackendModuleArgs('device_manager'), { cwd: pythonConfig.backendPath });
    } catch (e) {
      clearTimeout(timeout);
      console.error('Failed to spawn device_manager module:', e);
      resolve({
        valid: true, // Allow recording to proceed
        warnings: ['Could not validate devices - proceeding anyway'],
        errors: []
      });
      return;
    }

    python.stdout.on('data', (data) => { output += data.toString(); });
    python.stderr.on('data', (data) => { errorOutput += data.toString(); });

    python.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      if (code !== 0) {
        console.warn('validate-devices failed with code', code);
        resolve({
          valid: true, // Allow recording to proceed
          warnings: ['Device enumeration failed - proceeding anyway'],
          errors: []
        });
        return;
      }

      try {
        const data = JSON.parse(output);
        const errors = [];
        const warnings = [];

        // Check microphone device
        const micDevice = data.input_devices.find(d => d.id === micId);
        if (!micDevice) {
          errors.push(`Microphone device (ID: ${micId}) not found. It may have been disconnected.`);
        }

        // Check loopback device (platform-specific)
        if (process.platform === 'darwin') {
          // macOS: loopbackId -1 means ScreenCaptureKit (virtual)
          if (loopbackId !== -1) {
            warnings.push('Non-standard loopback device selected on macOS.');
          }
        } else {
          // Windows: Check loopback device exists
          const loopbackDevice = data.loopback_devices.find(d => d.id === loopbackId);
          if (loopbackId >= 0 && !loopbackDevice) {
            errors.push(`Desktop audio device (ID: ${loopbackId}) not found. It may have been disconnected.`);
          }
        }

        resolve({
          valid: errors.length === 0,
          errors,
          warnings,
          devices: {
            mic: micDevice || null,
            loopback: loopbackId === -1 ? { name: 'System Audio (ScreenCaptureKit)', id: -1 } :
                      data.loopback_devices.find(d => d.id === loopbackId) || null
          }
        });
      } catch (e) {
        console.warn('Failed to parse device list:', e);
        resolve({
          valid: true, // Allow recording to proceed
          warnings: ['Could not parse device list - proceeding anyway'],
          errors: []
        });
      }
    });

    python.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      console.error('validate-devices error:', err);
      resolve({
        valid: true, // Allow recording to proceed
        warnings: ['Device validation error - proceeding anyway'],
        errors: []
      });
    });
  });
}

ipcMain.handle('validate-devices', async (event, options) => {
  return validateSelectedDevices(options);
});

/**
 * Check disk space before recording.
 * Returns available space and warnings.
 */
ipcMain.handle('check-disk-space', async () => {
  return await checkDiskSpace();
});

/**
 * Inspect the current macOS audio output device for diagnostics only.
 *
 * ScreenCaptureKit is expected to capture system audio before routing to the
 * active output device, but we still surface the current output target so
 * manual validation can confirm behavior on real hardware.
 */
function checkAudioOutputSupport() {
  if (process.platform !== 'darwin') {
    // Windows WASAPI loopback works with all devices
    return { supported: true, warning: null };
  }

  const TIMEOUT_MS = 5000; // 5 second timeout

  return new Promise((resolve) => {
    let resolved = false;
    let output = '';

    // Timeout handler
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { proc.kill(); } catch (e) { /* ignore */ }
        console.warn('check-audio-output timed out');
        resolve({ supported: true, warning: null }); // Assume OK
      }
    }, TIMEOUT_MS);

    let proc;
    try {
      // Use system_profiler to get audio output info
      proc = spawn('system_profiler', ['SPAudioDataType', '-json']);
    } catch (e) {
      clearTimeout(timeout);
      console.error('Failed to spawn system_profiler:', e);
      resolve({ supported: true, warning: null }); // Assume OK
      return;
    }

    proc.stdout.on('data', (data) => { output += data.toString(); });

    proc.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);

      if (code !== 0) {
        resolve({ supported: true, warning: null }); // Unknown, assume OK
        return;
      }

      try {
        const data = JSON.parse(output);
        const audioData = data.SPAudioDataType || [];

        let deviceName = null;
        let deviceTransport = null;

        for (const section of audioData) {
          const items = section._items || [];
          for (const item of items) {
            // Check for default output device
            if (item.coreaudio_default_audio_output_device === 'spaudio_yes') {
              deviceName = item._name;
              deviceTransport = item.coreaudio_device_transport || null;
            }
          }
        }

        resolve({
          supported: true,
          warning: null,
          deviceName,
          deviceTransport,
        });
      } catch (e) {
        resolve({ supported: true, warning: null }); // Parse error, assume OK
      }
    });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      console.error('check-audio-output error:', err);
      resolve({ supported: true, warning: null });
    });
  });
}

ipcMain.handle('check-audio-output', async () => {
  return checkAudioOutputSupport();
});

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

ipcMain.handle('get-macos-permission-status', async () => {
  return getMacOSPermissionStatus();
});

ipcMain.handle('get-pending-update-info', async () => pendingUpdateInfo);

function emitAiAddonProgress(payload) {
  sendToRenderer(AI_ADDON_PROGRESS_CHANNEL, payload);
}

function createAiAddonCancelError(message = 'AI add-on setup was canceled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = AI_ADDON_CANCEL_CODE;
  return error;
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

function createAsyncActionQueue() {
  let tail = Promise.resolve();

  return function enqueue(action) {
    const run = tail.then(action, action);
    tail = run.catch(() => {});
    return run;
  };
}

const enqueueAiAddonAction = createAsyncActionQueue();
const enqueueAiComputeAction = createAsyncActionQueue();
const aiAddonSetupAbortControllers = new Map();

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

function validateDiarizationRuntime({ modelRef, token, requiredDevice, cancelSignal }) {
  clearDiarizationDependencySitePackagesCache();
  const resolvedToken = token || getAiAddonToken({
    userDataDir: app.getPath('userData'),
    tokenKey: TOKEN_KEYS.diarizationHuggingFace,
    safeStorage: getSafeStorage(),
  });

  return createAbortableComputeAction({
    cancelSignal,
    cancelMessage: 'Speaker identification setup was canceled.',
    action: () => new Promise((resolve, reject) => {
      if (cancelSignal && cancelSignal.aborted) {
        reject(createAiAddonCancelError('Speaker identification setup was canceled.'));
        return;
      }

      const python = spawnTrackedPython(buildManagedDiarizationValidationArgs(modelRef, requiredDevice), {
        cwd: pythonConfig.backendPath,
        env: {
          ...getDiarizationDependencyEnv(),
          ...getDiarizationCacheEnv(),
          ...buildCudaRuntimeEnv({}, { includeManagedDiarization: true }),
          HF_TOKEN: resolvedToken || '',
          HUGGINGFACE_HUB_TOKEN: resolvedToken || '',
        },
      });

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
      python.stdout.on('data', (data) => { output += data.toString(); });
      python.stderr.on('data', (data) => {
        const stderrChunk = data.toString();
        errorOutput += stderrChunk;
        for (const line of stderrChunk.split(/\r?\n/)) {
          const progressEvent = parseAiBackendProgressLine(line, 'diarization');
          if (progressEvent) {
            emitAiAddonProgress(progressEvent);
          }
        }
      });
      python.on('close', (code) => {
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
    return;
  }

  try {
    if (process.platform === 'win32' && proc.pid) {
      execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
      return;
    }

    proc.kill();
  } catch (error) {
    // Best effort cleanup.
  }
}

function createAbortableComputeAction({ cancelSignal, cancelMessage, action, waitTimeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    if (cancelSignal && cancelSignal.aborted) {
      reject(createAiAddonCancelError(cancelMessage));
      return;
    }

    let started = false;
    let settled = false;
    let waitTimer = null;
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (waitTimer) {
        clearTimeout(waitTimer);
      }
      cleanup();
      callback(value);
    };
    const cleanup = cancelSignal && typeof cancelSignal.addEventListener === 'function'
      ? (() => {
        const handleAbort = () => {
          if (settled) {
            return;
          }
          if (!started) {
            settle(reject, createAiAddonCancelError(cancelMessage));
          }
        };
        cancelSignal.addEventListener('abort', handleAbort, { once: true });
        return () => cancelSignal.removeEventListener('abort', handleAbort);
      })()
      : () => {};

    if (waitTimeoutMs > 0) {
      waitTimer = setTimeout(() => {
        if (!settled && !started) {
          settle(reject, new Error('Local AI setup validation is waiting for another AI job to finish. Try again after the current summary or speaker identification job completes.'));
        }
      }, waitTimeoutMs);
      waitTimer.unref?.();
    }

    enqueueAiComputeAction(async () => {
      // If waitTimeoutMs rejected while this was queued, the queue still drains
      // this no-op slot so later AI work is not blocked behind a stale action.
      if (settled) {
        return;
      }
      started = true;
      if (waitTimer) {
        clearTimeout(waitTimer);
        waitTimer = null;
      }
      try {
        const result = await action();
        settle(resolve, result);
      } catch (error) {
        settle(reject, error);
      }
    });
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
    action: () => new Promise((resolve, reject) => {
      if (cancelSignal && cancelSignal.aborted) {
        reject(createAiAddonCancelError('Summary model setup was canceled.'));
        return;
      }

      const python = spawnTrackedPython(buildSummaryArgs({
        meetingId: 'setup-validation',
        runtimeDir,
        modelPath,
        validateRuntime: true,
        modelLabel: artifact.modelLabel || artifact.modelId,
      }), { cwd: pythonConfig.backendPath });

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
      python.stdout.on('data', (data) => { output += data.toString(); });
      python.stderr.on('data', (data) => { errorOutput += data.toString(); });
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
}

function getAiAddonRuntimeOptions(extra = {}) {
  const options = {
    userDataDir: app.getPath('userData'),
    platform: process.platform,
    arch: process.arch,
    emitProgress: emitAiAddonProgress,
    ...extra,
  };

  if (extra.includeSafeStorage) {
    options.safeStorage = getSafeStorage();
    delete options.includeSafeStorage;
  }

  return options;
}

ipcMain.handle('get-ai-addon-status', async (event, options = {}) => checkAiAddonSetupStatus({
  userDataDir: app.getPath('userData'),
  platform: process.platform,
  arch: process.arch,
  includeStorageSizes: Boolean(options && options.includeStorageSizes),
  verifyChecksums: Boolean(options && options.verifyChecksums),
  checkTokenEncryption: false,
}));

ipcMain.handle('store-diarization-token', async (event, token) => storeAiAddonToken({
  userDataDir: app.getPath('userData'),
  tokenKey: TOKEN_KEYS.diarizationHuggingFace,
  token,
  safeStorage: getSafeStorage(),
}));

ipcMain.handle('get-diarization-token-status', async () => ({
  hasToken: hasAiAddonToken({
    userDataDir: app.getPath('userData'),
    tokenKey: TOKEN_KEYS.diarizationHuggingFace,
  }),
  encryptionAvailable: isTokenEncryptionAvailable({ safeStorage: getSafeStorage() }),
}));

ipcMain.handle('delete-diarization-token', async () => deleteAiAddonToken({
  userDataDir: app.getPath('userData'),
  tokenKey: TOKEN_KEYS.diarizationHuggingFace,
}));

ipcMain.handle('setup-diarization', async (event, options = {}) => runCancellableAiAddonSetup('diarization', (cancelSignal) => setupDiarizationAddon(getAiAddonRuntimeOptions({
  includeSafeStorage: true,
  modelId: options.modelId,
  speakerCount: options.speakerCount,
  token: options.token,
  pythonExe: pythonConfig.pythonExe,
  runtimeValidator: validateDiarizationRuntime,
  cancelSignal,
}))));

ipcMain.handle('cancel-diarization-setup', async () => cancelAiAddonSetup('diarization'));

ipcMain.handle('validate-diarization-setup', async () => {
  if (aiAddonSetupAbortControllers.has('diarization')) {
    throw new Error('Speaker identification setup is already running. Cancel it or wait for it to finish before validating.');
  }

  return enqueueAiAddonAction(() => validateDiarizationSetup(getAiAddonRuntimeOptions({
    includeSafeStorage: true,
    runtimeValidator: validateDiarizationRuntime,
  })));
});

ipcMain.handle('remove-diarization-setup', async () => {
  if (aiAddonSetupAbortControllers.has('diarization')) {
    throw new Error('Speaker identification setup is already running. Cancel it before removing setup.');
  }

  return enqueueAiAddonAction(async () => {
    try {
      return await removeDiarizationSetup(getAiAddonRuntimeOptions());
    } finally {
      clearDiarizationDependencySitePackagesCache();
    }
  });
});

ipcMain.handle('setup-summary-model', async (event, options = {}) => runCancellableAiAddonSetup('summary', (cancelSignal) => setupSummaryModel(getAiAddonRuntimeOptions({
  modelId: options.modelId,
  profile: options.profile,
  pythonExe: pythonConfig.pythonExe,
  backendPath: pythonConfig.backendPath,
  runtimeValidator: validateSummaryRuntimeSmoke,
  cancelSignal,
}))));

ipcMain.handle('cancel-summary-model-setup', async () => cancelAiAddonSetup('summary'));

ipcMain.handle('validate-summary-model', async (event, options = {}) => {
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
  if (aiAddonSetupAbortControllers.has('summary')) {
    throw new Error('Summary model setup is already running. Cancel it before removing the model.');
  }

  return enqueueAiAddonAction(() => removeSummaryModel(getAiAddonRuntimeOptions({
    modelId: options.modelId,
  })));
});

/**
 * Get list of available audio devices
 */
ipcMain.handle('get-audio-devices', async () => {
  return new Promise((resolve, reject) => {
    const python = spawnTrackedPython(getBackendModuleArgs('device_manager'), { cwd: pythonConfig.backendPath });

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(output);
          // Reformat to match UI expectations
          resolve({
            inputs: data.input_devices,
            loopbacks: data.loopback_devices,
            defaults: data.defaults
          });
        } catch (e) {
          reject(new Error(`Failed to parse device list: ${e.message}`));
        }
      } else {
        reject(new Error(`Python process exited with code ${code}: ${errorOutput}`));
      }
    });
  });
});

/**
 * Warm up audio system (enumerate devices and test streams)
 * This should be called on app startup to initialize audio drivers
 */
ipcMain.handle('warm-up-audio-system', async () => {
  return new Promise((resolve) => {
    // Step 1: Enumerate devices (forces driver initialization)
    const python = spawnTrackedPython(getBackendModuleArgs('device_manager'), { cwd: pythonConfig.backendPath });

    let output = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const data = JSON.parse(output);
          console.log('Audio system warmed up successfully');
          console.log(`  Found ${data.input_devices.length} input devices`);
          console.log(`  Found ${data.loopback_devices.length} loopback devices`);
          resolve({ success: true, deviceCount: data.input_devices.length + data.loopback_devices.length });
        } catch (e) {
          // Even if parsing fails, enumeration happened so drivers are warm
          console.log('Audio system enumeration completed (with parsing error)');
          resolve({ success: true, deviceCount: 0 });
        }
      } else {
        // Even if it failed, we tried to initialize
        console.log('Audio system warm-up completed (with error)');
        resolve({ success: true, deviceCount: 0 });
      }
    });
  });
});

/**
 * Check if Whisper model is downloaded
 */
ipcMain.handle('check-model-downloaded', async (event, modelSize) => {
  return new Promise((resolve) => {
    const { cacheDir, modelPatterns, modelSize: size } = buildModelDownloadCheck({
      platform: process.platform,
      arch: process.arch,
      homeDir: os.homedir(),
      modelSize,
    });

    try {
      if (fs.existsSync(cacheDir)) {
        const items = fs.readdirSync(cacheDir);
        const modelExists = cacheContainsModel(items, modelPatterns);
        resolve({ downloaded: modelExists, modelSize: size });
      } else {
        resolve({ downloaded: false, modelSize: size });
      }
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
  return new Promise((resolve, reject) => {
    const model = modelSize || 'small';
    console.log(`Downloading Whisper model: ${model}`);

    const python = spawnTrackedPython(getTranscriberArgs([
      '--preload',
      '--model', model
    ]), { cwd: pythonConfig.backendPath, env: buildCudaRuntimeEnv() });

    let hasError = false;

    python.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`[Model Download] ${output}`);

      // Send progress to renderer
      mainWindow.webContents.send('model-download-progress', output);

      // Check for errors
      if (isModelDownloadErrorOutput(output)) {
        hasError = true;
      }
    });

    python.on('close', (code) => {
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

    pythonProcess = spawnTrackedPython([
      '-m', recorderModule,
      '--mic', micId.toString(),
      '--loopback', loopbackId.toString(),
      '--output', outputPath
    ], { cwd: pythonConfig.backendPath });

    // FIX 2 (REFINED): Set high priority for Python recording process on Windows
    // Use small delay to ensure process is fully initialized before setting priority
    if (process.platform === 'win32' && pythonProcess.pid) {
      setTimeout(() => {
        try {
          const { exec } = require('child_process');
          exec(`wmic process where processid="${pythonProcess.pid}" CALL setpriority "high priority"`, (error) => {
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

    const failActiveRecording = (warning) => {
      const payload = {
        type: warning.type || 'recorder_exited',
        code: warning.code || 'RECORDER_EXITED',
        message: warning.message,
        help: warning.help,
        level: warning.level || 'error',
      };

      sendToRenderer('recording-warning', payload);
      sendToRenderer('recording-failed', {
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
        if (timeSinceUpdate > 10000 && pythonProcess && !pythonProcess.killed) {
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
      resolve({ success: true, message: 'Recording started' });
    };

    // PERFORMANCE FIX: Throttle audio level updates to reduce IPC overhead
    // Only send updates if window is visible AND we haven't sent one recently
    let lastLevelSentTime = 0;
    const LEVEL_UPDATE_THROTTLE_MS = 100; // Max 10 updates/sec instead of 20

    pythonProcess.stdout.on('data', (data) => {
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

    pythonProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`Python status: ${output}`);
    });

    pythonProcess.on('close', (code) => {
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
        if (pythonProcess) {
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
        startupSettled = true;
        reject(new Error(closeAction.errorMessage));
      }
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

        startupSettled = true;
        const timedOutProcess = pythonProcess;
        if (timedOutProcess && !timedOutProcess.killed) {
          timedOutProcess.kill();
        }
        clearRecordingRuntimeState('recording startup timeout');
        reject(new Error(errorMessage));
      }
    }, timeout);

    // Clean up timeout if recording starts successfully
    pythonProcess.on('close', () => {
      clearTimeout(timeoutHandle);
    });
  });
});

/**
 * Stop recording
 */
ipcMain.handle('stop-recording', async () => {
  return waitForRecordingStop({
    forceKillOnTimeout: true,
    timeoutMessage: 'Recording stop timeout - process took too long to finish',
  });
});

/**
 * Transcribe audio file
 */
ipcMain.handle('transcribe-audio', async (event, options) => {
  return new Promise((resolve, reject) => {
    let { audioFile, language, modelSize } = options;

    // Resolve relative paths. Keep real .wav fallback files transcribable; only
    // fall back to an .opus sibling when the .wav path is missing.
    if (!path.isAbsolute(audioFile)) {
      // Use userData recordings directory
      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      audioFile = resolveTranscriptionAudioFile({
        audioFile,
        recordingsDir,
        existsSync: fs.existsSync,
      });
    } else {
      audioFile = resolveTranscriptionAudioFile({
        audioFile,
        recordingsDir: path.dirname(audioFile),
        existsSync: fs.existsSync,
      });
    }

    const python = spawnTrackedPython(getTranscriberArgs([
      '--file', audioFile,
      '--language', language || 'en',
      '--model', modelSize || 'small',
      '--json'
    ]), { cwd: pythonConfig.backendPath, env: buildCudaRuntimeEnv() });

    let output = '';
    let errorOutput = '';
    let hasCompleted = false;

    // Timeout: generous limits for slow CPUs and long recordings
    // These are safety nets to catch stalled processes, not performance limits
    const modelTimeouts = { tiny: 30, base: 45, small: 60, medium: 90, large: 120 };
    const timeoutMinutes = modelTimeouts[modelSize] || 60;
    const transcriptionTimeout = setTimeout(() => {
      if (!hasCompleted) {
        hasCompleted = true;
        python.kill();
        reject(new Error(`Transcription timeout after ${timeoutMinutes} minutes. The process may have stalled.`));
      }
    }, timeoutMinutes * 60 * 1000);

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      const stderrChunk = data.toString();
      errorOutput += stderrChunk;
      mainWindow.webContents.send('transcription-progress', stderrChunk);
    });

    python.on('close', (code) => {
      if (hasCompleted) return; // Already timed out
      hasCompleted = true;
      clearTimeout(transcriptionTimeout);

      // Try to parse JSON output first, even if exit code is non-zero
      // This handles cases where transcription succeeds but cleanup fails
      if (output.trim()) {
        try {
          const result = JSON.parse(output);
          // If we successfully parsed JSON with the expected structure, consider it success
          if (result.text !== undefined || result.segments !== undefined) {
            resolve(result);
            return;
          }
        } catch (e) {
          // JSON parsing failed, continue to error handling
        }
      }

      // If we get here, either no output or parsing failed
      if (code === 0) {
        reject(new Error(`Transcription produced no valid output`));
      } else {
        reject(new Error(`Transcription failed: ${errorOutput || 'Unknown error'}`));
      }
    });
  });
});

ipcMain.handle('diarize-transcript', async (event, options = {}) => {
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
  const token = getAiAddonToken({
    userDataDir: app.getPath('userData'),
    tokenKey: TOKEN_KEYS.diarizationHuggingFace,
    safeStorage: getSafeStorage(),
  });

  return enqueueAiComputeAction(() => new Promise((resolve, reject) => {
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
        HF_TOKEN: token || '',
        HUGGINGFACE_HUB_TOKEN: token || '',
      },
    });

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      const stderrChunk = data.toString();
      errorOutput += stderrChunk;
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
  }));
});

ipcMain.handle('generate-summary', async (event, options = {}) => {
  const { meetingId, profile, modelId } = options;
  if (!meetingId) {
    throw new Error('generate-summary requires a meetingId');
  }

  const meeting = await new Promise((resolve, reject) => {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
      '--recordings-dir', recordingsDir,
      'get',
      String(meetingId),
    ]), { cwd: pythonConfig.backendPath });
    let output = '';
    let errorOutput = '';
    python.stdout.on('data', (data) => { output += data.toString(); });
    python.stderr.on('data', (data) => { errorOutput += data.toString(); });
    python.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(output));
        } catch (error) {
          reject(new Error(`Failed to parse meeting before summary generation: ${error.message}`));
        }
        return;
      }
      reject(new Error(errorOutput.trim() || 'Meeting not found'));
    });
    python.on('error', reject);
  });

  if (!meeting || !meeting.transcriptPath) {
    throw new Error('Meeting transcript is not available for summary generation.');
  }

  const aiStatus = await checkAiAddonSetupStatus(getAiAddonRuntimeOptions({ verifyChecksums: true }));
  if (aiStatus.features.summary.status !== 'ready' || !aiStatus.features.summary.setupComplete) {
    throw new Error('Summary model setup is not ready.');
  }

  const selectedModelId = aiStatus.features.summary.modelId;
  if (modelId && modelId !== selectedModelId) {
    throw new Error('Summary model selection is managed by local setup. Validate or reinstall the selected model in Settings.');
  }
  const artifact = getSummaryArtifactForPlatform(selectedModelId, process.platform, process.arch);
  if (!artifact) {
    throw new Error('No summary model artifact is available for this platform.');
  }

  const modelPath = getSummaryArtifactPath(app.getPath('userData'), artifact);
  const runtimeDir = getSummaryRuntimeDir(app.getPath('userData'), artifact);
  const transcriptPath = assertSafeExistingTranscriptPath(meeting.transcriptPath);
  const transcriptBase = transcriptPath.replace(/\.md$/i, '');
  const outputJson = `${transcriptBase}.summary.json`;
  const outputMarkdown = `${transcriptBase}.summary.md`;
  const speakerMetadataPath = meeting.ai && meeting.ai.diarization && meeting.ai.diarization.segmentsPath;
  const speakersJsonPath = speakerMetadataPath ? assertSafeExistingSegmentsPath(speakerMetadataPath) : null;

  return enqueueAiComputeAction(() => new Promise((resolve, reject) => {
    const python = spawnTrackedPython(buildSummaryArgs({
      meetingId: String(meetingId),
      transcriptPath,
      runtimeDir,
      modelPath,
      outputJson,
      outputMarkdown,
      speakersJsonPath,
      profile: profile || 'balanced',
      modelLabel: artifact.modelLabel || artifact.modelId,
    }), { cwd: pythonConfig.backendPath });

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      const stderrChunk = data.toString();
      errorOutput += stderrChunk;
      for (const line of stderrChunk.split(/\r?\n/)) {
        const progressEvent = parseAiBackendProgressLine(line, 'summary');
        if (progressEvent) {
          sendToRenderer('summary-progress', progressEvent);
        }
      }
    });

    python.on('close', async (code) => {
      if (code !== 0) {
        const reason = errorOutput && errorOutput.trim()
          ? errorOutput.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]
          : '';
        reject(new Error(reason || 'Summary generation failed.'));
        return;
      }

      try {
        const result = JSON.parse(output);
        const summaryMetadata = {
          status: 'completed',
          modelProfile: result.metadata.profile,
          model: result.metadata.model,
          generatedAt: result.metadata.generatedAt,
          sourceTranscriptHash: result.metadata.sourceTranscriptHash,
          jsonPath: result.jsonPath,
          markdownPath: result.markdownPath,
          error: null,
        };
        const updatedMeeting = await new Promise((metadataResolve, metadataReject) => {
          const recordingsDir = path.join(app.getPath('userData'), 'recordings');
          const pythonUpdate = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
            '--recordings-dir', recordingsDir,
            'update-ai',
            String(meetingId),
            '--summary-json', JSON.stringify(summaryMetadata),
          ]), { cwd: pythonConfig.backendPath });
          let metadataOutput = '';
          let metadataErrorOutput = '';
          pythonUpdate.stdout.on('data', (data) => { metadataOutput += data.toString(); });
          pythonUpdate.stderr.on('data', (data) => { metadataErrorOutput += data.toString(); });
          pythonUpdate.on('close', (updateCode) => {
            if (updateCode === 0) {
              try {
                metadataResolve(JSON.parse(metadataOutput));
              } catch (error) {
                metadataReject(new Error(`Failed to parse summary metadata update: ${error.message}`));
              }
              return;
            }
            metadataReject(new Error(metadataErrorOutput.trim() || 'Failed to update summary metadata'));
          });
          pythonUpdate.on('error', metadataReject);
        });

        resolve({ ...result, meeting: updatedMeeting });
      } catch (error) {
        reject(error);
      }
    });

    python.on('error', reject);
  }));
});

/**
 * List all meetings
 */
ipcMain.handle('list-meetings', async () => {
  return new Promise((resolve, reject) => {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
      '--recordings-dir', recordingsDir,
      'list'
    ]), { cwd: pythonConfig.backendPath });

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const meetings = JSON.parse(output);
          resolve(meetings);
        } catch (e) {
          reject(new Error(`Failed to parse meetings: ${e.message}`));
        }
      } else {
        const errorMsg = errorOutput.trim() || 'Unknown error';
        reject(new Error(`Failed to list meetings: ${errorMsg}`));
      }
    });
  });
});

/**
 * Get a single meeting
 */
ipcMain.handle('get-meeting', async (event, meetingId) => {
  return new Promise((resolve, reject) => {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
      '--recordings-dir', recordingsDir,
      'get',
      meetingId
    ]), { cwd: pythonConfig.backendPath });

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const meeting = JSON.parse(output);
          resolve(meeting);
        } catch (e) {
          reject(new Error(`Failed to parse meeting: ${e.message}`));
        }
      } else {
        const errorMsg = errorOutput.trim() || 'Meeting not found';
        reject(new Error(errorMsg));
      }
    });
  });
});

/**
 * Delete a meeting
 */
ipcMain.handle('delete-meeting', async (event, meetingId) => {
  const recordingsDir = path.join(app.getPath('userData'), 'recordings');

  return new Promise((resolve, reject) => {
    const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
      '--recordings-dir', recordingsDir,
      'delete',
      meetingId
    ]), { cwd: pythonConfig.backendPath });

    let errorOutput = '';

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        const errorMsg = errorOutput.trim() || 'Unknown error';
        reject(new Error(`Failed to delete meeting: ${errorMsg}`));
      }
    });

    python.on('error', (err) => {
      reject(err);
    });
  });
});

/**
 * Scan recordings directory and sync with database
 */
ipcMain.handle('scan-recordings', async () => {
  return new Promise((resolve, reject) => {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
      '--recordings-dir', recordingsDir,
      'scan'
    ]), { cwd: pythonConfig.backendPath });

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(output);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse scan result: ${e.message}`));
        }
      } else {
        const errorMsg = errorOutput.trim() || 'Unknown error';
        reject(new Error(`Failed to scan recordings: ${errorMsg}`));
      }
    });
  });
});

/**
 * Add a meeting (called after transcription)
 */
ipcMain.handle('add-meeting', async (event, meetingData) => {
  return addMeetingToHistory(meetingData);
});

/**
 * Update editable meeting metadata (currently: display title).
 *
 * Audio/transcript filenames stay anchored to the meeting ID; only the
 * label that the UI shows changes.
 */
ipcMain.handle('update-meeting', async (event, payload) => {
  const meetingId = payload && payload.meetingId;
  const updates = (payload && payload.updates) || {};
  if (!meetingId) {
    throw new Error('update-meeting requires a meetingId');
  }

  const recordingsDir = path.join(app.getPath('userData'), 'recordings');
  const args = [
    '--recordings-dir', recordingsDir,
    'update',
    String(meetingId),
  ];
  if (typeof updates.title === 'string') {
    args.push('--title', updates.title);
  }

  return new Promise((resolve, reject) => {
    const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', args), {
      cwd: pythonConfig.backendPath,
    });

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => { output += data.toString(); });
    python.stderr.on('data', (data) => { errorOutput += data.toString(); });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(output));
        } catch (e) {
          reject(new Error(`Failed to parse updated meeting: ${e.message}`));
        }
      } else {
        reject(new Error(errorOutput.trim() || 'Failed to update meeting'));
      }
    });

    python.on('error', (err) => reject(err));
  });
});

ipcMain.handle('update-meeting-ai', async (event, payload) => {
  const meetingId = payload && payload.meetingId;
  const updates = validateAiMetadataPaths((payload && payload.updates) || {});
  if (!meetingId) {
    throw new Error('update-meeting-ai requires a meetingId');
  }

  const recordingsDir = path.join(app.getPath('userData'), 'recordings');
  const args = [
    '--recordings-dir', recordingsDir,
    'update-ai',
    String(meetingId),
  ];

  if (Object.prototype.hasOwnProperty.call(updates, 'diarization')) {
    if (updates.diarization === null) {
      args.push('--clear-diarization');
    } else {
      args.push('--diarization-json', JSON.stringify(updates.diarization));
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'summary')) {
    if (updates.summary === null) {
      args.push('--clear-summary');
    } else {
      args.push('--summary-json', JSON.stringify(updates.summary));
    }
  }

  return new Promise((resolve, reject) => {
    const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', args), {
      cwd: pythonConfig.backendPath,
    });

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => { output += data.toString(); });
    python.stderr.on('data', (data) => { errorOutput += data.toString(); });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(output));
        } catch (e) {
          reject(new Error(`Failed to parse updated AI meeting metadata: ${e.message}`));
        }
      } else {
        reject(new Error(errorOutput.trim() || 'Failed to update AI meeting metadata'));
      }
    });

    python.on('error', (err) => reject(err));
  });
});

ipcMain.handle('save-transcript-file', async (event, options = {}) => {
  const { filePath, content } = options;
  if (!filePath || typeof content !== 'string') {
    throw new Error('save-transcript-file requires filePath and content');
  }

  const recordingsDir = path.join(app.getPath('userData'), 'recordings');
  if (!isSafeRecordingsMarkdownPath({ filePath, recordingsDir })) {
    throw new Error('Transcript file must be a Markdown file in the recordings directory.');
  }

  const resolvedPath = path.resolve(filePath);
  await fs.promises.writeFile(resolvedPath, content, 'utf8');
  return { success: true, filePath: resolvedPath };
});

/**
 * Show a Save dialog and write the supplied transcript text to disk.
 *
 * The renderer chooses the suggested filename (typically derived from the
 * meeting's display label) so users get a meaningful default name.
 */
ipcMain.handle('save-transcript-as', async (event, options) => {
  const opts = options || {};
  const suggestedName = (opts.suggestedName || 'transcript').toString();
  const content = typeof opts.content === 'string' ? opts.content : '';
  const title = typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : 'Save Transcript';

  // Sanitize for filesystem (Windows + macOS safe)
  const safeName = suggestedName
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'transcript';

  const window = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showSaveDialog(window, {
    title,
    defaultPath: safeName.toLowerCase().endsWith('.md') ? safeName : `${safeName}.md`,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await fs.promises.writeFile(result.filePath, content, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

/**
 * Check GPU availability (detect NVIDIA GPU)
 */
ipcMain.handle('check-gpu', async () => {
  return new Promise((resolve) => {
    const python = spawnTrackedPython([
      '-c',
      'import subprocess; result = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True); print(result.stdout.strip() if result.returncode == 0 else "None")'
    ]);

    let output = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.on('close', () => {
      const gpuName = output.trim();
      resolve({
        hasGPU: gpuName !== 'None' && gpuName !== '',
        gpuName: gpuName !== 'None' ? gpuName : null
      });
    });
  });
});

/**
 * Check CUDA installation status
 */
ipcMain.handle('check-cuda', async () => {
  return new Promise((resolve) => {
    const cudaPackages = getTranscriptionCudaPackages();
    const python = spawnTrackedPython([
      '-c',
      'try:\n    import ctranslate2\n    count = ctranslate2.get_cuda_device_count()\n    print("cuda_available:" + str(count > 0))\n    print("cuda_device_count:" + str(count))\n    print("cuda_runtime:ctranslate2")\nexcept Exception as exc:\n    print("cuda_available:False")\n    print("cuda_error:" + str(exc))'
    ], { env: buildCudaRuntimeEnv() });

    let output = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.on('close', () => {
      const cudaAvailable = output.includes('cuda_available:True');
      const versionMatch = output.match(/cuda_version:([\d.]+)/);
      getActivePythonVersion().then((pythonVersion) => {
        resolve({
          installed: cudaAvailable,
          version: versionMatch ? versionMatch[1] : null,
          runtime: 'ctranslate2',
          packages: cudaPackages,
          pythonVersion: pythonVersion.parsed ? pythonVersion.parsed.version : pythonVersion.output,
          pythonSupportedForInstall: isSupportedCudaInstallPythonVersion(pythonVersion.parsed),
          pythonExecutable: pythonConfig.pythonExe,
        });
      }).catch(() => {
        resolve({
          installed: cudaAvailable,
          version: versionMatch ? versionMatch[1] : null,
          runtime: 'ctranslate2',
          packages: cudaPackages,
          pythonVersion: null,
          pythonSupportedForInstall: false,
          pythonExecutable: pythonConfig.pythonExe,
        });
      });
    });
  });
});

/**
 * Install GPU acceleration packages
 */
ipcMain.handle('install-gpu', async () => {
  return new Promise((resolve, reject) => {
    getActivePythonVersion().then((pythonVersion) => {
      if (!isSupportedCudaInstallPythonVersion(pythonVersion.parsed)) {
        reject(new Error(buildUnsupportedCudaPythonMessage(pythonVersion.output)));
        return;
      }

      const python = spawnTrackedPython(buildTranscriptionCudaInstallArgs());

      let output = '';
      let errorOutput = '';

      python.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        // Send progress to renderer
        mainWindow.webContents.send('gpu-install-progress', text);
      });

      python.stderr.on('data', (data) => {
        const text = data.toString();
        errorOutput += text;
        mainWindow.webContents.send('gpu-install-progress', text);
      });

      python.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true, message: 'GPU acceleration installed successfully' });
        } else {
          reject(new Error(`Failed to install CUDA libraries: ${errorOutput}`));
        }
      });
    }).catch((error) => {
      reject(new Error(`Could not verify Python before installing GPU acceleration: ${error.message}`));
    });
  });
});

/**
 * Uninstall GPU packages
 */
ipcMain.handle('uninstall-gpu', async () => {
  return new Promise((resolve, reject) => {
    const python = spawnTrackedPython(buildTranscriptionCudaUninstallArgs());

    let errorOutput = '';

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        const errorMsg = errorOutput.trim() || 'Unknown error';
        reject(new Error(`Failed to uninstall GPU packages: ${errorMsg}`));
      }
    });
  });
});

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

/**
 * Open update download page in browser
 */
ipcMain.handle('download-update', async (event, downloadUrl) => {
  await openDownloadPage(downloadUrl);
  return { success: true };
});

console.log('AvaNevis - Main process started');
