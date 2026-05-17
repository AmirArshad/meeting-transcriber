const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');

const CHECKSUM_TARGET_SHA256 = 'a0700a1b17cb3f2328437cbc70a3ac543fab2c1e7d1d8014862d801e1eb11162';

const {
  AI_ADDON_PROGRESS_CHANNEL,
  buildDiarizationDependencyInstallArgs,
  checkAiAddonSetupStatus,
  checkDiarizationDependencyCache,
  checkMacOSCompilerToolchain,
  checkSummaryModelCache,
  checkSummaryRuntimeCache,
  createAiAddonProgressEvent,
  downloadFile,
  downloadHuggingFaceSummaryArtifact,
  extractZipArchive,
  extractTarGzArchive,
  getSummaryArtifactPath,
  getSummaryRuntimeArchivePath,
  getSummaryRuntimeDir,
  getSummaryRuntimeExecutablePath,
  isAllowedDownloadUrl,
  validateTarListing,
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
    extractedTo: null,
    getEntries() {
      return entries.map((entryName) => ({ entryName }));
    },
    extractAllTo(destination) {
      this.extractedTo = destination;
      this.extracted = true;
    },
  };
}

function createSourceArtifactDownloader(fsModule) {
  return async ({ url, destinationPath }) => {
    if (url.endsWith('julius-0.2.7.tar.gz')) {
      fsModule.writeFileSync(destinationPath, Buffer.from('mock julius source artifact'));
      return;
    }
    fsModule.writeFileSync(destinationPath, Buffer.from(String(url)));
  };
}

