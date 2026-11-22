'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const TRUSTED_GITHUB_PATH_PREFIX = '/AmirArshad/meeting-transcriber';
const TRUSTED_GITHUB_EXACT_PATHS = new Set([
  '/avencera/speakrs',
  '/ggml-org/llama.cpp',
  '/ai-dock/llama.cpp-cuda',
]);
const TRUSTED_HUGGING_FACE_PATHS = new Set([
  '/pyannote/speaker-diarization-community-1',
  '/settings/tokens',
  '/Qwen/Qwen3.5-9B',
  '/unsloth/Qwen3.8-27B-GGUF',
  '/ggml-org/gemma-4-E4B-it-GGUF',
  '/ggml-org/gemma-4-12B-it-GGUF',
  '/ggml-org/gemma-4-26B-A4B-it-GGUF',
  '/prism-ml/Ternary-Bonsai-2-9B-gguf',
  '/prism-ml/Ternary-Bonsai-2-27B-gguf',
  '/unsloth/Ministral-3-14B-Instruct-2512-GGUF',
  '/ggml-org/Inkling-2-Mini-GGUF',
  '/nvidia/parakeet-tdt-0.6b-v2',
  '/istupakov/parakeet-tdt-0.6b-v2-onnx',
  '/mlx-community/parakeet-tdt-0.6b-v2',
]);
const TRUSTED_CREATIVE_COMMONS_PATHS = new Set([
  '/licenses/by/4.0',
  '/licenses/by/4.0/',
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

function hasUnsafeHttpsPath(rawUrl, parsedUrl) {
  const str = String(rawUrl || '').trim();
  const schemeMatch = str.match(/^https:\/\/[^/?#]+(\/[^?#]*)?/i);
  const rawPath = (schemeMatch && schemeMatch[1]) ? schemeMatch[1] : '';
  const pathname = String((parsedUrl && parsedUrl.pathname) || '');

  if (/%2f|%5c|\\/i.test(rawPath) || /%2f|%5c|\\/i.test(pathname)) {
    return true;
  }

  let decodedRawPath;
  let decodedPathname;
  try {
    decodedRawPath = decodeURIComponent(rawPath);
    decodedPathname = decodeURIComponent(pathname);
  } catch (_error) {
    return true;
  }

  if (
    decodedRawPath.includes('\\')
    || decodedRawPath.includes('\0')
    || decodedPathname.includes('\\')
    || decodedPathname.includes('\0')
  ) {
    return true;
  }

  if (decodedRawPath.split('/').some((seg) => seg === '.' || seg === '..')) {
    return true;
  }

  return decodedPathname.split('/').some((seg) => seg === '.' || seg === '..');
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

    if (parsedUrl.username || parsedUrl.password || parsedUrl.port) {
      return false;
    }

    if (hasUnsafeHttpsPath(url, parsedUrl)) {
      return false;
    }

    if (parsedUrl.hostname === 'github.com') {
      return parsedUrl.pathname === TRUSTED_GITHUB_PATH_PREFIX
        || parsedUrl.pathname.startsWith(`${TRUSTED_GITHUB_PATH_PREFIX}/`)
        || TRUSTED_GITHUB_EXACT_PATHS.has(parsedUrl.pathname);
    }

    if (parsedUrl.hostname === 'creativecommons.org') {
      return TRUSTED_CREATIVE_COMMONS_PATHS.has(parsedUrl.pathname);
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
