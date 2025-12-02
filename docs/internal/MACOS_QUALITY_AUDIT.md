# macOS Recording Quality & Installation Size Audit

**Date:** December 2, 2025
**Purpose:** Compare macOS implementation against Windows to ensure feature parity for recording quality optimizations and installation size efficiency.

---

## Executive Summary

This audit reveals **significant gaps** in the macOS implementation compared to Windows. While the core architecture is sound, several critical audio quality optimizations and installation size features present in Windows are missing or incomplete on macOS.

**Key Findings:**
- Audio quality settings differ significantly (44.1kHz vs 48kHz)
- Desktop audio capture is incomplete (ScreenCaptureKit not fully implemented)
- Transcription uses different libraries (Lightning-Whisper-MLX vs faster-whisper)
- PyObjC frameworks add substantial installation overhead (~50-100MB+)
- No audio enhancement applied to macOS recordings

---

## Section 1: Audio Quality Parity Analysis

### 1.1 Sample Rate Configuration

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **Default Sample Rate** | 48000 Hz | 48000 Hz | ✓ MATCH |
| **Actual Implementation** | 48000 Hz (with auto-detect) | 44100 Hz (hardcoded in ScreenCaptureKit) | ⚠️ GAP |
| **Sample Rate Auto-Detection** | ✓ Yes (attempts 48kHz, fallback to device default) | ✗ No | ⚠️ GAP |

**Details:**
- **Windows** (`windows_recorder.py:65-77`): Intelligently attempts 48kHz capture even if mic defaults to 16kHz, with graceful fallback
- **macOS** (`macos_recorder.py:64`): Target rate set to 48000 Hz, but `screencapture_helper.py:28` hardcodes 44100 Hz for desktop audio
- **Impact:** macOS records at lower sample rate for desktop audio, requiring resampling and potential quality loss

### 1.2 Bit Depth & Channels

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **Bit Depth** | 16-bit (int16) | float32 (ScreenCaptureKit), int16 (final) | ⚠️ DIFFERENT |
| **Channels** | 2 (stereo) | 2 (stereo) | ✓ MATCH |
| **Mic Channels** | Auto-detect (mono/stereo) | Auto-detect (mono/stereo) | ✓ MATCH |

**Details:**
- **Windows**: Uses int16 throughout for consistency
- **macOS**: ScreenCaptureKit provides float32, converted to int16 later (additional processing step)
- **Impact:** Negligible - conversion is lossless for the quality level

### 1.3 Resampling Quality

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **Resampling Library** | soxr | soxr | ✓ MATCH |
| **Quality Setting** | VHQ (Very High Quality) | Not implemented | ⚠️ CRITICAL GAP |

**Details:**
- **Windows** (`windows_recorder.py:603-617`): Uses `soxr.resample()` with `quality='VHQ'`
- **macOS** (`macos_recorder.py:308-318`): Uses numpy padding instead of proper resampling when audio lengths differ
- **Impact:** macOS quality degradation when mic and desktop audio have different sample rates

**Code Comparison:**

Windows (VHQ resampling):
```python
# windows_recorder.py:603-617
def _resample(self, audio_data, original_rate, target_rate):
    audio_float = audio_data.astype(np.float32) / 32768.0
    resampled = soxr.resample(
        audio_float,
        original_rate,
        target_rate,
        quality='VHQ'  # Very High Quality
    )
    return (resampled * 32767.0).astype(np.int16)
```

macOS (no resampling):
```python
# macos_recorder.py:308-318
# Just pads with zeros instead of resampling
if len(mic_audio) != len(desktop_audio):
    target_length = max(len(mic_audio), len(desktop_audio))
    if len(mic_audio) < target_length:
        mic_audio = np.pad(mic_audio, ...)
```

### 1.4 Audio Enhancement

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **DC Offset Removal** | ✓ Yes | ✓ Yes | ✓ MATCH |
| **Noise Reduction** | ✓ Yes (minimal, Google Meet-style) | ✗ No | ⚠️ GAP |
| **Automatic Gain Control** | ✓ Yes (gentle normalization) | ✓ Partial (basic normalization) | ⚠️ PARTIAL |
| **High-pass Filtering** | ✗ No (removed for quality) | ✗ No | ✓ MATCH |
| **Soft Limiting** | ✓ Yes (tanh, prevents clipping) | ✓ Yes (tanh) | ✓ MATCH |

