#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');

const {
  SPEAKRS_ORT_RUNTIME_ARTIFACTS,
  getSpeakrsExtractedRuntimeDllPins,
  getSpeakrsRequiredRuntimeLibraryNames,
} = require('../src/ai-addon/speakrs-pack-spec');
const {
  listReleaseChecksumArtifacts,
} = require('./verify-speakrs-packaging');

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'speakrs-pack-verify');

function fail(message) {
  throw new Error(message);
}

function hashBufferSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extractNamedFilesFromZip(archivePath, fileNames) {
  const zip = new AdmZip(archivePath);
  const wanted = new Set(fileNames);
  const found = new Map();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }
    const baseName = path.posix.basename(String(entry.entryName || '').replace(/\\/g, '/'));
    if (!wanted.has(baseName) || found.has(baseName)) {
      continue;
    }
    found.set(baseName, entry.getData());
  }
  return found;
}

function extractNamedFilesFromTarGz(archivePath, fileNames) {
  const wanted = new Set(fileNames);
  const found = new Map();
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-ort-tar-'));
  try {
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      fail(result.stderr || `tar failed extracting ${archivePath}`);
    }
    const stack = [extractDir];
    while (stack.length) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile() || !wanted.has(entry.name) || found.has(entry.name)) {
          continue;
        }
        found.set(entry.name, fs.readFileSync(fullPath));
      }
    }
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
  return found;
}

function extractNamedFiles(archivePath, fileNames) {
  if (/\.(tgz|tar\.gz)$/i.test(archivePath)) {
    return extractNamedFilesFromTarGz(archivePath, fileNames);
  }
  return extractNamedFilesFromZip(archivePath, fileNames);
}

async function verifyPlatformRuntimePins(platformKey, { verifyArtifactDownload }) {
  const artifacts = listReleaseChecksumArtifacts().filter((artifact) => (
    artifact.checksumKind === 'ort-runtime' && artifact.platform === platformKey
  ));
  const expectedArtifacts = SPEAKRS_ORT_RUNTIME_ARTIFACTS[platformKey] || [];
  if (artifacts.length !== expectedArtifacts.length) {
    fail(`${platformKey} ORT runtime pin set is incomplete.`);
  }

  const requiredNames = getSpeakrsRequiredRuntimeLibraryNames(platformKey);
  const extracted = {};
  for (const artifact of artifacts) {
    const archivePath = await verifyArtifactDownload(artifact, CACHE_DIR);
    const keepFileNames = Array.isArray(artifact.keepFileNames) ? artifact.keepFileNames : [];
    if (keepFileNames.length === 0) {
      fail(`Runtime artifact is missing keepFileNames: ${artifact.id}`);
    }
    const files = extractNamedFiles(archivePath, keepFileNames);
    for (const name of keepFileNames) {
      const data = files.get(name);
      if (!data || data.length <= 0) {
        fail(`Pinned archive ${artifact.fileName} did not contain ${name}.`);
      }
      extracted[name] = {
        artifactId: artifact.id,
        fileName: name,
        sha256: hashBufferSha256(data),
        sizeBytes: data.length,
      };
      process.stdout.write(`${name} ${extracted[name].sizeBytes} ${extracted[name].sha256}\n`);
    }
  }

  const missing = requiredNames.filter((name) => !extracted[name]);
  if (missing.length) {
    fail(`Derived ${platformKey} runtime pin set is missing: ${missing.join(', ')}`);
  }
  if (Object.keys(extracted).length !== requiredNames.length) {
    fail(`Derived ${platformKey} runtime pin set has unexpected extra files.`);
  }

  const expected = getSpeakrsExtractedRuntimeDllPins(expectedArtifacts, platformKey);
  if (!expected) {
    fail(`Catalog extracted runtime pins are incomplete for ${platformKey}.`);
  }
  for (const name of requiredNames) {
    if (extracted[name].sha256 !== expected[name].sha256 || extracted[name].sizeBytes !== expected[name].sizeBytes) {
      fail(
        `Extracted runtime pin mismatch for ${name}. `
        + `Derived ${extracted[name].sizeBytes}/${extracted[name].sha256}, `
        + `catalog ${expected[name].sizeBytes}/${expected[name].sha256}.`
      );
    }
  }
}

async function main() {
  const { verifyArtifactDownload } = require('./verify-speakrs-packaging');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  await verifyPlatformRuntimePins('win32-x64', { verifyArtifactDownload });
  await verifyPlatformRuntimePins('linux-x64', { verifyArtifactDownload });
  process.stdout.write('Extracted Speakrs runtime library pins match the catalog.\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
