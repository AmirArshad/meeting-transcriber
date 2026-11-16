'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

for (const crate of ['speakrs-cli', 'speakrs-cpu-smoke']) {
  test(`the offline ${crate} lockfile excludes TLS-root artifacts and online model transports`, () => {
    const lock = fs.readFileSync(path.join(__dirname, '../../native', crate, 'Cargo.lock'), 'utf8');
    assert.doesNotMatch(lock, /^name = "(?:webpki-roots|webpki-root-certs|rustls-webpki|hf-hub|ort|ort-sys)"$/m);
  });
}
