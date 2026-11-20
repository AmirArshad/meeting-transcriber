'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_RELEASES_URL,
  resolveUpdateMode,
  buildManualInstallCommand,
  normalizeReleaseNotes,
  sanitizeUpdaterError,
  createUpdaterService,
} = require('../../src/main/updater-service');

const EXPECTED_UPDATE_STATE_KEYS = [
  'autoDownload',
  'availableVersion',
  'currentVersion',
  'downloadUrl',
  'error',
  'installOnNextQuit',
  'installerName',
  'lastCheckedAt',
  'manualCheck',
  'manualInstallCommand',
  'manualPackageKind',
  'mode',
  'progress',
  'releaseDate',
  'releaseNotes',
  'releaseUrl',
  'seq',
  'status',
];

function createFakeAutoUpdater() {
  const emitter = new EventEmitter();
  emitter.autoDownload = true;
  emitter.autoInstallOnAppQuit = true;
  emitter.allowPrerelease = true;
  emitter.allowDowngrade = true;
  emitter.checkCalls = 0;
  emitter.downloadCalls = [];
  emitter.quitAndInstallCalls = [];

  emitter.checkForUpdates = async () => {
    emitter.checkCalls += 1;
    emitter.emit('checking-for-update');
    return null;
  };

  emitter.downloadUpdate = (token) => {
    emitter.downloadCalls.push(token);
    return new Promise((resolve, reject) => {
      emitter._resolveDownload = resolve;
      emitter._rejectDownload = reject;
    });
  };

  emitter.quitAndInstall = (isSilent, isForceRunAfter) => {
    emitter.quitAndInstallCalls.push({ isSilent, isForceRunAfter });
  };

  return emitter;
}

class FakeCancellationToken {
  constructor() {
    this.cancelled = false;
    this.cancelCount = 0;
  }

  cancel() {
    this.cancelled = true;
    this.cancelCount += 1;
  }
}

function makeTempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-updater-test-'));
}

test('resolveUpdateMode detects dev, win32, darwin, Linux AppImage, pacman, deb, and appimage', () => {
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: false, platform: 'win32' }),
    { mode: 'dev-unpackaged', manualPackageKind: null },
  );
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: true, platform: 'win32' }),
    { mode: 'in-app', manualPackageKind: null },
  );
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: true, platform: 'darwin' }),
    { mode: 'in-app', manualPackageKind: null },
  );
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '/tmp/AvaNevis.AppImage' } }),
    { mode: 'in-app', manualPackageKind: null },
  );
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '1' }, osReleaseText: 'ID=arch\n' }),
    { mode: 'manual-package', manualPackageKind: 'pacman' },
  );
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: true, platform: 'linux', env: { APPIMAGE: './AvaNevis.AppImage' }, osReleaseText: 'ID=ubuntu\n' }),
    { mode: 'manual-package', manualPackageKind: 'deb' },
  );
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: true, platform: 'linux', env: { APPIMAGE: '/tmp/AvaNevis.AppImage\0evil' }, osReleaseText: 'ID=steamos\n' }),
    { mode: 'manual-package', manualPackageKind: 'appimage' },
  );
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: true, platform: 'linux', env: {}, osReleaseText: 'ID=cachyos\nID_LIKE=arch\n' }),
    { mode: 'manual-package', manualPackageKind: 'pacman' },
  );
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: true, platform: 'linux', env: {}, osReleaseText: 'ID=ubuntu\nID_LIKE=debian\n' }),
    { mode: 'manual-package', manualPackageKind: 'deb' },
  );
  assert.deepEqual(
    resolveUpdateMode({ isPackaged: true, platform: 'linux', env: {}, osReleaseText: 'ID=steamos\nID_LIKE=arch\n' }),
    { mode: 'manual-package', manualPackageKind: 'appimage' },
  );
});

