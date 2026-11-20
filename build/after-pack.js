'use strict';

const path = require('node:path');
const {
  writeSpeakrsPackagedIntegrityManifest,
} = require('./prepare-resources');
const {
  inspectPackagedSpeakrsLayout,
} = require('../src/ai-addon/speakrs-cli-integrity');

/**
 * Refresh the packaged Windows Speakrs integrity manifest after
 * WinPackager's extraResources transformer Authenticode-signs
 * resources/bin/speakrs-cli.exe and before NSIS builds the installer.
 * No-op on Linux and macOS (macOS refreshes after codesign inside build/mac-sign.js).
 *
 * @param {import('app-builder-lib').AfterPackContext} context
 */
async function afterPack(context) {
  const platformName = context && context.electronPlatformName;
  if (platformName !== 'win32') {
    return null;
  }

  const appOutDir = context && context.appOutDir;
  if (!appOutDir || typeof appOutDir !== 'string') {
    throw new Error('afterPack: context.appOutDir is required for win32 Speakrs integrity refresh');
  }

  const resourcesPath = path.join(appOutDir, 'resources');
  const binDir = path.join(resourcesPath, 'bin');
  const manifestPath = writeSpeakrsPackagedIntegrityManifest(binDir, 'win32');
  const inspection = inspectPackagedSpeakrsLayout({
    platform: 'win32',
    resourcesPath,
  });
  if (!inspection.ok) {
    throw new Error(
      `afterPack: packaged win32 Speakrs integrity check failed (${inspection.kind}): ${inspection.reason}`,
    );
  }
  return manifestPath;
}

module.exports = Object.assign(afterPack, {
  afterPack,
  default: afterPack,
});
