'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isGpuRuntimeActionBusyError, formatGpuRuntimeBusyAlertMessage, resolveGpuSettingsSurface, getUnsupportedGpuSettingsCopy } = require('../../src/renderer/gpu-settings-helpers');

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

test('formatGpuRuntimeBusyAlertMessage keeps N-queued compute-busy copy', () => {
  const queued = '2 recordings are queued for transcription — finish or cancel them before installing or repairing the GPU runtime.';
  assert.equal(
    formatGpuRuntimeBusyAlertMessage({ code: 'GPU_RUNTIME_COMPUTE_BUSY', message: queued }),
    queued,
  );
  assert.equal(
    formatGpuRuntimeBusyAlertMessage({ code: 'MODEL_DOWNLOAD_COMPUTE_BUSY', message: queued }),
    queued,
  );
  assert.match(
    formatGpuRuntimeBusyAlertMessage({ code: 'GPU_RUNTIME_ACTION_BUSY', message: 'GPU_RUNTIME_ACTION_BUSY' }),
    /Another GPU setup operation is already running/,
  );
});

test('resolveGpuSettingsSurface keeps Linux off the Windows CUDA surface', () => {
  assert.equal(resolveGpuSettingsSurface('darwin', 'arm64'), 'macos-metal');
  assert.equal(resolveGpuSettingsSurface('darwin', 'x64'), 'macos-intel-cpu');
  assert.equal(resolveGpuSettingsSurface('win32', 'x64'), 'windows-cuda');
  assert.equal(resolveGpuSettingsSurface('linux', 'x64'), 'unsupported');
  assert.equal(resolveGpuSettingsSurface('freebsd', 'x64'), 'unsupported');
});

test('unsupported GPU settings copy does not advertise Linux CUDA as ready', () => {
  const linux = getUnsupportedGpuSettingsCopy('linux');
  assert.match(linux.description, /not available yet/i);
  assert.equal(linux.statusLabel, 'Not available yet');
  assert.match(linux.diagnostics, /not offered on Linux/);
});
