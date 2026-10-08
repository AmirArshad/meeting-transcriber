const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  bootstrapInventory,
  loadInventories,
  nativeInventory,
  normalizePackageName,
  parakeetLockInventory,
  parseExactRequirement,
  pyannoteInventories,
  toRequirements,
} = require('../../scripts/extract-dependency-inventory');
const { BUILD_DOWNLOADS } = require('../../build/download-manifest');

const VULNERABLE_FIXTURE = path.join(__dirname, '..', 'fixtures', 'dependency-inventory', 'vulnerable-parakeet.lock.json');

function wheel(packageName, version, fileName) {
  return { packageName, version, fileName };
}

test('every shipped catalog yields a non-empty, exactly pinned inventory', () => {
  const inventories = loadInventories();
  assert.deepEqual(inventories.map((inventory) => inventory.id), [
    'parakeet-linux-cuda',
    'parakeet-macos-metal',
    'parakeet-windows-cuda',
    'pyannote-win32-x64',
    'pyannote-darwin-arm64',
    'bootstrap',
    'native',
  ]);
  for (const inventory of inventories) {
    assert.ok(inventory.entries.length > 0, inventory.id);
    if (inventory.kind === 'native-runtime') continue;
    for (const line of toRequirements(inventory).trimEnd().split('\n')) {
      assert.match(line, /^[a-z0-9-]+==\d[^+\s]*$/, `${inventory.id}: ${line}`);
    }
  }
  const macLock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'build', 'parakeet', 'macos-metal.lock.json'), 'utf8'));
  assert.equal(inventories.find((inventory) => inventory.id === 'parakeet-macos-metal').entries.length, macLock.wheels.length);
});

test('audit output normalizes aliases and strips local version labels', () => {
  assert.equal(normalizePackageName('pyannote.audio'), 'pyannote-audio');
  assert.equal(normalizePackageName('Annotated__Doc'), 'annotated-doc');
  assert.equal(normalizePackageName('PyYAML'), 'pyyaml');

  const [windows] = pyannoteInventories({
    'win32-x64': { id: 'fixture', pip: { requirements: ['pyannote.audio==4.0.7', 'torch==2.13.0+cu126'] } },
  });
  assert.equal(toRequirements(windows), 'pyannote-audio==4.0.7\ntorch==2.13.0\n');
  assert.equal(windows.entries.find((entry) => entry.name === 'torch').version, '2.13.0+cu126');

  const lock = parakeetLockInventory({ wheels: [wheel('Annotated_Doc', '0.0.5', 'annotated_doc-0.0.5-py3-none-any.whl')] }, 'fixture');
  assert.equal(toRequirements(lock), 'annotated-doc==0.0.5\n');

  assert.equal(toRequirements(bootstrapInventory(BUILD_DOWNLOADS)), 'pip==26.2.1\n');
});

test('the intentionally vulnerable fixture reaches the audit with its vulnerable pins intact', () => {
  const inventory = parakeetLockInventory(JSON.parse(fs.readFileSync(VULNERABLE_FIXTURE, 'utf8')), 'fixture');
  assert.equal(toRequirements(inventory), 'annotated-doc==0.0.5\nmsgpack==1.2.0\nurllib3==2.5.0\n');
});

test('unparseable or ambiguous catalog entries fail instead of shrinking the audit', () => {
  assert.throws(() => parakeetLockInventory({ wheels: [] }, 'empty'), /inventory is empty/);
  assert.throws(() => parakeetLockInventory({}, 'missing'), /no wheels array/);
  assert.throws(
    () => parakeetLockInventory({ wheels: [wheel('urllib3', '2.8.0', 'urllib3-2.7.0-py3-none-any.whl')] }, 'mismatch'),
    /does not match urllib3==2\.8\.0/,
  );
  assert.throws(() => parakeetLockInventory({ wheels: [wheel('urllib3', '2.8.0', 'urllib3-2.8.0.tar.gz')] }, 'sdist'), /unparseable wheel/);
  assert.throws(
    () => parakeetLockInventory({
      wheels: [
        wheel('msgpack', '1.2.3', 'msgpack-1.2.3-py3-none-any.whl'),
        wheel('msgpack', '1.2.0', 'msgpack-1.2.0-py3-none-any.whl'),
      ],
    }, 'conflict'),
    /listed at both/,
  );
  assert.throws(() => parseExactRequirement('torch>=2.13', 'loose'), /not an exact pin/);
  assert.throws(() => parseExactRequirement('torch==2.13.*', 'wildcard'), /exact version/);
  assert.throws(() => pyannoteInventories({ 'win32-x64': { id: 'x', pip: {} } }), /no pip requirements/);
});

test('native runtimes are inventoried for review, never passed to the PyPI audit, and FFmpeg binaries must match the source bundle', () => {
  const native = nativeInventory(BUILD_DOWNLOADS);
  assert.deepEqual(native.entries.map((entry) => `${entry.source}=${entry.name}@${entry.version}`), [
    'pythonWin=cpython@3.11.9',
    'pythonMac=cpython@3.11.17',
    'pythonLinux=cpython@3.11.17',
    'ffmpegWin=ffmpeg@8.0.1',
    'ffmpegMac=ffmpeg@8.0.1',
    'ffmpegLinux=ffmpeg@8.0.1',
  ]);
  assert.throws(() => toRequirements(native), /no PyPI advisory coverage/);

  const skewed = {
    ...BUILD_DOWNLOADS,
    ffmpegMac: { ...BUILD_DOWNLOADS.ffmpegMac, url: 'https://github.com/shaka-project/static-ffmpeg-binaries/releases/download/n8.0.3-1/ffmpeg-osx-arm64' },
  };
  assert.throws(() => nativeInventory(skewed), /ffmpegMac: binary FFmpeg 8\.0\.3 does not match the bundled corresponding source 8\.0\.1/);
  assert.throws(() => nativeInventory({ ...BUILD_DOWNLOADS, pythonMac: { url: 'https://example.invalid/python.tgz' } }), /pythonMac: cannot read a version/);
});
