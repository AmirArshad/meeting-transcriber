'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { createTranscriptionService } = require('../../src/main/transcription-service');
const { createAsyncActionQueue } = require('../../src/main/ai-compute-queue');
const { runDiarizationOnlyProcess } = require('../../src/main-process/transcription-runtime-helpers');
const { createMeetingManagerClient } = require('../../src/main/meeting-manager-client');
const {
  QUEUE_JOB_STATUSES,
  shouldTerminateComputeJobsForMeeting,
  getTranscriptionDeleteGuardGeneration,
} = require('../../src/main-process/transcription-queue-helpers');
const {
  runWallClockComputeAction,
  getActiveWallClockComputeJobs,
} = require('../../src/main-process/compute-timeout-helpers');

function createParkableComputeQueue() {
  const pending = [];
  return {
    enqueue(action) {
      return new Promise((resolve, reject) => {
        pending.push({ action, resolve, reject });
      });
    },
    async runNext() {
      const item = pending.shift();
      if (!item) {
        return null;
      }
      try {
        const result = await item.action();
        item.resolve(result);
        return result;
      } catch (error) {
        item.reject(error);
        throw error;
      }
    },
    rejectAll(error = new Error('test queue rejected')) {
      while (pending.length > 0) {
        const item = pending.shift();
        item.reject(error);
      }
    },
    async flush() {
      while (pending.length > 0) {
        try {
          await this.runNext();
        } catch (_error) {
          // Expected when cancelled/deleted.
        }
      }
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

function createMinimalFs() {
  return {
    promises: {
      readFile: async () => '',
      writeFile: async () => {},
      rm: async () => {},
      mkdtemp: async (prefix) => `${prefix}test`,
    },
    existsSync: () => true,
  };
}

function createServiceHarness(overrides = {}) {
  const computeQueue = createParkableComputeQueue();
  let terminateCalls = 0;
  const terminatedMeetingIds = [];
  const activeWallClockJobs = [];
  const service = createTranscriptionService({
    app: { getPath: () => '/tmp/avanevis-test', isPackaged: false },
    path,
    fs: createMinimalFs(),
    os,
    pythonConfig: { backendPath: '/tmp/backend', pythonPath: 'python' },
    spawnTrackedPython: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      // Auto-settle so teardown rejects do not hang on meeting_manager children.
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from('{"id":"meeting","success":true}'));
        proc.emit('close', 0);
      });
      return proc;
    },
    getBackendModuleArgs: (moduleName, args) => [moduleName, ...args],
    enqueueAiComputeAction: (action) => computeQueue.enqueue(action),
    getCachedCudaStatus: () => ({ available: false }),
    // Compute admission never consumes the UI cache on Linux; this harness
    // models an explicit live probe finding no managed CUDA runtime.
    resolveCudaStatusForTranscription: async () => null,
    buildCudaRuntimeEnv: (env) => env || {},
    getAiAddonRuntimeOptions: () => ({}),
    getDiarizationDependencyEnv: () => ({}),
    getDiarizationCacheEnv: () => ({}),
    getDiarizationDependencySitePackagesPath: () => null,
    requireAllowedModelSize: (value) => value || 'small',
    collectPythonProcessOutput: (python) => {
      let stdout = '';
      if (python && python.stdout && typeof python.stdout.on === 'function') {
        python.stdout.on('data', (data) => { stdout += String(data); });
      }
      return {
        getStdout: () => stdout,
        getStderr: () => '',
        assertStdoutWithinLimit() {},
      };
    },
    sendToRenderer() {},
    sendRedactedProgress() {},
    flushRedactedProgress() {},
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    appendSpawnJsonStdout: (buffer) => buffer,
    assertTrustedRendererSender() {},
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingSegmentsPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    terminateProcessBestEffort: async () => {},
    summarizeDiarizationError: (value) => value,
    sanitizeTranscriptionError: (value) => value,
    buildTranscriptionPlaceholderMarkdown: () => '# pending\n',
    formatDurationForTranscript: () => '0:00',
    listMeetings: async () => [],
    isQuitCommitted: () => false,
    getActiveWallClockComputeJobs: () => activeWallClockJobs,
    waitForGpuRuntimeIdle: async () => {},
    hasInFlightGpuRuntimeAction: () => false,
    ...overrides,
  });

  function addActiveWallClockJob(label = 'Transcription', meetingId = null) {
    activeWallClockJobs.push({
      label,
      meetingId,
      terminate: async () => {
        terminateCalls += 1;
        terminatedMeetingIds.push(meetingId);
      },
    });
  }

  return {
    service,
    computeQueue,
    addActiveWallClockJob,
    getTerminateCalls: () => terminateCalls,
    getTerminatedMeetingIds: () => terminatedMeetingIds.slice(),
    getQueueState: () => service.getTranscriptionQueueStatePayload(),
  };
}

test('diarization process errors settle on close before the caller can start fallback', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let settled = false;
  const action = runDiarizationOnlyProcess({
    spawnProcess: () => child,
    args: [],
  }).then(
    () => { settled = true; },
    () => { settled = true; },
  );

  child.emit('error', new Error('spawn failed'));
  await Promise.resolve();
  assert.equal(settled, false);
  child.emit('close', -1);
  await action;
  assert.equal(settled, true);
});

test('shouldTerminateComputeJobsForMeeting only matches the active meeting', () => {
  assert.equal(shouldTerminateComputeJobsForMeeting({
    activeMeetingId: 'meeting_a',
    targetMeetingId: 'meeting_a',
  }), true);
  assert.equal(shouldTerminateComputeJobsForMeeting({
    activeMeetingId: 'meeting_a',
    targetMeetingId: 'meeting_b',
  }), false);
});

test('resumePendingTranscriptions skips discovery and admission after quit commits', async () => {
  let listCalls = 0;
  const harness = createServiceHarness({
    isQuitCommitted: () => true,
    listMeetings: async () => {
      listCalls += 1;
      return [{ id: 'pending', transcriptionStatus: 'pending' }];
    },
  });

  const result = await harness.service.resumePendingTranscriptions({ reason: 'post-scan' });
  assert.equal(result.quitSkipped, true);
  assert.equal(result.enqueuedCount, 0);
  assert.equal(listCalls, 0);
  assert.equal(harness.computeQueue.pendingCount, 0);
});

test('deleting queued B does not hang behind parked FIFO work and does not terminate A', async () => {
  const harness = createServiceHarness();
  harness.addActiveWallClockJob('Transcription', 'meeting_a');

  const jobA = harness.service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_a',
    language: 'en',
    modelSize: 'small',
  });
  const jobB = harness.service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_b',
    language: 'en',
    modelSize: 'small',
  });
  assert.equal(harness.computeQueue.pendingCount, 2);

  const started = Date.now();
  const result = await harness.service.cancelJobForDelete('meeting_b');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `queued delete must not await FIFO head (elapsed=${elapsed}ms)`);
  assert.equal(result.tombstoned, true);
  assert.equal(result.deferredSettlement, true);
  assert.equal(harness.getTerminateCalls(), 0);

  assert.throws(
    () => harness.service.admitMeetingTranscriptionJob({
      meetingId: 'meeting_b',
      language: 'en',
      modelSize: 'small',
    }),
    (error) => error && error.code === 'TRANSCRIPTION_DELETED',
  );

  harness.computeQueue.rejectAll(new Error('test teardown'));
  await Promise.allSettled([jobA, jobB]);
  // Keep tombstone for process lifetime of this harness; next tests use fresh services.
});

