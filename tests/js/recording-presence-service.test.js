'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  createRecordingPresenceService,
  getNextReminderAt,
  buildReminderCopy,
  buildTrayView,
  buildWindowCloseDialogOptions,
  formatTrayElapsed,
  RECORDING_REMINDER_INTERVAL_MS,
} = require('../../src/main/recording-presence-service');

function createDeps(overrides = {}) {
  const timers = [];
  const intervals = [];
  const notifications = [];
  const menuTemplates = [];
  let trayImage = 'idle';
  let trayTitle = '';
  let trayTooltip = '';
  let dockBadge = '';
  let overlayDescription = null;
  let destroyed = false;

  class FakeNotification extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.shown = false;
      notifications.push(this);
    }

    show() {
      this.shown = true;
    }

    static isSupported() {
      return true;
    }
  }

  const tray = {
    setImage(image) {
      trayImage = image;
    },
    setTitle(title) {
      trayTitle = title;
    },
    setToolTip(tooltip) {
      trayTooltip = tooltip;
    },
    setContextMenu(menu) {
      tray.menu = menu;
    },
    on() {},
    destroy() {
      destroyed = true;
    },
  };

  const mainWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    setOverlayIcon(_image, description) {
      overlayDescription = description;
    },
  };

  const deps = {
    app: {
      isPackaged: false,
      dock: {
        setBadge(value) {
          dockBadge = value;
        },
      },
    },
    path,
    platform: 'darwin',
    resourcesPath: '/resources',
    dirname: path.join(__dirname, '../../src/main'),
    Tray: function Tray() {
      return tray;
    },
    Menu: {
      buildFromTemplate(template) {
        menuTemplates.push(template);
        return { template };
      },
    },
    Notification: FakeNotification,
    nativeImage: {
      createFromPath(filePath) {
        return {
          path: filePath,
          setTemplateImage(flag) {
            this.template = flag;
          },
        };
      },
    },
    getMainWindow: () => mainWindow,
    showMainWindow() {
      deps._showCalled = true;
    },
    toggleMainWindow() {
      deps._toggleCalled = true;
    },
    quitApp() {
      deps._quitCalled = true;
    },
    now: () => 1_000,
    setTimeoutFn: (fn, delay) => {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    },
    setIntervalFn: (fn, delay) => {
      const interval = { fn, delay, cleared: false };
      intervals.push(interval);
      return interval;
    },
    clearIntervalFn: (interval) => {
      if (interval) {
        interval.cleared = true;
      }
    },
    idleTrayImagePath: path.join(__dirname, '../../build/iconTemplate.png'),
    recordingTrayImagePath: path.join(__dirname, '../../build/iconRecording.png'),
    recordingOverlayPath: path.join(__dirname, '../../build/recording-overlay.png'),
    ...overrides,
  };

  return {
    deps,
    timers,
    intervals,
    notifications,
    menuTemplates,
    getTrayImage: () => trayImage,
    getTrayTitle: () => trayTitle,
    getTrayTooltip: () => trayTooltip,
    getDockBadge: () => dockBadge,
    getOverlayDescription: () => overlayDescription,
    isDestroyed: () => destroyed,
    mainWindow,
    tray,
  };
}

test('getNextReminderAt schedules the next unmissed hourly milestone', () => {
  assert.equal(getNextReminderAt(1_000, 1_000, 3_600_000), 3_601_000);
  assert.equal(getNextReminderAt(1_000, 3_701_000, 3_600_000), 7_201_000);
});

test('buildReminderCopy uses whole elapsed hours', () => {
  assert.deepEqual(buildReminderCopy(3_600_000), {
    title: 'AvaNevis is still recording',
    body: 'Recording has been active for 1 hour. Open AvaNevis to stop and transcribe when you are finished.',
  });
  assert.deepEqual(buildReminderCopy(7_200_000), {
    title: 'AvaNevis is still recording',
    body: 'Recording has been active for 2 hours. Open AvaNevis to stop and transcribe when you are finished.',
  });
});

