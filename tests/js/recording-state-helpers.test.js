const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getRecordButtonAction,
} = require('../../src/renderer/recording-state-helpers');


test('getRecordButtonAction starts from idle', () => {
  assert.equal(getRecordButtonAction('idle'), 'start');
});


test('getRecordButtonAction stops from recording', () => {
  assert.equal(getRecordButtonAction('recording'), 'stop');
});


test('getRecordButtonAction ignores busy renderer states', () => {
  for (const state of ['initializing', 'countdown', 'stopping', 'transcribing']) {
    assert.equal(getRecordButtonAction(state), 'ignore');
  }
});
