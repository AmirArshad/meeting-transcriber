const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync, execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { BUILD_DOWNLOADS, getBuildDownload, hashString, verifyFileChecksum } = require('./download-manifest');

const PYTHON_VERSION = '3.11.9';

const BUILD_DIR = path.join(__dirname, 'resources');
const PYTHON_DIR = path.join(BUILD_DIR, 'python');
const FFMPEG_DIR = path.join(BUILD_DIR, 'ffmpeg');
const BIN_DIR = path.join(BUILD_DIR, 'bin');
const MODELS_DIR = path.join(BUILD_DIR, 'whisper-models');
const RESOURCE_MANIFEST_PATH = path.join(BUILD_DIR, 'resource-manifest.json');
const RESOURCE_MANIFEST_VERSION = 4;
const REQUIREMENTS_MACOS_BUILD = path.join(__dirname, '..', 'requirements-macos-build.txt');
const REQUIREMENTS_WINDOWS_BUILD = path.join(__dirname, '..', 'requirements-windows-build.txt');
const MACOS_RUNTIME_REMOVABLE_PACKAGES = Object.freeze([
  'sympy',
  'av.libs',
  'setuptools',
  'onnxruntime',
  'faster_whisper',
  'ctranslate2',
  'ctranslate2.libs',
]);

// Swift AudioCaptureHelper paths
const SWIFT_HELPER_DIR = path.join(__dirname, '..', 'swift', 'AudioCaptureHelper');
const SWIFT_HELPER_BINARY = 'audiocapture-helper';

const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';

function readTextOrEmpty(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function listFilesRecursively(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursively(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

function hashFileContent(filePath) {
  return hashString(fs.readFileSync(filePath));
}

function buildDirectoryManifest(dirPath, rootPath) {
  const files = listFilesRecursively(dirPath);
  return files.map((filePath) => ({
    path: path.relative(rootPath, filePath).replace(/\\/g, '/'),
    sha256: hashFileContent(filePath),
  }));
}

function ensureBuildDirectory() {
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
    console.log('Created build/resources/ directory\n');
  }
}

function ensureWindowsEmbeddedPythonPathConfig(pthFile = path.join(PYTHON_DIR, 'python311._pth')) {
  if (!fs.existsSync(pthFile)) {
    return;
  }

  const pthContent = fs.readFileSync(pthFile, 'utf8');
  const lines = pthContent.split(/\r?\n/);
  const cleanedLines = lines.filter((line) => line.trim() !== '');
  const normalizedLines = [];
  const seen = new Set();
  let siteEnabled = false;

  for (const line of cleanedLines) {
    const trimmed = line.trim();

    if (trimmed === '#import site' || trimmed === 'import site') {
      if (!siteEnabled) {
        normalizedLines.push('import site');
        siteEnabled = true;
      }
      continue;
    }

    if (!seen.has(trimmed)) {
      normalizedLines.push(trimmed);
      seen.add(trimmed);
    }
  }

  const requiredPaths = ['../backend', './Lib/site-packages'];
  for (const requiredPath of requiredPaths.reverse()) {
    if (!seen.has(requiredPath)) {
      normalizedLines.unshift(requiredPath);
      seen.add(requiredPath);
    }
  }

  if (!siteEnabled) {
    normalizedLines.push('import site');
  }

  const updatedContent = `${normalizedLines.join('\n')}\n`;
  if (updatedContent !== pthContent) {
    fs.writeFileSync(pthFile, updatedContent);
    console.log('  → Embedded Python path configuration updated');
  } else {
    console.log('  → Embedded Python path configuration already current');
  }
}

function buildResourceManifest() {
  return {
    version: RESOURCE_MANIFEST_VERSION,
    platform: process.platform,
    downloads: BUILD_DOWNLOADS,
    inputs: {
      requirementsMacos: hashString(readTextOrEmpty(path.join(__dirname, '..', 'requirements-macos.txt'))),
      requirementsWindows: hashString(readTextOrEmpty(path.join(__dirname, '..', 'requirements-windows.txt'))),
      requirementsMacosBuild: hashString(readTextOrEmpty(REQUIREMENTS_MACOS_BUILD)),
      requirementsWindowsBuild: hashString(readTextOrEmpty(REQUIREMENTS_WINDOWS_BUILD)),
      swiftPackage: hashString(readTextOrEmpty(path.join(__dirname, '..', 'swift', 'AudioCaptureHelper', 'Package.swift'))),
      swiftInfoPlist: hashString(readTextOrEmpty(path.join(__dirname, '..', 'swift', 'AudioCaptureHelper', 'Info.plist'))),
      swiftSources: buildDirectoryManifest(
        path.join(__dirname, '..', 'swift', 'AudioCaptureHelper', 'Sources'),
        path.join(__dirname, '..', 'swift', 'AudioCaptureHelper')
      ),
      inheritEntitlements: hashString(readTextOrEmpty(path.join(__dirname, 'entitlements.mac.inherit.plist'))),
    },
  };
}

function ensurePipInstalled(pythonExe, pipTargetDir) {
  try {
    execSync(`"${pythonExe}" -m pip --version`, { stdio: 'inherit' });
    return Promise.resolve();
  } catch (error) {
    console.log('  pip not found; bootstrapping from pinned wheel...');
  }

  if (!fs.existsSync(pipTargetDir)) {
    fs.mkdirSync(pipTargetDir, { recursive: true });
  }

  const pipWheelPath = path.join(BUILD_DIR, path.basename(getBuildDownload('pipWheel').url));

  return downloadFile(getBuildDownload('pipWheel'), pipWheelPath)
    .then(() => {
      execSync(`"${pythonExe}" -m zipfile -e "${pipWheelPath}" "${pipTargetDir}"`, { stdio: 'inherit' });

      if (IS_WINDOWS) {
        ensureWindowsEmbeddedPythonPathConfig();
      }

      execSync(`"${pythonExe}" -m pip --version`, { stdio: 'inherit' });
    })
    .finally(() => {
      if (fs.existsSync(pipWheelPath)) {
        fs.unlinkSync(pipWheelPath);
      }
    });
}

function loadResourceManifest() {
  if (!fs.existsSync(RESOURCE_MANIFEST_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(RESOURCE_MANIFEST_PATH, 'utf8'));
  } catch (error) {
    console.log(`Warning: Could not parse resource manifest: ${error.message}`);
    return null;
  }
}

function manifestsMatch(currentManifest, existingManifest) {
  return JSON.stringify(currentManifest) === JSON.stringify(existingManifest);
}

function getStaleResourceDirectories() {
  return [PYTHON_DIR, FFMPEG_DIR, BIN_DIR];
}

function invalidateStaleResources() {
  const staleDirs = getStaleResourceDirectories();

  for (const dir of staleDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`Removed stale resource directory: ${path.relative(BUILD_DIR, dir)}`);
    }
  }
}

