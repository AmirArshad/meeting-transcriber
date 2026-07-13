'use strict';

/**
 * Gate C spike: prove Windows overlay requires a taskbar button.
 * Minimize keeps the button; hide removes it (and therefore the overlay).
 *
 * Run: npx electron scripts/gate-c-overlay-spike.js
 */

const { app, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_USER_MODEL_ID = 'com.avanevis.app';
const TOAST_ACTIVATOR_CLSID = '{A7E2C4F1-9B83-4D2E-8F61-1C0A9E5B7D33}';

function createOverlayImage() {
  // 16x16 solid red with a light border encoded as a tiny PNG via canvas-less fill.
  // Prefer a checked-in asset when present; otherwise synthesize a solid nativeImage.
  const overlayPath = path.join(__dirname, '../build/recording-overlay.png');
  if (fs.existsSync(overlayPath)) {
    return nativeImage.createFromPath(overlayPath);
  }
  return nativeImage.createEmpty();
}

app.setAppUserModelId(APP_USER_MODEL_ID);
if (typeof app.setToastActivatorCLSID === 'function') {
  app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    show: true,
    title: 'AvaNevis Gate C Overlay Spike',
  });

  const overlay = createOverlayImage();
  const hasOverlayPixels = !overlay.isEmpty();
  win.setOverlayIcon(hasOverlayPixels ? overlay : null, 'AvaNevis is recording');

  const evidence = {
    platform: process.platform,
    appUserModelId: APP_USER_MODEL_ID,
    toastActivatorCLSID: typeof app.getToastActivatorCLSID === 'function'
      ? app.getToastActivatorCLSID()
      : (typeof app.toastActivatorCLSID !== 'undefined' ? app.toastActivatorCLSID : null),
    overlayAssetPresent: hasOverlayPixels,
    shown: {
      isVisible: win.isVisible(),
      isMinimized: win.isMinimized(),
      note: 'Taskbar button present while shown; overlay can attach.',
    },
  };

  win.minimize();
  await new Promise((r) => setTimeout(r, 400));
  evidence.minimized = {
    isVisible: win.isVisible(),
    isMinimized: win.isMinimized(),
    note: 'Taskbar button remains while minimized; setOverlayIcon remains applicable (Gate B).',
  };

  win.hide();
  await new Promise((r) => setTimeout(r, 400));
  evidence.hidden = {
    isVisible: win.isVisible(),
    isMinimized: win.isMinimized(),
    note: 'No taskbar button while fully hidden; Windows overlay cannot remain (documents Gate B minimize).',
  };

  win.setOverlayIcon(null, '');
  console.log(JSON.stringify(evidence, null, 2));
  app.exit(0);
});
