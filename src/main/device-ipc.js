'use strict';

/**
 * Device + preflight IPC service for the AvaNevis main process.
 *
 * Owns the audio-device, disk-space, audio-output, and macOS-permission probes
 * plus their IPC channels. `run-recording-preflight` is registered by
 * `src/main/recorder-service.js` and calls the exported probe helpers.
 * Handler/helper bodies are moved verbatim; cross-module dependencies are
 * injected via `deps`.
 */

const DISK_WARNING_BYTES = 10 * 1024 * 1024 * 1024;
const DISK_CRITICAL_BYTES = 2 * 1024 * 1024 * 1024;
const DISK_SPACE_WARNING_MESSAGE =
  'Less than 10 GB is available. Long recordings may run out of space.';

/**
 * Pure disk-space classification used by checkDiskSpace and unit tests.
 * @param {number} availableBytes
 * @returns {{ success: true, availableBytes: number, availableGB: string, warning: string|null, level: 'warning'|'critical'|null }}
 */
function buildDiskSpaceResult(availableBytes) {
  const freeBytes = Number(availableBytes);
  const freeGB = freeBytes / (1024 * 1024 * 1024);
  const warning = freeBytes < DISK_WARNING_BYTES ? DISK_SPACE_WARNING_MESSAGE : null;
  const level = freeBytes < DISK_CRITICAL_BYTES
    ? 'critical'
    : (warning ? 'warning' : null);

  return {
    success: true,
    availableBytes: freeBytes,
    availableGB: freeGB.toFixed(2),
    warning,
    level,
  };
}

function buildUnknownDiskSpaceResult() {
  return {
    success: true,
    availableBytes: -1,
    availableGB: null,
    warning: null,
    level: null,
  };
}

/**
 * @param {object} deps
 * @param {import('electron').App} deps.app
 * @param {typeof import('path')} deps.path
 * @param {typeof import('fs')} deps.fs
 * @param {typeof import('child_process').spawn} deps.spawn
 * @param {Function} deps.spawnTrackedPython
 * @param {object} deps.pythonConfig
 * @param {Function} deps.getBackendModuleArgs
 * @param {Function} deps.appendSpawnLogBuffer
 * @param {Function} deps.runProcessWithTimeout
 * @param {Function} deps.buildMacOSPermissionCheckFailureStatus
 * @param {number} deps.MACOS_PERMISSION_CHECK_TIMEOUT_MS
 * @param {Function} [deps.statfs] optional injectable `fs.promises.statfs`
 * @param {Function} [deps.logWarn]
 */
