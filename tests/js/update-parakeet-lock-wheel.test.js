'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const catalog = require('../../src/main/transcription-engine-catalog');
const {
  buildWheelEntry,
  licenseFromMetadata,
  parseWheelFileName,
  replaceWheel,
  selectReleaseFile,
} = require('../../scripts/update-parakeet-lock-wheel');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function wheelBuffer(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
}

const METADATA = 'Metadata-Version: 2.4\nName: demo\nVersion: 2.0.0\nLicense-Expression: MIT\nLicense: ignored\n\nLicense-Expression: body\n';

test('wheel entries hash real bytes and inventory every member in sorted order', () => {
  const buffer = wheelBuffer({
    'demo/z.py': 'z',
    'demo-2.0.0.dist-info/METADATA': METADATA,
    'demo/__init__.py': '',
  });
  const entry = buildWheelEntry({
    packageName: 'demo',
    version: '2.0.0',
    fileName: 'demo-2.0.0-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/aa/demo-2.0.0-py3-none-any.whl',
    buffer,
    expectedSha256: sha256(buffer),
    expectedSize: buffer.length,
  });
  assert.equal(entry.sha256, sha256(buffer));
  assert.equal(entry.sizeBytes, buffer.length);
  assert.equal(entry.license, 'MIT');
  assert.deepEqual(entry.extractedFiles.map((file) => file.path), ['demo-2.0.0.dist-info/METADATA', 'demo/__init__.py', 'demo/z.py']);
  assert.equal(entry.extractedFiles[1].sha256, sha256(Buffer.alloc(0)));
});

test('registry digest, size, host and unsafe members fail closed', () => {
  const buffer = wheelBuffer({ 'demo-2.0.0.dist-info/METADATA': METADATA });
  const base = {
    packageName: 'demo',
    version: '2.0.0',
    fileName: 'demo-2.0.0-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/packages/aa/demo.whl',
    buffer,
  };
  assert.throws(() => buildWheelEntry({ ...base, expectedSha256: 'a'.repeat(64) }), /SHA-256 mismatch/);
  assert.throws(() => buildWheelEntry({ ...base, expectedSize: buffer.length + 1 }), /Size mismatch/);
  assert.throws(() => buildWheelEntry({ ...base, url: 'https://example.com/demo.whl' }), /direct PyPI/);
  const traversal = wheelBuffer({ 'demo-2.0.0.dist-info/METADATA': METADATA });
  const zip = new AdmZip(traversal);
  zip.getEntries()[0].entryName = '../escape.py';
  assert.throws(() => buildWheelEntry({ ...base, buffer: zip.toBuffer() }), /Unsafe wheel member/);
});

test('license metadata keeps folded text and falls back from expression to License', () => {
  assert.equal(licenseFromMetadata('Name: x\nLicense: BSD\n        \n        Text\nSummary: s\n'), 'BSD\n        \n        Text');
  assert.equal(licenseFromMetadata('Name: x\nLicense: UNKNOWN\n'), '');
  assert.equal(licenseFromMetadata('Name: x\nLicense-Expression: Apache-2.0\n'), 'Apache-2.0');
});

test('release selection keeps the pinned interpreter, ABI and platform tags', () => {
  const files = [
    { packagetype: 'bdist_wheel', filename: 'msgpack-1.2.3-cp312-cp312-macosx_11_0_arm64.whl' },
    { packagetype: 'bdist_wheel', filename: 'msgpack-1.2.3-cp311-cp311-macosx_11_0_arm64.whl' },
    { packagetype: 'sdist', filename: 'msgpack-1.2.3.tar.gz' },
  ];
  const selected = selectReleaseFile(files, 'msgpack-1.1.2-cp311-cp311-macosx_11_0_arm64.whl', '1.2.3');
  assert.equal(selected.filename, 'msgpack-1.2.3-cp311-cp311-macosx_11_0_arm64.whl');
  assert.throws(() => selectReleaseFile(files, 'msgpack-1.1.2-cp311-cp311-macosx_12_0_arm64.whl', '1.2.3'), /No wheel matches/);
  assert.equal(parseWheelFileName('scikit_learn-1.7.2-cp311-cp311-macosx_12_0_arm64.whl').distribution, 'scikit_learn');
});

test('replacing a wheel recomputes the lock digest and keeps the integrity contract', () => {
  const lock = JSON.parse(JSON.stringify(catalog.loadLock(catalog.ADAPTERS.MACOS_METAL)));
  const current = lock.wheels.find((wheel) => wheel.packageName === 'msgpack');
  const changed = { ...current, sha256: 'f'.repeat(64), packageName: 'MsgPack' };
  const next = replaceWheel(lock, changed);
  assert.notEqual(next.lockDigest, lock.lockDigest);
  assert.equal(next.lockDigest, catalog.canonicalLockDigest(next));
  assert.equal(next.wheels.find((wheel) => wheel.sha256 === 'f'.repeat(64)).packageName, 'msgpack');
  assert.equal(catalog.assertParakeetLockIntegrity(next), next);
  assert.throws(() => replaceWheel(lock, { ...current, packageName: 'not-in-lock' }), /resolver change/);
});
