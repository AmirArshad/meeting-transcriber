'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createSummaryProcessSlot } = require('../../src/main/summary-process-slot');
const { getSummaryModelFit, parseNvidiaMemory, classifyWindowsGpuAdapters } = require('../../src/ai-addon/summary-device-fit');

test('a closed launcher does not release the slot while its POSIX group is alive', async () => {
  let groupPresent = true;
  const signals = [];
  const slot = createSummaryProcessSlot({
    platform: 'darwin', releaseTimeoutMs: 2, pollMs: 1,
    kill: (pid, signal) => {
      assert.equal(pid, -42);
      signals.push(signal);
      if (!groupPresent) throw Object.assign(new Error('exited'), { code: 'ESRCH' });
    },
  });
  const launcher = Object.assign(new EventEmitter(), { pid: 42, avanevisProcessGroup: true });
  slot.spawnModel(() => launcher);
  launcher.emit('close', 0);
  await assert.rejects(slot.ensureExited(), { code: 'SUMMARY_MODEL_EXIT_UNCONFIRMED' });
  assert.ok(signals.includes('SIGKILL'));
  assert.throws(() => slot.spawnModel(() => assert.fail('next process started early')), { code: 'SUMMARY_MODEL_EXIT_UNCONFIRMED' });
  groupPresent = false;
  await slot.ensureExited();
  assert.equal(slot.hasOutstandingProcess(), false);
});

test('a Windows launcher can be replaced only after its named job is released', async () => {
  let jobName;
  let released = false;
  const slot = createSummaryProcessSlot({
    platform: 'win32', releaseTimeoutMs: 2, pollMs: 1,
    checkWindowsJob: (name) => { assert.equal(name, jobName); return released; },
  });
  const launcher = Object.assign(new EventEmitter(), { pid: 42 });
  slot.spawnModel((name) => { jobName = name; return launcher; });
  assert.match(jobName, /^Local\\AvaNevis-Summary-/);
  launcher.emit('close', 1);
  await assert.rejects(slot.ensureExited(), { code: 'SUMMARY_MODEL_EXIT_UNCONFIRMED' });
  released = true;
  await slot.ensureExited();
  assert.equal(slot.hasOutstandingProcess(), false);
});

test('device fit blocks low free VRAM and keeps a below-recommended fit advisory', () => {
  const inputs = {
    model: { memoryGuidance: { gpu: 8 } }, artifact: { estimatedSizeBytes: 4 * 1024 ** 3 },
    availability: { supported: true }, runtimeArtifact: {}, platform: 'linux',
  };
  const oneGpu = '0, GPU-a, 6144, 5000';
  assert.deepEqual(parseNvidiaMemory(`${oneGpu}\n1, GPU-b, 8192, 7000`), {
    totalBytes: 8192 * 1024 ** 2,
    availableBytes: 7000 * 1024 ** 2,
    multiGpu: true,
  });
  const fit = getSummaryModelFit({ ...inputs, deviceMemory: parseNvidiaMemory(oneGpu) });
  assert.equal(fit.status, 'tight');
  assert.equal(fit.blocked, false);
  const blocked = getSummaryModelFit({ ...inputs, deviceMemory: parseNvidiaMemory('0, GPU-a, 8192, 0') });
  assert.equal(blocked.blocked, true);
});

