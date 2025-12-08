/**
 * Main process for Meeting Transcriber Electron app.
 *
 * This file:
 * - Creates the application window
 * - Manages communication between UI and Python backend
 * - Handles application lifecycle
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, powerSaveBlocker } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const { checkForUpdates, openDownloadPage } = require('./updater');

// Use Electron's default userData path, which handles packaging correctly
// This is typically: C:\Users\<username>\AppData\Roaming\Meeting Transcriber
// No need to set a custom path - Electron manages this properly

let mainWindow;
let pythonProcess;
let recordingStartTime = null;
let activeProcesses = []; // Track all spawned Python processes for cleanup
let tray = null;
let isQuitting = false;
let powerSaveId = null; // Power save blocker ID for preventing system suspension during recording
let recordingHeartbeat = null; // Heartbeat monitor to detect recording failures
let lastLevelUpdate = null; // Timestamp of last audio level update

// ============================================================================
// Python Process Management
// ============================================================================

/**
 * Helper to spawn and track Python processes for cleanup
 */
function spawnTrackedPython(args, options = {}) {
  const proc = spawn(pythonConfig.pythonExe, args, options);
  activeProcesses.push(proc);

  // Auto-remove from tracking when process exits
  proc.on('close', () => {
    const index = activeProcesses.indexOf(proc);
    if (index > -1) {
      activeProcesses.splice(index, 1);
    }
  });

  return proc;
}

// ============================================================================
// Python Runtime Configuration
// ============================================================================

/**
 * Determine the correct Python executable and backend path based on environment
 * In production (packaged app), use bundled Python
 * In development, use system Python
 */
function getPythonConfig() {
  const isDev = !app.isPackaged;
  const isMac = process.platform === 'darwin';

  if (isDev) {
    // Development mode - use system Python
    return {
      pythonExe: isMac ? 'python3' : 'python',
      backendPath: path.join(__dirname, '../backend'),
      ffmpegPath: 'ffmpeg' // Assume in PATH
    };
  } else {
    // Production mode - use bundled Python
    const resourcesPath = process.resourcesPath;

    if (isMac) {
      // macOS: Use bundled Python from resources/python/bin/
      return {
        pythonExe: path.join(resourcesPath, 'python', 'bin', 'python3'),
        backendPath: path.join(resourcesPath, 'backend'),
        ffmpegPath: path.join(resourcesPath, 'ffmpeg', 'ffmpeg')
      };
    } else {
      // Windows: Use bundled Python from resources/python/
      return {
        pythonExe: path.join(resourcesPath, 'python', 'python.exe'),
        backendPath: path.join(resourcesPath, 'backend'),
        ffmpegPath: path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe')
      };
    }
  }
}

const pythonConfig = getPythonConfig();

/**
 * Get the platform-specific transcriber script path.
 * Returns the appropriate transcriber based on the operating system:
 * - macOS: MLX Whisper (Metal GPU acceleration for Apple Silicon)
 * - Windows/others: faster-whisper (CUDA GPU acceleration)
 */
function getTranscriberScript() {
  const isMac = process.platform === 'darwin';

  if (isMac) {
    // Check for Apple Silicon (arm64)
    // MLX requires native arm64 execution
    if (process.arch === 'arm64') {
      return path.join(pythonConfig.backendPath, 'transcription', 'mlx_whisper_transcriber.py');
    } else {
      // Intel Mac (x64) -> Use faster-whisper (CPU fallback)
      console.log('Intel Mac detected: Using faster-whisper fallback (CPU)');
      return path.join(pythonConfig.backendPath, 'transcription', 'faster_whisper_transcriber.py');
    }
  }

  // Windows/Linux -> faster-whisper (CUDA/CPU)
  return path.join(pythonConfig.backendPath, 'transcription', 'faster_whisper_transcriber.py');
}

// Add ffmpeg to PATH so Python scripts can find it
if (!app.isPackaged) {
  // In dev mode, ffmpeg should already be in PATH
} else {
  // In production, add the bundled ffmpeg directory to PATH
  const ffmpegDir = path.dirname(pythonConfig.ffmpegPath);
  const pathSeparator = process.platform === 'win32' ? ';' : ':';
  process.env.PATH = `${ffmpegDir}${pathSeparator}${process.env.PATH}`;
}

// Suppress Python warnings to reduce console noise
process.env.PYTHONWARNINGS = 'ignore::DeprecationWarning,ignore::UserWarning';

console.log('Python Configuration:', pythonConfig);
console.log('userData path:', app.getPath('userData'));
console.log('Recordings will be saved to:', path.join(app.getPath('userData'), 'recordings'));
console.log('Transcriber:', getTranscriberScript());

// ============================================================================
// Safety Checks and Verification Functions
// ============================================================================

/**
 * Helper to run a process with timeout.
 * Returns a promise that resolves with { stdout, stderr, code } or rejects on timeout/error.
 */
function runProcessWithTimeout(command, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        try { proc.kill(); } catch (e) { /* ignore */ }
      }
    };

    // Set timeout
    const timeout = setTimeout(() => {
      cleanup();
      resolve({ stdout, stderr, code: -1, timedOut: true });
    }, timeoutMs);

    let proc;
    try {
      proc = spawn(command, args);
    } catch (e) {
      clearTimeout(timeout);
      resolve({ stdout: '', stderr: e.message, code: -1, error: e });
      return;
    }

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout, stderr, code: code ?? 0 });
      }
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ stdout, stderr, code: -1, error: err });
      }
    });
  });
}

/**
 * Verify Python executable exists and runs correctly.
 * Returns object with success status and version info.
 * GRACEFUL: Always returns, never throws. Failure is non-fatal in dev mode.
 */
