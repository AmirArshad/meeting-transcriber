'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const catalog = require('../../src/main/transcription-engine-catalog');
const {
  assertDependencyClosure,
  buildWheelEntry,
  environmentForLock,
  licenseFromMetadata,
  parseWheelFileName,
  replaceWheel,
  selectReleaseFile,
  updateLockWheel,
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
  const withRequires = replaceWheel(lock, { ...current, requiresDist: ['llvmlite>=0.50'] });
  assert.equal(Object.hasOwn(withRequires.wheels.find((wheel) => wheel.packageName === 'msgpack'), 'requiresDist'), false);
});

test('explicit file names still have to match the lock interpreter and platform', () => {
  const files = [
    { packagetype: 'bdist_wheel', filename: 'msgpack-1.2.3-cp312-cp312-macosx_11_0_arm64.whl' },
    { packagetype: 'bdist_wheel', filename: 'msgpack-1.2.3-cp311-cp311-macosx_14_0_arm64.whl' },
  ];
  const target = { python: '3.11', platform: 'darwin', arch: 'arm64' };
  const current = 'msgpack-1.1.2-cp311-cp311-macosx_11_0_arm64.whl';
  assert.throws(() => selectReleaseFile(files, current, '1.2.3', files[0].filename, target), /CPython 3\.11/);
  assert.equal(selectReleaseFile(files, current, '1.2.3', files[1].filename, target).filename, files[1].filename);
  assert.throws(() => selectReleaseFile(files, current, '1.2.3', files[1].filename), /lock target/);
});

test('dependency closure rejects unsatisfied and reverse requirements', () => {
  const environment = environmentForLock({ python: '3.11', platform: 'darwin', arch: 'arm64' });
  const broken = [
    { name: 'numba', version: '0.68.0', requiresDist: ['llvmlite (>=0.50.0dev0,<0.51)'] },
    { name: 'llvmlite', version: '0.49.0', requiresDist: [] },
  ];
  assert.throws(() => assertDependencyClosure({ packages: broken, environment, focusName: 'numba' }), /llvmlite 0\.49\.0/);
  const satisfied = [
    { name: 'numba', version: '0.68.0', requiresDist: [
      'llvmlite (>=0.50.0dev0,<0.51)',
      'missing ; extra == "dev"',
      'missing ; python_version < "3.11"',
      'missing ; sys_platform == "win32"',
      'llvmlite >=0.50 ; python_version >= "3.11"',
    ] },
    { name: 'llvmlite', version: '0.50.0', requiresDist: [] },
  ];
  assert.doesNotThrow(() => assertDependencyClosure({ packages: satisfied, environment, focusName: 'numba' }));
  assert.throws(() => assertDependencyClosure({
    packages: [
      { name: 'numba', version: '0.68.0', requiresDist: ['llvmlite (>=0.50.0dev0,<0.51)'] },
      { name: 'llvmlite', version: '0.49.0', requiresDist: [] },
    ],
    environment,
    focusName: 'llvmlite',
  }), /llvmlite 0\.49\.0/);
  assert.throws(() => assertDependencyClosure({
    packages: [{ name: 'demo', version: '2.0.0', requiresDist: [] }, { name: 'other', version: '1.0.0', requiresDist: ['demo ~=1.0'] }],
    environment,
    focusName: 'demo',
  }), /demo ~=1\.0/);
});

test('wheel update rejects a broken closure and a foreign ABI before writing', async () => {
  const lock = {
    python: '3.11',
    platform: 'darwin',
    arch: 'arm64',
    adapterId: 'parakeet-mlx-metal-v1',
    model: { revision: 'rev' },
    vad: null,
    wheels: [
      {
        packageName: 'numba',
        version: '0.67.0',
        fileName: 'numba-0.67.0-cp311-cp311-macosx_12_0_arm64.whl',
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
        url: 'https://files.pythonhosted.org/packages/aa/old.whl',
        license: 'BSD',
        extractedFiles: [{ path: 'x', sizeBytes: 1, sha256: 'b'.repeat(64) }],
      },
      {
        packageName: 'llvmlite',
        version: '0.49.0',
        fileName: 'llvmlite-0.49.0-cp311-cp311-macosx_12_0_arm64.whl',
        sha256: 'c'.repeat(64),
        sizeBytes: 1,
        url: 'https://files.pythonhosted.org/packages/aa/ll.whl',
        license: 'BSD',
        extractedFiles: [{ path: 'y', sizeBytes: 1, sha256: 'd'.repeat(64) }],
      },
    ],
  };
  const buffer = wheelBuffer({
    'numba-0.68.0.dist-info/METADATA': 'Metadata-Version: 2.1\nName: numba\nVersion: 0.68.0\nLicense: BSD\nRequires-Dist: llvmlite (>=0.50.0dev0,<0.51)\n\n',
  });
  await assert.rejects(
    () => updateLockWheel(lock, {
      packageName: 'numba',
      version: '0.68.0',
      fetchJson: async (url) => {
        if (url.includes('/numba/0.68.0/')) {
          return {
            vulnerabilities: [],
            urls: [{
              packagetype: 'bdist_wheel',
              filename: 'numba-0.68.0-cp311-cp311-macosx_12_0_arm64.whl',
              url: 'https://files.pythonhosted.org/packages/aa/numba.whl',
              digests: { sha256: sha256(buffer) },
              size: buffer.length,
            }],
          };
        }
        if (url.includes('/llvmlite/0.49.0/')) return { info: { requires_dist: [] } };
        throw new Error(`unexpected ${url}`);
      },
      fetchBuffer: async () => buffer,
    }),
    /llvmlite 0\.49\.0/,
  );
  await assert.rejects(
    () => updateLockWheel(lock, {
      packageName: 'numba',
      version: '0.68.0',
      fileName: 'numba-0.68.0-cp312-cp312-macosx_12_0_arm64.whl',
      fetchJson: async () => ({
        vulnerabilities: [],
        urls: [{
          packagetype: 'bdist_wheel',
          filename: 'numba-0.68.0-cp312-cp312-macosx_12_0_arm64.whl',
          url: 'https://files.pythonhosted.org/packages/aa/numba.whl',
          digests: { sha256: 'aa' },
          size: 1,
        }],
      }),
      fetchBuffer: async () => {
        throw new Error('should not download');
      },
    }),
    /CPython 3\.11/,
  );
});
