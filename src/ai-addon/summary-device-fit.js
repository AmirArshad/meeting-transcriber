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
  // The catalog's runtime samples are Apple Silicon process RSS readings.
  // Discrete CUDA devices use the independent weights and context estimate.
  const measuredFloor = unified ? Number(model?.memoryGuidance?.minRuntimeBytes) || 0 : 0;
  const contextTokens = artifact?.inference?.contextTokens || null;
  const estimatedReserve = weightBytes
    ? Math.max(768 * MiB, Math.round(weightBytes * (contextTokens && contextTokens >= 32768 ? 0.16 : 0.12)))
    : 0;
  const minimumRuntimeBytes = measuredFloor > 0
    ? Math.max(measuredFloor, weightBytes)
    : (weightBytes ? weightBytes + estimatedReserve : null);
  const total = deviceMemory?.totalBytes || null;
  const available = deviceMemory?.availableBytes ?? null;
  const systemTotalBytes = deviceMemory?.systemTotalBytes || (unified ? total : null);
  const systemAvailableBytes = deviceMemory?.systemAvailableBytes ?? null;
  // No host-RAM recommendation is available for discrete GPUs without
  // model-specific measurements. Unified guidance applies to the whole system.
  const systemRecommendedBytes = unified ? workingMemoryBytes : null;
  const readings = {
    workingMemoryBytes,
    minimumRuntimeBytes,
    contextTokens,
    totalMemoryBytes: total,
    availableMemoryBytes: available,
    systemTotalBytes,
    systemAvailableBytes,
    systemRecommendedBytes,
    gpuCompatibility: deviceMemory?.gpuCompatibility ?? null,
    memoryType,
  };
  const result = (status, reason, blocked = false) => ({ status, reason, blocked, ...readings });
  const platformSupport = model?.supportedPlatforms?.[platform];
  if (platformSupport && platformSupport.status !== 'enabled') {
    return result('unavailable', platformSupport.reason || 'Not available on this platform yet.', true);
  }
  if (!artifact || !runtimeArtifact) return result('unavailable', 'No verified local runtime is available for this platform.', true);
  if (!availability?.supported) return result('runtime_needed', availability?.reason || 'Set up the required local runtime in Settings first.', true);
  if (platform === 'win32' && deviceMemory?.gpuCompatibility === 'incompatible') {
    return result('unavailable', 'An NVIDIA GPU is required for this local model.', true);
  }
  if (!total) return result('unknown', `Could not read this device’s ${memoryType}. Use Check setup after downloading to test it.`);
  if (unified) {
    const macSafeLimit = Math.min(total * MACOS_MAX_UNIFIED_RATIO, total - MACOS_OS_HEADROOM_BYTES);
    if (minimumRuntimeBytes && (macSafeLimit <= 0 || minimumRuntimeBytes > macSafeLimit)) {
      return result(
        'needs_more_memory',
        'Needs more unified memory than this Mac can spare. Choose a smaller model.',
        true,
      );
    }
  } else if (minimumRuntimeBytes && (total < minimumRuntimeBytes || (available !== null && available < minimumRuntimeBytes))) {
    return result(
      'needs_more_memory',
      total < minimumRuntimeBytes
        ? 'Needs more graphics memory than this GPU has. Choose a smaller model.'
        : 'Not enough free graphics memory right now. Close other GPU apps, click Free memory, or choose a smaller model.',
      true,
    );
  }
  if (workingMemoryBytes && total < workingMemoryBytes) {
    return result('needs_more_memory', `Below the recommended ${memoryType} for this model. Use Check setup to test it.`);
  }
  if (workingMemoryBytes && model?.memoryGuidance?.qualified === true) {
    return result('fits', `Meets the recommended ${memoryType} for this model.`);
  }
  return result('unknown', `Enough ${memoryType} detected for the model files. Use Check setup to verify full context.`);
}

function classifyWindowsGpuAdapters(adapters) {
  // Incomplete, NVIDIA, virtual, and unrecognized devices are inconclusive.
  if (Array.isArray(adapters) && adapters.length > 0
      && adapters.every((adapter) => [0x1002, 0x8086].includes(adapter?.vendorId)
        && Number.isInteger(adapter.deviceId) && adapter.deviceId > 0)) return 'incompatible';
  return 'unknown';
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

module.exports = { getSummaryModelFit, parseNvidiaMemory, classifyWindowsGpuAdapters };
