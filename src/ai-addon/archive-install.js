'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const AdmZip = require('adm-zip');

const {
  validateZipEntries,
  validateTarListing,
  resolvePreferredTarExecutable,
} = require('../ai-addon-archive-helpers');
const {
  bindFsMethod,
  findRuntimeExecutablePath,
  getSummaryRuntimeExtractDir,
} = require('./manifest-store');

function extractZipArchive(archivePath, destinationDir) {
  const zip = archivePath && typeof archivePath.getEntries === 'function'
    ? archivePath
    : new AdmZip(archivePath);
  const resolvedDestination = path.resolve(destinationDir);
  fs.mkdirSync(resolvedDestination, { recursive: true });
  validateZipEntries(zip, resolvedDestination);
  zip.extractAllTo(resolvedDestination, true);
}

function runArchiveExtractionInWorker(
  workerFileName,
  workerData,
  label = 'Runtime archive',
  cancelSignal,
  workerFactory = (workerPath, options) => new Worker(workerPath, options),
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelRequested = false;
    let worker;
    let removeAbortListener = () => {};
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      if (worker) {
        Promise.resolve(worker.terminate())
          .catch(() => {})
          .finally(() => callback(value));
        return;
      }
      callback(value);
    };
    try {
      worker = workerFactory(path.join(__dirname, '..', workerFileName), { workerData });
    } catch (error) {
      finish(reject, error);
      return;
    }
    if (cancelSignal && typeof cancelSignal.addEventListener === 'function') {
      const handleAbort = () => {
        if (settled || cancelRequested) {
          return;
        }
        cancelRequested = true;
        const error = new Error('AI add-on setup was canceled.');
        error.name = 'AbortError';
        error.code = 'AI_ADDON_SETUP_CANCELLED';
        try {
          worker.postMessage?.({ type: 'cancel' });
        } catch (_error) {
          // Worker termination below remains the final cancellation boundary.
        }
        setTimeout(() => finish(reject, error), 25);
      };
      cancelSignal.addEventListener('abort', handleAbort, { once: true });
      removeAbortListener = () => cancelSignal.removeEventListener('abort', handleAbort);
      if (cancelSignal.aborted) {
        handleAbort();
        return;
      }
    }
    worker.once('message', (message) => {
      if (cancelRequested) {
        return;
      }
      if (message && message.ok) {
        finish(resolve);
        return;
      }
      const error = new Error((message && message.error && message.error.message) || `Failed to extract ${label.toLowerCase()}.`);
      if (message && message.error && message.error.stack) {
        error.stack = message.error.stack;
      }
      finish(reject, error);
    });
    worker.once('error', (error) => {
      if (!cancelRequested) {
        finish(reject, error);
      }
    });
    worker.once('exit', (code) => {
      if (settled || cancelRequested) {
        return;
      }
      if (code !== 0) {
        finish(reject, new Error(`${label} extraction worker exited with code ${code}.`));
        return;
      }
      finish(reject, new Error(`${label} extraction worker exited without a result.`));
    });
  });
}

function extractZipArchiveInWorker(archivePath, destinationDir, options = {}) {
  return runArchiveExtractionInWorker(
    'ai-addon-zip-extractor-worker.js',
    {
      archivePath,
      destinationDir,
      includeFileNames: Array.isArray(options.includeFileNames) ? options.includeFileNames : null,
    },
    'Runtime zip archive',
    options.cancelSignal,
  );
}

function extractTarGzArchiveInWorker(archivePath, destinationDir, options = {}) {
  return runArchiveExtractionInWorker(
    'ai-addon-tar-extractor-worker.js',
    {
      archivePath,
      destinationDir,
      includeFileNames: Array.isArray(options.includeFileNames) ? options.includeFileNames : null,
    },
    'Runtime tar.gz archive',
    options.cancelSignal,
  );
}

function runTarCommand(args) {
  return new Promise((resolve, reject) => {
    const tar = spawn(resolvePreferredTarExecutable(), args, { windowsHide: true });
    let stdout = '';
    let errorOutput = '';
    tar.stdout.on('data', (data) => { stdout += data.toString(); });
    tar.stderr.on('data', (data) => { errorOutput += data.toString(); });
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(errorOutput.trim() || `Failed to inspect llama.cpp runtime archive: tar exited with code ${code}.`));
    });
  });
}

