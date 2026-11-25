'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const { createAiAddonIpc } = require('../../src/main/ai-addon-ipc');
const { createAsyncActionQueue } = require('../../src/main/ai-compute-queue');
const { createSummaryProcessSlot } = require('../../src/main/summary-process-slot');

const GiB = 1024 ** 3;
const READY_LINUX_CUDA = {
  statusCode: 'ready',
  installed: true,
  deviceAvailable: true,
  runtimeLoadable: true,
  missingLibraries: [],
  matchedProfile: 'cuda12',
};

function withPlatform(platform, arch, fn) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
      if (originalArch) Object.defineProperty(process, 'arch', originalArch);
    });
}

function createTempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-ai-addon-ipc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function registerHandlers(overrides = {}, userDataDir = '/tmp/avanevis-ipc-test') {
  const handlers = new Map();
  const events = [];
  const deps = {
    app: { getPath: () => userDataDir },
    path,
    fs,
    pythonConfig: { pythonExe: 'python3', backendPath: '/tmp/backend' },
    spawnTrackedPython: () => {
      throw new Error('spawnTrackedPython should not run in this test');
    },
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    sendToRenderer: (channel, payload) => events.push({ channel, payload }),
    getSafeStorage: () => ({ isEncryptionAvailable: () => false }),
    assertTrustedRendererSender: () => {},
    buildCudaRuntimeEnv: (extra) => ({ ...extra }),
    createAbortableComputeAction: ({ action }) => action(),
    terminateProcessBestEffort: () => {},
    buildManagedDiarizationValidationArgs: () => [],
    buildSummaryArgs: () => [],
    summarizeDiarizationError: (out) => out,
    summarizeSummaryValidationError: (out) => out,
    getCachedCudaStatus: () => READY_LINUX_CUDA,
    resolveCudaStatusForTranscription: async () => READY_LINUX_CUDA,
    getSummaryDeviceMemory: async () => ({ totalBytes: 12 * GiB, availableBytes: 11 * GiB }),
    getResidentSummaryModelState: () => ({ status: 'unloaded', modelId: null, modelName: null }),
    releaseSummaryModel: async () => {},
    ...overrides,
  };
  const service = createAiAddonIpc(deps);
  service.registerIpc({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });
  return { service, handlers, events };
}

test('setup-summary-model, validate-summary-model, and set-default-summary-model throw SUMMARY_MODEL_LOADED_IN_MEMORY when blocked solely by resident model VRAM', async (t) => {
  await withPlatform('linux', 'x64', async () => {
    const userDataDir = createTempUserData(t);
    let releaseCalls = 0;
    const residentState = {
      status: 'loaded',
      modelId: 'qwen3.5-9b-q4-k-m',
      modelName: 'Qwen3.5 9B',
    };
    const lowFreeVram = { totalBytes: 12 * GiB, availableBytes: 2 * GiB };

    const { handlers } = registerHandlers({
      getResidentSummaryModelState: () => residentState,
      getSummaryDeviceMemory: async () => lowFreeVram,
      releaseSummaryModel: async () => {
        releaseCalls += 1;
      },
      checkAiAddonSetupStatus: async ({ summaryModelId, deviceMemory }) => {
        const { getSummaryModelFit } = require('../../src/ai-addon/summary-device-fit');
        const { getModelById, getSummaryArtifactForPlatform, getSummaryRuntimeArtifactForPlatform, getSummaryAvailability } = require('../../src/ai-addon-state');
        const targetId = summaryModelId || 'gemma-4-12b';
        const fit = getSummaryModelFit({
          model: getModelById('summary', targetId),
          artifact: getSummaryArtifactForPlatform(targetId, 'linux', 'x64'),
          runtimeArtifact: getSummaryRuntimeArtifactForPlatform('linux', 'x64', undefined, targetId),
          availability: getSummaryAvailability('linux', 'x64', { cudaStatus: READY_LINUX_CUDA }),
          deviceMemory,
          platform: 'linux',
        });
        return {
          features: {
            summary: {
              modelId: targetId,
              setupComplete: true,
              status: 'ready',
              fit,
            },
          },
          summaryLibrary: { defaultModelId: 'qwen3.5-9b-q4-k-m', models: [] },
        };
      },
    }, userDataDir);

    for (const channel of ['setup-summary-model', 'validate-summary-model', 'set-default-summary-model']) {
      await assert.rejects(
        () => handlers.get(channel)({ sender: {} }, { modelId: 'gemma-4-12b' }),
        (error) => error
          && error.code === 'SUMMARY_MODEL_LOADED_IN_MEMORY'
          && error.loadedModelId === 'qwen3.5-9b-q4-k-m'
          && error.loadedModelName === 'Qwen3.5 9B',
        channel,
      );
    }
    assert.equal(releaseCalls, 0);
  });
});

