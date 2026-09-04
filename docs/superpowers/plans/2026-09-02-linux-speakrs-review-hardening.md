# Linux Speakrs Review Hardening Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Close the adversarial-review integrity, cancellation, fail-closed admission, worker responsiveness, and Linux CUDA-closure gaps for Speakrs.

**Architecture:** Compute admission will treat Speakrs model files and managed runtime files identically: a changed file fingerprint triggers a catalog-pin SHA-256 check before any CLI can launch. Live Linux CUDA probes will run within the corresponding abortable/wall-clock compute ownership boundary and register their child process, while passive UI checks keep using the cached value. Tar selected-file flattening moves wholly into its extraction worker, so the Electron main process only awaits a cancellable worker result.

**Tech Stack:** Electron main-process JavaScript, Node.js worker threads, Node.js built-in test runner, pinned local AI artifact catalog.

## Global Constraints

- Linux Speakrs is CUDA-only; do not add CPU or Vulkan fallback.
- Compute admission must derive integrity pins from the immutable catalog, never `install.json`.
- Linux ambient `LD_LIBRARY_PATH` remains cleared and rebuilt only from admitted managed and driver directories.
- `libcuda.so.1` and `libz.so.1` are existence-only closure dependencies, not managed content pins.
- Child processes must remain in POSIX process groups and cancellation/quit must release the compute slot.
- Tar flattening occurs only when `includeFileNames` is supplied and must preserve duplicate/missing/unsafe-name rejection.

---

### Task 1: Rehash Speakrs model packs at compute admission

**Files:**
- Modify: `src/ai-addon/manifest-store.js`
- Test: `tests/js/speakrs-task2-hardening.test.js`

**Implementation:** Pass `verifyChecksum: verifyChecksums || computeAdmissionEngine === 'speakrs'` and `verifyChecksumIfChanged: computeAdmissionEngine === 'speakrs'` to `checkSpeakrsModelCache`, matching the existing runtime-cache policy. Preserve explicit full setup validation and existing cache fingerprint behavior.

**Validation:** `node --test tests/js/speakrs-task2-hardening.test.js`

### Task 2: Make Linux CUDA admission live, cancellable, and wall-clock owned

**Files:**
- Modify: `src/main/ai-addon-ipc.js`
- Modify: `src/main/transcription-service.js`
- Test: `tests/js/speakrs-task2-hardening.test.js`
- Test: `tests/js/quit-lifecycle.behavioral.test.js`

**Implementation:** Introduce one internal admission-probe boundary per owner that receives `registerProcess` and the owning cancellation state. Setup passes its `AbortSignal`; guided/post-pass and normal transcription pass the `runWallClockComputeAction` registrar while within its queue slot. The Linux resolver throws a fail-closed availability error when the live resolver is missing; no compute path reads `getCachedCudaStatus`. Re-check cancellation/quit after awaited probe completion before continuing to validation or CLI spawn.

**Validation:** `node --test tests/js/speakrs-task2-hardening.test.js tests/js/quit-lifecycle.behavioral.test.js`

### Task 3: Keep tar extraction and selected-file flattening off the main thread

**Files:**
- Modify: `src/ai-addon/archive-install.js`
- Modify: `src/ai-addon-tar-extractor-worker.js`
- Test: `tests/js/speakrs-task2-hardening.test.js`

**Implementation:** Include `includeFileNames` in tar worker data and implement the current safe recursive selection, copy, and cleanup there, with cancellation checks between filesystem phases. Remove the post-worker synchronous flatten call from `extractRuntimeArchive`; keep the synchronous helper only for non-worker archive objects and existing direct unit coverage.

**Validation:** `node --test tests/js/speakrs-task2-hardening.test.js`

### Task 4: Exercise the complete Linux dynamic-library closure

**Files:**
- Modify: `tests/js/speakrs-task2-hardening.test.js`
- Test: `tests/js/speakrs-task2-hardening.test.js`

**Implementation:** Extend `createPinnedLinuxTestCatalog` with the Task 4 source-kind closure: small SHA-pinned managed ORT/CUDA files plus existence-only `libcuda.so.1` and `libz.so.1`. Assert compute admission rehashes changed managed files and rejects mismatch, while driver/system entries are checked for presence without hashing. Cover cancellation and quit for a registered Linux probe process group, including compute-queue release.

**Validation:** `node --test tests/js/speakrs-task2-hardening.test.js tests/js/quit-lifecycle.behavioral.test.js`

### Task 5: Repository verification and delivery

**Files:**
- Verify: `src/ai-addon/manifest-store.js`
- Verify: `src/main/ai-addon-ipc.js`
- Verify: `src/main/transcription-service.js`
- Verify: `src/ai-addon/archive-install.js`
- Verify: `src/ai-addon-tar-extractor-worker.js`
- Verify: `tests/js/speakrs-task2-hardening.test.js`
- Verify: `tests/js/quit-lifecycle.behavioral.test.js`

**Implementation:** Run the targeted suites, source-format checks, and the relevant broader test command from `package.json`. Inspect the final diff for catalog pin sourcing, Linux fail-closed behavior, and no main-thread tar flattening. Commit all reviewed Cursor-session changes plus these fixes on the current feature branch and push its upstream.

**Validation:** `node --test tests/js/speakrs-task2-hardening.test.js tests/js/quit-lifecycle.behavioral.test.js && git diff --check && npm test -- --runInBand`
