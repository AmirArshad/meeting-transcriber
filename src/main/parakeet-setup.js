'use strict';

const fs = require('fs');
const path = require('path');

const catalog = require('./transcription-engine-catalog');
const {
  expectedRuntimeFiles,
  hashFileSha256,
  verifyRuntimeHashes,
  verifyRuntimeTree,
} = require('./parakeet-runtime');
const { isAllowedDownloadUrl } = require('../ai-addon/download-helpers');

const INSTALL_RECORD = 'install.json';
const DEVICE_RECORD = 'device.json';

function fail(code, message, reason) {
  const error = new Error(message);
  error.code = code;
  if (reason) {
    error.reason = reason;
  }
  return error;
}

function throwIfCanceled(cancelSignal) {
  if (cancelSignal && cancelSignal.aborted) {
    throw fail('AI_ADDON_SETUP_CANCELLED', 'Parakeet setup was canceled.', 'canceled');
  }
}

function modelDir(userDataDir, revision) {
  return path.join(userDataDir, 'ai-addons', 'models', 'transcription', 'parakeet', revision);
}

function runtimeDir(userDataDir, adapterId, lockDigest) {
  return path.join(userDataDir, 'ai-addons', 'runtimes', 'parakeet', adapterId, lockDigest);
}

function vadDir(userDataDir, revision) {
  return path.join(userDataDir, 'ai-addons', 'models', 'transcription', 'parakeet', 'vad', revision);
}

function stagingDir(userDataDir, operationId) {
  return path.join(userDataDir, 'ai-addons', 'staging', 'parakeet', String(operationId || 'operation'));
}

function removeTree(target, fsModule) {
  if (fsModule.existsSync(target) && fsModule.rmSync) {
    fsModule.rmSync(target, { recursive: true, force: true });
  }
}

function huggingfaceFileUrl(repository, revision, filePath) {
  const encoded = String(filePath || '').split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://huggingface.co/${repository}/resolve/${revision}/${encoded}`;
}

function downloadPlan(lock) {
  const files = [];
  const groups = [
    ['model', lock.model],
    ['vad', lock.vad],
  ];
  for (const [kind, group] of groups) {
    if (!group || !Array.isArray(group.files)) {
      continue;
    }
    for (const file of group.files) {
      files.push({
        kind,
        relativePath: `${kind}/${file.path}`,
        url: huggingfaceFileUrl(group.repository, group.revision, file.path),
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
      });
    }
  }
  for (const wheel of lock.wheels || []) {
    files.push({
      kind: 'wheel',
      relativePath: `wheels/${wheel.fileName}`,
      url: wheel.url,
      sha256: wheel.sha256,
      sizeBytes: wheel.sizeBytes,
      fileName: wheel.fileName,
      extractedFiles: wheel.extractedFiles || [],
    });
  }
  return files;
}

function downloadTotalBytes(lock) {
  return downloadPlan(lock).reduce((total, file) => total + (Number(file.sizeBytes) || 0), 0);
}

function readJson(filePath, fsModule) {
  try {
    return JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return null;
  }
}

function fingerprintEntries(root, relativePaths, fsModule) {
  return relativePaths.map((relativePath) => {
    const filePath = path.join(root, ...String(relativePath).split('/'));
    if (!fsModule.existsSync(filePath)) {
      return null;
    }
    const stat = fsModule.statSync(filePath);
    return {
      path: relativePath,
      sizeBytes: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    };
  });
}

function lockFileRecords(files) {
  return (Array.isArray(files) ? files : []).map((file) => ({
    path: String(file && file.path || '').replace(/\\/g, '/'),
    sizeBytes: Number(file && file.sizeBytes),
  })).filter((file) => file.path);
}

function componentRecords(lock) {
  return {
    model: lockFileRecords(lock && lock.model && lock.model.files),
    vad: lockFileRecords(lock && lock.vad && lock.vad.files),
    runtime: expectedRuntimeFiles(lock || {}).map((file) => ({
      path: file.relativePath,
      sizeBytes: Number(file.sizeBytes),
    })),
  };
}

