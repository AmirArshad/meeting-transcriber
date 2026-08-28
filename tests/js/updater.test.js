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

const {
  findInstallerAsset,
  isNewerVersion,
  parseOsRelease,
  resolveLinuxInstallerOrder,
} = loadUpdaterWithShell();


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
      { name: 'AvaNevis-Setup-1.7.18.AppImage' },
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
      { name: 'AvaNevis-Setup-1.7.18.AppImage' },
    ]);

    assert.deepEqual(asset, { name: 'AvaNevis-Setup-1.7.18.dmg' });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});


test('running AppImages stay on the AppImage update channel', () => {
  assert.deepEqual(findInstallerAsset([
      { name: 'AvaNevis-Setup-2.7.0.pkg.tar.zst' },
      { name: 'AvaNevis-Setup-2.7.0.deb' },
      { name: 'AvaNevis-Setup-2.7.0.AppImage' },
      { name: 'source.tar.gz' },
    ], {
      platform: 'linux',
      env: { APPIMAGE: '/tmp/.mount_AvaNevis' },
      osReleaseText: 'ID=ubuntu\n',
    }), { name: 'AvaNevis-Setup-2.7.0.AppImage' });
});

test('Debian-family installs prefer deb while Arch-family installs prefer pacman', () => {
  const assets = [
      { name: 'AvaNevis-Setup-2.7.0.pkg.tar.zst' },
    { name: 'AvaNevis-Setup-2.7.0.AppImage' },
    { name: 'AvaNevis-Setup-2.7.0.deb' },
  ];
  for (const id of ['ubuntu', 'debian', 'pop', 'linuxmint']) {
    assert.deepEqual(
      findInstallerAsset(assets, { platform: 'linux', env: {}, osReleaseText: `ID=${id}\n` }),
      { name: 'AvaNevis-Setup-2.7.0.deb' },
      id,
    );
  }
  assert.deepEqual(
    findInstallerAsset(assets, {
      platform: 'linux',
      env: {},
      osReleaseText: 'ID=elementary\nID_LIKE="ubuntu debian"\n',
    }),
    { name: 'AvaNevis-Setup-2.7.0.deb' },
  );
  for (const id of ['arch', 'cachyos', 'omarchy']) {
    assert.deepEqual(
      findInstallerAsset(assets, { platform: 'linux', env: {}, osReleaseText: `ID=${id}\n` }),
      { name: 'AvaNevis-Setup-2.7.0.pkg.tar.zst' },
      id,
    );
  }
});

test('Fedora, SteamOS, and unknown Linux installs prefer AppImage', () => {
  const assets = [
    { name: 'AvaNevis-Setup-2.7.0.pkg.tar.zst' },
    { name: 'AvaNevis-Setup-2.7.0.deb' },
    { name: 'AvaNevis-Setup-2.7.0.AppImage' },
  ];
  for (const osReleaseText of ['ID=fedora\n', 'ID=steamos\nID_LIKE=arch\n', 'ID=mystery\n', '']) {
    assert.deepEqual(
      findInstallerAsset(assets, { platform: 'linux', env: {}, osReleaseText }),
      { name: 'AvaNevis-Setup-2.7.0.AppImage' },
      osReleaseText || '(missing os-release)',
    );
  }
});

test('Linux installer resolution parses os-release safely and preserves useful fallbacks', () => {
  assert.deepEqual(parseOsRelease('ID="ubuntu"\nID_LIKE="debian"\nNAME="Ubuntu Linux"\n'), {
    ID: 'ubuntu',
    ID_LIKE: 'debian',
    NAME: 'Ubuntu Linux',
  });
  assert.deepEqual(
    resolveLinuxInstallerOrder({ env: {}, osReleaseText: 'ID=ubuntu\n' }),
    ['.deb', '.AppImage'],
  );
  assert.deepEqual(
    resolveLinuxInstallerOrder({ env: {}, osReleaseText: 'ID=arch\n' }),
    ['.pkg.tar.zst', '.AppImage'],
  );
  assert.deepEqual(
    resolveLinuxInstallerOrder({ env: {}, osReleaseText: 'ID=steamos\nID_LIKE=arch\n' }),
    ['.AppImage'],
  );
});

test('findInstallerAsset ignores source archives and unprefixed Linux installers', () => {
    assert.equal(findInstallerAsset([
      { name: 'source.tar.gz' },
      { name: 'AvaNevis-Setup-2.7.0.tar.gz' },
      { name: 'AvaNevis-2.7.0.deb' },
      { name: 'AvaNevis-2.7.0.AppImage' },
      { name: 'meeting-transcriber-2.7.0.AppImage' },
    ], { platform: 'linux', env: {}, osReleaseText: 'ID=ubuntu\n' }), null);
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
