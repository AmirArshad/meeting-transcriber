'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { createTranscriptionService } = require('../../src/main/transcription-service');
const { createPythonRuntime } = require('../../src/main/python-runtime');
const { getDiarizationAvailability, LINUX_DIARIZATION_UNAVAILABLE_REASON } = require('../../src/ai-addon-state');
const { getSpeakrsOrtRuntimeDir, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE } = require('../../src/ai-addon/manifest-store');

const DIARIZE_REQUIRED_FLAGS = Object.freeze([
  '--audio',
  '--segments-json',
  '--output-json',
  '--model-ref',
  '--speaker-count',
  '--ffmpeg',
]);
const GUIDED_REQUIRED_FLAGS = Object.freeze([
  '--audio',
  '--output-transcript',
  '--language',
  '--model',
  '--transcriber-backend',
  '--model-ref',
  '--speaker-count',
  '--ffmpeg',
]);
const ENGINE_AGNOSTIC_OPTIONAL_FLAGS = Object.freeze([
  '--require-device',
  '--output-json',
  '--engine',
]);

function flagNames(args) {
  return args.filter((value) => typeof value === 'string' && value.startsWith('--'));
}

function makeTempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function mockSupportedDiarizationHost() {
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDesc = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
  return () => {
    Object.defineProperty(process, 'platform', platformDesc);
    Object.defineProperty(process, 'arch', archDesc);
  };
}

function assertEngineAgnosticFlags(actualFlags, requiredFlags) {
  for (const flag of requiredFlags) {
    assert.ok(actualFlags.includes(flag), `missing required flag ${flag}`);
  }
  for (const flag of actualFlags) {
    assert.ok(
      requiredFlags.includes(flag) || ENGINE_AGNOSTIC_OPTIONAL_FLAGS.includes(flag),
      `unexpected engine-specific flag ${flag}`,
    );
  }
}

function createService(overrides = {}) {
  return createTranscriptionService({
    app: { getPath: () => '/tmp/avanevis-test', isPackaged: false },
    path,
    fs: {
      promises: {
        readFile: async () => '',
        writeFile: async () => {},
        rm: async () => {},
        mkdtemp: async (prefix) => `${prefix}test`,
      },
      existsSync: () => true,
    },
    os,
    pythonConfig: { backendPath: '/tmp/backend', pythonPath: 'python', ffmpegPath: '/tmp/ffmpeg' },
    spawnTrackedPython: () => {},
    getBackendModuleArgs: (_moduleName, extraArgs) => extraArgs,
    enqueueAiComputeAction: (action) => action(),
    getCachedCudaStatus: () => ({ available: false }),
    buildCudaRuntimeEnv: (env) => env || {},
    getAiAddonRuntimeOptions: () => ({}),
    getDiarizationDependencyEnv: () => ({ PYTHONPATH: '/tmp/pyannote-site' }),
    getDiarizationCacheEnv: () => ({ HF_HOME: '/tmp/should-not-leak-to-speakrs' }),
    getDiarizationDependencySitePackagesPath: () => null,
    requireAllowedModelSize: (value) => value || 'small',
    collectPythonProcessOutput: () => ({
      getStdout: () => '',
      getStderr: () => '',
      assertStdoutWithinLimit() {},
    }),
    sendToRenderer() {},
    sendRedactedProgress() {},
    flushRedactedProgress() {},
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    appendSpawnJsonStdout: (buffer) => buffer,
    assertTrustedRendererSender() {},
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingSegmentsPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    terminateProcessBestEffort: async () => {},
    summarizeDiarizationError: (value) => value,
    sanitizeTranscriptionError: (value) => value,
    buildTranscriptionPlaceholderMarkdown: () => '# pending\n',
    formatDurationForTranscript: () => '0:00',
    listMeetings: async () => [],
    isQuitCommitted: () => false,
    ...overrides,
  });
}

test('diarize-transcript spawn flags stay engine-agnostic', () => {
  const service = createService();
  const args = service.buildManagedDiarizationArgs({
    audioPath: '/tmp/meeting.opus',
    segmentsJsonPath: '/tmp/meeting.segments.json',
    outputPath: '/tmp/meeting.speakers.json',
    modelRef: 'pyannote/speaker-diarization-community-1',
    speakerCount: 'auto',
    requiredDevice: 'mps',
  });

  assertEngineAgnosticFlags(flagNames(args), DIARIZE_REQUIRED_FLAGS);
  assert.ok(flagNames(args).includes('--require-device'));
  assert.equal(args.includes('--engine'), false);
});