function fileMatchesLockRecord(root, record, fsModule) {
  const filePath = path.join(root, ...record.path.split('/'));
  if (!fsModule.existsSync(filePath)) {
    return false;
  }
  const stat = fsModule.lstatSync ? fsModule.lstatSync(filePath) : fsModule.statSync(filePath);
  if (stat.isSymbolicLink && stat.isSymbolicLink()) {
    return false;
  }
  if (stat.isFile && !stat.isFile()) {
    return false;
  }
  return stat.size === record.sizeBytes;
}

function inventoryMatches(root, records, fsModule) {
  if (!records.length) {
    return false;
  }
  return records.every((record) => fileMatchesLockRecord(root, record, fsModule));
}

function runtimeTreeMatches(runtimePath, lock, fsModule) {
  try {
    verifyRuntimeTree(runtimePath, lock, fsModule);
    return true;
  } catch (error) {
    return false;
  }
}

function hasPositiveDeviceEvidence(record, expectedDevice) {
  return Boolean(
    record
    && record.deviceAvailable === true
    && record.device === expectedDevice
    && record.device !== 'cpu'
  );
}

function writeInstallRecord(root, relativePaths, fsModule) {
  const files = fingerprintEntries(root, relativePaths, fsModule);
  if (files.some((entry) => !entry)) {
    throw fail('PARAKEET_ARTIFACT_INVALID', 'Parakeet install is missing a pinned file.', 'missing');
  }
  fsModule.writeFileSync(path.join(root, INSTALL_RECORD), JSON.stringify({
    schemaVersion: 1,
    files,
  }));
}

function resolveTarget(options) {
  if (options.lock && options.adapterId) {
    return {
      ok: true,
      adapterId: options.adapterId,
      lock: options.lock,
      device: options.device || 'cuda',
      artifactRevision: options.lock.model.revision,
    };
  }
  const target = catalog.resolveAdapterForTarget({
    platform: options.platform,
    arch: options.arch,
    osRelease: options.osRelease,
  });
  if (!target.ok) {
    return target;
  }
  const spec = catalog.getAdapterSpec(target.adapterId);
  return {
    ok: true,
    adapterId: spec.adapterId,
    lock: spec.lock,
    device: spec.device,
    artifactRevision: spec.artifactRevision,
    runtimeLockId: spec.runtimeLockId,
  };
}

function publicStatus(status, extra = {}) {
  return {
    ok: true,
    engine: 'parakeet',
    status,
    ...extra,
  };
}

function getStatus({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  osRelease = '',
  fsModule = fs,
  lock = null,
  adapterId = null,
  device = null,
} = {}) {
  const target = resolveTarget({
    platform,
    arch,
    osRelease,
    lock,
    adapterId,
    device,
  });
  if (!target.ok) {
    return publicStatus('unsupported', {
      message: target.message,
      code: target.code || 'PARAKEET_SELECTION_UNAVAILABLE',
    });
  }
  const records = componentRecords(target.lock);
  const modelPath = modelDir(userDataDir, target.artifactRevision);
  const runtimePath = runtimeDir(userDataDir, target.adapterId, target.lock.lockDigest);
  const vadPath = records.vad.length ? vadDir(userDataDir, target.lock.vad.revision) : null;
  const modelExists = fsModule.existsSync(modelPath);
  const runtimeExists = fsModule.existsSync(runtimePath);
  const vadExists = Boolean(vadPath && fsModule.existsSync(vadPath));
  if (!modelExists && !runtimeExists && !vadExists) {
    return publicStatus('not-installed', {
      adapterId: target.adapterId,
      downloadBytes: downloadTotalBytes(target.lock),
    });
  }
  const modelOk = modelExists && inventoryMatches(modelPath, records.model, fsModule);
  const runtimeOk = runtimeExists && inventoryMatches(runtimePath, records.runtime, fsModule)
    && runtimeTreeMatches(runtimePath, target.lock, fsModule);
  const vadOk = !records.vad.length || (vadExists && inventoryMatches(vadPath, records.vad, fsModule));
  if (!modelOk || !runtimeOk || !vadOk) {
    return publicStatus('repair-required', {
      adapterId: target.adapterId,
      code: 'PARAKEET_ARTIFACT_INVALID',
      installed: true,
    });
  }
  const deviceRecord = readJson(path.join(runtimePath, DEVICE_RECORD), fsModule);
  const expectedDevice = target.device === 'metal' ? 'metal' : 'cuda';
  if (!hasPositiveDeviceEvidence(deviceRecord, expectedDevice)) {
    return publicStatus('device-unavailable', {
      adapterId: target.adapterId,
      code: 'PARAKEET_GPU_UNAVAILABLE',
      installed: true,
    });
  }
  return publicStatus('ready', {
    adapterId: target.adapterId,
    artifactRevision: target.artifactRevision,
    runtimeLockId: target.lock.lockDigest,
    installed: true,
  });
}

