const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parentPort, workerData } = require('worker_threads');
const { validateTarListing, resolvePreferredTarExecutable } = require('./ai-addon-archive-helpers');

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
    fs.mkdirSync(resolvedDestination, { recursive: true });
    const listingOutput = await runTarCommand(['-tzvf', archivePath]);
    validateTarListing(listingOutput, resolvedDestination);
    await runTarCommand(['-xzf', archivePath, '-C', resolvedDestination]);
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
