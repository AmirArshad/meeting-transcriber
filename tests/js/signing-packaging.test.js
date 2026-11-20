'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const packageJson = require('../../package.json');
const afterPack = require('../../build/after-pack');
const {
  buildOuterBundleResealArgs,
  refreshMacOSSpeakrsIntegrity,
} = require('../../build/mac-sign');
const {
  evaluateWindowsSigningConfig,
} = require('../../scripts/check-win-signing-config');
const {
  AD_HOC_IDENTITY,
  evaluateMacSigningIdentity,
  evaluateNotarizationCredentials,
  notarizationEnvironment,
} = require('../../scripts/check-mac-signing-identity');
const {
  getSpeakrsCliBinaryName,
  SPEAKRS_VALIDATE_WAV_NAME,
  writeSpeakrsPackagedIntegrityManifest,
} = require('../../build/prepare-resources');
const {
  inspectPackagedSpeakrsLayout,
} = require('../../src/ai-addon/speakrs-cli-integrity');

const ROOT = path.join(__dirname, '..', '..');
const RELEASE_WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build-release.yml'), 'utf8');
const WIN_VERIFY_SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-windows-installer.ps1'), 'utf8');
const MAC_APP_VERIFY_SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-macos-packaged-app.sh'), 'utf8');
const MAC_DMG_VERIFY_SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-macos-installer.sh'), 'utf8');

function writeMinimalPeExecutable(filePath, trailingBytes = Buffer.from('unsigned')) {
  const header = Buffer.alloc(0x48, 0);
  header.write('MZ', 0, 'ascii');
  header.writeUInt32LE(0x40, 0x3c);
  header.write('PE\0\0', 0x40, 'ascii');
  header.writeUInt16LE(0x8664, 0x44);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, trailingBytes]));
}

