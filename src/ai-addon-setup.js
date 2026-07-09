'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  AI_MODEL_CATALOG,
  getAiAddonPaths,
  getDiarizationAvailability,
  getDiarizationModelRef,
  getDiarizationDependencyArtifactForPlatform,
  getSummaryArtifactForPlatform,
  getSummaryAvailability,
  getSummaryRuntimeArtifactForPlatform,
  resolveModelId,
} = require('./ai-addon-state');
const {
  TOKEN_KEYS,
  deleteAiAddonToken,
  getAiAddonToken,
  storeAiAddonToken,
} = require('./ai-addon-token-store');

const {
  AI_ADDON_PROGRESS_CHANNEL,
  AI_ADDON_CANCEL_CODE,
  createAiAddonProgressEvent,
  isAiAddonCancelError,
  summarizePipProgress,
  emitSafeProgress,
  clampPercent,
  clampBytes,
  createAiAddonCancelError,
  forceKillChildProcess,
  throwIfAiAddonCanceled,
  onAiAddonCancel,
} = require('./ai-addon/progress-events');

const {
  downloadFile,
  downloadHuggingFaceSummaryArtifact,
  isAllowedDownloadUrl,
  isLikelyHuggingFaceToken,
  getDiarizationTokenStatus,
  isHuggingFaceSummaryArtifact,
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
  bindFsMethod,
  loadManifest,
  writeFileAtomicSync,
  updateManifestFeature,
  getDiarizationDependencyDir,
  getDiarizationDependencyMarkerPath,
  cleanupStaleDiarizationDependencyDirs,
  getSummaryRuntimeExtractDir,
  getSummaryRuntimeArchiveDir,
  hashFileSha256,
  validateDiarizationDependencyArtifact,
  validateSummaryRuntimeArtifact,
  validatePinnedSummarySetup,
} = require('./ai-addon/manifest-store');

const {
  extractZipArchive,
  extractRuntimeArchive,
  extractTarGzArchive,
  validateTarListing,
  finalizeInstalledRuntimeExecutable,
} = require('./ai-addon/archive-install');

function createValidation(status, message, now = () => new Date().toISOString()) {
  return {
    status,
    checkedAt: now(),
    message,
  };
}

function buildFeatureUpdates({ status, modelId, speakerCount, artifactId, profile, validation, error }) {
  const updates = {
    status,
    lastValidation: validation,
    error: error || null,
  };

  if (modelId) {
    updates.modelId = modelId;
  }
  if (speakerCount !== undefined) {
    updates.speakerCount = speakerCount;
  }
  if (artifactId !== undefined) {
    updates.artifactId = artifactId;
  }
  if (profile !== undefined) {
    updates.profile = profile;
  }

  return updates;
}

