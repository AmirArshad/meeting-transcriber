'use strict';

/**
 * Recorder lifecycle service for the AvaNevis main process.
 *
 * Owns recording mutable state (pythonProcess, stop/heartbeat/power-save) and
 * registers run-recording-preflight / start-recording / stop-recording.
 * Quit-during-recording helpers are exported for the composition-root
 * before-quit handler. Handler bodies are moved verbatim; deps are injected.
 */

const {
  buildRecordingPreflightReport,
  buildQuitRecordingDialogOptions,
  getRecorderCloseAction,
  getRecorderEventAction,
  getRecordingStopTimeout,
  parseRecordingStopResult,
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
    validateSelectedDevices,
    checkDiskSpace,
    checkAudioOutputSupport,
    getMacOSPermissionStatus,
    addMeetingToHistory,
    formatDurationForTranscript,
    getRecordingsDir,
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
  let recordingStopPromise = null;
  let stopCommandSent = false;
  let recordingSessionCounter = 0;

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

    const quitPromptWindow = getMainWindow();
    if (quitPromptWindow && !quitPromptWindow.isDestroyed()) {
      return dialog.showMessageBox(quitPromptWindow, options);
    }

    return dialog.showMessageBox(options);
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

      try {
        const result = await waitForRecordingStop({
          forceKillOnTimeout: false,
          timeoutMessage: 'Recorder stop is taking longer than expected.',
        });

        if (result?.audioPath) {
          await persistStoppedRecordingForQuit(result);
        }

        // Recording quit previously armed allowImmediateQuit and skipped AI drain.
        // Drain in-flight transcription/summary/GPU work before the final quit pass.
        if (hasInFlightAiWork()) {
          await drainAiWorkBeforeQuit();
        }

        setAllowImmediateQuit(true);
        setIsQuitting(true);
        app.quit();
        return;
      } catch (error) {
        console.warn('Graceful quit stop failed:', error.message);
        const response = await promptForForcedQuit(quitState.state, error);

        if (response.response === 1) {
          if (hasInFlightAiWork()) {
            await drainAiWorkBeforeQuit();
          }
          setAllowImmediateQuit(true);
          setIsQuitting(true);
          app.quit();
          return;
        }

        setIsQuitting(false);
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
        pythonProcess.kill();
      } catch (e) {
        // Process might already be dead, ignore
      }
    }
  }

  function registerIpc(ipcMain) {
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
          sendToRenderer('recording-init-progress', { stage, message });
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
            sessionId,
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
              sendToRenderer('recording-warning', {
                type: 'heartbeat_lost',
                sessionId,
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

              case 'result':
                break;

              case 'json':
                if (message.payload.message) {
                  sendToRenderer('recording-progress', message.payload.message);
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
  }

  return {
    getQuitInterceptInputs,
    handleQuitDuringRecording,
    forceKillRecordingOnShutdown,
    clearRecordingRuntimeState,
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
