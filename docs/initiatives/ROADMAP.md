# AvaNevis — Product Roadmap

This document outlines what's shipped, what's in flight, and what's planned. AvaNevis (formerly Meeting Transcriber) is a privacy-first local-only meeting recorder + transcriber for Windows and Apple Silicon macOS.

## Shipped

### Core

- **Dual audio capture** — microphone + desktop audio recorded in parallel and mixed after the recording stops. WASAPI loopback on Windows; native Swift helper on macOS using CoreAudio process taps on macOS 14.2+ with Swift/PyObjC ScreenCaptureKit fallback.
- **Local Whisper transcription** — `faster-whisper` on Windows with optional CUDA, `lightning-whisper-mlx` on Apple Silicon with Metal. CPU fallback path for non-GPU machines.
- **Local AI add-ons (optional)** — speaker diarization and transcript summaries with explicit setup and local-only execution. Diarization uses `pyannote/speaker-diarization-community-1` (Windows CUDA, macOS Apple Silicon MPS). Summaries use pinned local `llama.cpp` runtime/model setup with History integration.
- **Meeting history** — persisted under the user-data folder with a unique meeting ID, browseable list, transcript viewer, and synchronized audio playback.
- **Cross-platform installers** — Windows NSIS and macOS DMG with embedded Python runtime, ffmpeg, and the bundled native macOS audio helper.
- **GPU acceleration** — CUDA on Windows, Metal/MLX on Apple Silicon.
- **Opus compression** — ~95% size reduction vs WAV (≈ 23 MB for a 40-minute meeting), with WAV fallback if ffmpeg fails or output verification fails.
- **Model preloading** — improves first-time experience by warming the model in the background.
- **Auto-aware updater** — checks GitHub Releases on launch and surfaces an in-app banner; clicking opens the release page in the user's browser.
- **macOS feature parity** — full parity with Windows including 48 kHz / soxr VHQ resampling.

### Audio quality

- 48 kHz target sample rate end-to-end on both platforms.
- soxr VHQ resampling everywhere it matters.
- Gentle mic enhancement (DC-offset removal, light normalization). Desktop audio is left untouched.
- Stereo output with per-channel processing.

### UI / UX (latest UI overhaul)

- **Premium dark theme** with vertical icon rail (Record / History / Settings), top-bar app pane, Inter + JetBrains Mono typography, and violet/sky accents on a layered obsidian background.
- **Expressive dual-channel waveform visualizer** with sample interpolation, peak-hold caps, glow, and DPR-aware rendering — running off `requestAnimationFrame` rather than the recorder's 5 FPS level events.
- **Custom audio scrubber** built on the native `<audio>` element with rAF-driven progress updates for stutter-free seeking.
- **Markdown transcript rendering** in the meeting viewer (headings, lists, links, inline code, blockquotes, bold/italic) with `[mm:ss - mm:ss]` timestamp lines styled as accent pill chips. The raw `.md` is preserved as the source of truth for copy and save.
- **Inline meeting rename** in both history detail and the post-recording view, backed by a new `update-meeting` IPC and `MeetingManager.update_meeting` that mutates only the title — filenames stay anchored to the meeting ID.
- **Save Transcript As** via Electron's native save dialog with sanitized default filenames and `.md` / `.txt` / All Files filters, available from history detail and the post-recording view.
- **Multi-select + bulk delete** for the history list, plus a sidebar search filter, relative-time meeting timestamps, and a developer console drawer for inspecting backend logs.
- **Slimmer waveform container** (28 px high, denser buffer, gentler glow and peak cap) for a less-dominant visualizer.

### Reliability / data integrity

- **Atomic, locked meeting metadata writes** — `FileLock`-based cross-process locking, atomic temp-file + `os.replace()`, transactional add behavior (originals removed only after metadata is saved).
- **Corrupt metadata recovery** — corrupt `meetings.json` files are backed up as `meetings.corrupt.*.json` and the app recovers gracefully.
- **Filesystem rescan / import** — on launch the app rescans the recordings folder and re-imports any meetings present on disk but missing from metadata, preserving suffixed IDs like `meeting_20260107_104555_1`. History search filters metadata only until you refresh.
- **Structured stdout JSON event contract** — recorder startup, levels, warnings, errors, and completion are emitted as JSON on stdout; stderr is debug-only. The Electron parser is fully migrated to the JSON contract. Failed captures return `success: false` without a bogus output path.
- **Security and compute hardening (May 2026)** — IPC path guards, sensitive-text redaction, trusted update downloads, single GPU compute queue with wall-clock timeouts, recording lifecycle guards (`RECORDER_BUSY`), and expanded regression tests. See [CODE_REVIEW_REMEDIATION_2026-05.md](../completed/CODE_REVIEW_REMEDIATION_2026-05.md) and root [`AGENTS.md`](../../AGENTS.md).

### Branding

