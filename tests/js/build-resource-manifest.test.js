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
  buildResourceManifest,
  ensureWindowsEmbeddedPythonPathConfig,
  ensureWindowsEmptyBinDirectory,
  getMacOSPythonRuntimeRemovablePackages,
  getStaleResourceDirectories,
  macOSHelperEntitlementsIncludeInherit,
  manifestsMatch,
  pruneMacOSPythonRuntimeDevelopmentFiles,
} = require('../../build/prepare-resources');


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

  assert.equal(manifest.version, 4);
  assert.equal(typeof manifest.inputs.requirementsMacosBuild, 'string');
  assert.equal(typeof manifest.inputs.requirementsWindowsBuild, 'string');
  assert.equal(manifest.inputs.requirementsMacosBuild.length, 64);
  assert.equal(manifest.inputs.requirementsWindowsBuild.length, 64);
});


test('macOS packaged Python keeps pip for optional diarization setup', () => {
  const removablePackages = getMacOSPythonRuntimeRemovablePackages();

  assert.equal(removablePackages.includes('pip'), false);
  assert.ok(removablePackages.includes('setuptools'));
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


test('macOS helper signing path matches extraResources destination', () => {
  assert.deepEqual(packageJson.build.mac.binaries, [
    'Contents/Resources/bin/audiocapture-helper',
  ]);
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
