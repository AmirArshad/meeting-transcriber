# Speakrs Upgrade Implementation Plan

> **For agentic workers:** Execute inline by default. Delegate only with the user's permission.

**Goal:** Qualify and adopt a newer Speakrs release where it preserves or improves the existing speaker-identification experience on supported platforms.

**Architecture:** Compare the current pinned 0.5.0 CLI with the 0.7.0 candidate before changing production. Treat macOS CoreML, Linux CUDA and Windows CUDA as separate compatibility decisions, retaining the current path wherever the new backend cannot meet the product contract.

**Tech Stack:** Rust Speakrs CLI, Electron and Python 3.11; CoreML on Apple Silicon and managed CUDA 12 on Windows/Linux.

## Global Constraints

- Read `docs/development/contracts/local-ai.md`, `docs/development/contracts/ipc.md`, `docs/development/contracts/packaging.md`, and `docs/development/LOCAL_AI_MODEL_CATALOG.md` before implementation.
- Preserve token-free Speakrs, exclusive engine selection, saved pyannote tokens, local-only inference, explicit setup and no hidden model downloads.
- macOS remains CoreML-only; Linux remains Speakrs-only and CUDA-only; Windows remains CUDA. No CPU or cloud fallback.
- Keep the frozen CLI JSON stdout contract, validated artifacts, queue/timeouts, guided transcription and recovery semantics.
- Do not infer Windows support, accuracy or speed from Linux/macOS upstream claims; no release or hardware acceptance is implied by this plan.

---

### Task 1: Establish 0.7 compatibility and baseline

**Files:**
- Read: `native/speakrs-cli/Cargo.toml`, `native/speakrs-cli/src/main.rs`, `src/ai-addon/speakrs-pack-spec.js`, `docs/development/SPEAKRS_BENCHMARKS.md`
- Record: `docs/development/SPEAKRS_BENCHMARKS.md`

**Implementation:** Recheck the latest upstream release and inspect the exact version's supported OS/backends, public API, model requirements, features, licenses, runtime loading and offline behavior. Build a disposable candidate per platform without modifying production pins. Determine specifically whether native CUDA supports Windows, whether Linux's managed CUDA admission and driver requirements remain valid, and which macOS model files change. Compare 0.5 and candidate on identical local, consented recordings with reference speaker labels, including overlap, short turns and long meetings; record diarization error, startup/total time, peak RAM/VRAM, hardware, revisions and limits. Decide per platform whether to upgrade or keep 0.5; do not commit private audio or transcripts.

**Validation:** Run the current and candidate CLIs offline on each available target host and record reproducible commands, artifact identities and results. Use the two-speaker fixture for contract smoke only, not as the accuracy benchmark.

### Task 2: Update CLI and preserve version-specific platforms

**Files:**
- Modify: `native/speakrs-cli/Cargo.toml`, `native/speakrs-cli/Cargo.lock`, `native/speakrs-cli/src/main.rs`, `native/speakrs-cli/ort-compile-pins.json` as required by the qualified backend
- Modify: `backend/diarization/speakrs_runner.py`, `src/ai-addon/speakrs-cli-integrity.js`, `build/prepare-resources.js` if binary or packaging identities change
- Test: `tests/python/test_speakrs_cli_contract.py`, `tests/python/test_speakrs_runner.py`, `tests/js/speakrs-cli-integrity.test.js`, `tests/js/speakrs-packaging.test.js`, `tests/js/speakrs-cargo-security.test.js`

**Implementation:** Implement only the platform paths approved by Task 1. Adapt Rust APIs and features while preserving stdout success/failure keys, error handling and execution mode admission. If Windows cannot run the new backend, retain an independently pinned and reproducibly built 0.5 Windows path; do not sacrifice Windows support for a global version bump. Keep dependency and native binary checks fail-closed and rebuild rather than hand-edit generated resources.

**Validation:** `cargo test --manifest-path native/speakrs-cli/Cargo.toml` on applicable hosts; `.venv/bin/python -m pytest tests/python/test_speakrs_cli_contract.py tests/python/test_speakrs_runner.py -q`; `node --test tests/js/speakrs-cli-integrity.test.js tests/js/speakrs-packaging.test.js tests/js/speakrs-cargo-security.test.js`. Verify actual backend/device reporting and stable JSON fixtures.

### Task 3: Pin artifacts and migrate setup safely

**Files:**
- Modify: `src/ai-addon/speakrs-pack-spec.js`, `src/ai-addon/speakrs-model-files.json`, `src/ai-addon-state.js`, `scripts/build-speakrs-model-pack.js`, `scripts/derive-speakrs-runtime-dll-pins.js` as needed
- Test: `tests/js/speakrs-model-pack.test.js`, `tests/js/speakrs-task2-hardening.test.js`, `tests/js/ai-addon-setup.test.js`, `tests/js/ai-addon-state.test.js`, `tests/js/ai-addon-privacy-hardening.test.js`
- Update: `docs/development/LOCAL_AI_MODEL_CATALOG.md` and applicable local-AI/packaging contracts

**Implementation:** Derive model file lists, exact hashes, sizes, licenses and runtime closure from the chosen upstream version; build packs reproducibly using the existing pack process. Bind installation identity and integrity validation to platform and version, keep archive traversal and offline protections, and preserve an installed working version until explicit setup or repair completes successfully. Preserve ORT and CUDA pins wherever the old path still needs them; remove a closure only for a platform whose replacement has passed admission and packaging checks. Publishing model artifacts is a separate authorized release action.

**Validation:** `node --test tests/js/speakrs-model-pack.test.js tests/js/speakrs-task2-hardening.test.js tests/js/ai-addon-setup.test.js tests/js/ai-addon-state.test.js tests/js/ai-addon-privacy-hardening.test.js`; exercise hash mismatch, missing files, failed migration, offline setup status, cancellation and token preservation.

### Task 4: Qualify packaged behavior and record decisions

**Files:**
- Review/update: `tests/manual/local-ai-addons-checklist.md`, `docs/development/SPEAKRS_BENCHMARKS.md`, `docs/development/LOCAL_AI_MODEL_CATALOG.md`
- Test: `tests/python/test_guided_transcription.py`, `tests/js/speakrs-packaging.test.js`

**Implementation:** For each changed platform, test a packaged installer on real hardware: explicit setup, validation, restart, offline diarization, guided transcription, overlapping/short turns, cancel/quit, runtime loss, repair/remove, update survival and switching to/from pyannote where supported. Verify actual GPU backend and retained token behavior. Record unchanged platforms and unrun checks explicitly; release only combinations with passed gates.

**Validation:** `.venv/bin/python -m pytest tests/python/test_guided_transcription.py -q`, `node --test tests/js/speakrs-packaging.test.js`, and `npm run test:all`; run matching packaged builds and manual hardware checks. Record commands, sanitized results and outstanding gates without claiming CI proves hardware success.
