const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  AI_ADDON_PROGRESS_CHANNEL,
  checkAiAddonSetupStatus,
  checkSummaryModelCache,
  checkSummaryRuntimeCache,
  createAiAddonProgressEvent,
  getSummaryArtifactPath,
  getSummaryRuntimeArchivePath,
  getSummaryRuntimeDir,
  getSummaryRuntimeExecutablePath,
  removeDiarizationSetup,
  removeSummaryModel,
  setupDiarizationAddon,
  setupSummaryModel,
  validateSummaryModel,
} = require('../../src/ai-addon-setup');
const { TOKEN_KEYS, getTokenPath } = require('../../src/ai-addon-token-store');
const { DEFAULT_SUMMARY_MODEL_ID, getSummaryArtifactForPlatform } = require('../../src/ai-addon-state');

function createMemoryFs() {
  const files = new Map();
  const dirs = new Set();
  const removed = [];

  return {
    files,
    dirs,
    removed,
    mkdirSync(dirPath) {
      dirs.add(dirPath);
    },
    writeFileSync(filePath, data) {
      files.set(filePath, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    },
    readFileSync(filePath, encoding) {
      if (!files.has(filePath)) {
        throw new Error(`Missing file: ${filePath}`);
      }
      const data = files.get(filePath);
      return encoding ? data.toString(encoding) : data;
    },
    existsSync(filePath) {
      return files.has(filePath) || dirs.has(filePath);
    },
    unlinkSync(filePath) {
      files.delete(filePath);
    },
    copyFileSync(fromPath, toPath) {
      if (!files.has(fromPath)) {
        throw new Error(`Missing file: ${fromPath}`);
      }
      files.set(toPath, Buffer.from(files.get(fromPath)));
    },
    renameSync(fromPath, toPath) {
      if (!files.has(fromPath)) {
        throw new Error(`Missing file: ${fromPath}`);
      }
      files.set(toPath, files.get(fromPath));
      files.delete(fromPath);
    },
    rmSync(targetPath) {
      removed.push(targetPath);
      for (const filePath of [...files.keys()]) {
        if (filePath === targetPath || filePath.startsWith(`${targetPath}${path.sep}`)) {
          files.delete(filePath);
        }
      }
    },
    readdirSync(dirPath, options = {}) {
      const names = new Set();
      for (const filePath of files.keys()) {
        if (path.dirname(filePath) === dirPath) {
          names.add(path.basename(filePath));
        }
      }
      for (const childDir of dirs) {
        if (path.dirname(childDir) === dirPath && childDir !== dirPath) {
          names.add(path.basename(childDir));
        }
      }
      const entries = [...names].sort();
      if (!options.withFileTypes) {
        return entries;
      }
      return entries.map((name) => ({
        name,
        isDirectory: () => dirs.has(path.join(dirPath, name)),
      }));
    },
    statSync(targetPath) {
      return {
        isDirectory: () => dirs.has(targetPath),
      };
    },
  };
}

function createSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8').replace(/^encrypted:/, ''),
  };
}

function createCatalogWithPinnedSummaryArtifact({ sha256 = 'abc123', downloadUrl = 'https://example.test/model.gguf' } = {}) {
  const artifact = {
    format: 'gguf',
    distribution: 'optional-setup-artifact',
    fileName: 'model.gguf',
    sha256,
    estimatedSizeBytes: 1234,
    validationStatus: 'ready',
    llamaCpp: {
      runtime: 'llama.cpp',
      version: 'b9999',
      validationStatus: 'ready',
    },
    platformArtifacts: {
      'win32-x64': {
        id: 'summary-artifact-win32-x64',
        label: 'Summary artifact for Windows CUDA',
        platform: 'win32',
        arch: 'x64',
        acceleration: 'cuda',
        runtime: 'llama.cpp',
        runtimeArchitecture: 'qwen35',
        fileName: 'model.gguf',
        sha256,
        downloadUrl,
        validationStatus: 'ready',
      },
    },
  };

  return {
    version: 1,
    diarization: {
      defaultModelId: 'diarizer',
      models: [{ id: 'diarizer' }],
    },
    summary: {
      defaultModelId: 'summary-model',
      runtimeArtifacts: {
        'win32-x64': {
          id: 'summary-runtime-win32-x64',
          label: 'Summary runtime for Windows CUDA',
          runtime: 'llama.cpp',
          version: 'b9999',
          platform: 'win32',
          arch: 'x64',
          acceleration: 'cuda',
          executableName: 'llama-cli.exe',
          validationStatus: 'ready',
          artifacts: [
            {
              fileName: 'runtime.zip',
              archiveFormat: 'zip',
              sha256: '3f8ef8b3bfedd12cb8d81101703a10e5fc12f764dda294a4aaa963de0519b291',
              sizeBytes: 123,
              downloadUrl: 'https://example.test/runtime.zip',
            },
          ],
        },
      },
      models: [{ id: 'summary-model', label: 'Summary Model', runtime: 'llama.cpp', artifact }],
    },
  };
}

