const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../../package.json');
const ROOT = path.join(__dirname, '..', '..');
const RELEASE_WORKFLOW = fs.readFileSync(
  path.join(ROOT, '.github', 'workflows', 'build-release.yml'),
  'utf8',
);

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
  checkForUpdates,
  findInstallerAsset,
  isNewerVersion,
  parseOsRelease,
  resolveLinuxInstallerOrder,
} = loadUpdaterWithShell();


test('isNewerVersion compares semantic versions and SemVer prereleases correctly', () => {
  assert.equal(isNewerVersion('1.8.0', '1.7.18'), true);
  assert.equal(isNewerVersion('1.7.18', '1.7.18'), false);
  assert.equal(isNewerVersion('1.7.17', '1.7.18'), false);

  assert.equal(isNewerVersion('3.0.0', '3.0.0-rc.1'), true);
  assert.equal(isNewerVersion('3.0.0-rc.1', '3.0.0'), false);
  assert.equal(isNewerVersion('3.0.0-rc.2', '3.0.0-rc.1'), true);
  assert.equal(isNewerVersion('3.0.0-rc.10', '3.0.0-rc.2'), true);
  assert.equal(isNewerVersion('3.0.0-rc.1', '3.0.0-beta.9'), true);
  assert.equal(isNewerVersion('3.0.0-rc.1.1', '3.0.0-rc.1'), true);
  assert.equal(isNewerVersion('3.0.0-alpha.beta', '3.0.0-alpha.1'), true);
  assert.equal(isNewerVersion('3.0.0-rc.1', '3.0.0-rc.1'), false);
  assert.equal(isNewerVersion('3.0.0-', '3.0.0-rc.1'), false);
});

test('checkForUpdates rethrows HTTP errors when throwOnError=true and stays silent by default', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const originalGet = https.get;

  https.get = (_url, _options, callback) => {
    const req = new EventEmitter();
    process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = 503;
      res.setEncoding = () => {};
      callback(res);
      res.emit('data', 'Service Unavailable');
      res.emit('end');
    });
    return req;
  };

  try {
    const silentResult = await checkForUpdates();
    assert.equal(silentResult, null);

    await assert.rejects(
      () => checkForUpdates({ throwOnError: true }),
      /GitHub API returned 503/,
    );
  } finally {
    https.get = originalGet;
  }
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
  assert.throws(
    () => openDownloadPage('https://github.com.evil.tld/AmirArshad/meeting-transcriber/releases'),
    /Refusing to open untrusted update URL/,
  );
  assert.throws(
    () => openDownloadPage('https://github.com/AmirArshad/meeting-transcriber/..'),
    /Refusing to open untrusted update URL/,
  );
  assert.throws(
    () => openDownloadPage('https://github.com/AmirArshad/meeting-transcriber/..%2fevil/repo'),
    /Refusing to open untrusted update URL/,
  );
  assert.throws(
    () => openDownloadPage('https://github.com/AmirArshad/meeting-transcriber/%2e%2e%2fevil/repo'),
    /Refusing to open untrusted update URL/,
  );
  assert.throws(
    () => openDownloadPage('https://evil:pass@github.com/AmirArshad/meeting-transcriber/releases'),
    /Refusing to open untrusted update URL/,
  );
  assert.throws(
    () => openDownloadPage('https://github.com:8443/AmirArshad/meeting-transcriber/releases'),
    /Refusing to open untrusted update URL/,
  );
  assert.throws(
    () => openDownloadPage('https://huggingface.co/settings/tokens'),
    /Refusing to open untrusted update URL/,
  );
  assert.throws(
    () => openDownloadPage('x-apple.systempreferences:com.apple.preference.security?Privacy'),
    /Refusing to open untrusted update URL/,
  );
  assert.deepEqual(openedUrls, []);
});


test('package.json configures electron-updater, GitHub publish, macOS zip+dmg, and differential NSIS', () => {
  assert.ok(packageJson.dependencies['electron-updater']);
  assert.deepEqual(packageJson.build.publish, [
    {
      provider: 'github',
      owner: 'AmirArshad',
      repo: 'meeting-transcriber',
      releaseType: 'release',
    },
  ]);

  const macTargets = packageJson.build.mac.target;
  assert.ok(Array.isArray(macTargets));
  assert.ok(
    macTargets.some((t) => t.target === 'dmg' && Array.isArray(t.arch) && t.arch.includes('arm64')),
    'build.mac.target must include dmg for arm64',
  );
  assert.ok(
    macTargets.some((t) => t.target === 'zip' && Array.isArray(t.arch) && t.arch.includes('arm64')),
    'build.mac.target must include zip for arm64',
  );

  assert.equal(packageJson.build.nsis.differentialPackage, true);
  assert.equal(packageJson.build.artifactName, '${productName}-Setup-${version}.${ext}');
});


