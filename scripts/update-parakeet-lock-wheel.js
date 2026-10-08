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
// The replacement must match the lock's CPython ABI and platform, and its
// dependency closure — including reverse requirements — must still resolve.
// Verify mode re-downloads pinned wheels and fails on any entry drift.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const {
  assertParakeetLockIntegrity,
  assertWheelTargetCompatible,
  canonicalLockDigest,
  parseWheelFileName: parseCatalogWheelFileName,
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
  const parsed = parseCatalogWheelFileName(fileName);
  if (!parsed) {
    throw new Error(`Not a wheel filename: ${fileName}`);
  }
  return parsed;
}

function metadataHeaderValues(text, headerName) {
  const values = [];
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
    current = { key, value: line.slice(colon + 1).replace(/^[ \t]+/, '') };
    if (key === headerName) values.push(current);
  }
  return values.map((entry) => entry.value.replace(/\s+/g, ' ').trim()).filter(Boolean);
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
  let requiresDist = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const member = entry.entryName;
    if (!member || member.startsWith('/') || member.includes('\\') || member.split('/').includes('..')) {
      throw new Error(`Unsafe wheel member path: ${member}`);
    }
    const data = entry.getData();
    files.push({ path: member, sizeBytes: data.length, sha256: sha256(data) });
    if (metadataText == null && /^[^/]+\.dist-info\/METADATA$/.test(member)) {
      metadataText = data.toString('utf8');
      requiresDist = metadataHeaderValues(metadataText, 'requires-dist');
    }
  }
  if (metadataText == null) {
    throw new Error('Wheel has no .dist-info/METADATA.');
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, license: licenseFromMetadata(metadataText), requiresDist };
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
  const { files, license, requiresDist } = inventoryWheel(buffer);
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
    requiresDist,
  };
}

function replaceWheel(lock, entry) {
  const index = lock.wheels.findIndex((wheel) => normalizePackageName(wheel.packageName) === normalizePackageName(entry.packageName));
  if (index < 0) {
    throw new Error(`Lock has no wheel for ${entry.packageName}; adding packages is a resolver change, not a patch update.`);
  }
  const stored = { ...entry };
  delete stored.requiresDist;
  const wheels = lock.wheels.slice();
  wheels[index] = { ...stored, packageName: lock.wheels[index].packageName };
  const next = { ...lock, wheels };
  next.lockDigest = canonicalLockDigest(next);
  return next;
}

function selectReleaseFile(releaseFiles, currentFileName, version, explicitFileName, target) {
  const wheels = releaseFiles.filter((file) => file.packagetype === 'bdist_wheel' && !file.yanked);
  if (explicitFileName) {
    const match = wheels.find((file) => file.filename === explicitFileName);
    if (!match) throw new Error(`Release has no wheel named ${explicitFileName}.`);
    if (!target) throw new Error('An explicit wheel file name requires the lock target.');
    assertWheelTargetCompatible(match.filename, target);
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

const NEG_INF = Object.freeze({ kind: 'neg' });
const POS_INF = Object.freeze({ kind: 'pos' });
const VERSION_MARKERS = new Set(['python_version', 'python_full_version', 'implementation_version']);
const PEP440 = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|beta|preview|pre|rc|a|b|c)[-_.]?(\d*))?(?:[-_.]?(post|rev|r)[-_.]?(\d*))?(?:[-_.]?(dev)[-_.]?(\d*))?(?:\+[0-9A-Za-z][0-9A-Za-z._-]*)?$/i;
const PRE_RANK = Object.freeze({ alpha: 0, a: 0, beta: 1, b: 1, rc: 2, c: 2, pre: 2, preview: 2 });

function cmpValue(left, right) {
  if (left === right) return 0;
  if (left === NEG_INF || right === POS_INF) return -1;
  if (left === POS_INF || right === NEG_INF) return 1;
  if (Array.isArray(left) || Array.isArray(right)) {
    const a = Array.isArray(left) ? left : [left];
    const b = Array.isArray(right) ? right : [right];
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const result = cmpValue(index < a.length ? a[index] : 0, index < b.length ? b[index] : 0);
      if (result) return result;
    }
    return 0;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const as = String(left);
  const bs = String(right);
  return as === bs ? 0 : as < bs ? -1 : 1;
}

