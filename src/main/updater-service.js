'use strict';

const fs = require('fs');
const path = require('path');
const { resolveExternalUrl } = require('../main-process-helpers');
const {
  checkForUpdates: defaultCheckManualRelease,
  resolveLinuxInstallerOrder,
  isNewerVersion,
  openDownloadPage: defaultOpenDownloadPage,
} = require('../updater');

const REPO_URL_PREFIX = 'https://github.com/AmirArshad/meeting-transcriber';
const DEFAULT_RELEASES_URL = `${REPO_URL_PREFIX}/releases/latest`;
const PREFERENCES_FILENAME = 'updater-preferences.json';
const STARTUP_CHECK_DELAY_MS = 5000;
const PERIODIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROGRESS_THROTTLE_MS = 150;
const INSTALLER_NAME_REGEX = /^AvaNevis-Setup-[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?\.(?:pkg\.tar\.zst|deb|AppImage)$/;
const SEMVER_TAG_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

function resolveUpdateMode({
  isPackaged = false,
  platform = process.platform,
  env = process.env,
  osReleaseText,
} = {}) {
  if (!isPackaged) {
    return { mode: 'dev-unpackaged', manualPackageKind: null };
  }

  if (platform === 'win32' || platform === 'darwin') {
    return { mode: 'in-app', manualPackageKind: null };
  }

  if (platform === 'linux') {
    if (Boolean(env && env.APPIMAGE)) {
      return { mode: 'in-app', manualPackageKind: null };
    }

    const orderOptions = { env };
    if (osReleaseText !== undefined) {
      orderOptions.osReleaseText = osReleaseText;
    }
    const order = resolveLinuxInstallerOrder(orderOptions);
    const primary = Array.isArray(order) && order.length > 0 ? order[0] : '.AppImage';
    if (primary === '.pkg.tar.zst') {
      return { mode: 'manual-package', manualPackageKind: 'pacman' };
    }
    if (primary === '.deb') {
      return { mode: 'manual-package', manualPackageKind: 'deb' };
    }
    return { mode: 'manual-package', manualPackageKind: 'appimage' };
  }

  return { mode: 'manual-package', manualPackageKind: null };
}

function buildManualInstallCommand(installerName, manualPackageKind) {
  if (typeof installerName !== 'string' || !INSTALLER_NAME_REGEX.test(installerName)) {
    return null;
  }

  if (manualPackageKind === 'pacman' && installerName.endsWith('.pkg.tar.zst')) {
    return `sudo pacman -U ~/Downloads/${installerName}`;
  }

  if (manualPackageKind === 'deb' && installerName.endsWith('.deb')) {
    return `sudo apt install ~/Downloads/${installerName}`;
  }

  return null;
}

function normalizeReleaseNotes(releaseNotes) {
  if (releaseNotes == null) {
    return null;
  }

  if (typeof releaseNotes === 'string') {
    const trimmed = releaseNotes.trim();
    return trimmed || null;
  }

  if (Array.isArray(releaseNotes)) {
    const sections = [];
    for (const entry of releaseNotes) {
      if (!entry) continue;
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed) sections.push(trimmed);
        continue;
      }
      const note = typeof entry.note === 'string' ? entry.note.trim() : '';
      if (!note) continue;
      const version = typeof entry.version === 'string'
        ? entry.version.trim().replace(/^v/, '')
        : '';
      if (version) {
        sections.push(`## v${version}\n\n${note}`);
      } else {
        sections.push(note);
      }
    }
    const joined = sections.join('\n\n').trim();
    return joined || null;
  }

  const fallback = String(releaseNotes).trim();
  return fallback || null;
}

function resolveTrustedUpdateUrl(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }
  const resolved = resolveExternalUrl(url);
  if (!resolved) {
    return null;
  }
  if (resolved === REPO_URL_PREFIX || resolved.startsWith(`${REPO_URL_PREFIX}/`)) {
    return resolved;
  }
  return null;
}

function buildReleaseTagUrl(version) {
  const cleaned = String(version || '').trim().replace(/^v/, '');
  if (!cleaned || !SEMVER_TAG_REGEX.test(cleaned)) {
    return DEFAULT_RELEASES_URL;
  }
  return resolveTrustedUpdateUrl(`${REPO_URL_PREFIX}/releases/tag/v${cleaned}`) || DEFAULT_RELEASES_URL;
}

