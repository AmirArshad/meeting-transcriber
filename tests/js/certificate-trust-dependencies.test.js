'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function cargoPackages() {
  const lock = fs.readFileSync(path.join(__dirname, '../../native/speakrs-cli/Cargo.lock'), 'utf8');
  return lock.split('[[package]]').slice(1).map((entry) => ({
    name: entry.match(/^name = "([^"]+)"/m)?.[1],
    version: entry.match(/^version = "([^"]+)"/m)?.[1],
    dependencies: entry.match(/^dependencies = \[([\s\S]*?)\]/m)?.[1] || '',
  }));
}

function atLeast(actual, minimum) {
  const a = actual.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let i = 0; i < b.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

test('the audited legacy webpki facade resolves only to patched root data', () => {
  const packages = cargoPackages();
  const roots = packages.filter((entry) => entry.name === 'webpki-roots');
  assert.ok(roots.length > 0);
  for (const entry of roots) {
    if (entry.version === '0.26.11') {
      const parent = entry.dependencies.match(/"webpki-roots ([^"]+)"/);
      assert.ok(parent, 'the legacy facade must resolve a versioned parent');
      assert.ok(atLeast(parent[1], '1.0.10'), 'the legacy facade must re-export patched roots');
      assert.ok(roots.some((root) => root.version === parent[1]));
    } else {
      assert.ok(atLeast(entry.version, '1.0.10'), 'all other roots packages must contain patched data');
    }
  }
  const certs = packages.filter((entry) => entry.name === 'webpki-root-certs');
  assert.ok(certs.length > 0);
  for (const entry of certs) assert.ok(atLeast(entry.version, '1.0.10'));
  const validators = packages.filter((entry) => entry.name === 'rustls-webpki');
  assert.ok(validators.length > 0);
  for (const entry of validators) assert.ok(atLeast(entry.version, '0.103.16'));
});
