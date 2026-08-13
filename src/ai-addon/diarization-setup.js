'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const {
  AI_MODEL_CATALOG,
  getDiarizationAvailability,
  getDiarizationModelRef,
  getDiarizationDependencyArtifactForPlatform,
  getModelById,
  getSpeakrsSetupArtifactsForPlatform,
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
  isAllowedDownloadUrl,
  isLikelyHuggingFaceToken,
  getDiarizationTokenStatus,
} = require('./download-helpers');

const {
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  checkSpeakrsModelCache,
  checkSpeakrsRuntimeCache,
  getDiarizationDependencySitePackagesDir,
  getSpeakrsModelRevisionDir,
  getSpeakrsOrtRuntimeDir,
  getSpeakrsUninstallPaths,
  getPyannoteUninstallPaths,
  hasSpeakrsLocalState,
  hasPyannoteLocalState,
  resolveSpeakrsCliPath,
  bindFsMethod,
  loadManifest,
  writeFileAtomicSync,
  updateManifestFeature,
  getDiarizationDependencyDir,
  getDiarizationDependencyMarkerPath,
  cleanupStaleDiarizationDependencyDirs,
  hashFileSha256,
  isPinnedSha256,
  validateDiarizationDependencyArtifact,
  createValidation,
  buildFeatureUpdates,
} = require('./manifest-store');
const { extractRuntimeArchive } = require('./archive-install');
const {
  SPEAKRS_CUDA_RUNTIME_DLL_NAMES,
  SPEAKRS_DIARIZATION_ENGINES,
  SPEAKRS_ORT_DLL_NAMES,
  resolveContainedSpeakrsPath,
} = require('./speakrs-pack-spec');

function resolveDiarizationSetupTarget({
  engine,
  modelId,
  manifest,
  catalog = AI_MODEL_CATALOG,
} = {}) {
  const requestedEngine = typeof engine === 'string' ? engine.trim().toLowerCase() : '';
  if (requestedEngine && !SPEAKRS_DIARIZATION_ENGINES.includes(requestedEngine)) {
    const error = new Error('Unknown speaker engine.');
    error.code = 'UNKNOWN_DIARIZATION_ENGINE';
    throw error;
  }

  const models = Array.isArray(catalog?.diarization?.models) ? catalog.diarization.models : [];
  const modelEngine = (model) => {
    if (!model) {
      return null;
    }
    if (SPEAKRS_DIARIZATION_ENGINES.includes(model.engine)) {
      return model.engine;
    }
    return model.runtime?.type === 'native-cli' ? 'speakrs' : 'pyannote';
  };
  const firstModelForEngine = (targetEngine) => (
    models.find((candidate) => modelEngine(candidate) === targetEngine) || null
  );
  const requestedModelId = typeof modelId === 'string' && modelId.trim() ? modelId.trim() : null;
  const requestedModel = requestedModelId ? getModelById('diarization', requestedModelId, catalog) : null;
  const manifestState = manifest?.features?.diarization || {};
  const manifestEngine = typeof manifestState.engine === 'string'
    ? manifestState.engine.trim().toLowerCase()
    : '';
  const manifestModel = typeof manifestState.modelId === 'string'
    ? getModelById('diarization', manifestState.modelId.trim(), catalog)
    : null;
  const defaultModelId = resolveModelId('diarization', null, catalog);
  const defaultModel = getModelById('diarization', defaultModelId, catalog) || models[0] || null;

  let selectedEngine = null;
  let selectedModel = null;
  if (requestedEngine) {
    selectedEngine = requestedEngine;
    selectedModel = requestedModel && modelEngine(requestedModel) === selectedEngine
      ? requestedModel
      : firstModelForEngine(selectedEngine);
  } else if (requestedModel) {
    selectedEngine = modelEngine(requestedModel);
    selectedModel = requestedModel;
  } else if (SPEAKRS_DIARIZATION_ENGINES.includes(manifestEngine) && firstModelForEngine(manifestEngine)) {
    selectedEngine = manifestEngine;
    selectedModel = manifestModel && modelEngine(manifestModel) === selectedEngine
      ? manifestModel
      : firstModelForEngine(selectedEngine);
  } else if (manifestModel) {
    selectedEngine = modelEngine(manifestModel);
    selectedModel = manifestModel;
  } else {
    selectedEngine = modelEngine(defaultModel);
    selectedModel = defaultModel;
  }

  if (!selectedEngine || !selectedModel) {
    const error = new Error('The selected speaker engine is not available in the model catalog.');
    error.code = 'DIARIZATION_ENGINE_UNAVAILABLE';
    throw error;
  }
  return { engine: selectedEngine, modelId: selectedModel.id };
}