async function extractTarGzArchive(archivePath, destinationDir, tarRunner = runTarCommand) {
  const listingOutput = await tarRunner(['-tzvf', archivePath]);
  validateTarListing(listingOutput, destinationDir);
  fs.mkdirSync(path.resolve(destinationDir), { recursive: true });
  await tarRunner(['-xzf', archivePath, '-C', destinationDir]);
}

function flattenSelectedArchiveFiles(destinationDir, includeFileNames, fsModule = fs) {
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
  const existsSync = bindFsMethod(fsModule, 'existsSync');
  const readdirSync = bindFsMethod(fsModule, 'readdirSync');
  const statSync = bindFsMethod(fsModule, 'statSync');
  const copyFileSync = bindFsMethod(fsModule, 'copyFileSync');
  const rmSync = bindFsMethod(fsModule, 'rmSync');
  if (!existsSync || !readdirSync || !statSync || !copyFileSync || !rmSync || !existsSync(destinationDir)) {
    throw new Error('File system does not support flattening selected archive files.');
  }
  const selected = new Map();
  const queue = [path.resolve(destinationDir)];
  const resolvedRoot = path.resolve(destinationDir);
  while (queue.length) {
    const currentDir = queue.shift();
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      const isDirectory = typeof entry.isDirectory === 'function'
        ? entry.isDirectory()
        : statSync(entryPath).isDirectory();
      if (isDirectory) {
        queue.push(entryPath);
        continue;
      }
      if (!wanted.has(entry.name)) {
        continue;
      }
      if (selected.has(entry.name)) {
        throw new Error(`Archive contains duplicate selected filename: ${entry.name}`);
      }
      selected.set(entry.name, entryPath);
    }
  }
  for (const name of wanted) {
    if (!selected.has(name)) {
      throw new Error(`Archive did not provide required file: ${name}`);
    }
  }
  for (const [name, sourcePath] of selected) {
    const destPath = path.join(resolvedRoot, name);
    if (path.resolve(sourcePath) !== destPath) {
      copyFileSync(sourcePath, destPath);
    }
  }
  for (const entry of readdirSync(resolvedRoot)) {
    if (!wanted.has(entry)) {
      rmSync(path.join(resolvedRoot, entry), { recursive: true, force: true });
    }
  }
}

async function extractRuntimeArchive(archivePath, destinationDir, archiveFormat, options = {}) {
  if (archiveFormat === 'zip') {
    if (typeof archivePath === 'string') {
      await extractZipArchiveInWorker(archivePath, destinationDir, options);
      return;
    }
    extractZipArchive(archivePath, destinationDir);
    return;
  }
  if (archiveFormat === 'tar.gz') {
    if (typeof archivePath === 'string') {
      await extractTarGzArchiveInWorker(archivePath, destinationDir, options);
    } else {
      fs.mkdirSync(destinationDir, { recursive: true });
      await extractTarGzArchive(archivePath, destinationDir);
      if (Array.isArray(options.includeFileNames) && options.includeFileNames.length > 0) {
        flattenSelectedArchiveFiles(destinationDir, options.includeFileNames);
      }
    }
    return;
  }

  throw new Error(`Unsupported llama.cpp runtime archive format: ${archiveFormat || 'unknown'}.`);
}

function finalizeInstalledRuntimeExecutable({ userDataDir, artifact, runtimeArtifact, fsModule = fs }) {
  const executablePath = findRuntimeExecutablePath(
    getSummaryRuntimeExtractDir(userDataDir, artifact, runtimeArtifact),
    runtimeArtifact.executableName,
    fsModule,
  );
  const chmodSync = bindFsMethod(fsModule, 'chmodSync');
  if (!executablePath || !chmodSync) {
    return;
  }

  try {
    chmodSync(executablePath, 0o755);
  } catch (error) {
    // Best effort: Windows does not need POSIX execute bits.
  }
}

module.exports = {
  extractZipArchive,
  extractRuntimeArchive,
  extractTarGzArchive,
  flattenSelectedArchiveFiles,
  validateTarListing,
  // Private helpers used by setup flows
  finalizeInstalledRuntimeExecutable,
  runArchiveExtractionInWorker,
};
