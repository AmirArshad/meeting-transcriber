'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createMeetingManagerClient } = require('../../src/main/meeting-manager-client');
const { createRecordingsMaintenanceGate } = require('../../src/main/recordings-maintenance-gate');

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

async function checkDelayedScanHandoff(rejectHandoff) {
  const gate = createRecordingsMaintenanceGate();
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  const notifications = [];
  let terminated = false;
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
    recordingsMaintenanceGate: gate,
    recordingsScanTimeoutMs: 5,
    unrefRecordingsScanTimeout: false,
    terminateProcessBestEffort: async () => { terminated = true; },
    onScanSucceeded() { notifications.push('resume'); },
    onMeetingsMutated({ action }) { notifications.push(action); },
  });
  let resolveHandoff;
  let failHandoff;
  const handoff = new Promise((resolve, reject) => {
    resolveHandoff = resolve;
    failHandoff = reject;
  });
  let markHandoffStarted;
  const handoffStarted = new Promise((resolve) => { markHandoffStarted = resolve; });
  const scanPromise = client.scanRecordings({
    beforeAutoResume: () => {
      markHandoffStarted();
      return handoff;
    },
  });
  const outcome = rejectHandoff ? assert.rejects(scanPromise, /request staging failed/) : scanPromise;
  // Observe rejection even if the scanner incorrectly times out before staging settles.
  void outcome.catch(() => {});
  await Promise.resolve();
  proc.stdout.emit('data', Buffer.from('{"scanned":1,"added":1,"skipped":0}'));
  proc.emit('close', 0);
  await handoffStarted;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(gate.getOwner(), 'scan');
  assert.equal(gate.tryAcquire('start'), false);
  assert.equal(terminated, false);
  assert.deepEqual(notifications, []);

  if (rejectHandoff) failHandoff(new Error('request staging failed'));
  else resolveHandoff();
  const result = await outcome;
  if (!rejectHandoff) assert.equal(result.added, 1);
  assert.equal(gate.getOwner(), 'idle');
  assert.deepEqual(notifications, rejectHandoff ? [] : ['resume', 'scan']);
}

test('scan keeps admission past the scanner deadline until a successful handoff', () => checkDelayedScanHandoff(false));
test('scan keeps admission past the scanner deadline and suppresses success on handoff failure', () => checkDelayedScanHandoff(true));

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
  let handedOff = false;
  let notified = false;
  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython: () => proc,
    pythonConfig: { backendPath: '/tmp/backend' },
    getBackendModuleArgs: () => [],
    collectPythonProcessOutput: () => ({ getStdout: () => '{"scanned":0,"added":0,"skipped":0}', assertStdoutWithinLimit() {} }),
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
    terminateProcessBestEffort: async () => {
      assert.equal(client.isRecordingsScanInProgress(), true);
      proc.emit('close', 0);
      terminated = true;
    },
    onScanSucceeded() { notified = true; },
    onMeetingsMutated() { notified = true; },
  });

  await assert.rejects(client.scanRecordings({ beforeAutoResume() { handedOff = true; } }), /timed out/);
  assert.equal(terminated, true);
  assert.equal(handedOff, false);
  assert.equal(notified, false);
  assert.equal(client.isRecordingsScanInProgress(), false);
});

