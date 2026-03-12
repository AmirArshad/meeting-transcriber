const path = require('path');
const { pathToFileURL } = require('url');

function buildFileUrl(filePath) {
  const normalizedPath = String(filePath || '').trim();

  if (!normalizedPath) {
    return '';
  }

  if (normalizedPath.startsWith('file://')) {
    return normalizedPath;
  }

  return pathToFileURL(path.resolve(normalizedPath)).toString();
}

function getModelDownloadCacheDir(homeDir) {
  return path.join(homeDir, '.cache', 'huggingface', 'hub');
}

function getMacMLXCacheDir(homeDir) {
  return path.join(homeDir, 'Library', 'Caches', 'meeting-transcriber', 'mlx_models');
}

function getMacMLXModelStorageDirs(modelSize = 'small') {
  const size = modelSize || 'small';

  switch (size) {
    case 'tiny':
      return ['whisper-tiny-mlx'];
    case 'base':
      return ['whisper-base-mlx'];
    case 'small':
      return ['distil-small.en', 'whisper-small-mlx'];
    case 'medium':
      return ['distil-medium.en', 'whisper-medium-mlx'];
    case 'large':
    case 'large-v3':
      return ['distil-large-v3', 'whisper-large-v3-mlx'];
    default:
      return [`distil-${size}.en`, `whisper-${size}-mlx`, `whisper-${size}`];
  }
}

function getModelDownloadPatterns(platform, arch, modelSize = 'small') {
  const size = modelSize || 'small';
  const isMacArm = platform === 'darwin' && arch === 'arm64';

  if (isMacArm) {
    return getMacMLXModelStorageDirs(size);
  }

  return [`models--guillaumekln--faster-whisper-${size}`];
}

function buildModelDownloadCheck({ platform, arch, homeDir, modelSize }) {
  const size = modelSize || 'small';
  const isMacArm = platform === 'darwin' && arch === 'arm64';

  return {
    cacheDir: isMacArm ? getMacMLXCacheDir(homeDir) : getModelDownloadCacheDir(homeDir),
    modelPatterns: getModelDownloadPatterns(platform, arch, size),
    modelSize: size
  };
}

function cacheContainsModel(items, modelPatterns) {
  return modelPatterns.some((pattern) => items.some((item) => item.includes(pattern)));
}

function splitBufferedLines(output, pendingBuffer = '') {
  const combined = `${pendingBuffer}${output}`;
  const normalized = combined.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n');

  return {
    lines: parts.slice(0, -1),
    remainder: parts.at(-1) || ''
  };
}

function normalizeRecorderLevels(levels) {
  return {
    type: 'levels',
    mic: Number(levels.mic ?? levels.micLevel ?? 0),
    desktop: Number(levels.desktop ?? levels.desktopLevel ?? 0)
  };
}

function parseRecorderMessageLine(line) {
  const trimmed = line.trim();

  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);

    if (!parsed || typeof parsed !== 'object') {
      return { kind: 'text', payload: { message: trimmed } };
    }

    if (parsed.type === 'levels') {
      return { kind: 'levels', payload: normalizeRecorderLevels(parsed), raw: parsed };
    }

    if (parsed.type === 'warning') {
      return { kind: 'warning', payload: parsed };
    }

    if (parsed.type === 'error') {
      return { kind: 'error', payload: parsed };
    }

    if (parsed.type === 'event') {
      return { kind: 'event', payload: parsed };
    }

    if (parsed.type === 'status' || parsed.type === 'ready' || parsed.type === 'progress') {
      return { kind: 'status', payload: parsed };
    }

    if (parsed.outputPath || parsed.audioPath) {
      return { kind: 'result', payload: parsed };
    }

    return { kind: 'json', payload: parsed };
  } catch (error) {
    return { kind: 'text', payload: { message: trimmed } };
  }
}

function parseRecorderStdoutChunk(output, pendingBuffer = '') {
  const { lines, remainder } = splitBufferedLines(output, pendingBuffer);
  const messages = [];

  for (const line of lines) {
    const parsed = parseRecorderMessageLine(line);
    if (parsed) {
      messages.push(parsed);
    }
  }

  return { messages, remainder };
}

