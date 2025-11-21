/**
 * Main process for Meeting Transcriber Electron app.
 *
 * This file:
 * - Creates the application window
 * - Manages communication between UI and Python backend
 * - Handles application lifecycle
 */

const { app, BrowserWindow, ipcMain, Tray, Menu, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
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
 * In production (packaged app), use embedded Python
 * In development, use system Python
 */
function getPythonConfig() {
  const isDev = !app.isPackaged;

  if (isDev) {
    // Development mode - use system Python
    return {
      pythonExe: 'python',
      backendPath: path.join(__dirname, '../backend'),
      ffmpegPath: 'ffmpeg' // Assume in PATH
    };
  } else {
    // Production mode - use embedded Python from resources
    const resourcesPath = process.resourcesPath;
    return {
      pythonExe: path.join(resourcesPath, 'python', 'python.exe'),
      backendPath: path.join(resourcesPath, 'backend'),
      ffmpegPath: path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe')
    };
  }
}

const pythonConfig = getPythonConfig();

// Add ffmpeg to PATH so Python scripts can find it
if (!app.isPackaged) {
  // In dev mode, ffmpeg should already be in PATH
} else {
  // In production, add the bundled ffmpeg directory to PATH
  const ffmpegDir = path.dirname(pythonConfig.ffmpegPath);
  process.env.PATH = `${ffmpegDir};${process.env.PATH}`;
}

// Suppress Python warnings to reduce console noise
process.env.PYTHONWARNINGS = 'ignore::DeprecationWarning,ignore::UserWarning';

console.log('Python Configuration:', pythonConfig);

// Create the system tray
function createTray() {
  // In production, icon is at the root of resources
  // In development, icon is in build folder
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '../build/icon.ico');

  tray = new Tray(iconPath);

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
    path.join(pythonConfig.backendPath, 'transcriber.py'),
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

// Initialize app
app.whenReady().then(() => {
  // Set cache paths to userData to avoid permission issues
  const cacheDir = path.join(app.getPath('userData'), 'Cache');
  app.setPath('cache', cacheDir);

  createTray();
  createWindow();

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
      path.join(pythonConfig.backendPath, 'transcriber.py'),
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

    // Start Python recording process
    pythonProcess = spawnTrackedPython([
      path.join(pythonConfig.backendPath, 'audio_recorder.py'),
      '--mic', micId.toString(),
      '--loopback', loopbackId.toString(),
      '--output', outputPath
    ]);

    let recordingStarted = false;
    let progressStage = 'initializing';

    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString();

      // Check if this is a JSON level update
      if (output.trim().startsWith('{"type": "levels"')) {
        try {
          // There might be multiple JSON objects in one chunk, or mixed with newlines
          const lines = output.trim().split('\n');
          for (const line of lines) {
            if (line.startsWith('{"type": "levels"')) {
              const levels = JSON.parse(line);
              mainWindow.webContents.send('audio-levels', levels);
            }
          }
        } catch (e) {
          // Ignore parse errors for levels
        }
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
        mainWindow.webContents.send('recording-init-progress', { stage: 'started', message: 'Recording started!' });
        resolve({ success: true, message: 'Recording started' });
      }
    });

    pythonProcess.on('close', (code) => {
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
    if (pythonProcess) {
      let stdoutData = '';
      let stderrData = '';

      // Collect stdout (contains JSON with file path)
      pythonProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
      });

      // Collect stderr and send progress updates
      pythonProcess.stderr.on('data', (data) => {
        const output = data.toString();
        stderrData += output;

        // Send progress updates to renderer so user sees post-processing status
        console.log(`Python status: ${output}`);
        mainWindow.webContents.send('recording-progress', output.trim());
      });

      // Wait for process to actually complete
      pythonProcess.on('close', (code) => {
        pythonProcess = null;
        recordingStartTime = null; // Reset recording start time

        if (code === 0) {
          // Parse JSON output to get file path
          try {
            const lines = stdoutData.trim().split('\n');
            const jsonLine = lines[lines.length - 1]; // Last line should be JSON
            const recordingInfo = JSON.parse(jsonLine);

            // Verify file exists before resolving
            if (fs.existsSync(recordingInfo.audioPath)) {
              resolve({
                success: true,
                audioPath: recordingInfo.audioPath,
                duration: recordingInfo.duration
              });
            } else {
              reject(new Error(`Recording file not found: ${recordingInfo.audioPath}`));
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
      });

      // Send signal to stop via stdin
      pythonProcess.stdin.write('stop\n');

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
      path.join(pythonConfig.backendPath, 'transcriber.py'),
      '--file', audioFile,
      '--language', language || 'en',
      '--model', modelSize || 'small',
      '--json'
    ]);

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
      // Send progress to renderer
      mainWindow.webContents.send('transcription-progress', data.toString());
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
          reject(new Error(`Failed to parse transcription: ${e.message}`));
        }
      } else {
        reject(new Error(`Transcription failed: ${errorOutput}`));
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

    python.stdout.on('data', (data) => {
      output += data.toString();
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
        reject(new Error('Failed to list meetings'));
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

    python.stdout.on('data', (data) => {
      output += data.toString();
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
        reject(new Error('Meeting not found'));
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

    python.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        reject(new Error('Failed to delete meeting'));
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

    python.stdout.on('data', (data) => {
      output += data.toString();
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
        reject(new Error('Failed to add meeting'));
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

        cudaProcess.stdout.on('data', (data) => {
          mainWindow.webContents.send('gpu-install-progress', data.toString());
        });

        cudaProcess.stderr.on('data', (data) => {
          mainWindow.webContents.send('gpu-install-progress', data.toString());
        });

        cudaProcess.on('close', (cudaCode) => {
          if (cudaCode === 0) {
            resolve({ success: true, message: 'GPU acceleration installed successfully' });
          } else {
            reject(new Error('Failed to install CUDA libraries'));
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

    python.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        reject(new Error('Failed to uninstall GPU packages'));
      }
    });
  });
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
