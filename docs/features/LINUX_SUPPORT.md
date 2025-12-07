# Linux Support - Implementation Plan

**Status:** 📋 Planned (v1.8.0)  
**Target Platforms:** Arch Linux / SteamOS, Ubuntu / Linux Mint  
**Minimum Requirements:** Ubuntu 20.04+ / Arch Linux (current)

---

## Overview

This document outlines the plan for adding native Linux support to Meeting Transcriber while maintaining existing Windows and macOS versions in a single repository. The approach follows the established pattern of platform-specific optimizations with maximum code sharing.

## Key Features (Linux)

- ✅ **Native Desktop Audio Capture** via PulseAudio/PipeWire Monitor
- ✅ **Microphone Recording** via sounddevice (PortAudio)
- ✅ **GPU-Accelerated Transcription** using NVIDIA CUDA (optional)
- ✅ **Universal Packaging** via AppImage (runs everywhere)
- ✅ **No Third-Party Software Required** (uses system audio daemon)

## Architecture Decisions

### 1. Repository Structure

**Single monorepo** containing Windows, macOS, and Linux versions:

- ~75% code shared (UI, database, business logic, transcription)
- Platform-specific modules only for audio capture
- Clean abstraction layer already established from macOS work

### 2. Audio Capture Strategy

#### Windows (Unchanged)

- **Library:** pyaudiowpatch (WASAPI loopback)
- **Desktop Audio:** WASAPI loopback devices
- **Microphone:** Standard input devices
- **Status:** ✅ Existing implementation preserved

#### macOS (Unchanged)

- **Library:** sounddevice + ScreenCaptureKit
- **Desktop Audio:** ScreenCaptureKit API
- **Microphone:** sounddevice (PortAudio)
- **Status:** ✅ Existing implementation preserved

#### Linux (New)

- **Library:** sounddevice (PortAudio)
- **Desktop Audio:** PulseAudio/PipeWire Monitor Source
- **Microphone:** sounddevice (PortAudio)
- **Fallback:** Mic-only mode if monitor source not found

**Why PulseAudio Monitor?**

- Works on **both** PulseAudio (Ubuntu/Mint) and PipeWire (Arch/SteamOS)
- PipeWire includes `pipewire-pulse` compatibility layer
- No kernel modules or virtual cables required
- Standard on all modern Linux distributions
- Zero additional software installation

### 3. Transcription Strategy: Shared Backend

#### Linux: faster-whisper (SAME AS WINDOWS)

```python
# backend/transcription/faster_whisper_transcriber.py
# Existing Windows implementation - zero changes needed
- CUDA GPU acceleration (NVIDIA GPUs)
- CPU fallback (Intel/AMD CPUs, AMD APUs like Steam Deck)
- CTranslate2 models (already cached)
```

**Why Shared Backend?**
| Aspect | Benefit |
|--------|---------|
| **Code Reuse** | 100% transcription code shared with Windows |
| **Maintenance** | No new transcriber to maintain |
| **Quality** | Proven implementation, no new bugs |
| **GPU Support** | Native CUDA support for NVIDIA users |

### 4. Performance Expectations

#### Desktop PCs (NVIDIA GPU + CUDA)

- **Same as Windows** - Identical performance
- Medium model: 4-5x realtime

#### Steam Deck (AMD Zen2 APU + CPU)

- Tiny model: 1-2x realtime
- Base model: 0.5-1x realtime (slightly slower than realtime)
- Small model: 0.3-0.5x realtime
- **Note:** Steam Deck runs on CPU (no AMD GPU support). Base/Tiny models recommended.

#### AMD Desktop (ROCm - Future)

- ROCm (AMD GPU support) possible but complex
- Not in initial release
- Can be added in v1.9.0+ if user demand exists

## Implementation Phases

### Phase 1: Audio Implementation (Week 1)

**Goal:** Implement Linux audio recorder using existing abstraction

**Tasks:**

