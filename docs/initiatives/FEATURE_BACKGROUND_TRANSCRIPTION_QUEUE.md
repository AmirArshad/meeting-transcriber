# Feature: Back-to-Back Recording & Transcription Queue

**Status:** Next big feature — design locked (adversarial review incorporated); Phase 1 not started  
**Working title:** Background transcription queue  
**Primary pain:** After Stop, users wait through encode + full Whisper (and optional diarization) before they can start the next meeting.  
**Review input:** Adversarial design review (2026-07-15) — findings below are incorporated as product/architecture decisions, not open questions.  
**Diagram:** [Architecture + Home UX before/after](../architecture/background-transcription-queue-before-after.svg)  
**Tracking:** Root [`todo.md`](../../todo.md) · [Roadmap (In progress)](ROADMAP.md)

## Verdict

**Ship with changes — architecture-first, not “mostly renderer.”**

The product instinct is right and the unlock boundary is correctly identified: main’s `start-recording` only checks recorder busy state; nothing in main blocks Start during transcription. Unlocking Start is therefore renderer capture-state work.

But today a fresh recording **has no meeting until transcription finishes**. The renderer composes transcript markdown, calls `addMeeting` with `transcriptionStatus: 'completed'` only after Whisper returns (`src/renderer/app.js`), and orchestrates guided-vs-normal fallback plus diarization sidecars from module globals (`currentAudioFile`, `currentRecordingMeeting`). A queue that merely removes `await transcribeAudio()` inherits that global state and breaks as soon as Meeting 2 starts while Meeting 1’s promise is in flight (clobbered paths, wrong meeting attribution, lost persistence on renderer reload).

**Phase 1 is therefore:** move fresh-recording transcription persistence into main, on the pattern `retry-transcription` already implements end-to-end in `src/main/transcription-service.js`. Stop → `addMeeting(pending)` + placeholder transcript → main-owned per-meeting compute job → renderer becomes a pure view of queue state.

Do not promise “instant next recording” across encode. Promise **“record again as soon as the file is saved.”**

| Stage | What happens | Can next recording start? |
|-------|--------------|---------------------------|
| A. Capture stop + mix/encode | Recorder finalizes spools → Opus/WAV | **No** — capture exclusive |
| B. Persist pending meeting | `addMeeting` + placeholder transcript | Unlock after this |
| C. Transcription (+ optional diarization) | Main-owned job on `aiComputeActionQueue` | **Yes** — must not block Start |
| D. Summary | User-triggered only | Already non-blocking |

## Goals

1. After successful stop + pending persist, return capture to **Ready** and allow Start without waiting for Whisper.
2. Persist finished recordings immediately with durable `transcriptionStatus: pending|failed|completed` only (see status model). Process jobs FIFO on the existing compute queue, owned by main.
3. Replace the Home “current transcript” panel with an **Activity** surface driven by a structured main→renderer queue-state channel.
4. Preserve privacy-first local-only behavior, quit-terminate + durable-pending semantics, single-GPU serialization, and recording quality under concurrent CPU transcription.

## Non-goals

- Parallel / overlapping live recordings (still one capture session at a time).
- Skipping or backgrounding Stage A encode before the next Start.
- Real-time / streaming captions during capture.
- Auto-running summaries when a queued transcript completes.
- Replacing History — History remains the library; Home is operations.
- Tray / presence “Transcribing N” hints (cut until explicitly requested — easy to regress `recording-presence-service`).
- Persisting a `processing` transcription status (invalid today; see below).

## Locked product decisions

