'use strict';
// Disposable-profile fixture. The runner supplies only scratch directories and
// synthetic values; report booleans and provider labels, never ciphertext.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { isTokenEncryptionAvailable } = require('../../../src/ai-addon-token-store');
const [profile, mode, passwordStore] = process.argv.slice(2);
app.setName('AvaNevis-token-migration-smoke');
app.setPath('userData', profile);
if (process.platform === 'linux') app.commandLine.appendSwitch('password-store', passwordStore);
const secret = 'synthetic-avanevis-migration-canary';
const tokenPath = path.join(profile, 'synthetic-token.bin');
(async () => {
  await app.whenReady();
  const legacy = mode === 'legacy-write' || mode === 'legacy-read';
  let backend = null, available = false, protectedByAppPolicy = null, roundTrip = false, rotation = null, format = null;
  const classify = buffer => { const prefix = buffer.subarray(0, 3).toString('ascii'); return ['v10', 'v11', 'v12'].includes(prefix) ? prefix : 'other'; };
  try { backend = safeStorage.getSelectedStorageBackend?.() || null; } catch (_) {}
  try {
    available = legacy ? safeStorage.isEncryptionAvailable() : await safeStorage.isAsyncEncryptionAvailable();
    if (!legacy) protectedByAppPolicy = await isTokenEncryptionAvailable({ safeStorage });
    if (available && mode === 'async-write') {
      const encrypted = await safeStorage.encryptStringAsync(secret);
      format = classify(encrypted);
      fs.writeFileSync(tokenPath, encrypted, { mode: 0o600 });
      roundTrip = true;
    } else if (available && mode === 'async-roundtrip') {
      const encrypted = await safeStorage.encryptStringAsync(secret);
      format = classify(encrypted);
      const decoded = await safeStorage.decryptStringAsync(encrypted);
      roundTrip = decoded.result === secret;
      rotation = decoded.shouldReEncrypt;
    } else if (available && mode === 'legacy-write') {
      fs.writeFileSync(tokenPath, safeStorage.encryptString(secret), { mode: 0o600 });
      roundTrip = safeStorage.decryptString(fs.readFileSync(tokenPath)) === secret;
    } else if (available && mode === 'upgrade') {
      const stored = fs.readFileSync(tokenPath);
      format = classify(stored);
      const decoded = await safeStorage.decryptStringAsync(stored);
      roundTrip = decoded.result === secret;
      rotation = decoded.shouldReEncrypt;
      if (roundTrip) fs.writeFileSync(tokenPath, await safeStorage.encryptStringAsync(secret), { mode: 0o600 });
    } else if (available && mode === 'restart') {
      const stored = fs.readFileSync(tokenPath);
      format = classify(stored);
      const decoded = await safeStorage.decryptStringAsync(stored);
      roundTrip = decoded.result === secret;
      rotation = decoded.shouldReEncrypt;
    } else if (available && mode === 'legacy-read') {
      roundTrip = safeStorage.decryptString(fs.readFileSync(tokenPath)) === secret;
    }
  } catch (_) { /* Only report failure state; never emit native error text. */ }
  process.stdout.write(`${JSON.stringify({ mode, electron: process.versions.electron, backend, available, protectedByAppPolicy, roundTrip, rotation, format })}\n`);
  // Chromium persists the Windows encryption key on normal shutdown.
  app.quit();
})().catch(() => { process.stdout.write('{"fixtureError":true}\n'); app.exit(1); });
