'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIBRARY_NAME = /\.(?:dll|pyd|dylib|so)(?:\.\d+)*$/i;
const RUNTIME_METADATA = new Set(['install.json', 'device.json']);
// -S skips site import, so sitecustomize and interpreter/venv site-packages
// cannot run before the child replaces sys.path. -P omits the process cwd.
// PYTHONNOUSERSITE does not do either of those.
const STARTUP_ISOLATION_FLAGS = ['-S', '-P'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function posixRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function isLibraryName(fileName) {
  return LIBRARY_NAME.test(String(fileName || ''));
}

async function hashFileSha256(filePath, fsModule = fs) {
  const readStream = fsModule.createReadStream
    ? fsModule.createReadStream(filePath)
    : fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    readStream.on('data', (chunk) => hash.update(chunk));
    readStream.on('error', reject);
    readStream.on('end', () => resolve(hash.digest('hex')));
  });
}

function walkRuntimeEntries(root, fsModule = fs) {
  if (!fsModule.existsSync(root)) {
    return [];
  }
  const entries = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const children = fsModule.readdirSync(current, { withFileTypes: true });
    for (const entry of children) {
      const fullPath = path.join(current, entry.name);
      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
        entries.push({ fullPath, kind: 'symlink' });
        continue;
      }
      if (entry.isDirectory()) {
        entries.push({ fullPath, kind: 'directory' });
        stack.push(fullPath);
        continue;
      }
      entries.push({ fullPath, kind: entry.isFile() ? 'file' : 'other' });
    }
  }
  return entries;
}

function allowedRuntimeDirectories(relativePaths) {
  const dirs = new Set(['']);
  for (const relativePath of relativePaths) {
    const parts = String(relativePath || '').split('/');
    parts.pop();
    let current = '';
    for (const part of parts) {
      if (!part) {
        continue;
      }
      current = current ? `${current}/${part}` : part;
      dirs.add(current);
    }
  }
  return dirs;
}

function expectedRuntimeFiles(lock) {
  const files = [];
  for (const wheel of lock.wheels || []) {
    for (const extracted of wheel.extractedFiles || []) {
      files.push({
        relativePath: String(extracted.path || '').replace(/\\/g, '/'),
        sha256: extracted.sha256,
        sizeBytes: extracted.sizeBytes,
      });
    }
  }
  return files;
}

function verifyRuntimeTree(runtimeDir, lock, fsModule = fs) {
  const expected = expectedRuntimeFiles(lock);
  const expectedByPath = new Map(expected.map((file) => [file.relativePath, file]));
  const allowedDirs = allowedRuntimeDirectories(expected.map((file) => file.relativePath));
  const seen = new Set();
  for (const entry of walkRuntimeEntries(runtimeDir, fsModule)) {
    const relativePath = posixRelative(runtimeDir, entry.fullPath);
    if (entry.kind === 'symlink' || entry.kind === 'other') {
      throw fail('PARAKEET_RUNTIME_INVALID', 'Parakeet runtime contains an unexpected link or special file.');
    }
    if (entry.kind === 'directory') {
      if (!allowedDirs.has(relativePath)) {
        throw fail('PARAKEET_RUNTIME_INVALID', 'Parakeet runtime contains a directory that is not in the pinned lock.');
      }
      continue;
    }
    if (RUNTIME_METADATA.has(relativePath)) {
      continue;
    }
    if (!expectedByPath.has(relativePath)) {
      throw fail('PARAKEET_RUNTIME_INVALID', 'Parakeet runtime contains a file that is not in the pinned lock.');
    }
    const stat = fsModule.lstatSync ? fsModule.lstatSync(entry.fullPath) : fsModule.statSync(entry.fullPath);
    if (stat.isSymbolicLink && stat.isSymbolicLink()) {
      throw fail('PARAKEET_RUNTIME_INVALID', 'Parakeet runtime contains an unexpected link or special file.');
    }
    const record = expectedByPath.get(relativePath);
    if (Number(record.sizeBytes) !== stat.size) {
      throw fail('PARAKEET_RUNTIME_INVALID', 'Parakeet runtime file size does not match the pinned lock.');
    }
    seen.add(relativePath);
  }
  for (const record of expected) {
    if (!seen.has(record.relativePath)) {
      throw fail('PARAKEET_RUNTIME_INVALID', 'Parakeet runtime is missing a pinned file.');
    }
  }
  return expected;
}

async function verifyRuntimeHashes(runtimeDir, lock, fsModule = fs) {
  const expected = verifyRuntimeTree(runtimeDir, lock, fsModule);
  for (const record of expected) {
    const filePath = path.join(runtimeDir, ...record.relativePath.split('/'));
    const actual = await hashFileSha256(filePath, fsModule);
    if (actual !== record.sha256) {
      throw fail('PARAKEET_RUNTIME_INVALID', 'Parakeet runtime file hash does not match the pinned lock.');
    }
  }
}

