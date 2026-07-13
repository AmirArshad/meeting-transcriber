'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRecordingsMaintenanceGate } = require('../../src/main/recordings-maintenance-gate');

function createFakeTimers() {
  let now = 0;
  /** @type {Map<number, { due: number, fn: Function }>} */
  const timers = new Map();
  let nextId = 1;

  return {
    nowFn: () => now,
    setTimeoutFn(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { due: now + ms, fn });
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      const due = [...timers.entries()]
        .filter(([, entry]) => entry.due <= now)
        .sort((a, b) => a[1].due - b[1].due);
      for (const [id, entry] of due) {
        timers.delete(id);
        entry.fn();
      }
    },
  };
}

test('gate acquires and releases scan/recovery ownership', async () => {
  const gate = createRecordingsMaintenanceGate();
  assert.equal(gate.getOwner(), 'idle');
  const scan = await gate.acquire('scan');
  assert.equal(scan.ok, true);
  assert.equal(gate.getOwner(), 'scan');
  assert.equal(gate.release('scan'), true);
  assert.equal(gate.getOwner(), 'idle');

  const recovery = await gate.acquire('recovery');
  assert.equal(recovery.ok, true);
  assert.equal(gate.getOwner(), 'recovery');
  assert.equal(gate.release('recovery'), true);
});

test('scan cannot acquire while recovery holds the gate', async () => {
  const gate = createRecordingsMaintenanceGate();
  await gate.acquire('recovery');
  const denied = await gate.acquire('scan');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'RECORDINGS_MAINTENANCE_IN_PROGRESS');
  assert.equal(denied.owner, 'recovery');
});

test('recovery waits briefly for scan then acquires', async () => {
  const timers = createFakeTimers();
  const gate = createRecordingsMaintenanceGate({
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: timers.nowFn,
  });
  await gate.acquire('scan');

  let resolved = null;
  const pending = gate.acquire('recovery', { waitForScanMs: 1000 }).then((result) => {
    resolved = result;
    return result;
  });

  await Promise.resolve();
  assert.equal(resolved, null);
  gate.release('scan');
  timers.advance(0);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(gate.getOwner(), 'recovery');
});

test('start-recording waits briefly behind scan then admits', async () => {
  const timers = createFakeTimers();
  const gate = createRecordingsMaintenanceGate({
    scanWaitMs: 2000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: timers.nowFn,
  });
  await gate.acquire('scan');

  let resolved = null;
  const pending = gate.admitStartRecording().then((result) => {
    resolved = result;
    return result;
  });
  await Promise.resolve();
  assert.equal(resolved, null);
  gate.release('scan');
  timers.advance(0);
  const result = await pending;
  assert.equal(result.ok, true);
});

test('start-recording rejects immediately while recovery holds the gate', async () => {
  const gate = createRecordingsMaintenanceGate();
  await gate.acquire('recovery');
  const denied = await gate.admitStartRecording();
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'RECORDING_RECOVERY_IN_PROGRESS');
});

test('start-recording times out when scan never releases', async () => {
  const timers = createFakeTimers();
  const gate = createRecordingsMaintenanceGate({
    scanWaitMs: 100,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    nowFn: timers.nowFn,
  });
  await gate.acquire('scan');

  const pending = gate.admitStartRecording();
  // Drive the wait timeout without releasing scan.
  for (let i = 0; i < 5; i += 1) {
    timers.advance(50);
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  const denied = await pending;
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'RECORDING_SCAN_IN_PROGRESS');
});
