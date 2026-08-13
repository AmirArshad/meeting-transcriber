const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parentPort, workerData } = require('worker_threads');
const { validateTarListing, resolvePreferredTarExecutable } = require('./ai-addon-archive-helpers');

let activeTar = null;
let canceled = false;

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
    if (canceled) {
      throw new Error('AI add-on setup was canceled.');
    }
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
