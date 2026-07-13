'use strict';

/**
 * Shared gate that serializes recordings-directory mutations.
 *
 * Owners: idle | scan | recovery
 * - start-recording waits briefly when the gate is held as scan
 * - start-recording rejects immediately while recovery holds the gate
 * - recovery waits briefly for an in-flight scan, then re-checks capture state
 */

function createRecordingsMaintenanceGate(options = {}) {
  const {
    scanWaitMs = 5000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    nowFn = () => Date.now(),
  } = options;

  let owner = 'idle';
  /** @type {Set<() => void>} */
  const idleWaiters = new Set();

  function getOwner() {
    return owner;
  }

  function isIdle() {
    return owner === 'idle';
  }

  function notifyIdleWaiters() {
    for (const resolve of idleWaiters) {
      try {
        resolve();
      } catch (_) {
        // Waiter errors must not break release.
      }
    }
    idleWaiters.clear();
  }

  function tryAcquire(kind) {
    if (kind !== 'scan' && kind !== 'recovery') {
      throw new Error(`Invalid recordings maintenance owner: ${kind}`);
    }
    if (owner !== 'idle') {
      return false;
    }
    owner = kind;
    return true;
  }

  function release(kind) {
    if (owner !== kind) {
      return false;
    }
    owner = 'idle';
    notifyIdleWaiters();
    return true;
  }

  function waitForIdle(timeoutMs) {
    if (owner === 'idle') {
      return Promise.resolve(true);
    }
    if (!(timeoutMs > 0)) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        idleWaiters.delete(onIdle);
        clearTimeoutFn(timer);
        resolve(value);
      };
      const onIdle = () => finish(true);
      const timer = setTimeoutFn(() => finish(false), timeoutMs);
      idleWaiters.add(onIdle);
      if (owner === 'idle') {
        finish(true);
      }
    });
  }

  function busyResult(currentOwner) {
    if (currentOwner === 'recovery') {
      return {
        ok: false,
        code: 'RECORDINGS_MAINTENANCE_IN_PROGRESS',
        owner: 'recovery',
        message: 'Interrupted-recording recovery is in progress.',
      };
    }
    return {
      ok: false,
      code: 'RECORDING_SCAN_IN_PROGRESS',
      owner: 'scan',
      message: 'Recording recovery scan is already running.',
    };
  }

  async function acquire(kind, { waitForScanMs = 0 } = {}) {
    if (tryAcquire(kind)) {
      return { ok: true, owner: kind };
    }

    if (owner === 'recovery') {
      return busyResult('recovery');
    }

    if (owner === 'scan' && waitForScanMs > 0) {
      const deadline = nowFn() + waitForScanMs;
      while (nowFn() < deadline) {
        const remaining = deadline - nowFn();
        // eslint-disable-next-line no-await-in-loop
        await waitForIdle(remaining);
        if (tryAcquire(kind)) {
          return { ok: true, owner: kind };
        }
        if (owner === 'recovery') {
          return busyResult('recovery');
        }
      }
    }

    return busyResult(owner === 'idle' ? 'scan' : owner);
  }

  /**
   * Admission for start-recording: brief wait behind scan, immediate reject for recovery.
   */
  async function admitStartRecording({ waitForScanMs = scanWaitMs } = {}) {
    if (owner === 'idle') {
      return { ok: true };
    }
    if (owner === 'recovery') {
      return {
        ok: false,
        code: 'RECORDING_RECOVERY_IN_PROGRESS',
        owner: 'recovery',
        message: 'Finish or wait for interrupted-recording recovery before starting a new recording.',
      };
    }

    const deadline = nowFn() + Math.max(0, waitForScanMs);
    while (nowFn() < deadline) {
      const remaining = deadline - nowFn();
      // eslint-disable-next-line no-await-in-loop
      await waitForIdle(remaining);
      if (owner === 'idle') {
        return { ok: true };
      }
      if (owner === 'recovery') {
        return {
          ok: false,
          code: 'RECORDING_RECOVERY_IN_PROGRESS',
          owner: 'recovery',
          message: 'Finish or wait for interrupted-recording recovery before starting a new recording.',
        };
      }
    }

    return {
      ok: false,
      code: 'RECORDING_SCAN_IN_PROGRESS',
      owner: 'scan',
      message: 'Wait for recording recovery scan to finish before starting a new recording.',
    };
  }

  return {
    getOwner,
    isIdle,
    tryAcquire,
    acquire,
    release,
    admitStartRecording,
    waitForIdle,
    scanWaitMs,
  };
}

module.exports = {
  createRecordingsMaintenanceGate,
};