function createCatalogWithMockDiarizationSourceArtifact(platformKey = 'win32-x64') {
  const [platform, arch] = platformKey.split('-');
  const artifact = JSON.parse(JSON.stringify(getDiarizationDependencyArtifactForPlatform(platform, arch)));
  artifact.pip.sourceArtifacts = artifact.pip.sourceArtifacts.map((sourceArtifact) => ({
    ...sourceArtifact,
    sha256: '196a4a6677ffcdfe7c3b1a4db8bc805647cef61137a2e67d0540f774523d6278',
  }));
  return {
    version: 1,
    diarization: {
      defaultModelId: 'pyannote/speaker-diarization-community-1',
      dependencyArtifacts: { [platformKey]: artifact },
      models: [{ id: 'pyannote/speaker-diarization-community-1', runtime: { modelRef: 'pyannote/speaker-diarization-community-1' } }],
    },
    summary: { defaultModelId: 'summary-model', runtimeArtifacts: {}, models: [{ id: 'summary-model' }] },
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

function createCatalogWithPinnedSummaryArtifact({ sha256 = CHECKSUM_TARGET_SHA256, downloadUrl = 'https://huggingface.co/example/model.gguf' } = {}) {
  const artifact = {
    format: 'gguf',
    distribution: 'optional-setup-artifact',
    fileName: 'model.gguf',
    sha256,
    estimatedSizeBytes: 1234,
    source: {
      provider: 'huggingface',
      repo: 'example/model',
      revision: 'abc123abc123abc123abc123abc123abc123abc1',
      fileName: 'model.gguf',
      sizeBytes: 1234,
    },
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
        source: {
          provider: 'huggingface',
          repo: 'example/model',
          revision: 'abc123abc123abc123abc123abc123abc123abc1',
          fileName: 'model.gguf',
          sizeBytes: 1234,
        },
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
  assert.ok(artifact.id === 'pyannote-audio-4.0.1-win32-x64-cuda-12.6' || artifact.id === 'pyannote-audio-4.0.1-darwin-arm64-mps');
}

async function stubAnyDiarizationDependencyInstaller({ targetDir }) {
  assert.ok(targetDir.includes(path.join('dependencies', 'diarization')));
}

async function stubAvailableToolchain({ platform }) {
  assert.equal(platform, 'darwin');
  return { available: true };
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

test('progress events preserve bounded byte counters', () => {
  const event = createAiAddonProgressEvent({
    feature: 'summary',
    phase: 'download',
    message: 'Downloading',
    percent: 25,
    downloadedBytes: 600.9,
    totalBytes: 500.1,
  });

  assert.equal(event.downloadedBytes, 500);
  assert.equal(event.totalBytes, 500);
  assert.equal(event.percent, 25);
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

test('downloadFile removes partial destination when request fails', async () => {
  const destinationPath = path.join(__dirname, '..', 'tmp-partial-download.bin');
  const originalGet = https.get;
  try {
    https.get = (_url, callback) => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-length': '12' };
      process.nextTick(() => {
        callback(response);
        response.write(Buffer.from('partial'));
        setImmediate(() => response.destroy(new Error('simulated socket failure')));
      });
      return {
        setTimeout() {},
        on() {},
        destroy() {},
      };
    };
    await assert.rejects(
      () => downloadFile({
        url: 'https://github.com/example/artifact.bin',
        destinationPath,
        timeoutMs: 1000,
      }),
      /stream failed|socket failure/i,
    );
    assert.equal(fs.existsSync(destinationPath), false);
  } finally {
    https.get = originalGet;
    try {
      fs.unlinkSync(destinationPath);
    } catch (error) {
      // Best effort cleanup.
    }
  }
});

test('Hugging Face downloader kills child process and rejects on cancellation', async () => {
  const fsModule = createMemoryFs();
  const artifact = getSummaryArtifactForPlatform(
    'summary-model',
    'win32',
    'x64',
    createCatalogWithPinnedSummaryArtifact({
      sha256: CHECKSUM_TARGET_SHA256,
    }),
  );
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killedWithTaskkill = false;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    fsModule.__spawn = () => {
      child.kill = () => {
        child.signalCode = 'SIGTERM';
        setImmediate(() => child.emit('close', null, 'SIGTERM'));
        return true;
      };
      return child;
    };
    const controller = new AbortController();
    const downloadPromise = downloadHuggingFaceSummaryArtifact({
      artifact,
      destinationPath: '/tmp/AvaNevis/model.gguf.download',
      expectedSizeBytes: 1234,
      userDataDir: '/tmp/AvaNevis',
      pythonExe: '/python/bin/python3',
      backendPath: '/app/backend',
      fsModule,
      cancelSignal: controller.signal,
    });
    controller.abort();

    await assert.rejects(downloadPromise, /canceled/i);
    assert.equal(child.signalCode, 'SIGTERM');
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform || { value: process.platform });
  }
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

test('zip extraction creates missing destination directory', () => {
  const destinationDir = path.join(__dirname, '..', 'tmp-runtime-extract');
  const zip = createMemoryZip(['bin/llama-cli.exe']);
  try {
    fs.rmSync(destinationDir, { recursive: true, force: true });
    extractZipArchive(zip, destinationDir);

    assert.equal(fs.existsSync(destinationDir), true);
    assert.equal(zip.extractedTo, path.resolve(destinationDir));
  } finally {
    fs.rmSync(destinationDir, { recursive: true, force: true });
  }
});

test('tar.gz extraction rejects unsafe archive entries before extracting', async () => {
  const safeListing = '-rwxr-xr-x 0 user group 1 Jan 01 00:00 llama/bin/llama-cli\n';
  const calls = [];
  await extractTarGzArchive('/tmp/runtime.tar.gz', '/tmp/runtime', async (args) => {
    calls.push(args);
    return args[0] === '-tzvf' ? safeListing : '';
  });
  assert.deepEqual(calls, [
    ['-tzvf', '/tmp/runtime.tar.gz'],
    ['-xzf', '/tmp/runtime.tar.gz', '-C', '/tmp/runtime'],
  ]);

  assert.throws(
    () => validateTarListing('-rw-r--r-- 0 user group 1 Jan 01 00:00 ../escape\n', '/tmp/runtime'),
    /path traversal/,
  );
  assert.throws(
    () => validateTarListing('lrwxr-xr-x 0 user group 1 Jan 01 00:00 llama/link -> ../../escape\n', '/tmp/runtime'),
    /unsafe symlink/,
  );
  assert.throws(
    () => validateTarListing('-rw-r--r-- malformed-entry-without-a-name\n', '/tmp/runtime'),
    /unparseable tar listing/,
  );
  assert.doesNotThrow(
    () => validateTarListing('xrw-r--r-- 0 user group 1 Jan 01 00:00 llama/PaxHeaders/runtime\n', '/tmp/runtime'),
  );
  await assert.rejects(
    () => extractTarGzArchive('/tmp/runtime.tar.gz', '/tmp/runtime', async (args) => {
      calls.push(args);
      return '-rw-r--r-- 0 user group 1 Jan 01 00:00 /tmp/escape\n';
    }),
    /absolute path/,
  );
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
  assert.ok(status.features.summary.storage.estimatedInstalledBytes > status.features.summary.storage.estimatedModelBytes);
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

test('passive add-on status does not walk storage cache directories', async () => {
  const fsModule = createMemoryFs();
  const originalReaddirSync = fsModule.readdirSync;
  fsModule.readdirSync = () => {
    throw new Error('storage scan should not run');
  };

  const status = await checkAiAddonSetupStatus({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    safeStorage: createSafeStorage(),
    fsModule,
  });

  assert.equal(status.features.summary.storage.installedBytes, null);
  assert.equal(status.features.summary.storage.installedBytesAccuracy, 'notScanned');

  fsModule.readdirSync = originalReaddirSync;
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
  assert.equal(cache.partial, false);
  assert.equal(cache.artifactId, 'pyannote-audio-4.0.1-win32-x64-cuda-12.6');
  assert.equal(cache.sitePackagesDir, path.join('/tmp/AvaNevis', 'ai-addons', 'dependencies', 'diarization', artifact.id, 'site-packages'));
  fsModule.mkdirSync(cache.dependencyDir);
  const partialCache = checkDiarizationDependencyCache({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    fsModule,
  });
  assert.equal(partialCache.installed, false);
  assert.equal(partialCache.partial, true);
  assert.ok(artifact.pip.requirements.includes('pyannote.audio==4.0.1'));
  assert.ok(artifact.pip.requirements.includes('torch==2.8.0+cu126'));
});

test('macOS diarization dependency cache uses managed MPS artifact', () => {
  const fsModule = createMemoryFs();
  const artifact = getDiarizationDependencyArtifactForPlatform('darwin', 'arm64');
  const cache = checkDiarizationDependencyCache({
    userDataDir: '/tmp/AvaNevis',
    platform: 'darwin',
    arch: 'arm64',
    fsModule,
  });

  assert.equal(cache.installed, false);
  assert.equal(cache.artifactId, 'pyannote-audio-4.0.1-darwin-arm64-mps');
  assert.equal(cache.sitePackagesDir, path.join('/tmp/AvaNevis', 'ai-addons', 'dependencies', 'diarization', artifact.id, 'site-packages'));
  assert.ok(artifact.pip.requirements.includes('pyannote.audio==4.0.1'));
  assert.ok(artifact.pip.requirements.includes('torch==2.8.0'));
  assert.equal(artifact.pip.requirements.includes('torch==2.8.0+cu126'), false);
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
  assert.equal(artifact.pip.allowSourceBuilds, false);
  assert.ok(args.includes('--index-url'));
  assert.ok(args.includes('https://pypi.org/simple'));
  assert.ok(args.includes('--extra-index-url'));
  assert.ok(args.includes('https://download.pytorch.org/whl/cu126'));
  assert.equal(args.includes('--only-binary=:all:'), true);
  assert.equal(args.includes('--no-binary=julius'), false);
  assert.ok(args.includes('pyannote.audio==4.0.1'));
  assert.ok(args.includes('torch==2.8.0+cu126'));
  assert.equal(args.includes('julius==0.2.7'), true);
  assert.ok(artifact.pip.sourceArtifacts.some((sourceArtifact) => sourceArtifact.package === 'julius'));
});

test('diarization dependency installer allows only curated source artifacts', () => {
  const artifact = JSON.parse(JSON.stringify(getDiarizationDependencyArtifactForPlatform('darwin', 'arm64')));
  artifact.pip.sourceArtifacts = artifact.pip.sourceArtifacts.map((sourceArtifact) => ({
    ...sourceArtifact,
    localPath: `/tmp/${sourceArtifact.fileName}`,
  }));
  const args = buildDiarizationDependencyInstallArgs({ artifact, targetDir: 'deps/site-packages' });

  assert.equal(args.includes('--only-binary=:all:'), true);
  assert.equal(args.includes('--no-binary=julius'), true);
  assert.equal(args.includes('julius==0.2.7'), false);
  assert.ok(args.includes('/tmp/julius-0.2.7.tar.gz'));
});

test('macOS diarization dependency installer builds pinned MPS pip target args', () => {
  const artifact = getDiarizationDependencyArtifactForPlatform('darwin', 'arm64');
  const args = buildDiarizationDependencyInstallArgs({ artifact, targetDir: 'deps/site-packages' });

  assert.equal(artifact.pip.allowSourceBuilds, false);
  assert.ok(args.includes('--index-url'));
  assert.ok(args.includes('https://pypi.org/simple'));
  assert.equal(args.includes('--extra-index-url'), false);
  assert.equal(args.includes('https://download.pytorch.org/whl/cu126'), false);
  assert.equal(args.includes('--only-binary=:all:'), true);
  assert.ok(args.includes('pyannote.audio==4.0.1'));
  assert.ok(args.includes('torch==2.8.0'));
  assert.ok(args.includes('torchaudio==2.8.0'));
  assert.ok(args.includes('torchcodec==0.7.0'));
  assert.equal(args.includes('julius==0.2.7'), true);
});

test('pip progress summarizer returns non-sensitive install milestones', () => {
  assert.equal(summarizePipProgress('Collecting pyannote.audio==4.0.1\n'), 'Collecting pyannote.audio==4.0.1');
  assert.equal(summarizePipProgress('Downloading torch-2.8.0.whl\n'), 'Downloading torch-2.8.0.whl');
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
  catalog: createCatalogWithMockDiarizationSourceArtifact('win32-x64'),
  downloader: createSourceArtifactDownloader(fsModule),
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

test('setup diarization downloads pinned source artifacts before pip install', async () => {
  const fsModule = createMemoryFs();
  let installedArtifact = null;
  let toolchainChecked = false;
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog: createCatalogWithMockDiarizationSourceArtifact('win32-x64'),
    downloader: createSourceArtifactDownloader(fsModule),
    dependencyInstaller: async ({ artifact }) => {
      installedArtifact = artifact;
    },
    downloadSourceArtifacts: true,
    toolchainChecker: async () => {
      toolchainChecked = true;
      return { available: true };
    },
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(toolchainChecked, false);
  assert.ok(installedArtifact.pip.sourceArtifacts[0].localPath.endsWith('julius-0.2.7.tar.gz'));
  assert.equal(fsModule.existsSync(installedArtifact.pip.sourceArtifacts[0].localPath), true);
});

test('macOS curated diarization source artifacts require compiler toolchain', async () => {
  const fsModule = createMemoryFs();
  let installCalled = false;
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'darwin',
    arch: 'arm64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog: createCatalogWithMockDiarizationSourceArtifact('darwin-arm64'),
    downloader: createSourceArtifactDownloader(fsModule),
    dependencyInstaller: async () => {
      installCalled = true;
    },
    downloadSourceArtifacts: true,
    toolchainChecker: async () => ({ available: false }),
  });

  assert.equal(status.features.diarization.status, 'error');
  assert.match(status.features.diarization.error, /xcode-select --install/);
  assert.equal(installCalled, false);
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

test('macOS diarization setup preflights broad source-build toolchain before pip install', async () => {
  let installCalled = false;
  const fsModule = createMemoryFs();
  const artifact = JSON.parse(JSON.stringify(getDiarizationDependencyArtifactForPlatform('darwin', 'arm64')));
  artifact.pip.allowSourceBuilds = true;
  artifact.pip.sourceArtifacts = [];
  const catalog = {
    version: 1,
    diarization: {
      defaultModelId: 'pyannote/speaker-diarization-community-1',
      dependencyArtifacts: { 'darwin-arm64': artifact },
      models: [{ id: 'pyannote/speaker-diarization-community-1', runtime: { modelRef: 'pyannote/speaker-diarization-community-1' } }],
    },
    summary: { defaultModelId: 'summary-model', runtimeArtifacts: {}, models: [{ id: 'summary-model' }] },
  };
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'darwin',
    arch: 'arm64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    toolchainChecker: async () => ({ available: false }),
    dependencyInstaller: async () => {
      installCalled = true;
    },
  });

  assert.equal(status.features.diarization.status, 'error');
  assert.match(status.features.diarization.error, /xcode-select --install/);
  assert.equal(installCalled, false);
});

test('macOS compiler toolchain checker reports xcode-select failure clearly', async () => {
  const calls = [];
  const result = await checkMacOSCompilerToolchain({
    execFileFn(command, args, _options, callback) {
      calls.push([command, args]);
      callback(new Error('missing xcode'));
    },
  });

  assert.deepEqual(calls, [['xcode-select', ['-p']]]);
  assert.deepEqual(result, { available: false, reason: 'xcode-select' });
});

test('compiler toolchain checker is skipped outside macOS', async () => {
  let called = false;
  const result = await checkMacOSCompilerToolchain({
    platform: 'win32',
    execFileFn() {
      called = true;
    },
  });

  assert.equal(called, false);
  assert.deepEqual(result, { available: true, skipped: true });
});

test('setup diarization cancellation cleans managed dependencies', async () => {
  const fsModule = createMemoryFs();
  const controller = new AbortController();
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule,
    cancelSignal: controller.signal,
    dependencyInstaller: async ({ targetDir }) => {
      fsModule.writeFileSync(path.join(targetDir, 'partial.txt'), 'partial');
      controller.abort();
    },
  });

  assert.equal(status.features.diarization.status, 'notConfigured');
  assert.equal(status.features.diarization.error, null);
  assert.ok(fsModule.removed.some((targetPath) => targetPath.includes(path.join('dependencies', 'diarization'))));
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
  assert.equal(validations[0].requiredDevice, 'cuda');
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

test('macOS diarization setup validates MPS before ready', async () => {
  const validations = [];
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'darwin',
    arch: 'arm64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
    dependencyInstaller: stubAnyDiarizationDependencyInstaller,
    toolchainChecker: stubAvailableToolchain,
    runtimeValidator: async (payload) => validations.push(payload),
  });

  assert.equal(status.features.diarization.status, 'ready');
  assert.equal(status.features.diarization.setupComplete, true);
  assert.equal(status.features.diarization.availability.acceleration, 'mps');
  assert.equal(validations.length, 1);
  assert.equal(validations[0].requiredDevice, 'mps');
  assert.equal(validations[0].modelRef, 'pyannote/speaker-diarization-community-1');
});

test('macOS diarization setup fails closed when MPS validation fails', async () => {
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'darwin',
    arch: 'arm64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
    dependencyInstaller: stubAnyDiarizationDependencyInstaller,
    toolchainChecker: stubAvailableToolchain,
    runtimeValidator: async ({ requiredDevice }) => {
      assert.equal(requiredDevice, 'mps');
      throw new Error('Speaker identification on macOS requires PyTorch Metal/MPS acceleration. CPU fallback is disabled.');
    },
  });

  assert.equal(status.features.diarization.status, 'error');
  assert.match(status.features.diarization.error, /Metal\/MPS acceleration/);
  assert.equal(status.features.diarization.setupComplete, false);
});

test('Intel macOS diarization setup remains unsupported', async () => {
  const status = await setupDiarizationAddon({
    userDataDir: '/tmp/AvaNevis',
    platform: 'darwin',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule: createMemoryFs(),
  });

  assert.equal(status.features.diarization.status, 'unsupported');
  assert.equal(status.features.diarization.setupComplete, false);
  assert.match(status.features.diarization.error, /Apple Silicon.*Metal\/MPS/);
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

test('diarization setup removes stale dependency artifact directories', async () => {
  const fsModule = createMemoryFs();
  const userDataDir = '/tmp/AvaNevis';
  const artifact = getDiarizationDependencyArtifactForPlatform('win32', 'x64');
  const staleDependencyDir = path.join(userDataDir, 'ai-addons', 'dependencies', 'diarization', 'old-pyannote-artifact');
  const currentDependencyDir = path.join(userDataDir, 'ai-addons', 'dependencies', 'diarization', artifact.id);
  fsModule.mkdirSync(staleDependencyDir);
  fsModule.writeFileSync(path.join(staleDependencyDir, 'old.whl'), 'stale');

  await setupDiarizationAddon({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    token: 'hf_validtoken123',
    safeStorage: createSafeStorage(),
    fsModule,
    dependencyInstaller: stubDiarizationDependencyInstaller,
  });

  assert.ok(fsModule.removed.includes(staleDependencyDir));
  assert.equal(fsModule.existsSync(currentDependencyDir), true);
});

test('summary cache validation accepts pinned catalog artifact checksums', async () => {
  const fsModule = createMemoryFs();
  const userDataDir = '/tmp/AvaNevis';
  const artifact = getSummaryArtifactForPlatform(DEFAULT_SUMMARY_MODEL_ID, 'win32', 'x64');
  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  const artifactDir = path.dirname(artifactPath);
  fsModule.mkdirSync(artifactDir);
  const partialCache = await checkSummaryModelCache({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    modelId: DEFAULT_SUMMARY_MODEL_ID,
    fsModule,
  });
  assert.equal(partialCache.installed, false);
  assert.equal(partialCache.partial, true);

  fsModule.writeFileSync(artifactPath, 'model data');

  const cache = await checkSummaryModelCache({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    modelId: DEFAULT_SUMMARY_MODEL_ID,
    fsModule,
  });

  assert.equal(cache.installed, true);
  assert.equal(cache.partial, false);
  assert.equal(cache.valid, true);
  assert.equal(cache.checksumStatus, 'notChecked');
  assert.equal(cache.validationStatus, 'installed');

  const verifiedCache = await checkSummaryModelCache({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    modelId: DEFAULT_SUMMARY_MODEL_ID,
    fsModule,
    verifyChecksum: true,
  });
  assert.equal(verifiedCache.valid, false);
  assert.equal(verifiedCache.checksumStatus, 'mismatch');
});

test('summary runtime cache stays in userData and requires llama-cli', () => {
  const fsModule = createMemoryFs();
  const artifact = getSummaryArtifactForPlatform(DEFAULT_SUMMARY_MODEL_ID, 'win32', 'x64');
  const runtimeDir = getSummaryRuntimeDir('/tmp/AvaNevis', artifact);
  const runtimeExecutable = getSummaryRuntimeExecutablePath('/tmp/AvaNevis', artifact, {
    executableName: 'llama-cli.exe',
  });
  const nestedRuntimeExecutable = path.join(runtimeDir, 'extract', 'nested', 'llama-cli.exe');

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
  assert.equal(missingCache.partial, false);
  assert.equal(missingCache.reason, 'llama.cpp runtime is not installed.');

  fsModule.mkdirSync(path.join(runtimeDir, 'extract'));
  const partialCache = checkSummaryRuntimeCache({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: DEFAULT_SUMMARY_MODEL_ID,
    fsModule,
  });
  assert.equal(partialCache.installed, false);
  assert.equal(partialCache.partial, true);

  fsModule.mkdirSync(path.dirname(nestedRuntimeExecutable));
  fsModule.writeFileSync(nestedRuntimeExecutable, 'bin');
  fsModule.writeFileSync(runtimeExecutable, 'orphaned bin');
  const installedCache = checkSummaryRuntimeCache({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: DEFAULT_SUMMARY_MODEL_ID,
    fsModule,
  });
  assert.equal(installedCache.valid, true);
  assert.equal(installedCache.executablePath, nestedRuntimeExecutable);
});

test('validate summary model accepts installed model and runtime with matching checksum', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
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
  assert.equal(status.features.summary.cache.checksumStatus, 'match');
  assert.equal(status.features.summary.runtimeCache.installed, true);
});

test('ready summary status remains checksum-backed during passive refresh', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
  });
  const userDataDir = '/tmp/AvaNevis';
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  fsModule.mkdirSync(path.dirname(artifactPath));
  fsModule.writeFileSync(artifactPath, 'tampered model\n');
  const runtimeExecutable = getSummaryRuntimeExecutablePath(userDataDir, artifact, catalog.summary.runtimeArtifacts['win32-x64']);
  fsModule.mkdirSync(path.dirname(runtimeExecutable));
  fsModule.writeFileSync(runtimeExecutable, 'bin');
  await validateSummaryModel({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
  });

  const status = await checkAiAddonSetupStatus({ userDataDir, platform: 'win32', arch: 'x64', safeStorage: createSafeStorage(), fsModule, catalog });

  assert.equal(status.features.summary.status, 'error');
  assert.equal(status.features.summary.setupComplete, false);
  assert.equal(status.features.summary.cache.checksumStatus, 'mismatch');
});

test('passive summary status keeps healthy setup complete without rehashing model', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
  });
  const userDataDir = '/tmp/AvaNevis';
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const artifactPath = getSummaryArtifactPath(userDataDir, artifact);
  fsModule.mkdirSync(path.dirname(artifactPath));
  fsModule.writeFileSync(artifactPath, 'checksum target\n');
  const runtimeExecutable = getSummaryRuntimeExecutablePath(userDataDir, artifact, catalog.summary.runtimeArtifacts['win32-x64']);
  fsModule.mkdirSync(path.dirname(runtimeExecutable));
  fsModule.writeFileSync(runtimeExecutable, 'bin');
  await validateSummaryModel({
    userDataDir,
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
  });
  const originalReadFileSync = fsModule.readFileSync.bind(fsModule);
  fsModule.readFileSync = (filePath, encoding) => {
    if (filePath === artifactPath) {
      throw new Error('passive status should not hash model artifact');
    }
    return originalReadFileSync(filePath, encoding);
  };

  const status = await checkAiAddonSetupStatus({ userDataDir, platform: 'win32', arch: 'x64', safeStorage: createSafeStorage(), fsModule, catalog });

  assert.equal(status.features.summary.status, 'ready');
  assert.equal(status.features.summary.setupComplete, true);
  assert.equal(status.features.summary.cache.checksumStatus, 'notChecked');
});

