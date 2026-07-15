'use strict';

/**
 * Pure helpers for the main-owned transcription queue (Phase 1).
 *
 * Durable meeting metadata only uses pending|failed|completed.
 * In-memory job status/phase drives Home Activity (PR2) and progress attribution.
 */

const TRANSCRIPTION_QUEUE_STATE_CHANNEL = 'transcription-queue-state';
const USER_CANCELLED_TRANSCRIPTION_ERROR = 'Cancelled by user';

const QUEUE_JOB_STATUSES = Object.freeze({
  queued: 'queued',
  active: 'active',
  failed: 'failed',
  ready: 'ready',
  cancelled: 'cancelled',
});

const QUEUE_JOB_PHASES = Object.freeze({
  queued: 'queued',
  transcribing: 'transcribing',
  identifying_speakers: 'identifying_speakers',
  waiting_resource: 'waiting_resource',
  persisting: 'persisting',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
});

function createTranscriptionQueueState() {
  return {
    jobsByMeetingId: new Map(),
    jobOrder: [],
    activeMeetingId: null,
    cancelFlags: new Set(),
    // Survives removeQueueJob until the in-flight closure settles (delete-while-queued).
    deleteTombstones: new Set(),
    // Active reservation generation currently held for the meeting.
    cancelGuardGenerations: new Map(),
    deleteGuardGenerations: new Map(),
    // Monotonic counters — never reset on clear — so a stale clear from an
    // earlier reservation cannot match a recycled generation number.
    cancelGuardSequences: new Map(),
    deleteGuardSequences: new Map(),
  };
}

function upsertQueueJob(state, jobPatch = {}) {
  const meetingId = String(jobPatch.meetingId || '').trim();
  if (!meetingId) {
    throw new Error('Queue job requires meetingId');
  }

  const existing = state.jobsByMeetingId.get(meetingId) || {
    meetingId,
    status: QUEUE_JOB_STATUSES.queued,
    phase: QUEUE_JOB_PHASES.queued,
    title: '',
    durationSeconds: 0,
  };
  const next = {
    ...existing,
    ...jobPatch,
    meetingId,
  };
  state.jobsByMeetingId.set(meetingId, next);
  if (!state.jobOrder.includes(meetingId)) {
    state.jobOrder.push(meetingId);
  }
  return next;
}

/**
 * @param {{ clearCancelFlag?: boolean }} [options]
 *   clearCancelFlag defaults true. Delete-while-queued passes false so the
 *   in-flight closure still observes cancellation after the Activity row is gone.
 */
function removeQueueJob(state, meetingId, { clearCancelFlag = true } = {}) {
  const id = String(meetingId || '').trim();
  if (!id) {
    return;
  }
  state.jobsByMeetingId.delete(id);
  state.jobOrder = state.jobOrder.filter((entry) => entry !== id);
  if (state.activeMeetingId === id) {
    state.activeMeetingId = null;
  }
  if (clearCancelFlag) {
    state.cancelFlags.delete(id);
  }
}

function setActiveQueueMeeting(state, meetingId) {
  state.activeMeetingId = meetingId ? String(meetingId) : null;
}

function markTranscriptionJobCancelled(state, meetingId) {
  const id = String(meetingId || '').trim();
  if (!id) {
    return null;
  }
  const nextGeneration = (state.cancelGuardSequences.get(id) || 0) + 1;
  state.cancelGuardSequences.set(id, nextGeneration);
  state.cancelGuardGenerations.set(id, nextGeneration);
  state.cancelFlags.add(id);
  const job = state.jobsByMeetingId.get(id);
  if (job && job.status === QUEUE_JOB_STATUSES.queued) {
    upsertQueueJob(state, {
      meetingId: id,
      status: QUEUE_JOB_STATUSES.cancelled,
      phase: QUEUE_JOB_PHASES.cancelled,
    });
  }
  return nextGeneration;
}

function markTranscriptionJobDeleted(state, meetingId) {
  const id = String(meetingId || '').trim();
  if (!id) {
    return null;
  }
  const nextGeneration = (state.deleteGuardSequences.get(id) || 0) + 1;
  state.deleteGuardSequences.set(id, nextGeneration);
  state.deleteGuardGenerations.set(id, nextGeneration);
  state.deleteTombstones.add(id);
  markTranscriptionJobCancelled(state, id);
  return nextGeneration;
}

function isTranscriptionJobCancelled(state, meetingId) {
  return state.cancelFlags.has(String(meetingId || '').trim());
}

