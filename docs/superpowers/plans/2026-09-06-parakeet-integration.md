# Parakeet Integration Implementation Plan

> **For agentic workers:** Execute inline by default. Ask before routine delegation, as required by AGENTS.md. This document records the feature design and implementation phases; saving it does not authorize implementation.

**Goal:** Offer an optional local Parakeet transcription engine for English meetings, with measured improvements in speed and resource use over the existing Whisper path.

**Architecture:** Preserve renderer → preload → transcription IPC service → tracked Python/native runtime. Carry an explicit engine/model selection through setup, normal and speaker-guided transcription, queue admission, persistence, retry, and resume. Keep Whisper as the default and enable Parakeet only on independently validated platform/device combinations.

**Tech Stack:** Existing Electron 44, plain HTML/CSS/JS, Python 3.11, and local audio preparation. Parakeet runtime, model revision, and dependency pins require qualification before selection.

**Status:** Planned for v2.10; design captured 2026-09-06. No implementation or hardware acceptance completed.

## Global constraints

- Target Windows 10/11 x64, Apple Silicon macOS 14+, and Linux x86_64. Shipping on a validated subset is acceptable; targeting a platform is not a support claim.
- Launch scope is English-only. Faster transcription and lower resource use are the product objectives. Better accuracy is desirable but is not a release condition; usable meeting transcripts remain necessary.
- No cloud processing, telemetry, background uploads, or implicit model downloads.
- Keep Whisper as the default, preserve its caches/preferences, and require an explicit action to switch engines.
- Preserve IPC ownership, pinned facade export sets, the single compute queue, resource-queue admission, cancellation/deletion guards, quit drain, timeout termination/settlement, and actual-device metadata.
- Preserve recording/discard/recovery and atomic meeting persistence. A failed transcription must not lose its recording.
- Linux managed CUDA remains fail-closed; an incompatible or broken managed runtime cannot silently select CPU. Existing Windows Whisper fallback behavior remains unchanged.
- Read the relevant canonical contracts before implementation: `docs/development/contracts/local-ai.md`, `ipc.md`, `meeting-persistence.md`, and `packaging.md` as each surface is touched. Do not broaden the work into unrelated refactoring.

## Product decisions and model scope

The user approved targeting all three platforms with independent validation gates, English-only initial scope, and a speed/resource-use focus. Accuracy improvement is a bonus, not a requirement to beat Whisper.

Parakeet is a model family, not universally English-only. NVIDIA's [TDT 0.6B v2 model card](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) describes English transcription; [TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) supports 25 European languages. Sources checked 2026-09-06. English-only is the AvaNevis launch scope regardless of the eventual artifact. Evaluate v2 first for that scope; do not pin it until runtime and performance qualification passes. This supersedes the initial chat design's tentative v3/automatic-language recommendation.

