# Meeting Transcriber - Product Roadmap

This document outlines the development roadmap for Meeting Transcriber, organized by priority and implementation status.

## Completed Features ✅

### Core Functionality

- **Recording & Transcription** - Dual audio capture (mic + desktop) with Whisper AI transcription
- **Meeting History** - Searchable archive with audio playback and full transcripts
- **GPU Acceleration** - CUDA support for 4-5x faster transcription (Windows), Metal GPU for Apple Silicon (macOS)
- **Professional Installer** - One-click NSIS installer (Windows) and DMG installer (macOS) with embedded Python runtime
- **Opus Compression** - 95% file size reduction (450MB → 23MB for 40-min recording)
- **Model Preloading** - Improved first-time user experience with background model loading
- **macOS Support** - Full macOS support with ScreenCaptureKit for desktop audio and MLX Whisper for Apple Silicon

### Audio Quality

- **Intelligent Enhancement** - Automatic noise gate, compression, and EQ for microphone
- **WASAPI Loopback** - Direct desktop audio capture without virtual cables (Windows)
- **ScreenCaptureKit** - System audio capture for macOS
- **Stereo Mixing** - Professional audio processing and resampling

### User Interface

- **Settings Persistence** - Audio and model settings saved between sessions
- **Progress Logging** - Real-time feedback during recording and transcription
- **Meeting Management** - Browse, search, and replay past meetings
- **Combined Record Button** - Single action button for seamless recording flow
- **Audio Visualizer** - Real-time waveform visualization for mic and desktop audio
- **Auto-Updater** - Automatic update notifications with GitHub integration

---

## In Progress Features 🚧

### User Experience Improvements

No features currently in development.

---

## Planned Features 📋

### Code Quality Improvements

#### 1. JSON-Based Event System

**Status:** Planned
**Priority:** Low
**Description:** Refactor from string-based event detection to JSON-based event system

Currently, the app uses fragile string matching to detect recording state (e.g., \`output.includes('Recording started!')\`). This should be refactored to a robust JSON-based event system for better reliability and cross-platform consistency.

**Benefits:**
- Type-safe event detection
- Extensible without breaking changes
- Better cross-platform consistency
- Easier to debug and maintain

**Reference:** [json-based-events.md](features/json-based-events.md)

**Estimated Effort:** 4-6 hours

---

### Advanced Functionality

#### 2. Speaker Diarization

**Status:** Planned
**Priority:** Medium
**Description:** Identify who is speaking in multi-person meetings

**Challenge:** This is technically complex

- Requires \`pyannote-audio\` library
- Adds ~500MB model download
- 2-3x slower processing time
- GPU strongly recommended

**Output Example:**

\`\`\`markdown
[00:00:00 - 00:00:05] **Speaker 1:** Hello everyone.
[00:00:05 - 00:00:10] **Speaker 2:** Thanks for having me.
\`\`\`

**Reference:** [FEATURE_SPEAKER_DIARIZATION.md](features/FEATURE_SPEAKER_DIARIZATION.md)

---

#### 3. macOS Audio Architecture (Advanced)

**Status:** Future Enhancement
**Priority:** Medium
**Description:** Advanced audio features for macOS using ScreenCaptureKit

**Features:**

1.  **Real-Time Streaming:** Write audio to disk during recording to keep RAM usage low (flat ~50MB).
2.  **App-Specific Capture:** Capture audio only from specific apps (e.g., Zoom, Chrome) to exclude system notifications.
3.  **Real-Time Mixing:** Mix mic and desktop audio on-the-fly to eliminate post-processing wait times.

**Reference:** [MACOS_AUDIO_ARCHITECTURE.md](features/MACOS_AUDIO_ARCHITECTURE.md)

---

#### 4. Real-Time Transcription

**Status:** Planned
**Priority:** Low
**Description:** Show transcription while recording (live captions)

**Challenges:**

- Requires streaming Whisper implementation
- Higher CPU/GPU usage during recording
- May impact recording quality
- Accuracy lower than post-processing

**Use Cases:**

- Live captions for accessibility
- Quick reference during long meetings
- Detect important keywords in real-time

---

#### 5. Export Formats

**Status:** Planned
**Priority:** Low
**Description:** Export transcripts to various formats

**Supported Formats:**

- **SRT** - Subtitle format for video editors
- **VTT** - WebVTT for web players
- **DOCX** - Microsoft Word document
- **PDF** - Formatted document with timestamps
- **JSON** - Raw data for programmatic access

**Current Format:** Markdown only

---

#### 6. Acoustic Echo Cancellation (AEC)

**Status:** Future Enhancement
**Priority:** Medium
**Description:** Remove echo when desktop audio is picked up by microphone

When desktop audio plays through speakers, the microphone picks it up, creating an echo effect. AEC algorithms remove this echo by subtracting the known "reference" signal (desktop audio) from the microphone input.

**Technical Challenge:**

Current architecture uses post-processing (mixing after recording stops). True AEC requires:
- Real-time, frame-synchronized processing
- Both audio streams processed simultaneously during capture
- Significant architectural changes to recording pipeline

**Available Libraries:**

- **speexdsp-python** - Mature, requires real-time processing
- **pyaec** - Newer Rust-based library with cross-platform binaries

**Workaround:** Use headphones during recording to eliminate echo at source.

**Reference:** [FEATURE_ECHO_CANCELLATION.md](features/FEATURE_ECHO_CANCELLATION.md)

---

## Future Enhancements (Long-term) 🔮

### Nice-to-Have Features

- **Linux Support** - Expand to Linux desktop
- **Setup Wizard** - Guided first-time configuration (see [FEATURE_SETUP_WIZARD.md](features/FEATURE_SETUP_WIZARD.md))
- **Cloud Sync** - Optional backup to personal cloud storage
- **Mobile Apps** - Companion apps for iOS/Android
- **Multi-Language UI** - Localized interface (Spanish, French, etc.)
- **Advanced Search** - Semantic search across all meetings
- **Meeting Templates** - Pre-configured settings for different meeting types
- **Keyboard Shortcuts** - Global hotkeys for start/stop recording

---

## Feature Request Process

Have an idea for a new feature?

1. **Check existing features** - Review this roadmap and [GitHub Issues](https://github.com/AmirArshad/meeting-transcriber/issues)
2. **Open a discussion** - Post in [GitHub Discussions](https://github.com/AmirArshad/meeting-transcriber/discussions)
3. **Vote on features** - 👍 React to issues/discussions you want prioritized
4. **Contribute** - PRs welcome! See [BUILD_INSTRUCTIONS.md](development/BUILD_INSTRUCTIONS.md)

---

## Release Schedule

**Current Version:** 1.7.0
**Next Release:** 1.8.0 (Q1 2025)

**Versioning:**

- **Major (X.0.0)** - Breaking changes, major new features
- **Minor (1.X.0)** - New features, backwards compatible
- **Patch (1.2.X)** - Bug fixes, minor improvements

---

**Last Updated:** December 7, 2025
**Maintained By:** [@AmirArshad](https://github.com/AmirArshad)