test('buildManualInstallCommand strictly validates installer filename and rejects injection', () => {
  assert.equal(
    buildManualInstallCommand('AvaNevis-Setup-3.1.0.pkg.tar.zst', 'pacman'),
    'sudo pacman -U ~/Downloads/AvaNevis-Setup-3.1.0.pkg.tar.zst',
  );
  assert.equal(
    buildManualInstallCommand('AvaNevis-Setup-3.1.0-rc.1.deb', 'deb'),
    'sudo apt install ~/Downloads/AvaNevis-Setup-3.1.0-rc.1.deb',
  );
  assert.equal(buildManualInstallCommand('AvaNevis-Setup-3.1.0.AppImage', 'appimage'), null);
  assert.equal(buildManualInstallCommand('AvaNevis-Setup-3.1.0.AppImage', 'pacman'), null);
  assert.equal(buildManualInstallCommand('AvaNevis-Setup-3.1.0.pkg.tar.zst; rm -rf /', 'pacman'), null);
  assert.equal(buildManualInstallCommand('../AvaNevis-Setup-3.1.0.deb', 'deb'), null);
  assert.equal(buildManualInstallCommand('evil.deb', 'deb'), null);
  assert.equal(buildManualInstallCommand(null, 'pacman'), null);
});

test('normalizeReleaseNotes handles strings, arrays, and empty inputs', () => {
  assert.equal(normalizeReleaseNotes(null), null);
  assert.equal(normalizeReleaseNotes('   '), null);
  assert.equal(normalizeReleaseNotes('  ## Highlights\n- Faster  '), '## Highlights\n- Faster');
  assert.equal(
    normalizeReleaseNotes([
      { version: '3.1.0', note: '- Added auto-updater' },
      { version: 'v3.0.1', note: '- Bug fix' },
    ]),
    '## v3.1.0\n\n- Added auto-updater\n\n## v3.0.1\n\n- Bug fix',
  );
});

test('preferences default to autoDownload=false, survive corrupt JSON, and persist atomically', async () => {
  const userDataPath = makeTempUserData();
  const prefsPath = path.join(userDataPath, 'updater-preferences.json');
  fs.writeFileSync(prefsPath, '{not valid json', 'utf8');

  const fakeUpdater = createFakeAutoUpdater();
  const service = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'win32',
    userDataPath,
    autoUpdater: fakeUpdater,
    CancellationToken: FakeCancellationToken,
  });

  const initial = service.getState();
  assert.deepEqual(Object.keys(initial).sort(), EXPECTED_UPDATE_STATE_KEYS);
  assert.equal(initial.autoDownload, false);
  assert.equal(fakeUpdater.autoDownload, false);
  assert.equal(fakeUpdater.autoInstallOnAppQuit, false);
  assert.equal(fakeUpdater.allowPrerelease, false);
  assert.equal(fakeUpdater.allowDowngrade, false);

  const res = await service.setAutoDownloadUpdates(true);
  assert.equal(res.ok, true);
  assert.equal(res.autoDownload, true);
  assert.equal(fakeUpdater.autoDownload, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(prefsPath, 'utf8')), { autoDownload: true });

  // No leftover .tmp files after atomic rename.
  const leftoverTmp = fs.readdirSync(userDataPath).filter((name) => name.includes('.tmp.'));
  assert.deepEqual(leftoverTmp, []);

  // Re-instantiating loads persisted preference.
  const fakeUpdater2 = createFakeAutoUpdater();
  const service2 = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'win32',
    userDataPath,
    autoUpdater: fakeUpdater2,
    CancellationToken: FakeCancellationToken,
  });
  assert.equal(service2.getState().autoDownload, true);
  assert.equal(fakeUpdater2.autoDownload, true);
  service.dispose();
  service2.dispose();
});

