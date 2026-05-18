const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const AdmZip = require('adm-zip');

function validateZipEntries(zip, destinationDir) {
  const resolvedDestination = path.resolve(destinationDir);
  fs.mkdirSync(resolvedDestination, { recursive: true });

  for (const entry of zip.getEntries()) {
    const entryName = String(entry.entryName || '').replace(/\\/g, '/');
    if (!entryName || path.isAbsolute(entryName)) {
      throw new Error('Archive contains an unsafe absolute path.');
    }

    const resolvedEntryPath = path.resolve(resolvedDestination, entryName);
    if (resolvedEntryPath !== resolvedDestination && !resolvedEntryPath.startsWith(`${resolvedDestination}${path.sep}`)) {
      throw new Error('Archive contains an unsafe path traversal entry.');
    }
  }
}

try {
  const archivePath = workerData && workerData.archivePath;
  const destinationDir = workerData && workerData.destinationDir;
  if (!archivePath || !destinationDir) {
    throw new Error('Archive worker requires an archive path and destination directory.');
  }

  const zip = new AdmZip(archivePath);
  validateZipEntries(zip, destinationDir);
  zip.extractAllTo(path.resolve(destinationDir), true);
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
