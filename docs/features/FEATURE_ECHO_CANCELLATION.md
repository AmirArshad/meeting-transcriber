# Feature: Acoustic Echo Cancellation (AEC)

## Status: Planned (Future Enhancement)

## Overview

When desktop audio is playing (e.g., another meeting participant speaking), the microphone picks up this audio from the speakers, creating an echo effect in the final recording. Acoustic Echo Cancellation (AEC) removes this echo by subtracting the known "reference" signal (desktop audio) from the microphone input.

## The Problem

Currently, when recording a meeting:
1. Desktop audio plays through speakers (the other person talking)
2. Microphone picks up your voice + echo of desktop audio
3. Final mix contains both sources, so the desktop audio appears twice (original + echo)

This results in a noticeable echo/reverb effect, especially in quiet rooms or with louder speaker volumes.

## Technical Challenges

### Current Architecture: Post-Processing

Our current approach mixes audio **after** recording completes (post-processing). This creates a fundamental challenge for AEC:

- AEC algorithms require **real-time, frame-synchronized** processing
- The algorithm needs both streams simultaneously to cancel echo
- By post-processing time, we've lost the precise timing relationship needed

### AEC Requirements

True echo cancellation needs:
1. **Frame-synchronized streams** - Mic and desktop audio aligned sample-by-sample
2. **Real-time processing** - AEC applied during capture, not after
3. **Reference signal** - The exact audio being played to speakers
4. **Adaptive filter** - Adjusts to room acoustics in real-time

## Available Python Libraries

### 1. speexdsp-python (Most Mature)

**Repository:** https://github.com/xiongyihui/speexdsp-python

Python bindings for Speex DSP's acoustic echo cancellation.

```python
from speexdsp import EchoCanceller

# Frame size, filter length, sample rate
echo_canceller = EchoCanceller.create(256, 2048, 16000)

# Process requires synchronized frames
in_data = mic_audio.readframes(256)    # Near-end (mic with echo)
out_data = speaker_audio.readframes(256)  # Far-end (reference)
cleaned = echo_canceller.process(in_data, out_data)
```

**Requirements:**
- Mono 16kHz audio
- Linux: `sudo apt install libspeexdsp-dev`
- Windows/macOS: Requires building from source

**Limitations:**
- Designed for real-time processing
- Requires precise frame synchronization

### 2. pyaec (Newer, Cross-Platform)

**Repository:** https://github.com/thewh1teagle/aec-rs
**PyPI:** https://pypi.org/project/pyaec/

Rust-based AEC with Python bindings. Cross-platform binaries available.

```bash
pip install pyaec
```

**Platforms:**
- Windows (ARM64, x86-64)
- macOS (10.12+ x86-64, 11.0+ ARM64)
- Linux (manylinux with glibc 2.17+)

**Note:** Documentation is sparse; requires experimentation.

### 3. Adaptive Filter Implementations

**Repository:** https://github.com/Keyvanhardani/Python-Acoustic-Echo-Cancellation-Library

Pure Python implementation of adaptive filters:
- LMS (Least Mean Squares)
- NLMS (Normalized LMS) - Faster convergence
- RLS (Recursive Least Squares) - Best quality, highest CPU

These are educational implementations; may not be production-ready.

## Implementation Options

### Option 1: Real-Time AEC (Major Refactor)

**Effort:** High (2-3 weeks)

Restructure recording to process audio in real-time:

```
┌─────────────────────────────────────────────────────────┐
│                  Real-Time Processing                    │
├─────────────────────────────────────────────────────────┤
│                                                          │
│   Mic Input ──────┐                                      │
│                   ├──► AEC ──► Enhanced Mic ──► Mix ──► │
│   Desktop Audio ──┘      │                               │
│        │                 │                               │
│        └─────────────────┘ (reference signal)            │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Changes Required:**
1. Move from callback-based capture to streaming capture
2. Implement frame synchronization between streams
3. Process audio in small chunks (256-512 samples)
4. Buffer management for latency handling
5. Handle sample rate conversion in real-time

**Pros:**
- True echo cancellation
- Best audio quality
- Standard approach used by Zoom, Teams, etc.

**Cons:**
- Major architectural change
- Higher CPU usage during recording
- More complex error handling
- Risk of introducing audio glitches

### Option 2: Post-Processing Spectral Subtraction (Simpler)

**Effort:** Medium (1 week)

Apply frequency-domain echo reduction after recording:

```python
def reduce_echo_spectral(mic_audio, desktop_audio, alpha=0.5):
    """
    Simple spectral subtraction for echo reduction.
    Less effective than real AEC but works in post-processing.
    """
    # FFT both signals
    mic_fft = np.fft.rfft(mic_audio)
    desktop_fft = np.fft.rfft(desktop_audio)

    # Reduce frequencies present in both signals
    mask = np.abs(desktop_fft) / (np.abs(mic_fft) + 1e-10)
    mask = np.clip(1 - alpha * mask, 0, 1)

    # Apply mask and inverse FFT
    cleaned_fft = mic_fft * mask
    return np.fft.irfft(cleaned_fft)
```

**Pros:**
- Works with current post-processing architecture
- No real-time constraints
- Simpler implementation

**Cons:**
- Less effective than true AEC
- May reduce voice quality
- Artifacts possible (musical noise)
- Doesn't handle room reverb well

### Option 3: Headphone Recommendation (Zero Effort)

**Effort:** None

Simply recommend users wear headphones during recording.

**Pros:**
- Eliminates echo at source
- No code changes needed
- Best audio quality

**Cons:**
- Not always practical
- Relies on user compliance

## Recommendation

For the near term, **Option 3** (headphone recommendation) is the most practical solution. Add a tip to the UI or documentation.

For a future version, **Option 1** (real-time AEC) would provide the best user experience but requires significant architectural changes. This should be planned as a major feature release.

**Option 2** (spectral subtraction) could be a middle-ground experiment, but the quality tradeoffs may not be worth it.

## Implementation Priority

| Priority | Approach | Effort | Quality |
|----------|----------|--------|---------|
| Now | Recommend headphones | None | Best |
| Future | Real-time AEC with speexdsp/pyaec | High | Excellent |
| Maybe | Post-processing spectral subtraction | Medium | Fair |

## References

- [speexdsp-python](https://github.com/xiongyihui/speexdsp-python)
- [pyaec on PyPI](https://pypi.org/project/pyaec/)
- [aec-rs (pyaec backend)](https://github.com/thewh1teagle/aec-rs)
- [Python AEC Library](https://github.com/Keyvanhardani/Python-Acoustic-Echo-Cancellation-Library)
- [WebRTC AEC](https://webrtc.googlesource.com/src/+/refs/heads/main/modules/audio_processing/)

---

**Last Updated:** December 7, 2025
