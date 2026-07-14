'use strict';

/**
 * Shared gate that serializes recordings-directory mutations.
 *
 * Owners: idle | scan | recovery | start
 * - start-recording waits briefly when the gate is held as scan, then reserves `start`
 * - start-recording rejects immediately while recovery holds the gate
 * - recovery waits briefly for an in-flight scan/start, then re-checks capture state
 * - transfer() moves ownership without releasing to idle (recovery → scan for import)
 */

function createRecordingsMaintenanceGate(options = {}) {
  const {
    scanWaitMs = 5000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    nowFn = () => Date.now(),
  } = options;

  const VALID_OWNERS = new Set(['scan', 'recovery', 'start']);
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
    if (!VALID_OWNERS.has(kind)) {
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

  /**
   * Atomically move ownership without passing through idle.
   * Used so recovery can hand off to scan/import without admitting start.
   */
  function transfer(fromKind, toKind) {
    if (!VALID_OWNERS.has(toKind)) {
      throw new Error(`Invalid recordings maintenance owner: ${toKind}`);
    }
    if (owner !== fromKind) {
      return false;
    }
    owner = toKind;
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
    if (currentOwner === 'start') {
      return {
        ok: false,
        code: 'RECORDING_START_IN_PROGRESS',
        owner: 'start',
        message: 'A recording is starting.',
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

    // Wait behind scan or a brief start reservation.
    if ((owner === 'scan' || owner === 'start') && waitForScanMs > 0) {
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
      // One last attempt before attributing the blocker — owner may have flipped
      // in the final milliseconds after waitForIdle returned.
      if (tryAcquire(kind)) {
        return { ok: true, owner: kind };
      }
    }

    return busyResult(owner === 'idle' ? 'scan' : owner);
  }

  /**
   * Admission for start-recording: brief wait behind scan, then reserve `start`
   * so recovery cannot race in before capture state becomes non-idle.
   */
  async function admitStartRecording({ waitForScanMs = scanWaitMs } = {}) {
    if (owner === 'recovery') {
      return {
        ok: false,
        code: 'RECORDING_RECOVERY_IN_PROGRESS',
        owner: 'recovery',
        message: 'Finish or wait for interrupted-recording recovery before starting a new recording.',
      };
    }

    const deadline = nowFn() + Math.max(0, waitForScanMs);
    while (true) {
      if (tryAcquire('start')) {
        return { ok: true, owner: 'start' };
      }
      if (owner === 'recovery') {
        return {
          ok: false,
          code: 'RECORDING_RECOVERY_IN_PROGRESS',
          owner: 'recovery',
          message: 'Finish or wait for interrupted-recording recovery before starting a new recording.',
        };
      }
      if (owner === 'start') {
        // Another start already reserved.
        return {
          ok: false,
          code: 'RECORDING_START_IN_PROGRESS',
          owner: 'start',
          message: 'A recording is starting.',
        };
      }
      if (nowFn() >= deadline) {
        return {
          ok: false,
          code: 'RECORDING_SCAN_IN_PROGRESS',
          owner: 'scan',
          message: 'Wait for recording recovery scan to finish before starting a new recording.',
        };
      }
      const remaining = deadline - nowFn();
      // eslint-disable-next-line no-await-in-loop
      await waitForIdle(remaining);
    }
  }

  return {
    getOwner,
    isIdle,
    tryAcquire,
    acquire,
    release,
    transfer,
    admitStartRecording,
    waitForIdle,
    scanWaitMs,
  };
}

module.exports = {
  createRecordingsMaintenanceGate,
};
