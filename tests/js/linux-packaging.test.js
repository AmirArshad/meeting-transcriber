'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const packageJson = require('../../package.json');
const {
  assertAppImageUsesStaticRuntime,
  assertLinuxPackagedLayout,
  assertNotForbiddenPackagedPath,
  assertPacmanPkginfo,
  findLinuxArtifact,
  findLinuxResourcesRoot,
  getJustifiedPacmanDepends,
  parsePkginfo,
  verifyPacmanArchivePayload,
} = require('../../scripts/verify-linux-packaging');

const ROOT = path.join(__dirname, '..', '..');
const CI_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const RELEASE_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-release.yml'), 'utf8');
const PREPARE_RESOURCES_SOURCE = fs.readFileSync(path.join(ROOT, 'build', 'prepare-resources.js'), 'utf8');

function writeFile(filePath, contents = 'ok') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function makeLinuxResourcesFixture(root) {
  writeFile(path.join(root, 'python', 'bin', 'python3'), '#!/bin/sh\n');
  writeFile(path.join(root, 'ffmpeg', 'ffmpeg'), '#!/bin/sh\n');
  writeFile(path.join(root, 'backend', 'audio', 'linux_recorder.py'), 'pass\n');
  writeFile(path.join(root, 'backend', 'transcription', 'faster_whisper_transcriber.py'), 'pass\n');
  writeFile(path.join(root, 'legal', 'THIRD_PARTY_NOTICES.md'), 'notices\n');
  writeFile(path.join(root, 'requirements-linux.txt'), 'pulsectl==24.12.0\n');
  writeFile(path.join(root, 'requirements-linux-build.txt'), 'pulsectl==24.12.0\n');
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(root, 'python', 'bin', 'python3'), 0o755);
    fs.chmodSync(path.join(root, 'ffmpeg', 'ffmpeg'), 0o755);
  }
  return root;
}

test('electron-builder stays on 26.x and opts into the static FUSE-less AppImage toolset', () => {
  assert.match(packageJson.devDependencies['electron-builder'], /^\^26\./);
  assert.equal(packageJson.build.toolsets.appimage, '1.0.2');
  assert.notEqual(packageJson.build.toolsets.appimage, '0.0.0');
  assert.equal(packageJson.build.toolsets.appimage === '1.0.3', false);
});

test('Linux package targets are x86_64 AppImage and pacman with AvaNevis-Setup artifact names', () => {
  const linuxTargets = packageJson.build.linux.target;
  assert.ok(Array.isArray(linuxTargets));
  assert.deepEqual(
    linuxTargets.map((target) => [target.target, target.arch]),
    [
      ['AppImage', ['x64']],
      ['pacman', ['x64']],
    ],
  );
  assert.equal(packageJson.build.artifactName, '${productName}-Setup-${version}.${ext}');
  assert.equal(
    packageJson.build.pacman.artifactName,
    '${productName}-Setup-${version}.pkg.tar.zst',
  );
  assert.equal(packageJson.build.linux.target.some((target) => target.target === 'deb'), false);
  assert.equal(packageJson.build.linux.target.some((target) => target.target === 'rpm'), false);
  assert.equal(packageJson.build.linux.executableName, 'avanevis');
  assert.equal(packageJson.desktopName, 'avanevis');
  assert.equal(packageJson.build.linux.syncDesktopName, true);
});

test('pacman depends are an explicit justified list and omit libappindicator and ffmpeg', () => {
  const depends = getJustifiedPacmanDepends(packageJson);
  assert.deepEqual(depends, [
    'alsa-lib',
    'at-spi2-core',
    'dbus',
    'gtk3',
    'libnotify',
    'libpulse',
    'libsecret',
    'libxss',
    'libxtst',
    'nss',
    'xdg-utils',
  ]);
  assert.equal(depends.some((name) => /appindicator/i.test(name)), false);
  assert.equal(depends.includes('ffmpeg'), false);
  assert.equal(depends.includes('c-ares'), false);
});

