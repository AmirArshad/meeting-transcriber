'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SESSION_READY_CAP,
  getActivityChipLabel,
  countBusyTranscriptionJobs,
  getIdleStatusPillText,
  getRecordButtonLabel,
  buildResumePendingBannerView,
  countResumablePendingMeetings,
  buildActivityRows,
  getActivityEmptyStateText,
  formatQueuedTranscriptionBusyMessage,
  formatQuitPendingTranscriptionDetail,
} = require('../../src/renderer/transcription-activity-helpers');

test('status pill shows Ready or Ready · N transcribing', () => {
  assert.equal(getIdleStatusPillText({ jobs: [] }), 'Ready');
  assert.equal(getIdleStatusPillText({
    jobs: [
      { meetingId: 'a', status: 'active' },
      { meetingId: 'b', status: 'queued' },
      { meetingId: 'c', status: 'ready' },
    ],
  }), 'Ready · 2 transcribing');
});

test('record button never says Transcribing', () => {
  assert.equal(getRecordButtonLabel('recording'), 'Stop');
  assert.equal(getRecordButtonLabel('stopping'), 'Saving…');
  assert.equal(getRecordButtonLabel('stopping', 'Encoding audio…'), 'Encoding audio…');
  assert.equal(getRecordButtonLabel('idle'), 'Start Recording');
  assert.notEqual(getRecordButtonLabel('stopping'), 'Transcribing...');
});

test('activity chips map queue phases', () => {
  assert.equal(getActivityChipLabel({ status: 'queued' }), 'Queued');
  assert.equal(getActivityChipLabel({ status: 'active', phase: 'transcribing' }), 'Transcribing');
  assert.equal(getActivityChipLabel({ status: 'active', phase: 'identifying_speakers' }), 'Identifying speakers');
  assert.equal(getActivityChipLabel({ status: 'active', phase: 'waiting_resource' }), 'Waiting for GPU or model setup');
  assert.equal(getActivityChipLabel({ status: 'ready', phase: 'completed' }), 'Ready');
  assert.equal(getActivityChipLabel({ status: 'failed' }), 'Failed');
});

test('resume banner is explicit and hidden when empty', () => {
  assert.deepEqual(buildResumePendingBannerView(0), {
    visible: false,
    count: 0,
    label: '',
    buttonLabel: '',
  });
  const one = buildResumePendingBannerView(1);
  assert.equal(one.visible, true);
  assert.match(one.buttonLabel, /Resume 1 pending transcription/);
  const many = buildResumePendingBannerView(3);
  assert.match(many.buttonLabel, /Resume 3 pending transcriptions/);
});

test('resumable pending excludes busy queue jobs and never counts failed', () => {
  const meetings = [
    { id: 'a', transcriptionStatus: 'pending' },
    { id: 'b', transcriptionStatus: 'pending' },
    { id: 'c', transcriptionStatus: 'failed' },
    { id: 'd', transcriptionStatus: 'completed' },
  ];
  assert.equal(countResumablePendingMeetings(meetings, {
    jobs: [{ meetingId: 'a', status: 'active' }],
  }), 1);
  assert.equal(countBusyTranscriptionJobs([
    { status: 'queued' },
    { status: 'active' },
    { status: 'ready' },
  ]), 2);
});

test('buildActivityRows merges queue + durable and caps session Ready', () => {
  const readyJobs = Array.from({ length: SESSION_READY_CAP + 2 }, (_, i) => ({
    meetingId: `ready_${i}`,
    status: 'ready',
    phase: 'completed',
    title: `Ready ${i}`,
    durationSeconds: 60,
  }));
  const rows = buildActivityRows({
    queueState: {
      jobs: [
        { meetingId: 'active_1', status: 'active', phase: 'transcribing', title: 'Live', durationSeconds: 120 },
        { meetingId: 'queued_1', status: 'queued', phase: 'queued', title: 'Next', durationSeconds: 30 },
        ...readyJobs,
      ],
    },
    meetings: [
      { id: 'pending_old', title: 'Old pending', transcriptionStatus: 'pending', duration: 10 },
      { id: 'failed_old', title: 'Old failed', transcriptionStatus: 'failed', duration: 10 },
      { id: 'active_1', title: 'dup', transcriptionStatus: 'pending', duration: 10 },
    ],
  });

  const ids = rows.map((row) => row.meetingId);
  assert.ok(ids.includes('active_1'));
  assert.ok(ids.includes('queued_1'));
  assert.ok(ids.includes('pending_old'));
  assert.ok(ids.includes('failed_old'));
  assert.equal(rows.filter((row) => row.status === 'ready').length, SESSION_READY_CAP);
  assert.equal(rows.find((row) => row.meetingId === 'active_1').actions.includes('cancel'), true);
  assert.equal(rows.find((row) => row.meetingId === 'failed_old').actions.includes('retry'), true);
  assert.equal(rows.find((row) => row.status === 'ready').actions.includes('open'), true);
});

test('empty state and fail-fast / quit copy helpers', () => {
  assert.match(getActivityEmptyStateText(), /appear here while they transcribe/);
  assert.match(formatQueuedTranscriptionBusyMessage(2, 'installing the GPU runtime'), /2 recordings are queued/);
  assert.match(formatQueuedTranscriptionBusyMessage(1, 'downloading'), /1 recording is queued/);
  assert.equal(formatQuitPendingTranscriptionDetail(0), null);
  assert.match(formatQuitPendingTranscriptionDetail(2), /finish transcribing next time/);
});