test('cancelJobForDelete tombstones unconditionally and blocks admission until cleared', async () => {
  const harness = createServiceHarness();
  const { service, computeQueue } = harness;

  const result = await service.cancelJobForDelete('meeting_missing');
  assert.equal(result.tombstoned, true);
  assert.equal(typeof result.generation, 'number');

  assert.throws(
    () => service.admitMeetingTranscriptionJob({
      meetingId: 'meeting_missing',
      language: 'en',
      modelSize: 'small',
    }),
    (error) => error && error.code === 'TRANSCRIPTION_DELETED',
  );

  await service.clearMeetingDeleteGuard('meeting_missing', result.generation);
  const promise = service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_missing',
    language: 'en',
    modelSize: 'small',
  });
  const secondDelete = await service.cancelJobForDelete('meeting_missing');
  computeQueue.rejectAll(new Error('test teardown'));
  await promise.catch(() => {});
  await service.clearMeetingDeleteGuard('meeting_missing', secondDelete.generation);
});

test('admitMeetingTranscriptionJob rejects duplicate in-flight without overwriting the queue row', async () => {
  const harness = createServiceHarness();
  const { service, getQueueState, computeQueue } = harness;

  const first = service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_dup',
    language: 'en',
    modelSize: 'small',
    title: 'First',
  });
  assert.equal(getQueueState().jobs[0].title, 'First');

  assert.throws(
    () => service.admitMeetingTranscriptionJob({
      meetingId: 'meeting_dup',
      language: 'en',
      modelSize: 'small',
      title: 'Second',
    }),
    (error) => error && error.code === 'TRANSCRIPTION_ALREADY_IN_FLIGHT',
  );
  assert.equal(getQueueState().jobs[0].title, 'First');

  const deleted = await service.cancelJobForDelete('meeting_dup');
  computeQueue.rejectAll(new Error('test teardown'));
  await first.catch(() => {});
  await service.clearMeetingDeleteGuard('meeting_dup', deleted.generation);
});

test('cancel queued B persists durable failed and quit/head neither spawns nor overwrites it', async () => {
  const statusUpdates = [];
  const spawnCommands = [];
  let quitCommitted = false;
  let transcriptionWallClocks = 0;

  const harness = createServiceHarness({
    isQuitCommitted: () => quitCommitted,
    spawnTrackedPython: (args) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      const argList = Array.isArray(args) ? args.map(String) : [];
      spawnCommands.push(argList);
      if (argList.includes('update-transcription')) {
        const statusIdx = argList.indexOf('--status');
        statusUpdates.push({
          meetingId: argList[argList.indexOf('update-transcription') + 1],
          status: statusIdx >= 0 ? argList[statusIdx + 1] : null,
        });
      }
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          id: 'meeting_b',
          transcriptionStatus: statusUpdates.length
            ? statusUpdates[statusUpdates.length - 1].status
            : 'failed',
          transcriptionError: 'Cancelled by user',
        })));
        proc.emit('close', 0);
      });
      return proc;
    },
    collectPythonProcessOutput: (python) => {
      let stdout = '';
      if (python && python.stdout && typeof python.stdout.on === 'function') {
        python.stdout.on('data', (data) => { stdout += String(data); });
      }
      return {
        getStdout: () => stdout,
        getStderr: () => '',
        assertStdoutWithinLimit() {},
      };
    },
    runWallClockComputeAction: async ({ label, action }) => {
      const labelText = String(label || '');
      if (/^Transcription(\b|$)/i.test(labelText)
        || /^Transcription retry(\b|$)/i.test(labelText)
        || /^Speaker-guided transcription(\b|$)/i.test(labelText)) {
        transcriptionWallClocks += 1;
      }
      return action((proc) => proc);
    },
  });

  const handlers = {};
  harness.service.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  const jobB = harness.service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_b',
    language: 'en',
    modelSize: 'small',
  });
  assert.equal(harness.getQueueState().jobs[0].status, QUEUE_JOB_STATUSES.queued);

  const result = await handlers['cancel-pending-transcription']({}, { meetingId: 'meeting_b' });
  assert.equal(result.success, true);
  assert.equal(result.cancelled, true);
  assert.equal(
    result.deferredSettlement,
    false,
    'queued cancel must clear inFlight so Retry can re-admit immediately',
  );
  assert.ok(
    statusUpdates.some((entry) => entry.meetingId === 'meeting_b' && entry.status === 'failed'),
    'queued cancel must persist durable failed before quit can leave pending',
  );
  assert.equal(
    harness.getQueueState().jobs.find((job) => job.meetingId === 'meeting_b').status,
    QUEUE_JOB_STATUSES.failed,
  );

  const statusesAfterCancel = statusUpdates.map((entry) => entry.status);
  const spawnsAfterCancel = spawnCommands.length;
  const wallClocksAfterCancel = transcriptionWallClocks;

  // Simulate quit immediately after cancel, then let B's parked FIFO closure run.
  quitCommitted = true;
  await harness.computeQueue.flush();
  await jobB.catch((error) => {
    assert.ok(
      error && (error.code === 'TRANSCRIPTION_QUIT_SKIPPED' || error.code === 'TRANSCRIPTION_CANCELLED'),
      `expected quit/cancel skip, got ${(error && error.code) || error}`,
    );
  });

  assert.equal(
    transcriptionWallClocks,
    wallClocksAfterCancel,
    'quit/head must not start a transcription wall-clock job for cancelled B',
  );
  assert.equal(
    spawnCommands.filter((args) => args.some((arg) => /whisper|transcrib/i.test(String(arg)))).length,
    0,
    'quit/head must not spawn a Whisper/transcription process for cancelled B',
  );
  assert.deepEqual(
    statusUpdates.map((entry) => entry.status).slice(statusesAfterCancel.length),
    [],
    'quit/head must not overwrite durable failed with pending/completed',
  );
  assert.equal(
    statusUpdates.every((entry) => entry.status === 'failed'),
    true,
  );
  assert.equal(
    harness.getQueueState().jobs.some(
      (job) => job.meetingId === 'meeting_b' && job.status === QUEUE_JOB_STATUSES.ready,
    ),
    false,
  );
  assert.equal(spawnsAfterCancel, spawnCommands.length);
});

test('queued cancel clears inFlight so Retry can re-admit immediately', async () => {
  const harness = createServiceHarness();
  const handlers = {};
  harness.service.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  const jobA = harness.service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_a',
    language: 'en',
    modelSize: 'small',
  });
  const jobB = harness.service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_b',
    language: 'en',
    modelSize: 'small',
  });

  const cancelResult = await handlers['cancel-pending-transcription']({}, { meetingId: 'meeting_b' });
  assert.equal(cancelResult.success, true);
  assert.equal(cancelResult.deferredSettlement, false);

  // Retry must succeed immediately without waiting for A's FIFO slot.
  const retryPromise = harness.service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_b',
    language: 'en',
    modelSize: 'small',
  });
  assert.equal(
    harness.getQueueState().jobs.find((job) => job.meetingId === 'meeting_b').status,
    QUEUE_JOB_STATUSES.queued,
  );

  const cancelError = Object.assign(new Error('Cancelled by user'), { code: 'TRANSCRIPTION_CANCELLED' });
  for (const pending of [jobA, jobB, retryPromise]) {
    pending.catch(() => {});
  }
  harness.computeQueue.rejectAll(cancelError);
  await Promise.allSettled([jobA, jobB, retryPromise]);
});

test('stale delete clear after recycle cannot drop a newer tombstone', async () => {
  const harness = createServiceHarness();
  const first = await harness.service.cancelJobForDelete('meeting_recycle');
  await harness.service.clearMeetingDeleteGuard('meeting_recycle', first.generation);

  const second = await harness.service.cancelJobForDelete('meeting_recycle');
  assert.ok(second.generation > first.generation);

  const stale = await harness.service.clearMeetingDeleteGuard('meeting_recycle', first.generation);
  assert.equal(stale.cleared, false);
  assert.equal(stale.stale, true);

  assert.throws(
    () => harness.service.admitMeetingTranscriptionJob({
      meetingId: 'meeting_recycle',
      language: 'en',
      modelSize: 'small',
    }),
    (error) => error && error.code === 'TRANSCRIPTION_DELETED',
  );

  const cleared = await harness.service.clearMeetingDeleteGuard('meeting_recycle', second.generation);
  assert.equal(cleared.cleared, true);
});

