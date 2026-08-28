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

const AD_HOC_IDENTITY = '-';

const SIGNING_CREDENTIAL_ENV_KEYS = Object.freeze([
  'CSC_LINK',
  'CSC_NAME',
  'CSC_KEY_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLEID',
  'APPLE_API_KEY',
]);

/**
 * Pure decision helper (unit-tested).
 *
 * @param {object} params
 * @param {string|undefined} params.identity - build.mac.identity from package.json
 * @param {Record<string, string|undefined>} params.env
 * @returns {{ ok: boolean, reason: string|null, credentials: string[] }}
 */
function evaluateMacSigningIdentity({ identity, env = {} }) {
  const credentials = SIGNING_CREDENTIAL_ENV_KEYS.filter(
    (key) => typeof env[key] === 'string' && env[key].trim() !== '',
  );

  if (identity !== AD_HOC_IDENTITY) {
    return { ok: true, reason: null, credentials };
  }
  if (credentials.length === 0) {
    // No certificate configured: ad-hoc is the correct, Gate-B-compliant result.
    return { ok: true, reason: null, credentials };
  }
  if (String(env.AVANEVIS_ALLOW_ADHOC_MAC_SIGNING || '') === '1') {
    return { ok: true, reason: null, credentials };
  }

  return {
    ok: false,
    credentials,
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

function main() {
  if (process.platform !== 'darwin') {
    return;
  }
  const pkg = require('../package.json');
  const identity = pkg.build && pkg.build.mac ? pkg.build.mac.identity : undefined;
  const result = evaluateMacSigningIdentity({ identity, env: process.env });
  if (!result.ok) {
    console.error(`\nERROR: ${result.reason}\n`);
    process.exit(1);
  }
  if (identity === AD_HOC_IDENTITY) {
    console.log('macOS signing: ad-hoc identity "-" (no Developer ID certificate configured).');
  }
}

module.exports = { evaluateMacSigningIdentity, AD_HOC_IDENTITY, SIGNING_CREDENTIAL_ENV_KEYS };

if (require.main === module) {
  main();
}
