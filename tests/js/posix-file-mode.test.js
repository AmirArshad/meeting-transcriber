'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const {
  hostMapsPosixModeThroughWindowsAcls,
  isWindowsNtfsPosixModeMapping,
  isWorldWritableMode,
  lacksUnixExecuteBits,
} = require('../../src/main-process/posix-file-mode');

test('Windows NTFS POSIX mode mapping is host-native, not process.platform', () => {
  assert.equal(hostMapsPosixModeThroughWindowsAcls(), os.type() === 'Windows_NT');
});

test('world-writable detection keeps POSIX other-write and ignores NTFS 0o666/0o777 mapping', () => {
  if (os.type() === 'Windows_NT') {
    assert.equal(isWindowsNtfsPosixModeMapping(0o666), true);
    assert.equal(isWindowsNtfsPosixModeMapping(0o100666), true);
    assert.equal(isWindowsNtfsPosixModeMapping(0o777), true);
    assert.equal(isWorldWritableMode(0o666), false);
    assert.equal(isWorldWritableMode(0o777), false);
    assert.equal(isWorldWritableMode(0o100666), false);
    assert.equal(isWorldWritableMode(0o702), true);
    assert.equal(isWorldWritableMode(0o644), false);
    return;
  }

  assert.equal(isWindowsNtfsPosixModeMapping(0o666), false);
  assert.equal(isWorldWritableMode(0o666), true);
  assert.equal(isWorldWritableMode(0o777), true);
  assert.equal(isWorldWritableMode(0o644), false);
  assert.equal(isWorldWritableMode(0o755), false);
  assert.equal(isWorldWritableMode(0o702), true);
});

test('Unix execute-bit detection ignores NTFS 0o666 mapping and still honors explicit POSIX modes', () => {
  assert.equal(lacksUnixExecuteBits(0o755), false);
  assert.equal(lacksUnixExecuteBits(0o644), true);
  if (os.type() === 'Windows_NT') {
    assert.equal(lacksUnixExecuteBits(0o666), false);
    assert.equal(lacksUnixExecuteBits(0o100666), false);
    return;
  }
  assert.equal(lacksUnixExecuteBits(0o666), true);
});
