const fs = require('fs');
const path = require('path');

const TOKEN_KEYS = Object.freeze({
  diarizationHuggingFace: 'diarization-huggingface-token',
});

const TOKEN_FILE_NAMES = Object.freeze({
  [TOKEN_KEYS.diarizationHuggingFace]: 'diarization-huggingface-token.bin',
});

function getTokenStoreDir(userDataDir) {
  return path.join(String(userDataDir || ''), 'ai-addons', 'tokens');
}

function getTokenPath(userDataDir, tokenKey) {
  const fileName = TOKEN_FILE_NAMES[tokenKey];
  if (!fileName) {
    throw new Error(`Unsupported secure token key: ${tokenKey}`);
  }
  return path.join(getTokenStoreDir(userDataDir), fileName);
}

const operationStates = new Map();
let tempSequence = 0;
const unavailable = () => Object.assign(new Error('Secure token storage is unavailable right now. Unlock your secure storage and try again.'), { code: 'TOKEN_STORAGE_UNAVAILABLE' });
const storageError = () => new Error('Secure token storage could not complete the operation. Please try again.');

function stateFor(tokenPath) {
  const key = path.resolve(tokenPath);
  if (!operationStates.has(key)) operationStates.set(key, { generation: 0, tail: Promise.resolve(), active: 0 });
  const state = operationStates.get(key);
  state.active += 1;
  return state;
}

function enqueue(state, action) {
  const result = state.tail.then(action);
  state.tail = result.catch(() => {});
  return result;
}

function releaseState(tokenPath, state) {
  state.active -= 1;
  if (state.active === 0 && operationStates.get(path.resolve(tokenPath)) === state) {
    operationStates.delete(path.resolve(tokenPath));
  }
}

// Electron 46.0.0-alpha.10 / Chromium 159: v10 uses a fixed POSIX key;
// v11 and v12 identify the desktop keyring and Secret portal respectively.
function isProtectedLinuxCiphertext(value) {
  return Buffer.isBuffer(value) && (value.subarray(0, 3).equals(Buffer.from('v11'))
    || value.subarray(0, 3).equals(Buffer.from('v12')));
}

async function isTokenEncryptionAvailable({ safeStorage, checkAvailability = true } = {}) {
  if (!checkAvailability) return null;
  try {
    if (!safeStorage || typeof safeStorage.isAsyncEncryptionAvailable !== 'function') return false;
    if (process.platform === 'linux' && (typeof safeStorage.getSelectedStorageBackend !== 'function'
        || !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend()))) return false;
    if ((await safeStorage.isAsyncEncryptionAvailable()) !== true) return false;
    if (process.platform === 'linux') {
      if (process.versions.electron && process.versions.electron !== '46.0.0-alpha.10') return false;
      if (typeof safeStorage.encryptStringAsync !== 'function') return false;
      return isProtectedLinuxCiphertext(await safeStorage.encryptStringAsync('avanevis-storage-probe'));
    }
    return true;
  } catch (_) { return false; }
}

async function requireEncryption(safeStorage) {
  if (!await isTokenEncryptionAvailable({ safeStorage })) throw unavailable();
}

function writeTokenFileAtomicSync(fsModule, tokenPath, encryptedBuffer) {
  const tempPath = `${tokenPath}.${process.pid}.${Date.now()}.${++tempSequence}.tmp`;
  let fd;
  let created = false;
  try {
    fd = fsModule.openSync(tempPath, 'wx', 0o600);
    created = true;
    fsModule.writeFileSync(fd, encryptedBuffer);
    fsModule.fsyncSync(fd);
    fsModule.closeSync(fd);
    fd = undefined;
    fsModule.renameSync(tempPath, tokenPath);
  } finally {
    if (fd !== undefined) { try { fsModule.closeSync(fd); } catch (_) {} }
    if (created) { try { fsModule.unlinkSync(tempPath); } catch (_) {} }
  }
}

