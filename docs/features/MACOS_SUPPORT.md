# macOS Support - Implementation Plan

**Status:** 🚧 Planned (v1.7.0)
**Target Platform:** Apple Silicon (M1/M2/M3/M4) only
**Minimum macOS:** 13 Ventura

---

## Overview

This document outlines the plan for adding native macOS support to Meeting Transcriber while maintaining the existing Windows version in a single repository. The approach emphasizes platform-specific optimizations while maximizing code sharing.

## Key Features (macOS)

- ✅ **Native Desktop Audio Capture** via ScreenCaptureKit (macOS 13+)
- ✅ **Microphone Recording** via sounddevice
- ✅ **GPU-Accelerated Transcription** using Apple MLX framework
- ✅ **Apple Silicon Optimized** (M1/M2/M3/M4 support)
- ✅ **No Third-Party Software Required** (all native APIs)

## Architecture Decisions

### 1. Repository Structure

**Single monorepo** containing both Windows and macOS versions:
- ~70% code shared (UI, database, business logic)
- Platform-specific modules for audio and transcription
- Clean abstraction layer via factory pattern

### 2. Audio Capture Strategy

#### Windows (Unchanged)
- **Library:** pyaudiowpatch (WASAPI loopback)
- **Desktop Audio:** WASAPI loopback devices
- **Microphone:** Standard input devices
- **Status:** ✅ Existing implementation preserved

#### macOS (New)
- **Library:** sounddevice + ScreenCaptureKit
- **Desktop Audio:** ScreenCaptureKit API (requires Screen Recording permission)
- **Microphone:** sounddevice (cross-platform PortAudio)
- **Fallback:** Mic-only mode if Screen Recording permission denied

**Why ScreenCaptureKit?**
- Native Apple API (no third-party software installation)
- High quality, zero latency
- Modern, actively supported by Apple
- Requires macOS 13+ only (acceptable trade-off)

### 3. Transcription Strategy: Dual-Backend Approach

#### Windows: faster-whisper (UNCHANGED)
```python
# backend/transcription/faster_whisper_transcriber.py
# Existing implementation - zero changes
- CUDA GPU acceleration
- CTranslate2 models
- All optimizations preserved
```

#### macOS: Lightning-Whisper-MLX (NEW)
```python
# backend/transcription/mlx_whisper_transcriber.py
# New implementation for Apple Silicon
- MLX framework (Apple's native ML framework)
- Metal GPU acceleration
- Optimized for M1/M2/M3/M4
```

**Why Dual-Backend?**
| Aspect | Benefit |
|--------|---------|
| **Risk** | Zero risk to Windows - existing code untouched |
| **Performance** | Each platform uses its native ML framework |
| **Maintenance** | Clean separation, easier to debug |
| **Migration** | No Windows testing/validation burden |

### 4. Performance Expectations

#### Windows (NVIDIA GPU + CUDA)
- **Unchanged** - Exactly as it works today
- Medium model: 4-5x realtime

#### macOS (M4 Pro + MLX Metal)
- Tiny model: 8-10x realtime
- Base model: 5-7x realtime
- Small model: 3-4x realtime
- Medium model: 2-3x realtime (target: match Windows)

**Note:** M4 Pro expected to perform even better than M1/M2/M3 due to improved Neural Engine.

## Implementation Phases

### Phase 1: Create Abstraction Layer (Week 1)
**Goal:** Set up platform abstractions WITHOUT changing Windows functionality

**Tasks:**
1. Create folder structure (`backend/audio/`, `backend/transcription/`)
2. Move existing code (NO modifications):
   - `backend/transcriber.py` → `backend/transcription/faster_whisper_transcriber.py`
   - `backend/audio_recorder.py` → `backend/audio/windows_recorder.py`
3. Create factory functions and abstract base classes
4. Update imports throughout codebase
5. Verify Windows works exactly as before

**Deliverables:**
- Windows unchanged (zero functional changes)
- Clean abstraction layer ready for macOS

### Phase 2-3: macOS Audio Implementation (Week 2)
**Goal:** Implement microphone and desktop audio recording for macOS

**Phase 2 - Microphone:**
- Implement `MacOSAudioRecorder` (mic-only mode)
- Device enumeration via sounddevice
- Audio levels and visualization

**Phase 3 - Desktop Audio:**
- ScreenCaptureKit integration via PyObjC
- Screen Recording permission handling
- Graceful fallback to mic-only

### Phase 4-5: macOS Transcription (Week 3)
**Goal:** Implement MLX-based transcription for Apple Silicon

**Tasks:**
1. Install `lightning-whisper-mlx` on M4 Pro Mac
2. Implement `MLXWhisperTranscriber` class
3. Match interface with `FasterWhisperTranscriber`
4. Test Metal GPU acceleration
5. Benchmark performance on M4 Pro
6. Verify quality parity with Windows

### Phase 6-7: Build System & CI/CD (Week 4-5)
**Goal:** Automate builds for both platforms

**Build Configuration:**
- macOS: DMG installer (Apple Silicon arm64 only)
- Windows: NSIS installer (unchanged)
- CI/CD: Separate workflows for each platform
- Release: Both installers attached to same GitHub Release

### Phase 8: Testing & Polish (Week 5-6)
**Goal:** Thorough testing and documentation