test('progress events redact known sensitive fields and token-looking values', () => {
  const event = createAiAddonProgressEvent({
    feature: 'summary',
    phase: 'chunk prompt',
    message: 'Validating hf_secretvalue without transcript text.',
    percent: 120,
    transcriptText: 'do not include',
    prompt: 'do not include',
    token: 'hf_secretvalue',
  });

  assert.equal(AI_ADDON_PROGRESS_CHANNEL, 'ai-addon-progress');
  assert.equal(event.feature, 'summary');
  assert.equal(event.phase, 'chunk-prompt');
  assert.equal(event.percent, 100);
  assert.equal(event.message.includes('hf_secretvalue'), false);
  assert.equal('transcriptText' in event, false);
  assert.equal('prompt' in event, false);
  assert.equal('token' in event, false);
});

test('check status includes token and summary cache state without exposing token values', async () => {
  const fsModule = createMemoryFs();
  const safeStorage = createSafeStorage();
  const userDataDir = '/tmp/AvaNevis';
  fsModule.writeFileSync(getTokenPath(userDataDir, TOKEN_KEYS.diarizationHuggingFace), Buffer.from('encrypted:hf_secret'));

  const status = await checkAiAddonSetupStatus({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    safeStorage,
    fsModule,
  });

  assert.equal(status.features.diarization.tokenStatus.hasToken, true);
  assert.equal(status.features.summary.cache.installed, false);
  assert.equal(JSON.stringify(status).includes('hf_secret'), false);
});

test('setup diarization stores token securely and writes ready manifest state', async () => {
  const fsModule = createMemoryFs();
  const progress = [];
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule,
    now: () => '2026-05-16T00:00:00Z',
    emitProgress: (event) => progress.push(event),
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(status.features.diarization.setupComplete, true);
  assert.equal(progress.at(-1).status, 'ready');
  assert.equal(JSON.stringify(progress).includes('hf_validtoken123'), false);
});

test('setup diarization runs runtime validation before marking ready', async () => {
  const validations = [];
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
    runtimeValidator: async (payload) => validations.push(payload),
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(validations.length, 1);
  assert.equal(validations[0].modelId, 'pyannote/speaker-diarization-community-1');
  assert.equal(validations[0].token, 'hf_validtoken123');
});

test('setup diarization reports runtime validation failures before first run', async () => {
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
    runtimeValidator: async () => {
      throw new Error('pyannote.audio is not installed for speaker diarization.');
    },
  });

  assert.equal(status.features.diarization.status, 'error');
  assert.match(status.features.diarization.error, /pyannote\.audio is not installed/);
  assert.equal(status.features.diarization.setupComplete, false);
});

test('invalid diarization token keeps setup in needsAccount', async () => {
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'not-a-token',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
  });

  assert.equal(status.features.diarization.status, 'needsAccount');
  assert.equal(status.features.diarization.setupComplete, false);
});

test('macOS diarization setup remains unsupported', async () => {
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'darwin',
    arch: 'arm64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
  });

  assert.equal(status.features.diarization.status, 'unsupported');
  assert.equal(status.features.diarization.setupComplete, false);
});

