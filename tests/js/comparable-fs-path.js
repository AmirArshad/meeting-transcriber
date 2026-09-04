'use strict';

const fs = require('node:fs');
const path = require('node:path');

function comparableFsPath(targetPath) {
  const realpathSync = (fs.realpathSync && fs.realpathSync.native) || fs.realpathSync;
  return path.resolve(realpathSync(targetPath));
}

function splitLinuxLibraryPath(value) {
  const text = String(value || '');
  if (!text) {
    return [];
  }
  return text.split(/[;:](?=(?:[A-Za-z]:[\\/]|\/))/).filter(Boolean);
}

function comparableLinuxLibraryPathParts(value) {
  return splitLinuxLibraryPath(value).map((part) => comparableFsPath(part));
}

function linuxLibraryPathContainsDir(value, dir) {
  return comparableLinuxLibraryPathParts(value).includes(comparableFsPath(dir));
}

function linuxLibraryPathStartsWithDir(value, dir) {
  const parts = comparableLinuxLibraryPathParts(value);
  if (parts.length === 0) {
    return false;
  }
  const prefix = comparableFsPath(dir);
  return parts[0] === prefix
    || parts[0].startsWith(`${prefix}${path.sep}`)
    || parts[0].startsWith(`${prefix}/`);
}

module.exports = {
  comparableFsPath,
  comparableLinuxLibraryPathParts,
  linuxLibraryPathContainsDir,
  linuxLibraryPathStartsWithDir,
};