test('validate summary model smoke-tests runtime before ready state', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
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
    sha256: CHECKSUM_TARGET_SHA256,
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
    sha256: CHECKSUM_TARGET_SHA256,
  });
  const downloadedUrls = [];
  const runtimeArtifact = catalog.summary.runtimeArtifacts['win32-x64'];
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const nestedRuntimeExecutable = path.join(getSummaryRuntimeDir('/tmp/AvaNevis', artifact), 'extract', 'nested', 'llama-cli.exe');
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
      assert.equal(archivePath, getSummaryRuntimeArchivePath('/tmp/AvaNevis', artifact, archive));
      fsModule.writeFileSync(nestedRuntimeExecutable, 'bin');
    },
  });

  assert.deepEqual(downloadedUrls, ['https://github.com/example/runtime.zip', 'https://huggingface.co/example/model.gguf']);
  assert.equal(status.features.summary.status, 'ready');
  assert.equal(status.features.summary.profile, 'detailed');
  assert.equal(status.features.summary.setupComplete, true);
  assert.equal(status.features.summary.runtimeCache.valid, true);
  assert.equal(status.features.summary.runtimeCache.executablePath, nestedRuntimeExecutable);
  assert.equal(fsModule.existsSync(getSummaryRuntimeArchivePath('/tmp/AvaNevis', artifact, runtimeArtifact.artifacts[0])), false);
  assert.equal(fsModule.existsSync(getSummaryRuntimeExecutablePath('/tmp/AvaNevis', artifact, runtimeArtifact)), false);
});

