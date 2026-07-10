# Backend Development Notes

The backend is a set of Python 3.11 modules spawned by the Electron main process. It records audio, enumerates devices, manages meeting metadata, runs transcription, and executes optional local AI add-ons.

For cross-process invariants (recorder stdout JSON, compute queue, AI add-ons, packaging), use root `AGENTS.md`. Electron spawns these modules from Pattern C services under `src/main/` (wired by `src/main.js`).

## Architecture Map

### CLI / orchestration entry points

- `backend/device_manager.py` — enumerate and validate audio devices (CLI/JSON contract unchanged).
- `backend/check_permissions.py` — macOS permission checks.
- `backend/meeting_manager.py` — meeting history CLI/orchestration (`python -m meeting_manager`); public methods remain instance-method monkeypatch seams over `backend/meetings/`.
- `backend/audio/windows_recorder.py` — Windows microphone plus WASAPI loopback recording.
- `backend/audio/macos_recorder.py` — macOS microphone plus desktop/system audio recording.
- `backend/transcription/faster_whisper_transcriber.py` — Windows/default Whisper transcription.
- `backend/transcription/mlx_whisper_transcriber.py` — Apple Silicon MLX transcription.
- `backend/diarization/guided_transcription.py` — diarization-first speaker-guided transcription.
- `backend/diarization/diarization_pipeline.py` — local pyannote diarization runner and speaker merge.
- `backend/summaries/summary_runner.py` — local summary generation and sidecar output.

### Shared / extracted helpers (post-refactor)

| Area | Modules |
|------|---------|
| Devices | `backend/device_helpers.py` — blocklist, record shaping, dedupe, sort, macOS virtual loopback |
| Common | `backend/common/sensitive_text.py`, `backend/common/hf_runtime.py` |
| Meetings | `backend/meetings/normalization.py`, `scan_import.py`, `paths.py`, `store.py`, `delete_tx.py` |
| Recorder stdout | `backend/audio/recorder_stdout.py` — structured `send_*` emitters; platform recorders keep thin wrappers |
| Recorder temps | `backend/audio/recorder_temp_paths.py` — non-scanned `.pcm.tmp` paths |
| Audio processing | `backend/audio/processor.py`, `compressor.py`, `wav_io.py`, `timeline.py`, `constants.py` |
| macOS capture | `backend/audio/swift_audio_capture.py`, `macos_stereo_repair.py`, `macos_desktop_diagnostics.py`, `macos_stream_alignment.py`, `swift_pcm_alignment.py`, `swift_helper_status.py` |
| Transcription | `backend/transcription/formatting.py` — shared timestamp/segment-merge/Markdown helpers |
| Diarization | `backend/diarization/audio_prep.py` — ffmpeg 16 kHz mono prep (re-exported by pipeline) |
| Summaries | `backend/summaries/sidecar_io.py`, `summary_pipeline.py`, `llama_runtime.py`, `hf_model_downloader.py` |

## Setup

Use the repo-root setup instructions in `README.md` and install platform requirements into a repo-local `.venv`.

Windows:

```bash
py -3.11 -m pip install -r requirements-windows.txt -r requirements-dev.txt
```

macOS:

```bash
python3.11 -m pip install -r requirements-macos.txt -r requirements-dev.txt
```

## Useful Commands

Device enumeration:

```bash
python backend/device_manager.py
```

Python tests:

```bash
npm run test:python
```

Syntax checks (recursive under `backend/`, including `meetings/`, `summaries/`, `diarization/`, `common/`):

```bash
npm run test:python-syntax
# or: python scripts/check_python_syntax.py
```

## Important Contracts

- Recorder control-flow messages are structured JSON on stdout (`levels`, `event`, `warning`, `error`).
- Recorder stderr is debug-only.
- Windows recorder final JSON uses `audioPath`; macOS uses `outputPath`. Electron accepts both (intentional; not a pending unification).
- Stop/finalize failures must emit structured `success: false` JSON (with recoverable paths when a final or temp file exists), not only a stderr traceback.
- Meeting metadata writes must preserve file locks, atomic temp-file writes, corrupt backups, and transactional add/delete behavior.
- Optional AI add-ons must never write Hugging Face tokens to logs, metadata, transcripts, summaries, or progress events.

For the complete cross-process invariants, use root `AGENTS.md`.
