#!/usr/bin/env node
'use strict';

// Regenerates Parakeet lock wheel entries from real PyPI wheel bytes.
//
//   node scripts/update-parakeet-lock-wheel.js --lock macos-metal --package msgpack --version 1.2.3
//   node scripts/update-parakeet-lock-wheel.js --lock macos-metal --verify [--max-bytes 50000000]
//
// Update mode replaces one wheel entry (URL, size, SHA-256, license and the
// complete extracted-file inventory) and recomputes lockDigest, which moves
// existing installs to a new runtime identity that reports repair-required.
// Verify mode re-downloads pinned wheels and fails on any entry drift.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const {
  assertParakeetLockIntegrity,
  canonicalLockDigest,
} = require('../src/main/transcription-engine-catalog');

const LOCK_DIR = path.join(__dirname, '..', 'build', 'parakeet');
const LOCK_NAMES = Object.freeze(['macos-metal', 'linux-cuda', 'windows-cuda']);
const PYPI_FILE_HOST = 'https://files.pythonhosted.org/';

function normalizePackageName(name) {
  return String(name || '').trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseWheelFileName(fileName) {
  const match = /^(.+?)-([^-]+)(?:-\d[^-]*)?-([^-]+)-([^-]+)-([^-]+)\.whl$/.exec(String(fileName || ''));
  if (!match) {
    throw new Error(`Not a wheel filename: ${fileName}`);
  }
  return { distribution: match[1], version: match[2], pythonTag: match[3], abiTag: match[4], platformTag: match[5] };
}

// Mirrors email.message_from_string header semantics: continuation lines are
// kept with their newline and leading whitespace; the body is ignored.
function parseMetadataHeaders(text) {
  const headers = new Map();
  let current = null;
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (line === '') break;
    if (/^[ \t]/.test(line) && current) {
      current.value += `\n${line}`;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      current = null;
      continue;
    }
    const key = line.slice(0, colon).toLowerCase();
    current = { value: line.slice(colon + 1).replace(/^[ \t]+/, '') };
    if (!headers.has(key)) headers.set(key, current);
  }
  return new Map([...headers].map(([key, entry]) => [key, entry.value.replace(/\s+$/, '')]));
}

function licenseFromMetadata(text) {
  const headers = parseMetadataHeaders(text);
  const expression = headers.get('license-expression');
  if (expression && expression.trim()) return expression;
  const license = headers.get('license');
  if (license && license.trim() && license.trim().toUpperCase() !== 'UNKNOWN') return license;
  return '';
}

function inventoryWheel(buffer) {
  const zip = new AdmZip(buffer);
  const files = [];
  let metadataText = null;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const member = entry.entryName;
    if (!member || member.startsWith('/') || member.includes('\\') || member.split('/').includes('..')) {
      throw new Error(`Unsafe wheel member path: ${member}`);
    }
    const data = entry.getData();
    files.push({ path: member, sizeBytes: data.length, sha256: sha256(data) });
    if (/^[^/]+\.dist-info\/METADATA$/.test(member)) {
      metadataText = data.toString('utf8');
    }
  }
  if (metadataText == null) {
    throw new Error('Wheel has no .dist-info/METADATA.');
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, license: licenseFromMetadata(metadataText) };
}

