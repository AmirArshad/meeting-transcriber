# AvaNevis — Product Roadmap

This document outlines what's shipped, what's in flight, and what's planned. AvaNevis (formerly Meeting Transcriber) is a privacy-first local-only audio recorder and transcriber for Windows, Apple Silicon macOS, and Linux x86_64 Core Beta.

## Shipped

### Core

- **Dual audio capture** — microphone + desktop audio recorded in parallel and mixed after the recording stops. WASAPI loopback on Windows; native Swift helper on macOS using CoreAudio process taps on macOS 14.2+ with Swift/PyObjC ScreenCaptureKit fallback; Pulse/PipeWire on Linux.
- **Local transcription** — `faster-whisper` on Windows and Linux (optional managed CUDA 12), `lightning-whisper-mlx` on Apple Silicon with Metal, plus optional English-only **Parakeet v2** on supported GPUs.
- **Local AI add-ons (optional)** — speaker diarization (**Speakrs** token-free on Windows CUDA, macOS CoreML, and Linux CUDA; or **Pyannote** on Windows CUDA / macOS MPS) and **Summaries & Chat** (`llama.cpp` with Qwen3.5 9B/4B and Gemma 4 E4B/12B; Inkling 2 Mini gated) with explicit setup, device memory fit checks, single-slot memory release, and local-only execution.
- **Local History search & grounded Chat (v3.0.0+)** — disposable SQLite FTS5 full-text search across transcripts and summaries without AI add-ons, plus threaded local Q&A with clickable timestamp citations (`llama-server` with `llama-cli` fallback) and manual/idle memory unload.
- **Import local audio** — add WAV, MP3 or Opus to History and queue local transcription while preserving the source file.
- **Recording history & subtitle exports** — persisted under the user-data folder with a unique ID, browseable list, transcript viewer, synchronized audio playback, and `.md`/`.txt`/`.srt`/`.vtt` exports.
- **Cross-platform installers & in-app updater (v3.0.0+)** — Windows NSIS, macOS DMG/ZIP, and Linux x86_64 AppImage/pacman/experimental `.deb` packages with bundled runtimes and differential in-app updates (plus copyable `pacman`/`apt` commands for system packages and manual `.dmg` fallback for ad-hoc macOS builds).
- **GPU acceleration** — CUDA on Windows and managed Linux CUDA 12, Metal/MLX on Apple Silicon.
- **Opus compression** — ~95% size reduction vs WAV (≈ 23 MB for a 40-minute recording), with WAV fallback if ffmpeg fails or output verification fails.
- **Model preloading** — improves first-time experience by warming the Whisper model in the background.
- **macOS feature parity** — full parity with Windows including 48 kHz target sample rate (shared soxr VHQ in spool finalization; macOS capture still uses separate mix/align paths in `macos_recorder.py`).

### Audio quality

- 48 kHz target sample rate end-to-end on all platforms.
- soxr VHQ resampling via shared `backend/audio/processor.py` (Windows and Linux capture rates, and shared spool finalization); macOS capture uses separate mix/align paths.
- Gentle mic enhancement (DC-offset removal, light normalization). Desktop audio is left untouched.
- Stereo output with per-channel processing.

### UI / UX (latest UI overhaul)

- **Premium dark theme** with vertical icon rail (Record / Chat / History / Settings), top-bar app pane, Inter + JetBrains Mono typography, and violet/sky accents on a layered obsidian background.
- **Expressive dual-channel waveform visualizer** with sample interpolation, peak-hold caps, glow, and DPR-aware rendering — running off `requestAnimationFrame` rather than the recorder's 5 FPS level events.
- **Custom audio scrubber** built on the native `<audio>` element with rAF-driven progress updates for stutter-free seeking.
- **Markdown transcript rendering** in the History viewer (headings, lists, links, inline code, blockquotes, bold/italic) with `[mm:ss - mm:ss]` timestamp lines styled as accent pill chips. The raw `.md` is preserved as the source of truth for copy and save.
- **Inline recording rename** in both History detail and Activity, backed by the `update-meeting` IPC and `MeetingManager.update_meeting` that mutates only the title — filenames stay anchored to the recording ID.
- **Export Transcript** via Electron's native save dialog with sanitized default filenames and `.md`, `.txt`, `.srt`, and `.vtt` formats, available from History detail.
- **Multi-select + bulk delete** for the history list, plus full-text History search, tag filters, relative-time recording timestamps, and a developer console drawer for inspecting backend logs.
- **Slimmer waveform container** (28 px high, denser buffer, gentler glow and peak cap) for a less-dominant visualizer.