test('remove diarization setup deletes token and managed cache reference', async () => {
  const fsModule = createMemoryFs();
  await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule,
  });

  const status = await removeDiarizationSetup({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    safeStorage: createSafeStorage(),
    fsModule,
  });

  assert.equal(status.features.diarization.status, 'notConfigured');
  assert.equal(status.features.diarization.tokenStatus.hasToken, false);
  assert.ok(fsModule.removed.some((targetPath) => targetPath.includes(path.join('models', 'diarization'))));
});

test('summary cache validation accepts pinned catalog artifact checksums', async () => {
  const fsModule = createMemoryFs();
  const userDataDir = '/tmp/AvaNevis';
  const artifact = getSummaryArtifactForPlatform(DEFAULT_SUMMARY_MODEL_ID, 'win32', 'x64');
  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  fsModule.mkdirSync(path.dirname(artifactPath));
  fsModule.writeFileSync(artifactPath, 'model data');

  const cache = await checkSummaryModelCache({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    modelId: DEFAULT_SUMMARY_MODEL_ID,
    fsModule,
  });

  assert.equal(cache.installed, true);
  assert.equal(cache.valid, true);
  assert.equal(cache.checksumStatus, 'notChecked');
  assert.equal(cache.validationStatus, 'installed');
});

test('summary runtime cache stays in userData and requires llama-cli', () => {
  const fsModule = createMemoryFs();
  const artifact = getSummaryArtifactForPlatform(DEFAULT_SUMMARY_MODEL_ID, 'win32', 'x64');
  const runtimeDir = getSummaryRuntimeDir('/tmp/AvaNevis', artifact);
  const runtimeExecutable = getSummaryRuntimeExecutablePath('/tmp/AvaNevis', artifact, {
    executableName: 'llama-cli.exe',
  });

  assert.equal(runtimeDir, path.join('/tmp/AvaNevis', 'ai-addons', 'models', 'summary', DEFAULT_SUMMARY_MODEL_ID, 'runtime', 'win32-x64'));
  assert.equal(runtimeExecutable, path.join(runtimeDir, 'llama-cli.exe'));

  const missingCache = checkSummaryRuntimeCache({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: DEFAULT_SUMMARY_MODEL_ID,
    fsModule,
  });
  assert.equal(missingCache.valid, false);
  assert.equal(missingCache.reason, 'llama.cpp runtime is not installed.');

  fsModule.mkdirSync(runtimeDir);
  fsModule.writeFileSync(runtimeExecutable, 'bin');
  const installedCache = checkSummaryRuntimeCache({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: DEFAULT_SUMMARY_MODEL_ID,
    fsModule,
  });
  assert.equal(installedCache.valid, true);
  assert.equal(installedCache.executablePath, runtimeExecutable);
});

test('validate summary model accepts installed model and runtime with matching checksum', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: 'a0700a1b17cb3f2328437cbc70a3ac543fab2c1e7d1d8014862d801e1eb11162',
  });
  const userDataDir = '/tmp/AvaNevis';
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  fsModule.mkdirSync(path.dirname(artifactPath));
  fsModule.writeFileSync(artifactPath, 'checksum target\n');
  const runtimeExecutable = getSummaryRuntimeExecutablePath(userDataDir, artifact, catalog.summary.runtimeArtifacts['win32-x64']);
  fsModule.mkdirSync(path.dirname(runtimeExecutable));
  fsModule.writeFileSync(runtimeExecutable, 'bin');

  const status = await validateSummaryModel({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
  });

  assert.equal(status.features.summary.status, 'ready');
  assert.equal(status.features.summary.setupComplete, true);
  assert.equal(status.features.summary.cache.checksumStatus, 'notChecked');
  assert.equal(status.features.summary.runtimeCache.installed, true);
});

test('validate summary model smoke-tests runtime before ready state', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: 'a0700a1b17cb3f2328437cbc70a3ac543fab2c1e7d1d8014862d801e1eb11162',
  });
  const userDataDir = '/tmp/AvaNevis';
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  fsModule.mkdirSync(path.dirname(artifactPath));
  fsModule.writeFileSync(artifactPath, 'checksum target\n');
  const runtimeExecutable = getSummaryRuntimeExecutablePath(userDataDir, artifact, catalog.summary.runtimeArtifacts['win32-x64']);
  fsModule.mkdirSync(path.dirname(runtimeExecutable));
  fsModule.writeFileSync(runtimeExecutable, 'bin');
  const validations = [];

  const status = await validateSummaryModel({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    runtimeValidator: async (payload) => validations.push(payload),
  });

  assert.equal(status.features.summary.status, 'ready');
  assert.equal(validations.length, 1);
  assert.equal(validations[0].modelId, 'summary-model');
  assert.equal(validations[0].cache.artifactPath, artifactPath);
});

