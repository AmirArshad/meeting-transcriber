const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../../src/ai-addon-token-store');
const tokenKey = store.TOKEN_KEYS.diarizationHuggingFace;
function deferred() { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(t) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-token-test-'));
  t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
  const safeStorage = { getSelectedStorageBackend: () => 'gnome_libsecret', isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async s => Buffer.from(`v11${s}`), decryptStringAsync: async b => ({ result: b.subarray(3).toString(), shouldReEncrypt: false }) };
  return { userDataDir, tokenKey, safeStorage };
}
test('atomic storage, replacement, deletion and permissions', async t => {
  const o = fixture(t); const tokenPath = store.getTokenPath(o.userDataDir, tokenKey);
  await store.storeAiAddonToken({ ...o, token: ' first ' });
  await store.storeAiAddonToken({ ...o, token: 'second' });
  assert.equal(await store.getAiAddonToken(o), 'second');
  assert.equal(store.hasAiAddonToken(o), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  assert.deepEqual(await store.deleteAiAddonToken(o), { success: true, hasToken: false });
  assert.equal(await store.getAiAddonToken(o), null);
});
test('passive availability and missing files never initialize encryption', async t => {
  const o = fixture(t); o.safeStorage = new Proxy({}, { get() { throw Error('unexpected'); } });
  assert.equal(await store.isTokenEncryptionAvailable({ ...o, checkAvailability: false }), null);
  assert.equal(await store.getAiAddonToken(o), null);
});
test('delete during decrypt cannot return or resurrect token', async t => {
  const o = fixture(t); await store.storeAiAddonToken({ ...o, token: 'old' });
  const entered = deferred(), result = deferred();
  o.safeStorage.decryptStringAsync = () => { entered.resolve(); return result.promise; };
  const read = store.getAiAddonToken(o); await entered.promise;
  await store.deleteAiAddonToken(o); result.resolve({ result: 'old', shouldReEncrypt: true });
  assert.equal(await read, null); assert.equal(store.hasAiAddonToken(o), false);
});
test('newer save wins when older encryption is delayed', async t => {
  const o = fixture(t); const entered = deferred(), result = deferred();
  o.safeStorage.encryptStringAsync = value => { if (value === 'avanevis-storage-probe') return Promise.resolve(Buffer.from('v11probe')); if (value === 'old') { entered.resolve(); return result.promise; } return Promise.resolve(Buffer.from(`v11${value}`)); };
  const old = store.storeAiAddonToken({ ...o, token: 'old' }); await entered.promise;
  await store.storeAiAddonToken({ ...o, token: 'new' }); result.resolve(Buffer.from('v11old'));
  await assert.rejects(old); assert.equal(await store.getAiAddonToken(o), 'new');
});
test('rotation skips externally replaced source bytes', async t => {
  const o = fixture(t); await store.storeAiAddonToken({ ...o, token: 'old' });
  const entered = deferred(), result = deferred();
  o.safeStorage.decryptStringAsync = async () => ({ result: 'old', shouldReEncrypt: true });
  o.safeStorage.encryptStringAsync = value => { if (value === 'avanevis-storage-probe') return Promise.resolve(Buffer.from('v11probe')); entered.resolve(); return result.promise; };
  const read = store.getAiAddonToken(o); await entered.promise;
  fs.writeFileSync(store.getTokenPath(o.userDataDir, tokenKey), 'v11new'); result.resolve(Buffer.from('v11rotated'));
  assert.equal(await read, 'old'); assert.equal(fs.readFileSync(store.getTokenPath(o.userDataDir, tokenKey), 'utf8'), 'v11new');
});
test('failed encryption, corrupt reads and rename failures preserve ciphertext and sanitize errors', async t => {
  const o = fixture(t); await store.storeAiAddonToken({ ...o, token: 'old' });
  const tokenPath = store.getTokenPath(o.userDataDir, tokenKey);
  o.safeStorage.encryptStringAsync = async value => { if (value === 'avanevis-storage-probe') return Buffer.from('v11probe'); throw Error('secret diagnostic'); };
  await assert.rejects(store.storeAiAddonToken({ ...o, token: 'new' }), e => !e.message.includes('secret diagnostic'));
  o.safeStorage.decryptStringAsync = async () => { throw Error('secret diagnostic'); };
  await assert.rejects(store.getAiAddonToken(o), e => !e.message.includes('secret diagnostic'));
  o.safeStorage.decryptStringAsync = async () => ({ result: 'old' });
  await assert.rejects(store.getAiAddonToken(o));
  o.safeStorage.encryptStringAsync = async value => Buffer.from(`v11${value}`);
  const failingFs = Object.create(fs); failingFs.renameSync = () => { throw Error('rename'); };
  await assert.rejects(store.storeAiAddonToken({ ...o, fsModule: failingFs, token: 'new' }));
  assert.equal(fs.readFileSync(tokenPath, 'utf8'), 'v11old');
  assert.deepEqual(fs.readdirSync(path.dirname(tokenPath)), [path.basename(tokenPath)]);
});
test('failed exclusive create does not remove another attempt’s temporary file', async t => {
  const o = fixture(t); let attempted; let unlinked = false;
  const failingFs = Object.create(fs);
  failingFs.openSync = file => { attempted = file; const e = new Error('exists'); e.code = 'EEXIST'; throw e; };
  failingFs.unlinkSync = file => { if (file === attempted) unlinked = true; };
  await assert.rejects(store.storeAiAddonToken({ ...o, fsModule: failingFs, token: 'new' }));
  assert.equal(unlinked, false);
});
test('Linux availability rejects unknown and basic text backend labels', async () => {
  if (process.platform !== 'linux') return;
  for (const backend of ['unknown', 'basic_text', null]) {
    const safeStorage = { getSelectedStorageBackend: () => backend, isAsyncEncryptionAvailable: async () => true };
    assert.equal(await store.isTokenEncryptionAvailable({ safeStorage }), false);
  }
});
test('Linux rejects fixed-key fallback despite a secure backend label', async t => {
  if (process.platform !== 'linux') return;
  const o = fixture(t);
  o.safeStorage.encryptStringAsync = async () => Buffer.from('v10fallback');
  assert.equal(await store.isTokenEncryptionAvailable(o), false);
  await assert.rejects(store.storeAiAddonToken({ ...o, token: 'value' }), { code: 'TOKEN_STORAGE_UNAVAILABLE' });
  assert.equal(store.hasAiAddonToken(o), false);
});
test('failed key rotation preserves original ciphertext and returns the decrypted token', async t => {
  const o = fixture(t);
  await store.storeAiAddonToken({ ...o, token: 'old' });
  const tokenPath = store.getTokenPath(o.userDataDir, tokenKey);
  const original = fs.readFileSync(tokenPath);
  o.safeStorage.decryptStringAsync = async () => ({ result: 'old', shouldReEncrypt: true });
  o.safeStorage.encryptStringAsync = async value => {
    if (value === 'avanevis-storage-probe') return Buffer.from('v11probe');
    throw new Error('synthetic private diagnostic');
  };
  assert.equal(await store.getAiAddonToken(o), 'old');
  assert.deepEqual(fs.readFileSync(tokenPath), original);
});
test('a newer save during rotation wins even if rotation finishes last', async t => {
  const o = fixture(t);
  await store.storeAiAddonToken({ ...o, token: 'old' });
  const entered = deferred(), rotated = deferred();
  o.safeStorage.decryptStringAsync = async b => ({ result: b.subarray(3).toString(), shouldReEncrypt: b.subarray(3).toString() === 'old' });
  o.safeStorage.encryptStringAsync = async value => {
    if (value === 'old') { entered.resolve(); return rotated.promise; }
    return Buffer.from(`v11${value}`);
  };
  const read = store.getAiAddonToken(o);
  await entered.promise;
  await store.storeAiAddonToken({ ...o, token: 'new' });
  rotated.resolve(Buffer.from('v11rotated'));
  assert.equal(await read, null);
  assert.equal(await store.getAiAddonToken(o), 'new');
});
