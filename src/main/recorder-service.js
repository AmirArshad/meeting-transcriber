'use strict';

/**
 * Recorder lifecycle service for the AvaNevis main process.
 *
 * Owns recording mutable state (pythonProcess, stop/heartbeat/power-save) and
 * registers run-recording-preflight / start-recording / stop-recording.
 * Quit-during-recording helpers are exported for the composition-root
 * before-quit handler. Handler bodies are moved verbatim; deps are injected.
 */

const os = require('os');

const {
  buildRecordingPreflightReport,
  buildQuitRecordingDialogOptions,
  getRecorderCloseAction,
  getRecorderEventAction,
  getRecordingStopTimeout,
  parseRecordingStopResult,
  normalizeRecordingStopPayload,
  resolveStopTimeoutAction,
  parseRecorderStdoutChunk,
  appendCappedSpawnLogBuffer,
  SPAWN_JSON_RESULT_BUFFER_MAX_CHARS,
  buildRecorderBusyResponse,
  isRecorderBusy,
} = require('../main-process-helpers');

/**
 * @param {object} deps
 * @param {Function} deps.getRecordingsDir - Required for successful stop-result parsing.
 */
function createRecorderService(deps) {
  const {
    app,
    path,
    fs,
    dialog,
    powerSaveBlocker,
    pythonConfig,
    spawnTrackedPython,
    sendToRenderer,
    assertTrustedRendererSender,
    getMainWindow,
    setIsQuitting,
    getAllowImmediateQuit,
    setAllowImmediateQuit,
    getQuitWorkflowPromise,
    setQuitWorkflowPromise,
    hasInFlightAiWork = () => false,
    drainAiWorkBeforeQuit = async () => {},
    isQuitCommitted = () => false,
    isRecordingsScanInProgress = () => false,
    clearQuitCommitted = () => {},
    validateSelectedDevices,
    checkDiskSpace,
    checkAudioOutputSupport,
    getMacOSPermissionStatus,
    addMeetingToHistory,
    formatDurationForTranscript,
    getRecordingsDir,
    signalProcessTree = (proc, signal) => proc.kill(signal),
    getRecordingStopTimeoutMs = getRecordingStopTimeout,
    onCaptureStateChanged = () => {},
    notifyRecordingSafety = () => {},
    diskSpaceCheckIntervalMs = 5 * 60 * 1000,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = deps;

  if (typeof getRecordingsDir !== 'function') {
    throw new Error('createRecorderService requires getRecordingsDir');
  }

  // Single shared recording lifecycle state — never copy these lets into main.js.
  let pythonProcess = null;
  let recordingStartTime = null;
  let powerSaveId = null;
  let recordingHeartbeat = null;
  let lastLevelUpdate = null;
  let heartbeatLostWarningActive = false;
  let recordingStopPromise = null;
  let stopCommandSent = false;
  let recordingSessionCounter = 0;
  let activeRecordingSessionId = null;
  let publishedCaptureState = { state: 'idle', sessionId: null, startedAt: null };
  // Last structured result seen by the live stdout listener (not only stop buffer).
  let lastLiveRecorderResult = null;
  // Suppress unexpected_exit UI after a stop-timeout force-kill (renderer already failed).
  let suppressUnexpectedExitAfterStopTimeout = false;
  // Audio paths persisted by quit-cancel recovery; stop IPC should not re-save/transcribe.
  const quitPersistedAudioPaths = new Set();
  // In-flight quit-cancel persist; stop IPC awaits this before returning so the
  // alreadyPersistedForQuit flag is visible (avoids double transcribe/save).
  let quitStopRecoveryPromise = null;
  let diskSpaceMonitor = null;
  let lastEmittedDiskSpaceLevel = null;

  function diskSpaceLevelSeverity(level) {
    if (level === 'critical') {
      return 2;
    }
    if (level === 'warning') {
      return 1;
    }
    return 0;
  }

  function stopDiskSpaceMonitor() {
    if (diskSpaceMonitor) {
      clearIntervalFn(diskSpaceMonitor);
      diskSpaceMonitor = null;
    }
    lastEmittedDiskSpaceLevel = null;
  }

  async function evaluateDiskSpaceDuringRecording(sessionId) {
    if (
      publishedCaptureState.state !== 'recording'
      || activeRecordingSessionId !== sessionId
    ) {
      return;
    }

    let result;
    try {
      result = await checkDiskSpace();
    } catch (error) {
      console.warn('Recording disk-space check failed:', error?.message || error);
      return;
    }

    if (
      publishedCaptureState.state !== 'recording'
      || activeRecordingSessionId !== sessionId
    ) {
      return;
    }

    const level = result?.level || null;
    const nextSeverity = diskSpaceLevelSeverity(level);
    const previousSeverity = diskSpaceLevelSeverity(lastEmittedDiskSpaceLevel);
    if (nextSeverity <= previousSeverity) {
      return;
    }

    lastEmittedDiskSpaceLevel = level;
    const message = result.warning
      || (level === 'critical'
        ? 'Less than 2 GB is available. Long recordings may run out of space.'
        : 'Less than 10 GB is available. Long recordings may run out of space.');
    const payload = {
      type: 'disk_space',
      level,
      code: level === 'critical' ? 'DISK_SPACE_CRITICAL' : 'DISK_SPACE_LOW',
      message,
      availableBytes: result.availableBytes,
      availableGB: result.availableGB,
      sessionId,
    };

    sendToRenderer('recording-warning', payload);
    sendToRenderer('recording-progress', message);

    try {
      notifyRecordingSafety({
        title: level === 'critical'
          ? 'AvaNevis disk space is critically low'
          : 'AvaNevis disk space is running low',
        body: message,
      });
    } catch (error) {
      console.warn('Recording safety notification failed:', error?.message || error);
    }
  }

  function startDiskSpaceMonitor(sessionId) {
    stopDiskSpaceMonitor();
    const intervalMs = Number.isFinite(diskSpaceCheckIntervalMs) && diskSpaceCheckIntervalMs > 0
      ? diskSpaceCheckIntervalMs
      : 5 * 60 * 1000;
    diskSpaceMonitor = setIntervalFn(() => {
      evaluateDiskSpaceDuringRecording(sessionId).catch((error) => {
        console.warn('Recording disk-space monitor error:', error?.message || error);
      });
    }, intervalMs);
  }

  function publishCaptureState(state, sessionId = activeRecordingSessionId, startedAt = recordingStartTime) {
    publishedCaptureState = {
      state,
      sessionId: Number.isInteger(sessionId) ? sessionId : null,
      startedAt: Number.isFinite(startedAt) ? startedAt : null,
    };
    try {
      onCaptureStateChanged({ ...publishedCaptureState });
    } catch (error) {
      console.warn('onCaptureStateChanged failed:', error?.message || error);
    }
  }

  function getCaptureState() {
    return { ...publishedCaptureState };
  }

  function clearRecordingRuntimeState(reason, options = {}) {
    const {
      expectedProcess = null,
      expectedSessionId = undefined,
      publishIdle = true,
    } = options;

    if (expectedProcess && pythonProcess && pythonProcess !== expectedProcess) {
      return false;
    }
    if (expectedSessionId !== undefined && activeRecordingSessionId !== expectedSessionId) {
      return false;
    }

    if (recordingHeartbeat) {
      clearInterval(recordingHeartbeat);
      recordingHeartbeat = null;
      console.log(`Recording heartbeat monitor stopped (${reason})`);
    }

    stopDiskSpaceMonitor();

    pythonProcess = null;
    recordingStartTime = null;
    activeRecordingSessionId = null;
    lastLevelUpdate = null;
    heartbeatLostWarningActive = false;
    lastLiveRecorderResult = null;
    suppressUnexpectedExitAfterStopTimeout = false;
    disableRecordingPowerSaveBlocker(reason);
    resetStopWorkflowState();

    if (publishIdle) {
      publishCaptureState('idle', null, null);
    }
    return true;
  }

  function markQuitPersistedAudioPath(audioPath) {
    if (audioPath) {
      quitPersistedAudioPaths.add(String(audioPath));
    }
  }

  function consumeQuitPersistedFlag(result) {
    if (!result?.audioPath) {
      return result;
    }
    const key = String(result.audioPath);
    if (!quitPersistedAudioPaths.has(key)) {
      return result;
    }
    quitPersistedAudioPaths.delete(key);
    return {
      ...result,
      alreadyPersistedForQuit: true,
    };
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
          clearRecordingRuntimeState('recording completed', {
            expectedProcess: currentProcess,
          });
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

        // Prefer a structured stdout result when present, including non-zero
        // exits where Windows may still emit audioPath from finally.
        try {
          const parsed = parseRecordingStopResultFromStdout(stdoutData);
          if (parsed) {
            resolve(parsed);
            return;
          }
        } catch (error) {
          if (code === 0) {
            reject(error);
            return;
          }
          // Fall through to exit-code rejection when stdout is unusable.
        }

        if (code === 0) {
          reject(new Error('Recording completed but output file not found.'));
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
        publishCaptureState('stopping');
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
    const timeoutMs = getRecordingStopTimeoutMs(recordingStartTime);

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
          // Keep recordingStopPromise set so the subsequent close is classified as
          // stop_in_progress (not unexpected_exit). Also arm an explicit suppress
          // flag in case close ordering clears the stop promise first.
          suppressUnexpectedExitAfterStopTimeout = true;
          pythonProcess.kill();
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

    const quitPromptWindow = getMainWindow();
    if (quitPromptWindow && !quitPromptWindow.isDestroyed()) {
      return dialog.showMessageBox(quitPromptWindow, options);
    }

    return dialog.showMessageBox(options);
  }

  async function finishQuitAfterRecordingSaved(result) {
    if (result?.audioPath) {
      await persistStoppedRecordingForQuit(result);
      markQuitPersistedAudioPath(result.audioPath);
      sendToRenderer('recording-saved-during-quit', {
        audioPath: result.audioPath,
        duration: result.duration || 0,
        message: 'Recording saved during quit attempt. Open History to continue.',
      });
    }

    // Recording quit previously armed allowImmediateQuit and skipped AI drain.
    // Drain in-flight transcription/summary/GPU work before the final quit pass.
    if (hasInFlightAiWork()) {
      await drainAiWorkBeforeQuit();
    }

    setAllowImmediateQuit(true);
    setIsQuitting(true);
    app.quit();
  }

  async function recoverRecordingAfterQuitCanceled(outstandingStopPromise = null) {
    // Stop was already sent (or the recorder finished while the dialog was open).
    // Do not claim recording continues — await the outstanding stop and persist.
    sendToRenderer('recording-progress', {
      message: 'Quit canceled. Finishing the recording that was already stopping…',
      code: 'QUIT_CANCELED_STOP_IN_PROGRESS',
    });

    const recoveryWork = (async () => {
      // Prefer a captured stop promise (may already be settled if the recorder
      // finished while the forced-quit dialog was open). Fall back to the live
      // promise, then to a fresh wait only if stop was never attached.
      let result;
      if (outstandingStopPromise) {
        result = await outstandingStopPromise;
      } else if (recordingStopPromise) {
        result = await recordingStopPromise;
      } else {
        result = await waitForRecordingStop({
          forceKillOnTimeout: false,
          timeoutMessage: 'Recorder stop is taking longer than expected after quit was canceled.',
        });
      }

      if (result?.audioPath) {
        await persistStoppedRecordingForQuit(result);
        markQuitPersistedAudioPath(result.audioPath);
        sendToRenderer('recording-saved-during-quit', {
          audioPath: result.audioPath,
          duration: result.duration || 0,
          message: 'Recording finished and saved after quit was canceled. Open History to continue.',
        });
        sendToRenderer('recording-progress', {
          message: 'Recording finished and saved. Open History to continue.',
          code: 'RECORDING_SAVED_AFTER_QUIT_CANCEL',
        });
        return;
      }

      sendToRenderer('recording-progress', {
        message: 'Recording stop finished but no audio file was found.',
        code: 'RECORDING_STOP_NO_AUDIO',
      });
    })();

    quitStopRecoveryPromise = recoveryWork;
    try {
      await recoveryWork;
    } catch (recoverError) {
      console.warn('Post-quit-cancel recording recovery failed:', recoverError.message);
      sendToRenderer('recording-progress', {
        message: `Recording stop did not finish cleanly: ${recoverError.message}`,
        code: 'RECORDING_STOP_RECOVERY_FAILED',
      });
      sendToRenderer('recording-warning', {
        type: 'quit_cancel_stop_failed',
        code: 'QUIT_CANCEL_STOP_FAILED',
        message: 'Quit was canceled, but the recorder had already been told to stop and did not finish saving. Check History after relaunch, or try Stop again if the recorder is still running.',
        level: 'warning',
      });
    } finally {
      if (quitStopRecoveryPromise === recoveryWork) {
        quitStopRecoveryPromise = null;
      }
    }
  }

  async function handleQuitDuringRecording(quitState) {
    if (getQuitWorkflowPromise()) {
      return getQuitWorkflowPromise();
    }

    setIsQuitting(false);

    setQuitWorkflowPromise((async () => {
      if (quitState.progressMessage) {
        sendToRenderer('recording-progress', quitState.progressMessage);
      }

      // Captured across the dialog so F7 still recovers if closeHandler clears
      // stopCommandSent / recordingStopPromise while the dialog is open.
      let stopWasAttempted = Boolean(stopCommandSent || recordingStopPromise);
      let outstandingStopPromise = recordingStopPromise;

      try {
        const result = await waitForRecordingStop({
          forceKillOnTimeout: false,
          timeoutMessage: 'Recorder stop is taking longer than expected.',
        });

        await finishQuitAfterRecordingSaved(result);
        return;
      } catch (error) {
        // waitForRecordingStop always sends stop (or reuses an in-flight stop).
        stopWasAttempted = true;
        outstandingStopPromise = outstandingStopPromise || recordingStopPromise;

        console.warn('Graceful quit stop failed:', error.message);
        const response = await promptForForcedQuit(quitState.state, error);

        if (response.response === 1) {
          if (hasInFlightAiWork()) {
            await drainAiWorkBeforeQuit();
          }
          // The armed before-quit pass re-checks recorder state. Retire the
          // process explicitly so a hung recorder cannot intercept forced quit
          // again and strand the app after the dialog closes.
          forceKillRecordingOnShutdown();
          clearRecordingRuntimeState('forced quit');
          setAllowImmediateQuit(true);
          setIsQuitting(true);
          app.quit();
          return;
        }

        setIsQuitting(false);

        // F1/F7: stop was already sent (or may have completed while the dialog
        // was open). Never claim "recording continues" in that case.
        if (stopWasAttempted) {
          await recoverRecordingAfterQuitCanceled(outstandingStopPromise);
          clearQuitCommitted();
          return;
        }

        clearQuitCommitted();
        const canceledMessage = quitState.state === 'stopping'
          ? 'Quit canceled. Saving continues.'
          : 'Quit canceled. Recording continues.';
        sendToRenderer('recording-progress', canceledMessage);
      }
    })());

    try {
      await getQuitWorkflowPromise();
    } finally {
      if (!getAllowImmediateQuit()) {
        setQuitWorkflowPromise(null);
      }
    }
  }

  async function persistRecoveredRecording(recordingInfo, {
    title = 'Recording saved before quit',
    heading = 'Recording Saved Before Quit',
    body = 'Transcription was not completed because the app quit while recording was active.\nOpen AvaNevis again to keep this recording in history.',
  } = {}) {
    const audioPath = recordingInfo.audioPath;
    const audioFile = path.basename(audioPath);
    const recordingsDir = path.dirname(audioPath);
    const transcriptPath = path.join(
      recordingsDir,
      `${path.basename(audioFile, path.extname(audioFile))}.md`
    );

    if (!fs.existsSync(transcriptPath)) {
      const transcriptContent = [
        `# ${heading}`,
        '',
        `**Date:** ${new Date().toISOString()}`,
        `**Duration:** ${formatDurationForTranscript(recordingInfo.duration || 0)}`,
        '',
        body,
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
      title,
    });
  }

  async function persistStoppedRecordingForQuit(recordingInfo) {
    return persistRecoveredRecording(recordingInfo, {
      title: 'Recording saved before quit',
      heading: 'Recording Saved Before Quit',
      body: [
        'Transcription was not completed because the app quit while recording was active.',
        'Open AvaNevis again to keep this recording in history.',
      ].join('\n'),
    });
  }

  async function persistRecoveredRecordingAfterUnexpectedExit(recordingInfo) {
    return persistRecoveredRecording(recordingInfo, {
      title: 'Recording recovered after unexpected exit',
      heading: 'Recording Recovered After Unexpected Exit',
      body: [
        'The recorder exited unexpectedly, but the audio file was recovered.',
        'Open History to continue with this recording.',
      ].join('\n'),
    });
  }

  function getQuitInterceptInputs() {
    return {
      hasRecordingProcess: Boolean(pythonProcess),
      recordingStartTime,
      stopInProgress: Boolean(recordingStopPromise),
    };
  }

  function forceKillRecordingOnShutdown() {
    if (recordingHeartbeat) {
      clearInterval(recordingHeartbeat);
      recordingHeartbeat = null;
    }
    if (pythonProcess) {
      try {
        signalProcessTree(pythonProcess, 'SIGKILL');
      } catch (e) {
        // Process might already be dead, ignore
      }
    }
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('get-recording-state', async (event) => {
      assertTrustedRendererSender(event);
      return getCaptureState();
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

    /**
     * Start recording with improved timeout and progress feedback
     */
    ipcMain.handle('start-recording', async (event, options) => {
      assertTrustedRendererSender(event);

      if (isQuitCommitted()) {
        return {
          success: false,
          code: 'QUIT_IN_PROGRESS',
          message: 'Cannot start recording while the app is quitting.',
        };
      }

      if (isRecordingsScanInProgress()) {
        return {
          success: false,
          code: 'RECORDING_SCAN_IN_PROGRESS',
          message: 'Wait for recording recovery scan to finish before starting a new recording.',
        };
      }

      if (isRecorderBusy({ pythonProcess, recordingStopPromise })) {
        return buildRecorderBusyResponse();
      }

      const sessionId = ++recordingSessionCounter;
      activeRecordingSessionId = sessionId;
      publishCaptureState('starting', sessionId, null);

      return new Promise((resolve) => {
        let proc = null;
        let recordingStarted = false;
        let progressStage = 'initializing';
        let stdoutRemainder = '';
        let startupFailureMessage = null;
        let startupSettled = false;
        let onStdoutData = null;
        let timeoutHandle = null;

        const detachLiveStdout = () => {
          if (!proc?.stdout || typeof onStdoutData !== 'function') {
            return;
          }
          try {
            proc.stdout.removeListener('data', onStdoutData);
          } catch (_) {
            // Listener may already be gone.
          }
          onStdoutData = null;
        };

        const settleStartupFailure = (errorMessage) => {
          if (startupSettled) {
            return;
          }

          startupSettled = true;
          detachLiveStdout();
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          // Clear only if this session is still current (never wipe a newer retry).
          clearRecordingRuntimeState('recording startup failure', {
            expectedSessionId: sessionId,
          });

          resolve({
            success: false,
            code: 'STARTUP_FAILED',
            sessionId,
            message: errorMessage,
          });
        };

        try {
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

        proc = spawnTrackedPython([
          '-m', recorderModule,
          '--mic', micId.toString(),
          '--loopback', loopbackId.toString(),
          '--output', outputPath
        ], { cwd: pythonConfig.backendPath });
        pythonProcess = proc;

        // Set high priority for the Python recording process on Windows.
        // Prefer Node's os.setPriority (WMIC was removed on Windows 11 24H2+).
        if (process.platform === 'win32' && proc.pid) {
          const procPid = proc.pid;
          setTimeout(() => {
            if (pythonProcess !== proc || !procPid) {
              return;
            }

            try {
              const highPriority = os.constants?.priority?.PRIORITY_HIGH;
              if (typeof highPriority === 'number') {
                os.setPriority(procPid, highPriority);
                console.log('Recording process set to HIGH priority');
              } else {
                console.warn('Could not set process priority: PRIORITY_HIGH unavailable');
              }
            } catch (e) {
              console.warn('Could not set process priority:', e.message);
            }
          }, 100); // 100ms delay to ensure process initialization
        }

        lastLiveRecorderResult = null;
        suppressUnexpectedExitAfterStopTimeout = false;
        heartbeatLostWarningActive = false;

        const sendInitProgress = (stage, message) => {
          progressStage = stage;
          sendToRenderer('recording-init-progress', { stage, message });
        };

        const failActiveRecording = (warning) => {
          const payload = {
            type: warning.type || 'recorder_exited',
            code: warning.code || 'RECORDER_EXITED',
            message: warning.message,
            help: warning.help,
            level: warning.level || 'error',
            sessionId,
          };

          if (pythonProcess === proc) {
            clearRecordingRuntimeState('recording failed', {
              expectedProcess: proc,
              expectedSessionId: sessionId,
            });
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
            sessionId,
          };

          sendToRenderer('recording-warning', payload);
          sendToRenderer('recording-progress', message);
          if (payload.help) {
            sendToRenderer('recording-progress', payload.help);
          }

          return payload;
        };

        const markRecordingStarted = (message = 'Recording started!') => {
          // Ignore late stdout after this attempt settled, and ignore events from
          // a superseded child/session (startup timeout then retry).
          if (
            recordingStarted
            || startupSettled
            || pythonProcess !== proc
            || activeRecordingSessionId !== sessionId
          ) {
            return;
          }

          recordingStarted = true;
          recordingStartTime = Date.now();
          publishCaptureState('recording', sessionId, recordingStartTime);

          // Heartbeat monitor: warn once per stall episode (not every 5s).
          lastLevelUpdate = Date.now();
          heartbeatLostWarningActive = false;
          recordingHeartbeat = setInterval(() => {
            const timeSinceUpdate = Date.now() - lastLevelUpdate;

            // If no audio level updates for 10 seconds, something is wrong
            if (timeSinceUpdate > 10000 && pythonProcess === proc && !proc.killed) {
              if (!heartbeatLostWarningActive) {
                heartbeatLostWarningActive = true;
                console.error(`Recording heartbeat lost - no audio levels for ${timeSinceUpdate / 1000}s`);
                sendToRenderer('recording-warning', {
                  type: 'heartbeat_lost',
                  sessionId,
                  message: 'Recording may have stopped unexpectedly. No audio data received for 10+ seconds.'
                });
              }
              // Continue monitoring - don't auto-kill, let user decide
            }
          }, 5000);

          // Periodic free-space checks; warn only on threshold escalation.
          startDiskSpaceMonitor(sessionId);

          sendInitProgress('started', message);
          startupSettled = true;
          resolve({
            success: true,
            message: 'Recording started',
            sessionId,
            startedAt: recordingStartTime,
          });
        };

        // PERFORMANCE FIX: Throttle audio level updates to reduce IPC overhead
        // Only send updates if window is visible AND we haven't sent one recently
        let lastLevelSentTime = 0;
        const LEVEL_UPDATE_THROTTLE_MS = 100; // Max 10 updates/sec instead of 20

        onStdoutData = (data) => {
          const parsedChunk = parseRecorderStdoutChunk(data.toString(), stdoutRemainder);
          stdoutRemainder = parsedChunk.remainder;

          for (const message of parsedChunk.messages) {
            switch (message.kind) {
              case 'levels': {
                lastLevelUpdate = Date.now();
                // Levels resumed — allow a fresh warning if the stall returns.
                heartbeatLostWarningActive = false;

                const now = Date.now();
                const shouldSendUpdate = (now - lastLevelSentTime) >= LEVEL_UPDATE_THROTTLE_MS;

                const levelsWindow = getMainWindow();
                if (shouldSendUpdate && levelsWindow && !levelsWindow.isMinimized() && levelsWindow.isVisible()) {
                  sendToRenderer('audio-levels', { ...message.payload, sessionId });
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
                  sendToRenderer('recording-progress', eventAction.progressMessage);
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
                  sendToRenderer('recording-progress', message.payload.message);
                }
                break;

              case 'text':
                sendToRenderer('recording-progress', message.payload.message);
                break;

              case 'result': {
                // Stash for unexpected_exit recovery when stop buffer is absent.
                const normalizedLive = normalizeRecordingStopPayload(message.payload, {
                  existsSync: fs.existsSync,
                });
                if (normalizedLive && !normalizedLive.error) {
                  lastLiveRecorderResult = normalizedLive;
                }
                break;
              }

              case 'json':
                if (message.payload.message) {
                  sendToRenderer('recording-progress', message.payload.message);
                }
                break;

              default:
                break;
            }
          }
        };
        proc.stdout.on('data', onStdoutData);

        proc.stderr.on('data', (data) => {
          const output = data.toString();
          console.log(`Python status: ${output}`);
        });

        const handleProcessClosed = (code) => {
          clearTimeout(timeoutHandle);

          // Stale close from an older child must not clear a newer session.
          if (pythonProcess && pythonProcess !== proc) {
            return;
          }
          if (activeRecordingSessionId != null && activeRecordingSessionId !== sessionId) {
            return;
          }

          const recoveredStopResult = lastLiveRecorderResult;
          const closeAction = getRecorderCloseAction({
            recordingStarted,
            stopInProgress: Boolean(recordingStopPromise),
            startupSettled,
            startupFailureMessage,
            progressStage,
            exitCode: code,
            suppressUnexpectedExitWarning: suppressUnexpectedExitAfterStopTimeout,
            recoveredStopResult,
          });

          if (closeAction.type === 'stop_in_progress') {
            return;
          }

          const clearOpts = {
            expectedProcess: proc,
            expectedSessionId: sessionId,
          };

          if (closeAction.type === 'startup_already_settled') {
            clearRecordingRuntimeState('recording startup already settled', clearOpts);
            return;
          }

          if (closeAction.type === 'unexpected_exit_suppressed') {
            clearRecordingRuntimeState('recorder stop timeout force-kill', clearOpts);
            recordingStarted = false;
            startupSettled = true;
            return;
          }

          clearRecordingRuntimeState(
            closeAction.type === 'unexpected_exit'
              || closeAction.type === 'unexpected_exit_recovered'
              ? 'recorder exited unexpectedly'
              : 'recording failed',
            clearOpts,
          );
          recordingStarted = false;

          if (closeAction.type === 'unexpected_exit_recovered' && closeAction.recoveredStopResult?.audioPath) {
            const recovered = closeAction.recoveredStopResult;
            // Do not mark quitPersistedAudioPaths here — no stop IPC is waiting
            // to consume the flag (that Set is only for quit-cancel ↔ stop races).
            Promise.resolve()
              .then(() => persistRecoveredRecordingAfterUnexpectedExit(recovered))
              .then(() => {
                sendToRenderer('recording-saved-during-quit', {
                  audioPath: recovered.audioPath,
                  duration: recovered.duration || 0,
                  message: 'Recorder exited unexpectedly, but the recording file was recovered. Open History to continue.',
                });
                if (closeAction.warning) {
                  sendStructuredWarning(closeAction.warning, closeAction.warning.level || 'warning');
                }
              })
              .catch((persistError) => {
                console.warn('Failed to persist recovered recording after unexpected exit:', persistError.message);
                failActiveRecording({
                  type: 'recorder_exited',
                  code: 'RECORDER_EXITED',
                  level: 'error',
                  message: recovered.message
                    || 'Recorder exited unexpectedly after startup.',
                  help: 'A recording file may still exist on disk. Open History or scan recordings after relaunch.',
                });
              });
            startupSettled = true;
            return;
          }

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
          if (activeRecordingSessionId != null && activeRecordingSessionId !== sessionId) {
            return;
          }

          clearTimeout(timeoutHandle);

          if (recordingStopPromise) {
            return;
          }

          const wasRecording = recordingStarted;
          recordingStarted = false;
          clearRecordingRuntimeState(spawnError?.message || 'recorder process error', {
            expectedProcess: proc,
            expectedSessionId: sessionId,
          });

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
        timeoutHandle = setTimeout(() => {
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
        } catch (error) {
          settleStartupFailure(error?.message || 'Failed to start recording.');
        }
      });
    });

    /**
     * Stop recording
     */
    ipcMain.handle('stop-recording', async (event) => {
      assertTrustedRendererSender(event);
      const result = await waitForRecordingStop({
        forceKillOnTimeout: true,
        timeoutMessage: 'Recording stop timeout - process took too long to finish',
      });
      // Close the quit-cancel race: the shared stop promise can resolve while
      // the forced-quit dialog is still open (before recoverRecordingAfterQuitCanceled
      // assigns quitStopRecoveryPromise). Await the whole quit workflow so cancel
      // recovery can mark the path before we return to the renderer.
      const quitWorkflow = typeof getQuitWorkflowPromise === 'function'
        ? getQuitWorkflowPromise()
        : null;
      if (quitWorkflow) {
        try {
          await quitWorkflow;
        } catch (_) {
          // Quit workflow errors are already reported on the quit path.
        }
      }
      if (quitStopRecoveryPromise) {
        try {
          await quitStopRecoveryPromise;
        } catch (_) {
          // Recovery errors are already reported on the quit path.
        }
      }
      // Quit-cancel recovery may already have persisted this path; tell the
      // renderer to skip the normal transcribe-and-save flow for the same file.
      return consumeQuitPersistedFlag(result);
    });
  }

  return {
    getQuitInterceptInputs,
    handleQuitDuringRecording,
    forceKillRecordingOnShutdown,
    clearRecordingRuntimeState,
    getCaptureState,
    stopRecordingProcess,
    waitForRecordingStop,
    parseRecordingStopResultFromStdout,
    registerIpc,
  };
}

function registerRecorderService(ipcMain, deps) {
  const service = createRecorderService(deps);
  service.registerIpc(ipcMain);
  return service;
}

module.exports = { createRecorderService, registerRecorderService };
