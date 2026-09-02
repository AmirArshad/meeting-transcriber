const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync, execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { BUILD_DOWNLOADS, getBuildDownload, hashString, verifyFileChecksum } = require('./download-manifest');

const PYTHON_VERSION = '3.11.9';

const BUILD_DIR = path.join(__dirname, 'resources');
const PYTHON_DIR = path.join(BUILD_DIR, 'python');
const FFMPEG_DIR = path.join(BUILD_DIR, 'ffmpeg');
const LEGAL_DIR = path.join(BUILD_DIR, 'legal');
const BIN_DIR = path.join(BUILD_DIR, 'bin');
const REPO_ROOT = path.join(__dirname, '..');
const RESOURCE_MANIFEST_PATH = path.join(BUILD_DIR, 'resource-manifest.json');
const RESOURCE_MANIFEST_VERSION = 8;
const REQUIREMENTS_MACOS_BUILD = path.join(__dirname, '..', 'requirements-macos-build.txt');
const REQUIREMENTS_WINDOWS_BUILD = path.join(__dirname, '..', 'requirements-windows-build.txt');
const REQUIREMENTS_LINUX_BUILD = path.join(__dirname, '..', 'requirements-linux-build.txt');
const MACOS_PYTHON_WHEEL_PLATFORM = 'macosx_14_0_arm64';
const MACOS_RUNTIME_REMOVABLE_PACKAGES = Object.freeze([
  'sympy',
  'av.libs',
  'setuptools',
  'onnxruntime',
  'faster_whisper',
  'ctranslate2',
  'ctranslate2.libs',
  // lightning-whisper-mlx declares torch but MLX inference never imports torch_whisper.py.
  'torch',
  'torchgen',
  'caffe2',
  'networkx',
  'mpmath',
  'Jinja2',
  'MarkupSafe',
]);

// Swift AudioCaptureHelper paths
const SWIFT_HELPER_DIR = path.join(__dirname, '..', 'swift', 'AudioCaptureHelper');
const SWIFT_HELPER_BINARY = 'audiocapture-helper';

const {
  MACHO_CPU_TYPE_ARM64,
  WINDOWS_PE_MACHINE_AMD64,
  assertSpeakrsCliArchitecture: assertSpeakrsCliArchitectureHeaders,
  inspectSpeakrsCliFile,
  inspectSpeakrsValidateWavFile,
  isLinuxX64ElfExecutableFileOutput,
  readElfMachine,
  readMachOCpuType,
  readWindowsPeMachine,
  SPEAKRS_VALIDATE_WAV_NAME,
} = require('../src/ai-addon/speakrs-cli-integrity');

const SPEAKRS_CLI_DIR = path.join(REPO_ROOT, 'native', 'speakrs-cli');
const SPEAKRS_VALIDATE_WAV_SOURCE = path.join(REPO_ROOT, 'tests', 'fixtures', SPEAKRS_VALIDATE_WAV_NAME);
const SPEAKRS_ORT_COMPILE_PINS_PATH = path.join(SPEAKRS_CLI_DIR, 'ort-compile-pins.json');

const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

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

function copyFileIfExists(sourcePath, destPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
  return true;
}

function copyWindowsFfmpegUpstreamLicense(ffmpegExtractRoot) {
  const licenseCandidates = ['LICENSE', 'COPYING.GPLv3', 'COPYING', 'license.txt'];

  for (const name of licenseCandidates) {
    const sourcePath = path.join(ffmpegExtractRoot, name);
    if (copyFileIfExists(sourcePath, path.join(LEGAL_DIR, `ffmpeg-upstream-${name}`))) {
      return name;
    }
  }

  return null;
}

function copyDirectoryContents(sourceDir, destinationDir) {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destinationPath, { recursive: true });
      copyDirectoryContents(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      copyFileIfExists(sourcePath, destinationPath);
    }
  }
}

