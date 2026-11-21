'use strict';

const fs = require('fs');
const path = require('path');
const { getSummaryModelFit } = require('./summary-device-fit');

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
  getSharedSummaryRuntimeDir,
  getSummaryRuntimePeakBytes,
  getSummaryRuntimeExecutablePath,
  bindFsMethod,
  updateManifestFeature,
  loadManifest,
  saveAiAddonManifest,
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
  runtimeDirOverride = null,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  const sourceArtifact = getSummaryArtifactForPlatform(modelId, platform, arch, catalog);
  const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(platform, arch, catalog, modelId);
  const artifact = sourceArtifact && { ...sourceArtifact, runtimeArtifactId: runtimeArtifact?.id, ...(runtimeDirOverride ? { runtimeDirOverride } : {}) };
  const runtimeError = validateSummaryRuntimeArtifact(runtimeArtifact);
  if (runtimeError) {
    throw new Error(runtimeError);
  }

  const existingCache = await checkSummaryRuntimeCache({
    userDataDir,
    platform,
    arch,
    modelId,
    fsModule,
    catalog,
    verifyChecksum: true,
    verifyChecksumIfChanged: true,
    runtimeDirOverride,
  });
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
      await extractor(archivePath, extractDir, runtimeArchive.archiveFormat, { cancelSignal });
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

  const runtimeCache = await checkSummaryRuntimeCache({
    userDataDir,
    platform,
    arch,
    modelId,
    fsModule,
    catalog,
    verifyChecksum: true,
    runtimeDirOverride,
  });
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
  cudaStatus,
  deviceMemory,
} = {}) {
  if (modelId && !catalog.summary.models.some((model) => model.id === modelId)) throw new Error('Unknown summary model.');
  const selectedModelId = resolveModelId('summary', modelId || loadManifest({ userDataDir, fsModule, catalog }).summaryLibrary.defaultModelId, catalog);
  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'validating',
    message: 'Validating local summary model.',
    modelId: selectedModelId,
    percent: 95,
  });

  const availability = getSummaryAvailability(platform, arch, { cudaStatus });
  const cache = await checkSummaryModelCache({
    userDataDir,
    platform,
    arch,
    modelId: selectedModelId,
    fsModule,
    catalog,
    verifyChecksum: true,
  });
  const runtimeCache = await checkSummaryRuntimeCache({
    userDataDir,
    platform,
    arch,
    modelId: selectedModelId,
    fsModule,
    catalog,
    verifyChecksum: true,
  });
  let status = cache.valid ? 'ready' : 'error';
  let message = cache.valid ? 'Local summary model is ready.' : cache.reason;

  if (!availability.supported) {
    status = 'unsupported';
    message = availability.reason;
  } else if (cache.valid && !runtimeCache.valid) {
    status = 'error';
    message = runtimeCache.reason;
  } else if (!cache.installed) {
    status = 'notConfigured';
  } else if (cache.valid && runtimeCache.valid && typeof runtimeValidator === 'function') {
    try {
      await runtimeValidator({
        modelId: selectedModelId,
        cache,
        runtimeCache,
        runtimeArtifact: runtimeCache.runtimeArtifact,
        runtimeDir: runtimeCache.runtimeDir,
        cancelSignal,
      });
    } catch (runtimeError) {
      if (isAiAddonCancelError(runtimeError)) {
        throw runtimeError;
      }
      status = 'error';
      message = runtimeError.message || 'Local summary runtime validation failed.';
    }
  }

  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
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

  return checkAiAddonSetupStatus({
    userDataDir,
    platform,
    arch,
    safeStorage,
    fsModule,
    catalog,
    verifyChecksums: true,
    cudaStatus,
    summaryModelId: selectedModelId,
    deviceMemory,
  });
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
  cudaStatus,
  deviceMemory,
  runExclusiveMutation = async (operation) => operation(),
} = {}) {
  if (modelId && !catalog.summary.models.some((model) => model.id === modelId)) throw new Error('Unknown summary model.');
  const selectedModelId = resolveModelId('summary', modelId || loadManifest({ userDataDir, fsModule, catalog }).summaryLibrary.defaultModelId, catalog);
  throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
  const sourceArtifact = getSummaryArtifactForPlatform(selectedModelId, platform, arch, catalog);
  const runtimeArtifact = getSummaryRuntimeArtifactForPlatform(platform, arch, catalog, selectedModelId);
  const artifact = sourceArtifact && { ...sourceArtifact, runtimeArtifactId: runtimeArtifact?.id };
  const availability = getSummaryAvailability(platform, arch, { cudaStatus });
  const artifactError = availability.supported ? validatePinnedSummarySetup({ artifact, runtimeArtifact }) : availability.reason;
  const model = catalog.summary.models.find((item) => item.id === selectedModelId);
  const fit = getSummaryModelFit({ model, artifact, availability, runtimeArtifact, deviceMemory, platform });
  if (fit.blocked) throw new Error(fit.reason || 'This device cannot safely run the selected summary model.');

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
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
  }

  // Adopt a verified private runtime from a legacy installation without fetching it again.
  const sharedRuntimeDir = getSharedSummaryRuntimeDir(userDataDir, artifact, catalog);
  if (!fsModule.existsSync(sharedRuntimeDir) && typeof fsModule.renameSync === 'function') {
    const manifest = loadManifest({ userDataDir, fsModule, catalog });
    for (const installedModelId of Object.keys(manifest.summaryLibrary.models)) {
      const candidate = await checkSummaryRuntimeCache({ userDataDir, platform, arch, modelId: installedModelId, fsModule, catalog, verifyChecksum: true });
      if (candidate.valid && candidate.runtimeArtifact?.id === runtimeArtifact?.id && candidate.runtimeDir !== sharedRuntimeDir) {
        try {
          await runExclusiveMutation(async () => {
            throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
            if (!fsModule.existsSync(sharedRuntimeDir)) {
              fsModule.mkdirSync(path.dirname(sharedRuntimeDir), { recursive: true });
              fsModule.renameSync(candidate.runtimeDir, sharedRuntimeDir);
            }
          });
        } catch (error) {
          if (error.code !== 'EXDEV') throw error;
          // A private runtime on a separate volume stays available to its owner.
        }
        break;
      }
    }
  }
  const cache = await checkSummaryModelCache({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog, verifyChecksum: true });
  const runtimeCache = await checkSummaryRuntimeCache({
    userDataDir,
    platform,
    arch,
    modelId: selectedModelId,
    fsModule,
    catalog,
    verifyChecksum: true,
  });
  const modelDownloadBytes = Number(artifact?.estimatedSizeBytes) || 0;
  // Reserve room for temporary downloads plus extraction; unknown space is reported by status.
  const peakFreeBytes = (cache.valid ? 0 : modelDownloadBytes * 2) + (runtimeCache.valid ? 0 : getSummaryRuntimePeakBytes(runtimeArtifact));
  if (peakFreeBytes && typeof fsModule.statfsSync === 'function') {
    const cacheRoot = path.join(userDataDir, 'ai-addons');
    fsModule.mkdirSync(cacheRoot, { recursive: true });
    const volume = fsModule.statfsSync(cacheRoot);
    const shortfall = peakFreeBytes - Number(volume.bavail) * Number(volume.bsize);
    if (shortfall > 0) {
      throw new Error(`Not enough free disk space for the summary model download and setup. Free ${(shortfall / 1e9).toFixed(2)} GB and retry.`);
    }
  }
  const hadValidModelBeforeSetup = cache.valid;
  const hadValidRuntimeBeforeSetup = runtimeCache.valid;
  const hadRuntimeFilesBeforeSetup = fsModule.existsSync(getSummaryRuntimeDir(userDataDir, artifact, fsModule));
  const otherRuntimeReference = Object.keys(loadManifest({ userDataDir, fsModule, catalog }).summaryLibrary.models).some((id) => id !== selectedModelId && getSummaryRuntimeArtifactForPlatform(platform, arch, catalog, id)?.id === runtimeArtifact?.id);
  const cleanupDownloadedSummaryArtifacts = async ({ includeModel = !hadValidModelBeforeSetup, includeRuntime = !hadValidRuntimeBeforeSetup } = {}) => {
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
    await runExclusiveMutation(async () => {
    if (includeRuntime && !hadRuntimeFilesBeforeSetup && !otherRuntimeReference) {
      rmSync(getSummaryRuntimeDir(userDataDir, artifact, fsModule), { recursive: true, force: true });
    }
    if (includeModel) {
      // Remove only this download. The model can also own a legacy runtime.
      rmSync(getSummaryArtifactPath(userDataDir, artifact), { force: true });
    }
    });
  };
  if (cache.valid && runtimeCache.valid) {
    try {
      return await validateSummaryModel({
        userDataDir,
        platform,
        arch,
        modelId: selectedModelId,
        profile,
        safeStorage,
        fsModule,
        catalog,
        now,
        emitProgress,
        runtimeValidator,
        cancelSignal,
        cudaStatus,
        deviceMemory,
      });
    } catch (validationError) {
      if (isAiAddonCancelError(validationError)) {
        const message = 'Summary model setup was canceled. Existing local model and runtime were kept.';
        await cleanupDownloadedSummaryArtifacts({ includeModel: false, includeRuntime: false });
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
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
      }
      throw validationError;
    }
  }

  if (!runtimeCache.valid) {
    try {
      throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
      const target = getSharedSummaryRuntimeDir(userDataDir, artifact, catalog);
      const staging = `${target}.staging`;
      const backup = `${target}.backup`;
      fsModule.rmSync(staging, { recursive: true, force: true });
      try {
        await installSummaryRuntime({ userDataDir, platform, arch, modelId: selectedModelId, fsModule, catalog,
          emitProgress, downloader, extractor, cancelSignal, runtimeDirOverride: staging });
        await runExclusiveMutation(async () => {
          throwIfAiAddonCanceled(cancelSignal, 'Summary model setup was canceled.');
          if (!fsModule.existsSync(target) && fsModule.existsSync(backup)) fsModule.renameSync(backup, target);
          fsModule.rmSync(backup, { recursive: true, force: true });
          const hadTarget = fsModule.existsSync(target);
          if (hadTarget) fsModule.renameSync(target, backup);
          try {
            fsModule.renameSync(staging, target);
          } catch (error) {
            if (hadTarget) fsModule.renameSync(backup, target);
            throw error;
          }
          fsModule.rmSync(backup, { recursive: true, force: true });
        });
      } finally {
        fsModule.rmSync(staging, { recursive: true, force: true });
      }
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
        await cleanupDownloadedSummaryArtifacts({ includeModel: false, includeRuntime: !hadValidRuntimeBeforeSetup });
        emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
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
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
    }
  }

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
        await cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
        emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
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
      await cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
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
      await cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
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
      await cleanupDownloadedSummaryArtifacts({ includeModel: !hadValidModelBeforeSetup, includeRuntime: !hadValidRuntimeBeforeSetup });
      emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
    }

    if (!renameSync) {
      throw new Error('File system does not support installing summary setup artifacts.');
    }
    await runExclusiveMutation(async () => renameSync(tempPath, artifactPath));
  }

  try {
    const status = await validateSummaryModel({
      userDataDir,
      platform,
      arch,
      modelId: selectedModelId,
      profile,
      safeStorage,
      fsModule,
      catalog,
      now,
      emitProgress,
      runtimeValidator,
      cancelSignal,
      cudaStatus,
      deviceMemory,
    });
    if (status.features.summary.status !== 'ready') {
      await cleanupDownloadedSummaryArtifacts();
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
    }
    return status;
  } catch (validationError) {
    if (isAiAddonCancelError(validationError)) {
      const status = hadValidModelBeforeSetup && hadValidRuntimeBeforeSetup ? 'ready' : 'notConfigured';
      const percent = status === 'ready' ? 100 : 0;
      const message = hadValidModelBeforeSetup && hadValidRuntimeBeforeSetup
        ? 'Summary model setup was canceled. Existing local model and runtime were kept.'
        : 'Summary model setup was canceled. Partial downloads were removed.';
      await cleanupDownloadedSummaryArtifacts({
        includeModel: !hadValidModelBeforeSetup,
        includeRuntime: !hadValidRuntimeBeforeSetup,
      });
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
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, cudaStatus, deviceMemory, summaryModelId: selectedModelId });
    }
    throw validationError;
  }
}

