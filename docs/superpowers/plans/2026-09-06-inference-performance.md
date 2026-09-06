# Inference Performance Implementation Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries.

**Goal:** Reduce local recording-finalization and inference waits through measured, independently qualified changes, without sacrificing saved audio or transcript/summary quality.

**Architecture:** Retain Electron → preload → owning main service → tracked Python/native subprocesses. Establish reproducible baselines first; qualify encoding, Whisper decoding, and summary context independently. Persistent workers require their own lifecycle design before implementation.

**Tech Stack:** Existing plain HTML/CSS/JS, Electron, Python 3.11, ffmpeg/libopus, faster-whisper, lightning-whisper-mlx, and catalog-pinned llama.cpp.

**Status:** Proposed v2.10 design, 2026-09-06. Documentation only; no implementation, benchmarks, dependency qualification, or hardware acceptance completed.

## Global Constraints

- Local-only processing; no telemetry, uploads, background downloads, or new network listeners.
- Preserve existing IPC ownership, payloads, facade exports, queues, cancellation, timeouts, quit drain, and persistence contracts.
- Windows x64, Apple Silicon macOS, Linux x86_64; qualify each actual runtime/device combination independently.
- Keep durable spools, bounded post-stop mixing, 48 kHz mono-compatible stereo, 128k VBR Opus, integrity/decode verification, and recoverable WAV fallback.
- No new model/runtime/catalog pins, default decoding changes, or persistent process lifetime changes without qualification.

## 1. Current behavior

The committed scope is `todo.md:44–46`. `docs/initiatives/LOCAL_INFERENCE_PERFORMANCE.md` is an existing exploration note, not an implementation plan. This plan refines it; its old v3.0 Linux deferral is obsolete. Only the directly relevant recording and local-AI contracts were read. Investigation exceeded 15 files because the inherited feature spans three independent pipelines; additional reads were focused excerpts, tests, and call-site searches.

| Flow | Existing implementation |
|---|---|
| Stop → saved file → ready for another recording | `src/renderer/app.js:3711` calls `src/preload.js:75` → `src/main/recorder-service.js:2379`. Platform recorders call `backend/audio/streaming_post_processor.py:1109`; its encode path at line 1381 uses `backend/audio/compressor.py`. `src/renderer/app.js:4078` then persists/enqueues via `finalizeRecordingTranscription`; Start unlocks after pending persistence. |
| New/retried transcription → Activity/History | `src/renderer/app.js:4094` and `:4183` → `src/preload.js:84–85` → `src/main/transcription-service.js`. Its per-job spawn at line 381 uses `src/main/python-runtime.js:198`. Ordinary backends are `backend/transcription/faster_whisper_transcriber.py` and `backend/transcription/mlx_whisper_transcriber.py`; guided admission and fallback remain owned by the main service. |
| User requests summary | `src/renderer/app.js:4025` → `src/preload.js:91` → `src/main/summary-service.js:163`, queue at line 388, Python spawn at line 460 → `backend/summaries/summary_runner.py:149` → `backend/summaries/llama_runtime.py:263`. |

Current constants: Opus effort 10 (`backend/audio/constants.py:54`); faster-whisper beam 5 with VAD (`backend/transcription/faster_whisper_transcriber.py:426`); MLX batch 1 because larger batches can omit earlier windows (`backend/transcription/mlx_whisper_transcriber.py:317`). Whisper is loaded in a fresh Python process per job. llama context defaults to 32,768 tokens; llama-cli is invoked per prompt, including chunks, repairs, and merge—not merely once per meeting. A repeated filesystem-cache-warm run is therefore not a resident-model worker.

## 2. User-facing change

Users keep the existing recording, Activity, retry, model selection, and Generate Summary flows. Qualified optimizations reduce their waits without adding a performance mode or requiring migration. Benchmarking is a developer qualification tool, not an automatic user workload.

Use existing task terminology: saving/encoding, queued, transcribing or identifying speakers, generating summary, completed, failed, and cancelled where currently supported. Do not expose “inference,” beam size, context allocation, or a speculative time remaining in product controls. No new progress state or active-transcription Cancel control is implied.

