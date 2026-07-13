'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const {
  createDeviceIpc,
  buildDiskSpaceResult,
  buildUnknownDiskSpaceResult,
  DISK_WARNING_BYTES,
  DISK_CRITICAL_BYTES,
  DISK_SPACE_WARNING_MESSAGE,
} = require('../../src/main/device-ipc');

test('buildDiskSpaceResult reports healthy space without warning', () => {
  const result = buildDiskSpaceResult(DISK_WARNING_BYTES);
  assert.equal(result.success, true);
  assert.equal(result.availableBytes, DISK_WARNING_BYTES);
  assert.equal(result.warning, null);
  assert.equal(result.level, null);
  assert.match(result.availableGB, /^\d+\.\d{2}$/);
});

test('buildDiskSpaceResult warns below 10 GB and marks critical below 2 GB', () => {
  const warning = buildDiskSpaceResult(DISK_WARNING_BYTES - 1);
  assert.equal(warning.warning, DISK_SPACE_WARNING_MESSAGE);
  assert.equal(warning.level, 'warning');

  const critical = buildDiskSpaceResult(DISK_CRITICAL_BYTES - 1);
  assert.equal(critical.warning, DISK_SPACE_WARNING_MESSAGE);
  assert.equal(critical.level, 'critical');
});

test('buildUnknownDiskSpaceResult is non-blocking', () => {
  assert.deepEqual(buildUnknownDiskSpaceResult(), {
    success: true,
    availableBytes: -1,
    availableGB: null,
    warning: null,
    level: null,
  });
});

function createTempRecordingsRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-disk-'));
  const recordingsDir = path.join(root, 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });
  return { root, recordingsDir };
}

function createDiskProbeService({ recordingsDir, statfs, logWarn }) {
  return createDeviceIpc({
    app: {
      getPath: () => path.dirname(recordingsDir),
    },
    path,
    fs,
    spawn: () => {
      throw new Error('spawn should not be used by disk probe tests');
    },
    spawnTrackedPython: () => {
      throw new Error('spawnTrackedPython should not be used by disk probe tests');
    },
    pythonConfig: { backendPath: rootPlaceholder() },
    getBackendModuleArgs: () => [],
    appendSpawnLogBuffer: () => {},
    runProcessWithTimeout: async () => {
      throw new Error('shell disk probes must not be used');
    },
    buildMacOSPermissionCheckFailureStatus: () => ({}),
    MACOS_PERMISSION_CHECK_TIMEOUT_MS: 1000,
    statfs,
    logWarn,
  });
}

function rootPlaceholder() {
  return path.join(os.tmpdir(), 'avanevis-unused-backend');
}

test('checkDiskSpace uses injected statfs for known free space', async () => {
  const { root, recordingsDir } = createTempRecordingsRoot();
  const warnings = [];
  try {
    const service = createDiskProbeService({
      recordingsDir,
      logWarn: (...args) => warnings.push(args.join(' ')),
      statfs: async () => ({ bavail: 8n, bsize: 1024n * 1024n * 1024n }), // 8 GiB
    });

    const result = await service.checkDiskSpace();
    assert.equal(result.success, true);
    assert.equal(result.availableBytes, 8 * 1024 * 1024 * 1024);
    assert.equal(result.level, 'warning');
    assert.equal(result.warning, DISK_SPACE_WARNING_MESSAGE);
    assert.equal(warnings.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkDiskSpace reports critical free space from statfs', async () => {
  const { root, recordingsDir } = createTempRecordingsRoot();
  try {
    const service = createDiskProbeService({
      recordingsDir,
      logWarn: () => {},
      statfs: async () => ({ bavail: 1, bsize: 1024 * 1024 * 1024 }), // 1 GiB
    });

    const result = await service.checkDiskSpace();
    assert.equal(result.level, 'critical');
    assert.equal(result.warning, DISK_SPACE_WARNING_MESSAGE);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkDiskSpace returns unknown space when statfs fails', async () => {
  const { root, recordingsDir } = createTempRecordingsRoot();
  const warnings = [];
  try {
    const service = createDiskProbeService({
      recordingsDir,
      logWarn: (...args) => warnings.push(args.join(' ')),
      statfs: async () => {
        throw new Error('statfs unavailable');
      },
    });

    const result = await service.checkDiskSpace();
    assert.deepEqual(result, buildUnknownDiskSpaceResult());
    assert.match(warnings.join('\n'), /statfs unavailable|Disk space probe failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkDiskSpace returns unknown space for invalid bavail/bsize', async () => {
  const { root, recordingsDir } = createTempRecordingsRoot();
  const warnings = [];
  try {
    const service = createDiskProbeService({
      recordingsDir,
      logWarn: (...args) => warnings.push(args.join(' ')),
      statfs: async () => ({ bavail: Number.NaN, bsize: 0 }),
    });

    const result = await service.checkDiskSpace();
    assert.deepEqual(result, buildUnknownDiskSpaceResult());
    assert.match(warnings.join('\n'), /invalid bavail\/bsize/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
