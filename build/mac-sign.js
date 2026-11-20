'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');

const {
  writeSpeakrsPackagedIntegrityManifest,
} = require('./prepare-resources');
const {
  inspectPackagedSpeakrsLayout,
} = require('../src/ai-addon/speakrs-cli-integrity');

const execFileAsync = promisify(execFile);

/**
 * Build arguments to re-seal only the top-level macOS .app bundle after
 * updating Contents/Resources/bin/speakrs-integrity.json post-codesign.
 * Intentionally omits --deep so signed nested helpers/dylibs keep their seals
 * and per-component entitlements intact.
 *
 * @param {object} opts
 * @param {Function} [opts.optionsForFile]
 * @returns {string[]}
 */
function buildOuterBundleResealArgs(opts) {
  if (!opts || typeof opts.app !== 'string' || !opts.app) {
    throw new Error('buildOuterBundleResealArgs: opts.app path is required');
  }
  const identity = typeof opts.identity === 'string' && opts.identity.trim()
    ? opts.identity.trim()
    : '-';

  const perFileOptions = typeof opts.optionsForFile === 'function'
    ? (opts.optionsForFile(opts.app) || {})
    : {};

  const args = ['--sign', identity, '--force'];
  if (opts.keychain) {
    args.push('--keychain', opts.keychain);
  }

  if (perFileOptions.requirements) {
    if (perFileOptions.requirements.charAt(0) === '=') {
      args.push(`-r${perFileOptions.requirements}`);
    } else {
      args.push('--requirements', perFileOptions.requirements);
    }
  }

  if (perFileOptions.timestamp) {
    args.push(`--timestamp=${perFileOptions.timestamp}`);
  } else if (identity !== '-') {
    args.push('--timestamp');
  }

  const signatureFlags = [];
  if (Array.isArray(perFileOptions.signatureFlags)) {
    signatureFlags.push(...perFileOptions.signatureFlags);
  } else if (typeof perFileOptions.signatureFlags === 'string' && perFileOptions.signatureFlags.trim()) {
    signatureFlags.push(...perFileOptions.signatureFlags.split(',').map((flag) => flag.trim()).filter(Boolean));
  }
  if (perFileOptions.hardenedRuntime) {
    signatureFlags.push('runtime');
  }
  if (signatureFlags.length > 0) {
    args.push('--options', [...new Set(signatureFlags)].join(','));
  }

  if (Array.isArray(perFileOptions.additionalArguments) && perFileOptions.additionalArguments.length > 0) {
    args.push(...perFileOptions.additionalArguments);
  }

  const entitlements = perFileOptions.entitlements || opts.entitlements;
  if (entitlements) {
    args.push('--entitlements', entitlements);
  }

  args.push(opts.app);
  return args;
}

/**
 * Recompute Contents/Resources/bin/speakrs-integrity.json for the signed
 * darwin arm64 speakrs-cli binary without mutating any Mach-O executable.
 *
 * @param {string} appPath
 * @returns {{ manifestPath: string, resourcesPath: string }}
 */
function refreshMacOSSpeakrsIntegrity(appPath) {
  if (!appPath || typeof appPath !== 'string') {
    throw new Error('refreshMacOSSpeakrsIntegrity: appPath is required');
  }
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const binDir = path.join(resourcesPath, 'bin');
  const manifestPath = writeSpeakrsPackagedIntegrityManifest(binDir, 'darwin');
  const inspection = inspectPackagedSpeakrsLayout({
    platform: 'darwin',
    resourcesPath,
  });
  if (!inspection.ok) {
    throw new Error(
      `refreshMacOSSpeakrsIntegrity: packaged darwin Speakrs check failed (${inspection.kind}): ${inspection.reason}`,
    );
  }
  return { manifestPath, resourcesPath };
}

async function runWithRetry(fn, { retries = 3, delayMs = 5000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

/**
 * Custom electron-builder mac.sign hook:
 * 1. Signs the .app and nested binaries/frameworks via @electron/osx-sign.
 * 2. Refreshes Contents/Resources/bin/speakrs-integrity.json against the signed speakrs-cli.
 * 3. Re-seals only the outer .app bundle so CodeResources covers the updated manifest
 *    before electron-builder invokes notarization.
 *
 * @param {object} opts
 */
async function sign(opts) {
  const osxSign = await import('@electron/osx-sign');
  const signAsync = osxSign.signAsync || (osxSign.default && osxSign.default.signAsync);
  if (typeof signAsync !== 'function') {
    throw new Error('mac-sign: @electron/osx-sign signAsync export is unavailable');
  }
  await runWithRetry(() => signAsync(opts));

  refreshMacOSSpeakrsIntegrity(opts.app);

  const resealArgs = buildOuterBundleResealArgs(opts);
  await execFileAsync('codesign', resealArgs, { maxBuffer: 1024 * 1024 * 16 });
  await execFileAsync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', opts.app], {
    maxBuffer: 1024 * 1024 * 16,
  });

  const inspection = inspectPackagedSpeakrsLayout({
    platform: 'darwin',
    resourcesPath: path.join(opts.app, 'Contents', 'Resources'),
  });
  if (!inspection.ok) {
    throw new Error(
      `mac-sign: post-reseal Speakrs integrity check failed (${inspection.kind}): ${inspection.reason}`,
    );
  }
}

module.exports = Object.assign(sign, {
  buildOuterBundleResealArgs,
  default: sign,
  refreshMacOSSpeakrsIntegrity,
  sign,
});
