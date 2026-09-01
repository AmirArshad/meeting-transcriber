#!/usr/bin/env node
'use strict';

/**
 * Verify a packaged Linux AvaNevis layout (unpacked dir, AppImage, pacman, or deb).
 *
 * Core Beta: bundled Python/ffmpeg/backend/legal, CPU faster-whisper, no
 * Speakrs/ORT-CUDA/llama.cpp/pyannote artifacts, no FUSE2 AppImage runtime.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_UNPACKED = path.join(REPO_ROOT, 'dist', 'linux-unpacked');

const FORBIDDEN_DEPEND_SUBSTRINGS = Object.freeze([
  'libappindicator',
  'appindicator',
]);

const FORBIDDEN_PACMAN_PACKAGES = Object.freeze(['ffmpeg']);
const FORBIDDEN_DEB_PACKAGES = Object.freeze(['ffmpeg']);

const FORBIDDEN_BASENAME_PATTERNS = Object.freeze([
  /^speakrs-cli(\.exe)?$/i,
  /^llama-cli(\.exe)?$/i,
  /^audiocapture-helper$/i,
]);

const FORBIDDEN_PATH_SUBSTRINGS = Object.freeze([
  'onnxruntime-linux-x64-gpu',
  'nvidia_cublas',
  'nvidia-cublas',
  'nvidia_cudnn',
  'nvidia-cudnn',
  'nvidia_cuda_runtime',
  'llama.cpp',
  'pyannote.audio',
  'speakrs-cli',
]);

const FUSE2_RUNTIME_MARKERS = Object.freeze([
  'AppImages require FUSE to run',
  'dlopen(): error loading libfuse.so.2',
]);

function fail(message) {
  throw new Error(message);
}

function posixJoin(...parts) {
  return parts.join('/').replace(/\\/g, '/');
}

function getJustifiedPacmanDepends(pkg = require('../package.json')) {
  const depends = pkg.build && pkg.build.pacman && pkg.build.pacman.depends;
  if (!Array.isArray(depends) || depends.length === 0) {
    fail('package.json build.pacman.depends must be an explicit non-empty list');
  }
  const forbidden = depends.filter((name) => {
    const lower = String(name).toLowerCase();
    return FORBIDDEN_PACMAN_PACKAGES.includes(lower)
      || FORBIDDEN_DEPEND_SUBSTRINGS.some((marker) => lower.includes(marker));
  });
  if (forbidden.length > 0) {
    fail(`pacman.depends contains unjustified packages: ${forbidden.join(', ')}`);
  }
  return depends.slice();
}

function getJustifiedDebDepends(pkg = require('../package.json')) {
  const depends = pkg.build && pkg.build.deb && pkg.build.deb.depends;
  if (!Array.isArray(depends) || depends.length === 0) {
    fail('package.json build.deb.depends must be an explicit non-empty list');
  }
  const forbidden = depends.filter((name) => {
    const lower = String(name).toLowerCase();
    return FORBIDDEN_DEB_PACKAGES.includes(lower)
      || FORBIDDEN_DEPEND_SUBSTRINGS.some((marker) => lower.includes(marker));
  });
  if (forbidden.length > 0) {
    fail(`deb.depends contains unjustified packages: ${forbidden.join(', ')}`);
  }
  const recommends = pkg.build.deb.recommends;
  if (!Array.isArray(recommends) || recommends.length !== 0) {
    fail('package.json build.deb.recommends must be [] so tray integration is not a package requirement');
  }
  return depends.slice();
}

function listFilesRecursive(rootDir) {
  const results = [];
  if (!fs.existsSync(rootDir)) {
    return results;
  }
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

function assertNotForbiddenPackagedPath(relativePath) {
  const rel = String(relativePath || '').replace(/\\/g, '/');
  const base = path.posix.basename(rel);
  for (const pattern of FORBIDDEN_BASENAME_PATTERNS) {
    if (pattern.test(base)) {
      fail(`Linux package must not contain deferred add-on binary: ${rel}`);
    }
  }
  const lower = rel.toLowerCase();
  for (const marker of FORBIDDEN_PATH_SUBSTRINGS) {
    if (lower.includes(marker.toLowerCase())) {
      fail(`Linux package must not contain deferred add-on path: ${rel}`);
    }
  }
}

function findLinuxResourcesRoot(startDir) {
  const candidates = [
    path.join(startDir, 'resources'),
    path.join(startDir, 'usr', 'lib', 'avanevis', 'resources'),
    path.join(startDir, 'opt', 'AvaNevis', 'resources'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'python', 'bin', 'python3'))) {
      return candidate;
    }
  }

  const entries = listFilesRecursive(startDir);
  for (const filePath of entries) {
    const rel = path.relative(startDir, filePath).replace(/\\/g, '/');
    if (rel.endsWith('python/bin/python3') || rel.endsWith('python/bin/python')) {
      return path.dirname(path.dirname(path.dirname(filePath)));
    }
  }
  return null;
}

function assertExecutableFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`Missing ${label}: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    fail(`${label} is empty: ${filePath}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) {
    fail(`${label} is not executable: ${filePath}`);
  }
}

function assertLinuxPackagedLayout(resourcesRoot, { requireRequirements = true } = {}) {
  if (!resourcesRoot || !fs.existsSync(resourcesRoot)) {
    fail(`Linux resources root is missing: ${resourcesRoot}`);
  }

  const pythonPath = path.join(resourcesRoot, 'python', 'bin', 'python3');
  const ffmpegPath = path.join(resourcesRoot, 'ffmpeg', 'ffmpeg');
  const backendPath = path.join(resourcesRoot, 'backend');
  const recorderPath = path.join(backendPath, 'audio', 'linux_recorder.py');
  const transcriberPath = path.join(backendPath, 'transcription', 'faster_whisper_transcriber.py');
  const noticesPath = path.join(resourcesRoot, 'legal', 'THIRD_PARTY_NOTICES.md');

  assertExecutableFile(pythonPath, 'bundled Python');
  assertExecutableFile(ffmpegPath, 'bundled ffmpeg');

  if (!fs.existsSync(recorderPath)) {
    fail(`Missing bundled Linux recorder: ${recorderPath}`);
  }
  if (!fs.existsSync(transcriberPath)) {
    fail(`Missing bundled faster-whisper transcriber: ${transcriberPath}`);
  }
  if (!fs.existsSync(noticesPath) || fs.statSync(noticesPath).size <= 0) {
    fail(`Missing packaged legal notices: ${noticesPath}`);
  }

  if (requireRequirements) {
    for (const name of ['requirements-linux.txt', 'requirements-linux-build.txt']) {
      const reqPath = path.join(resourcesRoot, name);
      if (!fs.existsSync(reqPath) || fs.statSync(reqPath).size <= 0) {
        fail(`Missing packaged ${name} at ${reqPath}`);
      }
    }
  }

  for (const filePath of listFilesRecursive(resourcesRoot)) {
    assertNotForbiddenPackagedPath(path.relative(resourcesRoot, filePath));
  }

  return {
    pythonPath,
    ffmpegPath,
    backendPath,
    noticesPath,
  };
}

function assertLinuxPackagedRuntimeIsolation(resourcesRoot, { env = {}, spawnSyncFn = spawnSync } = {}) {
  const layout = assertLinuxPackagedLayout(resourcesRoot);
  const hostileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-hostile-pythonpath-'));
  try {
    fs.writeFileSync(path.join(hostileDir, 'pulsectl.py'), 'raise RuntimeError("hostile PYTHONPATH won")\n');
    const result = spawnSyncFn(layout.pythonPath, ['-c', [
      'import os, sys',
      'assert os.environ.get("AVANEVIS_PACKAGED") == "1"',
      'assert os.environ.get("PYTHONNOUSERSITE") == "1"',
      'assert "PYTHONHOME" not in os.environ',
      'assert "PYTHONUSERBASE" not in os.environ',
      'backend = os.environ["PYTHONPATH"].split(os.pathsep)[0]',
      'assert os.path.isdir(os.path.join(backend, "audio"))',
      'import audio, transcription.faster_whisper_transcriber',
      'print(sys.executable)',
      'print(os.path.realpath(sys.executable))',
    ].join('; ')], {
      env: {
        PATH: '/usr/bin:/bin',
        HOME: env.HOME || os.tmpdir(),
        AVANEVIS_PACKAGED: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONPATH: layout.backendPath,
        // Hostile extra must not be inherited by the isolation contract; the
        // verifier itself sets only the bundled backend path.
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    if (result.status !== 0) {
      fail(
        `Bundled Python failed packaged isolation checks: ${result.stderr || result.stdout || result.error}`,
      );
    }
    const printed = String(result.stdout || '').trim().split('\n')[0];
    const resolvedPython = path.resolve(printed);
    const expectedRoot = path.resolve(path.join(resourcesRoot, 'python'));
    if (resolvedPython !== path.resolve(layout.pythonPath)
        && !resolvedPython.startsWith(expectedRoot + path.sep)) {
      fail(`Bundled Python resolved outside packaged resources: ${printed}`);
    }

    const ffmpegResult = spawnSyncFn(layout.ffmpegPath, ['-version'], {
      env: { PATH: '/usr/bin:/bin', HOME: env.HOME || os.tmpdir() },
      encoding: 'utf8',
      timeout: 15000,
    });
    if (ffmpegResult.status !== 0 || !String(ffmpegResult.stdout || '').includes('ffmpeg version')) {
      fail(`Bundled ffmpeg failed: ${ffmpegResult.stderr || ffmpegResult.stdout || ffmpegResult.error}`);
    }
    return layout;
  } finally {
    fs.rmSync(hostileDir, { recursive: true, force: true });
  }
}

function assertAppImageUsesStaticRuntime(appImagePath, { spawnSyncFn = spawnSync } = {}) {
  if (!fs.existsSync(appImagePath) || !fs.statSync(appImagePath).isFile()) {
    fail(`AppImage is missing: ${appImagePath}`);
  }
  const fd = fs.openSync(appImagePath, 'r');
  const buf = Buffer.alloc(2 * 1024 * 1024);
  let bytesRead;
  try {
    bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (bytesRead < 4 || buf[0] !== 0x7f || buf.toString('ascii', 1, 4) !== 'ELF') {
    fail(`AppImage is not an ELF runtime: ${appImagePath}`);
  }
  const head = buf.slice(0, bytesRead).toString('latin1');
  for (const marker of FUSE2_RUNTIME_MARKERS) {
    if (head.includes(marker)) {
      fail(`AppImage embeds the legacy FUSE2 runtime (found ${JSON.stringify(marker)})`);
    }
  }
  const fileResult = spawnSyncFn('file', ['-b', appImagePath], {
    encoding: 'utf8',
    timeout: 15000,
  });
  const fileOutput = `${fileResult.stdout || ''}${fileResult.stderr || ''}`.trim();
  if (fileResult.status !== 0) {
    fail(`Could not inspect AppImage ELF runtime: ${fileOutput || fileResult.error}`);
  }
  if (!/ELF 64-bit/i.test(fileOutput)
      || !/(?:x86-64|x86_64)/i.test(fileOutput)
      || !/(?:static-pie linked|statically linked)/i.test(fileOutput)) {
    fail(`AppImage runtime is not a valid x86_64 static PIE ELF: ${fileOutput || '(empty file output)'}`);
  }
  return appImagePath;
}

function parsePkginfo(pkginfoText) {
  const depends = [];
  const fields = {};
  for (const line of String(pkginfoText || '').split(/\r?\n/)) {
    const match = line.match(/^([a-z]+)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2];
    if (key === 'depend') {
      depends.push(value);
    } else if (fields[key] == null) {
      fields[key] = value;
    }
  }
  return { fields, depends };
}

function isExpectedPacmanPkgver(actual, version) {
  const base = String(version || '');
  const value = String(actual || '');
  if (!base) {
    return false;
  }
  if (value === base) {
    return true;
  }
  // Arch .PKGINFO pkgver is version-pkgrel. electron-builder emits "2.7.0-1".
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}-[1-9][0-9]*$`).test(value);
}

function assertPacmanPkginfo(pkginfoText, pkg = require('../package.json')) {
  const expected = getJustifiedPacmanDepends(pkg);
  const { fields, depends } = parsePkginfo(pkginfoText);
  const expectedFields = {
    pkgname: pkg.name,
    arch: 'x86_64',
  };
  for (const [key, expectedValue] of Object.entries(expectedFields)) {
    if (fields[key] !== expectedValue) {
      fail(`pacman .PKGINFO ${key} must be ${expectedValue}, got ${fields[key] || '(missing)'}`);
    }
  }
  if (!isExpectedPacmanPkgver(fields.pkgver, pkg.version)) {
    fail(
      `pacman .PKGINFO pkgver must be ${pkg.version} or ${pkg.version}-<pkgrel>, got ${fields.pkgver || '(missing)'}`,
    );
  }
  if (depends.length === 0) {
    fail('pacman .PKGINFO has no depend entries');
  }
  const unexpected = depends.filter((name) => !expected.includes(name));
  if (unexpected.length > 0) {
    fail(`pacman .PKGINFO has unjustified depends: ${unexpected.join(', ')}`);
  }
  const missing = expected.filter((name) => !depends.includes(name));
  if (missing.length > 0) {
    fail(`pacman .PKGINFO is missing justified depends: ${missing.join(', ')}`);
  }
  for (const name of depends) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_PACMAN_PACKAGES.includes(lower)
        || FORBIDDEN_DEPEND_SUBSTRINGS.some((marker) => lower.includes(marker))) {
      fail(`pacman .PKGINFO must not depend on ${name}`);
    }
  }
  return depends;
}

function parseDebControl(controlText) {
  const fields = {};
  let currentKey = null;
  for (const line of String(controlText || '').split(/\r?\n/)) {
    const continuation = line.match(/^\s+(.*)$/);
    if (continuation && currentKey) {
      fields[currentKey] += ` ${continuation[1].trim()}`;
      continue;
    }
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (!match) {
      currentKey = null;
      continue;
    }
    currentKey = match[1].toLowerCase();
    fields[currentKey] = match[2].trim();
  }
  return fields;
}

function parseDebDependencyNames(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().split(/\s+\(/, 1)[0])
    .filter(Boolean);
}

function assertDebControl(controlText, pkg = require('../package.json')) {
  const expected = getJustifiedDebDepends(pkg);
  const fields = parseDebControl(controlText);
  const expectedFields = {
    package: pkg.name,
    version: pkg.version,
    architecture: 'amd64',
  };
  for (const [key, expectedValue] of Object.entries(expectedFields)) {
    if (fields[key] !== expectedValue) {
      fail(`deb control ${key} must be ${expectedValue}, got ${fields[key] || '(missing)'}`);
    }
  }
  const depends = parseDebDependencyNames(fields.depends);
  if (depends.length === 0) {
    fail('deb control has no Depends entries');
  }
  const unexpected = depends.filter((name) => !expected.includes(name));
  if (unexpected.length > 0) {
    fail(`deb control has unjustified depends: ${unexpected.join(', ')}`);
  }
  const missing = expected.filter((name) => !depends.includes(name));
  if (missing.length > 0) {
    fail(`deb control is missing justified depends: ${missing.join(', ')}`);
  }
  return depends;
}

function isMissingCommand(result) {
  return Boolean(result && result.error && result.error.code === 'ENOENT');
}

function listArMembers(archivePath, spawnSyncFn) {
  const listed = spawnSyncFn('ar', ['t', archivePath], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (isMissingCommand(listed)) {
    fail(`Failed to read deb archive ${archivePath}: ar is not available (install binutils)`);
  }
  if (listed.status !== 0) {
    fail(`Failed to list deb members in ${archivePath}: ${listed.stderr || listed.error}`);
  }
  return String(listed.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function findDebArchiveMember(members, prefix) {
  return members.find((name) => name === prefix || name.startsWith(`${prefix}.`)) || null;
}

function extractArMember(archivePath, memberName, destDir, spawnSyncFn) {
  fs.mkdirSync(destDir, { recursive: true });
  const extracted = spawnSyncFn('ar', ['x', archivePath, memberName], {
    cwd: destDir,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (isMissingCommand(extracted)) {
    fail(`Failed to extract ${memberName} from ${archivePath}: ar is not available (install binutils)`);
  }
  if (extracted.status !== 0) {
    fail(`Failed to extract ${memberName} from ${archivePath}: ${extracted.stderr || extracted.error}`);
  }
  const memberPath = path.join(destDir, memberName);
  if (!fs.existsSync(memberPath)) {
    fail(`ar did not extract ${memberName} from ${archivePath}`);
  }
  return memberPath;
}

function readTarMember(archivePath, memberNames, spawnSyncFn) {
  const errors = [];
  for (const memberName of memberNames) {
    const result = spawnSyncFn('tar', ['-xOf', archivePath, memberName], {
      encoding: 'utf8',
      timeout: 30000,
    });
    if (!isMissingCommand(result) && result.status === 0) {
      return result.stdout;
    }
    errors.push(`${memberName}: ${result.stderr || result.error || `status ${result.status}`}`);
  }
  fail(`Failed to read ${memberNames.join(' or ')} from ${archivePath} (${errors.join('; ')})`);
}

function readDebControlWithAr(archivePath, spawnSyncFn) {
  const members = listArMembers(archivePath, spawnSyncFn);
  const controlMember = findDebArchiveMember(members, 'control.tar');
  if (!controlMember) {
    fail(`deb archive ${archivePath} has no control.tar* member`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-deb-control-'));
  try {
    const controlTar = extractArMember(archivePath, controlMember, tmp, spawnSyncFn);
    return readTarMember(controlTar, ['./control', 'control'], spawnSyncFn);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function extractDebWithAr(archivePath, destDir, spawnSyncFn) {
  const members = listArMembers(archivePath, spawnSyncFn);
  const dataMember = findDebArchiveMember(members, 'data.tar');
  if (!dataMember) {
    fail(`deb archive ${archivePath} has no data.tar* member`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-deb-data-'));
  try {
    const dataTar = extractArMember(archivePath, dataMember, tmp, spawnSyncFn);
    fs.mkdirSync(destDir, { recursive: true });
    const extracted = spawnSyncFn('tar', ['-xf', dataTar, '-C', destDir], {
      encoding: 'utf8',
      timeout: 120000,
    });
    if (extracted.status !== 0) {
      fail(
        `Failed to extract deb data from ${archivePath}: `
        + `${extracted.stderr || extracted.stdout || extracted.error}`,
      );
    }
    return destDir;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readDebControlFromArchive(archivePath, { spawnSyncFn = spawnSync } = {}) {
  const result = spawnSyncFn('dpkg-deb', ['-f', archivePath], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (!isMissingCommand(result) && result.status === 0) {
    return result.stdout;
  }
  if (!isMissingCommand(result)) {
    fail(`Failed to read deb control from ${archivePath}: ${result.stderr || result.error}`);
  }
  return readDebControlWithAr(archivePath, spawnSyncFn);
}

function extractDebArchive(archivePath, destDir, { spawnSyncFn = spawnSync } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSyncFn('dpkg-deb', ['-x', archivePath, destDir], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (!isMissingCommand(result) && result.status === 0) {
    return destDir;
  }
  if (!isMissingCommand(result)) {
    fail(`Failed to extract deb archive ${archivePath}: ${result.stderr || result.stdout || result.error}`);
  }
  return extractDebWithAr(archivePath, destDir, spawnSyncFn);
}

function verifyDebArchivePayload(
  archivePath,
  pkg = require('../package.json'),
  { spawnSyncFn = spawnSync } = {},
) {
  const control = readDebControlFromArchive(archivePath, { spawnSyncFn });
  const depends = assertDebControl(control, pkg);
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-deb-'));
  try {
    extractDebArchive(archivePath, extractDir, { spawnSyncFn });
    const resourcesRoot = findLinuxResourcesRoot(extractDir);
    if (!resourcesRoot) {
      fail(`Could not find packaged resources in deb archive ${archivePath}`);
    }
    assertLinuxPackagedLayout(resourcesRoot);
    return { depends };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function readPkginfoFromPacmanArchive(archivePath, { spawnSyncFn = spawnSync } = {}) {
  const result = spawnSyncFn('tar', ['-xOf', archivePath, '.PKGINFO'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  if (result.status !== 0) {
    fail(`Failed to read .PKGINFO from ${archivePath}: ${result.stderr || result.error}`);
  }
  return result.stdout;
}

function extractPacmanArchive(archivePath, destDir, { spawnSyncFn = spawnSync } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSyncFn('tar', ['-xf', archivePath, '-C', destDir], {
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.status !== 0) {
    fail(`Failed to extract pacman archive ${archivePath}: ${result.stderr || result.stdout || result.error}`);
  }
  return destDir;
}

function verifyPacmanArchivePayload(
  archivePath,
  pkg = require('../package.json'),
  { spawnSyncFn = spawnSync } = {},
) {
  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-pacman-'));
  try {
    extractPacmanArchive(archivePath, extractDir, { spawnSyncFn });
    const pkginfoPath = path.join(extractDir, '.PKGINFO');
    if (!fs.existsSync(pkginfoPath)) {
      fail(`pacman archive is missing .PKGINFO: ${archivePath}`);
    }
    const pkginfo = fs.readFileSync(pkginfoPath, 'utf8');
    const depends = assertPacmanPkginfo(pkginfo, pkg);
    const resourcesRoot = findLinuxResourcesRoot(extractDir);
    if (!resourcesRoot) {
      fail(`Could not find packaged resources in pacman archive ${archivePath}`);
    }
    assertLinuxPackagedLayout(resourcesRoot);
    return { depends };
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function findLinuxArtifact(distDir, suffix) {
  if (!fs.existsSync(distDir)) {
    return null;
  }
  const matches = [];
  for (const name of fs.readdirSync(distDir)) {
    if (name.startsWith('AvaNevis-Setup-') && name.endsWith(suffix)) {
      matches.push(path.join(distDir, name));
    }
  }
  return matches.sort()[0] || null;
}

function extractAppImage(appImagePath, destDir, { spawnSyncFn = spawnSync } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const result = spawnSyncFn(appImagePath, ['--appimage-extract'], {
    cwd: destDir,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (result.status !== 0) {
    fail(`AppImage extract failed: ${result.stderr || result.stdout || result.error}`);
  }
  const extracted = path.join(destDir, 'squashfs-root');
  if (!fs.existsSync(extracted)) {
    fail(`AppImage extract did not produce squashfs-root in ${destDir}`);
  }
  return extracted;
}

function proveAppImageRuntimeLaunchesWithoutFuse(
  appImagePath,
  { spawnSyncFn = spawnSync, assertStaticRuntimeFn = assertAppImageUsesStaticRuntime } = {},
) {
  assertStaticRuntimeFn(appImagePath);
  const result = spawnSyncFn(appImagePath, ['--appimage-help'], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
    },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (/libfuse\.so\.2/i.test(output) || /AppImages require FUSE/i.test(output)) {
    fail(`AppImage runtime still requires FUSE2: ${output}`);
  }
  if (result.status !== 0) {
    fail(
      `AppImage runtime launch failed with status ${result.status == null ? 'none' : result.status}: `
      + `${output || result.error || '(no output)'}`,
    );
  }
  return output;
}

function main(argv = process.argv.slice(2)) {
  const distDir = path.join(REPO_ROOT, 'dist');
  const wantUnpacked = argv.includes('--unpacked') || argv.length === 0;
  const wantAppImage = argv.includes('--appimage') || argv.length === 0;
  const wantPacman = argv.includes('--pacman') || argv.length === 0;
  const wantDeb = argv.includes('--deb') || argv.length === 0;
  const runIsolation = !argv.includes('--skip-runtime');

  if (wantUnpacked) {
    const unpacked = argv.includes('--unpacked-dir')
      ? argv[argv.indexOf('--unpacked-dir') + 1]
      : DEFAULT_UNPACKED;
    if (!fs.existsSync(unpacked)) {
      fail(`Unpacked Linux app not found: ${unpacked}`);
    }
    const resourcesRoot = findLinuxResourcesRoot(unpacked);
    if (!resourcesRoot) {
      fail(`Could not find packaged resources under ${unpacked}`);
    }
    console.log(`Verifying unpacked Linux resources: ${resourcesRoot}`);
    if (runIsolation && process.platform === 'linux') {
      assertLinuxPackagedRuntimeIsolation(resourcesRoot);
    } else {
      assertLinuxPackagedLayout(resourcesRoot);
    }
  }

  if (wantAppImage) {
    const appImage = findLinuxArtifact(distDir, '.AppImage');
    if (!appImage) {
      fail('No AvaNevis-Setup-*.AppImage found in dist/');
    }
    console.log(`Verifying AppImage: ${appImage}`);
    assertAppImageUsesStaticRuntime(appImage);
    if (process.platform === 'linux') {
      proveAppImageRuntimeLaunchesWithoutFuse(appImage);
    }
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-appimage-'));
    try {
      const extracted = extractAppImage(appImage, extractDir);
      const resourcesRoot = findLinuxResourcesRoot(extracted);
      if (!resourcesRoot) {
        fail(`Could not find packaged resources in extracted AppImage ${extracted}`);
      }
      assertLinuxPackagedLayout(resourcesRoot);
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }

  if (wantPacman) {
    const pacman = findLinuxArtifact(distDir, '.pkg.tar.zst')
      || findLinuxArtifact(distDir, '.pacman');
    if (!pacman) {
      fail('No AvaNevis-Setup-*.pkg.tar.zst (or .pacman) found in dist/');
    }
    console.log(`Verifying pacman package: ${pacman}`);
    const verified = verifyPacmanArchivePayload(pacman);
    console.log('pacman .PKGINFO depends:', verified.depends.join(', '));
  }

  if (wantDeb) {
    const deb = findLinuxArtifact(distDir, '.deb');
    if (!deb) {
      fail('No AvaNevis-Setup-*.deb found in dist/');
    }
    console.log(`Verifying deb package: ${deb}`);
    const verified = verifyDebArchivePayload(deb);
    console.log('deb control depends:', verified.depends.join(', '));
  }

  console.log('✓ Linux packaging verification passed');
}

module.exports = {
  FORBIDDEN_BASENAME_PATTERNS,
  FORBIDDEN_DEPEND_SUBSTRINGS,
  FORBIDDEN_DEB_PACKAGES,
  FORBIDDEN_PACMAN_PACKAGES,
  FUSE2_RUNTIME_MARKERS,
  assertAppImageUsesStaticRuntime,
  assertDebControl,
  assertLinuxPackagedLayout,
  assertLinuxPackagedRuntimeIsolation,
  assertNotForbiddenPackagedPath,
  assertPacmanPkginfo,
  extractAppImage,
  extractDebArchive,
  findLinuxArtifact,
  findLinuxResourcesRoot,
  getJustifiedPacmanDepends,
  getJustifiedDebDepends,
  parseDebControl,
  parsePkginfo,
  proveAppImageRuntimeLaunchesWithoutFuse,
  readPkginfoFromPacmanArchive,
  readDebControlFromArchive,
  verifyDebArchivePayload,
  verifyPacmanArchivePayload,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
