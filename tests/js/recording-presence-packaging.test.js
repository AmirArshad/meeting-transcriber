'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../../package.json');
const ROOT = path.join(__dirname, '..', '..');

test('recording presence resources preserve app identity', () => {
  assert.equal(pkg.build.productName, 'AvaNevis');
  assert.equal(pkg.build.appId, 'com.avanevis.app');
  // Start/Spotlight search labels may be descriptive; storage/installer identity stays AvaNevis.
  assert.equal(pkg.build.nsis.shortcutName, 'AvaNevis Meeting Recorder & Transcriber');
  assert.match(pkg.description, /meeting recorder.*transcriber/i);
  assert.match(
    pkg.build.mac.extendInfo.CFBundleDisplayName,
    /AvaNevis.*Meeting.*Recorder.*Transcriber/i,
  );
  assert.ok(pkg.build.extraResources.some((entry) => entry.to === 'recording-overlay.png'));
  for (const name of ['iconRecording.png', 'iconRecording@2x.png']) {
    assert.ok(pkg.build.extraResources.some((entry) => entry.to === name));
  }
  assert.equal(
    pkg.build.extraResources.some((entry) => String(entry.to || '').includes('Glow')),
    false,
  );
});

test('recording presence PNG assets exist and are non-empty', () => {
  for (const name of ['recording-overlay.png', 'iconRecording.png', 'iconRecording@2x.png']) {
    const filePath = path.join(ROOT, 'build', name);
    assert.ok(fs.existsSync(filePath), `missing ${name}`);
    const bytes = fs.readFileSync(filePath);
    assert.ok(bytes.length > 50, `${name} too small`);
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes.toString('ascii', 1, 4), 'PNG');
  }
  // Overlay must be HiDPI-friendly (not a 16x16 upscale source).
  const overlay = fs.readFileSync(path.join(ROOT, 'build', 'recording-overlay.png'));
  const overlayWidth = overlay.readUInt32BE(16);
  const overlayHeight = overlay.readUInt32BE(20);
  assert.ok(overlayWidth >= 32 && overlayHeight >= 32, `overlay too small: ${overlayWidth}x${overlayHeight}`);
});

test('main process pins a stable Windows toast activator CLSID', () => {
  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.match(mainSource, /AVANEVIS_TOAST_ACTIVATOR_CLSID\s*=\s*'\{[0-9A-Fa-f-]{36}\}'/);
  assert.match(mainSource, /setToastActivatorCLSID/);
  assert.match(mainSource, /setAppUserModelId\('com\.avanevis\.app'\)|AVANEVIS_APP_USER_MODEL_ID/);
  assert.match(mainSource, /requestSingleInstanceLock/);
});

test('installer artifactName stays aligned with updater INSTALLER_NAME_TOKEN', () => {
  assert.equal(pkg.build.productName, 'AvaNevis');
  assert.equal(pkg.build.artifactName, '${productName}-Setup-${version}.${ext}');

  const updaterSource = fs.readFileSync(path.join(ROOT, 'src', 'updater.js'), 'utf8');
  const tokenMatch = updaterSource.match(/INSTALLER_NAME_TOKEN\s*=\s*'([^']+)'/);
  assert.ok(tokenMatch, 'expected INSTALLER_NAME_TOKEN in src/updater.js');
  assert.equal(tokenMatch[1], 'AvaNevis-Setup-');
  assert.equal(`${pkg.build.productName}-Setup-`, tokenMatch[1]);
});

test('createWindow refreshes presence after window recreation', () => {
  const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

  // showMainWindow must recreate a destroyed BrowserWindow before show/focus.
  assert.match(
    mainSource,
    /function showMainWindow\(\) \{[\s\S]*?if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) \{\s*createWindow\(\);/,
  );

  // createWindow itself must re-apply overlay/Dock for an in-progress capture.
  assert.match(
    mainSource,
    /function createWindow\(\) \{[\s\S]*?recordingPresenceService\.refreshPresentation\(\);/,
  );
});

test('renderer init finally hydrates recording state after partial init failure', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

  assert.match(
    appSource,
    /const ensureRecordingHydration = async \(\) => \{[\s\S]*?await hydrateRecordingStateFromMain\(\);/,
  );
  assert.match(
    appSource,
    /async function init\(\) \{[\s\S]*?\} finally \{\s*(?:\/\/[^\n]*\n\s*)*isInitializing = false;\s*await ensureRecordingHydration\(\);\s*\}/,
  );
});
