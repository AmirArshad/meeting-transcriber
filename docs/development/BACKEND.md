# Backend Development Notes

The backend is a set of Python 3.11 modules spawned by the Electron main process. It records audio, enumerates devices, manages meeting metadata, runs transcription, and executes optional local AI add-ons.

## Main Entry Points

- `backend/device_manager.py` — enumerate and validate audio devices.
- `backend/audio/windows_recorder.py` — Windows microphone plus WASAPI loopback recording.
- `backend/audio/macos_recorder.py` — macOS microphone plus desktop/system audio recording.
- `backend/transcription/faster_whisper_transcriber.py` — Windows/default Whisper transcription.
- `backend/transcription/mlx_whisper_transcriber.py` — Apple Silicon MLX transcription.
- `backend/meeting_manager.py` — locked, atomic meeting metadata persistence.
- `backend/diarization/guided_transcription.py` — diarization-first speaker-guided transcription.
- `backend/summaries/summary_runner.py` — local summary generation and sidecar output.

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

- Recorder control-flow messages are structured JSON on stdout.
- Recorder stderr is debug-only.
- Windows recorder final JSON uses `audioPath`.
- macOS recorder final JSON uses `outputPath`.
- Meeting metadata writes must preserve file locks, atomic temp-file writes, corrupt backups, and transactional add/delete behavior.
- Optional AI add-ons must never write Hugging Face tokens to logs, metadata, transcripts, summaries, or progress events.

For the complete cross-process invariants, use root `AGENTS.md`.
