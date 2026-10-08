'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

function electronFixtureArgs(fixturePath) {
  const args = [fixturePath];
  if (process.platform === 'linux') {
    // GitHub-hosted Ubuntu cannot chmod the Electron chrome-sandbox helper
    // setuid, so the process aborts before the window exists.
    args.unshift('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
  }
  return args;
}

function runRendererFixture() {
  const electron = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === 'linux') {
    env.ELECTRON_DISABLE_SANDBOX = '1';
  }
  return new Promise((resolve, reject) => {
    const child = spawn(electron, electronFixtureArgs(path.join(__dirname, 'history-detail-renderer-fixture.js')), {
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const marker = stdout.lastIndexOf('HISTORY_DETAIL_RESULT ');
      if (marker === -1) {
        reject(new Error(`Renderer fixture exited ${code} without a result.\n${stderr}\n${stdout}`));
        return;
      }
      const result = JSON.parse(stdout.slice(marker + 'HISTORY_DETAIL_RESULT '.length));
      if (result.error) {
        reject(new Error(result.error));
        return;
      }
      resolve(result);
    });
  });
}

function assertActionsReachable(measurement, minimumReadingHeight) {
  const detail = JSON.stringify(measurement);
  assert.ok(measurement.transcriptContentHeight >= minimumReadingHeight, detail);
  for (const button of measurement.buttons) {
    assert.equal(button.insidePane, true, `${button.id} extends outside the detail pane ${detail}`);
    assert.equal(button.reachable, true, `${button.id} stays clipped after scrolling ${detail}`);
  }
}

test('short history layouts keep summary actions clickable and the reading area usable', { timeout: 60000 }, async () => {
  const result = await runRendererFixture();
  assert.ok(result.short.viewport.width >= 560 && result.short.viewport.width <= 660, JSON.stringify(result.short.viewport));
  assert.ok(result.short.viewport.height >= 360 && result.short.viewport.height <= 440, JSON.stringify(result.short.viewport));
  assertActionsReachable(result.short, 120);

  assert.ok(result.tallViewport.width >= 760 && result.tallViewport.width <= 860, JSON.stringify(result.tallViewport));
  assert.ok(result.tallViewport.height >= 860 && result.tallViewport.height <= 960, JSON.stringify(result.tallViewport));
  assertActionsReachable(result.tall, 200);

  assert.equal(result.summary.disabled, false);
  assert.match(result.summary.className, /\bis-loading\b/);
  assert.match(result.summary.className, /\bsummary-generation-active\b/);
  assert.equal(result.summary.hoverLabel, 'Cancel Summarisation');
  assert.equal(result.summary.pointerEvents, 'auto');
  assert.notEqual(result.summary.color, 'rgba(0, 0, 0, 0)');
  assert.equal(result.summary.afterContent, 'none');
  assert.equal(result.hit.id, 'generate-summary-btn');
  assert.match(result.hoverAfter, /Cancel Summarisation/);
  assert.equal(result.cancelCalls, 1);
  assert.equal(result.cancelling.pointerEvents, 'none');
  assert.equal(result.cancelCallsAfterBlockedClick, 1);

  assert.equal(result.install.pointerEvents, 'none');
  assert.equal(result.install.color, 'rgba(0, 0, 0, 0)');
  assert.notEqual(result.install.afterContent, 'none');
});
