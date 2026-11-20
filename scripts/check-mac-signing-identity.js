#!/usr/bin/env node
'use strict';

/**
 * Guard against silently ad-hoc signing a build that has a real certificate.
 *
 * Gate B (issue #76) was caused by electron-builder skipping signing when no
 * identity was found, which shipped a linker-signed app that failed Gatekeeper.
 * The fix pinned `build.mac.identity: "-"` so certificate-less builds produce a
 * complete ad-hoc seal.
 *
 * That pin is now itself a footgun: an explicit `identity` takes precedence
 * over CSC_LINK / keychain discovery, so the first Developer ID build after
 * enrollment would still be ad-hoc signed — the same failure class, silently.
 * Fail the build instead, and tell the operator how to override.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const AD_HOC_IDENTITY = '-';

const SIGNING_CREDENTIAL_ENV_KEYS = Object.freeze([
  'CSC_LINK',
  'CSC_NAME',
  'CSC_KEY_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLEID',
  'APPLE_API_KEY',
]);

function isStrictSignedRelease(env = {}) {
  const raw = String(env.AVANEVIS_REQUIRE_SIGNED_RELEASE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}

function evaluateNotarizationCredentials(env = {}) {
  const appleId = nonEmpty(env.APPLE_ID);
  const applePassword = nonEmpty(env.APPLE_APP_SPECIFIC_PASSWORD);
  const appleTeamId = nonEmpty(env.APPLE_TEAM_ID);
  const anyAppleId = Boolean(appleId || applePassword);
  const fullAppleId = Boolean(appleId && applePassword && appleTeamId);

  const apiKey = nonEmpty(env.APPLE_API_KEY);
  const apiKeyId = nonEmpty(env.APPLE_API_KEY_ID);
  const apiIssuer = nonEmpty(env.APPLE_API_ISSUER);
  const anyApiKey = Boolean(apiKey || apiKeyId || apiIssuer);
  const fullApiKey = Boolean(apiKey && apiKeyId && apiIssuer);

  const keychainProfile = nonEmpty(env.APPLE_KEYCHAIN_PROFILE);

  if (anyAppleId && !fullAppleId && !fullApiKey && !keychainProfile) {
    return {
      ok: false,
      configured: false,
      reason: 'Partial Apple ID notarization credentials set; require APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID.',
    };
  }

  if (anyApiKey && !fullApiKey && !fullAppleId && !keychainProfile) {
    return {
      ok: false,
      configured: false,
      reason: 'Partial App Store Connect API notarization credentials set; require APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER.',
    };
  }

  return {
    ok: true,
    configured: Boolean(fullAppleId || fullApiKey || keychainProfile),
    reason: null,
  };
}

/**
 * Pure decision helper (unit-tested).
 *
 * @param {object} params
 * @param {string|undefined} params.identity - build.mac.identity from package.json
 * @param {Record<string, string|undefined>} params.env
 * @param {boolean} [params.allowManagedOverride=false] - true when invoked via build:mac preflight/--run
 * @returns {{ ok: boolean, reason: string|null, credentials: string[], mode: string, builderArgs: string[] }}
 */
