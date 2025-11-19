/**
 * Main process for Meeting Transcriber Electron app.
 *
 * This file:
 * - Creates the application window
 * - Manages communication between UI and Python backend
 * - Handles application lifecycle
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let pythonProcess;

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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Initialize app
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up on quit
app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill();
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
    const python = spawn('python', [
      path.join(__dirname, '../backend/device_manager.py')
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
 * Start recording
 */
ipcMain.handle('start-recording', async (event, options) => {
  return new Promise((resolve, reject) => {
    const { micId, loopbackId } = options;

    // Start Python recording process
    pythonProcess = spawn('python', [
      path.join(__dirname, '../backend/audio_recorder.py'),
      '--mic', micId.toString(),
      '--loopback', loopbackId.toString(),
      '--output', path.join(__dirname, '../recordings/temp.wav')
    ]);

    pythonProcess.stdout.on('data', (data) => {
      // Send progress updates to renderer
      mainWindow.webContents.send('recording-progress', data.toString());
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error(`Python error: ${data}`);
    });

    pythonProcess.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true });
      } else {
        reject(new Error(`Recording failed with code ${code}`));
      }
    });

    // Immediately resolve to indicate recording started
    resolve({ success: true, message: 'Recording started' });
  });
});

/**
 * Stop recording
 */
ipcMain.handle('stop-recording', async () => {
  return new Promise((resolve) => {
    if (pythonProcess) {
      pythonProcess.kill('SIGTERM');
      pythonProcess = null;
    }
    resolve({ success: true });
  });
});

/**
 * Transcribe audio file
 */
ipcMain.handle('transcribe-audio', async (event, options) => {
  return new Promise((resolve, reject) => {
    const { audioFile, language, modelSize } = options;

    const python = spawn('python', [
      path.join(__dirname, '../backend/transcriber.py'),
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

console.log('Meeting Transcriber - Main process started');
