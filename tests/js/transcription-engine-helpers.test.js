'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../src/transcription-policy');

let helpers = null;
try {
  helpers = require('../../src/renderer/transcription-engine-helpers');
} catch (_error) {
  // Keep the missing implementation as an assertion failure in the test body.
}

function requireHelpers() {
  assert.ok(helpers, 'transcription-engine-helpers should be available');
  return helpers;
}

test('legacy preferences migrate once into independent Whisper preferences with Whisper active', () => {
  const { normalizeTranscriptionEnginePreferences } = requireHelpers();
  const result = normalizeTranscriptionEnginePreferences({ language: 'de', modelSize: 'medium' }, policy);

  assert.deepEqual(result.preferences, {
    schemaVersion: 1,
    activeEngine: 'whisper',
    whisper: { language: 'de', modelSize: 'medium' },
  });
  assert.equal(result.shouldPersist, true);
  assert.equal(result.requiresChoice, false);
  const reloaded = normalizeTranscriptionEnginePreferences(result.preferences, policy);
  assert.equal(reloaded.shouldPersist, false);
  assert.deepEqual(reloaded.preferences, result.preferences);
});

test('migration keeps a retired Whisper language pending a replacement across app restarts', () => {
  const { normalizeTranscriptionEnginePreferences, snapshotTranscriptionSelection, updateTranscriptionEnginePreferences } = requireHelpers();
  const result = normalizeTranscriptionEnginePreferences({ language: 'fa', modelSize: 'medium' }, policy);

  assert.equal(result.preferences.activeEngine, 'whisper');
  assert.equal(result.preferences.whisper.language, 'fa');
  assert.equal(result.requiresChoice, true);
  assert.deepEqual(snapshotTranscriptionSelection(result.preferences), {
    engine: 'whisper', language: 'fa', modelSize: 'medium',
  });
  assert.equal(policy.validateNewSelection(snapshotTranscriptionSelection(result.preferences)).ok, false);

  const reloaded = normalizeTranscriptionEnginePreferences(result.preferences, policy);
  assert.equal(reloaded.preferences.whisper.language, 'fa');
  assert.equal(reloaded.requiresChoice, true);
  assert.equal(reloaded.shouldPersist, false);

  const modelUpdated = updateTranscriptionEnginePreferences(result.preferences, {
    whisper: { modelSize: 'small' },
  });
  assert.equal(modelUpdated.whisper.language, 'fa');
});

test('versioned preferences preserve Parakeet activation and keep Whisper changes independent', () => {
  const { normalizeTranscriptionEnginePreferences, updateTranscriptionEnginePreferences } = requireHelpers();
  const source = {
    schemaVersion: 1,
    activeEngine: 'parakeet',
    whisper: { language: 'fr', modelSize: 'small' },
  };
  const migrated = normalizeTranscriptionEnginePreferences(source, policy);
  const updated = updateTranscriptionEnginePreferences(migrated.preferences, {
    whisper: { language: 'ja', modelSize: 'medium' },
  });

  assert.equal(migrated.shouldPersist, false);
  assert.equal(updated.activeEngine, 'parakeet');
  assert.deepEqual(updated.whisper, { language: 'ja', modelSize: 'medium' });
  assert.deepEqual(source.whisper, { language: 'fr', modelSize: 'small' });
});

test('recording selection snapshots one engine and does not change with later Settings edits', () => {
  const { snapshotTranscriptionSelection, updateTranscriptionEnginePreferences } = requireHelpers();
  const preferences = {
    schemaVersion: 1,
    activeEngine: 'parakeet',
    whisper: { language: 'fr', modelSize: 'medium' },
  };
  const captured = snapshotTranscriptionSelection(preferences);
  const changed = updateTranscriptionEnginePreferences(preferences, {
    activeEngine: 'whisper',
    whisper: { language: 'de', modelSize: 'small' },
  });

  assert.deepEqual(captured, { engine: 'parakeet', language: 'en' });
  assert.equal(changed.activeEngine, 'whisper');
  assert.deepEqual(changed.whisper, { language: 'de', modelSize: 'small' });
  assert.deepEqual(captured, { engine: 'parakeet', language: 'en' });

  assert.deepEqual(snapshotTranscriptionSelection(changed), {
    engine: 'whisper', language: 'de', modelSize: 'small',
  });
});

test('ordinary retry has no Settings payload; Whisper retry carries an explicit new selection', () => {
  const { buildOrdinaryRetryOptions, buildWhisperRetryOptions } = requireHelpers();

  assert.deepEqual(buildOrdinaryRetryOptions('meeting-1', {
    activeEngine: 'parakeet', whisper: { language: 'fr', modelSize: 'medium' },
  }), { meetingId: 'meeting-1' });
  assert.deepEqual(buildWhisperRetryOptions('meeting-1', {
    language: 'ja', modelSize: 'medium',
  }), {
    meetingId: 'meeting-1',
    transcriptionSelection: { engine: 'whisper', language: 'ja', modelSize: 'medium' },
  });
});

