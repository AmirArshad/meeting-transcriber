#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  SPEAKRS_MODEL_PACK_ARTIFACTS,
  SPEAKRS_ORT_RUNTIME_ARTIFACTS,
  assertSpeakrsLinuxRequiredDynamicLibraryClosure,
  getSpeakrsExtractedRuntimeDllPins,
} = require('../src/ai-addon/speakrs-pack-spec');
const { isAllowedDownloadUrl } = require('../src/ai-addon/download-helpers');
const {
  assertSpeakrsCliArchitecture,
} = require('../build/prepare-resources');
const {
  inspectPackagedSpeakrsLayout,
  SPEAKRS_VALIDATE_WAV_NAME,
} = require('../src/ai-addon/speakrs-cli-integrity');

const REPO_ROOT = path.join(__dirname, '..');
const WAV_NAME = SPEAKRS_VALIDATE_WAV_NAME;
const REQUIRED_MODEL_PACK_PLATFORMS = Object.freeze(['darwin-arm64', 'linux-x64', 'win32-x64']);
const REQUIRED_WINDOWS_ORT_ARTIFACT_COUNT = 3;
const REQUIRED_LINUX_ORT_ARTIFACT_COUNT = 5;
const CONNECT_TIMEOUT_MS = 30000;
const IDLE_TIMEOUT_MS = 60000;
const MAX_REDIRECTS = 5;

function fail(message) {
  throw new Error(message);
}

function hashFileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function artifactDownloadUrl(artifact) {
  return artifact.downloadUrl || artifact.url;
}

