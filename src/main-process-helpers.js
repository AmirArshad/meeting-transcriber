const path = require('path');

function getModelDownloadCacheDir(homeDir) {
  return path.join(homeDir, '.cache', 'huggingface', 'hub');
}

function getMacMLXCacheDir(homeDir) {
  return path.join(homeDir, 'Library', 'Caches', 'meeting-transcriber', 'mlx_models');
}

function getMacMLXModelStorageDirs(modelSize = 'small') {
  const size = modelSize || 'small';

  switch (size) {
    case 'tiny':
      return ['whisper-tiny-mlx'];
    case 'base':
      return ['whisper-base-mlx'];
    case 'small':
      return ['distil-small.en', 'whisper-small-mlx'];
    case 'medium':
      return ['distil-medium.en', 'whisper-medium-mlx'];
    case 'large':
    case 'large-v3':
      return ['distil-large-v3', 'whisper-large-v3-mlx'];
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

  return [`models--guillaumekln--faster-whisper-${size}`];
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
  return modelPatterns.some((pattern) => items.some((item) => item.includes(pattern)));
}

function splitBufferedLines(output, pendingBuffer = '') {
  const combined = `${pendingBuffer}${output}`;
  const normalized = combined.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');

  return {
    lines: parts.slice(0, -1),
    remainder: parts.at(-1) || ''
  };
}

function normalizeRecorderLevels(levels) {
  return {
    type: 'levels',
    mic: Number(levels.mic ?? levels.micLevel ?? 0),
    desktop: Number(levels.desktop ?? levels.desktopLevel ?? 0)
  };
}

function parseRecorderMessageLine(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);

    if (!parsed || typeof parsed !== 'object') {
      return { kind: 'text', payload: { message: trimmed } };
    }

    if (parsed.type === 'levels') {
      return { kind: 'levels', payload: normalizeRecorderLevels(parsed), raw: parsed };
    }

    if (parsed.type === 'warning') {
      return { kind: 'warning', payload: parsed };
    }

    if (parsed.type === 'error') {
      return { kind: 'error', payload: parsed };
    }

    if (parsed.type === 'event') {
      return { kind: 'event', payload: parsed };
    }

    if (parsed.type === 'status' || parsed.type === 'ready' || parsed.type === 'progress') {
      return { kind: 'status', payload: parsed };
    }

    if (parsed.outputPath || parsed.audioPath) {
      return { kind: 'result', payload: parsed };
    }

    return { kind: 'json', payload: parsed };
  } catch (error) {
    return { kind: 'text', payload: { message: trimmed } };
  }
}

function parseRecorderStdoutChunk(output, pendingBuffer = '') {
  const { lines, remainder } = splitBufferedLines(output, pendingBuffer);
  const messages = [];

  for (const line of lines) {
    const parsed = parseRecorderMessageLine(line);
    if (parsed) {
      messages.push(parsed);
    }
  }

  return { messages, remainder };
}

function classifyRecorderStdoutChunk(output) {
  const { messages } = parseRecorderStdoutChunk(`${output}\n`);
  const firstMessage = messages[0];

  if (!firstMessage) {
    return { type: 'progress', output };
  }

  if (firstMessage.kind === 'levels') {
    return { type: 'levels', levels: firstMessage.payload };
  }

  return {
    type: 'progress',
    output: firstMessage.payload?.message || output
  };
}

function isModelDownloadErrorOutput(output) {
  return output.toLowerCase().includes('error') && !output.includes('non-critical');
}

module.exports = {
  buildModelDownloadCheck,
  cacheContainsModel,
  classifyRecorderStdoutChunk,
  getMacMLXModelStorageDirs,
  getModelDownloadCacheDir,
  getMacMLXCacheDir,
  getModelDownloadPatterns,
  isModelDownloadErrorOutput,
  normalizeRecorderLevels,
  parseRecorderMessageLine,
  parseRecorderStdoutChunk,
  splitBufferedLines
};