test('delete during final AI metadata persistence does not mark Ready', async () => {
  let releaseMetadata;
  const metadataGate = new Promise((resolve) => {
    releaseMetadata = resolve;
  });
  let metadataStarted = false;
  const meeting = {
    id: 'meeting_sidecar',
    audioPath: '/tmp/avanevis-test/recordings/meeting_sidecar.opus',
    transcriptPath: '/tmp/avanevis-test/recordings/meeting_sidecar.md',
    duration: 12,
    title: 'Sidecar',
  };

  const harness = createServiceHarness({
    enqueueAiComputeAction: (action) => action(),
    updateMeetingAiMetadata: async () => {
      metadataStarted = true;
      await metadataGate;
      return { ...meeting, ai: { diarization: null } };
    },
    runWallClockComputeAction: async ({ label, action, meetingId }) => {
      if (String(label).startsWith('Meeting lookup')) {
        return meeting;
      }
      if (String(label).startsWith('Meeting status update')) {
        return { ...meeting, transcriptionStatus: 'completed' };
      }
      if (String(label).includes('Transcription')) {
        return {
          duration: 12,
          segments: [],
          output_file: meeting.transcriptPath,
          device: 'cpu',
          meetingId,
        };
      }
      return action((proc) => proc);
    },
  });

  const jobPromise = harness.service.admitMeetingTranscriptionJob({
    meetingId: meeting.id,
    language: 'en',
    modelSize: 'small',
    clearPriorDiarization: true,
  });

  // Wait until sidecar metadata persistence is paused.
  for (let i = 0; i < 50 && !metadataStarted; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(metadataStarted, true, 'expected updateMeetingAiMetadata to start');

  const deletePromise = harness.service.cancelJobForDelete(meeting.id);
  // Active delete awaits settlement — release the paused metadata write so it can observe the tombstone.
  releaseMetadata();
  const deleted = await deletePromise;

  await assert.rejects(jobPromise, (error) => error && error.code === 'TRANSCRIPTION_DELETED');
  const readyRows = harness.getQueueState().jobs.filter(
    (job) => job.meetingId === meeting.id && job.status === QUEUE_JOB_STATUSES.ready,
  );
  assert.equal(readyRows.length, 0);
  await harness.service.clearMeetingDeleteGuard(meeting.id, deleted.generation);
});

test('terminateActiveTranscriptionComputeJobs only kills wall-clock jobs for the target meeting', async () => {
  const terminateLog = [];
  const jobs = [
    {
      label: 'Transcription',
      meetingId: 'meeting_a',
      terminate: async () => { terminateLog.push('meeting_a'); },
    },
    {
      label: 'Meeting lookup',
      meetingId: 'meeting_b',
      terminate: async () => { terminateLog.push('meeting_b'); },
    },
  ];

  let releaseLookup;
  const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });

  const harness = createServiceHarness({
    enqueueAiComputeAction: async (action) => action(),
    getActiveWallClockComputeJobs: () => jobs,
    runWallClockComputeAction: async ({ label, meetingId }) => {
      if (String(label).startsWith('Meeting lookup') && meetingId === 'meeting_a') {
        // Become active, then wait so delete can observe activeMeetingId.
        await lookupGate;
        return {
          id: 'meeting_a',
          audioPath: '/tmp/avanevis-test/recordings/a.opus',
          transcriptPath: '/tmp/avanevis-test/recordings/a.md',
        };
      }
      return {
        duration: 1,
        segments: [],
        output_file: '/tmp/avanevis-test/recordings/a.md',
        device: 'cpu',
      };
    },
  });

  const jobPromise = harness.service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_a',
    language: 'en',
    modelSize: 'small',
  });

  for (let i = 0; i < 40; i += 1) {
    if (harness.getQueueState().activeMeetingId === 'meeting_a') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(harness.getQueueState().activeMeetingId, 'meeting_a');

  const deletePromise = harness.service.cancelJobForDelete('meeting_a');
  // Allow terminate to run; settlement still waits on the paused lookup.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(terminateLog, ['meeting_a']);
  releaseLookup();
  const deleted = await deletePromise;
  await jobPromise.catch(() => {});
  await harness.service.clearMeetingDeleteGuard('meeting_a', deleted.generation);
});

test('stale clearMeetingDeleteGuard cannot drop a newer delete reservation', async () => {
  const harness = createServiceHarness();
  const first = await harness.service.cancelJobForDelete('meeting_race');
  const second = await harness.service.cancelJobForDelete('meeting_race');
  assert.notEqual(first.generation, second.generation);

  const stale = await harness.service.clearMeetingDeleteGuard('meeting_race', first.generation);
  assert.equal(stale.cleared, false);
  assert.equal(stale.stale, true);
  assert.equal(
    getTranscriptionDeleteGuardGeneration(
      {
        deleteGuardGenerations: new Map([['meeting_race', second.generation]]),
      },
      'meeting_race',
    ),
    second.generation,
  );

  // Still blocked for admission.
  assert.throws(
    () => harness.service.admitMeetingTranscriptionJob({
      meetingId: 'meeting_race',
      language: 'en',
      modelSize: 'small',
    }),
    (error) => error && error.code === 'TRANSCRIPTION_DELETED',
  );

  const cleared = await harness.service.clearMeetingDeleteGuard('meeting_race', second.generation);
  assert.equal(cleared.cleared, true);
});

test('runWallClockComputeAction records meetingId for scoped terminate', async () => {
  const actionPromise = runWallClockComputeAction({
    timeoutMs: 1000,
    label: 'Meeting lookup',
    meetingId: 'meeting_attr',
    terminateProcess: async () => {},
    action: async () => {
      const active = getActiveWallClockComputeJobs();
      assert.equal(active.length, 1);
      assert.equal(active[0].meetingId, 'meeting_attr');
      return { ok: true };
    },
  });
  assert.deepEqual(await actionPromise, { ok: true });
});

test('delete-meeting clears tombstone in finally after beforeDeleteMeeting', async () => {
  let beforeCalls = 0;
  let afterCalls = 0;
  let afterPrep = null;
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython: () => proc,
    pythonConfig: { backendPath: '/tmp/backend' },
    getBackendModuleArgs: (moduleName, args) => [moduleName, ...args],
    collectPythonProcessOutput: () => ({
      getStdout: () => '',
      getStderr: () => '',
      assertStdoutWithinLimit() {},
    }),
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    assertTrustedRendererSender() {},
    sanitizeTranscriptionError: (value) => value,
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    validateAiMetadataPaths: (value) => value,
    beforeDeleteMeeting: async () => {
      beforeCalls += 1;
      return { tombstoned: true, generation: 7 };
    },
    afterDeleteMeeting: async (_id, prep) => {
      afterCalls += 1;
      afterPrep = prep;
    },
  });
  const handlers = {};
  client.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  const deletePromise = handlers['delete-meeting']({}, 'meeting_z');
  await Promise.resolve();
  assert.equal(beforeCalls, 1);
  assert.equal(afterCalls, 0);
  proc.emit('close', 0);
  await deletePromise;
  assert.equal(afterCalls, 1);
  assert.equal(afterPrep && afterPrep.generation, 7);
});

