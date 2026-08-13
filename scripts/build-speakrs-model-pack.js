#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  SPEAKRS_MODEL_PACK_REVISION,
  SPEAKRS_MODEL_PACK_REVISION_SHORT,
  SPEAKRS_MODELS_REPO,
  SPEAKRS_ORT_RUNTIME_ARTIFACTS,
  getSpeakrsPackFileName,
  getSpeakrsRuntimeArtifacts,
  getSpeakrsSourceFiles,
  getSpeakrsSourceTotalBytes,
  resolveContainedSpeakrsPath,
} = require('../src/ai-addon/speakrs-pack-spec');

const BINDING_REVISION = '5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f';
const MODEL_PACK_LEGAL_DIR = path.join(__dirname, '..', 'legal', 'speakrs-model-pack');
const REQUIRED_MODEL_PACK_LEGAL_FILES = Object.freeze([
  'ATTRIBUTION.md',
  'LICENSES/Apache-2.0.txt',
  'LICENSES/CC-BY-4.0.txt',
  'LICENSES/MIT-onnxruntime.txt',
  'LICENSES/MIT-pyannote.txt',
]);

function fail(message) {
  throw new Error(message);
}

function hashFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function normalizeGzipTimestamp(filePath, fsModule = fs) {
  const handle = fsModule.openSync(filePath, 'r+');
  try {
    const header = Buffer.alloc(10);
    if (fsModule.readSync(handle, header, 0, header.length, 0) !== header.length
      || header[0] !== 0x1f
      || header[1] !== 0x8b
      || header[2] !== 0x08) {
      fail('Speakrs model-pack archive is not a valid gzip stream.');
    }
    fsModule.writeSync(handle, Buffer.alloc(4), 0, 4, 4);
  } finally {
    fsModule.closeSync(handle);
  }
}

function selectPackFiles(platformKey) {
  if (platformKey !== 'win32-x64' && platformKey !== 'darwin-arm64') {
    fail(`Unsupported Speakrs pack platform: ${platformKey}`);
  }
  return getSpeakrsSourceFiles(platformKey);
}

function assertBindingPins() {
  if (SPEAKRS_MODEL_PACK_REVISION !== BINDING_REVISION) {
    fail(`Speakrs source revision ${SPEAKRS_MODEL_PACK_REVISION} differs from the binding plan ${BINDING_REVISION}.`);
  }
  if (!SPEAKRS_MODEL_PACK_REVISION.startsWith(SPEAKRS_MODEL_PACK_REVISION_SHORT)) {
    fail('Speakrs short revision does not match the full pinned revision.');
  }
}

function validateSourceTree(sourceDir, files, fsModule = fs) {
  const mismatches = [];
  for (const file of files) {
    const filePath = resolveContainedSpeakrsPath(sourceDir, file.path);
    if (!fsModule.existsSync(filePath)) {
      mismatches.push({ path: file.path, reason: 'missing' });
      continue;
    }
    const stats = fsModule.statSync(filePath);
    if (Number(stats.size) !== Number(file.sizeBytes)) {
      mismatches.push({
        path: file.path,
        reason: 'size',
        actual: stats.size,
        expected: file.sizeBytes,
      });
      continue;
    }
    const actualSha256 = hashFileSha256(filePath);
    if (actualSha256 !== file.sha256) {
      mismatches.push({
        path: file.path,
        reason: 'sha256',
        actual: actualSha256,
        expected: file.sha256,
      });
    }
  }
  return mismatches;
}

function stagePackFiles(sourceDir, stagingDir, files) {
  fs.mkdirSync(stagingDir, { recursive: true });
  for (const file of files) {
    const fromPath = resolveContainedSpeakrsPath(sourceDir, file.path);
    const toPath = resolveContainedSpeakrsPath(stagingDir, file.path);
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.copyFileSync(fromPath, toPath);
    fs.utimesSync(toPath, 0, 0);
  }
}

function stageLegalFiles(stagingDir, legalDir = MODEL_PACK_LEGAL_DIR, fsModule = fs) {
  for (const relativePath of REQUIRED_MODEL_PACK_LEGAL_FILES) {
    const fromPath = resolveContainedSpeakrsPath(legalDir, relativePath);
    const toPath = resolveContainedSpeakrsPath(stagingDir, relativePath);
    if (!fsModule.existsSync(fromPath) || Number(fsModule.statSync(fromPath).size) <= 0) {
      fail(`Speakrs model-pack legal file is missing or empty: ${relativePath}`);
    }
    fsModule.mkdirSync(path.dirname(toPath), { recursive: true });
    fsModule.copyFileSync(fromPath, toPath);
    fsModule.utimesSync(toPath, 0, 0);
  }
  return [...REQUIRED_MODEL_PACK_LEGAL_FILES];
}

