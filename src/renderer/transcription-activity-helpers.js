(function attachTranscriptionActivityHelpers(root) {
  const SESSION_READY_CAP = 5;

  const ACTIVITY_CHIP_LABELS = Object.freeze({
    queued: 'Queued',
    transcribing: 'Transcribing',
    identifying_speakers: 'Identifying speakers',
    waiting_resource: 'Waiting for GPU or model setup',
    persisting: 'Saving transcript',
    ready: 'Ready',
    failed: 'Failed',
    cancelled: 'Cancelled',
  });

  function formatDurationLabel(durationSeconds) {
    const total = Math.max(0, Math.floor(Number(durationSeconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) {
      return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    }
    if (minutes > 0) {
      return `${minutes} min`;
    }
    return `${seconds}s`;
  }

  function getActivityChipLabel(job = {}) {
    const status = String(job.status || '');
    const phase = String(job.phase || '');
    if (status === 'queued' || phase === 'queued') {
      return ACTIVITY_CHIP_LABELS.queued;
    }
    if (status === 'failed' || phase === 'failed') {
      return ACTIVITY_CHIP_LABELS.failed;
    }
    if (status === 'cancelled' || phase === 'cancelled') {
      return ACTIVITY_CHIP_LABELS.cancelled;
    }
    if (status === 'ready' || phase === 'completed') {
      return ACTIVITY_CHIP_LABELS.ready;
    }
    if (phase === 'identifying_speakers') {
      return ACTIVITY_CHIP_LABELS.identifying_speakers;
    }
    if (phase === 'waiting_resource') {
      return ACTIVITY_CHIP_LABELS.waiting_resource;
    }
    if (phase === 'persisting') {
      return ACTIVITY_CHIP_LABELS.persisting;
    }
    if (status === 'active' || phase === 'transcribing') {
      return ACTIVITY_CHIP_LABELS.transcribing;
    }
    return ACTIVITY_CHIP_LABELS.queued;
  }

  function countBusyTranscriptionJobs(jobs = []) {
    return (jobs || []).filter((job) => {
      const status = String(job && job.status || '');
      return status === 'queued' || status === 'active';
    }).length;
  }

  function shouldApplyTranscriptionQueueState(payload, lastAppliedSeq = 0) {
    const seq = Number(payload && payload.seq) || 0;
    return seq > (Number(lastAppliedSeq) || 0);
  }

  /**
   * Home status pill while capture is idle.
   * @returns {string}
   */
  function getIdleStatusPillText(queueState = {}) {
    const busy = countBusyTranscriptionJobs(queueState.jobs);
    if (busy <= 0) {
      return 'Ready';
    }
    return `Ready · ${busy} transcribing`;
  }

  /**
   * Record button label honesty — never "Transcribing…".
   */
  function getRecordButtonLabel(recordingState, stopProgressMessage = '') {
    if (recordingState === 'recording') {
      return 'Stop';
    }
    if (recordingState === 'stopping') {
      const message = String(stopProgressMessage || '').trim();
      if (message) {
        return message.length > 28 ? 'Saving…' : message;
      }
      return 'Saving…';
    }
    if (recordingState === 'starting') {
      return 'Starting...';
    }
    if (recordingState === 'countdown') {
      return null; // caller keeps countdown text
    }
    if (recordingState === 'initializing') {
      return 'Initializing...';
    }
    return 'Start Recording';
  }

  function buildResumePendingBannerView(pendingCount) {
    const count = Math.max(0, Number(pendingCount) || 0);
    if (count <= 0) {
      return { visible: false, count: 0, label: '', buttonLabel: '' };
    }
    const noun = count === 1 ? 'transcription' : 'transcriptions';
    return {
      visible: true,
      count,
      label: `${count} pending ${noun} ready to resume.`,
      buttonLabel: count === 1
        ? 'Resume 1 pending transcription'
        : `Resume ${count} pending transcriptions`,
    };
  }

  function countResumablePendingMeetings(meetings = [], queueState = {}) {
    const busyIds = new Set(
      (queueState.jobs || [])
        .filter((job) => {
          const status = String(job && job.status || '');
          return status === 'queued' || status === 'active';
        })
        .map((job) => String(job.meetingId || '')),
    );
    return (meetings || []).filter((meeting) => {
      if (!meeting || String(meeting.transcriptionStatus || '') !== 'pending') {
        return false;
      }
      return !busyIds.has(String(meeting.id || ''));
    }).length;
  }

  function activityRowFromQueueJob(job) {
    if (!job || !job.meetingId) {
      return null;
    }
    const status = String(job.status || '');
    const chip = getActivityChipLabel(job);
    const title = String(job.title || 'Untitled meeting').trim() || 'Untitled meeting';
    const durationLabel = formatDurationLabel(job.durationSeconds);
    const actions = [];
    if (status === 'queued' || status === 'active') {
      actions.push('cancel');
    }
    if (status === 'failed' || status === 'cancelled') {
      actions.push('retry', 'open');
    }
    if (status === 'ready') {
      actions.push('open');
    }
    return {
      meetingId: String(job.meetingId),
      title,
      durationLabel,
      chip,
      status,
      phase: job.phase || null,
      source: 'queue',
      actions,
    };
  }

  function activityRowFromDurableMeeting(meeting) {
    if (!meeting || !meeting.id) {
      return null;
    }
    const status = String(meeting.transcriptionStatus || '');
    if (status !== 'pending' && status !== 'failed') {
      return null;
    }
    const chip = status === 'failed' ? ACTIVITY_CHIP_LABELS.failed : ACTIVITY_CHIP_LABELS.queued;
    const actions = status === 'failed' ? ['retry', 'open'] : ['cancel', 'open'];
    return {
      meetingId: String(meeting.id),
      title: String(meeting.title || 'Untitled meeting').trim() || 'Untitled meeting',
      durationLabel: formatDurationLabel(meeting.duration),
      chip,
      status: status === 'failed' ? 'failed' : 'queued',
      phase: status === 'pending' ? 'queued' : 'failed',
      source: 'durable',
      actions,
    };
  }

  /**
   * Project queue-state + durable pending/failed meetings into Activity rows.
   * Session Ready rows come from queue status=ready (cap SESSION_READY_CAP).
   */
  function buildActivityRows({ queueState = {}, meetings = [] } = {}) {
    const jobs = Array.isArray(queueState.jobs) ? queueState.jobs : [];
    const seen = new Set();
    const rows = [];

    const readyJobs = [];
    for (const job of jobs) {
      const status = String(job && job.status || '');
      if (status === 'ready') {
        readyJobs.push(job);
        continue;
      }
      if (status === 'queued' || status === 'active' || status === 'failed' || status === 'cancelled') {
        const row = activityRowFromQueueJob(job);
        if (row) {
          seen.add(row.meetingId);
          rows.push(row);
        }
      }
    }

    // Newest ready first, then cap.
    const readyRows = readyJobs
      .slice()
      .reverse()
      .slice(0, SESSION_READY_CAP)
      .map(activityRowFromQueueJob)
      .filter(Boolean);
    readyRows.forEach((row) => seen.add(row.meetingId));

    for (const meeting of meetings || []) {
      const id = String(meeting && meeting.id || '');
      if (!id || seen.has(id)) {
        continue;
      }
      // Skip durable pending that is already covered by a busy queue row.
      const row = activityRowFromDurableMeeting(meeting);
      if (row) {
        seen.add(row.meetingId);
        rows.push(row);
      }
    }

    return rows.concat(readyRows);
  }

  function getActivityEmptyStateText() {
    return 'Recordings you finish will appear here while they transcribe.';
  }

  function formatQueuedTranscriptionBusyMessage(queuedCount, actionLabel = 'continuing') {
    const count = Math.max(0, Number(queuedCount) || 0);
    if (count <= 0) {
      return `Local AI work is still running. Finish or cancel it before ${actionLabel}.`;
    }
    const noun = count === 1 ? 'recording is' : 'recordings are';
    return `${count} ${noun} queued for transcription — finish or cancel them before ${actionLabel}.`;
  }

  function formatQuitPendingTranscriptionDetail(pendingCount) {
    const count = Math.max(0, Number(pendingCount) || 0);
    if (count <= 0) {
      return null;
    }
    const noun = count === 1 ? 'recording' : 'recordings';
    return `${count} ${noun} will finish transcribing next time you open AvaNevis.`;
  }

  const helpers = {
    SESSION_READY_CAP,
    ACTIVITY_CHIP_LABELS,
    formatDurationLabel,
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
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  }

  root.transcriptionActivityHelpers = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