function classifyRecorderStdoutChunk(output) {
  const { messages } = parseRecorderStdoutChunk(`${output}\n`);
  const firstMessage = messages[0];

  if (!firstMessage) {
    return { type: 'progress', output };
  }

  if (firstMessage.kind === 'levels') {
    return { type: 'levels', levels: firstMessage.payload };
  }

  return {
    type: 'progress',
    output: firstMessage.payload?.message || output
  };
}

function isModelDownloadErrorOutput(output) {
  return output.toLowerCase().includes('error') && !output.includes('non-critical');
}

function getRecordingStopTimeout(recordingStartTime, now = Date.now()) {
  if (!Number.isFinite(recordingStartTime)) {
    return 30000;
  }

  const recordingDurationSeconds = Math.max(0, (now - recordingStartTime) / 1000);
  const recordingMinutes = Math.ceil(recordingDurationSeconds / 60);

  return Math.max(30000, 30000 + (recordingMinutes * 10000));
}

function getQuitInterceptState({ hasRecordingProcess, recordingStartTime, stopInProgress = false }) {
  if (!hasRecordingProcess) {
    return {
      interceptQuit: false,
      state: 'idle',
      progressMessage: null,
    };
  }

  if (stopInProgress) {
    return {
      interceptQuit: true,
      state: 'stopping',
      progressMessage: 'Finishing the current recording before quitting...',
    };
  }

  if (recordingStartTime) {
    return {
      interceptQuit: true,
      state: 'recording',
      progressMessage: 'Stopping and saving the current recording before quitting...',
    };
  }

  return {
    interceptQuit: true,
    state: 'starting',
    progressMessage: 'Stopping the recorder before quitting...',
  };
}

function buildQuitRecordingDialogOptions({ quitState, stopErrorMessage }) {
  const errorDetail = stopErrorMessage && stopErrorMessage.trim()
    ? `${stopErrorMessage.trim()}\n\n`
    : '';

  let title = 'Recorder Still Busy';
  let message = 'Meeting Transcriber could not stop the recorder cleanly.';
  let detail = 'Quitting now may interrupt recorder startup or discard any audio already captured. Keep the app open and try stopping again, or quit anyway and risk losing the recording.';

  if (quitState === 'recording') {
    title = 'Recording Still In Progress';
    message = 'Meeting Transcriber could not stop and save the current recording cleanly.';
    detail = 'Quitting now may discard the in-progress recording. Keep the app open to stop it manually and wait for saving to finish, or quit anyway and risk losing the recording.';
  } else if (quitState === 'stopping') {
    title = 'Recording Save Still Running';
    message = 'Meeting Transcriber is still finishing the current recording.';
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

function dedupeMessages(messages = []) {
  const seen = new Set();
  const unique = [];

  for (const message of messages) {
    const normalized = String(message || '').trim();

    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    unique.push(normalized);
  }

  return unique;
}

function buildRecordingPreflightReport({
  platform,
  deviceCheck = {},
  diskCheck = {},
  audioOutputCheck = {},
}) {
  const errors = Array.isArray(deviceCheck.errors) ? [...deviceCheck.errors] : [];
  const warnings = Array.isArray(deviceCheck.warnings) ? [...deviceCheck.warnings] : [];

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
    warningMessage,
  };
}

module.exports = {
  buildFileUrl,
  buildRecordingPreflightReport,
  buildQuitRecordingDialogOptions,
  buildModelDownloadCheck,
  cacheContainsModel,
  classifyRecorderStdoutChunk,
  dedupeMessages,
  getQuitInterceptState,
  getMacMLXModelStorageDirs,
  getModelDownloadCacheDir,
  getMacMLXCacheDir,
  getModelDownloadPatterns,
  getRecordingStopTimeout,
  isModelDownloadErrorOutput,
  normalizeRecorderLevels,
  parseRecorderMessageLine,
  parseRecorderStdoutChunk,
  splitBufferedLines
};
