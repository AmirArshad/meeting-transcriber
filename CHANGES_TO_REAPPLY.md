# Changes to Reapply on feature/macos-support Branch

This document contains all the changes that were made on master and need to be reapplied to the feature/macos-support branch.

## Commit to Revert
- **Commit**: 7219294 "Add support for 8 channel audio devices and cleaup docs"
- **Branch**: master
- **Target Branch**: feature/macos-support

## Summary of Changes

### 1. Bluetooth/Multi-Channel Audio Support Fix
**Problem**: Bluetooth headsets and 8-channel devices had distorted "bassy monster movie" audio due to sample rate mismatches and synchronization issues.

**Solution**: Implemented comprehensive sample rate detection, channel downmixing, and time-based synchronization.

---

## Files Modified

### backend/audio_recorder.py

#### Change 1: Add preroll_seconds parameter
**Location**: Line 38-48 (\_\_init\_\_ method signature)

**Add new parameter**:
```python
def __init__(
    self,
    mic_device_id: int,
    loopback_device_id: int,
    output_path: str,
    sample_rate: int = 48000,
    channels: int = 2,
    chunk_size: int = 4096,
    mic_volume: float = 1.0,
    desktop_volume: float = 1.0,
    preroll_seconds: float = None  # None = use default 1.5s, 0 = no preroll (for production with countdown)
):
```

#### Change 2: Add sample rate probing method
**Location**: After line 128 (after \_\_init\_\_, before \_mic_callback)

**Add entire method**:
```python
def _probe_loopback_sample_rate(self, device_id, device_info):
    """
    Probe loopback device to find actual working sample rate.

    COMPATIBILITY FIX: Bluetooth headsets and some other devices may report
    a default sample rate that doesn't match their actual operating rate.
    This causes severe pitch distortion (slow, bassy "monster movie" sound).

    This method tries common sample rates in priority order to find one that works:
    1. Reported default rate
    2. Common high-quality rates (48000, 44100)
    3. Common Bluetooth headset rates (32000, 16000, 8000)

    Args:
        device_id: PyAudio device index
        device_info: Device info dict from PyAudio

    Returns:
        (working_rate, channels) tuple

    Raises:
        RuntimeError: If no working sample rate is found
    """
    default_rate = int(device_info['defaultSampleRate'])
    channels = int(device_info['maxInputChannels'])

    # Priority order: default first, then high quality, then Bluetooth rates
    rates_to_try = [default_rate]

    # Add standard rates if not already in list
    for rate in [48000, 44100, 32000, 16000, 8000]:
        if rate != default_rate and rate not in rates_to_try:
            rates_to_try.append(rate)

    print(f"Probing loopback device sample rates...", file=sys.stderr)
    print(f"  Device: {device_info.get('name', 'Unknown')}", file=sys.stderr)
    if channels > 2:
        print(f"  Device has {channels} channels (surround sound), will downmix to stereo after recording", file=sys.stderr)
    print(f"  Trying rates: {rates_to_try}", file=sys.stderr)

    for rate in rates_to_try:
        try:
            # Attempt to open stream with this rate
            print(f"  Testing {rate} Hz...", end=' ', file=sys.stderr)
            test_stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                input=True,
                input_device_index=device_id,
                frames_per_buffer=1024
            )

            # If successful, close and return this rate
            test_stream.close()
            print(f"✓ Success!", file=sys.stderr)
            print(f"✓ Loopback device will use {rate} Hz, {channels} channel(s)", file=sys.stderr)
            return (rate, channels)

        except Exception as e:
            print(f"✗ Failed: {str(e)[:50]}", file=sys.stderr)
            continue

    # All rates failed
    raise RuntimeError(
        f"Could not find working sample rate for loopback device {device_id}.\n"
        f"Tried rates: {rates_to_try}\n"
        f"Device: {device_info.get('name', 'Unknown')}\n\n"
        f"Suggestions:\n"
        f"  1. Try selecting a different desktop audio device\n"
        f"  2. Check that the device is not in use by another application\n"
        f"  3. If using Bluetooth, ensure headset is in stereo mode (not headset/hands-free mode)\n"
        f"  4. Restart the audio device or reconnect Bluetooth"
    )
```

#### Change 3: Update loopback initialization to use probing
**Location**: Lines 81-108 (in \_\_init\_\_, loopback device initialization)

**Replace**:
```python
if loopback_device_id >= 0:
    loopback_info = self.pa.get_device_info_by_index(loopback_device_id)
    self.loopback_sample_rate = int(loopback_info['defaultSampleRate'])
    self.loopback_channels = int(loopback_info['maxInputChannels'])
    self.mixing_mode = True
```

