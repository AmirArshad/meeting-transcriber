const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getLegalNoticesPath } = require('../../src/main-process-helpers');

const repoRoot = path.join(__dirname, '..', '..');

test('THIRD_PARTY_NOTICES.md exists and documents key optional models', () => {
  const noticesPath = path.join(repoRoot, 'THIRD_PARTY_NOTICES.md');
  assert.equal(fs.existsSync(noticesPath), true);

  const contents = fs.readFileSync(noticesPath, 'utf8');
  assert.match(contents, /pyannote\/speaker-diarization-community-1/i);
  assert.match(contents, /CC BY 4\.0/i);
  assert.match(contents, /Qwen/i);
  assert.match(contents, /ffmpeg/i);
  assert.match(contents, /GPL/i);
});

test('getLegalNoticesPath prefers packaged resources/legal when present', () => {
  const tempResources = path.join(repoRoot, 'tests', 'fixtures', 'legal-notices-packaged');
  const packagedNotices = path.join(tempResources, 'legal', 'THIRD_PARTY_NOTICES.md');
  fs.mkdirSync(path.dirname(packagedNotices), { recursive: true });
  fs.writeFileSync(packagedNotices, '# Packaged notices\n', 'utf8');

  try {
    const resolved = getLegalNoticesPath({
      resourcesPath: tempResources,
      devRoot: repoRoot,
    });
    assert.equal(resolved, packagedNotices);
  } finally {
    fs.rmSync(tempResources, { recursive: true, force: true });
  }
});

test('getLegalNoticesPath falls back to repository root in development', () => {
  const resolved = getLegalNoticesPath({
    resourcesPath: path.join(repoRoot, 'missing-resources'),
    devRoot: repoRoot,
  });
  assert.equal(resolved, path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'));
});