function buildWheelEntry({ packageName, version, fileName, url, buffer, expectedSha256, expectedSize, fallbackLicense = '' }) {
  if (!String(url).startsWith(PYPI_FILE_HOST)) {
    throw new Error(`Wheel URL must be a direct PyPI object: ${url}`);
  }
  const actualSha256 = sha256(buffer);
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${fileName}: registry ${expectedSha256}, downloaded ${actualSha256}.`);
  }
  if (expectedSize != null && buffer.length !== expectedSize) {
    throw new Error(`Size mismatch for ${fileName}: registry ${expectedSize}, downloaded ${buffer.length}.`);
  }
  const { files, license } = inventoryWheel(buffer);
  const resolvedLicense = license || fallbackLicense;
  if (!resolvedLicense) {
    throw new Error(`No license metadata for ${fileName}; pass --license explicitly.`);
  }
  return {
    packageName,
    version,
    fileName,
    url,
    sizeBytes: buffer.length,
    sha256: actualSha256,
    license: resolvedLicense,
    extractedFiles: files,
  };
}

function replaceWheel(lock, entry) {
  const index = lock.wheels.findIndex((wheel) => normalizePackageName(wheel.packageName) === normalizePackageName(entry.packageName));
  if (index < 0) {
    throw new Error(`Lock has no wheel for ${entry.packageName}; adding packages is a resolver change, not a patch update.`);
  }
  const wheels = lock.wheels.slice();
  wheels[index] = { ...entry, packageName: lock.wheels[index].packageName };
  const next = { ...lock, wheels };
  next.lockDigest = canonicalLockDigest(next);
  return next;
}

function selectReleaseFile(releaseFiles, currentFileName, version, explicitFileName) {
  const wheels = releaseFiles.filter((file) => file.packagetype === 'bdist_wheel' && !file.yanked);
  if (explicitFileName) {
    const match = wheels.find((file) => file.filename === explicitFileName);
    if (!match) throw new Error(`Release has no wheel named ${explicitFileName}.`);
    return match;
  }
  const current = parseWheelFileName(currentFileName);
  const match = wheels.find((file) => {
    const candidate = parseWheelFileName(file.filename);
    return candidate.version === version
      && candidate.pythonTag === current.pythonTag
      && candidate.abiTag === current.abiTag
      && candidate.platformTag === current.platformTag;
  });
  if (!match) {
    const names = wheels.map((file) => file.filename).join('\n  ');
    throw new Error(`No wheel matches ${current.pythonTag}-${current.abiTag}-${current.platformTag}; pass --file-name. Candidates:\n  ${names}`);
  }
  return match;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

function lockPath(name) {
  if (!LOCK_NAMES.includes(name)) {
    throw new Error(`--lock must be one of ${LOCK_NAMES.join(', ')}.`);
  }
  return path.join(LOCK_DIR, `${name}.lock.json`);
}

function readLock(name) {
  return JSON.parse(fs.readFileSync(lockPath(name), 'utf8'));
}

function writeLock(name, lock) {
  assertParakeetLockIntegrity(lock);
  fs.writeFileSync(lockPath(name), `${JSON.stringify(lock, null, 2)}\n`);
}

async function updateWheel({ lockName, packageName, version, fileName, license }) {
  const lock = readLock(lockName);
  const current = lock.wheels.find((wheel) => normalizePackageName(wheel.packageName) === normalizePackageName(packageName));
  if (!current) throw new Error(`${lockName} has no wheel for ${packageName}.`);
  const release = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/json`);
  if (Array.isArray(release.vulnerabilities) && release.vulnerabilities.length) {
    throw new Error(`${packageName} ${version} has PyPI advisories: ${release.vulnerabilities.map((v) => v.id).join(', ')}.`);
  }
  const file = selectReleaseFile(release.urls || [], current.fileName, version, fileName);
  const buffer = await fetchBuffer(file.url);
  const entry = buildWheelEntry({
    packageName: current.packageName,
    version,
    fileName: file.filename,
    url: file.url,
    buffer,
    expectedSha256: file.digests && file.digests.sha256,
    expectedSize: file.size,
    fallbackLicense: license || '',
  });
  const next = replaceWheel(lock, entry);
  writeLock(lockName, next);
  return { from: `${current.version} ${current.sha256}`, to: `${entry.version} ${entry.sha256}`, lockDigest: next.lockDigest, files: entry.extractedFiles.length };
}

function diffEntries(expected, actual) {
  const problems = [];
  for (const key of ['fileName', 'url', 'sizeBytes', 'sha256', 'license']) {
    if (expected[key] !== actual[key]) problems.push(`${key} differs`);
  }
  const expectedFiles = JSON.stringify(expected.extractedFiles);
  if (expectedFiles !== JSON.stringify(actual.extractedFiles)) problems.push('extractedFiles differ');
  return problems;
}

async function verifyLock({ lockName, maxBytes }) {
  const lock = readLock(lockName);
  assertParakeetLockIntegrity(lock);
  const results = [];
  for (const wheel of lock.wheels) {
    if (maxBytes && wheel.sizeBytes > maxBytes) {
      results.push({ packageName: wheel.packageName, status: 'skipped', reason: `larger than ${maxBytes} bytes` });
      continue;
    }
    const buffer = await fetchBuffer(wheel.url);
    let entry;
    try {
      entry = buildWheelEntry({ ...wheel, buffer, expectedSha256: wheel.sha256, expectedSize: wheel.sizeBytes, fallbackLicense: wheel.license });
    } catch (error) {
      results.push({ packageName: wheel.packageName, status: 'failed', reason: error.message });
      continue;
    }
    const problems = diffEntries(wheel, entry);
    results.push({ packageName: wheel.packageName, status: problems.length ? 'failed' : 'ok', reason: problems.join(', ') });
  }
  return results;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') { args.verify = true; continue; }
    const key = arg.replace(/^--/, '');
    if (!arg.startsWith('--') || i + 1 >= argv.length) throw new Error(`Unexpected argument ${arg}.`);
    args[key] = argv[i += 1];
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.lock) throw new Error('--lock is required.');
  if (args.verify) {
    const results = await verifyLock({ lockName: args.lock, maxBytes: args['max-bytes'] ? Number(args['max-bytes']) : 0 });
    for (const result of results) {
      console.log(`${result.status.padEnd(7)} ${result.packageName}${result.reason ? ` (${result.reason})` : ''}`);
    }
    return results.some((result) => result.status === 'failed') ? 1 : 0;
  }
  if (!args.package || !args.version) throw new Error('--package and --version are required.');
  const summary = await updateWheel({
    lockName: args.lock,
    packageName: args.package,
    version: args.version,
    fileName: args['file-name'],
    license: args.license,
  });
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildWheelEntry,
  inventoryWheel,
  licenseFromMetadata,
  normalizePackageName,
  parseMetadataHeaders,
  parseWheelFileName,
  replaceWheel,
  selectReleaseFile,
};