test('delete-meeting still clears tombstone when meeting_manager delete fails', async () => {
  let afterCalls = 0;
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();

  const client = createMeetingManagerClient({
    app: { getPath: () => '/tmp/avanevis-test' },
    path,
    spawnTrackedPython: () => proc,
    pythonConfig: { backendPath: '/tmp/backend' },
    getBackendModuleArgs: (moduleName, args) => [moduleName, ...args],
    collectPythonProcessOutput: () => ({
      getStdout: () => '',
      getStderr: () => '',
      assertStdoutWithinLimit() {},
    }),
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    assertTrustedRendererSender() {},
    sanitizeTranscriptionError: (value) => value,
    getRecordingsDir: () => '/tmp/avanevis-test/recordings',
    assertSafeExistingRecordingAudioPath: (value) => value,
    assertSafeExistingTranscriptPath: (value) => value,
    validateAiMetadataPaths: (value) => value,
    beforeDeleteMeeting: async () => ({ generation: 1 }),
    afterDeleteMeeting: async () => {
      afterCalls += 1;
    },
  });
  const handlers = {};
  client.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });

  const deletePromise = handlers['delete-meeting']({}, 'meeting_fail');
  await Promise.resolve();
  proc.stderr.emit('data', Buffer.from('boom'));
  proc.emit('close', 1);
  await assert.rejects(deletePromise, /Failed to delete meeting/);
  assert.equal(afterCalls, 1);
});

// --- v2.10 Slice A policy wiring -------------------------------------------
// New work (finalize, transcribe-audio*, explicit retry) accepts curated
// Small/Medium + 11-language lists only; resume keeps legacy compat.

const SLICE_A_REJECTIONS = [
  [{ language: 'fa', modelSize: 'small' }, 'UNSUPPORTED_LANGUAGE'],
  [{ language: 'en', modelSize: 'tiny' }, 'UNSUPPORTED_MODEL'],
  [{ language: 'en', modelSize: 'base' }, 'UNSUPPORTED_MODEL'],
  [{ language: 'en', modelSize: 'large' }, 'UNSUPPORTED_MODEL'],
  [{ language: 'en', modelSize: 'large-v3' }, 'UNSUPPORTED_MODEL'],
  [{ language: '', modelSize: 'small' }, 'UNSUPPORTED_LANGUAGE'],
  [{ language: 'en', modelSize: '' }, 'UNSUPPORTED_MODEL'],
  [{ language: 'xx', modelSize: 'small' }, 'UNSUPPORTED_LANGUAGE'],
];

function createCountingFs(counts) {
  return {
    promises: {
      readFile: async () => '',
      writeFile: async () => { counts.writes += 1; },
      rm: async () => {},
      mkdtemp: async (prefix) => `${prefix}test`,
    },
    existsSync: () => true,
  };
}

function registerHandlers(harness) {
  const handlers = {};
  harness.service.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });
  return handlers;
}