### Reliability / data integrity

- **Atomic, locked meeting metadata writes** — `FileLock`-based cross-process locking, atomic temp-file + `os.replace()`, transactional add behavior (originals removed only after metadata is saved).
- **Corrupt metadata recovery** — corrupt `meetings.json` files are backed up as `meetings.corrupt.*.json` and the app recovers gracefully.
- **Filesystem rescan / import** — on launch the app rescans the recordings folder and re-imports any meetings present on disk but missing from metadata, preserving suffixed IDs like `meeting_20260107_104555_1`. History search filters metadata only until you refresh.
- **Structured stdout JSON event contract** — recorder startup, levels, warnings, errors, and completion are emitted as JSON on stdout; stderr is debug-only. The Electron parser is fully migrated to the JSON contract. Failed captures return `success: false` without a bogus output path.
- **Security and compute hardening (May 2026)** — IPC path guards, sensitive-text redaction, trusted update downloads, single GPU compute queue with wall-clock timeouts, recording lifecycle guards (`RECORDER_BUSY`), and expanded regression tests. See [CODE_REVIEW_REMEDIATION_2026-05.md](../completed/CODE_REVIEW_REMEDIATION_2026-05.md) and root [`AGENTS.md`](../../AGENTS.md).
- **Recording awareness (v2.5.0)** — authoritative `starting` / `recording` / `stopping` / `idle` lifecycle from the recorder service; always-visible in-app pill + elapsed clock; macOS static saturated menu-bar icon + `REC` + Dock badge; Windows taskbar overlay while minimized; hourly best-effort native reminders (click-to-open via retained notification objects — Electron has no Action Center cold-activation API); single-instance relaunch focuses the running app; recording-aware close copy.
- **Long-recording safety (v2.5.0)** — durable `{stem}.capture/` track spools (not whole-session RAM); bounded multi-pass stop finalization; interrupted-session recovery (`Recover Now` / `Later`); Node `statfs` disk probes with periodic low-space warnings (never auto-stop); structured stop stages in the UI. See [LONG_RECORDING_SAFETY.md](LONG_RECORDING_SAFETY.md).
- **Back-to-back recording & transcription queue (v2.6.0)** — Start unlocks after pending persist; main-owned FIFO transcription jobs; Home Activity list; discard capture; cancel/resume pending work; between-job GPU/preload admission. See [FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md](FEATURE_BACKGROUND_TRANSCRIPTION_QUEUE.md).
- **Speakrs speaker identification (v2.7.0)** — exclusive Speakrs (token-free default for new users) or Pyannote selector; only one engine installed; existing Pyannote installs stay until the user switches. Soak notes: [SPEAKRS_BENCHMARKS.md](../development/SPEAKRS_BENCHMARKS.md).
- **Linux Core Beta (v2.8.0)** — Omarchy 4 and CachyOS x86_64 Hyprland/Wayland + PipeWire support, with AppImage, pacman, and experimental `.deb` packaging. See [LINUX_EXPERIMENTAL.md](../guides/LINUX_EXPERIMENTAL.md).

### Branding

- **Renamed from Meeting Transcriber to AvaNevis** — display name, window title, tray tooltip, dialogs, NSIS shortcut and installer header, macOS Info.plist permission descriptions, Python permission and CLI strings, NPM package name, renderer localStorage keys, and the MLX cache directory all read AvaNevis. Installers ship as `AvaNevis-Setup-<version>.{exe,dmg}`. The GitHub repository slug stays `AmirArshad/meeting-transcriber` for compatibility with existing clones and release URLs.

