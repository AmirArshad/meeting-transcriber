'use strict';

const fs = require('fs');
const path = require('path');

const {
  AI_MODEL_CATALOG,
  getSummaryArtifactForPlatform,
  getSummaryAvailability,
  getSummaryRuntimeArtifactForPlatform,
  resolveModelId,
} = require('../ai-addon-state');

const {
  emitSafeProgress,
  clampPercent,
  clampBytes,
  throwIfAiAddonCanceled,
  isAiAddonCancelError,
} = require('./progress-events');

const {
  downloadFile,
  downloadHuggingFaceSummaryArtifact,
  isHuggingFaceSummaryArtifact,
} = require('./download-helpers');

const {
  checkAiAddonSetupStatus,
  checkSummaryModelCache,
  checkSummaryRuntimeCache,
  getSummaryArtifactPath,
  getSummaryModelCacheDir,
  getSummaryRuntimeArchivePath,
  getSummaryRuntimeDir,
  getSummaryRuntimeExecutablePath,
  bindFsMethod,
  updateManifestFeature,
  getSummaryRuntimeExtractDir,
  getSummaryRuntimeArchiveDir,
  hashFileSha256,
  validateSummaryRuntimeArtifact,
  validatePinnedSummarySetup,
  createValidation,
  buildFeatureUpdates,
} = require('./manifest-store');

const {
  extractRuntimeArchive,
  finalizeInstalledRuntimeExecutable,
} = require('./archive-install');

