# Parakeet v3 Upgrade Implementation Plan

> **For agentic workers:** Execute inline by default. Delegate only with the user's permission.

**Goal:** Qualify and introduce Parakeet TDT 0.6B v3 where it improves AvaNevis without regressing supported v2 workflows.

**Architecture:** Evaluate v3 against the existing v2 pipeline first. Introduce separately identified, immutable platform artifacts and adapters only for qualified configurations; preserve v2 and existing selections until migration and compatibility are demonstrated. Language exposure follows measured model and product support, not the model card alone.

**Tech Stack:** Electron, plain JavaScript, Python 3.11, Parakeet MLX on Apple Silicon, ONNX Runtime with managed CUDA 12 on Windows and Linux.

## Global Constraints

- Read `docs/development/contracts/local-ai.md`, `docs/development/contracts/ipc.md`, and `docs/development/contracts/packaging.md` before changing their surfaces.
- Explicit setup only; inference stays local and offline, with pinned, verified artifacts and no hidden downloads or telemetry.
- Maintain Windows x64 CUDA, macOS arm64 Metal and Linux x86_64 managed CUDA 12 policy, compute serialization, fail-closed GPU admission and explicit Whisper retry.
- Preserve queued and recovered recording selections, existing transcripts and audio, guided transcription, and actual-device provenance.
- Do not promise every v3 language or automatic language detection until the full product flow has been qualified; preserve current language and summary policies elsewhere.
- Do not claim speed, accuracy, hardware or packaged acceptance from upstream benchmarks or CI.

---

### Task 1: Establish candidates and compare v2 and v3

**Files:**
- Read: `docs/development/PARAKEET_COMPATIBILITY.md`, `docs/superpowers/plans/2026-09-22-parakeet-three-platform-gpu.md`
- Modify: `scripts/benchmarks/parakeet_qualification.py`, `scripts/benchmarks/parakeet_qualification_worker.py` if needed for a fair v3 comparison
- Test: `tests/python/test_parakeet_qualification.py`
- Record: `docs/development/PARAKEET_COMPATIBILITY.md`

**Implementation:** Verify current upstream releases, model licenses and exact MLX/ONNX conversions, runtime APIs, timestamps and CUDA compatibility; record immutable revisions and hashes before using candidates. Compare v2 and v3 on the same consented local English meeting samples, accents, noisy and overlapping speech, long recordings and representative non-English samples. Include manually checked references, WER or CER by language, timestamp/seam errors, real-time factor and peak RAM/VRAM. Record host, revision, repetitions, artifact identity and measurement limits without committing audio or transcripts. State per-platform and per-language ship/hold decisions; keep v2 where quality or resources regress materially or evidence is missing.

**Validation:** `.venv/bin/python -m pytest tests/python/test_parakeet_qualification.py -q`; run the qualification harness on actual target hardware and record its commands and results. A fixture-only run is not a product quality comparison.

### Task 2: Add qualified model identities and runtime adapters

**Files:**
- Modify: `build/parakeet/windows-cuda.lock.json`, `build/parakeet/linux-cuda.lock.json`, `build/parakeet/macos-metal.lock.json`, `src/main/transcription-engine-catalog.js`, `src/main/parakeet-setup.js`, `src/main/parakeet-runtime.js`
- Modify: `backend/transcription/parakeet_onnx.py`, `backend/transcription/parakeet_mlx.py`, `backend/transcription/parakeet_transcriber.py`, `backend/transcription/parakeet_segments.py`
- Test: `tests/js/parakeet-locks.test.js`, `tests/js/parakeet-setup.test.js`, `tests/js/parakeet-runtime.test.js`, `tests/python/test_parakeet_transcriber.py`, `tests/python/test_parakeet_segments.py`, `tests/python/test_parakeet_bootstrap.py`

**Implementation:** For candidates that pass Task 1, add version-specific model/runtime identities and generated complete artifact pins with sizes, hashes and legal attribution. Adapt actual ONNX/MLX APIs and token-to-word timestamps to the version, retaining bounded windows and strict output validation. Make setup, repair, remove, integrity checks and offline compute version-aware; never trust user-writable manifests for artifact identity. Preserve existing installed v2 until an explicit, recoverable migration has succeeded. If v3 requires a runtime unsupported on a platform, leave that platform on v2 and document the block.

**Validation:** `node --test tests/js/parakeet-locks.test.js tests/js/parakeet-setup.test.js tests/js/parakeet-runtime.test.js` and `.venv/bin/python -m pytest tests/python/test_parakeet_transcriber.py tests/python/test_parakeet_segments.py tests/python/test_parakeet_bootstrap.py -q`. Include corrupted/missing artifacts, offline loading, timestamps, version identity and failed migration coverage.

### Task 3: Integrate selection, language policy and recovery

**Files:**
- Modify: `src/main/transcription-engine-resolver.js`, `src/main/transcription-service.js`, `src/main/recorder-service.js`, `src/transcription-policy.js`, `src/renderer/transcription-engine-helpers.js`, `src/renderer/app.js`, `src/renderer/index.html`, `backend/diarization/guided_transcription.py` as required by the chosen version policy
- Test: `tests/js/transcription-engine-resolver.test.js`, `tests/js/transcription-engine-renderer.behavioral.test.js`, `tests/js/recorder-transcription-selection.test.js`, `tests/js/transcription-service-admission.test.js`, `tests/js/transcription-policy.test.js`, `tests/python/test_guided_transcription.py`
- Update contracts: `docs/development/contracts/local-ai.md`, `docs/development/contracts/ipc.md` if behavior or IPC changes

**Implementation:** Make the chosen model version explicit in saved selections, jobs, recovery and output metadata, with deterministic handling of legacy v2 choices. Expose only languages qualified in Task 1; do not equate automatic detection with reliable language provenance. Ensure guided speaker windows, source-relative timestamps, cancellation, queue and timeout behavior remain consistent; unavailable runtimes fail without overwriting prior output or silently switching engine. Update the main/preload/renderer contract and all callers together if IPC changes.

**Validation:** `node --test tests/js/transcription-engine-resolver.test.js tests/js/transcription-engine-renderer.behavioral.test.js tests/js/recorder-transcription-selection.test.js tests/js/transcription-service-admission.test.js tests/js/transcription-policy.test.js` and `.venv/bin/python -m pytest tests/python/test_guided_transcription.py -q`. Cover legacy selections, queued/recovered work, unsupported languages and guided fallback.

### Task 4: Package and qualify the release path

**Files:**
- Review/update: `build/prepare-resources.js`, `legal/`, `docs/development/LOCAL_AI_MODEL_CATALOG.md`, `tests/manual/local-ai-addons-checklist.md`, `docs/development/PARAKEET_COMPATIBILITY.md`
- Test: `tests/js/linux-packaging.test.js`, `tests/js/ipc-contract-snapshot.test.js`

**Implementation:** Verify licenses and installer resources for every changed artifact. On Windows CUDA, Apple Silicon Metal and Linux managed CUDA, exercise packaged setup, activation, restart, offline ordinary and guided transcription, multi-window seams, cancellation/quit, repair/remove, low-memory/runtime-loss failure, retry, recovery and app update survival. Mark each unavailable host or unrun case open, and ship only qualified platform/model combinations.

**Validation:** Run focused packaging tests and `npm run test:all`; build and run the matching installer on each target host. Save sanitized evidence and limitations in the compatibility record. CI is not a substitute for these hardware checks.