**Testing:**
- macOS 13, 14, 15 (Ventura, Sonoma, Sequoia)
- M1, M2, M3, M4 Macs
- Windows regression testing
- Platform-specific bug fixes

## File Organization

```
meeting-transcriber/
├── backend/
│   ├── audio/
│   │   ├── __init__.py              # Factory: get_audio_recorder()
│   │   ├── base_recorder.py         # Abstract base class
│   │   ├── windows_recorder.py      # Windows (pyaudiowpatch)
│   │   └── macos_recorder.py        # macOS (sounddevice + ScreenCaptureKit)
│   ├── transcription/
│   │   ├── __init__.py              # Factory: get_transcriber()
│   │   ├── base_transcriber.py      # Abstract base class
│   │   ├── faster_whisper_transcriber.py  # Windows (CUDA)
│   │   └── mlx_whisper_transcriber.py     # macOS (MLX Metal)
│   ├── device_manager.py            # Cross-platform device enumeration
│   ├── meeting_manager.py           # Shared (no changes)
│   └── platform_utils.py            # Platform detection utilities
├── build/
│   ├── resources/
│   │   ├── python-windows/          # Windows Python + deps
│   │   ├── python-macos/            # macOS Python + deps
│   │   ├── ffmpeg-windows/          # Windows ffmpeg
│   │   └── ffmpeg-macos/            # macOS ffmpeg
│   ├── prepare-resources-windows.js
│   ├── prepare-resources-macos.js
│   ├── icon.ico                     # Windows
│   └── icon.icns                    # macOS
└── .github/workflows/
    ├── build-windows.yml            # Windows CI/CD
    ├── build-macos.yml              # macOS CI/CD
    └── ci.yml                       # Tests both platforms
```

## Dependencies

### Common (Both Platforms)
```
requirements-common.txt:
numpy>=1.24.0
soxr>=0.3.0
filelock>=3.12.0
```

### Windows-Specific
```
requirements-windows.txt:
-r requirements-common.txt
pyaudiowpatch>=0.2.12.4    # WASAPI loopback
faster-whisper>=1.0.0      # CUDA transcription
```

### macOS-Specific
```
requirements-macos.txt:
-r requirements-common.txt
sounddevice>=0.5.0                                # Microphone
pyobjc-framework-ScreenCaptureKit>=10.0          # Desktop audio
pyobjc-framework-CoreAudio>=10.0                 # Audio framework
lightning-whisper-mlx>=0.1.0                     # Transcription
mlx>=0.0.9                                       # Apple ML framework
```

## User Experience Changes

### Windows Users
- **Zero changes** - Everything works exactly as before
- No model re-downloads
- No configuration changes
- All existing features preserved

### macOS Users (New)
1. **First Launch:**
   - Grant Microphone permission (standard system prompt)
   - Grant Screen Recording permission for desktop audio

2. **Recording:**
   - Select microphone device
   - Select desktop audio source (if permission granted)
   - Fallback to mic-only if permission denied

3. **Transcription:**
   - Models auto-download on first use (~150MB-1.5GB)
   - GPU acceleration automatic (Metal)
   - Performance comparable to Windows CUDA

## Technical Considerations

### Code Signing
- **Approach:** No code signing initially
- Users see Gatekeeper warning on first launch
- Fix: Right-click → Open (or System Settings → Privacy & Security → "Open Anyway")
- **No functional limitations** - app works identically once opened
- Perfect for personal use with friends

### ScreenCaptureKit Permission
- Requires Screen Recording permission (standard macOS security)
- Clear in-app instructions for granting permission
- Graceful fallback to mic-only mode if denied
- No privacy concerns (user explicitly grants permission)

### Model Compatibility
- Windows: CTranslate2 format (unchanged)
- macOS: MLX format (new)
- Both auto-download from Hugging Face
- Models cached locally per platform

### Distribution
- **Windows:** NSIS installer (~700MB)
- **macOS:** DMG installer (~500-550MB, Apple Silicon only)
- **Release Strategy:** Both attached to same GitHub Release

## Development Workflow

### Branch Strategy
```bash
git checkout -b feature/macos-support
# Develop incrementally
# Merge to master when stable
```

### Testing Strategy
1. **Windows:** Verify no regressions (should be trivial - no changes)
2. **macOS:** Test on M1/M2/M3/M4 Macs
3. **Both:** Integration testing, CI/CD validation

### Merge Criteria
- macOS build works (can create DMG)
- Basic recording works (at least mic-only)
- Windows build still works (no regressions)
- CI passes for both platforms

## Future Enhancements (Post-v1.7.0)

1. **Intel Mac Support** (if requested by users)
2. **Code Signing & Notarization** (if wider distribution needed)
3. **Older macOS Support** (if ScreenCaptureKit proves limiting)
4. **Linux Support** (similar approach to macOS)

## References

### Documentation
- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Lightning-Whisper-MLX](https://github.com/mustafaaljadery/lightning-whisper-mlx)
- [Apple MLX Framework](https://github.com/ml-explore/mlx)

### Examples
- [Azayaka - ScreenCaptureKit Example](https://github.com/Mnpn/Azayaka)
- [MLX Whisper Examples](https://github.com/ml-explore/mlx-examples/tree/main/whisper)

---

**Last Updated:** December 2025
**Status:** Planning Complete - Ready for Implementation
