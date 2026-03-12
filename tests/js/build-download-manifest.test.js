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
  assert.equal(BUILD_DOWNLOADS.ffmpegWin.url, 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.0.1-essentials_build.zip');
  assert.equal(BUILD_DOWNLOADS.ffmpegMac.url, 'https://evermeet.cx/ffmpeg/ffmpeg-8.0.1.zip');
  assert.equal(BUILD_DOWNLOADS.getPip.url, 'https://bootstrap.pypa.io/pip/get-pip.py');
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
