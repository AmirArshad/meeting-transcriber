'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

function releaseError() {
  const error = new Error('AvaNevis could not confirm that the previous local model released memory. Use Free memory to retry, or restart AvaNevis.');
  error.code = 'SUMMARY_MODEL_EXIT_UNCONFIRMED';
  return error;
}

function createSummaryProcessSlot({
  platform = process.platform,
  kill = process.kill,
  checkWindowsJob,
  releaseTimeoutMs = 8000,
  pollMs = 100,
} = {}) {
  let owner = null;

  async function isReleased(entry) {
    if (!entry.closed) return false;
    if (!entry.proc.pid) return true;
    if (platform === 'win32') return checkWindowsJob(entry.jobName);
    if (!entry.proc.avanevisProcessGroup) return false;
    try {
      kill(-entry.proc.pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }

  function acknowledgeRelease(entry) {
    if (owner === entry) owner = null;
  }

  function spawnModel(start) {
    if (owner) throw releaseError();
    const jobName = platform === 'win32' ? `Local\\AvaNevis-Summary-${randomUUID()}` : null;
    const proc = start(jobName);
    const entry = { proc, jobName, closed: false, pendingCheck: null };
    owner = entry;
    proc.once('close', () => {
      entry.closed = true;
      // Cache a confirmed normal exit. A failed probe keeps the slot reserved.
      void isReleased(entry).then((released) => {
        if (released) acknowledgeRelease(entry);
      }).catch(() => {});
    });
    return proc;
  }

  async function waitForRelease(entry) {
    const deadline = Date.now() + releaseTimeoutMs;
    do {
      if (owner !== entry) return;
      if (await isReleased(entry).catch(() => false)) {
        acknowledgeRelease(entry);
        return;
      }
      if (entry.closed && platform !== 'win32' && entry.proc.avanevisProcessGroup && entry.proc.pid) {
        try {
          kill(-entry.proc.pid, 'SIGKILL');
        } catch (_error) {
          // Only a later probe can confirm the process group has disappeared.
        }
      }
      if (Date.now() >= deadline) throw releaseError();
      await delay(pollMs);
    } while (true);
  }

  function ensureExited() {
    if (!owner) return Promise.resolve();
    const entry = owner;
    if (!entry.pendingCheck) {
      entry.pendingCheck = waitForRelease(entry).finally(() => { entry.pendingCheck = null; });
    }
    return entry.pendingCheck;
  }

  return {
    spawnModel,
    ensureExited,
    hasOutstandingProcess: () => Boolean(owner),
    hasActiveNonClosedProcess: () => Boolean(owner && !owner.closed),
    getOutstandingProcess: () => owner?.proc || null,
  };
}

module.exports = { createSummaryProcessSlot };
