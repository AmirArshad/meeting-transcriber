'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isGpuRuntimeActionBusyError, formatGpuRuntimeBusyAlertMessage, resolveGpuSettingsSurface, getUnsupportedGpuSettingsCopy, isLinuxCudaSettingsOffered, isCudaRuntimeSettingsSurface, getLinuxCudaSettingsDescription, getLinuxCudaBrokenRuntimeCopy, getLinuxCudaUninstallConfirmSuffix, shouldShowGpuUninstallButton, shouldShowGpuInstallOrRepairButton, shouldUseGpuRepairButton, shouldShowGpuHomeCta, shouldShowCudaRuntimeWarning } = require('../../src/renderer/gpu-settings-helpers');

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

test('unsupported GPU settings copy keeps Linux CUDA opt-in until an NVIDIA GPU is present', () => {
  const linux = getUnsupportedGpuSettingsCopy('linux');
  assert.match(linux.description, /No NVIDIA GPU was detected/i);
  assert.match(linux.description, /CPU faster-whisper/);
  assert.match(linux.description, /best-effort/i);
  assert.equal(linux.statusLabel, 'CPU transcription');
  assert.match(linux.diagnostics, /opt-in/i);
});

test('CUDA settings surface stays off Linux until the main-process probe is not unsupportedPlatform', () => {
  assert.equal(isCudaRuntimeSettingsSurface('win32', null), true);
  assert.equal(isLinuxCudaSettingsOffered('linux', { statusCode: 'unsupportedPlatform' }), false);
  assert.equal(isCudaRuntimeSettingsSurface('linux', { statusCode: 'unsupportedPlatform' }), false);
  assert.equal(isLinuxCudaSettingsOffered('linux', { statusCode: 'ready' }), true);
  assert.equal(isCudaRuntimeSettingsSurface('linux', { statusCode: 'missingLibraries' }), true);
  assert.equal(isCudaRuntimeSettingsSurface('darwin', { statusCode: 'ready' }), false);
});

test('Linux CUDA settings copy is opt-in and mentions uninstall back to CPU', () => {
  assert.match(getLinuxCudaSettingsDescription(), /Tested on CachyOS/i);
  assert.match(getLinuxCudaSettingsDescription(), /returns to CPU if you uninstall/i);
  assert.match(getLinuxCudaBrokenRuntimeCopy(), /uninstall to return to CPU/i);
  assert.match(getLinuxCudaUninstallConfirmSuffix(), /return to CPU faster-whisper/i);
});

test('Linux broken managed CUDA keeps Repair and Uninstall together', () => {
  const integrityFailure = {
    installed: false,
    managedRuntimePresent: true,
    statusCode: 'runtimeIntegrityFailed',
    deviceAvailable: false,
    runtimeLoadable: false,
  };
  const missingLibraries = {
    installed: false,
    managedRuntimePresent: true,
    statusCode: 'missingLibraries',
    missingLibraries: ['libcublas.so.12'],
    deviceAvailable: false,
    runtimeLoadable: false,
  };

  for (const cudaInfo of [integrityFailure, missingLibraries]) {
    assert.equal(shouldShowGpuUninstallButton('linux', cudaInfo), true);
    assert.equal(shouldShowGpuInstallOrRepairButton(cudaInfo), true);
    assert.equal(shouldUseGpuRepairButton('linux', cudaInfo), true);
    assert.equal(shouldShowCudaRuntimeWarning({
      platform: 'linux',
      gpuInfo: { hasGPU: true, gpuName: 'NVIDIA GeForce RTX 4070' },
      cudaInfo,
    }), true);
  }

  const firstInstall = {
    installed: false,
    managedRuntimePresent: false,
    statusCode: 'missingLibraries',
  };
  assert.equal(shouldShowGpuUninstallButton('linux', firstInstall), false);
  assert.equal(shouldShowGpuInstallOrRepairButton(firstInstall), true);
  assert.equal(shouldUseGpuRepairButton('linux', firstInstall), false);
});

test('Linux leftover managed CUDA keeps Uninstall after the GPU disappears', () => {
  const leftover = {
    installed: false,
    managedRuntimePresent: true,
    statusCode: 'deviceUnavailable',
    deviceAvailable: false,
    runtimeLoadable: false,
  };
  assert.equal(shouldShowGpuUninstallButton('linux', leftover), true);
  assert.equal(shouldShowGpuInstallOrRepairButton(leftover), true);
  assert.equal(shouldUseGpuRepairButton('linux', leftover), true);
  assert.equal(shouldShowCudaRuntimeWarning({
    platform: 'linux',
    gpuInfo: { hasGPU: false, gpuName: null },
    cudaInfo: leftover,
  }), true);
  assert.equal(shouldShowGpuHomeCta({
    platform: 'linux',
    gpuInfo: { hasGPU: false, gpuName: null },
    cudaInfo: leftover,
  }), false);
  assert.equal(shouldShowGpuHomeCta({
    platform: 'linux',
    gpuInfo: { hasGPU: true, gpuName: 'NVIDIA GeForce RTX 4070' },
    cudaInfo: leftover,
  }), true);
});

test('Windows GPU Uninstall still requires an installed runtime', () => {
  assert.equal(shouldShowGpuUninstallButton('win32', { installed: true }), true);
  assert.equal(shouldShowGpuUninstallButton('win32', { installed: false, managedRuntimePresent: true }), false);
  assert.equal(shouldShowGpuInstallOrRepairButton({ installed: false }), true);
  assert.equal(shouldShowGpuInstallOrRepairButton({ installed: true }), false);
});
