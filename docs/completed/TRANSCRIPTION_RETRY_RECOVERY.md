# Transcription Retry and Recovery Design

## Context

On 2026-05-27, a 92-minute Windows recording completed successfully, but post-recording transcription failed with:

```text
RuntimeError: Library cublas64_12.dll is not found or cannot be loaded
```

The failure happened after faster-whisper reported that the model loaded on CUDA. The app had already saved the `.opus` recording under Electron `userData`, but because meeting history is currently saved only after transcription succeeds, the recording did not appear as a recoverable meeting in History.

This incident exposed two separate gaps:

1. CUDA readiness detection can report success when the NVIDIA device is visible but required runtime DLLs are not loadable by the packaged Python process.
2. Transcription failures leave valid recordings stranded on disk with no History entry or retry action.

## Manual test fixture (incident recording)

Keep this recording on the development machine (or a backup copy) to validate scan/recovery and **Retry transcription** after the feature ships. It is **not** checked into the repo; paths are under the user’s Electron `userData` cache.

| Field | Value |
| --- | --- |
| **Audio file** | `C:\Users\Amirs\AppData\Roaming\avanevis\Cache\avanevis\recordings\recording_2026-05-27T14-32-26.opus` |
| **Filename** | `recording_2026-05-27T14-32-26.opus` |
| **Expected transcript (missing)** | `recording_2026-05-27T14-32-26.md` — not created because transcription failed |
| **Approx. size** | ~78.6 MB (~82,400,000 bytes) on disk as of 2026-05-27 |
| **Approx. duration** | ~92 minutes (recording stopped before transcription failed) |
| **Failure time (local)** | 2026-05-27 ~16:56 (transcription failed at segment encode) |
| **Transcription settings** | Model: `medium`, language: `en`, device: `auto` (CUDA selected, then `cublas64_12.dll` load failure) |
| **Expected scan meeting ID** | `20260527_143226` (derived from `recording_YYYY-MM-DDTHH-MM-SS` stem in `meeting_manager.scan_and_sync_recordings`) |
| **History status before fix** | Audio on disk only; not in `meetings.json` (no successful `addMeeting`) |

**Post-implementation checks using this file:**

1. Confirm the `.opus` file still exists at the path above (or restore from backup).
2. Run **scan/import** (or app launch recovery, per final UX) and verify the meeting appears with `transcriptionStatus` `pending` or `failed`.
3. Use **Retry transcription** from History; expect a full transcript and normal `meeting_*.md` persistence.
4. Optional CLI smoke before UI: packaged or dev Python transcriber with `--file` pointing at this path and `--device cpu` (long run; medium model timeout is 90 minutes per `getTranscriptionComputeTimeoutMs`).

Do not commit this audio file to git. If the path moves after an app reinstall, search `userData` for `recording_2026-05-27T14-32-26.opus`.

## Goals

- Preserve every completed recording even when transcription, diarization, or summary generation fails.
- Automatically recover from transient or misconfigured CUDA transcription failures by retrying once on CPU.
- Make GPU readiness checks match the actual runtime requirements of faster-whisper/CTranslate2.
- Give users a visible, low-friction way to retry transcription from History.
- Keep retry behavior local-only and compatible with the existing AI compute queue.

## Non-goals

- Do not add cloud transcription or upload-based recovery.
- Do not run infinite retries or background retries without user consent.
- Do not make CPU fallback the default when CUDA is healthy.
- Do not bundle Whisper model weights in the base installer.
- Do not change the recorder stdout JSON contract.

## Current Behavior

### Transcription flow

1. Renderer stops recording and receives `result.audioPath`.
2. Renderer calls `transcribeAudio()`.
3. Main process handles `transcribe-audio` and enqueues the Python transcriber on `aiComputeActionQueue`.
4. Python `faster_whisper_transcriber.py` chooses `device="auto"`.
5. If the Python process exits successfully, renderer saves the transcript and then calls `addMeeting`.
6. If transcription fails, renderer displays an error and returns to idle.

### Persistence gap

`addMeeting` requires both an audio path and a transcript path. Because the renderer calls it only after transcription succeeds, a valid recording with a failed transcription remains in `userData/recordings` but is not added to `meetings.json`.

The existing scan/import path also skips audio files without a matching `.md` transcript, so it does not recover this failure mode.

## Observed CUDA Failure Mode

On the affected Windows machine:

- `nvidia-smi` detected an RTX 4070.
- CTranslate2 reported at least one CUDA device.
- AvaNevis embedded Python did not have `nvidia-cublas-cu12` or `nvidia-cudnn-cu12` installed in its packaged site-packages.
- `cublas64_12.dll` was not loadable by name from the packaged Python process.
- Some NVIDIA CUDA DLLs existed under a separate user Python 3.13 site-packages directory, but the packaged app uses Python 3.11.

