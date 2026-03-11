const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildModelDownloadCheck,
  cacheContainsModel,
  classifyRecorderStdoutChunk,
  getModelDownloadPatterns,
  isModelDownloadErrorOutput,
} = require('../../src/main-process-helpers');


test('buildModelDownloadCheck returns Windows faster-whisper cache settings', () => {
  const result = buildModelDownloadCheck({
    platform: 'win32',
    arch: 'x64',
    homeDir: '/Users/tester',
    modelSize: 'medium',
  });

  assert.equal(result.cacheDir, path.join('/Users/tester', '.cache', 'huggingface', 'hub'));
  assert.deepEqual(result.modelPatterns, ['models--guillaumekln--faster-whisper-medium']);
  assert.equal(result.modelSize, 'medium');
});


test('getModelDownloadPatterns returns macOS Apple Silicon MLX patterns', () => {
  assert.deepEqual(getModelDownloadPatterns('darwin', 'arm64', 'small'), [
    'models--mlx-community--whisper-small-mlx',
    'models--mlx-community--whisper-small',
    'models--distil-whisper--distil-small',
    'whisper-small-mlx',
    'distil-small',
  ]);
});


test('cacheContainsModel matches a cached model entry by pattern fragment', () => {
  const items = [
    'models--foo--bar',
    'models--guillaumekln--faster-whisper-small',
  ];

  assert.equal(
    cacheContainsModel(items, ['models--guillaumekln--faster-whisper-small']),
    true,
  );
});


test('classifyRecorderStdoutChunk parses the first audio level payload', () => {
  const chunk = '{"type": "levels", "micLevel": 0.4, "desktopLevel": 0.2}\n{"type": "levels", "micLevel": 0.1, "desktopLevel": 0.1}';

  const result = classifyRecorderStdoutChunk(chunk);

  assert.equal(result.type, 'levels');
  assert.deepEqual(result.levels, {
    type: 'levels',
    micLevel: 0.4,
    desktopLevel: 0.2,
  });
});


test('classifyRecorderStdoutChunk treats malformed level JSON as a level chunk without parsed data', () => {
  const result = classifyRecorderStdoutChunk('{"type": "levels", bad json');

  assert.equal(result.type, 'levels');
  assert.equal(result.levels, null);
});


test('classifyRecorderStdoutChunk keeps non-level output as progress text', () => {
  const result = classifyRecorderStdoutChunk('Desktop audio stream opened');

  assert.deepEqual(result, {
    type: 'progress',
    output: 'Desktop audio stream opened',
  });
});


test('isModelDownloadErrorOutput ignores non-critical warnings but flags actual errors', () => {
  assert.equal(isModelDownloadErrorOutput('ERROR: failed to download model'), true);
  assert.equal(isModelDownloadErrorOutput('non-critical error: retrying download'), false);
});
