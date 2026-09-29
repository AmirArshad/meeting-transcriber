'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createRecorderService } = require('../../src/main/recorder-service');
const { createTranscriptionService } = require('../../src/main/transcription-service');
const { getRecorderModule } = require('../../src/main-process-helpers');
const {
  normalizeRecordingStopPayload,
} = require('../../src/main-process/recorder-output-helpers');
const catalog = require('../../src/main/transcription-engine-catalog');

const APP_JS = path.join(__dirname, '../../src/renderer/app.js');

function createProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {} };
  proc.killed = false;
  proc.pid = 4242;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

function createRecorderHarness(overrides = {}) {
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-selection-'));
  const spawned = [];
  const historyAdds = [];
  const staged = [];
  const proc = createProcess();
  let quitWorkflowPromise = null;
  let allowImmediateQuit = false;
  const deps = {
    app: { getPath: () => path.dirname(recordingsDir), quit() { deps.quitCalls += 1; } },
    path,
    fs,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    powerSaveBlocker: { start: () => 1, stop() {} },
    pythonConfig: { pythonExe: 'python', backendPath: recordingsDir, ffmpegPath: 'ffmpeg' },
    spawnTrackedPython(args) {
      spawned.push(args);
      return proc;
    },
    sendToRenderer() {},
    assertTrustedRendererSender() {},
    getMainWindow: () => null,
    setIsQuitting() {},
    getAllowImmediateQuit: () => allowImmediateQuit,
    setAllowImmediateQuit(value) { allowImmediateQuit = value; },
    getQuitWorkflowPromise: () => quitWorkflowPromise,
    setQuitWorkflowPromise(value) { quitWorkflowPromise = value; },
    isQuitCommitted: () => false,
    validateSelectedDevices: async () => ({ ok: true }),
    checkDiskSpace: async () => ({ ok: true }),
    checkAudioOutputSupport: async () => ({ ok: true }),
    getMacOSPermissionStatus: async () => ({ ok: true }),
    addMeetingToHistory: async (meeting) => {
      historyAdds.push(meeting);
      return { id: 'meeting-1', ...meeting };
    },
    stageTranscriptionRequest: async (meetingId, request) => {
      staged.push({ meetingId, request });
      return { id: meetingId, transcriptionRequest: request };
    },
    listMeetings: async () => [],
    formatDurationForTranscript: () => '0:00',
    getRecordingsDir: () => recordingsDir,
    resolveRecorderModule: (platform) => getRecorderModule(platform),
    quitCalls: 0,
    ...overrides,
  };
  const service = createRecorderService(deps);
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });
  return { deps, proc, spawned, historyAdds, staged, handlers, recordingsDir, service };
}

async function startRecording(harness, selection) {
  const startPromise = harness.handlers['start-recording']({ sender: {} }, {
    micId: 0,
    loopbackId: 1,
    captureMode: 'mic-and-desktop',
    isFirstRecording: false,
    transcriptionSelection: selection,
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.proc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));
  return startPromise;
}

test('successful stop and failure with audio keep selection; cancel and missing audio do not', () => {
  const audioPath = '/tmp/avanevis-selection/meeting.opus';
  const selection = {
    schemaVersion: 1,
    attemptId: '11111111-1111-4111-8111-111111111111',
    engine: 'whisper',
    language: 'fr',
    modelSize: 'medium',
  };
  assert.equal(
    normalizeRecordingStopPayload({
      success: true,
      audioPath,
      duration: 3,
      transcriptionSelection: selection,
    }, { existsSync: () => true }).transcriptionSelection.language,
    'fr',
  );
  assert.equal(
    Object.hasOwn(
      normalizeRecordingStopPayload({
        success: true,
        cancelled: true,
        transcriptionSelection: selection,
      }, { existsSync: () => false }),
      'transcriptionSelection',
    ),
    false,
  );
  const failed = normalizeRecordingStopPayload({
    success: false,
    code: 'RECORDING_FAILED',
    message: 'failed',
    audioPath,
    transcriptionSelection: selection,
  }, { existsSync: () => true });
  assert.equal(failed.audioPath, audioPath);
  assert.equal(failed.transcriptionSelection.attemptId, selection.attemptId);
  assert.equal(
    Object.hasOwn(
      normalizeRecordingStopPayload({
        success: false,
        code: 'RECORDING_FAILED',
        message: 'failed',
        audioPath,
        transcriptionSelection: selection,
      }, { existsSync: () => false }),
      'transcriptionSelection',
    ),
    false,
  );
});

