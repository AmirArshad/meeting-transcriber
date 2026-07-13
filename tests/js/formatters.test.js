'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatAiAddonProgressText,
  formatBytes,
  formatDate,
  formatElapsedDuration,
  formatRelativeDate,
  formatStatusLabel,
  formatTimestamp,
} = require('../../src/renderer/formatters');

test('formatTimestamp formats seconds as MM:SS', () => {
  assert.equal(formatTimestamp(65), '01:05');
  assert.equal(formatTimestamp(0), '00:00');
  assert.equal(formatTimestamp(125), '02:05');
});

test('formatElapsedDuration switches to hours after 60 minutes', () => {
  assert.equal(formatElapsedDuration(0), '00:00');
  assert.equal(formatElapsedDuration(3599), '59:59');
  assert.equal(formatElapsedDuration(3600), '1:00:00');
  assert.equal(formatElapsedDuration(33000), '9:10:00');
});

test('formatTimestamp stays unbounded MM:SS for transcript timestamps', () => {
  assert.equal(formatTimestamp(3600), '60:00');
  assert.equal(formatTimestamp(3661), '61:01');
});

test('formatDate formats locale short date-time', () => {
  const formatted = formatDate('2026-01-07T15:30:00.000Z');
  assert.match(formatted, /Jan/);
  assert.match(formatted, /7/);
});

test('formatRelativeDate returns relative labels and empty for invalid input', () => {
  assert.equal(formatRelativeDate('not-a-date'), '');
  assert.equal(formatRelativeDate(new Date().toISOString()), 'just now');
});

test('formatStatusLabel maps known statuses and falls back', () => {
  assert.equal(formatStatusLabel('ready'), 'Ready');
  assert.equal(formatStatusLabel('needsAccount'), 'Needs account');
  assert.equal(formatStatusLabel('nope'), 'Unknown');
});

test('formatBytes formats byte sizes', () => {
  assert.equal(formatBytes(0), '0 MB');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5 MB');
});

test('formatAiAddonProgressText includes percent and byte progress', () => {
  assert.equal(
    formatAiAddonProgressText({ message: 'Downloading', percent: 42 }),
    'Downloading 42%',
  );
  assert.match(
    formatAiAddonProgressText({
      message: 'Downloading',
      downloadedBytes: 1024,
      totalBytes: 2048,
      percent: 50,
    }),
    /Downloading 1 KB of 2 KB \(50%\)/,
  );
  assert.equal(formatAiAddonProgressText({}), 'Working...');
});
