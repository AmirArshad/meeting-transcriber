const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const {
  AI_MODEL_CATALOG,
  buildAiAddonStatus,
  getAiAddonPaths,
  getDiarizationAvailability,
  getSummaryArtifactForPlatform,
  getSummaryAvailability,
  loadAiAddonManifest,
  normalizeAiAddonManifest,
  resolveModelId,
} = require('./ai-addon-state');
const {
  TOKEN_KEYS,
  deleteAiAddonToken,
  getAiAddonToken,
  hasAiAddonToken,
  storeAiAddonToken,
} = require('./ai-addon-token-store');

const AI_ADDON_PROGRESS_CHANNEL = 'ai-addon-progress';

const SENSITIVE_PROGRESS_KEYS = new Set([
  'hfToken',
  'llmOutput',
  'prompt',
  'rawOutput',
  'text',
  'token',
  'transcript',
  'transcriptText',
]);

function safePathSegment(value) {
  return String(value || 'model')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'model';
}

function getSummaryModelCacheDir(userDataDir, modelId) {
  return path.join(getAiAddonPaths(userDataDir).summaryModelCacheDir, safePathSegment(modelId));
}

function getDiarizationModelCacheDir(userDataDir, modelId) {
  return path.join(getAiAddonPaths(userDataDir).diarizationModelCacheDir, safePathSegment(modelId));
}

function getSummaryArtifactPath(userDataDir, artifact) {
  if (!artifact || !artifact.fileName) {
    return null;
  }

  return path.join(getSummaryModelCacheDir(userDataDir, artifact.modelId), artifact.fileName);
}

function bindFsMethod(fsModule, methodName) {
  const method = fsModule && fsModule[methodName];
  return typeof method === 'function' ? method.bind(fsModule) : undefined;
}

function loadManifest({ userDataDir, fsModule = fs, catalog = AI_MODEL_CATALOG } = {}) {
  return loadAiAddonManifest({
    userDataDir,
    existsSync: bindFsMethod(fsModule, 'existsSync'),
    readFileSync: bindFsMethod(fsModule, 'readFileSync'),
    catalog,
  }).manifest;
}

function writeFileAtomicSync(fsModule, targetPath, contents) {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const writeFileSync = bindFsMethod(fsModule, 'writeFileSync');
  const renameSync = bindFsMethod(fsModule, 'renameSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');

  if (!writeFileSync) {
    throw new Error('File system does not support writing AI add-on state.');
  }

  try {
    writeFileSync(tempPath, contents, 'utf8');
    if (renameSync) {
      renameSync(tempPath, targetPath);
    } else {
      writeFileSync(targetPath, contents, 'utf8');
      if (unlinkSync) {
        unlinkSync(tempPath);
      }
    }
  } finally {
    const existsSync = bindFsMethod(fsModule, 'existsSync');
    if (existsSync && unlinkSync && existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch (error) {
        // Best effort cleanup only.
      }
    }
  }
}