function isCancellationError(error) {
  if (!error) return false;
  const name = String(error.name || '');
  const code = String(error.code || '');
  const message = String(error.message || '');
  return name === 'CancellationError'
    || code === 'ERR_UPDATER_CANCELLED'
    || /\bcancell?ed\b/i.test(message);
}

function sanitizeUpdaterError(error) {
  const rawMessage = String((error && error.message) || error || '').trim();
  const rawCode = String((error && error.code) || '').trim();
  const combined = `${rawCode} ${rawMessage}`;

  if (/(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_TIMED_OUT|ERR_NETWORK_CHANGED|net::ERR_)/i.test(combined)) {
    return {
      code: 'UPDATE_NETWORK_ERROR',
      message: 'Could not reach the update server. Check your internet connection and try again.',
      retryable: true,
    };
  }

  if (/(sha512|checksum|signature|code\s+signature|integrity|mismatch)/i.test(combined)) {
    return {
      code: 'UPDATE_VERIFICATION_FAILED',
      message: 'The downloaded update could not be verified. Please try again later.',
      retryable: true,
    };
  }

  if (/(ENOSPC|no space left on device|disk full)/i.test(combined)) {
    return {
      code: 'UPDATE_DISK_FULL',
      message: 'Not enough disk space to download the update.',
      retryable: true,
    };
  }

  if (/(404|No published versions|Cannot find latest)/i.test(combined)) {
    return {
      code: 'UPDATE_METADATA_UNAVAILABLE',
      message: 'Update information is temporarily unavailable. You can check GitHub Releases manually.',
      retryable: true,
    };
  }

  const firstLine = rawMessage
    .split(/\r?\n/)[0]
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  return {
    code: 'UPDATE_ERROR',
    message: firstLine || 'Could not complete the update check.',
    retryable: true,
  };
}

function createFallbackCancellationToken() {
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    cancel() {
      cancelled = true;
    },
  };
}