- **Renamed from Meeting Transcriber to AvaNevis** — display name, window title, tray tooltip, dialogs, NSIS shortcut and installer header, macOS Info.plist permission descriptions, Python permission and CLI strings, NPM package name, renderer localStorage keys, and the MLX cache directory all read AvaNevis. Installers ship as `AvaNevis-Setup-<version>.{exe,dmg}`. The GitHub repository slug stays `AmirArshad/meeting-transcriber` for compatibility with existing clones and release URLs.

### Historical milestones

- **May 2026** — Code review remediation merged to `master`: Phases 1–6 (security, recording lifecycle, local AI queue/timeouts, performance). Phase 7 backlog tracked in root `todo.md` and [TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md](../completed/todo-archives/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md).
- **v2.2.0** — Recording reliability and macOS desktop audio fixes in packaged builds, plus May 2026 security/stability remediation (lifecycle guards, path safety, compute queue timeouts, license notices in releases).
- **v2.1.0** — Local AI add-on reliability hardening: setup/install resilience, cancellation/recovery improvements, offline/cache behavior tightening, and archive extraction performance/safety updates.
- **v2.0.0** — AvaNevis rebrand and local AI add-ons delivered: optional speaker diarization, optional transcript summaries, History transcript/summary experience, and setup/validation flows.
- **v1.7.0** — macOS support with Metal GPU acceleration, cross-platform 48 kHz / soxr VHQ parity, Intel Mac CPU fallback (`faster-whisper` int8), 100% feature parity across platforms.
- **v1.6.1** — Transcription reliability fixes, automatic meeting recovery via filesystem scan, Cantonese added to UI.
- **v1.6.0** — Background recording stability for 60+ minute sessions, ~75% less CPU when minimized, Google-Meet-quality audio improvements.
- Earlier — Combined Start/Stop/Transcribe button, audio visualizer first version, Opus compression, professional installer, model preloading.

---

## In progress

Nothing actively in development right now.

---

## Planned

### Updater

- **True silent auto-install updater.** Today's updater detects new GitHub releases and opens the release page; the next iteration should download and apply the installer in-app. Reference: [FEATURE_AUTO_UPDATER.md](../completed/FEATURE_AUTO_UPDATER.md).

### Transcription

- **Upload existing audio files.** Import user-provided `.mp3`, `.wav`, and `.opus` files, normalize them into the app's processing format, run transcription/summaries with the same local pipeline, and save results into Meeting History as first-class meetings.
- **History chat over meetings.** Use the installed local summary runtime/model to ask questions about historical meetings, with responses grounded in saved transcript and summary artifacts.
- **Real-time transcription.** Live captions during the recording itself. Trade-off: requires a streaming Whisper implementation, raises CPU/GPU usage during capture, and accuracy is below post-processing.
- **Export formats.** SRT, VTT, DOCX, PDF, JSON in addition to today's Markdown + plain-text Save As.

### Audio

- **Acoustic echo cancellation (AEC).** Remove echo when desktop audio bleeds into the mic. Requires real-time, frame-synchronized processing — a significant change to the current post-processing mix architecture. Workaround today: use headphones. Reference: [FEATURE_ECHO_CANCELLATION.md](FEATURE_ECHO_CANCELLATION.md).
- **macOS advanced audio.** Stream audio to disk during capture (flat ~50 MB RAM), per-app capture (e.g. Zoom-only), and real-time mixing to remove the post-recording mix step. Reference: [MACOS_AUDIO_ARCHITECTURE.md](MACOS_AUDIO_ARCHITECTURE.md).

---

## Future enhancements

Longer horizon, lower priority:

- **Linux support.** Native build for Linux desktops. Reference: [LINUX_SUPPORT.md](LINUX_SUPPORT.md).
- **Setup wizard.** Guided first-time configuration. Reference: [FEATURE_SETUP_WIZARD.md](FEATURE_SETUP_WIZARD.md).
- **Optional cloud sync** to user-owned cloud storage (never to a hosted backend).
- **Companion mobile apps** (iOS / Android) for remote review.
- **Localized UI** (Spanish, French, etc.).
- **Semantic search** across transcripts.
- **Meeting templates** with preset device + model configuration.
- **Global keyboard shortcuts** for start/stop recording.

---

## Feature requests

1. Check this roadmap and [GitHub Issues](https://github.com/AmirArshad/meeting-transcriber/issues) first.
2. Open or join a [GitHub Discussion](https://github.com/AmirArshad/meeting-transcriber/discussions) for new ideas.
3. 👍 react to issues you want prioritized.
4. PRs welcome — see [BUILD_INSTRUCTIONS.md](../development/BUILD_INSTRUCTIONS.md) and run `npm run test:all` before opening one.

---

## Versioning

- **Major (X.0.0)** — Breaking changes or major new features.
- **Minor (1.X.0)** — New features, backwards compatible.
- **Patch (1.2.X)** — Bug fixes and minor improvements.

**Current branch version:** 2.2.0 (recording reliability, macOS packaged desktop audio capture, and security/stability remediation).

The rebrand introduces a new Electron `productName`, which changes the user-data folder. Existing Meeting Transcriber installs won't see their old recordings until the user manually moves the data folder, so this release uses a major version bump.

---

**Maintainer:** [@AmirArshad](https://github.com/AmirArshad)