async function verifyPythonInstallation() {
  try {
    const pythonPath = pythonConfig.pythonExe;

    // Check if file exists (only for packaged app)
    if (app.isPackaged && !fs.existsSync(pythonPath)) {
      return {
        success: false,
        error: `Python runtime not found at: ${pythonPath}`,
        help: 'Please reinstall the application.'
      };
    }

    const result = await runProcessWithTimeout(pythonPath, ['--version'], 10000);

    if (result.timedOut) {
      return {
        success: false,
        error: 'Python check timed out',
        help: 'The Python runtime is not responding. Try restarting the application.'
      };
    }

    if (result.error) {
      return {
        success: false,
        error: `Python failed to start: ${result.error.message}`,
        help: 'The Python runtime may be missing or corrupted.'
      };
    }

    if (result.code === 0) {
      const version = (result.stdout + result.stderr).replace('Python ', '').trim();
      return { success: true, version };
    } else {
      return {
        success: false,
        error: `Python failed to start (exit code ${result.code})`,
        help: 'The Python runtime may be corrupted. Please reinstall the application.'
      };
    }
  } catch (e) {
    // Catch any unexpected errors - fail gracefully
    console.error('Unexpected error in verifyPythonInstallation:', e);
    return {
      success: false,
      error: `Unexpected error: ${e.message}`,
      help: 'An unexpected error occurred during startup checks.'
    };
  }
}

/**
 * Verify FFmpeg is available for audio compression.
 * Returns object with success status.
 * GRACEFUL: Always returns, never throws. Failure is non-fatal.
 */
async function verifyFFmpegInstallation() {
  try {
    const ffmpegPath = pythonConfig.ffmpegPath;

    // Check if file exists (only for packaged app)
    if (app.isPackaged && !fs.existsSync(ffmpegPath)) {
      return {
        success: false,
        error: `FFmpeg not found at: ${ffmpegPath}`,
        help: 'Audio compression will not work. Please reinstall the application.'
      };
    }

    const result = await runProcessWithTimeout(ffmpegPath, ['-version'], 10000);

    if (result.timedOut || result.error) {
      return {
        success: false,
        error: result.timedOut ? 'FFmpeg check timed out' : `FFmpeg error: ${result.error?.message}`,
        help: 'Audio compression may not work correctly.'
      };
    }

    if (result.code === 0) {
      const versionMatch = result.stdout.match(/ffmpeg version ([^\s]+)/);
      return {
        success: true,
        version: versionMatch ? versionMatch[1] : 'unknown'
      };
    } else {
      return {
        success: false,
        error: 'FFmpeg failed to run',
        help: 'Audio compression may not work correctly.'
      };
    }
  } catch (e) {
    console.error('Unexpected error in verifyFFmpegInstallation:', e);
    return { success: false, error: `Unexpected error: ${e.message}` };
  }
}

/**
 * Check available disk space in recordings directory.
 * Returns object with available space in bytes and warnings.
 * GRACEFUL: Always returns success (with unknown space) if check fails.
 */
async function checkDiskSpace() {
  try {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');

    // Ensure directory exists
    if (!fs.existsSync(recordingsDir)) {
      try {
        fs.mkdirSync(recordingsDir, { recursive: true });
      } catch (e) {
        // Non-fatal - directory will be created later when needed
        console.warn('Could not create recordings directory:', e.message);
        return { success: true, availableBytes: -1, warning: null };
      }
    }

    if (process.platform === 'win32') {
      // Windows: Use wmic to get free space
      const drive = recordingsDir.split(':')[0] + ':';
      const result = await runProcessWithTimeout(
        'wmic',
        ['logicaldisk', 'where', `DeviceID="${drive}"`, 'get', 'FreeSpace', '/value'],
        5000
      );

      if (result.code === 0 && !result.timedOut) {
        const match = result.stdout.match(/FreeSpace=(\d+)/);
        if (match) {
          const freeBytes = parseInt(match[1], 10);
          const freeGB = freeBytes / (1024 * 1024 * 1024);
          return {
            success: true,
            availableBytes: freeBytes,
            availableGB: freeGB.toFixed(2),
            warning: freeBytes < 500 * 1024 * 1024 ? 'Low disk space (< 500MB)' : null
          };
        }
      }
      // Fall through to return unknown
    } else {
      // macOS/Linux: Use df command
      const result = await runProcessWithTimeout('df', ['-k', recordingsDir], 5000);

      if (result.code === 0 && !result.timedOut) {
        const lines = result.stdout.trim().split('\n');
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          if (parts.length >= 4) {
            const freeKB = parseInt(parts[3], 10);
            const freeBytes = freeKB * 1024;
            const freeGB = freeBytes / (1024 * 1024 * 1024);
            return {
              success: true,
              availableBytes: freeBytes,
              availableGB: freeGB.toFixed(2),
              warning: freeBytes < 500 * 1024 * 1024 ? 'Low disk space (< 500MB)' : null
            };
          }
        }
      }
    }

    // Unknown disk space - assume OK
    return { success: true, availableBytes: -1, warning: null };
  } catch (e) {
    console.error('Unexpected error in checkDiskSpace:', e);
    return { success: true, availableBytes: -1, warning: null };
  }
}

/**
 * Run all startup verification checks.
 * Shows dialog if critical checks fail in packaged app.
 * GRACEFUL: In dev mode, failures are warnings only. Never crashes the app.
 */
async function runStartupChecks() {
  console.log('=== Running Startup Safety Checks ===');

  try {
    // Check Python
    const pythonCheck = await verifyPythonInstallation();
    if (pythonCheck.success) {
      console.log(`✓ Python verified: ${pythonCheck.version}`);
    } else {
      console.error(`✗ Python check failed: ${pythonCheck.error}`);

      // Only fatal in packaged app - in dev mode, system Python might work
      if (app.isPackaged) {
        dialog.showErrorBox('Installation Error', `${pythonCheck.error}\n\n${pythonCheck.help}`);
        app.quit();
        return false;
      } else {
        console.warn('⚠ Continuing in dev mode despite Python check failure');
      }
    }

    // Check FFmpeg (non-fatal)
    const ffmpegCheck = await verifyFFmpegInstallation();
    if (ffmpegCheck.success) {
      console.log(`✓ FFmpeg verified: ${ffmpegCheck.version}`);
    } else {
      console.warn(`⚠ FFmpeg check failed: ${ffmpegCheck.error}`);
    }

    // Check disk space (non-fatal)
    const diskCheck = await checkDiskSpace();
    if (diskCheck.success) {
      if (diskCheck.availableGB && diskCheck.availableBytes > 0) {
        console.log(`✓ Disk space: ${diskCheck.availableGB} GB available`);
      }
      if (diskCheck.warning) {
        console.warn(`⚠ ${diskCheck.warning}`);
      }
    }

    console.log('=== Startup Checks Complete ===');
    return true;
  } catch (e) {
    // Catch any unexpected errors - don't crash the app
    console.error('Unexpected error during startup checks:', e);
    console.warn('⚠ Continuing despite startup check errors');
    return true; // Continue anyway
  }
}