function parsePep440(text) {
  const match = PEP440.exec(String(text || '').trim());
  if (!match) throw new Error(`Not a PEP 440 version: ${text}`);
  const preName = match[3] ? match[3].toLowerCase() : null;
  return {
    epoch: match[1] ? Number(match[1]) : 0,
    release: match[2].split('.').map((part) => Number(part)),
    pre: preName == null ? null : [PRE_RANK[preName], match[4] ? Number(match[4]) : 0],
    post: match[5] ? (match[6] ? Number(match[6]) : 0) : null,
    dev: match[7] ? (match[8] ? Number(match[8]) : 0) : null,
  };
}

function versionKeyFromParsed(parsed) {
  let pre;
  if (parsed.pre == null && parsed.post == null && parsed.dev != null) pre = NEG_INF;
  else if (parsed.pre == null) pre = POS_INF;
  else pre = parsed.pre;
  return [
    parsed.epoch,
    parsed.release,
    pre,
    parsed.post == null ? NEG_INF : parsed.post,
    parsed.dev == null ? POS_INF : parsed.dev,
  ];
}

function versionKey(text) {
  return versionKeyFromParsed(parsePep440(text));
}

function parseSpecifierClause(clause) {
  const match = /^(===|==|~=|!=|>=|<=|>|<)\s*(.+)$/.exec(String(clause || '').trim());
  if (!match) throw new Error(`Cannot parse version specifier ${clause}.`);
  return { op: match[1], version: match[2].trim() };
}

function releasePrefix(versionText) {
  return String(versionText).replace(/\.\*$/, '').split('.').map((part) => Number(part));
}

function prefixEqual(version, prefixText) {
  const prefix = releasePrefix(prefixText);
  if (!prefix.length || prefix.some((part) => !Number.isInteger(part))) return false;
  return prefix.every((part, index) => (version.release[index] || 0) === part);
}

function clauseMatches(clause, version, versionText) {
  if (clause.op === '===') return versionText.trim() === clause.version;
  if ((clause.op === '==' || clause.op === '!=') && clause.version.endsWith('.*')) {
    const matched = prefixEqual(version, clause.version);
    return clause.op === '==' ? matched : !matched;
  }
  if (clause.op === '~=') {
    const spec = parsePep440(clause.version);
    if (spec.release.length < 2) throw new Error(`Compatible release needs two components: ${clause.version}`);
    const prefix = spec.release.slice(0, -1).join('.');
    return cmpValue(versionKeyFromParsed(version), versionKey(clause.version)) >= 0
      && prefixEqual(version, `${prefix}.*`);
  }
  const compared = cmpValue(versionKeyFromParsed(version), versionKey(clause.version));
  if (clause.op === '==') return compared === 0;
  if (clause.op === '!=') return compared !== 0;
  if (clause.op === '>') return compared > 0;
  if (clause.op === '<') return compared < 0;
  if (clause.op === '>=') return compared >= 0;
  if (clause.op === '<=') return compared <= 0;
  throw new Error(`Unsupported specifier ${clause.op}.`);
}

function specifierMatches(specifier, versionText) {
  const clauses = String(specifier || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!clauses.length) return true;
  const version = parsePep440(versionText);
  const parsedClauses = clauses.map(parseSpecifierClause);
  const allowPre = parsedClauses.some((clause) => {
    if (clause.op === '===') return false;
    const spec = parsePep440(clause.version.replace(/\.\*$/, ''));
    return spec.pre != null || spec.dev != null;
  });
  if ((version.pre != null || version.dev != null) && !allowPre) return false;
  return parsedClauses.every((clause) => clauseMatches(clause, version, versionText));
}

function environmentForLock(lock) {
  const platform = lock && lock.platform;
  const arch = lock && lock.arch;
  const python = String(lock && lock.python || '');
  const full = /^\d+\.\d+$/.test(python) ? `${python}.0` : python;
  let machine = arch || '';
  if (arch === 'x64') machine = platform === 'win32' ? 'AMD64' : 'x86_64';
  return {
    python_version: python,
    python_full_version: full,
    implementation_version: full,
    os_name: platform === 'win32' ? 'nt' : 'posix',
    sys_platform: platform || '',
    platform_system: platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Darwin' : platform === 'linux' ? 'Linux' : '',
    platform_machine: machine,
    platform_python_implementation: 'CPython',
    implementation_name: 'cpython',
    extra: '',
  };
}