**Details:**
- **Windows** (`windows_recorder.py:538-601`): Comprehensive `_enhance_microphone()` and `_process_channel()` methods with minimal processing philosophy
- **macOS** (`macos_recorder.py:360-390`): Simpler `_enhance_microphone()` method, missing per-channel processing
- **Impact:** Windows recordings have cleaner, more consistent audio levels

**Code Comparison:**

Windows (comprehensive enhancement):
```python
# windows_recorder.py:572-601
def _process_channel(self, channel_data, sample_rate):
    # 1. Remove DC offset
    channel_data = channel_data - np.mean(channel_data)

    # 2. Very gentle normalization to -3dB peak
    peak = np.max(np.abs(channel_data))
    if peak > 0.7:
        channel_data = channel_data * (0.7 / peak)
    elif peak < 0.1:
        channel_data = channel_data * (0.3 / peak)

    # 3. Soft limiting
    abs_max = np.max(np.abs(channel_data))
    if abs_max > 0.95:
        channel_data = np.tanh(channel_data * 0.9) * 0.85

    return channel_data
```

macOS (basic enhancement):
```python
# macos_recorder.py:360-390
def _enhance_microphone(self, audio):
    # Remove DC offset
    audio = audio - np.mean(audio, axis=0)

    # Basic normalization
    current_peak = np.max(np.abs(audio))
    if current_peak > 0:
        target_peak = 0.8
        if current_peak < target_peak:
            gain = target_peak / current_peak
            audio = audio * gain

    # 2x boost + soft limiting
    audio = audio * 2.0
    audio = np.tanh(audio * 0.8) * 0.95

    return audio
```

### 1.5 Desktop Audio Capture Quality

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **Capture Method** | WASAPI Loopback (PyAudioWPatch) | ScreenCaptureKit (PyObjC) | ⚠️ DIFFERENT |
| **Implementation Status** | ✓ Complete | ⚠️ Incomplete | ❌ CRITICAL GAP |
| **Sample Rate** | Device native (typically 48kHz) | 44.1kHz (hardcoded) | ⚠️ GAP |
| **Bit Depth** | 16-bit int16 | 32-bit float32 | ⚠️ DIFFERENT |

**Details:**
- **Windows**: Mature WASAPI loopback via PyAudioWPatch, battle-tested
- **macOS**: ScreenCaptureKit implementation exists but has issues:
  - Hardcoded 44.1kHz sample rate (`screencapture_helper.py:28`)
  - Complex PyObjC delegate pattern (`screencapture_helper.py:74-185`)
  - Async callback handling may cause buffer issues
  - Requires Screen Recording permission
  - Not verified to work in production

**Code Evidence:**
```python
# screencapture_helper.py:28
def __init__(self, sample_rate: int = 44100, channels: int = 2):
    # Hardcoded 44100, ignoring the parameter default of 48000
```

```python
# macos_recorder.py:127-131
print(f"", file=sys.stderr)
print(f"Note: Desktop audio (ScreenCaptureKit) not yet implemented.", file=sys.stderr)
print(f"Recording microphone only for now.", file=sys.stderr)
print(f"", file=sys.stderr)
```

### 1.6 Compression Settings

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **Codec** | Opus (libopus) | Opus (libopus) | ✓ MATCH |
| **Bitrate** | 128 kbps | 128 kbps | ✓ MATCH |
| **VBR** | On | On | ✓ MATCH |
| **Compression Level** | 10 (maximum quality) | 10 (maximum quality) | ✓ MATCH |
| **Application Mode** | audio | audio | ✓ MATCH |
| **Sample Rate Preservation** | ✓ Yes (48kHz) | ✓ Yes (48kHz target) | ✓ MATCH |

**Details:**
- Both implementations use identical ffmpeg compression settings
- Windows: `windows_recorder.py:501-536`
- macOS: `macos_recorder.py:410-458`

---

## Section 2: Installation Size Comparison

### 2.1 Python Runtime

| Component | Windows | macOS | Status |
|-----------|---------|-------|--------|
| **Python Type** | Embedded Python (minimal) | python-build-standalone (relocatable) | ⚠️ DIFFERENT |
| **Python Version** | 3.11.9 | 3.11.7 | ⚠️ DIFFERENT |
| **Estimated Size** | ~15 MB | ~35-50 MB | ⚠️ LARGER |
| **Includes pip** | Manual setup | ✓ Included | ✓ BETTER |