// Create the system tray
function createTray() {
  // Platform-specific icon paths
  // macOS: Uses template PNG images that adapt to light/dark mode
  // Windows: Uses ICO file
  let iconPath;

  if (process.platform === 'darwin') {
    // macOS: Use template image for menu bar
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'iconTemplate.png')
      : path.join(__dirname, '../build/iconTemplate.png');
  } else {
    // Windows/Linux: Use ICO file
    iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.ico')
      : path.join(__dirname, '../build/icon.ico');
  }

  tray = new Tray(iconPath);

  // macOS: Mark as template image for automatic dark mode support
  if (process.platform === 'darwin') {
    tray.setImage(iconPath);  // Ensure template image is used
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide Window',
      click: () => {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      type: 'separator'
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Meeting Transcriber');
  tray.setContextMenu(contextMenu);

  // Show/hide window on tray icon click
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Create the main application window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'default',
    icon: path.join(__dirname, '../assets/icon.png')
  });

  // Load the HTML file
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Open DevTools in development mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Prevent window from closing, minimize to tray instead
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();

      // Show dialog to ask user what they want to do
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Minimize to Tray',
        message: 'Would you like to close the app or minimize it to the system tray?',
        detail: 'Minimizing to tray keeps the app running in the background.',
        buttons: ['Minimize to Tray', 'Close App', 'Cancel'],
        defaultId: 0,
        cancelId: 2
      }).then(result => {
        if (result.response === 0) {
          // Minimize to tray
          mainWindow.hide();
        } else if (result.response === 1) {
          // Close app
          isQuitting = true;
          app.quit();
        }
        // Cancel does nothing
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Set up application menu
  createApplicationMenu();
}

/**
 * Create application menu with Help > Check for Updates
 */
function createApplicationMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: async () => {
            const updateInfo = await checkForUpdates();
            if (updateInfo && mainWindow) {
              mainWindow.webContents.send('update-available', updateInfo);
            } else if (mainWindow) {
              dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'No Updates Available',
                message: 'You\'re up to date!',
                detail: `Meeting Transcriber v${app.getVersion()} is the latest version.`,
                buttons: ['OK']
              });
            }
          }
        },
        { type: 'separator' },
        {
          label: 'View on GitHub',
          click: () => {
            require('electron').shell.openExternal('https://github.com/AmirArshad/meeting-transcriber');
          }
        },
        {
          label: 'Report Issue',
          click: () => {
            require('electron').shell.openExternal('https://github.com/AmirArshad/meeting-transcriber/issues');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

/**
 * Preload Whisper model in background to improve first-time experience
 * Uses 'small' model by default as it balances quality and speed
 */
function preloadWhisperModel() {
  const modelSize = 'small'; // Default model size
  console.log(`Preloading Whisper model (${modelSize})...`);

  const preloadProcess = spawnTrackedPython([
    getTranscriberScript(),
    '--preload',
    '--model', modelSize
  ]);

  preloadProcess.stderr.on('data', (data) => {
    console.log(`[Model Preload] ${data.toString().trim()}`);
  });

  preloadProcess.on('close', (code) => {
    if (code === 0) {
      console.log('Whisper model preloaded successfully');
    } else {
      console.warn(`Model preload failed with code ${code} (non-critical)`);
    }
  });
}

/**
 * Check macOS permissions (microphone and screen recording).
 *
 * This runs asynchronously in the background and shows a notification
 * if permissions are missing. The permission prompts will be triggered
 * when the user first tries to record.
 */
function checkMacOSPermissions() {
  const checkScript = path.join(pythonConfig.backendPath, 'check_permissions.py');

  console.log('Checking macOS permissions...');

  const proc = spawn(pythonConfig.pythonExe, [checkScript], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  proc.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  proc.on('close', (code) => {
    try {
      const result = JSON.parse(stdout);

      // Log permission status
      console.log('Permission check result:', result);

      // If any permission is missing, the app will still work - permissions
      // will be requested when the user first tries to use the feature
      if (!result.all_granted) {
        console.warn('Some permissions are missing - will request on first use');

        if (!result.microphone.granted) {
          console.warn('Microphone permission:', result.microphone.error);
        }

        if (!result.screen_recording.granted) {
          console.warn('Screen Recording permission:', result.screen_recording.error);
        }
      } else {
        console.log('All permissions granted!');
      }
    } catch (error) {
      // If we can't parse the result, it's not critical - permissions
      // will be requested when needed
      console.warn('Could not parse permission check result:', error);
      if (stderr) {
        console.warn('Permission check stderr:', stderr);
      }
    }
  });
}

// Initialize app
app.whenReady().then(async () => {
  // IMPORTANT: Log all app paths for debugging
  console.log('=== App Path Configuration ===');
  console.log('app.getPath("userData"):', app.getPath('userData'));
  console.log('app.getPath("appData"):', app.getPath('appData'));
  console.log('app.getPath("cache"):', app.getPath('cache'));
  console.log('app.getName():', app.getName());
  console.log('app.isPackaged:', app.isPackaged);
  console.log('process.resourcesPath:', process.resourcesPath);
  console.log('==============================');

  // Set cache paths to userData to avoid permission issues
  const cacheDir = path.join(app.getPath('userData'), 'Cache');
  app.setPath('cache', cacheDir);

  // Run startup safety checks (Python, FFmpeg, disk space)
  const checksOk = await runStartupChecks();
  if (!checksOk) {
    return; // App will quit if critical checks fail
  }

  createTray();
  createWindow();

  // Check macOS permissions proactively
  if (process.platform === 'darwin') {
    checkMacOSPermissions();
  }

  // Don't preload model in background anymore - the renderer will handle it during init
  // This prevents double-downloading and gives better UX with progress feedback
  // preloadWhisperModel(); // REMOVED

  // Check for updates after app loads (5 second delay to not slow startup)
  setTimeout(async () => {
    const updateInfo = await checkForUpdates();
    if (updateInfo && mainWindow) {
      mainWindow.webContents.send('update-available', updateInfo);
    }
  }, 5000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Don't quit when all windows are closed (allow running in tray)
app.on('window-all-closed', () => {
  // Keep app running in tray even when window is closed
  // User must explicitly quit from tray menu
});

// Clean up on quit
app.on('before-quit', () => {
  isQuitting = true;

  // Kill the main recording process
  if (pythonProcess) {
    pythonProcess.kill();
  }

  // Kill all other spawned Python processes
  activeProcesses.forEach(proc => {
    try {
      if (!proc.killed) {
        proc.kill();
      }
    } catch (e) {
      // Process might already be dead, ignore
    }
  });

  activeProcesses = [];

  // Clean up tray
  if (tray) {
    tray.destroy();
  }
});

// ============================================================================
// IPC Handlers - Communication between UI and Python backend
// ============================================================================

/**
 * Validate audio devices before recording.
 * Checks that selected devices exist and are accessible.
 * GRACEFUL: Returns valid=true with warning if check fails, allowing recording to proceed.
 */
ipcMain.handle('validate-devices', async (event, { micId, loopbackId }) => {
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
      python = spawnTrackedPython([
        path.join(pythonConfig.backendPath, 'device_manager.py')
      ]);
    } catch (e) {
      clearTimeout(timeout);
      console.error('Failed to spawn device_manager.py:', e);
      resolve({
        valid: true, // Allow recording to proceed
        warnings: ['Could not validate devices - proceeding anyway'],
        errors: []
      });
      return;
    }

    python.stdout.on('data', (data) => { output += data.toString(); });
    python.stderr.on('data', (data) => { errorOutput += data.toString(); });

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
});

/**
 * Check disk space before recording.
 * Returns available space and warnings.
 */
ipcMain.handle('check-disk-space', async () => {
  return await checkDiskSpace();
});

/**
 * Check macOS audio output device for Bluetooth/headphone warning.
 * ScreenCaptureKit may not capture audio from these devices.
 * GRACEFUL: Returns supported=true if check fails, allowing recording to proceed.
 */
ipcMain.handle('check-audio-output', async () => {
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

    proc.stdout.on('data', (data) => { output += data.toString(); });

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

        // Look for Bluetooth or USB audio devices as default output
        let isBluetoothOrUSB = false;
        let deviceName = null;

        for (const section of audioData) {
          const items = section._items || [];
          for (const item of items) {
            // Check for default output device
            if (item.coreaudio_default_audio_output_device === 'spaudio_yes') {
              deviceName = item._name;

              // Check transport type or name for Bluetooth/USB indicators
              const transport = (item.coreaudio_device_transport || '').toLowerCase();
              const name = (item._name || '').toLowerCase();

              if (transport.includes('bluetooth') ||
                  transport.includes('usb') ||
                  name.includes('airpods') ||
                  name.includes('bluetooth') ||
                  name.includes('beats') ||
                  name.includes('headphone') ||
                  name.includes('usb')) {
                isBluetoothOrUSB = true;
              }
            }
          }
        }

        if (isBluetoothOrUSB) {
          resolve({
            supported: false,
            warning: `Desktop audio may not be captured when using "${deviceName}". ` +
                     `ScreenCaptureKit works best with built-in speakers. ` +
                     `Consider switching to built-in output or installing BlackHole for full desktop audio capture.`,
            deviceName,
            suggestion: 'Switch to built-in speakers or use BlackHole virtual audio device'
          });
        } else {
          resolve({ supported: true, warning: null, deviceName });
        }
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
});

/**
 * Get list of available audio devices
 */
ipcMain.handle('get-audio-devices', async () => {
  return new Promise((resolve, reject) => {
    const python = spawnTrackedPython([
      path.join(pythonConfig.backendPath, 'device_manager.py')
    ]);

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
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
  });
});

/**
 * Warm up audio system (enumerate devices and test streams)
 * This should be called on app startup to initialize audio drivers
 */
ipcMain.handle('warm-up-audio-system', async () => {
  return new Promise((resolve) => {
    // Step 1: Enumerate devices (forces driver initialization)
    const python = spawnTrackedPython([
      path.join(pythonConfig.backendPath, 'device_manager.py')
    ]);

    let output = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
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
  });
});

/**
 * Check if Whisper model is downloaded
 */
ipcMain.handle('check-model-downloaded', async (event, modelSize) => {
  return new Promise((resolve) => {
    // Check if model exists in cache
    // faster-whisper downloads to ~/.cache/huggingface/hub
    const homeDir = require('os').homedir();
    const cacheDir = path.join(homeDir, '.cache', 'huggingface', 'hub');

    // Model naming pattern: models--guillaumekln--faster-whisper-{size}
    const modelPattern = `models--guillaumekln--faster-whisper-${modelSize || 'small'}`;

    try {
      if (fs.existsSync(cacheDir)) {
        const items = fs.readdirSync(cacheDir);
        const modelExists = items.some(item => item.includes(modelPattern));
        resolve({ downloaded: modelExists, modelSize: modelSize || 'small' });
      } else {
        resolve({ downloaded: false, modelSize: modelSize || 'small' });
      }
    } catch (e) {
      // If we can't check, assume not downloaded
      resolve({ downloaded: false, modelSize: modelSize || 'small' });
    }
  });
});

/**
 * Download Whisper model (preload)
 */
ipcMain.handle('download-model', async (event, modelSize) => {
  return new Promise((resolve, reject) => {
    const model = modelSize || 'small';
    console.log(`Downloading Whisper model: ${model}`);

    const python = spawnTrackedPython([
      getTranscriberScript(),
      '--preload',
      '--model', model
    ]);

    let hasError = false;

    python.stdout.on('data', (data) => {
      const output = data.toString();
      // Send progress updates to renderer
      mainWindow.webContents.send('model-download-progress', output);
    });

    python.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`[Model Download] ${output}`);

      // Send progress to renderer
      mainWindow.webContents.send('model-download-progress', output);

      // Check for errors
      if (output.toLowerCase().includes('error') && !output.includes('non-critical')) {
        hasError = true;
      }
    });

    python.on('close', (code) => {
      if (code === 0) {
        console.log('Model downloaded successfully');
        resolve({ success: true });
      } else if (!hasError) {
        // Non-zero exit but no explicit error - might be OK
        console.log('Model download completed with warnings');
        resolve({ success: true });
      } else {
        reject(new Error('Failed to download model'));
      }
    });
  });
});

/**
 * Start recording with improved timeout and progress feedback
 */
ipcMain.handle('start-recording', async (event, options) => {
  return new Promise((resolve, reject) => {
    const { micId, loopbackId, isFirstRecording } = options;

    // Generate unique filename with timestamp
    const timestamp = new Date().toISOString()
      .replace(/:/g, '-')  // Replace : with - for Windows compatibility
      .replace(/\..+/, ''); // Remove milliseconds
    const filename = `recording_${timestamp}.wav`;

    // Note: audio_recorder.py will compress and save as .opus, not .wav
    // But we pass .wav as the base path - the recorder will change extension
    // Use userData path which is always writable (in AppData/Roaming)
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      fs.mkdirSync(recordingsDir, { recursive: true });
    }
    const outputPath = path.join(recordingsDir, filename);

    // FIX 1: Enable power save blocker to keep recording running
    // Platform-specific approach:
    // - macOS: Use 'prevent-app-suspension' to prevent App Nap from pausing recording
    // - Windows: Use 'prevent-display-sleep' for better battery life (Python process is separate)
    if (powerSaveId === null) {
      const isMacForPower = process.platform === 'darwin';
      const blockerType = isMacForPower ? 'prevent-app-suspension' : 'prevent-display-sleep';

      powerSaveId = powerSaveBlocker.start(blockerType);
      console.log(
        `Power save blocker enabled (${blockerType}) - recording will continue in background`
      );
    }

    // Start Python recording process (platform-specific recorder)
    // Run as module (-m) to support relative imports within the audio package
    const isMac = process.platform === 'darwin';
    const recorderModule = isMac ? 'audio.macos_recorder' : 'audio.windows_recorder';

    pythonProcess = spawnTrackedPython([
      '-m', recorderModule,
      '--mic', micId.toString(),
      '--loopback', loopbackId.toString(),
      '--output', outputPath
    ], { cwd: pythonConfig.backendPath });

    // FIX 2 (REFINED): Set high priority for Python recording process on Windows
    // Use small delay to ensure process is fully initialized before setting priority
    if (process.platform === 'win32' && pythonProcess.pid) {
      setTimeout(() => {
        try {
          const { exec } = require('child_process');
          exec(`wmic process where processid="${pythonProcess.pid}" CALL setpriority "high priority"`, (error) => {
            if (error) {
              console.warn('Failed to set high priority:', error.message);
            } else {
              console.log('Recording process set to HIGH priority');
            }
          });
        } catch (e) {
          console.warn('Could not set process priority:', e.message);
        }
      }, 100); // 100ms delay to ensure process initialization
    }

    let recordingStarted = false;
    let progressStage = 'initializing';

    // PERFORMANCE FIX: Throttle audio level updates to reduce IPC overhead
    // Only send updates if window is visible AND we haven't sent one recently
    let lastLevelSentTime = 0;
    const LEVEL_UPDATE_THROTTLE_MS = 100; // Max 10 updates/sec instead of 20

    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();

      // Check if this is a JSON level update
      if (output.trim().startsWith('{"type": "levels"')) {
        // FIX 3: Update heartbeat timestamp when we receive audio levels
        lastLevelUpdate = Date.now();

        // PERFORMANCE: Only parse and send if window visible and throttled
        const now = Date.now();
        const shouldSendUpdate = (now - lastLevelSentTime) >= LEVEL_UPDATE_THROTTLE_MS;

        if (shouldSendUpdate && mainWindow && !mainWindow.isMinimized() && mainWindow.isVisible()) {
          try {
            // There might be multiple JSON objects in one chunk, or mixed with newlines
            const lines = output.trim().split('\n');
            for (const line of lines) {
              if (line.startsWith('{"type": "levels"')) {
                const levels = JSON.parse(line);
                mainWindow.webContents.send('audio-levels', levels);
                lastLevelSentTime = now;
                break; // Only send first valid level to reduce overhead
              }
            }
          } catch (e) {
            // Ignore parse errors for levels
          }
        }
        // Note: We still update heartbeat even if we don't send to UI
      } else {
        // Send progress updates to renderer
        mainWindow.webContents.send('recording-progress', output);
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      const output = data.toString();
      console.log(`Python status: ${output}`);

      // Send detailed progress updates
      if (output.includes('Device configuration')) {
        progressStage = 'configuring';
        mainWindow.webContents.send('recording-init-progress', { stage: 'configuring', message: 'Configuring audio devices...' });
      } else if (output.includes('Microphone stream opened')) {
        progressStage = 'mic_opened';
        mainWindow.webContents.send('recording-init-progress', { stage: 'mic_opened', message: 'Microphone ready...' });
      } else if (output.includes('Desktop audio stream opened')) {
        progressStage = 'desktop_opened';
        mainWindow.webContents.send('recording-init-progress', { stage: 'desktop_opened', message: 'Desktop audio ready...' });
      }

      // Wait for confirmation that recording actually started
      if (!recordingStarted && output.includes('Recording started!')) {
        recordingStarted = true;
        recordingStartTime = Date.now(); // Track when recording actually started

        // FIX 3: Start heartbeat monitor to detect recording failures
        lastLevelUpdate = Date.now();
        recordingHeartbeat = setInterval(() => {
          const timeSinceUpdate = Date.now() - lastLevelUpdate;

          // If no audio level updates for 10 seconds, something is wrong
          if (timeSinceUpdate > 10000 && pythonProcess && !pythonProcess.killed) {
            console.error(`Recording heartbeat lost - no audio levels for ${timeSinceUpdate / 1000}s`);
            mainWindow.webContents.send('recording-warning', {
              type: 'heartbeat_lost',
              message: 'Recording may have stopped unexpectedly. No audio data received for 10+ seconds.'
            });

            // Continue monitoring - don't auto-kill, let user decide
          }
        }, 5000); // Check every 5 seconds

        mainWindow.webContents.send('recording-init-progress', { stage: 'started', message: 'Recording started!' });
        resolve({ success: true, message: 'Recording started' });
      }
    });

    pythonProcess.on('close', (code) => {
      // CRITICAL FIX: Clean up resources on error
      if (recordingHeartbeat) {
        clearInterval(recordingHeartbeat);
        recordingHeartbeat = null;
      }
      if (powerSaveId !== null) {
        powerSaveBlocker.stop(powerSaveId);
        powerSaveId = null;
        console.log('Power save blocker disabled (recording failed)');
      }

      if (!recordingStarted) {
        // Process closed before recording started - this is an error
        let errorMessage = `Recording failed to start. Process exited with code ${code}.`;

        // Provide helpful hints based on progress stage
        if (progressStage === 'initializing') {
          errorMessage += '\n\nTip: Try refreshing your audio devices or restarting the app.';
        } else if (progressStage === 'configuring') {
          errorMessage += '\n\nTip: Check that your selected audio devices are not in use by another application.';
        }

        reject(new Error(errorMessage));
      }
    });

    // Longer timeout for first recording (15s), shorter for subsequent (10s)
    const timeout = isFirstRecording ? 15000 : 10000;
    const timeoutHandle = setTimeout(() => {
      if (!recordingStarted) {
        // CRITICAL FIX: Clean up resources on timeout
        if (recordingHeartbeat) {
          clearInterval(recordingHeartbeat);
          recordingHeartbeat = null;
        }
        if (powerSaveId !== null) {
          powerSaveBlocker.stop(powerSaveId);
          powerSaveId = null;
          console.log('Power save blocker disabled (timeout)');
        }

        let errorMessage = `Recording failed to start within ${timeout / 1000} seconds.`;

        // Provide specific guidance based on what stage failed
        if (progressStage === 'initializing') {
          errorMessage += '\n\nThe audio system is taking longer than expected to initialize.';
          errorMessage += '\nThis can happen on first launch. Please try again.';
        } else if (progressStage === 'configuring') {
          errorMessage += '\n\nAudio device configuration is taking too long.';
          errorMessage += '\nCheck that your devices are properly connected and not in use.';
        } else if (progressStage === 'mic_opened' || progressStage === 'desktop_opened') {
          errorMessage += '\n\nAudio streams are opening but not fully ready.';
          errorMessage += '\nTry selecting different audio devices or restarting the app.';
        }

        reject(new Error(errorMessage));
        if (pythonProcess && !pythonProcess.killed) {
          pythonProcess.kill();
        }
      }
    }, timeout);

    // Clean up timeout if recording starts successfully
    pythonProcess.on('close', () => {
      clearTimeout(timeoutHandle);
    });
  });
});