test('in-app lifecycle transitions, throttled progress, cancellation, and monotonic seq', async () => {
  const userDataPath = makeTempUserData();
  const fakeUpdater = createFakeAutoUpdater();
  const pushed = [];
  let clock = 1000;

  const service = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'darwin',
    userDataPath,
    autoUpdater: fakeUpdater,
    CancellationToken: FakeCancellationToken,
    sendToRenderer: (channel, payload) => pushed.push({ channel, payload }),
    now: () => clock,
  });

  await service.checkForUpdates({ manual: true });
  fakeUpdater.emit('update-available', {
    version: '3.1.0',
    releaseDate: '2026-11-20T00:00:00Z',
    releaseNotes: '## What is new\n- In-app updates',
  });

  assert.equal(service.getState().status, 'available');
  assert.equal(service.getState().availableVersion, '3.1.0');
  assert.equal(
    service.getState().releaseUrl,
    'https://github.com/AmirArshad/meeting-transcriber/releases/tag/v3.1.0',
  );

  // Start download
  const dlStart = await service.downloadUpdate();
  assert.equal(dlStart.ok, true);
  assert.equal(service.getState().status, 'downloading');
  assert.equal(service.getState().progress.percent, 0);
  assert.equal(fakeUpdater.downloadCalls.length, 1);

  // Progress throttling: 50ms later should be throttled, 200ms later should emit.
  const countBeforeProgress = pushed.length;
  clock += 50;
  fakeUpdater.emit('download-progress', { percent: 12, bytesPerSecond: 1000, transferred: 120, total: 1000 });
  assert.equal(pushed.length, countBeforeProgress);

  clock += 150;
  fakeUpdater.emit('download-progress', { percent: 45, bytesPerSecond: 2000, transferred: 450, total: 1000 });
  assert.equal(pushed.length, countBeforeProgress + 1);
  assert.equal(service.getState().progress.percent, 45);

  // Cancel download -> must return to 'available', NOT 'error'
  const cancelRes = await service.cancelUpdateDownload();
  assert.equal(cancelRes.ok, true);
  assert.equal(fakeUpdater.downloadCalls[0].cancelled, true);
  assert.equal(service.getState().status, 'available');
  assert.equal(service.getState().progress, null);
  assert.equal(service.getState().error, null);

  // Late rejection and error event from electron-updater after cancel must be ignored.
  fakeUpdater.emit('error', new Error('Cancelled'));
  fakeUpdater._rejectDownload(Object.assign(new Error('Cancelled'), { name: 'CancellationError' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getState().status, 'available');
  assert.equal(service.getState().error, null);

  // Re-download and complete -> ready-to-install
  await service.downloadUpdate();
  clock += 10;
  // 100% edge always emits even within throttle window
  fakeUpdater.emit('download-progress', { percent: 100, bytesPerSecond: 2000, transferred: 1000, total: 1000 });
  assert.equal(service.getState().progress.percent, 100);

  fakeUpdater.emit('update-downloaded', { version: '3.1.0' });
  assert.equal(service.getState().status, 'ready-to-install');

  // Verify monotonic seq across all pushed snapshots
  assert.ok(pushed.length > 0);
  assert.ok(pushed.every((entry) => entry.channel === 'update-state-changed'));
  for (let i = 1; i < pushed.length; i += 1) {
    assert.ok(pushed[i].payload.seq > pushed[i - 1].payload.seq);
  }

  service.dispose();
});

