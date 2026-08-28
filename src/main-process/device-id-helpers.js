'use strict';

const LINUX_DESKTOP_OFF_ID = 'none';
const MACOS_SYSTEM_AUDIO_LOOPBACK_ID = -1;

function toOpaqueDeviceId(value) {
  if (value == null) {
    return '';
  }
  return String(value);
}

function deviceIdsEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  return String(left) === String(right);
}

function isDesktopCaptureOffId(deviceId) {
  return toOpaqueDeviceId(deviceId) === LINUX_DESKTOP_OFF_ID;
}

function isMacOSSystemAudioLoopbackId(deviceId) {
  return deviceIdsEqual(deviceId, MACOS_SYSTEM_AUDIO_LOOPBACK_ID);
}

function coerceIntegerDeviceId(value) {
  if (Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function findDeviceById(devices, deviceId) {
  if (!Array.isArray(devices)) {
    return null;
  }
  return devices.find((device) => deviceIdsEqual(device?.id, deviceId)) || null;
}

function extractDeviceManagerError(stderr) {
  const text = String(stderr || '');
  const match = text.match(/^ERROR:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function evaluateSelectedDevices(data, { micId, loopbackId, platform }) {
  const errors = [];
  const warnings = [];
  const inputDevices = data?.input_devices || [];
  const loopbackDevices = data?.loopback_devices || [];
  const micDevice = findDeviceById(inputDevices, micId);

  if (!micDevice) {
    errors.push(`Microphone device (ID: ${micId}) not found. It may have been disconnected.`);
  }

  let loopbackDevice = null;
  if (platform === 'darwin') {
    if (!isMacOSSystemAudioLoopbackId(loopbackId)) {
      warnings.push('Non-standard loopback device selected on macOS.');
    }
    loopbackDevice = isMacOSSystemAudioLoopbackId(loopbackId)
      ? { name: 'System Audio (ScreenCaptureKit)', id: MACOS_SYSTEM_AUDIO_LOOPBACK_ID }
      : findDeviceById(loopbackDevices, loopbackId);
  } else if (platform === 'linux') {
    if (isDesktopCaptureOffId(loopbackId)) {
      loopbackDevice = { name: 'None (microphone only)', id: LINUX_DESKTOP_OFF_ID };
    } else {
      loopbackDevice = findDeviceById(loopbackDevices, loopbackId);
      if (!loopbackDevice) {
        errors.push(`Desktop audio device (ID: ${loopbackId}) not found. It may have been disconnected.`);
      }
    }
  } else {
    loopbackDevice = findDeviceById(loopbackDevices, loopbackId);
    const numericLoopbackId = coerceIntegerDeviceId(loopbackId);
    if (numericLoopbackId != null && numericLoopbackId >= 0 && !loopbackDevice) {
      errors.push(`Desktop audio device (ID: ${loopbackId}) not found. It may have been disconnected.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    devices: {
      mic: micDevice || null,
      loopback: loopbackDevice,
    },
  };
}

module.exports = {
  LINUX_DESKTOP_OFF_ID,
  MACOS_SYSTEM_AUDIO_LOOPBACK_ID,
  toOpaqueDeviceId,
  deviceIdsEqual,
  isDesktopCaptureOffId,
  isMacOSSystemAudioLoopbackId,
  coerceIntegerDeviceId,
  findDeviceById,
  extractDeviceManagerError,
  evaluateSelectedDevices,
};
