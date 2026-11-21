'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createSummaryProcessSlot } = require('../../src/main/summary-process-slot');
const { getSummaryModelFit, parseNvidiaMemory } = require('../../src/ai-addon/summary-device-fit');

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

test('device fit blocks insufficient weight capacity and keeps unmeasured estimates advisory', () => {
  const inputs = {
    model: { memoryGuidance: { gpu: 8 } }, artifact: { estimatedSizeBytes: 4 * 1024 ** 3 },
    availability: { supported: true }, runtimeArtifact: {}, platform: 'linux',
  };
  const oneGpu = '0, GPU-a, 6144, 5000';
  assert.equal(parseNvidiaMemory(`${oneGpu}\n1, GPU-b, 8192, 7000`), null);
  const fit = getSummaryModelFit({ ...inputs, deviceMemory: parseNvidiaMemory(oneGpu) });
  assert.equal(fit.status, 'needs_more_memory');
  assert.equal(fit.blocked, false);
  const blocked = getSummaryModelFit({ ...inputs, deviceMemory: parseNvidiaMemory('0, GPU-a, 8192, 0') });
  assert.equal(blocked.blocked, true);
});