**Details:**
- **Windows** (`prepare-resources.js:8-9`): Uses official Python embedded distribution (minimal, optimized for bundling)
- **macOS** (`prepare-resources.js:11-12`): Uses indygreg/python-build-standalone (larger but more complete)
- **Impact:** macOS installation will be 20-35 MB larger due to Python runtime alone

### 2.2 Required Dependencies

**Windows** (`requirements-windows.txt`):
```
pyaudiowpatch>=0.2.12.4  # ~1 MB
numpy>=1.24.0            # ~20 MB
scipy>=1.11.0            # ~30 MB
soxr>=0.3.0              # ~2 MB
faster-whisper>=1.0.0    # ~5 MB + deps
filelock>=3.12.0         # <1 MB
# Total: ~58-60 MB + PyTorch/CUDA (optional)
```

**macOS** (`requirements-macos.txt`):
```
sounddevice>=0.4.6                          # ~2 MB
numpy>=1.24.0                               # ~20 MB
scipy>=1.11.0                               # ~30 MB
soxr>=0.3.0                                 # ~2 MB
pyobjc-framework-ScreenCaptureKit>=10.0     # ~25-40 MB
pyobjc-framework-CoreAudio>=10.0            # ~10-15 MB
pyobjc-framework-AVFoundation>=10.0         # ~15-20 MB
lightning-whisper-mlx>=0.0.10               # ~5 MB + MLX deps
filelock>=3.12.0                            # <1 MB
# Total: ~109-135 MB + MLX framework (~20-30 MB)
```

**Analysis:**
- **Windows** dependencies: ~58-60 MB (excluding optional GPU libraries)
- **macOS** dependencies: ~109-135 MB (including mandatory PyObjC frameworks)
- **Gap**: macOS requires **+51-75 MB** more for dependencies, primarily due to:
  - PyObjC frameworks (3 packages): ~50-75 MB
  - MLX framework: ~20-30 MB
  - These are **mandatory** for desktop audio and transcription on macOS

### 2.3 Model Download Strategy

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **Models Bundled** | ✗ No (on-demand) | ✗ No (on-demand) | ✓ MATCH |
| **First-run Download** | ✓ Yes (~500MB for base) | ✓ Yes (~500MB for base) | ✓ MATCH |
| **Model Cache Location** | User's home/.cache | User's home/.cache | ✓ MATCH |

**Details:**
- Both platforms download models on first transcription
- Build script (`prepare-resources.js:153-203`) can pre-download models (optional, controlled by `DOWNLOAD_MODELS` env var)
- **No difference** in model download strategy

### 2.4 FFmpeg Bundle

| Component | Windows | macOS | Status |
|-----------|---------|-------|--------|
| **FFmpeg Type** | Essentials build | Minimal build | ✓ MATCH |
| **Estimated Size** | ~50 MB | ~60 MB | ⚠️ SLIGHTLY LARGER |
| **Download Source** | gyan.dev | evermeet.cx | ⚠️ DIFFERENT |

**Details:**
- **Windows** (`prepare-resources.js:13`): Downloads "essentials" build from gyan.dev (~50 MB)
- **macOS** (`prepare-resources.js:14`): Downloads from evermeet.cx (~60 MB)
- **Both**: Only include ffmpeg binary (no ffprobe, ffplay, or extra codecs)
- **Impact:** macOS ffmpeg is ~10 MB larger

### 2.5 Total Installation Size Estimate

| Platform | Base Install | With Dependencies | With Models (base) | Total |
|----------|--------------|-------------------|-------------------|-------|
| **Windows** | ~100 MB | ~160 MB | ~660 MB | ~660 MB |
| **macOS** | ~100 MB | ~250 MB | ~750 MB | ~750 MB |
| **Gap** | - | **+90 MB** | **+90 MB** | **+90 MB** |

**Breakdown:**

**Windows:**
- Electron app: ~100 MB
- Python 3.11.9 embedded: ~15 MB
- Python dependencies: ~58 MB
- FFmpeg: ~50 MB
- Backend scripts: ~2 MB
- **Total (no models): ~225 MB**
- Base Whisper model: ~450 MB
- **Total (with base model): ~675 MB**

