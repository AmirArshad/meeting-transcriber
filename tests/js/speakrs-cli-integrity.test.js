const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  ELF_CLASS_32,
  ELF_MACHINE_X86_64,
  MACHO_CPU_TYPE_ARM64,
  SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE,
  SPEAKRS_VALIDATE_WAV_NAME,
  WINDOWS_PE_MACHINE_AMD64,
  getPackagedSpeakrsIntegrityError,
  inspectPackagedSpeakrsLayout,
  inspectSpeakrsCliFile,
  inspectSpeakrsValidateWavFile,
  isLinuxX64ElfExecutableFileOutput,
} = require('../../src/ai-addon/speakrs-cli-integrity');
const {
  checkAiAddonSetupStatus,
  getPackagedSpeakrsCliPreflightError,
} = require('../../src/ai-addon/manifest-store');
const {
  AI_MODEL_CATALOG,
  SPEAKRS_DIARIZATION_MODEL_ID,
} = require('../../src/ai-addon-state');
const { writeSpeakrsLinuxElfFixture } = require('./speakrs-linux-elf-fixture');

function createStatusCatalog() {
  const bytes = Buffer.from('model');
  const sha256 = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  return {
    version: 1,
    diarization: {
      defaultModelId: SPEAKRS_DIARIZATION_MODEL_ID,
      dependencyArtifacts: AI_MODEL_CATALOG.diarization.dependencyArtifacts,
      models: [{
        id: SPEAKRS_DIARIZATION_MODEL_ID,
        engine: 'speakrs',
        runtime: { type: 'native-cli', executableName: 'speakrs-cli', modeByPlatform: { 'darwin-arm64': 'coreml' } },
        packRevision: 'test-revision',
        packArtifacts: {
          'darwin-arm64': [{
            id: 'test-pack',
            kind: 'model-pack',
            fileName: 'test.tar.gz',
            archiveFormat: 'tar.gz',
            downloadUrl: 'https://github.com/AmirArshad/meeting-transcriber/releases/download/test/test.tar.gz',
            sha256,
            sizeBytes: bytes.length,
            requiredFiles: [{ path: 'model.bin', fileName: 'model.bin', sha256, sizeBytes: bytes.length }],
          }],
        },
      }],
    },
    summary: AI_MODEL_CATALOG.summary,
  };
}

function writeReadySpeakrsStatusState(userDataDir, catalog) {
  const modelPath = path.join(userDataDir, 'ai-addons', 'models', 'diarization', 'speakrs', 'test-revision', 'model.bin');
  fs.mkdirSync(path.dirname(modelPath), { recursive: true });
  fs.writeFileSync(modelPath, 'model');
  const manifestPath = path.join(userDataDir, 'ai-addons', 'manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify({
    manifestVersion: 1,
    features: {
      diarization: { engine: 'speakrs', status: 'ready', modelId: SPEAKRS_DIARIZATION_MODEL_ID },
      summary: { status: 'notConfigured', modelId: catalog.summary.defaultModelId },
    },
  }));
}

const WINDOWS_PE_MACHINE_I386 = 0x14c;
const MACHO_CPU_TYPE_X86_64 = 0x01000007;
const MACHO_FAT_MAGIC = 0xcafebabe;
const ELF_MACHINE_AARCH64 = 183;
const ELF_MACHINE_I386 = 3;

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

function writeMinimalElf(filePath, { eiClass = 2, machine = ELF_MACHINE_X86_64, kind = 'pie-executable' } = {}) {
  if (eiClass === ELF_CLASS_32) {
    writeSpeakrsLinuxElfFixture(filePath, { eiClass: ELF_CLASS_32, machine });
    return;
  }
  writeSpeakrsLinuxElfFixture(filePath, { kind, machine });
}