async function removeSummaryModel({
  userDataDir, platform = process.platform, arch = process.arch, modelId,
  replacementModelId, safeStorage, fsModule = fs, catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(), emitProgress,
  runExclusiveMutation = async (operation) => operation(),
} = {}) {
  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const selectedModelId = modelId || manifest.summaryLibrary.defaultModelId || resolveModelId('summary', null, catalog);
  if (!catalog.summary.models.some((model) => model.id === selectedModelId)) throw new Error('Unknown summary model.');
  const pending = manifest.summaryLibrary.models[selectedModelId];
  replacementModelId = replacementModelId || pending?.replacementModelId || undefined;
  const alternatives = Object.entries(manifest.summaryLibrary.models)
    .filter(([id, entry]) => id !== selectedModelId && entry.status === 'ready').map(([id]) => id);
  if (manifest.summaryLibrary.defaultModelId === selectedModelId && alternatives.length > 1 && !replacementModelId) {
    throw new Error('Choose a replacement default before removing this model.');
  }
  if (replacementModelId && !alternatives.includes(replacementModelId)) throw new Error('Replacement summary model is not ready.');
  const entry = manifest.summaryLibrary.models[selectedModelId] || { modelId: selectedModelId, status: 'error' };
  entry.status = 'error';
  entry.error = 'Removal is incomplete. Retry removal.';
  entry.removalPending = true;
  entry.replacementModelId = replacementModelId || alternatives[0] || null;
  manifest.summaryLibrary.models[selectedModelId] = entry;
  saveAiAddonManifest({ userDataDir, manifest, fsModule, catalog });
  emitSafeProgress(emitProgress, { feature: 'summary', phase: 'removing', message: 'Removing local summary model.', modelId: selectedModelId });
  try {
    await runExclusiveMutation(async () => {
      fsModule.rmSync(getSummaryModelCacheDir(userDataDir, selectedModelId), { recursive: true, force: true });
      const runtimeId = getSummaryRuntimeArtifactForPlatform(platform, arch, catalog, selectedModelId)?.id;
      const otherReference = Object.keys(manifest.summaryLibrary.models).some((id) => id !== selectedModelId && getSummaryRuntimeArtifactForPlatform(platform, arch, catalog, id)?.id === runtimeId);
      if (!otherReference) {
        const artifact = getSummaryArtifactForPlatform(selectedModelId, platform, arch, catalog);
        const shared = getSharedSummaryRuntimeDir(userDataDir, artifact, catalog);
        for (const dir of [shared, `${shared}.staging`, `${shared}.backup`, `${shared}.adopting`]) fsModule.rmSync(dir, { recursive: true, force: true });
      }
    });
  } catch (error) {
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, summaryModelId: selectedModelId });
  }
  delete manifest.summaryLibrary.models[selectedModelId];
  if (manifest.summaryLibrary.defaultModelId === selectedModelId) manifest.summaryLibrary.defaultModelId = replacementModelId || alternatives[0] || null;
  manifest.features.summary = manifest.summaryLibrary.models[manifest.summaryLibrary.defaultModelId] || {
    status: 'notConfigured', modelId: selectedModelId, artifactId: null,
    lastValidation: createValidation('notConfigured', 'Local summary model was removed.', now), error: null,
  };
  saveAiAddonManifest({ userDataDir, manifest, fsModule, catalog });
  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
}

module.exports = {
  setupSummaryModel,
  validateSummaryModel,
  removeSummaryModel,
};