/**
 * Stop recording
 */
ipcMain.handle('stop-recording', async () => {
  return new Promise((resolve, reject) => {
    // FIX 3: Clear heartbeat monitor
    if (recordingHeartbeat) {
      clearInterval(recordingHeartbeat);
      recordingHeartbeat = null;
      console.log('Recording heartbeat monitor stopped');
    }

    if (pythonProcess) {
      // Save reference to current process (in case it gets nulled)
      const currentProcess = pythonProcess;

      let stdoutData = '';
      let stderrData = '';

      // Set up one-time handlers to collect remaining output
      const stdoutHandler = (data) => {
        stdoutData += data.toString();
      };

      const stderrHandler = (data) => {
        const output = data.toString();
        stderrData += output;

        // Send progress updates to renderer so user sees post-processing status
        console.log(`Python status: ${output}`);
        mainWindow.webContents.send('recording-progress', output.trim());
      };

      // Add handlers (will be cleaned up after process closes)
      currentProcess.stdout.on('data', stdoutHandler);
      currentProcess.stderr.on('data', stderrHandler);

      // Wait for process to actually complete
      const closeHandler = (code) => {
        // Clean up event handlers to prevent memory leaks
        currentProcess.stdout.removeListener('data', stdoutHandler);
        currentProcess.stderr.removeListener('data', stderrHandler);

        pythonProcess = null;
        recordingStartTime = null; // Reset recording start time

        // FIX 1: Disable power save blocker after recording completes
        if (powerSaveId !== null) {
          powerSaveBlocker.stop(powerSaveId);
          powerSaveId = null;
          console.log('Power save blocker disabled');
        }

        if (code === 0) {
          // Parse JSON output to get file path
          try {
            const lines = stdoutData.trim().split('\n');
            const jsonLine = lines[lines.length - 1]; // Last line should be JSON
            const recordingInfo = JSON.parse(jsonLine);

            // Support both audioPath (Windows) and outputPath (macOS) for backward compatibility
            const filePath = recordingInfo.audioPath || recordingInfo.outputPath;

            // Verify file exists before resolving
            if (filePath && fs.existsSync(filePath)) {
              resolve({
                success: true,
                audioPath: filePath,
                duration: recordingInfo.duration
              });
            } else {
              reject(new Error(`Recording file not found: ${filePath}`));
            }
          } catch (e) {
            // If JSON parsing fails, file might still exist at default location
            const recordingsDir = path.join(app.getPath('userData'), 'recordings');
            const opusPath = path.join(recordingsDir, 'temp.opus');

            if (fs.existsSync(opusPath)) {
              resolve({ success: true, audioPath: opusPath });
            } else {
              reject(new Error(`Recording completed but output file not found. Error: ${e.message}`));
            }
          }
        } else {
          reject(new Error(`Recording stopped with exit code ${code}: ${stderrData}`));
        }
      };

      // Register close handler
      currentProcess.on('close', closeHandler);

      // Send signal to stop via stdin
      currentProcess.stdin.write('stop\n');

      // Calculate proportional timeout based on recording duration
      // Post-processing time scales with recording length
      // Formula: base 30s + (recording_minutes * 10s per minute)
      // Examples: 5min = 80s, 30min = 330s (5.5min), 60min = 630s (10.5min)
      const recordingDuration = recordingStartTime ? (Date.now() - recordingStartTime) / 1000 : 0;
      const recordingMinutes = Math.ceil(recordingDuration / 60);
      const processingTimeout = Math.max(30000, 30000 + (recordingMinutes * 10000)); // Minimum 30s

      console.log(`Recording duration: ${recordingMinutes} minutes, using ${processingTimeout / 1000}s timeout`);

      setTimeout(() => {
        if (pythonProcess) {
          pythonProcess.kill();
          pythonProcess = null;
          reject(new Error('Recording stop timeout - process took too long to finish'));
        }
      }, processingTimeout);
    } else {
      resolve({ success: true });
    }
  });
});

