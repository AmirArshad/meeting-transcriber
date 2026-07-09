'use strict';

const { dedupeMessages } = require('./ai-progress-helpers');

const MACOS_PERMISSION_CHECK_TIMEOUT_MS = 8000;

function buildQuitRecordingDialogOptions({ quitState, stopErrorMessage }) {
  const errorDetail = stopErrorMessage && stopErrorMessage.trim()
    ? `${stopErrorMessage.trim()}\n\n`
    : '';

  let title = 'Recorder Still Busy';
  let message = 'AvaNevis could not stop the recorder cleanly.';
  let detail = 'Quitting now may interrupt recorder startup or discard any audio already captured. Keep the app open and try stopping again, or quit anyway and risk losing the recording.';

  if (quitState === 'recording') {
    title = 'Recording Still In Progress';
    message = 'AvaNevis could not stop and save the current recording cleanly.';
    detail = 'Quitting now may discard the in-progress recording. Keep the app open to stop it manually and wait for saving to finish, or quit anyway and risk losing the recording.';
  } else if (quitState === 'stopping') {
    title = 'Recording Save Still Running';
    message = 'AvaNevis is still finishing the current recording.';
    detail = 'Quitting now may interrupt post-processing before the recording is fully saved. Keep the app open and let it finish, or quit anyway and risk losing the recording.';
  }

  return {
    type: 'warning',
    title,
    message,
    detail: `${errorDetail}${detail}`,
    buttons: ['Keep App Open', 'Quit Anyway'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

function buildPermissionErrorMessage(label, permissionCheck = {}) {
  const parts = [`${label} permission is not granted.`];

  if (permissionCheck.error) {
    parts.push(String(permissionCheck.error).trim());
  }

  if (permissionCheck.help) {
    parts.push(String(permissionCheck.help).trim());
  }

  return parts.join(' ');
}

function buildDesktopAudioAvailabilityError(desktopAudioCheck = {}) {
  const parts = ['Desktop audio capture is unavailable.'];

  if (desktopAudioCheck.error) {
    parts.push(String(desktopAudioCheck.error).trim());
  }

  if (desktopAudioCheck.help) {
    parts.push(String(desktopAudioCheck.help).trim());
  }

  return parts.join(' ');
}

function buildMacOSPermissionCheckFailureStatus(warning) {
  return {
    platform: 'darwin',
    all_granted: false,
    warning,
    microphone: { granted: true },
    screen_recording: { granted: true },
    desktop_audio: {
      available: false,
      error: 'macOS recording permission and desktop-audio preflight could not be verified.',
      help: 'Restart AvaNevis. If this persists, reinstall the app or rebuild the macOS package.',
    },
  };
}

function buildRecordingPreflightReport({
  platform,
  deviceCheck = {},
  diskCheck = {},
  audioOutputCheck = {},
  permissionCheck = null,
}) {
  const errors = Array.isArray(deviceCheck.errors) ? [...deviceCheck.errors] : [];
  const warnings = Array.isArray(deviceCheck.warnings) ? [...deviceCheck.warnings] : [];
  let permissionStatus = null;

  if (deviceCheck.valid === false && errors.length === 0) {
    errors.push('Selected audio devices failed validation.');
  }

  if (diskCheck.warning) {
    warnings.push(
      diskCheck.availableGB
        ? `Only ${diskCheck.availableGB} GB free in the recordings folder. Recording and saving may fail.`
        : 'Low disk space in the recordings folder. Recording and saving may fail.'
    );
  }

  if (audioOutputCheck.warning) {
    warnings.push(audioOutputCheck.warning);
  }

  if (audioOutputCheck.suggestion) {
    warnings.push(`Suggestion: ${audioOutputCheck.suggestion}`);
  }

  if (platform === 'darwin' && permissionCheck) {
    const missingMicrophone = permissionCheck.microphone?.granted === false;
    const missingScreenRecording = permissionCheck.screen_recording?.granted === false;
    const missingDesktopAudio = permissionCheck.desktop_audio?.available === false;

    if (missingMicrophone) {
      errors.push(buildPermissionErrorMessage('Microphone', permissionCheck.microphone));
    }

    if (missingScreenRecording) {
      errors.push(buildPermissionErrorMessage('Screen Recording', permissionCheck.screen_recording));
    }

    if (missingDesktopAudio) {
      errors.push(buildDesktopAudioAvailabilityError(permissionCheck.desktop_audio));
    }

    if (permissionCheck.warning) {
      warnings.push(permissionCheck.warning);
    }

    permissionStatus = {
      missingMicrophone,
      missingScreenRecording,
      missingDesktopAudio,
      settingsTarget: missingMicrophone && missingScreenRecording
        ? 'privacy'
        : (missingMicrophone ? 'microphone' : (missingScreenRecording ? 'screen' : null)),
    };
  }

  const normalizedErrors = dedupeMessages(errors);
  const normalizedWarnings = dedupeMessages(warnings);
  const isMac = platform === 'darwin';

  const guidance = isMac
    ? [
      'Refresh your audio devices and try again.',
      'If the microphone is missing, check System Settings > Privacy & Security > Microphone.',
      'For desktop audio on macOS, keep System Audio (ScreenCaptureKit) selected.',
    ]
    : [
      'Refresh your audio devices and try again.',
      'Reconnect the selected microphone or desktop audio device if it was unplugged.',
    ];

  const errorMessage = normalizedErrors.length
    ? [
      'Recording checks failed:',
      ...normalizedErrors.map((message) => `- ${message}`),
      '',
      ...guidance,
    ].join('\n')
    : null;

  const warningMessage = normalizedWarnings.length
    ? [
      'Recording checks found warnings:',
      ...normalizedWarnings.map((message) => `- ${message}`),
      '',
      'Continue anyway?',
    ].join('\n')
    : null;

  return {
    canStart: normalizedErrors.length === 0,
    errors: normalizedErrors,
    warnings: normalizedWarnings,
    errorMessage,
    permissionStatus,
    warningMessage,
  };
}

module.exports = {
  buildRecordingPreflightReport,
  buildPermissionErrorMessage,
  buildQuitRecordingDialogOptions,
  buildDesktopAudioAvailabilityError,
  buildMacOSPermissionCheckFailureStatus,
  MACOS_PERMISSION_CHECK_TIMEOUT_MS,
};
