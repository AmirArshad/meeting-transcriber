'use strict';

const path = require('path');
const fs = require('fs');

function resolveExistingRealPath(filePath, fsImpl = fs) {
  if (!filePath) {
    return null;
  }

  try {
    const realpathSync = fsImpl.realpathSync.native || fsImpl.realpathSync;
    return realpathSync(filePath);
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
    return resolvedPath === resolvedDirectory || resolvedPath.startsWith(resolvedDirectory + path.sep);
  }

  if (resolvedDirectory && !resolvedPath) {
    const lexicalPath = path.resolve(filePath);
    if (!(lexicalPath === resolvedDirectory || lexicalPath.startsWith(resolvedDirectory + path.sep))) {
      return false;
    }

    const parentRealPath = resolveExistingRealPath(path.dirname(filePath), fsImpl);
    return Boolean(
      parentRealPath
      && (parentRealPath === resolvedDirectory || parentRealPath.startsWith(resolvedDirectory + path.sep))
    );
  }

  const lexicalPath = path.resolve(filePath);
  const lexicalDirectory = path.resolve(directoryPath);
  return lexicalPath === lexicalDirectory || lexicalPath.startsWith(lexicalDirectory + path.sep);
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
