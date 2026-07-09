'use strict';

/**
 * Summary generation IPC service for the AvaNevis main process.
 *
 * Owns the single shared `activeSummaryGeneration` reference and registers
 * `generate-summary` / `cancel-summary-generation`. Preflight runs before
 * enqueue; the generation subprocess stays on `enqueueAiComputeAction`.
 * Handler bodies are moved verbatim from `src/main.js`; cross-module
 * dependencies are injected via `deps`.
 */

const {
  buildHuggingFaceOfflineEnv,
  parseAiBackendProgressLine,
  AI_COMPUTE_TIMEOUT_MS,
  runWallClockComputeAction,
} = require('../main-process-helpers');
const {
  checkAiAddonSetupStatus,
  getSummaryArtifactPath,
  getSummaryRuntimeDir,
} = require('../ai-addon-setup');
const {
  getSummaryArtifactForPlatform,
} = require('../ai-addon-state');

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {object} deps.pythonConfig
 * @param {Function} deps.spawnTrackedPython
 * @param {Function} deps.getBackendModuleArgs
 * @param {Function} deps.enqueueAiComputeAction
 * @param {Function} deps.createAiAddonCancelError
 * @param {Function} deps.getAiAddonRuntimeOptions
 * @param {Function} deps.buildSummaryArgs
 * @param {Function} deps.collectPythonProcessOutput
 * @param {Function} deps.sendToRenderer
 * @param {Function} deps.appendSpawnLogBuffer
 * @param {Function} deps.appendSpawnJsonStdout
 * @param {Function} deps.assertTrustedRendererSender
 * @param {Function} deps.assertSafeExistingTranscriptPath
 * @param {Function} deps.assertSafeExistingSegmentsPath
 * @param {Function} deps.terminateProcessBestEffort
 * @param {Function} deps.summarizeSummaryValidationError
 */
function createSummaryService(deps) {
  // Single shared reference — never duplicate this let in main.js.
  let activeSummaryGeneration = null;

  const {
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
    assertSafeExistingTranscriptPath,
    assertSafeExistingSegmentsPath,
    terminateProcessBestEffort,
    summarizeSummaryValidationError,
  } = deps;

  async function removeSummarySidecarFiles(filePaths = []) {
    await Promise.all(filePaths.filter(Boolean).map((filePath) => (
      fs.promises.rm(filePath, { force: true }).catch(() => {})
    )));
  }

  function canAbortActiveSummaryGeneration() {
    return Boolean(
      activeSummaryGeneration?.controller
      && !activeSummaryGeneration.controller.signal.aborted
      && activeSummaryGeneration.phase !== 'metadata'
    );
  }

  function hasActiveSummaryGeneration() {
    return Boolean(activeSummaryGeneration);
  }

  function getActiveSummaryPhase() {
    return activeSummaryGeneration?.phase ?? null;
  }

  function abortActiveSummaryForQuit(message = 'Summary generation was canceled because the app is quitting.') {
    if (canAbortActiveSummaryGeneration()) {
      activeSummaryGeneration.controller.abort(createAiAddonCancelError(message));
      terminateProcessBestEffort(activeSummaryGeneration.process);
    }
  }

  function registerIpc(ipcMain) {
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
  }

  return {
    hasActiveSummaryGeneration,
    canAbortActiveSummaryGeneration,
    abortActiveSummaryForQuit,
    getActiveSummaryPhase,
    registerIpc,
  };
}

/**
 * Convenience wiring helper: build the summary service and register IPC.
 * Returns the service so quit-flow helpers in main.js can call the exported
 * probes and abort helpers.
 */
function registerSummaryService(ipcMain, deps) {
  const service = createSummaryService(deps);
  service.registerIpc(ipcMain);
  return service;
}

module.exports = { createSummaryService, registerSummaryService };
