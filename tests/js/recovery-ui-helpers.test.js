'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FINISHING_RECORDING_LABEL,
  RECOVERING_BANNER_LABEL,
  getRecoveryPromptView,
  getRecoveryBannerView,
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
