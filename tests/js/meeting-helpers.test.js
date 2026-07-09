'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { meetingIdsEqual } = require('../../src/renderer/meeting-helpers');

test('meetingIdsEqual compares stringified ids and rejects nullish', () => {
  assert.equal(meetingIdsEqual('a', 'a'), true);
  assert.equal(meetingIdsEqual(1, '1'), true);
  assert.equal(meetingIdsEqual('a', 'b'), false);
  assert.equal(meetingIdsEqual(null, 'a'), false);
  assert.equal(meetingIdsEqual('a', undefined), false);
  assert.equal(meetingIdsEqual(null, null), false);
});
