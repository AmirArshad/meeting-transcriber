'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { roundedBar } = require('../../src/renderer/canvas-helpers');

test('roundedBar draws a closed rounded rectangle path on the injected ctx', () => {
  const calls = [];
  const ctx = {
    moveTo(...args) { calls.push(['moveTo', ...args]); },
    lineTo(...args) { calls.push(['lineTo', ...args]); },
    quadraticCurveTo(...args) { calls.push(['quadraticCurveTo', ...args]); },
    closePath(...args) { calls.push(['closePath', ...args]); },
  };

  roundedBar(ctx, 10, 20, 40, 8, 4);

  assert.equal(calls[0][0], 'moveTo');
  assert.equal(calls[calls.length - 1][0], 'closePath');
  assert.ok(calls.some((call) => call[0] === 'quadraticCurveTo'));
});
