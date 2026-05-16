const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  AI_ADDON_PROGRESS_CHANNEL,
  buildDiarizationDependencyInstallArgs,
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  checkSummaryModelCache,
  checkSummaryRuntimeCache,
  createAiAddonProgressEvent,
  extractZipArchive,
  getSummaryArtifactPath,
  getSummaryRuntimeArchivePath,
  getSummaryRuntimeDir,
  getSummaryRuntimeExecutablePath,
  isAllowedDownloadUrl,
  removeDiarizationSetup,
  removeSummaryModel,
  setupDiarizationAddon,
  setupSummaryModel,
  summarizePipProgress,
  validateSummaryModel,
  getDiarizationTokenStatus,
} = require('../../src/ai-addon-setup');
const { TOKEN_KEYS, getTokenPath } = require('../../src/ai-addon-token-store');
const { DEFAULT_SUMMARY_MODEL_ID, getDiarizationDependencyArtifactForPlatform, getSummaryArtifactForPlatform } = require('../../src/ai-addon-state');

function createMemoryFs() {
  const files = new Map();
  const dirs = new Set();
  const removed = [];

  function pathVariants(targetPath) {
    return [...new Set([targetPath, path.normalize(targetPath), path.resolve(targetPath)])];
  }

  function addDirTree(targetPath) {
    const normalized = path.normalize(targetPath);
    const root = path.parse(normalized).root;
    let current = root;
    if (current) {
      dirs.add(current);
    }
    for (const segment of normalized.slice(current.length).split(path.sep).filter(Boolean)) {
      current = current ? path.join(current, segment) : segment;
      dirs.add(current);
    }
    dirs.add(targetPath);
  }

  return {
    files,
    dirs,
    removed,
    mkdirSync(dirPath) {
      for (const variant of pathVariants(dirPath)) {
        addDirTree(variant);
      }
    },
    writeFileSync(filePath, data) {
      this.mkdirSync(path.dirname(filePath));
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
      return pathVariants(filePath).some((variant) => files.has(variant) || dirs.has(variant));
    },
    unlinkSync(filePath) {
      files.delete(filePath);
    },
    copyFileSync(fromPath, toPath) {
      if (!files.has(fromPath)) {
        throw new Error(`Missing file: ${fromPath}`);
      }
      this.mkdirSync(path.dirname(toPath));
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
      const parentVariants = pathVariants(dirPath);
      for (const filePath of files.keys()) {
        if (parentVariants.includes(path.dirname(filePath)) || parentVariants.includes(path.normalize(path.dirname(filePath)))) {
          names.add(path.basename(filePath));
        }
      }
      for (const childDir of dirs) {
        if ((parentVariants.includes(path.dirname(childDir)) || parentVariants.includes(path.normalize(path.dirname(childDir)))) && !parentVariants.includes(childDir)) {
          names.add(path.basename(childDir));
        }
      }
      const entries = [...names].sort();
      if (!options.withFileTypes) {
        return entries;
      }
      return entries.map((name) => ({
        name,
        isDirectory: () => pathVariants(path.join(dirPath, name)).some((variant) => dirs.has(variant)),
      }));
    },
    statSync(targetPath) {
      const resolvedFilePath = pathVariants(targetPath).find((variant) => files.has(variant));
      return {
        isDirectory: () => pathVariants(targetPath).some((variant) => dirs.has(variant)),
        size: resolvedFilePath ? files.get(resolvedFilePath).length : 0,
      };
    },
  };
}

function createMemoryZip(entries) {
  return {
    getEntries() {
      return entries.map((entryName) => ({ entryName }));
    },
    extractAllTo() {
      this.extracted = true;
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

function createCountingSafeStorage() {
  const counters = { availability: 0, encrypt: 0, decrypt: 0 };
  return {
    counters,
    isEncryptionAvailable: () => {
      counters.availability += 1;
      return true;
    },
    encryptString: (value) => {
      counters.encrypt += 1;
      return Buffer.from(`encrypted:${value}`, 'utf8');
    },
    decryptString: (value) => {
      counters.decrypt += 1;
      return Buffer.from(value).toString('utf8').replace(/^encrypted:/, '');
    },
  };
}

function createUnavailableSafeStorage() {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('unavailable');
    },
    decryptString: () => {
      throw new Error('unavailable');
    },
  };
}

function createCatalogWithPinnedSummaryArtifact({ sha256 = 'abc123', downloadUrl = 'https://huggingface.co/example/model.gguf' } = {}) {
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
              downloadUrl: 'https://github.com/example/runtime.zip',
            },
          ],
        },
      },
      models: [{ id: 'summary-model', label: 'Summary Model', runtime: 'llama.cpp', artifact }],
    },
  };
}

