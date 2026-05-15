const test = require('node:test');
const assert = require('node:assert/strict');

const electronModulePath = require.resolve('electron');
const updaterModulePath = require.resolve('../../src/updater');

function loadUpdaterWithShell(openExternal = () => Promise.resolve()) {
  const originalElectronModule = require.cache[electronModulePath];
  delete require.cache[updaterModulePath];

  require.cache[electronModulePath] = {
    id: electronModulePath,
    filename: electronModulePath,
    loaded: true,
    exports: {
      app: { getVersion: () => '1.8.0' },
      shell: { openExternal },
    },
  };

  try {
    return require(updaterModulePath);
  } finally {
    if (originalElectronModule) {
      require.cache[electronModulePath] = originalElectronModule;
    } else {
      delete require.cache[electronModulePath];
    }
  }
}

const { findInstallerAsset, isNewerVersion } = loadUpdaterWithShell();


test('isNewerVersion compares semantic versions correctly', () => {
  assert.equal(isNewerVersion('1.8.0', '1.7.18'), true);
  assert.equal(isNewerVersion('1.7.18', '1.7.18'), false);
  assert.equal(isNewerVersion('1.7.17', '1.7.18'), false);
});


test('findInstallerAsset matches the actual Windows installer naming convention', () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });

  try {
    const asset = findInstallerAsset([
      { name: 'AvaNevis-Setup-1.7.18.exe' },
      { name: 'avanevis-portable.exe' },
    ]);

    assert.deepEqual(asset, { name: 'AvaNevis-Setup-1.7.18.exe' });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});


test('findInstallerAsset matches the actual macOS installer naming convention', () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });

  try {
    const asset = findInstallerAsset([
      { name: 'AvaNevis-Setup-1.7.18.dmg' },
      { name: 'AvaNevis-1.7.18.dmg' },
    ]);

    assert.deepEqual(asset, { name: 'AvaNevis-Setup-1.7.18.dmg' });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});


test('openDownloadPage opens trusted GitHub release URLs', async () => {
  const openedUrls = [];
  const { openDownloadPage } = loadUpdaterWithShell((url) => {
    openedUrls.push(url);
    return Promise.resolve();
  });

  await openDownloadPage('https://github.com/AmirArshad/meeting-transcriber/releases/download/v1.8.0/AvaNevis-Setup-1.8.0.exe');

  assert.deepEqual(openedUrls, [
    'https://github.com/AmirArshad/meeting-transcriber/releases/download/v1.8.0/AvaNevis-Setup-1.8.0.exe',
  ]);
});


test('openDownloadPage rejects untrusted update URLs', () => {
  const openedUrls = [];
  const { openDownloadPage } = loadUpdaterWithShell((url) => {
    openedUrls.push(url);
    return Promise.resolve();
  });

  assert.throws(
    () => openDownloadPage('http://github.com/AmirArshad/meeting-transcriber/releases'),
    /Refusing to open untrusted update URL/,
  );
  assert.throws(
    () => openDownloadPage('https://example.com/AvaNevis-Setup-1.8.0.exe'),
    /Refusing to open untrusted update URL/,
  );
  assert.throws(
    () => openDownloadPage('javascript:alert(1)'),
    /Refusing to open untrusted update URL/,
  );
  assert.deepEqual(openedUrls, []);
});
