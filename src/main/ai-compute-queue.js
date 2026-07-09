'use strict';

/**
 * AI compute-queue service for the AvaNevis main process.
 *
 * Owns the single shared `aiComputeActionQueue` plus wait/abort helpers used by
 * transcription, diarization, summary generation, and AI add-on setup validation.
 * No IPC is registered here — consumers receive the queue API via deps.
 *
 * `download-model` and AI add-on setup downloads must stay OFF this queue
 * (see AGENTS.md / Phase 0.2 compute-queue membership tests).
 */

/**
 * Create a serial async action queue (FIFO, one active job at a time).
 * Exported so `ai-addon-ipc.js` can build the separate `aiAddonActionQueue`
 * without duplicating the queue implementation.
 */
function createAsyncActionQueue() {
  let tail = Promise.resolve();
  let pendingWorkCount = 0;

  function enqueue(action) {
    pendingWorkCount += 1;
    const run = tail.then(() => action()).finally(() => {
      pendingWorkCount -= 1;
    });
    tail = run.catch(() => {});
    return run;
  }

  function drain() {
    return tail;
  }

  function hasPendingWork() {
    return pendingWorkCount > 0;
  }

  return { enqueue, drain, hasPendingWork };
}

/**
 * @param {object} deps
 * @param {Function} deps.createAiAddonCancelError - Builds an AbortError-shaped cancel error.
 * @param {{ enqueue: Function, drain: Function, hasPendingWork: Function }} [deps.actionQueue]
 *   Optional injected queue (for tests). Defaults to a new `createAsyncActionQueue()`.
 * @param {Function} [deps.runWallClockComputeAction] - Optional wall-clock wrapper from
 *   main-process-helpers; when provided, `enqueueWallClockComputeAction` is exposed.
 */
function createAiComputeQueue(deps = {}) {
  const {
    createAiAddonCancelError,
    actionQueue = createAsyncActionQueue(),
    runWallClockComputeAction = null,
  } = deps;

  if (typeof createAiAddonCancelError !== 'function') {
    throw new Error('createAiComputeQueue requires createAiAddonCancelError');
  }

  // Single shared compute-queue reference. Never copy this object; callers must
  // use the same enqueue/drain/hasPendingWork methods.
  const aiComputeActionQueue = actionQueue;
  const enqueueAiComputeAction = aiComputeActionQueue.enqueue;

  function waitForAiComputeQueueIdle({
    cancelSignal,
    cancelMessage,
    pollIntervalMs = 250,
    timeoutMs = null,
    timeoutMessage = 'Timed out waiting for local AI work to finish.',
    onWaiting = null,
  } = {}) {
    return new Promise((resolve, reject) => {
      if (cancelSignal && cancelSignal.aborted) {
        reject(createAiAddonCancelError(cancelMessage));
        return;
      }

      let timer = null;
      let timeoutHandle = null;
      let settled = false;
      let waitingNotified = false;
      const cleanupAbort = cancelSignal && typeof cancelSignal.addEventListener === 'function'
        ? (() => {
          const handleAbort = () => {
            if (settled) {
              return;
            }
            settled = true;
            if (timer) {
              clearInterval(timer);
              timer = null;
            }
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
              timeoutHandle = null;
            }
            reject(createAiAddonCancelError(cancelMessage));
          };
          cancelSignal.addEventListener('abort', handleAbort, { once: true });
          return () => cancelSignal.removeEventListener('abort', handleAbort);
        })()
        : () => {};

      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        cleanupAbort();
        callback(value);
      };

      const checkIdle = () => {
        if (cancelSignal && cancelSignal.aborted) {
          finish(reject, createAiAddonCancelError(cancelMessage));
          return;
        }
        if (!aiComputeActionQueue.hasPendingWork()) {
          finish(resolve);
          return;
        }
        if (!waitingNotified && typeof onWaiting === 'function') {
          waitingNotified = true;
          try {
            onWaiting();
          } catch (error) {
            // Progress callbacks must not break the idle wait.
          }
        }
      };

      checkIdle();
      if (settled) {
        return;
      }

      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          finish(reject, new Error(timeoutMessage));
        }, timeoutMs);
        timeoutHandle.unref?.();
      }

      timer = setInterval(checkIdle, pollIntervalMs);
      timer.unref?.();
    });
  }

  function createAbortableComputeAction({ cancelSignal, cancelMessage, action }) {
    return waitForAiComputeQueueIdle({ cancelSignal, cancelMessage })
      .then(() => {
        if (cancelSignal && cancelSignal.aborted) {
          throw createAiAddonCancelError(cancelMessage);
        }
        return enqueueAiComputeAction(() => action());
      });
  }

  /**
   * Convenience: enqueue a wall-clock-bounded compute job on the shared queue.
   * Transcription/summary handlers may call this or the lower-level pair
   * `enqueueAiComputeAction(() => runWallClockComputeAction(...))` — both keep
   * the Phase 0.2 source-scan green when `enqueueAiComputeAction` appears in the
   * handler body.
   */
  function enqueueWallClockComputeAction(options) {
    if (typeof runWallClockComputeAction !== 'function') {
      throw new Error('enqueueWallClockComputeAction requires runWallClockComputeAction in deps');
    }
    return enqueueAiComputeAction(() => runWallClockComputeAction(options));
  }

  return {
    aiComputeActionQueue,
    enqueueAiComputeAction,
    waitForAiComputeQueueIdle,
    createAbortableComputeAction,
    enqueueWallClockComputeAction,
  };
}

module.exports = {
  createAsyncActionQueue,
  createAiComputeQueue,
};