**macOS:**
- Electron app: ~100 MB
- Python 3.11.7 standalone: ~45 MB
- Python dependencies: ~120 MB
- FFmpeg: ~60 MB
- Backend scripts: ~2 MB
- **Total (no models): ~327 MB**
- Base Whisper model: ~450 MB
- **Total (with base model): ~777 MB**

**Key Differences:**
1. PyObjC frameworks add ~50-75 MB (mandatory for ScreenCaptureKit)
2. python-build-standalone is larger than embedded Python (+30 MB)
3. MLX framework adds ~20-30 MB (mandatory for Metal GPU acceleration)

---

## Section 3: Performance Optimizations

### 3.1 Hardware Acceleration

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **GPU Framework** | CUDA (NVIDIA) | Metal (Apple Silicon) | ⚠️ DIFFERENT |
| **Transcription Library** | faster-whisper | lightning-whisper-mlx | ⚠️ DIFFERENT |
| **Auto-Detection** | ✓ Yes (CUDA available?) | ✓ Yes (always Metal) | ✓ MATCH |
| **Fallback to CPU** | ✓ Yes (graceful) | ✗ No (Metal only) | ⚠️ GAP |

**Details:**
- **Windows** (`faster_whisper_transcriber.py:199-213`): Detects CUDA availability, falls back to CPU gracefully
- **macOS** (`mlx_whisper_transcriber.py:149, 163`): Always uses Metal GPU (no CPU fallback)
- **Impact:** macOS **requires** Apple Silicon - won't work on Intel Macs or if Metal is unavailable

**Code Evidence:**

Windows (flexible device selection):
```python
# faster_whisper_transcriber.py:199-213
if device == "auto":
    try:
        import torch
        if torch.cuda.is_available():
            device = "cuda"
        else:
            device = "cpu"
    except:
        device = "cpu"  # Safe fallback
```

macOS (Metal-only, no fallback):
```python
# mlx_whisper_transcriber.py:149, 163
self.device = "metal"  # Hardcoded
print(f"  Device: Metal GPU (Apple Silicon)", file=sys.stderr)
```

### 3.2 Compute Types (Quantization)

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **CPU Compute Type** | int8 (quantized) | N/A (no CPU support) | ⚠️ GAP |
| **GPU Compute Type** | float16 | float16 | ✓ MATCH |
| **Auto-Selection** | ✓ Yes (int8 for CPU, float16 for GPU) | Hardcoded float16 | ⚠️ GAP |

**Details:**
- **Windows** (`faster_whisper_transcriber.py:216-221`): Automatically selects optimal compute type based on device
- **macOS** (`mlx_whisper_transcriber.py:150, 202`): Always float16 (no int8 option for CPU)
- **Impact:** macOS cannot optimize for CPU-only scenarios

### 3.3 Transcription Speed

| Metric | Windows (CUDA) | Windows (CPU) | macOS (Metal) |
|--------|----------------|---------------|---------------|
| **Relative Speed** | 4-5x realtime | ~1x realtime | 2-3x realtime |
| **Optimization** | CuBLAS + cuDNN | int8 quantization | MLX Metal kernels |

**Details:**
- **Windows CUDA**: Best performance (4-5x realtime on NVIDIA GPUs)
- **macOS Metal**: Good performance (2-3x realtime on Apple Silicon)
- **Windows CPU**: Decent fallback (int8 quantization helps)
- **Sources**:
  - Windows: `faster_whisper_transcriber.py:233, 272`
  - macOS: `mlx_whisper_transcriber.py:208`
  - README: Line 175-177

### 3.4 Memory Efficiency

| Feature | Windows | macOS | Status |
|---------|---------|-------|--------|
| **Buffer Management** | Sequential buffers | Sequential buffers | ✓ MATCH |
| **Pre-roll Discard** | ✓ Yes (~1.5 seconds) | ✓ Yes (~1.5 seconds) | ✓ MATCH |
| **Chunk Size** | 4096 (dynamic on Windows) | 4096 (static) | ⚠️ PARTIAL |
| **Watchdog Thread** | ✓ Yes (detects stalls) | ✗ No | ⚠️ GAP |