function assertNoWindowsOnlyStaleHelper() {
  if (!IS_WINDOWS) {
    return;
  }

  const helperPath = path.join(BIN_DIR, SWIFT_HELPER_BINARY);
  if (fs.existsSync(helperPath)) {
    throw new Error('Windows resources contain stale macOS audiocapture-helper; rerun prepare-build after cleanup.');
  }
}

function ensureWindowsEmptyBinDirectory() {
  if (IS_WINDOWS && !fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }
}

function buildMacOSHelperVerificationCommands(helperPath) {
  return [
    { command: 'codesign', args: ['--verify', '--strict', '--verbose=2', helperPath] },
    { command: 'codesign', args: ['-d', '--entitlements', ':-', helperPath] },
  ];
}

function macOSHelperEntitlementsIncludeInherit(entitlementsOutput) {
  return String(entitlementsOutput || '').includes('com.apple.security.inherit');
}

function verifyMacOSHelperSignature(helperPath = path.join(BIN_DIR, SWIFT_HELPER_BINARY)) {
  if (!IS_MAC) {
    return;
  }

  if (!fs.existsSync(helperPath)) {
    throw new Error(`macOS audiocapture-helper missing at ${helperPath}`);
  }

  const [verifyCommand, entitlementsCommand] = buildMacOSHelperVerificationCommands(helperPath);
  execFileSync(verifyCommand.command, verifyCommand.args, { stdio: 'inherit' });

  const entitlementsOutput = execFileSync(entitlementsCommand.command, entitlementsCommand.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!macOSHelperEntitlementsIncludeInherit(entitlementsOutput)) {
    throw new Error('macOS audiocapture-helper is missing com.apple.security.inherit entitlement.');
  }
}

