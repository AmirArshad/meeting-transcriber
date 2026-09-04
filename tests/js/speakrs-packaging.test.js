const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../../package.json');
const {
  MACHO_CPU_TYPE_ARM64,
  WINDOWS_PE_MACHINE_AMD64,
  assertSpeakrsCliArchitecture,
  assertStagedSpeakrsCli,
  assertStagedSpeakrsValidateWav,
  buildMacOSSpeakrsCliVerificationCommands,
  buildResourceManifest,
  buildSpeakrsCliCargoArgs,
  getSpeakrsCargoFeatures,
  getSpeakrsCargoTargetTriple,
  getSpeakrsResourceManifestTarget,
  getSpeakrsCliBinaryName,
  loadSpeakrsOrtCompilePins,
  manifestsMatch,
  readElfMachine,
  readMachOCpuType,
  readWindowsPeMachine,
  resolveCargoTargetDir,
  resolveSpeakrsCliCargoOutputPath,
  SPEAKRS_VALIDATE_WAV_NAME,
  SPEAKRS_VALIDATE_WAV_SOURCE,
  stageSpeakrsValidateWav,
  writeSpeakrsPackagedIntegrityManifest,
} = require('../../build/prepare-resources');
const {
  REQUIRED_LINUX_ORT_ARTIFACT_COUNT,
  REQUIRED_MODEL_PACK_PLATFORMS,
  REQUIRED_WINDOWS_ORT_ARTIFACT_COUNT,
  assertCatalogPinsComplete,
  assertModelPackPins,
  assertOrtRuntimePins,
  assertPackagedSpeakrsLayout,
  assertPinnedDownloadArtifact,
  listReleaseChecksumArtifacts,
} = require('../../scripts/verify-speakrs-packaging');
const {
  canReuseExtraction,
  getCpuSmokeCacheIdentity,
  getOnnxSubsetMarkerIdentity,
  getWindowsCpuOrtMarkerIdentity,
} = require('../../scripts/run-speakrs-cpu-smoke');
const ortCompilePins = require('../../native/speakrs-cli/ort-compile-pins.json');
const cpuSmokePins = require('../../native/speakrs-cli/ci-cpu-smoke-pins.json');
const {
  SPEAKRS_MODEL_PACK_ARTIFACTS,
  SPEAKRS_ORT_RUNTIME_ARTIFACTS,
} = require('../../src/ai-addon/speakrs-pack-spec');
const { writeSpeakrsLinuxElfFixture } = require('./speakrs-linux-elf-fixture');

const ROOT = path.join(__dirname, '..', '..');
const CARGO_TOML = fs.readFileSync(path.join(ROOT, 'native', 'speakrs-cli', 'Cargo.toml'), 'utf8');
const PREPARE_RESOURCES_SOURCE = fs.readFileSync(path.join(ROOT, 'build', 'prepare-resources.js'), 'utf8');
const VERIFY_PACKAGING_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-speakrs-packaging.js'), 'utf8');
const CI_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const RELEASE_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-release.yml'), 'utf8');
const MACOS_VERIFY_SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-macos-packaged-app.sh'), 'utf8');
const WINDOWS_PE_MACHINE_I386 = 0x14c;
const MACHO_CPU_TYPE_X86_64 = 0x01000007;

function writeMinimalPe(filePath, machine) {
  const buf = Buffer.alloc(0x48, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x40, 0x3c);
  buf.write('PE\0\0', 0x40, 'ascii');
  buf.writeUInt16LE(machine, 0x44);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

function writeMinimalMachO(filePath, cpuType) {
  const buf = Buffer.alloc(16, 0);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cpuType, 4);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

function writeMinimalElf(filePath, { eiClass = 2, machine = 62 } = {}) {
  writeSpeakrsLinuxElfFixture(filePath, {
    kind: eiClass === 1 ? 'header-only' : 'pie-executable',
    eiClass,
    machine,
  });
}

function writeCanonicalFixture(filePath, contents = Buffer.from('RIFF-fixture')) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}


test('speakrs rust-toolchain stays pinned at 1.88.0', () => {
  const toolchain = fs.readFileSync(path.join(ROOT, 'native', 'speakrs-cli', 'rust-toolchain.toml'), 'utf8');
  assert.match(toolchain, /channel = "1\.88\.0"/);
});


