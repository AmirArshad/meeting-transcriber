(function initPlatformSelectionHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.platformSelectionHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildPlatformSelectionHelpers() {
  function inferRendererHostFamily(navigatorPlatform) {
    const value = String(navigatorPlatform || '');
    if (value.includes('Mac')) {
      return 'darwin';
    }
    if (value.includes('Win')) {
      return 'win32';
    }
    if (/linux/i.test(value)) {
      return 'linux';
    }
    return 'unknown';
  }

  function getEmptyMicrophoneDeviceGuidance(hostFamily) {
    if (hostFamily === 'darwin') {
      return {
        logMessage: '⚠️ No microphone devices found - permission may not be granted',
        openSettings: 'microphone',
        confirmMessage: 'No microphone devices found!\n\n'
          + 'This usually means microphone permission is not granted.\n\n'
          + 'Would you like to open System Settings to grant permission?\n\n'
          + '1. Go to Privacy & Security → Microphone\n'
          + '2. Grant permission to AvaNevis\n'
          + '3. Restart the app',
      };
    }
    return {
      logMessage: '⚠️ No microphone devices found',
      openSettings: null,
      confirmMessage: null,
    };
  }

  function getRecordingPermissionFailureGuidance(hostFamily) {
    if (hostFamily === 'darwin') {
      return {
        kind: 'macos-settings',
        confirmMessage: 'Recording failed. Permission might be missing.\n\n'
          + 'Would you like to open System Settings to check permissions?\n\n'
          + 'Check both Microphone and Screen Recording permissions.',
        openSettings: 'screen',
      };
    }
    if (hostFamily === 'win32') {
      return {
        kind: 'alert',
        alertMessage: 'Recording failed. Please check:\n\n'
          + '1. Microphone permissions are granted to this app\n'
          + '2. Selected devices are not in use by another application\n'
          + '3. Devices are properly connected\n\n'
          + '• Grant microphone permissions in Windows Settings\n'
          + '• Restart the application\n'
          + '• Try different audio devices',
      };
    }
    return {
      kind: 'alert',
      alertMessage: 'Recording failed. Please check:\n\n'
        + '1. The selected microphone is connected and not in use\n'
        + '2. The PulseAudio/PipeWire session is running\n'
        + '3. Microphone access is allowed for this app\n\n'
        + 'Then refresh devices or restart AvaNevis.',
    };
  }

  function toOpaqueDeviceId(value) {
    if (value == null) {
      return '';
    }
    return String(value);
  }

  function decorateDesktopDevices(loopbacks, hostFamily) {
    const devices = Array.isArray(loopbacks) ? loopbacks.slice() : [];
    if (hostFamily !== 'linux') {
      return devices;
    }
    return [
      {
        id: 'none',
        name: 'None (microphone only)',
        sample_rate: 48000,
        channels: 0,
        host_api: 'PulseAudio',
      },
      ...devices,
    ];
  }

  return {
    inferRendererHostFamily,
    getEmptyMicrophoneDeviceGuidance,
    getRecordingPermissionFailureGuidance,
    toOpaqueDeviceId,
    decorateDesktopDevices,
  };
}));
