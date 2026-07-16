'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SESSION_READY_CAP,
  SOFT_QUEUE_DEPTH_WARNING,
  getActivityChipLabel,
  countBusyTranscriptionJobs,
  shouldApplyTranscriptionQueueState,
  getIdleStatusPillText,
  getRecordButtonLabel,
  buildResumePendingBannerView,
  countResumablePendingMeetings,
  buildActivityRows,
  getActivityEmptyStateText,
  formatQueuedTranscriptionBusyMessage,
  formatQuitPendingTranscriptionDetail,
  resolveMeetingDurationSeconds,
  formatDurationLabel,
  buildCompletionToastView,
  buildBackgroundTranscriptionTipView,
  buildSoftQueueDepthWarningView,
  resolveActivityRenameCommit,
} = require('../../src/renderer/transcription-activity-helpers');

test('queue state sequence rejects stale init snapshots and duplicate pushes', () => {
  assert.equal(shouldApplyTranscriptionQueueState({ seq: 4 }, 3), true);
  assert.equal(shouldApplyTranscriptionQueueState({ seq: 4 }, 4), false);
  assert.equal(shouldApplyTranscriptionQueueState({ seq: 3 }, 4), false);
  assert.equal(shouldApplyTranscriptionQueueState({ jobs: [] }, 4), false);
});

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

test('activity chips map queue phases and optional percent', () => {
  assert.equal(getActivityChipLabel({ status: 'queued' }), 'Queued');
  assert.equal(getActivityChipLabel({ status: 'active', phase: 'transcribing' }), 'Transcribing');
  assert.equal(
    getActivityChipLabel({ status: 'active', phase: 'identifying_speakers', percent: 41.2 }),
    'Identifying speakers · 41%',
  );
  assert.equal(getActivityChipLabel({ status: 'active', phase: 'waiting_resource' }), 'Waiting for GPU or model setup');
  assert.equal(getActivityChipLabel({ status: 'ready', phase: 'completed' }), 'Ready');
  assert.equal(getActivityChipLabel({ status: 'failed' }), 'Failed');
  assert.equal(getActivityChipLabel({ status: 'active', phase: 'transcribing', percent: null }), 'Transcribing');
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

test('buildActivityRows merges queue + durable, caps Ready, and exposes rename/delete', () => {
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
      { id: 'pending_old', title: 'Old pending', transcriptionStatus: 'pending', duration: '0:10', durationSeconds: 10 },
      { id: 'failed_old', title: 'Old failed', transcriptionStatus: 'failed', duration: '0:10', durationSeconds: 10 },
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
  assert.equal(rows.find((row) => row.meetingId === 'active_1').actions.includes('rename'), true);
  assert.equal(rows.find((row) => row.meetingId === 'active_1').actions.includes('delete'), true);
  assert.equal(rows.find((row) => row.meetingId === 'failed_old').actions.includes('retry'), true);
  assert.equal(rows.find((row) => row.status === 'ready').actions.includes('open'), true);
  assert.equal(rows.find((row) => row.meetingId === 'pending_old').durationLabel, '10s');
});

test('duration helpers ignore display M:SS strings', () => {
  assert.equal(resolveMeetingDurationSeconds({ duration: '1:23', durationSeconds: 83 }), 83);
  assert.equal(formatDurationLabel(83), '1 min');
  assert.equal(formatDurationLabel(Number('1:23') || 0), '0s');
});

test('completion toast prefers renamed titles and duration otherwise', () => {
  assert.match(
    buildCompletionToastView({ title: 'Sprint planning', durationSeconds: 120 }).message,
    /Sprint planning/,
  );
  assert.match(
    buildCompletionToastView({ title: 'Meeting 2026-07-16 11:42', durationSeconds: 120 }).message,
    /2 min/,
  );
});

test('first-run tip and soft queue-depth warning helpers', () => {
  assert.equal(buildBackgroundTranscriptionTipView({}).visible, true);
  assert.equal(buildBackgroundTranscriptionTipView({ backgroundTranscriptionTipSeen: true }).visible, false);
  assert.equal(buildSoftQueueDepthWarningView(SOFT_QUEUE_DEPTH_WARNING - 1).visible, false);
  assert.equal(buildSoftQueueDepthWarningView(SOFT_QUEUE_DEPTH_WARNING).visible, true);
});

test('activity rename commit skips empty/unchanged titles (no window.prompt)', () => {
  assert.deepEqual(
    resolveActivityRenameCommit({ draft: '  ', original: 'Old' }),
    { action: 'cancel' },
  );
  assert.deepEqual(
    resolveActivityRenameCommit({ draft: 'Old', original: 'Old' }),
    { action: 'cancel' },
  );
  assert.deepEqual(
    resolveActivityRenameCommit({ draft: '  Sprint planning  ', original: 'Old' }),
    { action: 'save', title: 'Sprint planning' },
  );
});

test('empty state and fail-fast / quit copy helpers', () => {
  assert.match(getActivityEmptyStateText(), /transcribe/i);
  assert.match(formatQueuedTranscriptionBusyMessage(2, 'installing'), /2 recordings are queued/);
  assert.match(formatQuitPendingTranscriptionDetail(1), /next time you open AvaNevis/);
});
