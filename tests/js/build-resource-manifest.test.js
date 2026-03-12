const test = require('node:test');
const assert = require('node:assert/strict');

const { hashString } = require('../../build/download-manifest');


test('hashString returns a stable SHA-256 for resource manifest inputs', () => {
  assert.equal(
    hashString('meeting-transcriber resource manifest\n'),
    'b135831e52b8ba2ecf6c995ec081334a59cd4e8218616cf7331b036b97532b38',
  );
});


test('swift build bin-path example resolves the helper binary location', () => {
  const binPath = '/tmp/AudioCaptureHelper/.build/arm64-apple-macosx/release';
  const helperBinary = `${binPath}/audiocapture-helper`;

  assert.equal(
    helperBinary,
    '/tmp/AudioCaptureHelper/.build/arm64-apple-macosx/release/audiocapture-helper',
  );
});