| Area | Decision |
|------|----------|
| Queue owner | **Main process.** Renderer never runs the fresh-recording `transcribeAudio` orchestration for new stops. |
| Unlock moment | Capture unlocks when stop has a saved audio path **and** the meeting is added with `pending` + placeholder transcript — before Whisper starts. |
| Encode still blocks Start | While `stopping` / post-processing, Start stays disabled. Copy: “Saving recording…” (surface existing stop-stage messages), never “Transcribing…”. |
| Durable status | Only `pending` \| `failed` \| `completed` in meeting metadata (`VALID_TRANSCRIPTION_STATUSES`). **Do not persist `processing`.** In-flight work is in-memory queue state in main. Crash/quit mid-job leaves durable `pending` → resume is natural. |
| Job unit | **Per-meeting composite:** transcribe → optional diarize (guided path or post-pass) → persist — one compute-queue entry so Meeting 2 cannot interleave between Meeting 1’s transcript and speaker pass. Shape after `retry-transcription`. |
| Guided readiness | Re-check guided readiness **at head-of-queue** (setup can change while queued). Do **not** snapshot guided-ness at enqueue. |
| Settings snapshot | Snapshot language/model (and related options) **at stop** onto the meeting (`addMeeting` already persists language/model; job reads them back like retry). Live dropdown changes must not affect in-flight/queued jobs. |
| Audio path | Job must use **`savedMeeting.audioPath`** after transactional add (original recorder path is removed). |
| Incomplete model cache | Same as retry today: in-job download may consume wall-clock budget — accepted; document in release notes / tip if needed. |
| Job ordering | FIFO by enqueue time. Capture never waits on the queue. |
| Home panel | “Activity” (or “Recent”). Session-only Ready rows (cap ~5); durable rows only for `pending` / `failed`. |
| Result click | **History deep-link** only in Phase 1–2. No inline Home transcript drawer. |
| Button label | Go straight to **Stop**. Teach via status pill + one-time tip (Phase 2), not a teaching button label. |
| Empty state | “Recordings you finish will appear here while they transcribe.” |
| Resume (Phase 1) | **Explicit banner:** “Resume N pending transcriptions” — not auto. Gate any later auto-resume behind `recordingsMaintenanceGate` / post-scan. Never auto-resume `failed`. |
| Resume (Phase 2) | Auto-resume `pending` after recordings maintenance scan completes; visible “Resuming…” row + per-row cancel. |
| Quit | Matches AGENTS.md: quit **terminates** non-abortable transcription-class jobs; meetings stay `pending`. Dialog copy: “N recordings will finish transcribing next time you open AvaNevis.” Never “quit will wait.” |
| Max queue depth | Soft guidance later; do not hard-block Start for depth in Phase 1. |
| Cancel pending | Supported from Home (and needed): cancel queued/pending job without quitting. |
| Disk pressure | Unchanged free-space policy. |

## Status model

| Layer | Values | Notes |
|-------|--------|-------|
| Meeting metadata (durable) | `pending`, `failed`, `completed` | Unknown values coerce via `normalize_transcription_status` — never write `processing`. |
| Main queue state (in-memory) | `queued`, `active`, phases (`transcribing`, `identifying_speakers`, …), `cancelled` | Source of truth for Home chips while app is running. |
| Home chips | Queued / Transcribing / Identifying speakers / Waiting for GPU or model setup / Ready / Failed | Ready = session-only completed; Failed/Queued backed by durable metadata. |

## User stories

1. **Back-to-back meetings:** I stop Meeting 1; Start is available as soon as the file is saved; I record Meeting 2 while Meeting 1 transcribes in main.
2. **Queue visibility:** Home shows Meeting 1 “Transcribing…” and Meeting 2 “Queued” with correct identity; I click Ready rows to open History detail.
3. **Failure without blocking:** Meeting 1 failing does not block Meeting 2; Retry from the row or History.
4. **Cancel unwanted work:** I can cancel a pending/queued job (test clip) without quitting.
5. **Quit safety:** Quit kills the active job; audio + `pending` metadata survive; I resume via banner (Phase 1) or auto (Phase 2).

## UX touchpoints

### Phase 1 (ship)

| # | Touchpoint | Notes |
|---|------------|-------|
| 1 | Instant Ready after save + status pill (`Ready · 1 transcribing`) | Core delight |
| 2 | Home Activity list | Driven by `transcription-queue-state` |
| 3 | Phase/identity on active row | MeetingId-tagged; percent optional later |
| 5 | Button honesty (`Stop` / Saving…) | Use existing stop-stage `recording-progress` messages |
| 7 | Failure row: Retry · Open in History | |
| 7b | Cancel pending/queued from Home | Higher value than toast; escape hatch from long jobs |
| 9 | Quit copy corrected | “Finish next time you open…” |
| — | “Waiting for GPU setup / model download” chip | When parked behind mutual-exclusion waits |

### Phase 2

| # | Touchpoint | Notes |
|---|------------|-------|
| 4 | Non-blocking completion toast | Prefer duration/relative copy (“Your 42-minute recording is ready”) unless user-renamed |
| 8 | First-run tip | “You can start another recording while this one transcribes.” |
| — | Soft queue-depth warning | |
| — | Auto-resume pending post-scan | |

### Cut / defer

- Tray “Transcribing N” (presence-service regress risk).
- Inline Home transcript drawer.
- Teaching button label “Stop · Transcribe in background”.
- Time estimates for encode (“~30s”) — use phase text only.
- History badge parity called out as “delight” (table stakes; keep consistent copy, don’t treat as a feature beat).

Avoid: dashboard clutter, modals while recording, auto-playing audio on completion.

## Information architecture

```
Home
  [Record controls + visualizer]     ← capture only
  [Activity]                         ← queue + session Ready + durable pending/failed
       Ready / Open → History detail
History
  [Full meeting list + detail]       ← archive + retry + summary + Save As
```