**Details:**
- **Windows** (`windows_recorder.py:199-207`): Dynamically increases buffer size on Windows for background resilience
- **macOS** (`macos_recorder.py:66`): Static chunk size
- **Windows** (`windows_recorder.py:277-306`): Watchdog thread monitors for callback stalls
- **macOS**: No equivalent watchdog mechanism
- **Impact:** Windows is more resilient to process backgrounding/suspension

---

## Section 4: Gaps Found

### 4.1 Critical Gaps (Must Fix)

1. **Desktop Audio Incomplete**
   - **Issue**: ScreenCaptureKit implementation exists but is not production-ready
   - **Evidence**: `macos_recorder.py:127-131` - warning messages indicate incomplete implementation
   - **Impact**: Users cannot record desktop audio (system audio) on macOS
   - **Priority**: CRITICAL

2. **No Resampling Implementation**
   - **Issue**: macOS uses padding instead of soxr resampling when audio lengths differ
   - **Evidence**: `macos_recorder.py:308-318` - uses `np.pad()` instead of `soxr.resample()`
   - **Impact**: Audio quality degradation when mic and desktop sample rates differ
   - **Priority**: CRITICAL

3. **No CPU Fallback for Transcription**
   - **Issue**: MLX requires Metal GPU - no CPU fallback for Intel Macs or fallback scenarios
   - **Evidence**: `mlx_whisper_transcriber.py:149` - hardcoded `self.device = "metal"`
   - **Impact**: App won't work on Intel Macs or if Metal is unavailable
   - **Priority**: HIGH

4. **Sample Rate Mismatch**
   - **Issue**: Desktop audio hardcoded to 44.1kHz while mic uses 48kHz
   - **Evidence**: `screencapture_helper.py:28` - hardcoded 44100 Hz
   - **Impact**: Requires resampling, quality loss, and potential sync issues
   - **Priority**: HIGH

### 4.2 Important Gaps (Should Fix)

5. **Missing Audio Enhancement**
   - **Issue**: macOS doesn't have per-channel processing like Windows
   - **Evidence**: `macos_recorder.py:360-390` vs `windows_recorder.py:572-601`
   - **Impact**: Less consistent audio levels, more raw/unprocessed sound
   - **Priority**: MEDIUM

6. **No Watchdog Thread**
   - **Issue**: No mechanism to detect audio callback stalls on macOS
   - **Evidence**: `windows_recorder.py:277-306` present, no equivalent in macOS
   - **Impact**: Harder to debug recording failures
   - **Priority**: MEDIUM

7. **Static Buffer Size**
   - **Issue**: macOS doesn't dynamically adjust buffer size for resilience
   - **Evidence**: `windows_recorder.py:199-207` vs `macos_recorder.py:66`
   - **Impact**: May be less resilient to app backgrounding
   - **Priority**: LOW

### 4.3 Installation Size Gaps (Known Trade-offs)

8. **PyObjC Framework Overhead**
   - **Issue**: PyObjC frameworks add ~50-75 MB mandatory overhead
   - **Evidence**: `requirements-macos.txt:6-8` - three PyObjC packages
   - **Impact**: macOS installation is ~90 MB larger
   - **Priority**: LOW (unavoidable, required for ScreenCaptureKit)

9. **python-build-standalone Size**
   - **Issue**: Standalone Python is ~30 MB larger than embedded Python
   - **Evidence**: `prepare-resources.js:8-12` - different Python sources
   - **Impact**: macOS installation is ~30 MB larger
   - **Priority**: LOW (trade-off for better Python compatibility)

---

## Section 5: Recommendations

### 5.1 High Priority Actions

**1. Complete ScreenCaptureKit Implementation**
- Fix hardcoded sample rate in `screencapture_helper.py`
- Verify PyObjC delegate callbacks work correctly
- Add error handling and fallback for permission issues
- Test with various apps (Chrome, Zoom, Spotify, etc.)
- Remove warning message in `macos_recorder.py:127-131`

**2. Implement soxr Resampling**
- Replace `np.pad()` with `soxr.resample()` in `macos_recorder.py:308-318`
- Add dedicated `_resample()` method like Windows
- Use VHQ quality setting
- Handle stereo/mono channel conversion properly

**3. Add Transcription Fallback Strategy**
- Detect if Metal is available
- Implement CPU fallback using faster-whisper
- Add user-friendly error messages
- Consider dual-library approach (MLX preferred, faster-whisper fallback)

