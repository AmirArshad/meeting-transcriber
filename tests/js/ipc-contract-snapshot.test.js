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
  'cancel-summary-generation',
  'cancel-summary-model-setup',
  'check-audio-output',
  'check-cuda',
  'check-disk-space',
  'check-gpu',
  'check-model-downloaded',
  'delete-diarization-token',
  'delete-meeting',
  'diarize-transcript',
  'download-model',
  'download-update',
  'ensure-compatible-gpu-runtime',
  'generate-summary',
  'get-ai-addon-status',
  'get-arch',
  'get-audio-devices',
  'get-diarization-token-status',
  'get-macos-permission-status',
  'get-meeting',
  'get-pending-update-info',
  'get-platform',
  'get-system-info',
  'install-gpu',
  'list-meetings',
  'open-legal-notices',
  'open-system-settings',
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
  'recording-saved-during-quit',
  'recording-warning',
  'summary-progress',
  'transcription-progress',
  'update-available',
];

const EXPECTED_MAIN_PROCESS_HELPER_EXPORTS = [
  'AI_COMPUTE_TIMEOUT_MS',
  'ALLOWED_WHISPER_MODELS',
  'CUDA_RUNTIME_PROFILES',
  'GPU_RUNTIME_ACTION_TIMEOUT_MS',
  'MACOS_PERMISSION_CHECK_TIMEOUT_MS',
  'PYTORCH_CUDA_BIN_DIRS',
  'SPAWN_JSON_RESULT_BUFFER_MAX_CHARS',
  'SPAWN_LOG_BUFFER_MAX_CHARS',
  'UPDATER_HTTP_RESPONSE_MAX_CHARS',
  'appendCappedSpawnLogBuffer',
  'appendSpawnJsonResultBuffer',
  'buildDesktopAudioAvailabilityError',
  'buildDiarizationOutputPath',
  'buildFileUrl',
  'buildGuidedTranscriptTempPath',
  'buildHuggingFaceOfflineEnv',
  'buildMacOSPermissionCheckFailureStatus',
  'buildModelDownloadCheck',
  'buildPermissionErrorMessage',
  'buildPythonModuleArgs',
  'buildQuitRecordingDialogOptions',
  'buildRecorderBusyResponse',
  'buildRecordingPreflightReport',
  'buildTranscriberArgs',
  'buildTranscriptionCliArgs',
  'buildTranscriptionCudaInstallArgs',
  'buildTranscriptionCudaUninstallArgs',
  'buildTranscriptionRuntimeEnv',
  'buildUnsupportedCudaPythonMessage',
  'cacheContainsCompleteFasterWhisperModel',
  'cacheContainsCompleteMacMLXModel',
  'cacheContainsCompleteTranscriptionModel',
  'cacheContainsModel',
  'classifyCudaProbeStatus',
  'classifyRecorderStdoutChunk',
  'collectProcessesToKillOnQuit',
  'createLineChunkRedactor',
  'cudaStatusNeedsGpuRuntimeEnsure',
  'dedupeMessages',
  'dispatchBeforeQuitAction',
  'findRecorderResultPayload',
  'formatComputeTimeoutLabel',
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
  'isTrustedExternalUrl',
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
  'resolveBeforeQuitAction',
  'resolveCudaInstalledProfile',
  'resolveExistingRealPath',
  'resolveExternalUrl',
  'resolveStopTimeoutAction',
  'resolveTranscriptionAudioFile',
  'runGuidedTranscriptionProcess',
  'runWallClockComputeAction',
  'selectGpuInstallModeForCudaStatus',
  'shouldForceCpuTranscriptionFromCudaStatus',
  'shouldKillProcessOnQuit',
  'shouldSkipQuitComputeDrain',
  'splitBufferedLines',
  'summarizeAiBackendError',
  'terminateNonAbortableQuitComputeJobs',
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
