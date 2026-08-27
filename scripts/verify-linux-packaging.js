#!/usr/bin/env node
'use strict';

/**
 * Verify a packaged Linux AvaNevis layout (unpacked dir, AppImage, or pacman).
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

function assertAppImageUsesStaticRuntime(appImagePath) {
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

function assertPacmanPkginfo(pkginfoText, pkg = require('../package.json')) {
  const expected = getJustifiedPacmanDepends(pkg);
  const { depends } = parsePkginfo(pkginfoText);
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

function proveAppImageRuntimeLaunchesWithoutFuse(appImagePath, { spawnSyncFn = spawnSync } = {}) {
  assertAppImageUsesStaticRuntime(appImagePath);
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
  if (result.status !== 0 && result.status !== null) {
    // Some static runtimes print help and exit 0; treat fuse errors only as fatal.
    // A missing display must not be confused with a FUSE2 failure.
    if (/fuse/i.test(output)) {
      fail(`AppImage runtime failed with a FUSE error: ${output}`);
    }
  }
  return output;
}

function main(argv = process.argv.slice(2)) {
  const distDir = path.join(REPO_ROOT, 'dist');
  const wantUnpacked = argv.includes('--unpacked') || argv.length === 0;
  const wantAppImage = argv.includes('--appimage') || argv.length === 0;
  const wantPacman = argv.includes('--pacman') || argv.length === 0;
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
    const pkginfo = readPkginfoFromPacmanArchive(pacman);
    assertPacmanPkginfo(pkginfo);
    console.log('pacman .PKGINFO depends:', parsePkginfo(pkginfo).depends.join(', '));
  }

  console.log('✓ Linux packaging verification passed');
}

module.exports = {
  FORBIDDEN_BASENAME_PATTERNS,
  FORBIDDEN_DEPEND_SUBSTRINGS,
  FORBIDDEN_PACMAN_PACKAGES,
  FUSE2_RUNTIME_MARKERS,
  assertAppImageUsesStaticRuntime,
  assertLinuxPackagedLayout,
  assertLinuxPackagedRuntimeIsolation,
  assertNotForbiddenPackagedPath,
  assertPacmanPkginfo,
  extractAppImage,
  findLinuxArtifact,
  findLinuxResourcesRoot,
  getJustifiedPacmanDepends,
  parsePkginfo,
  proveAppImageRuntimeLaunchesWithoutFuse,
  readPkginfoFromPacmanArchive,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