test('device fit enforces 32k runtime memory floor and macOS unified headroom', () => {
  const { getModelById, getSummaryArtifactForPlatform, getSummaryRuntimeArtifactForPlatform, AI_MODEL_CATALOG } = require('../../src/ai-addon-state');
  const GiB = 1024 ** 3;
  const macFit = (modelId, totalGiB) => getSummaryModelFit({
    model: getModelById('summary', modelId),
    artifact: getSummaryArtifactForPlatform(modelId, 'darwin', 'arm64'),
    runtimeArtifact: getSummaryRuntimeArtifactForPlatform('darwin', 'arm64', AI_MODEL_CATALOG, modelId),
    availability: { supported: true },
    deviceMemory: { totalBytes: totalGiB * GiB, availableBytes: null },
    platform: 'darwin',
  });
  const gemma12On8G = macFit('gemma-4-12b', 8);
  assert.equal(gemma12On8G.blocked, true);
  assert.equal(gemma12On8G.minimumRuntimeBytes, 8409792512);
  assert.equal(macFit('qwen3.5-9b-q4-k-m', 8).blocked, true);
  assert.equal(macFit('qwen3.5-4b-q4-k-m', 8).blocked, false);
  assert.equal(macFit('gemma-4-12b', 16).blocked, false);

  const gpuFit = (modelId, totalMiB, freeMiB) => getSummaryModelFit({
    model: getModelById('summary', modelId),
    artifact: getSummaryArtifactForPlatform(modelId, 'win32', 'x64'),
    runtimeArtifact: getSummaryRuntimeArtifactForPlatform('win32', 'x64', AI_MODEL_CATALOG, modelId),
    availability: { supported: true },
    deviceMemory: { totalBytes: totalMiB * 1024 ** 2, availableBytes: freeMiB * 1024 ** 2 },
    platform: 'win32',
  });
  assert.notEqual(gpuFit('gemma-4-12b', 16384, 16384).minimumRuntimeBytes, gemma12On8G.minimumRuntimeBytes);
  assert.equal(gpuFit('gemma-4-e4b', 4800, 4800).blocked, true);
  assert.equal(gpuFit('gemma-4-e4b', 8192, 4800).blocked, true);
  assert.equal(gpuFit('gemma-4-e4b', 8192, 6000).blocked, false);
});

test('Windows GPU evidence rejects only known non-NVIDIA adapters', () => {
  const intel = { vendorId: 0x8086, deviceId: 0x1234 };
  assert.equal(classifyWindowsGpuAdapters([intel, { vendorId: 0x1002, deviceId: 1 }]), 'incompatible');
  assert.equal(classifyWindowsGpuAdapters([intel, { vendorId: 0x10de, deviceId: 1 }]), 'unknown');
  assert.equal(classifyWindowsGpuAdapters([intel, { vendorId: 0x1414, deviceId: 1 }]), 'unknown');
  assert.equal(classifyWindowsGpuAdapters([{ vendorId: 0x8086 }]), 'unknown');
  assert.equal(classifyWindowsGpuAdapters([]), 'unknown');
});

test('host readings preserve unknown guidance and incompatible GPU evidence blocks Windows', () => {
  const GiB = 1024 ** 3;
  const inputs = {
    model: { memoryGuidance: { gpu: 8 } }, artifact: { estimatedSizeBytes: 4 * GiB },
    availability: { supported: true }, runtimeArtifact: {}, platform: 'win32',
    deviceMemory: { totalBytes: 16 * GiB, availableBytes: 16 * GiB, systemTotalBytes: 8 * GiB, systemAvailableBytes: 2 * GiB },
  };
  const fit = getSummaryModelFit(inputs);
  assert.equal(fit.systemRecommendedBytes, null);
  assert.equal(fit.systemTotalBytes, 8 * GiB);
  assert.equal(fit.systemAvailableBytes, 2 * GiB);
  assert.equal(fit.blocked, false);
  const incompatible = getSummaryModelFit({ ...inputs, deviceMemory: { ...inputs.deviceMemory, gpuCompatibility: 'incompatible' } });
  assert.equal(incompatible.status, 'unavailable');
  assert.equal(incompatible.blocked, true);
  const unknown = getSummaryModelFit({ ...inputs, deviceMemory: { systemTotalBytes: 8 * GiB } });
  assert.equal(unknown.status, 'unknown');
  const unavailable = getSummaryModelFit({ ...inputs, availability: { supported: false } });
  assert.equal(unavailable.blocked, true);
});

test('hasActiveNonClosedProcess reflects open vs closed process state', () => {
  const slot = createSummaryProcessSlot({ platform: 'darwin', releaseTimeoutMs: 5, pollMs: 1, kill: () => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }); } });
  assert.equal(slot.hasActiveNonClosedProcess(), false);
  const proc = Object.assign(new EventEmitter(), { pid: 99, avanevisProcessGroup: true });
  slot.spawnModel(() => proc);
  assert.equal(slot.hasActiveNonClosedProcess(), true);
  proc.emit('close', 0);
  assert.equal(slot.hasActiveNonClosedProcess(), false);
});