function buildDiarizationDependencyInstallArgs({ artifact, targetDir }) {
  const pip = artifact && artifact.pip ? artifact.pip : {};
  const installedSourceArtifacts = (pip.sourceArtifacts || [])
    .filter((sourceArtifact) => sourceArtifact && sourceArtifact.localPath);
  const sourceArtifactPaths = installedSourceArtifacts
    .map((sourceArtifact) => sourceArtifact.localPath)
    .filter(Boolean);
  const sourceArtifactPackages = new Set(installedSourceArtifacts
    .map((sourceArtifact) => String(sourceArtifact && sourceArtifact.package || '').toLowerCase())
    .filter(Boolean));
  const requirements = (pip.requirements || []).filter((requirement) => {
    const packageName = String(requirement || '').split(/[<>=!~\[]/)[0].trim().toLowerCase();
    return !sourceArtifactPackages.has(packageName);
  });
  const args = [
    '-m',
    'pip',
    'install',
    '--upgrade',
    '--ignore-installed',
    '--target',
    targetDir,
    '--no-warn-script-location',
    '--index-url',
    pip.indexUrl,
  ];

  for (const extraIndexUrl of pip.extraIndexUrls || []) {
    args.push('--extra-index-url', extraIndexUrl);
  }
  if (!pip.allowSourceBuilds) {
    args.push('--only-binary=:all:');
  }
  const sourceBuildPackages = installedSourceArtifacts
    .map((sourceArtifact) => sourceArtifact && sourceArtifact.package)
    .filter(Boolean);
  if (sourceBuildPackages.length) {
    args.push(`--no-binary=${sourceBuildPackages.join(',')}`);
  }
  args.push(...requirements, ...sourceArtifactPaths);
  return args;
}

async function downloadDiarizationSourceArtifacts({ artifact, dependencyDir, downloader = downloadFile, fsModule = fs, emitProgress, cancelSignal } = {}) {
  const sourceArtifacts = artifact && artifact.pip && Array.isArray(artifact.pip.sourceArtifacts)
    ? artifact.pip.sourceArtifacts
    : [];
  if (!sourceArtifacts.length) {
    return artifact;
  }

  const sourceDir = path.join(dependencyDir, 'source-artifacts');
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const renameSync = bindFsMethod(fsModule, 'renameSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
  if (!mkdirSync || !renameSync) {
    throw new Error('File system does not support installing speaker identification source artifacts.');
  }
  mkdirSync(sourceDir, { recursive: true });

  const installedSourceArtifacts = [];
  for (let index = 0; index < sourceArtifacts.length; index += 1) {
    const sourceArtifact = sourceArtifacts[index];
    const artifactPath = path.join(sourceDir, sourceArtifact.fileName);
    const tempPath = `${artifactPath}.download`;
    emitSafeProgress(emitProgress, {
      feature: 'diarization',
      phase: 'downloading-dependencies',
      message: `Downloading pinned speaker dependency source artifact ${index + 1} of ${sourceArtifacts.length}.`,
      percent: 8 + Math.round((index / sourceArtifacts.length) * 10),
    });
    try {
      await downloader({
        url: sourceArtifact.url,
        destinationPath: tempPath,
        cancelSignal,
        onProgress: (progress) => emitSafeProgress(emitProgress, {
          feature: 'diarization',
          phase: 'downloading-dependencies',
          message: `Downloading pinned speaker dependency source artifact ${index + 1} of ${sourceArtifacts.length}.`,
          percent: 8 + Math.round(((index + ((progress.percent || 0) / 100)) / sourceArtifacts.length) * 10),
          downloadedBytes: progress.downloaded,
          totalBytes: progress.total,
        }),
      });
      const actualSha256 = await hashFileSha256(tempPath, fsModule);
      if (actualSha256 !== sourceArtifact.sha256) {
        throw new Error(`Pinned speaker dependency source artifact checksum mismatch for ${sourceArtifact.fileName}.`);
      }
      renameSync(tempPath, artifactPath);
      installedSourceArtifacts.push({ ...sourceArtifact, localPath: artifactPath });
    } catch (error) {
      if (unlinkSync) {
        try {
          unlinkSync(tempPath);
        } catch (cleanupError) {
          // Best effort cleanup only.
        }
      }
      throw error;
    }
  }

  return {
    ...artifact,
    pip: {
      ...artifact.pip,
      sourceArtifacts: installedSourceArtifacts,
    },
  };
}

function installDiarizationDependenciesWithPip({ pythonExe = 'python', artifact, targetDir, onProgress, cancelSignal } = {}) {
  return new Promise((resolve, reject) => {
    if (cancelSignal && cancelSignal.aborted) {
      reject(createAiAddonCancelError('Speaker identification setup was canceled.'));
      return;
    }

    const child = spawn(pythonExe, buildDiarizationDependencyInstallArgs({ artifact, targetDir }), { windowsHide: true });
    const maxBufferedOutput = 64 * 1024;
    let errorOutput = '';
    let settled = false;
    let cancelError = null;
    let cancelFallbackTimer = null;

    const cleanupCancel = onAiAddonCancel(cancelSignal, (abortError) => {
      if (settled || cancelError) {
        return;
      }
      cancelError = abortError;
      forceKillChildProcess(child);
      cancelFallbackTimer = setTimeout(() => finish(reject, cancelError), 5000);
      cancelFallbackTimer.unref?.();
    });

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (cancelFallbackTimer) {
        clearTimeout(cancelFallbackTimer);
      }
      cleanupCancel();
      callback(value);
    };

    const handleOutput = (data) => {
      const text = data.toString();
      errorOutput += text;
      if (errorOutput.length > maxBufferedOutput) {
        errorOutput = errorOutput.slice(-maxBufferedOutput);
      }
      const message = summarizePipProgress(text);
      if (message && typeof onProgress === 'function') {
        onProgress(message);
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (cancelError) {
        finish(reject, cancelError);
        return;
      }
      if (code === 0) {
        finish(resolve, { success: true });
        return;
      }
      const reason = errorOutput.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
      finish(reject, new Error(reason || `Speaker identification dependency install failed with code ${code}.`));
    });
  });
}

function checkMacOSCompilerToolchain({ platform = process.platform, execFileFn = execFile } = {}) {
  if (platform !== 'darwin') {
    return Promise.resolve({ available: true, skipped: true });
  }

  return new Promise((resolve) => {
    execFileFn('xcode-select', ['-p'], { timeout: 10000 }, (xcodeError) => {
      if (xcodeError) {
        resolve({ available: false, reason: 'xcode-select' });
        return;
      }
      execFileFn('cc', ['--version'], { timeout: 10000 }, (compilerError) => {
        resolve(compilerError
          ? { available: false, reason: 'cc' }
          : { available: true });
      });
    });
  });
}

async function assertDiarizationSourceBuildToolchain({ platform = process.platform, artifact, toolchainChecker = checkMacOSCompilerToolchain } = {}) {
  const hasCuratedSourceArtifacts = Boolean(artifact && artifact.pip && Array.isArray(artifact.pip.sourceArtifacts) && artifact.pip.sourceArtifacts.length > 0);
  if (platform !== 'darwin' || !artifact || !artifact.pip || (!artifact.pip.allowSourceBuilds && !hasCuratedSourceArtifacts)) {
    return;
  }

  const result = await toolchainChecker({ artifact, platform });
  if (!result || result.available !== true) {
    throw new Error('Speaker identification setup on macOS needs Apple Command Line Tools to build a source-only pyannote dependency. Install them with `xcode-select --install`, then try setup again.');
  }
}

function estimatePipDownloadPercent(message) {
  const text = String(message || '');
  if (/^Collecting\b/.test(text)) {
    return 12;
  }
  if (/^(Downloading|Using cached)\b/.test(text)) {
    return 45;
  }
  if (/^(Installing|Building wheel)\b/.test(text)) {
    return 70;
  }
  if (/^Successfully installed\b/.test(text)) {
    return 82;
  }
  return 30;
}

async function installDiarizationDependencies({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  pythonExe,
  downloader = downloadFile,
  dependencyInstaller = installDiarizationDependenciesWithPip,
  downloadSourceArtifacts = dependencyInstaller === installDiarizationDependenciesWithPip,
  toolchainChecker = checkMacOSCompilerToolchain,
  cancelSignal,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
  const artifact = getDiarizationDependencyArtifactForPlatform(platform, arch, catalog);
  const validationError = validateDiarizationDependencyArtifact(artifact);
  if (validationError) {
    throw new Error(validationError);
  }

  const dependencyDir = getDiarizationDependencyDir(userDataDir, artifact);
  const sitePackagesDir = getDiarizationDependencySitePackagesDir(userDataDir, artifact);
  const markerPath = getDiarizationDependencyMarkerPath(userDataDir, artifact);
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  cleanupStaleDiarizationDependencyDirs({ userDataDir, artifact, fsModule });

  const existingCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  if (existingCache.valid) {
    return existingCache;
  }

  if (mkdirSync) {
    mkdirSync(dependencyDir, { recursive: true });
  }
  if (unlinkSync && existsSync?.(markerPath)) {
    unlinkSync(markerPath);
  }
  if (rmSync) {
    rmSync(sitePackagesDir, { recursive: true, force: true });
  }
  if (mkdirSync) {
    mkdirSync(sitePackagesDir, { recursive: true });
  }

  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'downloading-dependencies',
    message: 'Installing local speaker identification dependencies.',
    percent: 5,
  });

  try {
    const installArtifact = downloadSourceArtifacts
      ? await downloadDiarizationSourceArtifacts({
        artifact,
        dependencyDir,
        downloader,
        fsModule,
        emitProgress,
        cancelSignal,
      })
      : artifact;
    await assertDiarizationSourceBuildToolchain({ platform, artifact: installArtifact, toolchainChecker });
    await dependencyInstaller({
      pythonExe,
      artifact: installArtifact,
      targetDir: sitePackagesDir,
      cancelSignal,
      onProgress: (message) => emitSafeProgress(emitProgress, {
        feature: 'diarization',
        phase: 'downloading-dependencies',
        message,
        percent: estimatePipDownloadPercent(message),
      }),
    });
  } catch (error) {
    if (rmSync) {
      rmSync(sitePackagesDir, { recursive: true, force: true });
    }
    if (unlinkSync && existsSync?.(markerPath)) {
      unlinkSync(markerPath);
    }
    throw error;
  }

  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');

  writeFileAtomicSync(fsModule, markerPath, `${JSON.stringify({
    artifactId: artifact.id,
    package: artifact.package,
    version: artifact.version,
    requirements: artifact.pip.requirements,
    sourceArtifacts: (artifact.pip.sourceArtifacts || []).map((sourceArtifact) => ({
      package: sourceArtifact.package,
      version: sourceArtifact.version,
      fileName: sourceArtifact.fileName,
      sha256: sourceArtifact.sha256,
    })),
    installedAt: now(),
  }, null, 2)}\n`);

  const installedCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  if (!installedCache.valid) {
    throw new Error(installedCache.reason || 'Speaker identification dependency installation did not complete.');
  }
  return installedCache;
}

