'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  roundedBar,
  writeSignalTrace,
} = require('../../src/renderer/canvas-helpers');

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.00001, `${message}: expected ${expected}, got ${actual}`);
}

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

test('writeSignalTrace keeps silence centered and maps full input to the complete signal shape', () => {
  const output = new Float32Array(8);

  const maxAmplitude = writeSignalTrace([0, 1, 1, 1, 1, 1, 1, 1], output);

  const expected = [0, -0.08, 0.18, 0, -0.16, 1, -0.5, 0.16];
  expected.forEach((value, index) => assertClose(output[index], value, `point ${index}`));
  assert.equal(maxAmplitude, 1);
});

test('writeSignalTrace advances its angular signal phase as history scrolls', () => {
  const output = new Float32Array(4);

  writeSignalTrace([1, 1, 1, 1], output, 1);

  [-0.08, 0.18, 0, -0.16]
    .forEach((value, index) => assertClose(output[index], value, `point ${index}`));
});

test('writeSignalTrace clamps invalid levels instead of drawing outside its lane', () => {
  const output = new Float32Array(3);

  const maxAmplitude = writeSignalTrace([4, -1, Number.NaN], output, 5);

  assertClose(output[0], 1, 'clamped loud point');
  assertClose(output[1], 0, 'negative point');
  assertClose(output[2], 0, 'invalid point');
  assert.equal(maxAmplitude, 1);
});