/**
 * Transcribe audio file
 */
ipcMain.handle('transcribe-audio', async (event, options) => {
  return new Promise((resolve, reject) => {
    let { audioFile, language, modelSize } = options;

    // Resolve relative paths and handle .opus extension
    if (!path.isAbsolute(audioFile)) {
      // Use userData recordings directory
      const recordingsDir = path.join(app.getPath('userData'), 'recordings');
      audioFile = path.join(recordingsDir, path.basename(audioFile));
    }

    // The recorder saves as .opus, so if we get .wav, use .opus instead
    if (audioFile.endsWith('.wav')) {
      audioFile = audioFile.replace('.wav', '.opus');
    }

    const python = spawnTrackedPython([
      getTranscriberScript(),
      '--file', audioFile,
      '--language', language || 'en',
      '--model', modelSize || 'small',
      '--json'
    ]);

    let output = '';
    let errorOutput = '';
    let hasCompleted = false;

    // Timeout: generous limits for slow CPUs and long recordings
    // These are safety nets to catch stalled processes, not performance limits
    const modelTimeouts = { tiny: 30, base: 45, small: 60, medium: 90, large: 120 };
    const timeoutMinutes = modelTimeouts[modelSize] || 60;
    const transcriptionTimeout = setTimeout(() => {
      if (!hasCompleted) {
        hasCompleted = true;
        python.kill();
        reject(new Error(`Transcription timeout after ${timeoutMinutes} minutes. The process may have stalled.`));
      }
    }, timeoutMinutes * 60 * 1000);

    python.stdout.on('data', (data) => {
      output += data.toString();
      // Send progress to renderer
      mainWindow.webContents.send('transcription-progress', data.toString());
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (hasCompleted) return; // Already timed out
      hasCompleted = true;
      clearTimeout(transcriptionTimeout);

      // Try to parse JSON output first, even if exit code is non-zero
      // This handles cases where transcription succeeds but cleanup fails
      if (output.trim()) {
        try {
          const result = JSON.parse(output);
          // If we successfully parsed JSON with the expected structure, consider it success
          if (result.text !== undefined || result.segments !== undefined) {
            resolve(result);
            return;
          }
        } catch (e) {
          // JSON parsing failed, continue to error handling
        }
      }

      // If we get here, either no output or parsing failed
      if (code === 0) {
        reject(new Error(`Transcription produced no valid output`));
      } else {
        reject(new Error(`Transcription failed: ${errorOutput || 'Unknown error'}`));
      }
    });
  });
});

