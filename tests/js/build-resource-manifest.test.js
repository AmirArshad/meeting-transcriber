const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const packageJson = require('../../package.json');

const { hashString } = require('../../build/download-manifest');
const {
  buildDirectoryManifest,
  buildMacOSHelperVerificationCommands,
  buildMacOSPythonWheelhouseCommands,
  buildResourceManifest,
  extractTarGz,
  resolveArchiveExtractorPython,
  ensureWindowsEmbeddedPythonPathConfig,
  validateTarArchiveEntries,
  installPinnedPipWheel,
  ensureWindowsEmptyBinDirectory,
  getMacOSPythonRuntimeRemovablePackages,
  getStaleResourceDirectories,
  macOSHelperEntitlementsIncludeInherit,
  manifestsMatch,
  pruneMacOSPythonRuntimeDevelopmentFiles,
} = require('../../build/prepare-resources');

test('pinned pip replaces bundled pip and stale metadata without removing other packages', () => {
  const AdmZip = require('adm-zip');
  const { execFileSync } = require('node:child_process');
  const root = path.resolve(__dirname, '..', '..');
  const venvPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = fs.existsSync(venvPython) ? venvPython : (process.platform === 'win32' ? 'python' : 'python3');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-pip-pin-'));
  try {
    // A minimal wheel exercises replacement, including obsolete files that
    // extraction alone would otherwise leave in the bundled interpreter.
    const target = path.join(dir, 'site packages');
    fs.mkdirSync(path.join(target, 'pip'), { recursive: true });
    fs.mkdirSync(path.join(target, 'pip-0.0.0.dist-info'));
    fs.writeFileSync(path.join(target, 'pip', 'obsolete.py'), 'stale');
    fs.writeFileSync(path.join(target, 'unrelated.py'), 'keep');
    const zip = new AdmZip();
    zip.addFile('pip/__init__.py', Buffer.from('__version__ = "26.2.2"\n'));
    zip.addFile('pip-26.2.2.dist-info/METADATA', Buffer.from('Version: 26.2.2\n'));
    const wheel = path.join(dir, 'pinned pip.whl');
    zip.writeZip(wheel);

    installPinnedPipWheel(python, wheel, target);
    assert.equal(fs.existsSync(path.join(target, 'pip', 'obsolete.py')), false);
    assert.equal(fs.existsSync(path.join(target, 'pip-0.0.0.dist-info')), false);
    assert.equal(fs.readFileSync(path.join(target, 'unrelated.py'), 'utf8'), 'keep');
    const version = execFileSync(python, ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import pip; print(pip.__version__)', target], { encoding: 'utf8' }).trim();
    assert.equal(version, '26.2.2');
    // Fresh embedded Python has no pip; the same path must bootstrap it.
    const fresh = path.join(dir, 'fresh');
    installPinnedPipWheel(python, wheel, fresh);
    assert.ok(fs.existsSync(path.join(fresh, 'pip', '__init__.py')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hashString returns a stable SHA-256 for resource manifest inputs', () => {
  assert.equal(
    hashString('meeting-transcriber resource manifest\n'),
    'b135831e52b8ba2ecf6c995ec081334a59cd4e8218616cf7331b036b97532b38',
  );
});


test('buildDirectoryManifest captures file paths and content hashes', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-resource-manifest-'));
  const rootDir = path.join(tempDir, 'AudioCaptureHelper');
  const sourcesDir = path.join(rootDir, 'Sources');
  const nestedDir = path.join(sourcesDir, 'Nested');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, 'main.swift'), 'print("hello")\n', 'utf8');
  fs.writeFileSync(path.join(nestedDir, 'helper.swift'), 'struct Helper {}\n', 'utf8');

  const manifest = buildDirectoryManifest(sourcesDir, rootDir);

  assert.deepEqual(manifest.map((entry) => entry.path), [
    'Sources/Nested/helper.swift',
    'Sources/main.swift',
  ]);
  assert.equal(manifest[0].sha256.length, 64);
  assert.equal(manifest[1].sha256.length, 64);

  fs.rmSync(tempDir, { recursive: true, force: true });
});


test('manifestsMatch detects Swift source changes through the resource manifest', () => {
  const originalManifest = buildResourceManifest();
  const updatedManifest = structuredClone(originalManifest);

  assert.equal(typeof originalManifest.inputs.swiftInfoPlist, 'string');
  assert.equal(originalManifest.inputs.swiftInfoPlist.length, 64);
  assert.equal(manifestsMatch(originalManifest, updatedManifest), true);

  updatedManifest.inputs.swiftSources = [
    ...updatedManifest.inputs.swiftSources,
    { path: 'Sources/new-file.swift', sha256: 'deadbeef' },
  ];

  assert.equal(manifestsMatch(originalManifest, updatedManifest), false);

  const updatedInfoPlistManifest = structuredClone(originalManifest);
  updatedInfoPlistManifest.inputs.swiftInfoPlist = 'changed';
  assert.equal(manifestsMatch(originalManifest, updatedInfoPlistManifest), false);
});


test('buildResourceManifest tracks pinned packaged dependency requirements', () => {
  const manifest = buildResourceManifest();

  assert.equal(manifest.version, 9);
  assert.equal(typeof manifest.inputs.requirementsMacosBuild, 'string');
  assert.equal(typeof manifest.inputs.requirementsWindowsBuild, 'string');
  assert.equal(typeof manifest.inputs.requirementsLinuxBuild, 'string');
  assert.equal(manifest.inputs.requirementsMacosBuild.length, 64);
  assert.equal(manifest.inputs.requirementsWindowsBuild.length, 64);
  assert.equal(manifest.inputs.requirementsLinuxBuild.length, 64);
});


test('macOS packaged Python keeps pip for optional diarization setup', () => {
  const removablePackages = getMacOSPythonRuntimeRemovablePackages();

  assert.equal(removablePackages.includes('pip'), false);
  assert.ok(removablePackages.includes('setuptools'));
  assert.ok(removablePackages.includes('torch'));
  assert.ok(removablePackages.includes('Jinja2'));
  assert.ok(removablePackages.includes('MarkupSafe'));
});


test('macOS packaged Python resolves dependencies from macOS 14 arm64 wheels', () => {
  const commands = buildMacOSPythonWheelhouseCommands(
    '/repo/requirements-macos-build.txt',
    '/tmp/avanevis-macos-wheels',
  );

  assert.deepEqual(commands.download, [
    '-m', 'pip', 'download', '--only-binary=:all:',
    '--platform', 'macosx_14_0_arm64',
    '--implementation', 'cp',
    '--python-version', '3.11',
    '--abi', 'cp311',
    '--dest', '/tmp/avanevis-macos-wheels',
    '-r', '/repo/requirements-macos-build.txt',
  ]);
  assert.deepEqual(commands.install, [
    '-m', 'pip', 'install', '--only-binary=:all:',
    '--no-index', '--find-links', '/tmp/avanevis-macos-wheels',
    '-r', '/repo/requirements-macos-build.txt',
  ]);
});


test('Windows embedded Python path config enables pip and backend imports', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-python-pth-'));
  const pthFile = path.join(tempDir, 'python311._pth');
  fs.writeFileSync(pthFile, 'python311.zip\n.\n#import site\n', 'utf8');

  ensureWindowsEmbeddedPythonPathConfig(pthFile);

  const lines = fs.readFileSync(pthFile, 'utf8').trim().split(/\r?\n/);
  assert.ok(lines.includes('../backend'));
  assert.ok(lines.includes('./Lib/site-packages'));
  assert.ok(lines.includes('python311.zip'));
  assert.ok(lines.includes('.'));
  assert.equal(lines.at(-1), 'import site');
  assert.equal(lines.filter((line) => line === 'import site').length, 1);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Windows Astral standalone Python path config creates python311._pth from scratch with Lib and DLLs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-python-astral-pth-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'Lib'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'DLLs'), { recursive: true });
    const pthFile = path.join(tempDir, 'python311._pth');

    ensureWindowsEmbeddedPythonPathConfig(pthFile);

    const lines = fs.readFileSync(pthFile, 'utf8').trim().split(/\r?\n/);
    assert.ok(lines.includes('../backend'));
    assert.ok(lines.includes('./Lib/site-packages'));
    assert.ok(lines.includes('./Lib'));
    assert.ok(lines.includes('./DLLs'));
    assert.ok(lines.includes('.'));
    assert.equal(lines.includes('python311.zip'), false);
    assert.equal(lines.at(-1), 'import site');
    assert.equal(lines.filter((line) => line === 'import site').length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('validateTarArchiveEntries allows safe relative members and rejects path traversal or absolute paths', () => {
  assert.doesNotThrow(() => validateTarArchiveEntries([
    'python/python.exe',
    'python/Lib/os.py',
    'python/DLLs/_ctypes.pyd',
  ]));

  for (const unsafeEntry of ['/etc/passwd', '../escape', 'python/../../evil.dll', 'C:\\Windows\\system32\\evil.dll', 'bad\0entry']) {
    assert.throws(() => validateTarArchiveEntries([unsafeEntry]), /Refusing/);
  }
});


test('stale resource invalidation includes bin directory on every platform', () => {
  const staleDirs = getStaleResourceDirectories().map((dirPath) => path.basename(dirPath));

  assert.deepEqual(staleDirs, ['python', 'ffmpeg', 'bin']);
});


test('ensureWindowsEmptyBinDirectory is exported for packaging source stability', () => {
  assert.equal(typeof ensureWindowsEmptyBinDirectory, 'function');
});


test('pruneMacOSPythonRuntimeDevelopmentFiles is exported for macOS packaging cleanup', () => {
  assert.equal(typeof pruneMacOSPythonRuntimeDevelopmentFiles, 'function');
});


test('macOS bundled Mach-O signing paths match extraResources destinations', () => {
  assert.deepEqual(packageJson.build.mac.binaries, [
    'Contents/Resources/bin/audiocapture-helper',
    'Contents/Resources/bin/speakrs-cli',
    'Contents/Resources/ffmpeg/ffmpeg',
  ]);
  assert.equal(packageJson.build.mac.identity, '-');
  assert.equal(packageJson.build.mac.notarize, false);
});


test('macOS helper verification checks signature and entitlements', () => {
  const commands = buildMacOSHelperVerificationCommands('/Applications/AvaNevis.app/Contents/Resources/bin/audiocapture-helper');

  assert.deepEqual(commands, [
    {
      command: 'codesign',
      args: [
        '--verify',
        '--strict',
        '--verbose=2',
        '/Applications/AvaNevis.app/Contents/Resources/bin/audiocapture-helper',
      ],
    },
    {
      command: 'codesign',
      args: [
        '-d',
        '--entitlements',
        ':-',
        '/Applications/AvaNevis.app/Contents/Resources/bin/audiocapture-helper',
      ],
    },
  ]);
});


test('macOS helper entitlement parser requires inherit entitlement', () => {
  assert.equal(
    macOSHelperEntitlementsIncludeInherit('<key>com.apple.security.inherit</key><true/>'),
    true,
  );
  assert.equal(
    macOSHelperEntitlementsIncludeInherit('<key>com.apple.security.inherit</key><true/><key>com.apple.security.device.audio-input</key><true/>'),
    true,
  );
  assert.equal(
    macOSHelperEntitlementsIncludeInherit('<key>com.apple.security.inherit</key><false/>'),
    false,
  );
  assert.equal(
    macOSHelperEntitlementsIncludeInherit('<key>com.apple.security.cs.disable-library-validation</key><true/>'),
    false,
  );
});


test('resource manifest tracks the vendored Speakrs dependency patch', () => {
  const manifest = buildResourceManifest();
  assert.ok(manifest.inputs.speakrsVendor.some((entry) => entry.path === 'vendor/ndarray-npy/src/npz.rs'));
  const changed = structuredClone(manifest);
  changed.inputs.speakrsVendor[0].sha256 = 'changed';
  assert.equal(manifestsMatch(manifest, changed), false);
});

test('production Python archive extraction enforces paths and link targets', () => {
  const { execFileSync } = require('node:child_process');
  const { command: python, args } = resolveArchiveExtractorPython();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-tar-'));
  try {
    const create = [
      'import io, sys, tarfile',
      'archive, name, kind, link, with_symlink = sys.argv[1:]',
      'with tarfile.open(archive, "w:gz") as t:',
      '    data = b"safe"',
      '    target = tarfile.TarInfo("python/target")',
      '    target.size = len(data)',
      '    t.addfile(target, io.BytesIO(data))',
      '    member = tarfile.TarInfo(name)',
      '    member.type = {"file": tarfile.REGTYPE, "hard": tarfile.LNKTYPE, "sym": tarfile.SYMTYPE}[kind]',
      '    member.linkname = link',
      '    t.addfile(member)',
      '    if with_symlink == "yes":',
      '        member = tarfile.TarInfo("python/symlink")',
      '        member.type = tarfile.SYMTYPE',
      '        member.linkname = "target"',
      '        t.addfile(member)',
    ].join('\n');
    const make = (name, kind, link, symlink = 'no') => {
      const archive = path.join(dir, `${Math.random()}.tar.gz`);
      execFileSync(python, [...args, '-c', create, archive, name, kind, link, symlink]);
      return archive;
    };
    const out = path.join(dir, 'good');
    extractTarGz(make('python/hardlink', 'hard', 'python/target', process.platform === 'win32' ? 'no' : 'yes'), out);
    assert.equal(fs.readFileSync(path.join(out, 'python/hardlink'), 'utf8'), 'safe');
    if (process.platform !== 'win32') assert.equal(fs.readFileSync(path.join(out, 'python/symlink'), 'utf8'), 'safe');
    for (const [name, kind, link] of [
      ['/absolute', 'file', ''], ['../escape', 'file', ''], ['C:/escape', 'file', ''],
      ['python/link', 'sym', '../../escape'], ['python/link', 'hard', '../escape'],
    ]) {
      assert.throws(() => extractTarGz(make(name, kind, link), path.join(dir, `bad-${Math.random()}`)));
    }
    const manifest = buildResourceManifest();
    assert.ok(manifest.inputs.pythonArchiveExtractor);
    const changed = structuredClone(manifest);
    changed.inputs.pythonArchiveExtractor = 'changed';
    assert.equal(manifestsMatch(manifest, changed), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveArchiveExtractorPython probes Windows candidates in order and skips interpreters without tarfile.data_filter', () => {
  const probed = [];
  const resolved = resolveArchiveExtractorPython({
    platform: 'win32',
    repoRoot: '/repo',
    existsSync: () => false,
    spawnSync(command, args) {
      probed.push([command, args]);
      if (command === 'python') {
        return { status: 0 };
      }
      throw new Error(`Unexpected fallback probe: ${command}`);
    },
  });
  assert.deepEqual(resolved, { command: 'python', args: [] });
  assert.equal(probed.length, 1);

  const fallbackProbed = [];
  const fallbackResolved = resolveArchiveExtractorPython({
    platform: 'win32',
    repoRoot: '/repo',
    existsSync: () => false,
    spawnSync(command, args) {
      fallbackProbed.push([command, args[0] === '-c' ? [] : [args[0]]]);
      if (command === 'python') {
        return { status: 1 };
      }
      if (command === 'py' && args[0] === '-3.11') {
        return { error: new Error('ENOENT'), status: null };
      }
      if (command === 'py' && args[0] === '-3') {
        return { status: 0 };
      }
      return { status: 1 };
    },
  });
  assert.deepEqual(fallbackResolved, { command: 'py', args: ['-3'] });
  assert.deepEqual(fallbackProbed, [
    ['python', []],
    ['py', ['-3.11']],
    ['py', ['-3']],
  ]);

  assert.throws(
    () => resolveArchiveExtractorPython({
      platform: 'win32',
      repoRoot: '/repo',
      existsSync: () => false,
      spawnSync: () => ({ status: 1 }),
    }),
    /tarfile\.data_filter/,
  );
});
