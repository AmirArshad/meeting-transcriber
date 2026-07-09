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
  resolveModelId,
} = require('../ai-addon-state');
const {
  TOKEN_KEYS,
  deleteAiAddonToken,
  getAiAddonToken,
  storeAiAddonToken,
} = require('../ai-addon-token-store');

const {
  summarizePipProgress,
  emitSafeProgress,
  createAiAddonCancelError,
  forceKillChildProcess,
  throwIfAiAddonCanceled,
  onAiAddonCancel,
  isAiAddonCancelError,
} = require('./progress-events');

const {
  downloadFile,
  isLikelyHuggingFaceToken,
  getDiarizationTokenStatus,
} = require('./download-helpers');

const {
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  getDiarizationDependencySitePackagesDir,
  getDiarizationModelCacheDir,
  bindFsMethod,
  loadManifest,
  writeFileAtomicSync,
  updateManifestFeature,
  getDiarizationDependencyDir,
  getDiarizationDependencyMarkerPath,
  cleanupStaleDiarizationDependencyDirs,
  hashFileSha256,
  validateDiarizationDependencyArtifact,
  createValidation,
  buildFeatureUpdates,
} = require('./manifest-store');

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

module.exports = {
  buildDiarizationDependencyInstallArgs,
  installDiarizationDependencies,
  downloadDiarizationSourceArtifacts,
  setupDiarizationAddon,
  validateDiarizationSetup,
  removeDiarizationSetup,
  checkMacOSCompilerToolchain,
};
