# AvaNevis

> Local desktop app for recording microphone and desktop audio, importing audio files, and transcribing on your device.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6.svg)](https://www.microsoft.com/windows)
[![macOS](https://img.shields.io/badge/Platform-macOS%2015%2B-000000.svg)](https://www.apple.com/macos)
[![Linux](https://img.shields.io/badge/Platform-Linux%20x86__64%20Core%20Beta-FCC624.svg)](https://omarchy.org/)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](https://www.python.org/)
[![Electron](https://img.shields.io/badge/Electron-46%20alpha-47848F.svg)](https://www.electronjs.org/)

AvaNevis (formerly Meeting Transcriber) is a local audio recorder and transcriber. Capture your microphone, desktop audio, or both at once—or import existing audio files—and transcribe on your device with Whisper or optional NVIDIA Parakeet. Optional local add-ons add speaker labels and recording summaries or transcript chat. No cloud upload, no telemetry, no account.

**Latest published release:** [v2.12.0](docs/releases/v2.12.0.md) adds local audio import and dependency updates. See its [qualification record](docs/development/V2_12_QUALIFICATION.md) and [release status](todo.md). Tagged installers are published by the [release workflow](https://github.com/AmirArshad/meeting-transcriber/actions/workflows/build-release.yml).

## Why

Most transcription tools either upload your audio to a remote server, charge per minute, or only record your microphone and miss whatever is playing on your computer. AvaNevis works for calls, interviews, lectures, voice notes, podcasts, or any desktop audio: it records mic and system streams locally, runs transcription on your own hardware, and keeps everything stored in your user folder.

## Highlights

- **Dual or single capture** — record microphone audio, desktop audio, or both in parallel (mixed cleanly after recording stops).
- **Durable long recordings** — capture writes to on-disk track spools rather than holding the full recording in memory. Stop uses bounded finalization; interrupted sessions can be recovered after relaunch.
- **Recording status indicators** — visible in-app recording indicator and elapsed clock; macOS menu-bar `REC` and Dock badge; Windows taskbar overlay; Linux StatusNotifierItem tray (with taskbar fallback when tray creation fails); hourly reminders; single-instance focus.
- **Local transcription engines** — `faster-whisper` on Windows and Linux, `lightning-whisper-mlx` on Apple Silicon (Small, Medium, Large v3), plus optional English-only **Parakeet v2** (`parakeet-tdt-0.6b-v2`) on Windows CUDA, Apple Silicon Metal, and Linux managed CUDA 12. Linux defaults to CPU Whisper; managed CUDA 12 is an explicit x86_64 NVIDIA setup path, and a broken installed runtime stays disabled until repaired or removed.
- **Desktop interface** — vertical navigation rail, dual-channel level meters with peak hold, custom audio scrubber synced to playback, keyboard shortcuts, and built-in dark theme.
- **Markdown transcripts** — saved transcripts use standard Markdown (timestamps, headings, lists), and the built-in viewer renders them with clickable timestamp pills.
- **Import local audio** — add WAV, MP3, or Opus files to History, choose the transcription engine and language, and run them through the local queue without altering the original file.
- **Editable titles** — rename recordings inline in History or right after stopping, without moving or renaming files on disk.
- **Export anywhere** — save any transcript as `.md`, `.txt`, `.srt`, or `.vtt` subtitles through your OS save dialog.
- **Search and local Chat** — full-text search across recordings and transcripts (`SQLite FTS5`), bulk selection and deletion, synchronized playback, and optional local Q&A with clickable timestamp citations when Summaries & Chat is set up.
- **Recovery-friendly storage** — recordings are saved with atomic writes and a cross-process file lock, corrupt-metadata backups (`meetings.corrupt.*.json`), and filesystem rescanning on launch or manual refresh.
- **Optional local AI add-ons** — speaker labels (**Speakrs** token-free or **Pyannote** on Windows and macOS; **Speakrs** CUDA-only on Linux) and **Summaries & Chat** (`Qwen + llama.cpp`) are explicit opt-in downloads in Settings. On Linux, Pyannote, CPU fallback, and cloud fallback are unavailable; Speakrs and summaries require an admitted CUDA runtime. Linux test evidence is limited to CachyOS x86_64 + RTX 4070; see the [Linux guide](docs/guides/LINUX_EXPERIMENTAL.md).
- **Standalone installers** — Windows NSIS and macOS DMG bundle Python, ffmpeg, `speakrs-cli`, and the macOS audio helper. Linux x86_64 packages bundle Python/ffmpeg/backend and stage `speakrs-cli`; add-on models and CUDA libraries download only when you run setup. No system Python is required.
- **Update checks** — checks GitHub Releases on launch and offers one-click download of the matching installer (or opens the release page).

## Privacy

- 100% local processing — no cloud transcription, no API calls.
- Optional speaker diarization and summaries are local-only after explicit setup.
- Zero telemetry or analytics.
- No account, login, or signup.
- Speaker diarization with **Pyannote** requires your own Hugging Face token for the gated pyannote model; AvaNevis does not ship, proxy, or log a maintainer-owned token. **Speakrs** setup is token-free. Tokens and other secrets are redacted from progress output and from persisted meeting AI error fields.
- Summary models/runtimes download only after you explicitly start setup from Settings.
- Open source — audit the code yourself.
- Third-party licenses and attributions: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- See [docs/completed/audits/SECURITY_AUDIT.md](docs/completed/audits/SECURITY_AUDIT.md) for the full security write-up.

## Install

### Windows

1. Download the latest `AvaNevis-Setup-<version>.exe` from [Releases](https://github.com/AmirArshad/meeting-transcriber/releases).
2. Run it. SmartScreen may warn — click **More info → Run anyway** (the binary is unsigned).
3. Launch *AvaNevis* from the Start Menu.
4. Pick your microphone and desktop-audio loopback device on the Record tab.
5. First transcription downloads the Whisper model (~500MB) once and caches it.

### macOS (Apple Silicon, macOS 15+)

**macOS 14:** Stay on [v2.10.3](https://github.com/AmirArshad/meeting-transcriber/releases/tag/v2.10.3). The v2.12 installer requires macOS 15 or later, even if the older app offers the update.

1. Download `AvaNevis-Setup-<version>.dmg` from [Releases](https://github.com/AmirArshad/meeting-transcriber/releases).
2. Open the DMG and drag *AvaNevis* into Applications.
3. The app is ad-hoc signed and not notarized. If macOS blocks it, open **System Settings → Privacy & Security**, then choose **Open Anyway** after attempting to open the app. See [Apple’s instructions](https://support.apple.com/en-us/102445).
4. Grant microphone and desktop-audio permissions when prompted. On macOS 14.2+, AvaNevis uses a CoreAudio process tap that may request System Audio Recording permission; Screen Recording may still be requested by the ScreenCaptureKit fallback. No screen video is saved.
5. First transcription downloads the MLX Whisper model once and caches it under `~/Library/Caches/avanevis/mlx_models`; cached files are reused on later transcriptions.


### Linux (x86_64 Core Beta — Omarchy and CachyOS)

**Supported:** Omarchy 4 and CachyOS x86_64 on Hyprland/Wayland with PipeWire. Install `AvaNevis-Setup-<version>.pkg.tar.zst`, or run the AppImage.

**Experimental beta:** Ubuntu/Debian-family `.deb` or AppImage; vanilla Arch pacman or AppImage; Fedora Workstation and SteamOS Desktop Mode AppImage; CachyOS sessions that are not Hyprland. Distro matrix and likely failures: [LINUX_EXPERIMENTAL.md](docs/guides/LINUX_EXPERIMENTAL.md). Ubuntu desktop recording has not been smoke-tested yet. The 60-minute soak was cancelled (not run).

The AppImage is a static-pie runtime and does **not** need host `fuse2` / `libfuse.so.2` (kernel `/dev/fuse` + `fuse3` still mount the image). Do not treat `--appimage-extract-and-run` as the shipped default.

Transcription defaults to local CPU `faster-whisper`. On x86_64 Linux with a verified managed CUDA 12 runtime and NVIDIA GPU, CUDA transcription and local add-ons may be set up; otherwise their controls remain fail-closed. Linux support and acceptance boundaries are in [LINUX_EXPERIMENTAL.md](docs/guides/LINUX_EXPERIMENTAL.md). The [v2.9 compatibility matrix](docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md) is the historical release evidence record.

> **Upgrading from "Meeting Transcriber"?** The new app uses a fresh user-data folder (`%APPDATA%\AvaNevis` on Windows, `~/Library/Application Support/AvaNevis` on macOS, `~/.config/avanevis` on Linux), so old recordings won't auto-appear. Move the old folder's contents into the new one to keep your history. The in-app update banner opens the matching installer download in your browser, or the GitHub release page if no installer matches. It does not install the update.

## Develop

```bash
git clone https://github.com/AmirArshad/meeting-transcriber.git
cd meeting-transcriber

npm ci
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

### Linux `.venv` (Omarchy / Arch and other x86_64 desktops)

```bash
python3.11 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements-linux.txt -r requirements-dev.txt
```

Linux capture uses Pulse/PipeWire (`docs/initiatives/LINUX_SUPPORT.md`). The `.venv` is for device enumeration, tests, and `npm start`. Packaged AppImage/pacman/deb builds use bundled Python 3.11 and ffmpeg (`npm run build:linux`). Linux AI features are CUDA-only and remain fail-closed without an admitted managed runtime. Current support boundaries are in [LINUX_EXPERIMENTAL.md](docs/guides/LINUX_EXPERIMENTAL.md) and the [v2.10 qualification record](docs/development/V2_10_LINUX_RELEASE_QUALIFICATION.md). The [v2.9 compatibility matrix](docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md) is historical release evidence.

Then start the app from the repo root:

```bash
npm start           # run app
npm run dev         # run with --dev flag
```

During local development, AvaNevis picks Python in this order: `AVANEVIS_PYTHON`, an activated `VIRTUAL_ENV`, the repo-local `.venv`, then the system `python3`/`python`.

See [docs/development/BUILD_INSTRUCTIONS.md](docs/development/BUILD_INSTRUCTIONS.md) for packaging and [docs/development/TESTING.md](docs/development/TESTING.md) for setting up the test suite on a fresh machine.

## AI Add-ons

AI Add-ons are optional and live under Settings. They are not required for recording or transcription.

- **Speaker Identification:** Settings lets you install **one** engine: **Speakrs** (no account needed; default for new users on Windows CUDA / macOS Apple Silicon CoreML; the only engine on Linux CUDA) or **Pyannote** (`pyannote/speaker-diarization-community-1` with your own Hugging Face token; Windows CUDA / macOS Apple Silicon MPS only — unavailable on Linux). Switching uninstalls the other engine's models; a saved Hugging Face token is kept across a switch and when removing Speakrs, and deleted when removing Pyannote. When ready, AvaNevis runs diarization before transcription and uses padded speaker turns to create speaker-guided chunks; if that guided path fails, it saves a standard transcript and records the speaker-label error. The main process uses catalog-resolved model refs, validates the required accelerator, disables standalone Speakrs CPU mode, and serializes heavy AI work (transcription, diarization, guided transcription, summaries, and Chat) through one compute queue with timeouts so a stalled job cannot block the app.
- **Summaries & Chat:** Uses a pinned local `llama.cpp` runtime and pinned GGUF model artifacts stored under Electron `userData`. Hugging Face-hosted public GGUF downloads use bundled `huggingface_hub` HTTPS with patched certifi, without reusing the speaker token. Native Xet acceleration is disabled pending its certificate-trust qualification; large downloads can take longer. Setup verifies HTTPS artifact hosts, SHA-256 checksums, and safe runtime extraction. Summary generation and Chat questions are always user-triggered. The current Qwen model supports English, Spanish, French, German, Chinese, Japanese, Italian, Panjabi, Hindi, Korean and Portuguese. Summary generation asks for transcript-language confirmation and checks input/output language locally; failed checks preserve the previous summary.
- **Expected size:** the default summary/chat model is about 5.7 GB plus platform runtime archives. CUDA setup remains separate and can add several GB.
- **Outputs:** derived files are saved beside recordings as `*.speakers.json`, `*.summary.json`, and `*.summary.md`; raw transcripts remain the source of truth.

See [docs/development/LOCAL_AI_MODEL_CATALOG.md](docs/development/LOCAL_AI_MODEL_CATALOG.md) for catalog maintenance, [tests/manual/local-ai-addons-checklist.md](tests/manual/local-ai-addons-checklist.md) for manual validation, and the [v2.9 compatibility matrix](docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md) for the historical Linux evidence. Linux Pyannote is unavailable; Linux Speakrs and summaries require admitted CUDA and have no CPU or cloud fallback.

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
npm test                 # JS regression suite + syntax checks (all src/**/*.js)
npm run test:python      # Python regression suite (pytest via cross-platform wrapper)
npm run test:python-syntax  # recursive compileall under backend/
npm run test:all         # JS + Python tests + Python syntax (run before PRs)
```

Two extra checks that are not part of the npm scripts:

```bash
python backend/device_manager.py                 # device enumeration smoke test
swift build -c release --arch arm64              # macOS helper; run inside swift/AudioCaptureHelper
```

For recorder changes, also run the manual smoke checklist in `tests/manual/recording-smoke-checklist.md`.

## Coding agent setup

Codex, Claude Code, OpenCode and Cursor share root AGENTS.md and canonical on-demand skills. Follow the [agent setup guide](.agents/README.md) for Linux/macOS, native Windows and WSL bootstrap commands, then restart your agent. Claude uses relative links; the other tools discover `.agents/skills/` natively. Detailed rules live in [the contract directory](docs/development/contracts/).

## How it works

1. **Pick devices and engine.** Choose a microphone, a desktop-audio loopback device, language, and Whisper model size or Parakeet v2 in Settings.
2. **Record.** Both streams are written to disk in parallel (WASAPI loopback on Windows; CoreAudio process tap via the bundled Swift helper on macOS 14.2+, with Swift/PyObjC ScreenCaptureKit fallback; Pulse/PipeWire mic + sink-monitor capture on Linux). The audio visualizer shows live mic + system levels.
3. **Stop.** The recorder reports completion as structured stdout JSON (`success: true` with a file path, or `success: false` with a code and message when capture fails). The main process normalizes Windows `audioPath` and macOS `outputPath` into one `audioPath` for the UI. On success, the streams are aligned, mixed at 48 kHz stereo, kept mono-compatible for transcription, and compressed to Opus (with WAV fallback if ffmpeg fails).
4. **Transcribe.** The mixed audio is passed to the selected local Whisper or Parakeet backend; output is saved as a Markdown transcript with `[mm:ss - mm:ss]` timestamp lines.
5. **Save.** Recording metadata, audio file, and transcript are saved under your Electron user-data folder under a unique recording ID. Recordings already on disk are rescanned and re-imported on launch or refresh.

## Audio quality

- 48 kHz target sample rate end-to-end on Windows, macOS, and Linux.
- soxr VHQ resampling via shared `backend/audio/processor.py` (Windows and Linux capture rates, and shared spool finalization); macOS capture remains separate mix/align paths in `macos_recorder.py`.
- Gentle mic enhancement (DC-offset removal, light normalization) — no aggressive denoising or compression. Desktop audio is left untouched.
- Stereo output, Opus-compressed (≈ 95% size reduction vs WAV — a 40-minute recording is roughly 23 MB).

## Languages

Whisper exposes 11 language choices: English, Spanish, French, German, Italian, Portuguese, Chinese (Mandarin/Cantonese), Japanese, Korean, Panjabi and Hindi. Persian is retired from new choices; pending jobs retain their saved language. Parakeet is English-only. See [docs/guides/TRANSCRIPTION_GUIDE.md](docs/guides/TRANSCRIPTION_GUIDE.md) for tips.

## Requirements

### Windows

- Windows 10 or 11, 64-bit
- 4 GB RAM minimum, 8 GB recommended
- Speaker identification (optional): **8 GB RAM minimum, 16 GB recommended**. Speakrs downloads its platform-specific native model files; Pyannote is about 2–4 GB. Do not expect this add-on to fit a 4 GB machine.
- 2 GB free disk minimum, 10 GB recommended (models + recordings)
- Optional: NVIDIA GPU with 4 GB+ VRAM for CUDA acceleration

### macOS

- macOS 15 (Sequoia) or later
- Apple Silicon (M1 or newer) — Intel Macs have a CPU fallback path in dev but are not a packaged target
- 4 GB RAM minimum, 8 GB recommended
- Speaker identification (optional): **8 GB RAM minimum, 16 GB recommended** (Speakrs CLI peaked at 3.81 GB RSS on a 56 min Mac recording)
- 2 GB free disk minimum, 10 GB recommended

## Tech stack

- **Frontend:** Electron 46.0.0-alpha.11, plain HTML / CSS / JavaScript (no UI framework)
- **Backend:** Python 3.11, bundled with the installer
- **Transcription:** `faster-whisper` (Windows/Linux, CUDA optional), `lightning-whisper-mlx` (macOS, Metal); optional Parakeet v2 with pinned platform runtimes
- **Local AI add-ons:** Speakrs (token-free native CLI) or `pyannote.audio` for Windows CUDA and macOS Apple Silicon speaker identification; pinned `llama.cpp` + GGUF for user-triggered summaries
- **Audio capture:** `pyaudiowpatch` WASAPI loopback (Windows), `sounddevice` + native Swift `AudioCaptureHelper` using CoreAudio process taps on macOS 14.2+ with ScreenCaptureKit fallback, Pulse/PipeWire on Linux
- **Audio processing:** NumPy, soxr + ffmpeg (Opus) in packaged Windows, macOS, and Linux builds; macOS also keeps scipy for the MLX stack
- **Updater:** GitHub Releases API + in-app banner (release page opens in browser)

## Documentation

- **Users**
  - [Documentation index](docs/README.md)
  - [Troubleshooting](docs/guides/TROUBLESHOOTING.md) — common issues and fixes
  - [Transcription tips](docs/guides/TRANSCRIPTION_GUIDE.md)
  - [Recording features & history](docs/guides/MEETING_TRANSCRIPTION.md) — history, recovery, metadata
  - [macOS install guide](docs/guides/MACOS_INSTALLATION.md)
- **Developers**
  - [Agent guide / invariants](AGENTS.md) — architecture, IPC contracts, compute queue, validation expectations
  - [Build instructions](docs/development/BUILD_INSTRUCTIONS.md)
  - [Testing guide](docs/development/TESTING.md)
  - [Backend development notes](docs/development/BACKEND.md)
  - [GPU setup (CUDA)](docs/development/SETUP_GPU.md)
  - [Local AI model catalog](docs/development/LOCAL_AI_MODEL_CATALOG.md)
  - [v2.9 dependency compatibility and acceptance evidence](docs/development/V2_9_DEPENDENCY_COMPATIBILITY.md) (historical)
  - [Speakrs soak / benchmarks](docs/development/SPEAKRS_BENCHMARKS.md)
  - [v2.12.0 release notes](docs/releases/v2.12.0.md) and [qualification record](docs/development/V2_12_QUALIFICATION.md)
  - [v2.11.0 release notes](docs/releases/v2.11.0.md) and [qualification record](docs/development/V2_11_SPEAKRS_ELECTRON_QUALIFICATION.md)
  - [v2.10.0 release notes](docs/releases/v2.10.0.md)
  - [v2.10 Linux qualification and manual acceptance](docs/development/V2_10_LINUX_RELEASE_QUALIFICATION.md)
  - [v2.9.0 release notes](docs/releases/v2.9.0.md)
  - [v2.8.0 release notes](docs/releases/v2.8.0.md)
  - [Installer implementation](docs/development/INSTALLER_IMPLEMENTATION.md)
  - [Code review remediation (May 2026)](docs/completed/CODE_REVIEW_REMEDIATION_2026-05.md)
- **Roadmap & features**
  - [Roadmap](docs/initiatives/ROADMAP.md)
  - [Back-to-back recording & transcription queue](docs/initiatives/FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md) (shipped in v2.6.0)
  - [Long-recording safety](docs/initiatives/LONG_RECORDING_SAFETY.md) (shipped in v2.5.0)
  - [AvaNevis codebase refactor](docs/initiatives/AVANEVIS_CODEBASE_REFACTOR.md) (complete — reference)
  - [Adversarial review prompts](docs/development/ADVERSARIAL_REVIEW_PROMPTS.md)
  - [Acoustic echo cancellation](docs/initiatives/FEATURE_ECHO_CANCELLATION.md)
  - [Linux support](docs/initiatives/LINUX_SUPPORT.md)
  - [Linux experimental beta](docs/guides/LINUX_EXPERIMENTAL.md)
  - [Troubleshooting](docs/guides/TROUBLESHOOTING.md)
  - [Speaker diarization](docs/completed/FEATURE_SPEAKER_DIARIZATION.md)
  - [Transcript summaries](docs/completed/FEATURE_TRANSCRIPT_SUMMARIES.md)
  - [Local AI feature plan](docs/completed/PLAN_LOCAL_AI_FEATURES.md)
  - [Setup wizard](docs/initiatives/FEATURE_SETUP_WIZARD.md)
  - [Audio visualizer](docs/completed/FEATURE_AUDIO_VISUALIZER.md)
  - [Update checks](docs/completed/FEATURE_AUTO_UPDATER.md)
  - [JSON-based event system](docs/completed/json-based-events.md)

## Roadmap (short version)

**Shipped releases**

- **v2.12.0 (November 2026)** — local audio import, Activity integration and qualified dependency updates. [Release notes](docs/releases/v2.12.0.md).
- **v2.11.0 (November 2026)** — native Speakrs 0.7, Electron 46 alpha and asynchronous secure storage. [Release notes](docs/releases/v2.11.0.md).
- **v2.10.0 (October 2026)** — optional Parakeet with integrity/provenance protection, Whisper Large v3, checked transcript-language Qwen summaries, durable recovery selection, and Settings/navigation shortcuts. [Release notes](docs/releases/v2.10.0.md).
- **v2.9.0 (September 2026)** — Electron 44, explicit mic-only / desktop-only capture, Omarchy-inspired visual refresh, and optional Linux CUDA 12 (fail-closed Whisper, Speakrs-only speaker labels, CUDA-only Qwen summaries). [Release notes](docs/releases/v2.9.0.md).
- **v2.8.0 (August 2026)** — Linux x86_64 Core Beta: Omarchy 4 support, Pulse/PipeWire microphone and desktop-audio capture, CPU-only local transcription, AppImage and pacman packages plus an experimental `.deb`. AI add-ons remain unsupported on Linux. [Release notes](docs/releases/v2.8.0.md).
- **v2.7.0 (August 2026)** — Speakrs speaker identification: exclusive Speakrs (token-free default for new users) or Pyannote selector; only one engine installed. Soak notes: [SPEAKRS_BENCHMARKS.md](docs/development/SPEAKRS_BENCHMARKS.md). [Release notes](docs/releases/v2.7.0.md).
- **v2.6.0 (July 2026)** — Back-to-back recording and background transcription queue: Start unlocks after save; Home Activity list; discard in-progress recordings; cancel/resume pending jobs. See [FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md](docs/initiatives/FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md) and [release notes](docs/releases/v2.6.0.md).
- **v2.5.0 (July 2026)** — Recording awareness (presence pill, tray/Dock/taskbar indicators, hourly reminders, single-instance focus) and long-recording safety (durable capture spools, bounded stop finalization, interrupted-session recovery, low-disk warnings). See [LONG_RECORDING_SAFETY.md](docs/initiatives/LONG_RECORDING_SAFETY.md) and [release notes](docs/releases/v2.5.0.md).
- Codebase refactor (July 2026): main-process Pattern C services under `src/main/`, AI-addon and main-process helper facades, Python `meetings/` / shared recorder stdout helpers, characterization gates. Soft-cap accepted for `src/renderer/app.js`; see [AVANEVIS_CODEBASE_REFACTOR.md](docs/initiatives/AVANEVIS_CODEBASE_REFACTOR.md).
- Security and reliability hardening (May 2026): IPC path guards, sensitive-text redaction, trusted update downloads, single GPU compute queue with wall-clock timeouts, recording lifecycle guards (`RECORDER_BUSY`, session-aware failures), recorder `success: false` results, summary sidecar staging, and expanded regression tests. See [docs/completed/CODE_REVIEW_REMEDIATION_2026-05.md](docs/completed/CODE_REVIEW_REMEDIATION_2026-05.md).
- Optional local AI add-on foundations: Settings setup cards, pinned summary model/runtime catalog, secure diarization token storage, automatic post-transcription speaker labels when setup is ready, and user-triggered summary generation with History Transcript/Summary tabs.
- Desktop UI overhaul: vertical icon rail, top-bar pane, dual-channel waveform with peak-hold and interpolation, custom rAF-driven audio scrubber, multi-select with bulk delete, sidebar search, relative-time recording timestamps, developer console drawer.
- Markdown transcript rendering in the transcript viewer (timestamps as accent pill chips), with the raw `.md` preserved as the copy/save source of truth.
- Inline recording rename in both History and post-recording views (via a new `update-meeting` IPC + `MeetingManager.update_meeting`).
- Save transcripts via the native save dialog (`.md` / `.txt` / All Files) with sanitized default filenames.
- Slimmer audio visualizer (denser buffer, gentler glow and peak cap).
- Cross-process atomic meeting metadata writes with corrupt-file backups and transactional add behavior.
- Rebrand from Meeting Transcriber to AvaNevis (display name, installers, Info.plist descriptions, slug paths). GitHub repo slug stays `meeting-transcriber`.

**Next up**
- True silent auto-install updater (today's updater detects the new release and opens the download page).
- Real-time / streaming transcription.
- Export to DOCX, JSON (`.md`, `.txt`, `.srt`, and `.vtt` already ship).
- Acoustic echo cancellation when desktop audio bleeds into the mic.

Full plan: [docs/initiatives/ROADMAP.md](docs/initiatives/ROADMAP.md).

## Contributing

Issues and discussions live on GitHub:

- **Issues:** https://github.com/AmirArshad/meeting-transcriber/issues
- **Discussions:** https://github.com/AmirArshad/meeting-transcriber/discussions

PRs welcome. Please run `npm run test:all` before opening one and add coverage for any new IPC or recorder-output behavior — the JS test suite asserts cross-process contracts (paths, recorder stop payloads, compute timeouts, update URL trust) and the Python suite covers meeting-manager invariants. See [`AGENTS.md`](AGENTS.md) when changing main/renderer/Python contracts.

## Acknowledgments

- **OpenAI** for [Whisper](https://github.com/openai/whisper) (MIT).
- **NVIDIA** for [Parakeet (`parakeet-tdt-0.6b-v2`)](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) (CC BY 4.0), with ONNX and MLX model conversions (`istupakov/parakeet-tdt-0.6b-v2-onnx`, `istupakov/silero-vad-onnx`, `mlx-community/parakeet-tdt-0.6b-v2`).
- **Systran / guillaumekln** and **mlx-community** for packaged Whisper weights used by faster-whisper and Lightning-Whisper-MLX.
- **faster-whisper** for the efficient CUDA/CPU transcription runtime.
- **Lightning-Whisper-MLX** for Apple Silicon Metal acceleration.
- **Speakrs / avencera** for the [Speakrs](https://github.com/avencera/speakrs) speaker engine (Apache-2.0) and the `avencera/speakrs-models` pack (WeSpeaker CC BY 4.0; pyannote segmentation MIT; pyannote PLDA/VBx CC BY 4.0).
- **pyannote** for [Speaker Diarization Community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) (CC BY 4.0), used when you enable optional Pyannote speaker labels with your own Hugging Face token.
- **Alibaba Qwen** and community quantizers (e.g. Unsloth GGUF builds) for optional local summaries and Chat (Apache-2.0).
- **ggml-org** for [llama.cpp](https://github.com/ggml-org/llama.cpp) summary inference (MIT).
- **PyAudioWPatch** for WASAPI loopback on Windows.
- **ffmpeg** for Opus compression in installers (GPLv3 — see third-party notices).
- **CoreAudio process taps** and **ScreenCaptureKit** for clean desktop audio on macOS.
- **Electron** for making this kind of cross-platform desktop app practical.

## License

AvaNevis application source code is licensed under the [MIT License](LICENSE.txt).

Bundled and optional components (ffmpeg, Python packages, Whisper weights, Speakrs, pyannote, Qwen GGUF, llama.cpp, CUDA runtimes, and others) are governed by their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution, copyleft obligations, and optional model terms. Packaged installers also include a copy under `resources/legal/`.

## Repo note

The GitHub repository is still `AmirArshad/meeting-transcriber` even though the app is now AvaNevis. The repo slug was kept to avoid breaking existing clones, release URLs, and the in-app updater's trusted-URL allowlist. Everything user-facing (window title, installer, bundle, paths, docs) reads "AvaNevis".
