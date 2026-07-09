'use strict';

/**
 * Recursively syntax-check every .js file under src/ (including src/renderer/).
 * Replaces the hardcoded package.json test:syntax file list so new entry files
 * cannot silently drift out of coverage (Phase 0.0).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(ROOT, 'src');

function collectJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) {
    return out;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(fullPath);
    }
  }

  return out;
}

const files = collectJsFiles(SRC_ROOT).sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  console.error(`No JavaScript files found under ${SRC_ROOT}`);
  process.exit(1);
}

const requiredRelative = [
  'src/renderer/recording-state-helpers.js',
  'src/renderer/update-notification-helpers.js',
  'src/renderer/history-detail-helpers.js',
];

const relativeFiles = files.map((filePath) => path.relative(ROOT, filePath).split(path.sep).join('/'));
for (const required of requiredRelative) {
  if (!relativeFiles.includes(required)) {
    console.error(`Syntax glob missed required file: ${required}`);
    process.exit(1);
  }
}

let failed = 0;
for (const filePath of files) {
  const result = spawnSync(process.execPath, ['--check', filePath], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    failed += 1;
    const relative = path.relative(ROOT, filePath).split(path.sep).join('/');
    process.stderr.write(`Syntax check failed: ${relative}\n`);
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (result.stdout) {
      process.stderr.write(result.stdout);
    }
  }
}

if (failed > 0) {
  console.error(`node --check failed for ${failed} file(s) under src/`);
  process.exit(1);
}

console.log(`Checked ${files.length} JavaScript file(s) under src/`);
