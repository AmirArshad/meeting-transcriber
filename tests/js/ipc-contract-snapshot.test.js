'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  ROOT,
  readUtf8,
  readCombinedMainProcessSource,
  extractIpcMainHandleChannels,
  findDuplicateIpcMainHandleChannels,
  extractWebContentsSendChannels,
  extractPreloadInvokeChannels,
  extractPreloadListenerChannels,
} = require('./source-scan-helpers');

const PRELOAD_PATH = path.join(ROOT, 'src', 'preload.js');

/** Sorted snapshot of ipcMain.handle channel names (Phase 0.1). */
const EXPECTED_INVOKE_CHANNELS = [
  'add-meeting',
  'cancel-diarization-setup',
  'cancel-download-model',
  'cancel-pending-transcription',
  'cancel-summary-generation',
  'cancel-summary-model-setup',
  'check-audio-output',
  'check-cuda',
  'check-disk-space',
  'check-gpu',
  'check-model-downloaded',
  'defer-recording-recovery',
  'delete-diarization-token',
  'delete-meeting',
  'diarize-transcript',
  'download-model',
  'download-update',
  'ensure-compatible-gpu-runtime',
  'finalize-recording-transcription',
  'generate-summary',
  'get-ai-addon-status',
  'get-arch',
  'get-audio-devices',
  'get-diarization-token-status',
  'get-macos-permission-status',
  'get-meeting',
  'get-pending-update-info',
  'get-platform',
  'get-recording-recovery-state',
  'get-recording-state',
  'get-system-info',
  'install-gpu',
  'list-meetings',
  'open-legal-notices',
  'open-system-settings',
  'recover-recording',
  'remove-diarization-setup',
  'remove-summary-model',
  'retry-transcription',
  'run-recording-preflight',
  'save-speaker-segments-file',
  'save-transcript-as',
  'save-transcript-file',
  'scan-recordings',
  'setup-diarization',
  'setup-summary-model',
  'start-recording',
  'stop-recording',
  'store-diarization-token',
  'transcribe-audio',
  'transcribe-audio-with-speakers',
  'uninstall-gpu',
  'update-meeting',
  'update-meeting-ai',
  'validate-devices',
  'validate-diarization-setup',
  'validate-summary-model',
  'warm-up-audio-system',
];

/** Sorted snapshot of preload listener / main push channels (Phase 0.1). */
const EXPECTED_PUSH_CHANNELS = [
  'ai-addon-progress',
  'app-quit-progress',
  'audio-levels',
  'diarization-progress',
  'gpu-install-progress',
  'model-download-progress',
  'recording-failed',
  'recording-init-progress',
  'recording-progress',
  'recording-recovery-state-changed',
  'recording-saved-during-quit',
  'recording-warning',
  'summary-progress',
  'transcription-progress',
  'transcription-queue-state',
  'update-available',
];

