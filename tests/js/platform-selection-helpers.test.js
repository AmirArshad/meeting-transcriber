'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferRendererHostFamily,
  getEmptyMicrophoneDeviceGuidance,
  getRecordingPermissionFailureGuidance,
  decorateDesktopDevices,
  isDesktopCaptureDisabledSelection,
} = require('../../src/renderer/platform-selection-helpers');

test('isDesktopCaptureDisabledSelection matches only the synthetic desktop-off entry', () => {
  assert.equal(isDesktopCaptureDisabledSelection('none'), true);

  // Real device ids, sentinels, and empty selections are not "desktop off".
  for (const value of [
    'pulse-monitor:alsa_output.pci.monitor',
    'pulse-source:alsa_input.usb-mic',
    '',
    '-1',
    -1,
    0,
    null,
    undefined,
    'None',
  ]) {
    assert.equal(isDesktopCaptureDisabledSelection(value), false, String(value));
  }
});

test('the Linux desktop-off option id matches isDesktopCaptureDisabledSelection', () => {
  // The sentinel is defined once; keep the option and the predicate in step.
  const [first] = decorateDesktopDevices(
    [{ id: 'pulse-monitor:out.monitor', name: 'Desktop' }],
    'linux',
  );
  assert.equal(isDesktopCaptureDisabledSelection(first.id), true);

  const windowsDevices = decorateDesktopDevices(
    [{ id: 3, name: 'Loopback' }],
    'win32',
  );
  assert.equal(windowsDevices.length, 1);
  assert.equal(isDesktopCaptureDisabledSelection(windowsDevices[0].id), false);
});

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
  assert.match(linux.alertMessage, /pipewire-pulse/);
  assert.match(linux.alertMessage, /user audio session/);
  assert.equal(linux.alertMessage.includes('Windows Settings'), false);
});

test('toOpaqueDeviceId and decorateDesktopDevices keep Pulse IDs as strings', () => {
  const {
    toOpaqueDeviceId,
    decorateDesktopDevices,
  } = require('../../src/renderer/platform-selection-helpers');

  assert.equal(toOpaqueDeviceId(4), '4');
  assert.equal(toOpaqueDeviceId('pulse-source:mic'), 'pulse-source:mic');
  const decorated = decorateDesktopDevices([{ id: 'pulse-monitor:out.monitor', name: 'Out', sample_rate: 48000 }], 'linux');
  assert.equal(decorated[0].id, 'none');
  // The desktop-off entry is synthetic: no sample rate, so the dropdown does
  // not render "None (microphone only) (48000 Hz)".
  assert.equal(decorated[0].sample_rate, null);
  assert.equal(decorated[1].sample_rate, 48000);
  assert.equal(decorateDesktopDevices([{ id: 1, name: 'Loopback' }], 'win32')[0].id, 1);
});

test('resolveInitialDeviceSelection preserves a saved selection and uses a valid system default only when unset', () => {
  const {
    resolveInitialDeviceSelection,
  } = require('../../src/renderer/platform-selection-helpers');
  const devices = [
    { id: 'pulse-source:saved' },
    { id: 'pulse-source:default' },
  ];

  assert.equal(
    resolveInitialDeviceSelection({ savedId: 'pulse-source:saved', defaultId: 'pulse-source:default', devices }),
    'pulse-source:saved',
  );
  assert.equal(
    resolveInitialDeviceSelection({ savedId: undefined, defaultId: 'pulse-source:default', devices }),
    'pulse-source:default',
  );
  assert.equal(
    resolveInitialDeviceSelection({ savedId: undefined, defaultId: 'pulse-source:missing', devices }),
    '',
  );
  assert.equal(
    resolveInitialDeviceSelection({ savedId: 'pulse-source:missing', defaultId: 'pulse-source:default', devices }),
    '',
  );
  assert.equal(
    resolveInitialDeviceSelection({ savedId: '', defaultId: 'pulse-source:default', devices }),
    '',
  );
});

test('resolveInitialDeviceSelection stringifies numeric ids and ignores a -1 default sentinel', () => {
  const {
    resolveInitialDeviceSelection,
  } = require('../../src/renderer/platform-selection-helpers');
  const macDevices = [
    { id: 3 },
    { id: -1 },
  ];

  assert.equal(
    resolveInitialDeviceSelection({ savedId: undefined, defaultId: 3, devices: macDevices }),
    '3',
  );
  assert.equal(
    resolveInitialDeviceSelection({ savedId: 5, defaultId: 3, devices: [{ id: 3 }, { id: 5 }] }),
    '5',
  );
  assert.equal(
    resolveInitialDeviceSelection({ savedId: undefined, defaultId: -1, devices: macDevices }),
    '',
  );
  assert.equal(
    resolveInitialDeviceSelection({ savedId: -1, defaultId: 3, devices: macDevices }),
    '-1',
  );
});