test('manual-package mode validates URLs, builds safe install command, and opens download page', async () => {
  const userDataPath = makeTempUserData();
  const openedUrls = [];

  const service = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'linux',
    env: {},
    osReleaseText: 'ID=arch\n',
    userDataPath,
    checkManualRelease: async () => ({
      version: '3.2.0',
      releaseUrl: 'https://github.com/AmirArshad/meeting-transcriber/releases/tag/v3.2.0',
      downloadUrl: 'https://evil.example.com/malware.pkg.tar.zst',
      releaseNotes: 'Linux release',
      releaseDate: '2026-11-20T00:00:00Z',
      installerName: 'AvaNevis-Setup-3.2.0.pkg.tar.zst',
    }),
    openDownloadPage: async (url) => {
      openedUrls.push(url);
    },
  });

  const checked = await service.checkForUpdates({ manual: true });
  assert.equal(checked.mode, 'manual-package');
  assert.equal(checked.manualPackageKind, 'pacman');
  assert.equal(checked.status, 'manual-required');
  assert.equal(checked.availableVersion, '3.2.0');
  // Untrusted downloadUrl must be rejected and fall back to verified releaseUrl.
  assert.equal(
    checked.downloadUrl,
    'https://github.com/AmirArshad/meeting-transcriber/releases/tag/v3.2.0',
  );
  assert.equal(
    checked.manualInstallCommand,
    'sudo pacman -U ~/Downloads/AvaNevis-Setup-3.2.0.pkg.tar.zst',
  );

  const dl = await service.downloadUpdate();
  assert.equal(dl.ok, true);
  assert.deepEqual(openedUrls, ['https://github.com/AmirArshad/meeting-transcriber/releases/tag/v3.2.0']);

  await service.openUpdateReleasePage();
  assert.equal(openedUrls.length, 2);
  assert.equal(openedUrls[1], 'https://github.com/AmirArshad/meeting-transcriber/releases/tag/v3.2.0');
  service.dispose();
});

test('installUpdateNow enforces recording, import, summary metadata, and AI confirmation safety gates', async () => {
  const userDataPath = makeTempUserData();
  const fakeUpdater = createFakeAutoUpdater();
  let recordingActive = false;
  let audioImportActive = false;
  let protectedSummaryWrite = false;
  let aiWorkActive = false;
  let drainedCount = 0;
  let armedCount = 0;

  const service = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'win32',
    userDataPath,
    autoUpdater: fakeUpdater,
    CancellationToken: FakeCancellationToken,
    getQuitInterceptState: () => ({ interceptQuit: recordingActive }),
    hasActiveAudioImport: () => audioImportActive,
    hasProtectedSummaryWrite: () => protectedSummaryWrite,
    hasInFlightAiWork: () => aiWorkActive,
    drainAiWorkBeforeQuit: async () => {
      drainedCount += 1;
    },
    armUpdateQuit: () => {
      armedCount += 1;
    },
  });

  // Not ready yet
  let res = await service.installUpdateNow();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPDATE_NOT_READY');

  // Move to ready-to-install
  fakeUpdater.emit('update-available', { version: '3.1.0' });
  fakeUpdater.emit('update-downloaded', { version: '3.1.0' });

  // Blocked by active recording
  recordingActive = true;
  res = await service.installUpdateNow();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPDATE_BLOCKED_RECORDING');
  recordingActive = false;

  // Blocked by active audio import
  audioImportActive = true;
  res = await service.installUpdateNow();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPDATE_BLOCKED_IMPORT_SAVE');
  audioImportActive = false;

  // Blocked by protected summary metadata write
  protectedSummaryWrite = true;
  res = await service.installUpdateNow();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPDATE_BLOCKED_SUMMARY_FINALIZING');
  protectedSummaryWrite = false;

  // Requires confirmation when AI work is in flight
  aiWorkActive = true;
  res = await service.installUpdateNow();
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPDATE_CONFIRM_AI_INTERRUPT');
  assert.equal(drainedCount, 0);
  assert.equal(armedCount, 0);

  // Confirmed AI interrupt drains, arms quit, and invokes quitAndInstall(false, true)
  res = await service.installUpdateNow({ confirmAiInterrupt: true });
  assert.equal(res.ok, true);
  assert.equal(drainedCount, 1);
  assert.equal(armedCount, 1);
  assert.deepEqual(fakeUpdater.quitAndInstallCalls, [{ isSilent: false, isForceRunAfter: true }]);
  service.dispose();
});

