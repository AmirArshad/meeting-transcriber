'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isGpuRuntimeActionBusyError } = require('../../src/renderer/gpu-settings-helpers');

test('isGpuRuntimeActionBusyError detects busy runtime messages', () => {
  assert.equal(isGpuRuntimeActionBusyError({ message: 'GPU_RUNTIME_ACTION_BUSY' }), true);
  assert.equal(isGpuRuntimeActionBusyError({ message: 'Install already in progress' }), true);
  assert.equal(isGpuRuntimeActionBusyError({ message: 'network failed' }), false);
  assert.equal(isGpuRuntimeActionBusyError(null), false);
});