function writeCanonicalFixture(filePath, contents = Buffer.from('RIFF-fixture')) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writePackagedIntegrityManifest(resourcesPath, platform) {
  const binDir = path.join(resourcesPath, 'bin');
  const cliName = platform === 'win32' ? 'speakrs-cli.exe' : 'speakrs-cli';
  const cliPath = path.join(binDir, cliName);
  const wavPath = path.join(binDir, SPEAKRS_VALIDATE_WAV_NAME);
  const pin = (filePath) => {
    const contents = fs.readFileSync(filePath);
    return {
      sizeBytes: contents.length,
      sha256: crypto.createHash('sha256').update(contents).digest('hex'),
    };
  };
  const platformKey = platform === 'darwin' ? 'darwin-arm64' : `${platform}-x64`;
  fs.writeFileSync(path.join(binDir, 'speakrs-integrity.json'), JSON.stringify({
    version: 1,
    platforms: {
      [platformKey]: { cli: pin(cliPath), validationWav: pin(wavPath) },
    },
  }));
}

function createDarwinFs({ nonExecutablePaths = new Set(), nonFilePaths = new Set() } = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'statSync') {
        return (filePath) => {
          const stats = target.statSync(filePath);
          return {
            isFile: () => !nonFilePaths.has(filePath) && stats.isFile(),
            isDirectory: () => stats.isDirectory(),
            size: stats.size,
            mtimeMs: stats.mtimeMs,
            mode: nonExecutablePaths.has(filePath) ? 0o644 : 0o755,
          };
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function makeLayout(root, {
  platform = 'win32',
  cli,
  fixture = 'present',
} = {}) {
  const resourcesPath = path.join(root, 'Resources');
  const binDir = path.join(resourcesPath, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const cliName = platform === 'win32' ? 'speakrs-cli.exe' : 'speakrs-cli';
  const cliPath = path.join(binDir, cliName);
  const wavPath = path.join(binDir, SPEAKRS_VALIDATE_WAV_NAME);

  if (cli === 'valid-win32') {
    writeMinimalPe(cliPath, WINDOWS_PE_MACHINE_AMD64);
  } else if (cli === 'valid-darwin') {
    writeMinimalMachO(cliPath, MACHO_CPU_TYPE_ARM64);
  } else if (cli === 'valid-linux') {
    writeMinimalElf(cliPath);
  } else if (cli === 'empty') {
    fs.writeFileSync(cliPath, Buffer.alloc(0));
  } else if (cli === 'directory') {
    fs.mkdirSync(cliPath, { recursive: true });
  } else if (cli === 'i386') {
    writeMinimalPe(cliPath, WINDOWS_PE_MACHINE_I386);
  } else if (cli === 'x86_64-macho') {
    writeMinimalMachO(cliPath, MACHO_CPU_TYPE_X86_64);
  } else if (cli === 'malformed') {
    fs.writeFileSync(cliPath, Buffer.from('MZ-not-a-pe'));
  } else if (cli === 'fat-macho') {
    const buf = Buffer.alloc(16, 0);
    buf.writeUInt32LE(MACHO_FAT_MAGIC, 0);
    fs.writeFileSync(cliPath, buf);
  } else if (cli === 'python-wrapper') {
    fs.writeFileSync(path.join(binDir, 'speakrs-cli.py'), 'print("nope")\n');
  } else if (cli === 'wrong-basename') {
    writeMinimalPe(path.join(binDir, 'speakrs.exe'), WINDOWS_PE_MACHINE_AMD64);
  }

  if (fixture === 'present') {
    writeCanonicalFixture(wavPath);
  } else if (fixture === 'empty') {
    fs.writeFileSync(wavPath, Buffer.alloc(0));
  } else if (fixture === 'directory') {
    fs.mkdirSync(wavPath, { recursive: true });
  }

  if (fs.existsSync(cliPath) && fs.existsSync(wavPath)
    && fs.statSync(cliPath).isFile() && fs.statSync(wavPath).isFile()) {
    writePackagedIntegrityManifest(resourcesPath, platform);
  }

  return { resourcesPath, cliPath, wavPath };
}

test('inspectSpeakrsCliFile rejects missing, empty, directory, and wrong names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-cli-inspect-'));
  try {
    const missing = inspectSpeakrsCliFile(path.join(root, 'speakrs-cli.exe'), { platform: 'win32' });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing');

    const { cliPath: emptyPath } = makeLayout(path.join(root, 'empty'), { cli: 'empty', fixture: 'absent' });
    assert.equal(inspectSpeakrsCliFile(emptyPath, { platform: 'win32' }).reason, 'empty');

    const { cliPath: dirPath } = makeLayout(path.join(root, 'dir'), { cli: 'directory', fixture: 'absent' });
    assert.equal(inspectSpeakrsCliFile(dirPath, { platform: 'win32' }).reason, 'directory');

    const pyPath = path.join(root, 'speakrs-cli.py');
    fs.writeFileSync(pyPath, 'print("nope")\n');
    assert.equal(inspectSpeakrsCliFile(pyPath, { platform: 'win32' }).reason, 'python-wrapper');
    assert.equal(inspectSpeakrsCliFile(pyPath, { platform: 'darwin' }).reason, 'python-wrapper');

    const wrong = path.join(root, 'speakrs.exe');
    writeMinimalPe(wrong, WINDOWS_PE_MACHINE_AMD64);
    assert.equal(inspectSpeakrsCliFile(wrong, { platform: 'win32' }).reason, 'wrong-basename');

    const pathLookup = inspectSpeakrsCliFile('speakrs-cli', { platform: 'linux' });
    assert.equal(pathLookup.ok, false);
    assert.equal(pathLookup.reason, 'path-lookup');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectSpeakrsCliFile rejects wrong architecture and malformed binaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-cli-arch-'));
  try {
    const i386 = path.join(root, 'speakrs-cli.exe');
    writeMinimalPe(i386, WINDOWS_PE_MACHINE_I386);
    const i386Result = inspectSpeakrsCliFile(i386, { platform: 'win32' });
    assert.equal(i386Result.ok, false);
    assert.equal(i386Result.reason, 'wrong-architecture');

    const malformed = path.join(root, 'malformed', 'speakrs-cli.exe');
    fs.mkdirSync(path.dirname(malformed), { recursive: true });
    fs.writeFileSync(malformed, Buffer.from('MZ-not-a-pe'));
    assert.equal(inspectSpeakrsCliFile(malformed, { platform: 'win32' }).reason, 'malformed');

    const darwinFs = {
      existsSync: fs.existsSync.bind(fs),
      statSync: (filePath) => {
        const stats = fs.statSync(filePath);
        return {
          isFile: () => stats.isFile(),
          isDirectory: () => stats.isDirectory(),
          size: stats.size,
          mode: 0o755,
        };
      },
      openSync: fs.openSync.bind(fs),
      readSync: fs.readSync.bind(fs),
      closeSync: fs.closeSync.bind(fs),
    };
    const x64MachO = path.join(root, 'speakrs-cli');
    writeMinimalMachO(x64MachO, MACHO_CPU_TYPE_X86_64);
    assert.equal(inspectSpeakrsCliFile(x64MachO, { platform: 'darwin', fsModule: darwinFs }).reason, 'wrong-architecture');

    const fat = path.join(root, 'fat', 'speakrs-cli');
    fs.mkdirSync(path.dirname(fat), { recursive: true });
    const fatBuf = Buffer.alloc(16, 0);
    fatBuf.writeUInt32LE(MACHO_FAT_MAGIC, 0);
    fs.writeFileSync(fat, fatBuf);
    assert.equal(inspectSpeakrsCliFile(fat, { platform: 'darwin', fsModule: darwinFs }).reason, 'malformed');

    const validWin = path.join(root, 'valid-win', 'speakrs-cli.exe');
    writeMinimalPe(validWin, WINDOWS_PE_MACHINE_AMD64);
    assert.equal(inspectSpeakrsCliFile(validWin, { platform: 'win32' }).ok, true);

    const validMac = path.join(root, 'valid-mac', 'speakrs-cli');
    writeMinimalMachO(validMac, MACHO_CPU_TYPE_ARM64);
    assert.equal(inspectSpeakrsCliFile(validMac, { platform: 'darwin', fsModule: darwinFs }).ok, true);

    const linuxFs = darwinFs;
    const validLinux = path.join(root, 'valid-linux', 'speakrs-cli');
    writeMinimalElf(validLinux);
    assert.equal(inspectSpeakrsCliFile(validLinux, { platform: 'linux', fsModule: linuxFs }).ok, true);

    const elf32 = path.join(root, 'elf32', 'speakrs-cli');
    writeMinimalElf(elf32, { eiClass: ELF_CLASS_32, machine: ELF_MACHINE_I386 });
    assert.equal(inspectSpeakrsCliFile(elf32, { platform: 'linux', fsModule: linuxFs }).reason, 'wrong-architecture');

    const aarch64Elf = path.join(root, 'aarch64-elf', 'speakrs-cli');
    writeMinimalElf(aarch64Elf, { machine: ELF_MACHINE_AARCH64, kind: 'pie-executable' });
    assert.equal(inspectSpeakrsCliFile(aarch64Elf, { platform: 'linux', fsModule: linuxFs }).reason, 'wrong-architecture');

    const peOnLinux = path.join(root, 'pe-on-linux', 'speakrs-cli');
    writeMinimalPe(peOnLinux, WINDOWS_PE_MACHINE_AMD64);
    assert.equal(inspectSpeakrsCliFile(peOnLinux, { platform: 'linux', fsModule: linuxFs }).reason, 'malformed');

    const headerOnly = path.join(root, 'header-only', 'speakrs-cli');
    writeSpeakrsLinuxElfFixture(headerOnly, { kind: 'header-only' });
    assert.equal(inspectSpeakrsCliFile(headerOnly, { platform: 'linux', fsModule: linuxFs }).reason, 'malformed');

    const sharedObject = path.join(root, 'shared-object', 'speakrs-cli');
    writeSpeakrsLinuxElfFixture(sharedObject, { kind: 'shared-object' });
    assert.equal(inspectSpeakrsCliFile(sharedObject, { platform: 'linux', fsModule: linuxFs }).reason, 'malformed');
    assert.match(
      inspectSpeakrsCliFile(sharedObject, { platform: 'linux', fsModule: linuxFs }).detail,
      /shared object/,
    );

    const missingInterp = path.join(root, 'missing-interp', 'speakrs-cli');
    writeSpeakrsLinuxElfFixture(missingInterp, { kind: 'missing-interpreter' });
    assert.equal(inspectSpeakrsCliFile(missingInterp, { platform: 'linux', fsModule: linuxFs }).reason, 'malformed');
    assert.match(
      inspectSpeakrsCliFile(missingInterp, { platform: 'linux', fsModule: linuxFs }).detail,
      /interpreter/,
    );

    const badVersion = path.join(root, 'bad-version', 'speakrs-cli');
    writeSpeakrsLinuxElfFixture(badVersion, { kind: 'bad-header-version' });
    assert.equal(inspectSpeakrsCliFile(badVersion, { platform: 'linux', fsModule: linuxFs }).reason, 'malformed');
    assert.match(
      inspectSpeakrsCliFile(badVersion, { platform: 'linux', fsModule: linuxFs }).detail,
      /ELF version/,
    );

    const truncatedPhdrs = path.join(root, 'truncated-phdrs', 'speakrs-cli');
    writeSpeakrsLinuxElfFixture(truncatedPhdrs, { kind: 'truncated-program-table' });
    assert.equal(inspectSpeakrsCliFile(truncatedPhdrs, { platform: 'linux', fsModule: linuxFs }).reason, 'malformed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectSpeakrsCliFile requires POSIX execute permission', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-cli-mode-'));
  try {
    const cliPath = path.join(root, 'speakrs-cli');
    writeMinimalMachO(cliPath, MACHO_CPU_TYPE_ARM64);
    const stats = fs.statSync(cliPath);
    const result = inspectSpeakrsCliFile(cliPath, {
      platform: 'darwin',
      fsModule: {
        existsSync: () => true,
        statSync: () => ({
          isFile: () => true,
          isDirectory: () => false,
          size: stats.size,
          mode: 0o644,
        }),
        openSync: fs.openSync.bind(fs),
        readSync: fs.readSync.bind(fs),
        closeSync: fs.closeSync.bind(fs),
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'non-executable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('inspectSpeakrsValidateWavFile rejects missing, empty, and directory fixtures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-wav-inspect-'));
  try {
    const missing = inspectSpeakrsValidateWavFile(path.join(root, SPEAKRS_VALIDATE_WAV_NAME));
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing');

    const empty = path.join(root, 'empty', SPEAKRS_VALIDATE_WAV_NAME);
    fs.mkdirSync(path.dirname(empty), { recursive: true });
    fs.writeFileSync(empty, Buffer.alloc(0));
    assert.equal(inspectSpeakrsValidateWavFile(empty).reason, 'empty');

    const dir = path.join(root, 'dir', SPEAKRS_VALIDATE_WAV_NAME);
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(inspectSpeakrsValidateWavFile(dir).reason, 'directory');

    const wrong = path.join(root, 'other.wav');
    writeCanonicalFixture(wrong);
    assert.equal(inspectSpeakrsValidateWavFile(wrong).reason, 'wrong-basename');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packaged Speakrs integrity is fail-closed and ignores overrides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-packaged-integrity-'));
  try {
    const missing = makeLayout(path.join(root, 'missing'), { cli: 'absent', fixture: 'absent' });
    const missingError = getPackagedSpeakrsIntegrityError({
      platform: 'win32',
      resourcesPath: missing.resourcesPath,
    });
    assert.ok(missingError);
    assert.equal(missingError.code, 'SPEAKRS_PACKAGED_CLI_MISSING');
    assert.equal(missingError.message, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE);
    assert.equal(missingError.reason, 'missing');
    assert.doesNotMatch(missingError.message, /re-run speaker setup|FileNotFoundError|traceback/i);

    const emptyCli = makeLayout(path.join(root, 'empty-cli'), { cli: 'empty' });
    assert.equal(inspectPackagedSpeakrsLayout({
      platform: 'win32',
      resourcesPath: emptyCli.resourcesPath,
    }).reason, 'empty');

    const dirCli = makeLayout(path.join(root, 'dir-cli'), { cli: 'directory' });
    assert.equal(inspectPackagedSpeakrsLayout({
      platform: 'win32',
      resourcesPath: dirCli.resourcesPath,
    }).reason, 'directory');

    const wrongArch = makeLayout(path.join(root, 'i386'), { cli: 'i386' });
    assert.equal(inspectPackagedSpeakrsLayout({
      platform: 'win32',
      resourcesPath: wrongArch.resourcesPath,
    }).reason, 'wrong-architecture');

    const malformed = makeLayout(path.join(root, 'malformed'), { cli: 'malformed' });
    assert.equal(inspectPackagedSpeakrsLayout({
      platform: 'win32',
      resourcesPath: malformed.resourcesPath,
    }).reason, 'malformed');

    const emptyWav = makeLayout(path.join(root, 'empty-wav'), { cli: 'valid-win32', fixture: 'empty' });
    const emptyWavLayout = inspectPackagedSpeakrsLayout({
      platform: 'win32',
      resourcesPath: emptyWav.resourcesPath,
    });
    assert.equal(emptyWavLayout.ok, false);
    assert.equal(emptyWavLayout.kind, 'fixture');
    assert.equal(emptyWavLayout.reason, 'empty');

    const missingWav = makeLayout(path.join(root, 'missing-wav'), { cli: 'valid-win32', fixture: 'absent' });
    assert.equal(inspectPackagedSpeakrsLayout({
      platform: 'win32',
      resourcesPath: missingWav.resourcesPath,
    }).reason, 'missing');

    const valid = makeLayout(path.join(root, 'valid'), { cli: 'valid-win32', fixture: 'present' });
    fs.appendFileSync(valid.cliPath, 'substituted binary contents');
    const substitutedCli = inspectPackagedSpeakrsLayout({
      platform: 'win32',
      resourcesPath: valid.resourcesPath,
    });
    assert.equal(substitutedCli.ok, false);
    assert.equal(substitutedCli.kind, 'cli');
    assert.equal(substitutedCli.reason, 'checksum-mismatch');
    writePackagedIntegrityManifest(valid.resourcesPath, 'win32');
    fs.appendFileSync(valid.wavPath, 'substituted fixture contents');
    const substitutedFixture = inspectPackagedSpeakrsLayout({
      platform: 'win32',
      resourcesPath: valid.resourcesPath,
    });
    assert.equal(substitutedFixture.ok, false);
    assert.equal(substitutedFixture.kind, 'fixture');
    assert.equal(substitutedFixture.reason, 'checksum-mismatch');
    writePackagedIntegrityManifest(valid.resourcesPath, 'win32');
    const override = path.join(root, 'override', 'speakrs-cli.exe');
    writeMinimalPe(override, WINDOWS_PE_MACHINE_AMD64);
    writeCanonicalFixture(path.join(root, 'override', SPEAKRS_VALIDATE_WAV_NAME));
    const packagedError = getPackagedSpeakrsCliPreflightError({
      engine: 'speakrs',
      env: {
        AVANEVIS_PACKAGED: '1',
        SPEAKRS_CLI_PATH: override,
        SPEAKRS_VALIDATE_WAV: path.join(root, 'override', SPEAKRS_VALIDATE_WAV_NAME),
      },
      platform: 'win32',
      resourcesPath: missing.resourcesPath,
    });
    assert.ok(packagedError);
    assert.equal(packagedError.message, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE);

    assert.equal(getPackagedSpeakrsCliPreflightError({
      engine: 'speakrs',
      env: { AVANEVIS_PACKAGED: '1' },
      platform: 'win32',
      resourcesPath: valid.resourcesPath,
    }), null);

    const linuxValid = makeLayout(path.join(root, 'valid-linux'), { platform: 'linux', cli: 'valid-linux' });
    if (process.platform !== 'win32') {
      fs.chmodSync(linuxValid.cliPath, 0o755);
    }
    const linuxLayout = inspectPackagedSpeakrsLayout({
      platform: 'linux',
      resourcesPath: linuxValid.resourcesPath,
      fsModule: process.platform === 'win32'
        ? {
            existsSync: fs.existsSync.bind(fs),
            statSync: (filePath) => {
              const stats = fs.statSync(filePath);
              return {
                isFile: () => stats.isFile(),
                isDirectory: () => stats.isDirectory(),
                size: stats.size,
                mode: 0o755,
              };
            },
            openSync: fs.openSync.bind(fs),
            readSync: fs.readSync.bind(fs),
            closeSync: fs.closeSync.bind(fs),
          }
        : fs,
    });
    assert.equal(linuxLayout.ok, true);
    assert.equal(linuxLayout.cliPath, linuxValid.cliPath);
    assert.equal(
      isLinuxX64ElfExecutableFileOutput('ELF 64-bit LSB pie executable, x86-64, dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2'),
      true,
    );
    assert.equal(
      isLinuxX64ElfExecutableFileOutput('ELF 64-bit LSB shared object, x86-64, version 1 (SYSV), dynamically linked'),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packaged Speakrs status requires the canonical CLI and fixture integrity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speakrs-packaged-status-'));
  const catalog = createStatusCatalog();
  const cases = [
    { name: 'missing-cli', cli: 'absent', fixture: 'present' },
    { name: 'empty-cli', cli: 'empty', fixture: 'present' },
    { name: 'directory-cli', cli: 'directory', fixture: 'present' },
    { name: 'malformed-cli', cli: 'malformed', fixture: 'present' },
    { name: 'wrong-architecture-cli', cli: 'x86_64-macho', fixture: 'present' },
    { name: 'missing-fixture', cli: 'valid-darwin', fixture: 'absent' },
    { name: 'empty-fixture', cli: 'valid-darwin', fixture: 'empty' },
    { name: 'directory-fixture', cli: 'valid-darwin', fixture: 'directory' },
  ];
  try {
    for (const item of cases) {
      const userDataDir = path.join(root, item.name, 'userData');
      const layout = makeLayout(path.join(root, item.name), {
        platform: 'darwin',
        cli: item.cli,
        fixture: item.fixture,
      });
      if (fs.existsSync(layout.cliPath) && fs.statSync(layout.cliPath).isFile()) {
        fs.chmodSync(layout.cliPath, 0o755);
      }
      writeReadySpeakrsStatusState(userDataDir, catalog);
      const status = await checkAiAddonSetupStatus({
        userDataDir,
        platform: 'darwin',
        arch: 'arm64',
        catalog,
        fsModule: createDarwinFs(),
        env: {
          AVANEVIS_PACKAGED: '1',
          SPEAKRS_CLI_PATH: path.join(root, 'decoy', 'speakrs-cli'),
          SPEAKRS_VALIDATE_WAV: path.join(root, 'decoy', SPEAKRS_VALIDATE_WAV_NAME),
          PATH: path.join(root, 'decoy'),
        },
        resourcesPath: layout.resourcesPath,
      });
      assert.equal(status.features.diarization.cliPresent, false, item.name);
      assert.equal(status.features.diarization.setupComplete, false, item.name);
      assert.equal(status.features.diarization.status, 'error', item.name);
      assert.equal(status.features.diarization.error, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE, item.name);
      assert.equal(status.features.diarization.cliMissingMessage, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE, item.name);
    }

    const nonExecutableRoot = path.join(root, 'non-executable');
    const nonExecutableLayout = makeLayout(nonExecutableRoot, { platform: 'darwin', cli: 'valid-darwin' });
    fs.chmodSync(nonExecutableLayout.cliPath, 0o644);
    const nonExecutableUserData = path.join(nonExecutableRoot, 'userData');
    writeReadySpeakrsStatusState(nonExecutableUserData, catalog);
    const nonExecutableStatus = await checkAiAddonSetupStatus({
      userDataDir: nonExecutableUserData,
      platform: 'darwin',
      arch: 'arm64',
      catalog,
      fsModule: createDarwinFs({ nonExecutablePaths: new Set([nonExecutableLayout.cliPath]) }),
      env: { AVANEVIS_PACKAGED: '1' },
      resourcesPath: nonExecutableLayout.resourcesPath,
    });
    assert.equal(nonExecutableStatus.features.diarization.status, 'error');
    assert.equal(nonExecutableStatus.features.diarization.error, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE);

    for (const kind of ['cli', 'fixture']) {
      const nonFileRoot = path.join(root, `non-file-${kind}`);
      const nonFileLayout = makeLayout(nonFileRoot, { platform: 'darwin', cli: 'valid-darwin' });
      const nonFilePath = kind === 'cli' ? nonFileLayout.cliPath : nonFileLayout.wavPath;
      const nonFileUserData = path.join(nonFileRoot, 'userData');
      writeReadySpeakrsStatusState(nonFileUserData, catalog);
      const nonFileStatus = await checkAiAddonSetupStatus({
        userDataDir: nonFileUserData,
        platform: 'darwin',
        arch: 'arm64',
        catalog,
        fsModule: createDarwinFs({ nonFilePaths: new Set([nonFilePath]) }),
        env: { AVANEVIS_PACKAGED: '1' },
        resourcesPath: nonFileLayout.resourcesPath,
      });
      assert.equal(nonFileStatus.features.diarization.status, 'error', kind);
      assert.equal(nonFileStatus.features.diarization.cliPresent, false, kind);
      assert.equal(nonFileStatus.features.diarization.error, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE, kind);
    }

    const wrongPeRoot = path.join(root, 'wrong-pe-status');
    const wrongPeLayout = makeLayout(wrongPeRoot, { platform: 'win32', cli: 'i386' });
    const wrongPeUserData = path.join(wrongPeRoot, 'userData');
    writeReadySpeakrsStatusState(wrongPeUserData, catalog);
    const wrongPeStatus = await checkAiAddonSetupStatus({
      userDataDir: wrongPeUserData,
      platform: 'win32',
      arch: 'x64',
      catalog,
      env: { AVANEVIS_PACKAGED: '1' },
      resourcesPath: wrongPeLayout.resourcesPath,
    });
    assert.equal(wrongPeStatus.features.diarization.status, 'error');
    assert.equal(wrongPeStatus.features.diarization.cliPresent, false);
    assert.equal(wrongPeStatus.features.diarization.error, SPEAKRS_PACKAGED_CLI_MISSING_MESSAGE);

    const validRoot = path.join(root, 'valid-status');
    const validLayout = makeLayout(validRoot, { platform: 'darwin', cli: 'valid-darwin' });
    fs.chmodSync(validLayout.cliPath, 0o755);
    const validUserData = path.join(validRoot, 'userData');
    writeReadySpeakrsStatusState(validUserData, catalog);
    const validStatus = await checkAiAddonSetupStatus({
      userDataDir: validUserData,
      platform: 'darwin',
      arch: 'arm64',
      catalog,
      fsModule: createDarwinFs(),
      env: { AVANEVIS_PACKAGED: '1' },
      resourcesPath: validLayout.resourcesPath,
    });
    assert.equal(validStatus.features.diarization.cliPresent, true);
    assert.equal(validStatus.features.diarization.setupComplete, true);
    assert.equal(validStatus.features.diarization.status, 'ready');
    assert.equal(validStatus.features.diarization.cliPath, validLayout.cliPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
