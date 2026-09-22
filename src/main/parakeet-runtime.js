'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIBRARY_NAME = /\.(?:dll|pyd|dylib|so)(?:\.\d+)*$/i;
const RUNTIME_METADATA = new Set(['install.json', 'device.json']);
// -S skips site import for a normal interpreter, and -P omits the process cwd.
// Neither flag wins when a ._pth file contains "import site": CPython applies
// that line while building the path and command-line options cannot override it.
// The Windows embeddable DLL is searched before the executable, so Whisper's
// shared python311._pth still starts sitecustomize. Parakeet then uses a private
// interpreter directory whose own ._pth files do not contain that line.
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
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    // Librosa uses Numba's on-disk JIT cache. Keep it beside the immutable
    // pinned runtime so inference never makes the install fail its tree check.
    NUMBA_CACHE_DIR: runtimeDir ? `${runtimeDir}-numba-cache` : '',
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

function pthLineEnablesSite(line) {
  const stripped = String(line || '').split('#')[0].trim();
  return stripped === 'import site';
}

function fileEnablesSiteImport(filePath, fsModule) {
  try {
    return fsModule.readFileSync(filePath, 'utf8').split(/\r?\n/).some(pthLineEnablesSite);
  } catch (error) {
    return false;
  }
}

function interpreterDirs(pythonExe, fsModule, pathModule) {
  if (!pythonExe || !pathModule.isAbsolute(pythonExe)) {
    return [];
  }
  const dirs = [pathModule.dirname(pythonExe)];
  try {
    if (fsModule.existsSync(pythonExe)) {
      dirs.push(pathModule.dirname(fsModule.realpathSync(pythonExe)));
    }
  } catch (error) {
    // The spawn path is enough when the binary cannot be resolved.
  }
  return [...new Set(dirs)];
}

function sharedPthEnablesSite(pythonExe, fsModule, pathModule) {
  for (const dir of interpreterDirs(pythonExe, fsModule, pathModule)) {
    let names = [];
    try {
      names = fsModule.readdirSync(dir);
    } catch (error) {
      continue;
    }
    for (const name of names) {
      if (!String(name).toLowerCase().endsWith('._pth')) {
        continue;
      }
      if (fileEnablesSiteImport(pathModule.join(dir, name), fsModule)) {
        return true;
      }
    }
  }
  return false;
}

function addExistingStdlib(entries, seen, candidate, fsModule, pathModule) {
  if (!candidate || seen.has(candidate) || !fsModule.existsSync(candidate)) {
    return;
  }
  const isZip = candidate.toLowerCase().endsWith('.zip');
  if (!isZip && !fsModule.existsSync(pathModule.join(candidate, 'encodings'))) {
    return;
  }
  seen.add(candidate);
  entries.push(candidate);
  if (!isZip) {
    const dynload = pathModule.join(candidate, 'lib-dynload');
    if (!seen.has(dynload) && fsModule.existsSync(dynload)) {
      seen.add(dynload);
      entries.push(dynload);
    }
  }
}

function stdlibCandidatesFromPyvenv(cfgPath, fsModule, pathModule) {
  let text = '';
  try {
    text = fsModule.readFileSync(cfgPath, 'utf8');
  } catch (error) {
    return [];
  }
  const homeMatch = /^home\s*=\s*(.+)$/m.exec(text);
  const versionMatch = /^version\s*=\s*(\d+\.\d+)/m.exec(text);
  if (!homeMatch) {
    return [];
  }
  const homeDir = homeMatch[1].trim();
  const version = versionMatch ? versionMatch[1] : '3.11';
  const parent = pathModule.dirname(homeDir);
  return [
    pathModule.join(homeDir, 'Lib'),
    pathModule.join(homeDir, 'lib', `python${version}`),
    pathModule.join(parent, 'lib', `python${version}`),
    pathModule.join(parent, 'Lib'),
  ];
}

function discoverStdlibEntries(realExe, spawnExe, fsModule, pathModule) {
  const entries = [];
  const seen = new Set();
  const exeDirs = new Set([
    pathModule.dirname(realExe),
    pathModule.dirname(spawnExe),
  ]);
  for (const exeDir of exeDirs) {
    const prefix = pathModule.dirname(exeDir);
    addExistingStdlib(entries, seen, pathModule.join(prefix, 'lib', 'python3.11'), fsModule, pathModule);
    addExistingStdlib(entries, seen, pathModule.join(prefix, 'Lib'), fsModule, pathModule);
    addExistingStdlib(entries, seen, pathModule.join(exeDir, 'Lib'), fsModule, pathModule);
    addExistingStdlib(entries, seen, pathModule.join(exeDir, 'python311.zip'), fsModule, pathModule);
    addExistingStdlib(entries, seen, pathModule.join(exeDir, 'python3.11.zip'), fsModule, pathModule);
    for (const cfg of [
      pathModule.join(exeDir, 'pyvenv.cfg'),
      pathModule.join(prefix, 'pyvenv.cfg'),
    ]) {
      for (const candidate of stdlibCandidatesFromPyvenv(cfg, fsModule, pathModule)) {
        addExistingStdlib(entries, seen, candidate, fsModule, pathModule);
      }
    }
  }
  return entries;
}

