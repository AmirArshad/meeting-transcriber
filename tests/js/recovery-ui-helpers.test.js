'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FINISHING_RECORDING_LABEL,
  RECOVERING_BANNER_LABEL,
  getRecoveryPromptView,
  getRecoveryBannerView,
  mergeClaimedPromptIntoState,
  resolveRecoveryFocusTrapAction,
} = require('../../src/renderer/recovery-ui-helpers');

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${bytes} B`;
}

const oneCandidate = {
  status: 'available',
  promptEligible: true,
  totals: { count: 1, approxBytes: 45 * 1024 * 1024 },
  candidates: [{
    outputStem: 'recording_a',
    startedAtIso: '2026-07-13T10:00:00.000Z',
    approxDurationSeconds: 45 * 60,
    approxBytes: 45 * 1024 * 1024,
    state: 'recording',
  }],
  activeCandidateIndex: null,
  failed: [],
};

test('recovering banner label stays distinct from stopping pill', () => {
  assert.notEqual(RECOVERING_BANNER_LABEL, FINISHING_RECORDING_LABEL);
  assert.match(RECOVERING_BANNER_LABEL, /Recovering interrupted recording/);
  assert.match(FINISHING_RECORDING_LABEL, /Finishing recording/);
});

test('prompt visible only when available and promptEligible', () => {
  const shown = getRecoveryPromptView(oneCandidate, formatBytes);
  assert.equal(shown.visible, true);
  assert.equal(shown.title, 'Finish an interrupted recording?');
  assert.match(shown.body, /a recording/);
  assert.match(shown.detail, /Interrupted recordings: 1/);
  assert.match(shown.detail, /45 MB/);
  assert.equal(shown.primaryLabel, 'Recover Now');
  assert.equal(shown.secondaryLabel, 'Later');

  const suppressed = getRecoveryPromptView({ ...oneCandidate, promptEligible: false }, formatBytes);
  assert.equal(suppressed.visible, false);

  const discovering = getRecoveryPromptView({ status: 'discovering', promptEligible: true, totals: { count: 1 } }, formatBytes);
  assert.equal(discovering.visible, false);
});

test('prompt plural copy uses totals.count', () => {
  const view = getRecoveryPromptView({
    ...oneCandidate,
    totals: { count: 2, approxBytes: 90 * 1024 * 1024 },
    candidates: [oneCandidate.candidates[0], oneCandidate.candidates[0]],
  }, formatBytes);
  assert.match(view.body, /2 recordings/);
  assert.match(view.detail, /Interrupted recordings: 2/);
});

test('prompt omits null candidate metadata rather than rendering undefined', () => {
  const view = getRecoveryPromptView({
    ...oneCandidate,
    candidates: [{
      outputStem: 'recording_a',
      startedAtIso: null,
      approxDurationSeconds: null,
      approxBytes: null,
      state: 'recording',
    }],
  }, formatBytes);
  assert.equal(view.candidateLines.length, 0);
  assert.doesNotMatch(JSON.stringify(view), /undefined/);
});

test('banner hidden while discovering or idle', () => {
  assert.equal(getRecoveryBannerView({ status: 'idle', totals: { count: 0 } }, 'idle', formatBytes).visible, false);
  assert.equal(getRecoveryBannerView({ status: 'discovering', totals: { count: 1 } }, 'idle', formatBytes).visible, false);
});

test('available banner shows count and size with Recover', () => {
  const view = getRecoveryBannerView(oneCandidate, 'idle', formatBytes);
  assert.equal(view.visible, true);
  assert.match(view.text, /1 interrupted recording/);
  assert.match(view.text, /45 MB/);
  assert.equal(view.primaryAction, 'Recover');
  assert.equal(view.showSpinner, false);
});

test('available banner pluralizes from count', () => {
  const view = getRecoveryBannerView({
    ...oneCandidate,
    totals: { count: 2, approxBytes: 90 * 1024 * 1024 },
  }, { state: 'idle' }, formatBytes);
  assert.match(view.text, /2 interrupted recordings/);
});

test('banner hidden while capture state is not idle', () => {
  for (const capture of ['starting', 'recording', 'stopping']) {
    const view = getRecoveryBannerView(oneCandidate, capture, formatBytes);
    assert.equal(view.visible, false, `expected hidden for ${capture}`);
  }
});

test('banner remains visible during transcription', () => {
  const view = getRecoveryBannerView(oneCandidate, 'transcribing', formatBytes);
  assert.equal(view.visible, true);
  assert.equal(view.primaryAction, 'Recover');
});

test('scan-import-only error uses History copy', () => {
  const view = getRecoveryBannerView({
    status: 'error',
    totals: { count: 1, approxBytes: null },
    candidates: [],
    failed: [{ candidateIndex: null, code: 'SCAN_IMPORT_FAILED', message: 'x' }],
    scanImportPending: true,
    lastSuccessCount: 1,
    lastBatchSize: 1,
  }, 'idle', formatBytes);
  assert.equal(view.visible, true);
  assert.match(view.text, /History/);
  assert.doesNotMatch(view.text, /Couldn't finish recovering/);
});

test('candidate size renders alongside other fields', () => {
  const view = getRecoveryPromptView({
    ...oneCandidate,
    promptEligible: true,
    candidates: [{
      startedAtIso: '2026-07-13T10:00:00.000Z',
      approxDurationSeconds: 90,
      approxBytes: 5 * 1024 * 1024,
    }],
  }, formatBytes);
  assert.ok(view.candidateLines.some((line) => /MB|MiB|B/.test(line)));
});

test('recovering banner shows spinner and progress index', () => {
  const view = getRecoveryBannerView({
    status: 'recovering',
    totals: { count: 2, approxBytes: 10 },
    activeCandidateIndex: 0,
    candidates: [{}, {}],
    failed: [],
  }, 'idle', formatBytes);
  assert.equal(view.visible, true);
  assert.equal(view.showSpinner, true);
  assert.match(view.text, /Recovering interrupted recording… \(1 of 2\)/);
  assert.equal(view.primaryAction, null);
});

test('error banner full failure copy', () => {
  const view = getRecoveryBannerView({
    status: 'error',
    totals: { count: 1, approxBytes: 10 },
    candidates: [{}],
    failed: [{ candidateIndex: 0, code: 'RECOVERY_FAILED', message: 'x' }],
  }, 'idle', formatBytes);
  assert.equal(view.visible, true);
  assert.match(view.text, /Couldn't finish recovering/);
  assert.equal(view.primaryAction, 'Retry');
  assert.equal(view.secondaryAction, 'Dismiss');
});

test('error banner partial-failure copy distinguishes finished vs remaining', () => {
  const view = getRecoveryBannerView({
    status: 'error',
    totals: { count: 1, approxBytes: 10 },
    candidates: [{}],
    failed: [{ candidateIndex: 0, code: 'RECOVERY_FAILED', message: 'x' }],
    lastBatchSize: 2,
    lastSuccessCount: 1,
  }, 'idle', formatBytes);
  assert.match(view.text, /1 of 2 recordings was finished/);
  assert.match(view.text, /1 still needs another try/);
  assert.match(view.text, /kept safe/);
});

test('available banner with scanImportPending stays visible without candidates', () => {
  const view = getRecoveryBannerView({
    status: 'available',
    promptEligible: false,
    totals: { count: 1, approxBytes: null },
    candidates: [],
    failed: [],
    scanImportPending: true,
  }, 'idle', formatBytes);
  assert.equal(view.visible, true);
  assert.match(view.text, /still need to be added to History/);
  assert.equal(view.primaryAction, 'Recover');
});

test('prompt omits unknown disk usage instead of showing 0 MB', () => {
  const view = getRecoveryPromptView({
    ...oneCandidate,
    totals: { count: 1, approxBytes: null },
  }, formatBytes);
  assert.equal(view.visible, true);
  assert.doesNotMatch(view.detail, /0 MB/);
  assert.match(view.detail, /Interrupted recordings: 1$/);
});

test('mergeClaimedPromptIntoState preserves prompt across refresh while available', () => {
  const claimed = mergeClaimedPromptIntoState({
    status: 'available',
    promptEligible: false,
    totals: { count: 1 },
  }, true);
  assert.equal(claimed.promptEligible, true);

  const idle = mergeClaimedPromptIntoState({
    status: 'idle',
    promptEligible: false,
  }, true);
  assert.equal(idle.promptEligible, false);
});

test('resolveRecoveryFocusTrapAction cycles Tab and Shift+Tab', () => {
  assert.deepEqual(
    resolveRecoveryFocusTrapAction(2, 1, false),
    { preventDefault: true, focusIndex: 0 },
  );
  assert.deepEqual(
    resolveRecoveryFocusTrapAction(2, 0, true),
    { preventDefault: true, focusIndex: 1 },
  );
  assert.deepEqual(
    resolveRecoveryFocusTrapAction(2, 0, false),
    { preventDefault: false, focusIndex: null },
  );
  assert.deepEqual(
    resolveRecoveryFocusTrapAction(0, -1, false),
    { preventDefault: true, focusIndex: null },
  );
});