### Historical milestones

- **v2.7.0 (August 2026)** — Exclusive Speakrs / Pyannote speaker identification. New users default Speakrs (token-free); existing Pyannote installs stay until the user switches. Soak notes: [SPEAKRS_BENCHMARKS.md](../development/SPEAKRS_BENCHMARKS.md). [Release notes](../releases/v2.7.0.md).
- **v2.6.0 (July 2026)** — Back-to-back recording and background transcription queue shipped (Phase 1 + Phase 2 polish). Hardware smoke signed off on macOS; Windows queue/recorder smoke covered in pre-tag checks.
- **v2.5.0 (July 2026)** — Recording awareness (Release 1) and long-recording safety (Release 2) shipped: presence indicators, durable capture spools, bounded finalization, interrupted-session recovery. Hardware smoke signed off on Windows and macOS.
- **July 2026** — Codebase refactor complete (Phases 0–8 + 5B): Pattern C services under `src/main/`, AI-addon and main-process helper facades, Python `meetings/` package, shared `recorder_stdout.py`. Soft-cap accepted for `src/renderer/app.js`. See [AVANEVIS_CODEBASE_REFACTOR.md](AVANEVIS_CODEBASE_REFACTOR.md).
- **May 2026** — Code review remediation merged to `master`: Phases 1–6 (security, recording lifecycle, local AI queue/timeouts, performance). Phase 7 backlog tracked in root `todo.md` and [TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md](../completed/todo-archives/TODO_ARCHIVE_2026-05-20_CODE_REVIEW_REMEDIATION.md).
- **v2.2.0** — Recording reliability and macOS desktop audio fixes in packaged builds, plus May 2026 security/stability remediation (lifecycle guards, path safety, compute queue timeouts, license notices in releases).
- **v2.1.0** — Local AI add-on reliability hardening: setup/install resilience, cancellation/recovery improvements, offline/cache behavior tightening, and archive extraction performance/safety updates.
- **v2.0.0** — AvaNevis rebrand and local AI add-ons delivered: optional speaker diarization, optional transcript summaries, History transcript/summary experience, and setup/validation flows.
- **v1.7.0** — macOS support with Metal GPU acceleration, cross-platform 48 kHz parity (Windows soxr VHQ; macOS mix/align paths), Intel Mac CPU fallback (`faster-whisper` int8), 100% feature parity across platforms.
- **v1.6.1** — Transcription reliability fixes, automatic meeting recovery via filesystem scan, Cantonese added to UI.
- **v1.6.0** — Background recording stability for 60+ minute sessions, ~75% less CPU when minimized, Google-Meet-quality audio improvements.
- Earlier — Combined Start/Stop/Transcribe button, audio visualizer first version, Opus compression, professional installer, model preloading.

---

## Current release: v3.1.0

- **v3.1.0 (November 22, 2026)** — Streaming grounded Chat with smart date/entity/tag retrieval, follow-up continuity, and actionable recovery notices; 11 canonical recording tags with dedicated per-tag summary templates; non-destructive inline speaker naming with timestamped voice previews across History, Activity, and Prepare summary; the multi-model Summaries & Chat library (Qwen3.5 9B/4B, Gemma 4 E4B/12B, gated Inkling 2 Mini) with device-fit checks and single-slot memory release; UI polish; and Phase 5 dependency/security updates. See the [v3.1.0 release notes](../releases/v3.1.0.md) and [v3.1 qualification record](../development/V3_1_QUALIFICATION.md).

### Earlier v3.0.0 release

- **v3.0.0 (November 21, 2026)** — Local SQLite FTS5 History search, grounded local Chat with timestamp citations, caption-scale timing sidecars with `.srt`/`.vtt` exports, differential in-app auto-updater, bundled CPython `3.11.18+20261110`, and decoupled recovery locking. See the [v3.0.0 release notes](../releases/v3.0.0.md) and [v3.0 qualification record](../development/V3_0_QUALIFICATION.md).

### Earlier v2.12.0 release

