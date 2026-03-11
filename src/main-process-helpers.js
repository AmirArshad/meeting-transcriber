const path = require('path');

function getModelDownloadCacheDir(homeDir) {
  return path.join(homeDir, '.cache', 'huggingface', 'hub');
}

function getModelDownloadPatterns(platform, arch, modelSize = 'small') {
  const size = modelSize || 'small';
  const isMacArm = platform === 'darwin' && arch === 'arm64';

  if (isMacArm) {
    return [
      `models--mlx-community--whisper-${size}-mlx`,
      `models--mlx-community--whisper-${size}`,
      `models--distil-whisper--distil-${size}`,
      `whisper-${size}-mlx`,
      `distil-${size}`
    ];
  }

  return [`models--guillaumekln--faster-whisper-${size}`];
}

function buildModelDownloadCheck({ platform, arch, homeDir, modelSize }) {
  const size = modelSize || 'small';

  return {
    cacheDir: getModelDownloadCacheDir(homeDir),
    modelPatterns: getModelDownloadPatterns(platform, arch, size),
    modelSize: size
  };
}

function cacheContainsModel(items, modelPatterns) {
  return modelPatterns.some((pattern) => items.some((item) => item.includes(pattern)));
}

function classifyRecorderStdoutChunk(output) {
  const trimmed = output.trim();

  if (!trimmed.startsWith('{"type": "levels"')) {
    return { type: 'progress', output };
  }

  const lines = trimmed.split('\n');
  for (const line of lines) {
    if (line.startsWith('{"type": "levels"')) {
      try {
        return { type: 'levels', levels: JSON.parse(line) };
      } catch (error) {
        return { type: 'levels', levels: null };
      }
    }
  }

  return { type: 'levels', levels: null };
}

function isModelDownloadErrorOutput(output) {
  return output.toLowerCase().includes('error') && !output.includes('non-critical');
}

module.exports = {
  buildModelDownloadCheck,
  cacheContainsModel,
  classifyRecorderStdoutChunk,
  getModelDownloadCacheDir,
  getModelDownloadPatterns,
  isModelDownloadErrorOutput
};
