'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../../src/transcription-policy');

test('selectable lists exclude Persian, Tiny, Base and unqualified Large', () => {
  assert.deepEqual([...policy.SELECTABLE_LANGUAGES], ['en', 'es', 'fr', 'de', 'zh', 'ja', 'it', 'pa', 'hi', 'ko', 'pt']);
  assert.ok(!policy.SELECTABLE_LANGUAGES.includes('fa'));
  assert.deepEqual([...policy.SELECTABLE_MODEL_SIZES], ['small', 'medium']);
  assert.ok(!policy.SELECTABLE_MODEL_SIZES.includes('tiny'));
  assert.ok(!policy.SELECTABLE_MODEL_SIZES.includes('base'));
  assert.ok(!policy.SELECTABLE_MODEL_SIZES.includes('large-v3'));
});

test('legacy compatibility retains pending-job values', () => {
  assert.equal(policy.isCompatibleLanguage('fa'), true);
  assert.equal(policy.isCompatibleModelSize('tiny'), true);
  assert.equal(policy.isCompatibleModelSize('base'), true);
  assert.equal(policy.isCompatibleModelSize('large'), true);
  assert.equal(policy.isCompatibleModelSize('large-v3'), true);
  assert.equal(policy.isSelectableLanguage('fa'), false);
  assert.equal(policy.isSelectableModelSize('tiny'), false);
});

test('Tiny/Base migrate to Small once', () => {
  assert.deepEqual(policy.normalizePreferences({ language: 'en', modelSize: 'tiny' }), {
    language: 'en', modelSize: 'small', migrated: true, requiresChoice: false, normalizedLarge: false,
  });
  assert.deepEqual(policy.normalizePreferences({ language: 'en', modelSize: 'base' }), {
    language: 'en', modelSize: 'small', migrated: true, requiresChoice: false, normalizedLarge: false,
  });
});

test('saved large normalizes to canonical large-v3', () => {
  const result = policy.normalizePreferences({ language: 'en', modelSize: 'large' });
  assert.equal(result.modelSize, 'large-v3');
  assert.equal(result.normalizedLarge, true);
});

test('persisted canonical large-v3 stays gated via normalizedLarge', () => {
  const result = policy.normalizePreferences({ language: 'en', modelSize: 'large-v3' });
  assert.equal(result.modelSize, 'large-v3');
  assert.equal(result.normalizedLarge, true);
});

test('removed Persian requires choice instead of silent English', () => {
  const result = policy.normalizePreferences({ language: 'fa', modelSize: 'small' });
  assert.equal(result.requiresChoice, true);
  assert.equal(result.language, '');
  assert.equal(result.modelSize, 'small');
});

test('fresh profiles retain English/Small defaults', () => {
  const result = policy.normalizePreferences({});
  assert.equal(result.language, 'en');
  assert.equal(result.modelSize, 'small');
  assert.equal(result.requiresChoice, false);
});

test('new-selection validation rejects legacy and unknown values', () => {
  assert.equal(policy.validateNewSelection({ language: 'en', modelSize: 'small' }).ok, true);
  assert.equal(policy.validateNewSelection({ language: 'fa', modelSize: 'small' }).ok, false);
  assert.equal(policy.validateNewSelection({ language: 'en', modelSize: 'tiny' }).ok, false);
  assert.equal(policy.validateNewSelection({ language: 'en', modelSize: 'large-v3' }).ok, false);
  assert.equal(policy.validateNewSelection({ language: 'xx', modelSize: 'small' }).ok, false);
  assert.equal(policy.isSelectableModelSize('parakeet'), false);
  assert.equal(policy.validateNewSelection({ language: 'en', modelSize: 'parakeet' }).ok, false);
});

test('legacy preferences migrate to Whisper and do not activate Parakeet', () => {
  const migrated = policy.migrateEnginePreferences({ language: 'es', modelSize: 'medium' });
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.activeEngine, 'whisper');
  assert.deepEqual(migrated.whisper, { language: 'es', modelSize: 'medium' });
  assert.equal(migrated.migrated, true);
  assert.equal(policy.migrateEnginePreferences({ language: 'en', modelSize: 'small' }).activeEngine, 'whisper');
});

test('versioned Parakeet activation is preserved separately from Whisper settings', () => {
  const preserved = policy.migrateEnginePreferences({
    schemaVersion: 1,
    activeEngine: 'parakeet',
    whisper: { language: 'de', modelSize: 'small' },
  });
  assert.equal(preserved.activeEngine, 'parakeet');
  assert.equal(preserved.migrated, false);
  assert.deepEqual(preserved.whisper, { language: 'de', modelSize: 'small' });
});
