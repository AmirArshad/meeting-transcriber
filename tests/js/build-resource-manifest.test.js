const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { hashString } = require('../../build/download-manifest');
const {
  buildDirectoryManifest,
  buildResourceManifest,
  manifestsMatch,
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

  assert.equal(manifestsMatch(originalManifest, updatedManifest), true);

  updatedManifest.inputs.swiftSources = [
    ...updatedManifest.inputs.swiftSources,
    { path: 'Sources/new-file.swift', sha256: 'deadbeef' },
  ];

  assert.equal(manifestsMatch(originalManifest, updatedManifest), false);
});
