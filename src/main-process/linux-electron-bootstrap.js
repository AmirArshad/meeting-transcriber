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

module.exports = {
  applyLinuxElectronCommandLineSwitches,
  getSelectedStorageBackend,
  probeSecretStorage,
  resolveLinuxPasswordStore,
};
