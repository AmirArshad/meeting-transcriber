'use strict';

/**
 * Meeting-manager IPC client for the AvaNevis main process.
 *
 * Wraps the Python `meeting_manager` module behind the meeting-history IPC
 * channels and the `addMeetingToHistory` helper (also used by the quit flow).
 * Handler bodies are moved verbatim from `src/main.js`; only cross-module
 * dependencies are injected via `deps`.
 */

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('path')} deps.path
 * @param {Function} deps.spawnTrackedPython
 * @param {object} deps.pythonConfig
 * @param {Function} deps.getBackendModuleArgs
 * @param {Function} deps.collectPythonProcessOutput
 * @param {Function} deps.appendSpawnLogBuffer
 * @param {Function} deps.assertTrustedRendererSender
 * @param {Function} deps.sanitizeTranscriptionError
 * @param {Function} deps.getRecordingsDir
 * @param {Function} deps.assertSafeExistingRecordingAudioPath
 * @param {Function} deps.assertSafeExistingTranscriptPath
 * @param {Function} deps.validateAiMetadataPaths
 * @param {Function} [deps.isRecorderBusy]
 * @param {Function} [deps.terminateProcessBestEffort]
 * @param {Function} [deps.beforeDeleteMeeting] - cancel/terminate queued transcription before delete
 * @param {Function} [deps.afterDeleteMeeting] - clear delete tombstone after meeting_manager delete settles
 * @param {Function} [deps.afterUpdateMeeting] - sync queue job title after rename
 * @param {number} [deps.recordingsScanTimeoutMs]
 * @param {object} [deps.recordingsMaintenanceGate]
 */
