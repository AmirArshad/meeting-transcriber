# Speakrs Diarization Migration Plan (v5 — exclusive engine selector)

> **Revision history:** v1 drafted 2026-07-16. v2 (2026-07-18) production-viability rewrite. v3 (2026-08-13) pre-Task-0 hardening. **v4 (2026-08-13, post-0b):** Task 0b is **CONDITIONAL GO**. Product decision: keep **both** engines behind an exclusive user selector (not a silent Task 7 flip). Task 8 pyannote removal is **parked**. **v5 (2026-08-14):** first Mac packaged soak. Selector UX and one 2-talker quality miss are **Task 7a**, blocking the ship bar — not a silent cutover. Spike notes: `docs/development/SPEAKRS_SPIKE_NOTES.md`.
>
> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries. Do not ship speakrs packs publicly until Task 2b is merged. Do **not** delete pyannote code or token IPC on this branch.

**Verdict: CONDITIONAL GO (viability 3.5/5).** Windows ORT + existing cuda12 pip DLL closure **passed** (RTX 4070, driver 610.88, ORT 1.27.1 cuda12). Same-box Windows pyannote CUDA beat speakrs on DER (Δ +2.96 / +2.82) and RTFx (62× vs 35×). Mac speakrs remains a large win. License pack diligence (Task 2b) still gates public release. Young crate: vendor-pin; pyannote stays as a user-selectable engine.

**Goal:** Ship speakrs as a **token-free** speaker engine beside pyannote, exclusive-install (only one on disk), user-selected — while keeping AvaNevis speaker-segment JSON / guided-transcription contracts byte-compatible. New users default to speakrs. Existing pyannote installs stay on pyannote until the user switches.

**Architecture:** Python stays the orchestration layer (16 kHz mono prep, guided windows, merge, sidecars, progress JSON). speakrs runs as a **bundled native CLI** (`speakrs-cli`, built in CI from a vendored crate — Swift-helper pattern), with **model packs and the Windows ORT GPU runtime downloaded at setup time** (llama.cpp-runtime pattern, sha256-pinned, host-allowlisted).

---

## Verified Research Snapshot (2026-07-18, rechecked 2026-08-13)

Everything below was re-verified against crates.io, docs.rs, the speakrs GitHub repo/examples/source, and the HF model repos. Corrections vs v1/v2 are marked ⚠.