const EXPECTED_MAIN_PROCESS_HELPER_EXPORTS = [
  'AI_COMPUTE_TIMEOUT_MS',
  'ALLOWED_WHISPER_MODELS',
  'CUDA_RUNTIME_PROFILES',
  'GPU_RUNTIME_ACTION_TIMEOUT_MS',
  'MACOS_PERMISSION_CHECK_TIMEOUT_MS',
  'PYTORCH_CUDA_BIN_DIRS',
  'QUEUE_JOB_PHASES',
  'QUEUE_JOB_STATUSES',
  'SPAWN_JSON_RESULT_BUFFER_MAX_CHARS',
  'SPAWN_LOG_BUFFER_MAX_CHARS',
  'TRANSCRIPTION_QUEUE_STATE_CHANNEL',
  'UPDATER_HTTP_RESPONSE_MAX_CHARS',
  'USER_CANCELLED_TRANSCRIPTION_ERROR',
  'appendCappedSpawnLogBuffer',
  'appendSpawnJsonResultBuffer',
  'buildClearedHuggingFaceTokenEnv',
  'buildDesktopAudioAvailabilityError',
  'buildDiarizationOutputPath',
  'buildFileUrl',
  'buildGuidedDiarizationAiMetadata',
  'buildGuidedTranscriptTempPath',
  'buildHuggingFaceOfflineEnv',
  'buildMacOSPermissionCheckFailureStatus',
  'buildMeetingTranscriptMarkdown',
  'buildModelDownloadCheck',
  'buildPermissionErrorMessage',
  'buildPythonModuleArgs',
  'buildQuitRecordingDialogOptions',
  'buildRecorderBusyResponse',
  'buildRecordingPreflightReport',
  'buildSpeakerSidecarPayload',
  'buildTranscriberArgs',
  'buildTranscriptionCliArgs',
  'buildTranscriptionCudaInstallArgs',
  'buildTranscriptionCudaUninstallArgs',
  'buildTranscriptionQueueStatePayload',
  'buildTranscriptionRuntimeEnv',
  'buildUnsupportedCudaPythonMessage',
  'cacheContainsCompleteFasterWhisperModel',
  'cacheContainsCompleteMacMLXModel',
  'cacheContainsCompleteTranscriptionModel',
  'cacheContainsModel',
  'classifyCudaProbeStatus',
  'classifyRecorderStdoutChunk',
  'clearTranscriptionJobCancelFlag',
  'collectProcessesToKillOnQuit',
  'createLineChunkRedactor',
  'createTranscriptionQueueState',
  'cudaStatusNeedsGpuRuntimeEnsure',
  'dedupeMessages',
  'dispatchBeforeQuitAction',
  'findRecorderResultPayload',
  'formatComputeTimeoutLabel',
  'formatTranscriptSegmentTimestamp',
  'getActiveWallClockComputeJob',
  'getActiveWallClockComputeJobs',
  'getCudaRuntimeProfile',
  'getCudaRuntimeProfiles',
  'getGpuRuntimeEnsurePlan',
  'getGuidedTranscriptionComputeTimeoutMs',
  'getGuidedTranscriptionTimeoutMinutes',
  'getLegalNoticesPath',
  'getMacMLXCacheDir',
  'getMacMLXModelStorageDirs',
  'getModelDownloadCacheDir',
  'getModelDownloadPatterns',
  'getPyTorchCudaBinCandidates',
  'getPythonSitePackagesCandidates',
  'getQuitInterceptState',
  'getRecorderCloseAction',
  'getRecorderEventAction',
  'getRecorderResultAudioPath',
  'getRecordingStopTimeout',
  'getRequiredCudaRuntimeDlls',
  'getSupportedTranscriptionCudaProfileIds',
  'getTranscriberModule',
  'getTranscriptionComputeTimeoutMs',
  'getTranscriptionCudaPackages',
  'isModelDownloadErrorOutput',
  'isNonAbortableLongComputeJob',
  'isPathInsideDirectory',
  'isRecorderBusy',
  'isRetryableCudaTranscriptionError',
  'isSafeRecordingsAudioPath',
  'isSafeRecordingsJsonPath',
  'isSafeRecordingsMarkdownPath',
  'isSafeRecordingsPath',
  'isSupportedCudaInstallPythonVersion',
  'isTranscriptionJobCancelled',
  'isTrustedExternalUrl',
  'markTranscriptionJobCancelled',
  'matchesFasterWhisperCacheFolderName',
  'normalizeModelSize',
  'normalizeRecorderLevels',
  'normalizeRecordingStopPayload',
  'parseAiBackendProgressLine',
  'parseCheckCudaStatus',
  'parsePythonVersion',
  'parseRecorderMessageLine',
  'parseRecorderStdoutChunk',
  'parseRecordingStopResult',
  'redactSensitiveText',
  'removeQueueJob',
  'resolveBeforeQuitAction',
  'resolveCudaInstalledProfile',
  'resolveExistingRealPath',
  'resolveExternalUrl',
  'resolveStopTimeoutAction',
  'resolveTranscriptionAudioFile',
  'runGuidedTranscriptionProcess',
  'runWallClockComputeAction',
  'selectGpuInstallModeForCudaStatus',
  'setActiveQueueMeeting',
  'shouldForceCpuTranscriptionFromCudaStatus',
  'shouldKillProcessOnQuit',
  'shouldSkipJobAtHead',
  'shouldSkipQuitComputeDrain',
  'splitBufferedLines',
  'summarizeAiBackendError',
  'terminateNonAbortableQuitComputeJobs',
  'upsertQueueJob',
];

const EXPECTED_AI_ADDON_SETUP_EXPORTS = [
  'AI_ADDON_CANCEL_CODE',
  'AI_ADDON_PROGRESS_CHANNEL',
  'buildDiarizationDependencyInstallArgs',
  'checkAiAddonSetupStatus',
  'checkDiarizationDependencyCache',
  'checkMacOSCompilerToolchain',
  'checkSummaryModelCache',
  'checkSummaryRuntimeCache',
  'createAiAddonProgressEvent',
  'downloadDiarizationSourceArtifacts',
  'downloadFile',
  'downloadHuggingFaceSummaryArtifact',
  'extractRuntimeArchive',
  'extractTarGzArchive',
  'extractZipArchive',
  'getDiarizationDependencySitePackagesDir',
  'getDiarizationModelCacheDir',
  'getDiarizationTokenStatus',
  'getSummaryArtifactPath',
  'getSummaryModelCacheDir',
  'getSummaryRuntimeArchivePath',
  'getSummaryRuntimeDir',
  'getSummaryRuntimeExecutablePath',
  'installDiarizationDependencies',
  'isAiAddonCancelError',
  'isAllowedDownloadUrl',
  'isLikelyHuggingFaceToken',
  'removeDiarizationSetup',
  'removeSummaryModel',
  'saveAiAddonManifest',
  'setupDiarizationAddon',
  'setupSummaryModel',
  'summarizePipProgress',
  'validateDiarizationSetup',
  'validateSummaryModel',
  'validateTarListing',
];