test('transcribe-audio-with-speakers spawn flags stay engine-agnostic', () => {
  const service = createService();
  const args = service.buildManagedDiarizationGuidedTranscriptionArgs({
    audioPath: '/tmp/meeting.opus',
    outputTranscript: '/tmp/meeting.md',
    outputJson: '/tmp/meeting.speakers.json',
    language: 'en',
    modelSize: 'small',
    modelRef: 'pyannote/speaker-diarization-community-1',
    speakerCount: 'auto',
    requiredDevice: 'mps',
  });

  assertEngineAgnosticFlags(flagNames(args), GUIDED_REQUIRED_FLAGS);
  assert.ok(flagNames(args).includes('--output-json'));
  assert.ok(flagNames(args).includes('--require-device'));
  assert.equal(args.includes('--engine'), false);
});

test('diarize and guided spawn flags accept additive --engine without changing field sets', () => {
  const service = createService();
  const diarizeArgs = service.buildManagedDiarizationArgs({
    audioPath: '/tmp/meeting.opus',
    segmentsJsonPath: '/tmp/meeting.segments.json',
    outputPath: '/tmp/meeting.speakers.json',
    modelRef: 'speakrs-community1-vbx',
    speakerCount: 'auto',
    requiredDevice: 'cuda',
    engine: 'speakrs',
  });
  const guidedArgs = service.buildManagedDiarizationGuidedTranscriptionArgs({
    audioPath: '/tmp/meeting.opus',
    outputTranscript: '/tmp/meeting.md',
    outputJson: '/tmp/meeting.speakers.json',
    language: 'en',
    modelSize: 'small',
    modelRef: 'speakrs-community1-vbx',
    speakerCount: 'auto',
    requiredDevice: 'cuda',
    engine: 'speakrs',
  });

  assertEngineAgnosticFlags(flagNames(diarizeArgs), DIARIZE_REQUIRED_FLAGS);
  assertEngineAgnosticFlags(flagNames(guidedArgs), GUIDED_REQUIRED_FLAGS);
  assert.equal(diarizeArgs[diarizeArgs.indexOf('--engine') + 1], 'speakrs');
  assert.equal(guidedArgs[guidedArgs.indexOf('--engine') + 1], 'speakrs');
});

test('speakrs child env skips HF cache vars and does not inherit exclusive=0', () => {
  const service = createService();
  const previousExclusive = process.env.SPEAKRS_EXCLUSIVE;
  try {
    process.env.SPEAKRS_EXCLUSIVE = '0';
    const speakrsEnv = service.buildDiarizationChildEnv({
      engine: 'speakrs',
      requiredDevice: 'cuda',
    });
    const pyannoteEnv = service.buildDiarizationChildEnv({
      engine: 'pyannote',
      requiredDevice: 'cuda',
    });

    assert.equal(speakrsEnv.HF_HOME, undefined);
    assert.equal(speakrsEnv.PYTHONPATH, undefined);
    assert.equal(speakrsEnv.SPEAKRS_EXCLUSIVE, '1');
    assert.equal(speakrsEnv.SPEAKRS_MODE, 'cuda');
    if (process.platform === 'linux') {
      assert.equal(
        speakrsEnv.AVANEVIS_LINUX_CUDA_REQUIRED,
        '1',
        'guided Linux Speakrs must make Whisper fail closed on the admitted CUDA runtime',
      );
    }
    assert.equal(pyannoteEnv.HF_HOME, '/tmp/should-not-leak-to-speakrs');
    assert.equal(pyannoteEnv.PYTHONPATH, '/tmp/pyannote-site');
    assert.equal(pyannoteEnv.SPEAKRS_CLI_PATH, undefined);
  } finally {
    if (previousExclusive === undefined) {
      delete process.env.SPEAKRS_EXCLUSIVE;
    } else {
      process.env.SPEAKRS_EXCLUSIVE = previousExclusive;
    }
  }
});