test('Linux extraResources keep runtime/legal assets and add requirements without Speakrs/ORT/llama', () => {
  const globalResources = packageJson.build.extraResources;
  assert.ok(globalResources.some((entry) => entry.from === 'build/resources/python' && entry.to === 'python'));
  assert.ok(globalResources.some((entry) => entry.from === 'build/resources/ffmpeg' && entry.to === 'ffmpeg'));
  assert.ok(globalResources.some((entry) => entry.from === 'backend' && entry.to === 'backend'));
  assert.ok(globalResources.some((entry) => entry.from === 'build/resources/legal' && entry.to === 'legal'));
  assert.ok(globalResources.some((entry) => entry.from === 'build/resources/bin' && entry.to === 'bin'));

  const linuxResources = packageJson.build.linux.extraResources || [];
  assert.ok(linuxResources.some((entry) => entry.from === 'requirements-linux.txt' && entry.to === 'requirements-linux.txt'));
  assert.ok(linuxResources.some((entry) => entry.from === 'requirements-linux-build.txt' && entry.to === 'requirements-linux-build.txt'));
  assert.equal(
    linuxResources.some((entry) => /speakrs|onnxruntime|llama/i.test(JSON.stringify(entry))),
    false,
  );
});

test('Linux npm scripts build on Linux hosts and verify packaged layout', () => {
  assert.match(packageJson.scripts['build:linux'], /electron-builder build --linux/);
  assert.match(packageJson.scripts['build:linux:dir'], /--linux dir/);
  assert.equal(packageJson.scripts['verify:linux:packaged'], 'node scripts/verify-linux-packaging.js');
});

