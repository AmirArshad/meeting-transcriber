#!/usr/bin/env node
/**
 * Remove dist/ before prepare-build. Packaged apps and open Explorer windows
 * often lock files (app.asar on Windows, .app bundle on macOS).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIST_DIR = path.join(__dirname, '..', 'dist');
const IS_WIN = process.platform === 'win32';
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

function removePath(targetPath) {
  fs.rmSync(targetPath, RM_OPTIONS);
}

function stopPackagedAppBestEffort() {
  if (!IS_WIN) {
    return;
  }

  for (const image of ['AvaNevis.exe', 'Meeting Transcriber.exe']) {
    spawnSync('taskkill', ['/F', '/IM', image], { stdio: 'ignore', timeout: 3000 });
  }
}

function getDistCleanHints(lastError) {
  const detail = lastError?.message ? `\n\nOriginal error: ${lastError.message}` : '';

  if (IS_WIN) {
    return [
      'Could not remove dist/. On Windows a file inside dist\\ is usually locked:',
      '  - Quit AvaNevis.exe from Task Manager (dist\\win-unpacked\\AvaNevis.exe)',
      '  - Close File Explorer windows showing dist\\',
      '  - If the error mentions app.asar, close any editor tab or tool holding that file',
      '  - Then run: Remove-Item -Recurse -Force dist',
      '  - Or: $env:AVANEVIS_CLEAN_KILL=1; npm run clean',
      '  - Last resort (stale lock): $env:AVANEVIS_SKIP_DIST_CLEAN=1; npm run prepare-build',
    ].join('\n') + detail;
  }

  return [
    'Could not remove dist/. Common causes on macOS:',
    '  - Quit AvaNevis if it is running from dist/mac-arm64/AvaNevis.app',
    '  - Close Finder windows showing dist/',
    '  - Then run: rm -rf dist',
  ].join('\n') + detail;
}

function cleanDist() {
  if (!fs.existsSync(DIST_DIR)) {
    return;
  }

  if (process.env.AVANEVIS_SKIP_DIST_CLEAN === '1') {
    console.warn('AVANEVIS_SKIP_DIST_CLEAN=1: leaving existing dist/ in place');
    return;
  }

  if (process.env.AVANEVIS_CLEAN_KILL === '1') {
    stopPackagedAppBestEffort();
  }

  try {
    removePath(DIST_DIR);
    console.log('Cleaned dist/');
    return;
  } catch (firstError) {
    const retryable = ['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES'].includes(firstError.code);
    if (!retryable) {
      throw firstError;
    }
  }

  if (process.env.AVANEVIS_CLEAN_KILL !== '1') {
    stopPackagedAppBestEffort();
    try {
      removePath(DIST_DIR);
      console.log('Cleaned dist/');
      return;
    } catch (retryError) {
      // Fall through to rename attempt.
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
    const error = new Error(getDistCleanHints(renameError));
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
