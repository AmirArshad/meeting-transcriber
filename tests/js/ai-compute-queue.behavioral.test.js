'use strict';

/**
 * Phase 3b behavioral compute-queue membership test.
 *
 * Supplements (does not replace) the Phase 0.2 source-scan in
 * compute-queue-membership.test.js. Uses an injected fake queue so we can
 * assert enqueue membership without loading Electron `src/main.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAsyncActionQueue,
  createAiComputeQueue,
} = require('../../src/main/ai-compute-queue');

/** Mirrors AGENTS.md / Phase 0.2: handlers that MUST use the compute queue. */
const COMPUTE_QUEUE_ACTIONS = [
  'transcribe-audio',
  'transcribe-audio-with-speakers',
  'diarize-transcript',
  'generate-summary',
];

/** Must stay OFF the compute queue (downloads / add-on setup). */
const NON_COMPUTE_QUEUE_ACTIONS = [
  'download-model',
  'setup-diarization',
  'setup-summary-model',
];

function createFakeQueue() {
  const enqueuedLabels = [];
  const real = createAsyncActionQueue();

  return {
    enqueuedLabels,
    enqueue(action) {
      // Labels are attached by the test harness via action.__computeLabel.
      if (action && action.__computeLabel) {
        enqueuedLabels.push(action.__computeLabel);
      }
      return real.enqueue(action);
    },
    drain: real.drain,
    hasPendingWork: real.hasPendingWork,
  };
}

function labeledAction(label, fn = async () => label) {
  const action = () => fn();
  action.__computeLabel = label;
  return action;
}

/**
 * Stand-in for how main.js transcription/summary handlers enqueue work:
 * `enqueueAiComputeAction(() => runWallClockComputeAction(...))`.
 */
function simulateComputeHandler(enqueueAiComputeAction, label) {
  return enqueueAiComputeAction(labeledAction(label));
}

/**
 * Stand-in for download-model / AI add-on setup: they must NOT call
 * enqueueAiComputeAction (they use aiAddonActionQueue or no queue).
 */
function simulateNonComputeHandler(_enqueueAiComputeAction, label, addonEnqueue) {
  return addonEnqueue(labeledAction(label));
}

test('behavioral: compute handlers enqueue on the injected aiComputeActionQueue', async () => {
  const fakeQueue = createFakeQueue();
  const cancelErrors = [];
  const queue = createAiComputeQueue({
    createAiAddonCancelError: (message) => {
      const error = new Error(message || 'canceled');
      error.name = 'AbortError';
      cancelErrors.push(error);
      return error;
    },
    actionQueue: fakeQueue,
  });

  for (const label of COMPUTE_QUEUE_ACTIONS) {
    await simulateComputeHandler(queue.enqueueAiComputeAction, label);
  }

  assert.deepEqual(fakeQueue.enqueuedLabels, COMPUTE_QUEUE_ACTIONS);
});

test('behavioral: download-model and AI add-on setup stay off the compute queue', async () => {
  const fakeComputeQueue = createFakeQueue();
  const fakeAddonQueue = createFakeQueue();
  const queue = createAiComputeQueue({
    createAiAddonCancelError: (message) => {
      const error = new Error(message || 'canceled');
      error.name = 'AbortError';
      return error;
    },
    actionQueue: fakeComputeQueue,
  });

  for (const label of NON_COMPUTE_QUEUE_ACTIONS) {
    await simulateNonComputeHandler(
      queue.enqueueAiComputeAction,
      label,
      fakeAddonQueue.enqueue,
    );
  }

  assert.deepEqual(fakeComputeQueue.enqueuedLabels, []);
  assert.deepEqual(fakeAddonQueue.enqueuedLabels, NON_COMPUTE_QUEUE_ACTIONS);
});

test('behavioral: createAbortableComputeAction enqueues when the compute queue is idle', async () => {
  const fakeQueue = createFakeQueue();
  const queue = createAiComputeQueue({
    createAiAddonCancelError: (message) => {
      const error = new Error(message || 'canceled');
      error.name = 'AbortError';
      return error;
    },
    actionQueue: fakeQueue,
  });

  const result = await queue.createAbortableComputeAction({
    cancelMessage: 'canceled',
    action: async () => {
      fakeQueue.enqueuedLabels.push('abortable-action');
      return 'ok';
    },
  });

  assert.equal(result, 'ok');
  assert.deepEqual(fakeQueue.enqueuedLabels, ['abortable-action']);
});

test('behavioral: createAbortableComputeAction rejects when cancelSignal is already aborted', async () => {
  const fakeQueue = createFakeQueue();
  const queue = createAiComputeQueue({
    createAiAddonCancelError: (message) => {
      const error = new Error(message || 'canceled');
      error.name = 'AbortError';
      error.code = 'AI_ADDON_CANCELLED';
      return error;
    },
    actionQueue: fakeQueue,
  });

  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => queue.createAbortableComputeAction({
      cancelSignal: controller.signal,
      cancelMessage: 'Speaker identification setup was canceled.',
      action: async () => 'should-not-run',
    }),
    (error) => error && error.name === 'AbortError',
  );
  assert.deepEqual(fakeQueue.enqueuedLabels, []);
});

test('behavioral: createAsyncActionQueue serializes work', async () => {
  const q = createAsyncActionQueue();
  const order = [];

  const first = q.enqueue(async () => {
    order.push('a-start');
    await new Promise((r) => setTimeout(r, 20));
    order.push('a-end');
    return 'a';
  });
  const second = q.enqueue(async () => {
    order.push('b-start');
    order.push('b-end');
    return 'b';
  });

  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  assert.equal(q.hasPendingWork(), false);
});
