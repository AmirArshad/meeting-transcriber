'use strict';

const AI_COMPUTE_TIMEOUT_MS = Object.freeze({
  diarization: 30 * 60 * 1000,
  guidedTranscription: 120 * 60 * 1000,
  summary: 90 * 60 * 1000,
  meetingPreflight: 60 * 1000,
  // Max time download-model may block waiting for GPU compute to go idle.
  modelDownloadIdleWait: 15 * 60 * 1000,
});

function getTranscriptionComputeTimeoutMs(modelSize) {
  const modelTimeouts = {
    tiny: 30,
    base: 45,
    small: 60,
    medium: 90,
    large: 120,
    'large-v3': 120,
  };
  return (modelTimeouts[modelSize] || 60) * 60 * 1000;
}

function formatComputeTimeoutLabel(timeoutMs) {
  const minutes = Math.max(1, Math.round(timeoutMs / 60000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function runWallClockComputeAction({
  action,
  timeoutMs,
  label = 'Local AI job',
  terminateProcess = () => {},
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve().then(() => action(() => {}));
  }

  let activeProcess = null;
  let timeoutHandle = null;
  let settled = false;
  let timedOut = false;

  const registerProcess = (proc) => {
    activeProcess = proc;
    return proc;
  };

  const settle = (callback, value) => {
    if (settled) {
      return;
    }
    settled = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    callback(value);
  };

  return new Promise((resolve, reject) => {
    const actionPromise = Promise.resolve()
      .then(() => action(registerProcess));

    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      const timeoutError = new Error(`${label} timed out after ${formatComputeTimeoutLabel(timeoutMs)}.`);
      Promise.resolve(terminateProcess(activeProcess))
        .then(() => actionPromise)
        .catch(() => undefined)
        .finally(() => settle(reject, timeoutError));
    }, timeoutMs);
    timeoutHandle.unref?.();

    actionPromise
      .then((result) => {
        if (timedOut) {
          return;
        }
        settle(resolve, result);
      })
      .catch((error) => {
        if (timedOut) {
          return;
        }
        settle(reject, error);
      });
  });
}

function getGuidedTranscriptionTimeoutMinutes(modelSize) {
  const modelTimeouts = { tiny: 45, base: 60, small: 90, medium: 135, large: 180, 'large-v3': 180 };
  return modelTimeouts[modelSize] || 90;
}

module.exports = {
  AI_COMPUTE_TIMEOUT_MS,
  getTranscriptionComputeTimeoutMs,
  formatComputeTimeoutLabel,
  runWallClockComputeAction,
  getGuidedTranscriptionTimeoutMinutes,
};
