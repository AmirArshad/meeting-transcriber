'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getSummaryStorageFit, getSummaryArtifactPath, getSharedSummaryRuntimeDir } = require('../../src/ai-addon/manifest-store');

test('storage fit counts existing temporary files and shared runtimes', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-storage-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const artifact = { modelId: 'test', fileName: 'model.gguf', estimatedSizeBytes: 100, runtimeArtifactId: 'runtime' };
  const runtimeArtifact = { artifacts: [{ sizeBytes: 10, expandedBytes: 20 }] };
  const options = { userDataDir, artifact, runtimeArtifact, cache: { valid: false }, runtimeCache: { valid: false } };
  const modelPath = getSummaryArtifactPath(userDataDir, artifact);
  const runtimeDir = getSharedSummaryRuntimeDir(userDataDir, artifact);
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  fs.writeFileSync(`${modelPath}.download`, Buffer.alloc(20));
  fs.mkdirSync(`${runtimeDir}.staging`, { recursive: true });
  fs.writeFileSync(path.join(`${runtimeDir}.staging`, 'partial'), Buffer.alloc(5));
  const fsModule = {
    ...fs,
    statfsSync: () => ({ bavail: 100, bsize: 1 }),
    lstatSync(target) {
      const stat = fs.lstatSync(target);
      stat.blocks = Math.ceil(stat.size / 512);
      return stat;
    },
  };
  assert.deepEqual(getSummaryStorageFit({ ...options, fsModule }), {
    requiredBytes: 125, availableBytes: 100, blocked: true,
    reason: 'Not enough free disk space for the summary model download and setup.',
  });
  assert.equal(getSummaryStorageFit({ ...options, fsModule, runtimeCache: { valid: true } }).requiredBytes, 80);
  assert.equal(getSummaryStorageFit({ ...options, fsModule, cache: { valid: true }, runtimeCache: { valid: true } }).blocked, false);
  assert.equal(getSummaryStorageFit({ ...options, fsModule: { ...fsModule, statfsSync: () => { throw new Error('unavailable'); } } }).availableBytes, null);
});

test('storage preflight does not count HF temporary files or sparse bytes as free', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-storage-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const artifact = { modelId: 'test', fileName: 'model.gguf', estimatedSizeBytes: 8192, runtimeArtifactId: 'runtime' };
  const runtimeArtifact = { artifacts: [{ sizeBytes: 10, expandedBytes: 20 }] };
  const modelPath = getSummaryArtifactPath(userDataDir, artifact);
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  const fd = fs.openSync(`${modelPath}.download`, 'w');
  fs.ftruncateSync(fd, 8192);
  fs.closeSync(fd);
  const base = { userDataDir, artifact, runtimeArtifact, cache: { valid: false }, runtimeCache: { valid: true } };
  let allocatedBlocks = 0;
  const fsModule = {
    ...fs,
    statfsSync: () => ({ bavail: 1, bsize: 1 }),
    lstatSync(target) {
      const stat = fs.lstatSync(target);
      stat.blocks = allocatedBlocks;
      return stat;
    },
  };
  assert.equal(getSummaryStorageFit({ ...base, fsModule }).requiredBytes, 8192);
  fs.writeFileSync(`${modelPath}.download`, Buffer.alloc(8192));
  allocatedBlocks = 16;
  assert.equal(getSummaryStorageFit({ ...base, fsModule }).requiredBytes, 0);
  assert.equal(getSummaryStorageFit({ ...base, artifact: { ...artifact, source: { provider: 'huggingface' } }, fsModule }).requiredBytes, 8192);
});

test('known full destination stays blocked when another volume cannot be measured', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-storage-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const artifact = { modelId: 'test', fileName: 'model.gguf', estimatedSizeBytes: 100, runtimeArtifactId: 'runtime' };
  const runtimeArtifact = { artifacts: [{ sizeBytes: 10, expandedBytes: 20 }] };
  const modelDir = path.dirname(getSummaryArtifactPath(userDataDir, artifact));
  const runtimeParent = path.dirname(getSharedSummaryRuntimeDir(userDataDir, artifact));
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(runtimeParent, { recursive: true });
  const fsModule = { ...fs,
    statfsSync: (target) => { if (target === runtimeParent) throw new Error('unavailable'); return { bavail: 50, bsize: 1 }; },
    statSync: (target) => ({ ...fs.statSync(target), dev: target === runtimeParent ? 2 : 1 }),
  };
  const fit = getSummaryStorageFit({ userDataDir, artifact, runtimeArtifact, cache: { valid: false }, runtimeCache: { valid: false }, fsModule });
  assert.equal(fit.blocked, true);
  assert.equal(fit.availableBytes, 50);
});

test('storage fit picks worst blocked volume and tolerates statSync failure when statfsSync succeeds', (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-storage-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const artifact = { modelId: 'test', fileName: 'model.gguf', estimatedSizeBytes: 100, runtimeArtifactId: 'runtime' };
  const runtimeArtifact = { artifacts: [{ sizeBytes: 100, expandedBytes: 200 }] };
  const modelDir = path.dirname(getSummaryArtifactPath(userDataDir, artifact));
  const runtimeParent = path.dirname(getSharedSummaryRuntimeDir(userDataDir, artifact));
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(runtimeParent, { recursive: true });

  const twoBlockedFs = {
    ...fs,
    statfsSync: (target) => ({ bavail: target === runtimeParent ? 50 : 80, bsize: 1 }),
    statSync: (target) => ({ ...fs.statSync(target), dev: target === runtimeParent ? 2 : 1 }),
  };
  const worstBlocked = getSummaryStorageFit({
    userDataDir,
    artifact,
    runtimeArtifact,
    cache: { valid: false },
    runtimeCache: { valid: false },
    fsModule: twoBlockedFs,
  });
  assert.equal(worstBlocked.blocked, true);
  assert.equal(worstBlocked.requiredBytes, 300);
  assert.equal(worstBlocked.availableBytes, 50);

  const statThrowingFs = {
    ...fs,
    statfsSync: () => ({ bavail: 40, bsize: 1 }),
    statSync: () => { throw new Error('stat unavailable'); },
  };
  const noStatFit = getSummaryStorageFit({
    userDataDir,
    artifact,
    runtimeArtifact,
    cache: { valid: false },
    runtimeCache: { valid: true },
    fsModule: statThrowingFs,
  });
  assert.equal(noStatFit.blocked, true);
  assert.equal(noStatFit.availableBytes, 40);
  assert.equal(noStatFit.requiredBytes, 100);
});
