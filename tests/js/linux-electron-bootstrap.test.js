'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyLinuxElectronCommandLineSwitches,
  getSelectedStorageBackend,
  probeSecretStorage,
  resolveLinuxPasswordStore,
} = require('../../src/main-process/linux-electron-bootstrap');

test('Linux password-store is gnome-libsecret except KDE → kwallet6', () => {
  assert.equal(resolveLinuxPasswordStore({ XDG_CURRENT_DESKTOP: 'Hyprland' }), 'gnome-libsecret');
  assert.equal(resolveLinuxPasswordStore({ XDG_CURRENT_DESKTOP: 'sway:wlroots' }), 'gnome-libsecret');
  assert.equal(resolveLinuxPasswordStore({}), 'gnome-libsecret');
  assert.equal(resolveLinuxPasswordStore({ XDG_CURRENT_DESKTOP: 'KDE' }), 'kwallet6');
  assert.equal(resolveLinuxPasswordStore({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), 'gnome-libsecret');
  assert.equal(resolveLinuxPasswordStore({ KDE_FULL_SESSION: 'true' }), 'kwallet6');
});

test('Linux command-line switches append password-store and ozone-platform-hint=auto', () => {
  const switches = [];
  const commandLine = {
    appendSwitch(name, value) {
      switches.push([name, value]);
    },
  };
  const result = applyLinuxElectronCommandLineSwitches(commandLine, {
    XDG_CURRENT_DESKTOP: 'Hyprland',
  });
  assert.deepEqual(switches, [
    ['password-store', 'gnome-libsecret'],
    ['ozone-platform-hint', 'auto'],
  ]);
  assert.equal(result.passwordStore, 'gnome-libsecret');
  assert.equal(result.ozonePlatformHint, 'auto');
});

test('getSelectedStorageBackend is exposed for later preflights and rejects basic_text probes', () => {
  assert.equal(getSelectedStorageBackend(null), null);
  assert.equal(getSelectedStorageBackend({}), null);
  assert.equal(getSelectedStorageBackend({
    getSelectedStorageBackend: () => 'gnome_libsecret',
  }), 'gnome_libsecret');

  const probe = probeSecretStorage({
    getSelectedStorageBackend: () => 'basic_text',
    isEncryptionAvailable: () => true,
  });
  assert.equal(probe.backend, 'basic_text');
  assert.equal(probe.encryptionAvailable, true);
  assert.equal(probe.isBasicText, true);

  const real = probeSecretStorage({
    getSelectedStorageBackend: () => 'gnome_libsecret',
    isEncryptionAvailable: () => true,
  });
  assert.equal(real.isBasicText, false);
});

const {
  getUnsupportedPlatformCudaProbeError,
  buildUnsupportedPlatformCudaStatus,
} = require('../../src/main-process/cuda-runtime-helpers');

test('Linux CUDA probe reports unavailable and does not advertise install', () => {
  const linux = buildUnsupportedPlatformCudaStatus('linux');
  assert.equal(linux.installed, false);
  assert.equal(linux.deviceAvailable, false);
  assert.equal(linux.runtimeLoadable, false);
  assert.equal(linux.statusCode, 'unsupportedPlatform');
  assert.match(linux.error, /not available on Linux in this version/);
  assert.match(linux.error, /CPU faster-whisper/);
  assert.equal(
    getUnsupportedPlatformCudaProbeError('linux'),
    'CUDA is not available on Linux in this version. Transcription uses the CPU faster-whisper runtime.',
  );
  assert.match(getUnsupportedPlatformCudaProbeError('darwin'), /only supported on Windows/);
});
