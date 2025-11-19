# Meeting Transcriber

A Windows desktop application for recording and transcribing meetings using OpenAI's Whisper model with local GPU acceleration.

## Project Status

🚧 **In Development** - Currently implementing core components

### Completed
- ✅ Project structure
- ✅ Audio device enumeration (`device_manager.py`)
- ✅ Audio recording with WASAPI loopback (`audio_recorder.py`)
  - Microphone recording
  - Desktop audio (loopback) recording
  - Mixed recording (mic + desktop)
  - High-quality audio mixing with resampling
- ✅ Whisper transcription integration (`transcriber.py`)
  - CPU and GPU support (CUDA)
  - 99 language support
  - Markdown output with timestamps
  - Auto-fallback to CPU if GPU unavailable

### In Progress
- 🔄 Electron UI (interface created, testing in progress)
- 🔄 Application packaging/installer

### Planned
- ⏳ Speaker diarization (see [FEATURE_SPEAKER_DIARIZATION.md](FEATURE_SPEAKER_DIARIZATION.md))
- ⏳ Setup wizard (see [FEATURE_SETUP_WIZARD.md](FEATURE_SETUP_WIZARD.md))

## Quick Start (Development)

### Prerequisites
- Python 3.10+
- Node.js 18+ (for Electron UI)
- Windows 10/11 (64-bit)
- NVIDIA GPU with CUDA support (optional, for GPU transcription)

### Installation

1. **Install Python dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

2. **(Optional) Setup GPU Acceleration:**

   For 4-5x faster transcription with CUDA:

   **Automatic setup (Windows):**
   ```bash
   setup_gpu.bat
   ```

   **Manual setup:**
   ```bash
   # Install PyTorch with CUDA
   pip install torch --index-url https://download.pytorch.org/whl/cu121

   # Install CUDA libraries
   pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
   ```

   See [SETUP_GPU.md](SETUP_GPU.md) for detailed instructions and troubleshooting.

### Testing

1. **List audio devices:**
   ```bash
   cd backend
   python device_manager.py
   ```

2. **Record audio:**
   ```bash
   python test_recording.py
   # Follow the prompts to select devices
   ```

3. **Transcribe audio:**
   ```bash
   python test_transcribe.py
   # Follow the prompts to select a recording
   ```

4. **Run the Electron UI:**
   ```bash
   npm install  # First time only
   npm start    # Launch the app
   ```

   Or with DevTools for debugging:
   ```bash
   npm run dev
   ```

## Architecture

```
meeting-transcriber/
├── backend/              # Python backend
│   ├── device_manager.py # Audio device enumeration
│   ├── audio_recorder.py # Post-processing mix recorder (V2)
│   ├── transcriber.py    # Whisper transcription
│   ├── find_active_audio.py # Auto-detect desktop audio
│   └── test_*.py         # Test scripts
├── src/                  # Electron app
│   ├── main.js           # Main process
│   ├── preload.js        # Security bridge
│   └── renderer/         # UI
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── package.json          # Node dependencies
└── requirements.txt      # Python dependencies
```

## Technology Stack

- **Frontend:** Electron (HTML/CSS/JavaScript)
- **Backend:** Python
  - Audio Recording: pyaudiowpatch (WASAPI loopback)
  - Transcription: faster-whisper
  - Audio Processing: numpy, scipy
- **GPU:** CUDA (NVIDIA) - Optional, 4-5x faster transcription

## Documentation

See `backend/README.md` for Python backend documentation.

## License

Personal use project - no license specified yet.
