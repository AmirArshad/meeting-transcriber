'use strict';

const path = require('path');
const { splitBufferedLines } = require('./ai-progress-helpers');

const SPAWN_LOG_BUFFER_MAX_CHARS = 512 * 1024;
const SPAWN_JSON_RESULT_BUFFER_MAX_CHARS = 32 * 1024 * 1024;
const UPDATER_HTTP_RESPONSE_MAX_CHARS = 1024 * 1024;

function appendCappedSpawnLogBuffer(buffer, chunk, maxChars = SPAWN_LOG_BUFFER_MAX_CHARS) {
  const combined = `${buffer || ''}${String(chunk || '')}`;
  if (combined.length <= maxChars) {
    return combined;
  }
  return combined.slice(combined.length - maxChars);
}

function appendSpawnJsonResultBuffer(buffer, chunk, maxChars = SPAWN_JSON_RESULT_BUFFER_MAX_CHARS) {
  const current = buffer || '';
  const nextChunk = String(chunk || '');
  const nextLength = current.length + nextChunk.length;
  if (nextLength > maxChars) {
    return {
      buffer: current,
      overflowed: true,
    };
  }
  return {
    buffer: current + nextChunk,
    overflowed: false,
  };
}

function isRecorderBusy({ pythonProcess = null, recordingStopPromise = null } = {}) {
  return Boolean(pythonProcess || recordingStopPromise);
}

function buildRecorderBusyResponse() {
  return {
    success: false,
    code: 'RECORDER_BUSY',
    message: 'Recorder is already active or finishing a previous recording.',
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

    if (
      parsed.type === 'status' ||
      parsed.type === 'ready' ||
      parsed.type === 'progress' ||
      parsed.type === 'content_info' ||
      parsed.type === 'stream_config' ||
      parsed.type === 'audio_format'
    ) {
      return { kind: 'status', payload: parsed };
    }

    if (parsed.success === false || parsed.outputPath || parsed.audioPath) {
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

function getRecorderResultAudioPath(recordingInfo) {
  if (!recordingInfo || typeof recordingInfo !== 'object') {
    return null;
  }

  const audioPath = recordingInfo.audioPath || recordingInfo.outputPath;
  return audioPath ? String(audioPath) : null;
}

function findRecorderResultPayload(stdoutData) {
  const lines = String(stdoutData || '').split(/\r?\n/).filter((line) => line.trim());

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object' && (
        parsed.success === false ||
        getRecorderResultAudioPath(parsed)
      )) {
        return parsed;
      }
    } catch (error) {
      // Ignore progress text and malformed partial lines.
    }
  }

  return null;
}

function normalizeRecordingStopPayload(recordingInfo, { existsSync = () => false } = {}) {
  if (!recordingInfo || typeof recordingInfo !== 'object') {
    return null;
  }

  if (recordingInfo.success === false) {
    const failedPath = getRecorderResultAudioPath(recordingInfo);
    const recoveredPath = failedPath && existsSync(failedPath) ? failedPath : null;
    return {
      success: false,
      code: recordingInfo.code || 'RECORDING_FAILED',
      message: recordingInfo.message || 'Recording failed.',
      duration: recordingInfo.duration,
      desktopDiagnostics: recordingInfo.desktopDiagnostics,
      // Windows may still emit audioPath after a processing failure; preserve it
      // so quit/stop can save the recording when the file exists on disk.
      ...(recoveredPath ? { audioPath: recoveredPath } : {}),
    };
  }

  const filePath = getRecorderResultAudioPath(recordingInfo);
  if (filePath && existsSync(filePath)) {
    return {
      success: true,
      audioPath: filePath,
      duration: recordingInfo.duration,
      desktopDiagnostics: recordingInfo.desktopDiagnostics,
    };
  }

  if (filePath) {
    return {
      error: new Error(`Recording file not found: ${filePath}`),
    };
  }

  return null;
}

function parseRecordingStopResult(stdoutData, { existsSync = () => false, getRecordingsDir: getRecordingsDirFn } = {}) {
  const recordingInfo = findRecorderResultPayload(stdoutData);
  const normalized = normalizeRecordingStopPayload(recordingInfo, { existsSync });

  if (normalized?.error) {
    throw normalized.error;
  }
  if (normalized) {
    return normalized;
  }

  const recordingsDir = typeof getRecordingsDirFn === 'function'
    ? getRecordingsDirFn()
    : null;

  if (!recordingsDir) {
    throw new Error('Recording completed but output file not found.');
  }

  const opusPath = path.join(recordingsDir, 'temp.opus');

  if (existsSync(opusPath)) {
    return { success: true, audioPath: opusPath };
  }

  throw new Error('Recording completed but output file not found.');
}

