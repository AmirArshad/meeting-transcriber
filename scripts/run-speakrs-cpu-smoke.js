#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const {
  SPEAKRS_MODEL_PACK_ARTIFACTS,
  getSpeakrsSourceFiles,
} = require('../src/ai-addon/speakrs-pack-spec');
const smokePins = require('../native/speakrs-cli/ci-cpu-smoke-pins.json');

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'speakrs-cpu-smoke');
const CLI_NAME = process.platform === 'win32' ? 'speakrs-cli.exe' : 'speakrs-cli';
const WAV_NAME = 'speakrs-two-speaker-16k.wav';

function fail(message) {
  throw new Error(message);
}

function hashFileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function unlinkIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function downloadHttps(url, destination, { redirectDepth = 0 } = {}) {
  const maxRedirects = 5;
  const connectTimeoutMs = 30000;
  const idleTimeoutMs = 60000;

  return new Promise((resolve, reject) => {
    if (redirectDepth > maxRedirects) {
      reject(new Error(`Too many redirects downloading ${url}`));
      return;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const file = fs.createWriteStream(destination);
    let settled = false;
    let idleTimer = null;

    const clearIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const failDownload = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearIdleTimer();
      request.destroy();
      file.close(() => {
        unlinkIfExists(destination);
        reject(error);
      });
    };

    const armIdleTimer = () => {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        failDownload(new Error(`Download stalled after ${idleTimeoutMs}ms with no data: ${url}`));
      }, idleTimeoutMs);
    };

    const request = https.get(url, { timeout: connectTimeoutMs }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        unlinkIfExists(destination);
        settled = true;
        clearIdleTimer();
        request.destroy();
        downloadHttps(new URL(response.headers.location, url).toString(), destination, {
          redirectDepth: redirectDepth + 1,
        }).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        failDownload(new Error(`Failed to download ${url}: ${response.statusCode}`));
        return;
      }
      armIdleTimer();
      response.on('data', () => armIdleTimer());
      response.on('error', failDownload);
      response.pipe(file);
      file.on('finish', () => {
        clearIdleTimer();
        file.close(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      });
    });

    file.on('error', failDownload);
    request.on('timeout', () => {
      failDownload(new Error(`Download timed out after ${connectTimeoutMs}ms connecting to ${url}`));
    });
    request.on('error', failDownload);
  });
}

async function ensurePinnedFile(download, cacheDir) {
  const dest = path.join(cacheDir, download.fileName);
  if (!fs.existsSync(dest) || hashFileSha256(dest) !== download.sha256) {
    const tempPath = `${dest}.download`;
    unlinkIfExists(tempPath);
    process.stdout.write(`Downloading ${download.fileName}...\n`);
    await downloadHttps(download.url, tempPath);
    const actual = hashFileSha256(tempPath);
    if (actual !== download.sha256) {
      unlinkIfExists(tempPath);
      fail(`Checksum mismatch for ${download.fileName}. Expected ${download.sha256}, got ${actual}.`);
    }
    unlinkIfExists(dest);
    fs.renameSync(tempPath, dest);
  }
  return dest;
}

function extractTarGz(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(result.stderr || `tar failed extracting ${archivePath}`);
  }
}

function findFileByName(rootDir, fileName) {
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }
    }
  }
  return null;
}

function resolveCliPath(explicitPath) {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      fail(`speakrs-cli not found: ${explicitPath}`);
    }
    return explicitPath;
  }
  const triple = process.platform === 'darwin'
    ? 'aarch64-apple-darwin'
    : process.platform === 'win32'
      ? 'x86_64-pc-windows-msvc'
      : process.platform === 'linux'
        ? 'x86_64-unknown-linux-gnu'
        : null;
  const candidates = [
    path.join(REPO_ROOT, 'build', 'resources', 'bin', CLI_NAME),
  ];
  if (triple) {
    candidates.push(path.join(REPO_ROOT, 'native', 'speakrs-cli', 'target', triple, 'release', CLI_NAME));
  }
  candidates.push(path.join(REPO_ROOT, 'native', 'speakrs-cli', 'target', 'release', CLI_NAME));
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    fail('speakrs-cli is missing. Build it with cargo or npm run prepare-build first.');
  }
  return found;
}

