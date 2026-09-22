'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getStatus,
  removeParakeet,
  setupParakeet,
  stagingDir,
  validateParakeet,
} = require('../../src/main/parakeet-setup');
const {
  buildParakeetChildEnv,
  terminateLateRuntimeChild,
  windowsPthLines,
} = require('../../src/main/parakeet-runtime');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixtureLock() {
  const modelBytes = Buffer.from('ok');
  const wheelBytes = Buffer.from('wheel-bytes');
  const runtimeBytes = Buffer.from('data');
  return {
    lockDigest: 'ab'.repeat(32),
    model: {
      repository: 'istupakov/parakeet-tdt-0.6b-v2-onnx',
      revision: '0bbb45a3365852604aef28b538a8f066f4ccaa85',
      files: [{ path: 'config.json', sizeBytes: modelBytes.length, sha256: sha256(modelBytes) }],
    },
    vad: null,
    wheels: [{
      fileName: 'demo.whl',
      url: 'https://files.pythonhosted.org/packages/aa/demo.whl',
      sizeBytes: wheelBytes.length,
      sha256: sha256(wheelBytes),
      extractedFiles: [{ path: 'pkg/model.bin', sizeBytes: runtimeBytes.length, sha256: sha256(runtimeBytes) }],
    }],
    bytes: { modelBytes, wheelBytes, runtimeBytes },
  };
}

function userData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-parakeet-setup-'));
}

function bytesFor(lock, name) {
  if (lock.bytes.byName && lock.bytes.byName[name]) {
    return lock.bytes.byName[name];
  }
  if (name.endsWith('.whl')) {
    return lock.bytes.wheelBytes;
  }
  if (lock.bytes.vadBytes && name === 'silero_vad.onnx') {
    return lock.bytes.vadBytes;
  }
  return lock.bytes.modelBytes;
}

function downloaderFor(lock, mutate = () => {}) {
  return async ({ url, destinationPath }) => {
    const name = path.basename(destinationPath.replace(/\.partial$/, ''));
    let bytes = bytesFor(lock, name);
    const result = {};
    mutate({ url, destinationPath, name, result, assign(next) { bytes = next; } });
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, bytes);
    return result;
  };
}

function materializeFor(lock, extraRelative = null) {
  return async ({ runtimeDir }) => {
    const target = path.join(runtimeDir, 'pkg', 'model.bin');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, lock.bytes.runtimeBytes);
    if (extraRelative) {
      const extra = path.join(runtimeDir, extraRelative);
      fs.mkdirSync(path.dirname(extra), { recursive: true });
      fs.writeFileSync(extra, Buffer.from('extra'));
    }
  };
}

function setupOptions(root, lock, overrides = {}) {
  return {
    userDataDir: root,
    operationId: 'op-1',
    operation: 'install',
    lock,
    adapterId: 'parakeet-onnx-linux-cuda-v1',
    device: 'cuda',
    downloader: downloaderFor(lock),
    materializeRuntime: materializeFor(lock),
    probeDevice: async () => ({ deviceAvailable: true, device: 'cuda' }),
    ...overrides,
  };
}

test('passive status reports not-installed without a download or device probe', async () => {
  const root = userData();
  let probed = false;
  const status = getStatus({
    userDataDir: root,
    lock: fixtureLock(),
    adapterId: 'parakeet-onnx-linux-cuda-v1',
    device: 'cuda',
    probeDevice: () => { probed = true; },
  });
  assert.equal(status.status, 'not-installed');
  assert.equal(probed, false);
  assert.ok(status.downloadBytes > 0);
});

test('setup rejects a truncated download and keeps the previous install', async () => {
  const root = userData();
  const lock = fixtureLock();
  const previous = path.join(root, 'recordings', 'meeting.opus');
  fs.mkdirSync(path.dirname(previous), { recursive: true });
  fs.writeFileSync(previous, 'audio');
  await assert.rejects(
    setupParakeet(setupOptions(root, lock, {
      downloader: downloaderFor(lock, ({ name, assign }) => {
        if (name === 'config.json') {
          assign(Buffer.from('x'));
        }
      }),
    })),
    (error) => error.reason === 'truncated',
  );
  assert.equal(fs.readFileSync(previous, 'utf8'), 'audio');
  assert.equal(getStatus({
    userDataDir: root,
    lock,
    adapterId: 'parakeet-onnx-linux-cuda-v1',
  }).status, 'not-installed');
});

