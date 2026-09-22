'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../../src/main/transcription-engine-catalog');
const resolver = require('../../src/main/transcription-engine-resolver');

const LINUX = { platform: 'linux', arch: 'x64', generateAttemptId: () => 'attempt-1' };

test('supported target matrix resolves one adapter per GPU platform', () => {
  assert.deepEqual(
    catalog.listSupportedTargets().map((target) => [target.platform, target.arch, target.adapterId, target.device]),
    [
      ['win32', 'x64', catalog.ADAPTERS.WINDOWS_CUDA, 'cuda'],
      ['linux', 'x64', catalog.ADAPTERS.LINUX_CUDA, 'cuda'],
      ['darwin', 'arm64', catalog.ADAPTERS.MACOS_METAL, 'metal'],
    ],
  );
  assert.equal(catalog.resolveAdapterForTarget({ platform: 'linux', arch: 'arm64' }).ok, false);
  assert.match(catalog.resolveAdapterForTarget({ platform: 'darwin', arch: 'x64' }).message, /Apple Silicon/);
  assert.match(catalog.resolveAdapterForTarget({ platform: 'win32', arch: 'arm64' }).message, /Windows 10\/11 x64/);
  assert.equal(catalog.resolveAdapterForTarget({ platform: 'darwin', arch: 'arm64', osRelease: '13.6' }).ok, false);
  assert.equal(catalog.resolveAdapterForTarget({ platform: 'darwin', arch: 'arm64', osRelease: '14.0' }).adapterId, catalog.ADAPTERS.MACOS_METAL);
});

test('Parakeet requests are English-only and catalog-pinned', () => {
  const french = resolver.resolveTranscriptionRequest({ engine: 'parakeet', language: 'fr' }, LINUX);
  assert.equal(french.ok, false);
  assert.equal(french.code, 'PARAKEET_ENGLISH_ONLY');

  const resolved = resolver.resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, LINUX);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.request.engine, 'parakeet');
  assert.equal(resolved.request.language, 'en');
  assert.equal(resolved.request.modelId, catalog.PARAKEET_MODEL_ID);
  assert.equal(resolved.request.artifactRevision, catalog.ONNX_MODEL_REVISION);
  assert.equal(resolved.request.adapterId, catalog.ADAPTERS.LINUX_CUDA);
  assert.equal(resolved.request.boundaryPolicy, catalog.BOUNDARY_POLICY);
  assert.equal(resolved.request.runtimeLockId, catalog.getAdapterSpec(catalog.ADAPTERS.LINUX_CUDA).runtimeLockId);
  assert.equal(Object.hasOwn(resolved.request, 'modelSize'), false);
});

test('explicit unknown engines are rejected and missing engines stay legacy Whisper', () => {
  const unknown = resolver.resolveTranscriptionRequest({ engine: 'nemo', language: 'en', modelSize: 'small' }, LINUX);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'UNKNOWN_ENGINE');

  const legacy = resolver.resolveTranscriptionRequest({ language: 'fa', modelSize: 'tiny' }, LINUX);
  assert.equal(legacy.ok, true);
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.request.engine, 'whisper');
  assert.equal(legacy.request.language, 'fa');
  assert.equal(legacy.request.modelSize, 'tiny');
  assert.equal(legacy.request.artifactRevision, null);

  const freshWhisper = resolver.resolveTranscriptionRequest({ engine: 'whisper', language: 'en', modelSize: 'medium' }, LINUX);
  assert.equal(freshWhisper.request.modelSize, 'medium');
  assert.equal(resolver.resolveTranscriptionRequest({ engine: 'whisper', language: 'en', modelSize: 'tiny' }, LINUX).ok, false);
});

test('explicit foreign revisions are not replaced', () => {
  const drifted = resolver.resolveTranscriptionRequest({
    engine: 'parakeet',
    language: 'en',
    artifactRevision: 'ffffffffffffffffffffffffffffffffffffffff',
  }, LINUX);
  assert.equal(drifted.ok, false);
  assert.equal(drifted.code, 'PARAKEET_SELECTION_UNAVAILABLE');
});

test('adapter revisions are immutable and runtimes stay outside the Whisper CUDA tree', () => {
  const spec = catalog.getAdapterSpec(catalog.ADAPTERS.LINUX_CUDA);
  assert.equal(spec.artifactRevision, catalog.ONNX_MODEL_REVISION);
  assert.equal(Object.isFrozen(spec.lock.model), true);
  assert.throws(() => {
    spec.lock.model.revision = 'changed';
  });
  assert.equal(spec.runtimeRelativeDir.startsWith('ai-addons/runtimes/parakeet/'), true);
  assert.equal(spec.runtimeRelativeDir.includes(catalog.WHISPER_MANAGED_CUDA_ROOT), false);
  assert.equal(spec.modelRelativeDir, `ai-addons/models/transcription/parakeet/${catalog.ONNX_MODEL_REVISION}`);
});

test('stored Parakeet resume requires the exact adapter and lock', () => {
  const current = resolver.resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, LINUX).request;
  assert.equal(resolver.validateStoredRequest(current, LINUX).ok, true);
  assert.equal(resolver.validateStoredRequest({ ...current, runtimeLockId: '0'.repeat(64) }, LINUX).code, 'PARAKEET_SELECTION_UNAVAILABLE');
  assert.equal(resolver.validateStoredRequest({ ...current, adapterId: catalog.ADAPTERS.MACOS_METAL }, LINUX).code, 'PARAKEET_SELECTION_UNAVAILABLE');
});

test('admission never substitutes CPU or Whisper', () => {
  const request = resolver.resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, LINUX).request;
  assert.equal(resolver.evaluateParakeetAdmission(request, { installed: false }).code, 'PARAKEET_NOT_INSTALLED');
  assert.equal(resolver.evaluateParakeetAdmission(request, {
    installed: true,
    artifactValid: true,
    runtimeValid: true,
    deviceAvailable: true,
    device: 'cpu',
  }).code, 'PARAKEET_GPU_UNAVAILABLE');
  assert.equal(resolver.evaluateParakeetAdmission(request, {
    installed: true,
    artifactValid: true,
    runtimeValid: true,
    deviceAvailable: true,
    device: 'cuda',
  }).ok, true);
});
