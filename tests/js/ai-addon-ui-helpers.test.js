'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAiAddonProgressPhase,
  isAiAddonTerminalStatus,
} = require('../../src/renderer/ai-addon-ui-helpers');

test('isAiAddonTerminalStatus recognizes terminal statuses', () => {
  assert.equal(isAiAddonTerminalStatus('ready'), true);
  assert.equal(isAiAddonTerminalStatus('error'), true);
  assert.equal(isAiAddonTerminalStatus('notConfigured'), true);
  assert.equal(isAiAddonTerminalStatus('needsAccount'), true);
  assert.equal(isAiAddonTerminalStatus('unsupported'), true);
  assert.equal(isAiAddonTerminalStatus('downloading'), false);
  assert.equal(isAiAddonTerminalStatus('validating'), false);
});

test('isAiAddonProgressPhase recognizes active progress phases', () => {
  assert.equal(isAiAddonProgressPhase({ phase: 'downloading' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'downloading-runtime' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'downloading-dependencies' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'extracting-runtime' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'validating' }), true);
  assert.equal(isAiAddonProgressPhase({ phase: 'idle' }), false);
  assert.equal(isAiAddonProgressPhase(null), false);
});
