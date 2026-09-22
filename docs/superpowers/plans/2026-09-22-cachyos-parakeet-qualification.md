# CachyOS Parakeet Qualification Implementation Plan

> **For agentic workers:** Execute inline. No delegation unless the user requests it. This is the active next step for Parakeet; the integration plan's Tasks 2–6 remain gated.

**Goal:** Decide whether the existing Parakeet ONNX CUDA 12 candidate merits further qualification on CachyOS, using representative meeting audio and a reproducible comparison with Whisper Small.

**Architecture:** A developer-only harness runs one fresh offline subprocess per engine/trial, with separate pinned runtimes and a common measurement/reporting contract. Keep experimental code under `scripts/benchmarks/`; do not integrate an engine into the application. Separate host-driver readiness, managed Whisper readiness, candidate readiness, and product benefit in the report.

**Tech Stack:** CachyOS x86_64, Ryzen 5 7600 / RTX 4070 host, Python 3.11, existing faster-whisper 1.2.1 / CTranslate2 4.8.1 baseline, onnx-asr 0.12.0 / ONNX Runtime GPU 1.23.2 candidate.

**Execution status (2026-09-22):** The first representative attempt was **Inconclusive** because host GPU contention blocked fair inference. After that workload exited, the uncontended five-trial batch against Whisper Small classified Parakeet as **defer this candidate** (27.8% slower, higher RSS and VRAM, 1.29 percentage points lower WER). A second batch against the user's normal Whisper Medium, using the same harness and a pinned Medium cache, classified it as a **tradeoff** (28.9% faster, WER within 0.10 percentage points, lower RSS, higher VRAM). Sanitized evidence is in [PARAKEET_COMPATIBILITY.md](../../development/PARAKEET_COMPATIBILITY.md). Production integration remains unimplemented. The authorized next step is a technical design for an optional English engine on qualified CachyOS managed CUDA 12 only.

## Global constraints

- Current work is CachyOS only. Windows, macOS, Omarchy acceptance, and further CPU benchmarking are deferred. Keep historical CPU evidence; never use CPU fallback to rescue a failed CUDA trial.
- Read `docs/development/contracts/local-ai.md`, `docs/development/PARAKEET_COMPATIBILITY.md`, and the integration plan's Task 1 before execution.
- Keep Whisper as the default. No production backend, IPC, renderer, installer, runtime catalog, requirements, lockfile, driver, or system CUDA changes.
- No cloud processing, uploads, telemetry, private-recording discovery, or implicit inference downloads. Use explicit local fixture paths; keep audio, reference text, transcripts, raw output, environments, and reports outside git.
- Reuse hash-verified existing artifacts. Any missing-artifact setup must be an explicit separate step, with immutable identity, hashes, provenance, size, and licenses recorded before inference. Do not silently refresh pins or install into the app's managed tree or repo `.venv`.
- The existing candidate uses the community fp32 ONNX conversion, not NVIDIA's `.nemo` inference path. Preserve that distinction and report Whisper's float16 compute; this is a comparison of deployable configurations, not precision-matched architectures.
- All inference is offline; token environment variables are cleared using the project's privacy conventions. Reports use allowlisted aggregate fields and never serialize raw subprocess errors, paths, transcripts, or environment dumps.

## Starting evidence and boundaries

September 21 established CPU and CUDA execution on a 14.2245 s synthetic clip. Repeat CUDA medians were 1.012 s Parakeet and 0.981 s Whisper; the first recorded CUDA run favored Parakeet (1.180 s vs 1.509 s). Three tiny trials establish no meaningful GPU winner. CPU was slower and used substantially more RAM. Memory methods differed and isolated VRAM, reference-based quality, and long-form behavior were absent.

On September 22, `nvidia-smi` saw the RTX 4070 / driver 615.71.09, catalog integrity passed, and the project Python CUDA probe with managed library paths and CTranslate2 validation returned `ready`. `/usr/lib64` was rejected as a symlink; the probe succeeded without extra driver directories. This is a point-in-time probe, not candidate inference or packaged acceptance, and does not explain the earlier driver failure.

Keep candidate cuDNN 9.26.0.51 separate from Whisper's pinned 9.22.0.52. Their different pins mean a shared tree is unqualified; version difference alone does not prove ABI incompatibility. No shared-tree experiment is needed for this task.

### Task 1: Establish a repeatable environment and fixture preflight

**Files:** Create `scripts/benchmarks/parakeet_qualification.py`; create `scripts/benchmarks/parakeet_qualification_worker.py`; update `docs/development/PARAKEET_COMPATIBILITY.md`.

**Implementation:** Inspect the existing inference harness for subprocess/report patterns without broadening it. Add explicit CLI inputs for fixture/reference files, baseline/candidate Python executables, model/cache directories, candidate library directories, output directory, trial count, and timeout. The harness never installs or downloads. Validate paths and hashes before launching workers. Document exact runnable setup and benchmark commands with placeholders only for private absolute paths.

Reuse the recorded ONNX model revision `0bbb45a3365852604aef28b538a8f066f4ccaa85` and full CUDA 12 wheel closure from the compatibility record. Pin and hash the additional VAD artifact/dependencies required by onnx-asr's long-form path; inspect the installed 0.12.0 API rather than assuming current upstream examples match. Keep that change explicit. Do not search for more ASR runtimes, change precision, or install NeMo in this pass.

Run host `nvidia-smi`, managed library integrity, and the existing CUDA probe before benchmarks. Use the production Whisper environment construction as the reference. The candidate gets its own isolated loader path and must independently prove CUDA provider execution and loaded CUDA 12 libraries. Provider availability alone is insufficient; capture provider/session or profiling evidence plus loaded-library provenance without exporting private paths. Stop that row on failure and identify the failing layer; no package reinstall loop or bypassed gate.