async function receiveDownload({
  file,
  stagingRoot,
  downloader,
  cancelSignal,
  fsModule,
}) {
  if (!isAllowedDownloadUrl(file.url)) {
    throw fail('PARAKEET_ARTIFACT_INVALID', 'Parakeet download URL is not on the allowlist.', 'redirect');
  }
  const destination = path.join(stagingRoot, ...file.relativePath.split('/'));
  fsModule.mkdirSync(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  const result = await downloader({
    url: file.url,
    destinationPath: partial,
    expectedSizeBytes: file.sizeBytes,
    cancelSignal,
  });
  throwIfCanceled(cancelSignal);
  if (result && result.finalUrl && !isAllowedDownloadUrl(result.finalUrl)) {
    throw fail('PARAKEET_ARTIFACT_INVALID', 'Parakeet download was redirected off the allowlist.', 'redirect');
  }
  if (!fsModule.existsSync(partial)) {
    throw fail('PARAKEET_ARTIFACT_INVALID', 'Parakeet download did not produce a file.', 'truncated');
  }
  const stat = fsModule.statSync(partial);
  if (stat.size !== Number(file.sizeBytes)) {
    throw fail('PARAKEET_ARTIFACT_INVALID', 'Parakeet download was truncated.', 'truncated');
  }
  const actual = await hashFileSha256(partial, fsModule);
  if (actual !== file.sha256) {
    throw fail('PARAKEET_ARTIFACT_INVALID', 'Parakeet download checksum does not match the pinned lock.', 'checksum');
  }
  fsModule.renameSync(partial, destination);
  return destination;
}

function stagePromotion(stagingPath, destination, fsModule) {
  const previous = `${destination}.previous`;
  if (fsModule.existsSync(previous)) {
    removeTree(previous, fsModule);
  }
  const hadDestination = fsModule.existsSync(destination);
  if (hadDestination) {
    fsModule.renameSync(destination, previous);
  }
  try {
    fsModule.mkdirSync(path.dirname(destination), { recursive: true });
    fsModule.renameSync(stagingPath, destination);
  } catch (error) {
    if (hadDestination && fsModule.existsSync(previous) && !fsModule.existsSync(destination)) {
      fsModule.renameSync(previous, destination);
    }
    throw error;
  }
  return { destination, previous, hadDestination };
}

function commitPromotions(promoted, fsModule) {
  for (const item of promoted) {
    if (item.hadDestination && fsModule.existsSync(item.previous)) {
      removeTree(item.previous, fsModule);
    }
  }
}

function rollbackPromotions(promoted, fsModule) {
  for (const item of [...promoted].reverse()) {
    if (fsModule.existsSync(item.destination)) {
      removeTree(item.destination, fsModule);
    }
    if (item.hadDestination && fsModule.existsSync(item.previous) && !fsModule.existsSync(item.destination)) {
      fsModule.renameSync(item.previous, item.destination);
    }
  }
}

async function recordDeviceEvidence({
  runtimeDir: runtimeDestination,
  expectedDevice,
  probeDevice,
  fsModule,
}) {
  let probed = null;
  if (typeof probeDevice === 'function') {
    try {
      probed = await probeDevice({ runtimeDir: runtimeDestination, expectedDevice });
    } catch (error) {
      probed = null;
    }
  }
  const reported = probed && typeof probed.device === 'string' ? probed.device : 'cpu';
  const available = Boolean(
    probed
    && probed.deviceAvailable === true
    && reported === expectedDevice
    && reported !== 'cpu'
  );
  fsModule.writeFileSync(path.join(runtimeDestination, DEVICE_RECORD), JSON.stringify({
    device: reported,
    deviceAvailable: available,
  }));
}

async function setupParakeet({
  userDataDir,
  operationId,
  operation = 'install',
  platform = process.platform,
  arch = process.arch,
  osRelease = '',
  fsModule = fs,
  downloader,
  materializeRuntime = null,
  probeDevice = null,
  cancelSignal = null,
  emitProgress = () => {},
  lock = null,
  adapterId = null,
  device = null,
} = {}) {
  if (operation !== 'install' && operation !== 'repair') {
    throw fail('PARAKEET_SELECTION_UNAVAILABLE', 'Parakeet setup operation must be install or repair.');
  }
  if (typeof downloader !== 'function') {
    throw fail('PARAKEET_NOT_INSTALLED', 'Parakeet setup requires an explicit downloader.');
  }
  const target = resolveTarget({
    platform, arch, osRelease, lock, adapterId, device,
  });
  if (!target.ok) {
    throw fail(target.code || 'PARAKEET_SELECTION_UNAVAILABLE', target.message);
  }
  const stage = stagingDir(userDataDir, operationId);
  removeTree(stage, fsModule);
  fsModule.mkdirSync(stage, { recursive: true });
  const records = componentRecords(target.lock);
  const modelDestination = modelDir(userDataDir, target.artifactRevision);
  const runtimeDestination = runtimeDir(userDataDir, target.adapterId, target.lock.lockDigest);
  const vadDestination = records.vad.length ? vadDir(userDataDir, target.lock.vad.revision) : null;
  const expectedDevice = target.device === 'metal' ? 'metal' : 'cuda';
  try {
    const plan = downloadPlan(target.lock);
    let completed = 0;
    const total = downloadTotalBytes(target.lock);
    for (const file of plan) {
      throwIfCanceled(cancelSignal);
      emitProgress({
        operationId,
        phase: 'downloading',
        downloadedBytes: completed,
        totalBytes: total,
      });
      await receiveDownload({
        file,
        stagingRoot: stage,
        downloader,
        cancelSignal,
        fsModule,
      });
      completed += Number(file.sizeBytes) || 0;
    }
    throwIfCanceled(cancelSignal);
    emitProgress({
      operationId,
      phase: 'verifying',
      downloadedBytes: total,
      totalBytes: total,
    });
    const runtimeStage = path.join(stage, 'runtime');
    fsModule.mkdirSync(runtimeStage, { recursive: true });
    if (typeof materializeRuntime === 'function') {
      await materializeRuntime({
        stagingRoot: stage,
        runtimeDir: runtimeStage,
        lock: target.lock,
        fsModule,
        cancelSignal,
      });
    }
    throwIfCanceled(cancelSignal);
    verifyRuntimeTree(runtimeStage, target.lock, fsModule);
    await verifyRuntimeHashes(runtimeStage, target.lock, fsModule);
    throwIfCanceled(cancelSignal);
    const modelStage = path.join(stage, 'model');
    const vadStage = path.join(stage, 'vad');
    writeInstallRecord(modelStage, records.model.map((file) => file.path), fsModule);
    if (records.vad.length) {
      writeInstallRecord(vadStage, records.vad.map((file) => file.path), fsModule);
    }
    writeInstallRecord(runtimeStage, records.runtime.map((file) => file.path), fsModule);
    throwIfCanceled(cancelSignal);
    const promoted = [];
    try {
      promoted.push(stagePromotion(modelStage, modelDestination, fsModule));
      if (vadDestination) {
        promoted.push(stagePromotion(vadStage, vadDestination, fsModule));
      }
      promoted.push(stagePromotion(runtimeStage, runtimeDestination, fsModule));
    } catch (error) {
      rollbackPromotions(promoted, fsModule);
      throw error;
    }
    commitPromotions(promoted, fsModule);
    await recordDeviceEvidence({
      runtimeDir: runtimeDestination,
      expectedDevice,
      probeDevice,
      fsModule,
    });
    return getStatus({
      userDataDir,
      platform,
      arch,
      osRelease,
      fsModule,
      lock: target.lock,
      adapterId: target.adapterId,
      device: target.device,
    });
  } catch (error) {
    removeTree(stage, fsModule);
    throw error;
  } finally {
    removeTree(stage, fsModule);
  }
}

async function validateParakeet({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  osRelease = '',
  fsModule = fs,
  probeDevice = null,
  lock = null,
  adapterId = null,
  device = null,
} = {}) {
  const target = resolveTarget({
    platform, arch, osRelease, lock, adapterId, device,
  });
  if (!target.ok) {
    throw fail(target.code || 'PARAKEET_SELECTION_UNAVAILABLE', target.message);
  }
  const records = componentRecords(target.lock);
  const modelPath = modelDir(userDataDir, target.artifactRevision);
  const runtimePath = runtimeDir(userDataDir, target.adapterId, target.lock.lockDigest);
  const vadPath = records.vad.length ? vadDir(userDataDir, target.lock.vad.revision) : null;
  await verifyRuntimeHashes(runtimePath, target.lock, fsModule);
  for (const group of [
    [modelPath, target.lock.model && target.lock.model.files],
    [vadPath, target.lock.vad && target.lock.vad.files],
  ]) {
    const [root, files] = group;
    for (const file of files || []) {
      const filePath = path.join(root, ...String(file.path).split('/'));
      const actual = await hashFileSha256(filePath, fsModule);
      if (actual !== file.sha256) {
        throw fail('PARAKEET_ARTIFACT_INVALID', 'Parakeet model file hash does not match the pinned lock.', 'checksum');
      }
    }
  }
  const expectedDevice = target.device === 'metal' ? 'metal' : 'cuda';
  if (typeof probeDevice !== 'function') {
    throw fail('PARAKEET_GPU_UNAVAILABLE', 'Parakeet requires its GPU runtime. CPU and Whisper are not substituted.', 'device');
  }
  await recordDeviceEvidence({
    runtimeDir: runtimePath,
    expectedDevice,
    probeDevice,
    fsModule,
  });
  const deviceRecord = readJson(path.join(runtimePath, DEVICE_RECORD), fsModule);
  if (!hasPositiveDeviceEvidence(deviceRecord, expectedDevice)) {
    throw fail('PARAKEET_GPU_UNAVAILABLE', 'Parakeet requires its GPU runtime. CPU and Whisper are not substituted.', 'device');
  }
  return getStatus({
    userDataDir,
    platform,
    arch,
    osRelease,
    fsModule,
    lock: target.lock,
    adapterId: target.adapterId,
    device: target.device,
  });
}

let mutationReserved = false;

function defaultReserveMutation() {
  if (mutationReserved) {
    throw fail('PARAKEET_SETUP_BUSY', 'Parakeet files are already being changed.');
  }
  mutationReserved = true;
  return () => {
    mutationReserved = false;
  };
}

async function removeParakeet({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  osRelease = '',
  fsModule = fs,
  hasPendingWork = () => false,
  reserveMutation = defaultReserveMutation,
  lock = null,
  adapterId = null,
  device = null,
} = {}) {
  if (hasPendingWork()) {
    throw fail('PARAKEET_SETUP_BUSY', 'Wait for transcription or setup work to finish before removing Parakeet.');
  }
  const release = reserveMutation();
  try {
    const target = resolveTarget({
      platform, arch, osRelease, lock, adapterId, device,
    });
    if (!target.ok) {
      throw fail(target.code || 'PARAKEET_SELECTION_UNAVAILABLE', target.message);
    }
    removeTree(modelDir(userDataDir, target.artifactRevision), fsModule);
    removeTree(runtimeDir(userDataDir, target.adapterId, target.lock.lockDigest), fsModule);
    if (target.lock.vad && target.lock.vad.revision) {
      removeTree(vadDir(userDataDir, target.lock.vad.revision), fsModule);
    }
    return publicStatus('not-installed', { adapterId: target.adapterId, removed: true });
  } finally {
    release();
  }
}

module.exports = {
  downloadPlan,
  getStatus,
  modelDir,
  removeParakeet,
  vadDir,
  runtimeDir,
  setupParakeet,
  stagingDir,
  validateParakeet,
};