test('installUpdateNow aborts restart if recording starts while draining AI work', async () => {
  const userDataPath = makeTempUserData();
  const fakeUpdater = createFakeAutoUpdater();
  let recordingActive = false;
  let armedCount = 0;

  const service = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'win32',
    userDataPath,
    autoUpdater: fakeUpdater,
    CancellationToken: FakeCancellationToken,
    getQuitInterceptState: () => ({ interceptQuit: recordingActive }),
    hasInFlightAiWork: () => true,
    drainAiWorkBeforeQuit: async () => {
      // Simulate user starting a recording during drain
      recordingActive = true;
    },
    armUpdateQuit: () => {
      armedCount += 1;
    },
  });

  fakeUpdater.emit('update-available', { version: '3.1.0' });
  fakeUpdater.emit('update-downloaded', { version: '3.1.0' });

  const res = await service.installUpdateNow({ confirmAiInterrupt: true });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPDATE_BLOCKED_RECORDING');
  assert.equal(service.getState().status, 'ready-to-install');
  assert.equal(armedCount, 0);
  assert.equal(fakeUpdater.quitAndInstallCalls.length, 0);
  service.dispose();
});

test('registerIpcHandlers registers all 7 channels and enforces assertTrustedRendererSender', async () => {
  const userDataPath = makeTempUserData();
  const openedUrls = [];
  const service = createUpdaterService({
    app: { isPackaged: false, getVersion: () => '3.0.0' },
    userDataPath,
    checkManualRelease: async () => null,
    openDownloadPage: async (url) => openedUrls.push(url),
  });

  const handlers = {};
  const fakeIpcMain = {
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  };
  const assertTrusted = (event) => {
    if (!event || !event.trusted) {
      throw new Error('Untrusted IPC sender.');
    }
  };

  service.registerIpcHandlers(fakeIpcMain, assertTrusted);

  const channels = Object.keys(handlers).sort();
  assert.deepEqual(channels, [
    'cancel-update-download',
    'check-for-updates',
    'download-update',
    'get-update-state',
    'install-update-now',
    'open-update-release-page',
    'set-auto-download-updates',
  ]);

  // Every channel must reject untrusted senders
  for (const channel of channels) {
    await assert.rejects(
      () => handlers[channel]({ trusted: false }),
      /Untrusted IPC sender/,
    );
  }

  // Trusted calls succeed
  const state = await handlers['get-update-state']({ trusted: true });
  assert.equal(state.status, 'idle');

  const releaseRes = await handlers['open-update-release-page']({ trusted: true });
  assert.equal(releaseRes.ok, true);
  assert.deepEqual(openedUrls, [DEFAULT_RELEASES_URL]);
  service.dispose();
});

test('sanitizeUpdaterError classifies network, verification, disk, and redacts URLs', () => {
  assert.equal(sanitizeUpdaterError(new Error('getaddrinfo ENOTFOUND api.github.com')).code, 'UPDATE_NETWORK_ERROR');
  assert.equal(sanitizeUpdaterError(new Error('sha512 checksum mismatch')).code, 'UPDATE_VERIFICATION_FAILED');
  assert.equal(sanitizeUpdaterError(new Error('ENOSPC: no space left on device')).code, 'UPDATE_DISK_FULL');
  const redacted = sanitizeUpdaterError(new Error('Failed fetching https://secret.example/token=abc'));
  assert.equal(redacted.code, 'UPDATE_ERROR');
  assert.equal(redacted.message.includes('secret.example'), false);
});

