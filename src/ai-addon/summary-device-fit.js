'use strict';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const MACOS_OS_HEADROOM_BYTES = 3 * GiB;
const MACOS_MAX_UNIFIED_RATIO = 0.75;

function getSummaryModelFit({ model, artifact, availability, runtimeArtifact, deviceMemory, platform }) {
  const unified = platform === 'darwin';
  const memoryType = unified ? 'unified memory' : 'graphics memory';
  const workingMemoryBytes = model?.memoryGuidance?.[unified ? 'unified' : 'gpu'] * GiB || null;
  const weightBytes = Number(artifact?.estimatedSizeBytes) || 0;
  const measuredFloor = Number(model?.memoryGuidance?.minRuntimeBytes) || 0;
  const contextTokens = artifact?.inference?.contextTokens || null;
  const estimatedReserve = weightBytes
    ? Math.max(768 * MiB, Math.round(weightBytes * (contextTokens && contextTokens >= 32768 ? 0.16 : 0.12)))
    : 0;
  const minimumRuntimeBytes = measuredFloor > 0
    ? Math.max(measuredFloor, weightBytes)
    : (weightBytes ? weightBytes + estimatedReserve : null);
  const total = deviceMemory?.totalBytes || null;
  const available = deviceMemory?.availableBytes ?? null;
  const readings = {
    workingMemoryBytes,
    minimumRuntimeBytes,
    contextTokens,
    totalMemoryBytes: total,
    availableMemoryBytes: available,
    memoryType,
  };
  const result = (status, reason, blocked = false) => ({ status, reason, blocked, ...readings });
  const platformSupport = model?.supportedPlatforms?.[platform];
  if (platformSupport && platformSupport.status !== 'enabled') {
    return result('unavailable', platformSupport.reason || 'A compatible local runtime has not been verified on this platform.', true);
  }
  if (!artifact || !runtimeArtifact) return result('unavailable', 'This model has no verified runtime for this platform.', true);
  if (!availability?.supported) return result('runtime_needed', availability?.reason || 'Set up the required local runtime first.', true);
  if (!total) return result('unknown', `AvaNevis could not read this device’s ${memoryType}. Check setup to test the model.`);
  if (unified) {
    const macSafeLimit = Math.min(total * MACOS_MAX_UNIFIED_RATIO, total - MACOS_OS_HEADROOM_BYTES);
    if (minimumRuntimeBytes && (macSafeLimit <= 0 || minimumRuntimeBytes > macSafeLimit)) {
      return result(
        'needs_more_memory',
        'Running this model at a 32,768-token context would not leave enough unified memory for macOS and AvaNevis. Choose a smaller model.',
        true,
      );
    }
  } else if (minimumRuntimeBytes && (total < minimumRuntimeBytes || (available !== null && available < minimumRuntimeBytes))) {
    return result(
      'needs_more_memory',
      total < minimumRuntimeBytes
        ? 'This model needs more graphics memory for its weights and context buffer than this GPU has.'
        : 'There is not enough free graphics memory to load this model and its context buffer. Free memory or choose a smaller model.',
      true,
    );
  }
  if (workingMemoryBytes && total < workingMemoryBytes) {
    return result('needs_more_memory', `The detected ${memoryType} is below the estimate for this context. Check setup to test it.`);
  }
  if (workingMemoryBytes && model?.memoryGuidance?.qualified === true) {
    return result('fits', `The detected ${memoryType} meets the measured requirement for this context.`);
  }
  return result('unknown', `AvaNevis detected enough ${memoryType} for the weights. Check setup to verify the full context.`);
}

function parseNvidiaMemory(output, visibleDevices) {
  const devices = String(output).trim().split(/\r?\n/).map((row) => row.split(',').map((part) => part.trim()));
  // A multi-GPU context can be split differently by the runtime. A single
  // explicitly visible adapter gives a reliable per-device allocation limit.
  const selector = typeof visibleDevices === 'string' ? visibleDevices.trim() : null;
  const match = selector === null
    ? (devices.length === 1 ? devices[0] : null)
    : devices.find(([index, uuid]) => selector === uuid || (devices.length === 1 && selector === index));
  if (!match || match.length !== 4 || !/^\d+$/.test(match[2]) || !/^\d+$/.test(match[3])) return null;
  const totalMiB = Number(match[2]);
  const freeMiB = Number(match[3]);
  if (!Number.isSafeInteger(totalMiB) || !Number.isSafeInteger(freeMiB)
      || totalMiB <= 0 || freeMiB < 0 || freeMiB > totalMiB) return null;
  return { totalBytes: totalMiB * 1024 ** 2, availableBytes: freeMiB * 1024 ** 2 };
}

module.exports = { getSummaryModelFit, parseNvidiaMemory };
