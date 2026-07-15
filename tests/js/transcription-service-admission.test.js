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
} = require('../../src/main-process/transcription-queue-helpers');

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
    async flush() {
      while (pending.length > 0) {
        try {
          await this.runNext();
        } catch (_error) {
          // Job failures are expected when cancelled/deleted mid-flight.
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
    },
  };
}

function createServiceHarness(overrides = {}) {
  const computeQueue = createParkableComputeQueue();
  let terminateCalls = 0;
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
    collectPythonProcessOutput: () => ({
      getStdout: () => '',
      getStderr: () => '',
      assertStdoutWithinLimit() {},
    }),
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

  function addActiveWallClockJob(label = 'Transcription') {
    activeWallClockJobs.push({
      label,
      terminate: async () => {
        terminateCalls += 1;
      },
    });
  }

  async function deleteAndFlush(meetingId) {
    const deletePromise = service.cancelJobForDelete(meetingId);
    // Mimic FIFO compute progress so the deleted closure can observe the tombstone.
    await Promise.resolve();
    await computeQueue.flush();
    return deletePromise;
  }

  return {
    service,
    computeQueue,
    addActiveWallClockJob,
    deleteAndFlush,
    getTerminateCalls: () => terminateCalls,
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
  assert.equal(shouldTerminateComputeJobsForMeeting({
    activeMeetingId: null,
    targetMeetingId: 'meeting_b',
  }), false);
});

test('deleting queued B while A owns live Whisper jobs does not terminate them', async () => {
  const harness = createServiceHarness();
  harness.addActiveWallClockJob('Transcription');

  const jobB = harness.service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_b',
    language: 'en',
    modelSize: 'small',
  });
  assert.equal(harness.getQueueState().activeMeetingId, null);
  assert.equal(harness.computeQueue.pendingCount, 1);

  await harness.deleteAndFlush('meeting_b');
  assert.equal(
    harness.getTerminateCalls(),
    0,
    'queued delete must not terminate unrelated active Whisper jobs',
  );

  await jobB.catch(() => {});
  harness.service.clearMeetingDeleteGuard('meeting_b');
});

test('cancelJobForDelete tombstones unconditionally and blocks admission until cleared', async () => {
  const harness = createServiceHarness();
  const { service } = harness;

  const result = await service.cancelJobForDelete('meeting_missing');
  assert.equal(result.tombstoned, true);

  assert.throws(
    () => service.admitMeetingTranscriptionJob({
      meetingId: 'meeting_missing',
      language: 'en',
      modelSize: 'small',
    }),
    (error) => error && error.code === 'TRANSCRIPTION_DELETED',
  );

  service.clearMeetingDeleteGuard('meeting_missing');
  const promise = service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_missing',
    language: 'en',
    modelSize: 'small',
  });
  assert.equal(typeof promise.then, 'function');

  await harness.deleteAndFlush('meeting_missing');
  await promise.catch(() => {});
  service.clearMeetingDeleteGuard('meeting_missing');
});

test('admitMeetingTranscriptionJob rejects duplicate in-flight without overwriting the queue row', async () => {
  const harness = createServiceHarness();
  const { service, getQueueState } = harness;

  const first = service.admitMeetingTranscriptionJob({
    meetingId: 'meeting_dup',
    language: 'en',
    modelSize: 'small',
    title: 'First',
  });
  assert.equal(getQueueState().jobs[0].status, QUEUE_JOB_STATUSES.queued);
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

  const jobs = getQueueState().jobs.filter((job) => job.meetingId === 'meeting_dup');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, 'First');

  await harness.deleteAndFlush('meeting_dup');
  await first.catch(() => {});
  service.clearMeetingDeleteGuard('meeting_dup');
});

test('delete-meeting clears tombstone in finally after beforeDeleteMeeting', async () => {
  let beforeCalls = 0;
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
    beforeDeleteMeeting: async () => {
      beforeCalls += 1;
    },
    afterDeleteMeeting: async () => {
      afterCalls += 1;
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
    beforeDeleteMeeting: async () => {},
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
