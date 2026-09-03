const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  AI_MODEL_CATALOG,
  LINUX_PYANNOTE_UNAVAILABLE_REASON,
  PYANNOTE_DIARIZATION_MODEL_ID,
  SPEAKRS_DIARIZATION_MODEL_ID,
  getSpeakrsSetupArtifactsForPlatform,
} = require('../../src/ai-addon-state');
const { flattenSelectedArchiveFiles } = require('../../src/ai-addon/archive-install');
const {
  checkSpeakrsRuntimeCache,
  checkSpeakrsModelCache,
  checkAiAddonSetupStatus,
  getPyannoteUninstallPaths,
  getSpeakrsModelRevisionDir,
  getSpeakrsOrtRuntimeDir,
  resolveSpeakrsCliPath,
  resolveSpeakrsCliPathForSpawn,
  buildSpeakrsSpawnEnv,
  canStartGuidedDiarization,
  assertLinuxSpeakrsOnlyEngine,
  resolveSpawnDiarizationEngine,
  getPackagedSpeakrsCliPreflightError,
  SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
} = require('../../src/ai-addon/manifest-store');
const {
  SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE: RENDERER_SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
} = require('../../src/renderer/ai-addon-ui-helpers');
const { createPythonRuntime } = require('../../src/main/python-runtime');
const { TOKEN_KEYS, getTokenPath } = require('../../src/ai-addon-token-store');
const {
  setupDiarizationAddon,
  uninstallPyannoteLocalState,
  uninstallSpeakrsLocalState,
} = require('../../src/ai-addon/diarization-setup');
const {
  SPEAKRS_CUDA_RUNTIME_DLL_NAMES,
  SPEAKRS_CUDA_RUNTIME_SO_NAMES,
  SPEAKRS_MODEL_PACK_REVISION,
  SPEAKRS_ORT_DLL_NAMES,
  SPEAKRS_ORT_SO_NAMES,
} = require('../../src/ai-addon/speakrs-pack-spec');
const { stageLegalBundle } = require('../../build/prepare-resources');

const MODEL_BYTES = Buffer.from('model-pack-file');
const ARCHIVE_BYTES = Buffer.from('model-pack-archive');
const ARCHIVE_SHA256 = crypto.createHash('sha256').update(ARCHIVE_BYTES).digest('hex');
const MODEL_SHA256 = crypto.createHash('sha256').update(MODEL_BYTES).digest('hex');
const RUNTIME_DLL_NAMES = [...SPEAKRS_ORT_DLL_NAMES, ...SPEAKRS_CUDA_RUNTIME_DLL_NAMES];
const RUNTIME_SO_NAMES = [...SPEAKRS_ORT_SO_NAMES, ...SPEAKRS_CUDA_RUNTIME_SO_NAMES];
const READY_LINUX_CUDA = Object.freeze({
  statusCode: 'ready',
  installed: true,
  deviceAvailable: true,
  runtimeLoadable: true,
  missingLibraries: [],
  matchedProfile: 'cuda12',
});

function createSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => Buffer.from(value).toString('utf8'),
  };
}

function createPinnedTestCatalog(modelPath = 'model.bin') {
  return {
    version: 1,
    diarization: {
      defaultModelId: SPEAKRS_DIARIZATION_MODEL_ID,
      dependencyArtifacts: AI_MODEL_CATALOG.diarization.dependencyArtifacts,
      models: [
        {
          id: SPEAKRS_DIARIZATION_MODEL_ID,
          engine: 'speakrs',
          tokenRequired: false,
          runtime: {
            type: 'native-cli',
            executableName: 'speakrs-cli',
            modeByPlatform: { 'win32-x64': 'cuda' },
          },
          packRevision: SPEAKRS_MODEL_PACK_REVISION,
          packArtifacts: {
            'win32-x64': [
              {
                id: 'speakrs-model-pack-test',
                kind: 'model-pack',
                fileName: 'speakrs-model-pack-test.tar.gz',
                archiveFormat: 'tar.gz',
                sha256: ARCHIVE_SHA256,
                sizeBytes: ARCHIVE_BYTES.length,
                downloadUrl: 'https://github.com/AmirArshad/meeting-transcriber/releases/download/speakrs-test/speakrs-model-pack-test.tar.gz',
                requiredFiles: [{
                  path: modelPath,
                  fileName: path.posix.basename(modelPath),
                  sha256: MODEL_SHA256,
                  sizeBytes: MODEL_BYTES.length,
                }],
              },
              {
                id: 'speakrs-runtime-test',
                kind: 'ort-archive',
                fileName: 'speakrs-runtime-test.zip',
                archiveFormat: 'zip',
                sha256: ARCHIVE_SHA256,
                sizeBytes: ARCHIVE_BYTES.length,
                downloadUrl: 'https://github.com/AmirArshad/meeting-transcriber/releases/download/speakrs-test/speakrs-runtime-test.zip',
                keepFileNames: RUNTIME_DLL_NAMES,
                extractedFiles: Object.fromEntries(RUNTIME_DLL_NAMES.map((name) => {
                  const contents = Buffer.from(`MZ-${name}`);
                  return [name, {
                    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
                    sizeBytes: contents.length,
                  }];
                })),
              },
            ],
          },
        },
        AI_MODEL_CATALOG.diarization.models.find((model) => model.id === PYANNOTE_DIARIZATION_MODEL_ID),
      ],
    },
    summary: AI_MODEL_CATALOG.summary,
  };
}

function createPinnedLinuxTestCatalog(modelPath = 'model.bin') {
  return {
    diarization: {
      defaultModelId: SPEAKRS_DIARIZATION_MODEL_ID,
      models: [
        {
          id: SPEAKRS_DIARIZATION_MODEL_ID,
          engine: 'speakrs',
          tokenRequired: false,
          runtime: {
            type: 'native-cli',
            executableName: 'speakrs-cli',
            modeByPlatform: { 'linux-x64': 'cuda' },
          },
          packRevision: SPEAKRS_MODEL_PACK_REVISION,
          packArtifacts: {
            'linux-x64': [
              {
                id: 'speakrs-model-pack-linux-test',
                kind: 'model-pack',
                fileName: 'speakrs-model-pack-linux-test.tar.gz',
                archiveFormat: 'tar.gz',
                sha256: ARCHIVE_SHA256,
                sizeBytes: ARCHIVE_BYTES.length,
                downloadUrl: 'https://github.com/AmirArshad/meeting-transcriber/releases/download/speakrs-test/speakrs-model-pack-linux-test.tar.gz',
                requiredFiles: [{
                  path: modelPath,
                  fileName: path.posix.basename(modelPath),
                  sha256: MODEL_SHA256,
                  sizeBytes: MODEL_BYTES.length,
                }],
              },
              {
                id: 'speakrs-runtime-linux-test',
                kind: 'ort-archive',
                fileName: 'speakrs-runtime-linux-test.tgz',
                archiveFormat: 'tar.gz',
                sha256: ARCHIVE_SHA256,
                sizeBytes: ARCHIVE_BYTES.length,
                downloadUrl: 'https://github.com/AmirArshad/meeting-transcriber/releases/download/speakrs-test/speakrs-runtime-linux-test.tgz',
                keepFileNames: RUNTIME_SO_NAMES,
                extractedFiles: Object.fromEntries(RUNTIME_SO_NAMES.map((name) => {
                  const contents = Buffer.from(`MZ-${name}`);
                  return [name, {
                    sha256: crypto.createHash('sha256').update(contents).digest('hex'),
                    sizeBytes: contents.length,
                  }];
                })),
              },
            ],
          },
        },
        AI_MODEL_CATALOG.diarization.models.find((model) => model.id === PYANNOTE_DIARIZATION_MODEL_ID),
      ],
    },
    summary: AI_MODEL_CATALOG.summary,
  };
}