test('formatTrayElapsed switches to H:MM:SS after one hour', () => {
  assert.equal(formatTrayElapsed(0), '0:00');
  assert.equal(formatTrayElapsed(65_000), '1:05');
  assert.equal(formatTrayElapsed(3_723_000), '1:02:03');
});

test('buildTrayView returns idle, starting, recording, and stopping labels', () => {
  assert.deepEqual(buildTrayView({ state: 'idle', startedAt: null }, 1_000), {
    title: '',
    tooltip: 'AvaNevis - Private meeting recorder and transcriber',
    statusLabel: 'Ready',
    trayImage: 'idle',
  });

  assert.deepEqual(buildTrayView({ state: 'starting', startedAt: null }, 1_000), {
    title: 'REC',
    tooltip: 'AvaNevis - Starting recording...',
    statusLabel: 'Starting recording...',
    trayImage: 'recording',
  });

  assert.deepEqual(buildTrayView({ state: 'recording', startedAt: 1_000 }, 3_724_000), {
    title: 'REC',
    tooltip: 'AvaNevis - Recording (1:02:03)',
    statusLabel: 'REC  Recording - 1:02:03',
    trayImage: 'recording',
  });

  assert.deepEqual(buildTrayView({ state: 'stopping', startedAt: 1_000 }, 3_724_000), {
    title: '',
    tooltip: 'AvaNevis - Finishing recording',
    statusLabel: 'Finishing recording...',
    trayImage: 'idle',
  });
});

test('recording state schedules one reminder and clears it on stopping', () => {
  const harness = createDeps({
    now: () => 1_000,
  });
  const service = createRecordingPresenceService(harness.deps);
  service.createTray();

  service.updateCaptureState({ state: 'recording', sessionId: 7, startedAt: 1_000 });
  assert.equal(harness.timers[0].delay, RECORDING_REMINDER_INTERVAL_MS);
  assert.equal(harness.getTrayTitle(), 'REC');
  assert.equal(harness.getDockBadge(), 'REC');

  service.updateCaptureState({ state: 'stopping', sessionId: 7, startedAt: 1_000 });
  assert.equal(harness.timers[0].cleared, true);
  assert.equal(harness.getTrayTitle(), '');
  assert.equal(harness.getDockBadge(), '');
  assert.match(harness.getTrayTooltip(), /Finishing recording/);
});

test('reminder fire coalesces missed milestones and reschedules the next future one', () => {
  let now = 1_000;
  const harness = createDeps({
    now: () => now,
  });
  const service = createRecordingPresenceService(harness.deps);
  service.createTray();
  service.updateCaptureState({ state: 'recording', sessionId: 3, startedAt: 1_000 });

  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].delay, 3_600_000);

  // Sleep through the 1h and 2h milestones; only one notification should fire.
  now = 7_300_000;
  harness.timers[0].fn();

  assert.equal(harness.notifications.length, 1);
  assert.equal(
    harness.notifications[0].options.body,
    'Recording has been active for 2 hours. Open AvaNevis to stop and transcribe when you are finished.',
  );
  assert.equal(harness.timers.length, 2);
  // Next milestone is 3h = startedAt + 3*interval = 10_801_000; delay = 10_801_000 - 7_300_000.
  assert.equal(harness.timers[1].delay, 3_501_000);
});

test('stale session reminder does not show after session change', () => {
  let now = 1_000;
  const harness = createDeps({ now: () => now });
  const service = createRecordingPresenceService(harness.deps);
  service.createTray();
  service.updateCaptureState({ state: 'recording', sessionId: 1, startedAt: 1_000 });
  const firstTimer = harness.timers[0];

  service.updateCaptureState({ state: 'idle', sessionId: null, startedAt: null });
  service.updateCaptureState({ state: 'recording', sessionId: 2, startedAt: 5_000 });
  now = 3_700_000;
  firstTimer.fn();
  assert.equal(harness.notifications.length, 0);
});