test('only admitted Linux Speakrs explicitly retains the CUDA-required child flag', () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDesc = Object.getOwnPropertyDescriptor(process, 'arch');
  const cudaEnvInputs = [];
  const service = createService({
    buildCudaRuntimeEnv: (extra = {}) => {
      cudaEnvInputs.push(extra);
      return extra;
    },
  });

  try {
    for (const platform of ['linux', 'win32', 'darwin']) {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
      Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
      service.getTranscriptionRuntimeEnv('small');
      service.buildDiarizationChildEnv({ engine: 'pyannote', requiredDevice: 'cuda' });
      service.buildDiarizationChildEnv({ engine: 'speakrs', requiredDevice: 'cuda' });
    }
  } finally {
    Object.defineProperty(process, 'platform', platformDesc);
    Object.defineProperty(process, 'arch', archDesc);
  }

  const retained = cudaEnvInputs.filter(
    (input) => input.AVANEVIS_LINUX_CUDA_REQUIRED === '1',
  );
  const explicitlyCleared = cudaEnvInputs.filter(
    (input) => Object.hasOwn(input, 'AVANEVIS_LINUX_CUDA_REQUIRED')
      && input.AVANEVIS_LINUX_CUDA_REQUIRED === undefined,
  );
  assert.equal(retained.length, 1, 'only Linux Speakrs CUDA admission retains the flag');
  assert.equal(explicitlyCleared.length, 8, 'ordinary, Pyannote, Windows, and macOS paths scrub ambient state');
});

test('packaged missing Speakrs CLI rejects child env before Python spawn', () => {
  const previous = process.env.AVANEVIS_PACKAGED;
  process.env.AVANEVIS_PACKAGED = '1';
  try {
    const service = createService({
      app: { getPath: () => '/tmp/avanevis-test', isPackaged: true },
      fs: {
        promises: {
          readFile: async () => '',
          writeFile: async () => {},
          rm: async () => {},
          mkdtemp: async (prefix) => `${prefix}test`,
        },
        existsSync: () => false,
      },
      spawnTrackedPython: () => {
        throw new Error('Python must not spawn when the bundled Speakrs CLI is missing');
      },
      resourcesPath: path.join(os.tmpdir(), 'avanevis-missing-speakrs-bin'),
    });
    assert.throws(
      () => service.buildDiarizationChildEnv({ engine: 'speakrs', requiredDevice: 'cuda' }),
      (error) => error
        && error.code === 'SPEAKRS_PACKAGED_CLI_MISSING'
        && error.message === SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE
        && !/FileNotFoundError|traceback|re-run speaker setup/i.test(error.message),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.AVANEVIS_PACKAGED;
    } else {
      process.env.AVANEVIS_PACKAGED = previous;
    }
  }
});

test('guided diarization can start for speakrs without a runtime.modelRef', () => {
  const service = createService();
  assert.equal(service.canStartGuidedDiarization({
    status: 'ready',
    setupComplete: true,
    engine: 'speakrs',
    modelRef: null,
  }), true);
  assert.equal(service.canStartGuidedDiarization({
    status: 'ready',
    setupComplete: true,
    engine: 'pyannote',
    modelRef: null,
  }), false);
  assert.equal(service.canStartGuidedDiarization({
    status: 'ready',
    setupComplete: true,
    engine: 'pyannote',
    modelRef: 'pyannote/speaker-diarization-community-1',
  }), true);
});

test('pyannote child env keeps managed HF cache after spawn merge', () => {
  const previousHome = process.env.HF_HOME;
  const previousHub = process.env.HF_HUB_CACHE;
  process.env.HF_HOME = path.join(os.tmpdir(), 'hostile-hf-home');
  process.env.HF_HUB_CACHE = path.join(os.tmpdir(), 'hostile-hf-hub');
  try {
    const runtime = createPythonRuntime({
      app: { isPackaged: false },
      spawn: () => new EventEmitter(),
      path,
      fs,
      dirname: path.join(__dirname, '..', '..', 'src'),
    });
    const merged = runtime.buildPythonEnv(createService().buildDiarizationChildEnv({
      engine: 'pyannote',
      requiredDevice: 'cuda',
    }));
    assert.equal(merged.HF_HOME, '/tmp/should-not-leak-to-speakrs');
    assert.match(String(merged.PYTHONPATH || ''), /pyannote-site/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HF_HOME;
    } else {
      process.env.HF_HOME = previousHome;
    }
    if (previousHub === undefined) {
      delete process.env.HF_HUB_CACHE;
    } else {
      process.env.HF_HUB_CACHE = previousHub;
    }
  }
});