function isTranscriptionJobDeleted(state, meetingId) {
  return state.deleteTombstones.has(String(meetingId || '').trim());
}

function getTranscriptionCancelGuardGeneration(state, meetingId) {
  return state.cancelGuardGenerations.get(String(meetingId || '').trim()) || null;
}

function getTranscriptionDeleteGuardGeneration(state, meetingId) {
  return state.deleteGuardGenerations.get(String(meetingId || '').trim()) || null;
}

/**
 * Clear a consumed cancel flag. Must be called whenever a job reaches a
 * terminal state — a leaked flag would make every future job for that meeting
 * (e.g. Retry from History) self-cancel. Do not clear at head-of-queue admit;
 * mid-job cancel must remain visible through GPU wait / lookup / setup.
 * When expectedGeneration is set, a newer reservation wins and this is a no-op.
 * Sequences stay monotonic across clears.
 */
function clearTranscriptionJobCancelFlag(state, meetingId, expectedGeneration = null) {
  const id = String(meetingId || '').trim();
  if (!id) {
    return false;
  }
  if (expectedGeneration != null
    && state.cancelGuardGenerations.get(id) !== expectedGeneration) {
    return false;
  }
  state.cancelGuardGenerations.delete(id);
  return state.cancelFlags.delete(id);
}

function clearTranscriptionJobDeleteTombstone(state, meetingId, expectedGeneration = null) {
  const id = String(meetingId || '').trim();
  if (!id) {
    return false;
  }
  if (expectedGeneration != null
    && state.deleteGuardGenerations.get(id) !== expectedGeneration) {
    return false;
  }
  state.deleteGuardGenerations.delete(id);
  return state.deleteTombstones.delete(id);
}

/**
 * Head-of-queue / mid-job gate: skip Whisper when quit, user cancel, or delete tombstone.
 */
function shouldSkipJobAtHead({
  isQuitCommitted = false,
  isCancelled = false,
  isDeleted = false,
} = {}) {
  return Boolean(isQuitCommitted) || Boolean(isCancelled) || Boolean(isDeleted);
}

function isTranscriptionJobBlocked(state, meetingId, { isQuitCommitted = false } = {}) {
  const id = String(meetingId || '').trim();
  return Boolean(isQuitCommitted)
    || isTranscriptionJobCancelled(state, id)
    || isTranscriptionJobDeleted(state, id);
}

/**
 * Delete/cancel of meeting B must not terminate meeting A's active Whisper child.
 * Only the meeting that currently owns activeMeetingId may kill wall-clock jobs.
 */
function shouldTerminateComputeJobsForMeeting({ activeMeetingId, targetMeetingId } = {}) {
  const active = String(activeMeetingId || '').trim();
  const target = String(targetMeetingId || '').trim();
  return Boolean(active) && Boolean(target) && active === target;
}

const SESSION_READY_JOB_CAP = 5;

function countBusyTranscriptionJobs(state) {
  let count = 0;
  for (const meetingId of state.jobOrder) {
    const job = state.jobsByMeetingId.get(meetingId);
    if (!job) {
      continue;
    }
    if (job.status === QUEUE_JOB_STATUSES.queued || job.status === QUEUE_JOB_STATUSES.active) {
      count += 1;
    }
  }
  return count;
}

/**
 * Keep only the newest session-only Ready rows (cap) so Home Activity stays lean.
 */
function trimSessionReadyJobs(state, maxReady = SESSION_READY_JOB_CAP) {
  const readyIds = state.jobOrder.filter((meetingId) => {
    const job = state.jobsByMeetingId.get(meetingId);
    return job && job.status === QUEUE_JOB_STATUSES.ready;
  });
  const overflow = readyIds.length - Math.max(0, Number(maxReady) || 0);
  if (overflow <= 0) {
    return 0;
  }
  // jobOrder is enqueue order; oldest Ready entries are first among readyIds.
  const toRemove = readyIds.slice(0, overflow);
  toRemove.forEach((meetingId) => removeQueueJob(state, meetingId));
  return toRemove.length;
}

function formatQueuedTranscriptionBusyMessage(queuedCount, actionLabel = 'continuing') {
  const count = Math.max(0, Number(queuedCount) || 0);
  if (count <= 0) {
    return `Local AI work is still running. Finish or cancel it before ${actionLabel}.`;
  }
  const noun = count === 1 ? 'recording is' : 'recordings are';
  return `${count} ${noun} queued for transcription — finish or cancel them before ${actionLabel}.`;
}