function saveAiAddonManifest({ userDataDir, manifest, fsModule = fs, catalog = AI_MODEL_CATALOG } = {}) {
  const paths = getAiAddonPaths(userDataDir);
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const normalized = normalizeAiAddonManifest(manifest, catalog);

  if (mkdirSync) {
    mkdirSync(paths.rootDir, { recursive: true });
  }

  writeFileAtomicSync(fsModule, paths.manifestPath, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

function updateManifestFeature({ userDataDir, feature, updates, fsModule = fs, catalog = AI_MODEL_CATALOG } = {}) {
  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const nextManifest = normalizeAiAddonManifest({
    ...manifest,
    features: {
      ...manifest.features,
      [feature]: {
        ...manifest.features[feature],
        ...updates,
      },
    },
  }, catalog);

  return saveAiAddonManifest({ userDataDir, manifest: nextManifest, fsModule, catalog });
}

function createValidation(status, message, now = () => new Date().toISOString()) {
  return {
    status,
    checkedAt: now(),
    message,
  };
}

function sanitizeProgressMessage(message) {
  return String(message || '')
    .replace(/hf_[A-Za-z0-9_-]+/g, '[redacted-token]')
    .slice(0, 300);
}

function createAiAddonProgressEvent(input = {}) {
  const event = {
    feature: input.feature === 'summary' ? 'summary' : 'diarization',
    phase: String(input.phase || 'status').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
    message: sanitizeProgressMessage(input.message),
  };

  if (Number.isFinite(input.percent)) {
    event.percent = Math.max(0, Math.min(100, Number(input.percent)));
  }
  if (typeof input.modelId === 'string' && input.modelId.trim()) {
    event.modelId = input.modelId.trim();
  }
  if (typeof input.status === 'string' && input.status.trim()) {
    event.status = input.status.trim();
  }

  for (const key of Object.keys(input)) {
    if (SENSITIVE_PROGRESS_KEYS.has(key)) {
      delete event[key];
    }
  }

  return event;
}

function emitSafeProgress(emitProgress, payload) {
  if (typeof emitProgress === 'function') {
    emitProgress(createAiAddonProgressEvent(payload));
  }
}

function isLikelyHuggingFaceToken(token) {
  return /^hf_[A-Za-z0-9_-]{8,}$/.test(String(token || '').trim());
}

function getDiarizationTokenStatus({ userDataDir, safeStorage, fsModule = fs } = {}) {
  return {
    hasToken: hasAiAddonToken({
      userDataDir,
      tokenKey: TOKEN_KEYS.diarizationHuggingFace,
      fsModule,
    }),
    encryptionAvailable: Boolean(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()),
  };
}

function checkDiarizationCache({ userDataDir, modelId }) {
  return {
    cacheDir: getDiarizationModelCacheDir(userDataDir, modelId),
    provider: 'huggingface',
    managedBy: 'pyannote.audio',
  };
}

async function hashFileSha256(filePath, fsModule = fs) {
  const createReadStream = bindFsMethod(fsModule, 'createReadStream');
  if (!createReadStream) {
    return crypto.createHash('sha256').update(fsModule.readFileSync(filePath)).digest('hex');
  }

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function checkSummaryModelCache({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  modelId,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  verifyChecksum = false,
} = {}) {
  const artifact = getSummaryArtifactForPlatform(modelId, platform, arch, catalog);
  if (!artifact) {
    return {
      supported: false,
      installed: false,
      valid: false,
      validationStatus: 'unsupported',
      reason: 'No summary setup artifact is available for this platform.',
    };
  }

  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  const modelCacheDir = getSummaryModelCacheDir(userDataDir, artifact.modelId);
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const installed = Boolean(artifactPath && existsSync && existsSync(artifactPath));

  const base = {
    supported: true,
    modelId: artifact.modelId,
    artifactId: artifact.artifactId,
    modelCacheDir,
    artifactPath,
    expectedFileName: artifact.fileName,
    expectedSha256: artifact.sha256,
    installed,
    valid: false,
    checksumStatus: artifact.sha256 ? 'notChecked' : 'pendingPinnedChecksum',
    validationStatus: artifact.validationStatus,
  };

  if (!artifact.fileName) {
    return {
      ...base,
      reason: 'Summary setup artifact filename is not configured.',
      validationStatus: 'missingPinnedFilename',
    };
  }

  if (!installed) {
    return {
      ...base,
      checksumStatus: 'notChecked',
      validationStatus: 'notConfigured',
      reason: 'Summary model artifact is not installed.',
    };
  }

  if (!artifact.sha256) {
    return {
      ...base,
      reason: 'Pinned summary artifact checksum is not configured.',
      validationStatus: 'pendingPinnedArtifact',
    };
  }

  if (!verifyChecksum) {
    return {
      ...base,
      valid: true,
      reason: null,
      validationStatus: 'installed',
    };
  }

  const actualSha256 = await hashFileSha256(artifactPath, fsModule);
  if (actualSha256 !== artifact.sha256) {
    return {
      ...base,
      actualSha256,
      checksumStatus: 'mismatch',
      validationStatus: 'error',
      reason: 'Summary model artifact checksum does not match the pinned checksum.',
    };
  }

  return {
    ...base,
    actualSha256,
    valid: true,
    checksumStatus: 'match',
    validationStatus: 'ready',
    reason: null,
  };
}

function deriveDiarizationStatus(featureStatus, tokenStatus) {
  if (!featureStatus.availability.supported) {
    return { ...featureStatus, status: 'unsupported' };
  }
  if (featureStatus.status === 'ready' && !tokenStatus.hasToken) {
    return {
      ...featureStatus,
      status: 'needsAccount',
      error: 'Hugging Face token is missing.',
    };
  }
  return featureStatus;
}

function deriveSummaryStatus(featureStatus, cache) {
  if (!featureStatus.availability.supported) {
    return { ...featureStatus, status: 'unsupported' };
  }
  if (featureStatus.status === 'ready' && !cache.installed) {
    return {
      ...featureStatus,
      status: 'error',
      error: 'Summary model cache is missing.',
    };
  }
  if (featureStatus.status === 'ready' && cache.installed && cache.valid === false && cache.checksumStatus !== 'notChecked') {
    return {
      ...featureStatus,
      status: 'error',
      error: cache.reason || 'Summary model cache validation failed.',
    };
  }
  return featureStatus;
}

async function checkAiAddonSetupStatus({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  verifyChecksums = false,
} = {}) {
  const { manifest, readError } = loadAiAddonManifest({
    userDataDir,
    existsSync: bindFsMethod(fsModule, 'existsSync'),
    readFileSync: bindFsMethod(fsModule, 'readFileSync'),
    catalog,
  });
  const status = buildAiAddonStatus({ userDataDir, platform, arch, manifest, readError, catalog });
  const tokenStatus = getDiarizationTokenStatus({ userDataDir, safeStorage, fsModule });
  const summaryCache = await checkSummaryModelCache({
    userDataDir,
    platform,
    arch,
    modelId: status.features.summary.modelId,
    fsModule,
    catalog,
    verifyChecksum: verifyChecksums,
  });
  const diarization = deriveDiarizationStatus(status.features.diarization, tokenStatus);
  const summary = deriveSummaryStatus(status.features.summary, summaryCache);

  return {
    ...status,
    features: {
      diarization: {
        ...diarization,
        tokenStatus,
        cache: checkDiarizationCache({ userDataDir, modelId: diarization.modelId }),
        setupComplete: diarization.status === 'ready' && tokenStatus.hasToken,
      },
      summary: {
        ...summary,
        artifact: getSummaryArtifactForPlatform(summary.modelId, platform, arch, catalog),
        cache: summaryCache,
        setupComplete: summary.status === 'ready' && summaryCache.installed,
      },
    },
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

async function validateDiarizationSetup({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  safeStorage,
  fsModule = fs,
  catalog = AI_MODEL_CATALOG,
  now = () => new Date().toISOString(),
  emitProgress,
} = {}) {
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Validating speaker identification setup.',
  });

  const manifest = loadManifest({ userDataDir, fsModule, catalog });
  const modelId = resolveModelId('diarization', manifest.features.diarization.modelId, catalog);
  const availability = getDiarizationAvailability(platform, arch);
  let status = 'ready';
  let message = 'Speaker identification setup is ready.';
  let error = null;

  if (!availability.supported) {
    status = 'unsupported';
    message = availability.reason;
    error = availability.reason;
  } else if (!getDiarizationTokenStatus({ userDataDir, safeStorage, fsModule }).hasToken) {
    status = 'needsAccount';
    message = 'Hugging Face token is required for speaker identification setup.';
    error = message;
  } else {
    try {
      const token = getAiAddonToken({
        userDataDir,
        tokenKey: TOKEN_KEYS.diarizationHuggingFace,
        safeStorage,
        fsModule,
      });
      if (!isLikelyHuggingFaceToken(token)) {
        status = 'needsAccount';
        message = 'Stored Hugging Face token does not match the expected token format.';
        error = message;
      }
    } catch (validationError) {
      status = 'error';
      message = 'Stored Hugging Face token could not be decrypted.';
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
} = {}) {
  emitSafeProgress(emitProgress, {
    feature: 'diarization',
    phase: 'validating',
    message: 'Checking speaker identification setup.',
  });

  const selectedModelId = resolveModelId('diarization', modelId, catalog);
  const availability = getDiarizationAvailability(platform, arch);
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

    storeAiAddonToken({
      userDataDir,
      tokenKey: TOKEN_KEYS.diarizationHuggingFace,
      token: trimmedToken,
      safeStorage,
      fsModule,
    });
  }

  updateManifestFeature({
    userDataDir,
    feature: 'diarization',
    fsModule,
    catalog,
    updates: buildFeatureUpdates({
      status: 'validating',
      modelId: selectedModelId,
      speakerCount,
      validation: createValidation('validating', 'Speaker identification setup validation started.', now),
      error: null,
    }),
  });

  return validateDiarizationSetup({ userDataDir, platform, arch, safeStorage, fsModule, catalog, now, emitProgress });
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

function validateSummarySetupArtifact(artifact) {
  if (!artifact) {
    return 'No summary setup artifact is available for this platform.';
  }
  if (!artifact.fileName) {
    return 'Summary setup artifact filename is not configured.';
  }
  if (!artifact.sha256) {
    return 'Pinned summary artifact checksum is not configured.';
  }
  if (!artifact.downloadUrl) {
    return 'Pinned summary setup artifact download URL is not configured.';
  }
  return null;
}

async function downloadFile({ url, destinationPath, onProgress }) {
  const parsedUrl = new URL(url);
  const client = parsedUrl.protocol === 'https:' ? https : parsedUrl.protocol === 'http:' ? http : null;
  if (!client) {
    throw new Error('Unsupported summary setup artifact URL protocol.');
  }

  return new Promise((resolve, reject) => {
    const request = client.get(parsedUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile({ url: response.headers.location, destinationPath, onProgress }).then(resolve, reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Summary setup artifact download failed with HTTP ${response.statusCode}.`));
        return;
      }

      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      const file = fs.createWriteStream(destinationPath);
      const total = Number(response.headers['content-length']) || null;
      let downloaded = 0;

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total && typeof onProgress === 'function') {
          onProgress({ downloaded, total, percent: (downloaded / total) * 100 });
        }
      });

      file.on('error', reject);
      file.on('finish', () => file.close(resolve));
      response.pipe(file);
    });

    request.on('error', reject);
  });
}

async function validateSummaryModel({
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
    phase: 'validating',
    message: 'Validating local summary model.',
    modelId: selectedModelId,
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
  let status = cache.valid ? 'ready' : 'error';
  let message = cache.valid ? 'Local summary model is ready.' : cache.reason;

  if (!availability.supported) {
    status = 'unsupported';
    message = availability.reason;
  } else if (!cache.installed) {
    status = 'notConfigured';
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
  });

  return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
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
} = {}) {
  const selectedModelId = resolveModelId('summary', modelId, catalog);
  const artifact = getSummaryArtifactForPlatform(selectedModelId, platform, arch, catalog);
  const availability = getSummaryAvailability(platform, arch);
  const artifactError = availability.supported ? validateSummarySetupArtifact(artifact) : availability.reason;

  emitSafeProgress(emitProgress, {
    feature: 'summary',
    phase: 'downloading',
    message: 'Checking local summary setup artifact.',
    modelId: selectedModelId,
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
  if (cache.valid) {
    return validateSummaryModel({ userDataDir, platform, arch, modelId: selectedModelId, safeStorage, fsModule, catalog, now, emitProgress });
  }

  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  const tempPath = `${artifactPath}.download`;
  const mkdirSync = bindFsMethod(fsModule, 'mkdirSync');
  const renameSync = bindFsMethod(fsModule, 'renameSync');
  const unlinkSync = bindFsMethod(fsModule, 'unlinkSync');
  if (mkdirSync) {
    mkdirSync(path.dirname(artifactPath), { recursive: true });
  }

  await downloader({
    url: artifact.downloadUrl,
    destinationPath: tempPath,
    expectedSizeBytes: artifact.estimatedSizeBytes,
    onProgress: (progress) => emitSafeProgress(emitProgress, {
      feature: 'summary',
      phase: 'downloading',
      message: 'Downloading local summary setup artifact.',
      percent: progress.percent,
      modelId: selectedModelId,
    }),
  });

  const actualSha256 = await hashFileSha256(tempPath, fsModule);
  if (actualSha256 !== artifact.sha256) {
    if (unlinkSync) {
      unlinkSync(tempPath);
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
    emitSafeProgress(emitProgress, { feature: 'summary', phase: 'error', status: 'error', message, modelId: selectedModelId });
    return checkAiAddonSetupStatus({ userDataDir, platform, arch, safeStorage, fsModule, catalog });
  }

  if (!renameSync) {
    throw new Error('File system does not support installing summary setup artifacts.');
  }
  renameSync(tempPath, artifactPath);

  return validateSummaryModel({ userDataDir, platform, arch, modelId: selectedModelId, safeStorage, fsModule, catalog, now, emitProgress });
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
  checkAiAddonSetupStatus,
  checkSummaryModelCache,
  createAiAddonProgressEvent,
  getDiarizationModelCacheDir,
  getSummaryArtifactPath,
  getSummaryModelCacheDir,
  isLikelyHuggingFaceToken,
  removeDiarizationSetup,
  removeSummaryModel,
  saveAiAddonManifest,
  setupDiarizationAddon,
  setupSummaryModel,
  validateDiarizationSetup,
  validateSummaryModel,
};
