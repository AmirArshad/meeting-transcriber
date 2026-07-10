'use strict';

/**
 * Characterization coverage for token/privacy/path-jail hardening:
 * stdin token delivery, HF env clearing, stdin-failure child kill,
 * trusted-sender assertions on mutating setup IPC, download-host key filtering,
 * and packaged tar path preference.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createAiAddonIpc } = require('../../src/main/ai-addon-ipc');
const { collectConfiguredDownloadHosts } = require('../../src/ai-addon/download-helpers');
const { resolvePreferredTarExecutable } = require('../../src/ai-addon-archive-helpers');
const { AI_MODEL_CATALOG } = require('../../src/ai-addon-state');

function createFakeValidationChild({ writeThrows = false, emitStdinError = false } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.pid = 4242;
  proc.kill = () => {
    proc.killed = true;
    return true;
  };

  const stdin = new EventEmitter();
  stdin.write = (chunk) => {
    proc._stdinWritten = String(chunk);
    if (writeThrows) {
      throw new Error('stdin write failed');
    }
    if (emitStdinError) {
      setImmediate(() => stdin.emit('error', new Error('EPIPE')));
    }
    return true;
  };
  stdin.end = () => {
    proc._stdinEnded = true;
  };
  proc.stdin = stdin;
  return proc;
}

async function waitForSpawn(spawned, timeoutMs = 1000) {
  const started = Date.now();
  while (spawned.length === 0) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for validation child spawn');
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return spawned[0];
}

function createValidationDeps(overrides = {}) {
  const spawned = [];
  const terminated = [];
  const progressEvents = [];
  const trustedSenderCalls = [];

  const deps = {
    app: {
      getPath: () => '/tmp/AvaNevis',
    },
    path,
    fs: {
      existsSync: () => false,
    },
    pythonConfig: {
      pythonExe: 'python',
      backendPath: '/tmp/backend',
    },
    spawnTrackedPython(args, options) {
      const child = createFakeValidationChild(overrides.childOptions || {});
      spawned.push({ args, options, child });
      return child;
    },
    appendSpawnLogBuffer(buffer, data) {
      return `${buffer || ''}${data}`;
    },
    sendToRenderer(channel, payload) {
      progressEvents.push({ channel, payload });
    },
    getSafeStorage: () => ({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => Buffer.from(value).toString('utf8'),
    }),
    assertTrustedRendererSender(event) {
      trustedSenderCalls.push(event);
    },
    buildCudaRuntimeEnv: () => ({}),
    createAbortableComputeAction: ({ action }) => action(),
    terminateProcessBestEffort(proc) {
      terminated.push(proc);
      if (proc && typeof proc.kill === 'function') {
        proc.kill();
      }
    },
    buildManagedDiarizationValidationArgs(modelRef, requiredDevice) {
      return ['-m', 'diarization.diarization_pipeline', '--validate', '--token-stdin', modelRef, requiredDevice];
    },
    buildSummaryArgs: () => ['summary'],
    summarizeDiarizationError: () => 'validation failed',
    summarizeSummaryValidationError: () => 'summary validation failed',
    ...overrides,
  };

  return { deps, spawned, terminated, progressEvents, trustedSenderCalls };
}

test('validateDiarizationRuntime delivers token on stdin and clears all HF token env aliases', async () => {
  const { deps, spawned } = createValidationDeps();
  const service = createAiAddonIpc(deps);

  const resultPromise = service.validateDiarizationRuntime({
    modelRef: 'pyannote/speaker-diarization-community-1',
    token: 'hf_testtoken123',
    requiredDevice: 'cuda',
  });

  const { args, options, child } = await waitForSpawn(spawned);
  assert.ok(args.includes('--token-stdin'));
  assert.equal(args.some((arg) => String(arg).includes('hf_')), false);
  assert.equal(child._stdinWritten, 'hf_testtoken123\n');
  assert.equal(options.env.HF_TOKEN, '');
  assert.equal(options.env.HUGGINGFACE_HUB_TOKEN, '');
  assert.equal(options.env.HUGGING_FACE_HUB_TOKEN, '');
  assert.ok(options.env.HF_TOKEN_PATH, 'HF_TOKEN_PATH must be set to a non-empty sentinel path');
  assert.notEqual(options.env.HF_TOKEN_PATH, '');
  assert.notEqual(options.env.HF_TOKEN_PATH, '.');
  assert.equal(options.env.HF_TOKEN_PATH, require('node:os').devNull);

  child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true })));
  child.emit('close', 0);

  await assert.doesNotReject(resultPromise);
  const result = await resultPromise;
  assert.deepEqual(result, { ok: true });
});

test('validateDiarizationRuntime terminates the child when stdin write fails', async () => {
  const { deps, spawned, terminated } = createValidationDeps({
    childOptions: { writeThrows: true },
  });
  const service = createAiAddonIpc(deps);

  await assert.rejects(
    service.validateDiarizationRuntime({
      modelRef: 'pyannote/speaker-diarization-community-1',
      token: 'hf_testtoken123',
      requiredDevice: 'cuda',
    }),
    /Failed to deliver Hugging Face token to validation process/,
  );

  assert.equal(spawned.length, 1);
  assert.equal(terminated.length, 1);
  assert.equal(terminated[0], spawned[0].child);
  assert.equal(spawned[0].child.killed, true);
});

test('validateDiarizationRuntime terminates the child on async stdin EPIPE', async () => {
  const { deps, spawned, terminated } = createValidationDeps({
    childOptions: { emitStdinError: true },
  });
  const service = createAiAddonIpc(deps);

  await assert.rejects(
    service.validateDiarizationRuntime({
      modelRef: 'pyannote/speaker-diarization-community-1',
      token: 'hf_testtoken123',
      requiredDevice: 'cuda',
    }),
    /Failed to deliver Hugging Face token/,
  );

  assert.equal(spawned.length, 1);
  assert.equal(terminated.length, 1);
  assert.equal(spawned[0].child.killed, true);
});

test('validateDiarizationRuntime reassembles progress JSON split across stderr chunks', async () => {
  const { deps, spawned, progressEvents } = createValidationDeps();
  const service = createAiAddonIpc(deps);

  const resultPromise = service.validateDiarizationRuntime({
    modelRef: 'pyannote/speaker-diarization-community-1',
    token: 'hf_testtoken123',
    requiredDevice: 'cuda',
  });

  const { child } = await waitForSpawn(spawned);
  const progressLine = `${JSON.stringify({
    type: 'progress',
    feature: 'diarization',
    phase: 'download',
    percent: 42,
    message: 'Downloading model',
  })}\n`;
  const splitAt = Math.floor(progressLine.length / 2);
  child.stderr.emit('data', Buffer.from(progressLine.slice(0, splitAt)));
  child.stderr.emit('data', Buffer.from(progressLine.slice(splitAt)));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true })));
  child.emit('close', 0);

  await resultPromise;
  assert.ok(progressEvents.some((entry) => entry.payload && entry.payload.percent === 42));
});

test('mutating token, setup, cancel, and validate IPC channels assert trusted renderer sender', async () => {
  const { deps, trustedSenderCalls } = createValidationDeps();
  deps.assertTrustedRendererSender = (event) => {
    trustedSenderCalls.push(event);
    throw new Error('TRUSTED_SENDER_ASSERTED');
  };
  const service = createAiAddonIpc(deps);
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };

  service.registerIpc(ipcMain);

  // Cancel/validate are state-mutating or enqueue compute work; keep them behind
  // the same sender trust boundary as store/setup/remove.
  const mutatingChannels = [
    'store-diarization-token',
    'delete-diarization-token',
    'setup-diarization',
    'cancel-diarization-setup',
    'validate-diarization-setup',
    'remove-diarization-setup',
    'setup-summary-model',
    'cancel-summary-model-setup',
    'validate-summary-model',
    'remove-summary-model',
  ];

  for (const channel of mutatingChannels) {
    assert.ok(handlers.has(channel), `missing handler for ${channel}`);
    await assert.rejects(
      handlers.get(channel)({ sender: { id: channel } }, {}),
      /TRUSTED_SENDER_ASSERTED/,
    );
  }

  assert.equal(trustedSenderCalls.length, mutatingChannels.length);
});

test('destructive add-on removal rejects immediately while compute is pending', async () => {
  let removalAdmissionCalls = 0;
  const { deps } = createValidationDeps({
    hasPendingAiComputeWork: () => true,
    enqueueGpuExclusiveRemovalAction: () => {
      removalAdmissionCalls += 1;
      return Promise.resolve();
    },
  });
  const service = createAiAddonIpc(deps);
  const handlers = new Map();
  service.registerIpc({ handle(channel, handler) { handlers.set(channel, handler); } });

  for (const channel of ['remove-diarization-setup', 'remove-summary-model']) {
    await assert.rejects(
      handlers.get(channel)({ sender: {} }, {}),
      (error) => error && error.code === 'AI_ADDON_REMOVE_COMPUTE_BUSY',
    );
  }
  assert.equal(removalAdmissionCalls, 0);
  assert.equal(service.aiAddonActionQueue.hasPendingWork(), false);
});

test('queued destructive removal re-checks quit before deleting files', async () => {
  let releaseAddonQueue;
  let quitCommitted = false;
  let removalAdmissionCalls = 0;
  const { deps } = createValidationDeps({
    isQuitCommitted: () => quitCommitted,
    enqueueGpuExclusiveRemovalAction: (action) => {
      removalAdmissionCalls += 1;
      return action();
    },
  });
  const service = createAiAddonIpc(deps);
  const handlers = new Map();
  service.registerIpc({ handle(channel, handler) { handlers.set(channel, handler); } });

  const blocker = service.enqueueAiAddonAction(() => new Promise((resolve) => {
    releaseAddonQueue = resolve;
  }));
  const removal = handlers.get('remove-summary-model')({ sender: {} }, {});
  await new Promise((resolve) => setImmediate(resolve));
  quitCommitted = true;
  releaseAddonQueue();
  await blocker;

  await assert.rejects(removal, (error) => error && error.code === 'QUIT_IN_PROGRESS');
  assert.equal(removalAdmissionCalls, 0);
});

test('destructive removal rejects while preload or GPU runtime owns resources', async () => {
  let removalAdmissionCalls = 0;
  const { deps } = createValidationDeps({
    hasPendingGpuResourceWork: () => true,
    enqueueGpuExclusiveRemovalAction: () => {
      removalAdmissionCalls += 1;
      return Promise.resolve();
    },
  });
  const service = createAiAddonIpc(deps);
  const handlers = new Map();
  service.registerIpc({ handle(channel, handler) { handlers.set(channel, handler); } });

  await assert.rejects(
    handlers.get('remove-summary-model')({ sender: {} }, {}),
    (error) => error && error.code === 'AI_ADDON_REMOVE_COMPUTE_BUSY',
  );
  assert.equal(removalAdmissionCalls, 0);
});

test('collectConfiguredDownloadHosts ignores licenseUrl and releaseUrl', () => {
  const hosts = collectConfiguredDownloadHosts({
    releaseUrl: 'https://evil-docs.example/releases',
    licenseUrl: 'https://evil-license.example/terms',
    downloadUrl: 'https://huggingface.co/model.gguf',
    pip: {
      indexUrl: 'https://pypi.org/simple',
      extraIndexUrls: ['https://download.pytorch.org/whl/cu126'],
      sourceArtifacts: [
        { url: 'https://files.pythonhosted.org/packages/example.whl' },
      ],
    },
  });

  assert.equal(hosts.has('huggingface.co'), true);
  assert.equal(hosts.has('pypi.org'), true);
  assert.equal(hosts.has('download.pytorch.org'), true);
  assert.equal(hosts.has('files.pythonhosted.org'), true);
  assert.equal(hosts.has('evil-docs.example'), false);
  assert.equal(hosts.has('evil-license.example'), false);
});

test('live catalog host collection still includes download and pip hosts', () => {
  const hosts = collectConfiguredDownloadHosts(AI_MODEL_CATALOG);
  assert.equal(hosts.has('github.com'), true);
  assert.equal(hosts.has('huggingface.co'), true);
  assert.equal(hosts.has('pypi.org'), true);
  assert.equal(hosts.has('files.pythonhosted.org'), true);
});

test('resolvePreferredTarExecutable prefers system tar when packaged', () => {
  assert.equal(
    resolvePreferredTarExecutable({
      platform: 'win32',
      env: { AVANEVIS_PACKAGED: '1', SystemRoot: 'C:\\Windows' },
      existsSync: () => false,
    }),
    path.join('C:\\Windows', 'System32', 'tar.exe'),
  );

  assert.equal(
    resolvePreferredTarExecutable({
      platform: 'darwin',
      env: { AVANEVIS_PACKAGED: '1' },
      existsSync: () => false,
    }),
    '/usr/bin/tar',
  );

  assert.equal(
    resolvePreferredTarExecutable({
      platform: 'darwin',
      env: {},
      existsSync: () => false,
    }),
    'tar',
  );

  assert.equal(
    resolvePreferredTarExecutable({
      platform: 'darwin',
      env: {},
      existsSync: (candidate) => candidate === '/usr/bin/tar',
    }),
    '/usr/bin/tar',
  );
});

test('resolvePreferredTarExecutable reads process.env.AVANEVIS_PACKAGED by default (production path)', () => {
  // Production callers (tar worker / archive-install) invoke with no args.
  // Main sets process.env.AVANEVIS_PACKAGED at startup when app.isPackaged so
  // workers inherit the flag — this pins that default-arg path, not an explicit env override.
  const previousPackaged = process.env.AVANEVIS_PACKAGED;
  const previousSystemRoot = process.env.SystemRoot;
  try {
    process.env.AVANEVIS_PACKAGED = '1';
    process.env.SystemRoot = 'E:\\Windows';

    assert.equal(
      resolvePreferredTarExecutable({
        platform: 'win32',
        existsSync: () => false,
      }),
      path.join('E:\\Windows', 'System32', 'tar.exe'),
    );

    assert.equal(
      resolvePreferredTarExecutable({
        platform: 'darwin',
        existsSync: () => false,
      }),
      '/usr/bin/tar',
    );

    delete process.env.AVANEVIS_PACKAGED;
    assert.equal(
      resolvePreferredTarExecutable({
        platform: 'win32',
        existsSync: () => false,
      }),
      'tar',
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
test('main.js sets process.env.AVANEVIS_PACKAGED when app.isPackaged (worker inheritance)', () => {
  const fs = require('node:fs');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  assert.match(
    mainSource,
    /if\s*\(\s*app\.isPackaged\s*\)\s*\{\s*process\.env\.AVANEVIS_PACKAGED\s*=\s*['"]1['"]\s*;?\s*\}/s,
  );
});

test('main-process sources never assign HF_TOKEN_PATH to an empty string', () => {
  const {
    collectJsFiles,
    readUtf8,
    ROOT,
    SRC_ROOT,
    toPosix,
  } = require('./source-scan-helpers');

  const scanRoots = [
    path.join(SRC_ROOT, 'main.js'),
    ...collectJsFiles(path.join(SRC_ROOT, 'main')),
    ...collectJsFiles(path.join(SRC_ROOT, 'main-process')),
  ];
  const emptyTokenPath = /HF_TOKEN_PATH\s*:\s*['"]['"]/;
  const offenders = [];

  for (const filePath of scanRoots) {
    const source = readUtf8(filePath);
    if (emptyTokenPath.test(source)) {
      offenders.push(toPosix(path.relative(ROOT, filePath)));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `HF_TOKEN_PATH: '' breaks offline pyannote loads; use buildClearedHuggingFaceTokenEnv(). Offenders: ${offenders.join(', ')}`,
  );
});
