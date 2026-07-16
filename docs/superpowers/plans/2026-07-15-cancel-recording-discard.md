# Cancel Recording (Discard) Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Let users discard an in-progress recording so capture stops, Stage A is skipped, no meeting is created, and nothing appears in Activity/History.

**Architecture:** Add an exact-token stdin `cancel` command beside `stop` in both platform recorders. Cancel tombstones the capture manifest (`state: discarded`) before best-effort spool deletion, emits `{ success: true, cancelled: true }`, and exits without finalize. Electron’s cancel IPC path resolves to idle without `addMeetingToHistory` / transcription enqueue. Recovery and scan-import treat discarded sessions as cleanup-only.

**Tech Stack:** Python 3.11 recorders + capture manifest/recovery; Electron `recorder-service.js` / preload / renderer; JS + Python characterization tests.

## Global Constraints

- Discard only while `recording` / countdown / `starting`; never during `stopping` (hide Discard once Stop is pressed).
- Always confirm: `Discard this recording? The audio will not be saved.` No “don’t ask again.”
- Quit-during-recording semantics unchanged (no “Discard and quit”).
- Do not reopen PR2 compute-queue admission/cancel/delete work; durable transcription statuses stay `pending|failed|completed` only.
- Update JS + Python recorder contract sides together; never stderr-only exit on cancel.
- Crash before marker → recover as normal interrupted recording (safe default).

---

### Task 1: Manifest discarded state + tombstone-ordered discard

**Files:**
- Modify: `backend/audio/capture_manifest.py` — add `"discarded"` to `VALID_STATES`; add `mark_discarded_and_cleanup(session_dir_or_coordinator)` (or equivalent) that atomically `set_state("discarded")` first, then best-effort `discard_capture_session` / spool + `.pcm.tmp` removal after handles are closed.
- Modify: `backend/audio/capture_recovery.py` — `list_interrupted_captures` / `recover_capture`: discarded = cleanup-only (delete leftover dir; never `finalize_capture` / promote).
- Modify: `backend/meetings/scan_import.py` — when walking/recovering, treat discarded-marked `.capture` as cleanup-only (same as recovery); never import.
- Test: `tests/python/test_capture_manifest.py`, `tests/python/test_capture_recovery.py`, and scan-import coverage if present (`tests/python/test_recorder_temp_and_scan_recovery.py` or meeting scan tests).

**Implementation:** Marker write must succeed before any destructive delete. Partial delete failure still leaves the marker so relaunch cannot resurrect audio.

**Validation:** `npm run test:python` (or targeted pytest on the files above) + `npm run test:python-syntax`

---

### Task 2: Both recorders — exact-token stdin + cancel path

**Files:**
- Modify: `backend/audio/windows_recorder.py` — stdin listener: exact token match (`line.strip().lower()` is `stop` or `cancel`, not substring `"stop" in …`); on `cancel`, stop capture threads, skip `finalize_capture` / Stage A, tombstone-discard spools, emit `{ "success": true, "cancelled": true }` on stdout, exit cleanly.
- Modify: `backend/audio/macos_recorder.py` — same contract (keep platform stop/finalize differences elsewhere).
- Prefer a tiny shared helper (e.g. `backend/audio/recorder_stdin.py` or a function next to existing stdout helpers) for `parse_recorder_stdin_command(line) -> "stop"|"cancel"|None` so both platforms stay aligned.
- Test: `tests/python/test_recorder_event_contract.py` — pin exact-token parsing (e.g. `"stopgap"` / `"cancel"` / `"stop"`), cancel result shape, and that cancel path does not call finalize / stop-stage emitters.

**Implementation:** First stdin command wins inside the recorder process. EOF / Ctrl+C keep existing stop/finalize semantics (not discard). Cancel must never set `finalizing` or run normalize/mix/encode.

**Validation:** `npm run test:python` focused on recorder contract + capture tests

---

### Task 3: Electron stop-result parsing + cancel IPC path