## Architecture

### End-to-end flow

```
Stop recording (Stage A finalize — blocks Start)
  → addMeeting({
        transcriptionStatus: 'pending',
        language/model snapshotted,
        audioPath: post-add path,
        placeholder transcript via build_pending_transcript_placeholder
     })
  → main enqueues per-meeting composite job (meetingId-keyed) on aiComputeActionQueue
  → publish transcription-queue-state
  → renderer: capture idle / Start enabled; Activity shows Queued

Job reaches head of queue
  → re-check guided readiness + CUDA/CPU policy (like retry-transcription)
  → if capture non-idle: spawn/reduce child at below-normal priority; consider cpu_threads cap
  → optional: defer job start until capture leaves `starting` (protect device warm-up)
  → run composite: Whisper (+ optional diarization) → write transcript → update-transcription → completed/failed
  → tag progress with meetingId; publish queue-state transitions

Start recording (capture idle)
  → independent of queue depth; must not touch other meetings' job state
```

### Why main ownership (non-negotiable)

| Failure mode if renderer-owned | Mitigation |
|--------------------------------|------------|
| Meeting 2 Start clobbers `currentAudioFile` mid Meeting 1 transcribe | Main job keyed by `meetingId`; no shared renderer globals |
| Dev reload / crash drops awaiting promise; compute finishes with nobody writing `completed` | Main persists `update-transcription` |
| Quit cannot see “not yet enqueued” renderer work | Enqueue synchronously in main at stop-persist time → visible to `hasInFlightAiWork` / queue |

### Queue-state IPC (Phase 1 requirement)

Add a structured channel (name illustrative): `transcription-queue-state`

```json
{
  "jobs": [
    { "meetingId": "…", "status": "queued|active|failed|ready", "phase": "transcribing|identifying_speakers|waiting_resource|…", "title": "…", "durationSeconds": 0 }
  ],
  "activeMeetingId": "…"
}
```

- Push on every transition (enqueue, start, phase change, complete, fail, cancel).
- Tag `transcription-progress` (and related) events with `meetingId` of the active job. Percent can wait; **identity cannot**.
- Home Activity is a pure projection of this channel + session Ready ring buffer.

### Persistence helpers to reuse

- `build_pending_transcript_placeholder` (already used by scan-import).
- `retry-transcription` preflight, guided decision from catalog in main, transcript write, `update-transcription`.
- Durable statuses only from `VALID_TRANSCRIPTION_STATUSES` in `backend/meetings/normalization.py`.

### Recoverable stop failures

`success: false` + recoverable `audioPath` must use the **same** save-pending-first + main enqueue path (today it bypasses meeting creation until transcription ends). Preserve stop error text in meeting metadata where useful.

### Delete-while-queued

`createAsyncActionQueue` is chained-promise FIFO with **no dequeue**. Implement:

1. Per-meeting **cancel flag** checked when the job reaches the head (skip cheaply).
2. If the **active** job’s meeting is deleted: either refuse delete (“Finishing transcription — try again”) **or** terminate child then delete — pick one in implementation; prefer terminate+delete for UX consistency with cancel.
3. After cancel/delete, job must not write transcript artifacts for a tombstoned meeting (`delete_tx` interplay).

### Resource contention (recording + transcribing)

Premise of the feature is capture concurrent with Whisper. CPU-fallback Whisper can peg cores and starve WASAPI callbacks → glitched **new** recording audio.

**Phase 1 mitigations (required, small):**

- When capture state is non-idle, spawn/reduce the transcription child at **below-normal process priority**.
- Consider capping faster-whisper `cpu_threads` when capture is active.
- Optionally defer starting the next queue job until capture leaves `starting`.
- Manual smoke checklist item: **record while a CPU transcription runs**.

### GPU install / model download vs deep queues

`runGpuRuntimeAction` and `download-model` wait for **full compute-queue idle** (15 min bounds). With a real queue, those waits become routinely exceedable.

**Phase 1 minimum:** fail fast with explicit copy (“N recordings are queued for transcription — finish/cancel them before installing”). Surface Activity chip **Waiting for GPU setup / model download** when the inverse happens (job parked).

**Phase 2+ better:** admit runtime/preload actions **between** jobs on `gpuResourceActionQueue` rather than requiring total idle forever.

### Quit

Align with AGENTS.md / `drainAiWorkBeforeQuit`:

- Terminate active transcription-class job; do not wait for Whisper.
- Meetings remain `pending`.
- Queued-but-not-started jobs: drop from in-memory queue; durable `pending` remains.
- Renderer quit copy must not claim the app will wait for transcriptions to finish.

### Resume-on-launch

