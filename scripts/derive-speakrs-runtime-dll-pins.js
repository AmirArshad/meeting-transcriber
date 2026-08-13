#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const {
  SPEAKRS_CUDA_RUNTIME_DLL_NAMES,
  SPEAKRS_ORT_DLL_NAMES,
  SPEAKRS_ORT_RUNTIME_ARTIFACTS,
  getSpeakrsExtractedRuntimeDllPins,
} = require('../src/ai-addon/speakrs-pack-spec');
const {
  listReleaseChecksumArtifacts,
} = require('./verify-speakrs-packaging');

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache', 'speakrs-pack-verify');
const REQUIRED_DLL_NAMES = Object.freeze([
  ...SPEAKRS_ORT_DLL_NAMES,
  ...SPEAKRS_CUDA_RUNTIME_DLL_NAMES,
]);

function fail(message) {
  throw new Error(message);
}

function hashBufferSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extractNamedFiles(archivePath, fileNames) {
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

async function main() {
  const { verifyArtifactDownload } = require('./verify-speakrs-packaging');
  const artifacts = listReleaseChecksumArtifacts().filter((artifact) => artifact.checksumKind === 'ort-runtime');
  if (artifacts.length !== SPEAKRS_ORT_RUNTIME_ARTIFACTS['win32-x64'].length) {
    fail('Windows ORT runtime pin set is incomplete.');
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });
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

  const missing = REQUIRED_DLL_NAMES.filter((name) => !extracted[name]);
  if (missing.length) {
    fail(`Derived DLL pin set is missing: ${missing.join(', ')}`);
  }
  if (Object.keys(extracted).length !== REQUIRED_DLL_NAMES.length) {
    fail('Derived DLL pin set has unexpected extra files.');
  }

  const expected = getSpeakrsExtractedRuntimeDllPins(SPEAKRS_ORT_RUNTIME_ARTIFACTS['win32-x64']);
  if (!expected) {
    fail('Catalog extracted DLL pins are incomplete.');
  }
  for (const name of REQUIRED_DLL_NAMES) {
    if (extracted[name].sha256 !== expected[name].sha256 || extracted[name].sizeBytes !== expected[name].sizeBytes) {
      fail(
        `Extracted DLL pin mismatch for ${name}. `
        + `Derived ${extracted[name].sizeBytes}/${extracted[name].sha256}, `
        + `catalog ${expected[name].sizeBytes}/${expected[name].sha256}.`
      );
    }
  }

  process.stdout.write('Extracted Speakrs runtime DLL pins match the catalog.\n');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
