'use strict';

const fs = require('node:fs');
const path = require('node:path');

function comparableFsPath(targetPath) {
  return path.resolve(fs.realpathSync(targetPath));
}

function comparableLinuxLibraryPath(dirs) {
  return dirs.map(comparableFsPath).join(':');
}

module.exports = {
  comparableFsPath,
  comparableLinuxLibraryPath,
};
