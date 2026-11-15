#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  buildSpeakrsSourceArtifacts,
  resolveContainedSpeakrsPath,
} = require('../src/ai-addon/speakrs-pack-spec');

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'speakrs-cpu-smoke');
const CLI_NAME = process.platform === 'win32' ? 'speakrs-cpu-smoke.exe' : 'speakrs-cpu-smoke';
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

function getCpuSmokeCacheIdentity(files = buildSpeakrsSourceArtifacts('linux-x64')) {
  return crypto.createHash('sha256').update(JSON.stringify(files.map(({ path: relativePath, sizeBytes, sha256, downloadUrl }) => ({ path: relativePath, sizeBytes, sha256, downloadUrl })))).digest('hex');
}

function pinnedFileMatches(filePath, pin) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === pin.sizeBytes && hashFileSha256(filePath) === pin.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensurePinnedFile(pin, cacheDir, download = downloadHttps) {
  const dest = resolveContainedSpeakrsPath(cacheDir, pin.path);
  if (!pinnedFileMatches(dest, pin)) {
    const tempPath = `${dest}.download`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    unlinkIfExists(tempPath);
    process.stdout.write(`Downloading ${pin.path}...\n`);
    try {
      await download(pin.downloadUrl, tempPath);
      if (!pinnedFileMatches(tempPath, pin)) fail(`Checksum or size mismatch for ${pin.path}.`);
      unlinkIfExists(dest);
      fs.renameSync(tempPath, dest);
    } finally {
      unlinkIfExists(tempPath);
    }
  }
  return dest;
}

function resolveCliPath(explicitPath) {
  const candidate = explicitPath || path.join(REPO_ROOT, 'native', 'speakrs-cpu-smoke', 'target', 'release', CLI_NAME);
  if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) {
    fail(`CPU smoke binary not found at an absolute path: ${candidate}`);
  }
  return candidate;
}

function resolveWavPath(explicitPath) {
  const candidate = explicitPath || path.join(REPO_ROOT, 'tests', 'fixtures', WAV_NAME);
  if (!path.isAbsolute(candidate) || !fs.existsSync(candidate)) fail(`Fixture WAV not found at an absolute path: ${candidate}`);
  return candidate;
}

async function ensureModels(cacheRoot = CACHE_DIR) {
  const files = buildSpeakrsSourceArtifacts('linux-x64');
  const modelsDir = path.join(cacheRoot, getCpuSmokeCacheIdentity(files));
  for (const file of files) await ensurePinnedFile(file, modelsDir);
  return modelsDir;
}

function runCli(cliPath, wavPath, modelsDir) {
  const env = { ...process.env, SPEAKRS_MODELS_DIR: modelsDir, SPEAKRS_MODE: 'cpu', SPEAKRS_EXCLUSIVE: '1' };
  delete env.SPEAKRS_NUM_SPEAKERS;
  delete env.ORT_DYLIB_PATH;
  const result = spawnSync(cliPath, [wavPath], { encoding: 'utf8', env, windowsHide: true });
  if (result.status !== 0) fail(`CPU smoke failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) fail(`CPU smoke expected one stdout JSON line, got: ${result.stdout}`);
  const payload = JSON.parse(lines[0]);
  if (payload.success !== true || !Array.isArray(payload.segments) || payload.segments.length < 1 || payload.device !== 'cpu') {
    fail(`CPU smoke did not return CPU segments: ${lines[0]}`);
  }
  process.stdout.write(`Speakrs CPU smoke passed (${payload.segments.length} segment(s); structural check only)\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const cliIndex = args.indexOf('--cli');
  const wavIndex = args.indexOf('--wav');
  const cliPath = resolveCliPath(cliIndex >= 0 ? args[cliIndex + 1] : null);
  const wavPath = resolveWavPath(wavIndex >= 0 ? args[wavIndex + 1] : null);
  runCli(cliPath, wavPath, await ensureModels());
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}

module.exports = { CACHE_DIR, ensureModels, ensurePinnedFile, getCpuSmokeCacheIdentity, pinnedFileMatches, resolveCliPath, resolveWavPath };