test('total VRAM shortfall does not throw SUMMARY_MODEL_LOADED_IN_MEMORY even when a Chat model is loaded', async (t) => {
  await withPlatform('linux', 'x64', async () => {
    const userDataDir = createTempUserData(t);
    const { handlers } = registerHandlers({
      getResidentSummaryModelState: () => ({
        status: 'loaded',
        modelId: 'qwen3.5-4b-q4-k-m',
        modelName: 'Qwen3.5 4B',
      }),
      getSummaryDeviceMemory: async () => ({ totalBytes: 6 * GiB, availableBytes: 2 * GiB }),
    }, userDataDir);

    await assert.rejects(
      () => handlers.get('setup-summary-model')({ sender: {} }, { modelId: 'gemma-4-12b' }),
      (error) => error
        && error.code !== 'SUMMARY_MODEL_LOADED_IN_MEMORY'
        && /more graphics memory/i.test(error.message),
    );
  });
});

test('unloadLoadedModel: true releases the resident model before live VRAM probe in setup, validate, and set-default', async (t) => {
  await withPlatform('linux', 'x64', async () => {
    const userDataDir = createTempUserData(t);
    const manifestDir = path.join(userDataDir, 'ai-addons');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({
      version: 1,
      features: {
        summary: { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' },
      },
      summaryLibrary: {
        defaultModelId: 'qwen3.5-9b-q4-k-m',
        models: {
          'qwen3.5-9b-q4-k-m': { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' },
          'gemma-4-12b': { status: 'ready', modelId: 'gemma-4-12b' },
        },
      },
    }));

    const callOrder = [];
    let residentLoaded = true;
    const { handlers } = registerHandlers({
      getResidentSummaryModelState: () => (
        residentLoaded
          ? { status: 'loaded', modelId: 'qwen3.5-9b-q4-k-m', modelName: 'Qwen3.5 9B' }
          : { status: 'unloaded', modelId: null, modelName: null }
      ),
      releaseSummaryModel: async (reason) => {
        callOrder.push(`release:${reason}`);
        residentLoaded = false;
      },
      getSummaryDeviceMemory: async ({ live }) => {
        callOrder.push(`memory:live=${Boolean(live)}:loaded=${residentLoaded}`);
        return residentLoaded
          ? { totalBytes: 12 * GiB, availableBytes: 2 * GiB }
          : { totalBytes: 12 * GiB, availableBytes: 11.5 * GiB };
      },
      checkAiAddonSetupStatus: async ({ summaryModelId, deviceMemory }) => ({
        features: {
          summary: {
            modelId: summaryModelId || 'gemma-4-12b',
            setupComplete: true,
            status: 'ready',
            fit: { status: 'likely_fits', blocked: false, availableMemoryBytes: deviceMemory?.availableBytes ?? null },
          },
        },
        summaryLibrary: { defaultModelId: 'gemma-4-12b', models: [] },
      }),
    }, userDataDir);

    // 1. set-default-summary-model
    const defaultResult = await handlers.get('set-default-summary-model')(
      { sender: {} },
      { modelId: 'gemma-4-12b', unloadLoadedModel: true },
    );
    assert.equal(defaultResult.features.summary.fit.availableMemoryBytes, 11.5 * GiB);
    assert.deepEqual(callOrder.slice(0, 2), [
      'release:summary_model_setup',
      'memory:live=true:loaded=false',
    ]);

    // 2. validate-summary-model (manifest has no downloaded weights on disk, returns notConfigured with post-unload VRAM)
    callOrder.length = 0;
    residentLoaded = true;
    const validateResult = await handlers.get('validate-summary-model')(
      { sender: {} },
      { modelId: 'gemma-4-12b', unloadLoadedModel: true },
    );
    assert.equal(callOrder[0], 'release:summary_model_setup');
    assert.equal(callOrder[1], 'memory:live=true:loaded=false');
    assert.equal(validateResult.summaryLibrary.models.find((m) => m.modelId === 'gemma-4-12b').fit.availableMemoryBytes, 11.5 * GiB);
  });
});

test('SUMMARY_MODEL_EXIT_UNCONFIRMED blocks setup, validate, and set-default before VRAM probe', async (t) => {
  await withPlatform('linux', 'x64', async () => {
    const userDataDir = createTempUserData(t);
    const slot = createSummaryProcessSlot({
      platform: 'linux',
      kill: () => {},
      releaseTimeoutMs: 5,
      pollMs: 1,
    });
    const stuckProc = new EventEmitter();
    stuckProc.pid = 999999;
    stuckProc.avanevisProcessGroup = true;
    slot.spawnModel(() => stuckProc);

    let memoryProbeCalls = 0;
    const { handlers } = registerHandlers({
      releaseSummaryModel: async () => {
        await slot.ensureExited();
      },
      getSummaryDeviceMemory: async () => {
        memoryProbeCalls += 1;
        return { totalBytes: 12 * GiB, availableBytes: 11 * GiB };
      },
    }, userDataDir);

    for (const channel of ['setup-summary-model', 'validate-summary-model', 'set-default-summary-model']) {
      await assert.rejects(
        () => handlers.get(channel)({ sender: {} }, { modelId: 'gemma-4-12b', unloadLoadedModel: true }),
        (error) => error && error.code === 'SUMMARY_MODEL_EXIT_UNCONFIRMED',
        channel,
      );
    }
    assert.equal(memoryProbeCalls, 0);
  });
});

test('confirmed summary admission waits for active GPU work and holds the queue through the fresh probe', async () => {
  const gpuQueue = createAsyncActionQueue();
  const activeJob = Promise.withResolvers();
  const calls = [];
  void gpuQueue.enqueue(() => activeJob.promise);
  const { handlers } = registerHandlers({
    enqueueGpuResourceAction: gpuQueue.enqueue,
    releaseSummaryModel: async () => { calls.push('release'); },
    getSummaryDeviceMemory: async ({ fresh }) => {
      calls.push(fresh ? 'fresh probe' : 'shared probe');
      throw new Error('stop after probe');
    },
  });
  const operation = handlers.get('set-default-summary-model')({}, { modelId: 'gemma-4-12b', unloadLoadedModel: true });
  const result = assert.rejects(operation, /stop after probe/);
  try {
    await new Promise(setImmediate);
    assert.deepEqual(calls, []);
  } finally {
    activeJob.resolve();
    await result;
  }
  assert.deepEqual(calls, ['release', 'fresh probe']);
});

test('validation preserves exit failure on cancel and skips probes if quit commits during release', async () => {
  const release = Promise.withResolvers();
  const started = Promise.withResolvers();
  let quitting = false;
  let probes = 0;
  const { handlers } = registerHandlers({
    isQuitCommitted: () => quitting,
    releaseSummaryModel: () => {
      started.resolve();
      return release.promise;
    },
    getSummaryDeviceMemory: async () => { probes += 1; },
    checkAiAddonSetupStatus: async () => ({}),
  });
  const options = { modelId: 'gemma-4-12b', unloadLoadedModel: true };
  const validation = handlers.get('validate-summary-model')({}, options);
  await started.promise;
  await handlers.get('cancel-summary-model-setup')({});
  const failure = assert.rejects(validation, { code: 'SUMMARY_MODEL_EXIT_UNCONFIRMED' });
  release.reject(Object.assign(new Error('exit unconfirmed'), { code: 'SUMMARY_MODEL_EXIT_UNCONFIRMED' }));
  await failure;
  assert.equal(probes, 0);

  const quitHandlers = registerHandlers({
    isQuitCommitted: () => quitting,
    releaseSummaryModel: async () => { quitting = true; },
    getSummaryDeviceMemory: async () => { probes += 1; },
  }).handlers;
  await assert.rejects(quitHandlers.get('set-default-summary-model')({}, options), /quitting/);
  assert.equal(probes, 0);
});

test('a fresh VRAM read replaces an in-flight pre-unload probe', async () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const probes = [];
  const ctx = vm.createContext({
    os: { totalmem: () => 0, freemem: () => 0 },
    process: { platform: 'linux', env: {} },
    fs: { existsSync: () => true },
    isQuitCommitted: () => false,
    parseNvidiaMemory: (availableBytes) => ({ availableBytes }),
    execFile: (_file, _args, _options, done) => { probes.push(done); },
  });
  vm.runInContext(mainSource.slice(mainSource.indexOf('let summaryDeviceMemoryProbe'), mainSource.indexOf('function spawnSummaryPython')), ctx);
  const stale = ctx.getSummaryDeviceMemory({ live: true });
  const fresh = ctx.getSummaryDeviceMemory({ live: true, fresh: true });
  assert.equal(probes.length, 1);
  probes[0](null, 2 * GiB);
  assert.equal((await stale).availableBytes, 2 * GiB);
  assert.equal(probes.length, 2);
  probes[1](null, 11 * GiB);
  assert.equal((await fresh).availableBytes, 11 * GiB);
});

