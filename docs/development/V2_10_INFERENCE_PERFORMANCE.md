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

This is actual local, fresh-process evidence captured on an Apple M4 Pro. It
qualifies only the direct backend finalizer and direct Opus encoder. It does
**not** measure, or imply, renderer/UI Stop-to-ready time.

Environment:

- Hardware: Apple M4 Pro, 14 CPU cores, 48 GB unified memory (serial and UUID
  intentionally omitted); macOS 26.6.2 (25G83), arm64.
- App revision: `5b83259c8804cf74f5cbd5481c362744970f44db`; Python 3.11.16;
  bundled `ffmpeg version n8.0.1`.
- Power mode: unavailable. Filesystem-cache state: not controlled. Model
  residency: false. VRAM, ffmpeg-child CPU, queue wait, admission, and
  spawn/import/load timings: unavailable in this direct backend harness.

### Fixtures and method

All fixtures were created locally with `build/resources/ffmpeg/ffmpeg` by
looping the explicit source fixture
`tests/fixtures/speakrs-two-speaker-16k.wav` (SHA-256
`1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998`) and
decoding to PCM S16LE, 48 kHz stereo. No model, dependency, or network download
was used.

| Fixture ID | Exact duration | SHA-256 |
| --- | ---: | --- |
| `two-speaker-en-5m` | 300,000 ms | `e4a40a8991b4d5f482faea29e43572ed59f71804d13c61e31b6e1dd6068b4dcb` |
| `two-speaker-en-20m` | 1,200,000 ms | `07167f98b49542b40f6a1a9af236dac906b5182347891813e4eef793e6316f37` |
| `two-speaker-en-60m` | 3,600,000 ms | `8212a0a30402a367c4ed600aff2ff18fbdd6108ccfdd417803ce7fb07c2c60c1` |

Each row below is three newly spawned Python workers. The raw v1 JSON report
contains every individual outcome, output, CPU/RSS field and timing; its local
evidence directory is intentionally outside the repository. All 36 trials
succeeded. Every resulting file decoded using the bundled ffmpeg, was nonzero
bytes, preserved 48 kHz stereo and exact fixture duration (within the 25 ms
tolerance), and had `fallback_wav: false`.

### Actual backend finalization / backend Stop-to-ready

This uses the production `finalize_capture` path after staging a macOS-v1
48 kHz stereo mic spool. It includes finalizer mixing/verification/cleanup; it
is intentionally distinct from direct encoding and is **not** UI timing.

| Fixture | Raw trials (ms) | Median [range] ms | Python CPU ms (range) | Peak RSS bytes (range) | Output bytes |
| --- | --- | --- | --- | --- | ---: |
| 5m | 2366.830, 2368.329, 2367.517 | 2367.517 [2366.830–2368.329] | 101.406–103.861 | 44056576–44302336 | 5158059 |
| 20m | 9137.238, 9201.250, 9188.323 | 9188.323 [9137.238–9201.250] | 384.539–388.987 | 44187648–44253184 | 20633208 |
| 60m | 27210.367, 27138.583, 27163.828 | 27163.828 [27138.583–27210.367] | 1132.308–1147.271 | 43778048–44466176 | 61890147 |

### Direct Opus encoding

The encoder timing excludes fixture decode/staging, mixing, verification and
cleanup. CPU measurements are this worker's Python process only; they do not
attribute ffmpeg child CPU, so the small reported CPU values must not be read
as total encoder CPU consumption.

