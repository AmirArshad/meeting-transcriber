'use strict';

const path = require('path');
const fs = require('fs');

const ALLOWED_WHISPER_MODELS = Object.freeze(['tiny', 'base', 'small', 'medium', 'large', 'large-v3']);
// Transcription cache completeness (keep aligned with backend/transcription/faster_whisper_transcriber.py
// and MLX _required_model_files_cached in mlx_whisper_transcriber.py; see AGENTS.md).
const FASTER_WHISPER_REQUIRED_CACHE_FILES = ['config.json', 'model.bin', 'tokenizer.json'];
const FASTER_WHISPER_VOCABULARY_CACHE_FILES = ['vocabulary.txt', 'vocabulary.json'];
const MLX_REQUIRED_CACHE_FILES = ['weights.npz', 'config.json'];

function normalizeModelSize(modelSize, { defaultSize = 'small' } = {}) {
  const normalized = String(modelSize || '').trim().toLowerCase();
  if (!normalized) {
    return { ok: true, modelSize: defaultSize };
  }
  if (ALLOWED_WHISPER_MODELS.includes(normalized)) {
    return { ok: true, modelSize: normalized };
  }
  return {
    ok: false,
    modelSize: null,
    error: `Unsupported Whisper model size: ${modelSize}`,
  };
}

function matchesFasterWhisperCacheFolderName(entryName, modelPatterns) {
  return modelPatterns.some((pattern) => entryName === pattern);
}

function getModelDownloadCacheDir(homeDir) {
  return path.join(homeDir, '.cache', 'huggingface', 'hub');
}

function getMacMLXCacheDir(homeDir) {
  return path.join(homeDir, 'Library', 'Caches', 'avanevis', 'mlx_models');
}

function getMacMLXModelStorageDirs(modelSize = 'small') {
  const size = modelSize || 'small';

  switch (size) {
    case 'tiny':
      return ['whisper-tiny-mlx'];
    case 'base':
      return ['whisper-base-mlx'];
    case 'small':
      return ['whisper-small-mlx'];
    case 'medium':
      return ['whisper-medium-mlx'];
    case 'large':
    case 'large-v3':
      return ['whisper-large-v3-mlx'];
    default:
      return [`distil-${size}.en`, `whisper-${size}-mlx`, `whisper-${size}`];
  }
}

function getModelDownloadPatterns(platform, arch, modelSize = 'small') {
  const size = modelSize || 'small';
  const isMacArm = platform === 'darwin' && arch === 'arm64';

  if (isMacArm) {
    return getMacMLXModelStorageDirs(size);
  }

  return [
    `models--Systran--faster-whisper-${size}`,
    `models--guillaumekln--faster-whisper-${size}`,
  ];
}

function buildModelDownloadCheck({ platform, arch, homeDir, modelSize }) {
  const size = modelSize || 'small';
  const isMacArm = platform === 'darwin' && arch === 'arm64';

  return {
    cacheDir: isMacArm ? getMacMLXCacheDir(homeDir) : getModelDownloadCacheDir(homeDir),
    modelPatterns: getModelDownloadPatterns(platform, arch, size),
    modelSize: size
  };
}

function cacheContainsModel(items, modelPatterns) {
  return modelPatterns.some((pattern) => items.some((item) => item === pattern));
}

function safeReadDir(dirPath, fsImpl = fs) {
  try {
    return fsImpl.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    return [];
  }
}

function hasReadableFile(filePath, fsImpl = fs) {
  try {
    const stats = fsImpl.statSync(filePath);
    return stats.isFile() && stats.size > 0;
  } catch (error) {
    return false;
  }
}

function directoryHasRequiredFiles(dirPath, requiredFiles, alternateFiles = [], fsImpl = fs) {
  return requiredFiles.every((fileName) => hasReadableFile(path.join(dirPath, fileName), fsImpl)) &&
    (!alternateFiles.length || alternateFiles.some((fileName) => hasReadableFile(path.join(dirPath, fileName), fsImpl)));
}

function cacheContainsCompleteFasterWhisperModel({ cacheDir, modelPatterns, fsImpl = fs } = {}) {
  if (!cacheDir || !Array.isArray(modelPatterns) || !modelPatterns.length) {
    return false;
  }

  return safeReadDir(cacheDir, fsImpl).some((entry) => {
    const entryName = entry && entry.name ? entry.name : String(entry || '');
    if (!matchesFasterWhisperCacheFolderName(entryName, modelPatterns)) {
      return false;
    }

    const snapshotsDir = path.join(cacheDir, entryName, 'snapshots');
    return safeReadDir(snapshotsDir, fsImpl).some((snapshot) => {
      if (snapshot && typeof snapshot.isDirectory === 'function' && !snapshot.isDirectory()) {
        return false;
      }

      const snapshotName = snapshot && snapshot.name ? snapshot.name : String(snapshot || '');
      return directoryHasRequiredFiles(
        path.join(snapshotsDir, snapshotName),
        FASTER_WHISPER_REQUIRED_CACHE_FILES,
        FASTER_WHISPER_VOCABULARY_CACHE_FILES,
        fsImpl,
      );
    });
  });
}

function cacheContainsCompleteMacMLXModel({ cacheDir, modelPatterns, fsImpl = fs } = {}) {
  if (!cacheDir || !Array.isArray(modelPatterns) || !modelPatterns.length) {
    return false;
  }

  return modelPatterns.some((modelDir) => directoryHasRequiredFiles(
    path.join(cacheDir, modelDir),
    MLX_REQUIRED_CACHE_FILES,
    [],
    fsImpl,
  ));
}

function cacheContainsCompleteTranscriptionModel({ cacheDir, modelPatterns, platform, arch, fsImpl = fs } = {}) {
  if (platform === 'darwin' && arch === 'arm64') {
    return cacheContainsCompleteMacMLXModel({ cacheDir, modelPatterns, fsImpl });
  }

  return cacheContainsCompleteFasterWhisperModel({ cacheDir, modelPatterns, fsImpl });
}

function isModelDownloadErrorOutput(output) {
  return output.toLowerCase().includes('error') && !output.includes('non-critical');
}

module.exports = {
  ALLOWED_WHISPER_MODELS,
  normalizeModelSize,
  matchesFasterWhisperCacheFolderName,
  cacheContainsModel,
  cacheContainsCompleteFasterWhisperModel,
  cacheContainsCompleteMacMLXModel,
  cacheContainsCompleteTranscriptionModel,
  getMacMLXModelStorageDirs,
  getModelDownloadCacheDir,
  getMacMLXCacheDir,
  getModelDownloadPatterns,
  buildModelDownloadCheck,
  isModelDownloadErrorOutput,
};