Windows retains faster-whisper CPU/CUDA behavior. Apple Silicon retains MLX transcription and current Metal/CoreML/MPS feature policies. Linux retains CPU transcription by default and explicitly installed managed CUDA; an existing broken managed runtime remains fail-closed with Repair/Uninstall recovery. Linux speaker identification remains Speakrs-only; summaries remain component-gated. No optimization enables an unavailable feature.

## 3. Proposed behavior

Split into independent slices sharing one measurement protocol:

1. **A — Baseline and encoding:** measure real finalization, then compare effort 5 and 6 against 10 through the existing compressor override. Promote a constant change only after all release-target encoding gates pass. This can ship independently of inference tuning.
2. **B — Whisper qualification:** compare beam 1/2/5 on identical audio/model/language and measure model load separately from decoding. Include guided runs in the end-to-end baseline, preserving speaker behavior. Keep MLX batch 1 in production; higher-batch experiments require explicit long-meeting completeness evidence. This slice yields an accept/reject decision; a user-visible speed/accuracy mode needs a subsequent focused design.
3. **C — Summary context:** qualify smaller context allocation per complete prompt while retaining the existing per-prompt CLI lifetime. Count prompt/template overhead plus output allowance and safety headroom, capped at the current 32,768. Apply to chunk, repair, and merge prompts. Do not change chunking or truncate inputs to make a smaller allocation fit. If the pinned runtime has no validated tokenizer/counting mechanism, retain 32k; a character estimate alone is not qualification.
4. **D — Resident workers:** separate architectural design after load-time evidence establishes value. Not an implementation task in this plan. A future design must resolve eviction before other GPU jobs/resource mutation, model/device/cache invalidation, per-job isolation, late responses, child-tree termination, idle memory, and quit drain. A localhost server is not assumed available or acceptable.

Prefer A and independently qualified C over a blanket Fast preset (conflates model and quality decisions) or workers first (changes lifetime/resource ownership before measuring benefit).

Loading remains within current task states; queued time is measured separately from execution. Uninstalled/unsupported engines remain unavailable. Cancellation, timeout, quit, and recovery follow existing behavior: pending transcription cancellation remains distinct from active work; summary cancellation remains effective before metadata finalization; metadata commit is protected. No automatic quality downgrade/retry is added. Missing timing data is “unavailable,” never zero; failed/cancelled trials are recorded separately and excluded from successful speed averages. Diagnostic failure cannot fail a real meeting.

## 4. Technical impact and implementation sequence

**Renderer/UI and preload/IPC:** no production changes required for A–C. Existing string transcription progress and sequenced queue snapshots remain unchanged. Measure UI Stop→ready manually alongside backend timings. No diagnostic IPC or facade export additions.

**Main services/queues:** no new queue, concurrency, automatic preload, or process residency. Continue per-job device admission, FIFO resource admission for preload/runtime mutation, bounded timeout settlement and tracked-process cleanup. `src/main.js` remains composition-only.

**Backend/runtime:** benchmark harnesses call existing APIs in fresh processes, with measurement wrappers around load/decode/encode calls. Fully consume faster-whisper's lazy segments before ending decode timing. For llama, report total prompt time; split load/prompt/generation only when the exact pinned binary exposes validated timing output, otherwise mark components unavailable. Never infer native load time by subtraction. No runtime or tokenizer dependency is presumed installed.

**Persistence:** no meeting schema, sidecar schema, saved preference, or cache migration. Benchmark reports are explicit local outputs in a chosen scratch directory, outside recordings. Store fixture IDs/hashes, versions, actual device, settings, durations, outcome and resource measurements—not meeting titles, transcript/prompt text, user paths, or tokens. No background collection or upload.

### Task 1: Reproducible qualification harness

**Create:** `scripts/benchmarks/inference_performance.py`, `tests/python/test_inference_performance_benchmark.py`, and `docs/development/V2_10_INFERENCE_PERFORMANCE.md`.