async function installSummaryRuntime({
  userDataDir,
  platform,
  arch,
  modelId,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  emitProgress,
  downloader = downloadFile,
  extractor = extractRuntimeArchive,
  cancelSignal,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  const artifact = getSummaryArtifactForPlatform(modelId, platform, arch, catalog);
  const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(platform, arch, catalog);
  const runtimeError = validateSummaryRuntimeArtifact(runtimeArtifact);
  if (runtimeError) {
    throw new Error(runtimeError);
  }

  const existingCache = checkSummaryRuntimeCache({ userDataDir, platform, arch, modelId, fsModule, catalog });
  if (existingCache.valid) {
    return existingCache;
  }

  const runtimeDir = getSummaryRuntimeDir(userDataDir, artifact);
  const extractDir = getSummaryRuntimeExtractDir(userDataDir, artifact, runtimeArtifact);
  const archiveDir = getSummaryRuntimeArchiveDir(userDataDir, artifact);
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  if (mkdirSync) {
    mkdirSync(runtimeDir, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
  }
  const staleTopLevelExecutablePath = getSummaryRuntimeExecutablePath(userDataDir, artifact, runtimeArtifact);
  if (unlinkSync && existsSync?.(staleTopLevelExecutablePath)) {
    try {
      unlinkSync(staleTopLevelExecutablePath);
    } catch (cleanupError) {
      // Best effort: ignore stale executable cleanup failures.
    }
  }
  if (rmSync) {
    rmSync(extractDir, { recursive: true, force: true });
  }
  if (mkdirSync) {
    mkdirSync(extractDir, { recursive: true });
  }

  for (let index = 0; index < runtimeArtifact.artifacts.length; index += 1) {
    const runtimeArchive = runtimeArtifact.artifacts[index];
    const archivePath = getSummaryRuntimeArchivePath(userDataDir, artifact, runtimeArchive);
    const tempPath = `${archivePath}.download`;
    const totalRuntimeBytes = runtimeArtifact.artifacts.reduce((total, archive) => total + (Number(archive.sizeBytes) || 0), 0);
    const completedRuntimeBytes = runtimeArtifact.artifacts
      .slice(0, index)
      .reduce((total, archive) => total + (Number(archive.sizeBytes) || 0), 0);
    const runtimeArchiveStartPercent = clampPercent(totalRuntimeBytes ? (completedRuntimeBytes / totalRuntimeBytes) * 100 : (index / runtimeArtifact.artifacts.length) * 100);
    const runtimeArchiveCompletePercent = clampPercent(totalRuntimeBytes ? ((completedRuntimeBytes + (Number(runtimeArchive.sizeBytes) || 0)) / totalRuntimeBytes) * 100 : ((index + 1) / runtimeArtifact.artifacts.length) * 100);
    emitSafeProgress(emitProgress, {
      feature: 'summary',
      phase: 'downloading-runtime',
      message: 'Downloading local summary runtime.',
      modelId,
      percent: runtimeArchiveStartPercent,
      downloadedBytes: clampBytes(completedRuntimeBytes, totalRuntimeBytes),
      totalBytes: totalRuntimeBytes || undefined,
    });
    try {
      await downloader({
        url: runtimeArchive.downloadUrl,
        destinationPath: tempPath,
        expectedSizeBytes: runtimeArchive.sizeBytes,
        cancelSignal,
        onProgress: (progress) => emitSafeProgress(emitProgress, {
          feature: 'summary',
          phase: 'downloading-runtime',
          message: 'Downloading local summary runtime.',
          percent: clampPercent(totalRuntimeBytes
            ? ((completedRuntimeBytes + (progress.downloaded || 0)) / totalRuntimeBytes) * 100
            : ((index + (progress.percent || 0) / 100) / runtimeArtifact.artifacts.length) * 100),
          downloadedBytes: clampBytes(completedRuntimeBytes + (progress.downloaded || 0), totalRuntimeBytes || progress.total),
          totalBytes: totalRuntimeBytes || progress.total,
          modelId,
        }),
      });
    } catch (downloadError) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw downloadError;
    }

    try {
      emitSafeProgress(emitProgress, {
        feature: 'summary',
        phase: 'validating',
        message: 'Verifying local summary runtime download.',
        modelId,
        percent: runtimeArchiveCompletePercent,
      });
      throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
    } catch (cancelError) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw cancelError;
    }

    const actualSha256 = await hashFileSha256(tempPath, fsModule);
    if (actualSha256 !== runtimeArchive.sha256) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw new Error('Downloaded llama.cpp runtime checksum does not match the pinned checksum.');
    }

    if (!fsModule.renameSync) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw new Error('File system does not support installing summary runtime archives.');
    }
    fsModule.renameSync(tempPath, archivePath);
    emitSafeProgress(emitProgress, {
      feature: 'summary',
      phase: 'extracting-runtime',
      message: 'Installing local summary runtime.',
      modelId,
      percent: 95,
    });
    try {
      await extractor(archivePath, extractDir, runtimeArchive.archiveFormat);
    } catch (extractError) {
      if (rmSync) {
        rmSync(extractDir, { recursive: true, force: true });
      }
      if (unlinkSync) {
        try {
          unlinkSync(archivePath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw extractError;
    }
    if (unlinkSync) {
      try {
        unlinkSync(archivePath);
      } catch (cleanupError) {
        // Best effort cleanup: runtime archives are redownloadable from the pinned catalog.
      }
    }
  }

  finalizeInstalledRuntimeExecutable({ userDataDir, artifact, runtimeArtifact, fsModule });

  const runtimeCache = checkSummaryRuntimeCache({ userDataDir, platform, arch, modelId, fsModule, catalog });
  if (!runtimeCache.valid) {
    throw new Error(runtimeCache.reason || 'llama.cpp runtime installation did not produce the expected executable.');
  }

  return runtimeCache;
}

async function validateSummaryModel({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  profile,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  runtimeValidator,
  cancelSignal,
} = {}) {
  const selectedModelId = resolveModelId('summary', modelId, catalog);
  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'validating',
    message: 'Validating local summary model.',
    modelId: selectedModelId,
    percent: 95,
  });

  const availability = getSummaryAvailability(platform, arch);
  const cache = await checkSummaryModelCache({
    userDataDir,
    platform,
    arch,
    modelId: selectedModelId,
    fsModule,
    catalog,
    verifyChecksum: true,
  });
  const runtimeCache = checkSummaryRuntimeCache({
    userDataDir,
    platform,
    arch,
    modelId: selectedModelId,
    fsModule,
    catalog,
  });
  let status = cache.valid ? 'ready' : 'error';
  let message = cache.valid ? 'Local summary model is ready.' : cache.reason;

  if (!availability.supported) {
    status = 'unsupported';
    message = availability.reason;
  } else if (cache.valid && !runtimeCache.valid) {
    status = runtimeCache.validationStatus === 'pendingPinnedRuntime' ? 'error' : 'notConfigured';
    message = runtimeCache.reason;
  } else if (!cache.installed) {
    status = 'notConfigured';
  } else if (cache.valid && runtimeCache.valid && typeof runtimeValidator === 'function') {
    try {
      await runtimeValidator({ modelId: selectedModelId, cache, runtimeCache, cancelSignal });
    } catch (runtimeError) {
      if (isAiAddonCancelError(runtimeError)) {
        throw runtimeError;
      }
      status = 'error';
      message = runtimeError.message || 'Local summary runtime validation failed.';
    }
  }

  updateManifestFeature({
    userDataDir,
    feature: 'summary',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status,
      modelId: selectedModelId,
      artifactId: cache.artifactId || null,
      profile,
      validation: createValidation(status, message, now),
      error: status === 'ready' ? null : message,
    }),
  });

  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: status,
    status,
    message,
    modelId: selectedModelId,
    percent: status === 'ready' ? 100 : undefined,
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, verifyChecksums: true });
}