test('update-meeting preserves leading-dash titles and serializes concurrent renames', async () => {
  const processes = [];
  const syncedTitles = [];
  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython(args) {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.args = args;
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

  const first = handlers['update-meeting']({}, { meetingId: 'meeting', updates: { title: '-Standup' } });
  const second = handlers['update-meeting']({}, { meetingId: 'meeting', updates: { title: 'Second' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processes.length, 1, 'second rename must wait for the first subprocess');

  assert.deepEqual(processes[0].args.slice(-3), ['update', 'meeting', '--title=-Standup']);
  processes[0].stdout.emit('data', Buffer.from('{"id":"meeting","title":"-Standup"}'));
  processes[0].emit('close', 0);
  assert.deepEqual(await first, { id: 'meeting', title: '-Standup' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processes.length, 2);

  processes[1].stdout.emit('data', Buffer.from('{"id":"meeting","title":"Second"}'));
  processes[1].emit('close', 0);
  assert.deepEqual(await second, { id: 'meeting', title: 'Second' });
  assert.deepEqual(syncedTitles, ['-Standup', 'Second']);
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

test('addMeetingToHistory and update-meeting validate and forward --tag / --clear-tag', async () => {
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
        proc.stdout.emit('data', Buffer.from('{"id":"meeting-1","tag":"voice-note"}'));
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
  const handlers = {};
  client.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  await client.addMeetingToHistory({
    audioPath: '/tmp/avanevis-test/recordings/a.opus',
    transcriptPath: '/tmp/avanevis-test/recordings/a.md',
    duration: 12,
    tag: 'Voice Memo',
  });
  const addTagIdx = spawnedArgs[0].indexOf('--tag');
  assert.notEqual(addTagIdx, -1);
  assert.equal(spawnedArgs[0][addTagIdx + 1], 'voice-note');

  await assert.rejects(
    client.addMeetingToHistory({
      audioPath: '/tmp/avanevis-test/recordings/b.opus',
      transcriptPath: '/tmp/avanevis-test/recordings/b.md',
      duration: 12,
      tag: 'invalid-tag',
    }),
    /Unsupported recording tag/,
  );
  assert.equal(spawnedArgs.length, 1);

  await handlers['update-meeting']({}, { meetingId: 'meeting-1', updates: { tag: 'Lecture / Study' } });
  const updTagIdx = spawnedArgs[1].indexOf('--tag');
  assert.notEqual(updTagIdx, -1);
  assert.equal(spawnedArgs[1][updTagIdx + 1], 'lecture');

  await handlers['update-meeting']({}, { meetingId: 'meeting-1', updates: { tag: null } });
  assert.equal(spawnedArgs[2].includes('--clear-tag'), true);

  await handlers['update-meeting']({}, { meetingId: 'meeting-1', updates: { tag: '' } });
  assert.equal(spawnedArgs[3].includes('--clear-tag'), true);

  await handlers['update-meeting']({}, { meetingId: 'meeting-1', updates: { tag: '   ' } });
  assert.deepEqual(spawnedArgs[4].slice(-2), ['meeting-1', '--clear-tag']);

  await handlers['update-meeting']({}, { meetingId: 'meeting-1', updates: { title: 'Renamed', tag: undefined } });
  assert.deepEqual(spawnedArgs[5].slice(3), ['update', 'meeting-1', '--title=Renamed']);

  await assert.rejects(
    handlers['update-meeting']({}, { meetingId: 'meeting-1', updates: { tag: 'not-a-tag' } }),
    /Unsupported recording tag/,
  );
  assert.equal(spawnedArgs.length, 6);

  const expectedSourceTranscriptHash = `sha256:${'e'.repeat(64)}`;
  await handlers['update-meeting']({}, {
    meetingId: 'meeting-1',
    updates: {
      tag: 'interview',
      speakerNames: { 'Speaker 1': '  Ada* ', SPEAKER_03: '' },
      expectedSourceTranscriptHash,
      expectedTranscriptionAttemptId: '',
    },
  });
  assert.deepEqual(spawnedArgs[6].slice(5), [
    '--tag', 'interview',
    '--speaker-names-json', '{"Speaker 1":"Ada","SPEAKER_03":""}',
    '--expected-source-transcript-hash', expectedSourceTranscriptHash,
    '--expected-transcription-attempt-id=',
  ]);
  await assert.rejects(
    handlers['update-meeting']({}, { meetingId: 'meeting-1', updates: { speakerNames: { Unknown: 'Ada' } } }),
    /Invalid speaker names/,
  );
  await assert.rejects(
    handlers['update-meeting']({}, { meetingId: 'meeting-1', updates: { speakerNames: { 'Speaker 1': 'Ada' } } }),
    /require the current transcript/,
  );
  assert.equal(spawnedArgs.length, 7);
});