function createTestExtractor(modelPath = 'model.bin') {
  return async (_archivePath, destinationDir, _archiveFormat, options = {}) => {
    fs.mkdirSync(destinationDir, { recursive: true });
    if (Array.isArray(options.includeFileNames)) {
      for (const fileName of options.includeFileNames) {
        fs.writeFileSync(path.join(destinationDir, fileName), Buffer.from(`MZ-${fileName}`));
      }
      return;
    }
    const destinationPath = path.join(destinationDir, ...modelPath.split('/'));
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, MODEL_BYTES);
  };
}

async function installValidTestSetup(userDataDir, catalog, emitProgress) {
  const cliPath = path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, 'cli');
  const modelPath = getSpeakrsSetupArtifactsForPlatform('win32', 'x64', catalog).modelFiles[0].path;
  const status = await setupDiarizationAddon({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    engine: 'speakrs',
    safeStorage: createSafeStorage(),
    catalog,
    env: { SPEAKRS_CLI_PATH: cliPath },
    emitProgress,
    downloader: async ({ destinationPath }) => fs.writeFileSync(destinationPath, ARCHIVE_BYTES),
    extractor: createTestExtractor(modelPath),
  });
  assert.equal(
    status.features.diarization.status,
    'ready',
    `diarization status was '${status.features.diarization.status}'`
    + ` (error: ${status.features.diarization.error || 'none reported'})`,
  );
}

async function installValidLinuxTestSetup(userDataDir, catalog, emitProgress) {
  const cliPath = path.join(userDataDir, 'dev-bin', 'speakrs-cli');
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, 'cli');
  const modelPath = getSpeakrsSetupArtifactsForPlatform('linux', 'x64', catalog).modelFiles[0].path;
  const status = await setupDiarizationAddon({
    userDataDir,
    platform: 'linux',
    arch: 'x64',
    engine: 'speakrs',
    safeStorage: createSafeStorage(),
    catalog,
    env: { SPEAKRS_CLI_PATH: cliPath },
    emitProgress,
    cudaStatus: READY_LINUX_CUDA,
    downloader: async ({ destinationPath }) => fs.writeFileSync(destinationPath, ARCHIVE_BYTES),
    extractor: createTestExtractor(modelPath),
  });
  assert.equal(
    status.features.diarization.status,
    'ready',
    `Linux diarization status was '${status.features.diarization.status}'`
    + ` (error: ${status.features.diarization.error || 'none reported'})`,
  );
}

function createAbortDownloader() {
  return async ({ destinationPath }) => {
    fs.writeFileSync(destinationPath, ARCHIVE_BYTES);
    const error = new Error('Speaker identification setup was canceled.');
    error.name = 'AbortError';
    error.code = 'AI_ADDON_SETUP_CANCELLED';
    throw error;
  };
}

function createCancelingRuntimeValidator() {
  return async () => {
    const error = new Error('Speaker identification setup was canceled.');
    error.name = 'AbortError';
    error.code = 'AI_ADDON_SETUP_CANCELLED';
    throw error;
  };
}

function assertNotReady(status) {
  assert.notEqual(status.features.diarization.status, 'ready');
  assert.equal(status.features.diarization.setupComplete, false);
}

test('packaged Speakrs CLI resolution accepts only Resources/bin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-cli-'));
  try {
    const resourcesPath = path.join(root, 'Resources');
    const bundled = path.join(resourcesPath, 'bin', 'speakrs-cli.exe');
    const override = path.join(root, 'override', 'speakrs-cli.exe');
    const development = path.join(root, 'native', 'speakrs-cli', 'target', 'release', 'speakrs-cli.exe');
    const pathCandidate = path.join(root, 'path-bin', 'speakrs-cli.exe');
    for (const candidate of [bundled, override, development, pathCandidate]) {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, 'cli');
    }

    assert.equal(resolveSpeakrsCliPath({
      platform: 'win32',
      env: {
        AVANEVIS_PACKAGED: '1',
        SPEAKRS_CLI_PATH: override,
        PATH: path.dirname(pathCandidate),
      },
      resourcesPath,
      projectRoot: root,
    }), bundled);
    fs.rmSync(bundled);
    assert.equal(resolveSpeakrsCliPath({
      platform: 'win32',
      env: {
        AVANEVIS_PACKAGED: '1',
        SPEAKRS_CLI_PATH: override,
        PATH: path.dirname(pathCandidate),
      },
      resourcesPath,
      projectRoot: root,
    }), null);
    assert.equal(resolveSpeakrsCliPath({
      platform: 'win32',
      env: { SPEAKRS_CLI_PATH: override, PATH: path.dirname(pathCandidate) },
      resourcesPath: null,
      projectRoot: root,
    }), override);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packaged buildSpeakrsSpawnEnv pins Resources/bin and ignores decoys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-spawn-cli-'));
  try {
    const resourcesPath = path.join(root, 'Resources');
    const bundled = path.join(resourcesPath, 'bin', 'speakrs-cli.exe');
    const offBundleNative = path.join(root, 'override', 'speakrs-cli.exe');
    const pythonWrapper = path.join(root, 'override', 'speakrs-cli.py');
    const pathCandidate = path.join(root, 'path-bin', 'speakrs-cli.exe');
    const userDataDir = path.join(root, 'userData');
    for (const candidate of [bundled, offBundleNative, pythonWrapper, pathCandidate]) {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.writeFileSync(candidate, 'decoy');
    }

    const packagedEnv = {
      AVANEVIS_PACKAGED: '1',
      SPEAKRS_CLI_PATH: offBundleNative,
      SPEAKRS_EXCLUSIVE: '0',
      PATH: path.dirname(pathCandidate),
    };
    const spawned = buildSpeakrsSpawnEnv({
      userDataDir,
      requiredDevice: 'cuda',
      platform: 'win32',
      env: packagedEnv,
      resourcesPath,
      projectRoot: root,
      cliPath: offBundleNative,
      extra: {
        PATH: packagedEnv.PATH,
        SPEAKRS_CLI_PATH: pythonWrapper,
      },
    });

    assert.equal(spawned.SPEAKRS_CLI_PATH, bundled);
    assert.equal(path.basename(spawned.SPEAKRS_CLI_PATH), 'speakrs-cli.exe');
    assert.equal(spawned.SPEAKRS_CLI_PATH.toLowerCase().endsWith('.py'), false);
    assert.notEqual(spawned.SPEAKRS_CLI_PATH, offBundleNative);
    assert.notEqual(spawned.SPEAKRS_CLI_PATH, pythonWrapper);
    assert.notEqual(spawned.SPEAKRS_CLI_PATH, pathCandidate);
    assert.equal(resolveSpeakrsCliPathForSpawn({
      platform: 'win32',
      env: packagedEnv,
      resourcesPath,
      projectRoot: root,
    }), bundled);
    assert.equal(spawned.SPEAKRS_EXCLUSIVE, '1');
    assert.equal(spawned.AVANEVIS_PACKAGED, '1');
    assert.equal(spawned.SPEAKRS_MODE, 'cuda');
    assert.ok(spawned.PATH.startsWith(`${getSpeakrsOrtRuntimeDir(userDataDir)}${path.delimiter}`));
    assert.equal(
      spawned.ORT_DYLIB_PATH,
      path.join(getSpeakrsOrtRuntimeDir(userDataDir), 'onnxruntime.dll'),
    );
    assert.equal(spawned.PATH.includes(path.dirname(pathCandidate)), true);

    const pyDecoyEnv = buildSpeakrsSpawnEnv({
      userDataDir,
      requiredDevice: 'cuda',
      platform: 'win32',
      env: {
        AVANEVIS_PACKAGED: '1',
        SPEAKRS_CLI_PATH: pythonWrapper,
        PATH: path.dirname(pathCandidate),
      },
      resourcesPath,
      projectRoot: root,
      cliPath: pythonWrapper,
    });
    assert.equal(pyDecoyEnv.SPEAKRS_CLI_PATH, bundled);

    fs.rmSync(bundled);
    const missingBundled = buildSpeakrsSpawnEnv({
      userDataDir,
      requiredDevice: 'cuda',
      platform: 'win32',
      env: packagedEnv,
      resourcesPath,
      projectRoot: root,
      cliPath: offBundleNative,
      extra: { SPEAKRS_CLI_PATH: offBundleNative, PATH: packagedEnv.PATH },
    });
    assert.equal(missingBundled.SPEAKRS_CLI_PATH, bundled);
    assert.notEqual(missingBundled.SPEAKRS_CLI_PATH, offBundleNative);
    assert.equal(resolveSpeakrsCliPath({
      platform: 'win32',
      env: packagedEnv,
      resourcesPath,
      projectRoot: root,
    }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows Speakrs PATH prepends speakrs-ort once', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PATH uses `;`; host path.delimiter cannot simulate it on POSIX.');
    return;
  }
  const userDataDir = path.join('C:', 'Users', 'tester', 'AvaNevis');
  const ortDir = getSpeakrsOrtRuntimeDir(userDataDir);
  const spawned = buildSpeakrsSpawnEnv({
    userDataDir,
    requiredDevice: 'cuda',
    platform: 'win32',
    extra: {
      PATH: `${ortDir}${path.delimiter}${ortDir}${path.delimiter}C:\\Windows\\System32`,
    },
  });
  const parts = spawned.PATH.split(path.delimiter);
  assert.equal(parts[0], ortDir);
  assert.equal(parts.filter((part) => path.normalize(part) === path.normalize(ortDir)).length, 1);
});

