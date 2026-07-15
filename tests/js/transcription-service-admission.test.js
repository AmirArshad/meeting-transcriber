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
