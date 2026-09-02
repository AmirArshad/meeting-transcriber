const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parentPort, workerData } = require('worker_threads');
const { validateTarListing, resolvePreferredTarExecutable } = require('./ai-addon-archive-helpers');

let activeTar = null;
let canceled = false;

function throwIfCanceled() {
  if (canceled) {
    const error = new Error('AI add-on setup was canceled.');
    error.name = 'AbortError';
    error.code = 'AI_ADDON_SETUP_CANCELLED';
    throw error;
  }
}

function flattenSelectedArchiveFiles(destinationDir, includeFileNames) {
  if (!Array.isArray(includeFileNames) || includeFileNames.length === 0) {
    return;
  }
  const wanted = new Set();
  for (const fileName of includeFileNames) {
    const normalized = String(fileName || '');
    if (!normalized || normalized !== path.basename(normalized) || normalized.includes('/') || normalized.includes('\\')) {
      throw new Error('Archive flatten received an unsafe selected filename.');
    }
    wanted.add(normalized);
  }
  const resolvedRoot = path.resolve(destinationDir);
  const selected = new Map();
  const queue = [resolvedRoot];
  while (queue.length) {
    throwIfCanceled();
    const currentDir = queue.shift();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      throwIfCanceled();
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else if (wanted.has(entry.name)) {
        if (selected.has(entry.name)) {
          throw new Error(`Archive contains duplicate selected filename: ${entry.name}`);
        }
        selected.set(entry.name, entryPath);
      }
    }
  }
  for (const name of wanted) {
    if (!selected.has(name)) {
      throw new Error(`Archive did not provide required file: ${name}`);
    }
  }
  for (const [name, sourcePath] of selected) {
    throwIfCanceled();
    const destinationPath = path.join(resolvedRoot, name);
    if (path.resolve(sourcePath) !== destinationPath) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
  for (const entry of fs.readdirSync(resolvedRoot)) {
    throwIfCanceled();
    if (!wanted.has(entry)) {
      fs.rmSync(path.join(resolvedRoot, entry), { recursive: true, force: true });
    }
  }
}

parentPort.on('message', (message) => {
  if (message?.type !== 'cancel') {
    return;
  }
  canceled = true;
  try {
    activeTar?.kill();
  } catch (_error) {
    // Parent will terminate the worker after this cancellation grace period.
  }
});

function runTarCommand(args) {
  return new Promise((resolve, reject) => {
    const tar = spawn(resolvePreferredTarExecutable(), args, { windowsHide: true });
    activeTar = tar;
    let stdout = '';
    let errorOutput = '';
    tar.stdout.on('data', (data) => { stdout += data.toString(); });
    tar.stderr.on('data', (data) => { errorOutput += data.toString(); });
    tar.on('error', reject);
    tar.on('close', (code) => {
      activeTar = null;
      if (canceled) {
        const error = new Error('AI add-on setup was canceled.');
        error.name = 'AbortError';
        error.code = 'AI_ADDON_SETUP_CANCELLED';
        reject(error);
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(errorOutput.trim() || `Failed to extract llama.cpp runtime archive: tar exited with code ${code}.`));
    });
  });
}

(async () => {
  try {
    const archivePath = workerData && workerData.archivePath;
    const destinationDir = workerData && workerData.destinationDir;
    if (!archivePath || !destinationDir) {
      throw new Error('Archive worker requires an archive path and destination directory.');
    }

    const resolvedDestination = path.resolve(destinationDir);
    throwIfCanceled();
    fs.mkdirSync(resolvedDestination, { recursive: true });
    const listingOutput = await runTarCommand(['-tzvf', archivePath]);
    validateTarListing(listingOutput, resolvedDestination);
    await runTarCommand(['-xzf', archivePath, '-C', resolvedDestination]);
    throwIfCanceled();
    flattenSelectedArchiveFiles(resolvedDestination, workerData && workerData.includeFileNames);
    parentPort.postMessage({ ok: true });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: error && error.message ? error.message : String(error),
        stack: error && error.stack,
      },
    });
  }
})();
