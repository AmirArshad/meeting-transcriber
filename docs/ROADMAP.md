# Meeting Transcriber - Product Roadmap

This document outlines the development roadmap for Meeting Transcriber, organized by priority and implementation status.

## Completed Features ✅

### Core Functionality

- **Recording & Transcription** - Dual audio capture (mic + desktop) with Whisper AI transcription
- **Meeting History** - Searchable archive with audio playback and full transcripts
- **GPU Acceleration** - CUDA support for 4-5x faster transcription
- **Professional Installer** - One-click NSIS installer with embedded Python runtime
- **Opus Compression** - 95% file size reduction (450MB → 23MB for 40-min recording)
- **Model Preloading** - Improved first-time user experience with background model loading

### Audio Quality

- **Intelligent Enhancement** - Automatic noise gate, compression, and EQ for microphone
- **WASAPI Loopback** - Direct desktop audio capture without virtual cables
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

### Advanced Functionality

#### 1. Speaker Diarization

**Status:** Planned
**Priority:** Medium
**Description:** Identify who is speaking in multi-person meetings

**Challenge:** This is technically complex

- Requires `pyannote-audio` library
- Adds ~500MB model download
- 2-3x slower processing time
- GPU strongly recommended

**Output Example:**

```markdown
[00:00:00 - 00:00:05] **Speaker 1:** Hello everyone.
[00:00:05 - 00:00:10] **Speaker 2:** Thanks for having me.
```

**Reference:** [FEATURE_SPEAKER_DIARIZATION.md](features/FEATURE_SPEAKER_DIARIZATION.md)

---

#### 2. macOS Support

**Status:** Planned
**Priority:** Medium
**Description:** Cross-platform support for macOS

**Required Changes:**

- Replace PyAudio with cross-platform audio library (or add macOS-specific handling)
- Bundle Python runtime for macOS
- Create DMG installer with code signing
- Test audio device enumeration on macOS
- Update loopback audio capture (CoreAudio vs WASAPI)

**Challenges:**

- Audio device APIs differ between Windows and macOS
- Code signing requires Apple Developer account ($99/year)
- Distribution through Apple notarization

**Estimated Effort:** 1-2 weeks

---

#### 3. Real-Time Transcription

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

#### 4. Export Formats

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

**Current Version:** 1.3.0
**Next Release:** 1.4.0 (Q1 2025)

**Versioning:**

- **Major (X.0.0)** - Breaking changes, major new features
- **Minor (1.X.0)** - New features, backwards compatible
- **Patch (1.2.X)** - Bug fixes, minor improvements

---

**Last Updated:** November 20, 2025
**Maintained By:** [@AmirArshad](https://github.com/AmirArshad)