test('build-release workflow uploads and publishes differential updater metadata alongside all 5 installers', () => {
  const expectedUploadPaths = [
    'dist/AvaNevis-Setup-*.exe',
    'dist/AvaNevis-Setup-*.exe.blockmap',
    'dist/latest.yml',
    'dist/AvaNevis-Setup-*.dmg',
    'dist/AvaNevis-Setup-*.dmg.blockmap',
    'dist/AvaNevis-Setup-*.zip',
    'dist/AvaNevis-Setup-*.zip.blockmap',
    'dist/latest-mac.yml',
    'dist/AvaNevis-Setup-*.AppImage',
    'dist/AvaNevis-Setup-*.pkg.tar.zst',
    'dist/AvaNevis-Setup-*.deb',
    'dist/latest-linux.yml',
  ];
  for (const uploadPath of expectedUploadPaths) {
    assert.ok(
      RELEASE_WORKFLOW.includes(uploadPath),
      `build-release.yml must upload ${uploadPath}`,
    );
  }

  const collectSectionStart = RELEASE_WORKFLOW.indexOf('name: Collect release assets');
  const notesSectionStart = RELEASE_WORKFLOW.indexOf('name: Build release notes');
  assert.ok(collectSectionStart !== -1 && notesSectionStart > collectSectionStart);
  const collectSection = RELEASE_WORKFLOW.slice(collectSectionStart, notesSectionStart);

  const expectedStagedAssets = [
    '${installer}.exe',
    '${installer}.exe.blockmap',
    'latest.yml',
    '${installer}.dmg',
    '${installer}.dmg.blockmap',
    '${installer}.zip',
    '${installer}.zip.blockmap',
    'latest-mac.yml',
    '${installer}.AppImage',
    '${installer}.pkg.tar.zst',
    '${installer}.deb',
    'latest-linux.yml',
  ];
  for (const stagedAsset of expectedStagedAssets) {
    assert.ok(
      collectSection.includes(stagedAsset),
      `publish-release Collect release assets must stage ${stagedAsset}`,
    );
  }

  assert.ok(RELEASE_WORKFLOW.includes('release-upload/*'));
});


test('legacy v2.x findInstallerAsset ignores zip, blockmap, and latest*.yml metadata files', () => {
  const releaseAssets = [
    { name: 'latest.yml' },
    { name: 'latest-mac.yml' },
    { name: 'latest-linux.yml' },
    { name: 'AvaNevis-Setup-3.0.0.exe.blockmap' },
    { name: 'AvaNevis-Setup-3.0.0.dmg.blockmap' },
    { name: 'AvaNevis-Setup-3.0.0.zip' },
    { name: 'AvaNevis-Setup-3.0.0.zip.blockmap' },
    { name: 'AvaNevis-Setup-3.0.0.exe' },
    { name: 'AvaNevis-Setup-3.0.0.dmg' },
    { name: 'AvaNevis-Setup-3.0.0.AppImage' },
    { name: 'AvaNevis-Setup-3.0.0.pkg.tar.zst' },
    { name: 'AvaNevis-Setup-3.0.0.deb' },
  ];

  assert.deepEqual(
    findInstallerAsset(releaseAssets, { platform: 'win32' }),
    { name: 'AvaNevis-Setup-3.0.0.exe' },
  );
  assert.deepEqual(
    findInstallerAsset(releaseAssets, { platform: 'darwin' }),
    { name: 'AvaNevis-Setup-3.0.0.dmg' },
  );
  assert.deepEqual(
    findInstallerAsset(releaseAssets, {
      platform: 'linux',
      env: { APPIMAGE: '/tmp/.mount_AvaNevis' },
      osReleaseText: 'ID=ubuntu\n',
    }),
    { name: 'AvaNevis-Setup-3.0.0.AppImage' },
  );
  assert.deepEqual(
    findInstallerAsset(releaseAssets, {
      platform: 'linux',
      env: {},
      osReleaseText: 'ID=arch\n',
    }),
    { name: 'AvaNevis-Setup-3.0.0.pkg.tar.zst' },
  );
  assert.deepEqual(
    findInstallerAsset(releaseAssets, {
      platform: 'linux',
      env: {},
      osReleaseText: 'ID=ubuntu\n',
    }),
    { name: 'AvaNevis-Setup-3.0.0.deb' },
  );
});