function createUpdaterService(deps = {}) {
  const {
    app = { isPackaged: false, getVersion: () => '0.0.0' },
    platform = process.platform,
    env = process.env,
    osReleaseText,
    userDataPath = typeof app.getPath === 'function' ? app.getPath('userData') : '',
    fs: fsImpl = fs,
    autoUpdater: injectedAutoUpdater = null,
    CancellationToken: injectedCancellationToken = null,
    checkManualRelease = defaultCheckManualRelease,
    openDownloadPage = defaultOpenDownloadPage,
    sendToRenderer = () => {},
    getQuitInterceptState = () => ({ interceptQuit: false }),
    getRecorderQuitInputs = () => ({ hasRecordingProcess: false, recordingStartTime: null, stopInProgress: false }),
    hasActiveAudioImport = () => false,
    hasProtectedSummaryWrite = () => false,
    hasInFlightAiWork = () => false,
    drainAiWorkBeforeQuit = async () => {},
    armUpdateQuit = () => {},
    log = console,
    now = () => Date.now(),
    startupDelayMs = STARTUP_CHECK_DELAY_MS,
    periodicIntervalMs = PERIODIC_CHECK_INTERVAL_MS,
  } = deps;

  const isPackaged = Boolean(app && app.isPackaged);
  const currentVersion = typeof app?.getVersion === 'function'
    ? String(app.getVersion() || '0.0.0')
    : '0.0.0';
  const { mode, manualPackageKind } = resolveUpdateMode({
    isPackaged,
    platform,
    env,
    osReleaseText,
  });

  function getPreferencesPath() {
    if (!userDataPath) {
      return null;
    }
    return path.join(userDataPath, PREFERENCES_FILENAME);
  }

  function readPreferences() {
    const prefsPath = getPreferencesPath();
    if (!prefsPath) {
      return { autoDownload: false };
    }
    try {
      const raw = fsImpl.readFileSync(prefsPath, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        autoDownload: Boolean(parsed && parsed.autoDownload === true),
      };
    } catch (_error) {
      return { autoDownload: false };
    }
  }

  function writePreferences(prefs) {
    const prefsPath = getPreferencesPath();
    if (!prefsPath) {
      return;
    }
    const dir = path.dirname(prefsPath);
    if (typeof fsImpl.mkdirSync === 'function') {
      fsImpl.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = path.join(
      dir,
      `${PREFERENCES_FILENAME}.tmp.${process.pid}.${now()}.${Math.random().toString(36).slice(2, 8)}`,
    );
    const payload = JSON.stringify({ autoDownload: Boolean(prefs.autoDownload) }, null, 2);
    fsImpl.writeFileSync(tmpPath, payload, 'utf8');
    fsImpl.renameSync(tmpPath, prefsPath);
  }

  const initialPrefs = readPreferences();

  let state = {
    seq: 1,
    status: 'idle',
    mode,
    currentVersion,
    availableVersion: null,
    releaseDate: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    installerName: null,
    manualPackageKind,
    manualInstallCommand: null,
    progress: null,
    autoDownload: initialPrefs.autoDownload,
    installOnNextQuit: false,
    lastCheckedAt: null,
    manualCheck: false,
    error: null,
  };

  let autoUpdater = null;
  let CancellationTokenCtor = injectedCancellationToken;
  let activeCancellationToken = null;
  let downloadCancelledByUser = false;
  let lastProgressEmitAt = 0;
  let checkInFlightPromise = null;
  let installInFlight = false;
  let startupTimer = null;
  let periodicTimer = null;
  const attachedListeners = [];

  function cloneState() {
    return {
      ...state,
      progress: state.progress ? { ...state.progress } : null,
      error: state.error ? { ...state.error } : null,
    };
  }

  function emitState(patch = {}) {
    state = {
      ...state,
      ...patch,
      seq: state.seq + 1,
    };
    const snapshot = cloneState();
    sendToRenderer('update-state-changed', snapshot);
    return snapshot;
  }

  function nowIso() {
    return new Date(now()).toISOString();
  }

  function initInAppUpdater() {
    if (mode !== 'in-app') {
      return;
    }

    if (injectedAutoUpdater) {
      autoUpdater = injectedAutoUpdater;
    } else {
      // Lazy-require electron-updater only in packaged in-app mode.
      // eslint-disable-next-line global-require
      const electronUpdater = require('electron-updater');
      autoUpdater = electronUpdater.autoUpdater;
      if (!CancellationTokenCtor) {
        CancellationTokenCtor = electronUpdater.CancellationToken;
      }
    }

    if (!autoUpdater) {
      return;
    }

    autoUpdater.autoDownload = Boolean(state.autoDownload);
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;

    const addUpdaterListener = (eventName, handler) => {
      if (typeof autoUpdater.on === 'function') {
        autoUpdater.on(eventName, handler);
        attachedListeners.push([eventName, handler]);
      }
    };

    addUpdaterListener('checking-for-update', () => {
      if (state.status === 'downloading' || state.status === 'ready-to-install' || state.status === 'installing') {
        return;
      }
      if (state.status !== 'checking') {
        emitState({ status: 'checking', error: null });
      }
    });

    addUpdaterListener('update-available', (info = {}) => {
      const version = String(info.version || '').trim().replace(/^v/, '') || null;
      const releaseDate = info.releaseDate ? String(info.releaseDate) : null;
      const releaseNotes = normalizeReleaseNotes(info.releaseNotes);
      const releaseUrl = buildReleaseTagUrl(version);
      emitState({
        status: 'available',
        availableVersion: version,
        releaseDate,
        releaseNotes,
        releaseUrl,
        downloadUrl: null,
        installerName: null,
        manualInstallCommand: null,
        progress: null,
        lastCheckedAt: nowIso(),
        error: null,
      });
    });

    addUpdaterListener('update-not-available', () => {
      emitState({
        status: 'up-to-date',
        availableVersion: null,
        releaseDate: null,
        releaseNotes: null,
        releaseUrl: null,
        downloadUrl: null,
        installerName: null,
        manualInstallCommand: null,
        progress: null,
        lastCheckedAt: nowIso(),
        error: null,
      });
    });

    addUpdaterListener('download-progress', (progressObj = {}) => {
      if (downloadCancelledByUser || state.status === 'ready-to-install' || state.status === 'installing') {
        return;
      }
      const percent = Math.max(0, Math.min(100, Number(progressObj.percent) || 0));
      const timestamp = now();
      const isEdge = percent === 0 || percent >= 100 || state.status !== 'downloading';
      if (!isEdge && (timestamp - lastProgressEmitAt) < PROGRESS_THROTTLE_MS) {
        return;
      }
      lastProgressEmitAt = timestamp;
      emitState({
        status: 'downloading',
        progress: {
          percent,
          bytesPerSecond: Math.max(0, Number(progressObj.bytesPerSecond) || 0),
          transferred: Math.max(0, Number(progressObj.transferred) || 0),
          total: Math.max(0, Number(progressObj.total) || 0),
        },
        error: null,
      });
    });

    addUpdaterListener('update-downloaded', (info = {}) => {
      activeCancellationToken = null;
      downloadCancelledByUser = false;
      const version = String(info.version || state.availableVersion || '').trim().replace(/^v/, '') || null;
      const releaseDate = info.releaseDate ? String(info.releaseDate) : state.releaseDate;
      const releaseNotes = info.releaseNotes !== undefined
        ? normalizeReleaseNotes(info.releaseNotes)
        : state.releaseNotes;
      const releaseUrl = version ? buildReleaseTagUrl(version) : (state.releaseUrl || DEFAULT_RELEASES_URL);
      const total = state.progress ? state.progress.total : 0;
      emitState({
        status: 'ready-to-install',
        availableVersion: version,
        releaseDate,
        releaseNotes,
        releaseUrl,
        progress: {
          percent: 100,
          bytesPerSecond: 0,
          transferred: total,
          total,
        },
        error: null,
      });
    });

    addUpdaterListener('error', (err) => {
      if (downloadCancelledByUser || isCancellationError(err)) {
        return;
      }
      activeCancellationToken = null;
      if (log && typeof log.warn === 'function') {
        log.warn('Updater error:', (err && err.message) || err);
      }
      emitState({
        status: 'error',
        progress: null,
        error: sanitizeUpdaterError(err),
      });
    });
  }

  initInAppUpdater();

  async function checkForUpdates({ manual = false } = {}) {
    if (
      state.status === 'downloading'
      || state.status === 'ready-to-install'
      || state.status === 'installing'
    ) {
      return cloneState();
    }

    if (checkInFlightPromise) {
      if (manual && !state.manualCheck) {
        emitState({ manualCheck: true });
      }
      return checkInFlightPromise;
    }

    emitState({
      status: 'checking',
      manualCheck: Boolean(manual),
      error: null,
    });

    checkInFlightPromise = (async () => {
      try {
        if (mode === 'in-app' && autoUpdater) {
          await autoUpdater.checkForUpdates();
          return cloneState();
        }

        const release = await checkManualRelease();
        const checkedAt = nowIso();
        const latestVersion = release && release.version
          ? String(release.version).trim().replace(/^v/, '')
          : '';

        if (latestVersion && isNewerVersion(latestVersion, currentVersion)) {
          const releaseUrl = resolveTrustedUpdateUrl(release.releaseUrl)
            || buildReleaseTagUrl(latestVersion);
          const downloadUrl = resolveTrustedUpdateUrl(release.downloadUrl) || releaseUrl;
          const installerName = typeof release.installerName === 'string'
            ? release.installerName
            : null;
          const manualInstallCommand = buildManualInstallCommand(installerName, state.manualPackageKind);

          return emitState({
            status: 'manual-required',
            availableVersion: latestVersion,
            releaseDate: release.releaseDate ? String(release.releaseDate) : null,
            releaseNotes: normalizeReleaseNotes(release.releaseNotes),
            releaseUrl,
            downloadUrl,
            installerName,
            manualInstallCommand,
            progress: null,
            lastCheckedAt: checkedAt,
            error: null,
          });
        }

        return emitState({
          status: 'up-to-date',
          availableVersion: null,
          releaseDate: null,
          releaseNotes: null,
          releaseUrl: null,
          downloadUrl: null,
          installerName: null,
          manualInstallCommand: null,
          progress: null,
          lastCheckedAt: checkedAt,
          error: null,
        });
      } catch (error) {
        if (downloadCancelledByUser || isCancellationError(error)) {
          return cloneState();
        }
        if (log && typeof log.warn === 'function') {
          log.warn('Update check failed:', (error && error.message) || error);
        }
        if (state.status !== 'error') {
          emitState({
            status: 'error',
            progress: null,
            lastCheckedAt: nowIso(),
            error: sanitizeUpdaterError(error),
          });
        }
        return cloneState();
      } finally {
        checkInFlightPromise = null;
      }
    })();

    return checkInFlightPromise;
  }

  async function downloadUpdate() {
    if (mode !== 'in-app') {
      const targetUrl = resolveTrustedUpdateUrl(state.downloadUrl)
        || resolveTrustedUpdateUrl(state.releaseUrl)
        || DEFAULT_RELEASES_URL;
      await openDownloadPage(targetUrl);
      return { ok: true, state: cloneState() };
    }

    if (state.status === 'downloading' || state.status === 'ready-to-install') {
      return { ok: true, state: cloneState() };
    }

    if (state.status !== 'available' && state.status !== 'error') {
      return {
        ok: false,
        code: 'NO_UPDATE_AVAILABLE',
        message: 'No update is currently available to download.',
        state: cloneState(),
      };
    }

    if (!autoUpdater || typeof autoUpdater.downloadUpdate !== 'function') {
      return {
        ok: false,
        code: 'UPDATER_UNAVAILABLE',
        message: 'In-app updater is not available.',
        state: cloneState(),
      };
    }

    const token = CancellationTokenCtor
      ? new CancellationTokenCtor()
      : createFallbackCancellationToken();
    activeCancellationToken = token;
    downloadCancelledByUser = false;
    lastProgressEmitAt = now();

    emitState({
      status: 'downloading',
      progress: {
        percent: 0,
        bytesPerSecond: 0,
        transferred: 0,
        total: 0,
      },
      error: null,
    });

    try {
      const downloadPromise = autoUpdater.downloadUpdate(token);
      if (downloadPromise && typeof downloadPromise.then === 'function') {
        void downloadPromise.catch((error) => {
          const wasCancelled = downloadCancelledByUser
            || Boolean(token && token.cancelled)
            || isCancellationError(error);
          if (activeCancellationToken === token) {
            activeCancellationToken = null;
          }
          if (wasCancelled) {
            downloadCancelledByUser = false;
            if (state.status !== 'available') {
              emitState({
                status: 'available',
                progress: null,
                error: null,
              });
            }
            return;
          }
          if (state.status !== 'error') {
            emitState({
              status: 'error',
              progress: null,
              error: sanitizeUpdaterError(error),
            });
          }
        });
      }
      return { ok: true, state: cloneState() };
    } catch (error) {
      activeCancellationToken = null;
      const sanitized = sanitizeUpdaterError(error);
      emitState({
        status: 'error',
        progress: null,
        error: sanitized,
      });
      return {
        ok: false,
        code: sanitized.code,
        message: sanitized.message,
        state: cloneState(),
      };
    }
  }

  async function cancelUpdateDownload() {
    if (state.status !== 'downloading' && !activeCancellationToken) {
      return {
        ok: false,
        code: 'NO_ACTIVE_DOWNLOAD',
        message: 'No update download is currently in progress.',
        state: cloneState(),
      };
    }

    downloadCancelledByUser = true;
    const token = activeCancellationToken;
    activeCancellationToken = null;
    if (token && typeof token.cancel === 'function') {
      try {
        token.cancel();
      } catch (_error) {
        // Ignore cancellation token errors.
      }
    }

    emitState({
      status: 'available',
      progress: null,
      error: null,
    });

    return { ok: true, state: cloneState() };
  }

  async function installUpdateNow({ confirmAiInterrupt = false } = {}) {
    if (state.status !== 'ready-to-install') {
      return {
        ok: false,
        code: 'UPDATE_NOT_READY',
        message: 'No downloaded update is ready to install.',
        state: cloneState(),
      };
    }

    if (installInFlight) {
      return {
        ok: false,
        code: 'UPDATE_INSTALL_IN_PROGRESS',
        message: 'Update installation is already in progress.',
        state: cloneState(),
      };
    }

    const quitIntercept = getQuitInterceptState(getRecorderQuitInputs());
    if (quitIntercept && quitIntercept.interceptQuit) {
      return {
        ok: false,
        code: 'UPDATE_BLOCKED_RECORDING',
        message: 'Finish or discard your active recording before restarting to update.',
        state: cloneState(),
      };
    }

    if (hasActiveAudioImport()) {
      return {
        ok: false,
        code: 'UPDATE_BLOCKED_IMPORT_SAVE',
        message: 'Wait for the audio import to finish saving before restarting to update.',
        state: cloneState(),
      };
    }

    if (hasProtectedSummaryWrite()) {
      return {
        ok: false,
        code: 'UPDATE_BLOCKED_SUMMARY_FINALIZING',
        message: 'Wait a moment while your summary finishes saving before restarting to update.',
        state: cloneState(),
      };
    }

    if (hasInFlightAiWork() && !confirmAiInterrupt) {
      return {
        ok: false,
        code: 'UPDATE_CONFIRM_AI_INTERRUPT',
        message: 'Local AI work is in progress. Your audio is saved and will resume after restart.',
        state: cloneState(),
      };
    }

    installInFlight = true;
    try {
      emitState({ status: 'installing', error: null });

      if (hasInFlightAiWork()) {
        await drainAiWorkBeforeQuit();
      }

      // Re-verify recording did not start while draining AI work.
      const postDrainIntercept = getQuitInterceptState(getRecorderQuitInputs());
      if (postDrainIntercept && postDrainIntercept.interceptQuit) {
        emitState({ status: 'ready-to-install', error: null });
        return {
          ok: false,
          code: 'UPDATE_BLOCKED_RECORDING',
          message: 'Finish or discard your active recording before restarting to update.',
          state: cloneState(),
        };
      }

      armUpdateQuit();
      if (autoUpdater && typeof autoUpdater.quitAndInstall === 'function') {
        autoUpdater.quitAndInstall(false, true);
      }

      return { ok: true, state: cloneState() };
    } catch (error) {
      const sanitized = sanitizeUpdaterError(error);
      emitState({ status: 'ready-to-install', error: sanitized });
      return {
        ok: false,
        code: sanitized.code,
        message: sanitized.message,
        state: cloneState(),
      };
    } finally {
      installInFlight = false;
    }
  }

  async function setAutoDownloadUpdates(enabled) {
    const normalized = Boolean(enabled);
    writePreferences({ autoDownload: normalized });
    if (autoUpdater) {
      autoUpdater.autoDownload = normalized;
    }
    const nextState = emitState({ autoDownload: normalized });
    return { ok: true, autoDownload: normalized, state: nextState };
  }

  async function openUpdateReleasePage() {
    const targetUrl = resolveTrustedUpdateUrl(state.releaseUrl) || DEFAULT_RELEASES_URL;
    await openDownloadPage(targetUrl);
    return { ok: true };
  }

  function shouldRunScheduledCheck() {
    return state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error';
  }

  function startPeriodicChecks() {
    stopTimers();

    startupTimer = setTimeout(() => {
      startupTimer = null;
      if (shouldRunScheduledCheck()) {
        void checkForUpdates({ manual: false });
      }
    }, startupDelayMs);
    startupTimer.unref?.();

    periodicTimer = setInterval(() => {
      if (shouldRunScheduledCheck()) {
        void checkForUpdates({ manual: false });
      }
    }, periodicIntervalMs);
    periodicTimer.unref?.();
  }

  function stopTimers() {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (periodicTimer) {
      clearInterval(periodicTimer);
      periodicTimer = null;
    }
  }

  function dispose() {
    stopTimers();
    if (autoUpdater && typeof autoUpdater.removeListener === 'function') {
      for (const [eventName, handler] of attachedListeners) {
        autoUpdater.removeListener(eventName, handler);
      }
    }
    attachedListeners.length = 0;
  }

  function registerIpcHandlers(ipcMain, assertTrustedRendererSender) {
    ipcMain.handle('get-update-state', async (event) => {
      assertTrustedRendererSender(event);
      return cloneState();
    });

    ipcMain.handle('check-for-updates', async (event) => {
      assertTrustedRendererSender(event);
      return checkForUpdates({ manual: true });
    });

    ipcMain.handle('download-update', async (event) => {
      assertTrustedRendererSender(event);
      return downloadUpdate();
    });

    ipcMain.handle('cancel-update-download', async (event) => {
      assertTrustedRendererSender(event);
      return cancelUpdateDownload();
    });

    ipcMain.handle('install-update-now', async (event, options = {}) => {
      assertTrustedRendererSender(event);
      return installUpdateNow(options && typeof options === 'object' ? options : {});
    });

    ipcMain.handle('set-auto-download-updates', async (event, enabled) => {
      assertTrustedRendererSender(event);
      return setAutoDownloadUpdates(enabled);
    });

    ipcMain.handle('open-update-release-page', async (event) => {
      assertTrustedRendererSender(event);
      return openUpdateReleasePage();
    });
  }

  return {
    getState: cloneState,
    checkForUpdates,
    downloadUpdate,
    cancelUpdateDownload,
    installUpdateNow,
    setAutoDownloadUpdates,
    openUpdateReleasePage,
    startPeriodicChecks,
    dispose,
    registerIpcHandlers,
  };
}

module.exports = {
  DEFAULT_RELEASES_URL,
  STARTUP_CHECK_DELAY_MS,
  PERIODIC_CHECK_INTERVAL_MS,
  PROGRESS_THROTTLE_MS,
  INSTALLER_NAME_REGEX,
  resolveUpdateMode,
  buildManualInstallCommand,
  normalizeReleaseNotes,
  resolveTrustedUpdateUrl,
  sanitizeUpdaterError,
  createUpdaterService,
};
