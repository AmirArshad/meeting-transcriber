#!/usr/bin/env node
/**
 * Remove dist/ before prepare-build. macOS often returns ENOTEMPTY when the
 * packaged .app is still running or a directory handle is open in Finder.
 */

const fs = require('fs');
const path = require('path');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 8, retryDelay: 250 };

function removePath(targetPath) {
  fs.rmSync(targetPath, RM_OPTIONS);
}

function cleanDist() {
  if (!fs.existsSync(DIST_DIR)) {
    return;
  }

  try {
    removePath(DIST_DIR);
    console.log('Cleaned dist/');
    return;
  } catch (firstError) {
    if (firstError.code !== 'ENOTEMPTY' && firstError.code !== 'EBUSY' && firstError.code !== 'EPERM') {
      throw firstError;
    }
  }

  const stalePath = `${DIST_DIR}.stale-${process.pid}`;
  try {
    if (fs.existsSync(stalePath)) {
      removePath(stalePath);
    }
    fs.renameSync(DIST_DIR, stalePath);
    removePath(stalePath);
    console.log('Cleaned dist/ (renamed stale bundle first)');
    return;
  } catch (renameError) {
    const hint = [
      'Could not remove dist/. Common causes on macOS:',
      '  - Quit AvaNevis if it is running from dist/mac-arm64/AvaNevis.app',
      '  - Close Finder windows showing dist/',
      '  - Then run: rm -rf dist',
    ].join('\n');
    const error = new Error(`${hint}\n\nOriginal error: ${renameError.message}`);
    error.cause = renameError;
    throw error;
  }
}

try {
  cleanDist();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