test('speakrs cargo feature flags stay on the Task 1 matrix', () => {
  assert.deepEqual(getSpeakrsCargoFeatures('darwin'), ['default-linalg', 'coreml']);
  assert.deepEqual(getSpeakrsCargoFeatures('win32'), ['default-linalg', 'cuda', 'load-dynamic']);
  assert.deepEqual(getSpeakrsCargoFeatures('linux'), ['default-linalg', 'cuda', 'load-dynamic']);
  assert.equal(CARGO_TOML.includes('default-features = false'), true);
  assert.equal(CARGO_TOML.includes('default-linalg'), true);
  assert.equal(CARGO_TOML.includes('"online"'), false);
  assert.equal(/\bcoreml-fast\b/.test(CARGO_TOML), false);
  assert.equal(/\bcuda-fast\b/.test(CARGO_TOML), false);
  assert.equal(/\bonline\b/.test(CARGO_TOML), false);
  assert.match(CARGO_TOML, /target_os = "macos"[\s\S]*features = \["default-linalg", "coreml"\]/);
  assert.match(CARGO_TOML, /target_os = "windows"[\s\S]*features = \["default-linalg", "cuda", "load-dynamic"\]/);
  assert.match(CARGO_TOML, /target_os = "linux"[\s\S]*features = \["default-linalg", "cuda", "load-dynamic"\]/);
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(
      getSpeakrsCargoFeatures(platform).some((feature) => feature.includes('fast') || feature === 'online'),
      false,
    );
  }
});


test('installer artifactName is unchanged', () => {
  assert.equal(packageJson.build.artifactName, '${productName}-Setup-${version}.${ext}');
});


test('speakrs-cli binary names stay platform-specific', () => {
  assert.equal(getSpeakrsCliBinaryName('win32'), 'speakrs-cli.exe');
  assert.equal(getSpeakrsCliBinaryName('darwin'), 'speakrs-cli');
  assert.equal(getSpeakrsCliBinaryName('linux'), 'speakrs-cli');
});


test('speakrs packaging builds an explicit target triple per platform', () => {
  assert.equal(getSpeakrsCargoTargetTriple('darwin'), 'aarch64-apple-darwin');
  assert.equal(getSpeakrsCargoTargetTriple('win32'), 'x86_64-pc-windows-msvc');
  assert.equal(getSpeakrsCargoTargetTriple('linux'), 'x86_64-unknown-linux-gnu');
  assert.deepEqual(
    buildSpeakrsCliCargoArgs('darwin', { manifestPath: '/tmp/Cargo.toml' }),
    ['build', '--release', '--locked', '--target', 'aarch64-apple-darwin', '--manifest-path', '/tmp/Cargo.toml'],
  );
  assert.deepEqual(
    buildSpeakrsCliCargoArgs('win32', { manifestPath: 'D:\\crate\\Cargo.toml' }),
    ['build', '--release', '--locked', '--target', 'x86_64-pc-windows-msvc', '--manifest-path', 'D:\\crate\\Cargo.toml'],
  );
  assert.deepEqual(
    buildSpeakrsCliCargoArgs('linux', { manifestPath: '/tmp/Cargo.toml' }),
    ['build', '--release', '--locked', '--target', 'x86_64-unknown-linux-gnu', '--manifest-path', '/tmp/Cargo.toml'],
  );
});


test('cargo output path uses the target-triple directory and resolves relative CARGO_TARGET_DIR', () => {
  const cwd = path.join(os.tmpdir(), 'speakrs-cli-cwd');
  assert.equal(
    resolveSpeakrsCliCargoOutputPath('darwin', {}, { cwd }),
    path.join(cwd, 'target', 'aarch64-apple-darwin', 'release', 'speakrs-cli'),
  );
  assert.equal(
    resolveSpeakrsCliCargoOutputPath('win32', { CARGO_TARGET_DIR: 'custom-target' }, { cwd }),
    path.join(cwd, 'custom-target', 'x86_64-pc-windows-msvc', 'release', 'speakrs-cli.exe'),
  );
  assert.equal(
    resolveCargoTargetDir({ CARGO_TARGET_DIR: 'rel-out' }, { cwd }),
    path.resolve(cwd, 'rel-out'),
  );
  const absolute = path.join(os.tmpdir(), 'absolute-cargo-out');
  assert.equal(
    resolveSpeakrsCliCargoOutputPath('win32', { CARGO_TARGET_DIR: absolute }, { cwd }),
    path.join(absolute, 'x86_64-pc-windows-msvc', 'release', 'speakrs-cli.exe'),
  );
});