function resolveWavPath(explicitPath) {
  if (explicitPath) {
    if (!fs.existsSync(explicitPath)) {
      fail(`Fixture WAV not found: ${explicitPath}`);
    }
    return explicitPath;
  }
  const candidate = path.join(REPO_ROOT, 'tests', 'fixtures', WAV_NAME);
  if (!fs.existsSync(candidate)) {
    fail(`Fixture WAV not found: ${candidate}`);
  }
  return candidate;
}

function getOnnxSubsetMarkerIdentity(pack) {
  return `${pack.sha256}\n${pack.fileName}\n`;
}

function getWindowsCpuOrtMarkerIdentity(pin) {
  return `${pin.sha256}\n${pin.fileName}\n${pin.dylibName}\n`;
}

function getLinuxCpuOrtMarkerIdentity(pin) {
  return `${pin.sha256}\n${pin.fileName}\n${pin.dylibName}\n`;
}

function getCpuSmokeCacheIdentity(pins = smokePins, packs = SPEAKRS_MODEL_PACK_ARTIFACTS) {
  const pack = packs[pins.onnxSubsetPlatform];
  const parts = [
    pack ? pack.sha256 : '',
    pack ? pack.fileName : '',
    pins.windowsCpuOrt ? pins.windowsCpuOrt.sha256 : '',
    pins.windowsCpuOrt ? pins.windowsCpuOrt.fileName : '',
    pins.windowsCpuOrt ? pins.windowsCpuOrt.dylibName : '',
    pins.linuxCpuOrt ? pins.linuxCpuOrt.sha256 : '',
    pins.linuxCpuOrt ? pins.linuxCpuOrt.fileName : '',
    pins.linuxCpuOrt ? pins.linuxCpuOrt.dylibName : '',
  ];
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function markerMatches(extractDir, expectedIdentity) {
  const marker = path.join(extractDir, '.complete');
  if (!fs.existsSync(marker)) {
    return false;
  }
  return fs.readFileSync(marker, 'utf8') === expectedIdentity;
}

function canReuseExtraction(extractDir, expectedIdentity, requiredFileName = null) {
  if (!markerMatches(extractDir, expectedIdentity)) {
    return false;
  }
  if (requiredFileName && !findFileByName(extractDir, requiredFileName)) {
    return false;
  }
  return true;
}

function writeExtractionMarker(extractDir, expectedIdentity) {
  fs.writeFileSync(path.join(extractDir, '.complete'), expectedIdentity);
}

async function ensureOnnxSubset() {
  const pack = SPEAKRS_MODEL_PACK_ARTIFACTS[smokePins.onnxSubsetPlatform];
  if (!pack || !pack.downloadUrl || !pack.sha256) {
    fail('Speakrs ONNX subset pack pin is incomplete.');
  }
  const archivePath = await ensurePinnedFile({
    url: pack.downloadUrl,
    sha256: pack.sha256,
    fileName: pack.fileName,
  }, CACHE_DIR);
  const extractDir = path.join(CACHE_DIR, 'onnx-subset');
  const expectedIdentity = getOnnxSubsetMarkerIdentity(pack);
  if (!canReuseExtraction(extractDir, expectedIdentity)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    extractTarGz(archivePath, extractDir);
    for (const file of getSpeakrsSourceFiles(smokePins.onnxSubsetPlatform)) {
      const extracted = path.join(extractDir, ...file.path.split('/'));
      if (!fs.existsSync(extracted)) {
        fail(`ONNX subset extract is missing ${file.path}`);
      }
    }
    writeExtractionMarker(extractDir, expectedIdentity);
  }
  return extractDir;
}

async function ensureWindowsCpuOrt() {
  if (process.platform !== 'win32') {
    return null;
  }
  const pin = smokePins.windowsCpuOrt;
  const archivePath = await ensurePinnedFile(pin, CACHE_DIR);
  const extractDir = path.join(CACHE_DIR, 'windows-cpu-ort');
  const expectedIdentity = getWindowsCpuOrtMarkerIdentity(pin);
  if (!canReuseExtraction(extractDir, expectedIdentity, pin.dylibName)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(extractDir, true);
    writeExtractionMarker(extractDir, expectedIdentity);
  }
  const extracted = findFileByName(extractDir, pin.dylibName);
  if (!extracted) {
    fail(`CPU ORT extract is missing ${pin.dylibName}`);
  }
  return extracted;
}

async function ensureLinuxCpuOrt() {
  if (process.platform !== 'linux') {
    return null;
  }
  const pin = smokePins.linuxCpuOrt;
  if (!pin || !pin.url || !pin.sha256 || !pin.dylibName) {
    fail('Linux Speakrs CPU smoke ORT pin is incomplete.');
  }
  const archivePath = await ensurePinnedFile(pin, CACHE_DIR);
  const extractDir = path.join(CACHE_DIR, 'linux-cpu-ort');
  const expectedIdentity = getLinuxCpuOrtMarkerIdentity(pin);
  if (!canReuseExtraction(extractDir, expectedIdentity, pin.dylibName)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    extractTarGz(archivePath, extractDir);
    writeExtractionMarker(extractDir, expectedIdentity);
  }
  const extracted = findFileByName(extractDir, pin.dylibName);
  if (!extracted) {
    fail(`CPU ORT extract is missing ${pin.dylibName}`);
  }
  return extracted;
}

function runCli(cliPath, wavPath, modelsDir, ortDylibPath) {
  const env = { ...process.env };
  env.SPEAKRS_MODELS_DIR = modelsDir;
  env.SPEAKRS_MODE = 'cpu';
  env.SPEAKRS_EXCLUSIVE = '1';
  delete env.SPEAKRS_NUM_SPEAKERS;
  if (ortDylibPath) {
    env.ORT_DYLIB_PATH = ortDylibPath;
    env.PATH = `${path.dirname(ortDylibPath)}${path.delimiter}${env.PATH || ''}`;
    if (process.platform !== 'win32') {
      env.LD_LIBRARY_PATH = `${path.dirname(ortDylibPath)}${path.delimiter}${env.LD_LIBRARY_PATH || ''}`;
    }
  }
  const result = spawnSync(cliPath, [wavPath], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`speakrs-cli CPU smoke failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    fail(`speakrs-cli CPU smoke expected one stdout JSON line, got: ${result.stdout}`);
  }
  const payload = JSON.parse(lines[0]);
  if (payload.success !== true || !Array.isArray(payload.segments) || payload.segments.length < 1) {
    fail(`speakrs-cli CPU smoke did not return at least one segment: ${lines[0]}`);
  }
  if (payload.device !== 'cpu') {
    fail(`speakrs-cli CPU smoke reported device ${payload.device}, expected cpu`);
  }
  const gpuNote = process.platform === 'linux'
    ? ' (non-GPU structural check)'
    : '';
  process.stdout.write(`Speakrs CPU smoke passed (${payload.segments.length} segment(s))${gpuNote}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const cliIndex = args.indexOf('--cli');
  const wavIndex = args.indexOf('--wav');
  const cliPath = resolveCliPath(cliIndex >= 0 ? args[cliIndex + 1] : null);
  const wavPath = resolveWavPath(wavIndex >= 0 ? args[wavIndex + 1] : null);
  const modelsDir = await ensureOnnxSubset();
  const ortDylibPath = process.platform === 'linux'
    ? await ensureLinuxCpuOrt()
    : await ensureWindowsCpuOrt();
  runCli(cliPath, wavPath, modelsDir, ortDylibPath);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  CACHE_DIR,
  canReuseExtraction,
  getCpuSmokeCacheIdentity,
  getLinuxCpuOrtMarkerIdentity,
  getOnnxSubsetMarkerIdentity,
  getWindowsCpuOrtMarkerIdentity,
  markerMatches,
  resolveCliPath,
  resolveWavPath,
};
