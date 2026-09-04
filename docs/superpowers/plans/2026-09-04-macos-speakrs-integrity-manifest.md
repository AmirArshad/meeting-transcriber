# macOS Speakrs Integrity Manifest Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Keep the packaged Speakrs integrity manifest valid for binary executables.

**Architecture:** `build/prepare-resources.js` continues to create the staging manifest before packaging. Its file-hash helper must hash raw bytes rather than coercing executable bytes to UTF-8 text. The runtime keeps its existing fail-closed hash validation, so a correct binary SHA-256 restores normal packaging admission without weakening it.

**Tech Stack:** Node.js filesystem/crypto utilities, Electron Builder 26.x, macOS `codesign`, Node test runner.

## Global Constraints

- Preserve the fail-closed packaged CLI and fixture integrity gate.
- The final app must pass `codesign --verify --deep --strict`.
- Do not weaken runtime validation or skip the CLI hash check.
- Keep Windows and Linux packaging behavior unchanged.

---

### Task 1: Binary-safe packaged manifest hash

**Files:**
- Modify: `build/prepare-resources.js`
- Test: `tests/js/speakrs-packaging.test.js`

**Implementation:** Make `hashFileContent()` use `crypto.createHash('sha256').update(fs.readFileSync(filePath))`, preserving the raw Buffer. Keep `hashString()` for its existing text-only resource-manifest inputs. Add a test fixture containing non-UTF-8 CLI bytes and assert that `writeSpeakrsPackagedIntegrityManifest()` matches Node's raw-buffer SHA-256.

**Validation:** `node --test tests/js/speakrs-packaging.test.js` and a fresh `CSC_FOR_PULL_REQUEST=true npx electron-builder build --mac --dir` followed by `npm run verify:mac:packaged` and `inspectPackagedSpeakrsLayout` against the packaged resources.

### Task 2: Fresh-profile UI and metadata regression check

**Files:**
- No source changes unless the focused check exposes a second defect.

**Implementation:** Launch the rebuilt app with an isolated `--user-data-dir`, confirm an unconfigured Speakrs card keeps Set Up enabled (instead of a false incomplete-install error), then run the planned no-setup recording/transcription check.

**Validation:** Inspect the meeting record for normal MLX transcription metadata and absence of `ai.diarization` / speaker sidecar.