test('setup rejects a checksum mismatch and an off-allowlist redirect', async () => {
  const root = userData();
  const lock = fixtureLock();
  await assert.rejects(
    setupParakeet(setupOptions(root, lock, {
      downloader: downloaderFor(lock, ({ name, assign }) => {
        if (name === 'demo.whl') {
          assign(Buffer.alloc(lock.bytes.wheelBytes.length, 1));
        }
      }),
    })),
    (error) => error.reason === 'checksum',
  );
  await assert.rejects(
    setupParakeet(setupOptions(root, lock, {
      downloader: async ({ destinationPath }) => {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        const name = path.basename(destinationPath.replace(/\.partial$/, ''));
        fs.writeFileSync(destinationPath, name === 'demo.whl' ? lock.bytes.wheelBytes : lock.bytes.modelBytes);
        return { finalUrl: 'https://evil.example/redirect' };
      },
    })),
    (error) => error.reason === 'redirect',
  );
});

test('an extra native library blocks promotion', async () => {
  const root = userData();
  const lock = fixtureLock();
  await assert.rejects(
    setupParakeet(setupOptions(root, lock, {
      materializeRuntime: materializeFor(lock, 'pkg/evil.so'),
    })),
    (error) => error.code === 'PARAKEET_RUNTIME_INVALID',
  );
  assert.equal(fs.existsSync(stagingDir(root, 'op-1')), false);
});

test('cancel before promotion removes staging and leaves the previous generation', async () => {
  const root = userData();
  const lock = fixtureLock();
  await setupParakeet(setupOptions(root, lock));
  const controller = new AbortController();
  await assert.rejects(
    setupParakeet(setupOptions(root, lock, {
      operation: 'repair',
      operationId: 'op-2',
      cancelSignal: controller.signal,
      downloader: async (options) => {
        controller.abort();
        return downloaderFor(lock)(options);
      },
    })),
    (error) => error.code === 'AI_ADDON_SETUP_CANCELLED',
  );
  const status = getStatus({
    userDataDir: root,
    lock,
    adapterId: 'parakeet-onnx-linux-cuda-v1',
  });
  assert.equal(status.status, 'ready');
  assert.equal(fs.existsSync(stagingDir(root, 'op-2')), false);
});

test('a restarted setup discards a stale staging directory', async () => {
  const root = userData();
  const lock = fixtureLock();
  const stale = path.join(stagingDir(root, 'op-1'), 'leftover.so');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, 'stale');
  await setupParakeet(setupOptions(root, lock));
  assert.equal(fs.existsSync(stale), false);
  assert.equal(getStatus({
    userDataDir: root,
    lock,
    adapterId: 'parakeet-onnx-linux-cuda-v1',
  }).status, 'ready');
});

test('validate uses the lock hash and a device mismatch does not delete artifacts', async () => {
  const root = userData();
  const lock = fixtureLock();
  await setupParakeet(setupOptions(root, lock));
  const modelFile = path.join(
    root,
    'ai-addons',
    'models',
    'transcription',
    'parakeet',
    lock.model.revision,
    'config.json',
  );
  fs.writeFileSync(modelFile, Buffer.from('no'));
  fs.writeFileSync(path.join(path.dirname(modelFile), 'install.json'), JSON.stringify({
    schemaVersion: 1,
    sha256: 'not-the-authority',
    files: [{ path: 'config.json', sizeBytes: 99, mtimeMs: 1 }],
  }));
  await assert.rejects(
    validateParakeet({
      userDataDir: root,
      lock,
      adapterId: 'parakeet-onnx-linux-cuda-v1',
      device: 'cuda',
    }),
    (error) => error.reason === 'checksum' || error.code === 'PARAKEET_ARTIFACT_INVALID',
  );
  fs.writeFileSync(modelFile, lock.bytes.modelBytes);
  const runtimeRoot = path.join(root, 'ai-addons', 'runtimes', 'parakeet', 'parakeet-onnx-linux-cuda-v1', lock.lockDigest);
  const runtimeFile = path.join(runtimeRoot, 'pkg', 'model.bin');
  const stat = fs.statSync(runtimeFile);
  fs.writeFileSync(path.join(runtimeRoot, 'install.json'), JSON.stringify({
    schemaVersion: 1,
    sha256: 'ignored',
    files: [{ path: 'pkg/model.bin', sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) }],
  }));
  const modelStat = fs.statSync(modelFile);
  fs.writeFileSync(path.join(path.dirname(modelFile), 'install.json'), JSON.stringify({
    schemaVersion: 1,
    sha256: 'ignored',
    files: [{ path: 'config.json', sizeBytes: modelStat.size, mtimeMs: Math.round(modelStat.mtimeMs) }],
  }));
  await assert.rejects(
    validateParakeet({
      userDataDir: root,
      lock,
      adapterId: 'parakeet-onnx-linux-cuda-v1',
      device: 'cuda',
      probeDevice: async () => ({ deviceAvailable: true, device: 'cpu' }),
    }),
    (error) => error.code === 'PARAKEET_GPU_UNAVAILABLE',
  );
  assert.equal(fs.existsSync(modelFile), true);
  assert.equal(fs.existsSync(runtimeFile), true);
  assert.equal(getStatus({
    userDataDir: root,
    lock,
    adapterId: 'parakeet-onnx-linux-cuda-v1',
  }).status, 'device-unavailable');
});

