# Three-Platform Parakeet GPU Implementation Plan

> **For agentic workers:** Execute inline. Ask before delegation. This is the user-approved technical design and file-level implementation order; do not restart product discovery or insert a hardware qualification phase before implementation.

**Goal:** Offer Parakeet as an optional local English transcription engine on Windows CUDA, Linux managed CUDA 12, and Apple Silicon Metal, preserving Whisper as the default and durable per-meeting engine selection.

**Architecture:** Preserve renderer → preload → owning main service → tracked Python subprocesses. A common transcript and persistence contract fronts three platform adapters; setup is explicit, catalog-pinned, isolated, cancellable, and offline at inference. Guided work runs sequential isolated diarization and Parakeet subprocesses within one compute queue job.

**Tech Stack:** Electron 44, plain HTML/CSS/JavaScript, Python 3.11, onnx-asr 0.12.0 / ONNX Runtime GPU 1.23.2 / isolated CUDA 12, parakeet-mlx 0.5.2 / MLX 0.32.2 Metal, existing ffmpeg and recording/persistence infrastructure.

## Execution status — 2026-09-22

Implementation is in progress on `codex/parakeet-three-platform-gpu`. Catalog,
locks, durable selection, capture snapshot/recovery, and pinned setup code are
present. Bounded adapters and ordinary Mac Parakeet queue/commit code have been
exercised. Guided Parakeet work, Settings activation/recovery UI, packaging and
legal/contract updates, and the remaining lifecycle checks are still open.

On an Apple M4 Pro (macOS 26.7), explicit setup installed the pinned model and
47-wheel isolated runtime under Electron userData. A live Metal probe and
offline inference on a 14.22-second local English fixture succeeded. The app's
compute/resource queue modules ran an ordinary transcription and guarded
meeting-result commit: six timestamped segments, persisted `mps` / `float32`
provenance, and retained playable audio. Making the runtime unavailable for a
new attempt failed with `PARAKEET_ARTIFACT_INVALID` without CPU or Whisper
substitution; the prior transcript and audio survived. The runtime was restored
and passive status returned to `ready`. This was a service-level test, not a
renderer UI or packaged-app test. It establishes no performance comparison.

The smoke exposed two corrected setup issues: the pinned weight URL redirected
to an explicit Hugging Face CDN host missing from the allowlist, and Librosa's
Numba cache created directories inside the immutable runtime. Focused
regression coverage was added. `npm run test:all` passed (1,023 JS passed,
3 skipped; 715 Python passed, 9 skipped; Python syntax passed). Windows and
Linux hardware validation has not been run for this integration.

## Global constraints and authority

- Design baseline: branch `qualification/linux-parakeet-v2.10`, commit `ee1674cadbedf3d3dc03cc671df0de3edbb81222`.
- User approved this design on 2026-09-22 and requested it be saved, committed, and pushed. Saving this plan does not itself implement the feature.
- This plan supersedes the CachyOS-only implementation restriction and qualification prerequisite in `2026-09-06-parakeet-integration.md`, `2026-09-22-cachyos-parakeet-qualification.md`, and the next-step prose in `PARAKEET_COMPATIBILITY.md`. Historical evidence remains unchanged.
- Implement all three GPU targets. The user will perform Windows CUDA, Linux CUDA, and macOS Metal manual testing after implementation. Do not add a qualification phase before implementation.
- Target Windows 10/11 x64, Linux x86_64, and macOS 14+ arm64. Runtime integrity and live device admission remain mandatory; waiving qualification is not permission to execute on a broken GPU runtime.
- Whisper stays the default. Its selectable sizes remain Small and Medium. Large is a separate gated slice.
- Parakeet is English-only and explicitly installed/activated. No CPU Parakeet or automatic cross-engine fallback.
- No cloud, telemetry, background uploads, implicit downloads, embedded tokens, or inference network access.
- Preserve single compute/resource queue semantics, process tracking, cancellation/deletion guards, quit drain, atomic metadata, recording recovery, and facade export key sets.
- Preserve Linux supported versus experimental desktop/distro tiers. Availability of this adapter is not a new hardware-support claim.
- Work inline; ask before delegation. Future implementation commits/pushes/PRs require authorization from its execution prompt.

All file paths below are relative to the repository root. Read `AGENTS.md`, the compatibility evidence, both prior plans, and contracts `local-ai.md`, `ipc.md`, `meeting-persistence.md`, `recording.md`, and `packaging.md` before changing their surfaces. Inspect `src/renderer/index.html` and `src/transcription-policy.js`; this design preserves their Small/Medium menu.

## 1. Product behavior and evidence

Offer one optional engine, **Parakeet — English**, alongside Whisper.

