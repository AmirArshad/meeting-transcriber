# V2.10 Local Inference Performance Evidence

This document records developer qualification evidence for v2.10. It is not a
product performance claim and it does not change recording or decoding
defaults.

## Protocol

Run `scripts/benchmarks/inference_performance.py` only with explicit local
fixture paths, an explicit ffmpeg runtime, and an output directory outside
recordings. The script neither discovers inputs nor downloads models or
dependencies. It uses a fresh Python worker for every trial and reports
milliseconds, bytes, raw trials, medians and ranges. Failed and cancelled
trials stay in the raw record but are excluded from successful-trial summaries.
Missing measurements are recorded as `unavailable`, never as zero.

The harness runs two distinct measurements:

- `finalization`: stages the fixture as a 48 kHz stereo macOS capture spool,
  then invokes `finalize_capture`. This retains the intermediate WAV,
  integrity verification, recoverable WAV fallback, capture cleanup order and
  mono-compatible stereo output behavior.
- `encode`: stages a 48 kHz stereo WAV, calls the existing
  `compress_to_opus(..., compression_level=EFFORT)`, and verifies real ffmpeg
  decoding plus duration and channel preservation. It deliberately excludes
  mixing, WAV staging and finalizer cleanup so effort 5, 6 and 10 can be
  compared independently.

The script measures worker CPU time and peak RSS when the OS exposes them.
These are Python-process measurements; ffmpeg child CPU time and VRAM are not
attributed by this v1 harness. Queue wait, device admission and
spawn/import/load are not observable in this direct backend run. “Filesystem
cache warm” is never called model-resident.

Example:

```sh
.venv/bin/python scripts/benchmarks/inference_performance.py \
  --fixture speech-en-5m=/absolute/path/speech-5m.wav \
  --fixture speech-en-20m=/absolute/path/speech-20m.wav \
  --fixture speech-en-60m=/absolute/path/speech-60m.wav \
  --ffmpeg build/resources/ffmpeg/ffmpeg \
  --output-dir /absolute/scratch/v2.10-inference-evidence \
  --trials 3
```

## Apple Silicon baseline — 2026-09-14

Environment:

- Hardware: Apple M4 Pro, 14 CPU cores, 48 GB unified memory (hardware serial
  and UUID intentionally omitted).
- OS: macOS 26.6.2 (25G83), arm64.
- App revision: `1adbf9c` (full SHA is included in the local JSON report).
- Python: 3.11.16. Runtime: bundled `ffmpeg version n8.0.1`.
- Power mode: unavailable. Filesystem cache state: not controlled. Model
  residency: false. VRAM and child-process CPU: unavailable.

Fixtures are explicit local derivatives of
`tests/fixtures/speakrs-two-speaker-16k.wav` (SHA-256
`1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998`), looped
without network access to exactly 5, 20 and 60 minutes. They contain retained
English two-speaker speech, but are not adequate coverage for silence,
desktop-audio, overlap diversity, or retained-language qualification. Results
from them are therefore a reproducible **provisional codec/finalizer baseline**;
they do not clear the full v2.10 release audio-quality matrix.

The raw report is written only to the selected local evidence directory as
`inference-performance-report-v1.json`; it records fixture hashes rather than
paths, and excludes titles/transcripts/prompts and machine identifiers.

| Configuration | Status |
| --- | --- |
| Finalization / Stop-to-ready backend | Pending the fresh-process 5/20/60-minute raw report. UI Stop-to-ready remains manual and is not inferred from backend timing. |
| Opus effort 10 | Pending; production default remains 10. |
| Opus efforts 5 and 6 | Pending; no candidate is promoted. |
| Decode, duration, channels, fallback | The harness requires all four per successful trial; the completed short-fixture smoke run decoded correctly at 48 kHz stereo and preserved 14,224.5 ms. |
| CPU time / peak RSS | Collected where measurable in raw workers; VRAM and ffmpeg child CPU are unavailable in v1. |

No default changes are authorized by this evidence. Before any promotion, add
non-repeated 5/20/60-minute fixtures covering ordinary speech, silence,
overlap, desktop audio and retained languages; perform listening and transcript
quality review; capture recoverable-failure trials; and confirm the plan’s
cross-platform release gates.
