'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

test('sandboxed preload invokes IPC and subscribes and unsubscribes from progress', { timeout: 30000 }, async () => {
  const fixture = path.join(__dirname, '..', 'fixtures', 'electron', 'preload-smoke.js');
  const args = process.platform === 'linux'
    ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', fixture]
    : [fixture];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`Electron exited ${code}: ${stderr}`)));
  });
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith('PRELOAD_SMOKE '));
  assert.ok(line, `Missing preload result: ${output}`);
  const result = JSON.parse(line.slice('PRELOAD_SMOKE '.length));
  assert.deepEqual(result.state, { state: 'recording', sessionId: 'fixture' });
  assert.deepEqual(result.first, [{ phase: 'audio_encoding' }]);
  assert.equal(result.count, 1);
});
