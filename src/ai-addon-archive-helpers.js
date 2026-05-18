const path = require('path');

function validateZipEntryName(entryName, destinationDir) {
  const normalizedEntryName = String(entryName || '').replace(/\\/g, '/');
  if (!normalizedEntryName || path.isAbsolute(normalizedEntryName)) {
    throw new Error('Archive contains an unsafe absolute path.');
  }

  const resolvedDestination = path.resolve(destinationDir);
  const resolvedEntryPath = path.resolve(resolvedDestination, normalizedEntryName);
  if (resolvedEntryPath !== resolvedDestination && !resolvedEntryPath.startsWith(`${resolvedDestination}${path.sep}`)) {
    throw new Error('Archive contains an unsafe path traversal entry.');
  }
}

function validateZipEntries(zip, destinationDir) {
  const resolvedDestination = path.resolve(destinationDir);
  for (const entry of zip.getEntries()) {
    validateZipEntryName(entry.entryName, resolvedDestination);
  }
}

function validateTarEntryName(entryName, destinationDir) {
  const normalizedEntryName = String(entryName || '').trim().replace(/\\/g, '/');
  if (!normalizedEntryName) {
    return;
  }
  if (normalizedEntryName.startsWith('/') || path.isAbsolute(normalizedEntryName)) {
    throw new Error('Archive contains an unsafe absolute path.');
  }

  const parts = normalizedEntryName.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new Error('Archive contains an unsafe path traversal entry.');
  }

  const resolvedDestination = path.resolve(destinationDir);
  const resolvedEntryPath = path.resolve(resolvedDestination, normalizedEntryName);
  if (resolvedEntryPath !== resolvedDestination && !resolvedEntryPath.startsWith(`${resolvedDestination}${path.sep}`)) {
    throw new Error('Archive contains an unsafe path traversal entry.');
  }
}

function parseTarListingLine(line) {
  const text = String(line || '').trim();
  if (!text) {
    return null;
  }

  const mode = text.slice(0, 10);
  const type = mode[0];
  const tokens = text.split(/\s+/);
  if (tokens.length < 6) {
    throw new Error('Runtime archive contains an unparseable tar listing entry.');
  }

  const timeIndex = tokens.findIndex((token, index) => index > 0 && /^\d{1,2}:\d{2}(?::\d{2})?$/.test(token));
  const monthIndex = tokens.findIndex((token, index) => index > 0 && /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i.test(token));
  let nameStartIndex = timeIndex >= 0 ? timeIndex + 1 : -1;
  if (nameStartIndex < 0 && monthIndex >= 0 && tokens.length > monthIndex + 3) {
    nameStartIndex = monthIndex + 3;
  }
  if (nameStartIndex < 0 || nameStartIndex >= tokens.length) {
    throw new Error('Runtime archive contains an unparseable tar listing entry.');
  }
  let name = tokens.slice(nameStartIndex).join(' ');
  const linkIndex = name.indexOf(' -> ');
  const linkTarget = linkIndex >= 0 ? name.slice(linkIndex + 4) : null;
  if (linkIndex >= 0) {
    name = name.slice(0, linkIndex);
  }

  return { type, name, linkTarget };
}

function validateTarListing(listingOutput, destinationDir) {
  const entries = String(listingOutput || '').split(/\r?\n/).map(parseTarListingLine).filter(Boolean);
  if (!entries.length) {
    throw new Error('Runtime archive did not contain any extractable entries.');
  }

  for (const entry of entries) {
    validateTarEntryName(entry.name, destinationDir);
    if (!['-', 'd', 'l', 'x', 'g'].includes(entry.type)) {
      throw new Error('Archive contains an unsupported file type.');
    }
    if (entry.type === 'l') {
      if (!entry.linkTarget) {
        throw new Error('Archive contains an unsafe symlink entry.');
      }
      const linkTarget = String(entry.linkTarget).replace(/\\/g, '/');
      if (linkTarget.startsWith('/') || path.isAbsolute(linkTarget) || linkTarget.split('/').some((part) => part === '..')) {
        throw new Error('Archive contains an unsafe symlink entry.');
      }
      const linkBase = path.dirname(entry.name);
      validateTarEntryName(path.join(linkBase, linkTarget), destinationDir);
    }
  }
}

module.exports = {
  validateZipEntryName,
  validateZipEntries,
  validateTarEntryName,
  parseTarListingLine,
  validateTarListing,
};