test('setup summary model uses Hugging Face downloader for pinned Hugging Face model artifacts', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
  });
  const runtimeArtifact = catalog.summary.runtimeArtifacts['win32-x64'];
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const calls = [];
  const status = await setupSummaryModel({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    pythonExe: '/python/python.exe',
    backendPath: '/app/backend',
    downloader: async ({ url, destinationPath }) => {
      calls.push({ type: 'generic', url });
      fsModule.writeFileSync(destinationPath, 'runtime archive\n');
    },
    huggingFaceDownloader: async ({ artifact: downloadedArtifact, destinationPath, userDataDir, pythonExe, backendPath, onProgress }) => {
      calls.push({ type: 'huggingface', artifact: downloadedArtifact, userDataDir, pythonExe, backendPath });
      assert.equal(downloadedArtifact.sha256, CHECKSUM_TARGET_SHA256);
      fsModule.writeFileSync(destinationPath, 'checksum target\n');
      onProgress({ downloaded: 1234, total: 1234, percent: 100 });
    },
    extractor: async (archivePath) => {
      assert.equal(archivePath, getSummaryRuntimeArchivePath('/tmp/AvaNevis', artifact, runtimeArtifact.artifacts[0]));
      fsModule.writeFileSync(path.join(getSummaryRuntimeDir('/tmp/AvaNevis', artifact), 'extract', 'llama-cli.exe'), 'bin');
    },
  });

  assert.deepEqual(calls.map((call) => call.type), ['generic', 'huggingface']);
  assert.equal(calls[1].artifact.source.repo, 'example/model');
  assert.equal(calls[1].pythonExe, '/python/python.exe');
  assert.equal(calls[1].backendPath, '/app/backend');
  assert.equal(status.features.summary.status, 'ready');
});