test('Windows recording close dialog minimizes; macOS hides; idle preserves Gate A', () => {
  const winRecording = buildWindowCloseDialogOptions(
    { state: 'recording', sessionId: 1, startedAt: 1 },
    'win32',
  );
  assert.equal(winRecording.title, 'AvaNevis is still recording');
  assert.deepEqual(winRecording.buttons, [
    'Keep Recording Minimized',
    'Stop and Quit',
    'Cancel',
  ]);
  assert.equal(winRecording.defaultId, 0);
  assert.equal(winRecording.cancelId, 2);
  assert.equal(winRecording.keepRecordingAction, 'minimize');

  const macRecording = buildWindowCloseDialogOptions(
    { state: 'recording', sessionId: 1, startedAt: 1 },
    'darwin',
  );
  assert.deepEqual(macRecording.buttons, [
    'Keep Recording in Menu Bar',
    'Stop and Quit',
    'Cancel',
  ]);
  assert.equal(macRecording.keepRecordingAction, 'hide');

  const idle = buildWindowCloseDialogOptions({ state: 'idle' }, 'win32');
  assert.equal(idle.title, 'Minimize to Tray');
  assert.deepEqual(idle.buttons, ['Minimize to Tray', 'Close App', 'Cancel']);
  assert.equal(idle.keepRecordingAction, 'hide');
});

test('tray menu intentionally replaces Gate A Show/Hide with Show AvaNevis and Quit AvaNevis', () => {
  const harness = createDeps();
  const service = createRecordingPresenceService(harness.deps);
  service.createTray();

  const template = harness.menuTemplates[0];
  assert.equal(template[0].enabled, false);
  assert.equal(template[0].label, 'Ready');
  assert.equal(template[1].label, 'Show AvaNevis');
  assert.equal(template[2].type, 'separator');
  assert.equal(template[3].label, 'Quit AvaNevis');
});

test('Windows overlay is set while recording and cleared on idle', () => {
  const harness = createDeps({ platform: 'win32' });
  const service = createRecordingPresenceService(harness.deps);
  service.createTray();

  service.updateCaptureState({ state: 'recording', sessionId: 9, startedAt: 1_000 });
  assert.equal(harness.getOverlayDescription(), 'AvaNevis is recording');

  service.updateCaptureState({ state: 'idle', sessionId: null, startedAt: null });
  assert.equal(harness.getOverlayDescription(), '');
});

test('refreshPresentation reapplies Windows overlay for a replacement window', () => {
  let overlayDescription = null;
  const firstWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    setOverlayIcon(_image, description) {
      overlayDescription = description;
    },
  };
  let currentWindow = firstWindow;

  const harness = createDeps({
    platform: 'win32',
    getMainWindow: () => currentWindow,
  });
  const service = createRecordingPresenceService(harness.deps);
  service.createTray();
  service.updateCaptureState({ state: 'recording', sessionId: 3, startedAt: 1_000 });
  assert.equal(overlayDescription, 'AvaNevis is recording');

  // Simulate a recreated BrowserWindow with a fresh overlay slot.
  overlayDescription = null;
  currentWindow = {
    isDestroyed: () => false,
    isMinimized: () => false,
    setOverlayIcon(_image, description) {
      overlayDescription = description;
    },
  };
  service.refreshPresentation();
  assert.equal(overlayDescription, 'AvaNevis is recording');
});

test('destroy clears timers and tray', () => {
  const harness = createDeps();
  const service = createRecordingPresenceService(harness.deps);
  service.createTray();
  service.updateCaptureState({ state: 'recording', sessionId: 1, startedAt: 1_000 });
  service.destroy();
  assert.equal(harness.timers[0].cleared, true);
  assert.equal(harness.isDestroyed(), true);
  assert.deepEqual(service.getCaptureState(), {
    state: 'idle',
    sessionId: null,
    startedAt: null,
  });
});

test('showSafetyNotification shows a best-effort native toast', () => {
  const harness = createDeps();
  const service = createRecordingPresenceService(harness.deps);
  const shown = service.showSafetyNotification({
    title: 'AvaNevis disk space is running low',
    body: 'Less than 10 GB is available. Long recordings may run out of space.',
  });
  assert.equal(shown, true);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].shown, true);
  assert.equal(harness.notifications[0].options.title, 'AvaNevis disk space is running low');
});
