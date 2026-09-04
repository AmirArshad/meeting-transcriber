'use strict';

const os = require('os');

function hostMapsPosixModeThroughWindowsAcls() {
  return os.type() === 'Windows_NT';
}

function unixPermissionBits(mode) {
  return Number(mode) & 0o777;
}

function isWindowsNtfsPosixModeMapping(mode) {
  if (!hostMapsPosixModeThroughWindowsAcls()) {
    return false;
  }
  const bits = unixPermissionBits(mode);
  return bits === 0o666 || bits === 0o777;
}

function isWorldWritableMode(mode) {
  if (isWindowsNtfsPosixModeMapping(mode)) {
    return false;
  }
  return (Number(mode) & 0o002) !== 0;
}

function lacksUnixExecuteBits(mode) {
  if (mode == null) {
    return false;
  }
  if ((Number(mode) & 0o111) !== 0) {
    return false;
  }
  if (isWindowsNtfsPosixModeMapping(mode)) {
    return false;
  }
  return true;
}

module.exports = {
  hostMapsPosixModeThroughWindowsAcls,
  isWindowsNtfsPosixModeMapping,
  isWorldWritableMode,
  lacksUnixExecuteBits,
};
