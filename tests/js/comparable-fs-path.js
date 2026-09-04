'use strict';

const fs = require('node:fs');
const path = require('node:path');

function comparableFsPath(targetPath) {
  const realpathSync = (fs.realpathSync && fs.realpathSync.native) || fs.realpathSync;
  return path.resolve(realpathSync(targetPath));
}

function comparableLinuxLibraryPath(dirs) {
  return dirs.map(comparableFsPath).join(':');
}

module.exports = {
  comparableFsPath,
  comparableLinuxLibraryPath,
};
