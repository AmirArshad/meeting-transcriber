# Feature: Back-to-Back Recording & Transcription Queue

**Status:** PR1 in progress (`feature/transcription-queue-pr1`) — main-owned pending persist + composite job behind blocking UI; unlock / Activity UI are PR2  
**Working title:** Background transcription queue (+ cancel recording)  
**Primary pain:** After Stop, users wait through encode + full Whisper (and optional diarization) before they can start the next meeting. There is also no way to discard a recording — Stop always processes.  
**Review input:** Adversarial design review (2026-07-15) and second-pass review (2026-07-15) — findings below are incorporated as product/architecture decisions, not open questions.  
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
5. **Companion:** let users cancel (discard) an in-progress recording — today Stop always finalizes and processes; there is no escape hatch for false starts.

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
| Cancel semantics (durable) | Cancel → durable `failed` with `transcriptionError: "Cancelled by user"`. Never leave a user-cancelled job `pending` — the resume banner (and Phase 2 auto-resume) would keep offering work the user explicitly declined. Still retryable from History. |
| Progress attribution | **Do not change the `transcription-progress` payload** (string; pinned by Phase 0 IPC characterization tests). The compute queue guarantees one active job, so the renderer attributes all progress lines to `activeMeetingId` from the new queue-state channel. The queue-state channel is the only new IPC surface. |
| Child priority | Transcription/diarization children lower their **own** priority to below-normal unconditionally at startup (ctypes `SetPriorityClass` on Windows / `os.nice` on macOS). No dynamic capture-state check: Node `spawn` has no priority option on Windows, and capture can become active after a job spawned at normal priority. Batch work has no interactivity to protect — always-low is simpler and covers the mid-job Start case. |
| Sidecar persistence | Guided diarization sidecar + `update-meeting-ai` writes move **into the main job** for queue jobs. Today `retry-transcription` returns the diarization result and the *renderer* persists sidecars (`saveGuidedDiarizationMetadata` in `src/renderer/app.js`) — a background job completing during renderer reload/quit would silently lose speaker metadata. This is the one place where "reuse the retry shape" is misleading; it is a genuine scope item, not a doc line. |
| Disk pressure | Unchanged free-space policy. |

## Status model

| Layer | Values | Notes |
|-------|--------|-------|
| Meeting metadata (durable) | `pending`, `failed`, `completed` | Unknown values coerce via `normalize_transcription_status` — never write `processing`. |
| Main queue state (in-memory) | `queued`, `active`, phases (`transcribing`, `identifying_speakers`, …), `cancelled` | Source of truth for Home chips while app is running. Durable mapping: `cancelled` → `failed` ("Cancelled by user"); quit-killed → stays `pending`. |
| Home chips | Queued / Transcribing / Identifying speakers / Waiting for GPU or model setup / Ready / Failed | Ready = session-only completed; Failed/Queued backed by durable metadata. |

## User stories

1. **Back-to-back meetings:** I stop Meeting 1; Start is available as soon as the file is saved; I record Meeting 2 while Meeting 1 transcribes in main.
2. **Queue visibility:** Home shows Meeting 1 “Transcribing…” and Meeting 2 “Queued” with correct identity; I click Ready rows to open History detail.
3. **Failure without blocking:** Meeting 1 failing does not block Meeting 2; Retry from the row or History.
4. **Cancel unwanted work:** I can cancel a pending/queued job (test clip) without quitting.
5. **Discard a bad recording:** I started recording by mistake (wrong device, false start); I hit Discard, confirm, and nothing is saved or transcribed — no meeting, no queue entry, no recovered file on relaunch.
6. **Quit safety:** Quit kills the active job; audio + `pending` metadata survive; I resume via banner (Phase 1) or auto (Phase 2).

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
- Inline Home transcript drawer. **Known tradeoff to watch:** today the most common flow is a *single* recording whose transcript appears inline on Home; deep-link-only means first-time users click a Ready row instead of seeing words appear. Treat first-release feedback on this as expected (Phase 3 inline preview is the hedge), not a surprise regression.
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
- **Leave `transcription-progress` untouched** (raw string; payload pinned by Phase 0 IPC characterization tests). One active compute job at a time means the renderer attributes every progress line to `activeMeetingId` from this channel — identity without contract breakage. Percent can wait; **identity cannot**.
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

- Transcription/diarization children lower their **own** priority to below-normal unconditionally at startup (ctypes `SetPriorityClass` on Windows, `os.nice` on macOS). Not spawn-time, not capture-conditional — Node `spawn` has no Windows priority option, and capture can start *after* the job spawned. Always-low is simpler and covers the mid-job Start case at zero cost when idle.
- Consider capping faster-whisper `cpu_threads` when capture is active (optional; measure first).
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