function createPackArchive({ stagingDir, archivePath, files, legalFiles = REQUIRED_MODEL_PACK_LEGAL_FILES }) {
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const listed = [
    ...files.map((file) => String(file.path)),
    ...legalFiles,
  ].sort().map((relativePath) => relativePath.split('/').join(path.sep));
  const result = spawnSync('tar', ['-czf', archivePath, '-C', stagingDir, ...listed], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(result.stderr || `tar failed with code ${result.status}`);
  }
  normalizeGzipTimestamp(archivePath);
  return {
    archivePath,
    sizeBytes: fs.statSync(archivePath).size,
    sha256: hashFileSha256(archivePath),
  };
}

function parseArgs(argv) {
  const args = {
    platform: null,
    source: null,
    out: null,
    printPins: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--print-pins') {
      args.printPins = true;
    } else if (token === '--platform') {
      args.platform = argv[index + 1];
      index += 1;
    } else if (token === '--source') {
      args.source = argv[index + 1];
      index += 1;
    } else if (token === '--out') {
      args.out = argv[index + 1];
      index += 1;
    } else {
      fail(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function printPins(platformKey) {
  const files = selectPackFiles(platformKey);
  const runtimeArtifacts = getSpeakrsRuntimeArtifacts(platformKey);
  const payload = {
    repo: SPEAKRS_MODELS_REPO,
    revision: SPEAKRS_MODEL_PACK_REVISION,
    revisionShort: SPEAKRS_MODEL_PACK_REVISION_SHORT,
    platform: platformKey,
    packFileName: getSpeakrsPackFileName(platformKey),
    sourceFileCount: files.length,
    sourceBytes: getSpeakrsSourceTotalBytes(platformKey),
    files,
    runtimeArtifacts,
    legalFiles: [...REQUIRED_MODEL_PACK_LEGAL_FILES],
    ortRuntimeArtifacts: SPEAKRS_ORT_RUNTIME_ARTIFACTS[platformKey] || [],
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function main(argv = process.argv.slice(2)) {
  assertBindingPins();
  const args = parseArgs(argv);
  const platformKey = args.platform || (process.platform === 'darwin' ? 'darwin-arm64' : 'win32-x64');
  if (args.printPins) {
    printPins(platformKey);
    return 0;
  }
  if (!args.source || !args.out) {
    fail('Usage: node scripts/build-speakrs-model-pack.js --platform win32-x64|darwin-arm64 --source <snapshot-dir> --out <dir>');
  }
  const files = selectPackFiles(platformKey);
  const mismatches = validateSourceTree(args.source, files);
  if (mismatches.length) {
    fail(`Source tree failed pin validation:\n${JSON.stringify(mismatches, null, 2)}`);
  }
  const stagingDir = path.join(args.out, `.speakrs-pack-staging-${platformKey}`);
  const archivePath = path.join(args.out, getSpeakrsPackFileName(platformKey));
  fs.rmSync(stagingDir, { recursive: true, force: true });
  try {
    stagePackFiles(args.source, stagingDir, files);
    const legalFiles = stageLegalFiles(stagingDir);
    const archive = createPackArchive({ stagingDir, archivePath, files, legalFiles });
    process.stdout.write(`${JSON.stringify({
      repo: SPEAKRS_MODELS_REPO,
      revision: SPEAKRS_MODEL_PACK_REVISION,
      platform: platformKey,
      fileName: path.basename(archive.archivePath),
      sizeBytes: archive.sizeBytes,
      sha256: archive.sha256,
      sourceFileCount: files.length,
      sourceBytes: getSpeakrsSourceTotalBytes(platformKey),
      legalFiles,
    }, null, 2)}\n`);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BINDING_REVISION,
  assertBindingPins,
  createPackArchive,
  MODEL_PACK_LEGAL_DIR,
  normalizeGzipTimestamp,
  REQUIRED_MODEL_PACK_LEGAL_FILES,
  selectPackFiles,
  stageLegalFiles,
  stagePackFiles,
  validateSourceTree,
};
