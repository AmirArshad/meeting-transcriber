const test = require('node:test');
const assert = require('node:assert/strict');

const { findInstallerAsset, isNewerVersion } = require('../../src/updater');


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
      { name: 'Meeting Transcriber-Setup-1.7.18.exe' },
      { name: 'meeting-transcriber-portable.exe' },
    ]);

    assert.deepEqual(asset, { name: 'Meeting Transcriber-Setup-1.7.18.exe' });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});


test('findInstallerAsset matches the actual macOS installer naming convention', () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'darwin' });

  try {
    const asset = findInstallerAsset([
      { name: 'Meeting Transcriber-Setup-1.7.18.dmg' },
      { name: 'Meeting Transcriber-1.7.18.dmg' },
    ]);

    assert.deepEqual(asset, { name: 'Meeting Transcriber-Setup-1.7.18.dmg' });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
});
