const crypto = require('crypto');
const fs = require('fs');

const BUILD_DOWNLOADS = Object.freeze({
  pythonWin: Object.freeze({
    label: 'Windows embedded Python 3.11.9',
    url: 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
    sha256: '009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b',
  }),
  pythonMac: Object.freeze({
    label: 'macOS standalone Python 3.11.7+20240107',
    url: 'https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.11.7+20240107-aarch64-apple-darwin-install_only.tar.gz',
    sha256: 'b042c966920cf8465385ca3522986b12d745151a72c060991088977ca36d3883',
  }),
  ffmpegWin: Object.freeze({
    label: 'Windows ffmpeg 8.0.1 essentials build',
    url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.0.1-essentials_build.zip',
    sha256: 'e2aaeaa0fdbc397d4794828086424d4aaa2102cef1fb6874f6ffd29c0b88b673',
  }),
  ffmpegMac: Object.freeze({
    label: 'macOS ffmpeg 8.0.1',
    url: 'https://evermeet.cx/ffmpeg/ffmpeg-8.0.1.zip',
    sha256: '470e482f6e290eac92984ac12b2d67bad425b1e5269fd75fb6a3536c16e824e4',
  }),
  getPip: Object.freeze({
    label: 'get-pip bootstrap script',
    url: 'https://bootstrap.pypa.io/pip/get-pip.py',
    sha256: 'feba1c697df45be1b539b40d93c102c9ee9dde1d966303323b830b06f3fbca3c',
  }),
});

function getBuildDownload(key) {
  const download = BUILD_DOWNLOADS[key];

  if (!download) {
    throw new Error(`Unknown build download: ${key}`);
  }

  return download;
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
  verifyFileChecksum,
};