| Fixture / effort | Raw trials (ms) | Median [range] ms | Python CPU ms (range) | Peak RSS bytes (range) | Output bytes |
| --- | --- | --- | --- | --- | ---: |
| 5m / 10 | 1716.993, 1740.073, 1750.302 | 1740.073 [1716.993–1750.302] | 2.083–2.157 | 40009728–40058880 | 4685100 |
| 5m / 5 | 1282.003, 1286.341, 1305.876 | 1286.341 [1282.003–1305.876] | 2.122–2.182 | 39698432–40075264 | 4959197 |
| 5m / 6 | 1286.908, 1289.787, 1302.559 | 1289.787 [1286.908–1302.559] | 2.061–2.210 | 39649280–40091648 | 4959197 |
| 20m / 10 | 6940.027, 6926.394, 6885.715 | 6926.394 [6885.715–6940.027] | 2.199–2.276 | 39829504–40042496 | 18753040 |
| 20m / 5 | 5122.776, 5081.495, 5062.535 | 5081.495 [5062.535–5122.776] | 2.122–2.292 | 40042496–40091648 | 19837655 |
| 20m / 6 | 5116.963, 5088.592, 5067.866 | 5088.592 [5067.866–5116.963] | 2.147–2.177 | 39780352–40091648 | 19837655 |
| 60m / 10 | 20632.547, 20522.799, 20572.625 | 20572.625 [20522.799–20632.547] | 2.189–2.428 | 39714816–40337408 | 56253605 |
| 60m / 5 | 15092.147, 15136.691, 15203.313 | 15136.691 [15092.147–15203.313] | 2.153–2.301 | 39714816–39960576 | 59504787 |
| 60m / 6 | 15143.959, 15140.041, 15153.893 | 15143.959 [15140.041–15153.893] | 2.129–2.312 | 39911424–40173568 | 59504787 |

Efforts 5 and 6 reduced direct median encoder time by roughly 26% on each
fixture relative to effort 10, but both generated larger files on this repeated
speech fixture. This is a speed observation, not a quality qualification.

### Decision and coverage limits

Effort 10 remains the production default. No effort is promoted: this fixture
is repeated retained English two-speaker speech and does not cover independent
ordinary speech, silence, overlap diversity, desktop audio, retained-language
content, listening review, transcript/WER review, or recoverable-failure
trials. It therefore does not satisfy the full audio-quality or cross-platform
release gates. No Whisper, summary, UI, worker-lifetime, or automatic-setting
decision follows from this evidence.

## Apple Silicon MLX Whisper baseline — 2026-09-14

This is a baseline-only qualification of the existing Apple Silicon standard
transcription path. It makes no faster-whisper, Parakeet, model, beam, batch,
UI, IPC, worker-lifetime, or setting change. The benchmark calls the existing
`MLXWhisperTranscriber` with the production `small` model selection, `en`, and
batch size 1. It uses the cached `lightning-whisper-mlx` 0.0.10 runtime and
never downloads a model or dependency. `HF_HUB_OFFLINE=1` and
`AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY=1` were set because the required
local cache files were already complete.

Environment and identity:

- Hardware/OS: Apple M4 Pro (14 CPU cores, 48 GB unified memory), macOS
  26.6.2 (25G83), arm64; AC power, 100% charged. Power-performance mode is
  unavailable from the collected system interface.
- App revision: `915b8868908de53e9a956ba86a8d867a90b8b728`; Python 3.11.16;
  `lightning-whisper-mlx` 0.0.10. Actual result device was `metal` and compute
  type `float16` in every trial.
- Model: `mlx-community/whisper-small-mlx`, key `small`; `weights.npz`
  SHA-256 `55b6674c9b339702d486e2b1573839a66f8ec8f821ed2886993ef717a86b09f5`,
  `config.json` SHA-256
  `e8f58e638208af66d5d5d67801259dc7a12d199e971967a9f9d33a8e3635668e`.
- Filesystem cache: existing complete local cache, state otherwise not
  controlled. Every trial was a fresh Python process; no model was resident
  between trials.

### Fixture, reference, and method

The explicit local fixture was `tests/fixtures/speakrs-two-speaker-16k.wav`
(SHA-256 `1eed9687badcdd0d554638c8229fdb48d5c80e21ed1393c3bb5621f0c83bd998`),
14,224.5 ms of generated English two-speaker speech. Its locally maintained
generator supplies the reference dialogue; the reference text hash was
`a65643640aae5377b7079ad1ca301a1ef62c5254d0aea20c3d918500612fff20`.

The command below ran in a foreground CLI and completed all three trials:

```sh
env -u AVANEVIS_MLX_WHISPER_BATCH_SIZE \
  HF_HUB_OFFLINE=1 AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY=1 \
  .venv/bin/python scripts/benchmarks/inference_performance.py --mlx \
  --fixture speakrs-two-speaker-en=tests/fixtures/speakrs-two-speaker-16k.wav \
  --reference /private/tmp/v2.10-inference-fixtures-2026-09-14/speakrs-two-speaker-reference.txt \
  --expected-name Hazel --expected-name Zira --expected-number ten \
  --model small --language en \
  --output-dir /private/tmp/v2.10-mlx-qualification-2026-09-14 --trials 3
```

