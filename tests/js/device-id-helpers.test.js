'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LINUX_DESKTOP_OFF_ID,
  coerceIntegerDeviceId,
  decorateDesktopDevices,
  toOpaqueDeviceId,
} = (() => {
  const main = require('../../src/main-process/device-id-helpers');
  const renderer = require('../../src/renderer/platform-selection-helpers');
  return { ...main, ...renderer };
})();

const {
  deviceIdsEqual,
  evaluateSelectedDevices,
  extractDeviceManagerError,
  isDesktopCaptureOffId,
} = require('../../src/main-process/device-id-helpers');


test('opaque Pulse IDs round-trip without parseInt coercion', () => {
  assert.equal(toOpaqueDeviceId('pulse-source:alsa_input.usb-mic'), 'pulse-source:alsa_input.usb-mic');
  assert.equal(toOpaqueDeviceId('pulse-monitor:alsa_output.pci-0.monitor'), 'pulse-monitor:alsa_output.pci-0.monitor');
  assert.equal(toOpaqueDeviceId(0), '0');
  assert.equal(toOpaqueDeviceId(-1), '-1');
  assert.equal(Number.isNaN(parseInt('pulse-source:alsa_input.usb-mic', 10)), true);
});

test('deviceIdsEqual treats numeric strings as the same Windows/macOS id', () => {
  assert.equal(deviceIdsEqual(0, '0'), true);
  assert.equal(deviceIdsEqual(-1, '-1'), true);
  assert.equal(deviceIdsEqual('pulse-source:mic', 'pulse-source:mic'), true);
  assert.equal(deviceIdsEqual('pulse-source:mic', 'pulse-monitor:mic'), false);
});

test('coerceIntegerDeviceId only accepts integer-looking values', () => {
  assert.equal(coerceIntegerDeviceId(3), 3);
  assert.equal(coerceIntegerDeviceId('3'), 3);
  assert.equal(coerceIntegerDeviceId('-1'), -1);
  assert.equal(coerceIntegerDeviceId('pulse-source:mic'), null);
  assert.equal(coerceIntegerDeviceId('none'), null);
  assert.equal(coerceIntegerDeviceId('3.5'), null);
});

test('evaluateSelectedDevices accepts Pulse IDs and none on Linux', () => {
  const data = {
    input_devices: [{ id: 'pulse-source:avanevis_mic', name: 'Mic' }],
    loopback_devices: [{ id: 'pulse-monitor:avanevis_desktop.monitor', name: 'Desktop' }],
  };

  const ok = evaluateSelectedDevices(data, {
    micId: 'pulse-source:avanevis_mic',
    loopbackId: 'pulse-monitor:avanevis_desktop.monitor',
    platform: 'linux',
  });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.errors, []);

  const off = evaluateSelectedDevices(data, {
    micId: 'pulse-source:avanevis_mic',
    loopbackId: LINUX_DESKTOP_OFF_ID,
    platform: 'linux',
  });
  assert.equal(off.valid, true);
  assert.equal(isDesktopCaptureOffId(off.devices.loopback.id), true);

  const missing = evaluateSelectedDevices(data, {
    micId: 'pulse-source:missing',
    loopbackId: 'pulse-monitor:missing',
    platform: 'linux',
  });
  assert.equal(missing.valid, false);
  assert.equal(missing.errors.length, 2);
});

test('evaluateSelectedDevices still matches Windows numeric ids sent as strings', () => {
  const data = {
    input_devices: [{ id: 0, name: 'Mic' }],
    loopback_devices: [{ id: 1, name: 'Loopback' }],
  };
  const result = evaluateSelectedDevices(data, {
    micId: '0',
    loopbackId: '1',
    platform: 'win32',
  });
  assert.equal(result.valid, true);
  assert.equal(result.devices.mic.name, 'Mic');
  assert.equal(result.devices.loopback.name, 'Loopback');
});

test('evaluateSelectedDevices keeps macOS ScreenCaptureKit -1 as a string-safe id', () => {
  const data = {
    input_devices: [{ id: 2, name: 'Built-in' }],
    loopback_devices: [],
  };
  const result = evaluateSelectedDevices(data, {
    micId: '2',
    loopbackId: '-1',
    platform: 'darwin',
  });
  assert.equal(result.valid, true);
  assert.equal(result.devices.loopback.id, -1);
  assert.deepEqual(result.warnings, []);
});

test('extractDeviceManagerError reads the Python ERROR: line', () => {
  assert.equal(
    extractDeviceManagerError('noise\nERROR: PulseAudio/PipeWire is not running. Start the session audio service and try again.\n'),
    'PulseAudio/PipeWire is not running. Start the session audio service and try again.',
  );
  assert.equal(extractDeviceManagerError('no structured error'), null);
});

test('decorateDesktopDevices prepends none only on Linux', () => {
  const loopbacks = [{ id: 'pulse-monitor:out.monitor', name: 'Out', sample_rate: 48000 }];
  const linux = decorateDesktopDevices(loopbacks, 'linux');
  assert.equal(linux[0].id, 'none');
  assert.equal(linux[1].id, 'pulse-monitor:out.monitor');
  assert.deepEqual(decorateDesktopDevices(loopbacks, 'win32'), loopbacks);
});
