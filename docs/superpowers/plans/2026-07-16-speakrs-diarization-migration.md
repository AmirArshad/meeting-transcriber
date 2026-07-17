# Speakrs Diarization Migration Plan

> **For agentic workers:** Execute inline by default. Use a subagent only when the user requests it or the task crosses high-risk platform/process boundaries. This document is a research + implementation plan — do not cut over production until Phase 0 spike criteria pass.

**Goal:** Replace gated `pyannote/speaker-diarization-community-1` (HF token + PyTorch) with `speakrs` for faster local diarization, zero end-user tokens, and easier Electron distribution — while keeping AvaNevis’ existing speaker-segment JSON / guided-transcription contracts.

**Architecture:** Keep Python as the orchestration layer (16 kHz mono prep, Whisper windowing, sidecars, progress JSON). Run speakrs as a **bundled native CLI** (same pattern as `audiocapture-helper` / `llama-cli`), not as an in-process PyO3 wheel for v1. Models come from public `avencera/speakrs-models` (pinned revision + SHA-256), cached under `userData/ai-addons/models/diarization`, loaded offline via `SPEAKRS_MODELS_DIR` / `from_dir`.

**Tech Stack:** speakrs 0.5.x (Rust, Apache-2.0), ONNX Runtime / CoreML / CUDA, existing `backend/diarization/*`, catalog pins in `src/ai-addon-state.js`, Electron compute queue unchanged.

## Global Constraints

- Free/OSS: speakrs Apache-2.0; model artifacts inherit upstream CC-BY-4.0 attribution obligations (commercial use allowed; cite pyannote/WeSpeaker in Legal Notices).
- No per-user Hugging Face accounts or tokens for diarization setup or runtime.
- Offline after first model download (or fully bundled models in packaged builds).
- Windows + macOS Apple Silicon at minimum; preserve guided transcription (diarize → padded turns → Whisper).
- Keep stdout/stderr contracts: structured progress on stderr, result JSON on stdout; never log tokens/transcript text in progress.
- Preserve sidecar shape used by History / merge helpers (`speakerSegments`, merged `segments`, `*.speakers.json`).
- Serialize GPU-heavy work through `aiComputeActionQueue` (unchanged).
- Product default remains accelerator-first (`cuda` / `coreml`); CPU mode is a spike option only if RTF and UX justify it.

---

## Research Snapshot (speakrs as of 2026-07)