function removePathsStrict(targetPaths, fsModule = fs) {
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  if (!rmSync) {
    throw new Error('File system does not support removing the previous speaker engine.');
  }
  for (const targetPath of targetPaths) {
    if (!targetPath) {
      continue;
    }
    rmSync(targetPath, { recursive: true, force: true });
    if (existsSync?.(targetPath)) {
      throw new Error('The previous speaker engine could not be removed completely.');
    }
  }
}

function uninstallSpeakrsLocalState({ userDataDir, fsModule = fs } = {}) {
  removePathsStrict(getSpeakrsUninstallPaths(userDataDir), fsModule);
}

function uninstallPyannoteLocalState({ userDataDir, fsModule = fs } = {}) {
  deleteAiAddonToken({ userDataDir, tokenKey: TOKEN_KEYS.diarizationHuggingFace, fsModule });
  removePathsStrict(getPyannoteUninstallPaths(userDataDir), fsModule);
}

function removePathBestEffort(targetPath, fsModule = fs) {
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  if (!targetPath || !rmSync) {
    return;
  }
  try {
    rmSync(targetPath, { recursive: true, force: true });
  } catch (_error) {
    // Attempt-owned staging/download cleanup must not mask the primary error.
  }
}

function commitStagedDirectory(stagingDir, destinationDir, fsModule = fs) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const renameSync = bindFsMethod(fsModule, 'renameSync');
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  if (!renameSync || !rmSync) {
    throw new Error('File system does not support atomically installing Speakrs artifacts.');
  }
  if (existsSync?.(destinationDir)) {
    rmSync(destinationDir, { recursive: true, force: true });
  }
  renameSync(stagingDir, destinationDir);
}

async function validateStagedSpeakrsModelPack(stagingDir, files, fsModule = fs) {
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  for (const file of files) {
    const filePath = resolveContainedSpeakrsPath(stagingDir, file.path);
    if (!existsSync?.(filePath)) {
      throw new Error(`Speakrs model pack is missing a required file: ${file.path}.`);
    }
    const stats = fsModule.statSync(filePath);
    if (!stats || stats.isDirectory?.() || Number(stats.size) !== Number(file.sizeBytes)) {
      throw new Error(`Speakrs model pack contains an invalid required file: ${file.path}.`);
    }
    if (await hashFileSha256(filePath, fsModule) !== file.sha256) {
      throw new Error(`Speakrs model pack checksum does not match a required file: ${file.path}.`);
    }
  }
}

