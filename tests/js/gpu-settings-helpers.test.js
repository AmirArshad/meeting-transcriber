'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isGpuRuntimeActionBusyError } = require('../../src/renderer/gpu-settings-helpers');

test('isGpuRuntimeActionBusyError detects busy runtime messages', () => {
  assert.equal(isGpuRuntimeActionBusyError({ message: 'GPU_RUNTIME_ACTION_BUSY' }), true);
  assert.equal(isGpuRuntimeActionBusyError({ message: 'GPU_RUNTIME_COMPUTE_BUSY' }), true);
  assert.equal(isGpuRuntimeActionBusyError({
    message: 'Local AI work is still running. Wait for transcription to finish before installing or repairing the GPU runtime.',
  }), true);
  assert.equal(isGpuRuntimeActionBusyError({ message: 'Install already in progress' }), true);
  assert.equal(isGpuRuntimeActionBusyError({ message: 'network failed' }), false);
  assert.equal(isGpuRuntimeActionBusyError(null), false);
});
