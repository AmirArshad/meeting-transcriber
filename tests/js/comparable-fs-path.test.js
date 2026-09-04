'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  comparableFsPath,
  comparableLinuxLibraryPathParts,
  linuxLibraryPathContainsDir,
  linuxLibraryPathStartsWithDir,
} = require('./comparable-fs-path');

test('Linux library-path splitting keeps Windows drive letters intact', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-libpath-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-libpath-b-'));
  try {
    const joined = `${first}:${second}`;
    assert.deepEqual(
      comparableLinuxLibraryPathParts(joined),
      [first, second].map(comparableFsPath),
    );
    assert.equal(linuxLibraryPathContainsDir(joined, second), true);
    assert.equal(linuxLibraryPathStartsWithDir(joined, first), true);
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});
