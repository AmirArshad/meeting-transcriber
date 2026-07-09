const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  isZipSymlinkEntry,
  validateZipEntries,
  resolvePreferredTarExecutable,
} = require('../../src/ai-addon-archive-helpers');

test('validateZipEntries rejects symlink entries', () => {
  const destinationDir = path.join(os.tmpdir(), 'avanevis-zip-test');
  const zip = {
    getEntries: () => ([
      {
        entryName: 'link',
        header: { attr: (0o120777 << 16) | 0o777 },
      },
    ]),
  };

  assert.throws(
    () => validateZipEntries(zip, destinationDir),
    /unsafe symlink entry/,
  );
});

test('isZipSymlinkEntry detects unix symlink mode bits', () => {
  assert.equal(
    isZipSymlinkEntry({ header: { attr: (0o120644 << 16) | 0o644 } }),
    true,
  );
  assert.equal(
    isZipSymlinkEntry({ header: { attr: (0o100644 << 16) | 0o644 } }),
    false,
  );
});

test('resolvePreferredTarExecutable uses System32 tar on packaged Windows', () => {
  assert.equal(
    resolvePreferredTarExecutable({
      platform: 'win32',
      env: { AVANEVIS_PACKAGED: '1', SystemRoot: 'D:\\Windows' },
      existsSync: () => false,
    }),
    path.join('D:\\Windows', 'System32', 'tar.exe'),
  );
});

test('resolvePreferredTarExecutable default args honor process.env.AVANEVIS_PACKAGED', () => {
  const previousPackaged = process.env.AVANEVIS_PACKAGED;
  const previousSystemRoot = process.env.SystemRoot;
  try {
    process.env.AVANEVIS_PACKAGED = '1';
    process.env.SystemRoot = 'F:\\Windows';
    assert.equal(
      resolvePreferredTarExecutable({
        platform: 'win32',
        existsSync: () => false,
      }),
      path.join('F:\\Windows', 'System32', 'tar.exe'),
    );
  } finally {
    if (previousPackaged === undefined) {
      delete process.env.AVANEVIS_PACKAGED;
    } else {
      process.env.AVANEVIS_PACKAGED = previousPackaged;
    }
    if (previousSystemRoot === undefined) {
      delete process.env.SystemRoot;
    } else {
      process.env.SystemRoot = previousSystemRoot;
    }
  }
});