**With**:
```python
if loopback_device_id >= 0:
    loopback_info = self.pa.get_device_info_by_index(loopback_device_id)

    # COMPATIBILITY FIX: Probe actual working sample rate instead of trusting default
    # This prevents distorted audio on Bluetooth headsets and other devices
    # where reported rate doesn't match actual operating rate
    print(f"", file=sys.stderr)
    print(f"Initializing loopback device...", file=sys.stderr)
    try:
        self.loopback_sample_rate, self.loopback_channels = self._probe_loopback_sample_rate(
            loopback_device_id,
            loopback_info
        )
    except RuntimeError as e:
        # If probing fails completely, fall back to default but warn user
        print(f"", file=sys.stderr)
        print(f"⚠️  WARNING: Sample rate probing failed!", file=sys.stderr)
        print(f"⚠️  Using default rate - audio may be distorted", file=sys.stderr)
        print(f"⚠️  Error: {e}", file=sys.stderr)
        print(f"", file=sys.stderr)
        self.loopback_sample_rate = int(loopback_info['defaultSampleRate'])
        self.loopback_channels = int(loopback_info['maxInputChannels'])

    self.mixing_mode = True
```

#### Change 4: Replace frame-based preroll with time-based preroll
**Location**: Lines 122-145 (preroll tracking section in \_\_init\_\_)

**Replace entire section**:
```python
# Pre-roll tracking (discard first ~1.5 seconds for device warm-up)
# PRODUCTION FIX: In the real app, the 3-second countdown handles warm-up
# so we can skip preroll entirely. For direct API usage (tests), we still need it.
self.preroll_seconds = 1.5 if preroll_seconds is None else preroll_seconds

if self.preroll_seconds > 0:
    self.preroll_frames_mic = int(self.preroll_seconds * self.mic_sample_rate / self.chunk_size)
    # SYNCHRONIZATION FIX: Both streams must skip the SAME amount of TIME
    # Even though multi-channel devices have delayed first callbacks,
    # we can't skip less frames or they'll be out of sync
    # Instead, we accept that we might trim a bit of the start
    if self.mixing_mode and self.loopback_sample_rate > 0:
        # Calculate desktop preroll to match SAME time duration as mic
        self.preroll_frames_desktop = int(self.preroll_seconds * self.loopback_sample_rate / self.chunk_size)
    else:
        self.preroll_frames_desktop = 0
else:
    # No preroll - countdown in production app handles this (RECOMMENDED)
    self.preroll_frames_mic = 0
    self.preroll_frames_desktop = 0

self.mic_frame_count = 0
self.desktop_frame_count = 0

# Time-based synchronization (more reliable than frame counts)
self.recording_start_time = None  # Set when recording actually starts
```

#### Change 5: Update mic callback to use time-based preroll
**Location**: Lines 251-267 (in _mic_callback method)

**Replace**:
```python
if self.is_recording:
    with self.lock:
        self.mic_frame_count += 1
        # Skip pre-roll frames (first ~1.5 seconds) to avoid device warm-up artifacts
        if self.mic_frame_count > self.preroll_frames_mic:
            self.mic_frames.append(in_data)
```

**With**:
```python
if self.is_recording:
    with self.lock:
        self.mic_frame_count += 1

        # TIME-BASED SYNCHRONIZATION: Use wall-clock time instead of frame counts
        # This ensures both streams skip the same real-world time duration
        if self.recording_start_time is None:
            self.recording_start_time = time.time()

        elapsed = time.time() - self.recording_start_time

        # Skip pre-roll based on TIME, not frame counts
        if elapsed >= self.preroll_seconds:
            self.mic_frames.append(in_data)
```

#### Change 6: Update desktop callback to use time-based preroll
**Location**: Lines 289-305 (in _desktop_callback method)

**Replace**:
```python
if self.is_recording:
    with self.lock:
        self.desktop_frame_count += 1
        # Skip pre-roll frames (first ~1.5 seconds) to avoid device warm-up artifacts
        if self.desktop_frame_count > self.preroll_frames:
            self.desktop_frames.append(in_data)
```

**With**:
```python
if self.is_recording:
    with self.lock:
        self.desktop_frame_count += 1

        # TIME-BASED SYNCHRONIZATION: Use wall-clock time instead of frame counts
        # This ensures both streams skip the same real-world time duration
        if self.recording_start_time is None:
            self.recording_start_time = time.time()

        elapsed = time.time() - self.recording_start_time

        # Skip pre-roll based on TIME, not frame counts
        if elapsed >= self.preroll_seconds:
            self.desktop_frames.append(in_data)
```

#### Change 7: Update Windows preroll recalculation
**Location**: Lines 317-335 (Windows buffer adjustment section)

**Replace the preroll recalculation**:
```python
# CRITICAL FIX: Recalculate preroll_frames with new chunk size
if self.preroll_seconds > 0:
    self.preroll_frames_mic = int(self.preroll_seconds * self.mic_sample_rate / self.chunk_size)
    if self.mixing_mode and self.loopback_sample_rate > 0:
        # Recalculate desktop preroll - MUST match same time duration for sync
        self.preroll_frames_desktop = int(self.preroll_seconds * self.loopback_sample_rate / self.chunk_size)
    print(f"  Adjusted preroll: mic={self.preroll_frames_mic} frames, desktop={self.preroll_frames_desktop} frames", file=sys.stderr)
else:
    print(f"  Preroll disabled (using countdown)", file=sys.stderr)
```

#### Change 8: Add robust fallback to loopback stream opening
**Location**: Lines 339-432 (loopback stream opening section)

