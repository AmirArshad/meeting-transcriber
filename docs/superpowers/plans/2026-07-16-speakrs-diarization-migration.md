# Speakrs Diarization Migration Plan (v2 — reviewed & hardened)

> **Revision history:** v1 drafted 2026-07-16. v2 (2026-07-18) is a production-viability review + execution-ready rewrite: external claims verified (crate, models, licenses, ORT), repo contracts inventoried, vague gates replaced with measurable criteria, and tasks re-sequenced characterization-first.
>
> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries. Do not cut over production until Task 0 spike criteria pass and the license-compliance checklist (Task 2b) is merged.

**Verdict: CONDITIONAL GO (viability 3.5/5).** speakrs meets every product goal (zero tokens, OSS, offline, faster, Electron-shippable) and its deal-breakers are all engineering/process, not capability. Conditions: (1) license-compliance diligence on redistributing the model pack — the upstream `avencera/speakrs-models` repo has **no license file** even though every constituent model is MIT or CC-BY-4.0; we repack with our own LICENSES/attribution (self-serve checklist in Task 2b — this is the same posture as sherpa-onnx, Vibe, and OpenWhispr, which all redistribute these exact model families with attribution and no gate); (2) the Windows ONNX Runtime CUDA DLL closure must be proven against our existing CUDA 12 profile in the spike; (3) the crate is <4 months old with a single maintainer — we vendor-pin and keep pyannote behind a flag until soak completes.

**Goal:** Replace gated `pyannote/speaker-diarization-community-1` (HF token + ~4 GB Windows / ~2 GB macOS PyTorch dependency install) with `speakrs` for faster local diarization, zero end-user accounts/tokens, and a several-hundred-MB model pack — while keeping AvaNevis' speaker-segment JSON / guided-transcription contracts byte-compatible.

**Architecture:** Python stays the orchestration layer (16 kHz mono prep, guided windows, merge, sidecars, progress JSON). speakrs runs as a **bundled native CLI** (`speakrs-cli`, built in CI from a vendored crate — Swift-helper pattern), with **model packs and the Windows ORT GPU runtime downloaded at setup time** (llama.cpp-runtime pattern, sha256-pinned, host-allowlisted).

---

## Verified Research Snapshot (2026-07-18)

Everything below was re-verified against crates.io, docs.rs, the speakrs GitHub repo/examples/source, and the HF model repos. Corrections vs v1 are marked ⚠.

| Item | Finding |
|------|---------|
| Crate | `speakrs` 0.5.0 (2026-07-07), Apache-2.0, MSRV 1.88. ⚠ Crate first published **2026-03-25**; single maintainer (avencera / Praveen Perera); ~2.5 k total downloads. Young. |
| CLI | **None upstream** — library + examples only. We own `speakrs-cli`. |
| API (verified on docs.rs + examples) | `OwnedDiarizationPipeline::{from_pretrained, from_dir(Path, ExecutionMode), run(&[f32]) -> DiarizationResult}`; `result.discrete_diarization.clone()` → `make_exclusive()` → `to_segments()` → `Segment { start: f32, end: f32, speaker: String }`; `rttm(file_id)`. `make_exclusive()` confirmed in `examples/assign_transcript_speakers.rs`. |
| Speaker-count hint | `PipelineConfig` exposes speaker-count bounds + clustering thresholds (`VbxConfig`/`AhcConfig`/`BinarizeConfig`). Spike confirms mapping from our `--speaker-count`. |
| Modes | `cpu`, `coreml`, `coreml-fast`, `cuda`, `cuda-fast`, `migraphx`. `*-fast` = 2 s segmentation windows (coarser speaker-change boundaries). |
| ORT | `ort 2.0.0-rc.12` wrapping **ONNX Runtime 1.24** (a stable Microsoft release). Upstream describes the rc as production-ready but API-unstable; speakrs pins it, so API churn is isolated from us. ⚠ Milder risk than v1 implied. |
| ORT CUDA EP requirements | CUDA ≥ 12.8, cuDNN 9. DLL closure: `onnxruntime.dll`, `onnxruntime_providers_shared.dll`, `onnxruntime_providers_cuda.dll` (~250–300 MB), plus `cudart64_12.dll`, `cufft64_11.dll`, `cublas64_12.dll`/`cublasLt64_12.dll`, `cudnn64_9.dll`. Our cuda12 profile (`src/main-process/cuda-runtime-helpers.js:5-13`) already provides cublas/cudnn via pip; ⚠ **cudart/cufft/ORT itself are NOT provided today** — they ship in the new speakrs Windows runtime archive (Task 2). |
| Models | ⚠ `avencera/speakrs-models` (pin `5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f`) is **not** a straight community-1 conversion. Actual contents (from `src/models.rs` constants): `segmentation-3.0.onnx` (+ b32/b64 batched variants, ~6 MB each), `wespeaker-voxceleb-resnet34.onnx` (+ `.data`, b64, split fbank/multimask variants), PLDA/VBx `.npy` params "extracted from the community-1 pipeline cache", and CoreML `.mlmodelc` bundles (CoreML mode needs ONNX **plus** mlmodelc). Whole repo ≈ 870 MB; per-mode subsets are smaller (exact lists recorded in Task 0). |
| Model licenses | `pyannote/segmentation-3.0` = **MIT**. `wespeaker-voxceleb-resnet34-LM` = **CC-BY-4.0** (VoxCeleb dataset is CC-BY-4.0). community-1 pipeline (source of PLDA/VBx params) = **CC-BY-4.0**. The HF gate on pyannote repos is an access/marketing mechanism, **not a license term** — CC-BY-4.0/MIT permit redistribution with attribution. ⚠ `avencera/speakrs-models` itself ships **no LICENSE file** and defers to "upstream terms" → we repack with our own LICENSES manifest per the Task 2b self-serve compliance checklist. |
| Claimed perf (VoxConverse dev, collar 0) | coreml 7.1 % DER @ 529× (M4 Pro) vs pyannote MPS 7.2 % @ 24×; cuda 7.0 % @ 59×, cuda-fast 7.4 % @ 121× vs pyannote CUDA 7.2 % @ 32×. |
| Memory | `run(&[f32])` takes the whole mono-16k file in RAM (90 min ≈ 346 MB f32) — comparable to our current in-memory torch waveform path (`audio_prep.load_prepared_audio_for_pipeline`). Spike measures peak RSS. |
| Input | Mono 16 kHz f32 — exactly what `prepare_diarization_audio` already produces (s16le WAV; CLI decodes s16→f32). |