async function installSpeakrsArtifacts({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  emitProgress,
  downloader = downloadFile,
  extractor = extractRuntimeArchive,
  cancelSignal,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
  const artifact = getSpeakrsSetupArtifactsForPlatform(platform, arch, catalog);
  const modelPack = artifact?.modelPack;
  if (!artifact || !modelPack || !Array.isArray(artifact.modelFiles) || artifact.modelFiles.length === 0) {
    throw new Error('No Speakrs model pack is available for this platform.');
  }
  if (
    !modelPack.fileName
    || !modelPack.downloadUrl
    || !modelPack.archiveFormat
    || !isPinnedSha256(modelPack.sha256)
    || !Number(modelPack.sizeBytes)
  ) {
    throw new Error('Speakrs model-pack archive metadata is incomplete.');
  }
  if (!isAllowedDownloadUrl(modelPack.downloadUrl)) {
    throw new Error('Speakrs model-pack archive host is not allowed.');
  }
  for (const file of artifact.modelFiles) {
    resolveContainedSpeakrsPath(getSpeakrsModelRevisionDir(userDataDir, artifact.revision), file.path);
    if (!file.fileName || !Number(file.sizeBytes) || !isPinnedSha256(file.sha256)) {
      throw new Error(`Speakrs model file metadata is incomplete: ${file.path || file.fileName}.`);
    }
  }
  for (const runtimeArtifact of artifact.runtimeArtifacts) {
    if (!runtimeArtifact.fileName || !runtimeArtifact.downloadUrl || !isPinnedSha256(runtimeArtifact.sha256)) {
      throw new Error('Speakrs runtime artifact metadata is incomplete.');
    }
    if (!isAllowedDownloadUrl(runtimeArtifact.downloadUrl)) {
      throw new Error('Speakrs runtime artifact host is not allowed.');
    }
  }

  const existingPack = await checkSpeakrsModelCache({
    userDataDir,
    platform,
    arch,
    fsModule,
    catalog,
    verifyChecksum: true,
  });
  const existingRuntime = await checkSpeakrsRuntimeCache({
    userDataDir,
    platform,
    arch,
    fsModule,
    catalog,
    verifyChecksum: true,
  });
  if (existingPack.valid && existingRuntime.valid) {
    return { packCache: existingPack, runtimeCache: existingRuntime };
  }

  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
  const revisionDir = getSpeakrsModelRevisionDir(userDataDir, artifact.revision);
  const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
  const attemptId = `${process.pid}-${Date.now()}`;
  const modelStagingDir = existingPack.valid ? null : `${revisionDir}.install-${attemptId}`;
  const runtimeStagingDir = existingRuntime.valid ? null : `${runtimeDir}.install-${attemptId}`;
  const modelDownloadPath = `${revisionDir}.${modelPack.fileName}.download-${attemptId}`;
  const runtimeDownloadPaths = [];
  const downloads = [
    ...(existingPack.valid ? [] : [{ kind: 'model', file: modelPack }]),
    ...(existingRuntime.valid ? [] : artifact.runtimeArtifacts.map((file) => ({ kind: 'runtime', file }))),
  ];
  const totalBytes = downloads.reduce((total, item) => total + (Number(item.file.sizeBytes) || 0), 0);
  let completedBytes = 0;
  const committedPaths = [];
  try {
    removePathBestEffort(modelStagingDir, fsModule);
    removePathBestEffort(runtimeStagingDir, fsModule);
    if (modelStagingDir) {
      mkdirSync?.(modelStagingDir, { recursive: true });
    }
    if (runtimeStagingDir) {
      mkdirSync?.(runtimeStagingDir, { recursive: true });
    }
    for (let index = 0; index < downloads.length; index += 1) {
      throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
      const item = downloads[index];
      const tempPath = item.kind === 'model'
        ? modelDownloadPath
        : `${runtimeDir}.${item.file.fileName}.download-${attemptId}`;
      if (item.kind === 'runtime') {
        runtimeDownloadPaths.push(tempPath);
      }
      mkdirSync?.(path.dirname(tempPath), { recursive: true });
      emitSafeProgress(emitProgress, {
        feature: 'diarization',
        phase: 'downloading',
        message: 'Downloading Speakrs speaker model.',
        percent: totalBytes ? Math.round((completedBytes / totalBytes) * 80) : Math.round((index / downloads.length) * 80),
      });
      await downloader({
        url: item.file.downloadUrl,
        destinationPath: tempPath,
        expectedSizeBytes: item.file.sizeBytes,
        cancelSignal,
        onProgress: (progress) => emitSafeProgress(emitProgress, {
          feature: 'diarization',
          phase: 'downloading',
          message: 'Downloading Speakrs speaker model.',
          percent: totalBytes
            ? Math.round(((completedBytes + (progress.downloaded || 0)) / totalBytes) * 80)
            : Math.round(((index + ((progress.percent || 0) / 100)) / downloads.length) * 80),
          downloadedBytes: progress.downloaded,
          totalBytes: progress.total || totalBytes,
        }),
      });
      const actualSha256 = await hashFileSha256(tempPath, fsModule);
      if (actualSha256 !== item.file.sha256) {
        throw new Error(`Speakrs download checksum does not match the pinned checksum: ${item.file.fileName}.`);
      }
      emitSafeProgress(emitProgress, {
        feature: 'diarization',
        phase: 'extracting',
        message: item.kind === 'model' ? 'Installing Speakrs speaker model.' : 'Installing Speakrs runtime.',
        percent: 85,
      });
      await extractor(
        tempPath,
        item.kind === 'model' ? modelStagingDir : runtimeStagingDir,
        item.file.archiveFormat,
        {
          cancelSignal,
          includeFileNames: item.kind === 'runtime' ? item.file.keepFileNames : null,
        },
      );
      throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
      completedBytes += Number(item.file.sizeBytes) || 0;
    }
    if (modelStagingDir) {
      await validateStagedSpeakrsModelPack(modelStagingDir, artifact.modelFiles, fsModule);
    }
    if (runtimeStagingDir) {
      const runtimeFiles = {};
      for (const name of [...SPEAKRS_ORT_DLL_NAMES, ...SPEAKRS_CUDA_RUNTIME_DLL_NAMES]) {
        const filePath = path.join(runtimeStagingDir, name);
        const stats = fsModule.statSync(filePath);
        if (!stats || stats.isDirectory?.() || Number(stats.size) <= 0) {
          throw new Error(`Speakrs runtime archive did not provide a valid ${name}.`);
        }
        runtimeFiles[name] = {
          sizeBytes: Number(stats.size),
          sha256: await hashFileSha256(filePath, fsModule),
        };
      }
      fsModule.writeFileSync(path.join(runtimeStagingDir, 'install.json'), `${JSON.stringify({
        artifacts: artifact.runtimeArtifacts.map((entry) => ({ id: entry.id, sha256: entry.sha256 })),
        files: runtimeFiles,
      }, null, 2)}\n`);
    }
    throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
    if (modelStagingDir) {
      commitStagedDirectory(modelStagingDir, revisionDir, fsModule);
      committedPaths.push(revisionDir);
    }
    if (runtimeStagingDir) {
      commitStagedDirectory(runtimeStagingDir, runtimeDir, fsModule);
      committedPaths.push(runtimeDir);
    }
  } catch (error) {
    for (const committedPath of committedPaths) {
      removePathBestEffort(committedPath, fsModule);
    }
    throw error;
  } finally {
    removePathBestEffort(modelStagingDir, fsModule);
    removePathBestEffort(runtimeStagingDir, fsModule);
    for (const downloadPath of [modelDownloadPath, ...runtimeDownloadPaths]) {
      if (unlinkSync && fsModule.existsSync?.(downloadPath)) {
        try {
          unlinkSync(downloadPath);
        } catch (_error) {
          removePathBestEffort(downloadPath, fsModule);
        }
      }
    }
  }

  const packCache = await checkSpeakrsModelCache({
    userDataDir,
    platform,
    arch,
    fsModule,
    catalog,
    verifyChecksum: true,
  });
  const runtimeCache = await checkSpeakrsRuntimeCache({
    userDataDir,
    platform,
    arch,
    fsModule,
    catalog,
    verifyChecksum: true,
  });
  if (!packCache.valid) {
    throw new Error(packCache.reason || 'Speakrs model pack installation did not complete.');
  }
  if (!runtimeCache.valid) {
    throw new Error(runtimeCache.reason || 'Speakrs runtime installation did not complete.');
  }
  return { packCache, runtimeCache };
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
  env = process.env,
  tokenStatusReader = getDiarizationTokenStatus,
  tokenReader = getAiAddonToken,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Validating speaker identification setup.',
    percent: 85,
  });

  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const selected = resolveDiarizationSetupTarget({
    engine: manifest.features.diarization.engine,
    modelId: manifest.features.diarization.modelId,
    manifest,
    catalog,
  });
  const modelId = selected.modelId;
  const engine = selected.engine;
  const availability = getDiarizationAvailability(platform, arch);
  const dependencyCache = checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog });
  let status = 'ready';
  let message = 'Speaker identification setup is ready.';
  let error = null;

  if (!availability.supported) {
    status = 'unsupported';
    message = availability.reason;
    error = availability.reason;
  } else if (engine === 'speakrs') {
    const packCache = await checkSpeakrsModelCache({
      userDataDir,
      platform,
      arch,
      fsModule,
      catalog,
      verifyChecksum: true,
    });
    const runtimeCache = await checkSpeakrsRuntimeCache({
      userDataDir,
      platform,
      arch,
      fsModule,
      catalog,
      verifyChecksum: true,
    });
    const cliPath = resolveSpeakrsCliPath({ platform, env, fsModule });
    if (!packCache.valid) {
      status = packCache.validationStatus === 'error' ? 'error' : 'notConfigured';
      message = packCache.reason || 'Speakrs model pack is not installed.';
      error = message;
    } else if (!runtimeCache.valid) {
      status = 'notConfigured';
      message = runtimeCache.reason || 'Speakrs runtime is not installed.';
      error = message;
    } else if (!cliPath) {
      status = 'error';
      message = 'Speakrs CLI is not available.';
      error = message;
    } else if (typeof runtimeValidator === 'function') {
      try {
        await runtimeValidator({
          engine,
          modelId,
          modelRef: getDiarizationModelRef(modelId, catalog),
          packCache,
          runtimeCache,
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
  } else if (!dependencyCache.valid) {
    status = dependencyCache.validationStatus === 'error' ? 'error' : 'notConfigured';
    message = dependencyCache.reason || 'Speaker identification dependencies are not installed.';
    error = message;
  } else if (!tokenStatusReader({
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
      const token = existingToken || tokenReader({
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
      engine,
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

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
}

async function setupDiarizationAddon({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  engine,
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
  extractor = extractRuntimeArchive,
  dependencyInstaller,
  downloadSourceArtifacts,
  toolchainChecker,
  cancelSignal,
  env = process.env,
  tokenStatusReader = getDiarizationTokenStatus,
  tokenReader = getAiAddonToken,
  tokenWriter = storeAiAddonToken,
} = {}) {
  throwIfAiAddonCanceled(cancelSignal, 'Speaker identification setup was canceled.');
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Checking speaker identification setup.',
    percent: 0,
  });

  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  let selected;
  try {
    selected = resolveDiarizationSetupTarget({ engine, modelId, manifest, catalog });
  } catch (selectionError) {
    const message = selectionError.message || 'Unknown speaker engine.';
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'error',
        modelId: resolveModelId('diarization', modelId, catalog),
        speakerCount,
        validation: createValidation('error', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'error', status: 'error', message });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
  }
  const selectedModelId = selected.modelId;
  const selectedEngine = selected.engine;
  const availability = getDiarizationAvailability(platform, arch);
  let tokenForValidation = null;
  const previousDiarizationState = manifest.features.diarization;

  function buildSpeakrsCancellationUpdates(message) {
    if (previousDiarizationState.engine === selectedEngine) {
      return {
        ...previousDiarizationState,
      };
    }
    return buildFeatureUpdates({
      status: 'notConfigured',
      modelId: selectedModelId,
      engine: selectedEngine,
      speakerCount,
      validation: createValidation('notConfigured', message, now),
      error: null,
    });
  }

  function markDiarizationError(message) {
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'error',
        modelId: selectedModelId,
        engine: selectedEngine,
        speakerCount,
        validation: createValidation('error', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'error', status: 'error', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
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
        engine: selectedEngine,
        speakerCount,
        validation: createValidation('unsupported', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'unsupported', status: 'unsupported', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
  }

  const tokenStatus = selectedEngine === 'pyannote'
    ? tokenStatusReader({
      userDataDir,
      safeStorage,
      fsModule,
      checkEncryptionAvailability: false,
    })
    : { hasToken: false, encryptionAvailable: null };
  const speakrsState = hasSpeakrsLocalState({
    userDataDir,
    packCache: await checkSpeakrsModelCache({ userDataDir, platform, arch, fsModule, catalog }),
    runtimeCache: await checkSpeakrsRuntimeCache({ userDataDir, platform, arch, fsModule, catalog }),
    fsModule,
  });
  const pyannoteState = hasPyannoteLocalState({
    userDataDir,
    dependencyCache: checkDiarizationDependencyCache({ userDataDir, platform, arch, fsModule, catalog }),
    tokenStatus,
    fsModule,
  });
  if (selectedEngine === 'speakrs' && pyannoteState) {
    uninstallPyannoteLocalState({ userDataDir, fsModule });
  }
  if (selectedEngine === 'pyannote' && speakrsState) {
    uninstallSpeakrsLocalState({ userDataDir, fsModule });
  }

  if (selectedEngine === 'speakrs') {
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'downloading',
        modelId: selectedModelId,
        engine: selectedEngine,
        speakerCount,
        validation: createValidation('downloading', 'Speakrs speaker model download started.', now),
        error: null,
      }),
    });

    try {
      await installSpeakrsArtifacts({
        userDataDir,
        platform,
        arch,
        fsModule,
        catalog,
        emitProgress,
        downloader,
        extractor,
        cancelSignal,
      });
    } catch (installError) {
      if (isAiAddonCancelError(installError)) {
        const message = 'Speaker identification setup was canceled. Partial downloads were removed.';
        updateManifestFeature({
          userDataDir,
          feature: 'diarization',
          fsModule,
          catalog,
          updates: buildSpeakrsCancellationUpdates(message),
        });
        emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
      }
      return markDiarizationError(installError.message || 'Speakrs speaker setup failed.');
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
        cancelSignal,
        env,
        tokenStatusReader,
        tokenReader,
      });
    } catch (validationError) {
      if (!isAiAddonCancelError(validationError)) {
        throw validationError;
      }
      const message = 'Speaker identification setup was canceled. Partial downloads were removed.';
      updateManifestFeature({
        userDataDir,
        feature: 'diarization',
        fsModule,
        catalog,
        updates: buildSpeakrsCancellationUpdates(message),
      });
      emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
    }
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
          engine: selectedEngine,
          speakerCount,
          validation: createValidation('needsAccount', message, now),
          error: message,
        }),
      });
      emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'needsAccount', status: 'needsAccount', message, modelId: selectedModelId });
      return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
    }

    try {
      tokenWriter({
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

  const storedTokenStatus = tokenStatusReader({
    userDataDir,
    safeStorage,
    fsModule,
    checkEncryptionAvailability: false,
  });
  if (!storedTokenStatus.hasToken) {
    const message = 'Hugging Face token is required for speaker identification setup.';
    updateManifestFeature({
      userDataDir,
      feature: 'diarization',
      fsModule,
      catalog,
      updates: buildFeatureUpdates({
        status: 'needsAccount',
        modelId: selectedModelId,
        engine: selectedEngine,
        speakerCount,
        validation: createValidation('needsAccount', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'needsAccount', status: 'needsAccount', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
  }

  updateManifestFeature({
    userDataDir,
    feature: 'diarization',
    fsModule,
    catalog,
      updates: buildFeatureUpdates({
        status: 'downloading',
        modelId: selectedModelId,
        engine: selectedEngine,
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
            engine: selectedEngine,
            speakerCount,
            validation: createValidation('notConfigured', message, now),
            error: null,
          }),
        });
        emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
        return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
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
          engine: selectedEngine,
          speakerCount,
        validation: createValidation('error', message, now),
        error: message,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'error', status: 'error', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
  }

  if (!tokenForValidation) {
    try {
      tokenForValidation = tokenReader({
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
      env,
      tokenStatusReader,
      tokenReader,
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
        engine: selectedEngine,
        speakerCount,
        validation: createValidation('notConfigured', message, now),
        error: null,
      }),
    });
    emitSafeProgress(emitProgress, { feature: 'diarization', phase: 'cancelled', status: 'notConfigured', message, modelId: selectedModelId, percent: 0 });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
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
  env = process.env,
} = {}) {
  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const selected = resolveDiarizationSetupTarget({
    engine: manifest.features.diarization.engine,
    modelId: manifest.features.diarization.modelId,
    manifest,
    catalog,
  });
  const modelId = selected.modelId;
  const engine = selected.engine;
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'removing',
    message: 'Removing speaker identification setup.',
    modelId,
  });

  if (engine === 'speakrs') {
    uninstallSpeakrsLocalState({ userDataDir, fsModule });
  } else {
    uninstallPyannoteLocalState({ userDataDir, modelId, fsModule });
  }

  updateManifestFeature({
    userDataDir,
    feature: 'diarization',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status: 'notConfigured',
      modelId,
      engine,
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

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog, env });
}

module.exports = {
  buildDiarizationDependencyInstallArgs,
  installDiarizationDependencies,
  downloadDiarizationSourceArtifacts,
  setupDiarizationAddon,
  validateDiarizationSetup,
  removeDiarizationSetup,
  checkMacOSCompilerToolchain,
  resolveDiarizationSetupTarget,
  uninstallSpeakrsLocalState,
  uninstallPyannoteLocalState,
};