| Item | Finding |
|------|---------|
| Crate | [`speakrs` 0.5.0](https://crates.io/crates/speakrs) — Apache-2.0, MSRV **1.88**, edition 2024 |
| Docs | https://docs.rs/speakrs/latest/speakrs/ |
| Models | Public HF repo [`avencera/speakrs-models`](https://huggingface.co/avencera/speakrs-models), SDK pin `5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f` |
| Python bindings | **None official.** Docs: “no Python runtime in the library path.” |
| Input | Mono **16 kHz** `f32` samples (examples use 16-bit PCM WAV → f32) |
| Output | Segments / RTTM; `discrete_diarization.make_exclusive()` ≈ pyannote exclusive diarization |
| macOS accel | Native **CoreML** (`coreml` / `coreml-fast`) — not PyTorch MPS |
| Windows accel | ONNX Runtime **CUDA** (`cuda` / `cuda-fast`) |
| Claimed perf (VoxConverse dev) | CoreML ~529× RTFx @ 7.1% DER vs pyannote MPS ~24× @ 7.2%; CUDA ~59× vs pyannote ~32× |
| Risk flags | `ort` 2.0.0-rc.12 still pre-release; CoreML asset set is large; no first-party CLI crate yet (examples only) |

### Recommended integration shape for AvaNevis

```
Renderer / IPC (unchanged channels)
        ↓
transcription-service / ai-addon-ipc
        ↓
Python: guided_transcription / diarization_pipeline
        ↓  prepare 16 kHz mono WAV (existing audio_prep)
        ↓
spawn: Resources/bin/speakrs-cli  (NEW native helper)
        ↓  SPEAKRS_MODELS_DIR=...  --mode coreml|cuda|cpu
        ↓  stdout JSON: { segments: [{start,end,speaker}, ...] }
        ↓
Python: merge_speaker_labels / guided windows / Whisper
```

**Why CLI over PyO3/maturin for v1**

1. Matches existing packaging of Swift helper + llama.cpp binaries.
2. Avoids shipping a maturin wheel against the bundled Python ABI on Windows/macOS.
3. Crash isolation: a Rust panic does not take down the Electron Python child unexpectedly mid-import.
4. speakrs examples already demonstrate the exact WAV → segments / exclusive assignment flows we need.

PyO3 remains a Phase-later option if IPC overhead or process spawn cost becomes measurable on short clips.

---

## Pros / Cons vs Current pyannote Setup

| Dimension | Current (`pyannote` community-1) | `speakrs` |
|-----------|----------------------------------|-----------|
| **Accuracy** | Baseline (~7–11% DER on VoxConverse) | Matched in published benches (within ~0.1–0.4% DER) |
| **Speed** | Slow on MPS (~24×); moderate on CUDA (~18–32×) | Much faster (CoreML hundreds×; CUDA ~2× pyannote in published tables; `*-fast` even higher) |
| **Memory** | Large PyTorch + pyannote.audio dependency tree in `userData` | Smaller runtime (ORT/CoreML + Rust binary); models still multi‑hundred MB especially CoreML |
| **Ease of use** | HF account, gated accept, `safeStorage` token, setup validation with `--token-stdin` | No token; setup = download + smoke CLI run |
| **Distribution** | Heavy pip deps per platform (`DIARIZATION_DEPENDENCY_ARTIFACTS`); gated model | Ship CLI + pinned model pack; drop pyannote pip stack for diarization |
| **macOS path** | PyTorch MPS only; CPU forbidden | CoreML native; may eventually allow CPU as soft fallback |
| **License UX** | Gated HF + CC-BY-4.0 | Library Apache-2.0; models still need CC-BY-4.0 attribution (no gate) |
| **Maturity** | Battle-tested in our app | Young crate (2026), ORT RC, we must own the CLI wrapper |
| **Exclusive diarization** | First-class `exclusive_speaker_diarization` | `make_exclusive()` in examples — verify parity on meeting audio |
| **Speaker count hint** | `num_speakers` supported | Confirm `PipelineConfig` knobs expose equivalent; otherwise keep auto only |

**Verdict:** Strong primary candidate for the product goals (speed + zero tokens + distributability). Blockers are engineering/packaging (CLI, CI Rust builds, model pin sizes, legal attribution), not “speakrs cannot do the job.”

---

## File Map (planned)

| Path | Role |
|------|------|
| `native/speakrs-cli/` (new) | Thin Rust binary wrapping `OwnedDiarizationPipeline`; JSON stdout contract |
| `build/download-manifest.js` | Pin speakrs-cli + model archive URLs/SHA-256 |
| `build/prepare-resources.js` | Stage `bin/speakrs-cli` (+ optional bundled models) |
| `src/ai-addon-state.js` | Replace pyannote catalog entry; remove tokenKey; add speakrs model/runtime pins |
| `src/ai-addon/diarization-setup.js` | Token-free download/validate/remove |
| `src/main/ai-addon-ipc.js` | Drop token IPC eventually; keep status/setup/validate/remove |
| `src/main/transcription-service.js` | Spawn env: `SPEAKRS_MODELS_DIR`, mode, CLI path |
| `backend/diarization/speakrs_runner.py` (new) | Spawn CLI, parse JSON, map device names |
| `backend/diarization/diarization_pipeline.py` | Swap `run_pyannote_*` → speakrs runner; keep merge/result builders |
| `backend/diarization/guided_transcription.py` | Call speakrs for turns; keep Whisper windowing |
| `backend/diarization/speaker_segments.py` | Keep; reuse for Whisper alignment |
| `docs/development/LOCAL_AI_MODEL_CATALOG.md` | Catalog maintenance rules without HF token |
| `tests/js/ai-addon-*.test.js`, `tests/python/test_*diariz*` | Characterization for token-free setup + JSON contract |
| Legal notices | CC-BY-4.0 attribution for community-1-derived weights |

---

## Sample Integration Code

### A. Rust CLI contract (`native/speakrs-cli` sketch)

```rust
// Pseudocode — production CLI should pin speakrs = "0.5" with platform features.
use speakrs::{ExecutionMode, OwnedDiarizationPipeline};
use serde_json::json;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let models = PathBuf::from(std::env::var("SPEAKRS_MODELS_DIR")?);
    let wav = PathBuf::from(std::env::args().nth(1).expect("wav path"));
    let mode = parse_mode(std::env::var("SPEAKRS_MODE").unwrap_or_else(|_| "cpu".into()));
    let exclusive = std::env::var("SPEAKRS_EXCLUSIVE").unwrap_or_else(|_| "1".into()) == "1";

    let audio = load_mono_16k_f32(&wav)?; // same as speakrs examples
    let mut pipeline = OwnedDiarizationPipeline::from_dir(&models, mode)?;
    let result = pipeline.run(&audio)?;

    let mut discrete = result.discrete_diarization;
    if exclusive {
        discrete.make_exclusive();
    }
    let segments: Vec<_> = discrete
        .to_segments()
        .into_iter()
        .map(|s| json!({"start": s.start, "end": s.end, "speaker": s.speaker}))
        .collect();

    println!("{}", json!({
        "success": true,
        "device": format!("{:?}", mode).to_lowercase(),
        "annotationSource": if exclusive { "exclusive" } else { "discrete" },
        "segments": segments,
    }));
    Ok(())
}
```

### B. Python orchestrator (align with Whisper segments)

```python
# backend/diarization/speakrs_runner.py (illustrative)
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .speaker_segments import merge_speaker_labels


def run_speakrs_diarization(
    prepared_wav: Path,
    *,
    cli_path: str,
    models_dir: str,
    mode: str,  # "cuda" | "coreml" | "cuda-fast" | "coreml-fast" | "cpu"
    exclusive: bool = True,
    timeout_s: int = 1800,
) -> Tuple[List[Dict[str, Any]], str, str]:
    env = os.environ.copy()
    env["SPEAKRS_MODELS_DIR"] = models_dir
    env["SPEAKRS_MODE"] = mode
    env["SPEAKRS_EXCLUSIVE"] = "1" if exclusive else "0"
    # Never inherit user HF tokens into this child.
    for key in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        env.pop(key, None)

    proc = subprocess.run(
        [cli_path, str(prepared_wav)],
        capture_output=True,
        text=True,
        env=env,
        timeout=timeout_s,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "speakrs-cli failed")

    payload = json.loads(proc.stdout.strip().splitlines()[-1])
    if not payload.get("success"):
        raise RuntimeError(payload.get("error") or "speakrs-cli returned failure")

    segments = [
        {"start": float(s["start"]), "end": float(s["end"]), "speaker": str(s["speaker"])}
        for s in payload.get("segments") or []
        if float(s["end"]) > float(s["start"])
    ]
    return segments, str(payload.get("annotationSource") or "exclusive"), str(payload.get("device") or mode)


def build_labeled_transcript(
    transcript_segments: List[Dict[str, Any]],
    speaker_segments: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    # Existing AvaNevis merge (dominant overlap + long-segment split).
    return merge_speaker_labels(transcript_segments, speaker_segments)
```

### C. Guided path (unchanged structure)

1. `prepare_diarization_audio` → 16 kHz mono WAV (already matches speakrs).
2. `run_speakrs_diarization` → speaker turns.
3. Existing `normalize_speaker_turns` / padded windows in `guided_transcription.py`.
4. Whisper on windows; save Markdown + `*.speakers.json` via `build_diarization_result`.

---

## Benchmarking Guidance

### Corpus

| Set | Purpose |
|-----|---------|
| **Internal meetings** (5–60+ min, 2–8 speakers, overlap, mic+desktop mix) | Product acceptance |
| **VoxConverse** (dev/test) | Compare to speakrs published DER |
| **AMI / DIHARD subset** (optional) | Stress overlap / speaker count |

Store anonymized fixtures under a private corpus dir (not in git). Keep at least:

- 5 short (≤10 min), 5 medium (10–30), 3 long (45–90)
- Known speaker counts where possible
- Ground-truth RTTM when available; otherwise dual-blind A/B vs current pyannote

### Metrics

| Metric | How |
|--------|-----|
| **DER** | Use speakrs `metrics` module or `pyannote.metrics` offline eval on RTTM; collar 0 ms and 250 ms |
| **JER / speaker count error** | Optional secondary |
| **Wall time / RTFx** | `audio_duration / diarization_seconds` |
| **Peak RSS** | Process memory for CLI child |
| **End-to-end guided latency** | Diarize + Whisper windows vs plain Whisper |
| **Alignment quality** | Spot-check Whisper label accuracy on 50 random turns (human) |

### Platform matrix

| Platform | Mode | Compare against |
|----------|------|-----------------|
| macOS Apple Silicon | `coreml`, `coreml-fast` | current pyannote MPS |
| Windows NVIDIA | `cuda`, `cuda-fast` | current pyannote CUDA |
| Both | `cpu` (spike only) | product gate decision |

### Pass criteria (suggested)

1. DER within **+1.0 absolute** of pyannote on shared internal set (or better).
2. Diarization RTFx ≥ **2×** pyannote on same hardware for medium meetings.
3. Guided transcripts: no increase in “wrong speaker” rate on human sample (or ≤5% relative).
4. Setup completes without any HF token; offline second run works with cache only.
5. 60+ min meeting completes under existing wall-clock timeout (`AI_COMPUTE_TIMEOUT_MS.diarization` / guided budget).

### Minimal harness

```bash
# After CLI exists:
SPEAKRS_MODELS_DIR=./models SPEAKRS_MODE=coreml \
  /path/to/speakrs-cli meeting_16k.wav > out.json

# Time:
/usr/bin/time -l ./speakrs-cli ...   # macOS
# Compare RTTM:
# convert out.json segments → RTTM; score vs ref with pyannote.metrics or speakrs metrics
```

Keep a spreadsheet: file, duration, speakers, engine, mode, DER, seconds, RTFx, peak RSS, notes.

---

## Potential Issues & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| No official CLI / Python package | We own packaging | Ship `speakrs-cli` in-repo; pin crate version; smoke in CI |
| Rust MSRV 1.88 + edition 2024 | CI images may be old | Pin `rustup` toolchain in GitHub Actions; cache cargo |
| `ort` 2.0 RC | Runtime instability | Pin speakrs + ORT; integration tests; keep pyannote behind feature flag until soak |
| Large CoreML bundles | Download size / disk | Platform-specific model packs; pin SHA-256; optional first-run download (like summary models) instead of full installer bloat |
| CUDA ORT vs our CUDA 12 profile | DLL mismatch | Prefer `load-dynamic` ORT; document CUDA deps; reuse existing GPU readiness probes where possible |
| Exclusive diarization parity | Guided quality | Default `make_exclusive()`; A/B vs pyannote exclusive on meetings |
| CC-BY-4.0 attribution | Legal | Add Legal Notices entry; keep licenseUrl in catalog |
| Upstream HF wording (“upstream terms”) | Confusion | Prefer pinned public `speakrs-models` revision; counsel review if redistributing weights in installer |
| Dropping pyannote pip stack | Setup rewrite | Migrate status machine: remove `needsAccount`; keep `notConfigured` → `downloading` → `validating` → `ready` |
| Existing users with HF tokens | Migration | Detect old pyannote manifest → prompt re-setup; ignore stored token; never break transcription-only |
| Long audio memory | OOM | Speakrs loads full mono f32 — monitor 90 min; if needed chunk+stitch (future) |
| CPU policy | Product change | Keep accelerator-required until CPU RTF proven; then optional soft fallback |

---

## Alternatives if Speakrs Has Blockers

| Alternative | License | Token? | Accel | Fit |
|-------------|---------|--------|-------|-----|
| **Stay on pyannote community-1** | CC-BY-4.0 + gate | Yes | CUDA / MPS | Status quo; fails zero-token goal |
| **[diarize](https://pypi.org/project/diarize/) (FoxNoseTech)** | Apache-2.0 | No | CPU-only ONNX | Easiest Python drop-in; good DER claims; **no CUDA/CoreML** — conflicts with current accelerator-only product policy unless we change it |
| **pyannote-rs** | — | Models vary | Lighter Rust | Speakrs docs show much worse DER on VoxConverse subset — **not recommended** as primary |
| **NVIDIA NeMo Sortformer** | NVIDIA terms | No HF gate typically | CUDA only | Windows-only spike; weak macOS; 4-speaker limit historically |
| **WhisperX / NeMo + clustering DIY** | Mixed | Often HF | Mixed | Higher maintenance; reinvent clustering |
| **PyO3 speakrs wheel** | Apache-2.0 | No | Same as speakrs | Fallback if CLI spawn is too awkward; higher packaging cost |

**Fallback ladder**

1. Primary: speakrs CLI + CoreML/CUDA.
2. If Rust packaging blocked short-term: evaluate `diarize` as **CPU** experimental path (product decision required).
3. Keep pyannote behind internal flag until speakrs soak completes — do not dual-ship to end users long-term.

---

## Implementation Phases

### Task 0: Spike (go/no-go)

**Files:**
- Create: `native/speakrs-cli/` (spike, can live outside prepare-resources initially)
- Create: `docs/development/SPEAKRS_SPIKE_NOTES.md` (results table only)

**Implementation:**
- Build speakrs `diarize_wav` / `assign_transcript_speakers` examples on one Mac Silicon and one Windows CUDA machine.
- Download `avencera/speakrs-models` @ pin `5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f`.
- Run 3 internal meetings through exclusive segments; measure RTFx vs current pyannote.
- Confirm model disk footprint per platform.

**Validation:** Spike notes show DER/RTFx and a clear go/no-go. Proceed only if speed ≥2× and quality not worse than +1% DER absolute on the sample set.

---

### Task 1: `speakrs-cli` binary + JSON contract

**Files:**
- Create: `native/speakrs-cli/Cargo.toml`, `native/speakrs-cli/src/main.rs`
- Test: `tests/python/test_speakrs_cli_contract.py` (fixture JSON parse; skip if binary absent)

**Implementation:**
- CLI args: WAV path; env: `SPEAKRS_MODELS_DIR`, `SPEAKRS_MODE`, `SPEAKRS_EXCLUSIVE`.
- Stdout: single JSON object with `success`, `segments`, `device`, `annotationSource`.
- Stderr: human diagnostics only (Python must not parse stderr for control flow).
- Features: macOS `coreml`; Windows `cuda` + `load-dynamic` as needed; both support `cpu` for validation.

**Validation:** `cargo test` in crate; contract test parses fixture stdout.

---

### Task 2: Catalog + model download (token-free)

**Files:**
- Modify: `src/ai-addon-state.js`
- Modify: `src/ai-addon/diarization-setup.js`
- Modify: `docs/development/LOCAL_AI_MODEL_CATALOG.md`
- Test: `tests/js/ai-addon-*.test.js`

**Implementation:**
- New diarization catalog model id e.g. `speakrs-community-1-onnx-coreml` / platform variants.
- Pin archive URL + SHA-256 for model packs (Windows ONNX set vs macOS CoreML set).
- Remove `tokenKey` / `needsAccount` from diarization happy path.
- Cache under `userData/ai-addons/models/diarization/speakrs/<revision>/`.
- Validation = spawn `speakrs-cli` on a short bundled silent/speech fixture with required mode.

**Validation:** `npm test` covering normalize/status; setup reaches `ready` without token APIs.

---

### Task 3: Python backend swap

**Files:**
- Create: `backend/diarization/speakrs_runner.py`
- Modify: `backend/diarization/diarization_pipeline.py`
- Modify: `backend/diarization/guided_transcription.py`
- Test: `tests/python/test_diarization_pipeline.py` (and new runner tests)

**Implementation:**
- Replace `run_pyannote_diarization` call sites with speakrs runner.
- Keep `build_diarization_result`, `merge_speaker_labels`, progress emitters.
- Map devices: Windows `cuda`→`SPEAKRS_MODE=cuda`; macOS `mps` requirement → `coreml` (update user-facing copy from “Metal/MPS” to “Apple Silicon / CoreML”).
- `--validate-setup` becomes CLI smoke without `--token-stdin`.
- Preserve failure policy: guided failure → plain transcript + error metadata.

**Validation:** `npm run test:python`; unit tests with mocked CLI stdout.

---

### Task 4: Electron IPC / UI friction removal

**Files:**
- Modify: `src/main/ai-addon-ipc.js`, `src/preload.js`, `src/renderer/app.js` (token UI)
- Modify: `src/main/transcription-service.js` (env: models dir, cli path)
- Modify: `src/ai-addon-token-store.js` usage sites for diarization only
- Test: renderer/main characterization tests for status machine

**Implementation:**
- Hide HF token fields for speaker setup; deprecate `store-diarization-token` (keep no-op or remove after migration).
- Pass `speakrsCliPath` + `modelsDir` into Python spawns (catalog-owned).
- Update Settings copy / Legal Notices attribution.
- Manifest migration: old pyannote `ready` → force re-setup or auto-migrate if models missing.

**Validation:** `npm test`; manual checklist updates in `tests/manual/local-ai-addons-checklist.md`.

---

### Task 5: Build / CI packaging

**Files:**
- Modify: `build/prepare-resources.js`, `build/download-manifest.js`, `package.json` `extraResources`
- Modify: `.github/workflows/ci.yml` / `build-release.yml`
- Modify: `AGENTS.md` diarization bullets

**Implementation:**
- Cross-compile or native-build `speakrs-cli` on release runners (win x64, mac arm64).
- Stage to `build/resources/bin/speakrs-cli` (+ `.exe`).
- Do **not** call `shutil.which` for speakrs when `AVANEVIS_PACKAGED=1` — only bundled path (same rule as Swift helper).
- Cache cargo; fail release if checksum mismatch.

**Validation:** Packaged smoke installs CLI; `prepare-build` stages binary; CI builds both platforms.

---

### Task 6: Benchmark soak + cutover

**Files:**
- Create: `docs/development/SPEAKRS_BENCHMARKS.md` (results)
- Modify: remove pyannote dependency artifacts from catalog once soak passes
- Update: `todo.md` if used for tracking

**Implementation:**
- Run benchmarking matrix above.
- Feature-flag cutover (`AVANEVIS_DIARIZATION_ENGINE=speakrs|pyannote`) during soak.
- After soak: delete pyannote dependency install path; drop gated model refs; update `FEATURE_SPEAKER_DIARIZATION.md` historical note.

**Validation:** Pass criteria met; `npm run test:all`; manual QA on Windows CUDA + macOS CoreML.

---

## Ordered Execution Summary

1. Spike on real hardware (Task 0) — **decision gate**.
2. Own CLI + contract tests (Task 1).
3. Token-free catalog/setup (Task 2).
4. Backend swap + guided path (Task 3).
5. UI/IPC cleanup (Task 4).
6. Release packaging (Task 5).
7. Soak, then remove pyannote (Task 6).

---

## Self-Review Checklist

| Requirement | Covered by |
|-------------|------------|
| Detailed migration plan | Tasks 0–6 + file map |
| Pros/cons vs pyannote | Pros/Cons table |
| Sample Python (+ CLI) integration | Sample Integration Code |
| Benchmarking guidance | Benchmarking Guidance |
| Issues & mitigations | Potential Issues table |
| Alternatives | Alternatives section |
| Apache-2.0 / free | Global Constraints + license notes |
| Win CUDA + Mac Metal-class accel | CoreML / CUDA modes |
| Whisper alignment | Reuse `merge_speaker_labels` + exclusive turns |
| No HF token / offline | Task 2 + `from_dir` / `SPEAKRS_MODELS_DIR` |
| Electron distributable | CLI packaging Tasks 1 & 5 |

**Placeholder scan:** No TBD implementation steps; spike remains an explicit go/no-go gate before production cutover.

---

## Execution Handoff

Plan path: `docs/superpowers/plans/2026-07-16-speakrs-diarization-migration.md`

Recommended next step: run **Task 0 spike** on Apple Silicon + Windows CUDA with 3 internal meetings before any catalog cutover. Implementation can proceed inline after go/no-go.
