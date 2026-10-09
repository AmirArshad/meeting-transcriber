const crypto = require('crypto');
const fs = require('fs');

const BUILD_DOWNLOADS = Object.freeze({
  pythonWin: Object.freeze({
    label: 'Windows embedded Python 3.11.9',
    url: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
    sha256: '009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b',
  }),
  pythonMac: Object.freeze({
    label: 'macOS standalone Python 3.11.17+20261003',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.11.17+20261003-aarch64-apple-darwin-install_only.tar.gz',
    sha256: '3663b71c18364eccfbad74c4f21f9f6149e40b07329cd776287410cc1da5d612',
  }),
  pythonLinux: Object.freeze({
    label: 'Linux standalone Python 3.11.17+20261003',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.11.17+20261003-x86_64-unknown-linux-gnu-install_only.tar.gz',
    sha256: 'c624af93ad62a596806bbd2404e1fb80744a407ca7279854445ede16d93858b8',
  }),
  ffmpegWin: Object.freeze({
    label: 'Windows ffmpeg 8.1.2 essentials build',
    // gyan.dev/ffmpeg/builds/packages/ only hosts the current release zip.
    url: 'https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip',
    sha256: 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec',
  }),
  ffmpegMac: Object.freeze({
    label: 'macOS ffmpeg n8.1.2 arm64 static (shaka-project/static-ffmpeg-binaries)',
    url: 'https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.1.2-1/ffmpeg-osx-arm64',
    sha256: 'e7b9fcd97f95f333512d6e8b8ac24d9dbc08f189f36047695499bd7b57214b22',
    archiveFileName: 'ffmpeg-osx-arm64',
    requiredArch: 'arm64',
  }),
  ffmpegLinux: Object.freeze({
    label: 'Linux ffmpeg n8.1.2 x64 static (shaka-project/static-ffmpeg-binaries)',
    url: 'https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.1.2-1/ffmpeg-linux-x64',
    sha256: '9eac5b2b5076db5ff853a6fa0dcd6b8de7d0cac8481eadda6c47cd935825f1ee',
    archiveFileName: 'ffmpeg-linux-x64',
    requiredArch: 'x64',
  }),
  ffmpegSource: Object.freeze({
    label: 'FFmpeg 8.1.2 release source',
    url: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
    archiveFileName: 'ffmpeg-8.1.2.tar.xz',
    sha256: '464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c',
  }),
  pipWheel: Object.freeze({
    label: 'pip 26.2.1 wheel',
    url: 'https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/pip-26.2.1-py3-none-any.whl',
    sha256: '71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e',
  }),
});

function getBuildDownload(key) {
  const download = BUILD_DOWNLOADS[key];

  if (!download) {
    throw new Error(`Unknown build download: ${key}`);
  }

  return download;
}

function hashString(contents) {
  return crypto.createHash('sha256').update(String(contents)).digest('hex');
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifyFileChecksum(filePath, download) {
  const actualHash = await hashFile(filePath);
  const expectedHash = String(download.sha256 || '').toLowerCase();

  if (actualHash !== expectedHash) {
    throw new Error(
      `Checksum mismatch for ${download.label}. Expected ${expectedHash}, got ${actualHash}.`
    );
  }

  return actualHash;
}

module.exports = {
  BUILD_DOWNLOADS,
  getBuildDownload,
  hashFile,
  hashString,
  verifyFileChecksum,
};