Use the existing short synthetic fixture for plumbing, plus one fixed 5–15 minute representative English meeting with a known reference transcript for the actual screening decision. Prefer an explicitly supplied local fixture/reference path. If the execution prompt authorizes public fixture downloads, select one openly licensed meeting recording with a human reference transcript, record its source/license/hashes and any fixed excerpt offsets, and download it in a visible setup step outside the repo. Do not use another ASR output as ground truth. If neither route is available, ask early for a local fixture/reference path and continue harness work while waiting. Do not read arbitrary saved meetings. A repeated short clip can test chunk mechanics but cannot qualify meeting benefit. If no approved representative fixture becomes available, finish the harness and report the evidence gap without inventing a result.

**Validation:** `--help` and preflight must work without importing candidate packages into the parent. Missing files, changed hashes, unsupported host, failed CUDA probe, and absent references produce concise categorized failures before measured runs. Record OS/kernel, GPU/driver, app revision, artifact hashes, runtime versions, and fixture duration/provenance; omit machine-local paths.

### Task 2: Measure the complete meeting path fairly

**Files:** Implement the two harness files; create `tests/python/test_parakeet_qualification.py`.

**Implementation:** Run serially with no app compute job or competing benchmark. Use the same immutable mono 16 kHz derived audio for both engines. Preserve production Whisper Small English decoding/VAD settings and materialize its lazy segment iterator. Candidate timing includes preprocessing, VAD, all chunks, decoding, timestamp offset reconstruction, and output assembly. Do not substitute decode-only timing for total wall time.

Use a fresh process per run. Record first-run timing separately; do not claim OS cache eviction or a truly cold disk. Then run five measured trials per engine, alternating engine order to reduce order bias. Report every value, median, range, end-to-end RTF, and separate load/decode diagnostics where measurable. Load the model once per trial, not once per VAD segment; no persistent cross-job workers.

Measure both engines' peak process-tree RSS with the same sampling interval and method. Sample per-process GPU memory for the worker and descendants; report unavailable when not observable, rather than substituting desktop-wide `memory.used`. Include sampling limitations, observed GPU utilization, OOMs, and candidate runtime/model/VAD disk footprint.

Score both outputs against the same reference with a documented identical word-normalization rule and WER. Keep raw text local. Report counts of empty output, missing/duplicated chunk-boundary words, invalid or out-of-order timestamps, and omitted opening/closing content. Token start times are not segment end times: explicitly document the experimental interval construction and check its bounds against audio duration. Do not claim speaker-guided acceptance.

Give each child a configurable finite timeout (default 15 minutes for these screening fixtures), run it in its own process group, and terminate/reap that group on timeout or interruption. Record the failed trial; never count partial output as success. Keep a private bounded log for diagnosis if needed; public reports carry only categorized errors.

**Validation:** `.venv/bin/python -m pytest tests/python/test_parakeet_qualification.py -q`. Exercise real short-lived subprocesses for timeout/descendant cleanup; test report privacy, missing telemetry, malformed output, reference normalization, and chunk timestamp offsets with focused fixtures. Use real candidate bytes for hardware evidence; test doubles do not establish runtime compatibility. Run `npm run test:python-syntax` after adding scripts.

### Task 3: Publish a bounded screening decision

**Files:** Update `docs/development/PARAKEET_COMPATIBILITY.md`, this plan, `docs/superpowers/plans/2026-09-06-v2.10.md`, and `todo.md`.

**Implementation:** Before measured trials, record these provisional engineering screening rules in the report; they prioritize follow-up work and do not redefine release requirements:

- **Promising:** at least 20% lower median complete-meeting wall time, no higher measured peak RSS/VRAM beyond reported sampling uncertainty, no truncation/boundary failure, and WER no more than 1 absolute percentage point worse than the baseline. Missing reference or required resource measurements prevents this classification. At least one resource metric must improve before claiming both product objectives are met.
- **Tradeoff:** meaningful speed gain but higher memory or worse quality. Present the measured tradeoff for product review; do not approve integration.
- **Defer this candidate:** no meaningful speed gain on the representative fixture, repeated runtime failure, or unusable/incomplete output. Do not broaden into a runtime sweep.
- **Inconclusive:** overlapping timing ranges that do not support a stable gain, missing representative/reference audio, missing required telemetry, or host contention. List the missing evidence and identify the next smallest action. At most one additional five-trial batch is allowed when timing noise is the only uncertainty; otherwise stop with evidence.

These thresholds are conservative triage choices, not statistical significance claims or shipping guarantees. Even a promising result only authorizes planning the remaining qualification: 60-minute meeting, silence/noise, accents, real overlap, guided execution, lifecycle failure cases, and packaged CachyOS acceptance. Do not execute integration Tasks 2–6 or that entire acceptance matrix in this screening task.

**Validation:** Review the final diff and ensure public evidence contains no transcripts, raw logs, home paths, or unverified support claims. Run focused harness tests and syntax checks; run `npm run test:all` before any PR or if scope unexpectedly touches cross-cutting production behavior (which should instead be avoided). Report passed checks separately from hardware findings. Keep platform/device rows distinct and retain historical measurements.

## Completion and handoff

The uncontended Small and Medium batches are recorded. Do not proceed into production Parakeet integration from this screening task. The next step is a technical design for an optional English engine on the qualified CachyOS CUDA row; Windows, macOS, Linux CPU, guided execution, and packaged acceptance remain unqualified.
