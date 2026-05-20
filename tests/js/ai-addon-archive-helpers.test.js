const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  isZipSymlinkEntry,
  validateZipEntries,
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
