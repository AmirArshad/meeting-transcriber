'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Speakrs zip dependencies are patched for GHSA-m665-v7pm-7grj', () => {
  const lock = fs.readFileSync(path.join(__dirname, '../../native/speakrs-cli/Cargo.lock'), 'utf8');
  const versions = [...lock.matchAll(/\[\[package\]\]\s*\nname = "zip"\s*\nversion = "([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(versions.length > 0, 'expected at least one zip crate in the lock');
  for (const version of versions) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    assert.ok(match, `expected a stable zip version, got ${version}`);
    const [major, minor, patch] = match.slice(1).map(Number);
    assert.ok(major > 9 || (major === 9 && (minor > 0 || patch >= 5)), `zip ${version} is vulnerable`);
  }
});