function assertPinnedDownloadArtifact(artifact, { label } = {}) {
  const name = label || artifact.id || artifact.fileName || 'artifact';
  const url = artifactDownloadUrl(artifact);
  if (!url || typeof url !== 'string') {
    fail(`Speakrs pin is missing a download URL: ${name}`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    fail(`Speakrs pin has a malformed URL for ${name}: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    fail(`Speakrs pin must use HTTPS for ${name}: ${url}`);
  }
  if (!isAllowedDownloadUrl(url)) {
    fail(`Speakrs pin uses an unallowed download host for ${name}: ${parsed.hostname}`);
  }
  if (!artifact.fileName || typeof artifact.fileName !== 'string') {
    fail(`Speakrs pin is missing a filename for ${name}`);
  }
  const urlFileName = decodeURIComponent(path.posix.basename(parsed.pathname));
  if (urlFileName !== artifact.fileName) {
    fail(`Speakrs pin filename does not match URL for ${name}: ${urlFileName} vs ${artifact.fileName}`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ''))) {
    fail(`Speakrs pin sha256 is invalid for ${name}`);
  }
  if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes <= 0) {
    fail(`Speakrs pin sizeBytes is invalid for ${name}`);
  }
}

function assertModelPackPins(artifacts = SPEAKRS_MODEL_PACK_ARTIFACTS) {
  const keys = Object.keys(artifacts).sort();
  const required = [...REQUIRED_MODEL_PACK_PLATFORMS].sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    fail(`Speakrs model-pack platforms must be exactly ${required.join(', ')}`);
  }
  for (const platform of required) {
    const artifact = artifacts[platform];
    if (!artifact) {
      fail(`Speakrs model-pack pin is missing for ${platform}`);
    }
    assertPinnedDownloadArtifact(artifact, { label: `model-pack ${platform}` });
  }
}

function assertOrtRuntimePins(artifacts = SPEAKRS_ORT_RUNTIME_ARTIFACTS) {
  const windowsOrt = artifacts['win32-x64'];
  if (!Array.isArray(windowsOrt) || windowsOrt.length !== REQUIRED_WINDOWS_ORT_ARTIFACT_COUNT) {
    fail('Windows Speakrs ORT 1.27.1 runtime pin set is incomplete.');
  }
  for (const artifact of windowsOrt) {
    assertPinnedDownloadArtifact(artifact, { label: artifact.id || artifact.fileName });
    if (!Array.isArray(artifact.keepFileNames) || artifact.keepFileNames.length === 0) {
      fail(`Speakrs runtime pin is missing keepFileNames: ${artifact.id}`);
    }
    if (!artifact.extractedFiles || typeof artifact.extractedFiles !== 'object') {
      fail(`Speakrs runtime pin is missing extractedFiles: ${artifact.id}`);
    }
    for (const name of artifact.keepFileNames) {
      const pin = artifact.extractedFiles[name];
      if (!pin || !/^[a-f0-9]{64}$/.test(String(pin.sha256 || '')) || !Number.isInteger(pin.sizeBytes) || pin.sizeBytes <= 0) {
        fail(`Speakrs runtime pin is missing extracted DLL integrity for ${name}`);
      }
    }
  }
  if (!getSpeakrsExtractedRuntimeDllPins(windowsOrt, 'win32-x64')) {
    fail('Windows Speakrs extracted DLL pin set is incomplete.');
  }

  const linuxOrt = artifacts['linux-x64'];
  if (!Array.isArray(linuxOrt) || linuxOrt.length !== REQUIRED_LINUX_ORT_ARTIFACT_COUNT) {
    fail('Linux Speakrs ORT 1.27.1 runtime pin set is incomplete.');
  }
  for (const artifact of linuxOrt) {
    assertPinnedDownloadArtifact(artifact, { label: artifact.id || artifact.fileName });
    if (artifact.architecture !== 'x64') {
      fail(`Linux Speakrs runtime pin is missing architecture x64: ${artifact.id}`);
    }
    if (artifact.cudaMajor !== 12) {
      fail(`Linux Speakrs runtime pin is missing cudaMajor 12: ${artifact.id}`);
    }
    if (!artifact.dynamicLibraryDir || typeof artifact.dynamicLibraryDir !== 'string') {
      fail(`Linux Speakrs runtime pin is missing dynamicLibraryDir: ${artifact.id}`);
    }
    if (!Array.isArray(artifact.keepFileNames) || artifact.keepFileNames.length === 0) {
      fail(`Speakrs runtime pin is missing keepFileNames: ${artifact.id}`);
    }
    if (!artifact.extractedFiles || typeof artifact.extractedFiles !== 'object') {
      fail(`Speakrs runtime pin is missing extractedFiles: ${artifact.id}`);
    }
    for (const name of artifact.keepFileNames) {
      const pin = artifact.extractedFiles[name];
      if (!pin || !/^[a-f0-9]{64}$/.test(String(pin.sha256 || '')) || !Number.isInteger(pin.sizeBytes) || pin.sizeBytes <= 0) {
        fail(`Speakrs runtime pin is missing extracted library integrity for ${name}`);
      }
    }
  }
  if (!getSpeakrsExtractedRuntimeDllPins(linuxOrt, 'linux-x64')) {
    fail('Linux Speakrs extracted library pin set is incomplete.');
  }
  try {
    assertSpeakrsLinuxRequiredDynamicLibraryClosure({ runtimeArtifacts: linuxOrt });
  } catch (error) {
    fail(error.message);
  }
}

function assertCatalogPinsComplete(
  modelPacks = SPEAKRS_MODEL_PACK_ARTIFACTS,
  ortArtifacts = SPEAKRS_ORT_RUNTIME_ARTIFACTS,
) {
  assertModelPackPins(modelPacks);
  assertOrtRuntimePins(ortArtifacts);
}

function listReleaseChecksumArtifacts(
  modelPacks = SPEAKRS_MODEL_PACK_ARTIFACTS,
  ortArtifacts = SPEAKRS_ORT_RUNTIME_ARTIFACTS,
) {
  assertCatalogPinsComplete(modelPacks, ortArtifacts);
  const artifacts = [];
  for (const platform of REQUIRED_MODEL_PACK_PLATFORMS) {
    artifacts.push({
      ...modelPacks[platform],
      checksumKind: 'model-pack',
      platform,
    });
  }
  for (const artifact of ortArtifacts['win32-x64']) {
    artifacts.push({
      ...artifact,
      checksumKind: 'ort-runtime',
      platform: 'win32-x64',
    });
  }
  for (const artifact of ortArtifacts['linux-x64'] || []) {
    artifacts.push({
      ...artifact,
      checksumKind: 'ort-runtime',
      platform: 'linux-x64',
    });
  }
  return artifacts;
}

function unlinkIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

function downloadHttps(url, destination, { redirectDepth = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirectDepth > MAX_REDIRECTS) {
      reject(new Error(`Too many redirects downloading ${url}`));
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(new Error(`Malformed download URL: ${url}`));
      return;
    }
    if (parsed.protocol !== 'https:') {
      reject(new Error(`Refusing non-HTTPS download: ${url}`));
      return;
    }
    if (!isAllowedDownloadUrl(url)) {
      reject(new Error(`Refusing download from unallowed host: ${parsed.hostname}`));
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
        failDownload(new Error(`Download stalled after ${IDLE_TIMEOUT_MS}ms with no data: ${url}`));
      }, IDLE_TIMEOUT_MS);
    };

    const request = https.get(url, { timeout: CONNECT_TIMEOUT_MS }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        file.close();
        unlinkIfExists(destination);
        const location = response.headers.location;
        if (!location) {
          failDownload(new Error(`Redirect response missing Location header for ${url}`));
          return;
        }
        let redirectUrl;
        try {
          redirectUrl = new URL(location, url).toString();
        } catch (error) {
          failDownload(new Error(`Invalid redirect Location for ${url}: ${location}`));
          return;
        }
        settled = true;
        clearIdleTimer();
        request.destroy();
        downloadHttps(redirectUrl, destination, { redirectDepth: redirectDepth + 1 })
          .then(resolve)
          .catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        failDownload(new Error(`Failed to download ${url}: ${response.statusCode}`));
        return;
      }

      armIdleTimer();
      response.on('data', () => {
        armIdleTimer();
      });
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
      failDownload(new Error(`Download timed out after ${CONNECT_TIMEOUT_MS}ms connecting to ${url}`));
    });
    request.on('error', failDownload);
  });
}

async function verifyArtifactDownload(artifact, cacheDir) {
  const dest = path.join(cacheDir, artifact.fileName);
  const tempPath = `${dest}.download`;
  unlinkIfExists(tempPath);

  if (fs.existsSync(dest)) {
    const existingHash = hashFileSha256(dest);
    const existingSize = fs.statSync(dest).size;
    if (existingHash === artifact.sha256 && existingSize === artifact.sizeBytes) {
      process.stdout.write(`Cached ${artifact.fileName} already matches pin\n`);
      return dest;
    }
  }

  process.stdout.write(`Downloading ${artifact.fileName} to verify checksum...\n`);
  try {
    await downloadHttps(artifactDownloadUrl(artifact), tempPath);
    const actual = hashFileSha256(tempPath);
    if (actual !== artifact.sha256) {
      fail(`Checksum mismatch for ${artifact.fileName}. Expected ${artifact.sha256}, got ${actual}.`);
    }
    const sizeBytes = fs.statSync(tempPath).size;
    if (sizeBytes !== artifact.sizeBytes) {
      fail(`Size mismatch for ${artifact.fileName}. Expected ${artifact.sizeBytes}, got ${sizeBytes}.`);
    }
    unlinkIfExists(dest);
    fs.renameSync(tempPath, dest);
  } catch (error) {
    unlinkIfExists(tempPath);
    throw error;
  }
  process.stdout.write(`Verified ${artifact.fileName} ${artifact.sha256}\n`);
  return dest;
}

function resolvePackagedResourcesRoot() {
  const macApp = path.join(REPO_ROOT, 'dist', 'mac-arm64', 'AvaNevis.app', 'Contents', 'Resources');
  const winUnpacked = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'resources');
  if (fs.existsSync(macApp)) {
    return macApp;
  }
  if (fs.existsSync(winUnpacked)) {
    return winUnpacked;
  }
  fail('Packaged app resources were not found under dist/.');
}

function assertPackagedSpeakrsLayout(resourcesRoot = resolvePackagedResourcesRoot()) {
  const inspection = inspectPackagedSpeakrsLayout({
    platform: process.platform,
    resourcesPath: resourcesRoot,
  });
  if (!inspection.ok && inspection.kind === 'cli') {
    if (inspection.reason === 'missing') {
      fail(`Packaged speakrs-cli is missing: ${inspection.cliPath}`);
    }
    if (inspection.reason === 'empty' || inspection.reason === 'directory' || inspection.reason === 'not-a-file') {
      fail(`Packaged speakrs-cli is empty: ${inspection.cliPath}`);
    }
    if (inspection.reason === 'non-executable') {
      fail(`Packaged speakrs-cli is not executable: ${inspection.cliPath}`);
    }
    fail(`Packaged speakrs-cli failed integrity checks (${inspection.reason}): ${inspection.cliPath}`);
  }
  if (!inspection.ok) {
    if (inspection.reason === 'missing') {
      fail(`Packaged Speakrs validation fixture WAV is missing at the canonical path: ${inspection.wavPath}`);
    }
    fail(`Packaged Speakrs validation fixture WAV is empty: ${inspection.wavPath}`);
  }

  const cliPath = inspection.cliPath;
  const cliStat = fs.statSync(cliPath);
  if (process.platform !== 'win32' && (cliStat.mode & 0o111) === 0) {
    fail(`Packaged speakrs-cli is not executable: ${cliPath}`);
  }
  assertSpeakrsCliArchitecture(cliPath);

  const canonicalWav = inspection.wavPath;

  const duplicateCopies = [
    path.join(resourcesRoot, 'backend', 'diarization', 'fixtures', WAV_NAME),
    path.join(resourcesRoot, 'tests', 'fixtures', WAV_NAME),
  ];
  for (const extra of duplicateCopies) {
    if (fs.existsSync(extra)) {
      fail(`Packaged app must not ship a duplicate Speakrs fixture at ${extra}`);
    }
  }

  if (process.platform === 'darwin') {
    const verify = spawnSync('codesign', ['--verify', '--strict', '--verbose=2', cliPath], {
      encoding: 'utf8',
    });
    if (verify.status !== 0) {
      fail(`Packaged speakrs-cli is not codesigned: ${verify.stderr || verify.stdout}`);
    }
  }
  if (process.platform === 'win32') {
    const staleHelper = path.join(resourcesRoot, 'bin', 'audiocapture-helper');
    if (fs.existsSync(staleHelper)) {
      fail('Windows package contains stale macOS audiocapture-helper');
    }
  }
  process.stdout.write(`Packaged Speakrs layout OK (${cliPath})\n`);
  return cliPath;
}

async function verifyPublishedPackChecksums() {
  const artifacts = listReleaseChecksumArtifacts();
  const cacheDir = path.join(REPO_ROOT, '.cache', 'speakrs-pack-verify');
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const artifact of artifacts) {
    await verifyArtifactDownload(artifact, cacheDir);
  }
  const derived = spawnSync(process.execPath, [path.join(__dirname, 'derive-speakrs-runtime-dll-pins.js')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  if (derived.status !== 0) {
    fail((derived.stderr || derived.stdout || 'Extracted Speakrs runtime DLL pin verification failed.').trim());
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--require-binary') || args.has('--packaged')) {
    assertPackagedSpeakrsLayout();
  }
  if (args.has('--verify-pack-checksums')) {
    await verifyPublishedPackChecksums();
  }
  if (!args.has('--require-binary') && !args.has('--packaged') && !args.has('--verify-pack-checksums')) {
    assertCatalogPinsComplete();
    process.stdout.write('Speakrs catalog pins are complete.\n');
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  REQUIRED_LINUX_ORT_ARTIFACT_COUNT,
  REQUIRED_MODEL_PACK_PLATFORMS,
  REQUIRED_WINDOWS_ORT_ARTIFACT_COUNT,
  assertCatalogPinsComplete,
  assertModelPackPins,
  assertOrtRuntimePins,
  assertPackagedSpeakrsLayout,
  assertPinnedDownloadArtifact,
  listReleaseChecksumArtifacts,
  verifyArtifactDownload,
  verifyPublishedPackChecksums,
};
