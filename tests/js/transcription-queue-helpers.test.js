'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
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
  buildMeetingTranscriptMarkdown,
  buildSpeakerSidecarPayload,
  buildGuidedDiarizationAiMetadata,
} = require('../../src/main-process/transcription-queue-helpers');

test('queue state channel and cancel copy stay pinned', () => {
  assert.equal(TRANSCRIPTION_QUEUE_STATE_CHANNEL, 'transcription-queue-state');
  assert.equal(USER_CANCELLED_TRANSCRIPTION_ERROR, 'Cancelled by user');
});

test('shouldSkipJobAtHead gates quit and cancel', () => {
  assert.equal(shouldSkipJobAtHead({}), false);
  assert.equal(shouldSkipJobAtHead({ isQuitCommitted: true }), true);
  assert.equal(shouldSkipJobAtHead({ isCancelled: true }), true);
  assert.equal(shouldSkipJobAtHead({ isQuitCommitted: true, isCancelled: true }), true);
});

test('queue upsert/publish payload tracks active meeting and order', () => {
  const state = createTranscriptionQueueState();
  upsertQueueJob(state, {
    meetingId: 'meeting_a',
    status: QUEUE_JOB_STATUSES.queued,
    phase: QUEUE_JOB_PHASES.queued,
    title: 'A',
    durationSeconds: 12,
  });
  upsertQueueJob(state, {
    meetingId: 'meeting_b',
    status: QUEUE_JOB_STATUSES.queued,
    phase: QUEUE_JOB_PHASES.queued,
    title: 'B',
  });
  setActiveQueueMeeting(state, 'meeting_a');
  upsertQueueJob(state, {
    meetingId: 'meeting_a',
    status: QUEUE_JOB_STATUSES.active,
    phase: QUEUE_JOB_PHASES.transcribing,
  });

  const payload = buildTranscriptionQueueStatePayload(state);
  assert.equal(payload.activeMeetingId, 'meeting_a');
  assert.equal(payload.jobs.length, 2);
  assert.equal(payload.jobs[0].meetingId, 'meeting_a');
  assert.equal(payload.jobs[0].status, 'active');
  assert.equal(payload.jobs[0].phase, 'transcribing');
  assert.equal(payload.jobs[1].meetingId, 'meeting_b');
});

test('cancel flag marks queued jobs cancelled and is readable at head', () => {
  const state = createTranscriptionQueueState();
  upsertQueueJob(state, { meetingId: 'meeting_c', status: QUEUE_JOB_STATUSES.queued });
  assert.equal(markTranscriptionJobCancelled(state, 'meeting_c'), true);
  assert.equal(isTranscriptionJobCancelled(state, 'meeting_c'), true);
  assert.equal(state.jobsByMeetingId.get('meeting_c').status, QUEUE_JOB_STATUSES.cancelled);
  assert.equal(shouldSkipJobAtHead({
    isCancelled: isTranscriptionJobCancelled(state, 'meeting_c'),
  }), true);
});

test('clearTranscriptionJobCancelFlag consumes the flag so later jobs do not self-cancel', () => {
  const state = createTranscriptionQueueState();
  upsertQueueJob(state, { meetingId: 'meeting_e', status: QUEUE_JOB_STATUSES.queued });
  markTranscriptionJobCancelled(state, 'meeting_e');
  assert.equal(isTranscriptionJobCancelled(state, 'meeting_e'), true);

  // Head-of-queue consumption: clear, then a NEW job (e.g. Retry) must not
  // observe a stale flag.
  assert.equal(clearTranscriptionJobCancelFlag(state, 'meeting_e'), true);
  assert.equal(isTranscriptionJobCancelled(state, 'meeting_e'), false);
  assert.equal(shouldSkipJobAtHead({
    isCancelled: isTranscriptionJobCancelled(state, 'meeting_e'),
  }), false);

  // Clearing an absent flag is a safe no-op.
  assert.equal(clearTranscriptionJobCancelFlag(state, 'meeting_e'), false);
});

test('removeQueueJob clears active id and cancel flag', () => {
  const state = createTranscriptionQueueState();
  upsertQueueJob(state, { meetingId: 'meeting_d' });
  setActiveQueueMeeting(state, 'meeting_d');
  markTranscriptionJobCancelled(state, 'meeting_d');
  removeQueueJob(state, 'meeting_d');
  assert.equal(state.jobsByMeetingId.has('meeting_d'), false);
  assert.equal(state.activeMeetingId, null);
  assert.equal(isTranscriptionJobCancelled(state, 'meeting_d'), false);
});

test('buildMeetingTranscriptMarkdown includes speaker labels when present', () => {
  const markdown = buildMeetingTranscriptMarkdown({
    audioPath: 'C:/recordings/meeting.opus',
    language: 'en',
    duration: 65,
    transcriptionResult: { segments: [{ start: 0, end: 1.5, text: 'Hello', speaker: 'SPEAKER_00' }] },
  });
  assert.match(markdown, /meeting\.opus/);
  assert.match(markdown, /01:05/);
  assert.match(markdown, /SPEAKER_00/);
  assert.match(markdown, /Hello/);
});

test('sidecar and AI metadata helpers shape durable diarization fields', () => {
  const sidecar = buildSpeakerSidecarPayload({
    diarizationResult: { speakerCount: 2, segments: [] },
    audioPath: '/r/a.opus',
    segmentsPath: '/r/a.speakers.json',
  });
  assert.equal(sidecar.audioPath, '/r/a.opus');
  assert.equal(sidecar.segmentsPath, '/r/a.speakers.json');
  assert.equal(sidecar.speakerCount, 2);

  const completed = buildGuidedDiarizationAiMetadata({
    diarizationResult: { model: 'pyannote/x', completedAt: '2026-01-01', speakerCount: 2 },
    diarizationStatus: { modelId: 'community-1' },
    segmentsPath: '/r/a.speakers.json',
  });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.segmentsPath, '/r/a.speakers.json');
  assert.equal(completed.error, null);

  const failed = buildGuidedDiarizationAiMetadata({
    diarizationStatus: { modelId: 'community-1' },
    status: 'error',
    error: 'boom',
  });
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'boom');
});