**Files:**
- Modify: `src/main-process/recorder-output-helpers.js` — recognize `{ success: true, cancelled: true }` as a result in `parseRecorderMessageLine` / `findRecorderResultPayload` / `normalizeRecordingStopPayload` / `parseRecordingStopResult` → `{ success: true, cancelled: true }` (no `audioPath`).
- Modify: `src/main/recorder-service.js` — new `cancel-recording` handler (or exported cancel workflow):
  - Mutual exclusion with stop: if `stopCommandSent` / stop promise in flight → reject; if cancel already in flight → reuse; writing `cancel\n` sets cancel-sent and publishes `cancelling` (distinct capture state).
  - Cancel while `starting`: abort startup, terminate child best-effort, clean any spools created; resolve idle; no meeting.
  - On cancelled result: clear runtime → `idle`; **never** `addMeetingToHistory` / transcription enqueue.
  - Quit path untouched (no discard-and-quit).
- Modify: `src/preload.js` — `cancelRecording: (options) => ipcRenderer.invoke('cancel-recording', options)`; pass the known `sessionId` so stale renderer continuations cannot cancel a newer recording.
- Test: `tests/js/recorder-event-contract.test.js`, `tests/js/main-process-helpers.test.js`, plus a focused `recorder-service` deps/recovery-style test for stop-vs-cancel mutual exclusion and “no addMeeting on cancel” if DI seams allow.

**Validation:** `node --test tests/js/recorder-event-contract.test.js tests/js/main-process-helpers.test.js` (and any new recorder-service cancel test)

---

### Task 4: Discard UI (confirm + non-adjacent control)

**Files:**
- Modify: `src/renderer/index.html` — secondary/tertiary Discard control near Stop, spaced so it is not adjacent-clickable with Stop.
- Modify: `src/renderer/styles.css` — layout spacing for Discard vs Stop.
- Modify: `src/renderer/recording-state-helpers.js` — presence/button visibility for `cancelling`; Discard visible only for `recording` / `countdown` (and starting if product allows abort); hidden for `stopping` / `cancelling` / `idle`.
- Modify: `src/renderer/app.js` — confirm dialog with exact copy; call `cancelRecording`; state machine `cancelling` → `idle` → Ready; countdown cancel can reuse Discard or existing countdown abort + IPC cancel when child already spawned; never call `transcribeAudio` / history add.
- Modify: `src/renderer/recovery-ui-helpers.js` — treat `cancelling` as capture-busy like `stopping` where needed.
- Test: `tests/js/recording-state-helpers.test.js` (and recovery helper tests if busy-set changes).

**Validation:** `node --test tests/js/recording-state-helpers.test.js` (+ recovery helper tests if touched)

---

### Task 5: Manual checklist + tracking

**Files:**
- Modify: `tests/manual/recording-smoke-checklist.md` — cancel mid-recording (both platforms); confirm dialog; no History/Activity row; relaunch shows no recovered meeting for discarded session.
- Modify: `todo.md` — check off companion PR items when done.

**Validation:** `npm test`, `npm run test:python`, `npm run test:python-syntax` before claiming done. Manual smoke deferred to human on Windows/macOS.

---

## Spec coverage (self-check)

| Spec item | Task |
|-----------|------|
| Exact-token stdin; `cancel` never finalizes | 2 |
| Skip Stage A; `{success:true,cancelled:true}` | 2–3 |
| Tombstone-first spool discard | 1–2 |
| Recovery/scan-import cleanup-only for discarded | 1 |
| recorder-service cancel → idle, no meeting/enqueue | 3 |
| Stop/cancel mutual exclusion; cancel while starting | 3 |
| Discard UI + confirm; hide during stopping | 4 |
| Contract tests + smoke checklist | 2–5 |
| Quit unchanged; no PR2 queue reopen | Constraints / out of scope |

## Out of scope

- “Discard and quit”
- Compute-queue / pending-transcription cancel UX
- Changing durable meeting transcription statuses beyond existing `pending|failed|completed`
