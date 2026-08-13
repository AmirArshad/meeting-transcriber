const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  AI_MODEL_CATALOG,
  PYANNOTE_DIARIZATION_MODEL_ID,
  SPEAKRS_DIARIZATION_MODEL_ID,
  getSpeakrsSetupArtifactsForPlatform,
} = require('../../src/ai-addon-state');
const {
  checkSpeakrsRuntimeCache,
  checkSpeakrsModelCache,
  getPyannoteUninstallPaths,
  getSpeakrsModelRevisionDir,
  getSpeakrsOrtRuntimeDir,
  resolveSpeakrsCliPath,
  resolveSpeakrsCliPathForSpawn,
  buildSpeakrsSpawnEnv,
  canStartGuidedDiarization,
  resolveSpawnDiarizationEngine,
} = require('../../src/ai-addon/manifest-store');
const { createPythonRuntime } = require('../../src/main/python-runtime');
const {
  setupDiarizationAddon,
  uninstallPyannoteLocalState,
  uninstallSpeakrsLocalState,
} = require('../../src/ai-addon/diarization-setup');
const {
  SPEAKRS_CUDA_RUNTIME_DLL_NAMES,
  SPEAKRS_MODEL_PACK_REVISION,
  SPEAKRS_ORT_DLL_NAMES,
} = require('../../src/ai-addon/speakrs-pack-spec');
const { stageLegalBundle } = require('../../build/prepare-resources');

const MODEL_BYTES = Buffer.from('model-pack-file');
const ARCHIVE_BYTES = Buffer.from('model-pack-archive');
const ARCHIVE_SHA256 = crypto.createHash('sha256').update(ARCHIVE_BYTES).digest('hex');
const MODEL_SHA256 = crypto.createHash('sha256').update(MODEL_BYTES).digest('hex');
const RUNTIME_DLL_NAMES = [...SPEAKRS_ORT_DLL_NAMES, ...SPEAKRS_CUDA_RUNTIME_DLL_NAMES];

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
  assert.equal(status.features.diarization.status, 'ready');
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

test('Windows Speakrs PATH prepends speakrs-ort once', () => {
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

test('packaged buildPythonEnv applies AVANEVIS_PACKAGED after caller overrides', () => {
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
      FOO: 'bar',
    });
    assert.equal(packagedEnv.AVANEVIS_PACKAGED, '1');
    assert.equal(packagedEnv.FOO, 'bar');

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

test('Windows production runtime requires every non-empty integrity-checked DLL', async () => {
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
    assert.equal((await checkSpeakrsRuntimeCache({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      verifyChecksum: true,
    })).valid, true);

    for (const fileName of RUNTIME_DLL_NAMES) {
      const filePath = path.join(runtimeDir, fileName);
      const original = fs.readFileSync(filePath);
      fs.rmSync(filePath);
      const result = await checkSpeakrsRuntimeCache({
        userDataDir,
        platform: 'win32',
        arch: 'x64',
        verifyChecksum: true,
      });
      assert.equal(result.valid, false, `${fileName} must be required`);
      assert.ok(result.missingFiles.includes(fileName));
      fs.writeFileSync(filePath, original);
    }

    const corruptPath = path.join(runtimeDir, RUNTIME_DLL_NAMES[0]);
    const original = fs.readFileSync(corruptPath);
    fs.writeFileSync(corruptPath, Buffer.alloc(original.length));
    assert.equal((await checkSpeakrsRuntimeCache({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
      verifyChecksum: true,
    })).valid, false);
    fs.writeFileSync(corruptPath, Buffer.alloc(0));
    assert.equal((await checkSpeakrsRuntimeCache({
      userDataDir,
      platform: 'win32',
      arch: 'x64',
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

    await setupDiarizationAddon({
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

    await setupDiarizationAddon({
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

    await setupDiarizationAddon({
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

test('pyannote uninstall removes its exact roots even when they are empty directories', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyannote-empty-roots-'));
  try {
    const roots = getPyannoteUninstallPaths(userDataDir);
    for (const root of roots) {
      fs.mkdirSync(root, { recursive: true });
    }
    uninstallPyannoteLocalState({ userDataDir });
    assert.ok(roots.every((root) => !fs.existsSync(root)));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('uninstalling Speakrs never reaches shared CUDA, Whisper, or bundled CLI roots', () => {
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
    uninstallSpeakrsLocalState({ userDataDir });
    assert.ok(sharedFiles.every((filePath) => fs.existsSync(filePath)));
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