1. Create `backend/audio/linux_recorder.py`
2. Implement PulseAudio monitor detection via `sounddevice`
3. Handle both PulseAudio and PipeWire scenarios
4. Match interface with Windows/macOS recorders
5. Test on Ubuntu 22.04 and Arch Linux

**Deliverables:**

- Working Linux recorder
- Windows/macOS unchanged
- Device enumeration shows monitor sources

### Phase 2: Device Management (Week 1)

**Goal:** Update device manager to support Linux

**Tasks:**

1. Add `_list_devices_linux()` to `device_manager.py`
2. Detect PulseAudio/PipeWire monitor sources
3. Create virtual "System Audio (Monitor)" entry
4. Handle edge cases (no monitor, multiple monitors)

### Phase 3: Build System (Week 2)

**Goal:** Create AppImage and .deb packages

**Tasks:**

1. Add Linux build targets to `package.json`
2. Create `build/prepare-resources-linux.js`
3. Bundle Python runtime for Linux (x64)
4. Bundle ffmpeg static binary for Linux
5. Test AppImage on Ubuntu and Arch

**Build Configuration:**

```json
"linux": {
  "target": [
    {
      "target": "AppImage",
      "arch": ["x64"]
    },
    {
      "target": "deb",
      "arch": ["x64"]
    }
  ],
  "category": "Office",
  "maintainer": "meeting-transcriber@example.com"
}
```

### Phase 4: CI/CD Pipeline (Week 2)

**Goal:** Automate Linux builds

**Tasks:**

1. Create `.github/workflows/build-linux.yml`
2. Use `ubuntu-20.04` runner (for glibc compatibility)
3. Build both AppImage and .deb
4. Upload to GitHub Releases
5. Test installers on multiple distros

### Phase 5: Testing (Week 3)

**Goal:** Verify compatibility across Linux distributions

**Testing Matrix:**

- Ubuntu 20.04, 22.04, 24.04
- Linux Mint 21
- Arch Linux (current)
- SteamOS 3.x (Steam Deck)
- Fedora 39+ (PipeWire test)

## File Organization

```
meeting-transcriber/
├── backend/
│   ├── audio/
│   │   ├── __init__.py              # Factory: get_audio_recorder()
│   │   ├── base_recorder.py         # Abstract base class
│   │   ├── windows_recorder.py      # Windows (pyaudiowpatch)
│   │   ├── macos_recorder.py        # macOS (ScreenCaptureKit)
│   │   └── linux_recorder.py        # 🆕 Linux (PulseAudio/PipeWire)
│   ├── transcription/
│   │   ├── __init__.py              # Factory: get_transcriber()
│   │   ├── base_transcriber.py      # Abstract base class
│   │   ├── faster_whisper_transcriber.py  # Windows + Linux (CUDA/CPU)
│   │   └── mlx_whisper_transcriber.py     # macOS (MLX Metal)
│   ├── device_manager.py            # Platform detection + Linux support
│   ├── meeting_manager.py           # Shared (no changes)
│   └── platform_utils.py            # Platform detection utilities
├── build/
│   ├── resources/
│   │   ├── python-windows/          # Windows Python + deps
│   │   ├── python-macos/            # macOS Python + deps
│   │   ├── python-linux/            # 🆕 Linux Python + deps
│   │   ├── ffmpeg-windows/          # Windows ffmpeg
│   │   ├── ffmpeg-macos/            # macOS ffmpeg
│   │   └── ffmpeg-linux/            # 🆕 Linux ffmpeg (static)
│   ├── prepare-resources-windows.js
│   ├── prepare-resources-macos.js
│   ├── prepare-resources-linux.js   # 🆕
│   ├── icon.ico                     # Windows
│   ├── icon.icns                    # macOS
│   └── icon.png                     # 🆕 Linux (256x256)
└── .github/workflows/
    ├── build-windows.yml            # Windows CI/CD
    ├── build-macos.yml              # macOS CI/CD
    ├── build-linux.yml              # 🆕 Linux CI/CD
    └── build-release.yml            # Combined release for all platforms
```