test('removal waits for pending work and does not delete recordings', async () => {
  const root = userData();
  const lock = fixtureLock();
  await setupParakeet(setupOptions(root, lock));
  const recording = path.join(root, 'recordings', 'meeting.opus');
  fs.mkdirSync(path.dirname(recording), { recursive: true });
  fs.writeFileSync(recording, 'audio');
  await assert.rejects(
    removeParakeet({
      userDataDir: root,
      lock,
      adapterId: 'parakeet-onnx-linux-cuda-v1',
      hasPendingWork: () => true,
    }),
    (error) => error.code === 'PARAKEET_SETUP_BUSY',
  );
  assert.equal(fs.existsSync(recording), true);
  let held = false;
  const release = () => { held = false; };
  held = true;
  await assert.rejects(
    removeParakeet({
      userDataDir: root,
      lock,
      adapterId: 'parakeet-onnx-linux-cuda-v1',
      reserveMutation: () => {
        if (held) {
          throw Object.assign(new Error('busy'), { code: 'PARAKEET_SETUP_BUSY' });
        }
        held = true;
        return release;
      },
    }),
    (error) => error.code === 'PARAKEET_SETUP_BUSY',
  );
  held = false;
  const removed = await removeParakeet({
    userDataDir: root,
    lock,
    adapterId: 'parakeet-onnx-linux-cuda-v1',
  });
  assert.equal(removed.status, 'not-installed');
  assert.equal(fs.readFileSync(recording, 'utf8'), 'audio');
});

test('status uses the lock inventory and requires device evidence', async () => {
  const root = userData();
  const lock = fixtureLock();
  const emptyModel = path.join(root, 'ai-addons', 'models', 'transcription', 'parakeet', lock.model.revision);
  const emptyRuntime = path.join(root, 'ai-addons', 'runtimes', 'parakeet', 'parakeet-onnx-linux-cuda-v1', lock.lockDigest);
  fs.mkdirSync(emptyModel, { recursive: true });
  fs.mkdirSync(emptyRuntime, { recursive: true });
  fs.writeFileSync(path.join(emptyModel, 'install.json'), JSON.stringify({ schemaVersion: 1, files: [] }));
  fs.writeFileSync(path.join(emptyRuntime, 'install.json'), JSON.stringify({ schemaVersion: 1, files: [] }));
  assert.equal(getStatus({
    userDataDir: root,
    lock,
    adapterId: 'parakeet-onnx-linux-cuda-v1',
    device: 'cuda',
  }).status, 'repair-required');

  await setupParakeet(setupOptions(root, lock));
  const status = getStatus({
    userDataDir: root,
    lock,
    adapterId: 'parakeet-onnx-linux-cuda-v1',
    device: 'cuda',
  });
  assert.equal(status.status, 'ready');
  const runtimeRoot = path.join(root, 'ai-addons', 'runtimes', 'parakeet', 'parakeet-onnx-linux-cuda-v1', lock.lockDigest);
  fs.rmSync(path.join(runtimeRoot, 'device.json'));
  fs.writeFileSync(path.join(runtimeRoot, 'install.json'), JSON.stringify({
    schemaVersion: 1,
    files: [{ path: 'pkg/model.bin', sizeBytes: lock.bytes.runtimeBytes.length, mtimeMs: 1 }],
  }));
  assert.equal(getStatus({
    userDataDir: root,
    lock,
    adapterId: 'parakeet-onnx-linux-cuda-v1',
    device: 'cuda',
  }).status, 'device-unavailable');
});