/**
 * List all meetings
 */
ipcMain.handle('list-meetings', async () => {
  return new Promise((resolve, reject) => {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const python = spawnTrackedPython([
      path.join(pythonConfig.backendPath, 'meeting_manager.py'),
      '--recordings-dir', recordingsDir,
      'list'
    ]);

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const meetings = JSON.parse(output);
          resolve(meetings);
        } catch (e) {
          reject(new Error(`Failed to parse meetings: ${e.message}`));
        }
      } else {
        const errorMsg = errorOutput.trim() || 'Unknown error';
        reject(new Error(`Failed to list meetings: ${errorMsg}`));
      }
    });
  });
});

/**
 * Get a single meeting
 */
ipcMain.handle('get-meeting', async (event, meetingId) => {
  return new Promise((resolve, reject) => {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const python = spawnTrackedPython([
      path.join(pythonConfig.backendPath, 'meeting_manager.py'),
      '--recordings-dir', recordingsDir,
      'get',
      meetingId
    ]);

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const meeting = JSON.parse(output);
          resolve(meeting);
        } catch (e) {
          reject(new Error(`Failed to parse meeting: ${e.message}`));
        }
      } else {
        const errorMsg = errorOutput.trim() || 'Meeting not found';
        reject(new Error(errorMsg));
      }
    });
  });
});