async function validateDiarizationSetup({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  runtimeValidator,
  existingToken,
  cancelSignal,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Validating speaker identification setup.',
    percent: 85,
  });

  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const modelId = resolveModelId('diarization', manifest.features.diarization.modelId, catalog);
  const availability = getDiarizationAvailability(platform, arch);
  const dependencyCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  let status = 'ready';
  let message = 'Speaker identification setup is ready.';
  let error = null;

  if (!availability.supported) {
    status = 'unsupported';
    message = availability.reason;
    error = availability.reason;
  } else if (!dependencyCache.valid) {
    status = dependencyCache.validationStatus === 'error' ? 'error' : 'notConfigured';
    message = dependencyCache.reason || 'Speaker identification dependencies are not installed.';
    error = message;
  } else if (!getDiarizationTokenStatus({
    userDataDir,
    safeStorage,
    fsModule,
    checkEncryptionAvailability: false,
  }).hasToken) {
    status = 'needsAccount';
    message = 'Hugging Face token is required for speaker identification setup.';
    error = message;
  } else {
    try {
      const token = existingToken || getAiAddonToken({
        userDataDir,
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
        safeStorage,
        fsModule,
      });
      if (!isLikelyHuggingFaceToken(token)) {
        status = 'needsAccount';
        message = 'Stored Hugging Face token does not match the expected token format.';
        error = message;
      } else if (typeof runtimeValidator === 'function') {
        try {
          await runtimeValidator({
            modelId,
            modelRef: getDiarizationModelRef(modelId, catalog),
            token,
            dependencyCache,
            requiredDevice: availability.runtimeDevice || null,
            cancelSignal,
          });
        } catch (runtimeError) {
          if (isAiAddonCancelError(runtimeError)) {
            throw runtimeError;
          }
          status = 'error';
          message = runtimeError.message || 'Speaker identification runtime validation failed.';
          error = message;
        }
      }
    } catch (validationError) {
      if (isAiAddonCancelError(validationError)) {
        throw validationError;
      }
      status = 'error';
      message = validationError.message && validationError.message.includes('decrypt')
        ? 'Stored Hugging Face token could not be decrypted.'
        : validationError.message || 'Stored Hugging Face token could not be decrypted.';
      error = message;
    }
  }

  updateManifestFeature({
    userDataDir,
    feature: 'diarization',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status,
      modelId,
      speakerCount: manifest.features.diarization.speakerCount,
      validation: createValidation(status, message, now),
      error,
    }),
  });

  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: status,
    status,
    message,
    modelId,
    percent: status === 'ready' ? 100 : undefined,
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
}

