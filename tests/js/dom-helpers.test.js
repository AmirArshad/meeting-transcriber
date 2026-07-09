'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { clearElement } = require('../../src/renderer/dom-helpers');

test('clearElement replaces children on an injected element', () => {
  const removed = [];
  const element = {
    replaceChildren(...nodes) {
      removed.push(nodes);
    },
  };

  clearElement(element);
  assert.deepEqual(removed, [[]]);
});