This means "CUDA device exists" is not enough. The app must verify that the exact runtime libraries required by the packaged transcription process are present and loadable.

As of the current packaged runtime, the supported transcription CUDA profile is CUDA 12 (`nvidia-cublas-cu12` + `nvidia-cudnn-cu12`). If only newer major runtime DLLs are present (for example `cublas64_13.dll`), the runtime check should report an unsupported runtime-major mismatch and continue with CPU fallback rather than treating the system as fully GPU-ready.

## Proposed Design

### 1. Add explicit transcription device control

Add a CLI option to `backend/transcription/faster_whisper_transcriber.py`:

```text
--device auto|cpu|cuda
```

Default remains `auto`.

Main-process handlers should pass:

- `--device auto` for normal transcription.
- `--device cpu` for CPU retry attempts.
- Potentially `--device cuda` only for diagnostics or future explicit advanced settings.

The Python `TranscriberService` should keep using its existing `device` constructor argument, but the CLI must stop hard-coding `device="auto"`.

### 2. Verify CUDA runtime loadability

Add a lightweight CUDA runtime probe for Windows packaged and dev environments.

The probe should check:

- CTranslate2 can see a CUDA device.
- Required DLLs are loadable from the same environment used by transcription:
  - `cublas64_12.dll`
  - `cublasLt64_12.dll`
  - `cudnn64_9.dll` or the cuDNN DLL set expected by the installed CTranslate2 version

Prefer checking via the same Python executable and `PATH` construction used for transcription. This avoids false positives from another Python installation or a user shell environment.

`check-cuda` should return structured status such as:

```json
{
  "installed": false,
  "deviceAvailable": true,
  "runtimeLoadable": false,
  "missingLibraries": ["cublas64_12.dll"],
  "runtime": "ctranslate2"
}
```

Renderer messaging should distinguish:

- No NVIDIA GPU detected.
- NVIDIA GPU detected, but CUDA runtime libraries are missing.
- CUDA runtime healthy.

### 3. Python-level CUDA fallback during transcription

Model construction can succeed even when the first real encoder call later fails. To cover that, `TranscriberService.transcribe_file()` should catch known CUDA runtime failures while consuming the segment generator.

Suggested behavior:

1. Run once with selected device.
2. If the selected device is CUDA and the error is a known CUDA runtime/load failure, clean up the CUDA model.
3. Reload the same model on CPU with `compute_type="int8"`.
4. Retry the whole transcription once.
5. Emit clear stderr progress:

```text
CUDA transcription failed because required runtime libraries could not be loaded.
Retrying transcription on CPU. This may take significantly longer.
```

Known retryable patterns should include:

- `cublas64_12.dll`
- `cublasLt64_12.dll`
- `cudnn`
- `CUDA failed`
- `CUDA error`
- `Library ... is not found or cannot be loaded`

Do not retry for:

- Missing audio file.
- Invalid model cache.
- JSON serialization failures.
- User cancellation.
- Wall-clock timeout.
- Repeated CPU failure.

### 4. Main-process CPU retry as a second safety net

Even with Python-level fallback, the main process should retry once if the Python process exits with a known CUDA runtime error before Python fallback can complete.

Add a helper in `src/main-process-helpers.js`, for example:

```js
function isRetryableCudaTranscriptionError(errorOutput) { ... }
```

In `src/main.js`:

- Keep the existing `transcribe-audio` IPC surface.
- Internally run `runTranscriptionProcess({ device: 'auto' })`.
- If it fails with retryable CUDA output, send a progress message and run `runTranscriptionProcess({ device: 'cpu' })`.
- Ensure both attempts run inside the same queued compute action and wall-clock timeout policy, or explicitly decide whether the retry gets a fresh timeout.

Recommended timeout behavior:

- Use the current model-size timeout for the entire operation at first.
- If CPU retry begins after substantial GPU time, surface progress clearly.
- Revisit timeout sizing if CPU retries on long meetings frequently exceed current limits.

### 5. Save failed recordings to History

When recording stops successfully but transcription fails, persist the recording as a History item.

Minimum viable approach:

- Create a placeholder `.md` transcript next to the audio.
- Add meeting metadata with:
  - `model`: selected model
  - `language`: selected language
  - `transcriptionStatus`: `failed`
  - `transcriptionError`: sanitized concise error string
  - `audioPath`
  - `transcriptPath`

Placeholder transcript example:

```md
# Recording Awaiting Transcription

**Date:** 2026-05-27 14:32:26
**Status:** Transcription failed

The recording was saved successfully, but transcription failed.
Use Retry Transcription in AvaNevis to generate a transcript.
```

Long term, `meeting_manager.py` can support audio-only meetings, but the placeholder transcript is a smaller change because current UI and summary generation already assume `transcriptPath` exists.

### 6. Add History retry action