test('initInAppUpdater enforces privacy contract by disabling .updaterId and stripping x-user-staging-id headers', async () => {
  const userDataPath = makeTempUserData();
  const legacyIdPath = path.join(userDataPath, '.updaterId');
  fs.writeFileSync(legacyIdPath, '11111111-2222-5333-8444-555555555555', 'utf8');

  const fakeUpdater = createFakeAutoUpdater();
  fakeUpdater.requestHeaders = {
    'x-user-staging-id': 'leaked-id',
    'X-Custom-Header': 'kept',
  };

  const service = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'win32',
    userDataPath,
    autoUpdater: fakeUpdater,
    CancellationToken: FakeCancellationToken,
  });

  assert.equal(fs.existsSync(legacyIdPath), false, 'legacy .updaterId file must be removed');
  assert.equal(fakeUpdater.disableWebInstaller, true);
  assert.equal(fakeUpdater.forceDevUpdateConfig, false);
  assert.equal(fakeUpdater.fullChangelog, false);
  assert.equal(fakeUpdater.isUserWithinRollout(), true);
  assert.equal(await fakeUpdater.getOrCreateStagingUserId(), null);
  assert.equal(await fakeUpdater.stagingUserIdPromise.value, null);

  const computedHeaders = fakeUpdater.computeFinalHeaders({
    'x-user-staging-id': 'staging-uuid',
    'X-User-Staging-Id': 'staging-uuid-2',
    Accept: 'application/json',
  });
  assert.deepEqual(computedHeaders, {
    Accept: 'application/json',
    'X-Custom-Header': 'kept',
  });

  service.dispose();
});

test('setAutoDownloadUpdates(true) starts download immediately when an update is already available', async () => {
  const userDataPath = makeTempUserData();
  const fakeUpdater = createFakeAutoUpdater();
  const service = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'win32',
    userDataPath,
    autoUpdater: fakeUpdater,
    CancellationToken: FakeCancellationToken,
  });

  fakeUpdater.emit('update-available', { version: '3.1.0' });
  assert.equal(service.getState().status, 'available');
  assert.equal(fakeUpdater.downloadCalls.length, 0);

  const res = await service.setAutoDownloadUpdates(true);
  assert.equal(res.ok, true);
  assert.equal(res.autoDownload, true);
  assert.equal(res.state.status, 'downloading');
  assert.equal(fakeUpdater.downloadCalls.length, 1);

  service.dispose();
});

test('cancel-then-redownload generation race and late error events never clobber active download or ready-to-install', async () => {
  const userDataPath = makeTempUserData();
  const fakeUpdater = createFakeAutoUpdater();
  const downloadRejectors = [];
  fakeUpdater.downloadUpdate = (token) => {
    fakeUpdater.downloadCalls.push(token);
    return new Promise((_resolve, reject) => {
      downloadRejectors.push(reject);
    });
  };

  const service = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'win32',
    userDataPath,
    autoUpdater: fakeUpdater,
    CancellationToken: FakeCancellationToken,
  });

  fakeUpdater.emit('update-available', { version: '3.1.0' });

  // Start Download #1, cancel it, then immediately start Download #2 before #1 rejects.
  await service.downloadUpdate();
  await service.cancelUpdateDownload();
  assert.equal(service.getState().status, 'available');

  await service.downloadUpdate();
  assert.equal(service.getState().status, 'downloading');
  assert.equal(fakeUpdater.downloadCalls.length, 2);

  // Late rejection of Download #1 must NOT revert Download #2 back to 'available'.
  downloadRejectors[0](Object.assign(new Error('Cancelled'), { name: 'CancellationError' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getState().status, 'downloading');

  // Complete Download #2 -> ready-to-install.
  fakeUpdater.emit('update-downloaded', { version: '3.1.0' });
  assert.equal(service.getState().status, 'ready-to-install');

  // Late error event after update-downloaded must not overwrite ready-to-install.
  fakeUpdater.emit('error', new Error('net::ERR_CONNECTION_RESET'));
  assert.equal(service.getState().status, 'ready-to-install');

  // Manual check while ready-to-install emits manualCheck=true so the UI can surface the popover.
  const prevSeq = service.getState().seq;
  const manualSnap = await service.checkForUpdates({ manual: true });
  assert.equal(manualSnap.status, 'ready-to-install');
  assert.equal(manualSnap.manualCheck, true);
  assert.ok(manualSnap.seq > prevSeq);

  service.dispose();
});

