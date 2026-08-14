'use strict';

const path = require('path');
const fs = require('fs');

function stripWindowsNamespacePrefix(filePath) {
  if (typeof filePath !== 'string') {
    return filePath;
  }

  if (filePath.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${filePath.slice(8)}`;
  }
  if (filePath.startsWith('\\\\?\\')) {
    return filePath.slice(4);
  }
  return filePath;
}

function normalizeComparablePath(filePath) {
  if (typeof filePath !== 'string' || !filePath) {
    return filePath;
  }

  const resolved = path.resolve(stripWindowsNamespacePrefix(filePath));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrInsideDirectory(filePath, directoryPath) {
  const normalizedFile = normalizeComparablePath(filePath);
  const normalizedDirectory = normalizeComparablePath(directoryPath);
  if (!normalizedFile || !normalizedDirectory) {
    return false;
  }

  if (normalizedFile === normalizedDirectory) {
    return true;
  }

  const prefix = normalizedDirectory.endsWith(path.sep)
    ? normalizedDirectory
    : `${normalizedDirectory}${path.sep}`;
  return normalizedFile.startsWith(prefix);
}

function resolveExistingRealPath(filePath, fsImpl = fs) {
  if (!filePath) {
    return null;
  }

  try {
    const realpathSync = fsImpl.realpathSync.native || fsImpl.realpathSync;
    return stripWindowsNamespacePrefix(realpathSync(filePath));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isPathInsideDirectory(filePath, directoryPath, fsImpl = fs) {
  if (!filePath || !directoryPath) {
    return false;
  }

  const resolvedDirectory = resolveExistingRealPath(directoryPath, fsImpl);
  const resolvedPath = resolveExistingRealPath(filePath, fsImpl);

  if (resolvedDirectory && resolvedPath) {
    return isSameOrInsideDirectory(resolvedPath, resolvedDirectory);
  }

  if (resolvedDirectory && !resolvedPath) {
    if (!isSameOrInsideDirectory(filePath, directoryPath)) {
      return false;
    }

    const parentRealPath = resolveExistingRealPath(path.dirname(filePath), fsImpl);
    return Boolean(
      parentRealPath
      && isSameOrInsideDirectory(parentRealPath, resolvedDirectory),
    );
  }

  return isSameOrInsideDirectory(filePath, directoryPath);
}

function isSafeRecordingsPath({ filePath, recordingsDir, allowedExtensions = [] } = {}) {
  if (!isPathInsideDirectory(filePath, recordingsDir)) {
    return false;
  }

  if (!allowedExtensions.length) {
    return true;
  }

  const extension = path.extname(path.resolve(filePath)).toLowerCase();
  return allowedExtensions.map((item) => String(item).toLowerCase()).includes(extension);
}

function isSafeRecordingsMarkdownPath({ filePath, recordingsDir } = {}) {
  return isSafeRecordingsPath({ filePath, recordingsDir, allowedExtensions: ['.md'] });
}

function isSafeRecordingsAudioPath({ filePath, recordingsDir } = {}) {
  return isSafeRecordingsPath({ filePath, recordingsDir, allowedExtensions: ['.opus', '.wav', '.m4a', '.mp3', '.flac'] });
}

function isSafeRecordingsJsonPath({ filePath, recordingsDir } = {}) {
  return isSafeRecordingsPath({ filePath, recordingsDir, allowedExtensions: ['.json'] });
}

function resolveTranscriptionAudioFile({ audioFile, recordingsDir, existsSync }) {
  const fileExists = existsSync || (() => false);
  let resolvedAudioFile = String(audioFile || '');

  if (!resolvedAudioFile) {
    return resolvedAudioFile;
  }

  if (!path.isAbsolute(resolvedAudioFile) && !resolvedAudioFile.includes(path.sep) && !resolvedAudioFile.includes('/')) {
    resolvedAudioFile = path.join(recordingsDir, path.basename(resolvedAudioFile));
  }

  if (path.extname(resolvedAudioFile).toLowerCase() !== '.wav') {
    return resolvedAudioFile;
  }

  if (fileExists(resolvedAudioFile)) {
    return resolvedAudioFile;
  }

  const opusSibling = resolvedAudioFile.replace(/\.wav$/i, '.opus');
  if (fileExists(opusSibling)) {
    return opusSibling;
  }

  return resolvedAudioFile;
}

module.exports = {
  isPathInsideDirectory,
  resolveExistingRealPath,
  isSafeRecordingsAudioPath,
  isSafeRecordingsJsonPath,
  isSafeRecordingsMarkdownPath,
  isSafeRecordingsPath,
  resolveTranscriptionAudioFile,
};