function createMeetingManagerClient(deps) {
  let recordingsScanInProgress = false;
  const meetingUpdateTailById = new Map();
  const {
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
    isRecorderBusy = () => false,
    terminateProcessBestEffort = async (proc) => proc.kill(),
    beforeDeleteMeeting = async () => {},
    afterDeleteMeeting = async () => {},
    afterUpdateMeeting = async () => {},
    recordingsScanTimeoutMs = 60 * 1000,
    unrefRecordingsScanTimeout = true,
    recordingsMaintenanceGate = null,
    onScanSucceeded = () => {},
  } = deps;

  function addMeetingToHistory(meetingData) {
    let resolvedAudioPath;
    let resolvedTranscriptPath;

    try {
      resolvedAudioPath = assertSafeExistingRecordingAudioPath(meetingData.audioPath);
      resolvedTranscriptPath = assertSafeExistingTranscriptPath(meetingData.transcriptPath);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise((resolve, reject) => {
      const {
        duration,
        language,
        model,
        title,
        transcriptionStatus,
        transcriptionError,
        transcriptionDevice,
        transcriptionComputeType,
      } = meetingData;
      const recordingsDir = getRecordingsDir();
      const args = getBackendModuleArgs('meeting_manager', [
        '--recordings-dir', recordingsDir,
        'add',
        '--audio', resolvedAudioPath,
        '--transcript', resolvedTranscriptPath,
        '--duration', String(duration || 0),
        '--language', language || 'en',
        '--model', model || 'unknown'
      ]);

      if (title) {
        args.push('--title', title);
      }
      if (transcriptionStatus) {
        args.push('--transcription-status', String(transcriptionStatus));
      }
      if (transcriptionError) {
        args.push('--transcription-error', sanitizeTranscriptionError(transcriptionError));
      }
      if (transcriptionDevice) {
        args.push('--transcription-device', String(transcriptionDevice));
      }
      if (transcriptionComputeType) {
        args.push('--transcription-compute-type', String(transcriptionComputeType));
      }

      const python = spawnTrackedPython(args, { cwd: pythonConfig.backendPath });

      const processOutput = collectPythonProcessOutput(python, { jsonResult: true });

      python.on('close', (code) => {
        try {
          processOutput.assertStdoutWithinLimit();
        } catch (error) {
          reject(error);
          return;
        }

        if (code === 0) {
          try {
            resolve(JSON.parse(processOutput.getStdout()));
          } catch (error) {
            reject(new Error(`Failed to parse saved meeting: ${error.message}`));
          }
          return;
        }

        reject(new Error(`Failed to save meeting: ${processOutput.getStderr().trim() || 'Unknown error'}`));
      });

      python.on('error', reject);
    });
  }

  function isRecordingsScanInProgress() {
    if (recordingsMaintenanceGate && typeof recordingsMaintenanceGate.getOwner === 'function') {
      return recordingsMaintenanceGate.getOwner() === 'scan' || recordingsScanInProgress;
    }
    return recordingsScanInProgress;
  }

  function enqueueMeetingUpdate(meetingId, action) {
    const id = String(meetingId);
    const previous = meetingUpdateTailById.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(action);
    const tail = run.catch(() => {});
    meetingUpdateTailById.set(id, tail);
    void tail.finally(() => {
      if (meetingUpdateTailById.get(id) === tail) {
        meetingUpdateTailById.delete(id);
      }
    });
    return run;
  }

  /**
   * Scan recordings directory and sync with database.
   * Acquires the shared recordings-maintenance gate as `scan` when provided.
   */
  async function scanRecordings(options = {}) {
    const alreadyHoldingScan = Boolean(options && options.alreadyHoldingScan);
    if (isRecorderBusy()) {
      const error = new Error('Recording recovery scan is unavailable while a recording is active or being saved.');
      error.code = 'RECORDING_IN_PROGRESS';
      throw error;
    }
    if (recordingsScanInProgress) {
      const error = new Error('Recording recovery scan is already running.');
      error.code = 'RECORDING_SCAN_IN_PROGRESS';
      throw error;
    }

    if (recordingsMaintenanceGate && !alreadyHoldingScan) {
      const admission = await recordingsMaintenanceGate.acquire('scan');
      if (!admission.ok) {
        const error = new Error(admission.message || 'Recordings maintenance is in progress.');
        error.code = admission.code || 'RECORDINGS_MAINTENANCE_IN_PROGRESS';
        throw error;
      }
    } else if (
      alreadyHoldingScan
      && recordingsMaintenanceGate
      && recordingsMaintenanceGate.getOwner() !== 'scan'
    ) {
      const error = new Error('Scan was requested without holding the recordings maintenance gate.');
      error.code = 'RECORDINGS_MAINTENANCE_IN_PROGRESS';
      throw error;
    }

    recordingsScanInProgress = true;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        let scanTimeout = null;
        const finish = (callback, value) => {
          if (settled) {
            return;
          }
          settled = true;
          if (scanTimeout) {
            clearTimeout(scanTimeout);
          }
          callback(value);
        };
        const recordingsDir = path.join(app.getPath('userData'), 'recordings');
        const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
          '--recordings-dir', recordingsDir,
          'scan'
        ]), { cwd: pythonConfig.backendPath });

        const processOutput = collectPythonProcessOutput(python, { jsonResult: true });

        python.on('close', (code) => {
          try {
            processOutput.assertStdoutWithinLimit();
          } catch (error) {
            finish(reject, error);
            return;
          }

          if (code === 0) {
            try {
              const result = JSON.parse(processOutput.getStdout());
              try {
                onScanSucceeded();
              } catch (_) {
                // Best-effort recovery banner cleanup.
              }
              finish(resolve, result);
            } catch (e) {
              finish(reject, new Error(`Failed to parse scan result: ${e.message}`));
            }
          } else {
            const errorMsg = processOutput.getStderr().trim() || 'Unknown error';
            finish(reject, new Error(`Failed to scan recordings: ${errorMsg}`));
          }
        });

        python.on('error', (error) => finish(reject, error));
        scanTimeout = setTimeout(async () => {
          await terminateProcessBestEffort(python);
          finish(reject, new Error('Recording recovery scan timed out.'));
        }, recordingsScanTimeoutMs);
        if (unrefRecordingsScanTimeout) {
          scanTimeout.unref?.();
        }
      });
    } finally {
      recordingsScanInProgress = false;
      // Caller that transferred recovery→scan owns release of the scan hold.
      if (recordingsMaintenanceGate && !alreadyHoldingScan) {
        recordingsMaintenanceGate.release('scan');
      }
    }
  }

  function listMeetings() {
    return new Promise((resolve, reject) => {
      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
        '--recordings-dir', recordingsDir,
        'list'
      ]), { cwd: pythonConfig.backendPath });

      const processOutput = collectPythonProcessOutput(python, { jsonResult: true });

      python.on('close', (code) => {
        try {
          processOutput.assertStdoutWithinLimit();
        } catch (error) {
          reject(error);
          return;
        }

        if (code === 0) {
          try {
            const meetings = JSON.parse(processOutput.getStdout());
            resolve(meetings);
          } catch (e) {
            reject(new Error(`Failed to parse meetings: ${e.message}`));
          }
        } else {
          const errorMsg = processOutput.getStderr().trim() || 'Unknown error';
          reject(new Error(`Failed to list meetings: ${errorMsg}`));
        }
      });
      python.on('error', reject);
    });
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('list-meetings', async () => listMeetings());

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

        const processOutput = collectPythonProcessOutput(python, { jsonResult: true });

        python.on('close', (code) => {
          try {
            processOutput.assertStdoutWithinLimit();
          } catch (error) {
            reject(error);
            return;
          }

          if (code === 0) {
            try {
              const meeting = JSON.parse(processOutput.getStdout());
              resolve(meeting);
            } catch (e) {
              reject(new Error(`Failed to parse meeting: ${e.message}`));
            }
          } else {
            const errorMsg = processOutput.getStderr().trim() || 'Meeting not found';
            reject(new Error(errorMsg));
          }
        });
        python.on('error', reject);
      });
    });

    /**
     * Delete a meeting
     */
    ipcMain.handle('delete-meeting', async (event, meetingId) => {
      assertTrustedRendererSender(event);

      const id = String(meetingId || '').trim();
      if (!id) {
        throw new Error('delete-meeting requires a meetingId');
      }

      // Terminate+cancel any in-memory transcription job first so the compute
      // queue cannot write artifacts after the tombstone (PR2 delete-while-queued).
      // Failures must surface — swallowing would let delete proceed while a job
      // can still recreate transcript/sidecar files.
      // Tombstone stays until afterDeleteMeeting in finally (generation-owned;
      // may defer clear until in-flight settlement so delete IPC does not hang).
      const deletePrep = await beforeDeleteMeeting(id);

      const recordingsDir = path.join(app.getPath('userData'), 'recordings');

      try {
        return await new Promise((resolve, reject) => {
          const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
            '--recordings-dir', recordingsDir,
            'delete',
            id
          ]), { cwd: pythonConfig.backendPath });

          let errorOutput = '';

          python.stderr.on('data', (data) => {
            errorOutput = appendSpawnLogBuffer(errorOutput, data);
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
      } finally {
        try {
          await afterDeleteMeeting(id, deletePrep);
        } catch (clearError) {
          console.warn(
            'Could not clear transcription delete guard:',
            clearError && clearError.message,
          );
        }
      }
    });

    /**
     * Scan recordings directory and sync with database
     */
    ipcMain.handle('scan-recordings', async () => scanRecordings());

    /**
     * Add a meeting (called after transcription)
     */
    ipcMain.handle('add-meeting', async (event, meetingData) => {
      assertTrustedRendererSender(event);
      return addMeetingToHistory(meetingData);
    });

    ipcMain.handle('update-meeting', async (event, payload) => {
      assertTrustedRendererSender(event);

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

      return enqueueMeetingUpdate(meetingId, () => new Promise((resolve, reject) => {
        const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', args), {
          cwd: pythonConfig.backendPath,
        });

        const processOutput = collectPythonProcessOutput(python, { jsonResult: true });

        python.on('close', async (code) => {
          try {
            processOutput.assertStdoutWithinLimit();
          } catch (error) {
            reject(error);
            return;
          }

          if (code === 0) {
            try {
              const updatedMeeting = JSON.parse(processOutput.getStdout());
              if (!updatedMeeting) {
                reject(new Error('Meeting was not found.'));
                return;
              }
              try {
                await afterUpdateMeeting(updatedMeeting);
              } catch (syncError) {
                console.warn('afterUpdateMeeting failed:', syncError && syncError.message);
              }
              resolve(updatedMeeting);
            } catch (e) {
              reject(new Error(`Failed to parse updated meeting: ${e.message}`));
            }
          } else {
            reject(new Error(processOutput.getStderr().trim() || 'Failed to update meeting'));
          }
        });

        python.on('error', (err) => reject(err));
      }));
    });

    ipcMain.handle('update-meeting-ai', async (event, payload) => {
      assertTrustedRendererSender(event);

      const meetingId = payload && payload.meetingId;
      const updates = (payload && payload.updates) || {};
      return updateMeetingAiMetadata(meetingId, updates);
    });
  }

  function updateMeetingAiMetadata(meetingId, rawUpdates = {}, registerProcess = null) {
    const updates = validateAiMetadataPaths(rawUpdates || {});
    if (!meetingId) {
      return Promise.reject(new Error('update-meeting-ai requires a meetingId'));
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

        if (code === 0) {
          try {
            resolve(JSON.parse(processOutput.getStdout()));
          } catch (e) {
            reject(new Error(`Failed to parse updated AI meeting metadata: ${e.message}`));
          }
        } else {
          reject(new Error(processOutput.getStderr().trim() || 'Failed to update AI meeting metadata'));
        }
      });

      python.on('error', (err) => reject(err));
    });
  }

  return {
    addMeetingToHistory,
    updateMeetingAiMetadata,
    isRecordingsScanInProgress,
    scanRecordings,
    listMeetings,
    registerIpc,
  };
}

/**
 * Convenience wiring helper: build the client and register its IPC handlers.
 * Returns the client so callers can reach `addMeetingToHistory`.
 */
function registerMeetingManagerClient(ipcMain, deps) {
  const client = createMeetingManagerClient(deps);
  client.registerIpc(ipcMain);
  return client;
}

module.exports = { createMeetingManagerClient, registerMeetingManagerClient };