test('setup summary model records downloader failures and removes temp model downloads', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
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

test('setup summary model cancellation cleans partial cache and resets state', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
  });
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const controller = new AbortController();

  const status = await setupSummaryModel({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    cancelSignal: controller.signal,
    downloader: async ({ url, destinationPath }) => {
      fsModule.writeFileSync(destinationPath, url.endsWith('/runtime.zip') ? 'runtime archive\n' : 'partial model');
      if (!url.endsWith('/runtime.zip')) {
        controller.abort();
      }
    },
    extractor: async () => fsModule.writeFileSync(
      path.join(getSummaryRuntimeDir('/tmp/AvaNevis', artifact), 'extract', 'llama-cli.exe'),
      'bin',
    ),
  });

  assert.equal(status.features.summary.status, 'notConfigured');
  assert.equal(status.features.summary.error, null);
  assert.equal(fsModule.existsSync(getSummaryArtifactPath('/tmp/AvaNevis', artifact)), false);
  assert.ok(fsModule.removed.includes(getSummaryRuntimeDir('/tmp/AvaNevis', artifact)));
});

test('summary validation failure removes runtime installed during failed setup', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
  });
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const runtimeDir = getSummaryRuntimeDir('/tmp/AvaNevis', artifact);

  const status = await setupSummaryModel({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    downloader: async ({ url, destinationPath }) => fsModule.writeFileSync(destinationPath, url.endsWith('/runtime.zip') ? 'runtime archive\n' : 'checksum target\n'),
    extractor: async () => fsModule.writeFileSync(path.join(runtimeDir, 'extract', 'llama-cli.exe'), 'bin'),
    runtimeValidator: async () => {
      throw new Error('missing CUDA DLL');
    },
  });

  assert.equal(status.features.summary.status, 'error');
  assert.match(status.features.summary.error, /missing CUDA DLL/);
  assert.ok(fsModule.removed.includes(runtimeDir));
});

