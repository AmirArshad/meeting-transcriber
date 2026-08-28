'use strict';

/**
 * Linux Electron startup switches and secret-storage probe.
 *
 * password-store must be appended before app.whenReady(). Hyprland is not on
 * Chromium's XDG_CURRENT_DESKTOP list, so the default backend is basic_text.
 */

function resolveLinuxPasswordStore(env = {}) {
  const desktop = String(env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const isKde = desktop.includes('kde') || Boolean(env.KDE_FULL_SESSION);
  return isKde ? 'kwallet6' : 'gnome-libsecret';
}

function sanitizeDiagnosticLabel(value, maxLength = 120) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function classifyLinuxDesktopEnvironment(env = {}) {
  const desktop = String(env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  if (!desktop && env.KDE_FULL_SESSION) return 'kde';
  if (!desktop) return 'unknown';
  if (desktop.includes('kde') || desktop.includes('plasma')) return 'kde';
  if (desktop.includes('hyprland')) return 'hyprland';
  if (desktop.includes('cosmic')) return 'cosmic';
  if (desktop.includes('sway')) return 'sway';
  if (desktop.includes('niri')) return 'niri';
  if (desktop.includes('cinnamon')) return 'cinnamon';
  if (desktop.includes('xfce')) return 'xfce';
  if (desktop.includes('gnome')) return 'gnome';
  return 'other';
}

function applyLinuxElectronCommandLineSwitches(commandLine, env = {}) {
  if (!commandLine || typeof commandLine.appendSwitch !== 'function') {
    return {
      passwordStore: null,
      ozonePlatformHint: null,
    };
  }

  const passwordStore = resolveLinuxPasswordStore(env);
  commandLine.appendSwitch('password-store', passwordStore);
  commandLine.appendSwitch('ozone-platform-hint', 'auto');
  return {
    passwordStore,
    ozonePlatformHint: 'auto',
  };
}

function getSelectedStorageBackend(safeStorage) {
  if (!safeStorage || typeof safeStorage.getSelectedStorageBackend !== 'function') {
    return null;
  }
  try {
    const backend = safeStorage.getSelectedStorageBackend();
    return backend == null || backend === '' ? null : String(backend);
  } catch (_error) {
    return null;
  }
}

function probeSecretStorage(safeStorage) {
  const backend = getSelectedStorageBackend(safeStorage);
  let encryptionAvailable = false;
  if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function') {
    try {
      encryptionAvailable = Boolean(safeStorage.isEncryptionAvailable());
    } catch (_error) {
      encryptionAvailable = false;
    }
  }
  return {
    backend,
    encryptionAvailable,
    isBasicText: backend === 'basic_text',
  };
}

function buildLinuxEnvironmentDiagnostics({
  env = {},
  safeStorage = null,
  commandLine = null,
  argv = [],
} = {}) {
  const secretStorage = probeSecretStorage(safeStorage);
  const getSwitchValue = (name) => {
    if (!commandLine || typeof commandLine.getSwitchValue !== 'function') return null;
    const value = sanitizeDiagnosticLabel(commandLine.getSwitchValue(name));
    return value || null;
  };
  return {
    desktop: sanitizeDiagnosticLabel(env.XDG_CURRENT_DESKTOP) || null,
    desktopFamily: classifyLinuxDesktopEnvironment(env),
    sessionType: sanitizeDiagnosticLabel(env.XDG_SESSION_TYPE) || null,
    hasWaylandDisplay: Boolean(env.WAYLAND_DISPLAY),
    hasX11Display: Boolean(env.DISPLAY),
    requestedPasswordStore: resolveLinuxPasswordStore(env),
    selectedSecretBackend: secretStorage.backend,
    secretEncryptionAvailable: secretStorage.encryptionAvailable,
    ozonePlatform: getSwitchValue('ozone-platform'),
    ozonePlatformHint: getSwitchValue('ozone-platform-hint'),
    sandboxDisabled: Array.isArray(argv) && argv.includes('--no-sandbox'),
  };
}

const SAFESTORAGE_SMOKE_CANARY = 'avanevis-linux-phase5-safestorage';

function runLinuxSafeStorageSmoke(safeStorage) {
  const probe = probeSecretStorage(safeStorage);
  let roundTrip = false;
  let error = null;
  if (
    probe.encryptionAvailable
    && !probe.isBasicText
    && safeStorage
    && typeof safeStorage.encryptString === 'function'
    && typeof safeStorage.decryptString === 'function'
  ) {
    try {
      const encrypted = safeStorage.encryptString(SAFESTORAGE_SMOKE_CANARY);
      roundTrip = safeStorage.decryptString(encrypted) === SAFESTORAGE_SMOKE_CANARY;
    } catch (err) {
      error = err && err.message ? String(err.message) : String(err);
    }
  }
  return {
    ...probe,
    roundTrip,
    ok: Boolean(roundTrip && probe.encryptionAvailable && !probe.isBasicText),
    error,
  };
}

module.exports = {
  SAFESTORAGE_SMOKE_CANARY,
  applyLinuxElectronCommandLineSwitches,
  buildLinuxEnvironmentDiagnostics,
  classifyLinuxDesktopEnvironment,
  getSelectedStorageBackend,
  probeSecretStorage,
  resolveLinuxPasswordStore,
  runLinuxSafeStorageSmoke,
};