### Locked decisions (do not relitigate during execution)

1. **CLI, not PyO3.** Matches Swift-helper/llama-cli packaging, crash-isolates Rust panics, avoids maturin/ABI coupling to bundled Python. Spawn overhead is irrelevant at minutes-long job scale. PyO3 stays a non-goal.
2. **Default modes: `coreml` (macOS) and `cuda` (Windows) — NOT the `-fast` variants.** Guided transcription consumes turn boundaries to cut padded Whisper windows; `-fast`'s 2 s segmentation windows coarsen exactly those boundaries, and its DER is worse (7.4 vs 7.0/7.1). Precise modes are already 2×+ faster than pyannote. `-fast` may become an opt-in later; never the default.
3. **CLI is bundled in the installer (built in CI, both platforms); model packs + Windows ORT runtime archive are setup-time downloads.** Keeps the installer lean and the GPU stack out of non-diarization users' disk. Windows CLI builds with `cuda` + `load-dynamic` (small exe, ORT dylib resolved at runtime); macOS CLI builds with `coreml` (ort CPU statically linked). If the macOS binary exceeds 80 MB in Task 0, switch macOS to `load-dynamic` too and move the ort dylib into the model pack.
4. **Merge/labeling stays in Python.** `speaker_segments.py` (dominant-overlap merge, `Speaker N` relabeling, `Unknown`, 12 s coarse split) is pure Python with no torch dependency and is fully unit-tested. The CLI emits only raw turns.
5. **Accelerator-only policy is unchanged in this migration.** `cpu` mode exists in the CLI for CI smoke tests only; product setup still requires CUDA (win32) / Apple Silicon (darwin-arm64). Relaxing that is a separate product decision the CLI makes cheap later.
6. **Dual-engine soak via catalog constant.** `DIARIZATION_ENGINE` default `'speakrs'` in `src/ai-addon-state.js`, dev/QA override via `AVANEVIS_DIARIZATION_ENGINE` env. pyannote code paths are retained untouched until Task 8. Rollback = flip the constant in a patch release.

### Execution guardrails (binding on the implementing agent)

1. **Single implementation branch: `feature/speakrs-diarization`, one task at a time, in plan order.** Each task lands as its own commit (or small commit series) prefixed `speakrs task N:`, with that task's validation commands green **before** the next task starts — the branch must be revertible task-by-task and reviewable per-task via commit diffs. Tasks 1–6 merge together after Task 6 validation; Task 7 (soak) runs on merged builds; Task 8 (deletions) is a separate later PR after soak and is never done on this branch.
2. **Characterization first (Task 1 pre-step, before ANY app code changes):** add golden tests pinning today's behavior so the engine swap is diff-checked, not eyeballed —
   - a Python golden test asserting the exact `*.speakers.json` top-level schema + `segments`/`speakerSegments` field sets from `build_diarization_result` (extend `tests/python/test_diarization_pipeline.py`);
   - a Python test snapshotting the ordered `emit_progress` phase strings for a mocked full run;
   - a JS test pinning that `diarize-transcript` / `transcribe-audio-with-speakers` payload handling is engine-agnostic.
   These must stay green through Tasks 3–7 **unchanged**.
3. **Additive until Task 8.** Until then: no IPC channel renames/removals, no status-value removals, no `preload.js` API removals, no deletion of pyannote code/catalog/tests, no edits to `AI_ADDON_STATUS_STATES`. If a pinned snapshot test (ipc-contract, privacy-hardening trusted-sender list, status array) fails before Task 8, the change is wrong — fix the change, not the snapshot.
4. **Out of scope entirely, every task:** recorder services, capture/spool code, quit-drain/compute-queue internals (`ai-compute-queue.js`, `runWallClockComputeAction` — *use* them, never modify), meeting_manager persistence, summary feature code, updater/build download-manifest entries not listed in Task 6.
5. **After every task:** `npm test && npm run test:python` (plus `npm run prepare-build` for Task 6). A task is not done with red tests, skipped tests, or "TODO: fix later".
6. **Stop and ask the maintainer** instead of improvising when: a pinned sha256/revision doesn't match, a contract in this plan conflicts with current code, `cargo`/toolchain isn't available, or a change seems to require touching anything in guardrail 4.

---

## Threats to v1 assumptions — review outcomes

