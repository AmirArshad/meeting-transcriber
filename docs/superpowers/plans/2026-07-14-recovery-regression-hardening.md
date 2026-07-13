# Recovery Regression Hardening Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Prevent recovery from accepting wrong-duration final audio and cover recovery discovery, timeout, and deferred-prompt races with regressions.

**Architecture:** Keep recovery duration validation in `streaming_post_processor.py`, shared by normal idempotent cleanup and recovery. Extend existing service and renderer tests using their dependency-injected process and helper patterns rather than adding IPC abstractions.

**Tech Stack:** Python 3.11, Node.js built-in test runner, Electron main/renderer JavaScript.

## Global Constraints

- Preserve the durable capture spool and RAM fallback paths; do not remove `AVANEVIS_CAPTURE_SPOOL`.
- Recovery may delete a `.capture` only after a decodable final matches its expected output duration.
- Keep renderer IPC through `window.electronAPI` and recovery prompt claims process-owned in `recorder-service.js`.
- Leave all changes uncommitted.

---

### Task 1: Symmetric Final-Duration Validation

**Files:**
- Modify: `backend/audio/streaming_post_processor.py`
- Test: `tests/python/test_streaming_post_processor.py`
- Test: `tests/python/test_capture_recovery.py`

**Implementation:** Make `final_duration_matches_expectation` reject both materially short and materially overlong finals. Use a bounded absolute slack that cannot exceed the expected duration, so a short capture cannot accept an almost-empty final. Keep normal codec rounding acceptance.

**Validation:** `python3 -m pytest -q tests/python/test_streaming_post_processor.py tests/python/test_capture_recovery.py`

### Task 2: Recovery Process and Prompt Races

**Files:**
- Test: `tests/js/recorder-service.recovery.test.js`
- Test: `tests/js/recovery-ui-helpers.test.js`

**Implementation:** Add injected-process tests for structured discovery failure and timeout where the terminator waits for `close`. Add an extracted/helper-level test where available recovery remains unclaimed while capture is busy, then claims after the idle re-query contract.

**Validation:** `node --test tests/js/recorder-service.recovery.test.js tests/js/recovery-ui-helpers.test.js`

### Task 3: Full Regression Verification

**Files:**
- No source changes

**Implementation:** Run the project JS and Python suites plus recursive Python syntax validation. Confirm the worktree contains only the planned changes and no commit is created.

**Validation:** `npm test && npm run test:python && npm run test:python-syntax`
