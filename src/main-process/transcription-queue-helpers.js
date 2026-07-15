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

function removeQueueJob(state, meetingId) {
  const id = String(meetingId || '').trim();
  if (!id) {
    return;
  }
  state.jobsByMeetingId.delete(id);
  state.jobOrder = state.jobOrder.filter((entry) => entry !== id);
  if (state.activeMeetingId === id) {
    state.activeMeetingId = null;
  }
  state.cancelFlags.delete(id);
}

function setActiveQueueMeeting(state, meetingId) {
  state.activeMeetingId = meetingId ? String(meetingId) : null;
}

function markTranscriptionJobCancelled(state, meetingId) {
  const id = String(meetingId || '').trim();
  if (!id) {
    return false;
  }
  state.cancelFlags.add(id);
  const job = state.jobsByMeetingId.get(id);
  if (job && job.status === QUEUE_JOB_STATUSES.queued) {
    upsertQueueJob(state, {
      meetingId: id,
      status: QUEUE_JOB_STATUSES.cancelled,
      phase: QUEUE_JOB_PHASES.cancelled,
    });
  }
  return true;
}

function isTranscriptionJobCancelled(state, meetingId) {
  return state.cancelFlags.has(String(meetingId || '').trim());
}

/**
 * Clear a consumed cancel flag. Must be called whenever a job passes the
 * head-of-queue gate or reaches a terminal state — a leaked flag would make
 * every future job for that meeting (e.g. Retry from History) self-cancel.
 */
function clearTranscriptionJobCancelFlag(state, meetingId) {
  return state.cancelFlags.delete(String(meetingId || '').trim());
}

/**
 * Head-of-queue gate: skip spawning Whisper when quit has begun or the user cancelled.
 */
function shouldSkipJobAtHead({ isQuitCommitted = false, isCancelled = false } = {}) {
  return Boolean(isQuitCommitted) || Boolean(isCancelled);
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
  QUEUE_JOB_STATUSES,
  QUEUE_JOB_PHASES,
  createTranscriptionQueueState,
  upsertQueueJob,
  removeQueueJob,
  setActiveQueueMeeting,
  markTranscriptionJobCancelled,
  isTranscriptionJobCancelled,
  clearTranscriptionJobCancelFlag,
  shouldSkipJobAtHead,
  buildTranscriptionQueueStatePayload,
  formatTranscriptSegmentTimestamp,
  buildMeetingTranscriptMarkdown,
  buildSpeakerSidecarPayload,
  buildGuidedDiarizationAiMetadata,
};