## Dependencies

### Common (All Platforms)

```
requirements-common.txt:
numpy>=1.24.0
scipy>=1.11.0
soxr>=0.3.0
filelock>=3.12.0
```

### Windows-Specific (Unchanged)

```
requirements-windows.txt:
-r requirements-common.txt
pyaudiowpatch>=0.2.12.4    # WASAPI loopback
faster-whisper>=1.0.0      # CUDA transcription
```

### macOS-Specific (Unchanged)

```
requirements-macos.txt:
-r requirements-common.txt
sounddevice>=0.4.6
pyobjc-framework-ScreenCaptureKit>=10.0
lightning-whisper-mlx>=0.0.10
```

### Linux-Specific (New)

```
requirements-linux.txt:
-r requirements-common.txt
sounddevice>=0.4.6         # Microphone + Monitor
faster-whisper>=1.0.0      # Transcription (CUDA/CPU)
pulsectl>=23.5.0           # Optional: PulseAudio monitor detection
```

**System Dependencies (AppImage includes these):**

- `libportaudio2` - PortAudio library
- `pulseaudio` or `pipewire-pulse` - Audio daemon
- `ffmpeg` (bundled in AppImage)

## User Experience Changes

### Windows Users

- **Zero changes** - Everything works exactly as before

### macOS Users

- **Zero changes** - Everything works exactly as before

### Linux Users (New)

#### Installation

**AppImage (Recommended):**

```bash
# Download from GitHub Releases
chmod +x Meeting-Transcriber-1.8.0.AppImage
./Meeting-Transcriber-1.8.0.AppImage
```

**Debian/Ubuntu (.deb):**

```bash
sudo dpkg -i meeting-transcriber_1.8.0_amd64.deb
sudo apt-get install -f  # Fix dependencies
```

#### First Launch

1. **Permissions (if using Flatpak/Snap later):**

   - Grant PulseAudio/PipeWire access
   - Standard Linux permissions (no special prompts)

2. **Device Selection:**

   - Microphone: Standard input devices
   - Desktop Audio: "Monitor of [Output Device]" or "System Audio (Monitor)"
   - Fallback to mic-only if monitor not detected

3. **Transcription:**
   - Models auto-download (~500MB–1.5GB)
   - CUDA auto-detected (NVIDIA GPUs)
   - CPU fallback (AMD/Intel)

## Technical Considerations

### PulseAudio vs PipeWire

**Strategy:** Target PulseAudio API, which PipeWire emulates via `pipewire-pulse`.

**Detection Logic:**

```python
# Check if PipeWire is running
pipewire_running = subprocess.run(['pidof', 'pipewire'],
                                   capture_output=True).returncode == 0

# Use same API for both (PulseAudio compatibility layer)
monitor_device = find_monitor_source()
```

### Monitor Source Detection

```python
import sounddevice as sd

# List all devices
devices = sd.query_devices()

# Find monitor sources (contain "monitor" in name)
monitors = [d for d in devices if 'monitor' in d['name'].lower()]

# Prefer: "Monitor of [default output]"
default_monitor = [m for m in monitors if 'default' in m['name'].lower()]
```

### AppImage Compatibility

- **Build on Ubuntu 20.04** (glibc 2.31) for maximum compatibility
- **Static ffmpeg** bundled (no system dependencies)
- **Portable Python** using PyInstaller or standalone build
- **PortAudio** bundled in AppImage

### Steam Deck Specifics

- **SteamOS 3.x:** Arch Linux with PipeWire
- **File System:** Read-only root partition
- **Solution:** AppImage runs from `~/Downloads` or SD card
- **Performance:** CPU-only transcription (Base/Tiny models recommended)
- **UI Scaling:** 1280x800 resolution, touch-friendly buttons

