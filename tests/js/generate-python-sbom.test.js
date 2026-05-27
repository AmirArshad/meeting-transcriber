const test = require('node:test');
const assert = require('node:assert/strict');

const { mergePackages, parsePinnedRequirements } = require('../../scripts/generate-python-sbom');

test('parsePinnedRequirements extracts name==version pins', () => {
  const packages = parsePinnedRequirements(__filename.replace('generate-python-sbom.test.js', '../../requirements-windows-build.txt'));
  const numpy = packages.find((pkg) => pkg.name === 'numpy');
  assert.ok(numpy);
  assert.equal(numpy.version, '2.4.6');
});

test('mergePackages deduplicates requirements across platform build files', () => {
  const merged = mergePackages([
    { name: 'numpy', version: '1.26.4', source: 'requirements-windows-build.txt' },
    { name: 'numpy', version: '1.26.4', source: 'requirements-macos-build.txt' },
    { name: 'torch', version: '2.8.0', source: 'requirements-windows-build.txt' },
    { name: 'torch', version: '2.12.0', source: 'requirements-macos-build.txt' },
  ]);

  assert.equal(merged.length, 2);
  const torch = merged.find((pkg) => pkg.name === 'torch');
  assert.match(torch.versionNote, /platform-specific/);
});