test('quit-drain safety and unknown modelId prevent unloading a resident model', async (t) => {
  await withPlatform('linux', 'x64', async () => {
    const userDataDir = createTempUserData(t);
    let releaseCalls = 0;
    let quitCommitted = true;
    const { handlers } = registerHandlers({
      isQuitCommitted: () => quitCommitted,
      releaseSummaryModel: async () => {
        releaseCalls += 1;
      },
    }, userDataDir);

    await assert.rejects(
      () => handlers.get('setup-summary-model')({ sender: {} }, { modelId: 'gemma-4-12b', unloadLoadedModel: true }),
      (error) => error && error.code === 'QUIT_IN_PROGRESS',
    );
    await assert.rejects(
      () => handlers.get('validate-summary-model')({ sender: {} }, { modelId: 'gemma-4-12b', unloadLoadedModel: true }),
      (error) => error && error.code === 'QUIT_IN_PROGRESS',
    );
    await assert.rejects(
      () => handlers.get('set-default-summary-model')({ sender: {} }, { modelId: 'gemma-4-12b', unloadLoadedModel: true }),
      /quitting/i,
    );
    assert.equal(releaseCalls, 0);

    quitCommitted = false;
    for (const channel of ['setup-summary-model', 'validate-summary-model', 'set-default-summary-model']) {
      await assert.rejects(
        () => handlers.get(channel)({ sender: {} }, { modelId: 'does-not-exist', unloadLoadedModel: true }),
        /Unknown summary model/,
        channel,
      );
    }
    assert.equal(releaseCalls, 0);
  });
});