test('validate summary model reports smoke-test failure', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: 'a0700a1b17cb3f2328437cbc70a3ac543fab2c1e7d1d8014862d801e1eb11162',
  });
  const userDataDir = '/tmp/AvaNevis';
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  fsModule.mkdirSync(path.dirname(artifactPath));
  fsModule.writeFileSync(artifactPath, 'checksum target\n');
  const runtimeExecutable = getSummaryRuntimeExecutablePath(userDataDir, artifact, catalog.summary.runtimeArtifacts['win32-x64']);
  fsModule.mkdirSync(path.dirname(runtimeExecutable));
  fsModule.writeFileSync(runtimeExecutable, 'bin');

  const status = await validateSummaryModel({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    runtimeValidator: async () => {
      throw new Error('llama.cpp runtime smoke validation failed.');
    },
  });

  assert.equal(status.features.summary.status, 'error');
  assert.match(status.features.summary.error, /smoke validation failed/);
  assert.equal(status.features.summary.setupComplete, false);
});

test('setup summary model uses pinned default metadata and fails if runtime install fails', async () => {
  const progress = [];
  const status = await setupSummaryModel({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
    emitProgress: (event) => progress.push(event),
    downloader: async ({ destinationPath }) => {
      throw new Error(`unexpected download ${destinationPath}`);
    },
  });

  assert.equal(status.features.summary.status, 'error');
  assert.match(status.features.summary.error, /unexpected download/);
  assert.equal(progress.at(-1).status, 'error');
});

test('setup summary model downloads explicit runtime and model artifacts only when metadata is pinned', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: 'a0700a1b17cb3f2328437cbc70a3ac543fab2c1e7d1d8014862d801e1eb11162',
  });
  const downloadedUrls = [];
  const runtimeArtifact = catalog.summary.runtimeArtifacts['win32-x64'];
  const status = await setupSummaryModel({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    downloader: async ({ url, destinationPath, onProgress }) => {
      downloadedUrls.push(url);
      fsModule.writeFileSync(destinationPath, url.endsWith('/runtime.zip') ? 'runtime archive\n' : 'checksum target\n');
      onProgress({ percent: 50 });
    },
    extractor: async (archivePath) => {
      const archive = runtimeArtifact.artifacts[0];
      assert.equal(archivePath, getSummaryRuntimeArchivePath('/tmp/AvaNevis', getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog), archive));
      fsModule.writeFileSync(getSummaryRuntimeExecutablePath('/tmp/AvaNevis', getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog), runtimeArtifact), 'bin');
    },
  });

  assert.deepEqual(downloadedUrls, ['https://example.test/runtime.zip', 'https://example.test/model.gguf']);
  assert.equal(status.features.summary.status, 'ready');
  assert.equal(status.features.summary.setupComplete, true);
  assert.equal(status.features.summary.runtimeCache.valid, true);
});

test('remove summary model clears cache and manifest state', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: 'a0700a1b17cb3f2328437cbc70a3ac543fab2c1e7d1d8014862d801e1eb11162',
  });
  await setupSummaryModel({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    downloader: async ({ url, destinationPath }) => fsModule.writeFileSync(destinationPath, url.endsWith('/runtime.zip') ? 'runtime archive\n' : 'checksum target\n'),
    extractor: async () => fsModule.writeFileSync(
      getSummaryRuntimeExecutablePath('/tmp/AvaNevis', getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog), catalog.summary.runtimeArtifacts['win32-x64']),
      'bin',
    ),
  });

  const status = await removeSummaryModel({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
  });

  assert.equal(status.features.summary.status, 'notConfigured');
  assert.equal(status.features.summary.setupComplete, false);
  assert.ok(fsModule.removed.some((targetPath) => targetPath.includes(path.join('models', 'summary'))));
});