test('packaged buildPythonEnv enforces packaged isolation after caller overrides', () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', {
    value: path.join(os.tmpdir(), 'avanevis-resources'),
    configurable: true,
    enumerable: true,
    writable: true,
  });
  const previousPackaged = process.env.AVANEVIS_PACKAGED;
  delete process.env.AVANEVIS_PACKAGED;
  try {
    const packagedRuntime = createPythonRuntime({
      app: { isPackaged: true },
      spawn: () => new EventEmitter(),
      path,
      fs,
      dirname: path.join(__dirname, '..', '..', 'src'),
    });
    const packagedEnv = packagedRuntime.buildPythonEnv({
      AVANEVIS_PACKAGED: '0',
      PYTHONDONTWRITEBYTECODE: '0',
      FOO: 'bar',
    });
    assert.equal(packagedEnv.AVANEVIS_PACKAGED, '1');
    assert.equal(packagedEnv.PYTHONDONTWRITEBYTECODE, '1');
    assert.equal(packagedEnv.FOO, 'bar');
    assert.equal(packagedEnv.PYTHONNOUSERSITE, '1');

    const devRuntime = createPythonRuntime({
      app: { isPackaged: false },
      spawn: () => new EventEmitter(),
      path,
      fs,
      dirname: path.join(__dirname, '..', '..', 'src'),
    });
    const callerOverride = devRuntime.buildPythonEnv({ AVANEVIS_PACKAGED: '0' });
    assert.equal(callerOverride.AVANEVIS_PACKAGED, '0');
    const inheritedDev = devRuntime.buildPythonEnv({});
    assert.equal(inheritedDev.AVANEVIS_PACKAGED, undefined);
  } finally {
    if (previousDescriptor) {
      Object.defineProperty(process, 'resourcesPath', previousDescriptor);
    } else {
      delete process.resourcesPath;
    }
    if (previousPackaged === undefined) {
      delete process.env.AVANEVIS_PACKAGED;
    } else {
      process.env.AVANEVIS_PACKAGED = previousPackaged;
    }
  }
});