test('standalone Parakeet validation waits for the transcription resource slot', async () => {
  const resourceQueue = createAsyncActionQueue();
  let transcriptionActive = false;
  let releaseTranscription;
  let markTranscriptionStarted;
  const transcriptionStarted = new Promise((resolve) => { markTranscriptionStarted = resolve; });
  const transcriptionHold = new Promise((resolve) => { releaseTranscription = resolve; });
  const activeTranscription = resourceQueue.enqueue(async () => {
    transcriptionActive = true;
    markTranscriptionStarted();
    await transcriptionHold;
    transcriptionActive = false;
  });
  await transcriptionStarted;

  let validationCalls = 0;
  const harness = createServiceHarness({
    createAbortableComputeAction: ({ cancelSignal, action }) => resourceQueue.enqueue(async () => {
      if (cancelSignal && cancelSignal.aborted) {
        throw Object.assign(new Error('Canceled'), { code: 'AI_ADDON_SETUP_CANCELLED' });
      }
      return action();
    }),
    validateParakeetImplementation: async () => {
      assert.equal(transcriptionActive, false, 'the Parakeet probe must wait for transcription');
      validationCalls += 1;
      return { ok: true, engine: 'parakeet', status: 'ready' };
    },
  });
  const handlers = registerHandlers(harness);
  const validation = handlers['validate-transcription-engine']({}, { engine: 'parakeet' });
  let validationSettledWhileTranscribing = false;
  validation.then(() => { validationSettledWhileTranscribing = true; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const callsWhileTranscribing = validationCalls;
  const settledWhileTranscribing = validationSettledWhileTranscribing;

  releaseTranscription();
  await activeTranscription;
  const result = await validation;

  assert.equal(callsWhileTranscribing, 0);
  assert.equal(settledWhileTranscribing, false);
  assert.equal(validationCalls, 1);
  assert.equal(result.status, 'ready');
});

test('Parakeet repair admission holds promotion until an active transcription releases the resource slot', async () => {
  const resourceQueue = createAsyncActionQueue();
  let transcriptionActive = false;
  let releaseTranscription;
  let markTranscriptionStarted;
  const transcriptionStarted = new Promise((resolve) => { markTranscriptionStarted = resolve; });
  const transcriptionHold = new Promise((resolve) => { releaseTranscription = resolve; });
  const activeTranscription = resourceQueue.enqueue(async () => {
    transcriptionActive = true;
    markTranscriptionStarted();
    await transcriptionHold;
    transcriptionActive = false;
  });
  await transcriptionStarted;

  let staged = false;
  let promoted = false;
  const harness = createServiceHarness({
    createAbortableComputeAction: ({ cancelSignal, action }) => resourceQueue.enqueue(async () => {
      if (cancelSignal && cancelSignal.aborted) {
        throw Object.assign(new Error('Canceled'), { code: 'AI_ADDON_SETUP_CANCELLED' });
      }
      return action();
    }),
    setupParakeetImplementation: async ({ runValidationAndPromotion }) => {
      staged = true;
      return runValidationAndPromotion({
        action: async () => {
          assert.equal(transcriptionActive, false, 'staged GPU validation must wait for transcription');
          promoted = true;
          return { ok: true, engine: 'parakeet', status: 'ready' };
        },
      });
    },
  });
  const handlers = registerHandlers(harness);
  const setup = handlers['setup-transcription-engine']({}, {
    engine: 'parakeet', operation: 'repair',
  });
  let setupSettledWhileTranscribing = false;
  setup.then(() => { setupSettledWhileTranscribing = true; });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const promotedWhileTranscribing = promoted;
  const settledWhileTranscribing = setupSettledWhileTranscribing;

  releaseTranscription();
  await activeTranscription;
  const result = await setup;

  assert.equal(staged, true);
  assert.equal(promotedWhileTranscribing, false);
  assert.equal(settledWhileTranscribing, false);
  assert.equal(promoted, true);
  assert.equal(result.status, 'ready');
});

test('Slice A: finalize rejects unsupported new selections before persistence', async () => {
  for (const [input, code] of SLICE_A_REJECTIONS) {
    const counts = { writes: 0, persists: 0 };
    const harness = createServiceHarness({
      fs: createCountingFs(counts),
      addMeetingToHistory: async (meeting) => {
        counts.persists += 1;
        return { id: 'm1', audioPath: '/tmp/avanevis-test/recordings/a.opus', ...meeting };
      },
    });
    await assert.rejects(
      harness.service.finalizeRecordingTranscription({
        audioPath: '/tmp/avanevis-test/recordings/a.opus',
        ...input,
      }),
      (error) => error && error.code === code,
      `finalize must reject ${JSON.stringify(input)} with ${code}`,
    );
    assert.equal(counts.writes, 0, 'rejection must precede placeholder write');
    assert.equal(counts.persists, 0, 'rejection must precede meeting persist');
    assert.equal(harness.getQueueState().jobs.length, 0, 'rejection must not queue');
  }
});

test('Slice A: finalize persists and enqueues a curated selection', async () => {
  const counts = { writes: 0, persists: 0 };
  let persisted = null;
  const harness = createServiceHarness({
    fs: createCountingFs(counts),
    addMeetingToHistory: async (meeting) => {
      counts.persists += 1;
      persisted = meeting;
      return { id: 'm1', audioPath: '/tmp/avanevis-test/recordings/a.opus', title: 'T', ...meeting };
    },
  });
  const result = await harness.service.finalizeRecordingTranscription({
    audioPath: '/tmp/avanevis-test/recordings/a.opus',
    language: 'en',
    modelSize: 'medium',
  });
  assert.equal(result.success, true);
  assert.equal(counts.writes, 1);
  assert.equal(counts.persists, 1);
  assert.equal(persisted.language, 'en');
  assert.equal(persisted.model, 'medium');
  assert.equal(harness.getQueueState().jobs.length, 1);
  harness.computeQueue.rejectAll(new Error('test teardown'));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('Slice A: transcribe-audio validates raw selection before queueing', async () => {
  for (const [input, code] of SLICE_A_REJECTIONS) {
    const harness = createServiceHarness();
    const handlers = registerHandlers(harness);
    await assert.rejects(
      handlers['transcribe-audio']({}, { audioFile: '/tmp/a.opus', ...input }),
      (error) => error && error.code === code,
      `transcribe-audio must reject ${JSON.stringify(input)} with ${code}`,
    );
    assert.equal(harness.computeQueue.pendingCount, 0, 'rejection must not queue');
  }

  // Genuinely omitted fields still take safe defaults; present-but-empty rejects.
  const defaults = createServiceHarness();
  const defaultHandlers = registerHandlers(defaults);
  const queued = defaultHandlers['transcribe-audio']({}, { audioFile: '/tmp/a.opus' });
  assert.equal(defaults.computeQueue.pendingCount, 1);
  defaults.computeQueue.rejectAll(new Error('test teardown'));
  await assert.rejects(queued);

  const queuedMedium = createServiceHarness();
  const mediumHandlers = registerHandlers(queuedMedium);
  const mediumPromise = mediumHandlers['transcribe-audio'](
    {}, { audioFile: '/tmp/a.opus', language: 'es', modelSize: 'medium' },
  );
  assert.equal(queuedMedium.computeQueue.pendingCount, 1);
  queuedMedium.computeQueue.rejectAll(new Error('test teardown'));
  await assert.rejects(mediumPromise);
});

test('Slice A: transcribe-audio-with-speakers rejects before any setup work', async () => {
  for (const [input, code] of SLICE_A_REJECTIONS) {
    const harness = createServiceHarness();
    const handlers = registerHandlers(harness);
    await assert.rejects(
      handlers['transcribe-audio-with-speakers']({}, { audioFile: '/tmp/a.opus', ...input }),
      (error) => error && error.code === code,
      `transcribe-audio-with-speakers must reject ${JSON.stringify(input)} with ${code}`,
    );
    assert.equal(harness.computeQueue.pendingCount, 0, 'rejection must not queue');
  }
});

const SLICE_A_LEGACY_MEETING = {
  id: 'legacy_retry',
  audioPath: '/tmp/avanevis-test/recordings/r.opus',
  transcriptPath: '/tmp/avanevis-test/recordings/r.md',
  language: 'fa',
  model: 'tiny',
  title: 'Legacy',
};

function createRetryHarness(meeting = SLICE_A_LEGACY_MEETING) {
  const stagedRequests = [];
  return {
    ...createServiceHarness({
      runWallClockComputeAction: async ({ label, action }) => {
        if (String(label).startsWith('Meeting lookup')) {
          return { ...meeting };
        }
        return action((proc) => proc, { signal: undefined });
      },
      stageTranscriptionRequest: async (_meetingId, request) => {
        stagedRequests.push({ ...request });
        return { ...meeting, transcriptionRequest: { ...request } };
      },
    }),
    stagedRequests,
  };
}

async function settleAdmitted(harness, promise) {
  // The retry handler awaits meeting lookup before admission, so the queue
  // row appears a tick after the call. Settle the parked job afterwards.
  let outcome = null;
  promise.then(
    () => { outcome = 'resolved'; },
    () => { outcome = 'rejected'; },
  );
  const deadline = Date.now() + 2000;
  while (harness.getQueueState().jobs.length < 1 && outcome === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(outcome, null, 'admission must not reject before queueing');
  assert.equal(harness.getQueueState().jobs.length, 1);
  harness.computeQueue.rejectAll(new Error('test teardown'));
  await assert.rejects(promise);
}

test('ordinary retry ignores caller settings and stages a new attempt with the saved engine selection', async () => {
  const savedWhisperRequest = {
    schemaVersion: 1,
    attemptId: '00000000-0000-4000-8000-000000000001',
    engine: 'whisper', language: 'fa', modelSize: 'tiny', artifactRevision: null,
  };
  const whisperMeeting = { ...SLICE_A_LEGACY_MEETING, transcriptionRequest: savedWhisperRequest };
  const whisperHarness = createRetryHarness(whisperMeeting);
  const whisperHandlers = registerHandlers(whisperHarness);
  const whisperRetry = whisperHandlers['retry-transcription'](
    {}, { meetingId: whisperMeeting.id, language: 'fr', modelSize: 'small', engine: 'whisper' },
  );
  await settleAdmitted(whisperHarness, whisperRetry);
  assert.equal(whisperHarness.stagedRequests.length, 1);
  assert.equal(whisperHarness.stagedRequests[0].engine, 'whisper');
  assert.equal(whisperHarness.stagedRequests[0].language, 'fa');
  assert.equal(whisperHarness.stagedRequests[0].modelSize, 'tiny');
  assert.notEqual(whisperHarness.stagedRequests[0].attemptId, savedWhisperRequest.attemptId);

  const { resolveTranscriptionRequest } = require('../../src/main/transcription-engine-resolver');
  const resolvedParakeet = resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, {
    platform: process.platform, arch: process.arch, osRelease: '24.0.0',
  });
  assert.equal(resolvedParakeet.ok, true);
  const savedParakeetRequest = {
    ...resolvedParakeet.request,
    attemptId: '00000000-0000-4000-8000-000000000002',
  };
  const parakeetMeeting = { ...SLICE_A_LEGACY_MEETING, transcriptionRequest: savedParakeetRequest };
  const parakeetHarness = createRetryHarness(parakeetMeeting);
  const parakeetHandlers = registerHandlers(parakeetHarness);
  const parakeetRetry = parakeetHandlers['retry-transcription'](
    {}, { meetingId: parakeetMeeting.id, language: 'fr', modelSize: 'small', engine: 'whisper' },
  );
  await settleAdmitted(parakeetHarness, parakeetRetry);
  assert.equal(parakeetHarness.stagedRequests[0].engine, 'parakeet');
  assert.equal(parakeetHarness.stagedRequests[0].adapterId, savedParakeetRequest.adapterId);
  assert.equal(parakeetHarness.stagedRequests[0].artifactRevision, savedParakeetRequest.artifactRevision);
  assert.notEqual(parakeetHarness.stagedRequests[0].attemptId, savedParakeetRequest.attemptId);
});

test('explicit Whisper retry stages the requested Whisper selection without changing the saved engine preference', async () => {
  const { resolveTranscriptionRequest } = require('../../src/main/transcription-engine-resolver');
  const resolvedParakeet = resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, {
    platform: process.platform, arch: process.arch, osRelease: '24.0.0',
  });
  assert.equal(resolvedParakeet.ok, true);
  const savedParakeetRequest = {
    ...resolvedParakeet.request,
    attemptId: '00000000-0000-4000-8000-000000000003',
  };
  const meeting = { ...SLICE_A_LEGACY_MEETING, transcriptionRequest: savedParakeetRequest };
  const harness = createRetryHarness(meeting);
  const handlers = registerHandlers(harness);

  const retry = handlers['retry-transcription']({}, {
    meetingId: meeting.id,
    transcriptionSelection: { engine: 'whisper', language: 'fr', modelSize: 'medium' },
  });
  await settleAdmitted(harness, retry);

  assert.equal(harness.stagedRequests.length, 1);
  assert.equal(harness.stagedRequests[0].engine, 'whisper');
  assert.equal(harness.stagedRequests[0].language, 'fr');
  assert.equal(harness.stagedRequests[0].modelSize, 'medium');
  assert.notEqual(harness.stagedRequests[0].attemptId, savedParakeetRequest.attemptId);
  assert.equal(meeting.transcriptionRequest.engine, 'parakeet');
  assert.equal(meeting.transcriptionRequest.attemptId, savedParakeetRequest.attemptId);
});

test('queued Parakeet request is snapshotted before waiting for the compute queue', async () => {
  const { resolveTranscriptionRequest } = require('../../src/main/transcription-engine-resolver');
  const resolved = resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, {
    platform: process.platform, arch: process.arch, osRelease: '24.0.0',
  });
  assert.equal(resolved.ok, true);
  const request = { ...resolved.request };
  const storedRequest = { ...request };
  const meeting = {
    id: 'queued-parakeet', audioPath: '/tmp/avanevis-test/recordings/a.opus',
    transcriptPath: '/tmp/avanevis-test/recordings/a.md', transcriptionRequest: storedRequest,
  };
  const device = request.adapterId.includes('metal') ? 'metal' : 'cuda';
  let receivedRequest = null;
  const harness = createServiceHarness({
    runWallClockComputeAction: async ({ label, action }) => (
      String(label).startsWith('Meeting lookup')
        ? meeting
        : action((proc) => proc, { signal: undefined })
    ),
    getGuidedDiarizationStatusForJob: async () => null,
    getParakeetStatusForJob: () => ({ status: 'ready', artifactRevision: request.artifactRevision,
      runtimeLockId: request.runtimeLockId }),
    probeParakeetRuntime: async () => ({ deviceAvailable: true, device }),
    runParakeetProcessForJob: async ({ candidatePath, request: queuedRequest }) => {
      receivedRequest = queuedRequest;
      return {
        text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }], duration: 1,
        engine: 'parakeet', device, computeType: 'float32', language: 'en',
        modelId: request.modelId, boundaryPolicy: request.boundaryPolicy,
        adapterId: request.adapterId, artifactRevision: request.artifactRevision,
        runtimeLockId: request.runtimeLockId, output_file: candidatePath,
      };
    },
    commitTranscriptionAttempt: async () => ({ id: meeting.id, transcriptionStatus: 'completed' }),
    fs: { ...createMinimalFs(), promises: { ...createMinimalFs().promises,
      readFile: async () => '# Meeting Transcription\n\n## Transcript\n\nhello',
    } },
  });
  const job = harness.service.admitMeetingTranscriptionJob({ meetingId: meeting.id, request });
  const jobOutcome = job.then(() => null, (error) => error);
  request.modelId = 'changed-after-enqueue';
  request.adapterId = 'changed-after-enqueue';

  const queueOutcome = await harness.computeQueue.runNext().then(() => null, (error) => error);
  const jobError = await jobOutcome;
  assert.equal(queueOutcome, null);
  assert.equal(jobError, null);
  assert.ok(receivedRequest);
  assert.equal(receivedRequest.modelId, storedRequest.modelId);
  assert.equal(receivedRequest.adapterId, storedRequest.adapterId);
  assert.equal(Object.isFrozen(receivedRequest), true);
});

