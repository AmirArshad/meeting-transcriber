'use strict';

const {
  AI_ADDON_PROGRESS_CHANNEL,
  AI_ADDON_CANCEL_CODE,
  createAiAddonProgressEvent,
  isAiAddonCancelError,
  summarizePipProgress,
} = require('./ai-addon/progress-events');

const {
  downloadFile,
  downloadHuggingFaceSummaryArtifact,
  isAllowedDownloadUrl,
  isLikelyHuggingFaceToken,
  getDiarizationTokenStatus,
} = require('./ai-addon/download-helpers');

const {
  saveAiAddonManifest,
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  checkSummaryModelCache,
  checkSummaryRuntimeCache,
  getDiarizationDependencySitePackagesDir,
  getDiarizationModelCacheDir,
  getSummaryArtifactPath,
  getSummaryModelCacheDir,
  getSummaryRuntimeArchivePath,
  getSummaryRuntimeDir,
  getSummaryRuntimeExecutablePath,
} = require('./ai-addon/manifest-store');

const {
  extractZipArchive,
  extractRuntimeArchive,
  extractTarGzArchive,
  validateTarListing,
} = require('./ai-addon/archive-install');

const {
  buildDiarizationDependencyInstallArgs,
  installDiarizationDependencies,
  downloadDiarizationSourceArtifacts,
  setupDiarizationAddon,
  validateDiarizationSetup,
  removeDiarizationSetup,
  checkMacOSCompilerToolchain,
} = require('./ai-addon/diarization-setup');

const {
  setupSummaryModel,
  validateSummaryModel,
  removeSummaryModel,
} = require('./ai-addon/summary-setup');

module.exports = {
  AI_ADDON_PROGRESS_CHANNEL,
  AI_ADDON_CANCEL_CODE,
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  checkMacOSCompilerToolchain,
  checkSummaryModelCache,
  checkSummaryRuntimeCache,
  buildDiarizationDependencyInstallArgs,
  createAiAddonProgressEvent,
  downloadFile,
  downloadHuggingFaceSummaryArtifact,
  extractZipArchive,
  extractRuntimeArchive,
  extractTarGzArchive,
  validateTarListing,
  getDiarizationTokenStatus,
  getDiarizationDependencySitePackagesDir,
  getDiarizationModelCacheDir,
  getSummaryArtifactPath,
  getSummaryModelCacheDir,
  getSummaryRuntimeArchivePath,
  getSummaryRuntimeDir,
  getSummaryRuntimeExecutablePath,
  isAllowedDownloadUrl,
  isAiAddonCancelError,
  isLikelyHuggingFaceToken,
  installDiarizationDependencies,
  downloadDiarizationSourceArtifacts,
  removeDiarizationSetup,
  removeSummaryModel,
  saveAiAddonManifest,
  setupDiarizationAddon,
  setupSummaryModel,
  summarizePipProgress,
  validateDiarizationSetup,
  validateSummaryModel,
};