Published November 19, 2026. Import WAV, MP3 and Opus into History and transcribe them through Activity, alongside keyboard access to History recordings and qualified dependency updates. See the [release notes](../releases/v2.12.0.md) and [qualification record](../development/V2_12_QUALIFICATION.md).

### Earlier v2.11 release

Speakrs 0.7 added native CUDA and CoreML execution and asynchronous secure token
storage. Existing Speakrs users enable the new models through Repair. See the
[v2.11 release notes](../releases/v2.11.0.md).

### Earlier v2.10 releases

The [v2.10.1 release notes](../releases/v2.10.1.md) cover the maintenance
patch (History fixes, faster post-stop finalization, and the October 2026
dependency/security maintenance). The [v2.10 release notes](../releases/v2.10.0.md)
cover the feature scope it builds on:

- optional English-only Parakeet on Windows CUDA, Apple Silicon Metal and Linux
  managed CUDA 12, with integrity checks and durable capture/recovery selections;
- Whisper Large v3, Small as the default/minimum new choice, and Persian removed
  from new language selections while pending requests retain their saved choices;
- confirmed transcript-language Qwen summaries for 11 supported languages, local
  input/output checks and current-transcript speaker provenance;
- Settings navigation, enable/disable wording, AI log timestamps, rail branding,
  click-away meeting rename and app-focused recording/navigation shortcuts;
- dependency/audit maintenance and guarded retry/recovery fixes.

Implementation, review fixes and CI are complete; remaining manual acceptance
was confirmed by the user on 2026-10-03. See [`todo.md`](../../todo.md), the
[v2.10 plan index](../superpowers/plans/2026-09-06-v2.10.md) and
[qualification record](../development/V2_10_LINUX_RELEASE_QUALIFICATION.md).
Tagged installers are built and published by the release workflow.

Further inference-default changes, alternative summary models and additional
language removals were dropped from v2.10. The microphone investigation closed
with current gain behavior retained; no reset root cause or performance win is
claimed. The [v2.9 notes](../releases/v2.9.0.md) and
[compatibility matrix](../development/V2_9_DEPENDENCY_COMPATIBILITY.md) remain
historical evidence.

## Planned

### Next release: v3.2.0 (planned)

Full implementation plan: [v3.2.0 release plan](../superpowers/plans/2026-11-22-v3.2-release-plan.md).

- **Model compatibility & install UX** — Fix device compatibility assessment (`likely_fits` / `tight` / `needs_more_memory` / `unknown` separation, nominal GPU-tier rounding tolerance so 12 GB GPUs reporting `12,282 MiB` pass, hardened Linux `nvidia-smi` probing), recalibrate Gemma 4 12B for 12 GB VRAM, and prompt to unload a resident Chat model before downloading or switching models instead of throwing a VRAM error.
- **Smarter Chat context, precise citations & optional general chat** — Add a 3-tier local context router (direct full-transcript fit for single/small scopes within 32k context, conversation-aware two-stage retrieval with follow-up entity carry-over, and rolling history compaction), keep evidence chunks timestamp-granular with `Title · Summary` pill labels, and add an explicit recording-free **General chat** mode (`scope.type = 'none'`) plus a **Clear recording context** option with clear visual/citation guardrails.
- **Speaker samples & Summary format picker** — Pick ≥5-second speaker voice samples (falling back to the longest available segment) with a subtle `"Sample"` caption below the preview button, and make the **Summary format** dropdown always available in Prepare summary for both tagged and untagged recordings without silently mutating the recording tag.
- **Unified `llama.cpp >= b12631` runtime, Inkling 2 Mini & expanded model library** — Pin official `ggml-org/llama.cpp >= b12631` binaries across macOS arm64, Windows CUDA 12.4, and Linux CUDA 12.8 to unblock **Inkling 2 Mini** across all three platforms, and expand the curated catalog with **Bonsai 2** (`9B` `Q2_0`) & **Bonsai 2.5** (`27B` `Q2_0` on stock `llama.cpp`) plus mainstream peers (**Gemma 4 26B-A4B**, **Qwen 3.8 27B**, **Ministral 3 14B**, evaluating **Qwen 3.6 35B-A3B**).
- **Platform & dependency sweep** — Migrate Electron `46.0.0-alpha.11` toward stable `46.x` with cross-platform `safeStorage` verification, recheck matched cross-platform FFmpeg `> 8.1.2`, qualify held Python/Rust updates (`onnxruntime`, `ctranslate2`, `pyobjc`, `speakrs`), and verify zero `npm`/`pip`/`cargo` audit findings.