test('pinned VAD is promoted and hashed with the generation', async () => {
  const root = userData();
  const lock = fixtureLock();
  const vadBytes = Buffer.from('vad-bytes');
  lock.vad = {
    repository: 'istupakov/silero-vad-onnx',
    revision: 'b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6',
    files: [{ path: 'silero_vad.onnx', sizeBytes: vadBytes.length, sha256: sha256(vadBytes) }],
  };
  lock.bytes.vadBytes = vadBytes;
  await setupParakeet(setupOptions(root, lock));
  const vadFile = path.join(
    root,
    'ai-addons',
    'models',
    'transcription',
    'parakeet',
    'vad',
    lock.vad.revision,
    'silero_vad.onnx',
  );
  assert.equal(fs.readFileSync(vadFile).equals(vadBytes), true);
  fs.writeFileSync(vadFile, Buffer.from('bad-vad'));
  await assert.rejects(
    validateParakeet({
      userDataDir: root,
      lock,
      adapterId: 'parakeet-onnx-linux-cuda-v1',
      device: 'cuda',
      probeDevice: async () => ({ deviceAvailable: true, device: 'cuda' }),
    }),
    (error) => error.reason === 'checksum',
  );
});

test('a failed later promotion restores the whole previous generation', async () => {
  const root = userData();
  const lock = fixtureLock();
  await setupParakeet(setupOptions(root, lock));
  const modelRoot = path.join(root, 'ai-addons', 'models', 'transcription', 'parakeet', lock.model.revision);
  const runtimeRoot = path.join(root, 'ai-addons', 'runtimes', 'parakeet', 'parakeet-onnx-linux-cuda-v1', lock.lockDigest);
  fs.writeFileSync(path.join(modelRoot, 'sentinel.txt'), 'model');
  fs.writeFileSync(path.join(runtimeRoot, 'sentinel.txt'), 'runtime');
  const failingFs = new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'renameSync') {
        return (from, to) => {
          const promotingRuntime = String(to).includes(`${path.sep}runtimes${path.sep}`)
            && !String(to).endsWith('.previous')
            && String(from).includes(`${path.sep}staging${path.sep}`);
          if (promotingRuntime) {
            throw new Error('runtime promotion failed');
          }
          return fs.renameSync(from, to);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(
    setupParakeet(setupOptions(root, lock, {
      operation: 'repair',
      operationId: 'op-repair',
      fsModule: failingFs,
    })),
    /runtime promotion failed/,
  );
  assert.equal(fs.readFileSync(path.join(modelRoot, 'sentinel.txt'), 'utf8'), 'model');
  assert.equal(fs.readFileSync(path.join(runtimeRoot, 'sentinel.txt'), 'utf8'), 'runtime');
  assert.equal(fs.existsSync(`${modelRoot}.previous`), false);
  assert.equal(fs.existsSync(`${runtimeRoot}.previous`), false);
});

test('validation without a device probe does not report ready', async () => {
  const root = userData();
  const lock = fixtureLock();
  await setupParakeet(setupOptions(root, lock));
  await assert.rejects(
    validateParakeet({
      userDataDir: root,
      lock,
      adapterId: 'parakeet-onnx-linux-cuda-v1',
      device: 'cuda',
    }),
    (error) => error.code === 'PARAKEET_GPU_UNAVAILABLE',
  );
});

test('child env drops ambient libraries and a late child is terminated after timeout', () => {
  const env = buildParakeetChildEnv({
    backendPath: '/app/backend',
    runtimeDir: '/app/parakeet-runtime',
    platform: 'linux',
    packaged: true,
    cudaLibraryDirs: ['/verified/cuda'],
    baseEnv: {
      PATH: '/usr/bin',
      PYTHONPATH: '/evil/site-packages',
      LD_LIBRARY_PATH: '/usr/local/cuda/lib',
      HF_TOKEN: 'hf_secret',
    },
  });
  assert.equal(env.PYTHONPATH, '/app/parakeet-runtime:/app/backend');
  assert.equal(env.LD_LIBRARY_PATH, '/verified/cuda');
  assert.equal(env.HF_TOKEN, '');
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.deepEqual(windowsPthLines({
    runtimeDir: 'C:\\parakeet',
    backendDir: 'C:\\backend',
  }).slice(2, 4), ['C:\\parakeet', 'C:\\backend']);

  let terminated = false;
  const result = terminateLateRuntimeChild(
    { exitCode: null, signalCode: null },
    { timedOut: true, terminate(child) { terminated = child; } },
  );
  assert.equal(result.terminated, true);
  assert.equal(terminated.exitCode, null);
  assert.equal(terminateLateRuntimeChild({ exitCode: 0 }, { timedOut: true, terminate() {} }).terminated, false);
});