test('summary cancellation during validation preserves pre-existing ready cache', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
  });
  const artifact = getSummaryArtifactForPlatform('summary-model', 'win32', 'x64', catalog);
  const artifactPath = getSummaryArtifactPath('/tmp/AvaNevis', artifact);
  const runtimeExecutable = path.join(getSummaryRuntimeDir('/tmp/AvaNevis', artifact), 'extract', 'llama-cli.exe');
  fsModule.mkdirSync(path.dirname(artifactPath));
  fsModule.mkdirSync(path.dirname(runtimeExecutable));
  fsModule.writeFileSync(artifactPath, 'checksum target\n');
  fsModule.writeFileSync(runtimeExecutable, 'bin');
  const controller = new AbortController();

  const status = await setupSummaryModel({
    userDataDir: '/tmp/AvaNevis',
    platform: 'win32',
    arch: 'x64',
    modelId: 'summary-model',
    safeStorage: createSafeStorage(),
    fsModule,
    catalog,
    cancelSignal: controller.signal,
    runtimeValidator: async () => {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    },
  });

  assert.equal(status.features.summary.status, 'ready');
  assert.equal(fsModule.existsSync(artifactPath), true);
  assert.equal(fsModule.existsSync(runtimeExecutable), true);
  assert.equal(fsModule.removed.length, 0);
  assert.match(status.features.summary.lastValidation.message, /Existing local model and runtime were kept/);
});

test('remove summary model clears cache and manifest state', async () => {
  const fsModule = createMemoryFs();
  const catalog = createCatalogWithPinnedSummaryArtifact({
    sha256: CHECKSUM_TARGET_SHA256,
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
