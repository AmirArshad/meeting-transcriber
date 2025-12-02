const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { pipeline } = require('stream/promises');
const AdmZip = require('adm-zip');

const PYTHON_VERSION = '3.11.9';
const PYTHON_EMBED_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const FFMPEG_WIN_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const FFMPEG_MAC_URL = 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip';

const BUILD_DIR = path.join(__dirname, 'resources');
const PYTHON_DIR = path.join(BUILD_DIR, 'python');
const FFMPEG_DIR = path.join(BUILD_DIR, 'ffmpeg');
const MODELS_DIR = path.join(BUILD_DIR, 'whisper-models');

const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';

console.log('========================================');
console.log('Meeting Transcriber - Build Preparation');
console.log(`Platform: ${process.platform}`);
console.log('========================================\n');

// Ensure build directories exist
if (!fs.existsSync(BUILD_DIR)) {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  console.log('Created build/resources/ directory\n');
}

// Helper function to download files
async function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${url}`);
    const file = fs.createWriteStream(destination);

    https.get(url, { timeout: 30000 }, (response) => {
      // Handle redirects (301, 302, 303, 307, 308)
      if (response.statusCode >= 300 && response.statusCode < 400) {
        file.close();
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }
        return downloadFile(response.headers.location, destination).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }
        return reject(new Error(`Failed to download: ${response.statusCode}`));
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;
      let lastPercent = 0;

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        const percent = Math.floor((downloadedSize / totalSize) * 100);
        if (percent > lastPercent && percent % 10 === 0) {
          console.log(`  Progress: ${percent}%`);
          lastPercent = percent;
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        console.log('  Download complete!\n');
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      if (fs.existsSync(destination)) {
        fs.unlinkSync(destination);
      }
      reject(err);
    });
  });
}

// Helper to extract zip files
function extractZip(zipPath, targetDir) {
  console.log(`Extracting: ${path.basename(zipPath)}`);

  try {
    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Use adm-zip for cross-platform extraction
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(targetDir, true);
    console.log('  Extraction complete!\n');
  } catch (error) {
    throw new Error(`Failed to extract ${zipPath}: ${error.message}`);
  }
}

// Check if resources already exist
function checkExistingResources() {
  const pythonExe = IS_WINDOWS ? 'python.exe' : 'python3';
  const ffmpegExe = IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg';

  const pythonExists = IS_MAC ? checkSystemPython() : fs.existsSync(path.join(PYTHON_DIR, pythonExe));
  const ffmpegExists = fs.existsSync(path.join(FFMPEG_DIR, ffmpegExe));
  const modelsExist = fs.existsSync(MODELS_DIR) && fs.readdirSync(MODELS_DIR).length > 0;

  return { pythonExists, ffmpegExists, modelsExist };
}

// Check if system Python is available on macOS
function checkSystemPython() {
  if (!IS_MAC) return false;

  try {
    const version = execSync('python3 --version', { encoding: 'utf8' });
    console.log(`✓ Found system Python: ${version.trim()}`);
    return true;
  } catch (error) {
    console.log('⚠️ System Python not found. Please install Python 3.11+');
    return false;
  }
}

// Download Whisper models
async function downloadWhisperModels() {
  console.log('[1/3] Downloading Whisper models (optional components)...');

  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  const pythonExe = path.join(PYTHON_DIR, 'python.exe');

  // Create a Python script to download models using faster-whisper
  const downloadScript = `
import sys
import os
from faster_whisper import WhisperModel

models = ['tiny', 'small', 'medium']
cache_dir = r'${MODELS_DIR.replace(/\\/g, '\\\\')}'

for model_size in models:
    print(f'\\nDownloading {model_size} model...', file=sys.stderr)
    try:
        # This will download the model to the cache directory
        model = WhisperModel(
            model_size,
            device='cpu',
            compute_type='int8',
            download_root=cache_dir
        )
        print(f'✓ {model_size} model downloaded successfully', file=sys.stderr)
    except Exception as e:
        print(f'⚠️ Warning: Failed to download {model_size} model: {e}', file=sys.stderr)
        continue

