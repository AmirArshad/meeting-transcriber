# Local inference performance — future spike

**Status:** Exploration note only. Not scheduled for v2.9.0. A later pass (for example Fable 5) should turn this into a measurement-first spike before any behavior change.

## Intent

Make Stop → encode, transcription, and summarization feel much faster **without** leaving the current stack: Electron desktop shell, Python 3.11 backend, platform recorders, MLX / faster-whisper, llama.cpp, and the existing native sidecars (Swift `audiocapture-helper`, `speakrs-cli`).

Native *feel* (visual density, chrome, interaction) is already the v2.9 UI-foundation lane. This note is about wall-clock of encode / Whisper / llama, not a UI toolkit swap.

## Why not a framework rewrite

A Tauri or full-Rust rewrite was considered and rejected as the path to “Zed-like” speed:

- Zed is a custom GPU UI toolkit. Tauri still renders HTML in a system webview, so it would not produce that feel.
- AvaNevis wait time is almost entirely Stage A encode, Whisper (plus optional diarization), and llama.cpp — not Chromium.
- The v2.6 Activity queue already lets the next recording start after the file is saved. Transcription no longer blocks Start.
- Replacing Electron or Python would re-litigate recorder invariants, packaged CPython, CUDA 12 vs 13, MLX, `safeStorage`, tray, and Linux Core Beta. Maintainability and OS parity would get worse for a long time.

Keep extracting bounded native sidecars where a profiler shows Python is the bottleneck. Do not replace the shell or the ML runtimes as a performance project.

## Where the current stack still has headroom

The v2.6 queue split is the UX contract to preserve:

| After Stop | Blocks next recording? | User-visible wait |
|---|---|---|
| Mix + Opus encode (Stage A) | **Yes** | File saved, Ready again |
| Whisper / diarization | No | Transcript in History / Activity |
| Summary | No (user-triggered) | Notes appear |

### Encoding (Stage A)

Current path: durable spools → numpy/soxr mix → temp WAV → ffmpeg `libopus` at **`compression_level = 10`**, 128k VBR, `application=audio` (`backend/audio/constants.py`).

Highest-ROI, lowest-risk change: bake off compression level **5–6 vs 10** at the same bitrate. Level 10 is maximum encoder effort, not better transcription. Keep 48 kHz, integrity verification, and WAV fallback.

Do **not** rewrite the bounded mixer, reintroduce whole-session RAM mix, or move to real-time mix. Piping mix → Opus and skipping the intermediate WAV is a later, higher-risk idea because recovery still depends on `.pcm.tmp`.

### Transcription

Largest remaining numbers. Current knobs are accuracy-first:

- `faster-whisper`: `beam_size=5`, VAD on, CPU `int8` / GPU `float16`
- MLX: **`batch_size=1`** because `lightning-whisper-mlx` 0.0.10 can drop earlier 30s windows when batching; override exists as `AVANEVIS_MLX_WHISPER_BATCH_SIZE` (capped at 16)
- Each job **spawns a new Python process and reloads the model**
- Settings default is Small; Medium/Large are much slower
- Guided transcription is diarize, then transcribe speaker windows
- Linux Core Beta stays CPU `faster-whisper` until v3.0 add-on phases

Plausible in-stack wins (needs same-audio A/B, not a blind default flip):

1. **Warm Whisper worker** — keep one loaded model between serialized compute-queue jobs. Cold start is often the first 10–40s.
2. **Fast vs Accurate decoding** — `beam_size` 5 → 1 or 2, or greedy.
3. **Fast models as a first-class setting** — distil / `large-v3-turbo` (and existing English MLX distil specs) behind Fast / Balanced / Accurate, rather than treating Tiny/Base as “fast.”
4. **MLX batch > 1** — only after a long-meeting bake-off on the pinned runtime.
5. **Skip guided transcription** when speaker ID is off, or for very short / single-speaker recordings.

Do **not** default-cut over to whisper.cpp. Windows/Linux quality and CUDA live in CTranslate2; Apple Silicon speed lives in MLX. A sidecar bake-off is allowed; a replacement is a new product.

### Summarization

Already llama.cpp with GPU layers `-1` and `--no-warmup`. Remaining waste:

- **`llama-cli` is spawned per generate**, so the GGUF reloads every time
- **Context is always 32,768 tokens**, even for a short transcript
- Long meetings chunk into multiple completions (`backend/summaries/summary_pipeline.py`)
- 9B/14B catalog entries are much slower than 4B for short meetings

Plausible in-stack wins: persistent `llama-server` (or equivalent keep-alive) on the existing compute queue; adaptive `--ctx-size` from transcript length, capped at 32k; product default “Fast” = 4B without changing catalog pins. Optional later: llama.cpp flash-attn / batch flags only after a catalog-compatible runtime bump.

## v2.9.0 boundary

v2.9.0 must not implement this spike. It may keep the Omarchy-inspired visual refresh (native feel). It must not:

- change Opus compression level, Whisper `beam_size`, MLX batch default, or llama ctx/spawn lifetime;
- add turbo/distil as a shipped Fast preset;
- introduce a warm Whisper worker or `llama-server`;
- start a Tauri, whisper.cpp, or recorder-architecture rewrite.

If a one-line encode tweak is ever considered in this release family, it still needs its own focused change plus a same-file integrity/size check — do not fold it into dependency hygiene or Electron 44.

## Suggested spike order (later agent)

Measurement first, then **one engine per change**:

1. Log Stage A (mix vs Opus), Whisper (load vs decode), and llama (load vs prompt vs generate) on 5 / 20 / 60 minute fixtures per OS.
2. Encode: compression-level bake-off at 128k.
3. Transcribe: warm worker, then Fast/Accurate decode and turbo/distil as an explicit setting.
4. Summarize: keep-alive + adaptive ctx; leave catalog pins alone.

Hardware A/B must cover WER (or a documented proxy), summary faithfulness on a fixture transcript, Opus decode/playback, and a long-meeting MLX batch check. Linux CUDA / add-ons stay out of scope until Phases 6–9.

## Entry criteria for a future release

Before implementation: a short decision record with measured baselines, the chosen Fast/Accurate product copy, and which knobs stay conservative by default. Review any new long-lived Python or llama process against quit drain, `aiComputeActionQueue`, and packaged offline cache rules in `AGENTS.md`.
