# Speakrs Spike Notes (Task 0)

Tables only. speakrs **0.5.0**. Pin: `avencera/speakrs-models` `5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f`.

Copied from `src/models.rs` (`required_files`, compiled only with `online` — do not enable `online` to call `ModelManager`). Each `.mlmodelc` expands to `model.mil`, `coremldata.bin`, `weights/weight.bin`, `analytics/coremldata.bin`.

## Toolchain (0a)

| Item | Value |
|------|-------|
| rustc | crate pin `1.88.0` via `rust-toolchain.toml` (host also has rustup stable 1.97.1) |
| cargo | 1.88.0 (used for the spike build) |
| host | aarch64-apple-darwin |
| macOS | 26.5.2 (25F84) |
| C toolchain | Apple clang 21.0.0 (Xcode CLT) |
| speakrs features | `default-features=false`, `default-linalg` + `coreml`; `online` off |

## `required_files(CoreMl)` (from source)

**PLDA**

- `plda_lda.npy`
- `plda_tr.npy`
- `plda_mu.npy`
- `plda_psi.npy`
- `plda_mean1.npy`
- `plda_mean2.npy`
- `wespeaker-voxceleb-resnet34.min_num_samples.txt`

**ONNX**

- `segmentation-3.0.onnx`
- `wespeaker-voxceleb-resnet34.onnx`
- `wespeaker-voxceleb-resnet34.onnx.data`
- `segmentation-3.0-b32.onnx`
- `wespeaker-fbank.onnx`
- `wespeaker-fbank-b32.onnx`
- `wespeaker-voxceleb-resnet34-tail.onnx`
- `wespeaker-voxceleb-resnet34-tail-b3.onnx`
- `wespeaker-voxceleb-resnet34-tail-b32.onnx`

**CoreML common `.mlmodelc` trees**

- `segmentation-3.0.mlmodelc`
- `segmentation-3.0-b32.mlmodelc`
- `segmentation-3.0-b64.mlmodelc`
- `wespeaker-fbank.mlmodelc`
- `wespeaker-fbank-b32.mlmodelc`
- `wespeaker-fbank-30s.mlmodelc`
- `wespeaker-multimask-tail-b32.mlmodelc`
- `wespeaker-voxceleb-resnet34-tail.mlmodelc`
- `wespeaker-voxceleb-resnet34-tail-b3.mlmodelc`
- `wespeaker-voxceleb-resnet34-tail-b32.mlmodelc`

**CoreML chunk `.mlmodelc` trees (precise / 1s)**

- `wespeaker-chunk-emb-s12-w22.mlmodelc`
- `wespeaker-chunk-emb-s12-w37.mlmodelc`
- `wespeaker-chunk-emb-s12-w53.mlmodelc`
- `wespeaker-chunk-emb-s12-w84.mlmodelc`
- `wespeaker-chunk-emb-s12-w116.mlmodelc`

## `required_files(CoreMlFast)` extras (info only)

- `segmentation-3.0-w8a16.mlmodelc`
- `segmentation-3.0-b32-w8a16.mlmodelc`
- `segmentation-3.0-b64-w8a16.mlmodelc`
- `wespeaker-chunk-emb-s25-w11.mlmodelc`
- `wespeaker-chunk-emb-s25-w16.mlmodelc`
- `wespeaker-chunk-emb-s25-w21.mlmodelc`
- `wespeaker-chunk-emb-s25-w26.mlmodelc`
- `wespeaker-chunk-emb-s25-w36.mlmodelc`
- `wespeaker-chunk-emb-s25-w46.mlmodelc`
- `wespeaker-chunk-emb-s25-w56.mlmodelc`

## Binary size / link (0a)