test('diarize-transcript Speakrs production spawn receives engine argv and isolated env', async () => {
  const restoreHost = mockSupportedDiarizationHost();
  const availability = getDiarizationAvailability(process.platform, process.arch);
  assert.equal(availability.supported, true, 'handler coverage requires a supported diarization platform');

  const recordingsDir = makeTempDir('speakrs-diarize-rec-');
  const userDataDir = makeTempDir('speakrs-diarize-ud-');
  const audioPath = path.join(recordingsDir, 'meeting.opus');
  fs.writeFileSync(audioPath, 'opus');

  const previous = {
    HF_HOME: process.env.HF_HOME,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE,
    HUGGINGFACE_HUB_CACHE: process.env.HUGGINGFACE_HUB_CACHE,
    TRANSFORMERS_CACHE: process.env.TRANSFORMERS_CACHE,
    HF_TOKEN: process.env.HF_TOKEN,
  };
  process.env.HF_HOME = path.join(os.tmpdir(), 'hostile-hf-home');
  process.env.HF_HUB_CACHE = path.join(os.tmpdir(), 'hostile-hf-hub');
  process.env.HUGGINGFACE_HUB_CACHE = path.join(os.tmpdir(), 'hostile-hf-hub-alias');
  process.env.TRANSFORMERS_CACHE = path.join(os.tmpdir(), 'hostile-transformers');
  process.env.HF_TOKEN = 'hf_ambient_token';

  const captured = [];
  const cudaOptions = [];
  const statusOptions = [];
  let runQueuedAction = null;
  const runtime = createPythonRuntime({
    app: { isPackaged: false },
    spawn(_cmd, args, options) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      captured.push({ args, options, proc });
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          success: true,
          segments: [],
          annotationSource: 'exclusive_speaker_diarization',
        })));
        proc.emit('close', 0);
      });
      return proc;
    },
    path,
    fs,
    dirname: path.join(__dirname, '..', '..', 'src'),
  });

  try {
    const cliPath = path.join(userDataDir, 'dev-bin', process.platform === 'win32' ? 'speakrs-cli.exe' : 'speakrs-cli');
    const service = createTranscriptionService({
      app: { getPath: () => userDataDir, isPackaged: false },
      path,
      fs,
      os,
      pythonConfig: { backendPath: '/tmp/backend', pythonPath: 'python', ffmpegPath: '/tmp/ffmpeg' },
      spawnTrackedPython: (args, options) => runtime.spawnTrackedPython(args, options),
      getBackendModuleArgs: (moduleName, extraArgs = []) => ['-m', moduleName, ...extraArgs],
      enqueueAiComputeAction: (action) => new Promise((resolve, reject) => {
        runQueuedAction = () => action().then(resolve, reject);
      }),
      getCachedCudaStatus: () => ({ available: false }),
      buildCudaRuntimeEnv: (extra = {}, options = {}) => {
        cudaOptions.push(options);
        if (process.platform !== 'win32') {
          return extra || {};
        }
        return { ...(extra || {}), PATH: extra.PATH || process.env.PATH || 'C:\\Windows\\System32' };
      },
      getAiAddonRuntimeOptions: (extra = {}) => ({ userDataDir, ...extra }),
      getDiarizationDependencyEnv: () => ({ PYTHONPATH: '/tmp/pyannote-site' }),
      getDiarizationCacheEnv: () => ({
        HF_HOME: '/tmp/should-not-leak-to-speakrs',
        HF_HUB_CACHE: '/tmp/should-not-leak-to-speakrs/hub',
      }),
      getDiarizationDependencySitePackagesPath: () => '/tmp/pyannote-site',
      requireAllowedModelSize: (value) => value || 'small',
      collectPythonProcessOutput: () => ({
        getStdout: () => '',
        getStderr: () => '',
        assertStdoutWithinLimit() {},
      }),
      sendToRenderer() {},
      sendRedactedProgress() {},
      flushRedactedProgress() {},
      appendSpawnLogBuffer: (buffer, chunk) => `${buffer || ''}${chunk}`,
      appendSpawnJsonStdout: (buffer, data) => `${buffer || ''}${data}`,
      assertTrustedRendererSender() {},
      getRecordingsDir: () => recordingsDir,
      assertSafeExistingRecordingAudioPath: (value) => value,
      assertSafeExistingSegmentsPath: (value) => value,
      assertSafeExistingTranscriptPath: (value) => value,
      terminateProcessBestEffort: async () => {},
      summarizeDiarizationError: (value) => value,
      sanitizeTranscriptionError: (value) => value,
      buildTranscriptionPlaceholderMarkdown: () => '# pending\n',
      formatDurationForTranscript: () => '0:00',
      listMeetings: async () => [],
      isQuitCommitted: () => false,
      resolveSpeakrsCliPath: () => cliPath,
      checkAiAddonSetupStatus: async (options) => {
        statusOptions.push(options);
        return {
          features: {
            diarization: {
              status: 'ready',
              setupComplete: true,
              engine: 'speakrs',
              modelId: 'speakrs-community1-vbx',
              speakerCount: 'auto',
              runtimeCache: { valid: true },
            },
          },
        };
      },
    });

    const handlers = new Map();
    service.registerIpc({
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    });

    const resultPromise = handlers.get('diarize-transcript')({ sender: {} }, {
      audioPath,
      segments: [{ start: 0, end: 1, text: 'hello' }],
    });

    const started = Date.now();
    while (!runQueuedAction) {
      if (Date.now() - started > 2000) {
        throw new Error('Timed out waiting for diarize-transcript queue admission');
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(captured.length, 0, 'Python must not spawn before the queued action starts');
    assert.equal(statusOptions.length, 1);
    assert.notEqual(statusOptions[0].computeAdmission, true);
    runQueuedAction();
    while (captured.length === 0) {
      if (Date.now() - started > 2000) {
        throw new Error('Timed out waiting for diarize-transcript spawn');
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(statusOptions.length, 2);
    assert.equal(statusOptions[1].computeAdmission, true, 'integrity admission must run when the queue starts');

    const { args, options } = captured[0];
    assert.ok(args.includes('--engine'));
    assert.equal(args[args.indexOf('--engine') + 1], 'speakrs');
    assert.equal(args.includes('--token-stdin'), false);
    assert.equal(args.includes('-c'), false);
    assert.equal(args.includes('/tmp/pyannote-site'), false);

    const env = options.env;
    assert.equal(env.SPEAKRS_CLI_PATH, cliPath);
    assert.ok(String(env.SPEAKRS_MODELS_DIR || '').includes('speakrs'));
    assert.equal(env.SPEAKRS_MODE, availability.runtimeDevice === 'mps' ? 'coreml' : 'cuda');
    assert.equal(env.SPEAKRS_EXCLUSIVE, '1');
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'HF_HOME'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'HF_HUB_CACHE'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'HUGGINGFACE_HUB_CACHE'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(env, 'TRANSFORMERS_CACHE'), false);
    assert.equal(env.HF_TOKEN, '');
    assert.equal(env.HUGGINGFACE_HUB_TOKEN, '');
    assert.equal(env.HUGGING_FACE_HUB_TOKEN, '');
    assert.equal(env.HF_TOKEN_PATH, os.devNull);
    assert.equal(String(env.PYTHONPATH || '').includes('pyannote-site'), false);
    assert.equal(cudaOptions.length > 0, true);
    assert.equal(cudaOptions[0].includeManagedDiarization, false);
    if (process.platform === 'win32') {
      const ortDir = getSpeakrsOrtRuntimeDir(userDataDir);
      assert.equal(env.PATH.startsWith(`${ortDir}${path.delimiter}`) || env.PATH === ortDir, true);
      assert.equal(env.ORT_DYLIB_PATH, path.join(ortDir, 'onnxruntime.dll'));
    }
    if (process.platform === 'win32') {
      assert.equal(options.detached, false);
    } else {
      assert.equal(options.detached, true);
    }

    await resultPromise;
  } finally {
    restoreHost();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(recordingsDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('queued Speakrs compute admission failure prevents diarization spawn', async () => {
  const restoreHost = mockSupportedDiarizationHost();
  const availability = getDiarizationAvailability(process.platform, process.arch);
  assert.equal(availability.supported, true, 'handler coverage requires a supported diarization platform');
  const recordingsDir = makeTempDir('speakrs-admission-rec-');
  const audioPath = path.join(recordingsDir, 'meeting.opus');
  fs.writeFileSync(audioPath, 'opus');
  const spawned = [];
  let runQueuedAction = null;
  const statusOptions = [];
  try {
    const service = createService({
      app: { getPath: () => recordingsDir, isPackaged: false },
      fs,
      spawnTrackedPython: (...args) => {
        spawned.push(args);
        throw new Error('Python must not spawn after failed Speakrs integrity admission');
      },
      enqueueAiComputeAction: (action) => new Promise((resolve, reject) => {
        runQueuedAction = () => action().then(resolve, reject);
      }),
      getAiAddonRuntimeOptions: (extra = {}) => ({ userDataDir: recordingsDir, ...extra }),
      getRecordingsDir: () => recordingsDir,
      checkAiAddonSetupStatus: async (options) => {
        statusOptions.push(options);
        const admitted = options && options.computeAdmission === true;
        return {
          features: {
            diarization: {
              status: admitted ? 'error' : 'ready',
              setupComplete: !admitted,
              engine: 'speakrs',
              modelId: 'speakrs-community1-vbx',
              error: admitted ? 'Speakrs ONNX Runtime files failed integrity validation.' : null,
            },
          },
        };
      },
    });
    const handlers = new Map();
    service.registerIpc({ handle(channel, handler) { handlers.set(channel, handler); } });
    const resultPromise = handlers.get('diarize-transcript')({ sender: {} }, {
      audioPath,
      segments: [{ start: 0, end: 1, text: 'hello' }],
    });
    const started = Date.now();
    while (!runQueuedAction) {
      if (Date.now() - started > 2000) {
        throw new Error('Timed out waiting for diarize-transcript queue admission');
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(statusOptions.length, 1);
    runQueuedAction();
    await assert.rejects(resultPromise, /integrity validation/i);
    assert.equal(statusOptions.length, 2);
    assert.equal(statusOptions[1].computeAdmission, true);
    assert.equal(spawned.length, 0);
  } finally {
    restoreHost();
    fs.rmSync(recordingsDir, { recursive: true, force: true });
  }
});

test('packaged missing Speakrs CLI diarize-transcript handler returns reinstall copy without spawning', async () => {
  const restoreHost = mockSupportedDiarizationHost();
  const availability = getDiarizationAvailability(process.platform, process.arch);
  assert.equal(availability.supported, true, 'handler coverage requires a supported diarization platform');

  const recordingsDir = makeTempDir('speakrs-missing-cli-rec-');
  const audioPath = path.join(recordingsDir, 'meeting.opus');
  fs.writeFileSync(audioPath, 'opus');
  const previousPackaged = process.env.AVANEVIS_PACKAGED;
  process.env.AVANEVIS_PACKAGED = '1';
  const spawned = [];

  try {
    const service = createTranscriptionService({
      app: { getPath: () => recordingsDir, isPackaged: true },
      path,
      fs,
      os,
      pythonConfig: { backendPath: '/tmp/backend', pythonPath: 'python', ffmpegPath: '/tmp/ffmpeg' },
      spawnTrackedPython: (...args) => {
        spawned.push(args);
        throw new Error('Python must not spawn when the bundled Speakrs CLI is missing');
      },
      getBackendModuleArgs: (moduleName, extraArgs = []) => ['-m', moduleName, ...extraArgs],
      enqueueAiComputeAction: (action) => action(),
      getCachedCudaStatus: () => ({ available: false }),
      buildCudaRuntimeEnv: (extra = {}) => extra || {},
      getAiAddonRuntimeOptions: () => ({ userDataDir: recordingsDir }),
      getDiarizationDependencyEnv: () => ({}),
      getDiarizationCacheEnv: () => ({}),
      getDiarizationDependencySitePackagesPath: () => null,
      requireAllowedModelSize: (value) => value || 'small',
      collectPythonProcessOutput: () => ({
        getStdout: () => '',
        getStderr: () => '',
        assertStdoutWithinLimit() {},
      }),
      sendToRenderer() {},
      sendRedactedProgress() {},
      flushRedactedProgress() {},
      appendSpawnLogBuffer: (buffer, chunk) => `${buffer || ''}${chunk}`,
      appendSpawnJsonStdout: (buffer, data) => `${buffer || ''}${data}`,
      assertTrustedRendererSender() {},
      getRecordingsDir: () => recordingsDir,
      assertSafeExistingRecordingAudioPath: (value) => value,
      assertSafeExistingSegmentsPath: (value) => value,
      assertSafeExistingTranscriptPath: (value) => value,
      terminateProcessBestEffort: async () => {},
      summarizeDiarizationError: (value) => value,
      sanitizeTranscriptionError: (value) => value,
      buildTranscriptionPlaceholderMarkdown: () => '# pending\n',
      formatDurationForTranscript: () => '0:00',
      listMeetings: async () => [],
      isQuitCommitted: () => false,
      resourcesPath: path.join(os.tmpdir(), 'avanevis-missing-speakrs-bin'),
      checkAiAddonSetupStatus: async () => ({
        features: {
          diarization: {
            status: 'ready',
            setupComplete: true,
            engine: 'speakrs',
            modelId: 'speakrs-community1-vbx',
            speakerCount: 'auto',
            cliPresent: false,
            cliMissingMessage: SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
          },
        },
      }),
    });

    const handlers = new Map();
    service.registerIpc({
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    });

    await assert.rejects(
      handlers.get('diarize-transcript')({ sender: {} }, {
        audioPath,
        segments: [{ start: 0, end: 1, text: 'hello' }],
      }),
      (error) => error
        && error.code === 'SPEAKRS_PACKAGED_CLI_MISSING'
        && error.message === SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE
        && !/FileNotFoundError|traceback|re-run speaker setup/i.test(error.message),
    );
    assert.equal(spawned.length, 0);
  } finally {
    restoreHost();
    if (previousPackaged === undefined) {
      delete process.env.AVANEVIS_PACKAGED;
    } else {
      process.env.AVANEVIS_PACKAGED = previousPackaged;
    }
    fs.rmSync(recordingsDir, { recursive: true, force: true });
  }
});

test('Linux Speakrs stays unavailable without CUDA preflight and does not spawn', async () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDesc = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  Object.defineProperty(process, 'arch', { configurable: true, value: 'x64' });
  const recordingsDir = makeTempDir('linux-speakrs-nocuda-');
  const audioPath = path.join(recordingsDir, 'meeting.opus');
  fs.writeFileSync(audioPath, 'opus');
  const spawned = [];
  try {
    const service = createService({
      app: { getPath: () => recordingsDir, isPackaged: false },
      fs,
      spawnTrackedPython: (...args) => {
        spawned.push(args);
        throw new Error('Linux Speakrs must not spawn without CUDA preflight');
      },
      resolveCudaStatusForTranscription: async () => ({
        statusCode: 'missingDriver',
        installed: false,
        deviceAvailable: false,
        runtimeLoadable: false,
        missingLibraries: ['libcuda.so.1'],
        matchedProfile: null,
        error: 'NVIDIA driver libraries were not found.',
      }),
      getRecordingsDir: () => recordingsDir,
    });
    const handlers = new Map();
    service.registerIpc({ handle(channel, handler) { handlers.set(channel, handler); } });
    await assert.rejects(
      handlers.get('diarize-transcript')({ sender: {} }, {
        audioPath,
        segments: [{ start: 0, end: 1, text: 'hello' }],
      }),
      (error) => error
        && /CUDA 12|NVIDIA GPU/.test(error.message)
        && error.message.includes('NVIDIA driver libraries were not found'),
    );
    assert.equal(spawned.length, 0);
    assert.equal(getDiarizationAvailability('linux', 'x64').supported, false);
    assert.equal(getDiarizationAvailability('linux', 'x64').reason, LINUX_DIARIZATION_UNAVAILABLE_REASON);
  } finally {
    Object.defineProperty(process, 'platform', platformDesc);
    Object.defineProperty(process, 'arch', archDesc);
    fs.rmSync(recordingsDir, { recursive: true, force: true });
  }
});