function buildTranscriptionQueueStatePayload(state) {
  const jobs = state.jobOrder
    .map((meetingId) => state.jobsByMeetingId.get(meetingId))
    .filter(Boolean)
    .map((job) => ({
      meetingId: job.meetingId,
      status: job.status,
      phase: job.phase || null,
      title: job.title || '',
      durationSeconds: Number(job.durationSeconds) || 0,
    }));

  return {
    jobs,
    activeMeetingId: state.activeMeetingId,
    busyCount: countBusyTranscriptionJobs(state),
  };
}

function formatTranscriptSegmentTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function buildMeetingTranscriptMarkdown({
  audioPath = '',
  language = 'en',
  duration = 0,
  transcriptionResult = {},
  diarizationResult = null,
} = {}) {
  const sourceSegments = diarizationResult && Array.isArray(diarizationResult.segments)
    ? diarizationResult.segments
    : (transcriptionResult.segments || []);
  const basename = String(audioPath || 'recording').split(/[\\/]/).pop() || 'recording';
  const lines = [
    '# Meeting Transcription',
    '',
    `**File:** ${basename}`,
    `**Date:** ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`,
    `**Duration:** ${formatTranscriptSegmentTimestamp(duration || transcriptionResult.duration || 0)}`,
    `**Language:** ${language || transcriptionResult.language || 'en'}`,
    '',
    '---',
    '',
    '## Transcript',
    '',
  ];

  sourceSegments.forEach((segment) => {
    const startTime = formatTranscriptSegmentTimestamp(segment && segment.start);
    const endTime = formatTranscriptSegmentTimestamp(segment && segment.end);
    const speaker = segment && segment.speaker ? ` **${segment.speaker}:**` : '';
    lines.push(`**[${startTime} - ${endTime}]**${speaker}`);
    lines.push((segment && segment.text) || '');
    lines.push('');
  });

  if (!sourceSegments.length && transcriptionResult && transcriptionResult.text) {
    lines.push(transcriptionResult.text);
    lines.push('');
  }

  return lines.join('\n');
}

function buildSpeakerSidecarPayload({
  diarizationResult,
  audioPath,
  segmentsPath,
} = {}) {
  return {
    ...(diarizationResult && typeof diarizationResult === 'object' ? diarizationResult : {}),
    audioPath,
    segmentsPath,
  };
}

function buildGuidedDiarizationAiMetadata({
  diarizationResult,
  diarizationStatus,
  segmentsPath,
  status = 'completed',
  error = null,
} = {}) {
  if (status === 'error') {
    return {
      status: 'error',
      model: diarizationStatus && diarizationStatus.modelId,
      completedAt: new Date().toISOString(),
      error: error || 'Speaker identification failed.',
    };
  }

  return {
    status: 'completed',
    model: (diarizationResult && diarizationResult.model)
      || (diarizationStatus && diarizationStatus.modelId),
    completedAt: diarizationResult && diarizationResult.completedAt,
    speakerCount: diarizationResult && diarizationResult.speakerCount,
    segmentsPath,
    error: null,
  };
}

module.exports = {
  TRANSCRIPTION_QUEUE_STATE_CHANNEL,
  USER_CANCELLED_TRANSCRIPTION_ERROR,
  SESSION_READY_JOB_CAP,
  QUEUE_JOB_STATUSES,
  QUEUE_JOB_PHASES,
  createTranscriptionQueueState,
  upsertQueueJob,
  removeQueueJob,
  setActiveQueueMeeting,
  markTranscriptionJobCancelled,
  markTranscriptionJobDeleted,
  isTranscriptionJobCancelled,
  isTranscriptionJobDeleted,
  getTranscriptionCancelGuardGeneration,
  getTranscriptionDeleteGuardGeneration,
  clearTranscriptionJobCancelFlag,
  clearTranscriptionJobDeleteTombstone,
  shouldSkipJobAtHead,
  isTranscriptionJobBlocked,
  shouldTerminateComputeJobsForMeeting,
  countBusyTranscriptionJobs,
  trimSessionReadyJobs,
  formatQueuedTranscriptionBusyMessage,
  buildTranscriptionQueueStatePayload,
  formatTranscriptSegmentTimestamp,
  buildMeetingTranscriptMarkdown,
  buildSpeakerSidecarPayload,
  buildGuidedDiarizationAiMetadata,
};