function removeDirectoryIfExists(dirPath, label) {
  if (!fs.existsSync(dirPath)) {
    return false;
  }

  let sizeMB = null;
  if (IS_MAC) {
    try {
      sizeMB = execSync(`du -sm "${dirPath}" | cut -f1`, { encoding: 'utf8' }).trim();
    } catch (error) {
      sizeMB = null;
    }
  }

  fs.rmSync(dirPath, { recursive: true, force: true });
  console.log(sizeMB ? `  → Removed ${label} (${sizeMB} MB)` : `  → Removed ${label}`);
  return true;
}

function pruneMacOSPythonRuntimeDevelopmentFiles(sitePackagesDir) {
  if (!IS_MAC || !fs.existsSync(sitePackagesDir)) {
    return;
  }

  const pruneTargets = [
    {
      path: path.join(sitePackagesDir, 'torch', 'include'),
      label: 'torch/include development headers',
    },
    {
      path: path.join(sitePackagesDir, 'torch', 'share', 'cmake'),
      label: 'torch/share/cmake development metadata',
    },
    {
      path: path.join(sitePackagesDir, 'torch', 'test'),
      label: 'torch/test runtime test suite',
    },
    {
      path: path.join(sitePackagesDir, 'torch', 'testing', '_internal'),
      label: 'torch/testing/_internal development helpers',
    },
    {
      path: path.join(sitePackagesDir, 'torchgen'),
      label: 'torchgen code-generation package',
    },
    {
      path: path.join(sitePackagesDir, 'caffe2'),
      label: 'caffe2 development package',
    },
  ];

  let removedAny = false;
  for (const target of pruneTargets) {
    removedAny = removeDirectoryIfExists(target.path, target.label) || removedAny;
  }

  if (removedAny) {
    console.log('  → Pruned macOS Python development files not needed at runtime');
  }
}

function getMacOSPythonRuntimeRemovablePackages() {
  return [...MACOS_RUNTIME_REMOVABLE_PACKAGES];
}

function ensureFreshResourceManifest() {
  const currentManifest = buildResourceManifest();
  const existingManifest = loadResourceManifest();

  if (existingManifest && manifestsMatch(currentManifest, existingManifest)) {
    console.log('✓ Resource manifest matches current runtime inputs\n');
    return currentManifest;
  }

  if (existingManifest) {
    console.log('Runtime inputs changed; invalidating stale build/resources artifacts...');
  } else {
    console.log('No resource manifest found; preparing fresh build/resources artifacts...');
  }

  invalidateStaleResources();
  return currentManifest;
}