function writeMinimalArm64MachO(filePath, trailingBytes = Buffer.from('unsigned')) {
  const header = Buffer.alloc(16, 0);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, trailingBytes]));
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('afterPack refreshes win32 Speakrs integrity after Authenticode changes binary bytes and no-ops on Linux/macOS', async () => {
  assert.equal(await afterPack({ electronPlatformName: 'linux', appOutDir: '/nonexistent' }), null);
  assert.equal(await afterPack({ electronPlatformName: 'darwin', appOutDir: '/nonexistent' }), null);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-afterpack-win-'));
  try {
    const resourcesPath = path.join(tempDir, 'resources');
    const binDir = path.join(resourcesPath, 'bin');
    const cliPath = path.join(binDir, getSpeakrsCliBinaryName('win32'));
    const wavPath = path.join(binDir, SPEAKRS_VALIDATE_WAV_NAME);

    writeMinimalPeExecutable(cliPath, Buffer.from('raw-cargo-build'));
    fs.writeFileSync(wavPath, Buffer.from('RIFF-fixture'));
    writeSpeakrsPackagedIntegrityManifest(binDir, 'win32');

    // Simulate WinPackager Authenticode-signing speakrs-cli.exe while copying extraResources.
    writeMinimalPeExecutable(cliPath, Buffer.from('authenticode-signed-payload'));
    const staleCheck = inspectPackagedSpeakrsLayout({ platform: 'win32', resourcesPath });
    assert.equal(staleCheck.ok, false);

    const manifestPath = await afterPack({ electronPlatformName: 'win32', appOutDir: tempDir });
    assert.equal(manifestPath, path.join(binDir, 'speakrs-integrity.json'));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.platforms['win32-x64'].cli.sha256, sha256File(cliPath));

    const freshCheck = inspectPackagedSpeakrsLayout({ platform: 'win32', resourcesPath });
    assert.equal(freshCheck.ok, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('mac-sign builds outer non-deep reseal args and refreshes Speakrs integrity after codesign', () => {
  const devArgs = buildOuterBundleResealArgs({
    app: '/tmp/AvaNevis.app',
    identity: 'ABC123DEVID',
    keychain: '/tmp/signing.keychain',
    optionsForFile: () => ({
      entitlements: 'build/entitlements.mac.plist',
      hardenedRuntime: true,
      additionalArguments: ['--preserve-metadata=entitlements'],
    }),
  });
  assert.equal(devArgs.includes('--deep'), false);
  assert.ok(devArgs.includes('--sign'));
  assert.ok(devArgs.includes('ABC123DEVID'));
  assert.ok(devArgs.includes('--keychain'));
  assert.ok(devArgs.includes('/tmp/signing.keychain'));
  assert.ok(devArgs.includes('--timestamp'));
  assert.ok(devArgs.includes('--options'));
  assert.ok(devArgs.includes('runtime'));
  assert.ok(devArgs.includes('--entitlements'));
  assert.equal(devArgs[devArgs.length - 1], '/tmp/AvaNevis.app');

  const adhocArgs = buildOuterBundleResealArgs({
    app: '/tmp/AvaNevis.app',
    identity: '-',
    optionsForFile: () => ({
      entitlements: 'build/entitlements.mac.plist',
      hardenedRuntime: true,
    }),
  });
  assert.equal(adhocArgs.includes('--deep'), false);
  assert.equal(adhocArgs.some((arg) => arg.startsWith('--timestamp')), false);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-macsign-'));
  try {
    const appPath = path.join(tempDir, 'AvaNevis.app');
    const binDir = path.join(appPath, 'Contents', 'Resources', 'bin');
    const cliPath = path.join(binDir, getSpeakrsCliBinaryName('darwin'));
    const wavPath = path.join(binDir, SPEAKRS_VALIDATE_WAV_NAME);

    writeMinimalArm64MachO(cliPath, Buffer.from('raw-cargo-build'));
    fs.chmodSync(cliPath, 0o755);
    fs.writeFileSync(wavPath, Buffer.from('RIFF-fixture'));
    writeSpeakrsPackagedIntegrityManifest(binDir, 'darwin');

    writeMinimalArm64MachO(cliPath, Buffer.from('codesign-lc-signature-blob'));
    const refreshed = refreshMacOSSpeakrsIntegrity(appPath);
    const manifest = JSON.parse(fs.readFileSync(refreshed.manifestPath, 'utf8'));
    assert.equal(manifest.platforms['darwin-arm64'].cli.sha256, sha256File(cliPath));
    assert.equal(
      inspectPackagedSpeakrsLayout({ platform: 'darwin', resourcesPath: refreshed.resourcesPath }).ok,
      true,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('evaluateWindowsSigningConfig handles unsigned local, strict release, PFX, Azure, partial, and ambiguous configs', () => {
  const unsigned = evaluateWindowsSigningConfig({ env: {} });
  assert.equal(unsigned.ok, true);
  assert.equal(unsigned.mode, 'unsigned');
  assert.deepEqual(unsigned.builderArgs, []);

  const strictUnsigned = evaluateWindowsSigningConfig({
    env: { AVANEVIS_REQUIRE_SIGNED_RELEASE: '1' },
  });
  assert.equal(strictUnsigned.ok, false);
  assert.match(strictUnsigned.reason, /AVANEVIS_REQUIRE_SIGNED_RELEASE=1/);

  const pfx = evaluateWindowsSigningConfig({
    env: {
      AVANEVIS_REQUIRE_SIGNED_RELEASE: '1',
      WIN_CSC_LINK: 'base64-pfx',
      WIN_CSC_KEY_PASSWORD: 'secret',
    },
  });
  assert.equal(pfx.ok, true);
  assert.equal(pfx.mode, 'pfx');
  assert.deepEqual(pfx.builderArgs, ['-c.forceCodeSigning=true']);

  const azure = evaluateWindowsSigningConfig({
    env: {
      AVANEVIS_REQUIRE_SIGNED_RELEASE: '1',
      WINDOWS_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net/',
      WINDOWS_AZURE_CODE_SIGNING_ACCOUNT: 'avanevis-signing',
      WINDOWS_AZURE_CERT_PROFILE: 'avanevis-public',
      WINDOWS_AZURE_PUBLISHER_NAME: 'CN=AvaNevis',
      AZURE_TENANT_ID: 'tenant-id',
      AZURE_CLIENT_ID: 'client-id',
      AZURE_CLIENT_SECRET: 'client-secret',
    },
  });
  assert.equal(azure.ok, true);
  assert.equal(azure.mode, 'azure-trusted-signing');
  assert.ok(azure.builderArgs.includes('-c.forceCodeSigning=true'));
  assert.ok(azure.builderArgs.includes('-c.win.azureSignOptions.endpoint=https://eus.codesigning.azure.net/'));
  assert.ok(azure.builderArgs.includes('-c.win.azureSignOptions.codeSigningAccountName=avanevis-signing'));
  assert.ok(azure.builderArgs.includes('-c.win.azureSignOptions.certificateProfileName=avanevis-public'));
  assert.ok(azure.builderArgs.includes('-c.win.azureSignOptions.publisherName=CN=AvaNevis'));

  const partialAzure = evaluateWindowsSigningConfig({
    env: { WINDOWS_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net/' },
  });
  assert.equal(partialAzure.ok, false);
  assert.match(partialAzure.reason, /Partial Azure Trusted Signing/);

  const ambiguous = evaluateWindowsSigningConfig({
    env: {
      WIN_CSC_LINK: 'base64-pfx',
      WINDOWS_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net/',
      WINDOWS_AZURE_CODE_SIGNING_ACCOUNT: 'avanevis-signing',
      WINDOWS_AZURE_CERT_PROFILE: 'avanevis-public',
      AZURE_TENANT_ID: 'tenant-id',
      AZURE_CLIENT_ID: 'client-id',
      AZURE_CLIENT_SECRET: 'client-secret',
    },
  });
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.reason, /only one Windows signing provider/i);
});

test('evaluateMacSigningIdentity managed override supports ad-hoc dev, Developer ID + notarization, and strict enforcement', () => {
  const localAdhoc = evaluateMacSigningIdentity({
    identity: AD_HOC_IDENTITY,
    env: {},
    allowManagedOverride: true,
  });
  assert.equal(localAdhoc.ok, true);
  assert.equal(localAdhoc.mode, 'ad-hoc');
  assert.deepEqual(localAdhoc.builderArgs, []);

  const strictUnsigned = evaluateMacSigningIdentity({
    identity: AD_HOC_IDENTITY,
    env: { AVANEVIS_REQUIRE_SIGNED_RELEASE: '1' },
    allowManagedOverride: true,
  });
  assert.equal(strictUnsigned.ok, false);

  const strictForcedAdhoc = evaluateMacSigningIdentity({
    identity: AD_HOC_IDENTITY,
    env: {
      AVANEVIS_REQUIRE_SIGNED_RELEASE: '1',
      AVANEVIS_ALLOW_ADHOC_MAC_SIGNING: '1',
    },
    allowManagedOverride: true,
  });
  assert.equal(strictForcedAdhoc.ok, false);

  const strictMissingNotarize = evaluateMacSigningIdentity({
    identity: AD_HOC_IDENTITY,
    env: {
      AVANEVIS_REQUIRE_SIGNED_RELEASE: '1',
      CSC_LINK: 'base64-p12',
      CSC_KEY_PASSWORD: 'secret',
    },
    allowManagedOverride: true,
  });
  assert.equal(strictMissingNotarize.ok, false);
  assert.equal(strictMissingNotarize.mode, 'missing-notarize');

  const signedWithAppleId = evaluateMacSigningIdentity({
    identity: AD_HOC_IDENTITY,
    env: {
      AVANEVIS_REQUIRE_SIGNED_RELEASE: '1',
      CSC_LINK: 'base64-p12',
      CSC_KEY_PASSWORD: 'secret',
      APPLE_KEYCHAIN_PROFILE: 'notary-profile',
    },
    allowManagedOverride: true,
  });
  assert.equal(signedWithAppleId.ok, true);
  assert.equal(signedWithAppleId.mode, 'developer-id-notarize');
  assert.deepEqual(signedWithAppleId.builderArgs, [
    '-c.forceCodeSigning=true',
    '-c.mac.gatekeeperAssess=true',
    '-c.mac.identity=',
    '-c.mac.notarize=true',
  ]);

  const signedWithNameAndApiKey = evaluateMacSigningIdentity({
    identity: AD_HOC_IDENTITY,
    env: {
      AVANEVIS_REQUIRE_SIGNED_RELEASE: '1',
      CSC_NAME: 'Developer ID Application: AvaNevis (TEAM123456)',
      APPLE_API_KEY: '/tmp/AuthKey.p8',
      APPLE_API_KEY_ID: 'KEY123',
      APPLE_API_ISSUER: 'ISSUER-UUID',
    },
    allowManagedOverride: true,
  });
  assert.equal(signedWithNameAndApiKey.ok, true);
  assert.ok(
    signedWithNameAndApiKey.builderArgs.includes(
      '-c.mac.identity=Developer ID Application: AvaNevis (TEAM123456)',
    ),
  );

  const partialNotary = evaluateMacSigningIdentity({
    identity: AD_HOC_IDENTITY,
    env: {
      CSC_LINK: 'base64-p12',
      APPLE_ID: 'dev@example.com',
    },
    allowManagedOverride: true,
  });
  assert.equal(partialNotary.ok, false);
  assert.equal(partialNotary.mode, 'partial-notarize');
});

test('package.json, release workflow, and platform verifiers wire signing and notarization gates cleanly', () => {
  assert.equal(packageJson.build.afterPack, 'build/after-pack.js');
  assert.equal(packageJson.build.mac.sign, 'build/mac-sign.js');
  assert.deepEqual(packageJson.build.win.signtoolOptions.signingHashAlgorithms, ['sha256']);
  assert.match(packageJson.build.win.signtoolOptions.rfc3161TimeStampServer, /^https?:\/\//);
  assert.match(packageJson.scripts.build, /check-win-signing-config\.js/);
  assert.match(packageJson.scripts['build:mac'], /check-mac-signing-identity\.js/);

  assert.match(RELEASE_WORKFLOW, /require_signed_release:/);
  assert.match(RELEASE_WORKFLOW, /AVANEVIS_REQUIRE_SIGNED_RELEASE:/);
  assert.match(RELEASE_WORKFLOW, /bash scripts\/notarize-macos-dmg\.sh/);
  assert.match(RELEASE_WORKFLOW, /API_KEY_CONTENT: \${{ secrets\.APPLE_API_KEY }}/);
  assert.match(RELEASE_WORKFLOW, /umask 077/);
  assert.match(RELEASE_WORKFLOW, /APPLE_API_KEY=\$key_path/);
  assert.match(RELEASE_WORKFLOW, /if: always\(\) && matrix\.os == 'macOS'/);
  assert.match(RELEASE_WORKFLOW, /rm -f "\$RUNNER_TEMP\/avanevis-notary-key\.p8"/);
  assert.equal((RELEASE_WORKFLOW.match(/APPLE_KEYCHAIN_PROFILE: \${{ vars\.APPLE_KEYCHAIN_PROFILE }}/g) || []).length, 3);
  assert.match(RELEASE_WORKFLOW, /bash scripts\/verify-macos-installer\.sh/);
  assert.match(RELEASE_WORKFLOW, /verify-windows-installer\.ps1 -SignaturesOnly/);

  assert.match(WIN_VERIFY_SCRIPT, /Get-AuthenticodeSignature/);
  assert.match(WIN_VERIFY_SCRIPT, /TimeStamperCertificate/);
  assert.match(WIN_VERIFY_SCRIPT, /SignaturesOnly/);

  assert.match(MAC_APP_VERIFY_SCRIPT, /Authority=Developer ID Application:/);
  assert.match(MAC_APP_VERIFY_SCRIPT, /xcrun stapler validate "\$APP_PATH"/);
  assert.match(MAC_APP_VERIFY_SCRIPT, /spctl --assess --type execute/);

  assert.match(MAC_DMG_VERIFY_SCRIPT, /Authority=Developer ID Application:/);
  assert.match(MAC_DMG_VERIFY_SCRIPT, /xcrun stapler validate "\$dmg"/);
  assert.match(MAC_DMG_VERIFY_SCRIPT, /spctl --assess --type open/);
});


test('notarization selects complete credentials and strips raw Apple passwords from builder', () => {
  const env = { APPLE_ID: 'dev@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'secret',
    APPLE_TEAM_ID: 'TEAM', APPLE_API_KEY: '/tmp/key.p8', APPLE_API_KEY_ID: 'KEY',
    APPLE_API_ISSUER: 'ISSUER', APPLE_KEYCHAIN_PROFILE: 'profile' };
  assert.equal(evaluateNotarizationCredentials(env).mode, 'api');
  const builderEnv = notarizationEnvironment(env);
  assert.equal(builderEnv.APPLE_ID, undefined);
  assert.equal(builderEnv.APPLE_APP_SPECIFIC_PASSWORD, undefined);
  assert.equal(builderEnv.APPLE_KEYCHAIN_PROFILE, undefined);
  assert.equal(builderEnv.APPLE_API_KEY, '/tmp/key.p8');
  assert.equal(evaluateNotarizationCredentials({ APPLE_ID: 'dev', APPLE_APP_SPECIFIC_PASSWORD: 'secret', APPLE_TEAM_ID: 'TEAM' }).ok, false);
  const profileEnv = notarizationEnvironment({ APPLE_KEYCHAIN_PROFILE: 'profile', APPLE_API_KEY: 'partial' });
  assert.equal(profileEnv.APPLE_API_KEY, undefined);
  assert.equal(profileEnv.APPLE_KEYCHAIN_PROFILE, 'profile');
});
