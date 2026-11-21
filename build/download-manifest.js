const crypto = require('crypto');
const fs = require('fs');

const BUILD_DOWNLOADS = Object.freeze({
  pythonWin: Object.freeze({
    label: 'Windows standalone Python 3.11.18+20261110',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.11.18+20261110-x86_64-pc-windows-msvc-install_only.tar.gz',
    sha256: '5ca7e23bbcc8933a75f4ae9c3a5e5d1ffae5fd143aec9a9d77cf5124cc6e0eef',
  }),
  pythonMac: Object.freeze({
    label: 'macOS standalone Python 3.11.18+20261110',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.11.18+20261110-aarch64-apple-darwin-install_only.tar.gz',
    sha256: '73f1ed14486aa278d331e95f7d6d452f5cfb69d90b418e26e62fd4846d53557d',
  }),
  pythonLinux: Object.freeze({
    label: 'Linux standalone Python 3.11.18+20261110',
    url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.11.18+20261110-x86_64-unknown-linux-gnu-install_only.tar.gz',
    sha256: 'ac0b758b6ae4ba1cb87f7091eb6bb17c9a383a9bcdb5c18493cdd4f34e35ae8c',
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
    label: 'pip 26.3 wheel',
    url: 'https://files.pythonhosted.org/packages/07/25/ee8c38ae72d66b844ce8eb9711ba905dba21ca1a8a0c960057c41cd23337/pip-26.3-py3-none-any.whl',
    sha256: 'f3b60b20ffaadd4415ed7957212a38ac63fa4c5fa375bd0f4a797777940fad13',
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
