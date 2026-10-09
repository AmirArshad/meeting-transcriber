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
    'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.11.17+20261003-x86_64-unknown-linux-gnu-install_only.tar.gz',
  );
  assert.match(BUILD_DOWNLOADS.pythonLinux.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    BUILD_DOWNLOADS.ffmpegLinux.url,
    'https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.1.2-1/ffmpeg-linux-x64',
  );
  assert.equal(BUILD_DOWNLOADS.ffmpegLinux.requiredArch, 'x64');
  assert.equal(BUILD_DOWNLOADS.ffmpegLinux.sha256, '9eac5b2b5076db5ff853a6fa0dcd6b8de7d0cac8481eadda6c47cd935825f1ee');
  assert.equal(BUILD_DOWNLOADS.ffmpegSource.url, 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz');
  assert.equal(BUILD_DOWNLOADS.ffmpegSource.archiveFileName, 'ffmpeg-8.1.2.tar.xz');
  assert.equal(BUILD_DOWNLOADS.ffmpegSource.sha256, '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c');
  assert.equal(BUILD_DOWNLOADS.pipWheel.url, 'https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/pip-26.2.1-py3-none-any.whl');
  assert.equal(BUILD_DOWNLOADS.pipWheel.sha256, '71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e');
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
  assert.equal(getBuildDownload('pythonWin').label, 'Windows embedded Python 3.11.9');
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
