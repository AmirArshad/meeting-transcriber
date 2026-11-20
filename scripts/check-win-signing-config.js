'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

function isStrictSignedRelease(env = process.env) {
  const raw = String(env.AVANEVIS_REQUIRE_SIGNED_RELEASE || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function firstNonEmpty(env, keys) {
  for (const key of keys) {
    const val = typeof env[key] === 'string' ? env[key].trim() : '';
    if (val) {
      return { key, value: val };
    }
  }
  return null;
}

function detectAzureTrustedSigning(env = process.env) {
  const endpoint = firstNonEmpty(env, ['WINDOWS_AZURE_ENDPOINT', 'AZURE_SIGN_ENDPOINT']);
  const account = firstNonEmpty(env, [
    'WINDOWS_AZURE_CODE_SIGNING_ACCOUNT',
    'AZURE_SIGN_ACCOUNT_NAME',
  ]);
  const profile = firstNonEmpty(env, [
    'WINDOWS_AZURE_CERT_PROFILE',
    'AZURE_SIGN_CERT_PROFILE',
  ]);
  const publisher = firstNonEmpty(env, [
    'WINDOWS_AZURE_PUBLISHER_NAME',
    'AZURE_SIGN_PUBLISHER_NAME',
  ]);

  const anyMetadata = Boolean(endpoint || account || profile || publisher);
  const tenantId = firstNonEmpty(env, ['AZURE_TENANT_ID']);
  const clientId = firstNonEmpty(env, ['AZURE_CLIENT_ID']);
  const clientSecret = firstNonEmpty(env, ['AZURE_CLIENT_SECRET']);
  const federatedTokenFile = firstNonEmpty(env, ['AZURE_FEDERATED_TOKEN_FILE']);

  const hasEntraCredentials = Boolean(
    tenantId && clientId && (clientSecret || federatedTokenFile),
  );
  const anyEntra = Boolean(tenantId || clientId || clientSecret || federatedTokenFile);

  if (!anyMetadata) {
    return { configured: false, partial: false, hasEntra: anyEntra };
  }

  const missing = [];
  if (!endpoint) missing.push('WINDOWS_AZURE_ENDPOINT');
  if (!account) missing.push('WINDOWS_AZURE_CODE_SIGNING_ACCOUNT');
  if (!profile) missing.push('WINDOWS_AZURE_CERT_PROFILE');
  if (!hasEntraCredentials) {
    missing.push('AZURE_TENANT_ID + AZURE_CLIENT_ID + (AZURE_CLIENT_SECRET or AZURE_FEDERATED_TOKEN_FILE)');
  }

  if (missing.length > 0) {
    return {
      configured: false,
      partial: true,
      missing,
    };
  }

  const builderArgs = [
    '-c.forceCodeSigning=true',
    `-c.win.azureSignOptions.endpoint=${endpoint.value}`,
    `-c.win.azureSignOptions.codeSigningAccountName=${account.value}`,
    `-c.win.azureSignOptions.certificateProfileName=${profile.value}`,
  ];
  if (publisher) {
    builderArgs.push(`-c.win.azureSignOptions.publisherName=${publisher.value}`);
  }

  return {
    configured: true,
    partial: false,
    endpoint: endpoint.value,
    codeSigningAccountName: account.value,
    certificateProfileName: profile.value,
    publisherName: publisher ? publisher.value : null,
    builderArgs,
  };
}

function detectPfxSigning(env = process.env) {
  const link = firstNonEmpty(env, ['WIN_CSC_LINK', 'CSC_LINK']);
  const password = firstNonEmpty(env, ['WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD']);
  const subjectName = firstNonEmpty(env, ['WINDOWS_SIGN_CERT_SUBJECT_NAME']);
  const sha1 = firstNonEmpty(env, ['WINDOWS_SIGN_CERT_SHA1']);

  if (link) {
    return {
      configured: true,
      kind: 'pfx',
      credentialKey: link.key,
      hasPassword: Boolean(password),
      builderArgs: ['-c.forceCodeSigning=true'],
    };
  }

  if (subjectName || sha1) {
    const builderArgs = ['-c.forceCodeSigning=true'];
    if (subjectName) {
      builderArgs.push(`-c.win.signtoolOptions.certificateSubjectName=${subjectName.value}`);
    }
    if (sha1) {
      builderArgs.push(`-c.win.signtoolOptions.certificateSha1=${sha1.value}`);
    }
    return {
      configured: true,
      kind: 'store',
      credentialKey: subjectName ? subjectName.key : sha1.key,
      builderArgs,
    };
  }

  return { configured: false };
}

/**
 * Evaluate Windows Authenticode signing configuration before invoking electron-builder.
 * Allows unsigned local/PR dev builds unless AVANEVIS_REQUIRE_SIGNED_RELEASE=1 or
 * partial/ambiguous signing credentials are configured.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{ ok: boolean, mode: string, requireSigned: boolean, builderArgs: string[], reason?: string }}
 */
function evaluateWindowsSigningConfig({ env = process.env } = {}) {
  const requireSigned = isStrictSignedRelease(env);
  const azure = detectAzureTrustedSigning(env);
  const pfx = detectPfxSigning(env);

  if (azure.partial) {
    return {
      ok: false,
      mode: 'invalid-azure',
      requireSigned,
      builderArgs: [],
      reason: `Partial Azure Trusted Signing configuration detected; missing: ${azure.missing.join(', ')}.`,
    };
  }

  if (azure.configured && pfx.configured) {
    return {
      ok: false,
      mode: 'ambiguous',
      requireSigned,
      builderArgs: [],
      reason: `Both Azure Trusted Signing and ${pfx.credentialKey} are set; configure only one Windows signing provider.`,
    };
  }

  if (azure.configured) {
    return {
      ok: true,
      mode: 'azure-trusted-signing',
      requireSigned,
      builderArgs: azure.builderArgs,
      publisherName: azure.publisherName,
    };
  }

  if (pfx.configured) {
    return {
      ok: true,
      mode: pfx.kind === 'store' ? 'cert-store' : 'pfx',
      requireSigned,
      builderArgs: pfx.builderArgs,
      credentialKey: pfx.credentialKey,
    };
  }

  if (requireSigned) {
    return {
      ok: false,
      mode: 'unsigned',
      requireSigned,
      builderArgs: [],
      reason:
        'AVANEVIS_REQUIRE_SIGNED_RELEASE=1 requires Windows Authenticode credentials '
        + '(Azure Trusted Signing WINDOWS_AZURE_* + AZURE_* or WIN_CSC_LINK/CSC_LINK).',
    };
  }

  return {
    ok: true,
    mode: 'unsigned',
    requireSigned,
    builderArgs: [],
    reason: 'No Windows code signing credentials configured; continuing unsigned local/dev build.',
  };
}

function resolveElectronBuilderBin() {
  const pkgPath = require.resolve('electron-builder/package.json');
  const pkg = require(pkgPath);
  return path.join(path.dirname(pkgPath), pkg.bin['electron-builder']);
}

function main() {
  const rawArgs = process.argv.slice(2);
  const dashIndex = rawArgs.indexOf('--');
  const runMode = rawArgs.includes('--run');
  const passthroughArgs = dashIndex >= 0 ? rawArgs.slice(dashIndex + 1) : [];

  const result = evaluateWindowsSigningConfig();
  if (!result.ok) {
    console.error(`[check-win-signing-config] ERROR: ${result.reason}`);
    process.exit(1);
  }

  if (result.mode === 'unsigned') {
    console.log(`[check-win-signing-config] ${result.reason}`);
  } else {
    console.log(`[check-win-signing-config] Windows signing enabled (${result.mode}).`);
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

if (require.main === module) {
  main();
}

module.exports = {
  detectAzureTrustedSigning,
  detectPfxSigning,
  evaluateWindowsSigningConfig,
  isStrictSignedRelease,
};