function createDeviceIpc(deps) {
  const {
    app,
    path,
    fs,
    spawn,
    spawnTrackedPython,
    pythonConfig,
    getBackendModuleArgs,
    appendSpawnLogBuffer,
    runProcessWithTimeout,
    buildMacOSPermissionCheckFailureStatus,
    MACOS_PERMISSION_CHECK_TIMEOUT_MS,
    logWarn = (...args) => console.warn(...args),
  } = deps;

  const statfs = typeof deps.statfs === 'function'
    ? deps.statfs
    : (typeof fs?.promises?.statfs === 'function'
      ? (...args) => fs.promises.statfs(...args)
      : null);

  async function checkDiskSpace() {
    try {
      const recordingsDir = path.join(app.getPath('userData'), 'recordings');

      // Ensure directory exists
      if (!fs.existsSync(recordingsDir)) {
        try {
          fs.mkdirSync(recordingsDir, { recursive: true });
        } catch (e) {
          // Non-fatal - directory will be created later when needed
          logWarn('Could not create recordings directory:', e.message);
          return buildUnknownDiskSpaceResult();
        }
      }

      if (typeof statfs !== 'function') {
        logWarn('Disk space probe unavailable: fs.promises.statfs is missing');
        return buildUnknownDiskSpaceResult();
      }

      let stats;
      try {
        stats = await statfs(recordingsDir);
      } catch (probeError) {
        logWarn('Disk space probe failed:', probeError?.message || probeError);
        return buildUnknownDiskSpaceResult();
      }

      const bavail = Number(stats?.bavail);
      const bsize = Number(stats?.bsize);
      if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || bsize <= 0) {
        logWarn('Disk space probe returned invalid bavail/bsize; treating space as unknown');
        return buildUnknownDiskSpaceResult();
      }

      return buildDiskSpaceResult(bavail * bsize);
    } catch (e) {
      console.error('Unexpected error in checkDiskSpace:', e);
      return buildUnknownDiskSpaceResult();
    }
  }

  /**
   * Validate audio devices before recording.
   * Checks that selected devices exist and are accessible.
   * GRACEFUL: Returns valid=true with warning if check fails, allowing recording to proceed.
   */
  function validateSelectedDevices({ micId, loopbackId }) {
    const TIMEOUT_MS = 10000; // 10 second timeout

    return new Promise((resolve) => {
      let resolved = false;
      let output = '';
      let errorOutput = '';

      // Timeout handler
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { python.kill(); } catch (e) { /* ignore */ }
          console.warn('validate-devices timed out - allowing recording to proceed');
          resolve({
            valid: true, // Allow recording to proceed
            warnings: ['Device validation timed out - proceeding anyway'],
            errors: []
          });
        }
      }, TIMEOUT_MS);

      let python;
      try {
        python = spawnTrackedPython(getBackendModuleArgs('device_manager'), { cwd: pythonConfig.backendPath });
      } catch (e) {
        clearTimeout(timeout);
        console.error('Failed to spawn device_manager module:', e);
        resolve({
          valid: true, // Allow recording to proceed
          warnings: ['Could not validate devices - proceeding anyway'],
          errors: []
        });
        return;
      }

      python.stdout.on('data', (data) => { output = appendSpawnLogBuffer(output, data); });
      python.stderr.on('data', (data) => { errorOutput = appendSpawnLogBuffer(errorOutput, data); });

      python.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        if (code !== 0) {
          console.warn('validate-devices failed with code', code);
          resolve({
            valid: true, // Allow recording to proceed
            warnings: ['Device enumeration failed - proceeding anyway'],
            errors: []
          });
          return;
        }

        try {
          const data = JSON.parse(output);
          const errors = [];
          const warnings = [];

          // Check microphone device
          const micDevice = data.input_devices.find(d => d.id === micId);
          if (!micDevice) {
            errors.push(`Microphone device (ID: ${micId}) not found. It may have been disconnected.`);
          }

          // Check loopback device (platform-specific)
          if (process.platform === 'darwin') {
            // macOS: loopbackId -1 means ScreenCaptureKit (virtual)
            if (loopbackId !== -1) {
              warnings.push('Non-standard loopback device selected on macOS.');
            }
          } else {
            // Windows: Check loopback device exists
            const loopbackDevice = data.loopback_devices.find(d => d.id === loopbackId);
            if (loopbackId >= 0 && !loopbackDevice) {
              errors.push(`Desktop audio device (ID: ${loopbackId}) not found. It may have been disconnected.`);
            }
          }

          resolve({
            valid: errors.length === 0,
            errors,
            warnings,
            devices: {
              mic: micDevice || null,
              loopback: loopbackId === -1 ? { name: 'System Audio (ScreenCaptureKit)', id: -1 } :
                        data.loopback_devices.find(d => d.id === loopbackId) || null
            }
          });
        } catch (e) {
          console.warn('Failed to parse device list:', e);
          resolve({
            valid: true, // Allow recording to proceed
            warnings: ['Could not parse device list - proceeding anyway'],
            errors: []
          });
        }
      });

      python.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        console.error('validate-devices error:', err);
        resolve({
          valid: true, // Allow recording to proceed
          warnings: ['Device validation error - proceeding anyway'],
          errors: []
        });
      });
    });
  }

  /**
   * Inspect the current macOS audio output device for diagnostics only.
   *
   * ScreenCaptureKit is expected to capture system audio before routing to the
   * active output device, but we still surface the current output target so
   * manual validation can confirm behavior on real hardware.
   */
  function checkAudioOutputSupport() {
    if (process.platform !== 'darwin') {
      // Windows WASAPI loopback works with all devices
      return { supported: true, warning: null };
    }

    const TIMEOUT_MS = 5000; // 5 second timeout

    return new Promise((resolve) => {
      let resolved = false;
      let output = '';

      // Timeout handler
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { proc.kill(); } catch (e) { /* ignore */ }
          console.warn('check-audio-output timed out');
          resolve({ supported: true, warning: null }); // Assume OK
        }
      }, TIMEOUT_MS);

      let proc;
      try {
        // Use system_profiler to get audio output info
        proc = spawn('system_profiler', ['SPAudioDataType', '-json']);
      } catch (e) {
        clearTimeout(timeout);
        console.error('Failed to spawn system_profiler:', e);
        resolve({ supported: true, warning: null }); // Assume OK
        return;
      }

      proc.stdout.on('data', (data) => { output = appendSpawnLogBuffer(output, data); });

      proc.on('close', (code) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        if (code !== 0) {
          resolve({ supported: true, warning: null }); // Unknown, assume OK
          return;
        }

        try {
          const data = JSON.parse(output);
          const audioData = data.SPAudioDataType || [];

          let deviceName = null;
          let deviceTransport = null;

          for (const section of audioData) {
            const items = section._items || [];
            for (const item of items) {
              // Check for default output device
              if (item.coreaudio_default_audio_output_device === 'spaudio_yes') {
                deviceName = item._name;
                deviceTransport = item.coreaudio_device_transport || null;
              }
            }
          }

          resolve({
            supported: true,
            warning: null,
            deviceName,
            deviceTransport,
          });
        } catch (e) {
          resolve({ supported: true, warning: null }); // Parse error, assume OK
        }
      });

      proc.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        console.error('check-audio-output error:', err);
        resolve({ supported: true, warning: null });
      });
    });
  }

  function getMacOSPermissionStatus(micId = null) {
    if (process.platform !== 'darwin') {
      return Promise.resolve({
        platform: process.platform,
        all_granted: true,
        microphone: { granted: true },
        screen_recording: { granted: true },
        system_audio_recording: { granted: null, probed: false },
      });
    }

    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle = null;
      const args = Number.isInteger(micId)
        ? getBackendModuleArgs('check_permissions', ['--mic-device-id', String(micId), '--skip-screen-recording-check'])
        : getBackendModuleArgs('check_permissions', ['--skip-screen-recording-check']);

      const proc = spawnTrackedPython(args, {
        cwd: pythonConfig.backendPath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      const settle = (status) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        resolve(status);
      };

      timeoutHandle = setTimeout(() => {
        console.warn('macOS permission status check timed out');
        try {
          proc.kill();
        } catch (error) {
          console.warn('Failed to kill timed-out macOS permission check:', error.message);
        }
        settle(buildMacOSPermissionCheckFailureStatus('macOS permission checks timed out before recording.'));
      }, MACOS_PERMISSION_CHECK_TIMEOUT_MS);

      proc.stdout.on('data', (data) => {
        stdout = appendSpawnLogBuffer(stdout, data);
      });

      proc.stderr.on('data', (data) => {
        stderr = appendSpawnLogBuffer(stderr, data);
      });

      proc.on('close', () => {
        if (settled) {
          return;
        }

        try {
          settle(JSON.parse(stdout));
        } catch (error) {
          console.warn('Failed to parse permission status:', error.message);
          if (stderr.trim()) {
            console.warn('Permission status stderr:', stderr.trim());
          }
          settle(buildMacOSPermissionCheckFailureStatus('Could not verify macOS permissions before recording.'));
        }
      });

      proc.on('error', (error) => {
        if (settled) {
          return;
        }

        console.warn('Permission status check failed:', error.message);
        settle(buildMacOSPermissionCheckFailureStatus('Could not run macOS permission checks before recording.'));
      });
    });
  }

  function registerIpc(ipcMain) {
    ipcMain.handle('validate-devices', async (event, options) => {
      return validateSelectedDevices(options);
    });

    /**
     * Check disk space before recording.
     * Returns available space and warnings.
     */
    ipcMain.handle('check-disk-space', async () => {
      return await checkDiskSpace();
    });

    ipcMain.handle('check-audio-output', async () => {
      return checkAudioOutputSupport();
    });

    ipcMain.handle('get-macos-permission-status', async () => {
      return getMacOSPermissionStatus();
    });

    ipcMain.handle('get-audio-devices', async () => {
      return new Promise((resolve, reject) => {
        const python = spawnTrackedPython(getBackendModuleArgs('device_manager'), { cwd: pythonConfig.backendPath });

        let output = '';
        let errorOutput = '';

        python.stdout.on('data', (data) => {
          output = appendSpawnLogBuffer(output, data);
        });

        python.stderr.on('data', (data) => {
          errorOutput = appendSpawnLogBuffer(errorOutput, data);
        });

        python.on('close', (code) => {
          if (code === 0) {
            try {
              const data = JSON.parse(output);
              // Reformat to match UI expectations
              resolve({
                inputs: data.input_devices,
                loopbacks: data.loopback_devices,
                defaults: data.defaults
              });
            } catch (e) {
              reject(new Error(`Failed to parse device list: ${e.message}`));
            }
          } else {
            reject(new Error(`Python process exited with code ${code}: ${errorOutput}`));
          }
        });
        python.on('error', reject);
      });
    });

    /**
     * Warm up audio system (enumerate devices and test streams)
     * This should be called on app startup to initialize audio drivers
     */
    ipcMain.handle('warm-up-audio-system', async () => {
      return new Promise((resolve) => {
        // Step 1: Enumerate devices (forces driver initialization)
        const python = spawnTrackedPython(getBackendModuleArgs('device_manager'), { cwd: pythonConfig.backendPath });

        let output = '';

        python.stdout.on('data', (data) => {
          output = appendSpawnLogBuffer(output, data);
        });

        python.on('close', (code) => {
          if (code === 0) {
            try {
              const data = JSON.parse(output);
              console.log('Audio system warmed up successfully');
              console.log(`  Found ${data.input_devices.length} input devices`);
              console.log(`  Found ${data.loopback_devices.length} loopback devices`);
              resolve({ success: true, deviceCount: data.input_devices.length + data.loopback_devices.length });
            } catch (e) {
              // Even if parsing fails, enumeration happened so drivers are warm
              console.log('Audio system enumeration completed (with parsing error)');
              resolve({ success: true, deviceCount: 0 });
            }
          } else {
            // Even if it failed, we tried to initialize
            console.log('Audio system warm-up completed (with error)');
            resolve({ success: true, deviceCount: 0 });
          }
        });
        python.on('error', () => {
          console.log('Audio system warm-up completed (spawn error)');
          resolve({ success: true, deviceCount: 0 });
        });
      });
    });
  }

  return {
    checkDiskSpace,
    validateSelectedDevices,
    checkAudioOutputSupport,
    getMacOSPermissionStatus,
    registerIpc,
  };
}

/**
 * Convenience wiring helper: build the device service and register IPC.
 * Returns the service so `run-recording-preflight` (kept in main.js) can call
 * the exported probe helpers.
 */
function registerDeviceIpc(ipcMain, deps) {
  const service = createDeviceIpc(deps);
  service.registerIpc(ipcMain);
  return service;
}

module.exports = {
  createDeviceIpc,
  registerDeviceIpc,
  buildDiskSpaceResult,
  buildUnknownDiskSpaceResult,
  DISK_WARNING_BYTES,
  DISK_CRITICAL_BYTES,
  DISK_SPACE_WARNING_MESSAGE,
};
