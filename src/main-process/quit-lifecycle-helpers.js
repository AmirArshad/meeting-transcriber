'use strict';

/**
 * Pure helpers for before-quit / drain decisions.
 * Kept free of Electron so quit orchestration can be unit-tested.
 */

/**
 * Decide what the before-quit handler should do.
 *
 * Armed pass (after a prior drain/recording quit armed allowImmediateQuit):
 * - Still intercept a *new* recording that started during drain (needs graceful stop).
 * - Do NOT re-drain AI work — fall through to force-kill. Re-draining caused an
 *   unquittable loop when transcription/GPU outlived the drain budget.
 *
 * First pass:
 * - Intercept active recording for graceful stop.
 * - Drain in-flight AI once, then arm for a final quit pass.
 * - Otherwise force-quit immediately.
 *
 * @param {{ immediateQuitArmed: boolean, interceptQuit: boolean, hasInFlightAiWork: boolean }} input
 * @returns {{ action: 'intercept_recording' | 'drain_ai' | 'force_quit' }}
 */
function resolveBeforeQuitAction({
  immediateQuitArmed = false,
  interceptQuit = false,
  hasInFlightAiWork = false,
} = {}) {
  if (immediateQuitArmed) {
    if (interceptQuit) {
      return { action: 'intercept_recording' };
    }
    return { action: 'force_quit' };
  }

  if (interceptQuit) {
    return { action: 'intercept_recording' };
  }

  if (hasInFlightAiWork) {
    return { action: 'drain_ai' };
  }

  return { action: 'force_quit' };
}

/**
 * Whether a tracked process should be killed during the immediate-quit loop.
 * Metadata-phase summary update-ai is deliberately spared.
 */
function shouldKillProcessOnQuit(proc, protectedProcess) {
  if (!proc) {
    return false;
  }
  if (protectedProcess && proc === protectedProcess) {
    return false;
  }
  return !proc.killed;
}

/**
 * Select which tracked processes the force-quit kill loop should terminate.
 * Pure helper so the before-quit wiring can be unit-tested without Electron.
 */
function collectProcessesToKillOnQuit(activeProcesses = [], protectedProcess = null) {
  if (!Array.isArray(activeProcesses)) {
    return [];
  }
  return activeProcesses.filter((proc) => shouldKillProcessOnQuit(proc, protectedProcess));
}

/** Signal a spawned Python process and its POSIX descendants when it owns a group. */
function signalProcessTree(proc, signal = 'SIGTERM', killProcess = process.kill) {
  if (!proc || typeof proc.kill !== 'function') {
    return false;
  }

  if (proc.avanevisProcessGroup === true && Number.isInteger(proc.pid) && proc.pid > 0) {
    try {
      killProcess(-proc.pid, signal);
      return true;
    } catch (error) {
      // The group may already be gone while the direct child handle is still live.
    }
  }

  return proc.kill(signal);
}

function signalOwnedProcessGroup(proc, signal = 'SIGKILL', killProcess = process.kill) {
  if (!proc || proc.avanevisProcessGroup !== true || !Number.isInteger(proc.pid) || proc.pid <= 0) {
    return false;
  }
  try {
    killProcess(-proc.pid, signal);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Dispatch a resolved before-quit action to injected handlers.
 * Keeps `app.on('before-quit')` thin and lets tests assert wiring without Electron.
 *
 * @param {{ action: string }} quitAction
 * @param {{ onInterceptRecording: Function, onDrainAi: Function, onForceQuit: Function }} handlers
 */
function dispatchBeforeQuitAction(quitAction, handlers = {}) {
  const action = quitAction && quitAction.action;
  if (action === 'intercept_recording') {
    return handlers.onInterceptRecording();
  }
  if (action === 'drain_ai') {
    return handlers.onDrainAi();
  }
  if (action === 'force_quit') {
    return handlers.onForceQuit();
  }
  throw new Error(`Unknown before-quit action: ${action}`);
}

module.exports = {
  resolveBeforeQuitAction,
  shouldKillProcessOnQuit,
  collectProcessesToKillOnQuit,
  signalProcessTree,
  signalOwnedProcessGroup,
  dispatchBeforeQuitAction,
};
