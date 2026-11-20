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

test('transcription provenance commands forward bounded records and drop paths', async () => {
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

  const pending = client.stageTranscriptionRequest('meeting-1', {
    schemaVersion: 1,
    attemptId: '11111111-1111-1111-1111-111111111111',
    engine: 'parakeet',
    language: 'en',
    modelPath: '/tmp/secret/model.onnx',
    sha256: 'abc',
    token: 'hf_secret',
  }, { cancelGeneration: 2, deleteGeneration: 3 });
  proc.stdout.emit('data', Buffer.from('{"id":"meeting-1"}'));
  proc.emit('close', 0);
  await pending;
  const requestJson = spawnedArgs[spawnedArgs.indexOf('--request-json') + 1];
  assert.equal(JSON.parse(requestJson).engine, 'parakeet');
  assert.equal(requestJson.includes('modelPath'), false);
  assert.equal(requestJson.includes('hf_secret'), false);
  assert.equal(requestJson.includes('/tmp/secret'), false);
  assert.ok(spawnedArgs.includes('--cancel-generation'));
  assert.ok(spawnedArgs.includes('2'));
});

test('commit forwards device, compute type, and transcript hash without paths', async () => {
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
  const hash = `sha256:${'ab'.repeat(32)}`;
  const pending = client.commitTranscriptionAttempt('meeting-1', {
    attemptId: '11111111-1111-4111-8111-111111111111',
    candidatePath: '/tmp/avanevis-test/recordings/candidate.md',
    result: {
      schemaVersion: 1,
      attemptId: '11111111-1111-4111-8111-111111111111',
      engine: 'parakeet',
      language: 'en',
      device: 'cuda',
      computeType: 'float32',
      transcriptHash: hash,
      modelPath: '/tmp/secret/model.onnx',
      token: 'hf_secret',
    },
  });
  proc.stdout.emit('data', Buffer.from('{"id":"meeting-1"}'));
  proc.emit('close', 0);
  await pending;
  const resultJson = spawnedArgs[spawnedArgs.indexOf('--result-json') + 1];
  const parsed = JSON.parse(resultJson);
  assert.equal(parsed.device, 'cuda');
  assert.equal(parsed.computeType, 'float32');
  assert.equal(parsed.transcriptHash, hash);
  assert.equal(resultJson.includes('modelPath'), false);
  assert.equal(resultJson.includes('hf_secret'), false);
});

test('scan recovery hook failure rejects the scan before auto-resume', async () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  let resumed = false;
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
    onScanSucceeded() { resumed = true; },
  });
  const scanPromise = client.scanRecordings({
    beforeAutoResume: async () => {
      throw new Error('request staging failed');
    },
  });
  proc.stdout.emit('data', Buffer.from('{"scanned":1,"added":1,"skipped":0}'));
  proc.emit('close', 0);
  await assert.rejects(scanPromise, /request staging failed/);
  assert.equal(resumed, false);
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

test('update-meeting serializes concurrent renames for the same meeting', async () => {
  const processes = [];
  const syncedTitles = [];
  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython() {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      processes.push(proc);
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
    afterUpdateMeeting: async (meeting) => { syncedTitles.push(meeting.title); },
  });
  const handlers = {};
  client.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  const first = handlers['update-meeting']({}, { meetingId: 'meeting', updates: { title: 'First' } });
  const second = handlers['update-meeting']({}, { meetingId: 'meeting', updates: { title: 'Second' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processes.length, 1, 'second rename must wait for the first subprocess');

  processes[0].stdout.emit('data', Buffer.from('{"id":"meeting","title":"First"}'));
  processes[0].emit('close', 0);
  assert.deepEqual(await first, { id: 'meeting', title: 'First' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processes.length, 2);

  processes[1].stdout.emit('data', Buffer.from('{"id":"meeting","title":"Second"}'));
  processes[1].emit('close', 0);
  assert.deepEqual(await second, { id: 'meeting', title: 'Second' });
  assert.deepEqual(syncedTitles, ['First', 'Second']);
});

test('getMeeting spawns --recordings-dir ... get <id> and surfaces errors', async () => {
  const spawned = [];
  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython(args) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      spawned.push({ args, proc });
      return proc;
    },
    pythonConfig: { backendPath: '/tmp/backend' },
    getBackendModuleArgs: (moduleName, args) => [moduleName, ...args],
    collectPythonProcessOutput(python) {
      let stdout = '';
      let stderr = '';
      python.stdout.on('data', (data) => { stdout += data.toString(); });
      python.stderr.on('data', (data) => { stderr += data.toString(); });
      return {
        getStdout: () => stdout,
        getStderr: () => stderr,
        assertStdoutWithinLimit() {},
      };
    },
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    assertTrustedRendererSender() {},
    sanitizeTranscriptionError: (value) => value,
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    validateAiMetadataPaths: (value) => value,
  });

  const okPromise = client.getMeeting('  meeting-42  ');
  assert.deepEqual(spawned[0].args, [
    'meeting_manager',
    '--recordings-dir',
    path.join('/tmp/avanevis-test', 'recordings'),
    'get',
    'meeting-42',
  ]);
  spawned[0].proc.stdout.emit('data', Buffer.from('{"id":"meeting-42","captionsAvailable":true}'));
  spawned[0].proc.emit('close', 0);
  assert.deepEqual(await okPromise, { id: 'meeting-42', captionsAvailable: true });

  const failPromise = client.getMeeting('missing');
  spawned[1].proc.stderr.emit('data', Buffer.from('Meeting missing not found'));
  spawned[1].proc.emit('close', 1);
  await assert.rejects(failPromise, /Meeting missing not found/);
});

test('commitTranscriptionAttempt passes --captions-candidate only when provided', async () => {
  const spawnedArgs = [];
  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython(args) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      spawnedArgs.push(args);
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from('{"id":"meeting-1"}'));
        proc.emit('close', 0);
      });
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

  const baseResult = {
    schemaVersion: 1,
    attemptId: '11111111-1111-4111-8111-111111111111',
    engine: 'whisper',
    language: 'en',
  };

  await client.commitTranscriptionAttempt('meeting-1', {
    attemptId: baseResult.attemptId,
    candidatePath: '/tmp/avanevis-test/recordings/candidate.md',
    result: baseResult,
  });
  assert.equal(spawnedArgs[0].includes('--captions-candidate'), false);

  const captionsCandidate = '/tmp/avanevis-test/recordings/meeting.captions-11111111.json';
  await client.commitTranscriptionAttempt('meeting-1', {
    attemptId: baseResult.attemptId,
    candidatePath: '/tmp/avanevis-test/recordings/candidate.md',
    captionsCandidatePath: captionsCandidate,
    result: baseResult,
  });
  const flagIndex = spawnedArgs[1].indexOf('--captions-candidate');
  assert.notEqual(flagIndex, -1);
  assert.equal(spawnedArgs[1][flagIndex + 1], captionsCandidate);
});