## Build Pipeline

### Linux Build Workflow (`.github/workflows/build-linux.yml`)

```yaml
name: Build Linux Installer

on:
  push:
    tags:
      - "v*"

jobs:
  build-linux:
    runs-on: ubuntu-20.04 # Old glibc for compatibility

    steps:
      - name: Checkout
        uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: 18

      - name: Install Dependencies
        run: npm install

      - name: Prepare Linux Resources
        run: node build/prepare-resources-linux.js

      - name: Build AppImage & DEB
        run: npm run build:linux
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Upload Artifacts
        uses: actions/upload-artifact@v3
        with:
          name: linux-installers
          path: |
            dist/*.AppImage
            dist/*.deb
```

### Resource Preparation (`build/prepare-resources-linux.js`)

```javascript
// 1. Download portable Python for Linux
// 2. Install Python dependencies via pip
// 3. Download static ffmpeg binary
// 4. Create build/resources/python-linux/
// 5. Create build/resources/ffmpeg-linux/
```

### Package.json Updates

```json
{
  "scripts": {
    "build:linux": "electron-builder build --linux --publish never",
    "build:linux:dir": "electron-builder build --linux --dir"
  },
  "build": {
    "linux": {
      "target": ["AppImage", "deb"],
      "category": "Office",
      "icon": "build/icon.png",
      "artifactName": "${productName}-${version}.${ext}"
    }
  }
}
```

## Development Workflow

### Testing Locally

**On Linux:**

```bash
# Install dependencies
npm install
pip install -r requirements-linux.txt

# Run in development
npm start

# Build AppImage
npm run build:linux
```

**On Windows/macOS (via VM):**

- Use VirtualBox/VMware with Ubuntu 22.04
- Or use GitHub Actions for testing

### Branch Strategy

```bash
git checkout -b feature/linux-support
# Develop incrementally
# Test on Ubuntu + Arch
# Merge to main when stable
```

## Distribution Strategy

### GitHub Releases

**v1.8.0 Release Assets:**

- `Meeting-Transcriber-Setup-1.8.0.exe` (Windows)
- `Meeting-Transcriber-1.8.0.dmg` (macOS)
- `Meeting-Transcriber-1.8.0.AppImage` (Linux Universal)
- `meeting-transcriber_1.8.0_amd64.deb` (Ubuntu/Debian)

### Installation Instructions (README)

```markdown
## Linux Installation

### AppImage (All Distros)

1. Download `Meeting-Transcriber-1.8.0.AppImage`
2. Make executable: `chmod +x Meeting-Transcriber-1.8.0.AppImage`
3. Run: `./Meeting-Transcriber-1.8.0.AppImage`

### Ubuntu/Debian (.deb)

1. Download `meeting-transcriber_1.8.0_amd64.deb`
2. Install: `sudo dpkg -i meeting-transcriber_1.8.0_amd64.deb`
3. Fix dependencies: `sudo apt-get install -f`
```

## Future Enhancements (Post-v1.8.0)

1. **AMD ROCm Support** (GPU acceleration for AMD GPUs)
2. **Flatpak Package** (if wider sandboxed distribution needed)
3. **Snap Package** (for Ubuntu Software Center)
4. **ARM64 Support** (Raspberry Pi, Linux phones)

## References

### Documentation

- [PulseAudio Monitor Sources](https://www.freedesktop.org/wiki/Software/PulseAudio/)
- [PipeWire PulseAudio Compatibility](https://docs.pipewire.org/page_man_pipewire-pulse_1.html)
- [electron-builder Linux](https://www.electron.build/configuration/linux)

### Examples

- [AppImage Best Practices](https://docs.appimage.org/packaging-guide/index.html)
- [PortAudio on Linux](http://portaudio.com/docs/v19-doxydocs/compile_linux.html)

---

**Last Updated:** December 2025  
**Status:** Planning Complete - Ready for Implementation
