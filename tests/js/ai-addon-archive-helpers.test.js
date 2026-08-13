const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');

const {
  isZipSymlinkEntry,
  validateZipEntries,
  resolvePreferredTarExecutable,
} = require('../../src/ai-addon-archive-helpers');
const { runArchiveExtractionInWorker } = require('../../src/ai-addon/archive-install');

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

test('archive worker cancellation terminates extraction and rejects promptly', async () => {
  const controller = new AbortController();
  const worker = new EventEmitter();
  worker.terminated = 0;
  worker.terminate = async () => {
    worker.terminated += 1;
    return 0;
  };
  const extraction = runArchiveExtractionInWorker(
    'unused-worker.js',
    { archivePath: 'archive.zip', destinationDir: 'destination' },
    'Test archive',
    controller.signal,
    () => worker,
  );

  controller.abort();

  await assert.rejects(extraction, (error) => (
    error.name === 'AbortError' && error.code === 'AI_ADDON_SETUP_CANCELLED'
  ));
  assert.equal(worker.terminated, 1);
});
