'use strict';

/**
 * Behavioral coverage for quit / lifecycle race fixes (F1–F8 + review follow-ups).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const { createRecorderService } = require('../../src/main/recorder-service');
const { createSummaryService } = require('../../src/main/summary-service');
const { createGpuRuntimeService } = require('../../src/main/gpu-runtime-service');
const {
  runWallClockComputeAction,
  getActiveWallClockComputeJob,
  getActiveWallClockComputeJobs,
  shouldSkipQuitComputeDrain,
  isNonAbortableLongComputeJob,
  terminateNonAbortableQuitComputeJobs,
  resolveBeforeQuitAction,
  shouldKillProcessOnQuit,
  collectProcessesToKillOnQuit,
  dispatchBeforeQuitAction,
} = require('../../src/main-process-helpers');
const { createAiAddonCancelErrorStandalone } = require('../../src/main/ai-addon-ipc');

function createLongLivedProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    write(chunk) {
      proc._stopWritten = String(chunk);
    },
  };
  proc.killed = false;
  proc.pid = Math.floor(Math.random() * 100000) + 1000;
  proc.kill = () => {
    proc.killed = true;
  };
  return proc;
}

function createRecorderDeps(overrides = {}) {
  const recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-quit-rec-'));
  let quitWorkflowPromise = null;
  let allowImmediateQuit = false;
  let quitCommitted = true;
  const rendererMessages = [];
  const historyAdds = [];

  const deps = {
    app: {
      getPath: () => path.dirname(recordingsDir),
      quit() {
        deps._quitCalled = true;
      },
    },
    path,
    fs,
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
    },
    powerSaveBlocker: { start: () => 1, stop() {} },
    pythonConfig: { pythonExe: 'python', backendPath: recordingsDir, ffmpegPath: 'ffmpeg' },
    spawnTrackedPython() {
      throw new Error('spawnTrackedPython should not run unless overridden');
    },
    sendToRenderer(channel, payload) {
      rendererMessages.push({ channel, payload });
    },
    assertTrustedRendererSender() {},
    getMainWindow: () => null,
    setIsQuitting() {},
    getAllowImmediateQuit: () => allowImmediateQuit,
    setAllowImmediateQuit: (value) => { allowImmediateQuit = value; },
    getQuitWorkflowPromise: () => quitWorkflowPromise,
    setQuitWorkflowPromise: (value) => { quitWorkflowPromise = value; },
    hasInFlightAiWork: () => false,
    drainAiWorkBeforeQuit: async () => {},
    isQuitCommitted: () => quitCommitted,
    clearQuitCommitted: () => { quitCommitted = false; },
    validateSelectedDevices: async () => ({ ok: true }),
    checkDiskSpace: async () => ({ ok: true }),
    checkAudioOutputSupport: async () => ({ ok: true }),
    getMacOSPermissionStatus: async () => ({ ok: true }),
    addMeetingToHistory: async (meeting) => {
      historyAdds.push(meeting);
      return meeting;
    },
    formatDurationForTranscript: () => '0:00',
    getRecordingsDir: () => recordingsDir,
    getRecordingStopTimeoutMs: () => 30,
    ...overrides,
  };

  return {
    deps,
    recordingsDir,
    rendererMessages,
    historyAdds,
    getAllowImmediateQuit: () => allowImmediateQuit,
    getQuitCommitted: () => quitCommitted,
  };
}

async function startFakeRecording(service, handlers, proc) {
  const startPromise = handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );

  await new Promise((resolve) => setImmediate(resolve));
  proc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    type: 'event',
    event: 'recording_started',
    message: 'Recording started!',
  })}\n`));

  const startResult = await startPromise;
  assert.equal(startResult.success, true);
  return startResult;
}

test('resolveBeforeQuitAction: armed AI pass force-quits instead of re-draining', () => {
  assert.deepEqual(
    resolveBeforeQuitAction({
      immediateQuitArmed: true,
      interceptQuit: false,
      hasInFlightAiWork: true,
    }),
    { action: 'force_quit' },
  );
  assert.deepEqual(
    resolveBeforeQuitAction({
      immediateQuitArmed: true,
      interceptQuit: true,
      hasInFlightAiWork: true,
    }),
    { action: 'intercept_recording' },
  );
  assert.deepEqual(
    resolveBeforeQuitAction({
      immediateQuitArmed: false,
      interceptQuit: false,
      hasInFlightAiWork: true,
    }),
    { action: 'drain_ai' },
  );
  assert.deepEqual(
    resolveBeforeQuitAction({
      immediateQuitArmed: false,
      interceptQuit: true,
      hasInFlightAiWork: false,
    }),
    { action: 'intercept_recording' },
  );
  assert.deepEqual(
    resolveBeforeQuitAction({
      immediateQuitArmed: false,
      interceptQuit: false,
      hasInFlightAiWork: false,
    }),
    { action: 'force_quit' },
  );
});

test('shouldKillProcessOnQuit spares the protected metadata process', () => {
  const protectedProc = { killed: false };
  const otherProc = { killed: false };
  assert.equal(shouldKillProcessOnQuit(protectedProc, protectedProc), false);
  assert.equal(shouldKillProcessOnQuit(otherProc, protectedProc), true);
  assert.equal(shouldKillProcessOnQuit({ killed: true }, null), false);
  assert.equal(shouldKillProcessOnQuit(null, null), false);
});

test('collectProcessesToKillOnQuit spares protected metadata process and skips already-killed', () => {
  const protectedProc = { killed: false, pid: 1 };
  const other = { killed: false, pid: 2 };
  const dead = { killed: true, pid: 3 };
  assert.deepEqual(
    collectProcessesToKillOnQuit([protectedProc, other, dead], protectedProc),
    [other],
  );
});

test('dispatchBeforeQuitAction wires decision to the matching handler', () => {
  const calls = [];
  dispatchBeforeQuitAction(
    { action: 'intercept_recording' },
    {
      onInterceptRecording: () => calls.push('recording'),
      onDrainAi: () => calls.push('drain'),
      onForceQuit: () => calls.push('force'),
    },
  );
  dispatchBeforeQuitAction(
    { action: 'drain_ai' },
    {
      onInterceptRecording: () => calls.push('recording'),
      onDrainAi: () => calls.push('drain'),
      onForceQuit: () => calls.push('force'),
    },
  );
  dispatchBeforeQuitAction(
    { action: 'force_quit' },
    {
      onInterceptRecording: () => calls.push('recording'),
      onDrainAi: () => calls.push('drain'),
      onForceQuit: () => calls.push('force'),
    },
  );
  assert.deepEqual(calls, ['recording', 'drain', 'force']);
});

test('N1: armed AI decision dispatches force_quit (not drain) and kill list spares metadata', () => {
  const action = resolveBeforeQuitAction({
    immediateQuitArmed: true,
    interceptQuit: false,
    hasInFlightAiWork: true,
  });
  assert.equal(action.action, 'force_quit');

  const calls = [];
  dispatchBeforeQuitAction(action, {
    onInterceptRecording: () => calls.push('recording'),
    onDrainAi: () => calls.push('drain'),
    onForceQuit: () => {
      calls.push('force');
      const protectedProc = { killed: false, pid: 99 };
      const transcription = { killed: false, pid: 100 };
      const toKill = collectProcessesToKillOnQuit([protectedProc, transcription], protectedProc);
      assert.deepEqual(toKill, [transcription]);
    },
  });
  assert.deepEqual(calls, ['force']);
});

test('F1: quit cancel after stop was sent awaits stop and persists instead of claiming recording continues', async () => {
  let dialogOpened = null;
  const liveCtx = createRecorderDeps({
    dialog: {
      showMessageBox: async () => {
        dialogOpened = true;
        return { response: 0 };
      },
    },
    getRecordingStopTimeoutMs: () => 40,
  });
  const liveAudio = path.join(liveCtx.recordingsDir, 'recording_live.opus');
  fs.writeFileSync(liveAudio, 'audio');

  const longProc = createLongLivedProcess();
  liveCtx.deps.spawnTrackedPython = () => longProc;
  liveCtx.deps.isQuitCommitted = () => false;

  const liveService = createRecorderService(liveCtx.deps);
  const handlers = {};
  liveService.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  await startFakeRecording(liveService, handlers, longProc);

  setTimeout(() => {
    longProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
      success: true,
      audioPath: liveAudio,
      duration: 9,
    })}\n`));
    longProc.emit('close', 0);
  }, 120);

  await liveService.handleQuitDuringRecording({
    interceptQuit: true,
    state: 'recording',
    progressMessage: 'Stopping and saving the current recording before quitting...',
  });

  assert.equal(dialogOpened, true);
  assert.equal(liveCtx.getQuitCommitted(), false);
  assert.ok(liveCtx.historyAdds.length >= 1, 'expected meeting persisted after quit cancel');
  assert.equal(liveCtx.historyAdds[0].audioPath, liveAudio);
  assert.equal(longProc._stopWritten, 'stop\n');

  const progressText = liveCtx.rendererMessages
    .filter((entry) => entry.channel === 'recording-progress')
    .map((entry) => (typeof entry.payload === 'string' ? entry.payload : entry.payload?.message || ''))
    .join('\n');
  assert.equal(progressText.includes('Recording continues.'), false);
  assert.ok(
    liveCtx.rendererMessages.some((entry) => entry.channel === 'recording-saved-during-quit'),
    'expected recording-saved-during-quit notification',
  );
});

test('F7: recorder finishing while forced-quit dialog is open still persists (no UX lie)', async () => {
  const liveAudio = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-f7-')), 'done.opus');
  fs.mkdirSync(path.dirname(liveAudio), { recursive: true });
  fs.writeFileSync(liveAudio, 'audio');

  let resolveDialog;
  const dialogPromise = new Promise((resolve) => {
    resolveDialog = resolve;
  });

  const liveCtx = createRecorderDeps({
    dialog: {
      showMessageBox: async () => dialogPromise,
    },
    getRecordingStopTimeoutMs: () => 30,
    getRecordingsDir: () => path.dirname(liveAudio),
  });
  // Point recordings into the same dir as liveAudio for path checks.
  liveCtx.deps.getRecordingsDir = () => path.dirname(liveAudio);
  liveCtx.deps.app.getPath = () => path.dirname(path.dirname(liveAudio));

  const longProc = createLongLivedProcess();
  liveCtx.deps.spawnTrackedPython = () => longProc;
  liveCtx.deps.isQuitCommitted = () => false;

  const liveService = createRecorderService(liveCtx.deps);
  const handlers = {};
  liveService.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  await startFakeRecording(liveService, handlers, longProc);

  const quitPromise = liveService.handleQuitDuringRecording({
    interceptQuit: true,
    state: 'recording',
    progressMessage: 'Stopping...',
  });

  // Wait until stop timed out and dialog is pending, then finish the recorder
  // *before* the user answers Keep App Open (clears stopCommandSent flags).
  await new Promise((resolve) => setTimeout(resolve, 80));
  longProc.stdout.emit('data', Buffer.from(`${JSON.stringify({
    success: true,
    audioPath: liveAudio,
    duration: 3,
  })}\n`));
  longProc.emit('close', 0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  resolveDialog({ response: 0 });
  await quitPromise;

  const progressText = liveCtx.rendererMessages
    .filter((entry) => entry.channel === 'recording-progress')
    .map((entry) => (typeof entry.payload === 'string' ? entry.payload : entry.payload?.message || ''))
    .join('\n');
  assert.equal(progressText.includes('Recording continues.'), false);
  assert.ok(liveCtx.historyAdds.length >= 1, 'expected in-session history persist for F7');
  assert.ok(
    liveCtx.rendererMessages.some((entry) => entry.channel === 'recording-saved-during-quit'),
  );
});

test('F3: start-recording rejects when quit is committed', async () => {
  const ctx = createRecorderDeps({
    isQuitCommitted: () => true,
  });
  const service = createRecorderService(ctx.deps);
  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  const result = await handlers['start-recording'](
    { sender: {} },
    { micId: 0, loopbackId: 1, isFirstRecording: false },
  );
  assert.equal(result.success, false);
  assert.equal(result.code, 'QUIT_IN_PROGRESS');
});

test('F2: generate-summary enters metadata before update-ai; quit abort cannot kill it; sidecars survive', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-sum-f2-'));
  const recordingsDir = path.join(userData, 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });
  const transcriptPath = path.join(recordingsDir, 'meeting.md');
  fs.writeFileSync(transcriptPath, '# Meeting\n\nHello world.\n');

  const outputJson = path.join(recordingsDir, 'meeting.summary.json');
  const outputMarkdown = path.join(recordingsDir, 'meeting.summary.md');
  const outputJsonTemp = `${outputJson}.tmp`;
  const outputMarkdownTemp = `${outputMarkdown}.tmp`;

  const summaryResult = {
    metadata: {
      profile: 'balanced',
      model: 'test-model',
      generatedAt: new Date().toISOString(),
      sourceTranscriptHash: 'abc',
    },
    summary: { overview: 'ok' },
  };
  const updatedMeeting = {
    id: 'meeting_1',
    transcriptPath,
    ai: { summary: { status: 'completed', jsonPath: outputJson, markdownPath: outputMarkdown } },
  };

  let updateProc = null;
  let releaseUpdate = null;

  const service = createSummaryService({
    app: { getPath: () => userData },
    path,
    fs,
    pythonConfig: { backendPath: recordingsDir },
    spawnTrackedPython(args) {
      const proc = createLongLivedProcess();
      const joined = args.join(' ');
      if (joined.includes('meeting_manager') && joined.includes('get')) {
        setTimeout(() => {
          proc.stdout.emit('data', Buffer.from(JSON.stringify({
            id: 'meeting_1',
            transcriptPath,
            transcriptionStatus: 'completed',
            ai: {},
          })));
          proc.emit('close', 0);
        }, 5);
        return proc;
      }
      if (joined.includes('update-ai')) {
        updateProc = proc;
        // Hold update-ai open so we can probe metadata phase + abort refusal.
        releaseUpdate = () => {
          proc.stdout.emit('data', Buffer.from(JSON.stringify(updatedMeeting)));
          proc.emit('close', 0);
        };
        return proc;
      }
      setTimeout(() => {
        fs.writeFileSync(outputJsonTemp, '{"ok":true}');
        fs.writeFileSync(outputMarkdownTemp, '# Summary\n');
        proc.stdout.emit('data', Buffer.from(JSON.stringify(summaryResult)));
        proc.emit('close', 0);
      }, 10);
      return proc;
    },
    getBackendModuleArgs: (moduleName, extraArgs = []) => ['-m', moduleName, ...extraArgs],
    enqueueAiComputeAction: (action) => action(),
    createAiAddonCancelError: createAiAddonCancelErrorStandalone,
    getAiAddonRuntimeOptions: () => ({}),
    buildSummaryArgs: () => ['-m', 'summaries.summary_runner'],
    collectPythonProcessOutput: (python) => {
      let stdout = '';
      python.stdout.on('data', (data) => { stdout += data.toString(); });
      return {
        getStdout: () => stdout,
        getStderr: () => '',
        assertStdoutWithinLimit() {},
      };
    },
    sendToRenderer() {},
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    appendSpawnJsonStdout: (buffer, chunk) => buffer + String(chunk),
    assertTrustedRendererSender() {},
    assertSafeExistingTranscriptPath: (p) => p,
    assertSafeExistingSegmentsPath: (p) => p,
    terminateProcessBestEffort(proc) {
      if (proc) {
        proc.killed = true;
      }
    },
    summarizeSummaryValidationError: (text) => text || 'summary error',
    isQuitCommitted: () => false,
    checkAiAddonSetupStatus: async () => ({
      features: {
        summary: {
          status: 'ready',
          setupComplete: true,
          modelId: 'test-model',
        },
      },
    }),
    getSummaryArtifactForPlatform: () => ({
      modelId: 'test-model',
      modelLabel: 'Test',
      filename: 'model.gguf',
      runtime: 'llama.cpp',
    }),
    getSummaryArtifactPath: () => path.join(userData, 'model.gguf'),
    getSummaryRuntimeDir: () => path.join(userData, 'runtime'),
  });

  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  const resultPromise = handlers['generate-summary'](
    { sender: {} },
    { meetingId: 'meeting_1', profile: 'balanced' },
  );

  // Wait until update-ai is held open in metadata phase.
  for (let i = 0; i < 50 && !updateProc; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(updateProc, 'expected update-ai process');
  assert.equal(service.getActiveSummaryPhase(), 'metadata');
  assert.equal(service.canAbortActiveSummaryGeneration(), false);
  assert.equal(service.getActiveSummaryProcess(), updateProc);

  service.abortActiveSummaryForQuit('quit during metadata');
  assert.equal(updateProc.killed, false, 'metadata-phase update-ai must not be terminated by quit abort');

  assert.equal(shouldKillProcessOnQuit(updateProc, service.getActiveSummaryProcess()), false);

  releaseUpdate();
  const result = await resultPromise;

  assert.equal(result.jsonPath, outputJson);
  assert.ok(fs.existsSync(outputJson), 'final summary json must exist after successful update-ai');
  assert.ok(fs.existsSync(outputMarkdown), 'final summary md must exist after successful update-ai');
});

test('F4: terminateNonAbortableQuitComputeJobs terminates tracked transcription jobs', async () => {
  let terminated = false;
  const jobPromise = runWallClockComputeAction({
    timeoutMs: 60000,
    label: 'Transcription',
    terminateProcess: async (proc) => {
      terminated = true;
      if (proc) {
        proc.killed = true;
      }
    },
    action: async (registerProcess) => {
      registerProcess({ killed: false });
      assert.equal(getActiveWallClockComputeJob()?.label, 'Transcription');
      assert.equal(typeof getActiveWallClockComputeJob().terminate, 'function');
      // Hang until quit terminate settles the wall-clock wrapper.
      await new Promise(() => {});
    },
  });

  const rejection = assert.rejects(jobPromise, /terminated because the app is quitting/);
  const count = await terminateNonAbortableQuitComputeJobs();
  assert.equal(count, 1);
  assert.equal(terminated, true);
  await rejection;
  assert.equal(getActiveWallClockComputeJob(), null);
});


test('F4: shouldSkipQuitComputeDrain is true for transcription-class jobs', () => {
  assert.equal(shouldSkipQuitComputeDrain({ label: 'Transcription' }), true);
  assert.equal(shouldSkipQuitComputeDrain({ label: 'Speaker-guided transcription' }), true);
  assert.equal(shouldSkipQuitComputeDrain({ label: 'Speaker identification' }), true);
  assert.equal(shouldSkipQuitComputeDrain({ label: 'Transcription retry' }), true);
  assert.equal(shouldSkipQuitComputeDrain({ label: 'Summary generation' }), false);
  assert.equal(isNonAbortableLongComputeJob({ label: 'Meeting lookup' }), false);
});

test('F4/F5 helpers: active jobs are a set; GPU label does not hide transcription', async () => {
  assert.equal(getActiveWallClockComputeJobs().length, 0);

  let releaseGpu;
  const gpuPromise = runWallClockComputeAction({
    timeoutMs: 5000,
    label: 'GPU runtime setup',
    action: () => new Promise((resolve) => { releaseGpu = resolve; }),
  });

  let releaseTx;
  const txPromise = runWallClockComputeAction({
    timeoutMs: 5000,
    label: 'Transcription',
    action: () => new Promise((resolve) => { releaseTx = resolve; }),
  });

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(getActiveWallClockComputeJobs().length, 2);
  assert.equal(getActiveWallClockComputeJob()?.label, 'Transcription');
  assert.equal(shouldSkipQuitComputeDrain(getActiveWallClockComputeJob()), true);

  assert.equal(typeof releaseGpu, 'function');
  assert.equal(typeof releaseTx, 'function');
  releaseGpu('gpu-done');
  releaseTx('tx-done');
  assert.equal(await gpuPromise, 'gpu-done');
  assert.equal(await txPromise, 'tx-done');
  assert.equal(getActiveWallClockComputeJobs().length, 0);
});

test('F5: shouldKillProcessOnQuit matches kill-loop exemption contract', () => {
  const metadataProc = { killed: false, pid: 1 };
  const other = { killed: false, pid: 2 };
  assert.equal(shouldKillProcessOnQuit(metadataProc, metadataProc), false);
  assert.equal(shouldKillProcessOnQuit(other, metadataProc), true);
});

test('F8: GPU repair-recommended marker persists and is consumed once', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-gpu-marker-'));
  const service = createGpuRuntimeService({
    app: { getPath: () => userData },
    path,
    fs,
    pythonConfig: { pythonExe: 'python', backendPath: userData },
    spawnTrackedPython() { throw new Error('unused'); },
    getBackendModuleArgs: () => [],
    appendSpawnLogBuffer: (b, c) => b + String(c),
    sendRedactedProgress() {},
    flushRedactedProgress() {},
    getActivePythonVersion: async () => ({ parsed: { version: '3.11.0' }, output: '3.11.0' }),
    terminateProcessBestEffort() {},
    assertTrustedRendererSender() {},
    getDiarizationDependencySitePackagesPath: () => null,
  });

  service.markGpuRepairRecommendedAfterQuitKill('interrupted by quit');
  const markerPath = path.join(userData, 'gpu-runtime-repair-recommended.json');
  assert.ok(fs.existsSync(markerPath));

  const first = service.consumeGpuRepairRecommendedMarker();
  assert.equal(first.recommended, true);
  assert.match(first.reason, /interrupted by quit/);
  assert.equal(fs.existsSync(markerPath), false);

  const second = service.consumeGpuRepairRecommendedMarker();
  assert.equal(second, null);
});

test('generate-summary rejects when quit is committed', async () => {
  const service = createSummaryService({
    app: { getPath: () => os.tmpdir() },
    path,
    fs,
    pythonConfig: { backendPath: os.tmpdir() },
    spawnTrackedPython() { throw new Error('unused'); },
    getBackendModuleArgs: () => [],
    enqueueAiComputeAction: (action) => action(),
    createAiAddonCancelError: createAiAddonCancelErrorStandalone,
    getAiAddonRuntimeOptions: () => ({}),
    buildSummaryArgs: () => [],
    collectPythonProcessOutput: () => ({ getStdout: () => '', getStderr: () => '', assertStdoutWithinLimit() {} }),
    sendToRenderer() {},
    appendSpawnLogBuffer: (b, c) => b + String(c),
    appendSpawnJsonStdout: (b, c) => b + String(c),
    assertTrustedRendererSender() {},
    assertSafeExistingTranscriptPath: (p) => p,
    assertSafeExistingSegmentsPath: (p) => p,
    terminateProcessBestEffort() {},
    summarizeSummaryValidationError: (t) => t,
    isQuitCommitted: () => true,
  });

  const handlers = {};
  service.registerIpc({
    handle(channel, handler) {
      handlers[channel] = handler;
    },
  });

  await assert.rejects(
    () => handlers['generate-summary']({ sender: {} }, { meetingId: 'm1' }),
    /quitting/i,
  );
});