The harness measures only observable boundaries. `production_load_model_ms`
is the existing transcriber's cache verification/import/file-lock method;
`decode_transcription_ms` is its unmodified MLX `transcribe_audio` call. The
runtime internally initializes the native model during that latter call, so a
separate native model-load field is `unavailable`, not estimated by
subtraction. `process_startup_ms`, queue wait, device admission, VRAM, and UI
timing are likewise unavailable. `fresh_process_wall_ms` is the observed
parent-to-child wall time, not a UI duration.

### Raw standard-path trials

| Trial | Import ms | Production load ms | Decode/transcription ms | Process/persist ms | Worker end-to-end ms | Fresh-process wall ms | CPU ms | Peak RSS bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.012 | 840.386 | 560.579 | 0.927 | 1402.934 | 1754.628 | 1039.502 | 996147200 |
| 2 | 0.876 | 816.112 | 563.135 | 0.894 | 1381.050 | 1755.543 | 1028.905 | 998342656 |
| 3 | 0.924 | 821.227 | 562.122 | 0.912 | 1385.214 | 1752.550 | 1029.067 | 995508224 |
| Median [range] | 0.924 [0.876–1.012] | 821.227 [816.112–840.386] | 562.122 [560.579–563.135] | 0.912 [0.894–0.927] | 1385.214 [1381.050–1402.934] | 1754.628 [1752.550–1755.543] | 1029.067 [1028.905–1039.502] | 996147200 [995508224–998342656] |

All three standard-path trials exited successfully, wrote a 518-byte markdown
transcript, reported one timestamped segment, and reported the 14,224.5 ms
audio duration. The report is held in the local scratch directory named in the
command above; it contains only fixture/model hashes and validation outcomes,
not transcript text or user paths.

### Transcript parity and completeness

The reference/WER-style comparison was reproducible across all three trials:
WER 0.06383; middle and end reference sections present; beginning reference
section missing; expected names `Hazel`/`Zira` missing; expected number token
`ten` missing; timestamps present after the production transcriber's existing
timebase normalization. This is a real quality/completeness limitation of this
small synthetic fixture result, not a failed benchmark trial. It is recorded
instead of being normalized away or replaced with an untested decoder.

The guided/speaker-related path was not exercised: it remains a distinct
speaker-engine admission and windowing flow, and no standard backend duration
here is presented as guided or UI timing. No long-meeting fixture, desktop
audio, overlap, retained-language fixture, listening review, or higher MLX
batch experiment was performed.

### Decision

**Retain production defaults; reject any decoding/default promotion from this
evidence.** The work qualifies a fresh-process MLX baseline only. The fixture's
name/number/beginning misses and the missing long-meeting/guided/diverse-audio
coverage fail the quality gate for a beam/model/batch or product-mode change.
MLX batch size remains 1, and no production source file was changed.

## Apple Silicon summary context qualification — 2026-09-14

This is a local, baseline-only qualification of the existing per-prompt
llama.cpp summary path. It makes no production runtime, context, prompt,
chunking, IPC, queue, persistence, or worker-lifetime change.

### Inputs and environment

- Hardware/OS: Apple M4 Pro (14 CPU cores, 48 GB unified memory), macOS
  26.6.2 (25G83), arm64. AC power, 100% charged; Low Power Mode was off and
  High Power Mode was off. Filesystem-cache state was not controlled. Each
  trial was a new Python and llama-cli process; no model process remained
  resident between trials.
- App revision: `a1cae70d4a5b4c2927cca0230ddc2648b54f4a75`; Python 3.11.16.
- Model: installed catalog default `qwen3.5-9b-q4-k-m`, Qwen3.5 9B Q4_K_M;
  5,680,522,464 bytes, SHA-256
  `03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8`.
- Runtime: installed catalog target `llama-cpp-b9173-darwin-arm64-metal`,
  llama.cpp b9173 / commit `49d1701bd24e4cedf6dfec9e50e185111203946b`.
  `llama-cli --version` reported `9173 (49d1701bd)`, built with AppleClang
  15.0.0.15000309 for Darwin arm64. `llama-cli` SHA-256:
  `eec00d923f7f1307ca01691e86c7cb8e98fe5ded327cd1352559bca8fac3992d`.
  The bundled `llama-tokenize` SHA-256 was
  `4020ace3f31b976f585b85215a6516d1954296123fb6869f7c02e7ed14f01ae9`.