function writeResourceManifest(manifest) {
  fs.writeFileSync(RESOURCE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Helper function to download files
async function downloadFile(download, destination) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${download.url}`);
    const file = fs.createWriteStream(destination);

    https.get(download.url, { timeout: 30000 }, (response) => {
      // Handle redirects (301, 302, 303, 307, 308)
      if (response.statusCode >= 300 && response.statusCode < 400) {
        file.close();
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }

        // Handle both absolute and relative redirect URLs
        let redirectUrl = response.headers.location;
        if (redirectUrl.startsWith('/')) {
          // Relative URL - construct absolute URL from original request
          const parsedUrl = new URL(download.url);
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        }

        return downloadFile({ ...download, url: redirectUrl }, destination).then(resolve).catch(reject);
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
        file.close(async () => {
          try {
            const verifiedHash = await verifyFileChecksum(destination, download);
            console.log(`  Verified SHA-256: ${verifiedHash}`);
            console.log('  Download complete!\n');
            resolve();
          } catch (error) {
            if (fs.existsSync(destination)) {
              fs.unlinkSync(destination);
            }
            reject(error);
          }
        });
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

// Helper to extract tar.gz files (for macOS Python)
function extractTarGz(tarPath, targetDir) {
  console.log(`Extracting: ${path.basename(tarPath)}`);

  try {
    // Ensure target directory exists
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Use tar command (available on both macOS and Windows with Git Bash)
    execSync(`tar -xzf "${tarPath}" -C "${targetDir}"`, { stdio: 'inherit' });
    console.log('  Extraction complete!\n');
  } catch (error) {
    throw new Error(`Failed to extract ${tarPath}: ${error.message}`);
  }
}

// Check if resources already exist
function checkExistingResources() {
  const pythonExe = IS_WINDOWS ? 'python.exe' : 'python3';
  const ffmpegExe = IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg';

  // For macOS, check for python3 in PYTHON_DIR/bin/
  const pythonPath = IS_MAC
    ? path.join(PYTHON_DIR, 'bin', pythonExe)
    : path.join(PYTHON_DIR, pythonExe);

  const pythonExists = fs.existsSync(pythonPath);
  const ffmpegExists = fs.existsSync(path.join(FFMPEG_DIR, ffmpegExe));
  const modelsExist = fs.existsSync(MODELS_DIR) && fs.readdirSync(MODELS_DIR).length > 0;

  // Check for Swift helper binary (macOS only)
  const swiftHelperExists = IS_MAC
    ? fs.existsSync(path.join(BIN_DIR, SWIFT_HELPER_BINARY))
    : true; // Not needed on Windows

  return { pythonExists, ffmpegExists, modelsExist, swiftHelperExists };
}

// Build Swift AudioCaptureHelper (macOS only)
function buildSwiftHelper() {
  console.log('[Swift] Building AudioCaptureHelper...');

  // Check if Swift is available
  try {
    execSync('swift --version', { stdio: 'pipe' });
  } catch (error) {
    console.error('ERROR: Swift not found. Please install Xcode or Swift toolchain.');
    throw new Error('Swift toolchain not available');
  }

  // Check if Package.swift exists
  if (!fs.existsSync(path.join(SWIFT_HELPER_DIR, 'Package.swift'))) {
    console.error(`ERROR: Package.swift not found at ${SWIFT_HELPER_DIR}`);
    throw new Error('Swift package not found');
  }

  // Build in release mode
  console.log('  Building release configuration...');
  try {
    execSync('swift build -c release --arch arm64', {
      cwd: SWIFT_HELPER_DIR,
      stdio: 'inherit'
    });
  } catch (error) {
    console.error('ERROR: Swift build failed');
    throw error;
  }

  // Create bin directory if needed
  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  let binPath;
  try {
    binPath = execSync('swift build -c release --arch arm64 --show-bin-path', {
      cwd: SWIFT_HELPER_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit']
    }).trim();
  } catch (error) {
    console.error('ERROR: Could not resolve Swift binary directory via --show-bin-path');
    throw error;
  }

  const sourceBinary = path.join(binPath, SWIFT_HELPER_BINARY);

  if (!fs.existsSync(sourceBinary)) {
    console.error(`ERROR: Built binary not found at resolved bin path: ${sourceBinary}`);
    throw new Error('Swift binary not found after build');
  }

  // Copy to resources/bin
  const destBinary = path.join(BIN_DIR, SWIFT_HELPER_BINARY);
  fs.copyFileSync(sourceBinary, destBinary);

  // Ensure executable
  execSync(`chmod +x "${destBinary}"`, { stdio: 'inherit' });

  // Strip debug symbols to reduce binary size (typically 50-70% reduction)
  console.log('  Stripping debug symbols...');
  try {
    const beforeSize = fs.statSync(destBinary).size;
    execSync(`strip "${destBinary}"`, { stdio: 'inherit' });
    const afterSize = fs.statSync(destBinary).size;
    const reduction = ((beforeSize - afterSize) / beforeSize * 100).toFixed(1);
    console.log(`  → Stripped: ${(beforeSize / 1024).toFixed(0)}KB → ${(afterSize / 1024).toFixed(0)}KB (${reduction}% reduction)`);
  } catch (stripError) {
    console.log('  → Strip failed (non-critical):', stripError.message);
  }

  // Sign the helper binary with inherit entitlements
  // This allows it to inherit Screen Recording permission from the parent app
  console.log('  Signing helper binary with inherit entitlements...');
  const inheritEntitlements = path.join(__dirname, 'entitlements.mac.inherit.plist');
  try {
    // Use ad-hoc signing (-) for development, electron-builder will re-sign for distribution
    execSync(`codesign --force --options runtime --entitlements "${inheritEntitlements}" --sign - "${destBinary}"`, {
      stdio: 'inherit'
    });
    console.log('  → Helper binary signed with inherit entitlements');
  } catch (signError) {
    console.log('  → Signing failed (may still work if electron-builder signs it):', signError.message);
  }

  console.log(`  ✓ Built and copied to ${destBinary}`);
  console.log('✓ Swift AudioCaptureHelper ready!\n');
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
  console.log('========================================');
  console.log('AvaNevis - Build Preparation');
  console.log(`Platform: ${process.platform}`);
  console.log('========================================\n');

  ensureBuildDirectory();

  const resourceManifest = ensureFreshResourceManifest();
  const existing = checkExistingResources();
  assertNoWindowsOnlyStaleHelper();
  ensureWindowsEmptyBinDirectory();

  // Prepare Python
  if (existing.pythonExists) {
    console.log('✓ Python runtime already prepared');
    
    // CRITICAL FIX (v1.7.4): Always ensure .pth file has backend path
    // This applies the fix even if Python was downloaded in a previous build
    if (IS_WINDOWS) {
      const pthFile = path.join(PYTHON_DIR, 'python311._pth');
      if (fs.existsSync(pthFile)) {
        ensureWindowsEmbeddedPythonPathConfig();
        console.log('');
      }
    }
  } else {
    if (IS_MAC) {
      // macOS: Download standalone Python build
      console.log('[1/4] Downloading standalone Python for macOS (arm64)...');
      const pythonTar = path.join(BUILD_DIR, 'python-macos.tar.gz');
      await downloadFile(getBuildDownload('pythonMac'), pythonTar);

      console.log('[2/4] Extracting Python...');
      // Extract to temp dir first
      const tempDir = path.join(BUILD_DIR, 'python-temp');
      extractTarGz(pythonTar, tempDir);

      // Move the python directory to PYTHON_DIR
      const extractedPythonDir = path.join(tempDir, 'python');
      if (fs.existsSync(extractedPythonDir)) {
        // Move contents to PYTHON_DIR
        if (fs.existsSync(PYTHON_DIR)) {
          fs.rmSync(PYTHON_DIR, { recursive: true, force: true });
        }
        fs.renameSync(extractedPythonDir, PYTHON_DIR);
      }

      // Cleanup
      fs.unlinkSync(pythonTar);
      fs.rmSync(tempDir, { recursive: true, force: true });

      console.log('[3/4] Setting up pip...');

      // python-build-standalone includes pip, just verify it works
      const pythonExe = path.join(PYTHON_DIR, 'bin', 'python3');

      // Make python executable
      execSync(`chmod +x "${pythonExe}"`, { stdio: 'inherit' });

      await ensurePipInstalled(pythonExe, path.join(PYTHON_DIR, 'lib', 'python3.11', 'site-packages'));

      console.log('[4/4] Installing Python dependencies...');

      // Install requirements (macOS-specific)
      const requirementsPath = fs.existsSync(REQUIREMENTS_MACOS_BUILD)
        ? REQUIREMENTS_MACOS_BUILD
        : path.join(__dirname, '..', 'requirements-macos.txt');
      execSync(`"${pythonExe}" -m pip install --only-binary=:all: -r "${requirementsPath}"`, {
        stdio: 'inherit'
      });

      // Clean up bloated transitive dependencies to reduce bundle size
      // NOTE: scipy and torch are REQUIRED by lightning-whisper-mlx metadata.
      // Keep runtime packages, but prune torch development/test files below.
      console.log('[5/5] Cleaning up unused dependencies...');
      const sitePackages = path.join(PYTHON_DIR, 'lib', 'python3.11', 'site-packages');
      // Keep pip: explicit speaker diarization setup installs optional pyannote
      // dependencies into userData after the packaged app is installed.
      const packagesToRemove = getMacOSPythonRuntimeRemovablePackages();

      for (const pkg of packagesToRemove) {
        const pkgPath = path.join(sitePackages, pkg);
        removeDirectoryIfExists(pkgPath, pkg);
      }

      pruneMacOSPythonRuntimeDevelopmentFiles(sitePackages);

      console.log('✓ Python setup complete!\n');
    } else {
      // Windows: Download embedded Python
      console.log('[1/4] Downloading embedded Python...');
      const pythonZip = path.join(BUILD_DIR, 'python-embed.zip');
      await downloadFile(getBuildDownload('pythonWin'), pythonZip);

      console.log('[2/4] Extracting Python...');
      extractZip(pythonZip, PYTHON_DIR);
      fs.unlinkSync(pythonZip);

      console.log('[3/4] Setting up pip...');

      // Modify python311._pth to:
      // 1. Enable site packages (uncomment 'import site')
      // 2. Add backend folder path so -m flag can find our modules (audio, transcription)
      //    CRITICAL FIX (v1.7.3): Embedded Python ignores PYTHONPATH env var, so we MUST
      //    add paths directly to the .pth file for module resolution to work.
      ensureWindowsEmbeddedPythonPathConfig();

      // Install pip
      const pythonExe = path.join(PYTHON_DIR, 'python.exe');
      await ensurePipInstalled(pythonExe, path.join(PYTHON_DIR, 'Lib', 'site-packages'));

      console.log('[4/4] Installing Python dependencies...');

      // Install requirements (Windows-specific)
      const requirementsPath = fs.existsSync(REQUIREMENTS_WINDOWS_BUILD)
        ? REQUIREMENTS_WINDOWS_BUILD
        : path.join(__dirname, '..', 'requirements-windows.txt');
      execSync(`"${pythonExe}" -m pip install --only-binary=:all: -r "${requirementsPath}" --no-warn-script-location`, {
        stdio: 'inherit'
      });

      console.log('✓ Python setup complete!\n');
    }
  }

  if (IS_MAC) {
    pruneMacOSPythonRuntimeDevelopmentFiles(path.join(PYTHON_DIR, 'lib', 'python3.11', 'site-packages'));
  }

  // Prepare ffmpeg
  if (existing.ffmpegExists) {
    console.log('✓ ffmpeg already prepared\n');
  } else {
    if (IS_MAC) {
      // macOS: Download ffmpeg binary
      console.log('[1/2] Downloading ffmpeg for macOS...');
      const ffmpegZip = path.join(BUILD_DIR, 'ffmpeg.zip');
      await downloadFile(getBuildDownload('ffmpegMac'), ffmpegZip);

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
      await downloadFile(getBuildDownload('ffmpegWin'), ffmpegZip);

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

  // Build Swift AudioCaptureHelper (macOS only)
  if (IS_MAC) {
    if (existing.swiftHelperExists) {
      console.log('✓ Swift AudioCaptureHelper already built\n');
    } else {
      try {
        buildSwiftHelper();
      } catch (error) {
        console.error('ERROR: Swift helper build failed:', error.message);
        console.log('  macOS desktop audio capture requires the bundled Swift helper.\n');
        throw error;
      }
    }

    verifyMacOSHelperSignature();
  }

  assertNoWindowsOnlyStaleHelper();
  ensureWindowsEmptyBinDirectory();

  // Download Whisper models (optional, Windows only)
  // macOS uses MLX-format models from mlx-community/* which are incompatible with
  // the CTranslate2 models downloaded by faster-whisper. The macOS app downloads
  // MLX models on first use to ~/.cache/huggingface/hub, so bundling is skipped.
  if (IS_MAC) {
    console.log('ℹ️ Skipping model bundling on macOS (uses MLX models from HuggingFace cache)\n');
  } else if (existing.modelsExist) {
    console.log('✓ Whisper models already prepared\n');
  } else {
    const shouldDownloadModels = process.env.DOWNLOAD_MODELS === 'true';

    if (shouldDownloadModels) {
      console.log('Preparing Whisper models for installation...');
      console.log('(Set DOWNLOAD_MODELS=true was specified)\n');
      await downloadWhisperModels();
    } else {
      console.log('ℹ️ Skipping model bundling (models download on first use)\n');
      console.log('  Set DOWNLOAD_MODELS=true to pre-bundle models in the installer.\n');
    }
  }

  console.log('========================================');
  console.log('Build preparation complete!');
  console.log('========================================');

  writeResourceManifest(resourceManifest);
}

if (require.main === module) {
  prepareResources().catch((error) => {
    console.error('ERROR:', error.message);
    process.exit(1);
  });
}

module.exports = {
  buildDirectoryManifest,
  buildResourceManifest,
  ensureWindowsEmbeddedPythonPathConfig,
  getMacOSPythonRuntimeRemovablePackages,
  buildMacOSHelperVerificationCommands,
  macOSHelperEntitlementsIncludeInherit,
  getStaleResourceDirectories,
  ensureWindowsEmptyBinDirectory,
  listFilesRecursively,
  manifestsMatch,
  prepareResources,
  pruneMacOSPythonRuntimeDevelopmentFiles,
  verifyMacOSHelperSignature,
};