function stageLegalBundle(targetDir = LEGAL_DIR) {
  fs.mkdirSync(targetDir, { recursive: true });

  copyFileIfExists(path.join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'), path.join(targetDir, 'THIRD_PARTY_NOTICES.md'));
  copyFileIfExists(path.join(REPO_ROOT, 'LICENSE.txt'), path.join(targetDir, 'LICENSE.txt'));

  const repoLegalDir = path.join(REPO_ROOT, 'legal');
  if (fs.existsSync(repoLegalDir)) {
    copyDirectoryContents(repoLegalDir, targetDir);
  }

  writeFfmpegComplianceManifest(targetDir);
}

function writeFfmpegComplianceManifest(targetDir = LEGAL_DIR) {
  const templatePath = path.join(REPO_ROOT, 'legal', 'FFMPEG-COMPLIANCE.json');
  const ffmpegSource = getBuildDownload('ffmpegSource');
  let template = {};

  if (fs.existsSync(templatePath)) {
    try {
      template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    } catch (error) {
      console.log(`Warning: Could not parse ${templatePath}: ${error.message}`);
    }
  }

  const templateProvenance = template.binaryProvenance || {};
  const compliance = {
    ffmpegVersion: template.ffmpegVersion || '8.0.1',
    license: template.license || 'GPL-3.0-or-later',
    binaryProvenance: {
      win32: {
        ...(templateProvenance.win32 || {}),
        label: BUILD_DOWNLOADS.ffmpegWin.label,
        downloadUrl: BUILD_DOWNLOADS.ffmpegWin.url,
        buildPage: 'https://www.gyan.dev/ffmpeg/builds/',
        sha256: BUILD_DOWNLOADS.ffmpegWin.sha256,
      },
      darwin: {
        ...(templateProvenance.darwin || {}),
        label: BUILD_DOWNLOADS.ffmpegMac.label,
        downloadUrl: BUILD_DOWNLOADS.ffmpegMac.url,
        sha256: BUILD_DOWNLOADS.ffmpegMac.sha256,
        requiredArch: BUILD_DOWNLOADS.ffmpegMac.requiredArch || 'arm64',
      },
      linux: {
        ...(templateProvenance.linux || {}),
        label: BUILD_DOWNLOADS.ffmpegLinux.label,
        downloadUrl: BUILD_DOWNLOADS.ffmpegLinux.url,
        sha256: BUILD_DOWNLOADS.ffmpegLinux.sha256,
        requiredArch: BUILD_DOWNLOADS.ffmpegLinux.requiredArch || 'x64',
      },
    },
    correspondingSource: {
      ...(template.correspondingSource || {}),
      label: ffmpegSource.label,
      downloadUrl: ffmpegSource.url,
      archiveFileName: ffmpegSource.archiveFileName,
      sha256: ffmpegSource.sha256,
    },
    usageInAvaNevis: template.usageInAvaNevis
      || 'ffmpeg is invoked as a separate subprocess for Opus compression after recording.',
    releaseDistribution: template.releaseDistribution,
  };

  fs.writeFileSync(
    path.join(targetDir, 'FFMPEG-COMPLIANCE.json'),
    `${JSON.stringify(compliance, null, 2)}\n`,
    'utf8'
  );
}

function writeFfmpegBinaryInfo(targetDir = LEGAL_DIR) {
  const ffmpegExe = IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg';
  const ffmpegPath = path.join(FFMPEG_DIR, ffmpegExe);

  if (!fs.existsSync(ffmpegPath)) {
    return;
  }

  try {
    const output = execFileSync(ffmpegPath, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    fs.writeFileSync(path.join(targetDir, 'FFMPEG-BINARY-INFO.txt'), output, 'utf8');
  } catch (error) {
    console.log(`Warning: Could not capture ffmpeg -version: ${error.message}`);
  }
}

async function stageFfmpegSourceArchive(targetDir = LEGAL_DIR) {
  const download = getBuildDownload('ffmpegSource');
  const destPath = path.join(targetDir, download.archiveFileName || 'ffmpeg-8.0.1.tar.xz');

  if (!fs.existsSync(destPath)) {
    console.log(`Downloading ${download.label} for legal compliance...`);
    await downloadFile(download, destPath);
  }

  await verifyFileChecksum(destPath, download);
  console.log(`✓ FFmpeg source archive verified (${path.basename(destPath)})\n`);
  return destPath;
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
      requirementsLinux: hashString(readTextOrEmpty(path.join(__dirname, '..', 'requirements-linux.txt'))),
      requirementsMacosBuild: hashString(readTextOrEmpty(REQUIREMENTS_MACOS_BUILD)),
      requirementsWindowsBuild: hashString(readTextOrEmpty(REQUIREMENTS_WINDOWS_BUILD)),
      requirementsLinuxBuild: hashString(readTextOrEmpty(REQUIREMENTS_LINUX_BUILD)),
      swiftPackage: hashString(readTextOrEmpty(path.join(__dirname, '..', 'swift', 'AudioCaptureHelper', 'Package.swift'))),
      swiftInfoPlist: hashString(readTextOrEmpty(path.join(__dirname, '..', 'swift', 'AudioCaptureHelper', 'Info.plist'))),
      swiftSources: buildDirectoryManifest(
        path.join(__dirname, '..', 'swift', 'AudioCaptureHelper', 'Sources'),
        path.join(__dirname, '..', 'swift', 'AudioCaptureHelper')
      ),
      inheritEntitlements: hashString(readTextOrEmpty(path.join(__dirname, 'entitlements.mac.inherit.plist'))),
      speakrsCargoToml: hashString(readTextOrEmpty(path.join(SPEAKRS_CLI_DIR, 'Cargo.toml'))),
      speakrsCargoLock: hashString(readTextOrEmpty(path.join(SPEAKRS_CLI_DIR, 'Cargo.lock'))),
      speakrsToolchain: hashString(readTextOrEmpty(path.join(SPEAKRS_CLI_DIR, 'rust-toolchain.toml'))),
      speakrsSources: buildDirectoryManifest(
        path.join(SPEAKRS_CLI_DIR, 'src'),
        SPEAKRS_CLI_DIR
      ),
      speakrsOrtCompilePins: hashString(readTextOrEmpty(SPEAKRS_ORT_COMPILE_PINS_PATH)),
      speakrsCargoTarget: getSpeakrsResourceManifestTarget(),
      speakrsValidateWav: fs.existsSync(SPEAKRS_VALIDATE_WAV_SOURCE)
        ? hashFileContent(SPEAKRS_VALIDATE_WAV_SOURCE)
        : '',
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

function ensureLinuxEmptyBinDirectory() {
  // extraResources copies build/resources/bin on every platform. Linux now
  // stages speakrs-cli into this directory; keep the mkdir as a safety net
  // so packaging does not fail closed on a missing from-path.
  if (IS_LINUX && !fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }
}

function buildMacOSHelperVerificationCommands(helperPath) {
  return [
    { command: 'codesign', args: ['--verify', '--strict', '--verbose=2', helperPath] },
    { command: 'codesign', args: ['-d', '--entitlements', ':-', helperPath] },
  ];
}

function buildMacOSPythonWheelhouseCommands(requirementsPath, wheelhousePath) {
  return {
    download: [
      '-m', 'pip', 'download', '--only-binary=:all:',
      '--platform', MACOS_PYTHON_WHEEL_PLATFORM,
      '--implementation', 'cp',
      '--python-version', '3.11',
      '--abi', 'cp311',
      '--dest', wheelhousePath,
      '-r', requirementsPath,
    ],
    install: [
      '-m', 'pip', 'install', '--only-binary=:all:',
      '--no-index', '--find-links', wheelhousePath,
      '-r', requirementsPath,
    ],
  };
}

function macOSHelperEntitlementsIncludeInherit(entitlementsOutput) {
  return /<key>\s*com\.apple\.security\.inherit\s*<\/key>\s*<true\s*\/>/m.test(String(entitlementsOutput || ''));
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

function assertMacOSFfmpegBinaryArchitecture(ffmpegPath) {
  const requiredArch = getBuildDownload('ffmpegMac').requiredArch || 'arm64';
  const fileOutput = execSync(`file "${ffmpegPath}"`, { encoding: 'utf8' });
  if (!fileOutput.includes(requiredArch)) {
    throw new Error(
      `Bundled macOS ffmpeg is not ${requiredArch}: ${fileOutput.trim()}`
    );
  }
}

function assertMacOSPythonRuntimeImports(pythonExe) {
  const importCheck = [
    'import lightning_whisper_mlx',
    'from lightning_whisper_mlx.lightning import LightningWhisperMLX',
    'import transcription.mlx_whisper_transcriber',
  ].join('; ');

  execSync(`"${pythonExe}" -c "${importCheck}"`, {
    stdio: 'inherit',
    env: {
      ...process.env,
      PYTHONPATH: path.join(REPO_ROOT, 'backend'),
    },
  });
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
async function downloadFile(download, destination, { redirectDepth = 0 } = {}) {
  const maxRedirects = 5;
  const connectTimeoutMs = 30000;
  const idleTimeoutMs = 60000;

  return new Promise((resolve, reject) => {
    console.log(`Downloading: ${download.url}`);
    const file = fs.createWriteStream(destination);
    let settled = false;
    let clearIdleTimer = () => {};

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearIdleTimer();
      file.close(() => {
        if (fs.existsSync(destination)) {
          try {
            fs.unlinkSync(destination);
          } catch (_unlinkError) {
            // Best-effort cleanup.
          }
        }
        reject(error);
      });
    };

    const req = https.get(download.url, { timeout: connectTimeoutMs }, (response) => {
      // Handle redirects (301, 302, 303, 307, 308)
      if (response.statusCode >= 300 && response.statusCode < 400) {
        file.close();
        if (fs.existsSync(destination)) {
          fs.unlinkSync(destination);
        }

        if (redirectDepth >= maxRedirects) {
          return fail(new Error(`Too many redirects (max ${maxRedirects}) while downloading ${download.url}`));
        }

        // Handle both absolute and relative redirect URLs
        let redirectUrl = response.headers.location;
        if (!redirectUrl) {
          return fail(new Error(`Redirect response missing Location header for ${download.url}`));
        }
        if (redirectUrl.startsWith('/')) {
          // Relative URL - construct absolute URL from original request
          const parsedUrl = new URL(download.url);
          redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
        }

        settled = true;
        return downloadFile({ ...download, url: redirectUrl }, destination, {
          redirectDepth: redirectDepth + 1,
        }).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        return fail(new Error(`Failed to download: ${response.statusCode}`));
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      const hasTotalSize = Number.isFinite(totalSize) && totalSize > 0;
      let downloadedSize = 0;
      let lastPercent = 0;
      let lastByteLog = 0;
      let idleTimer = null;

      clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      const armIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          req.destroy();
          fail(new Error(`Download stalled after ${idleTimeoutMs}ms with no data: ${download.url}`));
        }, idleTimeoutMs);
      };

      armIdleTimer();

      response.on('data', (chunk) => {
        armIdleTimer();
        downloadedSize += chunk.length;
        if (hasTotalSize) {
          const percent = Math.floor((downloadedSize / totalSize) * 100);
          if (percent > lastPercent && percent % 10 === 0) {
            console.log(`  Progress: ${percent}%`);
            lastPercent = percent;
          }
        } else if (downloadedSize - lastByteLog >= 5 * 1024 * 1024) {
          console.log(`  Progress: ${(downloadedSize / (1024 * 1024)).toFixed(1)} MB`);
          lastByteLog = downloadedSize;
        }
      });

      response.on('error', (err) => {
        clearIdleTimer();
        fail(err);
      });

      response.pipe(file);

      file.on('finish', () => {
        clearIdleTimer();
        file.close(async () => {
          if (settled) {
            return;
          }
          try {
            const verifiedHash = await verifyFileChecksum(destination, download);
            console.log(`  Verified SHA-256: ${verifiedHash}`);
            console.log('  Download complete!\n');
            settled = true;
            resolve();
          } catch (error) {
            fail(error);
          }
        });
      });
    });

    file.on('error', (err) => {
      clearIdleTimer();
      req.destroy();
      fail(err);
    });

    req.on('timeout', () => {
      req.destroy();
      fail(new Error(`Download timed out after ${connectTimeoutMs}ms connecting to ${download.url}`));
    });

    req.on('error', (err) => {
      fail(err);
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

function getSpeakrsCliBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'speakrs-cli.exe' : 'speakrs-cli';
}

function isSpeakrsPackagingSupported(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
}

function getSpeakrsCargoTargetTriple(platform = process.platform) {
  if (platform === 'darwin') {
    return 'aarch64-apple-darwin';
  }
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }
  if (platform === 'linux') {
    return 'x86_64-unknown-linux-gnu';
  }
  throw new Error(`Unsupported Speakrs packaging platform: ${platform}`);
}

function getSpeakrsResourceManifestTarget(platform = process.platform) {
  return isSpeakrsPackagingSupported(platform) ? getSpeakrsCargoTargetTriple(platform) : null;
}

function getSpeakrsCargoFeatures(platform = process.platform) {
  if (platform === 'darwin') {
    return Object.freeze(['default-linalg', 'coreml']);
  }
  if (platform === 'win32' || platform === 'linux') {
    return Object.freeze(['default-linalg', 'cuda', 'load-dynamic']);
  }
  return Object.freeze(['default-linalg']);
}

function resolveCargoTargetDir(env = process.env, { cwd = SPEAKRS_CLI_DIR } = {}) {
  const raw = env && env.CARGO_TARGET_DIR;
  if (!raw) {
    return path.join(cwd, 'target');
  }
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function resolveSpeakrsCliCargoOutputPath(platform = process.platform, env = process.env, { cwd = SPEAKRS_CLI_DIR } = {}) {
  return path.join(
    resolveCargoTargetDir(env, { cwd }),
    getSpeakrsCargoTargetTriple(platform),
    'release',
    getSpeakrsCliBinaryName(platform)
  );
}

function buildSpeakrsCliCargoArgs(platform = process.platform, { manifestPath } = {}) {
  return [
    'build',
    '--release',
    '--locked',
    '--target',
    getSpeakrsCargoTargetTriple(platform),
    '--manifest-path',
    manifestPath || path.join(SPEAKRS_CLI_DIR, 'Cargo.toml'),
  ];
}

function loadSpeakrsOrtCompilePins() {
  if (!fs.existsSync(SPEAKRS_ORT_COMPILE_PINS_PATH)) {
    throw new Error(`Speakrs ort compile-time pins are missing: ${SPEAKRS_ORT_COMPILE_PINS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(SPEAKRS_ORT_COMPILE_PINS_PATH, 'utf8'));
}

function assertSpeakrsCliArchitecture(filePath, platform = process.platform) {
  const arch = assertSpeakrsCliArchitectureHeaders(filePath, platform);
  if (platform === 'darwin' && process.platform === 'darwin') {
    const fileOutput = execFileSync('file', [filePath], { encoding: 'utf8' });
    if (!fileOutput.includes('arm64')) {
      throw new Error(`Bundled macOS speakrs-cli is not arm64: ${fileOutput.trim()}`);
    }
  }
  if (platform === 'linux' && process.platform === 'linux') {
    const fileOutput = execFileSync('file', [filePath], { encoding: 'utf8' });
    if (!isLinuxX64ElfExecutableFileOutput(fileOutput)) {
      throw new Error(
        `Bundled Linux speakrs-cli is not an x86_64 ELF executable/PIE: ${fileOutput.trim()}`,
      );
    }
  }
  return arch;
}

function resolveCargoExecutable() {
  const cargoName = IS_WINDOWS ? 'cargo.exe' : 'cargo';
  const candidates = [];
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    candidates.push(path.join(entry, cargoName));
  }
  candidates.push(path.join(os.homedir(), '.cargo', 'bin', cargoName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Rust cargo not found. Install rustup 1.88.0 from native/speakrs-cli/rust-toolchain.toml.');
}

function resolveRustupExecutable(cargoPath) {
  const rustupName = IS_WINDOWS ? 'rustup.exe' : 'rustup';
  const nextToCargo = cargoPath ? path.join(path.dirname(cargoPath), rustupName) : null;
  const candidates = [];
  if (nextToCargo) {
    candidates.push(nextToCargo);
  }
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    candidates.push(path.join(entry, rustupName));
  }
  candidates.push(path.join(os.homedir(), '.cargo', 'bin', rustupName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Rust rustup not found. Install rustup 1.88.0 from native/speakrs-cli/rust-toolchain.toml.');
}

function ensureSpeakrsRustTargetInstalled(triple, cargoPath) {
  const rustup = resolveRustupExecutable(cargoPath);
  try {
    execFileSync(rustup, ['target', 'add', triple], { stdio: 'inherit' });
  } catch (error) {
    throw new Error(`Failed to install Rust target ${triple}: ${error.message}`);
  }
}

function assertStagedSpeakrsCli(binDir = BIN_DIR, platform = process.platform) {
  const destBinary = path.join(binDir, getSpeakrsCliBinaryName(platform));
  const inspection = inspectSpeakrsCliFile(destBinary, { platform });
  if (!inspection.ok) {
    if (inspection.reason === 'missing') {
      throw new Error(`speakrs-cli missing at ${destBinary}; prepare-build cannot continue.`);
    }
    if (inspection.reason === 'empty' || inspection.reason === 'directory' || inspection.reason === 'not-a-file') {
      throw new Error(`speakrs-cli is empty or not a file at ${destBinary}`);
    }
    if (inspection.reason === 'non-executable') {
      throw new Error(`speakrs-cli is not executable at ${destBinary}`);
    }
    assertSpeakrsCliArchitecture(destBinary, platform);
    throw new Error(`speakrs-cli failed integrity checks at ${destBinary}`);
  }
  assertSpeakrsCliArchitecture(destBinary, platform);
  return destBinary;
}

function assertStagedSpeakrsValidateWav(binDir = BIN_DIR) {
  const destWav = path.join(binDir, SPEAKRS_VALIDATE_WAV_NAME);
  const inspection = inspectSpeakrsValidateWavFile(destWav);
  if (!inspection.ok) {
    if (inspection.reason === 'missing') {
      throw new Error(`Speakrs validation fixture WAV is missing at ${destWav}`);
    }
    throw new Error(`Speakrs validation fixture WAV is empty at ${destWav}`);
  }
  return destWav;
}

function stageSpeakrsValidateWav(binDir = BIN_DIR) {
  if (!fs.existsSync(SPEAKRS_VALIDATE_WAV_SOURCE)) {
    throw new Error(`Speakrs validation fixture WAV is missing: ${SPEAKRS_VALIDATE_WAV_SOURCE}`);
  }
  const sourceSize = fs.statSync(SPEAKRS_VALIDATE_WAV_SOURCE).size;
  if (sourceSize <= 0) {
    throw new Error(`Speakrs validation fixture WAV source is empty: ${SPEAKRS_VALIDATE_WAV_SOURCE}`);
  }
  fs.mkdirSync(binDir, { recursive: true });
  const destWav = path.join(binDir, SPEAKRS_VALIDATE_WAV_NAME);
  fs.copyFileSync(SPEAKRS_VALIDATE_WAV_SOURCE, destWav);
  const staged = assertStagedSpeakrsValidateWav(binDir);
  if (fs.statSync(staged).size !== sourceSize) {
    throw new Error(`Failed to stage Speakrs validation fixture WAV at ${destWav}`);
  }
  return staged;
}

function buildMacOSSpeakrsCliVerificationCommands(cliPath) {
  return [
    { command: 'codesign', args: ['--verify', '--strict', '--verbose=2', cliPath] },
    { command: 'codesign', args: ['-d', '--entitlements', ':-', cliPath] },
  ];
}

function verifyMacOSSpeakrsCliSignature(cliPath = path.join(BIN_DIR, getSpeakrsCliBinaryName())) {
  if (!IS_MAC) {
    return;
  }

  if (!fs.existsSync(cliPath)) {
    throw new Error(`macOS speakrs-cli missing at ${cliPath}`);
  }

  const [verifyCommand, entitlementsCommand] = buildMacOSSpeakrsCliVerificationCommands(cliPath);
  execFileSync(verifyCommand.command, verifyCommand.args, { stdio: 'inherit' });

  const entitlementsOutput = execFileSync(entitlementsCommand.command, entitlementsCommand.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!macOSHelperEntitlementsIncludeInherit(entitlementsOutput)) {
    throw new Error('macOS speakrs-cli is missing com.apple.security.inherit entitlement.');
  }
}

function buildSpeakrsCli() {
  console.log('[Speakrs] Building speakrs-cli...');

  if (!fs.existsSync(path.join(SPEAKRS_CLI_DIR, 'Cargo.toml'))) {
    throw new Error(`speakrs-cli crate not found at ${SPEAKRS_CLI_DIR}`);
  }
  if (!fs.existsSync(path.join(SPEAKRS_CLI_DIR, 'rust-toolchain.toml'))) {
    throw new Error('speakrs-cli rust-toolchain.toml is missing');
  }

  const pins = loadSpeakrsOrtCompilePins();
  if (IS_WINDOWS && pins['win32-x64'] !== null) {
    throw new Error('Windows speakrs-cli must stay load-dynamic; do not add a compile-time ORT download pin.');
  }
  if (IS_LINUX && pins['linux-x64'] !== null) {
    throw new Error('Linux speakrs-cli must stay load-dynamic; do not add a compile-time ORT download pin.');
  }
  if (IS_MAC && (!pins['darwin-arm64'] || !pins['darwin-arm64'].sha256 || !pins['darwin-arm64'].url)) {
    throw new Error('macOS speakrs-cli is missing a pinned ort compile-time download.');
  }

  const cargo = resolveCargoExecutable();
  const features = getSpeakrsCargoFeatures();
  const triple = getSpeakrsCargoTargetTriple();
  ensureSpeakrsRustTargetInstalled(triple, cargo);
  console.log(`  Using ${cargo}`);
  console.log(`  Target: ${triple}`);
  console.log(`  Feature flags (Cargo.toml target cfg): ${features.join(', ')}`);

  try {
    execFileSync(cargo, buildSpeakrsCliCargoArgs(), {
      cwd: SPEAKRS_CLI_DIR,
      stdio: 'inherit',
      env: process.env,
    });
  } catch (error) {
    throw new Error(`speakrs-cli cargo build failed: ${error.message}`);
  }

  const sourceBinary = resolveSpeakrsCliCargoOutputPath(process.platform, process.env, {
    cwd: SPEAKRS_CLI_DIR,
  });
  if (!fs.existsSync(sourceBinary)) {
    throw new Error(`Built speakrs-cli not found at ${sourceBinary}`);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const destBinary = path.join(BIN_DIR, getSpeakrsCliBinaryName());
  fs.copyFileSync(sourceBinary, destBinary);

  if (!IS_WINDOWS) {
    execSync(`chmod +x "${destBinary}"`, { stdio: 'inherit' });
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
  }

  if (IS_MAC) {
    console.log('  Signing speakrs-cli with inherit entitlements...');
    const inheritEntitlements = path.join(__dirname, 'entitlements.mac.inherit.plist');
    try {
      execSync(`codesign --force --options runtime --entitlements "${inheritEntitlements}" --sign - "${destBinary}"`, {
        stdio: 'inherit',
      });
      console.log('  → speakrs-cli signed with inherit entitlements');
    } catch (signError) {
      console.log('  → Signing failed (may still work if electron-builder signs it):', signError.message);
    }
  }

  assertStagedSpeakrsCli();
  console.log(`  ✓ Built and copied to ${destBinary}`);
  console.log('✓ speakrs-cli ready!\n');
  return destBinary;
}

// Check if resources already exist
function checkExistingResources() {
  const pythonExe = IS_WINDOWS ? 'python.exe' : 'python3';
  const ffmpegExe = IS_WINDOWS ? 'ffmpeg.exe' : 'ffmpeg';

  const pythonPath = IS_WINDOWS
    ? path.join(PYTHON_DIR, pythonExe)
    : path.join(PYTHON_DIR, 'bin', pythonExe);

  const pythonExists = fs.existsSync(pythonPath);
  const ffmpegExists = fs.existsSync(path.join(FFMPEG_DIR, ffmpegExe));

  // Check for Swift helper binary (macOS only)
  const swiftHelperExists = IS_MAC
    ? fs.existsSync(path.join(BIN_DIR, SWIFT_HELPER_BINARY))
    : true; // Not needed on Windows

  return { pythonExists, ffmpegExists, swiftHelperExists };
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
  ensureLinuxEmptyBinDirectory();

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
      const wheelhousePath = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-macos-wheels-'));
      const wheelhouseCommands = buildMacOSPythonWheelhouseCommands(requirementsPath, wheelhousePath);
      try {
        execFileSync(pythonExe, wheelhouseCommands.download, { stdio: 'inherit' });
        execFileSync(pythonExe, wheelhouseCommands.install, { stdio: 'inherit' });
      } finally {
        fs.rmSync(wheelhousePath, { recursive: true, force: true });
      }

      // Clean up bloated transitive dependencies to reduce bundle size.
      // scipy stays bundled (lightning-whisper-mlx imports scipy.signal at runtime).
      // torch and its transitive-only packages are installed for reproducible pip resolution
      // then removed because MLX inference never imports torch_whisper.py.
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
      assertMacOSPythonRuntimeImports(pythonExe);

      console.log('✓ Python setup complete!\n');
    } else if (IS_LINUX) {
      console.log('[1/4] Downloading standalone Python for Linux (x86_64)...');
      const pythonTar = path.join(BUILD_DIR, 'python-linux.tar.gz');
      await downloadFile(getBuildDownload('pythonLinux'), pythonTar);

      console.log('[2/4] Extracting Python...');
      const tempDir = path.join(BUILD_DIR, 'python-temp');
      extractTarGz(pythonTar, tempDir);

      const extractedPythonDir = path.join(tempDir, 'python');
      if (fs.existsSync(extractedPythonDir)) {
        if (fs.existsSync(PYTHON_DIR)) {
          fs.rmSync(PYTHON_DIR, { recursive: true, force: true });
        }
        fs.renameSync(extractedPythonDir, PYTHON_DIR);
      }

      fs.unlinkSync(pythonTar);
      fs.rmSync(tempDir, { recursive: true, force: true });

      console.log('[3/4] Setting up pip...');
      const pythonExe = path.join(PYTHON_DIR, 'bin', 'python3');
      execSync(`chmod +x "${pythonExe}"`, { stdio: 'inherit' });
      await ensurePipInstalled(pythonExe, path.join(PYTHON_DIR, 'lib', 'python3.11', 'site-packages'));

      console.log('[4/4] Installing Python dependencies...');
      const requirementsPath = fs.existsSync(REQUIREMENTS_LINUX_BUILD)
        ? REQUIREMENTS_LINUX_BUILD
        : path.join(__dirname, '..', 'requirements-linux.txt');
      execSync(`"${pythonExe}" -m pip install --only-binary=:all: -r "${requirementsPath}"`, {
        stdio: 'inherit'
      });

      console.log('✓ Python setup complete!\n');
    } else if (IS_WINDOWS) {
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
    } else {
      throw new Error(`Unsupported prepare-resources Python platform: ${process.platform}`);
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
      const ffmpegDownload = getBuildDownload('ffmpegMac');
      console.log('[1/2] Downloading ffmpeg for macOS (arm64)...');
      const ffmpegStagingPath = path.join(BUILD_DIR, ffmpegDownload.archiveFileName || 'ffmpeg-osx-arm64');
      await downloadFile(ffmpegDownload, ffmpegStagingPath);

      console.log('[2/2] Staging ffmpeg...');
      if (!fs.existsSync(FFMPEG_DIR)) {
        fs.mkdirSync(FFMPEG_DIR, { recursive: true });
      }

      const ffmpegPath = path.join(FFMPEG_DIR, 'ffmpeg');
      fs.copyFileSync(ffmpegStagingPath, ffmpegPath);
      fs.chmodSync(ffmpegPath, 0o755);
      fs.unlinkSync(ffmpegStagingPath);
      assertMacOSFfmpegBinaryArchitecture(ffmpegPath);

      console.log('✓ ffmpeg setup complete!\n');
    } else if (IS_LINUX) {
      const ffmpegDownload = getBuildDownload('ffmpegLinux');
      console.log('[1/2] Downloading ffmpeg for Linux (x64)...');
      const ffmpegStagingPath = path.join(BUILD_DIR, ffmpegDownload.archiveFileName || 'ffmpeg-linux-x64');
      await downloadFile(ffmpegDownload, ffmpegStagingPath);

      console.log('[2/2] Staging ffmpeg...');
      if (!fs.existsSync(FFMPEG_DIR)) {
        fs.mkdirSync(FFMPEG_DIR, { recursive: true });
      }

      const ffmpegPath = path.join(FFMPEG_DIR, 'ffmpeg');
      fs.copyFileSync(ffmpegStagingPath, ffmpegPath);
      fs.chmodSync(ffmpegPath, 0o755);
      fs.unlinkSync(ffmpegStagingPath);

      console.log('✓ ffmpeg setup complete!\n');
    } else if (IS_WINDOWS) {
      // Windows: Download ffmpeg
      console.log('[1/2] Downloading ffmpeg...');
      const ffmpegZip = path.join(BUILD_DIR, 'ffmpeg.zip');
      await downloadFile(getBuildDownload('ffmpegWin'), ffmpegZip);

      console.log('[2/2] Extracting ffmpeg...');
      const tempDir = path.join(BUILD_DIR, 'ffmpeg-temp');
      extractZip(ffmpegZip, tempDir);

      // Find the bin directory (ffmpeg extracts to a versioned folder)
      const extractedDirs = fs.readdirSync(tempDir);
      const ffmpegExtractRoot = path.join(tempDir, extractedDirs[0]);
      const ffmpegBinDir = path.join(ffmpegExtractRoot, 'bin');

      // Copy binaries to ffmpeg dir
      if (!fs.existsSync(FFMPEG_DIR)) {
        fs.mkdirSync(FFMPEG_DIR, { recursive: true });
      }

      fs.copyFileSync(
        path.join(ffmpegBinDir, 'ffmpeg.exe'),
        path.join(FFMPEG_DIR, 'ffmpeg.exe')
      );

      fs.mkdirSync(LEGAL_DIR, { recursive: true });
      const upstreamLicense = copyWindowsFfmpegUpstreamLicense(ffmpegExtractRoot);
      if (upstreamLicense) {
        console.log(`  → Copied upstream ffmpeg license file (${upstreamLicense})\n`);
      }

      // Cleanup
      fs.unlinkSync(ffmpegZip);
      fs.rmSync(tempDir, { recursive: true, force: true });

      console.log('✓ ffmpeg setup complete!\n');
    } else {
      throw new Error(`Unsupported prepare-resources ffmpeg platform: ${process.platform}`);
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

  if (isSpeakrsPackagingSupported()) {
    try {
      buildSpeakrsCli();
    } catch (error) {
      console.error('ERROR: speakrs-cli build failed:', error.message);
      throw error;
    }

    stageSpeakrsValidateWav();
    assertStagedSpeakrsCli();
    assertStagedSpeakrsValidateWav();
    if (IS_MAC) {
      verifyMacOSSpeakrsCliSignature();
    }
  } else {
    throw new Error(`Speakrs packaging is not supported on ${process.platform}`);
  }

  assertNoWindowsOnlyStaleHelper();
  ensureWindowsEmptyBinDirectory();
  ensureLinuxEmptyBinDirectory();

  // Whisper models are downloaded on first use into the user cache
  // (~/.cache/huggingface/hub or MLX cache). They are not bundled in the installer.
  console.log('ℹ️ Whisper models download on first use (not bundled)\n');

  stageLegalBundle();
  writeFfmpegBinaryInfo();
  console.log('✓ Legal notices staged for installer bundling\n');

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
  MACHO_CPU_TYPE_ARM64,
  WINDOWS_PE_MACHINE_AMD64,
  assertSpeakrsCliArchitecture,
  assertStagedSpeakrsCli,
  assertStagedSpeakrsValidateWav,
  buildDirectoryManifest,
  buildResourceManifest,
  buildSpeakrsCli,
  buildSpeakrsCliCargoArgs,
  buildMacOSSpeakrsCliVerificationCommands,
  ensureWindowsEmbeddedPythonPathConfig,
  getMacOSPythonRuntimeRemovablePackages,
  buildMacOSHelperVerificationCommands,
  buildMacOSPythonWheelhouseCommands,
  macOSHelperEntitlementsIncludeInherit,
  getSpeakrsCargoFeatures,
  getSpeakrsCargoTargetTriple,
  getSpeakrsResourceManifestTarget,
  isSpeakrsPackagingSupported,
  getSpeakrsCliBinaryName,
  getStaleResourceDirectories,
  ensureWindowsEmptyBinDirectory,
  listFilesRecursively,
  loadSpeakrsOrtCompilePins,
  manifestsMatch,
  prepareResources,
  pruneMacOSPythonRuntimeDevelopmentFiles,
  downloadFile,
  readElfMachine,
  readMachOCpuType,
  readWindowsPeMachine,
  isLinuxX64ElfExecutableFileOutput,
  resolveCargoExecutable,
  resolveCargoTargetDir,
  resolveSpeakrsCliCargoOutputPath,
  stageLegalBundle,
  stageFfmpegSourceArchive,
  stageSpeakrsValidateWav,
  writeFfmpegBinaryInfo,
  writeFfmpegComplianceManifest,
  verifyMacOSHelperSignature,
  verifyMacOSSpeakrsCliSignature,
  SPEAKRS_VALIDATE_WAV_NAME,
  SPEAKRS_VALIDATE_WAV_SOURCE,
};