For meetings with `transcriptionStatus: "failed"` or `"pending"`, History detail should show:

- Audio player.
- Failure summary.
- `Retry transcription` button.
- Optional model/language selectors or use current Home settings.

On retry:

1. Disable the retry button and show progress.
2. Call a main-process IPC handler such as `retry-transcription`.
3. Reuse the existing compute queue and transcription runtime.
4. On success, overwrite the placeholder transcript with normal transcript Markdown.
5. Update metadata:
   - `transcriptionStatus: "completed"`
   - clear `transcriptionError`
   - update `durationSeconds`, `language`, `model`
6. Reload the History detail view.

Retry should be user-triggered. Do not auto-retry old failed meetings on app launch.

### 7. Recovery scan improvement

Extend scan/import to recover audio-only recordings:

- If an audio file has no `.md`, create a placeholder transcript and add a meeting with `transcriptionStatus: "pending"`.
- Preserve the current behavior for files that already have transcripts.
- Continue skipping unsafe paths and symlinks.

This protects against older stranded recordings and app exits between stop and save.

### 8. UI copy and progress

Suggested user-facing messages:

- During automatic CUDA fallback:
  - `GPU transcription failed because CUDA runtime libraries could not be loaded. Retrying on CPU; this may take significantly longer.`
- After failed transcription but saved recording:
  - `Recording saved, but transcription failed. You can retry from History.`
- In History:
  - `This recording has not been transcribed yet.`
  - `Retry transcription`

Avoid showing raw stack traces in the primary UI. Keep detailed stderr in logs/progress for debugging, with existing redaction.

## Implementation Plan

### Phase A — Runtime detection

- Add CUDA DLL loadability probe.
- Update `check-cuda` return shape.
- Update renderer settings/status copy.
- Add JS helper tests for retryable CUDA error classification and CUDA status mapping.

### Phase B — CPU retry

- Add `--device` CLI flag to faster-whisper transcriber.
- Add Python retry around segment iteration.
- Add main-process retry wrapper for known CUDA runtime failures.
- Add Python tests with a fake model whose segment generator fails once on CUDA and succeeds on CPU.
- Add JS tests for retryable error detection.

### Phase C — Failed recording persistence

- Add placeholder transcript creation.
- Save failed transcription meetings to history.
- Add meeting metadata fields for transcription status/error.
- Ensure summary generation refuses failed/pending transcripts with a clear message.
- Add Python meeting manager tests for scan recovery of audio-only files.

### Phase D — History retry UX

- Add preload API for retry transcription if a new IPC handler is needed.
- Add History detail retry button and progress state.
- Update transcript rendering for pending/failed meetings.
- Add focused renderer helper tests if logic is extracted.

## Test Plan

Automated:

```bash
npm test
npm run test:python
```

Targeted Python tests:

- CUDA model load succeeds but segment iteration raises `cublas64_12.dll` error; CPU retry succeeds.
- Non-CUDA errors do not retry.
- CPU retry failure returns the CPU error with context.
- `--device cpu` never attempts CUDA fallback.

Targeted JS tests:

- Retryable CUDA errors are classified correctly.
- Non-retryable transcription errors are not retried.
- `check-cuda` reports missing DLLs separately from missing GPU.
- Failed transcription meeting metadata is rendered as retryable.

Manual Windows smoke:

- Healthy CUDA: record short clip, transcribe on GPU.
- Broken CUDA runtime: temporarily remove CUDA DLL path or uninstall optional CUDA packages, record short clip, verify CPU fallback and successful transcript.
- Long recording recovery: use the incident fixture `recording_2026-05-27T14-32-26.opus` (see **Manual test fixture**); scan/retry from History and confirm ~92-minute transcript completes (CPU fallback acceptable).
- Failed retry path: force CPU failure with invalid audio and verify recording remains in History.

Manual packaging smoke:

- Packaged Windows app uses embedded Python runtime for CUDA checks.
- CUDA setup installs runtime DLLs where packaged app can load them.
- Existing Python 3.13 user packages do not create false CUDA-ready status for packaged Python 3.11.

## Open Questions

- Should CPU retry get a fresh wall-clock timeout after CUDA failure, or share the original timeout?
- Should the retry button use the original model/language, current Home settings, or expose per-meeting controls?
- Should failed transcription metadata live at the top level (`transcriptionStatus`) or under an `ai.transcription` namespace?
- Should audio-only scan recovery be automatic on app launch or only when the user clicks refresh/scan?

## Related Files

- `backend/transcription/faster_whisper_transcriber.py`
- `src/main.js`
- `src/main-process-helpers.js`
- `src/preload.js`
- `src/renderer/app.js`
- `backend/meeting_manager.py`
- `tests/python/test_transcriber_helpers.py`
- `tests/js/main-process-helpers.test.js`