function tokenizeMarker(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  const tokens = [];
  const re = /\s*(===|==|~=|!=|>=|<=|>|<|not in|in|and|or|\(|\)|'(?:\\'|[^'])*'|"(?:\\"|[^"])*"|[A-Za-z0-9_]+)\s*/y;
  while (re.lastIndex < source.length) {
    const match = re.exec(source);
    if (!match) throw new Error(`Cannot parse environment marker: ${text}`);
    tokens.push(match[1]);
  }
  return tokens;
}

function unquoteMarker(token) {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1).replace(/\\(["'])/g, '$1');
  }
  return null;
}

function lookupMarker(name, environment) {
  if (!Object.prototype.hasOwnProperty.call(environment, name)) {
    throw new Error(`Unsupported environment marker ${name}.`);
  }
  return environment[name];
}

function flipMarkerOp(op) {
  if (op === '>') return '<';
  if (op === '<') return '>';
  if (op === '>=') return '<=';
  if (op === '<=') return '>=';
  return op;
}

function applyMarkerOp(variable, op, actual, expected) {
  if (VERSION_MARKERS.has(variable)) {
    if (op === '===') return actual === expected;
    return specifierMatches(`${op}${expected}`, actual);
  }
  if (op === '===' || op === '==') return actual === expected;
  if (op === '!=') return actual !== expected;
  if (op === '>') return actual > expected;
  if (op === '<') return actual < expected;
  if (op === '>=') return actual >= expected;
  if (op === '<=') return actual <= expected;
  throw new Error(`Unsupported marker operator ${op}.`);
}

function markerExpression(tokens) {
  let index = 0;
  const eat = (value) => {
    if (tokens[index] !== value) return false;
    index += 1;
    return true;
  };
  const parseOr = () => {
    let left = parseAnd();
    while (eat('or')) {
      const right = parseAnd();
      const current = left;
      left = (environment) => current(environment) || right(environment);
    }
    return left;
  };
  const parseAnd = () => {
    let left = parseAtom();
    while (eat('and')) {
      const right = parseAtom();
      const current = left;
      left = (environment) => current(environment) && right(environment);
    }
    return left;
  };
  const parseAtom = () => {
    if (eat('(')) {
      const inner = parseOr();
      if (!eat(')')) throw new Error('Unclosed marker parenthesis.');
      return inner;
    }
    return parseComparison();
  };
  const parseComparison = () => {
    const leftToken = tokens[index];
    const op = tokens[index + 1];
    const rightToken = tokens[index + 2];
    index += 3;
    if (!leftToken || !op || !rightToken) throw new Error('Incomplete marker comparison.');
    return (environment) => {
      if (op === 'in' || op === 'not in') {
        const leftQuoted = unquoteMarker(leftToken);
        const rightQuoted = unquoteMarker(rightToken);
        const needle = leftQuoted == null ? String(lookupMarker(leftToken, environment)) : leftQuoted;
        const haystack = rightQuoted == null ? String(lookupMarker(rightToken, environment)) : rightQuoted;
        const found = haystack.includes(needle);
        return op === 'in' ? found : !found;
      }
      const leftQuoted = unquoteMarker(leftToken);
      const rightQuoted = unquoteMarker(rightToken);
      let variable;
      let expected;
      let variableOnLeft = true;
      if (leftQuoted == null && rightQuoted != null) {
        variable = leftToken;
        expected = rightQuoted;
      } else if (rightQuoted == null && leftQuoted != null) {
        variable = rightToken;
        expected = leftQuoted;
        variableOnLeft = false;
      } else {
        throw new Error(`Marker comparison must name an environment variable: ${leftToken} ${op} ${rightToken}`);
      }
      const actual = String(lookupMarker(variable, environment));
      return applyMarkerOp(variable, variableOnLeft ? op : flipMarkerOp(op), actual, expected);
    };
  };
  const expression = parseOr();
  if (index !== tokens.length) throw new Error(`Unexpected marker token ${tokens[index]}.`);
  return expression;
}

function markerApplies(marker, environment) {
  if (!marker || !String(marker).trim()) return true;
  return Boolean(markerExpression(tokenizeMarker(marker))(environment));
}

function parseRequirement(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Empty requirement.');
  const splitAt = raw.indexOf(';');
  const requirement = (splitAt === -1 ? raw : raw.slice(0, splitAt)).trim();
  const marker = splitAt === -1 ? '' : raw.slice(splitAt + 1).trim();
  const nameMatch = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?\s*(.*)$/.exec(requirement);
  if (!nameMatch) throw new Error(`Cannot parse requirement: ${raw}`);
  let specifier = nameMatch[3].trim();
  if (specifier.startsWith('(') && specifier.endsWith(')')) specifier = specifier.slice(1, -1).trim();
  if (specifier.startsWith('@')) throw new Error(`Direct reference requirements are not a lock update: ${raw}`);
  const extras = nameMatch[2] ? nameMatch[2].split(',').map((item) => item.trim()).filter(Boolean) : [];
  return { name: nameMatch[1], extras, specifier, marker, raw };
}

function assertDependencyClosure({ packages, environment, focusName }) {
  const byName = new Map(packages.map((pkg) => [normalizePackageName(pkg.name), pkg]));
  const focus = focusName ? normalizePackageName(focusName) : '';
  for (const pkg of packages) {
    const requirements = Array.isArray(pkg.requiresDist) ? pkg.requiresDist : [];
    for (const raw of requirements) {
      const requirement = parseRequirement(raw);
      if (!markerApplies(requirement.marker, environment)) continue;
      const requiredName = normalizePackageName(requirement.name);
      const owner = normalizePackageName(pkg.name);
      if (focus && owner !== focus && requiredName !== focus) continue;
      if (requirement.extras.length) {
        throw new Error(`${pkg.name} ${pkg.version} requires ${requirement.name}[${requirement.extras.join(',')}], which a single wheel update cannot prove.`);
      }
      const have = byName.get(requiredName);
      if (!have) {
        throw new Error(`${pkg.name} ${pkg.version} requires ${requirement.name}, which is not in the lock.`);
      }
      if (requirement.specifier && !specifierMatches(requirement.specifier, have.version)) {
        throw new Error(`${pkg.name} ${pkg.version} requires ${requirement.raw}, but the lock has ${have.name} ${have.version}.`);
      }
    }
  }
}

function lockTarget(lock) {
  return { python: lock.python, platform: lock.platform, arch: lock.arch };
}

async function updateLockWheel(lock, {
  packageName,
  version,
  fileName,
  license,
  fetchJson: fetchJsonImpl = fetchJson,
  fetchBuffer: fetchBufferImpl = fetchBuffer,
} = {}) {
  const current = lock.wheels.find((wheel) => normalizePackageName(wheel.packageName) === normalizePackageName(packageName));
  if (!current) throw new Error(`Lock has no wheel for ${packageName}.`);
  const target = lockTarget(lock);
  const release = await fetchJsonImpl(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/json`);
  if (Array.isArray(release.vulnerabilities) && release.vulnerabilities.length) {
    throw new Error(`${packageName} ${version} has PyPI advisories: ${release.vulnerabilities.map((item) => item.id).join(', ')}.`);
  }
  const file = selectReleaseFile(release.urls || [], current.fileName, version, fileName, target);
  assertWheelTargetCompatible(file.filename, target);
  const buffer = await fetchBufferImpl(file.url);
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
  const requiresByPackage = new Map([[normalizePackageName(entry.packageName), entry.requiresDist || []]]);
  for (const wheel of lock.wheels) {
    if (normalizePackageName(wheel.packageName) === normalizePackageName(entry.packageName)) continue;
    const sibling = await fetchJsonImpl(`https://pypi.org/pypi/${encodeURIComponent(wheel.packageName)}/${encodeURIComponent(wheel.version)}/json`);
    const listed = sibling && sibling.info ? sibling.info.requires_dist : null;
    requiresByPackage.set(normalizePackageName(wheel.packageName), Array.isArray(listed) ? listed : []);
  }
  const next = replaceWheel(lock, entry);
  assertDependencyClosure({
    packages: next.wheels.map((wheel) => ({
      name: wheel.packageName,
      version: wheel.version,
      requiresDist: requiresByPackage.get(normalizePackageName(wheel.packageName)) || [],
    })),
    environment: environmentForLock(lock),
    focusName: entry.packageName,
  });
  return {
    lock: next,
    summary: {
      from: `${current.version} ${current.sha256}`,
      to: `${entry.version} ${entry.sha256}`,
      lockDigest: next.lockDigest,
      files: entry.extractedFiles.length,
    },
  };
}

async function updateWheel({ lockName, packageName, version, fileName, license }) {
  const lock = readLock(lockName);
  const updated = await updateLockWheel(lock, { packageName, version, fileName, license });
  writeLock(lockName, updated.lock);
  return updated.summary;
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
  assertDependencyClosure,
  buildWheelEntry,
  environmentForLock,
  inventoryWheel,
  licenseFromMetadata,
  normalizePackageName,
  parseMetadataHeaders,
  parseWheelFileName,
  replaceWheel,
  selectReleaseFile,
  updateLockWheel,
};