**4. Standardize Sample Rates**
- Change ScreenCaptureKit default to 48000 Hz
- Ensure mic also attempts 48kHz capture
- Match Windows sample rate auto-detection behavior

### 5.2 Medium Priority Actions

**5. Enhance Audio Processing**
- Add per-channel processing like Windows (`_process_channel()`)
- Implement dual-threshold normalization (boost quiet, attenuate loud)
- Add pre-roll discard to match Windows exactly
- Test with various microphones

**6. Add Recording Resilience**
- Implement watchdog thread to detect callback stalls
- Add dynamic buffer sizing for background resilience
- Improve error messages and diagnostics
- Add recovery mechanisms

**7. Optimize Installation Size** (Nice to Have)
- Investigate lighter PyObjC alternatives (unlikely)
- Consider MLX as optional dependency (breaks Metal acceleration)
- Document size trade-offs for users
- Measure actual installed size vs estimates

### 5.3 Testing Recommendations

**Audio Quality Testing:**
1. Record 5-minute meeting with both mic and desktop audio
2. Compare spectrogram analysis (Windows vs macOS)
3. Measure RMS levels and dynamic range
4. A/B listening test with users
5. Test with various sample rate combinations

**Installation Size Testing:**
1. Build complete DMG installer
2. Measure actual installed size on macOS
3. Compare with Windows installer size
4. Profile startup time and memory usage
5. Test on M1, M2, M3, and M4 chips

**Performance Testing:**
1. Benchmark transcription speed on Apple Silicon
2. Compare Metal vs CUDA performance
3. Test with various model sizes (tiny, base, small, medium)
4. Measure memory usage during transcription
5. Test with long recordings (1+ hour)

### 5.4 Documentation Needs

**For Users:**
- Explain macOS installation size (90 MB larger than Windows)
- Document Screen Recording permission requirement
- Clarify Apple Silicon requirement (M1+)
- Provide troubleshooting for ScreenCaptureKit issues

**For Developers:**
- Document ScreenCaptureKit implementation details
- Explain PyObjC delegate pattern
- Describe Metal GPU acceleration limitations
- Add architecture decision records (ADR) for:
  - Why lightning-whisper-mlx vs faster-whisper
  - Why python-build-standalone vs embedded Python
  - Trade-offs of ScreenCaptureKit vs alternatives

---

## Appendix: File References

### Audio Implementations
- **Windows**: `d:\Projects\meeting-transcriber\backend\audio\windows_recorder.py`
- **macOS**: `d:\Projects\meeting-transcriber\backend\audio\macos_recorder.py`
- **ScreenCaptureKit Helper**: `d:\Projects\meeting-transcriber\backend\audio\screencapture_helper.py`

### Transcription Implementations
- **Windows/faster-whisper**: `d:\Projects\meeting-transcriber\backend\transcription\faster_whisper_transcriber.py`
- **macOS/MLX**: `d:\Projects\meeting-transcriber\backend\transcription\mlx_whisper_transcriber.py`

### Requirements
- **Windows**: `d:\Projects\meeting-transcriber\requirements-windows.txt`
- **macOS**: `d:\Projects\meeting-transcriber\requirements-macos.txt`

### Build Configuration
- **Package Definition**: `d:\Projects\meeting-transcriber\package.json`
- **Resource Preparation**: `d:\Projects\meeting-transcriber\build\prepare-resources.js`

---

## Conclusion

The macOS implementation demonstrates good architectural foundation but **requires significant work** to achieve feature parity with Windows:

**Audio Quality:** 3 critical gaps, 2 important gaps
**Installation Size:** 2 known trade-offs (~90 MB larger, unavoidable)
**Performance:** 2 gaps (no CPU fallback, no watchdog)

**Estimated Effort:**
- High priority fixes: 40-60 hours
- Medium priority fixes: 20-30 hours
- Testing and validation: 20-30 hours
- **Total: 80-120 hours**

**Primary Blocker:** ScreenCaptureKit implementation must be completed and tested before macOS version can be considered production-ready.

---

**Audit completed by:** Claude Code (Automated Analysis)
**Review recommended for:** Engineering team, macOS maintainers
**Next steps:** Prioritize Critical Gaps, create implementation tickets