function getRecorderEventAction(eventPayload = {}) {
  const eventName = eventPayload.event;
  const eventMessage = eventPayload.message;

  switch (eventName) {
    case 'configuring_devices':
      return {
        initProgress: {
          stage: 'configuring',
          message: eventMessage || 'Configuring audio devices...',
        },
        warning: null,
        recordingStartedMessage: null,
        progressMessage: null,
      };

    case 'mic_stream_opened':
      return {
        initProgress: {
          stage: 'mic_opened',
          message: eventMessage || 'Microphone ready...',
        },
        warning: null,
        recordingStartedMessage: null,
        progressMessage: null,
      };

    case 'desktop_stream_opened':
      return {
        initProgress: {
          stage: 'desktop_opened',
          message: eventMessage || 'Desktop audio ready...',
        },
        warning: null,
        recordingStartedMessage: null,
        progressMessage: null,
      };

    case 'desktop_capture_disabled':
      return {
        initProgress: {
          stage: 'desktop_disabled',
          message: eventMessage || 'Desktop audio capture unavailable',
        },
        warning: {
          code: eventPayload.code || 'NO_DESKTOP_AUDIO',
          message: eventMessage || 'Desktop audio capture is disabled.',
          help: eventPayload.help,
          type: 'desktop_capture_disabled',
        },
        recordingStartedMessage: null,
        progressMessage: null,
      };

    case 'recording_started':
      return {
        initProgress: null,
        warning: null,
        recordingStartedMessage: eventMessage || 'Recording started!',
        progressMessage: null,
      };

    default:
      return {
        initProgress: null,
        warning: null,
        recordingStartedMessage: null,
        progressMessage: eventMessage || null,
      };
  }
}

function getRecorderCloseAction({
  recordingStarted,
  stopInProgress,
  startupSettled,
  startupFailureMessage,
  progressStage,
  exitCode,
} = {}) {
  if (stopInProgress) {
    return { type: 'stop_in_progress', errorMessage: null, warning: null };
  }

  if (!recordingStarted && startupSettled) {
    return { type: 'startup_already_settled', errorMessage: null, warning: null };
  }

  if (recordingStarted) {
    const message = exitCode === 0
      ? 'Recorder exited unexpectedly after startup.'
      : `Recorder exited unexpectedly after startup with code ${exitCode}.`;

    return {
      type: 'unexpected_exit',
      errorMessage: null,
      warning: {
        type: 'recorder_exited',
        code: 'RECORDER_EXITED',
        level: 'error',
        message,
        help: 'The recording process stopped unexpectedly. Start a new recording when ready.',
      },
    };
  }

  const codeDetail = exitCode === null || typeof exitCode === 'undefined'
    ? 'without an exit code'
    : `with code ${exitCode}`;
  let errorMessage = startupFailureMessage || `Recording failed to start. Process exited ${codeDetail}.`;

  if (!startupFailureMessage && progressStage === 'initializing') {
    errorMessage += '\n\nTip: Try refreshing your audio devices or restarting the app.';
  } else if (!startupFailureMessage && progressStage === 'configuring') {
    errorMessage += '\n\nTip: Check that your selected audio devices are not in use by another application.';
  }

  return { type: 'startup_failed', errorMessage, warning: null };
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

function getRecordingStopTimeout(recordingStartTime, now = Date.now()) {
  if (!Number.isFinite(recordingStartTime)) {
    return 30000;
  }

  const recordingDurationSeconds = Math.max(0, (now - recordingStartTime) / 1000);
  const recordingMinutes = Math.ceil(recordingDurationSeconds / 60);

  return Math.max(30000, 30000 + (recordingMinutes * 10000));
}

function resolveStopTimeoutAction({ forceKillOnTimeout, errorMessage, timeoutMessage, hasRecordingProcess }) {
  const timedOut = errorMessage === timeoutMessage;

  return {
    timedOut,
    shouldKillProcess: Boolean(timedOut && forceKillOnTimeout && hasRecordingProcess),
    shouldKeepStopPromise: timedOut,
  };
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

module.exports = {
  classifyRecorderStdoutChunk,
  parseRecorderStdoutChunk,
  parseRecorderMessageLine,
  normalizeRecorderLevels,
  getRecorderCloseAction,
  getRecorderEventAction,
  findRecorderResultPayload,
  getRecorderResultAudioPath,
  normalizeRecordingStopPayload,
  parseRecordingStopResult,
  getRecordingStopTimeout,
  resolveStopTimeoutAction,
  getQuitInterceptState,
  buildRecorderBusyResponse,
  isRecorderBusy,
  appendCappedSpawnLogBuffer,
  appendSpawnJsonResultBuffer,
  SPAWN_LOG_BUFFER_MAX_CHARS,
  SPAWN_JSON_RESULT_BUFFER_MAX_CHARS,
  UPDATER_HTTP_RESPONSE_MAX_CHARS,
};
