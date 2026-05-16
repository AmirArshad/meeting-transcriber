const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  TOKEN_KEYS,
  deleteAiAddonToken,
  getAiAddonToken,
  getTokenPath,
  hasAiAddonToken,
  isTokenEncryptionAvailable,
  storeAiAddonToken,
} = require('../../src/ai-addon-token-store');

function createMemoryFs() {
  const files = new Map();
  const dirs = new Set();

  return {
    files,
    mkdirSync(dirPath) {
      dirs.add(dirPath);
    },
    writeFileSync(filePath, data) {
      files.set(filePath, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    },
    readFileSync(filePath) {
      if (!files.has(filePath)) {
        throw new Error(`Missing file: ${filePath}`);
      }
      return files.get(filePath);
    },
    existsSync(filePath) {
      return files.has(filePath) || dirs.has(filePath);
    },
    unlinkSync(filePath) {
      files.delete(filePath);
    },
  };
}

function createSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8').replace(/^encrypted:/, ''),
  };
}

test('stores and retrieves an encrypted AI add-on token', () => {
  const fsModule = createMemoryFs();
  const safeStorage = createSafeStorage();
  const userDataDir = '/tmp/AvaNevis';
  const tokenPath = getTokenPath(userDataDir, TOKEN_KEYS.diarizationHuggingFace);

  const result = storeAiAddonToken({
    userDataDir,
    tokenKey: TOKEN_KEYS.diarizationHuggingFace,
    token: ' hf_secret ',
    safeStorage,
    fsModule,
  });

  assert.deepEqual(result, { success: true, hasToken: true });
  assert.equal(hasAiAddonToken({ userDataDir, tokenKey: TOKEN_KEYS.diarizationHuggingFace, fsModule }), true);
  assert.equal(fsModule.files.get(tokenPath).toString('utf8'), 'encrypted:hf_secret');
  assert.equal(getAiAddonToken({ userDataDir, tokenKey: TOKEN_KEYS.diarizationHuggingFace, safeStorage, fsModule }), 'hf_secret');
});

test('does not store tokens when encryption is unavailable', () => {
  const fsModule = createMemoryFs();
  const safeStorage = { isEncryptionAvailable: () => false };

  assert.throws(
    () => storeAiAddonToken({
      userDataDir: '/tmp/AvaNevis',
      tokenKey: TOKEN_KEYS.diarizationHuggingFace,
      token: 'hf_secret',
      safeStorage,
      fsModule,
    }),
    /Secure token storage is unavailable/,
  );
  assert.equal(fsModule.files.size, 0);
});

test('can report unknown encryption availability without touching safeStorage', () => {
  let calls = 0;
  const safeStorage = {
    isEncryptionAvailable: () => {
      calls += 1;
      return true;
    },
  };

  assert.equal(isTokenEncryptionAvailable({ safeStorage, checkAvailability: false }), null);
  assert.equal(calls, 0);
  assert.equal(isTokenEncryptionAvailable({ safeStorage }), true);
  assert.equal(calls, 1);
});

test('rejects unsupported token keys instead of writing arbitrary files', () => {
  assert.throws(
    () => getTokenPath('/tmp/AvaNevis', '../bad'),
    /Unsupported secure token key/,
  );
});

test('deletes stored AI add-on token', () => {
  const fsModule = createMemoryFs();
  const safeStorage = createSafeStorage();
  const userDataDir = 'C:/Users/tester/AppData/Roaming/AvaNevis';

  storeAiAddonToken({
    userDataDir,
    tokenKey: TOKEN_KEYS.diarizationHuggingFace,
    token: 'hf_secret',
    safeStorage,
    fsModule,
  });

  const result = deleteAiAddonToken({
    userDataDir,
    tokenKey: TOKEN_KEYS.diarizationHuggingFace,
    fsModule,
  });

  assert.deepEqual(result, { success: true, hasToken: false });
  assert.equal(hasAiAddonToken({ userDataDir, tokenKey: TOKEN_KEYS.diarizationHuggingFace, fsModule }), false);
});

test('token path remains inside ai-addons token store', () => {
  const tokenPath = getTokenPath('/tmp/AvaNevis', TOKEN_KEYS.diarizationHuggingFace);

  assert.equal(tokenPath, path.join('/tmp/AvaNevis', 'ai-addons', 'tokens', 'diarization-huggingface-token.bin'));
});
