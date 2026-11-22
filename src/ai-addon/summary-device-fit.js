'use strict';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const MACOS_OS_HEADROOM_BYTES = 3 * GiB;
const MACOS_MAX_UNIFIED_RATIO = 0.75;
const NOMINAL_GPU_TIER_RATIO = 0.94;

function getSummaryModelFit({ model, artifact, availability, runtimeArtifact, deviceMemory, platform }) {
  const unified = platform === 'darwin';
  const memoryType = unified ? 'unified memory' : 'graphics memory';
  const workingMemoryBytes = model?.memoryGuidance?.[unified ? 'unified' : 'gpu'] * GiB || null;
  const effectiveRecommendedBytes = unified ? workingMemoryBytes : Math.round(workingMemoryBytes * NOMINAL_GPU_TIER_RATIO);
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
  const residentModelId = deviceMemory?.residentModelId ?? null;
  const residentModelName = deviceMemory?.residentModelName ?? null;
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
    multiGpu: deviceMemory?.multiGpu === true,
    residentModelId,
    residentModelName,
    memoryType,
  };
  const result = (status, reason, blocked = false) => ({ status, reason, blocked, ...readings });
  const platformSupport = model?.supportedPlatforms?.[platform];
  if (platformSupport && platformSupport.status !== 'enabled') {
    return result('unavailable', platformSupport.reason || 'Not available on this platform yet.', true);
  }
  if (!artifact || !runtimeArtifact) return result('unavailable', 'No verified local runtime is available for this platform.', true);
  if (!availability?.supported) {
    if (deviceMemory?.cudaStatusPending) return result('runtime_checking', 'Checking CUDA runtime…', true);
    return result('runtime_needed', availability?.reason || 'Set up the required local runtime in Settings first.', true);
  }
  if (platform === 'win32' && deviceMemory?.gpuCompatibility === 'incompatible') {
    return result('unavailable', 'An NVIDIA GPU is required for this local model.', true);
  }
  if (total == null) return result('unknown', `Could not read this device’s ${memoryType}. Use Check setup after downloading to test it.`);
  const lowFreeVram = !unified && minimumRuntimeBytes && available !== null && available < minimumRuntimeBytes;
  if (unified) {
    const macSafeLimit = Math.min(total * MACOS_MAX_UNIFIED_RATIO, total - MACOS_OS_HEADROOM_BYTES);
    if (minimumRuntimeBytes && (macSafeLimit <= 0 || minimumRuntimeBytes > macSafeLimit)) {
      return result(
        'needs_more_memory',
        'Needs more unified memory than this Mac can spare. Choose a smaller model.',
        true,
      );
    }
  } else if (minimumRuntimeBytes && (total < minimumRuntimeBytes || (lowFreeVram && !residentModelId))) {
    return result(
      'needs_more_memory',
      total < minimumRuntimeBytes
        ? 'Needs more graphics memory than this GPU has. Choose a smaller model.'
        : 'Not enough free graphics memory right now. Close other GPU apps, click Free memory, or choose a smaller model.',
      true,
    );
  }
  const retryAfterUnload = lowFreeVram && residentModelId
    ? 'Unload the model in memory and check again to confirm how much graphics memory is free.'
    : null;
  if (workingMemoryBytes && total < effectiveRecommendedBytes) {
    return result('tight', retryAfterUnload || `Below the recommended ${memoryType} for this model. Use Check setup to test it.`);
  }
  if (workingMemoryBytes && model?.memoryGuidance?.qualified === true && !retryAfterUnload) {
    return result('fits', `Meets the recommended ${memoryType} for this model.`);
  }
  return result('likely_fits', retryAfterUnload || `Enough ${memoryType} detected for the model files. Use Check setup to verify full context.`);
}

function classifyWindowsGpuAdapters(adapters) {
  // Incomplete, NVIDIA, virtual, and unrecognized devices are inconclusive.
  if (Array.isArray(adapters) && adapters.length > 0
      && adapters.every((adapter) => [0x1002, 0x8086].includes(adapter?.vendorId)
        && Number.isInteger(adapter.deviceId) && adapter.deviceId > 0)) return 'incompatible';
  return 'unknown';
}

function parseNvidiaMemory(output, visibleDevices) {
  const devices = [];
  for (const row of String(output).split(/\r?\n/)) {
    const columns = row.split(',').map((part) => part.trim());
    if (columns.length !== 4) continue;
    const [index, uuid, total, free] = columns;
    if (!/^\d+$/.test(index) || !uuid || !/^\d+$/.test(total) || !/^\d+$/.test(free)) continue;
    const totalBytes = Number(total) * MiB;
    const availableBytes = Number(free) * MiB;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || availableBytes > totalBytes) continue;
    devices.push({ index, uuid, totalBytes, availableBytes });
  }
  const selector = typeof visibleDevices === 'string' ? visibleDevices.trim() : '';
  const match = selector
    ? devices.find(({ index, uuid }) => selector === index || selector === uuid)
    : devices.sort((left, right) => right.totalBytes - left.totalBytes || Number(left.index) - Number(right.index))[0];
  if (!match) return null;
  const { totalBytes, availableBytes } = match;
  return { totalBytes, availableBytes, ...(devices.length > 1 ? { multiGpu: true } : {}) };
}

module.exports = { getSummaryModelFit, parseNvidiaMemory, classifyWindowsGpuAdapters };
