'use strict';

const { spawn } = require('child_process');
const { redactSensitiveText, SENSITIVE_PROGRESS_KEY_SET } = require('../ai-progress-sanitizer');

const AI_ADDON_PROGRESS_CHANNEL = 'ai-addon-progress';

const AI_ADDON_CANCEL_CODE = 'AI_ADDON_SETUP_CANCELLED';

function sanitizeProgressMessage(message) {
  return redactSensitiveText(message)
    .slice(0, 300);
}

function createAiAddonProgressEvent(input = {}) {
  const event = {
    feature: input.feature === 'summary' ? 'summary' : 'diarization',
    phase: String(input.phase || 'status').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80),
    message: sanitizeProgressMessage(input.message),
  };

  if (Number.isFinite(input.percent)) {
    event.percent = Math.max(0, Math.min(100, Number(input.percent)));
  }
  if (typeof input.modelId === 'string' && input.modelId.trim()) {
    event.modelId = input.modelId.trim();
  }
  if (typeof input.status === 'string' && input.status.trim()) {
    event.status = input.status.trim();
  }
  if (Number.isFinite(input.downloadedBytes) && input.downloadedBytes >= 0) {
    event.downloadedBytes = Math.floor(input.downloadedBytes);
  }
  if (Number.isFinite(input.totalBytes) && input.totalBytes > 0) {
    event.totalBytes = Math.floor(input.totalBytes);
  }
  if (event.totalBytes && event.downloadedBytes > event.totalBytes) {
    event.downloadedBytes = event.totalBytes;
  }

  for (const key of Object.keys(input)) {
    if (SENSITIVE_PROGRESS_KEY_SET.has(key)) {
      delete event[key];
    }
  }

  return event;
}

function emitSafeProgress(emitProgress, payload) {
  if (typeof emitProgress === 'function') {
    emitProgress(createAiAddonProgressEvent(payload));
  }
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function clampBytes(value, maxValue) {
  const bytes = Math.max(0, Math.floor(Number(value) || 0));
  const maxBytes = Math.max(0, Math.floor(Number(maxValue) || 0));
  return maxBytes > 0 ? Math.min(bytes, maxBytes) : bytes;
}

function createAiAddonCancelError(message = 'AI add-on setup was canceled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = AI_ADDON_CANCEL_CODE;
  return error;
}

function forceKillChildProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) {
    return;
  }
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      return;
    }
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        if (child.exitCode === null && !child.signalCode) {
          child.kill('SIGKILL');
        }
      } catch (killError) {
        // Best effort cleanup only.
      }
    }, 2000).unref?.();
  } catch (killError) {
    // Best effort cleanup only.
  }
}

function isAiAddonCancelError(error) {
  return Boolean(error && (error.code === AI_ADDON_CANCEL_CODE || error.name === 'AbortError'));
}

function throwIfAiAddonCanceled(cancelSignal, message) {
  if (cancelSignal && cancelSignal.aborted) {
    throw createAiAddonCancelError(message);
  }
}

function onAiAddonCancel(cancelSignal, callback) {
  if (!cancelSignal || typeof cancelSignal.addEventListener !== 'function') {
    return () => {};
  }

  const handleAbort = () => callback(createAiAddonCancelError());
  cancelSignal.addEventListener('abort', handleAbort, { once: true });
  return () => cancelSignal.removeEventListener('abort', handleAbort);
}

function summarizePipProgress(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const relevantLine = [...lines].reverse().find((line) => /^(Collecting|Downloading|Installing|Successfully installed|Building wheel|Using cached)/.test(line));
  return relevantLine || null;
}

module.exports = {
  AI_ADDON_PROGRESS_CHANNEL,
  AI_ADDON_CANCEL_CODE,
  createAiAddonProgressEvent,
  isAiAddonCancelError,
  summarizePipProgress,
  // Private helpers used by setup flows / other ai-addon modules
  emitSafeProgress,
  clampPercent,
  clampBytes,
  createAiAddonCancelError,
  forceKillChildProcess,
  throwIfAiAddonCanceled,
  onAiAddonCancel,
};
