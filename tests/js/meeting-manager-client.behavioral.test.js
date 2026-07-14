'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createMeetingManagerClient } = require('../../src/main/meeting-manager-client');

test('add-meeting forwards resolved transcription runtime metadata', async () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  let spawnedArgs = null;
  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython(args) {
      spawnedArgs = args;
      return proc;
    },
    pythonConfig: { backendPath: '/tmp/backend' },
    getBackendModuleArgs: (moduleName, args) => [moduleName, ...args],
    collectPythonProcessOutput(python) {
      let stdout = '';
      python.stdout.on('data', (data) => { stdout += data.toString(); });
      return { getStdout: () => stdout, getStderr: () => '', assertStdoutWithinLimit() {} };
    },
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    assertTrustedRendererSender() {},
    sanitizeTranscriptionError: (value) => value,
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    validateAiMetadataPaths: (value) => value,
  });

  const resultPromise = client.addMeetingToHistory({
    audioPath: '/tmp/avanevis-test/recordings/meeting.opus',
    transcriptPath: '/tmp/avanevis-test/recordings/meeting.md',
    duration: 5,
    language: 'en',
    model: 'medium',
    transcriptionDevice: 'cuda',
    transcriptionComputeType: 'float16',
  });
  proc.stdout.emit('data', Buffer.from('{"id":"meeting"}'));
  proc.emit('close', 0);

  assert.deepEqual(await resultPromise, { id: 'meeting' });
  assert.deepEqual(spawnedArgs.slice(-4), [
    '--transcription-device', 'cuda',
    '--transcription-compute-type', 'float16',
  ]);
});

test('scan-recordings rejects before spawning while recorder work is active', async () => {
  let spawned = false;
  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython() {
      spawned = true;
      throw new Error('must not spawn');
    },
    pythonConfig: { backendPath: '/tmp/backend' },
    getBackendModuleArgs: () => [],
    collectPythonProcessOutput: () => ({}),
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    assertTrustedRendererSender() {},
    sanitizeTranscriptionError: (value) => value,
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    validateAiMetadataPaths: (value) => value,
    isRecorderBusy: () => true,
  });
  const handlers = {};
  client.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  await assert.rejects(handlers['scan-recordings'](), (error) => {
    assert.equal(error.code, 'RECORDING_IN_PROGRESS');
    return true;
  });
  assert.equal(spawned, false);
});

test('scan-recordings exposes in-progress state until the scanner closes', async () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython: () => proc,
    pythonConfig: { backendPath: '/tmp/backend' },
    getBackendModuleArgs: () => [],
    collectPythonProcessOutput(python) {
      let stdout = '';
      python.stdout.on('data', (data) => { stdout += data.toString(); });
      return { getStdout: () => stdout, getStderr: () => '', assertStdoutWithinLimit() {} };
    },
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    assertTrustedRendererSender() {},
    sanitizeTranscriptionError: (value) => value,
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    validateAiMetadataPaths: (value) => value,
    isRecorderBusy: () => false,
  });
  const handlers = {};
  client.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  const scanPromise = handlers['scan-recordings']();
  assert.equal(client.isRecordingsScanInProgress(), true);
  proc.stdout.emit('data', Buffer.from('{"scanned":0,"added":0,"skipped":0}'));
  proc.emit('close', 0);
  await scanPromise;
  assert.equal(client.isRecordingsScanInProgress(), false);
});

test('scan-recordings timeout terminates the scanner and releases admission', async () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  let terminated = false;
  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython: () => proc,
    pythonConfig: { backendPath: '/tmp/backend' },
    getBackendModuleArgs: () => [],
    collectPythonProcessOutput: () => ({ getStdout: () => '', getStderr: () => '', assertStdoutWithinLimit() {} }),
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    assertTrustedRendererSender() {},
    sanitizeTranscriptionError: (value) => value,
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    validateAiMetadataPaths: (value) => value,
    isRecorderBusy: () => false,
    recordingsScanTimeoutMs: 5,
    unrefRecordingsScanTimeout: false,
    terminateProcessBestEffort: async () => { terminated = true; },
  });
  const handlers = {};
  client.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  await assert.rejects(handlers['scan-recordings'](), /timed out/);
  assert.equal(terminated, true);
  assert.equal(client.isRecordingsScanInProgress(), false);
});