test('assertStagedSpeakrsCli fails closed when the binary is missing, empty, or the wrong architecture', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-missing-cli-'));
  try {
    assert.throws(
      () => assertStagedSpeakrsCli(tempDir, 'win32'),
      /speakrs-cli missing/,
    );

    const emptyCli = path.join(tempDir, 'speakrs-cli.exe');
    fs.writeFileSync(emptyCli, '');
    assert.throws(
      () => assertStagedSpeakrsCli(tempDir, 'win32'),
      /empty or not a file/,
    );

    writeMinimalPe(emptyCli, WINDOWS_PE_MACHINE_I386);
    assert.throws(
      () => assertStagedSpeakrsCli(tempDir, 'win32'),
      /not Windows x64 PE/,
    );

    writeMinimalPe(emptyCli, WINDOWS_PE_MACHINE_AMD64);
    assert.equal(assertStagedSpeakrsCli(tempDir, 'win32'), emptyCli);
    assert.equal(readWindowsPeMachine(emptyCli), WINDOWS_PE_MACHINE_AMD64);

    const darwinDir = path.join(tempDir, 'darwin');
    const darwinCli = path.join(darwinDir, 'speakrs-cli');
    writeMinimalMachO(darwinCli, MACHO_CPU_TYPE_X86_64);
    if (process.platform !== 'win32') {
      fs.chmodSync(darwinCli, 0o755);
    }
    assert.throws(
      () => assertSpeakrsCliArchitecture(darwinCli, 'darwin'),
      /not arm64/,
    );

    writeMinimalMachO(darwinCli, MACHO_CPU_TYPE_ARM64);
    assert.equal(readMachOCpuType(darwinCli), MACHO_CPU_TYPE_ARM64);
    if (process.platform !== 'darwin') {
      assert.equal(assertSpeakrsCliArchitecture(darwinCli, 'darwin'), 'arm64');
    }

    const linuxDir = path.join(tempDir, 'linux');
    const linuxCli = path.join(linuxDir, 'speakrs-cli');
    writeMinimalElf(linuxCli, { eiClass: 1, machine: 3 });
    if (process.platform !== 'win32') {
      fs.chmodSync(linuxCli, 0o755);
    }
    assert.throws(
      () => assertSpeakrsCliArchitecture(linuxCli, 'linux'),
      /32-bit ELF/,
    );

    writeMinimalElf(linuxCli, { machine: 183 });
    if (process.platform !== 'win32') {
      fs.chmodSync(linuxCli, 0o755);
    }
    assert.throws(
      () => assertSpeakrsCliArchitecture(linuxCli, 'linux'),
      /not Linux x86_64 ELF/,
    );

    writeMinimalElf(linuxCli);
    if (process.platform !== 'win32') {
      fs.chmodSync(linuxCli, 0o755);
    }
    assert.equal(readElfMachine(linuxCli), 62);
    assert.equal(assertSpeakrsCliArchitecture(linuxCli, 'linux'), 'x64');
    assert.equal(assertStagedSpeakrsCli(linuxDir, 'linux'), linuxCli);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('prepare-resources always rebuilds speakrs-cli instead of trusting a staged binary', () => {
  assert.equal(PREPARE_RESOURCES_SOURCE.includes('existing.speakrsCliExists'), false);
  assert.equal(/if \(existing\.speakrsCliExists\)/.test(PREPARE_RESOURCES_SOURCE), false);
  assert.match(PREPARE_RESOURCES_SOURCE, /buildSpeakrsCli\(\)/);
  assert.match(PREPARE_RESOURCES_SOURCE, /--target/);
  assert.match(PREPARE_RESOURCES_SOURCE, /getSpeakrsCargoTargetTriple/);
});


test('stageSpeakrsValidateWav copies the fixture next to the CLI and not from a packaged tests path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-fixture-'));
  try {
    const dest = stageSpeakrsValidateWav(tempDir);
    assert.equal(path.basename(dest), SPEAKRS_VALIDATE_WAV_NAME);
    assert.equal(fs.existsSync(dest), true);
    assert.equal(fs.statSync(dest).size, fs.statSync(SPEAKRS_VALIDATE_WAV_SOURCE).size);
    assert.ok(SPEAKRS_VALIDATE_WAV_SOURCE.replace(/\\/g, '/').includes('tests/fixtures/'));
    assert.equal(assertStagedSpeakrsValidateWav(tempDir), dest);

    fs.writeFileSync(dest, '');
    assert.throws(
      () => assertStagedSpeakrsValidateWav(tempDir),
      /empty/,
    );
    fs.rmSync(dest);
    assert.throws(
      () => assertStagedSpeakrsValidateWav(tempDir),
      /missing/,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('package.json extraResources keep bin mapping and do not duplicate the fixture WAV', () => {
  const resources = packageJson.build.extraResources;
  assert.ok(resources.some((entry) => entry.from === 'build/resources/bin' && entry.to === 'bin'));
  assert.equal(
    resources.some((entry) => String(entry.to || '').replace(/\\/g, '/').includes('speakrs-two-speaker-16k.wav')),
    false,
  );
  assert.equal(
    resources.some((entry) => String(entry.from || '').replace(/\\/g, '/').includes('tests/fixtures')),
    false,
  );
  const backend = resources.find((entry) => entry.from === 'backend' && entry.to === 'backend');
  assert.deepEqual(backend.filter, ['**/*.py']);
});


test('resource manifest fingerprints the speakrs crate, toolchain, entitlements, target, and fixture', () => {
  const manifest = buildResourceManifest();
  assert.equal(typeof manifest.inputs.speakrsCargoToml, 'string');
  assert.equal(manifest.inputs.speakrsCargoToml.length, 64);
  assert.equal(manifest.inputs.speakrsCargoLock.length, 64);
  assert.equal(manifest.inputs.speakrsToolchain.length, 64);
  assert.equal(manifest.inputs.speakrsOrtCompilePins.length, 64);
  assert.equal(manifest.inputs.speakrsValidateWav.length, 64);
  assert.equal(manifest.inputs.inheritEntitlements.length, 64);
  assert.equal(manifest.inputs.speakrsCargoTarget, getSpeakrsResourceManifestTarget());
  assert.ok(Array.isArray(manifest.inputs.speakrsSources));
  assert.ok(manifest.inputs.speakrsSources.some((entry) => entry.path === 'src/main.rs'));

  const updated = structuredClone(manifest);
  updated.inputs.speakrsCargoToml = 'changed';
  assert.equal(manifestsMatch(manifest, updated), false);
});


test('ort compile-time downloads stay crate-pinned and off the installer download manifest', () => {
  const pins = loadSpeakrsOrtCompilePins();
  assert.equal(pins.ortSysVersion, '2.0.0-rc.13');
  assert.equal(pins['win32-x64'], null);
  assert.equal(pins['linux-x64'], null);
  assert.equal(
    pins['darwin-arm64'].url,
    'https://cdn.pyke.io/0/pyke:ort-rs/ms@1.28.0/aarch64-apple-darwin+coreml.tar.lzma2',
  );
  assert.equal(
    pins['darwin-arm64'].sha256,
    '6934874e2e953576d9c1db47ff1af39c62c4f4220dbe6f988e131f72879674c7',
  );
  assert.equal(pins['darwin-arm64'].target, 'aarch64-apple-darwin');
  assert.deepEqual(pins, ortCompilePins);
  assert.throws(
    () => assertOrtRuntimePins({ 'win32-x64': pins['win32-x64'] }),
    /ORT 1\.27\.1 runtime pin set is incomplete/,
  );
});


test('catalog pins require Windows, macOS, and Linux model packs plus ORT closures', () => {
  assert.deepEqual([...REQUIRED_MODEL_PACK_PLATFORMS].sort(), ['darwin-arm64', 'linux-x64', 'win32-x64']);
  assert.equal(REQUIRED_WINDOWS_ORT_ARTIFACT_COUNT, 3);
  assert.equal(REQUIRED_LINUX_ORT_ARTIFACT_COUNT, 5);
  assert.doesNotThrow(() => assertCatalogPinsComplete());

  const missingDarwin = { 'win32-x64': SPEAKRS_MODEL_PACK_ARTIFACTS['win32-x64'] };
  assert.throws(
    () => assertModelPackPins(missingDarwin),
    /exactly darwin-arm64, linux-x64, win32-x64/,
  );

  const incompleteOrt = {
    'win32-x64': SPEAKRS_ORT_RUNTIME_ARTIFACTS['win32-x64'].slice(0, 2),
  };
  assert.throws(
    () => assertOrtRuntimePins(incompleteOrt),
    /ORT 1\.27\.1 runtime pin set is incomplete/,
  );

  const incompleteLinuxOrt = {
    'win32-x64': SPEAKRS_ORT_RUNTIME_ARTIFACTS['win32-x64'],
    'linux-x64': SPEAKRS_ORT_RUNTIME_ARTIFACTS['linux-x64'].slice(0, 3),
  };
  assert.throws(
    () => assertOrtRuntimePins(incompleteLinuxOrt),
    /Linux Speakrs ORT 1\.27\.1 runtime pin set is incomplete/,
  );

  const malformedSha = {
    'win32-x64': SPEAKRS_ORT_RUNTIME_ARTIFACTS['win32-x64'].map((artifact, index) => (
      index === 0 ? { ...artifact, sha256: 'deadbeef' } : { ...artifact }
    )),
  };
  assert.throws(
    () => assertOrtRuntimePins(malformedSha),
    /sha256 is invalid/,
  );

  const missingExtracted = {
    'win32-x64': SPEAKRS_ORT_RUNTIME_ARTIFACTS['win32-x64'].map((artifact, index) => (
      index === 0 ? { ...artifact, extractedFiles: undefined } : { ...artifact }
    )),
  };
  assert.throws(
    () => assertOrtRuntimePins(missingExtracted),
    /extractedFiles|extracted DLL/,
  );

  assert.throws(
    () => assertPinnedDownloadArtifact({
      fileName: 'demo.tar.gz',
      downloadUrl: 'http://github.com/AmirArshad/meeting-transcriber/releases/download/x/demo.tar.gz',
      sha256: 'a'.repeat(64),
      sizeBytes: 12,
    }, { label: 'demo' }),
    /must use HTTPS/,
  );
});


test('release checksum verification includes model packs and Windows/Linux ORT artifacts', () => {
  const artifacts = listReleaseChecksumArtifacts();
  assert.equal(artifacts.filter((artifact) => artifact.checksumKind === 'model-pack').length, 3);
  assert.equal(artifacts.filter((artifact) => artifact.checksumKind === 'ort-runtime').length, 8);
  assert.deepEqual(
    artifacts.filter((artifact) => artifact.checksumKind === 'model-pack').map((artifact) => artifact.platform).sort(),
    ['darwin-arm64', 'linux-x64', 'win32-x64'],
  );
  assert.ok(artifacts.some((artifact) => artifact.fileName === 'onnxruntime-win-x64-gpu_cuda12-1.27.1.zip'));
  assert.ok(artifacts.some((artifact) => artifact.fileName === 'onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz'));
  assert.ok(artifacts.some((artifact) => artifact.fileName.includes('nvidia_cuda_runtime_cu12')));
  assert.ok(artifacts.some((artifact) => artifact.fileName.includes('nvidia_cufft_cu12')));
  assert.ok(artifacts.some((artifact) => artifact.fileName === 'nvidia_curand_cu12-10.3.10.19-py3-none-manylinux_2_27_x86_64.whl'));
  assert.ok(artifacts.some((artifact) => artifact.fileName === 'nvidia_cuda_nvrtc_cu12-12.9.86-py3-none-manylinux2010_x86_64.manylinux_2_12_x86_64.whl'));
  assert.match(VERIFY_PACKAGING_SOURCE, /async function verifyPublishedPackChecksums/);
  assert.match(VERIFY_PACKAGING_SOURCE, /listReleaseChecksumArtifacts\(\)/);
  assert.match(VERIFY_PACKAGING_SOURCE, /checksumKind: 'ort-runtime'/);
});


test('CPU smoke uses the published ONNX subset pack and CI-only Windows/Linux CPU ORT pins', () => {
  const pack = SPEAKRS_MODEL_PACK_ARTIFACTS[cpuSmokePins.onnxSubsetPlatform];
  assert.ok(pack);
  assert.match(pack.sha256, /^[a-f0-9]{64}$/);
  assert.equal(cpuSmokePins.windowsCpuOrt.fileName, 'onnxruntime-win-x64-1.27.1.zip');
  assert.equal(
    cpuSmokePins.windowsCpuOrt.sha256,
    '2e00414a63fdef0914cd5a5ede6c707844878e0c08e1b6693842f0451b2df2a1',
  );
  assert.equal(cpuSmokePins.linuxCpuOrt.fileName, 'onnxruntime-linux-x64-1.27.1.tgz');
  assert.equal(
    cpuSmokePins.linuxCpuOrt.sha256,
    '25b1ef1fea1acd210d63f8f24dc870ad6e077795ce1f54876252c6d3803c15af',
  );
  assert.equal(cpuSmokePins.linuxCpuOrt.dylibName, 'libonnxruntime.so.1.27.1');
});


test('CPU smoke extraction markers are pin-identity based and reject stale caches', () => {
  const pack = SPEAKRS_MODEL_PACK_ARTIFACTS[cpuSmokePins.onnxSubsetPlatform];
  const expectedOnnx = getOnnxSubsetMarkerIdentity(pack);
  const expectedOrt = getWindowsCpuOrtMarkerIdentity(cpuSmokePins.windowsCpuOrt);
  assert.equal(expectedOnnx, `${pack.sha256}\n${pack.fileName}\n`);
  assert.match(expectedOrt, new RegExp(`${cpuSmokePins.windowsCpuOrt.sha256}`));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-smoke-marker-'));
  try {
    const extractDir = path.join(tempDir, 'onnx-subset');
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(path.join(extractDir, '.complete'), 'stale-sha\n');
    assert.equal(canReuseExtraction(extractDir, expectedOnnx), false);

    fs.writeFileSync(path.join(extractDir, '.complete'), expectedOnnx);
    assert.equal(canReuseExtraction(extractDir, expectedOnnx), true);

    const ortDir = path.join(tempDir, 'windows-cpu-ort');
    fs.mkdirSync(ortDir, { recursive: true });
    fs.writeFileSync(path.join(ortDir, 'onnxruntime.dll'), 'old-dll');
    fs.writeFileSync(path.join(ortDir, '.complete'), 'old-ort-sha\n');
    assert.equal(canReuseExtraction(ortDir, expectedOrt, 'onnxruntime.dll'), false);

    fs.writeFileSync(path.join(ortDir, '.complete'), expectedOrt);
    assert.equal(canReuseExtraction(ortDir, expectedOrt, 'onnxruntime.dll'), true);
    assert.equal(canReuseExtraction(ortDir, expectedOrt, 'missing.dll'), false);

    const identity = getCpuSmokeCacheIdentity();
    assert.match(identity, /^[a-f0-9]{64}$/);
    const drifted = getCpuSmokeCacheIdentity({
      ...cpuSmokePins,
      windowsCpuOrt: { ...cpuSmokePins.windowsCpuOrt, sha256: 'b'.repeat(64) },
    });
    assert.notEqual(identity, drifted);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('CI and release workflows install explicit Rust targets and pin-safe smoke caches', () => {
  assert.match(CI_WORKFLOW, /targets:\s*aarch64-apple-darwin/);
  assert.match(CI_WORKFLOW, /targets:\s*x86_64-pc-windows-msvc/);
  assert.match(CI_WORKFLOW, /targets:\s*x86_64-unknown-linux-gnu/);
  assert.match(CI_WORKFLOW, /cargo build --release --locked --target aarch64-apple-darwin/);
  assert.match(CI_WORKFLOW, /cargo build --release --locked --target x86_64-pc-windows-msvc/);
  assert.match(CI_WORKFLOW, /cargo build --release --locked --target x86_64-unknown-linux-gnu/);
  assert.match(CI_WORKFLOW, /native\/speakrs-cli\/target\/aarch64-apple-darwin\/release\/speakrs-cli/);
  assert.match(CI_WORKFLOW, /native\/speakrs-cli\/target\/x86_64-pc-windows-msvc\/release\/speakrs-cli\.exe/);
  assert.match(CI_WORKFLOW, /native\/speakrs-cli\/target\/x86_64-unknown-linux-gnu\/release\/speakrs-cli/);
  assert.match(CI_WORKFLOW, /Speakrs CPU-mode inference smoke \(non-GPU structural check\)/);
  assert.match(CI_WORKFLOW, /hashFiles\('native\/speakrs-cli\/ci-cpu-smoke-pins\.json'/);
  assert.equal(CI_WORKFLOW.includes('speakrs-cpu-smoke-${{ runner.os }}-5d24ffe'), false);
  assert.match(RELEASE_WORKFLOW, /rust-target: x86_64-pc-windows-msvc/);
  assert.match(RELEASE_WORKFLOW, /rust-target: aarch64-apple-darwin/);
  assert.match(RELEASE_WORKFLOW, /rust-target: x86_64-unknown-linux-gnu/);
  assert.match(RELEASE_WORKFLOW, /targets: \$\{\{ matrix\.rust-target \}\}/);
});


test('release workflow verifies remote checksums once and keeps packaged layout checks per platform', () => {
  assert.match(RELEASE_WORKFLOW, /name: Verify Speakrs release artifact checksums/);
  assert.match(RELEASE_WORKFLOW, /node scripts\/verify-speakrs-packaging\.js --verify-pack-checksums/);
  assert.equal((RELEASE_WORKFLOW.match(/--verify-pack-checksums/g) || []).length, 1);
  assert.match(RELEASE_WORKFLOW, /needs: verify-speakrs-release-artifacts/);
  assert.match(RELEASE_WORKFLOW, /verify-speakrs-release-artifacts/);
  assert.match(RELEASE_WORKFLOW, /node scripts\/verify-speakrs-packaging\.js --packaged/);
  assert.equal(RELEASE_WORKFLOW.includes('--packaged --verify-pack-checksums'), false);
  assert.match(RELEASE_WORKFLOW, /publish-release:[\s\S]*needs:[\s\S]*verify-speakrs-release-artifacts/);
});


test('Speakrs GitHub Actions use reviewed commit SHAs rather than moving refs', () => {
  assert.doesNotMatch(CI_WORKFLOW, /dtolnay\/rust-toolchain@master/);
  assert.doesNotMatch(RELEASE_WORKFLOW, /dtolnay\/rust-toolchain@master/);
  assert.doesNotMatch(CI_WORKFLOW, /uses:\s*Swatinem\/rust-cache@v2\s/);
  assert.doesNotMatch(RELEASE_WORKFLOW, /uses:\s*Swatinem\/rust-cache@v2\s/);
  assert.match(CI_WORKFLOW, /dtolnay\/rust-toolchain@6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772/);
  assert.match(RELEASE_WORKFLOW, /dtolnay\/rust-toolchain@6c977a6ca4077a0ceb28ffbe03f59d46e9ac8772/);
  assert.match(CI_WORKFLOW, /Swatinem\/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6/);
  assert.match(RELEASE_WORKFLOW, /Swatinem\/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6/);
  assert.match(CI_WORKFLOW, /dtolnay\/rust-toolchain master as of 2026-08-05/);
  assert.match(RELEASE_WORKFLOW, /dtolnay\/rust-toolchain master as of 2026-08-05/);
  assert.match(CI_WORKFLOW, /Swatinem\/rust-cache v2\.9\.2/);
  assert.match(RELEASE_WORKFLOW, /Swatinem\/rust-cache v2\.9\.2/);
});


test('packaged Speakrs layout requires the canonical fixture and rejects missing, empty, or duplicate copies', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-packaged-layout-'));
  const resourcesRoot = path.join(tempDir, 'resources');
  try {
    assert.throws(
      () => assertPackagedSpeakrsLayout(resourcesRoot),
      /speakrs-cli is missing/,
    );

    const cliPath = path.join(resourcesRoot, 'bin', getSpeakrsCliBinaryName());
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.writeFileSync(cliPath, '');
    assert.throws(
      () => assertPackagedSpeakrsLayout(resourcesRoot),
      /empty/,
    );

    if (process.platform === 'win32') {
      writeMinimalPe(cliPath, WINDOWS_PE_MACHINE_AMD64);
      assert.throws(
        () => assertPackagedSpeakrsLayout(resourcesRoot),
        /canonical path/,
      );

      const wavPath = path.join(resourcesRoot, 'bin', SPEAKRS_VALIDATE_WAV_NAME);
      writeCanonicalFixture(wavPath, Buffer.alloc(0));
      assert.throws(
        () => assertPackagedSpeakrsLayout(resourcesRoot),
        /empty/,
      );

      writeCanonicalFixture(wavPath);
      const duplicate = path.join(resourcesRoot, 'backend', 'diarization', 'fixtures', SPEAKRS_VALIDATE_WAV_NAME);
      writeCanonicalFixture(duplicate);
      assert.throws(
        () => assertPackagedSpeakrsLayout(resourcesRoot),
        /duplicate Speakrs fixture/,
      );

      fs.rmSync(duplicate);
      const testsDuplicate = path.join(resourcesRoot, 'tests', 'fixtures', SPEAKRS_VALIDATE_WAV_NAME);
      writeCanonicalFixture(testsDuplicate);
      assert.throws(
        () => assertPackagedSpeakrsLayout(resourcesRoot),
        /duplicate Speakrs fixture/,
      );

      fs.rmSync(testsDuplicate);
      assert.equal(assertPackagedSpeakrsLayout(resourcesRoot), cliPath);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('macOS packaged-app verifier requires arm64 speakrs-cli and the canonical fixture only', () => {
  assert.match(MACOS_VERIFY_SCRIPT, /file "\$SPEAKRS_CLI_PATH" \| grep -q "arm64"/);
  assert.match(MACOS_VERIFY_SCRIPT, /test -s "\$SPEAKRS_CLI_PATH"/);
  assert.match(MACOS_VERIFY_SCRIPT, /test -s "\$SPEAKRS_WAV_BIN"/);
  assert.match(MACOS_VERIFY_SCRIPT, /must not ship a duplicate Speakrs fixture under backend\/diarization\/fixtures/);
  assert.equal(MACOS_VERIFY_SCRIPT.includes('SPEAKRS_WAV_BIN" && ! -f "$SPEAKRS_WAV_BACKEND'), false);
});


test('Speakrs packaged integrity manifest hashes binary CLI bytes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-speakrs-integrity-'));
  try {
    const binDir = path.join(tempDir, 'bin');
    const cliPath = path.join(binDir, getSpeakrsCliBinaryName('darwin'));
    const wavPath = path.join(binDir, SPEAKRS_VALIDATE_WAV_NAME);
    writeMinimalMachO(cliPath, MACHO_CPU_TYPE_ARM64);
    fs.chmodSync(cliPath, 0o755);
    writeCanonicalFixture(wavPath, Buffer.from([0x52, 0x49, 0x46, 0x46, 0xff, 0x80, 0x00]));

    const manifestPath = writeSpeakrsPackagedIntegrityManifest(binDir, 'darwin');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const expected = require('node:crypto').createHash('sha256')
      .update(fs.readFileSync(cliPath))
      .digest('hex');

    assert.equal(manifest.platforms['darwin-arm64'].cli.sha256, expected);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test('macOS packaged-app verifier rejects an invalid app seal without mutating it with pycache', () => {
  assert.match(MACOS_VERIFY_SCRIPT, /codesign --verify --deep --strict --verbose=2 "\$APP_PATH"/);
  assert.match(MACOS_VERIFY_SCRIPT, /PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="\$BACKEND_PATH"/);
  // PR builds otherwise skip signing, which leaves the incomplete linker seal
  // that Gate B closed (codesign --deep --strict: no resources).
  assert.match(CI_WORKFLOW, /CSC_FOR_PULL_REQUEST:\s*true/);
});


test('macOS speakrs-cli verification checks signature and entitlements', () => {
  const commands = buildMacOSSpeakrsCliVerificationCommands(
    '/Applications/AvaNevis.app/Contents/Resources/bin/speakrs-cli',
  );
  assert.deepEqual(commands, [
    {
      command: 'codesign',
      args: [
        '--verify',
        '--strict',
        '--verbose=2',
        '/Applications/AvaNevis.app/Contents/Resources/bin/speakrs-cli',
      ],
    },
    {
      command: 'codesign',
      args: [
        '-d',
        '--entitlements',
        ':-',
        '/Applications/AvaNevis.app/Contents/Resources/bin/speakrs-cli',
      ],
    },
  ]);
});
