'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
test('sidebar opens History and the import dialog restores focus to its opener', { timeout: 60000 }, async () => {
  const args = [path.join(__dirname, 'import-renderer-fixture.js')];
  if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
  const env = { ...process.env, ELECTRON_DISABLE_SANDBOX: '1' }; delete env.ELECTRON_RUN_AS_NODE;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), args, { env }); let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject); child.on('close', (code) => code ? reject(new Error(stderr + stdout)) : resolve(stdout));
  });
  const result = JSON.parse(output.split('IMPORT_RENDERER_RESULT ')[1]);
  assert.equal(result.historyOpened, true);
  assert.equal(result.opened, true); assert.equal(result.name, 'Long meeting.wav');
  assert.equal(result.focus, 'import-audio-engine'); assert.equal(result.inert, true);
  assert.equal(result.resultActionsHidden, true);
  assert.equal(result.call.transcriptionSelection.engine, 'whisper');
  assert.equal(result.resultTitle, 'Imported into History'); assert.equal(result.resultFocus, 'import-audio-open');
  assert.equal(result.activeStatus, 'Transcribing. You can play the audio now.');
  assert.equal(result.readyStatus, 'Transcript ready. You can play the audio now.');
  assert.equal(result.staleStatus, result.readyStatus);
  assert.equal(result.closed, true); assert.equal(result.restored, 'import-audio-rail-button');
  assert.equal(result.draftPreserved, true); assert.equal(result.returnedToEdit, true);
  assert.equal(result.finalFocus, 'cap-play-btn');
  assert.match(result.diskMessage, /enough space/); assert.equal(result.diskRetry, 'Try again');
  assert.equal(result.retryResult, 'Imported into History');
  assert.match(result.placeholderText, /Awaiting transcription/);
  assert.doesNotMatch(result.placeholderText, /recording was saved successfully/);
  assert.equal(result.hasActivity, true); assert.match(result.previousText, /A previous transcript/);
  assert.equal(result.cancelChip, 'Cancelled'); assert.equal(result.rowFocus, 'new');
  assert.equal(result.failedRetryVisible, true); assert.match(result.failedText, /transcription/i);
  assert.match(result.readyText, /Finished transcript/); assert.equal(result.readyRetryHidden, true);
  assert.equal(result.focusAfterDismiss, 'import-audio-button');
  assert.match(result.pickerMessage, /Could not choose a file/);
  assert.equal(result.immediateOpenId, 'fresh'); assert.equal(result.immediateOpenFocus, 'cap-play-btn');
  assert.deepEqual(result.shortWindowLayout, {
    dialogFits: true,
    bodyScrolls: true,
    bodyFitsWidth: true,
    footerVisible: true,
    footerStaysPut: true
  });
});