function buildParakeetChildEnv({
  backendPath,
  runtimeDir,
  platform = process.platform,
  packaged = false,
  cudaLibraryDirs = [],
  baseEnv = process.env,
} = {}) {
  const separator = platform === 'win32' ? ';' : ':';
  const pythonPath = [runtimeDir, backendPath].filter(Boolean).join(separator);
  const env = {
    ...baseEnv,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONPATH: pythonPath,
    HF_TOKEN: '',
    HUGGINGFACE_HUB_TOKEN: '',
    HUGGING_FACE_HUB_TOKEN: '',
    HF_TOKEN_PATH: os.devNull,
  };
  delete env.PYTHONHOME;
  delete env.PYTHONUSERBASE;
  if (platform === 'linux') {
    const allowed = (Array.isArray(cudaLibraryDirs) ? cudaLibraryDirs : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    if (allowed.length > 0) {
      env.LD_LIBRARY_PATH = allowed.join(':');
    } else {
      delete env.LD_LIBRARY_PATH;
    }
  }
  if (packaged) {
    env.AVANEVIS_PACKAGED = '1';
  }
  return env;
}

function resolveEmbeddedPythonPth(pythonExe, fsModule = fs, pathModule = path) {
  if (process.platform !== 'win32' || !pythonExe) {
    return null;
  }
  const candidate = pathModule.join(pathModule.dirname(pythonExe), 'python311._pth');
  return fsModule.existsSync(candidate) ? candidate : null;
}

function parakeetCudaLibraryDirs(runtimeDir, fsModule = fs) {
  if (!runtimeDir || !fsModule.existsSync(runtimeDir)) {
    return [];
  }
  const dirs = [];
  const stack = [runtimeDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let children = [];
    try {
      children = fsModule.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of children) {
      const fullPath = path.join(current, entry.name);
      if (typeof entry.isSymbolicLink === 'function' && entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !isLibraryName(entry.name)) {
        continue;
      }
      const parent = path.dirname(fullPath);
      const relative = path.relative(runtimeDir, parent);
      if (!relative || relative.startsWith('..')) {
        continue;
      }
      if (!dirs.includes(parent)) {
        dirs.push(parent);
      }
    }
  }
  return dirs;
}

function buildParakeetBootstrapArgs({
  backendPath,
  runtimeDir,
  pthFile = null,
  ambientPythonPath = '',
  commandArgs = [],
} = {}) {
  const args = ['--runtime', String(runtimeDir || ''), '--backend', String(backendPath || '')];
  if (pthFile) {
    args.push('--pth', String(pthFile));
  }
  if (ambientPythonPath) {
    args.push('--ambient-pythonpath', String(ambientPythonPath));
  }
  return args.concat(commandArgs);
}

function parseDeviceProbeStdout(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!line) {
    return { device: 'cpu', deviceAvailable: false };
  }
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed.device !== 'string' || typeof parsed.deviceAvailable !== 'boolean') {
      return { device: 'cpu', deviceAvailable: false };
    }
    return {
      device: parsed.device,
      deviceAvailable: parsed.deviceAvailable === true,
    };
  } catch (error) {
    return { device: 'cpu', deviceAvailable: false };
  }
}

function launchParakeetBootstrap({
  spawnParakeetPython,
  args,
  runtimeDir,
  cwd,
} = {}) {
  return new Promise((resolve, reject) => {
    if (typeof spawnParakeetPython !== 'function') {
      reject(fail('PARAKEET_RUNTIME_INVALID', 'Parakeet requires an isolated Python launch.'));
      return;
    }
    let child;
    try {
      child = spawnParakeetPython(args, { runtimeDir, cwd });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(fail('PARAKEET_RUNTIME_INVALID', String(stderr || '').trim() || 'Parakeet bootstrap failed.'));
        return;
      }
      resolve(stdout);
    });
  });
}

function windowsPthLines({ runtimeDir, backendDir } = {}) {
  return [
    'python311.zip',
    '.',
    String(runtimeDir || ''),
    String(backendDir || ''),
  ];
}

function terminateLateRuntimeChild(child, { timedOut = false, terminate } = {}) {
  if (!timedOut || !child) {
    return { terminated: false };
  }
  if (child.exitCode != null || child.signalCode) {
    return { terminated: false };
  }
  if (typeof terminate !== 'function') {
    throw fail('PARAKEET_RUNTIME_INVALID', 'A timed-out Parakeet child has no terminate hook.');
  }
  terminate(child);
  return { terminated: true };
}

module.exports = {
  STARTUP_ISOLATION_FLAGS,
  buildParakeetBootstrapArgs,
  buildParakeetChildEnv,
  expectedRuntimeFiles,
  hashFileSha256,
  isLibraryName,
  launchParakeetBootstrap,
  parakeetCudaLibraryDirs,
  parseDeviceProbeStdout,
  resolveEmbeddedPythonPth,
  terminateLateRuntimeChild,
  verifyRuntimeHashes,
  verifyRuntimeTree,
  windowsPthLines,
};