The [community Parakeet MLX implementation](https://github.com/senstella/parakeet-mlx) is an Apple Silicon candidate, not acceptance evidence. Evaluate packaged Python and native alternatives against the same app contract. Do not assume NeMo, MLX, ONNX, a converted model, or existing CUDA dependencies work on all targets.

## Existing behavior and integration seams

- `src/renderer/app.js`: restores `language`/`modelSize`, checks model installation at startup, finalizes recordings for queued transcription, and submits History retries using Settings.
- `src/preload.js`: forwards model setup and transcription requests to main.
- `src/main/transcription-service.js`: owns model download/preload, normal/guided transcription, retry, pending persistence, cancellation, and resume. Resume deliberately uses each meeting's persisted language/model instead of current Settings.
- `src/main-process/transcription-model-helpers.js`: validates Whisper sizes and checks platform-specific cache completeness.
- `src/main-process/transcription-runtime-helpers.js`: selects faster-whisper or MLX Whisper, builds CLI/environment arguments, and handles guided subprocess output.
- `src/main/python-runtime.js`: tracks subprocesses and isolates packaged Python imports.
- `backend/transcription/base_transcriber.py`: defines `load_model`, `transcribe_file`, and `get_model_info`.
- `backend/diarization/guided_transcription.py`: independently chooses the Whisper backend and transcribes padded speaker windows. It must receive the selected transcription engine too.
- `backend/meeting_manager.py`: persists model/language/status and actual device through guarded metadata writes.

This is one feature with a shared engine contract. Platform adapters can be qualified independently; none bypass the common job lifecycle.

## User-facing behavior

Settings gains **Transcription engine: Whisper / Parakeet**. Parakeet shows its model name, English-only scope, download size, and availability on this computer. **Set up Parakeet** explicitly downloads and validates resources. Setup success permits activation; cancelling setup preserves the previous active selection.

When Parakeet is active, show **Language: English** and explain that other languages require Whisper. Remember Whisper's language/model preferences separately. Do not claim automatic language detection, translation, or reject non-English audio based on an unverified detector.

States: checking availability, unavailable with reason, not installed, downloading, verifying, validating, ready, loading model, and repair required. Passive status must neither download nor load a model. Installed readiness and loading for an admitted job are distinct states.

Settings changes affect future submissions. Queued and resumed jobs retain their saved selection. History retry displays the engine it will use and permits an explicit retry with Whisper. Never silently switch engines after a Parakeet failure.

Missing/corrupt resources or runtime failure retain the recording and produce a recoverable transcription error with repair/retry actions. Parakeet setup failure must not trap application startup in the existing Whisper first-time setup loop or prevent access to recovery/Settings.

## Task 1: Qualify a model/runtime on each platform

**Files:**
- Evidence to create: `docs/development/PARAKEET_COMPATIBILITY.md`.
- Inspect: `src/main/python-runtime.js`, `backend/transcription/base_transcriber.py`, and the platform resource preparation paths reached from `build/prepare-resources.js`.
- Reference: `docs/initiatives/LOCAL_INFERENCE_PERFORMANCE.md` for shared measurement conventions only; warm workers and unrelated tuning are separate work.

**Behavior:** Establish a pinned candidate per platform with verified redistribution terms, offline local-path loading, segment timestamps, actual-device reporting, packaged dependency isolation, and bounded long-audio processing. Inspect real runtime output and artifact bytes, not just fakes or model-card examples. Record exact packaging files and dependency pins in this plan once qualification selects the runtime; do not guess them beforehand.

**Validation:** Compare the candidate with the same platform's Whisper Small baseline on identical English audio and hardware; also report the user's normal Whisper model when different. Measure cold start, total transcription time, repeated-run time, peak process-tree RAM, VRAM where applicable, CPU/GPU utilization, download/install size, and guided-transcription overhead. Include short clips, representative meetings, silence/noise, accents, overlapping speakers, and a 60-minute meeting. No upstream throughput figure counts as desktop evidence.

**Exit condition:** Document whether speed and resource objectives are met per platform/device. Define the resource metric and minimum useful improvement before interpreting results; report tradeoffs explicitly rather than equating model parameter count with memory use. Accuracy must be usable, but need not exceed Whisper. If a target fails qualification, leave it unavailable and record why. Numerical thresholds remain a product decision informed by this evidence, not invented guarantees.

## Task 2: Introduce engine identity and durable job selection

**Files:**
- Create: `src/main/transcription-engine-catalog.js` and `src/main/transcription-engine-resolver.js`.
- Modify: `src/main/transcription-service.js`, `src/preload.js`, `backend/meeting_manager.py`, and `backend/meetings/normalization.py`.
- Inspect/update the add/update CLI bridge in `src/main/meeting-manager-client.js`.
- Test: `tests/js/transcription-service-admission.test.js`, `tests/js/meeting-manager-client.behavioral.test.js`; create focused Python engine-metadata tests under `tests/python/`.

**Behavior:** Use a validated selection with `transcriptionEngine`, `model`, `modelRevision`, and `language`. Legacy requests/meetings without an engine resolve to Whisper and retain their historical model values. Parakeet language is `en`; model IDs and immutable revisions resolve through main-owned catalog entries, never arbitrary renderer URLs or executable paths.

Persist the selection with pending recordings before enqueue. Resume uses persisted selection; explicit retry replaces the requested selection durably without falsely relabelling a previously committed transcript as Parakeet before success. Keep requested job configuration distinct from completed-output provenance where a retry differs. Persist actual runtime/device/compute information on success, including an implementation identifier if platforms use different adapters.

Retain existing IPC channel ownership. Extend request objects compatibly; existing string model-check/download calls remain Whisper requests. Add engine-aware status/setup handling in the transcription service. Keep facade key sets stable through direct imports of new modules. `src/main.js` remains wiring-only.

**Validation:** First add regression cases for a legacy Whisper meeting, a Parakeet pending meeting resumed after Settings changes, retry across engines, failed retry preserving prior provenance, invalid engine/model/revision combinations, and restart during pending persistence. Verify locking/atomic writes and no paths/secrets in metadata.

## Task 3: Add explicit setup, cache validation, and runtime admission

**Files:**
- Create: `src/main/parakeet-setup.js`.
- Modify: `src/main/transcription-service.js` and the new catalog/resolver.
- Integrate with existing download/archive helpers under `src/ai-addon/` and existing resource-queue wiring; do not duplicate archive or download security logic.
- Test: create `tests/js/parakeet-setup.test.js`; extend relevant cache/admission tests.

**Behavior:** Keep resources under `userData/ai-addons/models/transcription/parakeet/` with a separate managed runtime location if needed. Catalog owns hashes, URLs, required files, dependency pins, and device policy. Preserve Whisper and diarization cache isolation. JS and Python completeness checks must agree.

Setup is explicit, staged, cancellable, hash-verified, and promoted only after validation. Never trust a writable install manifest as checksum authority. Resume partial downloads only where safely supported. Failed/cancelled setup cannot promote partial resources. Inference is offline and cannot opportunistically repair/download.

Reuse the resource queue for setup/preload work requiring compute or runtime mutation, admitting between jobs. Keep passive status responsive; destructive removal rejects pending dependent work and reserves mutation authority synchronously. Recheck live device/resources at job execution. Existing Whisper CUDA success does not admit Parakeet automatically. Linux loader isolation and fail-closed managed CUDA policy apply to every Parakeet child.

**Validation:** Corrupt/truncated artifacts, unexpected files, unsafe archives/redirects, missing dependency, offline ready state, cancelled/expired promotion, interrupted restart, removal while queued, and an admitted device differing from backend output must all have explicit outcomes. Test real pinned artifact structure during qualification.

## Task 4: Integrate normal and speaker-guided execution

**Files:**
- Create: `backend/transcription/parakeet_transcriber.py` as the common adapter; native delegation, if selected, stays behind this contract.
- Modify: `src/main/transcription-service.js`, `src/main-process/transcription-runtime-helpers.js`, and `backend/diarization/guided_transcription.py`.
- Inspect engine timeout policy in `src/main-process/compute-timeout-helpers.js`; preserve existing Whisper budgets.
- Test: `tests/js/transcription-service-admission.test.js`, `tests/python/test_guided_transcription.py`; create `tests/python/test_parakeet_transcriber.py`.

**Behavior:** Normalize output to text, timestamped segments, duration, output path, and truthful device/compute metadata. Resample derived input as required without altering recorded audio. Bound memory and chunk overlap; preserve timestamps and avoid duplicate/dropped boundary text. Do not introduce a persistent worker in this feature.

Run Parakeet within the existing compute queue and tracked process lifecycle. Engine-specific measured timeout budgets must reach both outer jobs and inner guided timers. Preserve termination/settlement bounds, late-child registration handling, quit rejection, queue sequence numbers, and cancellation/deletion tombstones.

Guided transcription uses the selected Parakeet adapter for speaker windows and normal fallback. Guided failure falls back to normal Parakeet, preserving existing diarization error metadata/post-pass behavior. Never silently run Whisper. Require speaker-guided validation before enabling that combination; preserve Speakrs/Pyannote platform restrictions.

**Validation:** Start with regression tests for queued cancellation, active termination, late spawn after timeout, quit during probe, delete during metadata work, unknown/mismatched execution device, silence, malformed output, timestamp offsets, long-window boundaries, and same-engine fallback. Exercise actual runtime output in addition to fake subprocess contracts. Full integration must preserve committed transcript/sidecar boundaries and existing summary invalidation by transcript hash.

## Task 5: Expose Settings and recovery flows

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/app.js`, and `src/preload.js`.
- Test: engine-aware renderer/IPC cases in focused tests under `tests/js/`.

**Behavior:** Add engine selection and setup states described above; retain independent Whisper preferences. Surface English-only scope, platform reasons, repair, and explicit switch/retry. Startup uses the selected engine's status and preserves access to recording recovery. Carry the selection through finalize/retry without overriding persisted resume jobs. Activity and History identify the selected engine without exposing implementation details to users.

**Validation:** Existing installation upgrade, first setup, setup cancellation, unsupported host, missing resources at restart, changing Settings while queued, English-only selection, retry with Whisper, and recording recovery while Parakeet is unavailable. Confirm settings cannot mutate an already admitted job.

## Task 6: Packaged acceptance and release scope

**Files:**
- Update: `docs/development/PARAKEET_COMPATIBILITY.md`, this plan, `todo.md`, and `docs/initiatives/ROADMAP.md`.
- Update actual platform packaging/legal manifests identified in Task 1; do not broaden installer targets.

**Validation:** Run focused JS tests with `node --test <test-file>` while iterating, Python tests through `npm run test:python`, and `npm run test:all` before a cross-cutting PR. These are future implementation checks; documentation-only plan saving does not require application tests.

For each enabled platform/device, run packaged fresh install, explicit setup/cancel/repair/remove, offline restart/transcription, normal and guided jobs, concurrent recording, low-memory failure, timeout/cancel/quit, pending resume, and model persistence across app updates. Verify no inference network traffic and no ambient token leakage. Record hardware, OS, artifact hashes, runtime versions, actual device, benchmark results, quality observations, and packaging/legal checks. CI is not hardware acceptance.

Windows CPU/CUDA, macOS Apple Silicon acceleration, and Linux CPU/managed CUDA are separate evidence rows. Unsupported or unvalidated combinations stay unavailable. A present but broken Linux managed CUDA tree remains repair/uninstall territory, never silent CPU fallback.

## Out of scope

Cloud APIs, streaming captions, translation, multilingual launch support, custom model URLs, automatic engine selection/fallback, replacing Whisper, bulk retranscription, new diarization engines, new platform architectures, warm-worker redesign, and unrelated v2.10 Whisper/language/summary changes.

## Remaining decisions

Platform targeting, English-only launch scope, and accuracy-improvement optionality are settled. Qualification must select exact model/runtime artifacts and establish minimum useful speed/resource improvements against the stated baseline. Bring measured tradeoffs back for product input if one objective improves while another regresses; do not silently weaken the feature goal.
