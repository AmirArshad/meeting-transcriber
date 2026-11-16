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
  assertPackagedSpeakrsLayout,
  assertPinnedDownloadArtifact,
  listReleaseChecksumArtifacts,
} = require('../../scripts/verify-speakrs-packaging');
const { SPEAKRS_MODEL_PACK_ARTIFACTS } = require('../../src/ai-addon/speakrs-pack-spec');
const { writeSpeakrsLinuxElfFixture } = require('./speakrs-linux-elf-fixture');

const ROOT = path.join(__dirname, '..', '..');
const CARGO_TOML = fs.readFileSync(path.join(ROOT, 'native', 'speakrs-cli', 'Cargo.toml'), 'utf8');
const PREPARE_RESOURCES_SOURCE = fs.readFileSync(path.join(ROOT, 'build', 'prepare-resources.js'), 'utf8');
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


test('speakrs rust-toolchain stays pinned at 1.89.0', () => {
  const toolchain = fs.readFileSync(path.join(ROOT, 'native', 'speakrs-cli', 'rust-toolchain.toml'), 'utf8');
  assert.match(toolchain, /channel = "1\.89\.0"/);
});


test('speakrs cargo feature flags stay on the Task 1 matrix', () => {
  assert.deepEqual(getSpeakrsCargoFeatures('darwin'), ['coreml']);
  assert.deepEqual(getSpeakrsCargoFeatures('win32'), ['cuda']);
  assert.deepEqual(getSpeakrsCargoFeatures('linux'), ['cuda']);
  assert.equal(CARGO_TOML.includes('default-features = false'), true);
  assert.equal(CARGO_TOML.includes('default-linalg'), false);
  assert.equal(CARGO_TOML.includes('"online"'), false);
  assert.equal(/\bcoreml-fast\b/.test(CARGO_TOML), false);
  assert.equal(/\bcuda-fast\b/.test(CARGO_TOML), false);
  assert.equal(/\bonline\b/.test(CARGO_TOML), false);
  assert.match(CARGO_TOML, /target_os = "macos"[\s\S]*features = \["coreml"\]/);
  assert.match(CARGO_TOML, /target_os = "windows"[\s\S]*features = \["cuda"\]/);
  assert.match(CARGO_TOML, /target_os = "linux"[\s\S]*features = \["cuda"\]/);
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
  assert.equal(manifest.inputs.speakrsCargoConfig.length, 64);
  assert.equal(manifest.inputs.speakrsValidateWav.length, 64);
  assert.equal(manifest.inputs.inheritEntitlements.length, 64);
  assert.equal(manifest.inputs.speakrsCargoTarget, getSpeakrsResourceManifestTarget());
  assert.ok(Array.isArray(manifest.inputs.speakrsSources));
  assert.ok(manifest.inputs.speakrsSources.some((entry) => entry.path === 'src/main.rs'));

  const updated = structuredClone(manifest);
  updated.inputs.speakrsCargoToml = 'changed';
  assert.equal(manifestsMatch(manifest, updated), false);
});


test('release verifier checks all 69 distinct model leaves at their pinned upstream paths', () => {
  const artifacts = listReleaseChecksumArtifacts();
  assert.equal(artifacts.length, 69);
  assert.equal(new Set(artifacts.map((artifact) => artifact.path)).size, artifacts.length);
  assert.ok(artifacts.some((artifact) => artifact.path.endsWith('.safetensors')));
  assert.ok(artifacts.some((artifact) => artifact.path.includes('.mlmodelc/weights/')));
  assert.ok(artifacts.every((artifact) => !artifact.fileName.endsWith('.onnx')));
  assert.throws(() => listReleaseChecksumArtifacts({
    'win32-x64': SPEAKRS_MODEL_PACK_ARTIFACTS['win32-x64'],
  }), /exactly darwin-arm64, linux-x64, win32-x64/);
  assert.throws(() => assertPinnedDownloadArtifact({
    fileName: 'model.npy',
    downloadUrl: 'http://huggingface.co/example/model.npy',
    sha256: 'a'.repeat(64),
    sizeBytes: 12,
  }), /must use HTTPS/);
});

test('macOS app and native Speakrs deployment floors are 15.0', () => {
  assert.equal(packageJson.build.mac.extendInfo.LSMinimumSystemVersion, '15.0');
  assert.match(PREPARE_RESOURCES_SOURCE, /SPEAKRS_MACOS_DEPLOYMENT_TARGET = '15.0'/);
  assert.match(MACOS_VERIFY_SCRIPT, /LSMinimumSystemVersion/);
});


test('CI and release workflows install explicit Rust targets and pin-safe smoke caches', () => {
  assert.match(CI_WORKFLOW, /targets:\s*aarch64-apple-darwin/);
  assert.match(CI_WORKFLOW, /targets:\s*x86_64-pc-windows-msvc/);
  assert.match(CI_WORKFLOW, /targets:\s*x86_64-unknown-linux-gnu/);
  assert.match(CI_WORKFLOW, /cargo build --release --locked --target aarch64-apple-darwin/);
  assert.match(CI_WORKFLOW, /cargo build --release --locked --target x86_64-pc-windows-msvc/);
  assert.match(CI_WORKFLOW, /cargo build --release --locked --target x86_64-unknown-linux-gnu/);
  assert.equal((CI_WORKFLOW.match(/cargo build --release --locked --features ci-cpu-smoke/g) || []).length, 3);
  assert.equal((CI_WORKFLOW.match(/run: node scripts\/run-speakrs-cpu-smoke\.js\s*$/gm) || []).length, 3);
  assert.match(CI_WORKFLOW, /hashFiles\('native\/speakrs-cpu-smoke\/Cargo\.lock'/);
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
  assert.match(CI_WORKFLOW, /dtolnay\/rust-toolchain@683b588c487a69d01f6c6ddf40f036ff682cc2c8/);
  assert.match(RELEASE_WORKFLOW, /dtolnay\/rust-toolchain@683b588c487a69d01f6c6ddf40f036ff682cc2c8/);
  assert.match(CI_WORKFLOW, /Swatinem\/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0/);
  assert.match(RELEASE_WORKFLOW, /Swatinem\/rust-cache@d1527c8f67ef9af357290475d4af4b0fab8f12e0/);
  assert.match(CI_WORKFLOW, /dtolnay\/rust-toolchain master as of 2026-11-03/);
  assert.match(RELEASE_WORKFLOW, /dtolnay\/rust-toolchain master as of 2026-11-03/);
  assert.match(CI_WORKFLOW, /Swatinem\/rust-cache v2\.9\.3/);
  assert.match(RELEASE_WORKFLOW, /Swatinem\/rust-cache v2\.9\.3/);
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
      writeSpeakrsPackagedIntegrityManifest(path.join(resourcesRoot, 'bin'), 'win32');
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