test('assertLinuxPackagedLayout requires bundled Python, ffmpeg, backend, and legal notices', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-layout-'));
  try {
    assert.throws(() => assertLinuxPackagedLayout(path.join(tempDir, 'missing')), /resources root is missing/);
    const resourcesRoot = path.join(tempDir, 'resources');
    makeLinuxResourcesFixture(resourcesRoot);
    const layout = assertLinuxPackagedLayout(resourcesRoot);
    assert.equal(layout.pythonPath, path.join(resourcesRoot, 'python', 'bin', 'python3'));
    assert.equal(layout.ffmpegPath, path.join(resourcesRoot, 'ffmpeg', 'ffmpeg'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assertLinuxPackagedLayout rejects deferred Linux add-on binaries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-forbidden-'));
  try {
    const resourcesRoot = path.join(tempDir, 'resources');
    makeLinuxResourcesFixture(resourcesRoot);
    writeFile(path.join(resourcesRoot, 'bin', 'speakrs-cli'), 'elf');
    assert.throws(() => assertLinuxPackagedLayout(resourcesRoot), /deferred add-on/);
    fs.rmSync(path.join(resourcesRoot, 'bin', 'speakrs-cli'));
    writeFile(path.join(resourcesRoot, 'bin', 'llama-cli'), 'elf');
    assert.throws(() => assertLinuxPackagedLayout(resourcesRoot), /deferred add-on/);
    fs.rmSync(path.join(resourcesRoot, 'bin', 'llama-cli'));
    writeFile(path.join(resourcesRoot, 'python', 'lib', 'onnxruntime-linux-x64-gpu_cuda12.so'), 'so');
    assert.throws(() => assertLinuxPackagedLayout(resourcesRoot), /deferred add-on/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assertNotForbiddenPackagedPath allows CPU onnxruntime site-packages and rejects Speakrs CUDA ORT', () => {
  assert.doesNotThrow(() => assertNotForbiddenPackagedPath('python/lib/python3.11/site-packages/onnxruntime/capi/onnxruntime_pybind11_state.so'));
  assert.throws(
    () => assertNotForbiddenPackagedPath('python/onnxruntime-linux-x64-gpu_cuda12-1.27.1.tgz'),
    /deferred add-on/,
  );
  assert.throws(() => assertNotForbiddenPackagedPath('bin/audiocapture-helper'), /deferred add-on/);
});

test('assertAppImageUsesStaticRuntime rejects malformed ELF and runtimes that still require libfuse.so.2', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-appimage-runtime-'));
  try {
    const fuse2 = path.join(tempDir, 'fuse2.AppImage');
    const payload = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.from('padding'),
      Buffer.from('dlopen(): error loading libfuse.so.2\nAppImages require FUSE to run.\n'),
    ]);
    fs.writeFileSync(fuse2, payload);
    assert.throws(() => assertAppImageUsesStaticRuntime(fuse2), /legacy FUSE2/);

    const malformed = path.join(tempDir, 'malformed.AppImage');
    fs.writeFileSync(malformed, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00]));
    assert.throws(() => assertAppImageUsesStaticRuntime(malformed), /valid ELF|static PIE/);

    const staticRuntime = path.join(tempDir, 'static.AppImage');
    fs.writeFileSync(staticRuntime, Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
      Buffer.from('static appimage runtime without host FUSE2'),
    ]));
    assert.equal(assertAppImageUsesStaticRuntime(staticRuntime, {
      spawnSyncFn: () => ({
        status: 0,
        stdout: 'ELF 64-bit LSB pie executable, x86-64, static-pie linked',
        stderr: '',
      }),
    }), staticRuntime);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('proveAppImageRuntimeLaunchesWithoutFuse rejects arbitrary runtime launch failures', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-appimage-launch-'));
  try {
    const appImage = path.join(tempDir, 'AvaNevis-Setup-2.7.0.AppImage');
    fs.writeFileSync(appImage, Buffer.alloc(4096));
    assert.throws(
      () => require('../../scripts/verify-linux-packaging').proveAppImageRuntimeLaunchesWithoutFuse(
        appImage,
        {
          assertStaticRuntimeFn: () => appImage,
          spawnSyncFn: () => ({ status: 127, stdout: '', stderr: 'broken runtime' }),
        },
      ),
      /runtime launch failed.*broken runtime/i,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('assertPacmanPkginfo accepts the justified depend list and rejects libappindicator or ffmpeg', () => {
  const depends = getJustifiedPacmanDepends(packageJson);
  const pkginfo = [
    'pkgname = avanevis',
    `pkgver = ${packageJson.version}`,
    'arch = x86_64',
    ...depends.map((name) => `depend = ${name}`),
    '',
  ].join('\n');
  assert.deepEqual(assertPacmanPkginfo(pkginfo, packageJson), depends);
  // electron-builder writes Arch pkgver as version-pkgrel (2.7.0-1).
  const pkginfoWithRel = pkginfo.replace(
    `pkgver = ${packageJson.version}`,
    `pkgver = ${packageJson.version}-1`,
  );
  assert.deepEqual(assertPacmanPkginfo(pkginfoWithRel, packageJson), depends);

  assert.throws(
    () => assertPacmanPkginfo(`${pkginfo}depend = libappindicator-gtk3\n`, packageJson),
    /unjustified depends/,
  );
  assert.throws(
    () => assertPacmanPkginfo(`${pkginfo}depend = ffmpeg\n`, packageJson),
    /unjustified depends/,
  );
  assert.equal(parsePkginfo(pkginfo).fields.pkgname, 'avanevis');

  assert.throws(
    () => assertPacmanPkginfo(pkginfo.replace('pkgname = avanevis', 'pkgname = wrong'), packageJson),
    /pkgname.*wrong/i,
  );
  assert.throws(
    () => assertPacmanPkginfo(pkginfo.replace(`pkgver = ${packageJson.version}`, 'pkgver = 9.9.9'), packageJson),
    /pkgver.*9\.9\.9/i,
  );
  assert.throws(
    () => assertPacmanPkginfo(pkginfo.replace(`pkgver = ${packageJson.version}`, `pkgver = ${packageJson.version}-0`), packageJson),
    /pkgver/,
  );
  assert.throws(
    () => assertPacmanPkginfo(pkginfo.replace(`pkgver = ${packageJson.version}`, 'pkgver = 9.9.9-1'), packageJson),
    /pkgver.*9\.9\.9-1/i,
  );
});

test('verifyPacmanArchivePayload validates the actual archive resources and exclusions', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-pacman-payload-'));
  try {
    const packageRoot = path.join(tempDir, 'package-root');
    const resourcesRoot = path.join(packageRoot, 'opt', 'AvaNevis', 'resources');
    makeLinuxResourcesFixture(resourcesRoot);
    const depends = getJustifiedPacmanDepends(packageJson);
    writeFile(path.join(packageRoot, '.PKGINFO'), [
      'pkgname = avanevis',
      `pkgver = ${packageJson.version}-1`,
      'arch = x86_64',
      ...depends.map((name) => `depend = ${name}`),
      '',
    ].join('\n'));
    const archive = path.join(tempDir, 'AvaNevis-Setup-2.7.0.pkg.tar.zst');
    const create = spawnSync('tar', ['-cf', archive, '-C', packageRoot, '.'], { encoding: 'utf8' });
    assert.equal(create.status, 0, create.stderr);

    assert.doesNotThrow(() => verifyPacmanArchivePayload(archive, packageJson));

    fs.rmSync(path.join(resourcesRoot, 'ffmpeg', 'ffmpeg'));
    const brokenArchive = path.join(tempDir, 'AvaNevis-Setup-2.7.0-broken.pkg.tar.zst');
    const createBroken = spawnSync('tar', ['-cf', brokenArchive, '-C', packageRoot, '.'], { encoding: 'utf8' });
    assert.equal(createBroken.status, 0, createBroken.stderr);
    assert.throws(() => verifyPacmanArchivePayload(brokenArchive, packageJson), /Missing bundled ffmpeg/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('findLinuxResourcesRoot locates python-build-standalone under unpacked and /opt layouts', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-root-'));
  try {
    const unpacked = path.join(tempDir, 'linux-unpacked');
    makeLinuxResourcesFixture(path.join(unpacked, 'resources'));
    assert.equal(findLinuxResourcesRoot(unpacked), path.join(unpacked, 'resources'));

    const optRoot = path.join(tempDir, 'pkg');
    makeLinuxResourcesFixture(path.join(optRoot, 'opt', 'AvaNevis', 'resources'));
    assert.equal(
      findLinuxResourcesRoot(optRoot),
      path.join(optRoot, 'opt', 'AvaNevis', 'resources'),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('findLinuxArtifact only matches AvaNevis-Setup names', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-linux-artifact-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'source.tar.gz'), 'nope');
    fs.writeFileSync(path.join(tempDir, 'AvaNevis-2.7.0.AppImage'), 'nope');
    fs.writeFileSync(path.join(tempDir, 'AvaNevis-Setup-2.7.0.AppImage'), 'ok');
    assert.equal(
      findLinuxArtifact(tempDir, '.AppImage'),
      path.join(tempDir, 'AvaNevis-Setup-2.7.0.AppImage'),
    );
    assert.equal(findLinuxArtifact(tempDir, '.pkg.tar.zst'), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('prepare-resources still skips Speakrs on Linux and still creates a bin directory for extraResources', () => {
  assert.match(PREPARE_RESOURCES_SOURCE, /Skipping speakrs-cli packaging on this platform/);
  assert.match(PREPARE_RESOURCES_SOURCE, /ensureLinuxEmptyBinDirectory|IS_LINUX && !fs.existsSync\(BIN_DIR\)/);
});

test('Ubuntu CI job builds Linux packages on ubuntu-latest with SHA-pinned actions', () => {
  assert.match(CI_WORKFLOW, /runs-on:\s*ubuntu-latest/);
  assert.match(CI_WORKFLOW, /npm run test:all/);
  assert.match(CI_WORKFLOW, /build:linux|electron-builder build --linux/);
  assert.match(CI_WORKFLOW, /verify-linux-packaging\.js/);
  assert.match(CI_WORKFLOW, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(CI_WORKFLOW, /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/);
  assert.match(CI_WORKFLOW, /actions\/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1/);
  assert.doesNotMatch(CI_WORKFLOW, /libfuse2|fuse2/);
  assert.match(CI_WORKFLOW, /branches:.*release\/linux/);
});

test('release workflow builds and publishes both Linux Core Beta artifacts after Gate B', () => {
  assert.match(RELEASE_WORKFLOW, /os: Linux/);
  assert.match(RELEASE_WORKFLOW, /build:linux/);
  assert.match(RELEASE_WORKFLOW, /AvaNevis-Setup-\*\.AppImage/);
  assert.match(RELEASE_WORKFLOW, /AvaNevis-Setup-\*\.pkg\.tar\.zst/);
  assert.match(RELEASE_WORKFLOW, /verify-linux-packaging\.js/);
  assert.match(RELEASE_WORKFLOW, /os: Windows/);
  assert.match(RELEASE_WORKFLOW, /os: macOS/);
});