async function stubDiarizationDependencyInstaller({ targetDir, artifact }) {
  assert.ok(targetDir.includes(path.join('dependencies', 'diarization')));
  assert.equal(artifact.id, 'pyannote-audio-4.0.1-win32-x64-cuda-12.6');
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

test('download URL validation allows configured HTTPS hosts and expected redirects', () => {
  assert.equal(isAllowedDownloadUrl('https://github.com/ggml-org/llama.cpp/releases/download/b9173/runtime.zip'), true);
  assert.equal(isAllowedDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset-2e65be/runtime.zip'), true);
  assert.equal(isAllowedDownloadUrl('https://huggingface.co/unsloth/model/resolve/main/model.gguf'), true);
  assert.equal(isAllowedDownloadUrl('https://cdn-lfs.hf.co/repos/model.gguf'), true);
  assert.equal(isAllowedDownloadUrl('https://cas-bridge.xethub.hf.co/xet-bridge-us/model.gguf'), true);
  assert.equal(isAllowedDownloadUrl('https://cas-server.xethub.hf.co/reconstruction/model.gguf'), true);
  assert.equal(isAllowedDownloadUrl('https://transfer.xethub.hf.co/xorbs/model.gguf'), true);
  assert.equal(isAllowedDownloadUrl('https://cdn-lfs.huggingface.co/repos/model.gguf'), true);
  assert.equal(isAllowedDownloadUrl('https://pypi.org/simple'), true);
  assert.equal(isAllowedDownloadUrl('https://download.pytorch.org/whl/cu126'), true);
  assert.equal(isAllowedDownloadUrl('https://files.pythonhosted.org/packages/example.whl'), true);
  assert.equal(isAllowedDownloadUrl('http://github.com/ggml-org/llama.cpp/releases/download/b9173/runtime.zip'), false);
  assert.equal(isAllowedDownloadUrl('https://example.test/model.gguf'), false);
});

test('zip extraction rejects unsafe archive entry names', () => {
  assert.throws(
    () => extractZipArchive(createMemoryZip(['bin/llama-cli.exe', '../escape.txt']), '/tmp/runtime'),
    /unsafe path traversal/,
  );
  assert.throws(
    () => extractZipArchive(createMemoryZip(['..\\escape.txt']), '/tmp/runtime'),
    /unsafe path traversal/,
  );
  assert.throws(
    () => extractZipArchive(createMemoryZip([path.resolve('/tmp/escape.txt')]), '/tmp/runtime'),
    /unsafe absolute path/,
  );
  assert.doesNotThrow(() => extractZipArchive(createMemoryZip(['bin/llama-cli.exe']), '/tmp/runtime'));
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
  assert.equal(status.features.diarization.storage.installedBytes, null);
  assert.equal(status.features.summary.storage.installedBytes, null);
  assert.equal(status.features.summary.storage.installedBytesAccuracy, 'notScanned');
  assert.equal(typeof status.footprint.totalInstalledBytes, 'number');
  assert.equal(JSON.stringify(status).includes('hf_secret'), false);
});

test('passive add-on status does not query secure storage availability', async () => {
  const fsModule = createMemoryFs();
  const userDataDir = '/tmp/AvaNevis';
  fsModule.writeFileSync(getTokenPath(userDataDir, TOKEN_KEYS.diarizationHuggingFace), Buffer.from('encrypted:hf_secret'));
  let encryptionChecks = 0;
  const safeStorage = {
    isEncryptionAvailable: () => {
      encryptionChecks += 1;
      return true;
    },
  };

  const status = await checkAiAddonSetupStatus({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    safeStorage,
    fsModule,
  });

  assert.equal(status.features.diarization.tokenStatus.hasToken, true);
  assert.equal(status.features.diarization.tokenStatus.encryptionAvailable, null);
  assert.equal(encryptionChecks, 0);
});

test('explicit token status can query secure storage availability', () => {
  const fsModule = createMemoryFs();
  const userDataDir = '/tmp/AvaNevis';
  fsModule.writeFileSync(getTokenPath(userDataDir, TOKEN_KEYS.diarizationHuggingFace), Buffer.from('encrypted:hf_secret'));
  let encryptionChecks = 0;
  const safeStorage = {
    isEncryptionAvailable: () => {
      encryptionChecks += 1;
      return true;
    },
  };

  const status = getDiarizationTokenStatus({ userDataDir, safeStorage, fsModule });

  assert.equal(status.hasToken, true);
  assert.equal(status.encryptionAvailable, true);
  assert.equal(encryptionChecks, 1);
});

test('diarization dependency cache uses managed userData path and pinned requirements', () => {
  const fsModule = createMemoryFs();
  const artifact = getDiarizationDependencyArtifactForPlatform('win32', 'x64');
  const cache = checkDiarizationDependencyCache({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    fsModule,
  });

  assert.equal(cache.installed, false);
  assert.equal(cache.artifactId, 'pyannote-audio-4.0.1-win32-x64-cuda-12.6');
  assert.equal(cache.sitePackagesDir, path.join('/tmp/AvaNevis', 'ai-addons', 'dependencies', 'diarization', artifact.id, 'site-packages'));
  assert.ok(artifact.pip.requirements.includes('pyannote.audio==4.0.1'));
  assert.ok(artifact.pip.requirements.includes('torch==2.8.0+cu126'));
});

test('diarization dependency cache rejects unallowed pip index hosts', () => {
  const artifact = JSON.parse(JSON.stringify(getDiarizationDependencyArtifactForPlatform('win32', 'x64')));
  artifact.pip.indexUrl = 'https://example.test/simple';
  const catalog = {
    version: 1,
    diarization: {
      defaultModelId: 'diarizer',
      dependencyArtifacts: { 'win32-x64': artifact },
      models: [{ id: 'diarizer' }],
    },
    summary: { defaultModelId: 'summary', runtimeArtifacts: {}, models: [] },
  };

  const cache = checkDiarizationDependencyCache({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    fsModule: createMemoryFs(),
    catalog,
  });

  assert.equal(cache.valid, false);
  assert.match(cache.reason, /index URL host is not allowed/);
});

test('diarization dependency installer builds pinned pip target args', () => {
  const artifact = getDiarizationDependencyArtifactForPlatform('win32', 'x64');
  const args = buildDiarizationDependencyInstallArgs({ artifact, targetDir: 'deps/site-packages' });

  assert.deepEqual(args.slice(0, 8), ['-m', 'pip', 'install', '--upgrade', '--ignore-installed', '--target', 'deps/site-packages', '--no-warn-script-location']);
  assert.ok(args.includes('--index-url'));
  assert.ok(args.includes('https://pypi.org/simple'));
  assert.ok(args.includes('--extra-index-url'));
  assert.ok(args.includes('https://download.pytorch.org/whl/cu126'));
  assert.equal(args.includes('--only-binary=:all:'), false);
  assert.ok(args.includes('pyannote.audio==4.0.1'));
  assert.ok(args.includes('torch==2.8.0+cu126'));
});

test('pip progress summarizer returns non-sensitive install milestones', () => {
  assert.equal(summarizePipProgress('Collecting pyannote.audio==4.0.1\n'), 'Collecting pyannote.audio==4.0.1');
  assert.equal(summarizePipProgress('WARNING only\n'), null);
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
    dependencyInstaller: stubDiarizationDependencyInstaller,
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(status.features.diarization.setupComplete, true);
  assert.equal(status.features.diarization.dependencyCache.valid, true);
  assert.equal(progress.at(-1).status, 'ready');
  assert.equal(JSON.stringify(progress).includes('hf_validtoken123'), false);
});

test('setup diarization installs dependencies before runtime validation', async () => {
  const fsModule = createMemoryFs();
  const calls = [];
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule,
    dependencyInstaller: async ({ targetDir }) => {
      calls.push(`install:${targetDir}`);
    },
    runtimeValidator: async (payload) => {
      calls.push(`validate:${payload.dependencyCache.sitePackagesDir}`);
    },
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^install:/);
  assert.match(calls[1], /^validate:/);
});

test('setup diarization reports dependency install failures before token validation', async () => {
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
    dependencyInstaller: async () => {
      throw new Error('julius source build failed');
    },
    runtimeValidator: async () => {
      throw new Error('should not run');
    },
  });

  assert.equal(status.features.diarization.status, 'error');
  assert.match(status.features.diarization.error, /julius source build failed/);
  assert.equal(status.features.diarization.setupComplete, false);
});