test('start snapshots the passed selection and stop keeps it when stdout omits it', async () => {
  const harness = createRecorderHarness();
  const started = await startRecording(harness, {
    engine: 'whisper',
    language: 'fr',
    modelSize: 'medium',
  });
  assert.equal(started.success, true);
  const args = harness.spawned[0];
  const selection = JSON.parse(args[args.indexOf('--transcription-selection') + 1]);
  assert.equal(selection.engine, 'whisper');
  assert.equal(selection.language, 'fr');
  assert.equal(selection.modelSize, 'medium');
  assert.match(selection.attemptId, /^[0-9a-f-]{36}$/);

  const audioPath = path.join(harness.recordingsDir, 'recording_fr.wav');
  fs.writeFileSync(audioPath, 'audio');
  const stopPromise = harness.handlers['stop-recording']({ sender: {} });
  await new Promise((resolve) => setImmediate(resolve));
  harness.proc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    success: true,
    audioPath,
    duration: 4,
  })}\n`));
  harness.proc.emit('close', 0);
  const stopped = await stopPromise;
  assert.equal(stopped.transcriptionSelection.language, 'fr');
  assert.equal(stopped.transcriptionSelection.modelSize, 'medium');
  assert.equal(stopped.transcriptionSelection.attemptId, selection.attemptId);
});

test('quit-stop stages the snapshotted request and does not enqueue transcription', async () => {
  const harness = createRecorderHarness();
  await startRecording(harness, {
    engine: 'whisper',
    language: 'de',
    modelSize: 'small',
  });
  const audioPath = path.join(harness.recordingsDir, 'recording_quit.wav');
  fs.writeFileSync(audioPath, 'audio');
  const quitPromise = harness.service.handleQuitDuringRecording({
    interceptQuit: true,
    state: 'recording',
    progressMessage: 'Saving before quit',
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.proc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    success: true,
    audioPath,
    duration: 2,
  })}\n`));
  harness.proc.emit('close', 0);
  await quitPromise;

  assert.equal(harness.historyAdds.length, 1);
  assert.equal(harness.historyAdds[0].language, 'de');
  assert.equal(harness.historyAdds[0].model, 'small');
  assert.equal(harness.historyAdds[0].transcriptionRequest.language, 'de');
  assert.equal(harness.historyAdds[0].transcriptionRequest.attemptId, harness.historyAdds[0].transcriptionRequest.attemptId);
  assert.equal(harness.staged.length, 0);
  assert.equal(harness.spawned.length, 1);
  assert.equal(fs.existsSync(audioPath), true);
  assert.equal(harness.deps.quitCalls, 1);
});