**Two job-level guards (required — latent bug becomes routine with queue depth > 1):**

1. **Head-of-queue quit check.** `createAsyncActionQueue` is chained promises: after quit terminates the *active* job, the queue advances and the next closure would start a fresh Whisper run mid-quit. Every job must check `quitCommitted` (and its cancel flag) as its first act at head-of-queue and no-op. This is the **same primitive** as delete-while-queued cancellation — implement once.
2. **Skip the write-`failed` path on quit-kill.** A job killed by quit must not run its failure handler's `update-transcription --status failed` write: it would spawn a `meeting_manager` Python child during quit teardown (racing the force-kill loop) and mark a perfectly resumable meeting as failed. Check `isQuitCommitted()` in the job's catch: quit-killed → leave durable `pending`; real failure → write `failed`.

### Resume-on-launch

- **Owner:** main, after recordings maintenance / scan-import completes (scan can create `pending` from recovered temps).
- **Phase 1:** do not auto-enqueue; show banner with count + Resume action → enqueue through the same per-meeting job path.
- **Phase 2:** auto-enqueue all `pending` once post-scan; never auto-enqueue `failed`.

## Companion feature: Cancel recording (discard)

Today Stop always finalizes and processes — there is no way to throw away an in-progress recording (test clip, false start, wrong device). This initiative adds **Cancel recording**: stop capture, discard everything, create no meeting. It is separable from the queue (own PR; touches the recorder contract, not the compute queue) but shares the Activity/Home surface and copy work.

### Locked decisions

| Area | Decision |
|------|----------|
| Availability | Cancel is offered only while `recording` (and during countdown, which already has cancel). **Not** during `stopping`: once `stop` is sent, finalize is committed — same rule as the quit-cancel invariant ("stop was sent must await/persist the stop result"). |
| Confirmation | Destructive → always confirm: "Discard this recording? The audio will not be saved." No "don't ask again" in v1. |
| UI | Secondary/tertiary affordance near the Stop button (small "Discard" link/button). Must not be adjacent-clickable with Stop. New renderer state `cancelling` → `idle`. |
| Outcome | No meeting is created. Nothing appears in Activity or History. Status pill returns to Ready. |
| Quit dialog | Unchanged in v1 — quit-during-recording keeps its existing persist semantics. (A "Discard and quit" option is a possible later addition, not in scope.) |

### Recorder contract (both platforms, update together per AGENTS.md)

- **New stdin command `cancel`** alongside `stop`. ⚠️ The current parser is a substring match (`"stop" in line.lower()` — `backend/audio/windows_recorder.py` `input_listener`); the command word must not contain "stop", and the parser should be tightened to exact-token matching while touched (a `cancel` line must never trigger finalize).
- On `cancel`: stop capture threads, **skip all Stage A post-processing** (no normalize/mix/encode), discard spools, and emit a structured final JSON result on stdout, e.g. `{ "success": true, "cancelled": true }` — never exit with only a stderr traceback (existing invariant).
- **Tombstone-ordered spool discard.** Durable `{stem}.capture/` spools are intentionally crash-recoverable via `audio.capture_recovery`; a cancelled session must not be resurrected as a recording on next launch. Order: write a `discarded` marker into the capture manifest **first**, then delete spool dirs / `.pcm.tmp` temps (best-effort). Recovery and scan-import must treat a `discarded`-marked capture as cleanup-only, never promote it. Mirrors the `delete_tx` tombstone pattern.
- If spool deletion partially fails, the marker still prevents resurrection; leftover files are removed by the existing recovery/cleanup sweep.
- `src/main/recorder-service.js`: new cancel path publishes capture state (`stopping`-equivalent or a distinct `cancelling`) and resolves to idle without invoking `addMeetingToHistory` or the transcription enqueue. Stop/cancel are mutually exclusive: first command wins; a cancel arriving after `stop` was written is rejected (recording is already finalizing).
- Contract test updates required (AGENTS.md recorder invariant list): `src/main-process/recorder-output-helpers.js`, `tests/js/recorder-event-contract.test.js`, `tests/python/test_recorder_event_contract.py`, `tests/js/main-process-helpers.test.js`, plus the manual smoke checklist (cancel mid-recording on both platforms; relaunch after cancel shows no recovered meeting).

### Edge cases (cancel)

| Case | Behavior |
|------|----------|
| Cancel while `starting` | Allowed: abort startup, kill recorder child, clean spools if any were created. |
| Cancel while `stopping` | Rejected — finalize already committed; UI hides Discard once Stop is pressed. |
| Quit during recording | Unchanged existing persist rules; cancel plays no role. |
| Recorder crashes mid-cancel (marker written, spools remain) | Next-launch recovery sees `discarded` marker → cleanup-only, no resurrection. |
| Recorder crashes mid-cancel (before marker) | Session recovers as a normal interrupted recording — safe default (never silently lose audio on ambiguity). |