print('\\nModel download complete!', file=sys.stderr)
`;

  const scriptPath = path.join(BUILD_DIR, 'download_models.py');
  fs.writeFileSync(scriptPath, downloadScript);

  try {
    console.log('  This may take 5-10 minutes depending on your connection...');
    execSync(`"${pythonExe}" "${scriptPath}"`, { stdio: 'inherit' });
    fs.unlinkSync(scriptPath);
    console.log('✓ Whisper models downloaded!\n');
  } catch (error) {
    console.log('⚠️ Warning: Model download failed. Models will be downloaded on first use.\n');
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
    }
  }
}

// Main preparation function
async function prepareResources() {
  const existing = checkExistingResources();

  // Prepare Python
  if (existing.pythonExists) {
    console.log('✓ Python runtime already prepared\n');
  } else {
    if (IS_MAC) {
      // macOS: Use system Python
      console.log('macOS detected - using system Python');
      console.log('Please ensure Python 3.11+ is installed via Homebrew:');
      console.log('  brew install python@3.11\n');

      // Verify Python installation
      try {
        const version = execSync('python3 --version', { encoding: 'utf8' });
        console.log(`Using: ${version.trim()}`);

        // Check for pip
        execSync('python3 -m pip --version', { encoding: 'utf8' });
        console.log('✓ pip is available\n');

        // Install dependencies to user site-packages
        console.log('Installing Python dependencies...');
        const requirementsPath = path.join(__dirname, '..', 'requirements.txt');
        execSync(`python3 -m pip install -r "${requirementsPath}" --user`, {
          stdio: 'inherit'
        });
        console.log('✓ Python setup complete!\n');
      } catch (error) {
        console.error('ERROR: Python 3.11+ is required for macOS builds');
        console.error('Install it with: brew install python@3.11');
        process.exit(1);
      }
    } else {
      // Windows: Download embedded Python
      console.log('[1/4] Downloading embedded Python...');
      const pythonZip = path.join(BUILD_DIR, 'python-embed.zip');
      await downloadFile(PYTHON_EMBED_URL, pythonZip);

      console.log('[2/4] Extracting Python...');
      extractZip(pythonZip, PYTHON_DIR);
      fs.unlinkSync(pythonZip);

      console.log('[3/4] Setting up pip...');

      // Download get-pip.py
      const getPipPath = path.join(PYTHON_DIR, 'get-pip.py');
      await downloadFile('https://bootstrap.pypa.io/get-pip.py', getPipPath);

      // Uncomment python311._pth to allow pip
      const pthFile = path.join(PYTHON_DIR, 'python311._pth');
      let pthContent = fs.readFileSync(pthFile, 'utf8');
      pthContent = pthContent.replace('#import site', 'import site');
      fs.writeFileSync(pthFile, pthContent);

      // Install pip
      const pythonExe = path.join(PYTHON_DIR, 'python.exe');
      execSync(`"${pythonExe}" "${getPipPath}"`, { stdio: 'inherit' });

      console.log('[4/4] Installing Python dependencies...');

      // Install requirements
      const requirementsPath = path.join(__dirname, '..', 'requirements.txt');
      execSync(`"${pythonExe}" -m pip install -r "${requirementsPath}" --no-warn-script-location`, {
        stdio: 'inherit'
      });

      console.log('✓ Python setup complete!\n');
    }
  }

  // Prepare ffmpeg
  if (existing.ffmpegExists) {
    console.log('✓ ffmpeg already prepared\n');
  } else {
    if (IS_MAC) {
      // macOS: Download ffmpeg binary
      console.log('[1/2] Downloading ffmpeg for macOS...');
      const ffmpegZip = path.join(BUILD_DIR, 'ffmpeg.zip');
      await downloadFile(FFMPEG_MAC_URL, ffmpegZip);

      console.log('[2/2] Extracting ffmpeg...');
      if (!fs.existsSync(FFMPEG_DIR)) {
        fs.mkdirSync(FFMPEG_DIR, { recursive: true });
      }

      // Extract zip directly to ffmpeg dir
      extractZip(ffmpegZip, FFMPEG_DIR);

      // Make executable
      const ffmpegPath = path.join(FFMPEG_DIR, 'ffmpeg');
      execSync(`chmod +x "${ffmpegPath}"`, { stdio: 'inherit' });

      // Cleanup
      fs.unlinkSync(ffmpegZip);

      console.log('✓ ffmpeg setup complete!\n');
    } else {
      // Windows: Download ffmpeg
      console.log('[1/2] Downloading ffmpeg...');
      const ffmpegZip = path.join(BUILD_DIR, 'ffmpeg.zip');
      await downloadFile(FFMPEG_WIN_URL, ffmpegZip);

      console.log('[2/2] Extracting ffmpeg...');
      const tempDir = path.join(BUILD_DIR, 'ffmpeg-temp');
      extractZip(ffmpegZip, tempDir);

      // Find the bin directory (ffmpeg extracts to a versioned folder)
      const extractedDirs = fs.readdirSync(tempDir);
      const ffmpegBinDir = path.join(tempDir, extractedDirs[0], 'bin');

      // Copy binaries to ffmpeg dir
      if (!fs.existsSync(FFMPEG_DIR)) {
        fs.mkdirSync(FFMPEG_DIR, { recursive: true });
      }

      fs.copyFileSync(
        path.join(ffmpegBinDir, 'ffmpeg.exe'),
        path.join(FFMPEG_DIR, 'ffmpeg.exe')
      );

      // Cleanup
      fs.unlinkSync(ffmpegZip);
      fs.rmSync(tempDir, { recursive: true, force: true });

      console.log('✓ ffmpeg setup complete!\n');
    }
  }

  // Download Whisper models (optional)
  if (existing.modelsExist) {
    console.log('✓ Whisper models already prepared\n');
  } else {
    const shouldDownloadModels = process.env.DOWNLOAD_MODELS !== 'false';

    if (shouldDownloadModels) {
      console.log('Preparing Whisper models for installation...');
      console.log('(Set DOWNLOAD_MODELS=false to skip this step)\n');
      await downloadWhisperModels();
    } else {
      console.log('⚠️ Skipping model download (DOWNLOAD_MODELS=false)\n');
      console.log('Models will be downloaded on first use by end users.\n');
    }
  }

  console.log('========================================');
  console.log('Build preparation complete!');
  console.log('========================================');
}

// Run preparation
prepareResources().catch((error) => {
  console.error('ERROR:', error.message);
  process.exit(1);
});