- Configuration: existing `detailed` profile, `--ctx-size 32768`,
  `--predict 2600`, `--n-gpu-layers -1`, temperature 0.1, no warmup, and the
  existing one-CLI-invocation-per-prompt lifecycle. Actual Metal device/VRAM
  telemetry is unavailable from this production invocation; `-1` requests all
  layers and the catalog target is Metal, but that is not treated as measured
  actual-device evidence.

The explicit, non-user fixtures were added under `tests/fixtures/`:

| Fixture | SHA-256 | Shape | Expected evidence checked manually |
| --- | --- | --- | --- |
| `summary-context-qualification-en.md` | `c9b25c781837ed5acf8f930c65f0b8741590c5d205321b3bf3a87ca8db13a101` | English, one chunk | approval date, three owners/actions, vendor risk, open support coverage |
| `summary-context-qualification-fa.md` | `168ece091228518b8f20594e8155f5d48fb9df9e4abf7ad96bb64372b92ae510` | Persian, one chunk | same facts in Persian, including Tuesday October 6 |

Raw outputs and sidecars were kept only in a local scratch directory outside
the repository; the report does not retain prompt or transcript text. The
first six exploratory runs used speaker names
in a markdown form that `parse_markdown_transcript` does not recognize. They
completed but produced empty-content summaries, so they are recorded as
fixture-construction failures and excluded. A combined re-run then overlapped
two CLI processes after the terminal collection window elapsed; those partial
trials are also excluded. The six raw trials below were rerun singly, in the
foreground, after no summary process was active.

### Unmodified 32k raw trials

`real` and CPU are `/usr/bin/time -l` measurements in seconds, converted to
milliseconds below. Peak RSS is the tool's maximum-resident-set field. The
runner gives progress boundaries, but it has no production timing hooks around
complete prompt construction, native load, prompt evaluation, generation, or
persistence; those components are explicitly unavailable rather than derived
by subtraction.

| Fixture / trial | Total fresh-process ms | CPU ms (user + system) | Peak RSS bytes | Outcome / quality |
| --- | ---: | ---: | ---: | --- |
| English / 1 | 18170 | 960 + 470 | 7030063104 | Completed; all checked facts present. |
| English / 2 | 18000 | 1010 + 480 | 7024951296 | Completed; all checked facts present. |
| English / 3 | 18180 | 970 + 470 | 7024803840 | Completed; all checked facts present. |
| Persian / 1 | 20080 | 1040 + 490 | 7027326976 | Completed, but changed Tuesday to Wednesday. |
| Persian / 2 | 17860 | 990 + 470 | 7027048448 | Completed, but changed Tuesday to Wednesday. |
| Persian / 3 | 18700 | 1010 + 480 | 7027294208 | Completed, but changed Tuesday to Wednesday. |

| Fixture | Successful process median [range] ms | CPU total median [range] ms | Peak RSS range bytes | Prompt construction / runtime load / generation / persistence |
| --- | ---: | ---: | ---: | --- |
| English | 18170 [18000–18180] | 1440 [1430–1490] | 7024803840–7030063104 | unavailable / unavailable / unavailable / unavailable |
| Persian | 18700 [17860–20080] | 1490 [1460–1530] | 7027048448–7027326976 | unavailable / unavailable / unavailable / unavailable |

The normal CLI's timing line is a rate-only display and does not give a safe
load/prompt/generation decomposition. `--perf` exists, but it is not among the
production arguments, so it was not used to derive baseline component times.
The actual installed b9173 CLI also emitted that `--no-conversation` is not
supported before continuing its single-turn invocation. This is recorded as
runtime compatibility evidence; this Task does not alter that existing flag.

### Prompt accounting and context decision

The installed b9173 bundle provides `llama-tokenize --file|--stdin
--show-count`; it uses the same installed GGUF. Exact rendered-prompt checks
using the current detailed profile produced 412 tokens for the complete
English chunk prompt, 52 for the repair prompt, and 490 for a complete merge
prompt containing one validated chunk summary. This proves an available raw
prompt tokenizer, including the constructed prompt text.

