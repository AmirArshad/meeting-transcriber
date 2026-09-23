# Parakeet Adversarial Review Fixes Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Fix the renderer regressions and serialize Parakeet GPU validation and generation promotion so active transcription and canceled setup cannot race installed files.

**Architecture:** Keep downloads, extraction, and checksum verification in operation-specific staging paths. Admit staged GPU probing and promotion through the existing abortable GPU-exclusive compute/resource queue, require matching positive device evidence before promotion, and check cancellation/quit authority immediately before promotion. Canceled bootstrap children receive bounded termination escalation, but setup cleanup and operation ownership wait for their `close` event. Whisper retries close their settings dialog after submission and report completion through nonblocking Activity/log updates.

**Tech Stack:** Electron main process, Node.js async queues and child processes, plain renderer JavaScript, `node:test`.

## Global Constraints

- Preserve the existing GPU compute/resource queue ordering and between-job admission behavior.
- Keep Parakeet install records, staging cleanup, rollback, and installed-generation paths intact.
- Preserve explicit user-triggered setup and the current renderer IPC channel contracts.
- Do not stage, commit, or publish the existing uncommitted feature work.

---

### Task 1: Renderer settings and retry behavior

**Files:**
- Modify: `src/renderer/app.js`
- Test: `tests/js/transcription-engine-renderer.behavioral.test.js`

**Implementation:** Read Whisper preferences from `transcriptionEnginePreferences.whisper` inside settings rendering. Submit Whisper retry IPC once, close the modal as soon as submission succeeds, and let the queued job continue; completion or failure updates logs/history without stealing navigation. Keep Activity as the progress and cancellation surface.

**Validation:** `node --test tests/js/transcription-engine-renderer.behavioral.test.js`

### Task 2: Serialize Parakeet validation and promotion

**Files:**
- Modify: `src/main/parakeet-setup.js`
- Modify: `src/main/transcription-service.js`
- Modify: `src/main.js`
- Test: `tests/js/parakeet-setup.test.js`
- Test: `tests/js/transcription-service-admission.test.js`

**Implementation:** Allow setup staging to proceed independently, then run the staged GPU probe and all generation promotion inside the existing abortable GPU-exclusive compute/resource admission. Queue standalone Parakeet validation through the same admission. Recheck cancellation and quit authority before probe and again immediately before promotion. Require positive evidence for the expected GPU and preserve the previous generation if probing fails. Add a regression that holds a transcription resource slot while repair stages and confirms promotion waits until the slot is released.

**Validation:** `node --test tests/js/parakeet-setup.test.js tests/js/transcription-service-admission.test.js`

### Task 3: Await canceled bootstrap process settlement

**Files:**
- Modify: `src/main/parakeet-runtime.js`
- Test: `tests/js/parakeet-runtime.test.js`

**Implementation:** On abort, send graceful termination, escalate to force termination after a bounded grace period, and reject only after child settlement. Keep setup ownership and staging cleanup pending until the child's `close` event. Replace the synchronous-close-only test double with a delayed-exit child and assert escalation plus awaited settlement.

**Validation:** `node --test tests/js/parakeet-runtime.test.js tests/js/parakeet-setup.test.js`

### Task 4: Focused and repository verification

**Files:** None beyond the task changes above.

**Implementation:** Inspect the final diff and confirm each adversarial finding has a behavioral regression test or a focused assertion.

**Validation:** `npm run test:all`