- Preserve the existing Small default and any saved Medium preference.
- Parakeet never becomes a Whisper model-size option.
- Installing Parakeet does not activate it. After setup, **Use Parakeet** explicitly activates it.
- Parakeet always requests `language: "en"`. Show “English only. Use Whisper for other languages.” Do not add language detection or a language classifier.
- Remember Whisper language/model separately; switching back restores them.
- Settings changes affect future recordings and explicit new submissions, not active recordings, queued/resumed jobs, or ordinary retries.
- Missing dependencies, GPU failure, malformed output, and OOM never select CPU or Whisper automatically.
- Failed transcription retains recording audio and any previously completed transcript.

Settings explanation:

> Optional local English transcription. On one CachyOS RTX 4070 test, Parakeet was faster than Whisper Medium but used more GPU memory, with similar measured WER. Windows and Mac performance has not been measured.

Only hardware evidence: CachyOS x86_64, RTX 4070, driver 615.71.09, managed CUDA 12, one 838.8333125-second AMI meeting, five uncontended trials.

| Comparison, median | Parakeet | Whisper |
| --- | ---: | ---: |
| Small: wall time | 11.762 s | 9.206 s |
| Small: WER | 0.2660 | 0.2789 |
| Small: RSS / VRAM | 1201 / 3666 MiB | 989 / 1004 MiB |
| Medium: wall time | 12.982 s | 18.266 s |
| Medium: WER | 0.2660 | 0.2670 |
| Medium: RSS / VRAM | 1201 / 3668 MiB | 1637 / 2412 MiB |

Medium revision: `08e178d48790749d25932bbc082711ddcfdfbc4f`.

Parakeet was 27.8% slower than Small and 28.9% faster than Medium. Against Medium it used approximately 52% more VRAM. Both engines failed opening and closing presence checks; Parakeet duplicated three boundary words per trial. This is an accepted speed/VRAM tradeoff, not a quality win, lower-GPU-memory claim, or Windows/macOS performance prediction. The production boundary policy below differs from the benchmark; its timing is not established by those measurements.

## 2. Architecture and ownership

| Adapter ID | Target | Runtime |
| --- | --- | --- |
| `parakeet-onnx-win-cuda-v1` | Windows 10/11 x64 | onnx-asr / ORT CUDA 12 |
| `parakeet-onnx-linux-cuda-v1` | Linux x86_64 | onnx-asr / isolated managed CUDA 12 |
| `parakeet-mlx-metal-v1` | macOS 14+ arm64 | parakeet-mlx / MLX Metal |

Create:

- `src/main/transcription-engine-catalog.js`: identities, target policy, immutable model/runtime specifications.
- `src/main/transcription-engine-resolver.js`: request validation, legacy conversion, adapter resolution, admission policy.
- `src/main/parakeet-setup.js`: status, explicit setup, validation, repair, cancellation, removal.
- `src/main/parakeet-runtime.js`: isolated child arguments/environment and runtime verification.
- `backend/transcription/parakeet_transcriber.py`: common `BaseTranscriber` implementation and CLI.
- `backend/transcription/parakeet_onnx.py`: shared ONNX inference implementation.
- `backend/transcription/parakeet_mlx.py`: Metal implementation.
- `backend/transcription/parakeet_segments.py`: bounded chunking, timestamp normalization, seam ownership.
- `backend/transcription/parakeet_bootstrap.py`: managed import isolation before engine imports.

Windows/Linux share inference code but have separate loader/admission policies. `transcription-service.js` owns transcription IPC and orchestration; `main.js` remains wiring-only. Import new helpers directly, preserving pinned `main-process-helpers` and `ai-addon-setup` export sets and `AI_ADDON_PROGRESS_CHANNEL` / `AI_ADDON_CANCEL_CODE` values. No persistent worker.

## 3. Runtime and artifact pins

### Windows and Linux

The executable model repository is `istupakov/parakeet-tdt-0.6b-v2-onnx`, including `-onnx`. The shorter spelling in the initial request is not a download URL.

```text
model: istupakov/parakeet-tdt-0.6b-v2-onnx
revision: 0bbb45a3365852604aef28b538a8f066f4ccaa85
precision: float32
vad: istupakov/silero-vad-onnx
revision: b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6

onnx-asr==0.12.0
onnxruntime-gpu==1.23.2
nvidia-cublas-cu12==12.9.2.10
nvidia-cudnn-cu12==9.26.0.51
nvidia-cuda-runtime-cu12==12.9.79
nvidia-cuda-nvrtc-cu12==12.9.86
nvidia-cufft-cu12==11.4.1.4
nvidia-curand-cu12==10.3.10.19
nvidia-nvjitlink-cu12==12.9.86
numpy==2.4.6
protobuf==7.36.2
flatbuffers==25.12.19
packaging==26.3
coloredlogs==15.0.1
humanfriendly==10.0
sympy==1.14.0
mpmath==1.3.0
```