**Reference:** the production files listed above; do not add benchmark controls to renderer/IPC. Use fixture copies and isolated output directories. Allow only explicit fixture/model/runtime inputs and fail clearly for unavailable prerequisites; never install them automatically. Define report version 1, milliseconds, actual runtime/device, cold-process versus repeated-process runs, and unavailable component/resource fields. Stub clocks/processes only for report behavior; actual performance requires real binaries.

Measure 5/20/60-minute fixtures with ordinary speech, silence, overlap, desktop audio, and retained-language coverage. Run at least three fresh-process trials per configuration, alternating baseline/candidate order; report individual runs, median, range, peak RSS/VRAM where measurable, output size, and failures. Do not call three samples a reliable p95. Separate queue wait, admission, spawn/import/load, decode, persistence, and end-to-end time when observable. Keep “filesystem cache warm” distinct from “model resident.” Record power mode, hardware, OS, app revision, model/runtime hashes, and fixture identity.

**Validation:** `python -m pytest tests/python/test_inference_performance_benchmark.py -q`; prove missing measurements, failure/cancel exclusion, unit consistency, lazy-segment timing, and redaction. Capture real baselines before selecting changes.

### Task 2: Encode qualification and conditional promotion

**Possible modify:** `backend/audio/constants.py` only for the accepted effort value. **Tests:** `tests/python/test_compressor.py`, `tests/python/test_streaming_post_processor.py`; extend Task 1's harness for effort comparisons through the existing compressor parameter.

Preserve the finalizer's intermediate WAV, verification passes, capture cleanup ordering, and fallback path. Measure encoder effort separately from full Stop→ready, since verification/mixing may dominate. No recorder protocol changes.

**Validation:** `python -m pytest tests/python/test_compressor.py tests/python/test_streaming_post_processor.py -q`, plus actual packaged ffmpeg decode/playback, duration/channel checks, WER comparison, output size, and recoverable-failure trials. Retain effort 10 if no candidate passes.

### Task 3: Whisper qualification; no default flip

**Modify:** benchmark harness only; exercise the installed faster-whisper API with beam 1/2/5 after checking its real signature/version. **Reference/tests:** `backend/transcription/faster_whisper_transcriber.py`, `backend/transcription/mlx_whisper_transcriber.py`, `tests/python/test_transcriber_helpers.py`.

Measure unmodified production behavior first. Candidate API runs must preserve all other production decoding/VAD/output processing choices and demonstrate parity at beam 5 before comparisons count. Keep current guided and standard paths separate in reports. Higher MLX batches are laboratory-only and not a prerequisite for v2.10. Do not silently use a different model or Parakeet to claim a Whisper improvement.

**Validation:** `python -m pytest tests/python/test_transcriber_helpers.py -q`, reference transcripts/WER, names/numbers, timestamps and beginning/middle/end completeness, CPU/CUDA admission and actual-device results. Record whether a candidate merits a separate product-mode design or is rejected.

### Task 4: Summary context qualification and conditional promotion

**Possible modify:** `backend/summaries/llama_runtime.py` for bounded per-call context selection; `backend/summaries/summary_runner.py` to select using each final prompt and its output budget. Preserve the base runtime's context used by existing chunk budgeting. **Tests:** `tests/python/test_summary_llama_runtime.py`, `tests/python/test_summary_runner.py`, `tests/python/test_summary_pipeline.py`.

First verify tokenizer/template accounting and supported CLI flags on each catalog-pinned binary. No new flags/dependencies or runtime bump are assumed. Evaluate candidate 4k/8k/16k/32k allocations, rounding up from the validated complete budget. If accounting is unavailable, use existing 32k; if even 32k is insufficient, preserve the existing bounded failure path, without truncation or increasing the cap. Recalculate for repair/merge prompts rather than reusing the first chunk's allocation. Ship only where measured compatibility supports the policy; otherwise retain baseline behavior.

**Validation:** `python -m pytest tests/python/test_summary_llama_runtime.py tests/python/test_summary_runner.py tests/python/test_summary_pipeline.py -q`. Test exact bucket boundaries, overhead/output reservation, cap, missing counter, repair/merge sizing and immutable base context. Validate real CLI flags and faithful, complete summaries on short/long multilingual fixtures; include cancellation and prior-summary preservation.

### Task 5: Release decision and regression evidence