test('Slice A: resume keeps legacy rows, canonicalizes, and reports skipped', async () => {
  const meetings = [
    { id: 'legacy-fa-tiny', transcriptionStatus: 'pending', language: 'fa', model: 'tiny', title: 'A' },
    { id: 'legacy-padded', transcriptionStatus: 'pending', language: ' FA ', model: ' TINY ', title: 'B' },
    { id: 'legacy-large', transcriptionStatus: 'pending', language: 'en', model: 'large', title: 'C' },
    { id: 'legacy-large-v3', transcriptionStatus: 'pending', language: 'en', model: 'large-v3', title: 'D' },
    { id: 'unknown-row', transcriptionStatus: 'pending', language: 'xx', model: 'xx', title: 'E' },
    { id: 'done', transcriptionStatus: 'completed', language: 'en', model: 'small', title: 'F' },
  ];
  const harness = createServiceHarness({
    listMeetings: async () => meetings,
    stageTranscriptionRequest: async (meetingId, request) => ({
      id: meetingId,
      transcriptionRequest: { ...request },
    }),
  });
  const result = await harness.service.resumePendingTranscriptions();
  assert.deepEqual([...result.meetingIds].sort(), [
    'legacy-fa-tiny',
    'legacy-large',
    'legacy-large-v3',
    'legacy-padded',
  ]);
  assert.equal(result.enqueuedCount, 4);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].meetingId, 'unknown-row');
  assert.ok(result.skipped[0].code === 'UNSUPPORTED_LANGUAGE' || result.skipped[0].code === 'UNSUPPORTED_MODEL');
  harness.computeQueue.rejectAll(new Error('test teardown'));
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test('resume queues the exact saved Parakeet identity in an immutable request', async () => {
  const { resolveTranscriptionRequest } = require('../../src/main/transcription-engine-resolver');
  const { getAdapterSpec } = require('../../src/main/transcription-engine-catalog');
  const resolved = resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, {
    platform: process.platform, arch: process.arch, osRelease: '24.0.0',
  });
  assert.equal(resolved.ok, true);
  const savedRequest = { ...resolved.request };
  const resumeRow = {
    id: 'resume-parakeet',
    audioPath: '/tmp/avanevis-test/recordings/resume.opus',
    transcriptPath: '/tmp/avanevis-test/recordings/resume.md',
    transcriptionStatus: 'pending',
    transcriptionRequest: { ...savedRequest },
  };
  const persistedMeeting = {
    ...resumeRow,
    transcriptionRequest: { ...savedRequest },
  };
  let receivedRequest = null;
  let committedAttempt = null;
  const spec = getAdapterSpec(savedRequest.adapterId);
  const harness = createServiceHarness({
    listMeetings: async () => [resumeRow],
    runWallClockComputeAction: async ({ label, action }) => (
      String(label).startsWith('Meeting lookup') ? persistedMeeting : action((proc) => proc, { signal: undefined })
    ),
    stageTranscriptionRequest: async () => {
      throw new Error('an exact saved request does not need restaging');
    },
    getGuidedDiarizationStatusForJob: async () => null,
    getParakeetStatusForJob: () => ({ status: 'ready',
      artifactRevision: savedRequest.artifactRevision, runtimeLockId: savedRequest.runtimeLockId }),
    probeParakeetRuntime: async () => ({ deviceAvailable: true, device: spec.device }),
    runParakeetProcessForJob: async ({ request, candidatePath }) => {
      receivedRequest = request;
      return {
        text: 'resumed', segments: [{ start: 0, end: 1, text: 'resumed' }], duration: 1,
        engine: 'parakeet', device: spec.device, computeType: 'float32', language: 'en',
        modelId: savedRequest.modelId, boundaryPolicy: savedRequest.boundaryPolicy,
        adapterId: savedRequest.adapterId, artifactRevision: savedRequest.artifactRevision,
        runtimeLockId: savedRequest.runtimeLockId, output_file: candidatePath,
      };
    },
    commitTranscriptionAttempt: async (_meetingId, payload) => {
      committedAttempt = payload.attemptId;
      return { ...persistedMeeting, transcriptionStatus: 'completed' };
    },
    fs: { ...createMinimalFs(), promises: {
      ...createMinimalFs().promises,
      readFile: async () => '# Meeting Transcription\n\n## Transcript\n\nresumed',
    } },
  });

  const resumed = await harness.service.resumePendingTranscriptions();
  assert.deepEqual(resumed.meetingIds, [resumeRow.id]);
  resumeRow.transcriptionRequest.adapterId = 'changed-after-resume';
  await harness.computeQueue.flush();

  assert.ok(receivedRequest);
  assert.equal(Object.isFrozen(receivedRequest), true);
  assert.equal(receivedRequest.attemptId, savedRequest.attemptId);
  assert.equal(receivedRequest.adapterId, savedRequest.adapterId);
  assert.equal(receivedRequest.artifactRevision, savedRequest.artifactRevision);
  assert.equal(committedAttempt, savedRequest.attemptId);
  assert.equal(harness.getQueueState().jobs[0].status, 'ready');
});