function evaluateMacSigningIdentity({ identity, env = {}, allowManagedOverride = false }) {
  const credentials = SIGNING_CREDENTIAL_ENV_KEYS.filter(
    (key) => typeof env[key] === 'string' && env[key].trim() !== '',
  );
  const requireSigned = isStrictSignedRelease(env);
  const allowAdhoc = String(env.AVANEVIS_ALLOW_ADHOC_MAC_SIGNING || '') === '1';
  const hasCertCreds = Boolean(nonEmpty(env.CSC_LINK) || nonEmpty(env.CSC_NAME));
  const notaryCheck = evaluateNotarizationCredentials(env);

  if (requireSigned && allowAdhoc) {
    return {
      ok: false,
      credentials,
      mode: 'invalid-adhoc',
      builderArgs: [],
      reason: 'AVANEVIS_ALLOW_ADHOC_MAC_SIGNING=1 is forbidden when AVANEVIS_REQUIRE_SIGNED_RELEASE=1.',
    };
  }

  if (allowManagedOverride) {
    if (!notaryCheck.ok) {
      return {
        ok: false,
        credentials,
        mode: 'partial-notarize',
        builderArgs: [],
        reason: notaryCheck.reason,
      };
    }
    if (allowAdhoc) {
      return {
        ok: true,
        reason: null,
        credentials,
        mode: 'ad-hoc',
        builderArgs: [],
      };
    }

    if (!hasCertCreds && (credentials.length > 0 || notaryCheck.configured)) {
      return {
        ok: false,
        credentials,
        mode: 'missing-cert',
        builderArgs: [],
        reason:
          `macOS signing/notarization environment variables are set (${credentials.join(', ') || 'notarization'}), `
          + 'but neither CSC_LINK nor CSC_NAME is configured for Developer ID signing.',
      };
    }

    if (!hasCertCreds) {
      if (requireSigned) {
        return {
          ok: false,
          credentials,
          mode: 'missing-credentials',
          builderArgs: [],
          reason:
            'AVANEVIS_REQUIRE_SIGNED_RELEASE=1 requires Developer ID signing credentials '
            + '(CSC_LINK + CSC_KEY_PASSWORD, or CSC_NAME) and Apple notarization credentials.',
        };
      }
      return {
        ok: true,
        reason: null,
        credentials,
        mode: 'ad-hoc',
        builderArgs: [],
      };
    }

    if (requireSigned && !notaryCheck.configured) {
      return {
        ok: false,
        credentials,
        mode: 'missing-notarize',
        builderArgs: [],
        reason:
          'AVANEVIS_REQUIRE_SIGNED_RELEASE=1 requires notarization credentials '
          + '(APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, '
          + 'or APPLE_KEYCHAIN_PROFILE).',
      };
    }

    const identityOverride = nonEmpty(env.CSC_NAME);
    const builderArgs = [
      '-c.forceCodeSigning=true',
      '-c.mac.gatekeeperAssess=true',
      `-c.mac.identity=${identityOverride}`,
      `-c.mac.notarize=${notaryCheck.configured ? 'true' : 'false'}`,
    ];

    return {
      ok: true,
      reason: null,
      credentials,
      mode: notaryCheck.configured ? 'developer-id-notarize' : 'developer-id',
      builderArgs,
    };
  }

  if (identity !== AD_HOC_IDENTITY) {
    if (!notaryCheck.ok) {
      return {
        ok: false,
        credentials,
        mode: 'partial-notarize',
        builderArgs: [],
        reason: notaryCheck.reason,
      };
    }
    if (requireSigned && !notaryCheck.configured) {
      return {
        ok: false,
        credentials,
        mode: 'missing-notarize',
        builderArgs: [],
        reason: 'AVANEVIS_REQUIRE_SIGNED_RELEASE=1 requires Apple notarization credentials.',
      };
    }
    return { ok: true, reason: null, credentials, mode: 'developer-id', builderArgs: [] };
  }

  if (credentials.length === 0) {
    if (requireSigned) {
      return {
        ok: false,
        credentials,
        mode: 'missing-credentials',
        builderArgs: [],
        reason:
          'AVANEVIS_REQUIRE_SIGNED_RELEASE=1 requires Developer ID signing and notarization credentials '
          + '(cannot build ad-hoc "-" release).',
      };
    }
    // No certificate configured: ad-hoc is the correct, Gate-B-compliant result.
    return { ok: true, reason: null, credentials, mode: 'ad-hoc', builderArgs: [] };
  }

  if (allowAdhoc) {
    return { ok: true, reason: null, credentials, mode: 'ad-hoc', builderArgs: [] };
  }

  return {
    ok: false,
    credentials,
    mode: 'ad-hoc-guard',
    builderArgs: [],
    reason:
      `build.mac.identity is pinned to "${AD_HOC_IDENTITY}" (ad-hoc) but macOS signing credentials are set `
      + `(${credentials.join(', ')}).\n`
      + 'electron-builder gives an explicit identity precedence over CSC_LINK and keychain discovery, so this\n'
      + 'build would be ad-hoc signed and fail Gatekeeper exactly like the v2.7.0 release (issue #76).\n\n'
      + 'Pick one:\n'
      + '  • Sign with the certificate:  npx electron-builder build --mac -c.mac.identity="Developer ID Application: ..."\n'
      + '  • Remove the "identity" pin from package.json build.mac once enrollment is permanent.\n'
      + '  • Deliberately ad-hoc sign anyway:  AVANEVIS_ALLOW_ADHOC_MAC_SIGNING=1 npm run build:mac',
  };
}

function resolveElectronBuilderBin() {
  const pkgPath = require.resolve('electron-builder/package.json');
  const pkg = require(pkgPath);
  return path.join(path.dirname(pkgPath), pkg.bin['electron-builder']);
}

function main() {
  const rawArgs = process.argv.slice(2);
  const preflightMode = rawArgs.includes('--preflight');
  const runMode = rawArgs.includes('--run');
  const dashIndex = rawArgs.indexOf('--');
  const passthroughArgs = dashIndex >= 0 ? rawArgs.slice(dashIndex + 1) : [];

  if (process.platform !== 'darwin') {
    return;
  }

  const pkg = require('../package.json');
  const identity = pkg.build && pkg.build.mac ? pkg.build.mac.identity : undefined;
  const result = evaluateMacSigningIdentity({
    identity,
    env: process.env,
    allowManagedOverride: preflightMode || runMode,
  });

  if (!result.ok) {
    console.error(`\nERROR: ${result.reason}\n`);
    process.exit(1);
  }

  if (result.mode === 'ad-hoc') {
    console.log('macOS signing: ad-hoc identity "-" (no Developer ID certificate configured).');
  } else {
    console.log(`macOS signing enabled (${result.mode}).`);
  }

  if (!runMode) {
    return;
  }

  const builderBin = resolveElectronBuilderBin();
  const finalArgs = [...passthroughArgs, ...result.builderArgs];
  const child = spawnSync(process.execPath, [builderBin, ...finalArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(child.status === null ? 1 : child.status);
}

module.exports = {
  AD_HOC_IDENTITY,
  SIGNING_CREDENTIAL_ENV_KEYS,
  evaluateMacSigningIdentity,
  evaluateNotarizationCredentials,
  isStrictSignedRelease,
};

if (require.main === module) {
  main();
}
