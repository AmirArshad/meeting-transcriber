'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferRendererHostFamily,
  getEmptyMicrophoneDeviceGuidance,
  getRecordingPermissionFailureGuidance,
} = require('../../src/renderer/platform-selection-helpers');

test('inferRendererHostFamily distinguishes Mac, Windows, and Linux navigator platforms', () => {
  assert.equal(inferRendererHostFamily('MacIntel'), 'darwin');
  assert.equal(inferRendererHostFamily('Win32'), 'win32');
  assert.equal(inferRendererHostFamily('Linux x86_64'), 'linux');
  assert.equal(inferRendererHostFamily('Unknown'), 'unknown');
});

test('empty-microphone guidance opens System Settings only on macOS', () => {
  const mac = getEmptyMicrophoneDeviceGuidance('darwin');
  assert.match(mac.logMessage, /permission may not be granted/);
  assert.equal(mac.openSettings, 'microphone');
  assert.match(mac.confirmMessage, /System Settings/);

  const windows = getEmptyMicrophoneDeviceGuidance('win32');
  assert.equal(windows.openSettings, null);
  assert.equal(windows.confirmMessage, null);
  assert.match(windows.logMessage, /No microphone devices found/);

  const linux = getEmptyMicrophoneDeviceGuidance('linux');
  assert.equal(linux.openSettings, null);
  assert.equal(linux.confirmMessage, null);
  assert.equal(linux.logMessage, windows.logMessage);
});

test('recording permission failure copy is platform-specific and does not treat Linux as Windows', () => {
  const mac = getRecordingPermissionFailureGuidance('darwin');
  assert.equal(mac.kind, 'macos-settings');
  assert.equal(mac.openSettings, 'screen');

  const windows = getRecordingPermissionFailureGuidance('win32');
  assert.equal(windows.kind, 'alert');
  assert.match(windows.alertMessage, /Windows Settings/);

  const linux = getRecordingPermissionFailureGuidance('linux');
  assert.equal(linux.kind, 'alert');
  assert.match(linux.alertMessage, /PulseAudio\/PipeWire/);
  assert.equal(linux.alertMessage.includes('Windows Settings'), false);
});