| Item | Value |
|------|-------|
| features | `default-linalg` + `coreml`, `online` off |
| rustc used | 1.88.0 (6b00bc388 2025-06-23) via `rust-toolchain.toml` |
| release exe size | **19 MB** (`native/speakrs-cli/target/release/speakrs-cli`) |
| dylibs | system only: libSystem, libc++, Foundation, CoreML, ImageIO, CoreGraphics, CoreVideo, Metal, CoreFoundation, libobjc, libiconv |
| static OpenBLAS | yes (`openblas-src` feature `static`) |
| static ort | yes (`ort-sys` `download-binaries`; no `libonnxruntime` dylib in `otool -L`) |
| `online` compiled out | yes — `speakrs::ModelManager` is cfg-gated; binary has no `huggingface` / `avencera/speakrs-models` strings |
| > 80 MB? | **no** — keep static OpenBLAS + static ort on macOS |

## Speaker-count API

| Item | Finding |
|------|---------|
| `PipelineConfig` knobs | `binarize`, `ahc.threshold`, `vbx`, `merge_gap`, `speaker_keep_threshold`, `reconstruct_method` |
| speaker-count / `num_speakers` | **none in 0.5.0** |
| product | **auto-only** |

## Pack sizes (0a)

Snapshot: `~/Library/Caches/avanevis/speakrs-models/5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f` (whole repo 1645 MB). All `required_files` leaves present.

| Mode | required file count | pack total |
|------|---------------------|------------|
| coreml | 76 leaves / 15 `.mlmodelc` trees | **419.5 MB** |
| coreml-fast | 96 leaves | **474.3 MB** |

Largest coreml constituents: chunk-emb s12-w116 30.2 MB, s12-w84 29.2 MB, s12-w53 28.2 MB, embedding ONNX + `.onnx.data` ~53.6 MB, three tail ONNX ~80.9 MB. Per-mode totals are under the 600 MB note threshold; no installer-bundle escalate.

Escalate-or-not: **do not bundle in installer** — keep setup-time download.

## Meetings / DER / RSS (0a)

Private corpus only (not in git). Longest valid local file is **55.9 min** (`20260722_073706`); `20260516_160249` is tagged 68.5 min but the opus is 0.6 MB / corrupt — not used.

Pinned VoxConverse dev subset (every 21st of sorted `dev/*.rttm`, n=10, 50.8 min): `abjxc,cmfyw,exymw,hiyis,jyflp,mekog,oenox,qsfzo,tjkfn,wjhgf`. Scored with `pyannote.metrics.DiarizationErrorRate` vs official RTTMs. Duration-weighted: speakrs `coreml` **8.46% / 6.74%** vs pyannote MPS **7.93% / 6.31%** (Δ **+0.53 / +0.43** abs). Gate was ≤ +1.0 abs — **PASS** both collars. Not a publishable claim (n=10). `wjhgf` is the outlier (+8.5 both collars, 91 s / 5 speakers).

Cold-start (1 s silence, `coreml`): **1.84 s**, CLI RSS 246 MB.

