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
const fs = require('fs');

// Set a custom userData path to avoid permission errors with system cache
// This keeps all cache/config in the project folder instead of AppData
const userDataPath = path.join(__dirname, '../userData');
if (!fs.existsSync(userDataPath)) {
  fs.mkdirSync(userDataPath);
}
app.setPath('userData', userDataPath);

let mainWindow;
let pythonProcess;

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

console.log('Python Configuration:', pythonConfig);

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
    const python = spawn(pythonConfig.pythonExe, [
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
 * Start recording
 */
ipcMain.handle('start-recording', async (event, options) => {
  return new Promise((resolve, reject) => {
    const { micId, loopbackId } = options;

    // Note: audio_recorder.py will compress and save as .opus, not .wav
    // But we pass .wav as the base path - the recorder will change extension
    const outputPath = path.join(__dirname, '../recordings/temp.wav');

    // Start Python recording process
    pythonProcess = spawn(pythonConfig.pythonExe, [
      path.join(pythonConfig.backendPath, 'audio_recorder.py'),
      '--mic', micId.toString(),
      '--loopback', loopbackId.toString(),
      '--output', outputPath
    ]);

    pythonProcess.stdout.on('data', (data) => {
      // Send progress updates to renderer
      mainWindow.webContents.send('recording-progress', data.toString());
    });

    pythonProcess.stderr.on('data', (data) => {
      console.log(`Python status: ${data}`);
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
      // Wait for process to close (which happens after it saves the file)
      pythonProcess.on('close', () => {
        pythonProcess = null;
        resolve({ success: true });
      });

      // Send signal to stop via stdin (SIGTERM kills instantly on Windows)
      pythonProcess.stdin.write('stop\n');
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
      audioFile = path.join(__dirname, audioFile);
    }

    // The recorder saves as .opus, so if we get temp.wav, use temp.opus instead
    if (audioFile.endsWith('temp.wav')) {
      audioFile = audioFile.replace('temp.wav', 'temp.opus');
    }

    const python = spawn(pythonConfig.pythonExe, [
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
    const python = spawn(pythonConfig.pythonExe, [
      path.join(pythonConfig.backendPath, 'meeting_manager.py'),
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
    const python = spawn(pythonConfig.pythonExe, [
      path.join(pythonConfig.backendPath, 'meeting_manager.py'),
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
    const python = spawn(pythonConfig.pythonExe, [
      path.join(pythonConfig.backendPath, 'meeting_manager.py'),
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

    const args = [
      path.join(pythonConfig.backendPath, 'meeting_manager.py'),
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

    const python = spawn(pythonConfig.pythonExe, args);

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
    const python = spawn(pythonConfig.pythonExe, [
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
    const python = spawn(pythonConfig.pythonExe, [
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

    const python = spawn(pythonConfig.pythonExe, [
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

        const cudaProcess = spawn(pythonConfig.pythonExe, [
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

    const python = spawn(pythonConfig.pythonExe, [
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
    const python = spawn(pythonConfig.pythonExe, ['--version']);

    let pythonVersion = '';

    python.stdout.on('data', (data) => {
      pythonVersion += data.toString();
    });

    python.stderr.on('data', (data) => {
      pythonVersion += data.toString();
    });

    python.on('close', () => {
      resolve({
        electron: process.versions.electron,
        python: pythonVersion.replace('Python ', '').trim()
      });
    });
  });
});

console.log('Meeting Transcriber - Main process started');
