# AvaNevis

> Privacy-first desktop app for recording and transcribing meetings locally with Whisper.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6.svg)](https://www.microsoft.com/windows)
[![macOS](https://img.shields.io/badge/Platform-macOS%2013%2B-000000.svg)](https://www.apple.com/macos)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](https://www.python.org/)
[![Electron](https://img.shields.io/badge/Electron-42-47848F.svg)](https://www.electronjs.org/)

AvaNevis (formerly Meeting Transcriber) records your microphone *and* desktop audio at the same time, then transcribes everything on-device with Whisper. No cloud, no telemetry, no account.

## Why

Online meetings are a tax on memory. The good options for getting transcripts back either upload your audio to someone else's cloud, charge per minute, or only listen to your microphone and miss whatever the other side said. AvaNevis captures both sides, runs the model locally, and keeps everything on disk under your user folder.

## Highlights

- **Dual capture** — microphone + desktop audio recorded in parallel, then mixed after the recording stops to keep both streams intact.
- **Local transcription** — `faster-whisper` on Windows (CUDA when available), `lightning-whisper-mlx` on Apple Silicon (Metal). CPU fallback path exists for non-GPU machines.
- **Premium dark UI** — vertical icon rail, top-bar app pane, dense waveform visualizer with peak-hold and DPR-aware rendering, and a stutter-free custom audio scrubber driven by `requestAnimationFrame`.
- **Markdown transcripts** — saved transcripts are real Markdown (timestamps, headings, lists), and the in-app viewer renders them inline with chip-style timestamp pills.
- **Editable meetings** — rename meetings inline (history *and* immediately after recording) without renaming any files; metadata stays anchored to the meeting ID.
- **Save As anywhere** — export any transcript through Electron's native save dialog as `.md` or `.txt`.
- **Search and bulk-manage history** — filter the meeting list, multi-select, bulk delete, replay with synchronized audio.
- **Recovery-friendly storage** — meetings are persisted with an atomic write + cross-process file lock, with corrupt-metadata backups (`meetings.corrupt.*.json`) and filesystem rescan/import on demand.
- **Optional local AI add-ons** — speaker labels and meeting summaries can be set up after install. Speaker identification uses the user's own Hugging Face token; summaries use pinned local `llama.cpp`/GGUF artifacts and run only when the user clicks Generate Summary.
- **One-click installer** — Windows NSIS and macOS DMG with embedded Python runtime, ffmpeg, and the bundled native macOS helper. No system Python required.
- **Update awareness** — checks GitHub Releases on launch and shows an in-app banner with one-click open of the release page.

## Privacy

- 100% local processing — no cloud transcription, no API calls.
- Optional speaker diarization and summaries are local-only after explicit setup.
- Zero telemetry or analytics.
- No account, login, or signup.
- Speaker diarization requires your own Hugging Face token for the gated pyannote model; AvaNevis does not ship, proxy, or log a maintainer-owned token.
- Summary models/runtimes download only after you explicitly start setup from Settings.
- Open source — audit the code yourself.
- See [docs/internal/SECURITY_AUDIT.md](docs/internal/SECURITY_AUDIT.md) for the full security write-up.

## Install

### Windows

1. Download the latest `AvaNevis-Setup-<version>.exe` from [Releases](https://github.com/AmirArshad/meeting-transcriber/releases).
2. Run it. SmartScreen may warn — click **More info → Run anyway** (the binary is unsigned).
3. Launch *AvaNevis* from the Start Menu.
4. Pick your microphone and desktop-audio loopback device on the Record tab.
5. First transcription downloads the Whisper model (~500MB) once and caches it.

### macOS (Apple Silicon, macOS 13+)

1. Download `AvaNevis-Setup-<version>.dmg` from [Releases](https://github.com/AmirArshad/meeting-transcriber/releases).
2. Open the DMG and drag *AvaNevis* into Applications.
3. **Right-click → Open** the first time. Double-clicking will trigger Gatekeeper to claim the app is "damaged" because the build is unsigned. Right-click → Open bypasses this safely.
4. Grant microphone and desktop-audio permissions when prompted. On macOS 14.2+, AvaNevis uses a CoreAudio process tap that may request System Audio Recording permission; Screen Recording may still be requested by the ScreenCaptureKit fallback. No screen video is saved.
5. First transcription downloads the MLX Whisper model once and caches it under `~/Library/Caches/avanevis/mlx_models`; cached files are reused on later transcriptions.

If right-click → Open misbehaves, run `xattr -d com.apple.quarantine /Applications/AvaNevis.app` once and relaunch.

> **Upgrading from "Meeting Transcriber"?** The new app uses a fresh user-data folder (`%APPDATA%\AvaNevis` on Windows, `~/Library/Application Support/AvaNevis` on macOS), so old recordings won't auto-appear. Move the old folder's contents into the new one to keep your history. The first AvaNevis update prompt for existing Meeting Transcriber installs opens the GitHub release page in your browser instead of auto-downloading; future AvaNevis-to-AvaNevis updates restore the direct-download path.

## Develop

```bash
git clone https://github.com/AmirArshad/meeting-transcriber.git
cd meeting-transcriber

npm install
```

Create a repo-local Python virtual environment named `.venv`. The Electron main process auto-detects this path in development, so you do not need to activate it before running `npm start`.

### Windows `.venv`

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements-windows.txt -r requirements-dev.txt
```

### macOS `.venv`

```bash
python3.11 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements-macos.txt -r requirements-dev.txt
```

Then start the app from the repo root:

```bash
npm start           # run app
npm run dev         # run with --dev flag
```

During local development, AvaNevis picks Python in this order: `AVANEVIS_PYTHON`, an activated `VIRTUAL_ENV`, the repo-local `.venv`, then the system `python3`/`python`.

See [docs/development/BUILD_INSTRUCTIONS.md](docs/development/BUILD_INSTRUCTIONS.md) for packaging and [docs/development/TESTING.md](docs/development/TESTING.md) for setting up the test suite on a fresh machine.

## AI Add-ons

AI Add-ons are optional and live under Settings. They are not required for recording or transcription.

- **Speaker Identification:** Windows CUDA and macOS Apple Silicon MPS paths use `pyannote/speaker-diarization-community-1` with the user's own Hugging Face token. It runs automatically after transcription only when setup is ready. The main process uses catalog-resolved model refs, validates the required accelerator, refuses CPU fallback, and serializes local AI compute work.
- **Meeting Summaries:** Uses a pinned local `llama.cpp` runtime and pinned GGUF model artifacts stored under Electron `userData`. Hugging Face-hosted public GGUF downloads use the bundled `huggingface_hub`/`hf_xet` path without reusing the speaker token. Summary setup verifies HTTPS artifact hosts, SHA-256 checksums, and safe runtime extraction. Summary generation is always user-triggered from Home or History.
- **Expected size:** the default summary model is about 5.7 GB plus platform runtime archives. CUDA setup remains separate and can add several GB.
- **Outputs:** derived files are saved beside recordings as `*.speakers.json`, `*.summary.json`, and `*.summary.md`; raw transcripts remain the source of truth.

See [docs/development/LOCAL_AI_MODEL_CATALOG.md](docs/development/LOCAL_AI_MODEL_CATALOG.md) for catalog maintenance and [tests/manual/local-ai-addons-checklist.md](tests/manual/local-ai-addons-checklist.md) for manual validation.

### Build installers

```bash
npm run prepare-build     # downloads pinned Python + ffmpeg into build/resources
npm run build             # Windows NSIS
npm run build:mac         # macOS DMG (Apple Silicon)
npm run build:dir         # unpacked dir build for fast smoke testing
npm run build:mac:dir     # unpacked .app for macOS
```

The macOS build also signs and bundles the native `audiocapture-helper` Swift binary from `swift/AudioCaptureHelper/`.

### Test

```bash
npm test            # JS regression suite + syntax checks (Node test runner)
npm run test:python # Python regression suite (pytest via cross-platform wrapper)
npm run test:all    # both
```

For recorder changes, also run the manual smoke checklist in `tests/manual/recording-smoke-checklist.md`.

## How it works

1. **Pick devices.** Choose a mic, a desktop-audio loopback device, the language, and a Whisper model size in the Settings tab.
2. **Record.** Both streams are written to disk in parallel (WASAPI loopback on Windows, CoreAudio process tap via the bundled Swift helper on macOS 14.2+, with Swift/PyObjC ScreenCaptureKit fallback). The audio visualizer shows live mic + desktop levels.
3. **Stop.** The recorder reports completion as a structured stdout JSON event. The two streams are aligned, mixed at 48 kHz stereo, kept mono-compatible for transcription, and compressed to Opus (with WAV fallback if ffmpeg fails).
4. **Transcribe.** The mixed audio is passed to the platform-appropriate Whisper backend; output lands as a Markdown transcript with `[mm:ss - mm:ss]` timestamp lines.
5. **Save.** Meeting metadata, audio file, and transcript are persisted to the user-data folder under a unique meeting ID. Meetings that already exist on disk get rescanned and re-imported on launch.

## Audio quality

- 48 kHz target sample rate end-to-end (Windows + macOS parity).
- soxr VHQ resampling for the highest available quality on both platforms.
- Gentle mic enhancement (DC-offset removal, light normalization) — no aggressive denoising or compression. Desktop audio is left untouched.
- Stereo output, Opus-compressed (≈ 95% size reduction vs WAV — a 40-minute meeting is roughly 23 MB).

## Languages

The UI exposes 12 commonly used languages: English, Spanish, French, German, Italian, Portuguese, Mandarin/Cantonese, Japanese, Korean, Farsi/Persian, Punjabi, Hindi. Whisper itself supports 99 — extending the list is a one-line UI change. See [docs/TRANSCRIPTION_GUIDE.md](docs/TRANSCRIPTION_GUIDE.md) for tips.

## Requirements

### Windows

- Windows 10 or 11, 64-bit
- 4 GB RAM minimum, 8 GB recommended
- 2 GB free disk minimum, 10 GB recommended (models + recordings)
- Optional: NVIDIA GPU with 4 GB+ VRAM for CUDA acceleration

### macOS

- macOS 13 (Ventura) or later
- macOS 14.2+ recommended for the CoreAudio system-audio capture path; macOS 13+ uses ScreenCaptureKit fallback behavior
- Apple Silicon (M1/M2/M3/M4) — Intel Macs have a CPU fallback path in dev but are not a packaged target
- 4 GB RAM minimum, 8 GB recommended
- 2 GB free disk minimum, 10 GB recommended

## Tech stack

- **Frontend:** Electron 42, plain HTML / CSS / JavaScript (no UI framework)
- **Backend:** Python 3.11, bundled with the installer
- **Transcription:** `faster-whisper` (Windows, CUDA optional), `lightning-whisper-mlx` (macOS, Metal)
- **Local AI add-ons:** `pyannote.audio` for Windows CUDA and macOS Apple Silicon MPS speaker identification, pinned `llama.cpp` + GGUF for user-triggered summaries
- **Audio capture:** `pyaudiowpatch` WASAPI loopback (Windows), `sounddevice` + native Swift `AudioCaptureHelper` using CoreAudio process taps on macOS 14.2+ with ScreenCaptureKit fallback
- **Audio processing:** NumPy, SciPy, soxr, ffmpeg (Opus)
- **Updater:** GitHub Releases API + in-app banner (release page opens in browser)

## Documentation

- **Users**
  - [Troubleshooting](docs/TROUBLESHOOTING.md) — common issues and fixes
  - [Transcription tips](docs/TRANSCRIPTION_GUIDE.md)
  - [Meeting features](docs/MEETING_TRANSCRIPTION.md) — history, recovery, metadata
  - [macOS install guide](docs/MACOS_INSTALLATION.md)
- **Developers**
  - [Build instructions](docs/development/BUILD_INSTRUCTIONS.md)
  - [Testing guide](docs/development/TESTING.md)
  - [GPU setup (CUDA)](docs/development/SETUP_GPU.md)
  - [Local AI model catalog](docs/development/LOCAL_AI_MODEL_CATALOG.md)
  - [Installer implementation](docs/development/INSTALLER_IMPLEMENTATION.md)
- **Roadmap & features**
  - [Roadmap](docs/ROADMAP.md)
  - [Speaker diarization](docs/features/FEATURE_SPEAKER_DIARIZATION.md)
  - [Transcript summaries](docs/features/FEATURE_TRANSCRIPT_SUMMARIES.md)
  - [Local AI feature plan](docs/features/PLAN_LOCAL_AI_FEATURES.md)
  - [Setup wizard](docs/features/FEATURE_SETUP_WIZARD.md)
  - [Audio visualizer](docs/features/FEATURE_AUDIO_VISUALIZER.md)
  - [Update checks](docs/features/FEATURE_AUTO_UPDATER.md)
  - [JSON-based event system](docs/features/json-based-events.md)

## Roadmap (short version)

**Shipped recently**
- Optional local AI add-on foundations: Settings setup cards, pinned summary model/runtime catalog, secure diarization token storage, automatic post-transcription speaker labels when setup is ready, and user-triggered summary generation with History Transcript/Summary tabs.
- Premium dark UI overhaul: vertical icon rail, top-bar pane, expressive dual-channel waveform with peak-hold and interpolation, custom rAF-driven audio scrubber, multi-select with bulk delete, sidebar search, relative-time meeting timestamps, developer console drawer.
- Markdown transcript rendering in the meeting viewer (timestamps as accent pill chips), with the raw `.md` preserved as the copy/save source of truth.
- Inline meeting rename in both history and post-recording views (via a new `update-meeting` IPC + `MeetingManager.update_meeting`).
- Save transcripts via the native save dialog (`.md` / `.txt` / All Files) with sanitized default filenames.
- Slimmer audio visualizer (denser buffer, gentler glow and peak cap).
- Cross-process atomic meeting metadata writes with corrupt-file backups and transactional add behavior.
- Rebrand from Meeting Transcriber to AvaNevis (display name, installers, Info.plist descriptions, slug paths). GitHub repo slug stays `meeting-transcriber`.

**Next up**
- True silent auto-install updater (today's updater detects the new release and opens the download page).
- Hardware validation for Windows CUDA speaker identification and long local summaries.
- Real-time / streaming transcription.
- Export to SRT, VTT, DOCX, JSON.
- Acoustic echo cancellation when desktop audio bleeds into the mic.

Full plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## Contributing

Issues and discussions live on GitHub:

- **Issues:** https://github.com/AmirArshad/meeting-transcriber/issues
- **Discussions:** https://github.com/AmirArshad/meeting-transcriber/discussions

PRs welcome. Please run `npm run test:all` before opening one and add coverage for any new IPC or recorder-output behavior — the JS test suite asserts cross-process contracts and the Python suite covers meeting-manager invariants.

## Acknowledgments

- **OpenAI** for Whisper.
- **faster-whisper** for the efficient CUDA/CPU implementation.
- **Lightning-Whisper-MLX** for Apple Silicon Metal acceleration.
- **PyAudioWPatch** for WASAPI loopback on Windows.
- **CoreAudio process taps** and **ScreenCaptureKit** for clean desktop audio on macOS.
- **Electron** for making this kind of cross-platform desktop app practical.

## License

MIT — see [LICENSE.txt](LICENSE.txt).

## Repo note

The GitHub repository is still `AmirArshad/meeting-transcriber` even though the app is now AvaNevis. The repo slug was kept to avoid breaking existing clones, release URLs, and the in-app updater's trusted-URL allowlist. Everything user-facing (window title, installer, bundle, paths, docs) reads "AvaNevis".
