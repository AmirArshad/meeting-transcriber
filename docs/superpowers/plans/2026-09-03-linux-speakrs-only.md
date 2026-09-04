# Linux Speakrs-Only Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Make Speakrs the sole Linux speaker-identification option while retaining Pyannote on Windows and macOS for backwards compatibility.

**Architecture:** The renderer filters the platform's selectable engine cards so Linux presents Speakrs alone. Existing main-process rejection of Linux Pyannote remains a defense-in-depth boundary. Planning, product, and operator documents replace the deferred Linux-Pyannote gate with a permanent out-of-scope decision.

**Tech Stack:** Plain JavaScript renderer helpers, Node.js tests, Markdown documentation.

## Global Constraints

- Windows and Apple Silicon macOS retain the existing exclusive Speakrs/Pyannote selector and Pyannote token safeguards.
- Linux exposes Speakrs only after its existing CUDA/x64 preflight; it has no Pyannote token, catalog entry, setup path, or CPU fallback.
- Preserve `LINUX_PYANNOTE_UNAVAILABLE_REASON` and Linux setup rejection for untrusted/stale IPC.
- Do not alter managed CUDA, Speakrs integrity, recording, or summary behavior.

---

### Task 1: Filter Linux speaker-engine cards

**Files:**
- Modify: `src/renderer/ai-addon-ui-helpers.js`
- Test: `tests/js/ai-addon-ui-helpers.test.js`

**Implementation:** Make `buildDiarizationEngineCards({ platform: 'linux' })` return only the Speakrs card. Keep both cards in the existing order for Windows and macOS. The renderer's existing card application logic then hides neither template card by itself, so extend it to hide cards whose engine has no returned entry, preventing a disabled Pyannote card from remaining visible on Linux.

**Validation:** `node --test tests/js/ai-addon-ui-helpers.test.js`

### Task 2: Record permanent Linux Pyannote scope exclusion

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-v2.9-linux-ai-addons-design.md`
- Modify: `docs/superpowers/plans/2026-09-01-v2.9-linux-ai-addons.md`
- Modify: `todo.md`
- Modify: `docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md`
- Modify: `docs/development/LOCAL_AI_MODEL_CATALOG.md`
- Modify: `docs/initiatives/LINUX_SUPPORT.md`
- Modify: `tests/manual/local-ai-addons-checklist.md`

**Implementation:** Remove the Task 6 investigation and conditional Task 7 implementation from the Linux-AI plan, renumber the summary/integration work, and state that Linux speaker identification is Speakrs-only by product choice. Retain Pyannote documentation for Windows/macOS. Update manual acceptance language to require no visible Pyannote selector or token UI on Linux.

**Validation:** `git diff --check && rg -n -i "Task 6: Investigate Pyannote|Task 7: Add Pyannote|Speakrs/Pyannote CUDA-only" docs/superpowers/{specs,plans} docs/development docs/initiatives tests/manual todo.md`

### Task 3: Validate the scoped change

**Files:**
- Test: `tests/js/ai-addon-ui-helpers.test.js`
- Test: `tests/js/linux-platform-selection.test.js`
- Test: `tests/js/speakrs-task2-hardening.test.js`

**Implementation:** Run the focused renderer/platform/defense-in-depth tests and a JS syntax check. Confirm that the working tree contains only the intended renderer, tests, plan, and documentation changes.

**Validation:** `node --test tests/js/ai-addon-ui-helpers.test.js tests/js/linux-platform-selection.test.js tests/js/speakrs-task2-hardening.test.js && npm run test:syntax && git diff --check`

## Self-review

- **Spec coverage:** Task 1 enforces Linux Speakrs-only UI while preserving the backend guard; Task 2 aligns every requested planning and product document; Task 3 checks the changed platform boundary.
- **Placeholder scan:** No deferred Linux Pyannote work or unspecified implementation remains.
- **Type consistency:** The plan uses the existing `buildDiarizationEngineCards` helper and `LINUX_PYANNOTE_UNAVAILABLE_REASON` export without changing their public contracts.