It does **not** qualify smaller contexts: the existing CLI invocation's
template/conversation behavior cannot be reconciled with that standalone count
because the production `--no-conversation` flag is unsupported, and there is
no validated accounting of resulting template overhead. More importantly, the
current code has no defined per-call safety headroom policy. The 2,600-token
detailed output allowance alone is therefore insufficient to establish a
complete context budget. No 4k, 8k, or 16k candidate was run; no estimated or
character-based allocation was used. Chunk, repair, and merge counts are kept
separate and are not reused as one another's budget.

### Decision: retain 32k; reject context promotion

**Retain `LLAMA_CONTEXT_TOKENS = 32768` and make no source change.** The
prerequisite for safe complete-prompt accounting is incomplete, the required
long/merge and repair-generation quality coverage is absent, and the Persian
fixture changed a material date in all three baseline trials. The English
single-chunk summary was faithful, but it cannot offset that multilingual
quality failure or establish behavior for chunk/repair/merge calls. Existing
bounded failure behavior, base-context chunk budgeting, cancellation and
prior-summary preservation remain unchanged.

This evidence is macOS Apple Silicon only. It makes no Windows or Linux
performance, compatibility, or actual-device claim. Before reconsidering a
smaller allocation, qualify the exact runtime's full invocation/template token
count, explicit output reservation and safety headroom for every prompt type,
then collect uncontended fresh-process short, long/merge, repair, and retained
language quality trials.

## Task 5 release decision — 2026-09-14

**No v2.10 inference-performance optimization is qualified for release from
the recorded evidence.** This is a release-decision record for the Task 1–4
local evidence, not a hardware acceptance, packaged-app acceptance, or product
performance claim. No production default, runtime pin, IPC surface, UI,
process lifetime, dependency, or model artifact changed for this work.

| Platform / slice | Recorded decision | Evidence boundary |
| --- | --- | --- |
| Apple Silicon macOS / Opus encoding | Retain Opus effort 10. Reject effort 5 and 6 promotion. | Three fresh-process direct-encoder trials on each repeated-English fixture observed about 26% lower encoder medians for efforts 5 and 6, but both produced larger files and have no required listening, transcript/WER, diverse-audio, recoverable-failure, or cross-platform quality evidence. |
| Apple Silicon macOS / MLX Whisper | Retain existing MLX Whisper defaults, including `small` and batch size 1. Reject any decode/default or product-mode promotion. | The only standard-path baseline is a short synthetic English fixture; it missed the beginning, both expected names, and the expected number. Guided transcription, long meetings, overlap/desktop audio, retained languages, listening review, and higher-batch completeness were not qualified. |
| Apple Silicon macOS / llama.cpp summaries | Retain the 32k summary context. No 4k, 8k, or 16k candidate is qualified. | A standalone tokenizer count cannot account for the installed CLI's unresolved template/conversation overhead or define complete-prompt output reservation and safety headroom. No smaller candidate ran; long/merge and repair-generation coverage is absent, and every Persian baseline changed a material date. |
| Windows x64 / all slices | No decision beyond retaining existing behavior. | No local qualification evidence was recorded. |
| Linux x86_64 / all slices | No decision beyond retaining existing behavior. | No local qualification evidence was recorded, including no managed-CUDA or component-gated add-on qualification. |

The entire evidence set is limited to local Apple M4 Pro direct-backend or
fresh-process CLI measurements on 2026-09-14. It does not measure packaged
Windows/Linux behavior, UI Stop-to-ready, queue/admission timing, native
load-time decomposition, actual-device VRAM, concurrent recording/inference,
power/thermal variation, or persistent-worker behavior. The recording
fixtures do not provide the required independent speech, silence, overlap,
desktop-audio, retained-language, listening, WER, or recoverable-failure
coverage. The MLX baseline is not guided-path evidence. The summary baseline
does not establish faithful short/long multilingual chunk, repair, and merge
behavior. These limitations prevent hardware or release acceptance claims.

Future promotion requires the per-slice gates in the implementation plan,
including actual-runtime/device evidence on each release platform, quality and
lost-content checks, and at least 10% median improvement in the targeted stage
without an end-to-end or resource regression beyond observed baseline
variation. Persistent workers remain a separate lifecycle design.
