'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { createTranscriptionService } = require('../../src/main/transcription-service');
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

function createRetryHarness() {
  return createServiceHarness({
    runWallClockComputeAction: async ({ label, action }) => {
      if (String(label).startsWith('Meeting lookup')) {
        return { ...SLICE_A_LEGACY_MEETING };
      }
      throw new Error(`test: unexpected compute ${label}`);
    },
  });
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

test('Slice A: retry uses field presence, not truthiness, for explicit selection', async () => {
  // Present-but-empty must fail validation, never fall back to saved legacy.
  {
    const harness = createRetryHarness();
    const handlers = registerHandlers(harness);
    await assert.rejects(
      handlers['retry-transcription']({}, { meetingId: 'legacy_retry', language: '', modelSize: '' }),
      (error) => error && error.code === 'UNSUPPORTED_LANGUAGE',
    );
    assert.equal(harness.getQueueState().jobs.length, 0);
  }

  // Explicit legacy values are new-work selections: rejected.
  {
    const harness = createRetryHarness();
    const handlers = registerHandlers(harness);
    await assert.rejects(
      handlers['retry-transcription']({}, { meetingId: 'legacy_retry', language: 'fa', modelSize: 'tiny' }),
      (error) => error && (error.code === 'UNSUPPORTED_LANGUAGE' || error.code === 'UNSUPPORTED_MODEL'),
    );
    assert.equal(harness.getQueueState().jobs.length, 0);
  }

  // Partial explicit selection still validates the resolved pair strictly.
  {
    const harness = createRetryHarness();
    const handlers = registerHandlers(harness);
    await assert.rejects(
      handlers['retry-transcription']({}, { meetingId: 'legacy_retry', language: 'en' }),
      (error) => error && error.code === 'UNSUPPORTED_MODEL',
    );
    assert.equal(harness.getQueueState().jobs.length, 0);
  }

  // Curated explicit selection admits.
  {
    const harness = createRetryHarness();
    const handlers = registerHandlers(harness);
    const promise = handlers['retry-transcription'](
      {}, { meetingId: 'legacy_retry', language: 'en', modelSize: 'small' },
    );
    await settleAdmitted(harness, promise);
  }

  // Both keys absent: legacy fallback admits the saved fa/tiny pair.
  {
    const harness = createRetryHarness();
    const handlers = registerHandlers(harness);
    const promise = handlers['retry-transcription']({}, { meetingId: 'legacy_retry' });
    await settleAdmitted(harness, promise);
  }
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
  const harness = createServiceHarness({ listMeetings: async () => meetings });
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