| v1 assumption | Review outcome |
|---|---|
| "Models inherit CC-BY-4.0; cite pyannote/WeSpeaker" | Partially right, understated. Pack is mixed-provenance (MIT + CC-BY-4.0 + params extracted from a CC-BY-4.0 pipeline) and the upstream pack repo has **no license file**. Redistribution is permitted under the constituent licenses provided we attribute correctly; we ship our own LICENSES manifest inside a repacked archive (Task 2b self-serve checklist, modeled on how sherpa-onnx/Vibe/OpenWhispr already redistribute these exact model families). |
| "No token survives legal reality" | **Yes.** The HF gate is access control + marketing-consent, not a license term; `avencera/speakrs-models` is public and ungated; CC-BY-4.0/MIT permit redistribution. Zero-token is real. |
| "ort 2.0 RC = instability risk" | Downgraded. rc.12 wraps stable ONNX Runtime 1.24 and is used in production; speakrs pins it. Residual risk is ONNX Runtime 1.24 behavior on user GPUs — covered by setup validation smoke + CPU-fallback-free error surfacing. |
| "Reuse existing GPU readiness probes" | Partially. cublas/cudnn come from the existing cuda12 pip profile (already gated by `check-cuda` and the renderer's `shouldShowSpeakerSetupPrompt`), but ORT needs CUDA ≥ 12.8 semantics plus cudart/cufft/ORT DLLs we don't ship. These go in the pinned speakrs runtime archive; **do not** mutate the shared transcription pip profile for diarization. Spike proves the closure with the Dependencies tool on a clean Windows box. |
| "CoreML vs current MPS copy/UX" | Strict improvement: no 2 GB torch download, no MPS probe. All user-facing "Metal/MPS" copy and the `LOCAL_AI_MODEL_CATALOG.md` MPS-only rules change at cutover. `.mlmodelc` bundles are precompiled (no first-run CoreML compile stall); macOS 13+ target is fine. |
| "Young crate" | Confirmed and worse than v1 implied: first release 2026-03-25, bus factor 1. Mitigations: exact-version pin + `cargo vendor` the dependency tree into our build (or a fork under our org), our own thin CLI as the only API surface, pyannote behind the engine flag until soak, and the model pack self-hosted so upstream deletion cannot brick setup. |
| "speakrs metrics module for DER" | Not found on docs.rs — benchmark DER with `pyannote.metrics` offline instead (Task 0 harness). |

## Repo-grounded gaps v1 under-specified (all addressed in tasks below)

1. **Pinned contract tests that WILL break** and must be updated deliberately, not discovered: `tests/js/ipc-contract-snapshot.test.js` (full IPC channel snapshot incl. every diarization/token channel + `ai-addon-progress`), `tests/js/ai-addon-privacy-hardening.test.js` (trusted-sender list pins the 10 mutating channel names; source-scan asserts on `HF_TOKEN_PATH`), `tests/js/ai-addon-state.test.js:319` (pins the 7-value status array), `formatters.test.js` / `ai-addon-ui-helpers.test.js` / `history-detail-helpers.test.js` (`needsAccount` label/terminal/prompt copy).
2. **`needsAccount` producers/consumers enumerated:** produced only in `src/ai-addon/diarization-setup.js` (L439, L451, L590-597, L629-636); consumed in `src/renderer/ai-addon-ui-helpers.js:13`, `formatters.js:66`, `app.js:4319/4499`, `history-detail-helpers.js:156-158/283`. Removal is Task 8 (post-soak), not Task 4.
3. **Manifest has no migration mechanism today** (`manifestVersion: 1` unconditionally rewritten; legacy top-level fallback exists in `normalizeAiAddonManifest`). v2 defines a concrete `engine` field + legacy-pyannote detection instead of hand-waving "manifest migration".
4. **`deriveDiarizationStatus` (`manifest-store.js:718-730`) downgrades `ready`→`error` from the pip `dependencyCache`** — a speakrs install has no pip dependency cache; status derivation must switch to model-pack + CLI presence checks per engine.
5. **Progress contract specifics:** guided/diarization progress is parsed from **stderr** via `parseAiBackendProgressLine` (accepts only `{type:'progress'}`, sanitizes phase ≤ 80 chars, redacts message ≤ 300); valid diarization events go to `diarization-progress`, everything else to `transcription-progress`; setup progress goes to `ai-addon-progress`. The speakrs runner must reuse `emit_progress` with the **same phase strings** so zero renderer changes are needed for progress.
6. **Pre-existing bug to fix during the port:** `backend/diarization/guided_transcription.py:492` prints the exception **unredacted** (`diarization_pipeline.py:472` redacts). Fix in Task 4 with a test.
7. **Grandchild termination:** today pyannote runs inside the Python child, so `runWallClockComputeAction`'s kill works. With speakrs the Rust CLI is a **grandchild**; the Python runner must guarantee the CLI dies when Python is terminated (POSIX: process group / `preexec_fn`; Windows: Job-object semantics via `subprocess` kill in a `finally` + signal handler). Explicit test in Task 4.
8. **`AVANEVIS_PACKAGED=1` PATH-skip rule** (Swift helper: `swift_audio_capture.py:82-84`; tar: `resolvePreferredTarExecutable`) must apply to `speakrs-cli` resolution, with a test mirroring `tests/js/ai-addon-archive-helpers.test.js:40-51`.
9. **Legal Notices mechanics:** attribution lives in root `THIRD_PARTY_NOTICES.md`, staged via `stageLegalBundle` (`build/prepare-resources.js`) to `Resources/legal/`, opened by `open-legal-notices` (`src/main/file-export-ipc.js:129-155`). Plus `npm run legal:sbom` / `legal:release-assets` scripts. Concrete edits listed in Task 2b.
10. **Host allowlist:** derived automatically from catalog `downloadUrl`/`url`/`indexUrl`/`extraIndexUrls` keys plus `DOWNLOAD_REDIRECT_HOSTS` (`src/ai-addon/download-helpers.js:39-102`). Self-hosting packs on GitHub Releases is already covered (`objects.githubusercontent.com` etc.); adding pins to the catalog auto-allowlists the host. `licenseUrl` never expands the allowlist.
11. **Timeout budgets:** unchanged — `AI_COMPUTE_TIMEOUT_MS.diarization` 30 min and `addonValidation` 15 min are generous for an engine 2–20× faster; guided budget stays Whisper-model-driven (`getGuidedTranscriptionComputeTimeoutMs`). Only the model-pack **download** needs a budget: reuse `DOWNLOAD_TIMEOUT_MS` (5 min inactivity) per file like summary artifacts.
12. **Windows setup gating stays behind CUDA readiness** (`shouldShowSpeakerSetupPrompt` requires `hasNvidiaGpu && cudaInstalled`) because speakrs reuses cublas/cudnn from the existing GPU runtime install.

---

## Target architecture

```
Renderer (unchanged channels: setup-diarization / validate / remove / get-ai-addon-status,
          transcribe-audio-with-speakers, diarize-transcript, diarization-progress)
        ↓
src/main/ai-addon-ipc.js  +  src/main/transcription-service.js
        │   engine = DIARIZATION_ENGINE (catalog; env override for QA)
        │   spawn env: SPEAKRS_CLI_PATH, SPEAKRS_MODELS_DIR, SPEAKRS_MODE, (win) SPEAKRS_ORT_DIR
        ↓
Python: diarization_pipeline.py / guided_transcription.py   (CLI args: + --engine speakrs)
        ↓ prepare_diarization_audio → 16 kHz mono WAV        (unchanged)
        ↓ speakrs_runner.run_speakrs_diarization()
        ↓   spawn Resources/bin/speakrs-cli <wav>            (grandchild; killed with parent)
        ↓   stdout: single JSON {success, device, annotationSource, segments[{start,end,speaker}]}
        ↓   stderr: diagnostics only (never parsed for control flow)
        ↓ emit_progress(...) — SAME phases/JSON on Python stderr as today
        ↓ merge_speaker_labels / guided windows / Whisper    (unchanged)
        ↓ build_diarization_result → *.speakers.json         (unchanged schema)
```

Sidecar schema, `diarization-progress` payloads, guided fallback policy (guided failure → `runNormalTranscriptionWithCudaFallback` + `persistDiarizationFailureArtifacts`), and compute-queue serialization are **explicit non-changes**.

### Device naming

| Platform | `--require-device` (JS→Python, unchanged) | `SPEAKRS_MODE` | sidecar `diarization.device` |
|---|---|---|---|
| Windows | `cuda` | `cuda` | `cuda` |
| macOS arm64 | `mps` → interpreted as "Apple accelerator" | `coreml` | `coreml` |

`transcriptionDevice`/`transcriptionComputeType` (Whisper runtime) are untouched. Renderer copy that says "Metal/MPS" changes to "Apple Silicon (CoreML)" in Task 5. `meeting_manager` does not normalize `diarization.device` (only the transcription `metal`→`mps` alias), so `coreml` is safe to persist; add a characterization test proving it.

### Status machine

During soak (engine flag live, pyannote retained):

```
unsupported  (platform policy — unchanged gates)
notConfigured ── setup-diarization ──> downloading ──> validating ──> ready
      ^                                    │               │
      └──────────── remove ────────────────┴──── error ◄───┘
needsAccount  (LEGACY: reachable only when engine=pyannote; hidden for speakrs)
```

- `downloading` = model pack (+ Windows ORT runtime archive) download + extract, progress on `ai-addon-progress` with `downloadedBytes/totalBytes`.
- `validating` = one smoke diarization of the bundled fixture WAV in the required mode, invoked through the **same path as production runs**: `python -m diarization.diarization_pipeline --validate-setup --engine speakrs` (no `--token-stdin`), wrapped in `createAbortableComputeAction` + `AI_COMPUTE_TIMEOUT_MS.addonValidation` exactly like today's pyannote validation. Do **not** have JS spawn `speakrs-cli` directly — validating through Python proves the whole Python↔CLI integration and keeps a single spawn path.
- `ready` derivation replaces the pip `dependencyCache` check with: CLI binary present + model pack manifest-complete (per-file existence/size always; full sha256 at setup/validate, fingerprint-skip on later status polls — mirror the summary checksum policy).

After Task 8 (pyannote removal): `AI_ADDON_STATUS_STATES` becomes `['notConfigured','downloading','validating','ready','error','unsupported']` and every pinned consumer/test updates in the same commit.

### Manifest migration (existing pyannote users)

Manifest shape gains one field; `manifestVersion` stays `1` (additive, old builds ignore it):

```json
"features": { "diarization": { "engine": "speakrs", "status": "...", "modelId": "speakrs-community1-vbx", ... } }
```

- `normalizeDiarizationState`: missing `engine` + legacy `modelId === 'pyannote/speaker-diarization-community-1'` → normalized as `engine: 'pyannote'`.
- When active engine is speakrs and manifest engine is pyannote: status presents as `notConfigured` with migration copy ("Speaker identification has a new engine — set it up again. No Hugging Face account needed."); the History/Home prompt reuses `shouldShowSpeakerSetupPrompt` gates.
- **Never auto-delete** the old install. Legacy cleanup is explicit: extend `remove-diarization-setup` to also remove `dependencies/diarization/*` (pip tree), the old HF hub cache under `models/diarization/hub`, and the stored token file (`ai-addons/tokens/diarization-huggingface-token.bin`) — with dialog copy stating the token will be deleted and ~2–4 GB freed. Transcription-only users are never touched.

---

## Model pack strategy

**Distribution: repacked, self-hosted archives (one per platform), sha256-pinned — not per-file HF downloads.** Reasons: CoreML `.mlmodelc` are directory bundles (per-file HF fetch is fragile), upstream repo has no LICENSE file (we inject a `LICENSES/` directory + `ATTRIBUTION.md`), and self-hosting removes the upstream-deletion risk for a bus-factor-1 project.

- Repack script: `scripts/build-speakrs-model-pack.js` (or `.py`) — pulls `avencera/speakrs-models` at the pinned revision, selects the per-mode file set (from Task 0's recorded list), injects `LICENSES/` (MIT segmentation-3.0, CC-BY-4.0 wespeaker + community-1 params, Apache-2.0 speakrs) and `ATTRIBUTION.md`, produces `speakrs-models-<rev7>-win32-x64-cuda.tar.gz` and `speakrs-models-<rev7>-darwin-arm64-coreml.tar.gz`, prints sha256s for the catalog.
- Hosting: our GitHub Releases (same trust surface as llama.cpp archives; hosts already allowlisted). Windows pack also carries `ort/` (onnxruntime.dll + providers + cudart64_12 + cufft64_11) — or as a separate pinned archive if > 1 GB combined; Task 0 decides on measured sizes.
- Cache layout: `userData/ai-addons/models/diarization/speakrs/<revision>/` (extract root), validated like summary runtime caches; extraction through the existing zip/tar workers + `ai-addon-archive-helpers.js` traversal guards (verify guards accept `.mlmodelc` nested directories).
- Size expectations (verify in Task 0): Windows ONNX pack ~120–250 MB + ORT/CUDA DLLs ~300–400 MB; macOS pack (ONNX + mlmodelc subset) ~300–500 MB. Anything > 600 MB per platform escalates the bundle-vs-download decision before Task 2 proceeds. Either way this replaces a 4 GB (win) / 2 GB (mac) pip install — strictly better.

---

## Implementation Phases

### Task 0: Spike (go/no-go gate — measurable)

**Files:**
- Create: `native/speakrs-cli/` (Cargo project; may start as a copy of `examples/diarize_wav.rs` + `assign_transcript_speakers.rs` glue)
- Create: `docs/development/SPEAKRS_SPIKE_NOTES.md` (results tables only)

**Steps:**
1. Build the CLI on one Apple Silicon Mac (`--features coreml`) and one Windows CUDA machine (`--features cuda,load-dynamic`). Record binary sizes and the exact link/runtime requirements.
2. Windows: on a machine with ONLY the app's existing cuda12 pip DLLs (cublas/cudnn) on PATH plus a candidate ORT 1.24 GPU archive, enumerate the full DLL closure with the Dependencies tool until the CLI runs on GPU. Record every DLL and its source. Confirm driver floor (CUDA 12.8 minor-version compatibility).
3. Record, per mode (`coreml`, `cuda`, and both `-fast` variants for comparison): the exact model file list `ModelManager` requires, per-file sizes, per-mode pack totals.
4. Run ≥ 3 internal meetings (one ≥ 60 min, one with heavy overlap, one 2-speaker) + a 10-file VoxConverse dev subset through both speakrs (exclusive segments) and current pyannote on the same hardware.
5. Confirm `PipelineConfig` speaker-count bounds map from our `--speaker-count`; if not, record "auto-only" as the shipped behavior.
6. Measure peak RSS on the 60+ min meeting (CLI child), and cold-start latency (model load) per mode.

**Go criteria (ALL must hold):**
- DER within **+1.0 absolute** of pyannote on the VoxConverse subset AND blind A/B on the internal meetings shows wrong-speaker rate not worse than **5 % relative** (2 reviewers, 50 sampled turns each).
- Diarization RTFx ≥ **2×** pyannote on the same hardware for the medium meeting, per platform.
- Peak RSS ≤ **4 GB** for the 60+ min meeting.
- Windows GPU run succeeds with cublas/cudnn from the existing pip profile + the candidate ORT archive (documented closure, no pip profile mutation).
- Per-platform pack total ≤ **600 MB** (else escalate before Task 2).
- 60+ min meeting completes well inside `AI_COMPUTE_TIMEOUT_MS.diarization` (30 min).

**Validation:** `SPEAKRS_SPIKE_NOTES.md` contains the tables (file, duration, speakers, engine, mode, DER, seconds, RTFx, peak RSS) + DLL closure + pack lists, and an explicit GO/NO-GO line.

---

### Task 1: `speakrs-cli` binary + JSON contract (+ characterization pre-work)

**Files:**
- Create: `native/speakrs-cli/Cargo.toml`, `native/speakrs-cli/src/main.rs`, `native/speakrs-cli/rust-toolchain.toml` (pin ≥ 1.88), vendored deps policy (`cargo vendor` or lockfile-only — decide by CI network policy)
- Create: `tests/python/test_speakrs_cli_contract.py` (fixture-JSON parse tests; real-binary smoke marked skip-if-absent)
- Create: `tests/fixtures/` short 2-speaker WAV (~15 s, self-recorded or synthetic TTS — no third-party license)

**Contract (frozen here):**
- argv: `speakrs-cli <wav-path>`; env: `SPEAKRS_MODELS_DIR` (required), `SPEAKRS_MODE` (`cpu|coreml|cuda`, required), `SPEAKRS_EXCLUSIVE` (`1` default), `SPEAKRS_NUM_SPEAKERS` (optional int, if Task 0 confirmed the knob).
- stdout: exactly one JSON object: `{"success": true, "device": "<mode>", "annotationSource": "exclusive"|"discrete", "segments": [{"start": f, "end": f, "speaker": "SPEAKER_00"}, ...]}` — speaker labels keep the `SPEAKER_NN` convention so `speaker_segments._speaker_label_map` works unchanged. Failure: `{"success": false, "error": "<single-line message>"}` + non-zero exit.
- stderr: human diagnostics only; Python never parses it for control flow.
- Exit promptly on SIGTERM/CTRL-BREAK (no orphaned inference).
- Implementation: decode 16-bit PCM WAV → f32, `OwnedDiarizationPipeline::from_dir(models, mode)`, `run()`, clone `discrete_diarization`, `make_exclusive()` when `SPEAKRS_EXCLUSIVE=1`, `to_segments()`, serialize.

**Validation:** `cargo test` + `cargo clippy -D warnings` in the crate; `npm run test:python` (contract fixture tests); manual run against the spike models.

---

### Task 2: Model pack repack + catalog pins (token-free setup)

**Files:**
- Create: `scripts/build-speakrs-model-pack.js`
- Modify: `src/ai-addon-state.js` — add `DIARIZATION_ENGINE` (default `'speakrs'`, env override), new catalog model entry, keep the pyannote entry untouched behind the engine flag. Target shape (mirror `SUMMARY_RUNTIME_ARTIFACTS` field conventions; final sha256/size values come from the repack script):

```js
const SPEAKRS_MODEL_PACK_REVISION = '5d24ffe'; // upstream speakrs-models rev (short)
// inside AI_MODEL_CATALOG.diarization.models[]:
{
  id: 'speakrs-community1-vbx',
  engine: 'speakrs',
  label: 'Speaker identification (speakrs)',
  provider: 'github-release',
  license: 'MIT + CC-BY-4.0 (see pack ATTRIBUTION.md)',
  licenseUrl: 'https://huggingface.co/avencera/speakrs-models',
  gated: false, tokenRequired: false, termsRequired: false,
  runtime: { type: 'native-cli', executableName: 'speakrs-cli', modeByPlatform: { 'win32-x64': 'cuda', 'darwin-arm64': 'coreml' } },
  packArtifacts: {
    'win32-x64': [{ id, fileName, url, sha256, sizeBytes }, /* + ORT/CUDA runtime archive */],
    'darwin-arm64': [{ id, fileName, url, sha256, sizeBytes }],
  },
  supportedPlatforms: { win32: { acceleration: 'cuda', status: 'enabled' }, darwin: { acceleration: 'coreml', arch: 'arm64', status: 'enabled' } },
}
```
- Modify: `src/ai-addon/manifest-store.js` — `checkSpeakrsModelCache` (existence/size always, sha256 at setup/validate, fingerprint-skip later), engine-aware `deriveDiarizationStatus`
- Modify: `src/ai-addon/diarization-setup.js` — engine branch: speakrs setup = download archives → extract via existing workers → validate; no token calls anywhere on this path
- Modify: `src/ai-addon-state.js` `normalizeDiarizationState` — `engine` field + legacy detection (see Manifest migration)
- Tests: `tests/js/ai-addon-state.test.js`, `ai-addon-setup.test.js` (new: token-free happy path reaches `ready` with zero token-store calls; cancel during download removes partials, preserves prior valid install; checksum mismatch → never `ready`; legacy manifest → migration-needed state)

**Validation:** `npm test`. Setup on a dev machine reaches `ready` offline-after-download with `HF_TOKEN` absent and token store empty.

#### Task 2b (parallel, blocking release only): License-compliance gate (self-serve — no counsel available)

Plain-English framing: model weights are files with licenses, exactly like ffmpeg. Every constituent here is **permissive** (MIT or CC-BY-4.0): use, modification, redistribution, and commercial use are all allowed; the only enforceable obligation is **attribution** (credit + license link + "changes were made"). The HF gate on pyannote's repos is an access/marketing mechanism of that distribution channel, **not a license term** — which is why ungated mirrors (`onnx-community/pyannote-segmentation-3.0`, `pyannote-community/speaker-diarization-community-1`) and redistributors (sherpa-onnx GitHub releases, Vibe, OpenWhispr) exist openly. Precedent to copy: **sherpa-onnx**, which repacks the pyannote segmentation model from the MIT onnx-community mirror at a pinned revision, retains upstream copyright, and notes that the only modification is format conversion.

Checklist (all engineering, done by the maintainer; keep evidence in the PR):

1. `ATTRIBUTION.md` + `LICENSES/` directory inside each model-pack archive, one entry per constituent in TASL form (Title, Author, Source link, License link) + a "changes" line ("converted to ONNX/CoreML and repackaged for AvaNevis; weights unmodified"):
   - `pyannote/segmentation-3.0` — MIT (include the upstream copyright/permission notice verbatim; prefer citing the un-gated MIT `onnx-community` mirror revision as the conversion source, like sherpa-onnx does)
   - `wespeaker-voxceleb-resnet34-LM` — CC-BY-4.0 (WeSpeaker authors; pyannote conversion)
   - PLDA/VBx parameters — derived from `pyannote/speaker-diarization-community-1`, CC-BY-4.0 (pyannoteAI)
   - `speakrs` — Apache-2.0 (avencera); ONNX Runtime — MIT (Microsoft)
2. Mirror the same entries into root `THIRD_PARTY_NOTICES.md`; verify `stageLegalBundle` stages them and `open-legal-notices` shows them; run `npm run legal:sbom`.
3. Download the upstream gated repos once with the maintainer's own HF account to source/verify artifacts (accepting the gate yourself is exactly the licensed acquisition path; end users never see it).
4. Keep `licenseUrl` pins in the catalog (non-allowlist-expanding) and the pinned source revision recorded in the repack script output.
5. Residual risk, accepted knowingly: VoxCeleb-trained embedding weights. The model card licenses them CC-BY-4.0 and the industry (sherpa-onnx, Vibe, OpenWhispr, many commercial products) ships them; for a desktop app this is standard practice. If real legal review ever becomes available, have it confirm items 1–5 — nothing in the architecture changes either way.

Until the checklist is merged: dev/QA builds may fetch packs from upstream HF directly; **no public release ships the pack**.

---

### Task 3: Python backend — speakrs runner behind engine switch

**Files:**
- Create: `backend/diarization/speakrs_runner.py`
- Modify: `backend/diarization/diarization_pipeline.py` — add `--engine speakrs|pyannote` (default pyannote for backward compat; JS always passes it explicitly); route `run_pyannote_diarization` call sites through an engine dispatch; speakrs validate-setup path = runner smoke without `--token-stdin`
- Modify: `backend/diarization/guided_transcription.py` — same dispatch; **fix the unredacted `ERROR:` print (L492) with `redact_sensitive_text`**
- Tests: extend `tests/python/test_diarization_pipeline.py`, `test_guided_transcription.py`; new `test_speakrs_runner.py`

**`speakrs_runner.py` requirements:**
- Resolve CLI path: `SPEAKRS_CLI_PATH` env (set by JS) → packaged `Resources/bin/speakrs-cli` → dev `native/speakrs-cli/target/release/` → PATH **only when `AVANEVIS_PACKAGED` unset** (Swift-helper rule, `swift_audio_capture.py:82-84` as the template).
- Spawn with: cleared HF token env (reuse the same clearing the JS side sends; belt-and-braces pop in Python too), `SPEAKRS_MODELS_DIR`/`SPEAKRS_MODE`/`SPEAKRS_EXCLUSIVE` set, lowered priority inherited, **and guaranteed child termination**: POSIX `start_new_session=True` + `os.killpg` in `finally`/signal handler; Windows `proc.kill()` in `finally` + `CTRL_BREAK_EVENT`-capable creation flags. Test with a fake hanging CLI.
- Emit the **same** `emit_progress` phases as today (`preparing-audio` 15, `validating-accelerator` 30, `loading-model` 35, `running-model` 55, `merging-speakers` 80, `completed` 100) so `parseAiBackendProgressLine` / `diarization-progress` need zero changes.
- Parse the CLI's single stdout JSON; map failures to the existing single-line `ERROR:` stderr convention (redacted).
- Return `(speaker_segments, annotation_source, device)` — exactly `run_pyannote_diarization`'s tuple — so `build_diarization_result`, sidecar schema, and merge behavior are untouched.
- Device mapping per the table above (`mps` requirement → `coreml` mode, reported device `coreml`).

**Validation:** `npm run test:python` (all existing diarization tests still green with engine=pyannote default; new speakrs tests with mocked CLI stdout, kill-propagation, redaction).

---

### Task 4: Electron main — spawn plumbing + setup/validation wiring

**Files:**
- Modify: `src/main/transcription-service.js` — `buildManagedDiarizationArgs` / `...GuidedTranscriptionArgs` append `--engine` from catalog; speakrs env block (`SPEAKRS_CLI_PATH`, `SPEAKRS_MODELS_DIR`, `SPEAKRS_MODE`, Windows `PATH` prepend for the downloaded ORT dir — alongside existing `buildCudaRuntimeEnv` for cublas/cudnn); skip `getDiarizationCacheEnv()` HF vars for speakrs runs (keep for pyannote); `resolveGuidedDiarizationStatus` stays catalog-only
- Modify: `src/main/ai-addon-ipc.js` — validation spawn for speakrs: no `--token-stdin`, no token resolution, same `createAbortableComputeAction` + `addonValidation` timeout; keep token channels registered (legacy path) but never called on the speakrs path
- Modify: `src/main.js` — `buildManagedDiarizationValidationArgs` engine branch; resolve packaged CLI path (`process.resourcesPath/bin/speakrs-cli[.exe]`)
- Tests: `tests/js/ai-addon-privacy-hardening.test.js` (extend: speakrs validation spawns with cleared HF env and NO stdin token write), `transcription-queue-helpers` characterization, ipc snapshot unchanged this task (no channel changes yet)

**Validation:** `npm test`; dev-mode end-to-end: record → guided transcription with speakrs → `*.speakers.json` schema-identical (diff against a pyannote run of the same audio apart from `model`/`device` fields); wall-clock kill test leaves no orphaned `speakrs-cli`.

---

### Task 5: Renderer UX + migration copy

**Files:**
- Modify: `src/renderer/app.js`, `src/renderer/index.html` — hide token entry/status UI when engine=speakrs; setup flow becomes download+validate only
- Modify: `src/renderer/history-detail-helpers.js` — `getDiarizationSetupMessage` new copy (no HF account); migration prompt for legacy-pyannote manifests; `shouldShowSpeakerSetupPrompt` Windows CUDA gate unchanged
- Modify: `src/renderer/formatters.js` — no change yet (`needsAccount` label stays until Task 8)
- Modify: legacy cleanup: extend `remove-diarization-setup` handler (`ai-addon-ipc.js`) to delete pip tree + old HF cache + token file with explicit dialog copy (see Manifest migration); destructive-removal guards (compute/preload pending → reject) preserved
- Modify: `tests/manual/local-ai-addons-checklist.md` — speakrs setup/validate/remove/migration rows
- Tests: `history-detail-helpers.test.js`, renderer characterization

**Validation:** `npm test`; manual checklist pass on one platform in dev.

---

### Task 6: Build / CI / release packaging

**Files:**
- Modify: `build/prepare-resources.js` — `buildSpeakrsCli()` mirroring `buildSwiftHelper()` (cargo build --release → stage to `build/resources/bin/` → strip → macOS codesign with `entitlements.mac.inherit.plist`); add build-input fingerprints to `resource-manifest.json` invalidation
- Modify: `package.json` — `extraResources` already maps `build/resources/bin` → `bin`; add `Contents/Resources/bin/speakrs-cli` to mac `binaries`/`asarUnpack` signing list beside `audiocapture-helper`
- Modify: `.github/workflows/ci.yml` — Rust toolchain (pinned via `rust-toolchain.toml`) + cargo cache on `windows-latest` and `macos-14` jobs; `cargo test`; **CPU-mode end-to-end smoke**: cache the small ONNX subset, run `speakrs-cli` on the fixture WAV, assert ≥ 1 segment (this is real-inference CI coverage pyannote never had)
- Modify: `.github/workflows/build-release.yml` — build + stage CLI per platform; fail release on missing binary or pack checksum mismatch
- Modify: `AGENTS.md` — diarization bullets (this is the invariant doc; update in the same PR as cutover default flip, not before)
- Modify: `docs/development/LOCAL_AI_MODEL_CATALOG.md` — replace token/MPS-only rules with speakrs pack-pin rules (revision, sha256, per-mode file lists, repack script usage)

**Validation:** `npm run prepare-build` stages the binary; packaged smoke (both CI jobs) asserts `bin/speakrs-cli` present and codesigned (mac); `npm run test:all`.

---

### Task 7: Soak + benchmark + cutover gate

- Flip `DIARIZATION_ENGINE` default to `'speakrs'` (if not already) in a beta/internal build; pyannote reachable via `AVANEVIS_DIARIZATION_ENGINE=pyannote`.
- Run the full benchmark matrix (below) and record in `docs/development/SPEAKRS_BENCHMARKS.md`.
- **Cutover bar (all):** ≥ 25 internal meetings across both platforms through guided transcription with zero engine crashes/hangs; wrong-speaker A/B within the Task 0 threshold; setup/validate/remove/migration manual checklist green on Windows CUDA + macOS AS packaged builds; no compute-queue or quit-drain regressions (existing characterization suites green).
- Rollback playbook: flip the catalog default back to pyannote in a patch release; speakrs artifacts stay cached (harmless); legacy pyannote installs still work because nothing was deleted automatically.

### Task 8: pyannote removal (post-soak cleanup — single PR)

- Remove: `DIARIZATION_DEPENDENCY_ARTIFACTS`, pyannote catalog entry, `needsAccount` from `AI_ADDON_STATUS_STATES` + all consumers (`ai-addon-ui-helpers.js`, `formatters.js`, `app.js:4319/4499`, `history-detail-helpers.js`), token IPC channels (`store-diarization-token`, `get-diarization-token-status`, `delete-diarization-token`) + preload + renderer sites, `--token-stdin` path in `diarization_pipeline.py`, `getDiarizationCacheEnv` HF vars for diarization (keep Whisper cache env untouched), pyannote branches in setup/validation.
- Update in the same PR: `tests/js/ipc-contract-snapshot.test.js`, `ai-addon-privacy-hardening.test.js` trusted-sender list, `ai-addon-state.test.js` status array, formatter/ui-helper/history tests, `AGENTS.md`, `LOCAL_AI_MODEL_CATALOG.md`, `docs/initiatives/FEATURE_SPEAKER_DIARIZATION.md` (historical note).
- Keep: `ai-addon-token-store.js` (generic mechanism, other features may use it), legacy-cleanup path in `remove-diarization-setup` for one more release cycle.

**Validation:** `npm run test:all`; ipc snapshot regenerated deliberately; grep proves no `needsAccount` / `token-stdin` / `pyannote.audio` references remain outside docs history.

---

## Benchmarking matrix (Task 0 subset → Task 7 full)

| Platform | Mode | Compare against | Corpus |
|----------|------|-----------------|--------|
| macOS Apple Silicon | `coreml` (default), `coreml-fast` (info only) | pyannote MPS | 3–13 internal meetings + VoxConverse dev subset |
| Windows NVIDIA | `cuda` (default), `cuda-fast` (info only) | pyannote CUDA | same |
| Both | `cpu` | n/a (CI smoke only) | fixture WAV |

Metrics: DER (`pyannote.metrics` offline, collar 0 + 250 ms), wall time / RTFx, peak RSS (CLI child), end-to-end guided latency vs plain Whisper, human wrong-speaker rate on 50 sampled turns. Keep the spreadsheet columns from Task 0. Internal meeting fixtures stay in a private corpus dir, never in git.

---

## Alternatives ranking (if a condition fails)

1. **speakrs (this plan)** — only option meeting all goals: zero-token, OSS, accelerated on both platforms, offline, distributable. Conditions are process, not capability.
2. **Stay on pyannote community-1** — the rollback position and the soak-period fallback. Zero engineering risk; permanently fails the zero-token and 4 GB-install goals. Correct choice only if legal blocks pack redistribution AND per-file HF download of speakrs models is also ruled out.
3. **Hybrid: speakrs on macOS first, pyannote on Windows** — macOS has the biggest win (24×→529×, minus 2 GB torch) and no ORT-CUDA DLL question. Cuts blast radius but doubles the support matrix and keeps tokens on Windows; choose only if the Windows DLL closure fails in Task 0.
4. **sherpa-onnx diarization (k2-fsa / Next-gen Kaldi)** — Apache-2.0, mature multi-year project, prebuilt binaries for every platform, already redistributes the pyannote segmentation model with clean attribution. The catch: its diarization is segmentation + embedding + simple clustering (no VBx/PLDA), so accuracy is a clear step below community-1/speakrs on hard meeting audio. It is the "boring and reliable" plan C if speakrs is abandoned upstream — and its model-hosting/attribution practice is the template for our Task 2b regardless.
5. **`diarize` (FoxNoseTech, CPU-only ONNX)** — Apache-2.0, easy Python drop-in, but violates the accelerator-only policy and gives up the speed win; also young. Only relevant if a CPU policy change happens independently.
6. **NVIDIA NeMo Sortformer** — CUDA/Windows-only, weak macOS story, historical speaker-count limits, heavyweight stack. Not a fit.

---

## Top risks (post-review)

| # | Risk | Mitigation |
|---|------|------------|
| 1 | Model-pack redistribution: upstream repo has no LICENSE file; params extracted from community-1 | Repack with LICENSES/ATTRIBUTION per the Task 2b self-serve checklist (sherpa-onnx precedent); gates public release, not development |
| 2 | Windows ORT CUDA DLL closure / CUDA ≥ 12.8 vs existing cuda12 pip profile | Task 0 proves the closure on clean hardware; ORT+cudart+cufft ship in our pinned archive; never mutate the shared transcription pip profile |
| 3 | Young single-maintainer crate + ORT rc pin | Exact-version pin + vendored deps; our CLI is the only API surface; pyannote behind engine flag until soak; self-hosted models |
| 4 | Real-meeting parity (overlap, exclusive boundaries feeding guided windows) unproven vs VoxConverse claims | Task 0 blind A/B + DER gates; `-fast` modes excluded from defaults |
| 5 | Contract breakage during surgery (IPC snapshot, status enum, privacy tests, sidecar schema) | Characterization-first: pinned tests updated deliberately per task; `needsAccount`/token removal deferred to a single post-soak PR |

**Single best next engineering action:** run Task 0 on Apple Silicon first — build `native/speakrs-cli` from the two upstream examples, run the 3 internal meetings against current pyannote MPS, and fill the spike tables. It exercises the biggest win, needs no CUDA hardware, and produces the model-pack file lists every later task depends on.

---

## Ordered execution summary

1. Task 0 spike (Apple Silicon first, then Windows DLL closure) — **decision gate**
2. Task 1 CLI + frozen JSON contract + fixtures
3. Task 2 pack repack + catalog pins ∥ Task 2b legal gate (blocks release only)
4. Task 3 Python engine switch (pyannote default preserved)
5. Task 4 main-process plumbing
6. Task 5 renderer UX + migration
7. Task 6 build/CI/release packaging
8. Task 7 soak + benchmarks + cutover flip
9. Task 8 pyannote removal (single deliberate PR)