async function setupDiarizationAddon({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  speakerCount = 'auto',
  token,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
  runtimeValidator,
  pythonExe,
  downloader = downloadFile,
  dependencyInstaller,
  downloadSourceArtifacts,
  toolchainChecker,
  cancelSignal,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Checking speaker identification setup.',
    percent: 0,
  });

  const selectedModelId = resolveModelId('diarization', modelId, catalog);
  const availability = getDiarizationAvailability(platform, arch);
  let tokenForValidation = null;

  function markDiarizationError(message) {
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'error',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('error', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'error', status: 'error', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  if (!availability.supported) {
    const message = availability.reason;
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'unsupported',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('unsupported', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'unsupported', status: 'unsupported', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  const trimmedToken = typeof token === 'string' ? token.trim() : '';
  if (trimmedToken) {
    if (!isLikelyHuggingFaceToken(trimmedToken)) {
      const message = 'Hugging Face token does not match the expected token format.';
      updateManifestFeature({
        userDataDir,
        feature: 'diarization',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'needsAccount',
          modelId: selectedModelId,
          speakerCount,
          validation: createValidation('needsAccount', message, now),
          error: message,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'needsAccount', status: 'needsAccount', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    try {
      storeAiAddonToken({
        userDataDir,
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
        token: trimmedToken,
        safeStorage,
        fsModule,
      });
      tokenForValidation = trimmedToken;
    } catch (storageError) {
      return markDiarizationError(storageError.message || 'Secure token storage is unavailable.');
    }
  }

  const tokenStatus = getDiarizationTokenStatus({
    userDataDir,
    safeStorage,
    fsModule,
    checkEncryptionAvailability: false,
  });
  if (!tokenStatus.hasToken) {
    const message = 'Hugging Face token is required for speaker identification setup.';
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'needsAccount',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('needsAccount', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'needsAccount', status: 'needsAccount', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  updateManifestFeature({
    userDataDir,
    feature: 'diarization',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status: 'downloading',
      modelId: selectedModelId,
      speakerCount,
      validation: createValidation('downloading', 'Speaker identification dependency installation started.', now),
      error: null,
    }),
  });

  const dependencyCacheBeforeInstall = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  const cleanupDownloadedDiarizationDependencies = () => {
    const artifact = getDiarizationDependencyArtifactForPlatform(platform, arch, catalog);
    const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
    const existsSync = bindFsMethod(fsModule, 'existsSync');
    const markerPath = artifact ? getDiarizationDependencyMarkerPath(userDataDir, artifact) : null;
    if (markerPath && unlinkSync && existsSync?.(markerPath)) {
      try {
        unlinkSync(markerPath);
      } catch (cleanupError) {
        // Best effort cleanup.
      }
    }
    if (dependencyCacheBeforeInstall.valid) {
      return;
    }
    const rmSync = bindFsMethod(fsModule, 'rmSync');
    if (artifact && rmSync) {
      rmSync(getDiarizationDependencyDir(userDataDir, artifact), { recursive: true, force: true });
    }
  };

  try {
    await installDiarizationDependencies({
      userDataDir,
      platform,
      arch,
      fsModule,
      catalog,
      now,
      emitProgress,
      pythonExe,
      downloader,
      downloadSourceArtifacts,
      dependencyInstaller,
      toolchainChecker,
      cancelSignal,
    });
  } catch (dependencyError) {
    if (isAiAddonCancelError(dependencyError)) {
      const message = 'Speaker identification setup was canceled. Partial downloads were removed.';
      cleanupDownloadedDiarizationDependencies();
      updateManifestFeature({
        userDataDir,
        feature: 'diarization',
        fsModule,
        catalog,
        updates: buildFeatureUpdates({
          status: 'notConfigured',
          modelId: selectedModelId,
          speakerCount,
          validation: createValidation('notConfigured', message, now),
          error: null,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
    }

    const message = dependencyError.message || 'Speaker identification dependency setup failed.';
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'error',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('error', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'error', status: 'error', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  if (!tokenForValidation) {
    try {
      tokenForValidation = getAiAddonToken({
        userDataDir,
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
        safeStorage,
        fsModule,
      });
    } catch (storageError) {
      return markDiarizationError(storageError.message || 'Stored Hugging Face token could not be decrypted.');
    }
  }

  try {
    throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
    return await validateDiarizationSetup({
      userDataDir,
      platform,
      arch,
      safeStorage,
      fsModule,
      catalog,
      now,
      emitProgress,
      runtimeValidator,
      existingToken: tokenForValidation,
      cancelSignal,
    });
  } catch (validationError) {
    if (!isAiAddonCancelError(validationError)) {
      throw validationError;
    }

    const message = 'Speaker identification setup was canceled. Partial downloads were removed.';
    cleanupDownloadedDiarizationDependencies();
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'notConfigured',
        modelId: selectedModelId,
        speakerCount,
        validation: createValidation('notConfigured', message, now),
        error: null,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }
}

async function removeDiarizationSetup({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
} = {}) {
  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const modelId = manifest.features.diarization.modelId;
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'removing',
    message: 'Removing speaker identification setup.',
    modelId,
  });

  deleteAiAddonToken({ userDataDir, tokenKey: TOKEN_KEYS.diarizationHuggingFace, fsModule });
  if (fsModule.rmSync) {
    fsModule.rmSync(getDiarizationModelCacheDir(userDataDir, modelId), { recursive: true, force: true });
    fsModule.rmSync(getAiAddonPaths(userDataDir).diarizationDependencyCacheDir, { recursive: true, force: true });
  }

  updateManifestFeature({
    userDataDir,
    feature: 'diarization',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status: 'notConfigured',
      modelId,
      speakerCount: 'auto',
      validation: createValidation('notConfigured', 'Speaker identification setup was removed.', now),
      error: null,
    }),
  });

  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'notConfigured',
    status: 'notConfigured',
    message: 'Speaker identification setup was removed.',
    modelId,
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
}

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
