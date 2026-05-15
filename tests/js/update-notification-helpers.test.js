const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUpdateNotificationView,
  hideUpdateNotificationBanner,
  replayPendingUpdateNotification,
  showUpdateNotificationBanner,
} = require('../../src/renderer/update-notification-helpers');

const UPDATE_DOWNLOAD_BASE = 'https://github.com/AmirArshad/meeting-transcriber/releases/download';

function createBannerElements() {
  return {
    banner: { style: { display: 'none' } },
    title: { textContent: '' },
    description: { textContent: '' },
    downloadBtn: { onclick: null },
    dismissBtn: { onclick: null },
  };
}

test('buildUpdateNotificationView formats banner copy from update info', () => {
  assert.deepEqual(buildUpdateNotificationView({ version: '1.7.19' }), {
    title: 'Update Available: v1.7.19',
    description: 'A new version of AvaNevis is ready to download.',
    logMessage: '✨ Update available: v1.7.19',
  });
});

test('showUpdateNotificationBanner handles repeated update events in one session', () => {
  const elements = createBannerElements();
  const logs = [];
  const firstDownload = () => {};
  const firstDismiss = () => {};
  const secondDownload = () => {};
  const secondDismiss = () => {};

  const startupUpdate = showUpdateNotificationBanner({
    ...elements,
    updateInfo: { version: '1.7.19', downloadUrl: `${UPDATE_DOWNLOAD_BASE}/v1.7.19/Meeting%20Transcriber-Setup-1.7.19.exe` },
    onDownload: firstDownload,
    onDismiss: firstDismiss,
    addLog: (message) => logs.push(message),
  });

  assert.equal(startupUpdate.version, '1.7.19');
  assert.equal(elements.banner.style.display, 'block');
  assert.equal(elements.title.textContent, 'Update Available: v1.7.19');
  assert.equal(elements.downloadBtn.onclick, firstDownload);
  assert.equal(elements.dismissBtn.onclick, firstDismiss);

  hideUpdateNotificationBanner({
    banner: elements.banner,
    addLog: (message) => logs.push(message),
  });

  assert.equal(elements.banner.style.display, 'none');

  const manualCheckUpdate = showUpdateNotificationBanner({
    ...elements,
    updateInfo: { version: '1.7.20', downloadUrl: `${UPDATE_DOWNLOAD_BASE}/v1.7.20/Meeting%20Transcriber-Setup-1.7.20.exe` },
    onDownload: secondDownload,
    onDismiss: secondDismiss,
    addLog: (message) => logs.push(message),
  });

  assert.equal(manualCheckUpdate.version, '1.7.20');
  assert.equal(elements.banner.style.display, 'block');
  assert.equal(elements.title.textContent, 'Update Available: v1.7.20');
  assert.equal(elements.downloadBtn.onclick, secondDownload);
  assert.equal(elements.dismissBtn.onclick, secondDismiss);
  assert.deepEqual(logs, [
    '✨ Update available: v1.7.19',
    'Update reminder dismissed',
    '✨ Update available: v1.7.20',
  ]);
});


test('replayPendingUpdateNotification shows update emitted before renderer subscription', async () => {
  const shown = [];

  const result = await replayPendingUpdateNotification({
    getPendingUpdateInfo: async () => ({ version: '1.7.21', downloadUrl: `${UPDATE_DOWNLOAD_BASE}/v1.7.21/Meeting%20Transcriber-Setup-1.7.21.exe` }),
    showUpdateNotification: (updateInfo) => shown.push(updateInfo),
  });

  assert.deepEqual(result, { version: '1.7.21', downloadUrl: `${UPDATE_DOWNLOAD_BASE}/v1.7.21/Meeting%20Transcriber-Setup-1.7.21.exe` });
  assert.deepEqual(shown, [{ version: '1.7.21', downloadUrl: `${UPDATE_DOWNLOAD_BASE}/v1.7.21/Meeting%20Transcriber-Setup-1.7.21.exe` }]);
});


test('replayPendingUpdateNotification ignores empty pending update state', async () => {
  let shown = false;

  const result = await replayPendingUpdateNotification({
    getPendingUpdateInfo: async () => null,
    showUpdateNotification: () => {
      shown = true;
    },
  });

  assert.equal(result, null);
  assert.equal(shown, false);
});