test('setup diarization requires token before installing dependencies', async () => {
  let installCalled = false;
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
    dependencyInstaller: async () => {
      installCalled = true;
    },
  });

  assert.equal(status.features.diarization.status, 'needsAccount');
  assert.equal(status.features.diarization.setupComplete, false);
  assert.equal(installCalled, false);
});

test('setup diarization reports unavailable secure token storage before installing dependencies', async () => {
  let installCalled = false;
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createUnavailableSafeStorage(),
    fsModule: createMemoryFs(),
    dependencyInstaller: async () => {
      installCalled = true;
    },
  });

  assert.equal(status.features.diarization.status, 'error');
  assert.match(status.features.diarization.error, /Secure token storage is unavailable/);
  assert.equal(status.features.diarization.setupComplete, false);
  assert.equal(installCalled, false);
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
    dependencyInstaller: stubDiarizationDependencyInstaller,
    runtimeValidator: async (payload) => validations.push(payload),
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(validations.length, 1);
  assert.equal(validations[0].modelId, 'pyannote/speaker-diarization-community-1');
  assert.equal(validations[0].modelRef, 'pyannote/speaker-diarization-community-1');
  assert.equal(validations[0].token, 'hf_validtoken123');
  assert.equal(validations[0].dependencyCache.valid, true);
});

