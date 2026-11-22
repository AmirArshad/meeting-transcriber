const test = require('node:test');
const assert = require('node:assert/strict');
const { getSummaryModelFit, parseNvidiaMemory } = require('../../src/ai-addon/summary-device-fit');
const { getModelById, getSummaryArtifactForPlatform, getSummaryRuntimeArtifactForPlatform, getSummaryAvailability } = require('../../src/ai-addon-state');

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

function fit(deviceMemory, memoryGuidance = { gpu: 12 }) {
  return getSummaryModelFit({
    model: { memoryGuidance },
    artifact: { estimatedSizeBytes: 7219673216, inference: { contextTokens: 32768 } },
    runtimeArtifact: {},
    availability: { supported: true },
    deviceMemory,
    platform: 'linux',
  });
}

test('nominal NVIDIA tiers tolerate reported VRAM below the advertised capacity', () => {
  for (const tier of [8, 12, 16, 24]) {
    const device = parseNvidiaMemory(`0, GPU-primary, ${tier * 1024 - 6}, ${tier * 1024 - 80}`, '');
    const estimate = fit(device, { gpu: tier });
    assert.equal(estimate.status, 'likely_fits');
    assert.equal(estimate.blocked, false);
    assert.equal(estimate.workingMemoryBytes, tier * GiB);
    assert.equal(fit(device, { gpu: tier, qualified: true }).status, 'fits');
  }
});

test('fit distinguishes unreadable, tight, and insufficient memory', () => {
  assert.equal(fit(null).status, 'unknown');
  const tight = fit({ totalBytes: 10 * GiB, availableBytes: 9 * GiB });
  assert.equal(tight.status, 'tight');
  assert.equal(tight.blocked, false);
  for (const device of [
    { totalBytes: 7 * GiB },
    { totalBytes: 12 * GiB, availableBytes: 0 },
    { totalBytes: 7 * GiB, availableBytes: 0, residentModelId: 'qwen' },
  ]) {
    const insufficient = fit(device);
    assert.equal(insufficient.status, 'needs_more_memory');
    assert.equal(insufficient.blocked, true);
  }
});

test('measured Linux CUDA allocations raise the estimated VRAM floor', () => {
  const device = { totalBytes: 12282 * MiB, availableBytes: 9000 * MiB };
  assert.equal(fit(device).blocked, false);
  const assessment = fit(device, { gpu: 12, minLinuxCudaRuntimeBytes: 9306 * MiB });
  assert.equal(assessment.minimumRuntimeBytes, 9306 * MiB);
  assert.equal(assessment.status, 'needs_more_memory');
  assert.equal(assessment.blocked, true);
  assert.equal(fit(device, { gpu: 12, minLinuxCudaRuntimeBytes: 1 }).minimumRuntimeBytes, fit(device).minimumRuntimeBytes);
});

test('the 48 GiB Apple Silicon fit check admits the peers and Inkling', () => {
  const platform = 'darwin';
  const arch = 'arm64';
  for (const id of ['bonsai-2-9b-q2-0', 'bonsai-2-27b-q2-0', 'ministral-3-14b', 'gemma-4-26b-a4b', 'qwen3.8-27b', 'inkling-2-mini']) {
    const model = getModelById('summary', id);
    const assessment = getSummaryModelFit({
      model,
      artifact: getSummaryArtifactForPlatform(id, platform, arch),
      runtimeArtifact: getSummaryRuntimeArtifactForPlatform(platform, arch, undefined, id),
      availability: getSummaryAvailability(platform, arch),
      deviceMemory: { totalBytes: 48 * GiB },
      platform,
    });
    assert.equal(assessment.blocked, false, id);
  }
});

test('Inkling fit depends on the CUDA device memory', () => {
  const id = 'inkling-2-mini';
  const platform = 'linux';
  const arch = 'x64';
  const options = {
    model: getModelById('summary', id),
    artifact: getSummaryArtifactForPlatform(id, platform, arch),
    runtimeArtifact: getSummaryRuntimeArtifactForPlatform(platform, arch, undefined, id),
    availability: { supported: true },
    platform,
  };
  const smaller = getSummaryModelFit({ ...options, deviceMemory: { totalBytes: 12 * GiB } });
  assert.equal(smaller.status, 'needs_more_memory');
  assert.equal(smaller.blocked, true);
  const larger = getSummaryModelFit({ ...options, deviceMemory: { totalBytes: 24 * GiB, availableBytes: 23 * GiB } });
  assert.equal(larger.blocked, false);
});

test('a resident model makes low free VRAM conditional on unloading', () => {
  const assessment = fit({
    totalBytes: 12282 * MiB,
    availableBytes: 4 * GiB,
    residentModelId: 'qwen3.5-9b-q4-k-m',
    residentModelName: 'Qwen3.5 9B',
  }, { gpu: 12, qualified: true });
  assert.equal(assessment.status, 'likely_fits');
  assert.equal(assessment.blocked, false);
  assert.equal(assessment.residentModelId, 'qwen3.5-9b-q4-k-m');
  assert.equal(assessment.residentModelName, 'Qwen3.5 9B');
  assert.match(assessment.reason, /unload.*check again/i);
});

test('NVIDIA parsing skips noise and selects one valid adapter', () => {
  const output = [
    '',
    'Driver warning: GPU wake took longer than expected',
    '0, GPU-small, 8190, 8000',
    '1, GPU-large, 12282, 12000',
    '2, GPU-invalid, 90000, 90001',
    '',
  ].join('\r\n');
  const small = { totalBytes: 8190 * MiB, availableBytes: 8000 * MiB, multiGpu: true };
  const large = { totalBytes: 12282 * MiB, availableBytes: 12000 * MiB, multiGpu: true };
  assert.deepEqual(parseNvidiaMemory(output), large);
  assert.deepEqual(parseNvidiaMemory(output, ''), large);
  assert.deepEqual(parseNvidiaMemory(output, '0'), small);
  assert.deepEqual(parseNvidiaMemory(output, 'GPU-small'), small);
  assert.equal(parseNvidiaMemory(output, '2'), null);
  assert.equal(parseNvidiaMemory('Failed to initialize NVML'), null);
});
