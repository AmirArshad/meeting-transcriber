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

function requireEncryption(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure token storage is unavailable right now. Unlock Keychain or restart AvaNevis and try again.');
  }
}

function isTokenEncryptionAvailable({ safeStorage, checkAvailability = true } = {}) {
  if (!checkAvailability) {
    return null;
  }

  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    return false;
  }

  return safeStorage.isEncryptionAvailable();
}

function writeTokenFileAtomicSync(fsModule, tokenPath, encryptedBuffer) {
  const tempPath = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  const writeOptions = process.platform === 'win32' ? undefined : { mode: 0o600 };

  try {
    fsModule.writeFileSync(tempPath, encryptedBuffer, writeOptions);
    if (typeof fsModule.renameSync === 'function') {
      fsModule.renameSync(tempPath, tokenPath);
    } else {
      fsModule.writeFileSync(tokenPath, encryptedBuffer, writeOptions);
      if (typeof fsModule.unlinkSync === 'function') {
        fsModule.unlinkSync(tempPath);
      }
    }
  } finally {
    if (typeof fsModule.existsSync === 'function' && typeof fsModule.unlinkSync === 'function' && fsModule.existsSync(tempPath)) {
      try {
        fsModule.unlinkSync(tempPath);
      } catch (error) {
        // Best effort cleanup only.
      }
    }
  }
}

function storeAiAddonToken({ userDataDir, tokenKey, token, safeStorage, fsModule = fs } = {}) {
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  if (!normalizedToken) {
    throw new Error('Token must not be empty.');
  }

  requireEncryption(safeStorage);
  const tokenPath = getTokenPath(userDataDir, tokenKey);
  fsModule.mkdirSync(path.dirname(tokenPath), { recursive: true });
  writeTokenFileAtomicSync(fsModule, tokenPath, safeStorage.encryptString(normalizedToken));

  return { success: true, hasToken: true };
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

function getAiAddonToken({ userDataDir, tokenKey, safeStorage, fsModule = fs } = {}) {
  const tokenPath = getTokenPath(userDataDir, tokenKey);
  if (!hasAiAddonToken({ userDataDir, tokenKey, fsModule })) {
    return null;
  }

  requireEncryption(safeStorage);
  return safeStorage.decryptString(fsModule.readFileSync(tokenPath));
}

function deleteAiAddonToken({ userDataDir, tokenKey, fsModule = fs } = {}) {
  const tokenPath = getTokenPath(userDataDir, tokenKey);
  if (fsModule.existsSync(tokenPath)) {
    fsModule.unlinkSync(tokenPath);
  }

  return { success: true, hasToken: false };
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