test('Slice A: legacy resolver returns canonical normalized values', () => {
  const harness = createServiceHarness();
  assert.deepEqual(
    harness.service.resolveLegacyCompatibleSelection({ language: ' FA ', modelSize: ' TINY ' }),
    { language: 'fa', modelSize: 'tiny' },
  );
  assert.deepEqual(
    harness.service.resolveLegacyCompatibleSelection({ language: 'EN', modelSize: 'LARGE' }),
    { language: 'en', modelSize: 'large' },
  );
  assert.throws(
    () => harness.service.resolveLegacyCompatibleSelection({ language: 'xx', modelSize: 'small' }),
    (error) => error && error.code === 'UNSUPPORTED_LANGUAGE',
  );
  assert.throws(
    () => harness.service.resolveLegacyCompatibleSelection({ language: 'en', modelSize: 'xx' }),
    (error) => error && error.code === 'UNSUPPORTED_MODEL',
  );
});

test('Slice A: model setup IPC serves Small/Medium only', async () => {
  const harness = createServiceHarness();
  const handlers = registerHandlers(harness);
  for (const size of ['tiny', 'base', 'large', 'large-v3']) {
    await assert.rejects(
      handlers['check-model-downloaded']({}, size),
      (error) => error && error.code === 'UNSUPPORTED_MODEL',
      `check-model-downloaded must reject ${size}`,
    );
    await assert.rejects(
      handlers['download-model']({}, size),
      (error) => error && error.code === 'UNSUPPORTED_MODEL',
      `download-model must reject ${size}`,
    );
  }
  const check = await handlers['check-model-downloaded']({}, 'small');
  assert.equal(check.modelSize, 'small');
  assert.equal(typeof check.downloaded, 'boolean');
});

test('Parakeet finalization queues its saved request and commits a candidate through the compute queue', async () => {
  const { resolveTranscriptionRequest } = require('../../src/main/transcription-engine-resolver');
  const requested = resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, {
    platform: 'darwin', arch: 'arm64', osRelease: '24.0.0',
  });
  assert.equal(requested.ok, true);
  const request = requested.request;
  const audioPath = '/tmp/avanevis-test/recordings/a.opus';
  let committed = null;
  let pending = null;
  const harness = createServiceHarness({
    fs: { ...createMinimalFs(), promises: {
      ...createMinimalFs().promises,
      readFile: async () => '# Meeting Transcription\n\n## Transcript\n\nhello',
    } },
    spawnTrackedPython: () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          id: 'm1', audioPath, transcriptPath: '/tmp/avanevis-test/recordings/a.md',
          transcriptionRequest: pending.transcriptionRequest,
        })));
        proc.emit('close', 0);
      });
      return proc;
    },
    addMeetingToHistory: async (record) => {
      pending = record;
      return { ...record, id: 'm1', audioPath };
    },
    getParakeetStatusForJob: () => ({ status: 'ready',
      artifactRevision: pending.transcriptionRequest.artifactRevision, runtimeLockId: pending.transcriptionRequest.runtimeLockId }),
    probeParakeetRuntime: async () => ({ deviceAvailable: true, device: 'metal' }),
    runParakeetProcessForJob: async ({ candidatePath }) => ({
      text: 'hello', segments: [{ start: 0, end: 1, text: 'hello' }], duration: 1,
      engine: 'parakeet', device: 'metal', computeType: 'float32',
      language: 'en', modelId: pending.transcriptionRequest.modelId,
      boundaryPolicy: pending.transcriptionRequest.boundaryPolicy,
      adapterId: pending.transcriptionRequest.adapterId, artifactRevision: pending.transcriptionRequest.artifactRevision,
      runtimeLockId: pending.transcriptionRequest.runtimeLockId, output_file: candidatePath,
    }),
    commitTranscriptionAttempt: async (id, payload) => {
      committed = { id, ...payload };
      return { id, transcriptionStatus: 'completed' };
    },
  });
  const result = await harness.service.finalizeRecordingTranscription({
    audioPath, transcriptionSelection: { engine: 'parakeet', language: 'en' },
  });
  assert.equal(result.enqueued, true);
  assert.equal(pending.transcriptionRequest.engine, 'parakeet');
  await harness.computeQueue.flush();
  assert.equal(committed.result.engine, 'parakeet');
  assert.equal(committed.result.device, 'mps');
  assert.equal(harness.getQueueState().jobs[0].status, 'ready');
});

test('missing Parakeet runtime fails the saved attempt before any CPU or Whisper child', async () => {
  const { resolveTranscriptionRequest } = require('../../src/main/transcription-engine-resolver');
  const request = resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, {
    platform: 'darwin', arch: 'arm64', osRelease: '24.0.0',
  }).request;
  const spawns = [];
  const failures = [];
  const harness = createServiceHarness({
    spawnTrackedPython: (args) => {
      spawns.push(args);
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      queueMicrotask(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          id: 'm1', audioPath: '/tmp/avanevis-test/recordings/a.opus',
          transcriptionRequest: request,
        })));
        proc.emit('close', 0);
      });
      return proc;
    },
    getParakeetStatusForJob: () => ({ status: 'repair-required', code: 'PARAKEET_ARTIFACT_INVALID' }),
    probeParakeetRuntime: () => { throw new Error('unexpected GPU probe'); },
    runParakeetProcessForJob: () => { throw new Error('unexpected ASR child'); },
    commitTranscriptionAttempt: () => { throw new Error('unexpected commit'); },
    failTranscriptionAttempt: async (id, attemptId, code) => failures.push({ id, attemptId, code }),
  });
  const job = harness.service.admitMeetingTranscriptionJob({ meetingId: 'm1', request });
  await assert.rejects(harness.computeQueue.runNext(), (error) => error.code === 'PARAKEET_ARTIFACT_INVALID');
  await assert.rejects(job, (error) => error.code === 'PARAKEET_ARTIFACT_INVALID');
  assert.deepEqual(failures, [{ id: 'm1', attemptId: request.attemptId, code: 'PARAKEET_ARTIFACT_INVALID' }]);
  assert.equal(spawns.length, 1);
  assert.equal(harness.getQueueState().jobs[0].status, 'failed');
});

test('Parakeet re-admission fails closed when its live GPU disappears', async () => {
  const { resolveTranscriptionRequest } = require('../../src/main/transcription-engine-resolver');
  const request = resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, {
    platform: process.platform, arch: process.arch, osRelease: '24.0.0',
  }).request;
  const meeting = {
    id: 'parakeet-gpu-removed',
    audioPath: '/tmp/avanevis-test/recordings/gpu-removed.opus',
    transcriptPath: '/tmp/avanevis-test/recordings/gpu-removed.md',
    transcriptionRequest: { ...request },
  };
  let probes = 0;
  let transcriptionChildren = 0;
  const harness = createServiceHarness({
    runWallClockComputeAction: async ({ label, action }) => (
      String(label).startsWith('Meeting lookup') ? meeting : action((proc) => proc, { signal: undefined })
    ),
    getGuidedDiarizationStatusForJob: async () => null,
    getParakeetStatusForJob: () => ({ status: 'ready', artifactRevision: request.artifactRevision,
      runtimeLockId: request.runtimeLockId }),
    probeParakeetRuntime: async () => {
      probes += 1;
      return { deviceAvailable: false, device: 'cpu' };
    },
    runParakeetProcessForJob: async () => {
      transcriptionChildren += 1;
      throw new Error('Parakeet transcription must not start without its GPU');
    },
  });

  const job = harness.service.admitMeetingTranscriptionJob({ meetingId: meeting.id, request });
  const queueOutcome = await harness.computeQueue.runNext().then(() => null, (error) => error);
  await assert.rejects(job, (error) => error && error.code === 'PARAKEET_GPU_UNAVAILABLE');

  assert.equal(queueOutcome.code, 'PARAKEET_GPU_UNAVAILABLE');
  assert.equal(probes, 1);
  assert.equal(transcriptionChildren, 0);
  assert.equal(harness.getQueueState().jobs[0].status, 'failed');
});