/**
 * Delete a meeting
 */
ipcMain.handle('delete-meeting', async (event, meetingId) => {
  return new Promise((resolve, reject) => {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const python = spawnTrackedPython([
      path.join(pythonConfig.backendPath, 'meeting_manager.py'),
      '--recordings-dir', recordingsDir,
      'delete',
      meetingId
    ]);

    // FIX: Capture error output for better diagnostics
    let errorOutput = '';

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        // Include actual error details from Python
        const errorMsg = errorOutput.trim() || 'Unknown error';
        reject(new Error(`Failed to delete meeting: ${errorMsg}`));
      }
    });
  });
});

/**
 * Scan recordings directory and sync with database
 */
ipcMain.handle('scan-recordings', async () => {
  return new Promise((resolve, reject) => {
    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const python = spawnTrackedPython([
      path.join(pythonConfig.backendPath, 'meeting_manager.py'),
      '--recordings-dir', recordingsDir,
      'scan'
    ]);

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const result = JSON.parse(output);
          resolve(result);
        } catch (e) {
          reject(new Error(`Failed to parse scan result: ${e.message}`));
        }
      } else {
        const errorMsg = errorOutput.trim() || 'Unknown error';
        reject(new Error(`Failed to scan recordings: ${errorMsg}`));
      }
    });
  });
});

