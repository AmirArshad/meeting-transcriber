const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');
const AdmZip = require('adm-zip');
const { validateZipEntries } = require('./ai-addon-archive-helpers');

try {
  const archivePath = workerData && workerData.archivePath;
  const destinationDir = workerData && workerData.destinationDir;
  if (!archivePath || !destinationDir) {
    throw new Error('Archive worker requires an archive path and destination directory.');
  }

  const zip = new AdmZip(archivePath);
  const resolvedDestination = path.resolve(destinationDir);
  fs.mkdirSync(resolvedDestination, { recursive: true });
  validateZipEntries(zip, resolvedDestination);
  const includeFileNames = Array.isArray(workerData && workerData.includeFileNames)
    ? workerData.includeFileNames
    : null;
  if (includeFileNames) {
    const wanted = new Set();
    for (const fileName of includeFileNames) {
      const normalized = String(fileName || '');
      if (!normalized || normalized !== path.basename(normalized) || normalized.includes('/') || normalized.includes('\\')) {
        throw new Error('Archive worker received an unsafe selected filename.');
      }
      wanted.add(normalized);
    }
    const selected = new Map();
    for (const entry of zip.getEntries()) {
      const normalizedEntryName = String(entry.entryName || '').replace(/\\/g, '/');
      const fileName = path.posix.basename(normalizedEntryName);
      if (!entry.isDirectory && wanted.has(fileName)) {
        if (selected.has(fileName)) {
          throw new Error(`Archive contains duplicate selected filename: ${fileName}`);
        }
        selected.set(fileName, entry);
      }
    }
    for (const [fileName, entry] of selected) {
      const destinationPath = path.resolve(resolvedDestination, fileName);
      if (!destinationPath.startsWith(`${resolvedDestination}${path.sep}`)) {
        throw new Error('Archive selected filename escapes the destination directory.');
      }
      fs.writeFileSync(destinationPath, entry.getData());
    }
  } else {
    zip.extractAllTo(resolvedDestination, true);
  }
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
