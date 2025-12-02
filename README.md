# 🎙️ Meeting Transcriber

> AI-powered desktop application for recording and transcribing meetings with pristine audio quality

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D6.svg)](https://www.microsoft.com/windows)
[![macOS](https://img.shields.io/badge/Platform-macOS%2013%2B-000000.svg)](https://www.apple.com/macos)
[![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](https://www.python.org/)
[![Electron](https://img.shields.io/badge/Electron-28.0-47848F.svg)](https://www.electronjs.org/)

## What is this?

Meeting Transcriber is a **privacy-first desktop application** that captures and transcribes your meetings with exceptional audio quality. This app captures **both your voice AND desktop audio** (speakers/system audio) - perfect for recording online meetings (with attendee permission), interviews, podcasts, or any computer-based conversation.

### Why I Built This

During remote work, I found myself in countless meetings where I wished I could:

- 📝 **Have accurate transcripts** for later reference
- 🔒 **Keep recordings private** - all processing happens locally on my machine
- 🚀 **Get fast transcriptions** with GPU acceleration

No existing solution offered all of this in one package, so I built it.

## ✨ Key Features

### 🎯 Core Capabilities

- **Dual Audio Capture** - Records both microphone and desktop audio (WASAPI on Windows, ScreenCaptureKit on macOS)
- **AI Transcription** - Powered by OpenAI's Whisper model with 99 language support
- **100% Local Processing** - No data sent to cloud, complete privacy
- **GPU Acceleration** - CUDA support on Windows (NVIDIA), Metal support on macOS (Apple Silicon)
- **Cross-Platform** - 100% feature parity between Windows and macOS

### 🛠️ Technical Features

- **Professional Audio Quality** - 48kHz sampling with soxr VHQ resampling on both platforms
- **Intelligent Audio Enhancement** - Per-channel processing for natural, broadcast-quality sound
- **Opus Compression** - 95% file size reduction (450MB → 23MB for 40-min recording)
- **Meeting History** - Searchable archive with audio playback and full transcripts
- **One-Click Installer** - Professional installers with embedded Python runtime (no dependencies)
- **CPU Fallback** - Automatic fallback to CPU transcription when GPU unavailable

## 🚀 Quick Start

### For End Users (Installer)

**Windows:**

1. **Download** the latest `.exe` installer from [Releases](https://github.com/AmirArshad/meeting-transcriber/releases)
2. **Run** `Meeting Transcriber Setup.exe` (may show SmartScreen warning - click "More info" → "Run anyway")
3. **Launch** the app from Start Menu
4. **Select** your microphone and desktop audio device
5. **Click** "Start Recording" and transcribe!

**macOS:**

1. **Download** the latest `.dmg` file from [Releases](https://github.com/AmirArshad/meeting-transcriber/releases)
2. **Open** the DMG and drag Meeting Transcriber to Applications
3. **⚠️ IMPORTANT:** Right-click the app → select "Open" (NOT double-click)
   - If you double-click, macOS will show '"Meeting Transcriber" is damaged'
   - This is a security warning for unsigned apps, NOT actual damage
   - Right-click → "Open" bypasses this Gatekeeper check
4. **Click** "Open" in the confirmation dialog
5. **Grant** microphone permissions when prompted
6. **Select** your audio devices and start recording!

> **Alternative (if right-click doesn't work):** Run in Terminal: `xattr -d com.apple.quarantine /Applications/Meeting\ Transcriber.app`

**First run:** Whisper model (~500MB) downloads automatically on first transcription.

### For Developers

```bash
# Clone repository
git clone https://github.com/AmirArshad/meeting-transcriber.git
cd meeting-transcriber

# Install Python dependencies
pip install -r requirements.txt

# Install Node.js dependencies
npm install

# Run the app
npm start
```

See [docs/development/BUILD_INSTRUCTIONS.md](docs/development/BUILD_INSTRUCTIONS.md) for detailed setup.

## 📸 How It Works

1. **Select Audio Sources**

   - Choose your microphone (for your voice)
   - Choose desktop audio/loopback device (for system audio)
   - Select transcription language and model size

2. **Record Your Meeting**

   - App captures both audio streams simultaneously
   - Real-time audio enhancement and mixing
   - Automatic Opus compression on save

3. **Get Your Transcript**

   - Click "Stop & Transcribe"
   - Whisper AI processes audio locally
   - View timestamped transcript with audio playback

4. **Access History**
   - Browse all past meetings
   - Search transcripts
   - Re-listen with synchronized audio

## 🎛️ Audio Quality

This app uses **professional-grade audio processing with 100% parity across Windows and macOS**:

- **Microphone Enhancement:**

  - 48kHz sample rate (professional broadcast standard)
  - Per-channel processing for stereo sources
  - DC offset removal (prevents pops/clicks)
  - Minimal processing (Google Meet-style natural sound)
  - Gentle normalization (preserves dynamics)

- **Desktop Audio:**

  - Pristine capture with no processing
  - Maintains original quality
  - 48kHz sample rate on both platforms

- **Final Mix:**
  - soxr VHQ resampling (Very High Quality - maximum available quality)
  - Cross-platform quality matching (identical processing on Windows and macOS)
  - Stereo output with per-channel enhancement
  - Compressed to Opus format (128 kbps, maximum quality)

## 🌍 Supported Languages

The UI provides quick access to 12 commonly used languages:

- **English**, Spanish, French, German, Italian, Portuguese
- **Chinese** (Mandarin/Cantonese), Japanese, Korean
- **Farsi/Persian**, Panjabi, Hindi

Whisper itself supports **99 languages total** - the full list can be customized in the code if needed. See [docs/TRANSCRIPTION_GUIDE.md](docs/TRANSCRIPTION_GUIDE.md) for transcription tips.

## 💻 System Requirements

### Windows

**Minimum:**

- **OS:** Windows 10/11 (64-bit)
- **RAM:** 4 GB
- **Storage:** 2 GB free space
- **Audio:** Any microphone + audio interface

**Recommended:**

- **OS:** Windows 11 (64-bit)
- **RAM:** 8 GB
- **Storage:** 10 GB free space (for models + recordings)
- **GPU:** NVIDIA GPU with 4GB+ VRAM (for CUDA acceleration)
- **Audio:** USB microphone or audio interface

### macOS

**Minimum:**

- **OS:** macOS 13 (Ventura) or later
- **Chip:** Apple Silicon (M1/M2/M3/M4)
- **RAM:** 4 GB
- **Storage:** 2 GB free space
- **Audio:** Any microphone

**Recommended:**

- **OS:** macOS 14 (Sonoma) or later
- **Chip:** M3/M4 (better Metal GPU performance)
- **RAM:** 8 GB
- **Storage:** 10 GB free space (for models + recordings)
- **Audio:** USB microphone or audio interface

## ⚙️ Technology Stack

- **Frontend:** Electron 28, HTML/CSS/JavaScript
- **Backend:** Python 3.11 (bundled)
- **AI Models:**
  - Windows: faster-whisper (OpenAI Whisper with CUDA)
  - macOS: Lightning-Whisper-MLX (Metal GPU acceleration)
- **Audio Capture:**
  - Windows: PyAudioWPatch (WASAPI loopback)
  - macOS: sounddevice + ScreenCaptureKit
- **Audio Processing:** NumPy, SciPy, soxr (high-quality resampling)
- **Compression:** ffmpeg (Opus codec)
- **GPU Acceleration:**
  - Windows: PyTorch + CUDA 12.1
  - macOS: MLX framework (Metal)

## 📚 Documentation

- **User Guides:**

  - [🔧 Troubleshooting](docs/TROUBLESHOOTING.md) - **Common issues & solutions**
  - [Transcription Tips](docs/TRANSCRIPTION_GUIDE.md) - Get the best results
  - [Meeting Features](docs/MEETING_TRANSCRIPTION.md) - Using the history viewer

- **Development:**

  - [Build Instructions](docs/development/BUILD_INSTRUCTIONS.md) - Create installer
  - [GPU Setup](docs/development/SETUP_GPU.md) - Enable CUDA acceleration
  - [Implementation Details](docs/development/INSTALLER_IMPLEMENTATION.md) - Technical overview

- **Roadmap & Features:**
  - [Product Roadmap](docs/ROADMAP.md) - Full development roadmap
  - [Speaker Diarization](docs/features/FEATURE_SPEAKER_DIARIZATION.md) - Who said what
  - [Setup Wizard](docs/features/FEATURE_SETUP_WIZARD.md) - Guided first-time setup
  - [Combined Button](docs/features/FEATURE_COMBINED_BUTTON.md) - Unified recording control
  - [Audio Visualizer](docs/features/FEATURE_AUDIO_VISUALIZER.md) - Real-time level meters
  - [Auto-Updater](docs/features/FEATURE_AUTO_UPDATER.md) - Automatic updates from GitHub

## 🔒 Privacy & Security

- ✅ **100% Local Processing** - No cloud uploads, no API calls
- ✅ **No Telemetry** - Zero usage tracking or analytics
- ✅ **No Account Required** - No login, no email, no registration
- ✅ **Open Source** - Full transparency, audit the code yourself
- ✅ **GDPR Compliant** - No personal data collected

See [docs/internal/SECURITY_AUDIT.md](docs/internal/SECURITY_AUDIT.md) for full security analysis.

## 📝 License

This project is licensed under the MIT License - see [LICENSE.txt](LICENSE.txt) for details.

## 🙏 Acknowledgments

- **OpenAI** - For the incredible Whisper model
- **faster-whisper** - For the efficient CPU/CUDA implementation
- **Lightning-Whisper-MLX** - For blazing-fast Metal GPU acceleration on macOS
- **PyAudioWPatch** - For WASAPI loopback support on Windows
- **ScreenCaptureKit** - For pristine desktop audio capture on macOS
- **Electron** - For making desktop apps accessible

## 📞 Contact & Support

- **Issues:** [GitHub Issues](https://github.com/AmirArshad/meeting-transcriber/issues)
- **Discussions:** [GitHub Discussions](https://github.com/AmirArshad/meeting-transcriber/discussions)

## 🗺️ Roadmap

### Completed ✅

- [x] Core recording and transcription
- [x] Meeting history with playback
- [x] GPU acceleration support
- [x] Professional installer
- [x] Opus audio compression
- [x] Model preloading for improved first-time experience
- [x] Combined Start/Stop/Transcribe button (single action UX)
- [x] Audio visualizer (real-time waveform during recording)
- [x] **v1.6.0:** Background recording stability (60+ min recordings)
- [x] **v1.6.0:** Performance optimizations (75% less CPU when minimized)
- [x] **v1.6.0:** Audio quality improvements (Google Meet-quality)
- [x] **v1.6.1:** Transcription reliability fixes (handle edge cases gracefully)
- [x] **v1.6.1:** Automatic meeting recovery (scan filesystem on refresh)
- [x] **v1.6.1:** Cantonese language support added to UI
- [x] **v1.7.0:** macOS support with Metal GPU acceleration
- [x] **v1.7.0:** Cross-platform audio quality parity (48kHz + soxr VHQ resampling)
- [x] **v1.7.0:** CPU fallback for Intel Macs (faster-whisper with int8 optimization)
- [x] **v1.7.0:** 100% feature parity across Windows and macOS

### In Progress 🚧

- [ ] Auto-updater (GitHub release detection and installation)

### Planned 📋

- [ ] Speaker diarization (identify who's speaking)
- [ ] **macOS Advanced Audio:** Real-time streaming (low RAM), App-specific capture, Real-time mixing
- [ ] Real-time transcription
- [ ] Export to various formats (SRT, VTT, DOCX)

---