| file | duration | speakers | engine | mode | DER 0 | DER 250ms | seconds | RTFx | cold-start | CLI RSS | combined RSS |
|------|----------|----------|--------|------|-------|-----------|---------|------|------------|---------|--------------|
| 20260812_072216 Andrew Aurison Hypercare Sync | 31.6 min | 2 | speakrs | coreml | — | — | 6.20 | 306× | 1.84 s | 3.56 GB | — |
| 20260812_072216 | 31.6 min | 2 | speakrs | coreml-fast | — | — | 3.83 | 495× | — | 3.92 GB | — |
| 20260812_072216 | 31.6 min | 2 | pyannote | mps | — | — | 69.35 run / 74.43 total | 27.3× run | 5.06 s load | 1.59 GB | — |
| 20260709_074020 Radiology Company Onboarding | 24.9 min | 4 (overlap) | speakrs | coreml | — | — | 3.52 | 425× | 1.84 s | 3.50 GB | — |
| 20260722_073706 Andrew Onboarding Call 2 | 55.9 min | 2 | speakrs | coreml | — | — | 6.57 | 510× | 1.84 s | **3.81 GB** | **3.64 GB** thin Python spawn; +~215 MB if Python also holds f32 |
| voxconverse `abjxc` | 68.4 s | 1 | speakrs / pyannote | coreml / mps | 0.7 / 0.6 | 0.3 / 0.2 | 1.87 / 2.75 | — | — | — | — |
| voxconverse `cmfyw` | 483.9 s | 5 | speakrs / pyannote | coreml / mps | 21.3 / 20.9 | 19.0 / 18.9 | 1.68 / 17.41 | — | — | — | — |
| voxconverse `exymw` | 116.4 s | 5 | speakrs / pyannote | coreml / mps | 6.4 / 6.9 | 4.8 / 5.3 | 0.87 / 4.29 | — | — | — | — |
| voxconverse `hiyis` | 87.0 s | 2 | speakrs / pyannote | coreml / mps | 0.5 / 0.6 | 0.0 / 0.0 | 0.71 / 2.96 | — | — | — | — |
| voxconverse `jyflp` | 451.3 s | 7 | speakrs / pyannote | coreml / mps | 9.8 / 9.3 | 6.7 / 6.5 | 1.44 / 16.14 | — | — | — | — |
| voxconverse `mekog` | 881.5 s | 2 | speakrs / pyannote | coreml / mps | 3.6 / 3.3 | 2.2 / 1.9 | 2.36 / 32.19 | — | — | — | — |
| voxconverse `oenox` | 77.2 s | 2 | speakrs / pyannote | coreml / mps | 0.4 / 0.4 | 0.0 / 0.0 | 0.78 / 2.68 | — | — | — | — |
| voxconverse `qsfzo` | 143.7 s | 2 | speakrs / pyannote | coreml / mps | 2.4 / 2.3 | 1.2 / 1.2 | 0.98 / 5.19 | — | — | — | — |
| voxconverse `tjkfn` | 647.8 s | 10 | speakrs / pyannote | coreml / mps | 5.4 / 5.0 | 4.1 / 3.8 | 2.14 / 23.50 | — | — | — | — |
| voxconverse `wjhgf` | 91.5 s | 5 | speakrs / pyannote | coreml / mps | 35.1 / 26.7 | 33.2 / 24.6 | 0.74 / 3.19 | — | — | — | — |

RTFx excludes a separate cold-start row; wall seconds above include model load. Medium-meeting speed vs same-box pyannote MPS: **306× / 27.3× ≈ 11.2×** (bar was ≥2×). 55.9 min finishes in 6.57 s (30 min timeout is not in play). CLI RSS on the long file is under 4 GB.

Human A/B (1 reviewer × 50 turns): **not listened**. Automated majority-map of 50 pyannote turns (≥1 s) onto speakrs exclusive segments: **0 / 50 disagreements** on all three meetings (labels remapped). Not a substitute for the Task 7 two-reviewer bar.

60+ min timeout sanity: no valid ≥60 min local file; 55.9 min is the stand-in.

## `required_files(Cuda)` / `CudaFast` (from source)

Same list for `Cuda` and `CudaFast`. Copied from `src/models.rs` (`online`-gated; do not enable `online`).

**PLDA** — same 7 files as CoreML.

**ONNX (source list)**

- `segmentation-3.0.onnx`
- `wespeaker-voxceleb-resnet34.onnx`
- `wespeaker-voxceleb-resnet34.onnx.data`
- `wespeaker-fbank.onnx`
- `wespeaker-fbank-b32.onnx`
- `wespeaker-multimask-tail.onnx`
- `wespeaker-multimask-tail-b32.onnx`
- `segmentation-3.0-b32.onnx`
- `wespeaker-voxceleb-resnet34-b64.onnx`

**Runtime extras (not in `required_files(Cuda)`, required by `EmbeddingModel` load):** if `wespeaker-fbank.onnx` exists, load always `commit_from_file`s `wespeaker-voxceleb-resnet34-tail.onnx`. Optional exists-gated: `wespeaker-voxceleb-resnet34-tail-b3.onnx`, `wespeaker-voxceleb-resnet34-tail-b32.onnx`. `*-b64` tail/multimask 404 at this revision.

