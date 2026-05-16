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
    throw new Error('Secure token storage is unavailable on this system.');
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

function storeAiAddonToken({ userDataDir, tokenKey, token, safeStorage, fsModule = fs } = {}) {
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  if (!normalizedToken) {
    throw new Error('Token must not be empty.');
  }

  requireEncryption(safeStorage);
  const tokenPath = getTokenPath(userDataDir, tokenKey);
  fsModule.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fsModule.writeFileSync(tokenPath, safeStorage.encryptString(normalizedToken));

  return { success: true, hasToken: true };
}

function hasAiAddonToken({ userDataDir, tokenKey, fsModule = fs } = {}) {
  return fsModule.existsSync(getTokenPath(userDataDir, tokenKey));
}

function getAiAddonToken({ userDataDir, tokenKey, safeStorage, fsModule = fs } = {}) {
  const tokenPath = getTokenPath(userDataDir, tokenKey);
  if (!fsModule.existsSync(tokenPath)) {
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
