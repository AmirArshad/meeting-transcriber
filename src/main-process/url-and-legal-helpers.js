'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const TRUSTED_GITHUB_PATH_PREFIX = '/AmirArshad/meeting-transcriber';
const TRUSTED_HUGGING_FACE_PATHS = new Set([
  '/pyannote/speaker-diarization-community-1',
  '/settings/tokens',
]);

function buildFileUrl(filePath) {
  const normalizedPath = String(filePath || '').trim();

  if (!normalizedPath) {
    return '';
  }

  if (normalizedPath.startsWith('file://')) {
    return normalizedPath;
  }

  return pathToFileURL(path.resolve(normalizedPath)).toString();
}

function isTrustedExternalUrl(url) {
  try {
    const parsedUrl = new URL(String(url || ''));

    if (parsedUrl.protocol === 'x-apple.systempreferences:') {
      return true;
    }

    if (parsedUrl.protocol !== 'https:') {
      return false;
    }

    if (parsedUrl.hostname === 'github.com') {
      return parsedUrl.pathname === TRUSTED_GITHUB_PATH_PREFIX ||
        parsedUrl.pathname.startsWith(`${TRUSTED_GITHUB_PATH_PREFIX}/`);
    }

    return parsedUrl.hostname === 'huggingface.co' &&
      TRUSTED_HUGGING_FACE_PATHS.has(parsedUrl.pathname);
  } catch (error) {
    return false;
  }
}

function resolveExternalUrl(url) {
  if (!isTrustedExternalUrl(url)) {
    return null;
  }

  return new URL(String(url)).toString();
}

function getLegalNoticesPath(options = {}) {
  // __dirname is src/main-process/; go up two levels to repo root (was path.join(__dirname, '..') when this lived in src/).
  const devRoot = options.devRoot || path.join(__dirname, '..', '..');
  const resourcesPath = options.resourcesPath ? String(options.resourcesPath) : '';

  if (resourcesPath) {
    const packagedPath = path.join(resourcesPath, 'legal', 'THIRD_PARTY_NOTICES.md');
    if (fs.existsSync(packagedPath)) {
      return packagedPath;
    }
  }

  const devPath = path.join(devRoot, 'THIRD_PARTY_NOTICES.md');
  return fs.existsSync(devPath) ? devPath : null;
}

module.exports = {
  buildFileUrl,
  isTrustedExternalUrl,
  resolveExternalUrl,
  getLegalNoticesPath,
};