**Update:** `docs/development/V2_10_INFERENCE_PERFORMANCE.md`, this plan's status, the v2.10 plan index, and `todo.md`. Record accepted and rejected candidates per platform; do not mark the feature implemented because the design exists.

Run focused tests above, `node --test tests/js/compute-queue-membership.test.js tests/js/ai-compute-queue.behavioral.test.js tests/js/summary-service.behavioral.test.js`, then `npm run test:all` for the eventual cross-cutting change. Existing queue scans complement behavioral tests; neither proves hardware performance.

## 5. Risks and constraints

- Lower Opus effort can change encoded bytes/quality; beam reductions can lose words; MLX batching has a known completeness hazard. Speed alone never qualifies them.
- Smaller summary context can overflow on non-English text, templates, repairs, or merges. Tokenizer parity with each pinned runtime is a technical investigation, not a presumed capability.
- Repeated llama invocations may dominate more than context allocation; disclose negligible benefit rather than introducing a server opportunistically.
- OS cache, power mode, GPU contention, and thermal throttling can produce misleading wins. Record raw runs, actual device, failures, and concurrent-recording behavior.
- No dependency/catalog/package payload changes are planned. Test with packaged ffmpeg/Python/llama because developer tools are not evidence for shipped bytes. Any future runtime/binary change requires a separate packaging-contract review.
- Existing v2.10 model/language and Parakeet work can change baselines. Pin revisions/configurations and rerun affected comparisons after those changes; do not duplicate those designs here.
- Resident models could block runtime uninstall, starve another engine, or retain meeting state. Slice D is deliberately not executable under A–C's lifecycle assumptions.

## 6. Validation outline and release acceptance

Focused automated coverage is specified per task. Additionally exercise missing/incomplete caches offline, failed managed CUDA admission, normal retry, guided fallback, queued cancellation, summary cancellation before/at metadata finalization, quit during inference, and recording while inference runs. Existing saved meetings must reopen with no migration.

Manual matrix: packaged Windows CPU and admitted CUDA 12; Apple Silicon MLX and supported summary runtime; Linux CPU plus managed CUDA on supported Omarchy/CachyOS targets. Linux summary/Speakrs checks run only when their own admission gates pass. CPU-only Linux must retain unavailable add-on states. No experimental distro or Intel Mac support claim follows from this work.

**Proposed release gate:** at least 10% median improvement in the targeted stage, report absolute end-to-end improvement, no end-to-end/resource regression beyond observed baseline variation, and no new failure or lost-content cases. Encoding must fully decode, preserve duration/channels and pass listening checks; transcription quality must show no material WER/name/number degradation; summary claims/actions must remain faithful and complete. Small sample ambiguity or a quality disagreement means retain the baseline. Confirm the quality tradeoff policy in section 8 before considering a faster decoding preset.

Required evidence: dated app/runtime/model/fixture identities, raw baseline/candidate timings, actual-device and memory results, audio integrity/listening records, transcript/reference comparisons, summary faithfulness review, cancellation/quit/recovery outcomes, and the final per-platform shipping decision. No speed or hardware acceptance claims until these exist.

## 7. Explicitly out of scope

Electron/Python rewrites, real-time mixing, skipping recovery WAV or integrity checks, cloud processing, telemetry, automatic benchmarks/downloads, new model catalog entries, Parakeet implementation, language/model-list cleanup, summary-model replacement, automatic engine switching, skipping speaker identification by meeting length, multiple concurrent GPU jobs, public benchmark UI, persistent workers/llama-server implementation, and new cancellation semantics.

## 8. Open decisions

1. Should faster decoding be offered later if it measurably loses some accuracy? Recommendation: retain current decoding for v2.10 unless product explicitly accepts a quality envelope; design the setting separately if accepted.
2. Is keeping a model resident and consuming RAM/VRAM while idle acceptable in a later worker slice? Recommendation: make that decision only after load-time/resource evidence, then specify memory/idle policy in that slice's design.

These do not block baseline collection, encoding qualification, or conservative summary-context qualification. Tokenizer support, measured speed, and pinned-binary behavior are engineering investigations rather than product questions.
