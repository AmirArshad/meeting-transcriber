'use strict';

const crypto = require('crypto');

const transcriptionPolicy = require('../transcription-policy');
const catalog = require('./transcription-engine-catalog');

const CLIENT_AUTHORITY_KEYS = Object.freeze([
  'modelPath',
  'runtimePath',
  'url',
  'downloadUrl',
  'sha256',
  'hash',
  'token',
]);

function normalizeToken(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function present(input, key) {
  return Object.prototype.hasOwnProperty.call(input || {}, key) && input[key] != null && String(input[key]).trim() !== '';
}

function failure(code, message) {
  return { ok: false, code, message };
}

function createAttemptId(generateAttemptId) {
  if (typeof generateAttemptId === 'function') {
    return generateAttemptId();
  }
  return crypto.randomUUID();
}

function rejectClientAuthority(input) {
  for (const key of CLIENT_AUTHORITY_KEYS) {
    if (present(input, key)) {
      return failure('PARAKEET_SELECTION_UNAVAILABLE', 'Transcription requests cannot supply paths, URLs, or hashes.');
    }
  }
  return null;
}

function resolveLegacyWhisper(input, attemptId) {
  const language = normalizeToken(input.language) || transcriptionPolicy.DEFAULT_LANGUAGE;
  const modelSize = normalizeToken(input.modelSize || input.model) || transcriptionPolicy.DEFAULT_MODEL_SIZE;
  if (!transcriptionPolicy.isCompatibleLanguage(language)) {
    return failure('UNSUPPORTED_LANGUAGE', 'Choose a supported transcription language.');
  }
  if (!transcriptionPolicy.isCompatibleModelSize(modelSize)) {
    return failure('UNSUPPORTED_MODEL', 'Choose a supported Whisper model.');
  }
  return {
    ok: true,
    legacy: true,
    request: {
      schemaVersion: 1,
      attemptId,
      engine: catalog.ENGINE_WHISPER,
      language,
      modelSize,
      artifactRevision: null,
    },
  };
}

function resolveNewWhisper(input, attemptId) {
  const validation = transcriptionPolicy.validateNewSelection({
    language: input.language,
    modelSize: input.modelSize || input.model,
  });
  if (!validation.ok) {
    return validation;
  }
  return {
    ok: true,
    legacy: false,
    request: {
      schemaVersion: 1,
      attemptId,
      engine: catalog.ENGINE_WHISPER,
      language: validation.language,
      modelSize: validation.modelSize,
      artifactRevision: null,
    },
  };
}

function sameIfPresent(input, key, expected, label) {
  if (!present(input, key)) {
    return null;
  }
  if (String(input[key]).trim() !== expected) {
    return failure('PARAKEET_SELECTION_UNAVAILABLE', `${label} does not match the installed Parakeet revision.`);
  }
  return null;
}

function resolveParakeet(input, options, attemptId) {
  const authority = rejectClientAuthority(input);
  if (authority) {
    return authority;
  }
  const language = normalizeToken(input.language);
  if (language !== 'en') {
    return failure('PARAKEET_ENGLISH_ONLY', 'English only. Use Whisper for other languages.');
  }
  const target = catalog.resolveAdapterForTarget({
    platform: options.platform,
    arch: options.arch,
    osRelease: options.osRelease,
  });
  if (!target.ok) {
    return target;
  }
  const spec = catalog.getAdapterSpec(target.adapterId);
  const mismatches = [
    sameIfPresent(input, 'modelId', spec.modelId, 'Parakeet model'),
    sameIfPresent(input, 'artifactRevision', spec.artifactRevision, 'Parakeet artifact'),
    sameIfPresent(input, 'adapterId', spec.adapterId, 'Parakeet adapter'),
    sameIfPresent(input, 'runtimeLockId', spec.runtimeLockId, 'Parakeet runtime'),
    sameIfPresent(input, 'boundaryPolicy', spec.boundaryPolicy, 'Parakeet boundary policy'),
  ].filter(Boolean);
  if (mismatches.length) {
    return mismatches[0];
  }
  return {
    ok: true,
    legacy: false,
    request: {
      schemaVersion: 1,
      attemptId,
      engine: catalog.ENGINE_PARAKEET,
      modelId: spec.modelId,
      artifactRevision: spec.artifactRevision,
      adapterId: spec.adapterId,
      runtimeLockId: spec.runtimeLockId,
      language: 'en',
      boundaryPolicy: spec.boundaryPolicy,
    },
  };
}

function resolveTranscriptionRequest(input, options = {}) {
  const source = input || {};
  const attemptId = createAttemptId(options.generateAttemptId);
  if (!present(source, 'engine')) {
    return resolveLegacyWhisper(source, attemptId);
  }
  const engine = normalizeToken(source.engine);
  if (engine === catalog.ENGINE_WHISPER) {
    return resolveNewWhisper(source, attemptId);
  }
  if (engine === catalog.ENGINE_PARAKEET) {
    return resolveParakeet(source, options, attemptId);
  }
  return failure('UNKNOWN_ENGINE', 'Unknown transcription engine.');
}

function validateStoredRequest(input, options = {}) {
  const source = input || {};
  if (!present(source, 'engine')) {
    const language = normalizeToken(source.language);
    const modelSize = normalizeToken(source.modelSize || source.model);
    if (!transcriptionPolicy.isCompatibleLanguage(language) || !transcriptionPolicy.isCompatibleModelSize(modelSize)) {
      return failure('UNSUPPORTED_MODEL', 'Saved Whisper selection is no longer compatible.');
    }
    return {
      ok: true,
      legacy: true,
      request: {
        schemaVersion: 1,
        attemptId: source.attemptId || null,
        engine: catalog.ENGINE_WHISPER,
        language,
        modelSize,
        artifactRevision: source.artifactRevision == null ? null : source.artifactRevision,
      },
    };
  }
  const engine = normalizeToken(source.engine);
  if (engine === catalog.ENGINE_WHISPER) {
    const language = normalizeToken(source.language);
    const modelSize = normalizeToken(source.modelSize || source.model);
    if (!transcriptionPolicy.isCompatibleLanguage(language) || !transcriptionPolicy.isCompatibleModelSize(modelSize)) {
      return failure('UNSUPPORTED_MODEL', 'Saved Whisper selection is no longer compatible.');
    }
    return {
      ok: true,
      legacy: false,
      request: {
        schemaVersion: 1,
        attemptId: source.attemptId || null,
        engine: catalog.ENGINE_WHISPER,
        language,
        modelSize,
        artifactRevision: null,
      },
    };
  }
  if (engine !== catalog.ENGINE_PARAKEET) {
    return failure('UNKNOWN_ENGINE', 'Unknown transcription engine.');
  }
  const target = catalog.resolveAdapterForTarget({
    platform: options.platform,
    arch: options.arch,
    osRelease: options.osRelease,
  });
  if (!target.ok) {
    return failure('PARAKEET_SELECTION_UNAVAILABLE', target.message);
  }
  const spec = catalog.getAdapterSpec(target.adapterId);
  const identityMatches = source.modelId === spec.modelId
    && source.artifactRevision === spec.artifactRevision
    && source.adapterId === spec.adapterId
    && source.runtimeLockId === spec.runtimeLockId
    && source.boundaryPolicy === spec.boundaryPolicy
    && normalizeToken(source.language) === 'en';
  if (!identityMatches) {
    return failure('PARAKEET_SELECTION_UNAVAILABLE', 'Exact saved Parakeet adapter or revision is unavailable.');
  }
  return {
    ok: true,
    legacy: false,
    request: {
      schemaVersion: 1,
      attemptId: source.attemptId || null,
      engine: catalog.ENGINE_PARAKEET,
      modelId: spec.modelId,
      artifactRevision: spec.artifactRevision,
      adapterId: spec.adapterId,
      runtimeLockId: spec.runtimeLockId,
      language: 'en',
      boundaryPolicy: spec.boundaryPolicy,
    },
  };
}

function evaluateParakeetAdmission(request, status = {}) {
  const source = request || {};
  if (source.engine !== catalog.ENGINE_PARAKEET) {
    return { ok: true };
  }
  if (!status.installed) {
    return failure('PARAKEET_NOT_INSTALLED', 'Set up Parakeet before transcribing.');
  }
  if (status.artifactValid === false) {
    return failure('PARAKEET_ARTIFACT_INVALID', 'Parakeet model files failed integrity checks.');
  }
  if (status.runtimeValid === false) {
    return failure('PARAKEET_RUNTIME_INVALID', 'Parakeet runtime failed integrity checks.');
  }
  const expectedDevice = source.adapterId === catalog.ADAPTERS.MACOS_METAL ? 'metal' : 'cuda';
  if (!status.deviceAvailable || status.device === 'cpu' || status.device !== expectedDevice) {
    return failure('PARAKEET_GPU_UNAVAILABLE', 'Parakeet requires its GPU runtime. CPU and Whisper are not substituted.');
  }
  return { ok: true, device: expectedDevice, computeType: catalog.EXECUTION_PRECISION };
}

module.exports = {
  evaluateParakeetAdmission,
  resolveTranscriptionRequest,
  validateStoredRequest,
};