test('renderer Settings prompts to unload loaded model, retries on SUMMARY_MODEL_LOADED_IN_MEMORY, and syncs state on unload', async () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/app.js'), 'utf8');
  const makeElement = (tag = 'div') => ({
    tag,
    className: '',
    children: [],
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    textContent: '',
    attributes: {},
    isConnected: true,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren(...items) {
      this.children = [...items];
    },
    remove() {
      this.removed = true;
      const idx = document.body.children.indexOf(this);
      if (idx >= 0) document.body.children.splice(idx, 1);
    },
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    addEventListener(type, fn) {
      this[type] = fn;
    },
    focus() {
      document.activeElement = this;
    },
  });

  const container = makeElement('div');
  const created = [];
  const document = {
    activeElement: null,
    body: makeElement('body'),
    createElement: (tag) => {
      const el = makeElement(tag);
      created.push(el);
      return el;
    },
    getElementById: (id) => (id === 'summary-model-library' ? container : null),
  };

  const calls = [];
  const toasts = [];
  let unloadCalls = 0;
  let setupShouldThrowLoadedOnce = false;
  const ctx = vm.createContext({
    document,
    aiAddonDownloadState: { summary: { active: false } },
    aiAddonStatusSnapshot: null,
    aiAddonStatusRefreshPromise: null,
    chatState: {
      modelState: { status: 'loaded', modelId: 'qwen3.5-9b-q4-k-m', modelName: 'Qwen3.5 9B' },
    },
    formatBytes: (n) => `${n} B`,
    usableSummaryModels: (lib) => (lib?.models || []).filter((m) => m.installed && m.setupComplete && m.status === 'ready' && m.fit?.blocked !== true),
    setAiAddonProgressState: () => {},
    hideAiAddonProgressSoon: () => {},
    updateAiAddonSettings: () => {},
    updateHomeAiAddonCTA: () => {},
    refreshChatEligibility: async () => {},
    showAppToast: (message, tone) => toasts.push({ message, tone }),
    window: {
      confirm: () => true,
      electronAPI: {
        setupSummaryModel: async (opts) => {
          calls.push(['setup', opts]);
          if (setupShouldThrowLoadedOnce && !opts.unloadLoadedModel) {
            setupShouldThrowLoadedOnce = false;
            const err = new Error('Qwen3.5 9B is currently loaded in memory. [SUMMARY_MODEL_LOADED_IN_MEMORY:qwen3.5-9b-q4-k-m]');
            err.code = 'SUMMARY_MODEL_LOADED_IN_MEMORY';
            err.loadedModelId = 'qwen3.5-9b-q4-k-m';
            throw err;
          }
          return { ok: true };
        },
        validateSummaryModel: async (opts) => {
          calls.push(['validate', opts]);
          return { ok: true };
        },
        setDefaultSummaryModel: async (opts) => {
          calls.push(['setDefault', opts]);
          return { ok: true };
        },
        unloadHistoryQaModel: async () => {
          unloadCalls += 1;
          return { unloaded: true };
        },
        getAiAddonStatus: async () => ({
          summaryLibrary: library,
        }),
      },
    },
  });

  vm.runInContext(
    appSource.slice(appSource.indexOf('function summaryModelHasFiles('), appSource.indexOf('function chooseSummaryReplacement(')),
    ctx,
  );
  vm.runInContext(appSource.slice(appSource.indexOf('async function refreshAiAddonSettings('), appSource.indexOf('async function refreshHomeAiAddonPrompt(')), ctx);

  const library = {
    defaultModelId: 'qwen3.5-9b-q4-k-m',
    availableBytes: 50 * GiB,
    models: [
      {
        modelId: 'qwen3.5-9b-q4-k-m',
        modelName: 'Qwen3.5 9B',
        installed: true,
        setupComplete: true,
        status: 'ready',
        installedBytes: 6 * GiB,
        fit: { status: 'likely_fits', blocked: false },
      },
      {
        modelId: 'gemma-4-12b',
        modelName: 'Gemma 4 12B',
        installed: false,
        setupComplete: false,
        status: 'notConfigured',
        downloadBytes: 7 * GiB,
        peakFreeBytes: 8 * GiB,
        fit: {
          status: 'needs_more_memory',
          blocked: true,
          memoryType: 'graphics memory',
          totalMemoryBytes: 12 * GiB,
          availableMemoryBytes: 2 * GiB,
          minimumRuntimeBytes: 8 * GiB,
        },
      },
    ],
  };

  // Download button is NOT permanently disabled when blocked solely by AvaNevis's own loaded model.
  ctx.renderSummaryModelLibrary(library);
  const downloadBtn = created.find((el) => el.tag === 'button' && el.textContent === 'Download');
  assert.ok(downloadBtn);
  assert.equal(downloadBtn.disabled, false);

  // Clicking Download opens "Unload loaded model?" modal and passes unloadLoadedModel: true on confirm.
  const downloadPromise = downloadBtn.click();
  await new Promise((resolve) => setImmediate(resolve));
  const overlay = document.body.children[0];
  assert.ok(overlay);
  const dialog = overlay.children[0];
  assert.equal(dialog.children[0].children[0].textContent, 'Unload loaded model?');
  assert.equal(
    dialog.children[1].children[0].textContent,
    '“Qwen3.5 9B” is currently loaded in memory. Unload it to free graphics memory and continue with “Gemma 4 12B”?',
  );
  const [cancelBtn, unloadContinueBtn] = dialog.children[2].children;
  assert.equal(cancelBtn.textContent, 'Cancel');
  assert.equal(unloadContinueBtn.textContent, 'Unload & Continue');
  unloadContinueBtn.onclick();
  await downloadPromise;
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['setup', { modelId: 'gemma-4-12b', unloadLoadedModel: true }]]);

  // Cancel on "Unload loaded model?" aborts without calling setupSummaryModel.
  calls.length = 0;
  const cancelDownloadPromise = downloadBtn.click();
  await new Promise((resolve) => setImmediate(resolve));
  const cancelOverlay = document.body.children[0];
  assert.ok(cancelOverlay);
  cancelOverlay.children[0].children[2].children[0].onclick();
  await cancelDownloadPromise;
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), []);

  // Stale renderer state: catches SUMMARY_MODEL_LOADED_IN_MEMORY and offers the same Unload & Continue prompt.
  calls.length = 0;
  created.length = 0;
  ctx.chatState.modelState = { status: 'unloaded', modelId: null, modelName: null };
  library.models[1].fit.blocked = false;
  setupShouldThrowLoadedOnce = true;
  ctx.renderSummaryModelLibrary(library);
  const staleDownloadBtn = created.find((el) => el.tag === 'button' && el.textContent === 'Download');
  const stalePromise = staleDownloadBtn.click();
  await new Promise((resolve) => setImmediate(resolve));
  const retryOverlay = document.body.children[0];
  assert.ok(retryOverlay);
  assert.equal(retryOverlay.children[0].children[0].children[0].textContent, 'Unload loaded model?');
  retryOverlay.children[0].children[2].children[1].onclick();
  await stalePromise;
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['setup', { modelId: 'gemma-4-12b' }],
    ['setup', { modelId: 'gemma-4-12b', unloadLoadedModel: true }],
  ]);
  assert.equal(toasts.length, 0);

  // Set as default and Check setup also prompt to unload when another model is loaded.
  calls.length = 0;
  created.length = 0;
  ctx.chatState.modelState = { status: 'loaded', modelId: 'qwen3.5-9b-q4-k-m', modelName: 'Qwen3.5 9B' };
  const installedLibrary = {
    defaultModelId: 'qwen3.5-9b-q4-k-m',
    availableBytes: 50 * GiB,
    models: [
      library.models[0],
      {
        modelId: 'gemma-4-12b',
        modelName: 'Gemma 4 12B',
        installed: true,
        setupComplete: true,
        status: 'ready',
        installedBytes: 7 * GiB,
        fit: {
          status: 'needs_more_memory',
          blocked: true,
          memoryType: 'graphics memory',
          totalMemoryBytes: 12 * GiB,
          availableMemoryBytes: 2 * GiB,
          minimumRuntimeBytes: 8 * GiB,
        },
      },
    ],
  };
  ctx.renderSummaryModelLibrary(installedLibrary);
  const setDefaultBtn = created.find((el) => el.tag === 'button' && el.textContent === 'Set as default');
  assert.ok(setDefaultBtn);
  assert.equal(setDefaultBtn.disabled, false);
  const setDefaultPromise = setDefaultBtn.click();
  await new Promise((resolve) => setImmediate(resolve));
  document.body.children[0].children[0].children[2].children[1].onclick();
  await setDefaultPromise;

  const checkSetupButtons = created.filter((el) => el.tag === 'button' && el.textContent === 'Check setup');
  const gemmaCheckSetupBtn = checkSetupButtons[1];
  assert.ok(gemmaCheckSetupBtn);
  const checkSetupPromise = gemmaCheckSetupBtn.click();
  await new Promise((resolve) => setImmediate(resolve));
  document.body.children[0].children[0].children[2].children[1].onclick();
  await checkSetupPromise;
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ['setDefault', { modelId: 'gemma-4-12b', unloadLoadedModel: true }],
    ['validate', { modelId: 'gemma-4-12b', unloadLoadedModel: true }],
  ]);

  // Settings "Free memory" clears summaryDeviceCheckSnapshot.
  created.length = 0;
  ctx.chatState.modelState = { status: 'loaded', modelId: 'qwen3.5-9b-q4-k-m', modelName: 'Qwen3.5 9B' };
  ctx.renderSummaryModelLibrary(library);
  await created.find((el) => el.tag === 'button' && el.textContent === 'Check this device').click();
  assert.notEqual(vm.runInContext('summaryDeviceCheckSnapshot', ctx), null);
  created.length = 0;
  ctx.renderSummaryModelLibrary(library);
  await created.find((el) => el.tag === 'button' && el.textContent === 'Free memory').click();
  assert.equal(unloadCalls, 1);
  assert.equal(vm.runInContext('summaryDeviceCheckSnapshot', ctx), null);

  // Both status requests started before Free memory must lose to the new refresh.
  const staleCheck = Promise.withResolvers();
  const staleRefresh = Promise.withResolvers();
  const freshStatus = { summaryLibrary: { ...library, models: [] } };
  let settingsReads = 0;
  ctx.window.electronAPI.getAiAddonStatus = ({ checkDevice }) => {
    if (checkDevice) return staleCheck.promise;
    settingsReads += 1;
    return settingsReads === 1 ? staleRefresh.promise : Promise.resolve(freshStatus);
  };
  created.length = 0;
  ctx.renderSummaryModelLibrary(library);
  const checking = created.find((el) => el.textContent === 'Check this device').click();
  const refreshing = ctx.refreshAiAddonSettings();
  const unloading = created.find((el) => el.textContent === 'Free memory').click();
  try {
    await new Promise(setImmediate);
    assert.equal(settingsReads, 2);
  } finally {
    staleCheck.resolve({ summaryLibrary: library });
    staleRefresh.resolve({ summaryLibrary: library });
    await Promise.all([checking, refreshing, unloading]);
  }
  assert.equal(ctx.aiAddonStatusSnapshot, freshStatus);
  assert.equal(vm.runInContext('summaryDeviceCheckSnapshot', ctx), null);

  // onHistoryQaModelState clears summaryDeviceCheckSnapshot and calls refreshAiAddonSettings on unload transition.
  let modelStateListener = null;
  let chatRefreshCount = 0;
  const chatCtx = vm.createContext({
    document: { getElementById: () => null },
    chatState: {
      listenersBound: false,
      modelState: { status: 'loaded', modelId: 'qwen3.5-9b-q4-k-m', modelName: 'Qwen3.5 9B' },
      sending: false,
    },
    summaryDeviceCheckSnapshot: new Map([['gemma-4-12b', { fit: { status: 'needs_more_memory' } }]]),
    summaryDeviceCheckGeneration: 0,
    aiAddonStatusRefreshPromise: null,
    summaryLibrary: () => library,
    registerCleanup: () => {},
    renderChatModelPill: () => {},
    renderSummaryModelLibrary: () => {},
    refreshAiAddonSettings: async () => {
      chatRefreshCount += 1;
    },
    syncChatProgressBanner: () => {},
    window: {
      electronAPI: {
        onHistoryQaModelState: (cb) => {
          modelStateListener = cb;
          return () => {};
        },
      },
    },
  });
  const onStateStart = appSource.indexOf('if (window.electronAPI && typeof window.electronAPI.onHistoryQaModelState');
  const onStateEnd = appSource.indexOf('if (window.electronAPI && typeof window.electronAPI.onHistoryQaProgress', onStateStart);
  const unloadSyncStart = appSource.indexOf('function onSummaryModelUnloaded(');
  if (unloadSyncStart !== -1) {
    vm.runInContext(appSource.slice(unloadSyncStart, appSource.indexOf('async function unloadSummaryModelFromUi(', unloadSyncStart)), chatCtx);
  }
  vm.runInContext(appSource.slice(onStateStart, onStateEnd), chatCtx);
  assert.equal(typeof modelStateListener, 'function');

  // loaded -> unloading -> unloaded must clear snapshot and refresh settings.
  modelStateListener({ status: 'unloading', modelId: 'qwen3.5-9b-q4-k-m', modelName: 'Qwen3.5 9B' });
  assert.equal(chatRefreshCount, 0);
  modelStateListener({ status: 'unloaded', modelId: null, modelName: null });
  assert.equal(chatCtx.summaryDeviceCheckSnapshot, null);
  assert.equal(chatRefreshCount, 1);

  // Direct loaded -> unloaded also clears snapshot and refreshes settings.
  chatCtx.chatState.modelState = { status: 'loaded', modelId: 'qwen3.5-9b-q4-k-m', modelName: 'Qwen3.5 9B' };
  chatCtx.summaryDeviceCheckSnapshot = new Map([['gemma-4-12b', { fit: {} }]]);
  modelStateListener({ status: 'unloaded', modelId: null, modelName: null });
  assert.equal(chatCtx.summaryDeviceCheckSnapshot, null);
  assert.equal(chatRefreshCount, 2);
});

