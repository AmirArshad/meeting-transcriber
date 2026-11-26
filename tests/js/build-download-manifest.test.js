const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUILD_DOWNLOADS,
  getBuildDownload,
  hashFile,
  verifyFileChecksum,
} = require('../../build/download-manifest');


test('BUILD_DOWNLOADS uses pinned direct download URLs', () => {
  assert.equal(
    BUILD_DOWNLOADS.pythonWin.url,
    'https://github.com/astral-sh/python-build-standalone/releases/download/20261124/cpython-3.11.18+20261124-x86_64-pc-windows-msvc-install_only.tar.gz',
  );
  assert.equal(BUILD_DOWNLOADS.pythonWin.sha256, '3e4a35e3c238e5090d36bf95c041d9052bc82d6e298cb912ba7f70f6c66cf81a');
  assert.equal(
    BUILD_DOWNLOADS.pythonMac.url,
    'https://github.com/astral-sh/python-build-standalone/releases/download/20261124/cpython-3.11.18+20261124-aarch64-apple-darwin-install_only.tar.gz',
  );
  assert.equal(BUILD_DOWNLOADS.pythonMac.sha256, '89ce773f5eb6f072ceea3a30d86258ecd5d02ea0f8e87fda0b940b9067aebf81');
  assert.equal(BUILD_DOWNLOADS.ffmpegWin.url, 'https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip');
  assert.equal(BUILD_DOWNLOADS.ffmpegWin.sha256, 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec');
  assert.equal(
    BUILD_DOWNLOADS.ffmpegMac.url,
    'https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.1.2-1/ffmpeg-osx-arm64',
  );
  assert.equal(BUILD_DOWNLOADS.ffmpegMac.requiredArch, 'arm64');
  assert.equal(BUILD_DOWNLOADS.ffmpegMac.sha256, 'e7b9fcd97f95f333512d6e8b8ac24d9dbc08f189f36047695499bd7b57214b22');
  assert.equal(
    BUILD_DOWNLOADS.pythonLinux.url,
    'https://github.com/astral-sh/python-build-standalone/releases/download/20261124/cpython-3.11.18+20261124-x86_64-unknown-linux-gnu-install_only.tar.gz',
  );
  assert.equal(BUILD_DOWNLOADS.pythonLinux.sha256, 'ef0764e884b5e123692281b91bf388f8ebfd0afb41d6a212bb4f2779e51abf0e');
  assert.equal(
    BUILD_DOWNLOADS.ffmpegLinux.url,
    'https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.1.2-1/ffmpeg-linux-x64',
  );
  assert.equal(BUILD_DOWNLOADS.ffmpegLinux.requiredArch, 'x64');
  assert.equal(BUILD_DOWNLOADS.ffmpegLinux.sha256, '9eac5b2b5076db5ff853a6fa0dcd6b8de7d0cac8481eadda6c47cd935825f1ee');
  assert.equal(BUILD_DOWNLOADS.ffmpegSource.url, 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz');
  assert.equal(BUILD_DOWNLOADS.ffmpegSource.archiveFileName, 'ffmpeg-8.1.2.tar.xz');
  assert.equal(BUILD_DOWNLOADS.ffmpegSource.sha256, '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c');
  assert.equal(BUILD_DOWNLOADS.pipWheel.url, 'https://files.pythonhosted.org/packages/07/25/ee8c38ae72d66b844ce8eb9711ba905dba21ca1a8a0c960057c41cd23337/pip-26.3-py3-none-any.whl');
  assert.equal(BUILD_DOWNLOADS.pipWheel.sha256, 'f3b60b20ffaadd4415ed7957212a38ac63fa4c5fa375bd0f4a797777940fad13');
});


test('BUILD_DOWNLOADS does not pin speakrs or ort compile-time downloads', () => {
  const keys = Object.keys(BUILD_DOWNLOADS);
  assert.equal(keys.some((key) => /speakrs|ort|onnx/i.test(key)), false);
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'build', 'download-manifest.js'), 'utf8');
  assert.equal(/speakrs/i.test(source), false);
  assert.equal(/onnxruntime/i.test(source), false);
  assert.equal(/cdn\.pyke\.io/i.test(source), false);
});


test('getBuildDownload returns manifest entries and rejects unknown keys', () => {
  assert.equal(getBuildDownload('pythonWin').label, 'Windows standalone Python 3.11.18+20261124');
  assert.equal(getBuildDownload('pythonMac').label, 'macOS standalone Python 3.11.18+20261124');
  assert.equal(getBuildDownload('pythonLinux').label, 'Linux standalone Python 3.11.18+20261124');
  assert.throws(() => getBuildDownload('missing'), /Unknown build download/);
});


test('hashFile returns the expected SHA-256', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-download-manifest-'));
  const tempFile = path.join(tempDir, 'demo.txt');
  fs.writeFileSync(tempFile, 'meeting-transcriber\n', 'utf8');

  await assert.doesNotReject(async () => {
    const hash = await hashFile(tempFile);
    assert.equal(hash, 'de70587023e997d0c23d41800a65867bd246f7a79c6c21748a9d031dd0111f74');
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
});


test('verifyFileChecksum accepts matching files and rejects mismatches', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-download-verify-'));
  const tempFile = path.join(tempDir, 'payload.txt');
  fs.writeFileSync(tempFile, 'checksum target\n', 'utf8');

  const matching = {
    label: 'payload',
    sha256: 'a0700a1b17cb3f2328437cbc70a3ac543fab2c1e7d1d8014862d801e1eb11162',
  };

  await assert.doesNotReject(async () => {
    const result = await verifyFileChecksum(tempFile, matching);
    assert.equal(result, matching.sha256);
  });

  await assert.rejects(
    verifyFileChecksum(tempFile, { label: 'payload', sha256: 'deadbeef' }),
    /Checksum mismatch for payload/
  );

  fs.rmSync(tempDir, { recursive: true, force: true });
});