async function setupSummaryModel({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  profile,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  downloader = downloadFile,
  huggingFaceDownloader = downloadHuggingFaceSummaryArtifact,
  extractor = extractRuntimeArchive,
  runtimeValidator,
  pythonExe,
  backendPath,
  cancelSignal,
} = {}) {
  const selectedModelId = resolveModelId('summary', modelId, catalog);
  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  const artifact = getSummaryArtifactForPlatform(selectedModelId, platform, arch, catalog);
  const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(platform, arch, catalog);
  const availability = getSummaryAvailability(platform, arch);
  const artifactError = availability.supported ? validatePinnedSummarySetup({ artifact, runtimeArtifact }) : availability.reason;

  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'downloading',
    message: 'Checking local summary setup artifact.',
    modelId: selectedModelId,
    percent: 0,
  });

  if (artifactError) {
    const status = availability.supported ? 'error' : 'unsupported';
    updateManifestFeature({
      userDataDir,
      feature: 'summary',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status,
        modelId: selectedModelId,
        artifactId: artifact && artifact.artifactId,
        profile,
        validation: createValidation(status, artifactError, now),
        error: artifactError,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'summary', phase: status, status, message: artifactError, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  const cache = await checkSummaryModelCache({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog, verifyChecksum: true });
  const runtimeCache = checkSummaryRuntimeCache({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog });
  const hadValidModelBeforeSetup = cache.valid;
  const hadValidRuntimeBeforeSetup = runtimeCache.valid;
  const cleanupDownloadedSummaryArtifacts = ({ includeModel = !hadValidModelBeforeSetup, includeRuntime = !hadValidRuntimeBeforeSetup } = {}) => {
    const rmSync = bindFsMethod(fsModule, 'rmSync');
    const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
    if (unlinkSync && artifact) {
      try {
        unlinkSync(`${getSummaryArtifactPath(userDataDir, artifact)}.download`);
      } catch (cleanupError) {
        // Best effort cleanup.
      }
    }
    if (!rmSync) {
      return;
    }
    if (includeRuntime) {
      rmSync(getSummaryRuntimeDir(userDataDir, artifact), { recursive: true, force: true });
    }
    if (includeModel) {
      rmSync(getSummaryModelCacheDir(userDataDir, selectedModelId), { recursive: true, force: true });
    }
  };
  if (cache.valid && runtimeCache.valid) {
    try {
      return await validateSummaryModel({ userDataDir, platform, arch, modelId: selectedModelId, profile, safeStorage, fsModule, catalog, now, emitProgress, runtimeValidator, cancelSignal });
    } catch (validationError) {
      if (isAiAddonCancelError(validationError)) {
        const message = 'Summary model setup was canceled. Existing local model and runtime were kept.';
        cleanupDownloadedSummaryArtifacts({ includeModel: false, includeRuntime: false });
        updateManifestFeature({
          userDataDir,
          feature: 'summary',
          fsModule,
          catalog,
          updates: buildFeatureUpdates({
            status: 'ready',
            modelId: selectedModelId,
            artifactId: artifact && artifact.artifactId,
            profile,
            validation: createValidation('ready', message, now),
            error: null,
          }),
        });
        emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'ready', message, modelId: selectedModelId, percent: 100 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
      }
      throw validationError;
    }
  }

  if (!runtimeCache.valid) {
    try {
      await installSummaryRuntime({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog, emitProgress, downloader, extractor, cancelSignal });
    } catch (runtimeError) {
      if (isAiAddonCancelError(runtimeError)) {
        const message = 'Summary model setup was canceled. Partial downloads were removed.';
        updateManifestFeature({
          userDataDir,
          feature: 'summary',
          fsModule,
          catalog,
          updates: buildFeatureUpdates({
            status: 'notConfigured',
            modelId: selectedModelId,
            artifactId: artifact && artifact.artifactId,
            profile,
            validation: createValidation('notConfigured', message, now),
            error: null,
          }),
        });
        cleanupDownloadedSummaryArtifacts({ includeModel: false, includeRuntime: !hadValidRuntimeBeforeSetup });
        emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
      }

      const message = runtimeError.message || 'Local summary runtime setup failed.';
      updateManifestFeature({
        userDataDir,
        feature: 'summary',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'error',
          modelId: selectedModelId,
          artifactId: artifact && artifact.artifactId,
          profile,
          validation: createValidation('error', message, now),
          error: message,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }
  }

  const runtimeCacheAfterInstall = checkSummaryRuntimeCache({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog });

  if (!cache.valid) {
    const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
    const tempPath = `${artifactPath}.download`;
    const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
    const renameSync = bindFsMethod(fsModule, 'renameSync');
    const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
    if (mkdirSync) {
      mkdirSync(path.dirname(artifactPath), { recursive: true });
    }

    try {
      const selectedDownloader = isHuggingFaceSummaryArtifact(artifact) && pythonExe && backendPath
        ? (options) => huggingFaceDownloader({ ...options, artifact, userDataDir, pythonExe, backendPath, fsModule })
        : downloader;
      await selectedDownloader({
        url: artifact.downloadUrl,
        destinationPath: tempPath,
        expectedSizeBytes: artifact.estimatedSizeBytes,
        cancelSignal,
        onProgress: (progress) => emitSafeProgress(emitProgress, {
          feature: 'summary',
          phase: 'downloading',
          message: isHuggingFaceSummaryArtifact(artifact)
            ? 'Downloading local summary model through Hugging Face accelerated transfer.'
            : 'Downloading local summary setup artifact.',
          percent: progress.percent,
          downloadedBytes: progress.downloaded,
          totalBytes: progress.total || artifact.estimatedSizeBytes,
          modelId: selectedModelId,
        }),
      });
    } catch (downloadError) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      if (isAiAddonCancelError(downloadError)) {
        const message = 'Summary model setup was canceled. Partial downloads were removed.';
        updateManifestFeature({
          userDataDir,
          feature: 'summary',
          fsModule,
          catalog,
          updates: buildFeatureUpdates({
            status: 'notConfigured',
            modelId: selectedModelId,
            artifactId: hadValidModelBeforeSetup ? artifact.artifactId : null,
            profile,
            validation: createValidation('notConfigured', message, now),
            error: null,
          }),
        });
        cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
        emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
      }
      const message = downloadError.message || 'Local summary model download failed.';
      updateManifestFeature({
        userDataDir,
        feature: 'summary',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'error',
          modelId: selectedModelId,
          artifactId: artifact.artifactId,
          profile,
          validation: createValidation('error', message, now),
          error: message,
        }),
      });
      cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    try {
      throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
    } catch (cancelError) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      const message = 'Summary model setup was canceled. Partial downloads were removed.';
      updateManifestFeature({
        userDataDir,
        feature: 'summary',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'notConfigured',
          modelId: selectedModelId,
          artifactId: hadValidModelBeforeSetup ? artifact.artifactId : null,
          profile,
          validation: createValidation('notConfigured', message, now),
          error: null,
        }),
      });
      cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    emitSafeProgress(emitProgress, {
      feature: 'summary',
      phase: 'validating',
      message: 'Verifying local summary model download.',
      modelId: selectedModelId,
      percent: 100,
    });

    const actualSha256 = await hashFileSha256(tempPath, fsModule);
    if (actualSha256 !== artifact.sha256) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      const message = 'Downloaded summary setup artifact checksum does not match the pinned checksum.';
      updateManifestFeature({
        userDataDir,
        feature: 'summary',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'error',
          modelId: selectedModelId,
          artifactId: artifact.artifactId,
          profile,
          validation: createValidation('error', message, now),
          error: message,
        }),
      });
      cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    if (!renameSync) {
      throw new Error('File system does not support installing summary setup artifacts.');
    }
    renameSync(tempPath, artifactPath);
  }

  try {
    const status = await validateSummaryModel({ userDataDir, platform, arch, modelId: selectedModelId, profile, safeStorage, fsModule, catalog, now, emitProgress, runtimeValidator, cancelSignal });
    if (status.features.summary.status !== 'ready' && !hadValidRuntimeBeforeSetup && runtimeCacheAfterInstall.valid) {
      const rmSync = bindFsMethod(fsModule, 'rmSync');
      if (rmSync) {
        rmSync(getSummaryRuntimeDir(userDataDir, artifact), { recursive: true, force: true });
      }
    }
    return status;
  } catch (validationError) {
    if (isAiAddonCancelError(validationError)) {
      const status = hadValidModelBeforeSetup && hadValidRuntimeBeforeSetup ? 'ready' : 'notConfigured';
      const percent = status === 'ready' ? 100 : 0;
      const message = hadValidModelBeforeSetup && hadValidRuntimeBeforeSetup
        ? 'Summary model setup was canceled. Existing local model and runtime were kept.'
        : 'Summary model setup was canceled. Partial downloads were removed.';
      cleanupDownloadedSummaryArtifacts({ includeModel: status !== 'ready', includeRuntime: status !== 'ready' });
      updateManifestFeature({
        userDataDir,
        feature: 'summary',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status,
          modelId: selectedModelId,
          artifactId: artifact && artifact.artifactId,
          profile,
          validation: createValidation(status, message, now),
          error: null,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status, message, modelId: selectedModelId, percent });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }
    throw validationError;
  }
}

async function removeSummaryModel({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
} = {}) {
  const selectedModelId = resolveModelId('summary', modelId, catalog);
  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'removing',
    message: 'Removing local summary model.',
    modelId: selectedModelId,
  });

  if (fsModule.rmSync) {
    fsModule.rmSync(getSummaryModelCacheDir(userDataDir, selectedModelId), { recursive: true, force: true });
  }

  updateManifestFeature({
    userDataDir,
    feature: 'summary',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status: 'notConfigured',
      modelId: selectedModelId,
      artifactId: null,
      validation: createValidation('notConfigured', 'Local summary model was removed.', now),
      error: null,
    }),
  });

  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'notConfigured',
    status: 'notConfigured',
    message: 'Local summary model was removed.',
    modelId: selectedModelId,
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
}

module.exports = {
  setupSummaryModel,
  validateSummaryModel,
  removeSummaryModel,
};
