'use strict';

const AI_COMPUTE_TIMEOUT_MS = Object.freeze({
  diarization: 30 * 60 * 1000,
  // Floor / documentation default; live guided jobs use getGuidedTranscriptionComputeTimeoutMs.
  guidedTranscription: 120 * 60 * 1000,
  summary: 90 * 60 * 1000,
  meetingPreflight: 60 * 1000,
  // Max time download-model may block waiting for GPU compute to go idle.
  modelDownloadIdleWait: 15 * 60 * 1000,
  // Full preload/model-download wall clock once admitted to GPU resources.
  modelDownload: 30 * 60 * 1000,
  // Max time GPU install/repair/uninstall may wait for compute-queue idle.
  gpuRuntimeComputeIdleWait: 15 * 60 * 1000,
  // Diarization / summary setup smoke validation on the compute queue.
  addonValidation: 15 * 60 * 1000,
  // After terminateProcess on timeout, release the queue even if the child never exits.
  wallClockSettleGraceMs: 30 * 1000,
});

/** Labels for compute jobs that cannot be aborted and routinely exceed quit-drain budgets. */
const NON_ABORTABLE_LONG_COMPUTE_LABEL_PATTERN = /^(Transcription|Speaker-guided transcription|Speaker identification|Transcription retry)(\b|$)/i;

/** All in-flight wall-clock jobs (compute queue + GPU can overlap). */
const activeWallClockComputeJobs = new Set();

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

function getActiveWallClockComputeJobs() {
  return [...activeWallClockComputeJobs];
}

/**
 * Prefer a non-abortable transcription-class job when present (quit-drain skip),
 * otherwise the most recently started job.
 */
function getActiveWallClockComputeJob() {
  const jobs = getActiveWallClockComputeJobs();
  if (jobs.length === 0) {
    return null;
  }
  const nonAbortable = jobs.find((job) => isNonAbortableLongComputeJob(job));
  return nonAbortable || jobs[jobs.length - 1];
}

function isNonAbortableLongComputeJob(job) {
  if (!job || typeof job.label !== 'string') {
    return false;
  }
  return NON_ABORTABLE_LONG_COMPUTE_LABEL_PATTERN.test(job.label.trim());
}

/**
 * Quit drain should not burn the full 30s budget waiting on transcription-class
 * jobs that have no abort path and will be force-killed anyway.
 */
function shouldSkipQuitComputeDrain(job) {
  return isNonAbortableLongComputeJob(job);
}

/**
 * Terminate every active non-abortable long compute job (transcription-class).
 * Used by quit drain so hasPendingWork() can clear instead of looping forever.
 */
async function terminateNonAbortableQuitComputeJobs() {
  const jobs = getActiveWallClockComputeJobs().filter(shouldSkipQuitComputeDrain);
  await Promise.all(jobs.map(async (job) => {
    if (typeof job.terminate !== 'function') {
      return;
    }
    try {
      await job.terminate();
    } catch (_error) {
      // Best-effort — force-kill loop is the backstop.
    }
  }));
  return jobs.length;
}

function runWallClockComputeAction({
  action,
  timeoutMs,
  label = 'Local AI job',
  terminateProcess = () => {},
  settleGraceMs = AI_COMPUTE_TIMEOUT_MS.wallClockSettleGraceMs,
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    // Identity registerProcess so callers can still use the return value.
    return Promise.resolve().then(() => action((proc) => proc));
  }

  let activeProcess = null;
  let timeoutHandle = null;
  let settled = false;
  let timedOut = false;
  let quitTerminated = false;
  let settleReject = null;

  const registerProcess = (proc) => {
    activeProcess = proc;
    return proc;
  };

  const job = {
    label,
    timeoutMs,
    startedAt: Date.now(),
    terminate: async () => {
      quitTerminated = true;
      try {
        await Promise.resolve(terminateProcess(activeProcess));
      } catch (_error) {
        // Best-effort terminate.
      }
      if (typeof settleReject === 'function') {
        settleReject(new Error(`${label} was terminated because the app is quitting.`));
      }
    },
  };

  const clearActiveJob = () => {
    activeWallClockComputeJobs.delete(job);
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
    clearActiveJob();
    callback(value);
  };

  const waitForActionOrGrace = (actionPromise) => {
    const graceMs = Number.isFinite(settleGraceMs) && settleGraceMs > 0
      ? settleGraceMs
      : AI_COMPUTE_TIMEOUT_MS.wallClockSettleGraceMs;
    return Promise.race([
      actionPromise.catch(() => undefined),
      new Promise((resolve) => {
        const graceHandle = setTimeout(resolve, graceMs);
        graceHandle.unref?.();
      }),
    ]);
  };

  return new Promise((resolve, reject) => {
    // Assign settleReject before registering the job so a concurrent quit
    // terminate can never land on a null settleReject (N2).
    settleReject = (error) => settle(reject, error);
    activeWallClockComputeJobs.add(job);

    const actionPromise = Promise.resolve()
      .then(() => action(registerProcess));

    timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      const timeoutError = new Error(`${label} timed out after ${formatComputeTimeoutLabel(timeoutMs)}.`);
      Promise.resolve(terminateProcess(activeProcess))
        .catch(() => undefined)
        .then(() => waitForActionOrGrace(actionPromise))
        .finally(() => settle(reject, timeoutError));
    }, timeoutMs);
    timeoutHandle.unref?.();

    actionPromise
      .then((result) => {
        if (timedOut || quitTerminated) {
          return;
        }
        settle(resolve, result);
      })
      .catch((error) => {
        if (timedOut) {
          return;
        }
        if (quitTerminated) {
          // Prefer the explicit quit-terminate rejection if settleReject already ran;
          // otherwise surface the action error.
          settle(reject, error);
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

/** Outer compute-queue wall clock: model budget + small margin so the inner timer can fire first. */
function getGuidedTranscriptionComputeTimeoutMs(modelSize) {
  return (getGuidedTranscriptionTimeoutMinutes(modelSize) * 60 * 1000) + (30 * 1000);
}

module.exports = {
  AI_COMPUTE_TIMEOUT_MS,
  getTranscriptionComputeTimeoutMs,
  formatComputeTimeoutLabel,
  runWallClockComputeAction,
  getActiveWallClockComputeJob,
  getActiveWallClockComputeJobs,
  terminateNonAbortableQuitComputeJobs,
  isNonAbortableLongComputeJob,
  shouldSkipQuitComputeDrain,
  getGuidedTranscriptionTimeoutMinutes,
  getGuidedTranscriptionComputeTimeoutMs,
};