test('buildPythonEnv unsets explicit undefined keys after merging process.env', () => {
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
    const merged = runtime.buildPythonEnv({
      HF_HOME: undefined,
      HF_HUB_CACHE: undefined,
      SPEAKRS_MODE: 'cuda',
    });
    assert.equal(Object.prototype.hasOwnProperty.call(merged, 'HF_HOME'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(merged, 'HF_HUB_CACHE'), false);
    assert.equal(merged.SPEAKRS_MODE, 'cuda');
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

test('QA AVANEVIS_DIARIZATION_ENGINE overrides spawn dispatch only', () => {
  assert.equal(resolveSpawnDiarizationEngine('pyannote', { AVANEVIS_DIARIZATION_ENGINE: 'speakrs' }), 'speakrs');
  assert.equal(resolveSpawnDiarizationEngine('speakrs', { AVANEVIS_DIARIZATION_ENGINE: 'pyannote' }), 'pyannote');
  assert.throws(
    () => assertLinuxSpeakrsOnlyEngine('pyannote', 'linux'),
    (error) => error && error.code === 'LINUX_PYANNOTE_UNAVAILABLE',
  );
  assert.equal(assertLinuxSpeakrsOnlyEngine('speakrs', 'linux'), 'speakrs');
  assert.equal(resolveSpawnDiarizationEngine('speakrs', {}), 'speakrs');
  assert.equal(canStartGuidedDiarization({
    status: 'ready',
    setupComplete: true,
    engine: 'speakrs',
    modelRef: null,
  }), true);
});

test('Speakrs setup progress never exposes URLs tokens or filesystem paths', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-progress-'));
  const events = [];
  try {
    await installValidTestSetup(userDataDir, createPinnedTestCatalog(), (event) => events.push(event));
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes('https://'), false);
    assert.equal(serialized.includes(userDataDir), false);
    assert.equal(serialized.includes('hf_secret'), false);
    assert.equal(serialized.includes('.tar.gz'), false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('prepared legal resources include nested Speakrs model-pack notices', () => {
  const destinationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-legal-stage-'));
  try {
    stageLegalBundle(destinationDir);
    assert.equal(
      fs.existsSync(path.join(destinationDir, 'speakrs-model-pack', 'ATTRIBUTION.md')),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(destinationDir, 'speakrs-model-pack', 'LICENSES', 'CC-BY-4.0.txt')),
      true,
    );
  } finally {
    fs.rmSync(destinationDir, { recursive: true, force: true });
  }
});

test('Speakrs install and validation preserve nested CoreML-style bundle paths', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-nested-model-'));
  const modelPath = 'speaker.mlmodelc/weights/weight.bin';
  const catalog = createPinnedTestCatalog(modelPath);
  try {
    await installValidTestSetup(userDataDir, catalog);
    const installedPath = path.join(
      getSpeakrsModelRevisionDir(userDataDir, SPEAKRS_MODEL_PACK_REVISION),
      ...modelPath.split('/'),
    );
    assert.deepEqual(fs.readFileSync(installedPath), MODEL_BYTES);
    assert.equal((await checkSpeakrsModelCache({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      catalog,
      verifyChecksum: true,
    })).valid, true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Speakrs install rejects unsafe required-file paths before downloading', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-unsafe-model-'));
  const catalog = createPinnedTestCatalog();
  catalog.diarization.models[0].packArtifacts['win32-x64'][0].requiredFiles[0].path = '../escape.bin';
  let downloads = 0;
  try {
    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      downloader: async () => {
        downloads += 1;
      },
      extractor: createTestExtractor(),
    });
    assert.equal(status.features.diarization.status, 'error');
    assert.match(status.features.diarization.error, /Unsafe Speakrs model-pack path/);
    assert.equal(downloads, 0);
    assert.equal(fs.existsSync(path.join(userDataDir, 'escape.bin')), false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Windows production runtime rejects replaced DLLs even with a forged install.json', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-runtime-'));
  const artifact = getSpeakrsSetupArtifactsForPlatform('win32', 'x64');
  const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const files = {};
    for (const fileName of RUNTIME_DLL_NAMES) {
      const contents = Buffer.from(`MZ-production-${fileName}`);
      fs.writeFileSync(path.join(runtimeDir, fileName), contents);
      files[fileName] = {
        sizeBytes: contents.length,
        sha256: crypto.createHash('sha256').update(contents).digest('hex'),
      };
    }
    fs.writeFileSync(path.join(runtimeDir, 'install.json'), JSON.stringify({
      artifacts: artifact.runtimeArtifacts.map((entry) => ({ id: entry.id, sha256: entry.sha256 })),
      files,
    }));

    const fullHash = await checkSpeakrsRuntimeCache({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      verifyChecksum: true,
    });
    assert.equal(fullHash.valid, false);

    const passive = await checkSpeakrsRuntimeCache({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      verifyChecksum: false,
    });
    assert.equal(passive.valid, false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('forged install.json hashes cannot pass Speakrs compute admission', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-forged-runtime-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
    const target = path.join(runtimeDir, RUNTIME_DLL_NAMES[0]);
    const original = fs.readFileSync(target);
    const forged = Buffer.alloc(original.length, 0x41);
    fs.writeFileSync(target, forged);
    const manifestPath = path.join(runtimeDir, 'install.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files[RUNTIME_DLL_NAMES[0]] = {
      sizeBytes: forged.length,
      sha256: crypto.createHash('sha256').update(forged).digest('hex'),
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const passive = await checkAiAddonSetupStatus({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      catalog,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe') },
    });
    assert.equal(passive.features.diarization.status, 'ready');

    const admission = await checkAiAddonSetupStatus({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      catalog,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe') },
      computeAdmission: true,
    });
    assert.equal(admission.features.diarization.status, 'error');
    assert.equal(admission.features.diarization.setupComplete, false);
    assert.ok(admission.features.diarization.runtimeCache.invalidFiles.includes(RUNTIME_DLL_NAMES[0]));
    assert.match(admission.features.diarization.error, /integrity validation/i);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('forged model-pack metadata cannot pass Speakrs compute admission', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-forged-model-pack-'));
  const catalog = createPinnedTestCatalog();
  const cliPath = path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe');
  try {
    await installValidTestSetup(userDataDir, catalog);
    const modelPath = getSpeakrsSetupArtifactsForPlatform('win32', 'x64', catalog).modelFiles[0].path;
    const target = path.join(getSpeakrsModelRevisionDir(userDataDir, SPEAKRS_MODEL_PACK_REVISION), ...modelPath.split('/'));
    const original = fs.readFileSync(target);
    const forged = Buffer.alloc(original.length, 0x41);
    fs.writeFileSync(target, forged);
    fs.writeFileSync(path.join(path.dirname(target), 'install.json'), `${JSON.stringify({
      files: {
        [modelPath]: {
          sizeBytes: forged.length,
          sha256: crypto.createHash('sha256').update(forged).digest('hex'),
        },
      },
    }, null, 2)}\n`);

    const passive = await checkAiAddonSetupStatus({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      catalog,
      env: { SPEAKRS_CLI_PATH: cliPath },
    });
    assert.equal(passive.features.diarization.status, 'ready');

    const admission = await checkAiAddonSetupStatus({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      catalog,
      env: { SPEAKRS_CLI_PATH: cliPath },
      computeAdmission: true,
    });
    assert.equal(admission.features.diarization.status, 'error');
    assert.equal(admission.features.diarization.setupComplete, false);
    assert.equal(admission.features.diarization.packCache.checksumStatus, 'mismatch');
    assert.match(admission.features.diarization.packCache.reason, /pinned checksum/);
    assert.match(admission.features.diarization.error, /checksum does not match the pinned checksum/i);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Speakrs compute admission caches unchanged DLL fingerprints and rehashes changed metadata', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-runtime-fingerprint-'));
  const catalog = createPinnedTestCatalog();
  const cliPath = path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe');
  try {
    await installValidTestSetup(userDataDir, catalog);
    let hashReads = 0;
    const fsModule = Object.create(fs);
    Object.defineProperty(fsModule, 'createReadStream', {
      value(filePath, ...args) {
        if (RUNTIME_DLL_NAMES.includes(path.basename(filePath))) {
          hashReads += 1;
        }
        return fs.createReadStream(filePath, ...args);
      },
    });

    const options = {
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      fsModule,
      catalog,
      env: { SPEAKRS_CLI_PATH: cliPath },
      computeAdmission: true,
    };
    assert.equal((await checkAiAddonSetupStatus(options)).features.diarization.setupComplete, true);
    assert.equal(hashReads, RUNTIME_DLL_NAMES.length);
    assert.equal((await checkAiAddonSetupStatus(options)).features.diarization.setupComplete, true);
    assert.equal(hashReads, RUNTIME_DLL_NAMES.length, 'unchanged fingerprints must skip redundant hashes');

    const changedPath = path.join(getSpeakrsOrtRuntimeDir(userDataDir), RUNTIME_DLL_NAMES[0]);
    const changedStats = fs.statSync(changedPath);
    fs.utimesSync(changedPath, changedStats.atime, new Date(changedStats.mtimeMs + 5000));
    assert.equal((await checkAiAddonSetupStatus(options)).features.diarization.setupComplete, true);
    assert.equal(hashReads, RUNTIME_DLL_NAMES.length + 1, 'changed mtime must force a full hash');

    fs.appendFileSync(changedPath, Buffer.from('x'));
    const changedSize = await checkAiAddonSetupStatus(options);
    assert.equal(changedSize.features.diarization.setupComplete, false);
    assert.equal(hashReads, RUNTIME_DLL_NAMES.length + 2, 'changed size must force a full hash');
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Pyannote compute admission does not hash Speakrs runtime DLLs', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyannote-no-speakrs-hash-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const manifestPath = path.join(userDataDir, 'ai-addons', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.features.diarization = {
      ...manifest.features.diarization,
      engine: 'pyannote',
      modelId: PYANNOTE_DIARIZATION_MODEL_ID,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    let runtimeHashReads = 0;
    const fsModule = Object.create(fs);
    Object.defineProperty(fsModule, 'createReadStream', {
      value(filePath, ...args) {
        if (RUNTIME_DLL_NAMES.includes(path.basename(filePath))) {
          runtimeHashReads += 1;
        }
        return fs.createReadStream(filePath, ...args);
      },
    });
    await checkAiAddonSetupStatus({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      fsModule,
      catalog,
      computeAdmission: true,
    });
    assert.equal(runtimeHashReads, 0);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('QA Speakrs compute admission hashes the runtime even when the manifest selects Pyannote', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-speakrs-runtime-hash-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const manifestPath = path.join(userDataDir, 'ai-addons', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.features.diarization = {
      ...manifest.features.diarization,
      engine: 'pyannote',
      modelId: PYANNOTE_DIARIZATION_MODEL_ID,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    let runtimeHashReads = 0;
    const fsModule = Object.create(fs);
    Object.defineProperty(fsModule, 'createReadStream', {
      value(filePath, ...args) {
        if (RUNTIME_DLL_NAMES.includes(path.basename(filePath))) {
          runtimeHashReads += 1;
        }
        return fs.createReadStream(filePath, ...args);
      },
    });
    await checkAiAddonSetupStatus({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      fsModule,
      catalog,
      env: { AVANEVIS_DIARIZATION_ENGINE: 'speakrs' },
      computeAdmission: true,
    });
    assert.equal(runtimeHashReads, RUNTIME_DLL_NAMES.length);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Windows test runtime requires every non-empty integrity-checked DLL', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-runtime-required-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
    for (const fileName of RUNTIME_DLL_NAMES) {
      const filePath = path.join(runtimeDir, fileName);
      const original = fs.readFileSync(filePath);
      fs.rmSync(filePath);
      const result = await checkSpeakrsRuntimeCache({
        userDataDir,
        platform: 'win32',
        arch: 'x64',
        catalog,
        verifyChecksum: true,
      });
      assert.equal(result.valid, false, `${fileName} must be required`);
      assert.ok(result.missingFiles.includes(fileName));
      fs.writeFileSync(filePath, original);
    }

    const corruptPath = path.join(runtimeDir, RUNTIME_DLL_NAMES[0]);
    const original = fs.readFileSync(corruptPath);
    fs.writeFileSync(corruptPath, Buffer.alloc(original.length, 0));
    assert.equal((await checkSpeakrsRuntimeCache({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      catalog,
      verifyChecksum: true,
    })).valid, false);
    fs.writeFileSync(corruptPath, Buffer.alloc(0));
    assert.equal((await checkSpeakrsRuntimeCache({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      catalog,
      verifyChecksum: true,
    })).valid, false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Windows runtime fails closed when runtime artifact metadata is absent', async () => {
  const catalog = JSON.parse(JSON.stringify(AI_MODEL_CATALOG));
  const speakrs = catalog.diarization.models.find((model) => model.id === SPEAKRS_DIARIZATION_MODEL_ID);
  speakrs.packArtifacts['win32-x64'] = speakrs.packArtifacts['win32-x64']
    .filter((entry) => entry.kind === 'model-pack');
  const result = await checkSpeakrsRuntimeCache({
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-no-runtime-')),
    platform: 'win32',
    arch: 'x64',
    catalog,
  });
  assert.equal(result.supported, false);
  assert.equal(result.valid, false);
  assert.match(result.reason, /No complete Speakrs ONNX Runtime artifact/);
  fs.rmSync(path.dirname(result.runtimeDir), { recursive: true, force: true });
});

test('canceling runtime repair preserves a previously valid model pack', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-runtime-cancel-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const modelPath = path.join(getSpeakrsModelRevisionDir(userDataDir, SPEAKRS_MODEL_PACK_REVISION), 'model.bin');
    const modelBefore = fs.readFileSync(modelPath);
    fs.rmSync(path.join(getSpeakrsOrtRuntimeDir(userDataDir), 'cufft64_11.dll'));

    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe') },
      downloader: createAbortDownloader(),
      extractor: createTestExtractor(),
    });

    assert.deepEqual(fs.readFileSync(modelPath), modelBefore);
    assertNotReady(status);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('canceling model repair preserves a previously valid Windows runtime', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-model-cancel-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
    const runtimeBefore = new Map(RUNTIME_DLL_NAMES.map((name) => [
      name,
      fs.readFileSync(path.join(runtimeDir, name)),
    ]));
    fs.rmSync(path.join(getSpeakrsModelRevisionDir(userDataDir, SPEAKRS_MODEL_PACK_REVISION), 'model.bin'));

    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe') },
      downloader: createAbortDownloader(),
      extractor: createTestExtractor(),
    });

    for (const [name, contents] of runtimeBefore) {
      assert.deepEqual(fs.readFileSync(path.join(runtimeDir, name)), contents);
    }
    assertNotReady(status);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('cancellation during runtime extraction removes attempt staging and downloads', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-extract-cancel-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
    const modelPath = path.join(getSpeakrsModelRevisionDir(userDataDir, SPEAKRS_MODEL_PACK_REVISION), 'model.bin');
    const modelBefore = fs.readFileSync(modelPath);
    fs.rmSync(path.join(runtimeDir, 'cufft64_11.dll'));

    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe') },
      downloader: async ({ destinationPath }) => fs.writeFileSync(destinationPath, ARCHIVE_BYTES),
      extractor: async (_archivePath, destinationDir) => {
        fs.mkdirSync(destinationDir, { recursive: true });
        fs.writeFileSync(path.join(destinationDir, 'partial.dll'), 'partial');
        const error = new Error('Speaker identification setup was canceled.');
        error.name = 'AbortError';
        error.code = 'AI_ADDON_SETUP_CANCELLED';
        throw error;
      },
    });

    assert.deepEqual(fs.readFileSync(modelPath), modelBefore);
    const runtimeParentEntries = fs.readdirSync(path.dirname(runtimeDir));
    assert.equal(runtimeParentEntries.some((name) => name.includes('.install-') || name.includes('.download-')), false);
    assertNotReady(status);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('cancellation after model commit does not restore unvalidated ready', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-model-commit-cancel-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
    const runtimeBefore = new Map(RUNTIME_DLL_NAMES.map((name) => [
      name,
      fs.readFileSync(path.join(runtimeDir, name)),
    ]));
    const modelPath = path.join(getSpeakrsModelRevisionDir(userDataDir, SPEAKRS_MODEL_PACK_REVISION), 'model.bin');
    fs.rmSync(modelPath);

    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe') },
      downloader: async ({ destinationPath }) => fs.writeFileSync(destinationPath, ARCHIVE_BYTES),
      extractor: createTestExtractor(),
      runtimeValidator: createCancelingRuntimeValidator(),
    });

    assert.equal(status.features.diarization.status, 'notConfigured');
    assertNotReady(status);
    assert.equal(fs.existsSync(modelPath), true);
    for (const [name, contents] of runtimeBefore) {
      assert.deepEqual(fs.readFileSync(path.join(runtimeDir, name)), contents);
    }
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('cancellation after runtime commit does not restore unvalidated ready', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-runtime-commit-cancel-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const modelPath = path.join(getSpeakrsModelRevisionDir(userDataDir, SPEAKRS_MODEL_PACK_REVISION), 'model.bin');
    const modelBefore = fs.readFileSync(modelPath);
    fs.rmSync(path.join(getSpeakrsOrtRuntimeDir(userDataDir), 'cufft64_11.dll'));

    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe') },
      downloader: async ({ destinationPath }) => fs.writeFileSync(destinationPath, ARCHIVE_BYTES),
      extractor: createTestExtractor(),
      runtimeValidator: createCancelingRuntimeValidator(),
    });

    assert.equal(status.features.diarization.status, 'notConfigured');
    assertNotReady(status);
    assert.deepEqual(fs.readFileSync(modelPath), modelBefore);
    assert.equal(fs.existsSync(path.join(getSpeakrsOrtRuntimeDir(userDataDir), 'cufft64_11.dll')), true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('cancellation after both Speakrs commits does not restore unvalidated ready', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-both-commit-cancel-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const modelPath = path.join(getSpeakrsModelRevisionDir(userDataDir, SPEAKRS_MODEL_PACK_REVISION), 'model.bin');
    const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
    fs.rmSync(modelPath);
    fs.rmSync(path.join(runtimeDir, 'onnxruntime.dll'));

    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe') },
      downloader: async ({ destinationPath }) => fs.writeFileSync(destinationPath, ARCHIVE_BYTES),
      extractor: createTestExtractor(),
      runtimeValidator: createCancelingRuntimeValidator(),
    });

    assert.equal(status.features.diarization.status, 'notConfigured');
    assertNotReady(status);
    assert.equal(fs.existsSync(modelPath), true);
    assert.equal(fs.existsSync(path.join(runtimeDir, 'onnxruntime.dll')), true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('cancellation before any Speakrs commit does not mark ready', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-before-commit-cancel-'));
  const catalog = createPinnedTestCatalog();
  try {
    const cliPath = path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, 'cli');
    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: cliPath },
      downloader: createAbortDownloader(),
      extractor: createTestExtractor(),
    });

    assert.equal(status.features.diarization.status, 'notConfigured');
    assertNotReady(status);
    assert.equal(fs.existsSync(path.join(getSpeakrsOrtRuntimeDir(userDataDir), 'onnxruntime.dll')), false);
    assert.equal(
      fs.existsSync(path.join(getSpeakrsModelRevisionDir(userDataDir, SPEAKRS_MODEL_PACK_REVISION), 'model.bin')),
      false,
    );
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Speakrs setup retries a transient Windows runtime-directory rename', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-runtime-rename-retry-'));
  const catalog = createPinnedTestCatalog();
  const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
  let runtimeRenameAttempts = 0;
  const fsModule = {
    ...fs,
    renameSync(fromPath, toPath) {
      if (path.resolve(toPath) === path.resolve(runtimeDir)) {
        runtimeRenameAttempts += 1;
        if (runtimeRenameAttempts === 1) {
          const error = new Error('simulated transient Windows directory lock');
          error.code = 'EPERM';
          throw error;
        }
      }
      return fs.renameSync(fromPath, toPath);
    },
  };
  try {
    const cliPath = path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, 'cli');
    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: cliPath },
      fsModule,
      downloader: async ({ destinationPath }) => fs.writeFileSync(destinationPath, ARCHIVE_BYTES),
      extractor: createTestExtractor(),
    });

    assert.equal(status.features.diarization.status, 'ready');
    assert.equal(runtimeRenameAttempts, 2);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('cancellation with no Speakrs artifact changes may restore previous ready', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-unchanged-cancel-'));
  const catalog = createPinnedTestCatalog();
  try {
    await installValidTestSetup(userDataDir, catalog);
    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli.exe') },
      downloader: async () => {
        throw new Error('download should not start');
      },
      extractor: createTestExtractor(),
      runtimeValidator: createCancelingRuntimeValidator(),
    });

    assert.equal(status.features.diarization.status, 'ready');
    assert.equal(status.features.diarization.setupComplete, true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('exclusive switch propagates real-filesystem deletion failures', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-delete-failure-'));
  const speakrsRoot = path.join(userDataDir, 'ai-addons', 'models', 'diarization', 'speakrs');
  const realFsWithDeletionFailure = {
    ...fs,
    rmSync(targetPath, options) {
      if (path.resolve(targetPath) === path.resolve(speakrsRoot)) {
        throw new Error('simulated locked directory');
      }
      return fs.rmSync(targetPath, options);
    },
    promises: {
      ...fs.promises,
      rm(targetPath, options) {
        if (path.resolve(targetPath) === path.resolve(speakrsRoot)) {
          return Promise.reject(new Error('simulated locked directory'));
        }
        return fs.promises.rm(targetPath, options);
      },
    },
  };
  try {
    fs.mkdirSync(speakrsRoot, { recursive: true });
    fs.writeFileSync(path.join(speakrsRoot, 'model.bin'), MODEL_BYTES);
    await assert.rejects(
      () => setupDiarizationAddon({
        userDataDir,
        platform: 'win32',
        arch: 'x64',
        engine: 'pyannote',
        token: 'hf_validtoken123',
        safeStorage: createSafeStorage(),
        fsModule: realFsWithDeletionFailure,
        catalog: createPinnedTestCatalog(),
      }),
      /simulated locked directory/,
    );
    assert.equal(fs.existsSync(speakrsRoot), true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('pyannote uninstall roots are exact and exclude sanitized model-id paths', () => {
  const userDataDir = path.join('C:', 'Users', 'tester', 'AvaNevis');
  assert.deepEqual(getPyannoteUninstallPaths(userDataDir), [
    path.join(userDataDir, 'ai-addons', 'dependencies', 'diarization'),
    path.join(userDataDir, 'ai-addons', 'models', 'diarization', 'hub'),
    path.join(userDataDir, 'ai-addons', 'models', 'diarization', 'xet'),
    path.join(userDataDir, 'ai-addons', 'models', 'diarization', '.locks'),
  ]);
  assert.equal(
    getPyannoteUninstallPaths(userDataDir).some((entry) => entry.includes('pyannote_speaker-diarization')),
    false,
  );
});

test('pyannote uninstall removes its exact roots even when they are empty directories', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyannote-empty-roots-'));
  try {
    const roots = getPyannoteUninstallPaths(userDataDir);
    for (const root of roots) {
      fs.mkdirSync(root, { recursive: true });
    }
    await uninstallPyannoteLocalState({ userDataDir });
    assert.ok(roots.every((root) => !fs.existsSync(root)));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('uninstalling Speakrs never reaches shared CUDA, Whisper, or bundled CLI roots', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-exact-delete-'));
  const sharedFiles = [
    path.join(userDataDir, 'Python', 'site-packages', 'nvidia', 'cublas', 'bin', 'cublas64_12.dll'),
    path.join(userDataDir, '.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-small', 'model.bin'),
    path.join(userDataDir, 'Resources', 'bin', 'speakrs-cli.exe'),
  ];
  try {
    for (const filePath of sharedFiles) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'keep');
    }
    fs.mkdirSync(getSpeakrsOrtRuntimeDir(userDataDir), { recursive: true });
    fs.mkdirSync(path.dirname(getSpeakrsModelRevisionDir(userDataDir)), { recursive: true });
    await uninstallSpeakrsLocalState({ userDataDir });
    assert.ok(sharedFiles.every((filePath) => fs.existsSync(filePath)));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('token-only Pyannote uninstall deletes the saved token and exact roots only', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyannote-token-only-'));
  const tokenPath = getTokenPath(userDataDir, TOKEN_KEYS.diarizationHuggingFace);
  const cudaPip = path.join(userDataDir, 'Python', 'site-packages', 'nvidia', 'cublas', 'bin', 'cublas64_12.dll');
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, Buffer.from('encrypted:hf_secret'));
    fs.mkdirSync(path.dirname(cudaPip), { recursive: true });
    fs.writeFileSync(cudaPip, 'keep');
    await uninstallPyannoteLocalState({ userDataDir });
    assert.equal(fs.existsSync(tokenPath), false);
    assert.equal(fs.existsSync(cudaPip), true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Pyannote uninstall can keep the saved token when switching to Speakrs', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyannote-keep-token-'));
  const tokenPath = getTokenPath(userDataDir, TOKEN_KEYS.diarizationHuggingFace);
  try {
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, Buffer.from('encrypted:hf_secret'));
    await uninstallPyannoteLocalState({ userDataDir, deleteToken: false });
    assert.equal(fs.existsSync(tokenPath), true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Speakrs uninstall unlinks a replaced root without following the symlink', async (t) => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-symlink-delete-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-outside-target-'));
  const speakrsRoot = path.join(userDataDir, 'ai-addons', 'models', 'diarization', 'speakrs');
  const outsideFile = path.join(outsideDir, 'keep.bin');
  try {
    fs.mkdirSync(path.dirname(speakrsRoot), { recursive: true });
    fs.writeFileSync(outsideFile, 'keep');
    try {
      fs.symlinkSync(outsideDir, speakrsRoot, 'dir');
    } catch (_error) {
      t.skip('Symlink path hardening test requires directory symlink support.');
      return;
    }
    await uninstallSpeakrsLocalState({ userDataDir });
    assert.equal(fs.existsSync(speakrsRoot), false);
    assert.equal(fs.existsSync(outsideFile), true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('engine uninstall uses awaited fs.promises.rm on real trees', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-async-rm-'));
  const speakrsRoot = path.join(userDataDir, 'ai-addons', 'models', 'diarization', 'speakrs');
  const nested = path.join(speakrsRoot, 'rev', 'weights.bin');
  const originalRm = fs.promises.rm;
  const rmCalls = [];
  fs.promises.rm = async (targetPath, options) => {
    rmCalls.push({ targetPath, options });
    return originalRm.call(fs.promises, targetPath, options);
  };
  try {
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, Buffer.alloc(64 * 1024, 7));
    await uninstallSpeakrsLocalState({ userDataDir });
    assert.equal(fs.existsSync(speakrsRoot), false);
    assert.ok(rmCalls.some((call) => path.resolve(call.targetPath) === path.resolve(speakrsRoot)));
    assert.equal(rmCalls[0].options.recursive, true);
  } finally {
    fs.promises.rm = originalRm;
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('packaged missing Speakrs CLI preflight is a reinstall error, not a Python traceback', () => {
  assert.equal(SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE, RENDERER_SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE);
  const error = getPackagedSpeakrsCliPreflightError({
    engine: 'speakrs',
    env: { AVANEVIS_PACKAGED: '1' },
    platform: 'win32',
    resourcesPath: path.join(os.tmpdir(), 'avanevis-empty-resources'),
    fsModule: { existsSync: () => false },
  });
  assert.ok(error);
  assert.equal(error.code, 'SPEAKRS_PACKAGED_CLI_MISSING');
  assert.equal(error.message, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE);
  assert.doesNotMatch(error.message, /FileNotFoundError|traceback|re-run speaker setup/i);
  assert.equal(getPackagedSpeakrsCliPreflightError({
    engine: 'pyannote',
    env: { AVANEVIS_PACKAGED: '1' },
    platform: 'win32',
    resourcesPath: path.join(os.tmpdir(), 'avanevis-empty-resources'),
    fsModule: { existsSync: () => false },
  }), null);
  assert.equal(getPackagedSpeakrsCliPreflightError({
    engine: 'speakrs',
    env: {},
    platform: 'win32',
    resourcesPath: path.join(os.tmpdir(), 'avanevis-empty-resources'),
    fsModule: { existsSync: () => false },
  }), null);
});

test('Linux Speakrs spawn env is CUDA-only and ignores ambient LD_LIBRARY_PATH', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-speakrs-env-'));
  try {
    const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
    const cublasDir = path.join(userDataDir, 'ai-addons', 'cuda', 'python', 'nvidia', 'cublas', 'lib');
    const cudnnDir = path.join(userDataDir, 'ai-addons', 'cuda', 'python', 'nvidia', 'cudnn', 'lib');
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cublasDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cudnnDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(runtimeDir, 0o700);
    fs.chmodSync(cublasDir, 0o700);
    fs.chmodSync(cudnnDir, 0o700);
    fs.writeFileSync(path.join(runtimeDir, 'libonnxruntime.so.1.27.1'), 'so');

    const env = buildSpeakrsSpawnEnv({
      userDataDir,
      extra: {
        LD_LIBRARY_PATH: '/tmp/hostile-libs',
        SPEAKRS_MODE: 'cpu',
        HF_TOKEN: 'should-clear',
        HUGGINGFACE_HUB_TOKEN: 'should-clear',
      },
      env: {
        PATH: '/usr/bin',
        HOME: '/home/test',
        SPEAKRS_MODE: 'cpu',
        LD_LIBRARY_PATH: '/tmp/ambient',
        HF_HUB_CACHE: '/tmp/hf',
      },
      platform: 'linux',
      arch: 'x64',
    });

    assert.equal(env.SPEAKRS_MODE, 'cuda');
    assert.equal(env.HF_TOKEN, undefined);
    assert.equal(env.HUGGINGFACE_HUB_TOKEN, undefined);
    assert.equal(env.HF_HUB_CACHE, undefined);
    assert.doesNotMatch(String(env.LD_LIBRARY_PATH || ''), /hostile-libs|ambient/);
    assert.ok(String(env.LD_LIBRARY_PATH || '').startsWith(runtimeDir));
    assert.ok(env.LD_LIBRARY_PATH.includes(cublasDir));
    assert.ok(env.LD_LIBRARY_PATH.includes(cudnnDir));
    assert.equal(env.ORT_DYLIB_PATH, path.join(runtimeDir, 'libonnxruntime.so.1.27.1'));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Linux Speakrs setup stays unsupported without CUDA preflight', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-speakrs-nocuda-'));
  const catalog = createPinnedLinuxTestCatalog();
  try {
    const cliPath = path.join(userDataDir, 'dev-bin', 'speakrs-cli');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, 'cli');
    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'linux',
      arch: 'x64',
      engine: 'speakrs',
      safeStorage: createSafeStorage(),
      catalog,
      env: { SPEAKRS_CLI_PATH: cliPath },
      downloader: async () => {
        throw new Error('Linux Speakrs must not download without CUDA preflight');
      },
    });
    assert.equal(status.features.diarization.status, 'unsupported');
    assert.equal(status.features.diarization.availability.supported, false);
    assert.match(status.features.diarization.availability.reason, /CUDA 12/);
    assert.equal(status.features.diarization.setupComplete, false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Linux Pyannote setup stays unavailable even when Speakrs CUDA is ready', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-pyannote-reject-'));
  try {
    const status = await setupDiarizationAddon({
      userDataDir,
      platform: 'linux',
      arch: 'x64',
      engine: 'pyannote',
      safeStorage: createSafeStorage(),
      cudaStatus: READY_LINUX_CUDA,
      downloader: async () => {
        throw new Error('Linux Pyannote must not download');
      },
    });
    assert.equal(status.features.diarization.status, 'unsupported');
    assert.equal(status.features.diarization.error, LINUX_PYANNOTE_UNAVAILABLE_REASON);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Linux Speakrs compute admission rejects forged runtime hashes in user-writable install.json', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-linux-forged-install-'));
  const catalog = createPinnedLinuxTestCatalog();
  try {
    await installValidLinuxTestSetup(userDataDir, catalog);
    const runtimeDir = getSpeakrsOrtRuntimeDir(userDataDir);
    const target = path.join(runtimeDir, RUNTIME_SO_NAMES[0]);
    const original = fs.readFileSync(target);
    const forged = Buffer.alloc(original.length, 0x41);
    fs.writeFileSync(target, forged);
    const manifestPath = path.join(runtimeDir, 'install.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files[RUNTIME_SO_NAMES[0]] = {
      sizeBytes: forged.length,
      sha256: crypto.createHash('sha256').update(forged).digest('hex'),
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const passive = await checkAiAddonSetupStatus({
      userDataDir,
      platform: 'linux',
      arch: 'x64',
      catalog,
      cudaStatus: READY_LINUX_CUDA,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli') },
    });
    assert.equal(passive.features.diarization.status, 'ready');

    const admission = await checkAiAddonSetupStatus({
      userDataDir,
      platform: 'linux',
      arch: 'x64',
      catalog,
      cudaStatus: READY_LINUX_CUDA,
      env: { SPEAKRS_CLI_PATH: path.join(userDataDir, 'dev-bin', 'speakrs-cli') },
      computeAdmission: true,
    });
    assert.equal(admission.features.diarization.status, 'error');
    assert.equal(admission.features.diarization.setupComplete, false);
    assert.ok(admission.features.diarization.runtimeCache.invalidFiles.includes(RUNTIME_SO_NAMES[0]));
    assert.match(admission.features.diarization.error, /integrity validation/i);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Linux Speakrs compute admission caches unchanged SO fingerprints and rehashes changed metadata', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-linux-runtime-fingerprint-'));
  const catalog = createPinnedLinuxTestCatalog();
  const cliPath = path.join(userDataDir, 'dev-bin', 'speakrs-cli');
  try {
    await installValidLinuxTestSetup(userDataDir, catalog);
    let hashReads = 0;
    const fsModule = Object.create(fs);
    Object.defineProperty(fsModule, 'createReadStream', {
      value(filePath, ...args) {
        if (RUNTIME_SO_NAMES.includes(path.basename(filePath))) {
          hashReads += 1;
        }
        return fs.createReadStream(filePath, ...args);
      },
    });

    const options = {
      userDataDir,
      platform: 'linux',
      arch: 'x64',
      fsModule,
      catalog,
      cudaStatus: READY_LINUX_CUDA,
      env: { SPEAKRS_CLI_PATH: cliPath },
      computeAdmission: true,
    };
    assert.equal((await checkAiAddonSetupStatus(options)).features.diarization.setupComplete, true);
    assert.equal(hashReads, RUNTIME_SO_NAMES.length);
    assert.equal((await checkAiAddonSetupStatus(options)).features.diarization.setupComplete, true);
    assert.equal(hashReads, RUNTIME_SO_NAMES.length, 'unchanged fingerprints must skip redundant hashes');

    const changedPath = path.join(getSpeakrsOrtRuntimeDir(userDataDir), RUNTIME_SO_NAMES[0]);
    const changedStats = fs.statSync(changedPath);
    fs.utimesSync(changedPath, changedStats.atime, new Date(changedStats.mtimeMs + 5000));
    assert.equal((await checkAiAddonSetupStatus(options)).features.diarization.setupComplete, true);
    assert.equal(hashReads, RUNTIME_SO_NAMES.length + 1, 'changed mtime must force a full hash');

    fs.appendFileSync(changedPath, Buffer.from('x'));
    const changedSize = await checkAiAddonSetupStatus(options);
    assert.equal(changedSize.features.diarization.setupComplete, false);
    assert.equal(hashReads, RUNTIME_SO_NAMES.length + 2, 'changed size must force a full hash');
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Linux Speakrs runtime cache flags missing managed CUDA libraries from requiredDynamicLibraries', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-linux-missing-cublas-'));
  const catalog = createPinnedLinuxTestCatalog();
  try {
    await installValidLinuxTestSetup(userDataDir, catalog);
    catalog.diarization.models[0].packArtifacts['linux-x64'][1].requiredDynamicLibraries = [
      {
        name: 'libcublas.so.12',
        source: 'managed-cuda-runtime',
        relativePath: 'nvidia/cublas/lib/libcublas.so.12',
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        sizeBytes: 16,
      },
    ];
    const runtimeCache = await checkSpeakrsRuntimeCache({
      userDataDir,
      platform: 'linux',
      arch: 'x64',
      catalog,
      verifyChecksum: true,
    });
    assert.equal(runtimeCache.valid, false);
    assert.ok(runtimeCache.missingFiles.includes('libcublas.so.12'));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('uninstalling Linux Speakrs never reaches managed CUDA or Whisper roots', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-linux-exact-delete-'));
  const sharedFiles = [
    path.join(userDataDir, 'ai-addons', 'cuda', 'python', 'nvidia', 'cublas', 'lib', 'libcublas.so.12'),
    path.join(userDataDir, '.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-small', 'model.bin'),
    path.join(userDataDir, 'Resources', 'bin', 'speakrs-cli'),
  ];
  try {
    for (const filePath of sharedFiles) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'keep');
    }
    fs.mkdirSync(getSpeakrsOrtRuntimeDir(userDataDir), { recursive: true });
    fs.mkdirSync(path.dirname(getSpeakrsModelRevisionDir(userDataDir)), { recursive: true });
    await uninstallSpeakrsLocalState({ userDataDir });
    assert.ok(sharedFiles.every((filePath) => fs.existsSync(filePath)));
    assert.equal(fs.existsSync(getSpeakrsOrtRuntimeDir(userDataDir)), false);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Linux ORT tar flatten keeps selected .so files at dest root and removes extras', () => {
  const destinationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-linux-ort-flatten-'));
  try {
    fs.mkdirSync(path.join(destinationDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(destinationDir, 'lib', 'libonnxruntime.so.1.27.1'), 'ort');
    fs.writeFileSync(path.join(destinationDir, 'lib', 'unused.so'), 'drop');
    fs.writeFileSync(path.join(destinationDir, 'README.txt'), 'drop');
    flattenSelectedArchiveFiles(destinationDir, ['libonnxruntime.so.1.27.1']);
    assert.equal(fs.readFileSync(path.join(destinationDir, 'libonnxruntime.so.1.27.1'), 'utf8'), 'ort');
    assert.equal(fs.existsSync(path.join(destinationDir, 'lib')), false);
    assert.equal(fs.existsSync(path.join(destinationDir, 'README.txt')), false);
  } finally {
    fs.rmSync(destinationDir, { recursive: true, force: true });
  }
});