function isolatedPthNames(executableName, siblingNames) {
  const names = new Set(['python3.11._pth', 'python311._pth', 'python._pth']);
  const stem = String(executableName || '').toLowerCase().endsWith('.exe')
    ? executableName.slice(0, -4)
    : executableName;
  if (stem) {
    names.add(`${stem}._pth`);
  }
  for (const sibling of siblingNames) {
    const lower = String(sibling).toLowerCase();
    if (lower.endsWith('.dll') || lower.endsWith('.exe')) {
      names.add(`${sibling.slice(0, -4)}._pth`);
    }
  }
  return [...names];
}

function isNativeLoaderName(name) {
  const lower = String(name || '').toLowerCase();
  return lower.endsWith('.dll') || lower.endsWith('.so') || lower.endsWith('.dylib');
}

function linkOrCopy(source, destination, fsModule) {
  if (fsModule.existsSync(destination)) {
    return;
  }
  try {
    fsModule.linkSync(source, destination);
  } catch (error) {
    fsModule.copyFileSync(source, destination);
  }
}

function resolveParakeetPythonExecutable({
  pythonExe,
  backendPath,
  runtimeDir = '',
  cacheRoot,
  fsModule = fs,
  pathModule = path,
} = {}) {
  if (!pythonExe || !sharedPthEnablesSite(pythonExe, fsModule, pathModule)) {
    return pythonExe;
  }
  let realExe = pythonExe;
  try {
    realExe = fsModule.realpathSync(pythonExe);
  } catch (error) {
    throw fail('PARAKEET_RUNTIME_INVALID', 'Parakeet could not resolve its Python interpreter.');
  }
  const stdlibEntries = discoverStdlibEntries(realExe, pythonExe, fsModule, pathModule);
  if (stdlibEntries.length === 0) {
    throw fail(
      'PARAKEET_RUNTIME_INVALID',
      'Parakeet could not find the standard library for an isolated interpreter.',
    );
  }
  const exeDir = pathModule.dirname(realExe);
  let siblingNames = [];
  try {
    siblingNames = fsModule.readdirSync(exeDir);
  } catch (error) {
    siblingNames = [];
  }
  const launchName = pathModule.basename(realExe);
  const pthBody = [...stdlibEntries, backendPath, runtimeDir]
    .filter((entry) => entry && !pthLineEnablesSite(entry))
    .join('\n')
    .concat('\n');
  let exeStamp = { size: 0, mtimeMs: 0 };
  try {
    const stat = fsModule.statSync(realExe);
    exeStamp = { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    exeStamp = { size: 0, mtimeMs: 0 };
  }
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    realExe,
    launchName,
    exeStamp,
    pthBody,
  })).digest('hex').slice(0, 24);
  const root = cacheRoot || pathModule.join(os.tmpdir(), 'avanevis-parakeet-python');
  const home = pathModule.join(root, fingerprint);
  fsModule.mkdirSync(home, { recursive: true });
  linkOrCopy(realExe, pathModule.join(home, launchName), fsModule);
  for (const name of siblingNames) {
    if (!isNativeLoaderName(name)) {
      continue;
    }
    const source = pathModule.join(exeDir, name);
    try {
      if (!fsModule.statSync(source).isFile()) {
        continue;
      }
    } catch (error) {
      continue;
    }
    linkOrCopy(source, pathModule.join(home, name), fsModule);
  }
  for (const name of isolatedPthNames(launchName, siblingNames)) {
    const pthFile = pathModule.join(home, name);
    let current = null;
    try {
      current = fsModule.readFileSync(pthFile, 'utf8');
    } catch (error) {
      current = null;
    }
    if (current !== pthBody) {
      fsModule.writeFileSync(pthFile, pthBody);
    }
  }
  return pathModule.join(home, launchName);
}

function parakeetInterpreterCacheRoot(userDataDir, pathModule = path) {
  if (!userDataDir) {
    return null;
  }
  return pathModule.join(userDataDir, 'ai-addons', 'runtimes', 'parakeet-python');
}

function resolveEmbeddedPythonPth(pythonExe, fsModule = fs, pathModule = path) {
  if (!pythonExe || !pathModule.isAbsolute(pythonExe)) {
    return null;
  }
  const dir = pathModule.dirname(pythonExe);
  const base = pathModule.basename(pythonExe);
  const stem = base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base;
  const names = ['python311._pth'];
  if (stem && stem !== 'python311') {
    names.push(`${stem}._pth`);
  }
  for (const name of names) {
    const candidate = pathModule.join(dir, name);
    if (!fsModule.existsSync(candidate) || fileEnablesSiteImport(candidate, fsModule)) {
      continue;
    }
    return candidate;
  }
  return null;
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
  registerProcess,
} = {}) {
  return new Promise((resolve, reject) => {
    if (typeof spawnParakeetPython !== 'function') {
      reject(fail('PARAKEET_RUNTIME_INVALID', 'Parakeet requires an isolated Python launch.'));
      return;
    }
    let child;
    try {
      child = spawnParakeetPython(args, { runtimeDir, cwd });
      if (typeof registerProcess === 'function') registerProcess(child);
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
  parakeetInterpreterCacheRoot,
  resolveEmbeddedPythonPth,
  resolveParakeetPythonExecutable,
  terminateLateRuntimeChild,
  verifyRuntimeHashes,
  verifyRuntimeTree,
  windowsPthLines,
};