/**
 * Add a meeting (called after transcription)
 */
ipcMain.handle('add-meeting', async (event, meetingData) => {
  return new Promise((resolve, reject) => {
    const { audioPath, transcriptPath, duration, language, model, title } = meetingData;

    const recordingsDir = path.join(app.getPath('userData'), 'recordings');
    const args = [
      path.join(pythonConfig.backendPath, 'meeting_manager.py'),
      '--recordings-dir', recordingsDir,
      'add',
      '--audio', audioPath,
      '--transcript', transcriptPath,
      '--duration', duration.toString(),
      '--language', language,
      '--model', model
    ];

    if (title) {
      args.push('--title', title);
    }

    const python = spawnTrackedPython(args);

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        try {
          const meeting = JSON.parse(output);
          resolve(meeting);
        } catch (e) {
          reject(new Error(`Failed to parse meeting: ${e.message}`));
        }
      } else {
        const errorMsg = errorOutput.trim() || 'Unknown error';
        reject(new Error(`Failed to add meeting: ${errorMsg}`));
      }
    });
  });
});

/**
 * Check GPU availability (detect NVIDIA GPU)
 */
ipcMain.handle('check-gpu', async () => {
  return new Promise((resolve) => {
    const python = spawnTrackedPython([
      '-c',
      'import subprocess; result = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True); print(result.stdout.strip() if result.returncode == 0 else "None")'
    ]);

    let output = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.on('close', () => {
      const gpuName = output.trim();
      resolve({
        hasGPU: gpuName !== 'None' && gpuName !== '',
        gpuName: gpuName !== 'None' ? gpuName : null
      });
    });
  });
});

/**
 * Check CUDA installation status
 */
ipcMain.handle('check-cuda', async () => {
  return new Promise((resolve) => {
    const python = spawnTrackedPython([
      '-c',
      'try:\n    import torch\n    print("cuda_available:" + str(torch.cuda.is_available()))\n    if torch.cuda.is_available():\n        print("cuda_version:" + torch.version.cuda)\nexcept ImportError:\n    print("cuda_available:False")'
    ]);

    let output = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.on('close', () => {
      const cudaAvailable = output.includes('cuda_available:True');
      const versionMatch = output.match(/cuda_version:([\d.]+)/);
      resolve({
        installed: cudaAvailable,
        version: versionMatch ? versionMatch[1] : null
      });
    });
  });
});

/**
 * Install GPU acceleration packages
 */
ipcMain.handle('install-gpu', async () => {
  return new Promise((resolve, reject) => {
    const packages = [
      'torch',
      'torchvision',
      'torchaudio',
      '--index-url',
      'https://download.pytorch.org/whl/cu121'
    ];

    const python = spawnTrackedPython([
      '-m',
      'pip',
      'install',
      ...packages,
      '--no-warn-script-location'
    ]);

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      // Send progress to renderer
      mainWindow.webContents.send('gpu-install-progress', text);
    });

    python.stderr.on('data', (data) => {
      const text = data.toString();
      errorOutput += text;
      mainWindow.webContents.send('gpu-install-progress', text);
    });

    python.on('close', (code) => {
      if (code === 0) {
        // Install CUDA libraries
        const cudaPackages = ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12'];

        const cudaProcess = spawnTrackedPython([
          '-m',
          'pip',
          'install',
          ...cudaPackages,
          '--no-warn-script-location'
        ]);

        let cudaErrorOutput = '';

        cudaProcess.stdout.on('data', (data) => {
          mainWindow.webContents.send('gpu-install-progress', data.toString());
        });

        cudaProcess.stderr.on('data', (data) => {
          const text = data.toString();
          cudaErrorOutput += text;
          mainWindow.webContents.send('gpu-install-progress', text);
        });

        cudaProcess.on('close', (cudaCode) => {
          if (cudaCode === 0) {
            resolve({ success: true, message: 'GPU acceleration installed successfully' });
          } else {
            const errorMsg = cudaErrorOutput.trim() || 'Unknown error';
            reject(new Error(`Failed to install CUDA libraries: ${errorMsg}`));
          }
        });
      } else {
        reject(new Error(`Failed to install PyTorch: ${errorOutput}`));
      }
    });
  });
});

/**
 * Uninstall GPU packages
 */
ipcMain.handle('uninstall-gpu', async () => {
  return new Promise((resolve, reject) => {
    const packages = ['torch', 'torchvision', 'torchaudio', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12'];

    const python = spawnTrackedPython([
      '-m',
      'pip',
      'uninstall',
      '-y',
      ...packages
    ]);

    let errorOutput = '';

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    python.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        const errorMsg = errorOutput.trim() || 'Unknown error';
        reject(new Error(`Failed to uninstall GPU packages: ${errorMsg}`));
      }
    });
  });
});

/**
 * Get platform information (for UI platform detection)
 */
ipcMain.handle('get-platform', async () => {
  return process.platform;
});

ipcMain.handle('get-arch', async () => {
  return process.arch;
});

/**
 * Get system info (versions)
 */
ipcMain.handle('get-system-info', async () => {
  return new Promise((resolve) => {
    const python = spawnTrackedPython(['--version']);

    let pythonVersion = '';

    python.stdout.on('data', (data) => {
      pythonVersion += data.toString();
    });

    python.stderr.on('data', (data) => {
      pythonVersion += data.toString();
    });

    python.on('close', () => {
      resolve({
        app: app.getVersion(),
        electron: process.versions.electron,
        python: pythonVersion.replace('Python ', '').trim()
      });
    });
  });
});

/**
 * Open update download page in browser
 */
ipcMain.handle('download-update', async (event, downloadUrl) => {
  openDownloadPage(downloadUrl);
  return { success: true };
});

console.log('Meeting Transcriber - Main process started');
