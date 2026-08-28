'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateMacSigningIdentity,
  AD_HOC_IDENTITY,
} = require('../../scripts/check-mac-signing-identity');

const packageJson = require('../../package.json');

test('certificate-less builds keep the Gate B ad-hoc identity', () => {
  // Gate B root cause: electron-builder skipped signing entirely without an
  // identity, shipping a linker-signed app that failed --deep --strict.
  assert.equal(packageJson.build.mac.identity, AD_HOC_IDENTITY);

  const result = evaluateMacSigningIdentity({ identity: AD_HOC_IDENTITY, env: {} });
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
});

test('an ad-hoc pin plus real signing credentials fails the build loudly', () => {
  for (const key of ['CSC_LINK', 'CSC_NAME', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLEID', 'CSC_KEY_PASSWORD']) {
    const result = evaluateMacSigningIdentity({
      identity: AD_HOC_IDENTITY,
      env: { [key]: 'configured' },
    });
    assert.equal(result.ok, false, `${key} must trip the guard`);
    assert.match(result.reason, /ad-hoc/i);
    assert.match(result.reason, /Gatekeeper/);
    assert.ok(result.credentials.includes(key));
  }
});

test('blank credential values are not treated as configured', () => {
  const result = evaluateMacSigningIdentity({
    identity: AD_HOC_IDENTITY,
    env: { CSC_LINK: '   ', CSC_NAME: '' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.credentials, []);
});

test('a real Developer ID identity is never blocked', () => {
  const result = evaluateMacSigningIdentity({
    identity: 'Developer ID Application: AvaNevis (TEAMID)',
    env: { CSC_LINK: 'configured' },
  });
  assert.equal(result.ok, true);
});

test('the ad-hoc override escape hatch is explicit', () => {
  const result = evaluateMacSigningIdentity({
    identity: AD_HOC_IDENTITY,
    env: { CSC_LINK: 'configured', AVANEVIS_ALLOW_ADHOC_MAC_SIGNING: '1' },
  });
  assert.equal(result.ok, true);
});

test('build:mac runs the signing guard before packaging', () => {
  assert.match(packageJson.scripts['build:mac'], /check-mac-signing-identity\.js/);
});