| Item | Finding |
|------|---------|
| Crate | `speakrs` **0.5.0 still latest** (published 2026-07-07; crates.io `max_version`/`newest_version` 0.5.0; GitHub latest release tag `v0.5.0`). Apache-2.0, MSRV 1.88, edition 2024. First published **2026-03-25**; single maintainer (avencera / Praveen Perera). Master after v0.5.0 is docs-only (`Why not pyannote-rs?`). Do not pin unreleased master. |
| Features | ⚠ `default = ["online", "default-linalg"]`. No-default builds **must** enable exactly one BLAS: `default-linalg` / `intel-mkl` / `openblas-static` / `openblas-system`. x86_64 `default-linalg` = static Intel MKL (can be huge); arm64 = static OpenBLAS (needs a C toolchain). `online` gates `ModelManager` / `from_pretrained` / HF repo strings. |
| CLI | **None upstream** — library + examples only. We own `speakrs-cli`. ⚠ `examples/diarize_wav.rs` hardcodes `ExecutionMode::Cpu` — never copy that as the product path. |
| API (verified on docs.rs + examples) | `OwnedDiarizationPipeline::{from_pretrained, from_dir(Path, ExecutionMode), run(&[f32]) -> DiarizationResult}`; `result.discrete_diarization.clone()` → `make_exclusive()` → `to_segments()` → `Segment { start: f32, end: f32, speaker: String }`; `rttm(file_id)`. `make_exclusive()` confirmed in `examples/assign_transcript_speakers.rs`. |
| Speaker-count hint | ⚠ **No speaker-count API in 0.5.0.** `PipelineConfig` has binarize / `AhcConfig { threshold }` / VBx / merge_gap only. Expect **auto-only** unless Task 0 finds another knob. |
| Modes | `cpu`, `coreml`, `coreml-fast`, `cuda`, `cuda-fast`, `migraphx`. `*-fast` = 2 s segmentation windows (coarser speaker-change boundaries). |
| ORT | speakrs 0.5.0 lock uses `ort 2.0.0-rc.13`, which requires ONNX Runtime **≥ 1.27** (plan v3's 1.24 / rc.12 note is stale). Task 0b candidate: official `onnxruntime-win-x64-gpu_cuda12-1.27.1.zip` + `cudart64_12` / `cufft64_11` from NVIDIA cu12 wheels (not the app pip profile). Pin that archive in the catalog. `ort` compile-time downloads — Task 6 vendors them, not `download-manifest.js`. |
| ORT CUDA EP requirements | ORT 1.27 CUDA12 builds + existing cuda12 pip `cublas64_12` / `cublasLt64_12` / `cudnn64_9`. 0b **proved** closure on driver **610.88** / RTX 4070 with **no** CUDA toolkit and **no** pip-profile mutation. Official ORT zip does **not** include cudart/cufft — our Windows runtime archive must. |
| Models | ⚠ `avencera/speakrs-models` (pin `5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f`) is **not** a straight community-1 conversion. `required_files(CoreMl)` (in `src/models.rs`, compiled only with `online`) is ONNX + `.onnx.data` + ~15 `.mlmodelc` trees, not just the three `from_dir` base names. Copy that list from **source** in Task 0 — do not enable `online` just to call `ModelManager`. Whole repo ≈ 870 MB. |
| Model licenses | `pyannote/segmentation-3.0` = **MIT**. `wespeaker-voxceleb-resnet34-LM` = **CC-BY-4.0** (VoxCeleb dataset is CC-BY-4.0). community-1 pipeline (source of PLDA/VBx params) = **CC-BY-4.0**. The HF gate on pyannote repos is an access/marketing mechanism, **not a license term** — CC-BY-4.0/MIT permit redistribution with attribution. ⚠ `avencera/speakrs-models` itself ships **no LICENSE file** and defers to "upstream terms" → we repack with our own LICENSES manifest per the Task 2b self-serve compliance checklist. |
| Claimed perf (VoxConverse dev, collar 0) | coreml 7.1 % DER @ 529× (M4 Pro) vs pyannote MPS 7.2 % @ 24×; cuda 7.0 % @ 59×, cuda-fast 7.4 % @ 121× vs pyannote CUDA 7.2 % @ 32×. |
| Memory | `run(&[f32])` takes the whole mono-16k file in RAM (90 min ≈ 346 MB f32). Python `load_prepared_audio_for_pipeline` holds another copy during the spawn. Spike measures **CLI RSS and Python+CLI RSS**. |
| Input | Mono 16 kHz f32 — exactly what `prepare_diarization_audio` already produces (s16le WAV; CLI decodes s16→f32). |

### Locked decisions (do not relitigate during execution)

1. **CLI, not PyO3.** Matches Swift-helper/llama-cli packaging, crash-isolates Rust panics, avoids maturin/ABI coupling to bundled Python. Spawn overhead is irrelevant at minutes-long job scale. PyO3 stays a non-goal.
2. **Default modes: `coreml` (macOS) and `cuda` (Windows) — NOT the `-fast` variants.** Guided transcription consumes turn boundaries to cut padded Whisper windows; `-fast`'s 2 s segmentation windows coarsen exactly those boundaries, and its DER is worse (7.4 vs 7.0/7.1). Precise modes are already 2×+ faster than pyannote. `-fast` may become an opt-in later; never the default.
3. **CLI is bundled in the installer (built in CI, both platforms); model packs + Windows ORT runtime archive are setup-time downloads.** Keeps the installer lean and the GPU stack out of non-diarization users' disk. **Feature flags (binding):** `default-features = false` plus **`default-linalg`** plus the platform features — never platform-only (that fails the crate's BLAS compile-time check). Mac: `["default-linalg", "coreml"]`. Windows: `["default-linalg", "cuda", "load-dynamic"]`. CI CPU smoke may use `["default-linalg"]` only. If the macOS binary exceeds 80 MB in Task 0 (OpenBLAS + static ort), switch macOS to `load-dynamic` too and move the ort dylib into the model pack. Record Windows exe size **with static MKL** — that can dwarf the “small exe” story.
4. **Merge/labeling stays in Python.** `speaker_segments.py` (dominant-overlap merge, `Speaker N` relabeling, `Unknown`, 12 s coarse split) is pure Python with no torch dependency and is fully unit-tested. The CLI emits only raw turns.
5. **Accelerator-only policy is unchanged in this migration.** `cpu` mode exists in the CLI for CI smoke tests only; product setup still requires CUDA (win32) / Apple Silicon (darwin-arm64). Relaxing that is a separate product decision the CLI makes cheap later.
6. **Exclusive user-selected engine (v4 — replaces the catalog-constant flip).** Both engines stay in the product. The user picks one. **Only one may be installed.** Switching uninstalls the other (models + engine-specific caches). The Pyannote Hugging Face token stays in `safeStorage` across a switch to Speakrs so switch-back can reuse it; **Remove** still deletes the token. New / unset users **default to speakrs**. Existing pyannote installs stay on pyannote until they switch. `AVANEVIS_DIARIZATION_ENGINE` is QA spawn-only (does not install both). **No Task 7 silent flip. Task 8 is parked.** `-fast` stays off the default (locked #2). Do not claim a Windows speed or DER win vs pyannote CUDA.

### Execution guardrails (binding on the implementing agent)

1. **Single implementation branch: `feature/speakrs-diarization`, one task at a time, in plan order.** Each task lands as its own commit (or small commit series) prefixed `speakrs task N:`, with that task's validation commands green **before** the next task starts. Tasks 1–6 merge together after Task 6 validation; Task 7 is soak on merged builds (no default flip). Task 8 (pyannote deletion) is **not scheduled** and is never done on this branch.
2. **Characterization first (Task 1 pre-step; may land in parallel with Task 0a — no hardware needed), before ANY app code changes:** add golden tests pinning today's behavior so the engine swap is diff-checked, not eyeballed —
   - a Python golden test asserting the exact `*.speakers.json` **top-level field set** + `segments`/`speakerSegments` field sets from `build_diarization_result` (extend `tests/python/test_diarization_pipeline.py`); pin `annotationSource` **values** as today's `exclusive_speaker_diarization` / `speaker_diarization` (speakrs must map onto those);
   - Python tests snapshotting the ordered `emit_progress` phase strings **per entry point** (`diarize_transcript`, `transcribe_with_diarization_guidance`, `validate_pyannote_setup`) — not one invented sequence;
   - a JS test pinning that `diarize-transcript` / `transcribe-audio-with-speakers` **payload shape** is engine-agnostic. Pin schema / field sets, **not full argv** (Task 4 adds `--engine` additively).
    These must stay green through Tasks 3–7 without weakening the pins. Adding `--engine` and additive status/`setup-diarization` fields is allowed; changing field sets or phase names is not.
3. **Additive; pyannote stays.** No IPC channel renames/removals, no status-value removals, no `preload.js` API removals, no deletion of pyannote code/catalog/tests, no edits to `AI_ADDON_STATUS_STATES`, **no new keys on the pinned facades** (`src/ai-addon-setup.js`, `src/main-process-helpers.js`). New helpers stay internal to `manifest-store.js` / services. If a pinned snapshot test fails, fix the change, not the snapshot — unless Task 5 adds a genuine new channel (then edit the snapshot in the same commit). Prefer **no new channel**: pass `engine` on existing `setup-diarization` and extra fields on existing `get-ai-addon-status`.
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
| "Reuse existing GPU readiness probes" | Partially. cublas/cudnn come from the existing cuda12 pip profile (already gated by `check-cuda` and the renderer's `shouldShowSpeakerSetupPrompt`). ORT 1.24 CUDA-12.8 builds are compatible with **any CUDA 12.x** user-mode libs; we still must ship cudart/cufft/ORT in the pinned archive. **Do not** mutate the shared transcription pip profile. Spike proves the closure with the Dependencies tool on a box that already runs pyannote CUDA. |
| "CoreML vs current MPS copy/UX" | Strict improvement: no 2 GB torch download, no MPS probe. All user-facing "Metal/MPS" copy and the `LOCAL_AI_MODEL_CATALOG.md` MPS-only rules change at cutover. `.mlmodelc` bundles are precompiled (no first-run CoreML compile stall); macOS 13+ target is fine. |
| "Young crate" | Confirmed and worse than v1 implied: first release 2026-03-25, bus factor 1. Mitigations: exact-version pin + `cargo vendor` the dependency tree into our build (or a fork under our org), our own thin CLI as the only API surface, pyannote behind the engine flag until soak, and the model pack self-hosted so upstream deletion cannot brick setup. |
| "speakrs metrics module for DER" | Exists only behind the private `_metrics` feature. Still benchmark DER with `pyannote.metrics` offline (Task 0 harness) so numbers match today's pyannote path. |

## Repo-grounded gaps v1 under-specified (all addressed in tasks below)

1. **Pinned contract tests that WILL break** and must be updated deliberately, not discovered: `tests/js/ipc-contract-snapshot.test.js` (full IPC channel snapshot incl. every diarization/token channel + `ai-addon-progress`), `tests/js/ai-addon-privacy-hardening.test.js` (trusted-sender list pins the 10 mutating channel names; source-scan asserts on `HF_TOKEN_PATH`), `tests/js/ai-addon-state.test.js:319` (pins the 7-value status array), `formatters.test.js` / `ai-addon-ui-helpers.test.js` / `history-detail-helpers.test.js` (`needsAccount` label/terminal/prompt copy).
2. **`needsAccount` producers/consumers enumerated:** produced only in `src/ai-addon/diarization-setup.js` (L439, L451, L590-597, L629-636); consumed in `src/renderer/ai-addon-ui-helpers.js:13`, `formatters.js:66`, `app.js:4319/4499`, `history-detail-helpers.js:156-158/283`. Stays for the pyannote choice. Hide those surfaces when `engine === 'speakrs'`. Do not delete the status value.
3. **Manifest has no migration mechanism today** (`manifestVersion: 1` unconditionally rewritten; legacy top-level fallback exists in `normalizeAiAddonManifest`). v2 defines a concrete `engine` field + legacy-pyannote detection instead of hand-waving "manifest migration".
4. **`deriveDiarizationStatus` (`manifest-store.js:718-730`) is not the only pip-cache trap.** It downgrades `ready`→`error` from pip `dependencyCache`. Worse: `setupComplete` is `status === 'ready' && diarizationDependencyCache.valid` (`manifest-store.js:824`) and `resolveGuidedDiarizationStatus` / `transcribe-audio-with-speakers` / `diarize-transcript` all require `setupComplete` (`transcription-service.js:828`, `:2056`, `:2139`). Speakrs has no pip cache → guided never starts. Independently, `getDiarizationModelRef` returns `runtime.modelRef` (`ai-addon-state.js:414-417`); the speakrs catalog entry has no `modelRef` → status resolves to null / "model is not configured". `hasDiarizationLocalState` and `buildDiarizationStorageFootprint` also key off pip `dependencyCache` — Remove + Settings bytes stay wrong unless Task 2 is engine-aware. Status derivation must switch to model-pack + CLI presence checks per engine **and** those two JS gates must not require pip/`modelRef`.
5. **Progress contract specifics:** guided/diarization progress is parsed from **stderr** via `parseAiBackendProgressLine` (accepts only `{type:'progress'}`, sanitizes phase ≤ 80 chars, redacts message ≤ 300); valid diarization events go to `diarization-progress`, everything else to `transcription-progress`; setup progress goes to `ai-addon-progress`. Replace only `run_pyannote_diarization` (inner phases: `validating-accelerator` 30, `loading-model` 35, `running-model` 55, `merging-speakers` 80). Parents still emit `loading-transcript` / `preparing-audio` / guided `building-speaker-windows` / validate `validating-runtime` + `ready`. Do **not** re-emit parent phases from the runner. Do **not** call `assert_required_device_available` (torch) on the speakrs path — map `--require-device mps` → CoreML without importing torch.
6. **Pre-existing bug to fix during the port:** `backend/diarization/guided_transcription.py:492` prints the exception **unredacted** (`diarization_pipeline.py:472` redacts). Fix in Task 3 with a test.
7. **Grandchild termination:** today pyannote runs inside the Python child, so `runWallClockComputeAction`'s kill works. With speakrs the Rust CLI is a **grandchild**. POSIX Python is already a process-group leader (`spawnTrackedPython` `detached: true`, `avanevisProcessGroup`; `terminateProcessBestEffort` does `kill(-pid)`). **Do not `start_new_session` / new process group** — that detaches the CLI so SIGKILL skips Python `finally` and orphans inference. Spawn the CLI in the **same** group as Python. Windows already uses `taskkill /PID /T /F` — no Job object. Python `finally` is backup only. Test: POSIX group-kill of the Python pid must reap the CLI; Windows `taskkill /T` must reap the CLI.
8. **`AVANEVIS_PACKAGED=1` PATH-skip rule** (Swift helper: `swift_audio_capture.py:82-84`; tar: `resolvePreferredTarExecutable`) must apply to `speakrs-cli` resolution, with a test mirroring `tests/js/ai-addon-archive-helpers.test.js:40-51`. Packaged validation needs a **bundled fixture WAV** under `backend/diarization/fixtures/` or `build/resources/` (Task 6 stages it). `tests/fixtures/` is not in `extraResources` and must not be the packaged path.
9. **Legal Notices mechanics:** attribution lives in root `THIRD_PARTY_NOTICES.md`, staged via `stageLegalBundle` (`build/prepare-resources.js`) to `Resources/legal/`, opened by `open-legal-notices` (`src/main/file-export-ipc.js:129-155`). Plus `npm run legal:sbom` / `legal:release-assets` scripts. Concrete edits listed in Task 2b.
10. **Host allowlist:** derived automatically from catalog `downloadUrl`/`url`/`indexUrl`/`extraIndexUrls` keys plus `DOWNLOAD_REDIRECT_HOSTS` (`src/ai-addon/download-helpers.js:39-102`). Self-hosting packs on GitHub Releases is already covered (`objects.githubusercontent.com` etc.); adding pins to the catalog auto-allowlists the host. `licenseUrl` never expands the allowlist.
11. **Timeout budgets:** unchanged — `AI_COMPUTE_TIMEOUT_MS.diarization` 30 min and `addonValidation` 15 min are generous for an engine 2–20× faster; guided budget stays Whisper-model-driven (`getGuidedTranscriptionComputeTimeoutMs`). Only the model-pack **download** needs a budget: reuse `DOWNLOAD_TIMEOUT_MS` (5 min inactivity) per file like summary artifacts.
12. **Windows setup gating stays behind CUDA readiness** (`shouldShowSpeakerSetupPrompt` requires `hasNvidiaGpu && cudaInstalled`) because speakrs reuses cublas/cudnn from the existing GPU runtime install. Speakrs validation must use `buildCudaRuntimeEnv` and must **not** require `includeManagedDiarization` torch site-packages. `setupDiarizationAddon` (`diarization-setup.js:580-637`) currently requires a token **before** download — the speakrs branch must return before that check.

---

## Target architecture

```
Renderer (unchanged channels: setup-diarization / validate / remove / get-ai-addon-status,
          transcribe-audio-with-speakers, diarize-transcript, diarization-progress)
        ↓
src/main/ai-addon-ipc.js  +  src/main/transcription-service.js
        │   engine = manifest.features.diarization.engine
        │            (QA: AVANEVIS_DIARIZATION_ENGINE spawn override only)
        │   spawn env: SPEAKRS_CLI_PATH, SPEAKRS_MODELS_DIR, SPEAKRS_MODE, (win) SPEAKRS_ORT_DIR
        ↓
Python: diarization_pipeline.py / guided_transcription.py   (CLI args: + --engine speakrs)
        ↓ prepare_diarization_audio → 16 kHz mono WAV        (unchanged)
        ↓ speakrs_runner.run_speakrs_diarization()
        ↓   spawn Resources/bin/speakrs-cli <wav>            (grandchild; killed with parent)
        ↓   stdout: single JSON {success, device, annotationSource: exclusive_speaker_diarization|speaker_diarization, segments[{start,end,speaker}]}
        ↓   stderr: diagnostics only (never parsed for control flow)
        ↓ emit_progress(...) — SAME phases/JSON on Python stderr as today
        ↓ merge_speaker_labels / guided windows / Whisper    (unchanged)
        ↓ build_diarization_result → *.speakers.json         (unchanged schema)
```

Sidecar schema, `diarization-progress` payloads, guided fallback policy (guided failure → `runNormalTranscriptionWithCudaFallback` + `persistDiarizationFailureArtifacts`), and compute-queue serialization are **explicit non-changes**. Switching engines does **not** rewrite existing `*.speakers.json` or `meeting.ai.diarization` rows.

### Device naming

| Platform | `--require-device` (JS→Python, unchanged) | `SPEAKRS_MODE` | sidecar `diarization.device` |
|---|---|---|---|
| Windows | `cuda` | `cuda` | `cuda` |
| macOS arm64 | `mps` → interpreted as "Apple accelerator" | `coreml` | `coreml` |

`transcriptionDevice`/`transcriptionComputeType` (Whisper runtime) are untouched. Renderer copy that says "Metal/MPS" changes to "Apple Silicon (CoreML)" in Task 5. `meeting_manager` does not normalize `diarization.device` (only the transcription `metal`→`mps` alias), so `coreml` is safe to persist; add a characterization test proving it.

### Dual-engine selector (v4 — binding)

**One installed engine. User chooses. Switching deletes the other.**

#### Defaults

| Situation | `engine` |
|-----------|----------|
| New user / missing field / `notConfigured` never set up | `speakrs` |
| Existing manifest `modelId === 'pyannote/speaker-diarization-community-1'` (ready or needsAccount) | `pyannote` — do **not** auto-migrate |
| QA | `AVANEVIS_DIARIZATION_ENGINE=speakrs\|pyannote` overrides **spawn/dispatch only**. It must not leave both trees on disk. |

Windows setup for **both** engines still requires `hasNvidiaGpu && cudaInstalled`. Shared transcription cuda12 pip (`cublas`/`cudnn`) is **never** deleted by speaker setup/remove/switch.

#### Manifest (`manifestVersion` stays `1`)

```json
"features": {
  "diarization": {
    "engine": "speakrs",
    "status": "ready",
    "modelId": "speakrs-community1-vbx"
  }
}
```

`normalizeDiarizationState`: missing `engine` + legacy pyannote `modelId` → `engine: 'pyannote'`. Missing `engine` + no legacy model → `engine: 'speakrs'`.

#### Status payload (additive fields on existing `get-ai-addon-status`)

Inside `features.diarization` (or a sibling `diarizationUi` object if that keeps the feature blob cleaner — do **not** add facade exports):

- `engine`: `'speakrs' | 'pyannote'`
- `recommended`: `true` only for speakrs on `darwin-arm64`
- `setupComplete`: engine-aware (speakrs = CLI + pack valid; pyannote = today's pip `dependencyCache.valid`)
- Token UI only when `engine === 'pyannote'`

`needsAccount` remains reachable **only** for pyannote. Speakrs never produces it.

#### IPC (no new channel)

- `setup-diarization({ engine, modelId, speakerCount, token })` — `engine` required once Task 5 ships (`'speakrs' | 'pyannote'`). Main rejects unknown values.
- Exclusive rule **inside** setup, before download: if the *other* engine has local state, delete it (same file lists as remove), then persist `engine`, then run that engine's setup.
- `remove-diarization-setup` — deletes **whichever** engine is installed; leaves `engine` as the last choice so re-setup is one click; status `notConfigured`.
- `validate-diarization-setup` — validates the **active** engine only.
- Reject setup/remove/switch while diarization setup is running, or while compute/preload/GPU-runtime work is pending (`assertRemovalCanRun` / existing queues). Do not wait unbounded behind compute.

#### Exclusive delete lists

**Uninstall speakrs** (switch to pyannote, or Remove while engine=speakrs):

- `userData/ai-addons/models/diarization/speakrs/` (entire tree)
- `userData/ai-addons/runtimes/speakrs-ort/` (Windows ORT archive extract; create this path in Task 2)
- Do **not** delete `Resources/bin/speakrs-cli` (bundled)
- Do **not** delete cuda12 pip or Whisper caches

**Uninstall pyannote** (switch to speakrs, or Remove while engine=pyannote):

- `userData/ai-addons/dependencies/diarization/`
- `userData/ai-addons/models/diarization/hub` and `.../xet` / `.locks` under the **diarization** HF cache only (`getDiarizationCacheEnv` dir — not `AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR`, not `~/.cache/huggingface/hub` Whisper trees)
- `userData/ai-addons/tokens/diarization-huggingface-token.bin` **on Remove only** — keep this file when switching to Speakrs
- Do **not** delete cuda12 pip or Whisper caches

Confirm dialogs **before** the delete (renderer). Copy:

- To speakrs: `Switch to Speakrs? This removes the current speaker model (about 2–4 GB). Your saved Hugging Face token is kept so you can switch back to Pyannote without pasting it again. Speakrs does not need an account.`
- To pyannote: `Switch to Pyannote? This removes Speakrs (about 800 MB). Pyannote needs a Hugging Face account and a larger download. On this PC it is more accurate and faster.`
- Mac to pyannote: same minus the “more accurate and faster” sentence.
- Remove: keep today’s destructive-removal tone; name the active engine and that any saved Hugging Face token is deleted.

#### UI copy

| Surface | macOS Apple Silicon | Windows CUDA |
|---------|---------------------|--------------|
| Speakrs title | `Speakrs` + **`Recommended`** badge | `Speakrs` (no badge) |
| Speakrs subtitle | `Faster. No Hugging Face account.` | `No Hugging Face account.` |
| Pyannote title | `Pyannote` | `Pyannote` |
| Pyannote subtitle | `Needs a Hugging Face account.` | `More accurate and faster here. Needs a Hugging Face account.` |

Do not put **Recommended** on pyannote (that would push tokens). Hide token fields unless pyannote is selected. Hide speaker-count for speakrs (auto-only — crate 0.5.0 has **no** speaker-count API; a 2–6 dropdown that cannot be honored is a lie). Home/History prompt uses `shouldShowSpeakerSetupPrompt` unchanged (Windows still CUDA-gated) and sets up **selected** `engine` (speakrs for new users).

**Primary action label (v5):** the Settings/Home button is **`Set Up`** only when the selected engine has no local state. When the *other* engine is installed, the same button is **`Switch model`**. Selecting the other card must leave that button enabled. Do not require a separate “I picked the card, now find Set Up” discovery step.

#### Status machine (per selected engine)

```
unsupported
notConfigured ── setup-diarization ──> downloading ──> validating ──> ready
      ^                                    │               │
      └──────────── remove / switch ───────┴──── error ◄───┘
needsAccount  (pyannote only)
```

- Speakrs `downloading` = model pack + Windows ORT archive; progress on `ai-addon-progress`.
- Speakrs `validating` = `python -m diarization.diarization_pipeline --validate-setup --engine speakrs` (no `--token-stdin`), same `createAbortableComputeAction` + `addonValidation` timeout. JS must not spawn `speakrs-cli` directly.
- Speakrs `ready` = CLI present + pack complete (existence/size always; sha256 at setup/validate; fingerprint-skip on later polls).

---

## Model pack strategy

**Distribution: repacked, self-hosted archives (one per platform), sha256-pinned — not per-file HF downloads.** Reasons: CoreML `.mlmodelc` are directory bundles (per-file HF fetch is fragile), upstream repo has no LICENSE file (we inject a `LICENSES/` directory + `ATTRIBUTION.md`), and self-hosting removes the upstream-deletion risk for a bus-factor-1 project.

- Repack script: `scripts/build-speakrs-model-pack.js` (or `.py`) — pulls `avencera/speakrs-models` at the pinned revision, selects the per-mode file set (from Task 0's recorded list), injects `LICENSES/` (MIT segmentation-3.0, CC-BY-4.0 wespeaker + community-1 params, Apache-2.0 speakrs) and `ATTRIBUTION.md`, produces `speakrs-models-<rev7>-win32-x64-cuda.tar.gz` and `speakrs-models-<rev7>-darwin-arm64-coreml.tar.gz`, prints sha256s for the catalog.
- Hosting: our GitHub Releases (same trust surface as llama.cpp archives; hosts already allowlisted). Windows ORT archive is a **separate** pin: ORT 1.27.1 cuda12 + `cudart64_12` + `cufft64_11` only (no TensorRT/PDBs). Extract to `userData/ai-addons/runtimes/speakrs-ort/`. 0b measured **220 MB** runtime-complete CUDA pack + **603 MB** ORT archive = **823 MB** — setup-time download, do not bundle.
- Cache layout: `userData/ai-addons/models/diarization/speakrs/<revision>/` (extract root). Pack file list = `required_files(Cuda)` **plus** runtime extras `wespeaker-voxceleb-resnet34-tail.onnx` (+ optional `-b3`/`-b32` tails). Mac pack = 0a CoreML list (419.5 MB).
- Extraction through existing zip/tar workers + `ai-addon-archive-helpers.js` traversal guards (accept `.mlmodelc` nested directories).

---

## Implementation Phases

### Task 0: Spike (go/no-go gate — measurable)

**Files:**
- Create: `native/speakrs-cli/` (thin Cargo wrapper — **do not** copy `examples/diarize_wav.rs` as-is; that example is CPU-only)
- Create: `docs/development/SPEAKRS_SPIKE_NOTES.md` (results tables only)

**Done.** 0a Mac tables + 0b Windows CONDITIONAL GO are in `docs/development/SPEAKRS_SPIKE_NOTES.md`. Do not re-run the spike. ORT pin is **1.27.1 cuda12**, not 1.24. Windows exe 19.47 MB; CUDA pack 220 MB; ORT archive 603 MB; CLI RSS 1.39 GB / combined 1.40 GB on 82 min.

**Steps:**
1. rustup **1.88+** (edition 2024). Confirm a C toolchain (Xcode CLT on Mac). If `default-linalg` / OpenBLAS fails to compile, **stop and ask** — do not improvise a BLAS.
2. Depend on speakrs **0.5.0** with `default-features = false` and `features = ["default-linalg", "coreml"]` (0a) / `["default-linalg", "cuda", "load-dynamic"]` (0b). Confirm `online` is off (`from_pretrained` / `ModelManager` must not compile).
3. Build a thin CLI: decode 16-bit PCM WAV → f32, `OwnedDiarizationPipeline::from_dir`, **`ExecutionMode::CoreMl` on Mac / `Cuda` on Windows** (and the matching `-fast` mode for the info table only). Record binary sizes **with** static OpenBLAS/MKL and the exact link/runtime requirements.
4. Windows (0b): on a machine that **already runs current pyannote CUDA**, with ONLY the app's existing cuda12 pip DLLs (cublas/cudnn) on PATH plus a candidate ORT 1.24 GPU archive, enumerate the full DLL closure with the Dependencies tool until the CLI runs on GPU. Record every DLL and its source. Record the NVIDIA **driver** version that worked. Do not mutate the cuda12 pip profile.
5. Record, per mode (`coreml`, `cuda`, and both `-fast` variants for comparison): the exact file list from `src/models.rs` `required_files(...)` **copied from source**, per-file sizes, per-mode pack totals. Do not enable `online` to call `ModelManager`.
6. Run ≥ 3 internal meetings (one ≥ 60 min, one with heavy overlap, one 2-speaker) + a **pinned** 10-file VoxConverse dev subset (write the IDs in the notes) through both speakrs (exclusive segments) and current pyannote on the same hardware. Private corpus stays out of git.
7. Confirm there is no speaker-count API; record **auto-only** unless a real knob is found.
8. Measure cold-start latency (model load) per mode. Measure peak RSS of the **CLI child** and of **Python+CLI combined** on the 60+ min meeting.

**Go criteria (ALL must hold after 0b; 0a only fills Mac columns):**
- DER within **+1.0 absolute** of pyannote on the pinned VoxConverse subset (collar 0 **and** 250 ms). This is a smoke gate, not a publishable claim (n=10).
- Human A/B: 0a may use **1 reviewer × 50 turns**. Wrong-speaker count vs pyannote on those turns must be **≤ +2**. Two-reviewer A/B is a **Task 7** cutover bar, not a 0a blocker.
- Diarization RTFx ≥ **2×** pyannote on the same hardware for the medium meeting, per platform. Exclude cold-start from RTFx; record cold-start separately.
- Peak **CLI** RSS ≤ **4 GB** for the 60+ min meeting **and** combined Python+CLI RSS recorded (combined OOM is a NO-GO even if CLI-only is under 4 GB).
- Windows GPU run succeeds with cublas/cudnn from the existing pip profile + the candidate ORT archive (documented closure, no pip profile mutation) on a box that already runs pyannote CUDA.
- 60+ min meeting completes well inside `AI_COMPUTE_TIMEOUT_MS.diarization` (30 min) — sanity only.
- Pack totals are recorded. > 600 MB does **not** fail GO; write the escalate-or-not decision in the notes.

**Validation:** `SPEAKRS_SPIKE_NOTES.md` contains the tables (file, duration, speakers, engine, mode, DER both collars, seconds, RTFx, cold-start, CLI RSS, combined RSS) + DLL closure + pack lists. Explicit GO/NO-GO line only after 0b.

---

### Task 1: `speakrs-cli` binary + JSON contract (+ characterization pre-work)

**Files:**
- Create: `native/speakrs-cli/Cargo.toml`, `native/speakrs-cli/src/main.rs`, `native/speakrs-cli/rust-toolchain.toml` (pin ≥ 1.88), vendored deps policy (`cargo vendor` or lockfile-only — decide by CI network policy)
- Create: `tests/python/test_speakrs_cli_contract.py` (fixture-JSON parse tests; real-binary smoke marked skip-if-absent)
- Create: `tests/fixtures/` short 2-speaker WAV (~15 s, self-recorded or synthetic TTS — no third-party license)

**Contract (frozen here):**
- argv: `speakrs-cli <wav-path>`; env: `SPEAKRS_MODELS_DIR` (required), `SPEAKRS_MODE` (`cpu|coreml|cuda`, required), `SPEAKRS_EXCLUSIVE` (`1` default), `SPEAKRS_NUM_SPEAKERS` (optional int; omit unless Task 0 found a real knob — default is auto-only).
- stdout: exactly one JSON object: `{"success": true, "device": "<mode>", "annotationSource": "exclusive_speaker_diarization"|"speaker_diarization", "segments": [{"start": f, "end": f, "speaker": "SPEAKER_00"}, ...]}` — map exclusive → `exclusive_speaker_diarization` (today's sidecar value; do not invent `"exclusive"`/`"discrete"`). Speaker labels keep the `SPEAKER_NN` convention so `speaker_segments._speaker_label_map` works unchanged. Failure: `{"success": false, "error": "<single-line message>"}` + non-zero exit.
- stderr: human diagnostics only; Python never parses it for control flow.
- Exit promptly on SIGTERM/CTRL-BREAK (no orphaned inference).
- Implementation: decode 16-bit PCM WAV → f32, `OwnedDiarizationPipeline::from_dir(models, mode)`, `run()`, clone `discrete_diarization`, `make_exclusive()` when `SPEAKRS_EXCLUSIVE=1`, `to_segments()`, serialize.
- **Network policy: the CLI must be incapable of downloading.** Build with `default-features = false` so `online` is compiled out, **and keep `default-linalg`**. Mac features: `["default-linalg", "coreml"]`. Windows: `["default-linalg", "cuda", "load-dynamic"]`. Model loading is `from_dir` + `SPEAKRS_MODELS_DIR` only; a missing/incomplete models dir is a structured `success:false` error telling the user to re-run speaker setup — never a download. Verify with a test that the binary has no HF host strings (`huggingface`, `avencera/speakrs-models`) baked in (`strings` grep in CI is acceptable).

**Validation:** `cargo test` + `cargo clippy -D warnings` in the crate; `npm run test:python` (contract fixture tests); manual run against the spike models.

---

### Task 2: Model pack repack + catalog pins (token-free setup)

**Files:**
- Create: `scripts/build-speakrs-model-pack.js`
- Modify: `src/ai-addon-state.js` — both catalog entries live forever on this branch. **No compile-time `DIARIZATION_ENGINE` flip.** Persist `features.diarization.engine` (`speakrs` | `pyannote`). New/unset → `speakrs`. Legacy pyannote `modelId` → `pyannote`. QA env `AVANEVIS_DIARIZATION_ENGINE` is spawn-only. Target speakrs catalog shape (mirror `SUMMARY_RUNTIME_ARTIFACTS`; sha256/size from the repack script):

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
- Modify: `src/ai-addon/manifest-store.js` — engine-aware cache/status **inside existing functions** (`checkAiAddonSetupStatus`, `deriveDiarizationStatus`). Do **not** export a new `checkSpeakrsModelCache` from `src/ai-addon-setup.js` (facade key set is pinned). Existence/size always, sha256 at setup/validate, fingerprint-skip later. **`setupComplete` must be engine-aware:** speakrs ready = CLI present + pack checksum valid, not `dependencyCache.valid`.
- Modify: `src/ai-addon/diarization-setup.js` — engine branch **before** the token required check at L580–637: speakrs setup = download archives → extract via existing workers → validate; no token calls anywhere on this path. `hasDiarizationLocalState` / `buildDiarizationStorageFootprint` must see speakrs pack bytes (not only pip `dependencyCache`) so Remove and Settings sizes work.
- Modify: `src/ai-addon-state.js` `normalizeDiarizationState` — `engine` field + legacy detection (see Manifest migration). Speakrs catalog `runtime` has no `modelRef`; `getDiarizationModelRef` / guided gates must accept `runtime.type === 'native-cli'` (or the model id) so Task 4 is not dead on arrival.
- Tests: `tests/js/ai-addon-state.test.js`, `ai-addon-setup.test.js` (new: token-free speakrs path reaches `ready` **and `setupComplete: true`** with zero token-store calls; cancel during download removes partials; checksum mismatch → never `ready`; setup `{ engine: 'speakrs' }` while a pyannote tree exists **deletes** the pyannote list first; setup `{ engine: 'pyannote' }` while a speakrs pack exists **deletes** the speakrs list first; never deletes cuda12 pip or Whisper cache; legacy pyannote manifest keeps `engine: 'pyannote'`)

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
- Modify: `backend/diarization/diarization_pipeline.py` — add `--engine speakrs|pyannote` (default pyannote for backward compat; JS always passes it explicitly); route `run_pyannote_diarization` call sites through an engine dispatch **before** `assert_required_device_available`; speakrs validate-setup path = runner smoke of the **bundled** fixture WAV without `--token-stdin` and without importing torch
- Modify: `backend/diarization/guided_transcription.py` — same dispatch; **fix the unredacted `ERROR:` print (L492) with `redact_sensitive_text`**
- Tests: extend `tests/python/test_diarization_pipeline.py`, `test_guided_transcription.py`; new `test_speakrs_runner.py`

**`speakrs_runner.py` requirements:**
- Resolve CLI path: `SPEAKRS_CLI_PATH` env (set by JS) → packaged `Resources/bin/speakrs-cli` → dev `native/speakrs-cli/target/release/` → PATH **only when `AVANEVIS_PACKAGED` unset** (Swift-helper rule, `swift_audio_capture.py:82-84` as the template).
- Spawn with: cleared HF token env (reuse the same clearing the JS side sends; belt-and-braces pop in Python too), `SPEAKRS_MODELS_DIR`/`SPEAKRS_MODE`/`SPEAKRS_EXCLUSIVE` set, lowered priority inherited, **and guaranteed child termination**: POSIX — **same process group as Python**, no `start_new_session`; `finally` kills the CLI pid as backup. Windows — inherit default creation flags so Electron's `taskkill /T` reaps the tree; `proc.kill()` in `finally` is backup only. Test with a fake hanging CLI: killing the Python pid (POSIX group / Windows `/T`) must reap the CLI.
- Emit the **same inner** `emit_progress` phases as `run_pyannote_diarization` (`validating-accelerator` 30, `loading-model` 35, `running-model` 55, `merging-speakers` 80). Parents keep `loading-transcript` / `preparing-audio` / `completed` / guided extras. Do not invent a new sequence.
- Parse the CLI's single stdout JSON; map failures to the existing single-line `ERROR:` stderr convention (redacted).
- Return `(speaker_segments, annotation_source, device)` — exactly `run_pyannote_diarization`'s tuple — so `build_diarization_result`, sidecar schema, and merge behavior are untouched.
- Device mapping per the table above (`mps` requirement → `coreml` mode, reported device `coreml`).

**Validation:** `npm run test:python` (all existing diarization tests still green with engine=pyannote default; new speakrs tests with mocked CLI stdout, kill-propagation, redaction).

---

### Task 4: Electron main — spawn plumbing + setup/validation wiring

**Files:**
- Modify: `src/main/transcription-service.js` — `buildManagedDiarizationArgs` / `...GuidedTranscriptionArgs` append `--engine` from **manifest `features.diarization.engine`** (QA env may override spawn only); speakrs env block (`SPEAKRS_CLI_PATH`, `SPEAKRS_MODELS_DIR`, `SPEAKRS_MODE`, Windows `PATH` prepend for `userData/ai-addons/runtimes/speakrs-ort/` — alongside existing `buildCudaRuntimeEnv` for cublas/cudnn, **without** `includeManagedDiarization`); skip `getDiarizationCacheEnv()` HF vars for speakrs (keep for pyannote); `resolveGuidedDiarizationStatus` must **not** require `runtime.modelRef` / pip `setupComplete`
- Modify: `src/main/ai-addon-ipc.js` — validation spawn for speakrs: no `--token-stdin`, no token resolution, no stdin token write, same `createAbortableComputeAction` + `addonValidation` timeout; keep token channels registered (legacy path) but never called on the speakrs path. Do **not** change the shared pyannote `buildManagedDiarizationValidationArgs` unconditionally — privacy tests still assert `--token-stdin` on that path; branch by engine.
- Modify: `src/main.js` — `buildManagedDiarizationValidationArgs` engine branch; resolve packaged CLI path (`process.resourcesPath/bin/speakrs-cli[.exe]`)
- Tests: `tests/js/ai-addon-privacy-hardening.test.js` (extend: speakrs validation spawns with cleared HF env and NO stdin token write; existing token-stdin test stays green for pyannote), `transcription-queue-helpers` characterization, ipc snapshot / facade key sets unchanged this task (no channel or facade-export changes)

**Validation:** `npm test`; dev-mode end-to-end: record → guided transcription with speakrs → `*.speakers.json` schema-identical (diff against a pyannote run of the same audio apart from `model`/`device` fields); wall-clock kill test leaves no orphaned `speakrs-cli`.

---

### Task 5: Renderer selector + exclusive switch

**Files:**
- Modify: `src/renderer/index.html`, `src/renderer/app.js` — Settings (and first-time speaker prompt) show **two cards**: Speakrs / Pyannote. Mac Speakrs gets a `Recommended` badge. Copy from the Dual-engine selector table. Selecting a card + Setup calls `setupDiarization({ engine })`. If the other engine is installed, show the confirm dialog first.
- Modify: `src/renderer/history-detail-helpers.js`, `src/renderer/ai-addon-ui-helpers.js` — hide token UI unless `engine === 'pyannote'`; hide speaker-count for speakrs; `shouldShowSpeakerSetupPrompt` Windows CUDA gate unchanged; new-user prompt sets up **speakrs**.
- Modify: `src/renderer/formatters.js` — `needsAccount` label stays (pyannote path).
- Modify: `src/main/ai-addon-ipc.js` + `src/ai-addon/diarization-setup.js` — `options.engine` on `setup-diarization`; exclusive delete of the other tree **before** download; `remove-diarization-setup` deletes the active engine only (lists in Dual-engine selector). Guards: reject while setup/compute/preload/runtime pending.
- Modify: `src/main/transcription-service.js` and/or `src/ai-addon/manifest-store.js` — **packaged missing bundled CLI preflight.** Task 4 already fail-closes (pins `SPEAKRS_CLI_PATH` to `Resources/bin/speakrs-cli[.exe]`, no PATH fallback). If that file is absent, reject **before** Python spawn with a concise user-facing error: the app install is incomplete and they should reinstall AvaNevis. **Do not** tell them to re-run speaker setup (setup cannot restore the bundled binary). Do not surface a Python `FileNotFoundError` or traceback. Reuse the same copy from `cliPresent: false` / Speakrs card status. Task 6 still fails the **build** when the binary is missing; this is the in-app backstop for a broken packaged install.
- Modify: `tests/manual/local-ai-addons-checklist.md` — selector, switch (both directions), Remove, token-hidden-for-speakrs, shared CUDA survives switch, packaged-missing-CLI copy (reinstall, not re-setup).
- Tests: `history-detail-helpers.test.js`, `ai-addon-ui-helpers.test.js`, setup tests for exclusive delete; a focused test that packaged missing CLI yields the user-facing error (not a Python traceback).

**Validation:** `npm test`; manual: install speakrs → switch to pyannote → speakrs dir gone, token prompt shown; reverse; Remove; `nvidia-cublas` still present.

---

### Task 6: Build / CI / release packaging

**Files:**
- Modify: `build/prepare-resources.js` — `buildSpeakrsCli()` mirroring `buildSwiftHelper()` (cargo build --release with the Task 1 feature flags → stage to `build/resources/bin/` → strip → macOS codesign with `entitlements.mac.inherit.plist`); add build-input fingerprints to `resource-manifest.json` invalidation. Stage the **validation fixture WAV** next to the CLI or under `backend/diarization/fixtures/` so packaged `--validate-setup --engine speakrs` can find it. `ort` compile-time downloads must be pinned/vendored here or in the crate — **not** via `download-manifest.js`.
- Modify: `package.json` — `extraResources` already maps `build/resources/bin` → `bin`; add `Contents/Resources/bin/speakrs-cli` to mac `binaries` signing list beside `audiocapture-helper`. Include the fixture WAV in extraResources if it is not already under `backend/**/*.py` (it will not be — add an explicit resource entry).
- Modify: `.github/workflows/ci.yml` — Rust toolchain (pinned via `rust-toolchain.toml`) + cargo cache on `windows-latest` and `macos-14` jobs; `cargo test`; **CPU-mode end-to-end smoke**: cache the small ONNX subset, run `speakrs-cli` on the fixture WAV, assert ≥ 1 segment (this is real-inference CI coverage pyannote never had). Prove `cuda,load-dynamic` **compiles** on `windows-latest` without a CUDA toolkit (link-only); do not claim CI covers CUDA/CoreML inference.
- Modify: `.github/workflows/build-release.yml` — build + stage CLI per platform; fail release on missing binary or pack checksum mismatch
- Update `AGENTS.md` only with: speakrs is a **user-selectable** engine; exclusive install; Windows ORT 1.27.1 pin; do not claim Windows speed/DER win. Do **not** delete pyannote token rules.
- Modify: `docs/development/LOCAL_AI_MODEL_CATALOG.md` — add speakrs pack-pin rules (revision, sha256, per-mode file lists, repack script usage) **alongside** the still-live pyannote rules until Task 8.

**Validation:** `npm run prepare-build` stages the binary; packaged smoke (both CI jobs) asserts `bin/speakrs-cli` present and codesigned (mac); `npm run test:all`.

---

### Task 7: Soak + benchmarks (no cutover flip)

- Run on **merged** Task 1–6 builds. Users pick the engine. New installs default speakrs; existing pyannote users stay until they switch.
- **README (same release that first ships the selector):** app-wide stay **8 GB recommended**. **Speaker identification:** **8 GB min / 16 GB recommended** (Mac CLI 3.81 GB; Windows 1.39 GB). Disk: call out Windows speakrs+ORT **~823 MB** vs pyannote **~2–4 GB**. Do not promise 4 GB machines this add-on.
- Record matrix in `docs/development/SPEAKRS_BENCHMARKS.md`.
- **Ship bar (all):** ≥ 25 meetings (≥10/OS) guided, zero engine crashes; 2×50-turn A/B speakrs not worse than **+2** vs pyannote on **Mac** (Windows A/B is informational — 0b already showed a DER gap); selector/switch/remove checklist green on packaged Windows CUDA + macOS AS; characterization suites green.
- Rollback: users switch back to pyannote (re-download). No catalog-constant flip.
- **Closed 2026-08-14** from Mac packaged CoreML guided smoke + Windows CUDA guided smoke. Original ≥25-meeting / 2×50-turn bars were not fully executed. Known quality misses stay in `docs/development/SPEAKRS_BENCHMARKS.md`. Pyannote remains selectable. No silent cutover.

#### Mac soak findings (2026-08-14) — facts, not guesses

Two same-morning in-room + YouTube clips, Whisper `medium` / `mps`. Sidecars only; no transcript text in this plan.

| Clip | Duration | Engine | `device` | sidecar `speakerCount` |
|------|----------|--------|----------|------------------------|
| 10:19 | 26 s | pyannote community-1 | `mps` | **2** |
| 10:22 | 35 s | speakrs-community1-vbx | `coreml` | **3** |

Speakrs exclusive turns were `SPEAKER_00` / `SPEAKER_01` / `SPEAKER_02`. Merge relabels those in index order to `Speaker 1` / `Speaker 2` / `Speaker 3`, so a phantom `SPEAKER_00` pushes the two real talkers onto **Speaker 2 and Speaker 3**. One in-room turn was also assigned the YouTube speaker’s label (split identity). Speed was fine (CoreML). This is a clustering miss, not a crash, and it is exactly the Task 7 A/B risk (plan risk #4). Do **not** add a Speakrs speaker-count CLI flag — 0.5.0 has none. Next measurement: pyannote vs Speakrs on the **same** 10:22 audio, then the 2×50-turn Mac bar.

**Selector UX (blocking):**

1. Switching is select-card-then-**Set Up**. When the other engine is installed, the button must read **Switch model** (product copy, v5).
2. After Speakrs was Ready, the soak **could not switch back to Pyannote**. Unit test `switching the selected engine re-enables Set Up while the other engine is ready` already expects `canConfigure: true` for `selectedEngine: 'pyannote'` on a ready Speakrs feature. Reproduce in the packaged Settings UI. If Set Up stays disabled, `selectedEngine` is not reaching `buildAiAddonControlState`. If it is enabled but setup no-ops/errors, log the confirm + token path (Pyannote still needs a token after exclusive delete).
3. Hugging Face token and Speakers dropdown stayed visible on Speakrs. Helpers already return false for speakrs (`shouldShowDiarizationTokenUi` / `shouldShowDiarizationSpeakerCount`) and JS sets `hidden`. **Root cause:** `src/renderer/styles.css` `.ai-addon-field { display: flex }` overrides the UA `[hidden] { display: none }` (same pattern already fixed for `.recording-presence[hidden]`). Speakrs stays auto-only; Pyannote keeps Auto / 2–6.

### Task 7a: Selector UX + Mac quality follow-up (blocking ship bar)

Do this **before** calling Task 7 checklist green. Still no Task 7 default flip. Still no Task 8.

**Files:**

- Modify: `src/renderer/styles.css` — `.ai-addon-field[hidden] { display: none; }` (and compact if needed) so token + speaker-count actually hide.
- Modify: `src/renderer/ai-addon-ui-helpers.js` — `getDiarizationSetupButtonLabel({ selectedEngine, installedEngine, hasOtherEngineLocalState })` → `'Switch model'` when `shouldConfirmDiarizationEngineSwitch`, else `'Set Up'`.
- Modify: `src/renderer/app.js` — apply that label on Settings + Home; selecting the other card must enable the button. Reproduce Speakrs→Pyannote in packaged Settings and fix whatever kept soak from switching (control state, confirm, or token gate). Do not auto-start setup on card click.
- Modify: `tests/js/ai-addon-ui-helpers.test.js`, `tests/js/history-detail-helpers.test.js` — pin label + hidden fields; keep the existing `canConfigure` switch test and add a UI-level assertion that the Settings button text flips.
- Modify: `tests/manual/local-ai-addons-checklist.md` — Switch model label; token/speaker-count hidden **visually** (not just `hidden=` attribute); Speakrs→Pyannote on a Ready Speakrs install.
- Quality (no code until the same-audio A/B is logged): run pyannote on the 10:22 clip (or a new paired recording). If Speakrs is still ≥1 extra speaker or split-identity on the in-room talker, record it in `docs/development/SPEAKRS_BENCHMARKS.md` and keep pyannote selectable. Do not invent a Speakrs `--speaker-count`.

**Validation:** `npm test`; packaged Mac: Speakrs selected → no token field, no Speakers dropdown; Pyannote selected → both visible; Ready Speakrs → select Pyannote → button reads **Switch model** and is enabled → confirm → token prompt → Speakrs pack gone. Same-audio A/B note in the benchmarks file.

**Closed 2026-08-14:** Switch-model label, `.ai-addon-field[hidden]`, and `canSelectEngine` radio restore landed. Soak could not switch Speakrs→Pyannote because `setAiAddonControlsDisabled(true)` never re-enabled engine radios after a successful setup. Later the same day: leftover progress no longer locks the overall Downloading badge; Pyannote→Speakrs **keeps** the Hugging Face token for switch-back (Remove still deletes it). Windows substitute A/B plus the 11:17 CUDA soak split-identity note are in `docs/development/SPEAKRS_BENCHMARKS.md`. Do not invent `--speaker-count`.

### Task 8: pyannote removal — **PARKED**

Do **not** implement. Pyannote stays a first-class selectable engine. Revisit only if product later drops it. Never on `feature/speakrs-diarization`.

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
3. **Hybrid: speakrs-Mac / pyannote-Windows only** — retired. DLL closure passed. v4 selector lets Windows users pick pyannote when they want the quality/speed win.
4. **sherpa-onnx diarization (k2-fsa / Next-gen Kaldi)** — Apache-2.0, mature multi-year project, prebuilt binaries for every platform, already redistributes the pyannote segmentation model with clean attribution. The catch: its diarization is segmentation + embedding + simple clustering (no VBx/PLDA), so accuracy is a clear step below community-1/speakrs on hard meeting audio. It is the "boring and reliable" plan C if speakrs is abandoned upstream — and its model-hosting/attribution practice is the template for our Task 2b regardless.
5. **`diarize` (FoxNoseTech, CPU-only ONNX)** — Apache-2.0, easy Python drop-in, but violates the accelerator-only policy and gives up the speed win; also young. Only relevant if a CPU policy change happens independently.
6. **NVIDIA NeMo Sortformer** — CUDA/Windows-only, weak macOS story, historical speaker-count limits, heavyweight stack. Not a fit.

---

## Top risks (post-review)

| # | Risk | Mitigation |
|---|------|------------|
| 1 | Model-pack redistribution: upstream repo has no LICENSE file; params extracted from community-1 | Repack with LICENSES/ATTRIBUTION per the Task 2b self-serve checklist (sherpa-onnx precedent); gates public release, not development |
| 2 | Windows ORT CUDA DLL closure vs existing cuda12 pip profile (cu126 torch + cublas/cudnn only) | Task 0b proves the closure on a box that already runs pyannote CUDA; ORT+cudart+cufft ship in our pinned archive; never mutate the shared transcription pip profile |
| 3 | Young single-maintainer crate + ORT rc pin | Exact-version pin + vendored deps; our CLI is the only API surface; pyannote remains user-selectable; self-hosted models |
| 4 | Real-meeting parity (overlap, exclusive boundaries feeding guided windows) unproven vs VoxConverse claims | Task 0 DER smoke + 1-reviewer A/B; Task 7 2-reviewer bar; `-fast` modes excluded from defaults |
| 5 | Contract breakage during surgery (IPC snapshot, status enum, privacy tests, sidecar schema, facade exports) | Characterization-first: pin field sets not argv; no new facade keys; `needsAccount`/token IPC stay for pyannote |
| 6 | `setupComplete` + `getDiarizationModelRef` silently skip speakrs | Task 2 makes both engine-aware before any spawn plumbing |
| 7 | POSIX `start_new_session` orphans the CLI | Same process group as Electron's Python child; no new session |
| 8 | `default-features = false` without BLAS fails to build; static MKL inflates the Windows exe | Always keep `default-linalg`; Task 0 records binary size |

**Single best next engineering action:** Task 1 — freeze `speakrs-cli` to the JSON contract + fixture WAV + tests. Selector work starts in Task 2 (manifest `engine`) and Task 5 (UI + exclusive delete).

---

## Ordered execution summary

1. ~~Task 0a / 0b / 1 pre-step~~ **done** (CONDITIONAL GO + characterization)
2. Task 1 CLI + frozen JSON contract + fixtures
3. Task 2 pack + catalog + manifest `engine` (new default **speakrs**; legacy pyannote kept) ∥ Task 2b legal
4. Task 3 Python `--engine` dispatch
5. Task 4 main-process plumbing
6. Task 5 selector UI + exclusive switch/delete
7. Task 6 build/CI/release (merge; both engines selectable)
8. ~~Task 7 soak + README RAM (no flip)~~ **closed 2026-08-14** (Mac packaged + Windows CUDA smoke; volume/A/B bars not fully executed)
9. ~~Task 7a selector UX~~ **closed 2026-08-14**
10. Task 8 parked