test('setup diarization does not decrypt a newly entered token for runtime validation', async () => {
  const safeStorage = createCountingSafeStorage();
  const validations = [];

  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage,
    fsModule: createMemoryFs(),
    dependencyInstaller: stubDiarizationDependencyInstaller,
    runtimeValidator: async (payload) => validations.push(payload),
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(validations.length, 1);
  assert.equal(validations[0].token, 'hf_validtoken123');
  assert.equal(safeStorage.counters.encrypt, 1);
  assert.equal(safeStorage.counters.decrypt, 0);
});

test('setup diarization decrypts an existing token once for runtime validation', async () => {
  const fsModule = createMemoryFs();
  const safeStorage = createCountingSafeStorage();
  const userDataDir = '/tmp/AvaNevis';
  fsModule.writeFileSync(getTokenPath(userDataDir, TOKEN_KEYS.diarizationHuggingFace), Buffer.from('encrypted:hf_validtoken123'));
  const validations = [];

  const status = await setupDiarizationAddon({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    safeStorage,
    fsModule,
    dependencyInstaller: stubDiarizationDependencyInstaller,
    runtimeValidator: async (payload) => validations.push(payload),
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(validations.length, 1);
  assert.equal(validations[0].token, 'hf_validtoken123');
  assert.equal(safeStorage.counters.encrypt, 0);
  assert.equal(safeStorage.counters.decrypt, 1);
});

test('setup diarization reports runtime validation failures before first run', async () => {
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
    dependencyInstaller: stubDiarizationDependencyInstaller,
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
    dependencyInstaller: stubDiarizationDependencyInstaller,
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
  assert.ok(fsModule.removed.some((targetPath) => targetPath.includes(path.join('dependencies', 'diarization'))));
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
    profile: 'detailed',
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
      fsModule.writeFileSync(path.join(getSummaryRuntimeDir('/tmp/AvaNevis', getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog)), 'extract', 'nested', 'llama-cli.exe'), 'bin');
    },
  });

  assert.deepEqual(downloadedUrls, ['https://github.com/example/runtime.zip', 'https://huggingface.co/example/model.gguf']);
  assert.equal(status.features.summary.status, 'ready');
  assert.equal(status.features.summary.profile, 'detailed');
  assert.equal(status.features.summary.setupComplete, true);
  assert.equal(status.features.summary.runtimeCache.valid, true);
  assert.equal(fsModule.existsSync(getSummaryRuntimeArchivePath('/tmp/AvaNevis', getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog), runtimeArtifact.artifacts[0])), false);
  assert.equal(fsModule.existsSync(getSummaryRuntimeExecutablePath('/tmp/AvaNevis', getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog), runtimeArtifact)), true);
});

test('setup summary model records downloader failures and removes temp model downloads', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: 'a0700a1b17cb3f2328437cbc70a3ac543fab2c1e7d1d8014862d801e1eb11162',
  });
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const tempModelPath = `${getSummaryArtifactPath('/tmp/AvaNevis', artifact)}.download`;

  const status = await setupSummaryModel({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    downloader: async ({ url, destinationPath }) => {
      if (url.endsWith('/runtime.zip')) {
        fsModule.writeFileSync(destinationPath, 'runtime archive\n');
        return;
      }
      fsModule.writeFileSync(destinationPath, 'partial model');
      throw new Error('network timeout');
    },
    extractor: async () => fsModule.writeFileSync(
      path.join(getSummaryRuntimeDir('/tmp/AvaNevis', artifact), 'extract', 'llama-cli.exe'),
      'bin',
    ),
  });

  assert.equal(status.features.summary.status, 'error');
  assert.match(status.features.summary.error, /network timeout/);
  assert.equal(fsModule.existsSync(tempModelPath), false);
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
      path.join(getSummaryRuntimeDir('/tmp/AvaNevis', getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog)), 'extract', 'llama-cli.exe'),
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