async function storeAiAddonToken({ userDataDir, tokenKey, token, safeStorage, fsModule = fs } = {}) {
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  if (!normalizedToken) throw new Error('Token must not be empty.');
  const tokenPath = getTokenPath(userDataDir, tokenKey);
  const state = stateFor(tokenPath);
  const generation = ++state.generation;
  try {
    await requireEncryption(safeStorage);
    const encrypted = await safeStorage.encryptStringAsync(normalizedToken);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length
        || (process.platform === 'linux' && !isProtectedLinuxCiphertext(encrypted))) throw storageError();
    return await enqueue(state, () => {
      if (state.generation !== generation) throw storageError();
      fsModule.mkdirSync(path.dirname(tokenPath), { recursive: true });
      writeTokenFileAtomicSync(fsModule, tokenPath, encrypted);
      return { success: true, hasToken: true };
    });
  } catch (error) { if (error.code === 'TOKEN_STORAGE_UNAVAILABLE') throw error; throw storageError(); }
  finally { releaseState(tokenPath, state); }
}

function hasAiAddonToken({ userDataDir, tokenKey, fsModule = fs } = {}) {
  const tokenPath = getTokenPath(userDataDir, tokenKey);
  if (!fsModule.existsSync(tokenPath)) {
    return false;
  }

  // Existence alone is not enough: a crash mid-write can leave a zero-length
  // file that would otherwise push users into a decrypt-error path. Non-empty
  // corrupt blobs still report hasToken (atomic rename makes truncation rare).
  try {
    const stats = typeof fsModule.statSync === 'function'
      ? fsModule.statSync(tokenPath)
      : null;
    if (stats && typeof stats.size === 'number' && stats.size <= 0) {
      return false;
    }
  } catch (error) {
    return false;
  }

  return true;
}

async function getAiAddonToken({ userDataDir, tokenKey, safeStorage, fsModule = fs } = {}) {
  const tokenPath = getTokenPath(userDataDir, tokenKey);
  const state = stateFor(tokenPath);
  const generation = state.generation;
  let snapshot;
  try {
    snapshot = await enqueue(state, () => {
      if (!hasAiAddonToken({ userDataDir, tokenKey, fsModule })) return null;
      return Buffer.from(fsModule.readFileSync(tokenPath));
    });
    if (!snapshot || !snapshot.length) return null;
    if (process.platform === 'linux' && !isProtectedLinuxCiphertext(snapshot)) throw storageError();
    await requireEncryption(safeStorage);
    const decrypted = await safeStorage.decryptStringAsync(snapshot);
    if (!decrypted || typeof decrypted.result !== 'string' || !decrypted.result
        || typeof decrypted.shouldReEncrypt !== 'boolean') throw storageError();
    if (state.generation !== generation) return null;
    if (decrypted.shouldReEncrypt) {
      try {
        const rotated = await safeStorage.encryptStringAsync(decrypted.result);
        if (!Buffer.isBuffer(rotated) || !rotated.length
            || (process.platform === 'linux' && !isProtectedLinuxCiphertext(rotated))) throw storageError();
        await enqueue(state, () => {
          if (state.generation !== generation) return;
          let current;
          try { current = fsModule.readFileSync(tokenPath); } catch (_) { return; }
          if (Buffer.from(current).equals(snapshot)) writeTokenFileAtomicSync(fsModule, tokenPath, rotated);
        });
      } catch (_) { /* Retain the readable original on rotation failure. */ }
    }
    return state.generation === generation ? decrypted.result : null;
  } catch (error) { if (error.code === 'TOKEN_STORAGE_UNAVAILABLE') throw error; throw storageError(); }
  finally { releaseState(tokenPath, state); }
}

async function deleteAiAddonToken({ userDataDir, tokenKey, fsModule = fs } = {}) {
  const tokenPath = getTokenPath(userDataDir, tokenKey);
  const state = stateFor(tokenPath);
  ++state.generation;
  try {
    return await enqueue(state, () => {
      try { fsModule.unlinkSync(tokenPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { success: true, hasToken: false };
    });
  } catch (_) { throw storageError(); }
  finally { releaseState(tokenPath, state); }
}

module.exports = {
  TOKEN_KEYS,
  deleteAiAddonToken,
  getAiAddonToken,
  getTokenPath,
  getTokenStoreDir,
  hasAiAddonToken,
  isTokenEncryptionAvailable,
  storeAiAddonToken,
};
