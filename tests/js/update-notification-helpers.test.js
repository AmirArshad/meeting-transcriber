const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUpdateNotificationView,
  hideUpdateNotificationBanner,
  isTrustedUpdateDownloadUrl,
  replayPendingUpdateNotification,
  showUpdateNotificationBanner,
} = require('../../src/renderer/update-notification-helpers');

const UPDATE_DOWNLOAD_BASE = 'https://github.com/AmirArshad/meeting-transcriber/releases/download';

function avanevisInstallerUrl(version) {
  return `${UPDATE_DOWNLOAD_BASE}/v${version}/AvaNevis-Setup-${version}.exe`;
}

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
    updateInfo: { version: '1.7.19', downloadUrl: avanevisInstallerUrl('1.7.19') },
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
    updateInfo: { version: '1.7.20', downloadUrl: avanevisInstallerUrl('1.7.20') },
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
  const updateInfo = { version: '1.7.21', downloadUrl: avanevisInstallerUrl('1.7.21') };

  const result = await replayPendingUpdateNotification({
    getPendingUpdateInfo: async () => updateInfo,
    showUpdateNotification: (info) => shown.push(info),
  });

  assert.deepEqual(result, updateInfo);
  assert.deepEqual(shown, [updateInfo]);
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


test('replayPendingUpdateNotification ignores pending updates without trusted downloadUrl', async () => {
  const shown = [];

  const httpResult = await replayPendingUpdateNotification({
    getPendingUpdateInfo: async () => ({ version: '1.7.22', downloadUrl: 'http://example.com/installer.exe' }),
    showUpdateNotification: (updateInfo) => shown.push(updateInfo),
  });
  assert.equal(httpResult, null);

  const httpsResult = await replayPendingUpdateNotification({
    getPendingUpdateInfo: async () => ({ version: '1.7.22', downloadUrl: 'https://example.com/AvaNevis-Setup-1.7.22.exe' }),
    showUpdateNotification: (updateInfo) => shown.push(updateInfo),
  });
  assert.equal(httpsResult, null);
  assert.deepEqual(shown, []);
});


test('isTrustedUpdateDownloadUrl accepts only trusted GitHub repo release links', () => {
  assert.equal(isTrustedUpdateDownloadUrl(avanevisInstallerUrl('1.7.21')), true);
  assert.equal(
    isTrustedUpdateDownloadUrl('https://github.com/AmirArshad/meeting-transcriber/releases/latest'),
    true,
  );
  assert.equal(isTrustedUpdateDownloadUrl('http://example.com/installer.exe'), false);
  assert.equal(isTrustedUpdateDownloadUrl('https://example.com/AvaNevis-Setup-1.7.21.exe'), false);
  assert.equal(isTrustedUpdateDownloadUrl('https://github.com/electron/electron/releases/latest'), false);
  assert.equal(isTrustedUpdateDownloadUrl('https://github.com/AmirArshad/meeting-transcriber-malicious/releases/latest'), false);
  assert.equal(isTrustedUpdateDownloadUrl('mailto:updates@example.com'), false);
  assert.equal(isTrustedUpdateDownloadUrl('/local/installer.exe'), false);
});