test('setup cancellation targets only its operation ID', () => {
  const { buildSetupCancellationOptions } = requireHelpers();
  assert.deepEqual(buildSetupCancellationOptions('operation-7'), { operationId: 'operation-7' });
});

test('Parakeet settings view covers all documented setup and removal states', () => {
  const { buildParakeetSettingsView } = requireHelpers();
  const states = [
    [{ status: 'checking' }, 'checking', []],
    [{ status: 'unsupported', message: 'Requires Apple Silicon macOS 14 or newer.' }, 'unsupported', []],
    [{ status: 'device-unavailable', installed: true }, 'device-unavailable', ['recheck', 'repair', 'remove']],
    [{ status: 'not-installed', downloadBytes: 1234 }, 'not-installed', ['setup']],
    [{ status: 'ready' }, 'ready', ['use-parakeet', 'validate', 'repair', 'remove']],
    [{ status: 'repair-required', message: 'A pinned runtime file is missing.' }, 'repair-required', ['repair', 'remove']],
  ];

  for (const [status, expectedState, expectedActions] of states) {
    const view = buildParakeetSettingsView({ status, activeEngine: 'whisper' });
    assert.equal(view.state, expectedState);
    for (const action of expectedActions) {
      assert.ok(view.actions.includes(action), `${expectedState} should offer ${action}`);
    }
  }

  const checking = buildParakeetSettingsView({ status: { status: 'checking' } });
  assert.match(checking.statusText, /Checking Parakeet/);
  assert.equal(buildParakeetSettingsView({
    status: { status: 'checking' }, activeEngine: 'parakeet',
  }).activeUnavailable, false);
  const unsupported = buildParakeetSettingsView({ status: states[1][0] });
  assert.match(unsupported.statusText, /Apple Silicon macOS 14/);
  const notInstalled = buildParakeetSettingsView({ status: states[3][0] });
  assert.equal(notInstalled.downloadBytes, 1234);
});

test('download, verification, validation wait, validation, and removal expose the right progress actions', () => {
  const { buildParakeetSettingsView } = requireHelpers();
  const cases = [
    [{ phase: 'downloading', downloadedBytes: 25, totalBytes: 100 }, 'downloading', 25],
    [{ phase: 'verifying', downloadedBytes: 100, totalBytes: 100 }, 'verifying', null],
    [{ phase: 'waiting-for-validation' }, 'waiting-for-validation', null],
    [{ phase: 'validating' }, 'validating', null],
  ];

  for (const [progress, state, percent] of cases) {
    const view = buildParakeetSettingsView({
      status: { status: 'not-installed' },
      activeEngine: 'whisper',
      operation: 'install',
      progress,
    });
    assert.equal(view.state, state);
    assert.ok(view.actions.includes('cancel'));
    assert.equal(view.progressPercent, percent);
  }

  const validating = buildParakeetSettingsView({
    status: { status: 'ready' }, activeEngine: 'whisper', operation: 'validate',
  });
  assert.equal(validating.state, 'validating');
  assert.ok(validating.actions.includes('cancel'));

  const removing = buildParakeetSettingsView({
    status: { status: 'ready' }, activeEngine: 'parakeet', operation: 'remove',
  });
  assert.equal(removing.state, 'removing');
  assert.deepEqual(removing.actions, []);
});

test('install does not activate Parakeet and removal leaves it selected until Use Whisper is explicit', () => {
  const { buildParakeetSettingsView } = requireHelpers();
  const preferences = {
    schemaVersion: 1,
    activeEngine: 'whisper',
    whisper: { language: 'en', modelSize: 'small' },
  };
  const afterInstall = buildParakeetSettingsView({
    status: { status: 'ready' }, activeEngine: preferences.activeEngine,
  });
  assert.equal(afterInstall.activeEngine, 'whisper');
  assert.ok(afterInstall.actions.includes('use-parakeet'));
  assert.equal(preferences.activeEngine, 'whisper');

  const afterRemoval = buildParakeetSettingsView({
    status: { status: 'not-installed' }, activeEngine: 'parakeet',
  });
  assert.equal(afterRemoval.activeEngine, 'parakeet');
  assert.equal(afterRemoval.activeUnavailable, true);
  assert.ok(afterRemoval.actions.includes('use-whisper'));
  assert.ok(!afterRemoval.actions.includes('use-parakeet'));
});

test('ready activation is explicit and device-unavailable Parakeet keeps recovery and Whisper available', () => {
  const { buildParakeetSettingsView } = requireHelpers();
  const ready = buildParakeetSettingsView({
    status: { status: 'ready' }, activeEngine: 'whisper',
  });
  assert.ok(ready.actions.includes('use-parakeet'));
  assert.equal(ready.activeEngine, 'whisper');

  const unavailable = buildParakeetSettingsView({
    status: { status: 'device-unavailable', installed: true }, activeEngine: 'parakeet',
  });
  assert.equal(unavailable.activeEngine, 'parakeet');
  assert.equal(unavailable.activeUnavailable, true);
  assert.ok(unavailable.actions.includes('use-whisper'));
  assert.ok(unavailable.actions.includes('recheck'));
});