Resolve platform-conditional dependencies into the locks, including Windows `pyreadline3==3.5.4` where required by humanfriendly.

Copy the six ONNX model filenames, sizes, and hashes verbatim from `docs/development/PARAKEET_COMPATIBILITY.md`; total 2,512,624,330 bytes. The same pins are in `scripts/benchmarks/parakeet_qualification.py` for comparison, but production must not import the benchmark harness.

```text
silero_vad.onnx
bytes: 2327524
sha256: 1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3
```

Use the recorded Linux wheel hashes. Windows hashes are separate:

```text
onnxruntime_gpu-1.23.2-cp311-cp311-win_amd64.whl
sha256: 054282614c2fc9a4a27d74242afbae706a410f1f63cc35bc72f99709029a5ba4
nvidia_cudnn_cu12-9.26.0.51-py3-none-win_amd64.whl
sha256: 010abb90f513fc6e2b6e9278d56f594b87922fff80737434ab415da609db8311
```

Sources: [ORT 1.23.2 metadata](https://pypi.org/pypi/onnxruntime-gpu/1.23.2/json), [cuDNN 9.26.0.51 metadata](https://pypi.org/pypi/nvidia-cudnn-cu12/9.26.0.51/json).

Never use unbounded `onnx-asr[gpu]`, Whisper's cuDNN 9.22.0.52 tree, or Speakrs' ORT tree.

### macOS Metal

```text
parakeet-mlx==0.5.2
mlx==0.32.2
mlx-metal==0.32.2
model: mlx-community/parakeet-tdt-0.6b-v2
revision: 8ae155301e23d820d82aa60d24817c900e69e487
execution precision: float32
decoding: greedy
attention: unchanged full attention
```

Use float32 explicitly, avoiding the upstream bfloat16 default and an additional precision decision.

| Required file | Bytes | SHA-256 |
| --- | ---: | --- |
| `config.json` | 36,176 | `9bd323e60afe2615c983a5d9fc3a2c0470df2a03edf90c0f861bd59509d07264` |
| `model.safetensors` | 2,471,559,904 | `b958c37a6baa6874a279108755c8f2818e27bf647d72d54800a234a421341dfe` |

The pinned runtime builds vocabulary from configuration; separate tokenizer files are not needed by this loading path. [Immutable model tree](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v2/tree/8ae155301e23d820d82aa60d24817c900e69e487).

Use macOS 14.0-tagged wheels even on newer Macs:

```text
parakeet_mlx-0.5.2-py3-none-any.whl
sha256: 50afb6ddb62237a6486e214482c25ef12759832fda3cd514e159938fa5970d9c
mlx-0.32.2-cp311-cp311-macosx_14_0_arm64.whl
sha256: 238b50d2ee3917c836e73f9446011518b79ff094940eb0107fa6cd17d02a2eca
mlx_metal-0.32.2-py3-none-macosx_14_0_arm64.whl
sha256: 3825fff379dbc107dd3413e564a06caeaa24819910ec49c0439e454c06a1b9b8
```

Sources: versioned [parakeet-mlx](https://pypi.org/pypi/parakeet-mlx/0.5.2/json), [MLX](https://pypi.org/pypi/mlx/0.32.2/json), [MLX Metal](https://pypi.org/pypi/mlx-metal/0.32.2/json) metadata, inspected during design.

For the closure, take shared versions from baseline commit `ee1674cadbedf3d3dc03cc671df0de3edbb81222`'s `requirements-macos-build.txt`, restricted to actual transitive dependencies. Add:

```text
dacite==1.9.2
librosa==0.11.0
audioread==3.1.0
scikit-learn==1.7.2
joblib==1.5.2
threadpoolctl==3.6.0
decorator==5.2.1
soundfile==0.13.1
pooch==1.8.2
platformdirs==4.4.0
lazy-loader==0.4
msgpack==1.1.2
```

### Lock materialization

Create `build/parakeet/windows-cuda.lock.json`, `linux-cuda.lock.json`, and `macos-metal.lock.json`. Materialize full closures during implementation: wheel filename, HTTPS URL, size, SHA-256, license, and extracted-file hashes. This mechanical packaging work is not hardware qualification. The above hashes are not a claim that all platform closure bytes were downloaded or hardware-tested during design.

No deployed setup may resolve dependencies, upgrade versions, build sdists, or proceed with an incomplete lock. Use complete code-owned locks; no checksum authority in writable install manifests. Model/runtime payloads remain explicit setup downloads, not base Whisper dependencies.

## 4. Isolation and device admission

Models: `userData/ai-addons/models/transcription/parakeet/<artifact-revision>/`.

Runtimes: `userData/ai-addons/runtimes/parakeet/<adapter-id>/<lock-digest>/`.

Use existing Python 3.11 with the bootstrap. Import paths contain the chosen managed closure, bundled backend, and Python standard library; exclude ambient/unrelated application/add-on site-packages. Handle Windows embedded `_pth` explicitly, not by assuming `PYTHONPATH` works. Preserve `spawnTrackedPython`, process registration/groups, packaged hardening, and cleared HF tokens (`HF_TOKEN_PATH=os.devNull`).

- Linux: clear ambient `LD_LIBRARY_PATH`; allow only verified Parakeet CUDA 12 directories and validated driver directories. Independently probe this runtime; Whisper readiness is insufficient. Broken Parakeet offers Repair/Remove, never CPU. Preserve existing Whisper managed-tree fail-closed behavior.
- Windows: verified absolute DLL paths, retained `os.add_dll_directory` handles, explicit ORT preloading; exclude host toolkit/Whisper/Speakrs directories. Missing driver/runtime prerequisites fail actionably.
- macOS: require arm64/macOS 14+, `mx.metal.is_available()`, and an evaluated GPU operation. Set `mx.gpu` before model creation and use GPU stream execution. Metal error terminates the job. [MLX Metal API](https://ml-explore.github.io/mlx/build/html/python/metal.html).

CUDA requests CUDA explicitly, disables ORT runtime retry fallback, and verifies CUDA encoder/decoder sessions and actual GPU execution. `get_available_providers()` alone is insufficient. CPU audio decoding/token assembly/runtime shape bookkeeping are allowed; CPU-only neural transcription or retry is not.

Setup validation runs a short real inference using the bundled synthetic fixture. Compute rechecks live device and resources at job start; actual output device must match admission. Apply existing changed-fingerprint rehash policy at compute, full hashes at setup/validate, and directory rescans for extra libraries.

MLX loads local JSON with `from_config`, loads local safetensors, casts parameters to float32, and evaluates on GPU. Do not use `from_pretrained`, which tries Hugging Face before local fallback. No inference-time repair or download.

## 5. Durable selection and provenance

Requested work and completed output are separate:

```json
{
  "transcriptionRequest": {
    "schemaVersion": 1,
    "attemptId": "main-generated UUID",
    "engine": "parakeet",
    "modelId": "parakeet-tdt-0.6b-v2",
    "artifactRevision": "0bbb45a3365852604aef28b538a8f066f4ccaa85",
    "adapterId": "parakeet-onnx-linux-cuda-v1",
    "runtimeLockId": "catalog lock digest",
    "language": "en",
    "boundaryPolicy": "parakeet-boundaries-v1"
  },
  "transcriptionResult": {
    "schemaVersion": 1,
    "attemptId": "matching UUID",
    "engine": "parakeet",
    "modelId": "parakeet-tdt-0.6b-v2",
    "artifactRevision": "0bbb45a3365852604aef28b538a8f066f4ccaa85",
    "adapterId": "parakeet-onnx-linux-cuda-v1",
    "runtimeLockId": "actual lock digest",
    "language": "en",
    "device": "cuda",
    "computeType": "float32",
    "boundaryPolicy": "parakeet-boundaries-v1",
    "transcriptHash": "sha256:computed transcript digest"
  }
}
```

Main generates attempt UUIDs and catalog-controlled fields. Renderer supplies engine/model/language choices, not paths, executable IDs, URLs, or hashes. Result fields describe actual execution. Use the matching Metal artifact/adapter on macOS.

Keep `transcriptionStatus`, `transcriptionError`, `transcriptionDevice`, and `transcriptionComputeType`. If completed output exists, top-level model/language/device continue describing that output while a retry is pending. Activity shows the request; History labels the committed transcript from result provenance.

Whisper requests retain `modelSize` and legacy language compatibility. Unknown historical artifact revisions are null, not fabricated.

- Missing new fields implies legacy Whisper request semantics.
- Resume uses historical compatibility validation, not current preference migration.
- Imported transcript output whose engine cannot be established displays Unknown.
- Explicit unknown engine is an error, never legacy Whisper.
- Metadata values are bounded and allowlisted, with no paths, tokens, or raw exceptions.

Snapshot selection at recording start and persist it in the capture manifest before capture. Carry through stop, quit-stop, recovery, and pending meeting creation. Modify recorder service, capture manifest/spool runtime/recovery, all three recorders, and scan/import. Update recorder stdout contracts/tests together when carrying selection in results. Preserve session IDs, first-command-wins stop/discard, and discarded capture tombstones.

Persist pending `transcriptionRequest` before enqueue. Failed metadata persistence neither enqueues nor deletes audio.

## 6. Retry, resume, and transcript commit

Ordinary Retry sends `meetingId` only and reuses the saved request. Remove History's automatic current-Settings language/model submission.

A separate **Retry with Whisper…** action displays saved Whisper language and Small/Medium preferences, permits adjustment, and explicitly submits a new Whisper request. It does not change the global active engine.

Resume uses exact saved selection. Missing exact adapter/model/runtime yields `PARAKEET_SELECTION_UNAVAILABLE`; no automatic adapter/revision replacement.

Replacing an existing transcript:

1. Persist the new request/attempt without changing completed provenance.
2. Write candidate Markdown under recordings to `{stem}.transcript-{attemptId}.md`.
3. Validate complete child output and candidate Markdown.
4. Under existing meeting lock, recheck attempt ID and cancel/delete generation.
5. Atomically update metadata's transcript path and corresponding result provenance.
6. Clean obsolete output only after successful metadata commit.

Scan/import ignores unreferenced attempt files. Never overwrite prior Markdown before metadata commit. A crash before commit leaves an unreferenced candidate; a crash after commit leaves a valid referenced transcript. Failed retries keep old output and provenance. Preserve `FileLock`, atomic temp/replace, instance-method seams, transactional audio add, suffixed IDs, corrupt backups, Windows deletion retry, and rename-by-ID behavior.

Keep summary invalidation by `sourceTranscriptHash`. New objects are transcription metadata, not new `update-ai` categories.

## 7. Transcript and boundary contract

Both adapters return existing application fields plus provenance:

```text
text
segments: [{start, end, text}]
language: "en"
duration: source duration, seconds
output_file
device: "cuda" | "metal"
compute_type: "float32"
engine/model/revision/adapter/runtime/boundary provenance
```

Persist `metal` as `mps`. Implement `load_model`, `transcribe_file`, and `get_model_info` through `BaseTranscriber`. Use existing Markdown formatting.

Decode derived audio with bundled ffmpeg to temporary mono 16 kHz PCM. Never alter recordings or hold the complete meeting waveform in memory.

`parakeet-boundaries-v1`:

1. Contiguous 18-second ownership intervals.
2. Decode each with up to 0.35 s context on each side, clipped to source bounds; maximum ASR input 18.7 s.
3. CUDA: pinned Silero within bounded input, batch 1, threshold 0.5, negative threshold 0.35, minimum speech 250 ms, minimum silence 500 ms, maximum speech 20 s, padding 30 ms.
4. Metal: directly transcribe bounded inputs. No ONNX CPU VAD or upstream long-file merge path.
5. Normalize all token times to source-relative seconds before ownership filtering.

ONNX timestamps are token starts. Group subwords by decoded whitespace boundaries. Word end is the next distinct word start capped at containing VAD segment end; final word ends at VAD segment end. Internal data labels this estimated timing. Include VAD segment and outer input offsets exactly once.

MLX groups aligned tokens into words using first start and final token end. The pinned runtime exposes aligned tokens with start/duration; see [upstream implementation](https://github.com/senstella/parakeet-mlx).

Keep words whose start lies in `[ownershipStart, ownershipEnd)`; final interval includes source endpoint. Drop context-only words.

Narrow seam repair: compare at most 8 suffix/prefix words within 0.75 s of seam, case-folded/punctuation-stripped, starts differing by at most 0.5 s. Remove duplicated following prefix only for longest contiguous match of at least 2 words. Never collapse a single repetition such as “yes, yes”; never deduplicate across different speaker IDs.

Assemble display segments at punctuation, a 1 s gap, or 20 s accumulated words, using retained word times. Require ordered finite in-bounds intervals. Nonfinite/reversed times, mismatched token arrays, or material bounds violations cause `PARAKEET_INVALID_OUTPUT`. Only rounding correction within 80 ms of a boundary is allowed; never invent whole-recording timestamps for malformed output.

Valid empty result succeeds with “No speech transcribed.” A chunk exception fails the whole attempt; partial output is never published as complete. This policy defines behavior and memory bounds, not perfect recognition or benchmark timing equivalence.

## 8. Guided speaker transcription

Keep existing platform speaker restrictions: Linux Speakrs CUDA only; Windows existing supported Speakrs/Pyannote GPU paths; Apple Silicon Speakrs CoreML or Pyannote MPS.

For Parakeet, one compute queue job runs sequential stages:

1. Diarization in its existing isolated runtime.
2. Wait for process/GPU settlement.
3. One Parakeet child receives validated speaker turns.
4. Load Parakeet once, process all windows.
5. Commit transcript/diarization via guarded persistence.

Never combine Pyannote/Parakeet imports or CUDA directories. Refactor shared window construction in `backend/diarization/guided_transcription.py` for reuse. Preserve minimum turn 0.5 s, same-speaker merge gap 0.6 s, unpadded maximum 18 s, padding 0.35 s.

Map token/word times with `audioStart` and keep words belonging to the unpadded turn. For overlapping turns, assign duplicate temporal words to greatest word-interval overlap; tie-break earlier turn start then speaker ID. This is not simultaneous voice separation. Do not use the existing all-window-text fallback when timestamp filtering selects nothing.

Fallback:

- Diarization failure, no usable windows, or invalid guided assembly: ordinary full-recording Parakeet once.
- Guided ASR/runtime error: one fresh same-engine attempt only after child settlement and successful live admission.
- Cancel/delete/quit/exhausted deadline: no fallback.
- Ordinary Parakeet failure: failed attempt, retained audio/previous transcript.
- Ordinary Parakeet success: save it plus sanitized guidance/diarization error metadata.
- Retain existing optional post-pass diarization without recursive fallback.

Keep transcription engine arguments separate from existing guided `engine`, which denotes diarization.

## 9. Settings, setup, and IPC

Settings gets Transcription engine cards. Recording page retains Whisper's model control; active Parakeet shows static “Parakeet v2” and fixed English.

Versioned preferences contain `activeEngine`, `whisper.language`, and `whisper.modelSize`. Migrate existing preferences once without activating Parakeet.

| State | UI/actions |
| --- | --- |
| checking | Checking Parakeet; no model load/download |
| unsupported | Exact OS/architecture reason; no setup |
| device-unavailable | GPU unavailable; Recheck, plus Repair/Remove if installed |
| not-installed | Model/runtime download totals; Set up Parakeet |
| downloading | Bytes/progress; Cancel |
| verifying | Integrity progress; Cancel |
| waiting-for-validation | Waiting for current AI work; Cancel |
| validating | Local GPU test; Cancel |
| ready | Use Parakeet, Validate, Repair, Remove |
| repair-required | Concise reason; Repair and Remove |
| removing | Progress; unavailable |

Setup returns ready; activation is separate. Cancel keeps previous active engine/generation. Removing active Parakeet leaves the selected engine unavailable and offers Use Whisper, never silently switches. Keep Settings, History, recovery, and recording accessible; recording can be saved with a failed attempt when transcription admission is unavailable.

Setup:

- Explicit setup/repair only; reuse HTTPS allowlist and safe extraction.
- Stage whole generations, never mutate loaded runtimes.
- Full-hash against code-owned pins; writable install metadata is not authority.
- Queue validation without holding a resource lock while awaiting compute admission.
- Recheck cancel/timeout authority immediately before atomic promotion.
- Preserve previous generation on failure; passive status neither loads model nor waits behind compute.
- Removal rejects pending dependent/resource work and synchronously reserves mutation authority before deletion.
- Never remove recordings, Whisper caches, or diarization resources.

New transcription-service-owned channels:

```text
get-transcription-engine-status
setup-transcription-engine
cancel-transcription-engine-setup
validate-transcription-engine
remove-transcription-engine
transcription-engine-setup-progress
```

Status/validate/remove accept `{engine: "parakeet"}`. Setup also accepts `operation: "install" | "repair"`. Main creates operation IDs; cancellation targets ID; progress includes ID, phase, bytes, and sanitized code. Extend existing transcription/finalize/start objects with selection; preserve Whisper string check/download calls. Update preload, all callers, and characterization tests together.

## 10. Queues, timeouts, failures

Preserve single compute queue, resource FIFO, queue `seq`, unchanged transcription-progress string payload, tombstones, late-child termination, and process settlement.

Initial conservative budgets, not performance claims:

- Ordinary Parakeet: 60 minutes.
- Guided composite including fallback: 90 minutes.
- Setup validation: existing 15 minutes.
- Meeting preflight: existing 60 seconds.

One absolute guided deadline reaches every stage; fallback never resets it. Keep Whisper budgets unchanged and match inner/outer timeout behavior.

| Code | Behavior |
| --- | --- |
| PARAKEET_NOT_INSTALLED | Setup; no inference |
| PARAKEET_ARTIFACT_INVALID | Repair required |
| PARAKEET_GPU_UNAVAILABLE | Recheck/repair guidance |
| PARAKEET_RUNTIME_INVALID | Repair required |
| PARAKEET_OUT_OF_MEMORY | Failed; close other GPU work and retry, or explicitly retry Whisper |
| PARAKEET_INVALID_OUTPUT | Failed; preserve old output |
| PARAKEET_SELECTION_UNAVAILABLE | Exact saved adapter/revision unavailable; explicit intervention |
| Existing cancel/delete/quit/timeout codes | Existing lifecycle semantics |

OOM does not mark intact artifacts corrupt. Quit-killed work stays pending under existing rules. User cancellation is failed/cancelled; deletion never resurrects metadata/artifacts.

## 11. File-level task order

### Task 1: Catalog, target policy, and locks

**Files:** Create catalog/resolver and `build/parakeet/{windows-cuda,linux-cuda,macos-metal}.lock.json`; modify `src/transcription-policy.js`; create `tests/js/transcription-engine-resolver.test.js` and `tests/js/parakeet-locks.test.js`; extend `tests/js/transcription-policy.test.js`.

**Implementation:** Sections 1–4. Materialize pinned closures without adding Parakeet to Whisper size arrays. No hardware gate before subsequent tasks.

**Validation:** `node --test tests/js/transcription-engine-resolver.test.js tests/js/parakeet-locks.test.js tests/js/transcription-policy.test.js`. Cases: supported target matrix, English-only validation, unknown engine, legacy Whisper, immutable revisions, missing hashes, sdists, CUDA 13, forbidden shared cuDNN paths.

### Task 2: Requested selection and atomic output provenance

**Files:** Modify `backend/meeting_manager.py`, `backend/meetings/normalization.py`, `backend/meetings/scan_import.py`, `src/main/meeting-manager-client.js`; create `tests/python/test_transcription_engine_metadata.py`; extend `tests/js/meeting-manager-client.behavioral.test.js`.

**Implementation:** Sections 5–6. Preserve locking, instance seams, transactional add and existing outputs across retry failure. Ignore unreferenced attempt Markdown during import.

**Validation:** `.venv/bin/python -m pytest tests/python/test_transcription_engine_metadata.py -q`; `node --test tests/js/meeting-manager-client.behavioral.test.js`. Cases: malformed metadata, legacy requests, failed cross-engine retry retaining provenance, stale attempt, crash before/after commit, atomic-write failure, unchanged source audio.

### Task 3: Capture-time snapshot and recovery

**Files:** Modify `src/main/recorder-service.js`, `src/preload.js`, recorder start caller in `src/renderer/app.js`, `backend/audio/capture_manifest.py`, `capture_spool_runtime.py`, `capture_recovery.py`, `windows_recorder.py`, `macos_recorder.py`, `linux_recorder.py`, and `backend/meetings/scan_import.py`. Extend `tests/js/recorder-event-contract.test.js` and `tests/python/test_recorder_temp_and_scan_recovery.py`; create `tests/python/test_capture_transcription_selection.py` and `tests/js/recorder-transcription-selection.test.js`.

**Implementation:** Section 5. Persist validated choice before capture; propagate through stop/quit/recovery. Preserve session and discard behavior.

**Validation:** `node --test tests/js/recorder-event-contract.test.js tests/js/recorder-transcription-selection.test.js`; `.venv/bin/python -m pytest tests/python/test_capture_transcription_selection.py tests/python/test_recorder_temp_and_scan_recovery.py -q`. Cases: settings changed mid-capture, quit-stop, interrupted recovery, legacy manifests, discarded capture never imported, failed pending persistence never enqueued.

### Task 4: Setup, isolated bootstrap, runtime admission

**Files:** Create setup/runtime/bootstrap modules listed in Section 2; wire through `src/main/transcription-service.js`, `src/main/python-runtime.js`, and `src/main.js`; integrate existing `src/ai-addon/` download/archive helpers; create `tests/js/parakeet-setup.test.js`, `tests/js/parakeet-runtime.test.js`, and `tests/python/test_parakeet_bootstrap.py`.

**Implementation:** Sections 3–4 and 9–10. Complete resource generation staging and explicit setup IPC. No base-runtime dependency pollution.

**Validation:** `node --test tests/js/parakeet-setup.test.js tests/js/parakeet-runtime.test.js`; `.venv/bin/python -m pytest tests/python/test_parakeet_bootstrap.py -q`. Cases: corrupt/truncated file, extra DLL/SO, unsafe archive/redirect, staging restart, cancel-before-promotion, removal races, offline passive status, Windows `_pth` isolation, device mismatch, late child after timeout.

### Task 5: Bounded engine adapters and output contract

**Files:** Create `backend/transcription/parakeet_transcriber.py`, `parakeet_onnx.py`, `parakeet_mlx.py`, `parakeet_segments.py`; reuse `backend/transcription/formatting.py`; create `tests/python/test_parakeet_transcriber.py` and `tests/python/test_parakeet_segments.py`.

**Implementation:** Sections 4 and 7. Real pinned return types, direct local MLX loading, strict device policy, bounded waveform windows, complete result validation.

**Validation:** `.venv/bin/python -m pytest tests/python/test_parakeet_transcriber.py tests/python/test_parakeet_segments.py -q`. Cases: empty speech, nonfinite/reversed/out-of-bounds timestamps, token count mismatch, double-offset prevention, seam ownership, duplicated multiword prefix, retained “yes, yes,” last partial chunk, opening/closing padding, bounded waveform allocation, malformed output never published. Real-adapter smoke is opt-in with installed artifacts; never download from tests.

### Task 6: Normal, guided, retry, and resume lifecycle

**Files:** Modify `src/main/transcription-service.js`, `src/main-process/transcription-runtime-helpers.js`, `src/main-process/compute-timeout-helpers.js`, and `backend/diarization/guided_transcription.py`; extend `tests/js/transcription-service-admission.test.js`, `tests/js/linux-cuda-transcription-admission.test.js`, and `tests/python/test_guided_transcription.py`.

**Implementation:** Sections 5–8 and 10. Same-engine fallback, separate sequential runtime processes, immutable queued requests, fresh execution admission, one deadline, atomic result commit. Distinguish diarization `engine` from transcription engine.

**Validation:** `node --test tests/js/transcription-service-admission.test.js tests/js/linux-cuda-transcription-admission.test.js`; `.venv/bin/python -m pytest tests/python/test_guided_transcription.py -q`. Cases: failed guidance invokes Parakeet only, ordinary retry ignores settings, pending resume exact identity, live GPU removal, deadline shared with fallback, timeout/quit late spawn, cancellation/delete during commit, old transcript survives failed candidate, summary hash invalidation.

### Task 7: Settings, activation, and recovery UI

**Files:** Modify `src/preload.js`, `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/transcription-activity-helpers.js`; create `src/renderer/transcription-engine-helpers.js` and `tests/js/transcription-engine-helpers.test.js`; extend `tests/js/transcription-policy.test.js`, `tests/js/transcription-activity-helpers.test.js`, and `tests/js/ipc-contract-snapshot.test.js`.

**Implementation:** Sections 1, 6, and 9. Separate engine/model controls, independent Whisper preferences, explicit activation and Whisper retry. Cover every renderer caller, including History and recovery entry points.

**Validation:** `node --test tests/js/transcription-engine-helpers.test.js tests/js/transcription-policy.test.js tests/js/transcription-activity-helpers.test.js tests/js/ipc-contract-snapshot.test.js`. Cases: all setup states, preference migration, setup cancel, install does not activate, remove does not switch, ordinary retry ignoring Settings, explicit Whisper retry, recovery accessible when unavailable, queued identity unchanged by UI changes.

### Task 8: Packaging, legal, contracts, final validation

**Files:** Align `build/prepare-resources.js`, `build/download-manifest.js`, `package.json` only as needed for adapter code/locks/validation fixture; update `src/renderer/index.html` About credits, `THIRD_PARTY_NOTICES.md`, `docs/development/LOCAL_AI_MODEL_CATALOG.md`, contracts `local-ai.md`, `ipc.md`, `meeting-persistence.md`, `recording.md`, prior Parakeet integration plan, `todo.md`, and `docs/initiatives/ROADMAP.md`. Extend `tests/js/build-resource-manifest.test.js`, `tests/js/build-download-manifest.test.js`, `tests/js/legal-notices.test.js`, and IPC snapshots.

**Implementation:** Keep payloads setup-time. Do not hand-edit generated resources or add Parakeet to base Whisper requirements. Credit NVIDIA v2, both community conversions, onnx-asr, ORT, Silero, parakeet-mlx, MLX, and runtime redistribution notices. Reconcile prior Tasks 2–6 with this plan and remove obsolete future qualification prerequisites without rewriting historical evidence.

**Validation:** `npm run test:all`. Inspect final diff. Report automated checks separately from hardware/manual results. Use matching-host build commands for packaged artifacts when those hosts are available; do not claim unavailable-host builds passed.

## 12. Manual testing after implementation

Run on Windows CUDA, Linux managed CUDA 12, and macOS Metal:

1. Setup, cancel midway, restart, repair, validate, remove; Whisper preferences survive.
2. Activate, disconnect networking, transcribe short English and a meeting; inspect actual device/provenance and retained playable audio.
3. Inspect opening/closing words and several 18 s seams, including a genuine repeated phrase.
4. Guided work with supported speaker engine; force guidance failure and confirm same-engine fallback.
5. Queue recordings, change Settings, restart/resume; verify saved engine per meeting.
6. GPU/runtime unavailable and memory pressure; actionable failure, no CPU/Whisper substitution, explicit Whisper retry works.
7. Cancel, quit during inference, queued deletion, interrupted recording recovery.
8. Repeat setup/offline inference in packaged app; installed resources survive update.

Record results separately per platform. The partial Mac service-level smoke
is recorded above; the remaining checks have not been run for the new
integration. Mocked GPU tests prove contracts/routing, not hardware execution.

## Out of scope

CPU Parakeet; Intel Mac; Windows ARM; multilingual Parakeet/v3; translation; Whisper Large; automatic engine selection or cross-engine fallback; streaming captions; cloud/telemetry; new diarization engines; bulk retranscription; persistent workers; unrelated Whisper/summary/platform redesign.
