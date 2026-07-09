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
  const writeModes = new Map();

  return {
    files,
    writeModes,
    mkdirSync(dirPath) {
      dirs.add(dirPath);
    },
    writeFileSync(filePath, data, options) {
      files.set(filePath, Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      if (options && typeof options.mode === 'number') {
        writeModes.set(filePath, options.mode);
      }
    },
    renameSync(fromPath, toPath) {
      if (!files.has(fromPath)) {
        throw new Error(`Missing file for rename: ${fromPath}`);
      }
      files.set(toPath, files.get(fromPath));
      files.delete(fromPath);
      if (writeModes.has(fromPath)) {
        writeModes.set(toPath, writeModes.get(fromPath));
        writeModes.delete(fromPath);
      }
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
    statSync(filePath) {
      if (!files.has(filePath)) {
        throw new Error(`Missing file: ${filePath}`);
      }
      return { size: files.get(filePath).length };
    },
    unlinkSync(filePath) {
      files.delete(filePath);
      writeModes.delete(filePath);
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

test('stores and retrieves an encrypted AI add-on token via atomic rename', () => {
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
  assert.equal(
    [...fsModule.files.keys()].some((filePath) => String(filePath).endsWith('.tmp')),
    false,
  );
  assert.equal(getAiAddonToken({ userDataDir, tokenKey: TOKEN_KEYS.diarizationHuggingFace, safeStorage, fsModule }), 'hf_secret');
});

test('token writes use restrictive mode on POSIX platforms', () => {
  if (process.platform === 'win32') {
    return;
  }

  const fsModule = createMemoryFs();
  const userDataDir = '/tmp/AvaNevis';
  const tokenPath = getTokenPath(userDataDir, TOKEN_KEYS.diarizationHuggingFace);

  storeAiAddonToken({
    userDataDir,
    tokenKey: TOKEN_KEYS.diarizationHuggingFace,
    token: 'hf_secret',
    safeStorage: createSafeStorage(),
    fsModule,
  });

  assert.equal(fsModule.writeModes.get(tokenPath), 0o600);
});

test('empty token files are not treated as a stored token', () => {
  const fsModule = createMemoryFs();
  const userDataDir = '/tmp/AvaNevis';
  const tokenPath = getTokenPath(userDataDir, TOKEN_KEYS.diarizationHuggingFace);
  fsModule.writeFileSync(tokenPath, Buffer.alloc(0));

  assert.equal(hasAiAddonToken({ userDataDir, tokenKey: TOKEN_KEYS.diarizationHuggingFace, fsModule }), false);
  assert.equal(
    getAiAddonToken({
      userDataDir,
      tokenKey: TOKEN_KEYS.diarizationHuggingFace,
      safeStorage: createSafeStorage(),
      fsModule,
    }),
    null,
  );
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