- **Owner:** main, after recordings maintenance / scan-import completes (scan can create `pending` from recovered temps).
- **Phase 1:** do not auto-enqueue; show banner with count + Resume action → enqueue through the same per-meeting job path.
- **Phase 2:** auto-enqueue all `pending` once post-scan; never auto-enqueue `failed`.

## Edge cases

| Case | Behavior |
|------|----------|
| Stop fails with recoverable audio | Save pending meeting first (incl. error note), enqueue, unlock. |
| Quit during Stage A | Existing quit-during-recording / persist rules unchanged. |
| Quit during queued/active | Terminate active; all unfinished stay `pending`; no wait. |
| Delete while queued | Cancel flag / skip at head; no artifact write after tombstone. |
| Delete while active | Refuse or terminate-then-delete (implementation pick; document). |
| Guided fails | Same as retry: normal transcript + diarization error metadata when applicable. |
| GPU install / preload while queue deep | Fail fast with N-queued copy (Phase 1); between-job admit later. |
| Model dropdown changed after stop | Ignored; job uses snapshotted meeting language/model. |
| Incomplete snapshotted model cache | May download in-job (retry behavior); can burn wall-clock budget. |
| Single instance | One main queue owner. |

## Phased delivery

### Phase 1 — Main-owned unlock (MVP)

Minimum shippable:

1. Stop → `addMeeting(pending)` + placeholder transcript (including recoverable-failure path).
2. Main enqueues per-meeting composite job (`retry-transcription` shape); snapshot settings; use post-add `audioPath`.
3. Renderer returns to idle immediately; remove Start-blocking `transcribing` capture state for this flow.
4. `transcription-queue-state` channel + meetingId-tagged progress; Home Activity: Queued / Transcribing / Failed (Retry) / Cancel pending + session-only Ready → History.
5. Quit: terminate active; stay `pending`; corrected quit copy.
6. Explicit “Resume N pending transcriptions” banner (no auto-resume).
7. Contention mitigation: below-normal priority (and related) when recording while transcribing.
8. GPU/preload: fail-fast copy when queue non-idle (no 15-minute false hope).

**Cut from Phase 1:** percent progress, completion toasts, tray hints, soft depth warning, first-run tip, auto-resume, dismiss-from-Home-only-for-completed archival rows (cancel pending is in).

### Phase 2 — Polish

- Auto-resume `pending` post-scan.
- Completion toasts (duration-based copy).
- First-run tip; soft queue-depth warning.
- Richer phase text / optional percent.
- Between-job GPU/preload admission if still painful.

### Phase 3 — Optional

- Inline Home preview (only if History deep-link feels too slow).
- Import-audio reuses the same queue + Activity UI.
- Reorder / pause queue — probably never.

## Implementation touch points (for a later execution plan)

| Area | Files / symbols |
|------|-----------------|
| Stop → pending persist | `src/renderer/app.js` `stopRecording`; new main helper or extend meeting-manager client |
| Main job | `src/main/transcription-service.js` (`retry-transcription` pattern); composite diarization |
| Queue + cancel | `src/main/ai-compute-queue.js` / transcription service cancel flags |
| Queue state IPC | New channel + `src/preload.js` + renderer Activity UI |
| Placeholder / statuses | `backend/meeting_manager.py`, `backend/meetings/normalization.py` — do **not** add `processing` |
| Quit copy | `src/main.js` / presence close-dialog helpers |
| Priority / smoke | Transcription spawn path; `tests/manual/recording-smoke-checklist.md` |
| Characterization | JS tests for queue-state helpers; meeting status normalization tests |

No recorder stdout JSON contract changes. No second compute scheduler.

## Success metrics (qualitative)

- Start Meeting 2 within seconds of Meeting 1’s **file save**, not after Whisper.
- Two overlapping meetings never cross-wire audio paths or transcripts.
- Quit never claims transcriptions will finish in-process; relaunch can resume pending audio.
- Recording-while-CPU-transcribe smoke does not produce obviously glitched capture.
- Cancel pending works without quitting the app.

## Relationship to roadmap

Tracked under Transcription in `docs/initiatives/ROADMAP.md`. Complements “Upload existing audio files” — imports should enqueue on the same Activity surface later.

## Out of scope reminders

Do not weaken:

- Single capture session invariant (`recorder-service` states).
- Recorder stdout JSON control contract.
- Privacy / no cloud transcription.
- Compute-queue serialization and wall-clock timeouts (including metadata-phase summary exemptions).
- Summary remains user-triggered.
- `VALID_TRANSCRIPTION_STATUSES` — unknown statuses must not be introduced as durable values without updating normalization **and** every caller; prefer in-memory phases instead.
