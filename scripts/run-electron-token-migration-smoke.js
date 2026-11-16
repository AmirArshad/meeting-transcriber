'use strict';
// Run within an isolated desktop/keyring session. Never point at an app profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const legacy = process.argv[2];
const current = process.argv[3] || require('electron');
if (!legacy || !path.isAbsolute(legacy) || !path.isAbsolute(current)) {
  process.stderr.write('Usage: node scripts/run-electron-token-migration-smoke.js /absolute/electron45 [/absolute/electron46]\n');
  process.exit(2);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-token-migration-'));
const profile = path.join(root, 'profile');
const copy = path.join(root, 'downgrade-copy');
const fixture = path.resolve(__dirname, '../tests/fixtures/electron/token-migration-smoke.js');
fs.mkdirSync(profile);
function run(binary, target, mode, backend = 'gnome-libsecret', unavailable = false) {
  const child = spawnSync(binary, [fixture, target, mode, backend], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ...(unavailable ? { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/avanevis-probe-bus' } : {}) } });
  const line = (child.stdout || '').split(/\r?\n/).find(value => value.startsWith('{'));
  let result;
  try { result = JSON.parse(line); } catch (_) { result = { mode, processFailed: true }; }
  if (child.status !== 0) result.processFailed = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}
try {
  let passed = true;
  const first = run(legacy, profile, 'legacy-write');
  passed = passed && first.roundTrip === true;
  if (first.roundTrip) {
    const upgrade = run(current, profile, 'upgrade');
    passed = passed && upgrade.roundTrip === true && upgrade.protectedByAppPolicy === true;
    if (upgrade.roundTrip) {
      const restart = run(current, profile, 'restart');
      passed = passed && restart.roundTrip === true;
      fs.cpSync(profile, copy, { recursive: true });
      const downgrade = run(legacy, copy, 'legacy-read');
      passed = passed && downgrade.roundTrip === true;
    }
  }
  if (process.platform === 'linux') {
    const basic = path.join(root, 'basic');
    fs.mkdirSync(basic);
    const basicResult = run(current, basic, 'async-roundtrip', 'basic');
    const unavailable = path.join(root, 'unavailable');
    fs.mkdirSync(unavailable);
    const fallback = run(current, unavailable, 'async-write', 'gnome-libsecret', true);
    const fallbackRestart = run(current, unavailable, 'restart', 'gnome-libsecret', true);
    passed = passed && [basicResult, fallback, fallbackRestart].every(
      (result) => !result.processFailed && result.protectedByAppPolicy === false,
    );
  }
  if (!passed) process.exitCode = 1;
} finally { fs.rmSync(root, { recursive: true, force: true }); }
