'use strict';

const { normalizeTagStrict } = require('../renderer/tag-helpers');
const { isCanonicalSpeakerKey, normalizeSpeakerName } = require('../renderer/speaker-label-helpers');

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
 * @param {Function} [deps.onMeetingsMutated] - notify derived caches (e.g. search index) on successful mutations
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
    onMeetingsMutated = () => {},
  } = deps;

  function notifyMeetingsMutated(detail) {
    try {
      onMeetingsMutated(detail);
    } catch (_error) {
      // Derived cache notifications must never break primary persistence.
    }
  }

  function addMeetingToHistory(meetingData) {
    let resolvedAudioPath;
    let resolvedTranscriptPath;
    let normalizedTag = null;

    try {
      resolvedAudioPath = assertSafeExistingRecordingAudioPath(meetingData.audioPath);
      resolvedTranscriptPath = assertSafeExistingTranscriptPath(meetingData.transcriptPath);
      if (Object.hasOwn(meetingData || {}, 'tag') && meetingData.tag !== undefined && meetingData.tag !== null && meetingData.tag !== '') {
        normalizedTag = normalizeTagStrict(meetingData.tag);
      }
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
        args.push(`--title=${title}`);
      }
      if (normalizedTag) {
        args.push('--tag', normalizedTag);
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
      if (meetingData.transcriptionRequest) {
        const boundedRequest = boundedTranscriptionRecord(meetingData.transcriptionRequest);
        if (!boundedRequest) {
          reject(new Error('add-meeting transcription request is empty'));
          return;
        }
        args.push('--request-json', JSON.stringify(boundedRequest));
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
            const addedMeeting = JSON.parse(processOutput.getStdout());
            notifyMeetingsMutated({ action: 'add', meeting: addedMeeting });
            resolve(addedMeeting);
          } catch (error) {
            reject(new Error(`Failed to parse saved meeting: ${error.message}`));
          }
          return;
        }

        const diagnostic = processOutput.getStderr().trim();
        if (diagnostic.split(/\r?\n/).includes('MEETING_STORAGE_FULL')) {
          reject(Object.assign(new Error('There is not enough space to save the meeting.'), { code: 'ENOSPC' }));
          return;
        }
        reject(new Error(`Failed to save meeting: ${diagnostic || 'Unknown error'}`));
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
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
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
          if (settled || timedOut) {
            return;
          }
          try {
            processOutput.assertStdoutWithinLimit();
          } catch (error) {
            finish(reject, error);
            return;
          }

          if (code === 0) {
            try {
              finish(resolve, JSON.parse(processOutput.getStdout()));
            } catch (e) {
              finish(reject, new Error(`Failed to parse scan result: ${e.message}`));
            }
          } else {
            const errorMsg = processOutput.getStderr().trim() || 'Unknown error';
            finish(reject, new Error(`Failed to scan recordings: ${errorMsg}`));
          }
        });

        python.on('error', (error) => {
          if (!timedOut) finish(reject, error);
        });
        scanTimeout = setTimeout(async () => {
          timedOut = true;
          try {
            await terminateProcessBestEffort(python);
          } catch (_) {
            // Report the scanner timeout even if termination fails.
          }
          finish(reject, new Error('Recording recovery scan timed out.'));
        }, recordingsScanTimeoutMs);
        if (unrefRecordingsScanTimeout) {
          scanTimeout.unref?.();
        }
      });
      // The scanner deadline has ended. Keep admission through durable staging.
      if (typeof options.beforeAutoResume === 'function') {
        await options.beforeAutoResume(result);
      }
      try {
        onScanSucceeded();
      } catch (_) {
        // Best-effort recovery banner cleanup.
      }
      notifyMeetingsMutated({ action: 'scan', result });
      return result;
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

  function getMeeting(meetingId) {
    return new Promise((resolve, reject) => {
      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      const python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
        '--recordings-dir', recordingsDir,
        'get',
        String(meetingId || '').trim(),
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
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('list-meetings', async () => listMeetings());

    /**
     * Get a single meeting
     */
    ipcMain.handle('get-meeting', async (event, meetingId) => getMeeting(meetingId));

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
              notifyMeetingsMutated({ action: 'delete', meetingId: id });
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
        args.push(`--title=${updates.title}`);
      }
      if (Object.hasOwn(updates, 'tag') && updates.tag !== undefined) {
        const normalizedTag = normalizeTagStrict(updates.tag);
        if (normalizedTag === null) {
          args.push('--clear-tag');
        } else {
          args.push('--tag', normalizedTag);
        }
      }
      if (Object.hasOwn(updates, 'speakerNames')) {
        const names = updates.speakerNames;
        const expectedHash = updates.expectedSourceTranscriptHash;
        const expectedAttempt = updates.expectedTranscriptionAttemptId;
        if (!names || typeof names !== 'object' || Array.isArray(names)
            || Object.keys(names).length > 199 || Object.entries(names).some(([speaker, name]) => (
              !isCanonicalSpeakerKey(speaker) || typeof name !== 'string' || name.length > 1024
            ))) {
          throw new Error('Invalid speaker names.');
        }
        if (typeof expectedHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expectedHash)) {
          throw new Error('Speaker names require the current transcript.');
        }
        const patch = Object.fromEntries(Object.entries(names)
          .map(([speaker, name]) => [speaker, normalizeSpeakerName(name)]));
        args.push('--speaker-names-json', JSON.stringify(patch), '--expected-source-transcript-hash', expectedHash);
        if (expectedAttempt !== undefined) {
          if (typeof expectedAttempt !== 'string' || expectedAttempt.length > 128 || expectedAttempt.includes('\0')) {
            throw new Error('Invalid transcription attempt.');
          }
          args.push(`--expected-transcription-attempt-id=${expectedAttempt}`);
        }
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
              notifyMeetingsMutated({ action: 'update', meeting: updatedMeeting });
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
            const updatedAiMeeting = JSON.parse(processOutput.getStdout());
            notifyMeetingsMutated({ action: 'update-ai', meeting: updatedAiMeeting });
            resolve(updatedAiMeeting);
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

  const TRANSCRIPTION_REQUEST_KEYS = [
    'schemaVersion',
    'attemptId',
    'engine',
    'modelId',
    'artifactRevision',
    'adapterId',
    'runtimeLockId',
    'language',
    'boundaryPolicy',
    'modelSize',
  ];

  const TRANSCRIPTION_RESULT_KEYS = [
    ...TRANSCRIPTION_REQUEST_KEYS,
    'device',
    'computeType',
    'transcriptHash',
  ];

  function boundedRecord(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const bounded = {};
    for (const key of keys) {
      if (value[key] != null && value[key] !== '') {
        bounded[key] = value[key];
      }
    }
    return Object.keys(bounded).length ? bounded : null;
  }

  function boundedTranscriptionRecord(value) {
    return boundedRecord(value, TRANSCRIPTION_REQUEST_KEYS);
  }

  function boundedTranscriptionResult(value) {
    return boundedRecord(value, TRANSCRIPTION_RESULT_KEYS);
  }

  function runMeetingManagerCommand(args, registerProcess = null) {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    return new Promise((resolve, reject) => {
      let python = spawnTrackedPython(getBackendModuleArgs('meeting_manager', [
        '--recordings-dir', recordingsDir,
        ...args,
      ]), { cwd: pythonConfig.backendPath });
      if (typeof registerProcess === 'function') python = registerProcess(python);
      const processOutput = collectPythonProcessOutput(python, { jsonResult: true });
      python.on('close', (code) => {
        try {
          processOutput.assertStdoutWithinLimit();
        } catch (error) {
          reject(error);
          return;
        }
        if (code !== 0) {
          reject(new Error(processOutput.getStderr().trim() || 'Meeting manager command failed'));
          return;
        }
        try {
          resolve(JSON.parse(processOutput.getStdout()));
        } catch (error) {
          reject(new Error(`Failed to parse meeting manager result: ${error.message}`));
        }
      });
      python.on('error', reject);
    });
  }

  function stageTranscriptionRequest(meetingId, request, guards = {}) {
    const bounded = boundedTranscriptionRecord(request);
    if (!meetingId || !bounded) {
      return Promise.reject(new Error('stage-transcription-request requires a meeting and bounded request'));
    }
    return runMeetingManagerCommand([
      'stage-transcription-request',
      String(meetingId),
      '--request-json', JSON.stringify(bounded),
      '--cancel-generation', String(guards.cancelGeneration || 0),
      '--delete-generation', String(guards.deleteGeneration || 0),
    ]);
  }

  function excludeIncompleteTranscription(meetingId) {
    if (!meetingId) {
      return Promise.reject(new Error('exclude-incomplete-transcription requires a meeting'));
    }
    return runMeetingManagerCommand([
      'exclude-incomplete-transcription',
      String(meetingId),
    ]).then((result) => {
      notifyMeetingsMutated({ action: 'exclude-incomplete', meetingId: String(meetingId) });
      return result;
    });
  }

  function failTranscriptionAttempt(meetingId, attemptId, errorMessage, registerProcess = null) {
    if (!meetingId || !attemptId) {
      return Promise.reject(new Error('fail-transcription-attempt requires a meeting and attempt'));
    }
    return runMeetingManagerCommand([
      'fail-transcription-attempt', String(meetingId),
      '--attempt-id', String(attemptId),
      '--error', String(errorMessage || 'Transcription failed.').slice(0, 500),
    ], registerProcess).then((result) => {
      notifyMeetingsMutated({ action: 'fail-transcription', meetingId: String(meetingId) });
      return result;
    });
  }

  function commitTranscriptionAttempt(meetingId, payload = {}, registerProcess = null) {
    const bounded = boundedTranscriptionResult(payload.result);
    if (!meetingId || !payload.attemptId || !payload.candidatePath || !bounded) {
      return Promise.reject(new Error('commit-transcription-attempt requires a candidate and bounded result'));
    }
    const args = [
      'commit-transcription-attempt',
      String(meetingId),
      '--attempt-id', String(payload.attemptId),
      '--candidate', String(payload.candidatePath),
      '--result-json', JSON.stringify(bounded),
      '--cancel-generation', String(payload.cancelGeneration || 0),
      '--delete-generation', String(payload.deleteGeneration || 0),
    ];
    if (payload.captionsCandidatePath) {
      args.push('--captions-candidate', String(payload.captionsCandidatePath));
    }
    return runMeetingManagerCommand(args, registerProcess).then((result) => {
      notifyMeetingsMutated({ action: 'commit-transcription', meetingId: String(meetingId), meeting: result });
      return result;
    });
  }

  return {
    addMeetingToHistory,
    updateMeetingAiMetadata,
    stageTranscriptionRequest,
    excludeIncompleteTranscription,
    commitTranscriptionAttempt,
    failTranscriptionAttempt,
    boundedTranscriptionRecord,
    boundedTranscriptionResult,
    isRecordingsScanInProgress,
    scanRecordings,
    listMeetings,
    getMeeting,
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