test('set-default-summary-model probes managed CUDA when Linux cache is cold', async (t) => {
  await withPlatform('linux', 'x64', async () => {
    const userDataDir = createTempUserData(t);
    const manifestDir = path.join(userDataDir, 'ai-addons');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({
      version: 1,
      features: {
        summary: { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' },
      },
      summaryLibrary: {
        defaultModelId: 'qwen3.5-9b-q4-k-m',
        models: {
          'qwen3.5-9b-q4-k-m': { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' },
          'qwen3.5-4b-q4-k-m': { status: 'ready', modelId: 'qwen3.5-4b-q4-k-m' },
        },
      },
    }));

    let cudaProbeCalls = 0;
    const statusCudaInputs = [];
    const { handlers } = registerHandlers({
      getCachedCudaStatus: () => null,
      resolveCudaStatusForTranscription: async () => {
        cudaProbeCalls += 1;
        return READY_LINUX_CUDA;
      },
      getSummaryDeviceMemory: async () => ({ totalBytes: 12 * GiB, availableBytes: 11 * GiB }),
      checkAiAddonSetupStatus: async ({ summaryModelId, cudaStatus, deviceMemory }) => {
        statusCudaInputs.push(cudaStatus);
        const { getSummaryModelFit } = require('../../src/ai-addon/summary-device-fit');
        const { getModelById, getSummaryArtifactForPlatform, getSummaryRuntimeArtifactForPlatform, getSummaryAvailability } = require('../../src/ai-addon-state');
        const targetId = summaryModelId || 'qwen3.5-4b-q4-k-m';
        const availability = getSummaryAvailability('linux', 'x64', { cudaStatus });
        const fit = getSummaryModelFit({
          model: getModelById('summary', targetId),
          artifact: getSummaryArtifactForPlatform(targetId, 'linux', 'x64'),
          runtimeArtifact: getSummaryRuntimeArtifactForPlatform('linux', 'x64', undefined, targetId),
          availability,
          deviceMemory,
          platform: 'linux',
        });
        return {
          features: {
            summary: {
              modelId: targetId,
              setupComplete: true,
              status: 'ready',
              fit,
            },
          },
          summaryLibrary: { defaultModelId: targetId, models: [] },
        };
      },
    }, userDataDir);

    const result = await handlers.get('set-default-summary-model')(
      { sender: {} },
      { modelId: 'qwen3.5-4b-q4-k-m' },
    );
    assert.equal(cudaProbeCalls, 1);
    assert.deepEqual(statusCudaInputs, [READY_LINUX_CUDA, READY_LINUX_CUDA]);
    assert.equal(result.features.summary.fit.blocked, false);
    assert.equal(result.summaryLibrary.defaultModelId, 'qwen3.5-4b-q4-k-m');
  });
});

test('set-default-summary-model preserves residentModelId on returned status when setting a smaller model while another model is loaded', async (t) => {
  await withPlatform('linux', 'x64', async () => {
    const userDataDir = createTempUserData(t);
    const manifestDir = path.join(userDataDir, 'ai-addons');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({
      version: 1,
      features: {
        summary: { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' },
      },
      summaryLibrary: {
        defaultModelId: 'qwen3.5-9b-q4-k-m',
        models: {
          'qwen3.5-9b-q4-k-m': { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' },
          'qwen3.5-4b-q4-k-m': { status: 'ready', modelId: 'qwen3.5-4b-q4-k-m' },
          'gemma-4-12b': { status: 'ready', modelId: 'gemma-4-12b' },
        },
      },
    }));

    const statusDeviceMemories = [];
    const { handlers } = registerHandlers({
      getResidentSummaryModelState: () => ({
        status: 'loaded',
        modelId: 'qwen3.5-9b-q4-k-m',
        modelName: 'Qwen3.5 9B',
      }),
      getSummaryDeviceMemory: async () => ({ totalBytes: 12 * GiB, availableBytes: 5 * GiB }),
      checkAiAddonSetupStatus: async ({ summaryModelId, cudaStatus, deviceMemory }) => {
        statusDeviceMemories.push(deviceMemory);
        const { getSummaryModelFit } = require('../../src/ai-addon/summary-device-fit');
        const { getModelById, getSummaryArtifactForPlatform, getSummaryRuntimeArtifactForPlatform, getSummaryAvailability } = require('../../src/ai-addon-state');
        const availability = getSummaryAvailability('linux', 'x64', { cudaStatus });
        const buildFit = (id) => getSummaryModelFit({
          model: getModelById('summary', id),
          artifact: getSummaryArtifactForPlatform(id, 'linux', 'x64'),
          runtimeArtifact: getSummaryRuntimeArtifactForPlatform('linux', 'x64', undefined, id),
          availability,
          deviceMemory,
          platform: 'linux',
        });
        const activeId = summaryModelId || 'qwen3.5-4b-q4-k-m';
        return {
          features: {
            summary: {
              modelId: activeId,
              setupComplete: true,
              status: 'ready',
              fit: buildFit(activeId),
            },
          },
          summaryLibrary: {
            defaultModelId: activeId,
            models: ['qwen3.5-4b-q4-k-m', 'qwen3.5-9b-q4-k-m', 'gemma-4-12b'].map((id) => ({
              modelId: id,
              setupComplete: true,
              status: 'ready',
              fit: buildFit(id),
            })),
          },
        };
      },
    }, userDataDir);

    const result = await handlers.get('set-default-summary-model')(
      { sender: {} },
      { modelId: 'qwen3.5-4b-q4-k-m' },
    );
    assert.equal(statusDeviceMemories.length, 2);
    assert.equal(statusDeviceMemories[0].residentModelId, undefined);
    assert.equal(statusDeviceMemories[1].residentModelId, 'qwen3.5-9b-q4-k-m');
    assert.equal(statusDeviceMemories[1].residentModelName, 'Qwen3.5 9B');
    assert.equal(result.features.summary.fit.residentModelId, 'qwen3.5-9b-q4-k-m');
    assert.equal(result.features.summary.fit.residentModelName, 'Qwen3.5 9B');
    const gemma = result.summaryLibrary.models.find((m) => m.modelId === 'gemma-4-12b');
    assert.equal(gemma.fit.blocked, false);
    assert.equal(gemma.fit.residentModelId, 'qwen3.5-9b-q4-k-m');
  });
});

test('Linux CUDA live probes in set-default-summary-model and validate-diarization-setup serialize behind gpuResourceActionQueue without releasing loaded summary model', async (t) => {
  await withPlatform('linux', 'x64', async () => {
    const userDataDir = createTempUserData(t);
    const manifestDir = path.join(userDataDir, 'ai-addons');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({
      version: 1,
      features: {
        summary: { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' },
      },
      summaryLibrary: {
        defaultModelId: 'qwen3.5-9b-q4-k-m',
        models: {
          'qwen3.5-9b-q4-k-m': { status: 'ready', modelId: 'qwen3.5-9b-q4-k-m' },
          'qwen3.5-4b-q4-k-m': { status: 'ready', modelId: 'qwen3.5-4b-q4-k-m' },
        },
      },
    }));

    const gpuQueue = createAsyncActionQueue();
    const activeJob = Promise.withResolvers();
    const callOrder = [];
    let releaseCalls = 0;
    let cudaProbeCalls = 0;

    void gpuQueue.enqueue(async () => {
      callOrder.push('gpu-job-start');
      await activeJob.promise;
      callOrder.push('gpu-job-end');
    });

    const { handlers } = registerHandlers({
      enqueueGpuResourceAction: gpuQueue.enqueue,
      getCachedCudaStatus: () => null,
      releaseSummaryModel: async () => {
        releaseCalls += 1;
      },
      resolveCudaStatusForTranscription: async () => {
        cudaProbeCalls += 1;
        callOrder.push(`cuda-probe-${cudaProbeCalls}`);
        return READY_LINUX_CUDA;
      },
      getSummaryDeviceMemory: async () => ({ totalBytes: 12 * GiB, availableBytes: 11 * GiB }),
      checkAiAddonSetupStatus: async ({ summaryModelId }) => ({
        features: {
          summary: {
            modelId: summaryModelId || 'qwen3.5-4b-q4-k-m',
            setupComplete: true,
            status: 'ready',
            fit: { status: 'likely_fits', blocked: false },
          },
        },
        summaryLibrary: { defaultModelId: 'qwen3.5-4b-q4-k-m', models: [] },
      }),
    }, userDataDir);

    const defaultOp = handlers.get('set-default-summary-model')(
      { sender: {} },
      { modelId: 'qwen3.5-4b-q4-k-m' },
    );
    const validateOp = handlers.get('validate-diarization-setup')({ sender: {} });

    await new Promise(setImmediate);
    assert.equal(cudaProbeCalls, 0);
    assert.equal(releaseCalls, 0);
    assert.deepEqual(callOrder, ['gpu-job-start']);

    activeJob.resolve();
    const [defaultResult, validateResult] = await Promise.all([defaultOp, validateOp]);
    assert.equal(defaultResult.summaryLibrary.defaultModelId, 'qwen3.5-4b-q4-k-m');
    assert.equal(validateResult.features.diarization.status, 'notConfigured');
    assert.equal(cudaProbeCalls, 2);
    assert.equal(releaseCalls, 0);
    assert.deepEqual(callOrder, [
      'gpu-job-start',
      'gpu-job-end',
      'cuda-probe-1',
      'cuda-probe-2',
    ]);

    // If quit commits while validate-diarization-setup waits in gpuQueue, it skips the probe.
    let quitting = false;
    let quitProbeCalls = 0;
    const quitBlocker = Promise.withResolvers();
    void gpuQueue.enqueue(() => quitBlocker.promise);
    const quitHandlers = registerHandlers({
      enqueueGpuResourceAction: gpuQueue.enqueue,
      isQuitCommitted: () => quitting,
      resolveCudaStatusForTranscription: async () => {
        quitProbeCalls += 1;
        return READY_LINUX_CUDA;
      },
    }, userDataDir).handlers;
    const queuedValidate = quitHandlers.get('validate-diarization-setup')({ sender: {} });
    await new Promise(setImmediate);
    quitting = true;
    quitBlocker.resolve();
    await assert.rejects(queuedValidate, /quitting/i);
    assert.equal(quitProbeCalls, 0);
  });
});