### Transcription

- **Real-time transcription.** Live captions during the recording itself. Trade-off: requires a streaming Whisper implementation, raises CPU/GPU usage during capture, and accuracy is below post-processing.
- **Additional export formats.** DOCX, PDF, JSON in addition to Markdown, plain text, SRT, and WebVTT.

### Summaries & Chat

- **Inkling 2 Mini qualification (scheduled for v3.2.0).** Official `ggml-org/llama.cpp` `b12631` includes the loop-layer scale fix and publishes macOS arm64, Windows CUDA 12.4, and Linux CUDA 12.8 archives; qualify natively across all three platforms and resolve the English summary language check.
- **Expanded Gemma 4 & new-model language checks.** Extend Gemma 4 summaries beyond Apple Silicon English and qualify Bonsai 2 / Bonsai 2.5 / new catalog models per platform.

### Audio

- **Acoustic echo cancellation (AEC).** Remove echo when desktop audio bleeds into the mic. Requires real-time, frame-synchronized processing — a significant change to the current post-processing mix architecture. Workaround today: use headphones. Reference: [FEATURE_ECHO_CANCELLATION.md](FEATURE_ECHO_CANCELLATION.md).
- **macOS advanced audio.** Stream audio to disk during capture (flat ~50 MB RAM), per-app capture (e.g. Zoom-only), and real-time mixing to remove the post-recording mix step. Reference: [MACOS_AUDIO_ARCHITECTURE.md](MACOS_AUDIO_ARCHITECTURE.md).

### Packaging & Distribution

- **AUR package (`avanevis-bin`) & CI release automation.** The supported CachyOS/Omarchy install smoke is complete; revisit publishing automation in a future release. Reference: [AUR_PACKAGING_AND_AUTOMATION.md](AUR_PACKAGING_AND_AUTOMATION.md) and [AUR_PACKAGE_GUIDE.md](../guides/AUR_PACKAGE_GUIDE.md).

---

## Future enhancements

Longer horizon, lower priority:

- **Linux expansion.** Broader desktop/hardware validation beyond the supported Core Beta hosts, including the still-open Ubuntu desktop recording/`safeStorage` smoke. Reference: [LINUX_SUPPORT.md](LINUX_SUPPORT.md).
- **Setup wizard.** Guided first-time configuration. Reference: [FEATURE_SETUP_WIZARD.md](FEATURE_SETUP_WIZARD.md).
- **Optional private meeting-object sync** to user-controlled storage (never to a hosted AvaNevis backend). See [Meeting objects and private sync](MEETING_OBJECTS_AND_PRIVATE_SYNC.md); not yet scheduled.
- **Local inference performance** (recording finalization/encoding, Whisper, llama.cpp knobs and warm workers; stay on Electron + Python). See [Local inference performance](LOCAL_INFERENCE_PERFORMANCE.md); further production-default changes remain deferred.
- **Apple Developer signing/notarization & Windows Authenticode signing** — repo/CI wiring is in place and activates once signing credentials are configured; unsigned Windows and ad-hoc macOS packaging checks remain the current boundary.
- **Companion mobile apps** (iOS / Android) for remote review.
- **Localized UI** (Spanish, French, etc.).
- **Semantic search** across transcripts.
- **Recording presets** with preset device + model configuration.

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

**Current release version:** v3.1.0 (`v3.2.0` planned). Hardware acceptance and its limits are recorded separately from CI.

The v2.0 rebrand introduced a new Electron `productName`, which changes the user-data folder. Existing Meeting Transcriber installs won't see their old recordings until the user manually moves the data folder, so that release used a major version bump.

---

**Maintainer:** [@AmirArshad](https://github.com/AmirArshad)
