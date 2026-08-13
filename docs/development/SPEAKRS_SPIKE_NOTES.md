# Speakrs Spike Notes (Task 0)

Tables only. No GO/NO-GO until Task 0b. speakrs **0.5.0**. Pin: `avencera/speakrs-models` `5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f`.

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

Pinned VoxConverse dev subset IDs: **not run** (no local VoxConverse tree). DER columns stay empty until a 10-file subset is pulled.

Cold-start (1 s silence, `coreml`): **1.84 s**, CLI RSS 246 MB.

| file | duration | speakers | engine | mode | DER 0 | DER 250ms | seconds | RTFx | cold-start | CLI RSS | combined RSS |
|------|----------|----------|--------|------|-------|-----------|---------|------|------------|---------|--------------|
| 20260812_072216 Andrew Aurison Hypercare Sync | 31.6 min | 2 | speakrs | coreml | — | — | 6.20 | 306× | 1.84 s | 3.56 GB | — |
| 20260812_072216 | 31.6 min | 2 | speakrs | coreml-fast | — | — | 3.83 | 495× | — | 3.92 GB | — |
| 20260812_072216 | 31.6 min | 2 | pyannote | mps | — | — | 69.35 run / 74.43 total | 27.3× run | 5.06 s load | 1.59 GB | — |
| 20260709_074020 Radiology Company Onboarding | 24.9 min | 4 (overlap) | speakrs | coreml | — | — | 3.52 | 425× | 1.84 s | 3.50 GB | — |
| 20260722_073706 Andrew Onboarding Call 2 | 55.9 min | 2 | speakrs | coreml | — | — | 6.57 | 510× | 1.84 s | **3.81 GB** | **3.64 GB** thin Python spawn; +~215 MB if Python also holds f32 |

RTFx excludes a separate cold-start row; wall seconds above include model load. Medium-meeting speed vs same-box pyannote MPS: **306× / 27.3× ≈ 11.2×** (bar was ≥2×). 55.9 min finishes in 6.57 s (30 min timeout is not in play). CLI RSS on the long file is under 4 GB.

Human A/B (1 reviewer × 50 turns): **not listened**. Automated majority-map of 50 pyannote turns (≥1 s) onto speakrs exclusive segments: **0 / 50 disagreements** on all three meetings (labels remapped). Not a substitute for the Task 7 two-reviewer bar.

60+ min timeout sanity: no valid ≥60 min local file; 55.9 min is the stand-in.

## Windows (0b)

DLL closure, driver floor, cuda/cuda-fast columns: not started.

## Decision

No GO/NO-GO until 0b.