## Edge cases

| Case | Behavior |
|------|----------|
| Stop fails with recoverable audio | Save pending meeting first (incl. error note), enqueue, unlock. |
| `addMeeting(pending)` itself fails (lock timeout, disk full) | Surface the error, stay idle, do **not** enqueue. Audio is already in the recordings dir, so existing `scan-recordings` / scan-import recovery creates the pending meeting with placeholder on next scan — "zero lost audio" holds even when persistence hiccups. |
| Cancelled job (user) | Durable `failed` + "Cancelled by user"; never resurfaces in resume banner; retryable from History. |
| Quit-killed job | Durable stays `pending`; no failure-status write during quit (see Quit guards). |
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

**Ship as two PRs** (bisectable risk, fits characterization-first style):

- **PR 1 — architecture move, behavior-identical:** main-owned composite job + `transcription-queue-state` channel behind the *current* blocking UI (renderer still waits). Includes moving guided-sidecar / `update-meeting-ai` persistence into main. Characterization tests pin that behavior is unchanged.
- **PR 2 — visible flip:** unlock Start, Activity UI, resume banner, quit copy.

**PR 3 (companion, independent):** Cancel recording (discard) — recorder `cancel` stdin command + tombstoned spool discard + Discard UI. Can land before, between, or after PR 1/2.

Minimum shippable:

1. Stop → `addMeeting(pending)` + placeholder transcript (including recoverable-failure path).
2. Main enqueues per-meeting composite job (`retry-transcription` shape); snapshot settings; use post-add `audioPath`.
3. Renderer returns to idle immediately; remove Start-blocking `transcribing` capture state for this flow.
4. `transcription-queue-state` channel + meetingId-tagged progress; Home Activity: Queued / Transcribing / Failed (Retry) / Cancel pending + session-only Ready → History.
5. Quit: terminate active; stay `pending`; corrected quit copy.
6. Explicit “Resume N pending transcriptions” banner (no auto-resume).
7. Contention mitigation: children self-lower to below-normal priority unconditionally.
8. GPU/preload: fail-fast copy when queue non-idle (no 15-minute false hope).
9. Guided-sidecar / `update-meeting-ai` persistence moved into the main job (PR 1 scope item).
10. Quit guards: head-of-queue `quitCommitted`/cancel check; no failure-status write on quit-kill.
11. Cancel recording (companion PR): `cancel` stdin command, tombstoned spool discard, Discard UI with confirm.

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
| Main job | `src/main/transcription-service.js` (`retry-transcription` pattern); composite diarization; **move guided-sidecar / `update-meeting-ai` persistence into the job** (today the renderer persists sidecars after retry returns) |
| Queue + cancel/quit guards | `src/main/ai-compute-queue.js` / transcription service cancel flags; head-of-queue `quitCommitted` check; skip `failed` write on quit-kill |
| Queue state IPC | New channel + `src/preload.js` + renderer Activity UI. `transcription-progress` payload unchanged; attribute via `activeMeetingId` |
| Placeholder / statuses | `backend/meeting_manager.py`, `backend/meetings/normalization.py` — do **not** add `processing`; cancel → `failed` + "Cancelled by user" |
| Quit copy | `src/main.js` / presence close-dialog helpers |
| Priority / smoke | Priority self-lowering inside `faster_whisper_transcriber.py` / MLX / diarization entry points; `tests/manual/recording-smoke-checklist.md` |
| Cancel recording | Both recorders' stdin listeners (exact-token parse), capture manifest `discarded` marker, `audio/capture_recovery.py`, `src/main/recorder-service.js` cancel path, recorder contract tests (JS + Python), Discard UI in `src/renderer/app.js` |
| Characterization | JS tests for queue-state helpers; meeting status normalization tests; recorder event-contract tests for `cancel` |

No recorder stdout JSON contract changes. No second compute scheduler.

## Success metrics (qualitative)

- Start Meeting 2 within seconds of Meeting 1’s **file save**, not after Whisper.
- Two overlapping meetings never cross-wire audio paths or transcripts.
- Quit never claims transcriptions will finish in-process; relaunch can resume pending audio.
- Recording-while-CPU-transcribe smoke does not produce obviously glitched capture.
- Cancel pending works without quitting the app.
- Discarding a recording leaves no meeting, no queue entry, and no resurrected recording after relaunch.
- A user-cancelled job never reappears in the resume banner.

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