test('installUpdateNow re-verifies import save and summary metadata after drain and disarms quit on failure or post-drain block', async () => {
  const userDataPath = makeTempUserData();
  const fakeUpdater = createFakeAutoUpdater();
  let audioImportActive = false;
  let protectedSummaryWrite = false;
  let shouldThrowInDrain = false;
  let armedCount = 0;
  let disarmedCount = 0;
  let drainStep = 'none';

  const service = createUpdaterService({
    app: { isPackaged: true, getVersion: () => '3.0.0' },
    platform: 'win32',
    userDataPath,
    autoUpdater: fakeUpdater,
    CancellationToken: FakeCancellationToken,
    hasActiveAudioImport: () => audioImportActive,
    hasProtectedSummaryWrite: () => protectedSummaryWrite,
    hasInFlightAiWork: () => true,
    drainAiWorkBeforeQuit: async () => {
      if (shouldThrowInDrain) {
        throw new Error('Drain failed');
      }
      if (drainStep === 'import') {
        audioImportActive = true;
      } else if (drainStep === 'summary') {
        protectedSummaryWrite = true;
      }
    },
    armUpdateQuit: () => {
      armedCount += 1;
    },
    disarmUpdateQuit: () => {
      disarmedCount += 1;
    },
  });

  fakeUpdater.emit('update-available', { version: '3.1.0' });
  fakeUpdater.emit('update-downloaded', { version: '3.1.0' });

  // 1. Audio import enters commit/save phase during drain -> blocked & disarmed.
  drainStep = 'import';
  let res = await service.installUpdateNow({ confirmAiInterrupt: true });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPDATE_BLOCKED_IMPORT_SAVE');
  assert.equal(service.getState().status, 'ready-to-install');
  assert.equal(armedCount, 0);
  assert.equal(disarmedCount, 1);
  audioImportActive = false;

  // 2. Summary enters metadata phase during drain -> blocked & disarmed.
  drainStep = 'summary';
  res = await service.installUpdateNow({ confirmAiInterrupt: true });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPDATE_BLOCKED_SUMMARY_FINALIZING');
  assert.equal(service.getState().status, 'ready-to-install');
  assert.equal(armedCount, 0);
  assert.equal(disarmedCount, 2);
  protectedSummaryWrite = false;

  // 3. Drain throws -> disarmed and reverted to ready-to-install.
  drainStep = 'none';
  shouldThrowInDrain = true;
  res = await service.installUpdateNow({ confirmAiInterrupt: true });
  assert.equal(res.ok, false);
  assert.equal(service.getState().status, 'ready-to-install');
  assert.equal(disarmedCount, 3);
  shouldThrowInDrain = false;

  // 4. Async error emitted after quitAndInstall is armed -> disarms wedged quit state.
  res = await service.installUpdateNow({ confirmAiInterrupt: true });
  assert.equal(res.ok, true);
  assert.equal(armedCount, 1);
  fakeUpdater.emit('error', new Error('Squirrel install error'));
  assert.equal(disarmedCount, 4);
  assert.equal(service.getState().status, 'error');

  service.dispose();
});

test('IPC handlers validate argument types for set-auto-download-updates and install-update-now', async () => {
  const userDataPath = makeTempUserData();
  const service = createUpdaterService({
    app: { isPackaged: false, getVersion: () => '3.0.0' },
    userDataPath,
    checkManualRelease: async () => null,
  });

  const handlers = {};
  service.registerIpcHandlers(
    { handle(ch, fn) { handlers[ch] = fn; } },
    () => {},
  );

  await assert.rejects(
    () => handlers['set-auto-download-updates']({}, 'false'),
    /must be a boolean/i,
  );
  await assert.rejects(
    () => handlers['set-auto-download-updates']({}, { enabled: false }),
    /must be a boolean/i,
  );
  await assert.rejects(
    () => handlers['install-update-now']({}, null),
    /must be a plain object/i,
  );
  await assert.rejects(
    () => handlers['install-update-now']({}, []),
    /must be a plain object/i,
  );
  await assert.rejects(
    () => handlers['install-update-now']({}, { confirmAiInterrupt: 'false' }),
    /confirmAiInterrupt must be a boolean/i,
  );

  service.dispose();
});
