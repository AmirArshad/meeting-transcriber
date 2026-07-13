'use strict';

/**
 * Recording presence service — tray, Dock/taskbar, and hourly reminders.
 *
 * Capture truth remains in recorder-service; this service only presents state.
 */

const RECORDING_REMINDER_INTERVAL_MS = 60 * 60 * 1000;
const TRAY_ELAPSED_REFRESH_MS = 60 * 1000;
const AVANEVIS_TOAST_GROUP = 'avanevis-recording-reminders';

function getNextReminderAt(startedAt, now, intervalMs = RECORDING_REMINDER_INTERVAL_MS) {
  const completedIntervals = Math.floor(Math.max(0, now - startedAt) / intervalMs);
  return startedAt + ((completedIntervals + 1) * intervalMs);
}

function formatTrayElapsed(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(elapsedMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function buildReminderCopy(elapsedMs) {
  const hours = Math.max(1, Math.floor(elapsedMs / RECORDING_REMINDER_INTERVAL_MS));
  return {
    title: 'AvaNevis is still recording',
    body: `Recording has been active for ${hours} ${hours === 1 ? 'hour' : 'hours'}. Open AvaNevis to stop and transcribe when you are finished.`,
  };
}

function buildTrayView(captureState, now = Date.now()) {
  const state = captureState?.state || 'idle';
  const startedAt = Number.isFinite(captureState?.startedAt) ? captureState.startedAt : null;

  if (state === 'starting') {
    return {
      title: 'REC',
      tooltip: 'AvaNevis - Starting recording...',
      statusLabel: 'Starting recording...',
      trayImage: 'recording',
    };
  }

  if (state === 'recording' && startedAt != null) {
    const elapsed = formatTrayElapsed(Math.max(0, now - startedAt));
    return {
      title: 'REC',
      tooltip: `AvaNevis - Recording (${elapsed})`,
      statusLabel: `REC  Recording - ${elapsed}`,
      trayImage: 'recording',
    };
  }

  if (state === 'stopping') {
    return {
      title: '',
      tooltip: 'AvaNevis - Finishing recording',
      statusLabel: 'Finishing recording...',
      trayImage: 'idle',
    };
  }

  return {
    title: '',
    tooltip: 'AvaNevis - Private meeting recorder and transcriber',
    statusLabel: 'Ready',
    trayImage: 'idle',
  };
}

function isActiveCaptureState(state) {
  return state === 'starting' || state === 'recording' || state === 'stopping';
}

/**
 * @returns {{
 *   type: string,
 *   title: string,
 *   message: string,
 *   detail: string,
 *   buttons: string[],
 *   defaultId: number,
 *   cancelId: number,
 *   keepRecordingAction: 'minimize'|'hide',
 * }}
 */
function buildWindowCloseDialogOptions(captureState, platform = process.platform) {
  const state = captureState?.state || 'idle';

  if (isActiveCaptureState(state)) {
    if (platform === 'win32') {
      return {
        type: 'question',
        title: 'AvaNevis is still recording',
        message: 'AvaNevis is still recording.',
        detail: 'Minimize to keep the taskbar recording indicator visible, or stop and quit.',
        buttons: ['Keep Recording Minimized', 'Stop and Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        keepRecordingAction: 'minimize',
      };
    }

    return {
      type: 'question',
      title: 'AvaNevis is still recording',
      message: 'AvaNevis is still recording.',
      detail: 'Keep recording in the menu bar, or stop and quit.',
      buttons: ['Keep Recording in Menu Bar', 'Stop and Quit', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      keepRecordingAction: 'hide',
    };
  }

  // Gate A idle close dialog
  return {
    type: 'question',
    title: 'Minimize to Tray',
    message: 'Would you like to close the app or minimize it to the system tray?',
    detail: 'Minimizing to tray keeps the app running in the background.',
    buttons: ['Minimize to Tray', 'Close App', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    keepRecordingAction: 'hide',
  };
}

function resolveResourcePath(deps, fileName) {
  if (deps.app?.isPackaged) {
    return deps.path.join(deps.resourcesPath || process.resourcesPath, fileName);
  }
  return deps.path.join(deps.dirname || __dirname, '../../build', fileName);
}

function createRecordingPresenceService(deps) {
  const {
    app,
    path: pathMod,
    Tray,
    Menu,
    Notification,
    nativeImage,
    getMainWindow,
    showMainWindow,
    toggleMainWindow,
    quitApp,
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    platform = process.platform,
    reminderIntervalMs = RECORDING_REMINDER_INTERVAL_MS,
    logWarn = (...args) => console.warn(...args),
  } = deps;

  const idleTrayImagePath = deps.idleTrayImagePath
    || resolveResourcePath(deps, platform === 'darwin' ? 'iconTemplate.png' : 'icon.ico');
  const recordingTrayImagePath = deps.recordingTrayImagePath
    || resolveResourcePath(deps, 'iconRecording.png');
  const recordingOverlayPath = deps.recordingOverlayPath
    || resolveResourcePath(deps, 'recording-overlay.png');

  let tray = null;
  let captureState = { state: 'idle', sessionId: null, startedAt: null };
  let reminderTimer = null;
  let elapsedRefreshTimer = null;
  let notificationActivationRegistered = false;
  const retainedNotifications = new Set();

  function getCaptureState() {
    return {
      state: captureState.state,
      sessionId: captureState.sessionId,
      startedAt: captureState.startedAt,
    };
  }

  function clearReminderTimer() {
    if (reminderTimer) {
      clearTimeoutFn(reminderTimer);
      reminderTimer = null;
    }
  }

  function clearElapsedRefreshTimer() {
    if (elapsedRefreshTimer) {
      clearIntervalFn(elapsedRefreshTimer);
      elapsedRefreshTimer = null;
    }
  }

  function retainNotification(notification) {
    retainedNotifications.add(notification);
    const release = () => {
      retainedNotifications.delete(notification);
    };
    notification.once('click', () => {
      try {
        showMainWindow();
      } catch (error) {
        logWarn('Recording reminder click failed to show window:', error?.message || error);
      }
      release();
    });
    notification.once('close', release);
    notification.once('failed', (error) => {
      logWarn('Recording reminder notification failed:', error?.message || error || 'unknown');
      release();
    });
  }

  function ensureNotificationActivationHandler() {
    if (notificationActivationRegistered || platform !== 'win32') {
      return;
    }
    if (typeof Notification?.handleActivation !== 'function') {
      return;
    }
    try {
      Notification.handleActivation(() => {
        try {
          showMainWindow();
        } catch (error) {
          logWarn('Toast activation failed to show window:', error?.message || error);
        }
      });
      notificationActivationRegistered = true;
    } catch (error) {
      logWarn('Could not register toast activation handler:', error?.message || error);
    }
  }

  function showRecordingReminder() {
    const current = getCaptureState();
    if (current.state !== 'recording' || !Number.isInteger(current.sessionId) || !Number.isFinite(current.startedAt)) {
      return;
    }

    const currentNow = now();
    const elapsedMs = Math.max(0, currentNow - current.startedAt);
    if (elapsedMs < reminderIntervalMs) {
      scheduleReminder();
      return;
    }

    const hours = Math.max(1, Math.floor(elapsedMs / reminderIntervalMs));
    const copy = buildReminderCopy(elapsedMs);
    const toastId = `recording-reminder-${current.sessionId}-${hours}`;

    if (typeof Notification?.isSupported === 'function' && !Notification.isSupported()) {
      logWarn('Native notifications are not supported; keeping tray/Dock/taskbar indicators.');
      scheduleReminder();
      return;
    }

    try {
      ensureNotificationActivationHandler();
      const notification = new Notification({
        title: copy.title,
        body: copy.body,
        silent: false,
      });
      try {
        notification.toastId = toastId;
        notification.group = AVANEVIS_TOAST_GROUP;
      } catch (_) {
        // Optional identity only.
      }

      retainNotification(notification);
      notification.show();
    } catch (error) {
      logWarn('Failed to show recording reminder:', error?.message || error);
    }

    scheduleReminder();
  }

  function scheduleReminder() {
    clearReminderTimer();
    const current = getCaptureState();
    if (current.state !== 'recording' || !Number.isFinite(current.startedAt)) {
      return;
    }

    const currentNow = now();
    const nextAt = getNextReminderAt(current.startedAt, currentNow, reminderIntervalMs);
    const delay = Math.max(0, nextAt - currentNow);
    const expectedSessionId = current.sessionId;
    const expectedStartedAt = current.startedAt;

    reminderTimer = setTimeoutFn(() => {
      const latest = getCaptureState();
      if (
        latest.state !== 'recording'
        || latest.sessionId !== expectedSessionId
        || latest.startedAt !== expectedStartedAt
      ) {
        return;
      }
      showRecordingReminder();
    }, delay);
  }

  function loadTrayNativeImage(kind) {
    const filePath = kind === 'recording' ? recordingTrayImagePath : idleTrayImagePath;
    const image = nativeImage.createFromPath(filePath);
    if (platform === 'darwin' && typeof image.setTemplateImage === 'function') {
      // Non-template for saturated red recording status; template for idle monochrome.
      image.setTemplateImage(kind !== 'recording');
    }
    return image;
  }

  function applyOverlay(active) {
    if (platform !== 'win32') {
      return;
    }
    const mainWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      return;
    }
    try {
      if (active) {
        const overlay = nativeImage.createFromPath(recordingOverlayPath);
        mainWindow.setOverlayIcon(overlay, 'AvaNevis is recording');
      } else {
        mainWindow.setOverlayIcon(null, '');
      }
    } catch (error) {
      logWarn('Failed to update taskbar overlay:', error?.message || error);
    }
  }

  function applyDockBadge(badge) {
    if (platform !== 'darwin' || !app?.dock || typeof app.dock.setBadge !== 'function') {
      return;
    }
    try {
      app.dock.setBadge(badge || '');
    } catch (error) {
      logWarn('Failed to update Dock badge:', error?.message || error);
    }
  }

  function rebuildTrayMenu(view) {
    if (!tray) {
      return;
    }

    const template = [
      {
        label: view.statusLabel,
        enabled: false,
      },
      {
        label: 'Show AvaNevis',
        click: () => {
          try {
            showMainWindow();
          } catch (error) {
            logWarn('Show AvaNevis failed:', error?.message || error);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Quit AvaNevis',
        click: () => {
          try {
            quitApp();
          } catch (error) {
            logWarn('Quit AvaNevis failed:', error?.message || error);
          }
        },
      },
    ];

    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  function applyTrayPresentation() {
    if (!tray) {
      return;
    }

    const view = buildTrayView(captureState, now());
    const image = loadTrayNativeImage(view.trayImage);
    // macOS: setTemplateImage(false) already applied for recording images before setImage.
    tray.setImage(image);

    if (platform === 'darwin' && typeof tray.setTitle === 'function') {
      try {
        tray.setTitle(view.title, { fontType: 'monospacedDigit' });
      } catch (_) {
        tray.setTitle(view.title);
      }
    }

    tray.setToolTip(view.tooltip);
    rebuildTrayMenu(view);
  }

  function syncPlatformPresence() {
    const state = captureState.state;
    const showRecordingMarkers = state === 'starting' || state === 'recording';
    const keepWindowsOverlay = showRecordingMarkers || state === 'stopping';

    applyTrayPresentation();

    if (platform === 'darwin') {
      applyDockBadge(showRecordingMarkers ? 'REC' : '');
    }

    if (platform === 'win32') {
      applyOverlay(keepWindowsOverlay);
    }
  }

  function startElapsedRefresh() {
    clearElapsedRefreshTimer();
    if (captureState.state !== 'recording' || !Number.isFinite(captureState.startedAt)) {
      return;
    }
    elapsedRefreshTimer = setIntervalFn(() => {
      if (captureState.state !== 'recording') {
        clearElapsedRefreshTimer();
        return;
      }
      applyTrayPresentation();
    }, TRAY_ELAPSED_REFRESH_MS);
  }

  function updateCaptureState(nextState) {
    captureState = {
      state: nextState?.state || 'idle',
      sessionId: Number.isInteger(nextState?.sessionId) ? nextState.sessionId : null,
      startedAt: Number.isFinite(nextState?.startedAt) ? nextState.startedAt : null,
    };

    if (captureState.state === 'recording') {
      scheduleReminder();
      startElapsedRefresh();
    } else {
      clearReminderTimer();
      clearElapsedRefreshTimer();
    }

    syncPlatformPresence();
  }

  function createTray() {
    if (tray) {
      return tray;
    }

    const idleImage = loadTrayNativeImage('idle');
    tray = new Tray(idleImage);

    if (platform === 'darwin') {
      // Ensure idle starts as a template image.
      const image = loadTrayNativeImage('idle');
      tray.setImage(image);
    }

    tray.on('click', () => {
      try {
        toggleMainWindow();
      } catch (error) {
        logWarn('Tray click failed:', error?.message || error);
      }
    });

    applyTrayPresentation();
    return tray;
  }

  function destroy() {
    clearReminderTimer();
    clearElapsedRefreshTimer();
    applyOverlay(false);
    applyDockBadge('');
    captureState = { state: 'idle', sessionId: null, startedAt: null };
    for (const notification of retainedNotifications) {
      retainedNotifications.delete(notification);
    }
    if (tray) {
      try {
        tray.destroy();
      } catch (_) {
        // already destroyed
      }
      tray = null;
    }
  }

  return {
    createTray,
    updateCaptureState,
    getCaptureState,
    destroy,
    // Test seams
    _applyTrayPresentation: applyTrayPresentation,
  };
}

module.exports = {
  RECORDING_REMINDER_INTERVAL_MS,
  TRAY_ELAPSED_REFRESH_MS,
  createRecordingPresenceService,
  getNextReminderAt,
  buildReminderCopy,
  buildTrayView,
  buildWindowCloseDialogOptions,
  formatTrayElapsed,
  isActiveCaptureState,
};