**Replace entire loopback opening block** with the version that includes re-probing and detailed error handling (see lines 340-452 in the modified file).

#### Change 9: Add debug logging to mixing
**Location**: Lines 533-543 (in _mix_and_save method)

**Add after line 539**:
```python
print(f"  Raw mic audio: {len(mic_audio)} samples ({len(mic_audio) / self.mic_sample_rate / self.mic_channels:.2f} seconds at {self.mic_sample_rate} Hz, {self.mic_channels} ch)", file=sys.stderr)
```

**Add after line 542**:
```python
print(f"  Raw desktop audio: {len(desktop_audio)} samples ({len(desktop_audio) / self.loopback_sample_rate / self.loopback_channels:.2f} seconds at {self.loopback_sample_rate} Hz, {self.loopback_channels} ch)", file=sys.stderr)
```

#### Change 10: Add multi-channel downmixing
**Location**: After line 560 (after desktop resampling, before channel conversion)

**Add entire section**:
```python
# CHANNEL FIX: Downmix multi-channel audio to stereo
if self.loopback_channels > 2:
    print(f"  Downmixing desktop audio from {self.loopback_channels} channels to stereo...", file=sys.stderr)
    # Reshape to (samples, channels)
    desktop_multichannel = desktop_audio.reshape(-1, self.loopback_channels)

    # Simple downmix: average all channels to create stereo
    # For proper 5.1/7.1 downmix, would need channel routing, but this works for most cases
    # Take first 2 channels if available (usually FL/FR), or average all
    if self.loopback_channels >= 2:
        # Use first two channels (Front Left, Front Right)
        desktop_stereo = desktop_multichannel[:, :2]
    else:
        # Fallback: average all channels to mono, then duplicate to stereo
        desktop_mono = np.mean(desktop_multichannel, axis=1, dtype=np.float32)
        desktop_stereo = np.column_stack((desktop_mono, desktop_mono))

    # Flatten back to 1D array
    desktop_audio = desktop_stereo.flatten().astype(np.int16)

# Convert mono loopback to stereo if needed (rare but possible)
elif self.loopback_channels == 1 and self.target_channels == 2:
    print(f"  Converting desktop audio from mono to stereo...", file=sys.stderr)
    desktop_audio = np.repeat(desktop_audio, 2)
```

**Remove the old mono conversion** (the original `if self.loopback_channels == 1` block).

#### Change 11: Add FileNotFoundError handling for ffmpeg
**Location**: Lines 677-729 (in _compress_audio method)

**Add new exception handler before CalledProcessError**:
```python
except FileNotFoundError:
    print(f"Warning: ffmpeg not found in PATH", file=sys.stderr)
    print(f"Falling back to WAV format (audio will be larger)...", file=sys.stderr)
    # If ffmpeg is not installed, just copy the temp WAV to output
    import shutil
    shutil.copy(input_path, output_path)
    return output_path
```

#### Change 12: Set preroll_seconds=0 in production mode
**Location**: Line 862-868 (in main() function, AudioRecorder instantiation)

**Add parameter**:
```python
recorder = AudioRecorder(
    mic_device_id=args.mic,
    loopback_device_id=args.loopback,
    output_path=str(output_path),
    sample_rate=48000,
    preroll_seconds=0  # Production mode: no preroll, countdown in Electron app handles device warm-up
)
```

---

### backend/test_bluetooth_headset.py (NEW FILE)
**Create entire file** with content from the committed version. This is a comprehensive test script for Bluetooth headset compatibility.

---

### docs/README.md (NEW FILE)
**Create file** with documentation index explaining the folder structure.

---

### docs/design/AUDIO_DEVICE_COMPATIBILITY_PLAN.md (NEW FILE)
**Create file** with complete technical plan for Bluetooth/multi-device audio support.

---

### docs/design/BLUETOOTH_FIX_SUMMARY.md (NEW FILE)
**Create file** with implementation summary of the Bluetooth fix.

---

### Files Moved
- `FIRST_TIME_UX_IMPROVEMENTS.md` → `docs/design/FIRST_TIME_UX_IMPROVEMENTS.md`
- `INSTALLER_PERFORMANCE_IMPROVEMENTS.md` → `docs/design/INSTALLER_PERFORMANCE_IMPROVEMENTS.md`

---

### Files Deleted
- `=0.3.0` (orphaned file)
- `=3.12.0` (orphaned file)

---

## Key Features Implemented

1. **Sample Rate Probing**: Automatically detects actual device sample rate (handles Bluetooth 8-16kHz)
2. **Multi-Channel Downmixing**: Converts 8-channel surround to stereo
3. **Time-Based Synchronization**: Ensures mic and desktop audio stay synchronized
4. **Production Mode Support**: preroll_seconds=0 leverages countdown for warm-up
5. **Robust Error Handling**: Re-probing and clear troubleshooting messages
6. **Cross-Platform**: Works on Windows, Mac, and Linux

## Testing
After reapplying changes, run:
```bash
cd backend
python test_bluetooth_headset.py
```

Select your Bluetooth headset devices and verify audio quality is normal (no distortion).
