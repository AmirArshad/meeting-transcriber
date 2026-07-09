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

function runArchiveExtractionInWorker(workerFileName, workerData, label = 'Runtime archive') {
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (worker) {
        worker.terminate().catch(() => {});
      }
      callback(value);
    };
    try {
      worker = new Worker(path.join(__dirname, '..', workerFileName), { workerData });
    } catch (error) {
      finish(reject, error);
      return;
    }
    worker.once('message', (message) => {
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
    worker.once('error', (error) => finish(reject, error));
    worker.once('exit', (code) => {
      if (settled) {
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

function extractZipArchiveInWorker(archivePath, destinationDir) {
  return runArchiveExtractionInWorker(
    'ai-addon-zip-extractor-worker.js',
    { archivePath, destinationDir },
    'Runtime zip archive',
  );
}

function extractTarGzArchiveInWorker(archivePath, destinationDir) {
  return runArchiveExtractionInWorker(
    'ai-addon-tar-extractor-worker.js',
    { archivePath, destinationDir },
    'Runtime tar.gz archive',
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

async function extractRuntimeArchive(archivePath, destinationDir, archiveFormat) {
  if (archiveFormat === 'zip') {
    if (typeof archivePath === 'string') {
      await extractZipArchiveInWorker(archivePath, destinationDir);
      return;
    }
    extractZipArchive(archivePath, destinationDir);
    return;
  }
  if (archiveFormat === 'tar.gz') {
    if (typeof archivePath === 'string') {
      await extractTarGzArchiveInWorker(archivePath, destinationDir);
      return;
    }
    fs.mkdirSync(destinationDir, { recursive: true });
    await extractTarGzArchive(archivePath, destinationDir);
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
  validateTarListing,
  // Private helpers used by setup flows
  finalizeInstalledRuntimeExecutable,
};