test('delete during Parakeet result commit cannot publish a Ready queue row', async () => {
  const { resolveTranscriptionRequest } = require('../../src/main/transcription-engine-resolver');
  const { getAdapterSpec } = require('../../src/main/transcription-engine-catalog');
  const request = resolveTranscriptionRequest({ engine: 'parakeet', language: 'en' }, {
    platform: process.platform, arch: process.arch, osRelease: '24.0.0',
  }).request;
  const spec = getAdapterSpec(request.adapterId);
  const meeting = {
    id: 'delete-at-parakeet-commit',
    audioPath: '/tmp/avanevis-test/recordings/commit.opus',
    transcriptPath: '/tmp/avanevis-test/recordings/commit.md',
    transcriptionRequest: { ...request },
  };
  let releaseCommit;
  const commitGate = new Promise((resolve) => { releaseCommit = resolve; });
  let commitStarted = false;
  const harness = createServiceHarness({
    runWallClockComputeAction: async ({ label, action }) => (
      String(label).startsWith('Meeting lookup') ? meeting : action((proc) => proc, { signal: undefined })
    ),
    getGuidedDiarizationStatusForJob: async () => null,
    getParakeetStatusForJob: () => ({ status: 'ready', artifactRevision: request.artifactRevision,
      runtimeLockId: request.runtimeLockId }),
    probeParakeetRuntime: async () => ({ deviceAvailable: true, device: spec.device }),
    runParakeetProcessForJob: async ({ candidatePath }) => ({
      text: 'complete', segments: [{ start: 0, end: 1, text: 'complete' }], duration: 1,
      engine: 'parakeet', device: spec.device, computeType: 'float32', language: 'en',
      modelId: request.modelId, boundaryPolicy: request.boundaryPolicy,
      adapterId: request.adapterId, artifactRevision: request.artifactRevision,
      runtimeLockId: request.runtimeLockId, output_file: candidatePath,
    }),
    commitTranscriptionAttempt: async () => {
      commitStarted = true;
      await commitGate;
      return { ...meeting, transcriptionStatus: 'completed' };
    },
    fs: { ...createMinimalFs(), promises: {
      ...createMinimalFs().promises,
      readFile: async () => '# Meeting Transcription\n\n## Transcript\n\ncomplete',
    } },
  });

  const job = harness.service.admitMeetingTranscriptionJob({ meetingId: meeting.id, request });
  const jobOutcome = job.then(() => null, (error) => error);
  const running = harness.computeQueue.runNext().then(() => null, (error) => error);
  for (let index = 0; index < 50 && !commitStarted; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(commitStarted, true, 'expected atomic commit to be in progress');

  const deletion = harness.service.cancelJobForDelete(meeting.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  releaseCommit();
  const [jobError, queueError, deleted] = await Promise.all([jobOutcome, running, deletion]);

  assert.equal(jobError.code, 'TRANSCRIPTION_DELETED');
  assert.equal(queueError.code, 'TRANSCRIPTION_DELETED');
  assert.equal(deleted.tombstoned, true);
  assert.equal(harness.getQueueState().jobs.some((item) => item.meetingId === meeting.id), false);
});

test('request-based Whisper jobs commit a candidate and retain the prior transcript on failure', async () => {
  const { resolveTranscriptionRequest } = require('../../src/main/transcription-engine-resolver');
  const request = resolveTranscriptionRequest({ engine: 'whisper', language: 'en', modelSize: 'small' }, {
    platform: process.platform, arch: process.arch,
  }).request;

  async function runAttempt(candidateMarkdown) {
    const files = new Map([
      ['/tmp/avanevis-test/recordings/whisper-retry.md', '# Old committed transcript\n'],
    ]);
    const meeting = {
      id: 'whisper-retry',
      audioPath: '/tmp/avanevis-test/recordings/whisper-retry.opus',
      transcriptPath: '/tmp/avanevis-test/recordings/whisper-retry.md',
      transcriptionStatus: 'pending',
      transcriptionRequest: { ...request },
      language: 'en',
      model: 'small',
    };
    const commits = [];
    const failedAttempts = [];
    const harness = createServiceHarness({
      fs: {
        existsSync: () => true,
        promises: {
          readFile: async (filePath) => {
            if (!files.has(filePath)) throw new Error(`missing test file: ${filePath}`);
            return files.get(filePath);
          },
          writeFile: async (filePath, content) => { files.set(filePath, String(content)); },
          rm: async (filePath) => { files.delete(filePath); },
          mkdtemp: async (prefix) => `${prefix}test`,
        },
      },
      spawnTrackedPython: (args) => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          if (args[0] === 'meeting_manager') {
            child.stdout.emit('data', Buffer.from(JSON.stringify(meeting)));
          } else {
            const outputPath = args[args.indexOf('--output') + 1];
            files.set(outputPath, candidateMarkdown);
            const requestedDevice = args.includes('--device')
              ? args[args.indexOf('--device') + 1]
              : 'metal';
            child.stdout.emit('data', Buffer.from(JSON.stringify({
              text: 'new transcript',
              segments: [{ start: 0, end: 1, text: 'new transcript' }],
              language: 'en', duration: 1,
              device: requestedDevice === 'auto' ? 'metal' : requestedDevice,
              computeType: requestedDevice === 'cpu' ? 'int8' : 'float32',
              output_file: outputPath,
            })));
          }
          child.emit('close', 0);
        });
        return child;
      },
      appendSpawnJsonStdout: (buffer, data) => `${buffer}${data}`,
      checkAiAddonSetupStatus: async () => ({ features: { diarization: { status: 'notConfigured' } } }),
      commitTranscriptionAttempt: async (meetingId, payload) => {
        commits.push({ meetingId, payload });
        return { ...meeting, transcriptPath: payload.candidatePath, transcriptionStatus: 'completed' };
      },
      failTranscriptionAttempt: async (meetingId, attemptId, code) => {
        failedAttempts.push({ meetingId, attemptId, code });
        return { ...meeting, transcriptionStatus: 'failed' };
      },
    });

    const job = harness.service.admitMeetingTranscriptionJob({
      meetingId: meeting.id, request, language: 'fr', modelSize: 'medium',
    });
    const queued = await harness.computeQueue.runNext().then(() => null, (error) => error);
    const outcome = await job.then((value) => ({ value }), (error) => ({ error }));
    return { files, meeting, commits, failedAttempts, harness, queued, outcome };
  }

  const failed = await runAttempt('# Invalid child output\n');
  assert.ok(failed.outcome.error, JSON.stringify(failed.outcome));
  assert.equal(failed.outcome.error.code, 'TRANSCRIPTION_INVALID_OUTPUT', failed.outcome.error.message);
  assert.equal(failed.commits.length, 0);
  assert.equal(failed.failedAttempts[0].attemptId, request.attemptId);
  assert.equal(failed.files.get(failed.meeting.transcriptPath), '# Old committed transcript\n');

  const passed = await runAttempt('# Meeting Transcription\n\n## Transcript\n\nnew transcript');
  assert.equal(passed.outcome.error, undefined);
  assert.equal(passed.queued, null);
  assert.equal(passed.commits.length, 1);
  assert.equal(passed.commits[0].payload.candidatePath,
    '/tmp/avanevis-test/recordings/whisper-retry.transcript-' + request.attemptId + '.md');
  assert.equal(passed.commits[0].payload.result.engine, 'whisper');
  assert.equal(passed.commits[0].payload.result.attemptId, request.attemptId);
  assert.equal(passed.files.get(passed.meeting.transcriptPath), '# Old committed transcript\n');
});