test('refreshMacDmgUpdateMetadata and verifyMacUpdateMetadata / assertLinuxUpdateMetadata keep post-sign blockmap and latest*.yml in sync', async () => {
  const crypto = require('node:crypto');
  const os = require('node:os');
  const yaml = require('js-yaml');
  const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
  const {
    refreshMacDmgUpdateMetadata,
    verifyMacUpdateMetadata,
  } = require('../../scripts/check-mac-signing-identity');
  const {
    assertLinuxUpdateMetadata,
  } = require('../../scripts/verify-linux-packaging');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-updater-meta-'));
  try {
    const version = '3.0.0';
    const zipName = `AvaNevis-Setup-${version}.zip`;
    const dmgName = `AvaNevis-Setup-${version}.dmg`;
    const appImageName = `AvaNevis-Setup-${version}.AppImage`;
    const zipPath = path.join(tmpDir, zipName);
    const dmgPath = path.join(tmpDir, dmgName);
    const appImagePath = path.join(tmpDir, appImageName);
    const latestMacYmlPath = path.join(tmpDir, 'latest-mac.yml');
    const latestLinuxYmlPath = path.join(tmpDir, 'latest-linux.yml');

    fs.writeFileSync(zipPath, crypto.randomBytes(40 * 1024));
    fs.writeFileSync(dmgPath, crypto.randomBytes(48 * 1024));
    fs.writeFileSync(appImagePath, crypto.randomBytes(36 * 1024));

    const zipInfo = await buildBlockMap(zipPath, 'gzip', `${zipPath}.blockmap`);
    const preNotarizedDmgInfo = await buildBlockMap(dmgPath, 'gzip', `${dmgPath}.blockmap`);
    const appImageSha512 = crypto.createHash('sha512').update(fs.readFileSync(appImagePath)).digest('base64');
    const appImageSize = fs.statSync(appImagePath).size;

    fs.writeFileSync(
      latestMacYmlPath,
      yaml.dump({
        version,
        files: [
          { url: zipName, sha512: zipInfo.sha512, size: zipInfo.size },
          { url: dmgName, sha512: preNotarizedDmgInfo.sha512, size: preNotarizedDmgInfo.size },
        ],
        path: zipName,
        sha512: zipInfo.sha512,
        releaseDate: '2026-11-20T00:00:00.000Z',
      }),
      'utf8',
    );

    assert.equal(verifyMacUpdateMetadata({ distDir: tmpDir, version }), true);

    // Simulate post-build DMG codesign + notarization stapling mutating the DMG file.
    fs.appendFileSync(dmgPath, Buffer.from('stapled-notarization-ticket-bytes'));
    assert.throws(
      () => verifyMacUpdateMetadata({ distDir: tmpDir, version }),
      /sha512 mismatch/,
    );

    const refreshed = await refreshMacDmgUpdateMetadata({ dmgPath, latestMacYmlPath });
    assert.equal(refreshed.updatedYml, true);
    assert.equal(verifyMacUpdateMetadata({ distDir: tmpDir, version }), true);

    // Verify Linux latest-linux.yml check passes when valid and rejects tampered hash.
    fs.writeFileSync(
      latestLinuxYmlPath,
      yaml.dump({
        version,
        files: [
          { url: appImageName, sha512: appImageSha512, size: appImageSize },
        ],
        path: appImageName,
        sha512: appImageSha512,
        releaseDate: '2026-11-20T00:00:00.000Z',
      }),
      'utf8',
    );
    assert.equal(assertLinuxUpdateMetadata(tmpDir, appImagePath), latestLinuxYmlPath);

    fs.appendFileSync(appImagePath, Buffer.from('tampered'));
    assert.throws(
      () => assertLinuxUpdateMetadata(tmpDir, appImagePath),
      /sha512 mismatch/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