test('quit save excludes a pending row when the request is not stored', async () => {
  const excluded = [];
  const harness = createRecorderHarness({
    addMeetingToHistory: async (meeting) => ({
      id: 'meeting-1',
      audioPath: meeting.audioPath,
      transcriptionStatus: 'pending',
      language: meeting.language,
      model: meeting.model,
    }),
    stageTranscriptionRequest: async () => {
      throw new Error('metadata store unavailable');
    },
    excludeIncompleteTranscription: async (meetingId) => {
      excluded.push(meetingId);
      return { id: meetingId, transcriptionStatus: 'failed', transcriptionResumeExcluded: true };
    },
  });
  await startRecording(harness, {
    engine: 'whisper',
    language: 'de',
    modelSize: 'small',
  });
  const audioPath = path.join(harness.recordingsDir, 'recording_quit.wav');
  fs.writeFileSync(audioPath, 'audio');
  const quitPromise = harness.service.handleQuitDuringRecording({
    interceptQuit: true,
    state: 'recording',
    progressMessage: 'Saving before quit',
  });
  await new Promise((resolve) => setImmediate(resolve));
  harness.proc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    success: true,
    audioPath,
    duration: 2,
  })}\n`));
  harness.proc.emit('close', 0);
  await quitPromise;
  assert.deepEqual(excluded, ['meeting-1']);
  assert.equal(fs.existsSync(audioPath), true);
});

test('renderer stop uses the capture snapshot instead of live settings', () => {
  const source = fs.readFileSync(APP_JS, 'utf8');
  assert.match(source, /activeRecordingTranscriptionSelection = snapshotTranscriptionSelection\(\)/);
  assert.match(source, /transcriptionSelection: activeRecordingTranscriptionSelection/);
  assert.match(
    source,
    /const capturedSelection = options\.transcriptionSelection \|\| activeRecordingTranscriptionSelection/,
  );
  assert.match(source, /transcriptionSelection: capturedSelection \|\| null/);
});

test('failed request persistence does not enqueue, delete audio, or leave a resumable row', async () => {
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-finalize-'));
  const audioPath = path.join(recordingsDir, 'a.opus');
  fs.writeFileSync(audioPath, 'audio');
  let enqueued = 0;
  const rows = [];
  const service = createTranscriptionService({
    app: { getPath: () => recordingsDir, isPackaged: false },
    path,
    fs: {
      promises: {
        writeFile: async () => {},
        readFile: async () => '',
        rm: async () => { throw new Error('audio must not be deleted'); },
      },
      existsSync: () => true,
    },
    os,
    pythonConfig: { backendPath: recordingsDir, pythonPath: 'python' },
    spawnTrackedPython: () => { throw new Error('transcription must not spawn'); },
    getBackendModuleArgs: (moduleName, args) => [moduleName, ...(args || [])],
    enqueueAiComputeAction: async () => { enqueued += 1; },
    getCachedCudaStatus: () => ({ available: false }),
    buildCudaRuntimeEnv: (env) => env || {},
    getAiAddonRuntimeOptions: () => ({}),
    getDiarizationDependencyEnv: () => ({}),
    getDiarizationCacheEnv: () => ({}),
    getDiarizationDependencySitePackagesPath: () => null,
    requireAllowedModelSize: (value) => value || 'small',
    collectPythonProcessOutput: () => ({
      getStdout: () => '',
      getStderr: () => '',
      assertStdoutWithinLimit() {},
    }),
    sendToRenderer() {},
    sendRedactedProgress() {},
    flushRedactedProgress() {},
    appendSpawnLogBuffer: (buffer, chunk) => `${buffer}${chunk}`,
    appendSpawnJsonStdout: (buffer) => buffer,
    assertTrustedRendererSender() {},
    getRecordingsDir: () => recordingsDir,
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingSegmentsPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    terminateProcessBestEffort: async () => {},
    summarizeDiarizationError: (value) => value,
    sanitizeTranscriptionError: (value) => value,
    buildTranscriptionPlaceholderMarkdown: () => '# pending\n',
    formatDurationForTranscript: () => '0:00',
    addMeetingToHistory: async (meeting) => {
      const row = {
        id: 'm1',
        audioPath,
        transcriptionStatus: 'pending',
        language: meeting.language,
        model: meeting.model,
      };
      rows.push(row);
      return row;
    },
    stageTranscriptionRequest: async () => {
      throw new Error('metadata store unavailable');
    },
    excludeIncompleteTranscription: async (meetingId) => {
      const row = rows.find((item) => item.id === meetingId);
      row.transcriptionStatus = 'failed';
      row.transcriptionResumeExcluded = true;
      return row;
    },
    listMeetings: async () => rows.map((row) => ({ ...row })),
    isQuitCommitted: () => false,
  });

  const result = await service.finalizeRecordingTranscription({
    audioPath,
    language: 'en',
    modelSize: 'small',
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'PENDING_MEETING_PERSIST_FAILED');
  assert.equal(enqueued, 0);
  assert.equal(fs.existsSync(audioPath), true);
  const resumed = await service.resumePendingTranscriptions();
  assert.equal(resumed.enqueuedCount, 0);
  assert.equal(rows[0].transcriptionStatus, 'failed');
});

test('a staged Parakeet request queues with its Linux adapter instead of Whisper', {
  skip: process.platform !== 'linux' || process.arch !== 'x64',
}, async () => {
  const spec = catalog.getAdapterSpec(catalog.ADAPTERS.LINUX_CUDA);
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-parakeet-finalize-'));
  const audioPath = path.join(recordingsDir, 'a.opus');
  fs.writeFileSync(audioPath, 'audio');
  let enqueued = 0;
  let savedRequest = null;
  const service = createTranscriptionService({
    app: { getPath: () => recordingsDir, isPackaged: false },
    path,
    fs: {
      promises: { writeFile: async () => {}, readFile: async () => '' },
      existsSync: () => true,
    },
    os,
    pythonConfig: { backendPath: recordingsDir, pythonPath: 'python' },
    spawnTrackedPython: () => { throw new Error('transcription must not spawn'); },
    getBackendModuleArgs: (moduleName, args) => [moduleName, ...(args || [])],
    enqueueAiComputeAction: async () => { enqueued += 1; },
    getCachedCudaStatus: () => ({ available: false }),
    buildCudaRuntimeEnv: (env) => env || {},
    getAiAddonRuntimeOptions: () => ({}),
    getDiarizationDependencyEnv: () => ({}),
    getDiarizationCacheEnv: () => ({}),
    getDiarizationDependencySitePackagesPath: () => null,
    requireAllowedModelSize: (value) => value || 'small',
    collectPythonProcessOutput: () => ({
      getStdout: () => '',
      getStderr: () => '',
      assertStdoutWithinLimit() {},
    }),
    sendToRenderer() {},
    sendRedactedProgress() {},
    flushRedactedProgress() {},
    appendSpawnLogBuffer: (buffer, chunk) => `${buffer}${chunk}`,
    appendSpawnJsonStdout: (buffer) => buffer,
    assertTrustedRendererSender() {},
    getRecordingsDir: () => recordingsDir,
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingSegmentsPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    terminateProcessBestEffort: async () => {},
    summarizeDiarizationError: (value) => value,
    sanitizeTranscriptionError: (value) => value,
    buildTranscriptionPlaceholderMarkdown: () => '# pending\n',
    formatDurationForTranscript: () => '0:00',
    addMeetingToHistory: async (meeting) => {
      savedRequest = meeting.transcriptionRequest;
      return { id: 'm1', audioPath, ...meeting };
    },
    stageTranscriptionRequest: async () => {
      throw new Error('the request must be stored with the pending meeting');
    },
    listMeetings: async () => [],
    isQuitCommitted: () => false,
  });

  const result = await service.finalizeRecordingTranscription({
    audioPath,
    transcriptionSelection: {
      engine: 'parakeet',
      language: 'en',
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.enqueued, true);
  assert.equal(enqueued, 1);
  assert.equal(savedRequest.engine, 'parakeet');
  assert.equal(savedRequest.adapterId, spec.adapterId);
  assert.equal(savedRequest.runtimeLockId, spec.runtimeLockId);
});

test('finalize uses the captured request and ignores a renderer attempt id', async () => {
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-captured-'));
  const audioPath = path.join(recordingsDir, 'a.opus');
  fs.writeFileSync(audioPath, 'audio');
  const captured = {
    schemaVersion: 1,
    attemptId: '11111111-1111-4111-8111-111111111111',
    engine: 'whisper',
    language: 'fr',
    modelSize: 'medium',
  };
  let saved = null;
  const service = createTranscriptionService({
    app: { getPath: () => recordingsDir, isPackaged: false },
    path,
    fs: {
      promises: { writeFile: async () => {}, readFile: async () => '' },
      existsSync: () => true,
    },
    os,
    pythonConfig: { backendPath: recordingsDir, pythonPath: 'python' },
    spawnTrackedPython: () => { throw new Error('transcription must not spawn'); },
    getBackendModuleArgs: (moduleName, args) => [moduleName, ...(args || [])],
    enqueueAiComputeAction: async () => {},
    getCachedCudaStatus: () => ({ available: false }),
    buildCudaRuntimeEnv: (env) => env || {},
    getAiAddonRuntimeOptions: () => ({}),
    getDiarizationDependencyEnv: () => ({}),
    getDiarizationCacheEnv: () => ({}),
    getDiarizationDependencySitePackagesPath: () => null,
    requireAllowedModelSize: (value) => value || 'small',
    collectPythonProcessOutput: () => ({
      getStdout: () => '',
      getStderr: () => '',
      assertStdoutWithinLimit() {},
    }),
    sendToRenderer() {},
    sendRedactedProgress() {},
    flushRedactedProgress() {},
    appendSpawnLogBuffer: (buffer, chunk) => `${buffer}${chunk}`,
    appendSpawnJsonStdout: (buffer) => buffer,
    assertTrustedRendererSender() {},
    getRecordingsDir: () => recordingsDir,
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingSegmentsPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    terminateProcessBestEffort: async () => {},
    summarizeDiarizationError: (value) => value,
    sanitizeTranscriptionError: (value) => value,
    buildTranscriptionPlaceholderMarkdown: () => '# pending\n',
    formatDurationForTranscript: () => '0:00',
    consumeCapturedTranscriptionRequest: (requestedPath) => (
      requestedPath === audioPath ? captured : null
    ),
    addMeetingToHistory: async (meeting) => {
      saved = meeting;
      return { id: 'm1', audioPath, ...meeting };
    },
    listMeetings: async () => [],
    isQuitCommitted: () => false,
  });

  const result = await service.finalizeRecordingTranscription({
    audioPath,
    transcriptionSelection: {
      schemaVersion: 1,
      attemptId: '22222222-2222-4222-8222-222222222222',
      engine: 'whisper',
      language: 'en',
      modelSize: 'tiny',
    },
  });
  assert.equal(result.success, true);
  assert.equal(saved.transcriptionRequest.attemptId, captured.attemptId);
  assert.equal(saved.transcriptionRequest.language, 'fr');
  assert.equal(saved.transcriptionRequest.modelSize, 'medium');
});