test('ipcMain.handle channels match the Phase 0 invoke snapshot', () => {
  const combined = readCombinedMainProcessSource();
  assert.deepEqual(extractIpcMainHandleChannels(combined), EXPECTED_INVOKE_CHANNELS);
});

test('ipcMain.handle channels are registered at most once', () => {
  const combined = readCombinedMainProcessSource();
  assert.deepEqual(findDuplicateIpcMainHandleChannels(combined), []);
});

test('preload invoke channels match main handle channels', () => {
  const preloadSource = readUtf8(PRELOAD_PATH);
  const preloadInvoke = extractPreloadInvokeChannels(preloadSource);
  const mainHandles = extractIpcMainHandleChannels(readCombinedMainProcessSource());

  assert.deepEqual(preloadInvoke, EXPECTED_INVOKE_CHANNELS);
  assert.deepEqual(preloadInvoke, mainHandles);
});

test('preload listener channels and main push channels match the Phase 0 send snapshot', () => {
  const preloadSource = readUtf8(PRELOAD_PATH);
  const listenerChannels = extractPreloadListenerChannels(preloadSource);
  const sendChannels = extractWebContentsSendChannels(readCombinedMainProcessSource());

  assert.deepEqual(listenerChannels, EXPECTED_PUSH_CHANNELS);
  assert.deepEqual(sendChannels, EXPECTED_PUSH_CHANNELS);
});

test('main-process-helpers facade export keys stay stable', () => {
  const helpers = require('../../src/main-process-helpers');
  assert.deepEqual(Object.keys(helpers).sort(), EXPECTED_MAIN_PROCESS_HELPER_EXPORTS);
});

test('ai-addon-setup facade export keys stay stable', () => {
  const setup = require('../../src/ai-addon-setup');
  assert.deepEqual(Object.keys(setup).sort(), EXPECTED_AI_ADDON_SETUP_EXPORTS);
});

test('AI_ADDON_PROGRESS_CHANNEL and AI_ADDON_CANCEL_CODE keep their pinned string values', () => {
  // Phase 4 requires these exact values; pin them here so preload literals cannot
  // diverge from the exported constants without failing Phase 0.1.
  const {
    AI_ADDON_PROGRESS_CHANNEL,
    AI_ADDON_CANCEL_CODE,
  } = require('../../src/ai-addon-setup');

  assert.equal(AI_ADDON_PROGRESS_CHANNEL, 'ai-addon-progress');
  assert.equal(AI_ADDON_CANCEL_CODE, 'AI_ADDON_SETUP_CANCELLED');

  const preloadSource = readUtf8(PRELOAD_PATH);
  assert.match(
    preloadSource,
    new RegExp(`addListener\\(\\s*['"]${AI_ADDON_PROGRESS_CHANNEL}['"]`),
  );

  const sendChannels = extractWebContentsSendChannels(readCombinedMainProcessSource());
  assert.ok(sendChannels.includes(AI_ADDON_PROGRESS_CHANNEL));
});

test('Phase 0.1 scan roots include main.js and survive a future src/main/ tree', () => {
  const mainEntry = path.join(ROOT, 'src', 'main.js');
  assert.equal(fs.existsSync(mainEntry), true);

  // Directory may not exist yet; the scanner must still succeed and include main.js.
  const combined = readCombinedMainProcessSource();
  assert.match(combined, /\/\* FILE: src\/main\.js \*\//);
});

test('main.js Python spawn sites consume asynchronous child errors', () => {
  const source = readUtf8(path.join(ROOT, 'src', 'main.js'));
  const permissionFunction = source.match(/function checkMacOSPermissions\(\)[\s\S]*?\n\}/);
  assert.ok(permissionFunction, 'expected checkMacOSPermissions function');
  assert.match(permissionFunction[0], /proc\.on\(['"]error['"]/);

  const systemInfoHandler = source.match(/ipcMain\.handle\(['"]get-system-info['"][\s\S]*?\n\}\);/);
  assert.ok(systemInfoHandler, 'expected get-system-info handler');
  assert.match(systemInfoHandler[0], /python\.on\(['"]error['"]/);
  assert.match(systemInfoHandler[0], /python:\s*version/);
});