## Toolchain (0b)

| Item | Value |
|------|-------|
| rustc | crate pin `1.88.0` via `rust-toolchain.toml` (installed this spike) |
| cargo | 1.88.0 |
| host | x86_64-pc-windows-msvc |
| Windows | 11; VS 2019 BuildTools (MSVC 14.29) |
| GPU | NVIDIA GeForce RTX 4070 12 GB |
| NVIDIA driver | **610.88** (CUDA UMD 13.3) |
| speakrs features | `default-features=false`, `default-linalg` + `cuda` + `load-dynamic`; `online` off |
| ort crate | `2.0.0-rc.13` (lock; requires ORT **≥ 1.27**, not the plan's 1.24 / rc.12 note) |

## Binary size / link (0b)

| Item | Value |
|------|-------|
| features | `default-linalg` + `cuda` + `load-dynamic`, `online` off |
| rustc used | 1.88.0 (6b00bc388 2025-06-23) |
| release exe size | **19.47 MB** (`native/speakrs-cli/target/release/speakrs-cli.exe`) |
| dumpbin dependents | kernel32, ntdll, VCRUNTIME140, api-ms-win-crt-* only — no `mkl_rt`, no `onnxruntime` |
| static MKL | yes (`intel-mkl-src`; no MKL DLL) — did **not** dwarf the exe |
| ORT | dynamic via `ORT_DYLIB_PATH` / `onnxruntime.dll` |
| `online` compiled out | yes — no `huggingface` / `avencera/speakrs-models` strings |
| > 80 MB? | **no** |

## Pack sizes (0b)

Snapshot: `%LOCALAPPDATA%\avanevis\speakrs-models\5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f`.

| Mode | required file count | pack total |
|------|---------------------|------------|
| cuda (source `required_files`) | 16 files | **139.1 MB** |
| cuda (runtime-complete, used) | 19 files | **220.0 MB** |
| cuda-fast | same files as cuda | same |

Largest: embedding ONNX + `.onnx.data` ~53.6 MB, multimask tails ~55.5 MB, resnet tails ~80.9 MB, b64 embedding 28.2 MB.

## ORT / DLL closure (0b)

Official Microsoft zip **does not** ship `cudart`/`cufft`. Candidate archive assembled from:

- `onnxruntime-win-x64-gpu_cuda12-1.27.1.zip` (ORT 1.27.1 CUDA 12)
- `nvidia-cuda-runtime-cu12==12.9.79` wheel → `cudart64_12.dll` (spike cache only; **not** pip-installed into the app)
- `nvidia-cufft-cu12==11.4.1.4` wheel → `cufft64_11.dll` (same)

Existing cuda12 pip profile (**not mutated**), from `%APPDATA%\Python\Python311\site-packages` (`buildCudaRuntimeEnv` user-site):

- `nvidia-cublas-cu12==12.9.2.10` → `cublas64_12.dll`, `cublasLt64_12.dll`, `nvblas64_12.dll`
- `nvidia-cudnn-cu12==9.22.0.52` → `cudnn64_9.dll` + `cudnn_*64_9.dll`

PATH for the successful GPU run: `ort-candidate` + `nvidia\cublas\bin` + `nvidia\cudnn\bin` only. No CUDA toolkit. No `torch\lib`. `ORT_DYLIB_PATH` = candidate `onnxruntime.dll`.

`dumpbin /dependents` on `onnxruntime_providers_cuda.dll` (1.27.1): `cublasLt64_12`, `cublas64_12`, `cufft64_11`, `cudart64_12`, `cudnn64_9`, `onnxruntime_providers_shared`, plus CRT/system. `cudart`/`cufft` depend on system DLLs only.

| DLL | Source |
|-----|--------|
| `onnxruntime.dll` | ORT 1.27.1 cuda12 zip |
| `onnxruntime_providers_shared.dll` | ORT 1.27.1 cuda12 zip |
| `onnxruntime_providers_cuda.dll` | ORT 1.27.1 cuda12 zip |
| `cudart64_12.dll` | candidate (nvidia-cuda-runtime-cu12 12.9.79) |
| `cufft64_11.dll` | candidate (nvidia-cufft-cu12 11.4.1.4) |
| `cublas64_12.dll` / `cublasLt64_12.dll` | existing cuda12 pip |
| `cudnn64_9.dll` + `cudnn_*64_9.dll` | existing cuda12 pip |
| `VCRUNTIME140.dll` / `MSVCP140.dll` | system VC++ redist |

Candidate archive **602.8 MB**. Models 220 MB + archive 603 MB = **823 MB**. Over the 600 MB note; **do not bundle in installer** — setup-time download. Do not ship TensorRT / PDBs from the ORT zip.

1.24.1 GPU zip loads then fails speakrs version check (`expected >= 1.27.x, got 1.24.1`). Pin **1.27.1 cuda12**, not 1.24.

## Meetings / DER / RSS (0b)

Private corpus only (not in git). Long file `20260527_143226` / `recording_2026-05-27T14-32-26.opus` is **82.4 min**.

Pinned VoxConverse subset (same IDs as 0a): `abjxc,cmfyw,exymw,hiyis,jyflp,mekog,oenox,qsfzo,tjkfn,wjhgf`. Duration-weighted: speakrs `cuda` **8.41% / 6.67%** vs pyannote CUDA **5.45% / 3.84%** (Δ **+2.96 / +2.82** abs). Gate was ≤ +1.0 abs — **FAIL** both collars. Speakrs per-file DERs match 0a CoreML; Windows pyannote CUDA is a stronger baseline than Mac MPS (e.g. `cmfyw` pyannote 9.3% here vs 20.9% MPS). Not a publishable claim (n=10).

Cold-start (1 s silence, `cuda`): **0.74 s**, CLI RSS 391 MB.

| file | duration | speakers | engine | mode | DER 0 | DER 250ms | seconds | RTFx | cold-start | CLI RSS | combined RSS |
|------|----------|----------|--------|------|-------|-----------|---------|------|------------|---------|--------------|
| 20260618_153139 Persona Pricing Call | 27.2 min | 2 | speakrs | cuda | — | — | 47.13 | 34.6× | 0.74 s | 1.10 GB | — |
| 20260618_153139 | 27.2 min | 2 | speakrs | cuda-fast | — | — | 23.60 | 69.1× | — | 1.08 GB | — |
| 20260618_153139 | 27.2 min | 2 | pyannote | cuda | — | — | 26.32 run / 35.09 total | 61.9× run | 8.77 s load | — | — |
| 20260716_170118 Pain Points Discussion | 53.0 min | 6 (overlap) | speakrs | cuda | — | — | 89.97 | 35.3× | 0.74 s | 1.22 GB | — |
| 20260527_143226 ADHD Assessment | 82.4 min | — | speakrs | cuda | — | — | 141.91 | 34.8× | 0.74 s | **1.39 GB** | **1.40 GB** thin Python spawn |
| voxconverse `abjxc` | 68.4 s | 1 | speakrs / pyannote | cuda / cuda | 0.6 / 0.6 | 0.2 / 0.2 | 3.25 / 1.39 | — | — | — | — |
| voxconverse `cmfyw` | 483.9 s | 5 | speakrs / pyannote | cuda / cuda | 21.4 / 9.3 | 19.1 / 7.3 | 13.99 / 7.40 | — | — | — | — |
| voxconverse `exymw` | 116.4 s | 5 | speakrs / pyannote | cuda / cuda | 6.9 / 9.9 | 5.3 / 8.3 | 4.15 / 1.72 | — | — | — | — |
| voxconverse `hiyis` | 87.0 s | 2 | speakrs / pyannote | cuda / cuda | 0.6 / 0.6 | 0.0 / 0.0 | 3.38 / 1.23 | — | — | — | — |
| voxconverse `jyflp` | 451.3 s | 7 | speakrs / pyannote | cuda / cuda | 10.1 / 8.3 | 7.1 / 5.4 | 12.93 / 6.90 | — | — | — | — |
| voxconverse `mekog` | 881.5 s | 2 | speakrs / pyannote | cuda / cuda | 3.4 / 2.1 | 2.0 / 0.8 | 24.86 / 13.66 | — | — | — | — |
| voxconverse `oenox` | 77.2 s | 2 | speakrs / pyannote | cuda / cuda | 0.4 / 0.4 | 0.0 / 0.0 | 2.94 / 1.09 | — | — | — | — |
| voxconverse `qsfzo` | 143.7 s | 2 | speakrs / pyannote | cuda / cuda | 2.6 / 1.9 | 1.3 / 0.7 | 4.50 / 2.13 | — | — | — | — |
| voxconverse `tjkfn` | 647.8 s | 10 | speakrs / pyannote | cuda / cuda | 5.4 / 4.0 | 4.0 / 2.7 | 18.60 / 10.03 | — | — | — | — |
| voxconverse `wjhgf` | 91.5 s | 5 | speakrs / pyannote | cuda / cuda | 31.9 / 26.1 | 29.8 / 24.4 | 3.25 / 1.31 | — | — | — | — |

RTFx excludes a separate cold-start row; wall seconds include model load. Medium-meeting speed vs same-box pyannote CUDA: **34.6× / 61.9× ≈ 0.56×** (bar was ≥2×). 82.4 min finishes in 142 s (30 min timeout is not in play). CLI RSS on the long file is under 4 GB.

Human A/B (1 reviewer × 50 turns): **not listened**. Automated majority-overlap of 50 pyannote turns (≥1 s) onto speakrs exclusive segments: **1 / 50** (2-speaker) and **0 / 50** (overlap). Midpoint sampling was 3/50 on the 2-speaker file — all sub-second exclusive islands. Not a substitute for the Task 7 two-reviewer bar.

## README requirements (follow-up at Task 7 cutover)

Current README: 4 GB min / 8 GB recommended both OS. **Too low for speakrs on Mac** (CLI 3.81 GB on 56 min). Windows CLI peak is **1.39 GB** on 82 min — the floor is Mac-driven. Plan Task 7 must still raise speaker-ID to **8 GB min / 16 GB recommended**. Do not change README until the default flip.

## Decision

**CONDITIONAL GO.** Binding Windows risk (ORT + existing cuda12 cublas/cudnn, no pip-profile mutation, GPU `device=cuda`) is **PASS**. Written ALL-must-hold bars that miss:

| Gate | Result |
|------|--------|
| Windows GPU + documented DLL closure | **PASS** (driver 610.88) |
| CLI RSS ≤ 4 GB + combined recorded | **PASS** (1.39 / 1.40 GB) |
| 60+ min inside 30 min timeout | **PASS** (82.4 min in 142 s) |
| Pack totals recorded; >600 MB is a note | **PASS** (823 MB combined; do not bundle) |
| A/B ≤ +2 vs pyannote (automated majority-overlap) | **PASS** (1/50, 0/50) |
| VoxConverse DER ≤ +1.0 abs vs same-box pyannote | **FAIL** (+2.96 / +2.82). Speakrs abs ≈ 0a CoreML; pyannote CUDA is the stronger baseline |
| Medium-meeting RTFx ≥ 2× pyannote | **FAIL** (34.6× vs 61.9×) |

Do **not** take the hybrid (speakrs-Mac / pyannote-Windows) fork — that was only if DLL closure failed. Proceed to Task 1. Do not claim a Windows speed or DER win vs current pyannote CUDA. Token-free setup, ~823 MB vs ~4 GB install, Mac 11× speed, and timeout-safe Windows (35× RT) still hold. Revisit Windows DER/speed at Task 7 soak.
