"""
Windows Audio Recorder (v2).

Records microphone and desktop audio to separate buffers, then mixes them
after recording completes (post-processing). This avoids real-time buffer
synchronization issues that cause choppy audio.

Key features:
- Separate mic and desktop audio capture using WASAPI
- Timestamp-based gap preservation for desktop audio (WASAPI loopback only
  sends callbacks when audio is playing)
- Post-processing mix with minimal enhancement for natural sound quality
- High-quality Opus compression via ffmpeg

Module structure:
- constants.py: Configuration values
- processor.py: Audio processing (resampling, enhancement, mixing)
- compressor.py: ffmpeg compression wrapper
- timeline.py: WASAPI gap reconstruction
"""

import sys
import wave
import json
import threading
import time
import platform
from pathlib import Path
import numpy as np
import pyaudiowpatch as pyaudio

# Import from our modular components
from .constants import (
    DEFAULT_SAMPLE_RATE,
    DEFAULT_CHANNELS,
    DEFAULT_CHUNK_SIZE,
    WINDOWS_CHUNK_MULTIPLIER,
    DEFAULT_PREROLL_SECONDS,
    COMMON_SAMPLE_RATES,
    WATCHDOG_CHECK_INTERVAL,
    WATCHDOG_STALL_THRESHOLD,
    LEVEL_SUBSAMPLE_FACTOR,
    LEVEL_UPDATE_FPS,
    MIC_BOOST_LINEAR,
)
from .processor import (
    resample,
    enhance_microphone,
    downmix_to_stereo,
    mono_to_stereo,
    mix_audio,
    align_audio_lengths,
)
from .compressor import compress_to_opus
from .timeline import reconstruct_desktop_timeline

# Store final output path for meeting manager (legacy interface)
_final_output_path = None
_recording_duration = 0.0


class AudioRecorder:
    """
    Audio recorder with post-processing mix.

    Records mic and desktop simultaneously to separate buffers,
    then mixes them after recording completes. This approach
    avoids real-time buffer synchronization issues.
    """

    def __init__(
        self,
        mic_device_id: int,
        loopback_device_id: int,
        output_path: str,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        channels: int = DEFAULT_CHANNELS,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        mic_volume: float = 1.0,
        desktop_volume: float = 1.0,
        preroll_seconds: float = None  # None = use default, 0 = no preroll (for production with countdown)
    ):
        """
        Initialize the Windows audio recorder.

        Args:
            mic_device_id: PyAudio device index for microphone
            loopback_device_id: PyAudio device index for desktop audio (-1 to disable)
            output_path: Path for output audio file
            sample_rate: Target output sample rate (default: 48000)
            channels: Target output channels (default: 2 for stereo)
            chunk_size: Audio buffer size in frames (default: 4096)
            mic_volume: Microphone volume multiplier (0.0-1.0)
            desktop_volume: Desktop audio volume multiplier (0.0-1.0)
            preroll_seconds: Seconds to discard at start for device warm-up
                            (None = default 1.5s, 0 = disabled for production)
        """
        self.mic_device_id = mic_device_id
        self.loopback_device_id = loopback_device_id
        self.output_path = output_path
        self.target_sample_rate = sample_rate
        self.target_channels = channels  # Target output channels (always 2 for stereo)
        self.chunk_size = chunk_size
        self.mic_volume = mic_volume
        self.desktop_volume = desktop_volume

        self.pa = pyaudio.PyAudio()

        # Get device info and auto-detect channel counts
        mic_info = self.pa.get_device_info_by_index(mic_device_id)

        # AUDIO QUALITY FIX: Try to use high-quality mode instead of default
        # Many modern USB mics support 48kHz even if default is 16kHz
        # This avoids quality-degrading resampling
        default_rate = int(mic_info['defaultSampleRate'])

        # Try to use 48kHz if device supports it, otherwise use native rate
        # This matches Google Meet's approach
        if default_rate < 48000 and sample_rate == 48000:
            print(f"Mic default rate is {default_rate} Hz, will attempt to use {sample_rate} Hz", file=sys.stderr)
            self.mic_sample_rate = sample_rate  # Try requested rate
            self.mic_requested_higher_rate = True
        else:
            self.mic_sample_rate = default_rate
            self.mic_requested_higher_rate = False

        self.mic_channels = int(mic_info['maxInputChannels'])

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
                print(f"WARNING: Sample rate probing failed!", file=sys.stderr)
                print(f"WARNING: Using default rate - audio may be distorted", file=sys.stderr)
                print(f"WARNING: Error: {e}", file=sys.stderr)
                print(f"", file=sys.stderr)
                self.loopback_sample_rate = int(loopback_info['defaultSampleRate'])
                self.loopback_channels = int(loopback_info['maxInputChannels'])

            self.mixing_mode = True
        else:
            self.loopback_sample_rate = None
            self.loopback_channels = None
            self.mixing_mode = False

        print(f"Device configuration:", file=sys.stderr)
        print(f"  Mic: {self.mic_sample_rate} Hz, {self.mic_channels} channel(s)", file=sys.stderr)
        if self.mixing_mode:
            print(f"  Loopback: {self.loopback_sample_rate} Hz, {self.loopback_channels} channel(s)", file=sys.stderr)
        print(f"  Target output: {self.target_sample_rate} Hz, {self.target_channels} channel(s) (stereo)", file=sys.stderr)

        # Separate frame buffers
        # Mic frames: just audio data (continuous callbacks even during silence)
        # Desktop frames: (timestamp, audio_data) tuples to preserve gaps
        # WASAPI loopback only sends callbacks when audio is playing, so we need
        # timestamps to reconstruct the timeline with proper silence gaps
        self.mic_frames = []
        self.desktop_frames = []  # List of (timestamp, audio_data) tuples
        self.is_recording = False
        self.lock = threading.Lock()

        # Pre-roll: discard first N seconds for device warm-up
        # In production, the 3-second countdown handles warm-up, so preroll can be 0
        # NOTE: Preroll is time-based (checked in callbacks), not frame-count based
        self.preroll_seconds = DEFAULT_PREROLL_SECONDS if preroll_seconds is None else preroll_seconds

        self.mic_frame_count = 0
        self.desktop_frame_count = 0

        # Time-based synchronization - SINGLE reference point set at recording start
        # Both streams use the same reference to ensure they stay in sync
        self.recording_start_time = None

        # Audio levels (0.0 to 1.0)
        self.mic_level = 0.0
        self.desktop_level = 0.0

        # Streams
        self.mic_stream = None
        self.desktop_stream = None

        # Callback watchdog to detect audio stream stalls
        self.last_callback_time = 0
        self.callback_watchdog = None
        self.watchdog_running = False
        self.watchdog_warning_shown = False

        # Platform detection (already imported at module level)
        self.is_windows = platform.system() == 'Windows'

        # Store original chunk size before any modifications
        self.original_chunk_size = chunk_size

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

        # Priority order: default first, then common rates from constants
        rates_to_try = [default_rate]
        for rate in COMMON_SAMPLE_RATES:
            if rate != default_rate and rate not in rates_to_try:
                rates_to_try.append(rate)

        print(f"Probing loopback device sample rates...", file=sys.stderr)
        print(f"  Device: {device_info.get('name', 'Unknown')}", file=sys.stderr)
        if channels > 2:
            print(f"  Device has {channels} channels (surround sound), will downmix to stereo after recording", file=sys.stderr)
        print(f"  Trying rates: {rates_to_try}", file=sys.stderr)

        for rate in rates_to_try:
            test_stream = None
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
                print(f"Success!", file=sys.stderr)
                print(f"  Loopback device will use {rate} Hz, {channels} channel(s)", file=sys.stderr)
                return (rate, channels)

            except Exception as e:
                print(f"Failed: {str(e)[:50]}", file=sys.stderr)
                continue
            finally:
                # Always close the stream if it was opened (prevents resource leak)
                if test_stream is not None:
                    try:
                        test_stream.close()
                    except Exception:
                        pass  # Ignore errors during cleanup

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

    def _mic_callback(self, in_data, frame_count, time_info, status):
        """Callback for microphone."""
        # FIX 6: Update watchdog timestamp
        self.last_callback_time = time.time()

        if status:
            print(f"Mic status: {status}", file=sys.stderr)

        if self.is_recording:
            with self.lock:
                self.mic_frame_count += 1
                current_time = time.time()

                # DEBUG: Track first callback time
                if self.mic_first_callback_time is None:
                    self.mic_first_callback_time = current_time
                    print(f"DEBUG MIC: First callback at {current_time - self.recording_start_time:.4f}s after recording start", file=sys.stderr)

                # TIME-BASED SYNCHRONIZATION: Use shared reference set at recording start
                # Both streams use the same recording_start_time (set in start_recording)
                # This ensures they skip the same wall-clock period and stay in sync
                elapsed = current_time - self.recording_start_time

                # Skip pre-roll based on TIME, not frame counts
                if elapsed >= self.preroll_seconds:
                    # DEBUG: Track first capture time
                    if self.mic_first_capture_time is None:
                        self.mic_first_capture_time = current_time
                        print(f"DEBUG MIC: First CAPTURE at {elapsed:.4f}s elapsed (preroll={self.preroll_seconds}s)", file=sys.stderr)
                    self.mic_frames.append(in_data)

                # Calculate level for visualization (subsampled for performance)
                try:
                    data = np.frombuffer(in_data, dtype=np.int16)
                    peak = np.abs(data[::LEVEL_SUBSAMPLE_FACTOR]).max() if len(data) > 0 else 0
                    self.mic_level = float(peak) / 32768.0
                except Exception:
                    self.mic_level = 0.0

        return (in_data, pyaudio.paContinue)

    def _desktop_callback(self, in_data, frame_count, time_info, status):
        """Callback for desktop audio."""
        # Update watchdog timestamp
        self.last_callback_time = time.time()

        if status:
            print(f"Desktop status: {status}", file=sys.stderr)

        if self.is_recording:
            with self.lock:
                self.desktop_frame_count += 1
                current_time = time.time()

                # DEBUG: Track first callback time
                if self.desktop_first_callback_time is None:
                    self.desktop_first_callback_time = current_time
                    print(f"DEBUG DESKTOP: First callback at {current_time - self.recording_start_time:.4f}s after recording start", file=sys.stderr)

                # TIME-BASED SYNCHRONIZATION: Use shared reference set at recording start
                # Both streams use the same recording_start_time (set in start_recording)
                # This ensures they skip the same wall-clock period and stay in sync
                elapsed = current_time - self.recording_start_time

                # Skip pre-roll based on TIME, not frame counts
                if elapsed >= self.preroll_seconds:
                    # DEBUG: Track first capture time
                    if self.desktop_first_capture_time is None:
                        self.desktop_first_capture_time = current_time
                        print(f"DEBUG DESKTOP: First CAPTURE at {elapsed:.4f}s elapsed (preroll={self.preroll_seconds}s)", file=sys.stderr)
                    # Store timestamp with audio data to preserve gaps
                    # WASAPI loopback only sends callbacks when audio is playing
                    # We need timestamps to reconstruct timeline with proper silence
                    self.desktop_frames.append((current_time, in_data))

                # Calculate level for visualization (subsampled for performance)
                try:
                    data = np.frombuffer(in_data, dtype=np.int16)
                    peak = np.abs(data[::LEVEL_SUBSAMPLE_FACTOR]).max() if len(data) > 0 else 0
                    self.desktop_level = float(peak) / 32768.0
                except Exception:
                    self.desktop_level = 0.0

        return (in_data, pyaudio.paContinue)

    def start_recording(self):
        """Start recording from both sources."""
        print("Starting recording...", file=sys.stderr)

        # Reset buffers and counters
        self.mic_frames = []
        self.desktop_frames = []
        self.mic_frame_count = 0
        self.desktop_frame_count = 0
        self.is_recording = True
        self.watchdog_warning_shown = False  # Reset warning flag

        # Increase chunk size on Windows for better resilience to backgrounding
        # Larger buffers = more tolerance for process scheduling delays
        if self.is_windows:
            self.chunk_size = self.original_chunk_size * WINDOWS_CHUNK_MULTIPLIER
            print(f"Windows: Using {self.chunk_size} frame buffer for background resilience", file=sys.stderr)
            if self.preroll_seconds > 0:
                print(f"  Preroll: {self.preroll_seconds}s (time-based)", file=sys.stderr)
            else:
                print(f"  Preroll disabled (production mode)", file=sys.stderr)

        # Set recording start time BEFORE starting streams
        # This is the single reference point for both streams' preroll timing
        # Setting it here (not in callbacks) ensures both streams use the SAME reference
        self.recording_start_time = time.time()

        # DEBUG: Track first capture times to verify synchronization
        self.mic_first_capture_time = None
        self.desktop_first_capture_time = None
        self.mic_first_callback_time = None
        self.desktop_first_callback_time = None

        # NOTE: Thread priority boost removed - it only affects main thread, not audio callbacks
        # PyAudio's internal callback threads cannot be easily accessed from Python

        # Open mic stream with error handling
        # AUDIO QUALITY FIX: Try requested sample rate first, fall back to default if unsupported
        try:
            self.mic_stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=self.mic_channels,
                rate=self.mic_sample_rate,  # Try higher quality rate
                input=True,
                input_device_index=self.mic_device_id,
                frames_per_buffer=self.chunk_size,
                stream_callback=self._mic_callback
            )
            print(f"✓ Microphone stream opened at {self.mic_sample_rate} Hz", file=sys.stderr)
        except Exception as e:
            # If higher rate failed, try falling back to device default
            if self.mic_requested_higher_rate:
                print(f"  Warning: {self.mic_sample_rate} Hz not supported, trying device default...", file=sys.stderr)
                mic_info = self.pa.get_device_info_by_index(self.mic_device_id)
                self.mic_sample_rate = int(mic_info['defaultSampleRate'])
                try:
                    self.mic_stream = self.pa.open(
                        format=pyaudio.paInt16,
                        channels=self.mic_channels,
                        rate=self.mic_sample_rate,
                        input=True,
                        input_device_index=self.mic_device_id,
                        frames_per_buffer=self.chunk_size,
                        stream_callback=self._mic_callback
                    )
                    print(f"✓ Microphone stream opened at {self.mic_sample_rate} Hz (fallback)", file=sys.stderr)
                except Exception as e2:
                    raise RuntimeError(f"Failed to open microphone stream: {e2}")
            else:
                raise RuntimeError(f"Failed to open microphone stream (device {self.mic_device_id}): {e}")

        if self.mixing_mode:
            # Open desktop stream with error handling
            try:
                self.desktop_stream = self.pa.open(
                    format=pyaudio.paInt16,
                    channels=self.loopback_channels,  # Use detected channel count
                    rate=self.loopback_sample_rate,
                    input=True,
                    input_device_index=self.loopback_device_id,
                    frames_per_buffer=self.chunk_size,
                    stream_callback=self._desktop_callback
                )
                print(f"✓ Desktop audio stream opened successfully", file=sys.stderr)
            except Exception as e:
                # Close mic stream if desktop fails
                if self.mic_stream:
                    self.mic_stream.stop_stream()
                    self.mic_stream.close()
                    self.mic_stream = None
                raise RuntimeError(f"Failed to open desktop audio stream (device {self.loopback_device_id}): {e}")

        # Start streams
        try:
            self.mic_stream.start_stream()
            if self.desktop_stream:
                self.desktop_stream.start_stream()
        except Exception as e:
            self.cleanup()
            raise RuntimeError(f"Failed to start audio streams: {e}")

        # Start watchdog thread to detect callback stalls
        def watchdog():
            """Monitor audio callback health and warn if stalled."""
            self.watchdog_running = True
            self.last_callback_time = time.time()

            while self.is_recording and self.watchdog_running:
                time.sleep(WATCHDOG_CHECK_INTERVAL)

                if self.is_recording:
                    elapsed = time.time() - self.last_callback_time

                    # Warn if no callback for too long (only once to avoid spam)
                    if elapsed > WATCHDOG_STALL_THRESHOLD and not self.watchdog_warning_shown:
                        print(f"", file=sys.stderr)
                        print(f"=" * 70, file=sys.stderr)
                        print(f"ERROR: Audio callback stalled!", file=sys.stderr)
                        print(f"  No audio callback received for {elapsed:.1f} seconds", file=sys.stderr)
                        print(f"  This may indicate the process was suspended by Windows", file=sys.stderr)
                        print(f"  when the app was sent to the background.", file=sys.stderr)
                        print(f"", file=sys.stderr)
                        print(f"  Recording may have failed. Audio data might be incomplete.", file=sys.stderr)
                        print(f"=" * 70, file=sys.stderr)
                        print(f"", file=sys.stderr)
                        self.watchdog_warning_shown = True  # Only warn once
                        # Don't stop recording - let user decide

        self.callback_watchdog = threading.Thread(target=watchdog, daemon=True)
        self.callback_watchdog.start()

        print("Recording started!", file=sys.stderr)

    def stop_recording(self):
        """Stop recording and mix the audio."""
        print("Stopping recording...", file=sys.stderr)
        self.is_recording = False

        # FIX 6: Stop watchdog thread
        self.watchdog_running = False
        if self.callback_watchdog:
            # Give it a moment to finish
            self.callback_watchdog.join(timeout=1.0)

        # Stop streams
        if self.mic_stream:
            self.mic_stream.stop_stream()
            self.mic_stream.close()
            self.mic_stream = None

        if self.desktop_stream:
            self.desktop_stream.stop_stream()
            self.desktop_stream.close()
            self.desktop_stream = None

        print(f"Streams stopped", file=sys.stderr)
        print(f"  Mic frames: {len(self.mic_frames)}", file=sys.stderr)
        print(f"  Desktop frames: {len(self.desktop_frames)}", file=sys.stderr)

        # DEBUG: Print timing diagnostics
        print(f"", file=sys.stderr)
        print(f"=" * 60, file=sys.stderr)
        print(f"DEBUG: TIMING DIAGNOSTICS", file=sys.stderr)
        print(f"=" * 60, file=sys.stderr)
        print(f"  Recording start time: {self.recording_start_time}", file=sys.stderr)
        print(f"  Preroll seconds: {self.preroll_seconds}", file=sys.stderr)
        print(f"", file=sys.stderr)

        if self.mic_first_callback_time is not None:
            mic_cb_offset = self.mic_first_callback_time - self.recording_start_time
            print(f"  MIC first callback: {mic_cb_offset:.4f}s after recording start", file=sys.stderr)
        else:
            print(f"  MIC first callback: NEVER (no callbacks received!)", file=sys.stderr)

        if self.mic_first_capture_time is not None:
            mic_cap_offset = self.mic_first_capture_time - self.recording_start_time
            print(f"  MIC first capture:  {mic_cap_offset:.4f}s after recording start", file=sys.stderr)
        else:
            print(f"  MIC first capture: NEVER (preroll never elapsed or no callbacks)", file=sys.stderr)

        print(f"", file=sys.stderr)

        if self.desktop_first_callback_time is not None:
            desk_cb_offset = self.desktop_first_callback_time - self.recording_start_time
            print(f"  DESKTOP first callback: {desk_cb_offset:.4f}s after recording start", file=sys.stderr)
        else:
            print(f"  DESKTOP first callback: NEVER (no callbacks received!)", file=sys.stderr)

        if self.desktop_first_capture_time is not None:
            desk_cap_offset = self.desktop_first_capture_time - self.recording_start_time
            print(f"  DESKTOP first capture:  {desk_cap_offset:.4f}s after recording start", file=sys.stderr)
        else:
            print(f"  DESKTOP first capture: NEVER (preroll never elapsed or no callbacks)", file=sys.stderr)

        # KEY DIAGNOSTIC: Check if captures started at same time
        if self.mic_first_capture_time is not None and self.desktop_first_capture_time is not None:
            capture_delta = self.desktop_first_capture_time - self.mic_first_capture_time
            print(f"", file=sys.stderr)
            print(f"  CAPTURE TIME DELTA: {capture_delta:.4f}s", file=sys.stderr)
            if abs(capture_delta) > 0.1:
                print(f"  *** WARNING: Captures started {abs(capture_delta):.4f}s apart! This will cause overlap! ***", file=sys.stderr)
            else:
                print(f"  (Captures started within 100ms - timing looks OK)", file=sys.stderr)

        print(f"=" * 60, file=sys.stderr)
        print(f"", file=sys.stderr)

        # Mix and save with detailed error handling
        try:
            self._mix_and_save()
        except Exception as e:
            print(f"ERROR in audio processing: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            # Re-raise so caller knows it failed
            raise

        # Clear buffers
        self.mic_frames = []
        self.desktop_frames = []

        print("Recording stopped!", file=sys.stderr)

    def _reconstruct_desktop_timeline(self):
        """
        Reconstruct desktop audio timeline from timestamped frames.

        Delegates to the timeline module for the actual reconstruction.
        See timeline.py for implementation details.
        """
        return reconstruct_desktop_timeline(
            desktop_frames=self.desktop_frames,
            mic_frames=self.mic_frames,
            mic_first_capture_time=self.mic_first_capture_time,
            mic_sample_rate=self.mic_sample_rate,
            mic_channels=self.mic_channels,
            loopback_sample_rate=self.loopback_sample_rate,
            loopback_channels=self.loopback_channels
        )

    def _mix_and_save(self):
        """Mix the two audio sources and save to file."""
        print("Mixing audio...", file=sys.stderr)

        # Validate that we captured audio
        if len(self.mic_frames) == 0:
            raise RuntimeError(
                "No audio captured from microphone! "
                "This may be due to:\n"
                "  - Microphone permissions not granted\n"
                "  - Microphone is muted or disabled\n"
                "  - Device driver issues\n"
                "  - Wrong device selected"
            )

        print(f"  Captured {len(self.mic_frames)} mic frames", file=sys.stderr)
        if self.mixing_mode:
            print(f"  Captured {len(self.desktop_frames)} desktop frames", file=sys.stderr)

        # Convert to numpy arrays
        mic_audio = np.frombuffer(b''.join(self.mic_frames), dtype=np.int16)
        mic_duration = len(mic_audio) / self.mic_sample_rate / self.mic_channels
        print(f"  Raw mic audio: {len(mic_audio)} samples ({mic_duration:.2f} seconds at {self.mic_sample_rate} Hz, {self.mic_channels} ch)", file=sys.stderr)

        if self.mixing_mode and self.desktop_frames:
            # TIMELINE RECONSTRUCTION: Desktop frames have timestamps to preserve gaps
            # WASAPI loopback only sends callbacks when audio is playing, so we need
            # to reconstruct the full timeline with silence where there was no audio
            desktop_audio = self._reconstruct_desktop_timeline()
            desktop_duration = len(desktop_audio) / self.loopback_sample_rate / self.loopback_channels
            print(f"  Reconstructed desktop audio: {len(desktop_audio)} samples ({desktop_duration:.2f} seconds at {self.loopback_sample_rate} Hz, {self.loopback_channels} ch)", file=sys.stderr)

            # Resample both to target rate (using processor module)
            if self.mic_sample_rate != self.target_sample_rate:
                print(f"  Resampling mic: {self.mic_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                mic_audio = resample(mic_audio, self.mic_sample_rate, self.target_sample_rate)

            # CHANNEL FIX: Handle multi-channel mic (some USB mics have 4+ channels)
            if self.mic_channels > 2:
                mic_audio = downmix_to_stereo(mic_audio, self.mic_channels)
            elif self.mic_channels == 1 and self.target_channels == 2:
                print(f"  Converting mic from mono to stereo...", file=sys.stderr)
                mic_audio = mono_to_stereo(mic_audio)

            # Apply noise reduction to microphone audio only (using processor module)
            print(f"  Applying noise reduction to mic...", file=sys.stderr)
            mic_audio = enhance_microphone(mic_audio, self.target_sample_rate, self.target_channels)

            if self.loopback_sample_rate != self.target_sample_rate:
                print(f"  Resampling desktop: {self.loopback_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                desktop_audio = resample(desktop_audio, self.loopback_sample_rate, self.target_sample_rate)

            # CHANNEL FIX: Downmix multi-channel audio to stereo (using processor module)
            if self.loopback_channels > 2:
                desktop_audio = downmix_to_stereo(desktop_audio, self.loopback_channels)
            elif self.loopback_channels == 1 and self.target_channels == 2:
                print(f"  Converting desktop audio from mono to stereo...", file=sys.stderr)
                desktop_audio = mono_to_stereo(desktop_audio)

            # Align audio lengths (using processor module)
            mic_len = len(mic_audio)
            desktop_len = len(desktop_audio)

            # Safety check: ensure we have valid audio data
            if max(mic_len, desktop_len) == 0:
                raise RuntimeError(
                    "Audio alignment failed - both audio tracks are empty after resampling. "
                    "This may be due to audio buffer corruption or device issues."
                )

            print(f"  Aligning audio lengths: mic={mic_len} samples, desktop={desktop_len} samples", file=sys.stderr)
            mic_audio, desktop_audio = align_audio_lengths(mic_audio, desktop_audio)

            if len(mic_audio) != mic_len:
                print(f"  Padded mic END with {len(mic_audio) - mic_len} samples of silence", file=sys.stderr)
            if len(desktop_audio) != desktop_len:
                print(f"  Padded desktop END with {len(desktop_audio) - desktop_len} samples of silence", file=sys.stderr)

            # Mix (using processor module)
            print("  Mixing mic + desktop...", file=sys.stderr)
            final_audio = mix_audio(
                mic_audio, desktop_audio,
                mic_volume=self.mic_volume,
                desktop_volume=self.desktop_volume,
                mic_boost=MIC_BOOST_LINEAR
            )

        else:
            # Mic-only
            if self.mic_sample_rate != self.target_sample_rate:
                print(f"  Resampling mic: {self.mic_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                mic_audio = resample(mic_audio, self.mic_sample_rate, self.target_sample_rate)

            # CHANNEL FIX: Handle multi-channel mic (some USB mics have 4+ channels)
            if self.mic_channels > 2:
                mic_audio = downmix_to_stereo(mic_audio, self.mic_channels)
            elif self.mic_channels == 1 and self.target_channels == 2:
                print(f"  Converting mic from mono to stereo...", file=sys.stderr)
                mic_audio = mono_to_stereo(mic_audio)

            # Apply noise reduction to microphone audio (using processor module)
            print(f"  Applying noise reduction to mic...", file=sys.stderr)
            mic_audio = enhance_microphone(mic_audio, self.target_sample_rate, self.target_channels)

            final_audio = mic_audio

        # Validate final audio is not empty
        if len(final_audio) == 0:
            raise RuntimeError(
                "Audio processing resulted in empty output. "
                "This may be due to audio buffer corruption or processing errors."
            )

        duration = len(final_audio) / (self.target_sample_rate * self.target_channels)
        print(f"  Final audio length: {len(final_audio)} samples ({duration:.2f} seconds)", file=sys.stderr)

        # Save to temporary WAV first
        temp_wav = str(Path(self.output_path).with_suffix('.temp.wav'))
        print(f"Saving temporary WAV...", file=sys.stderr)
        with wave.open(temp_wav, 'wb') as wf:
            wf.setnchannels(self.target_channels)
            wf.setsampwidth(self.pa.get_sample_size(pyaudio.paInt16))
            wf.setframerate(self.target_sample_rate)
            wf.writeframes(final_audio.tobytes())

        temp_size = Path(temp_wav).stat().st_size

        # Compress with ffmpeg (using compressor module)
        print(f"Compressing with ffmpeg (128 kbps Opus)...", file=sys.stderr)
        final_path = compress_to_opus(temp_wav, self.output_path, self.target_sample_rate)

        # Clean up temp file
        Path(temp_wav).unlink()

        file_size = Path(final_path).stat().st_size
        compression_ratio = (1 - file_size / temp_size) * 100

        print(f"Audio saved!", file=sys.stderr)
        print(f"  File: {Path(final_path).name}", file=sys.stderr)
        print(f"  Size: {file_size / 1024 / 1024:.2f} MB (was {temp_size / 1024 / 1024:.2f} MB, {compression_ratio:.1f}% smaller)", file=sys.stderr)
        print(f"  Duration: {duration:.2f} seconds", file=sys.stderr)
        print(f"  Sample rate: {self.target_sample_rate} Hz", file=sys.stderr)

        # Update output path for caller and store globally for main()
        self.output_path = final_path
        global _final_output_path, _recording_duration
        _final_output_path = final_path
        _recording_duration = duration

    def cleanup(self):
        """Clean up resources."""
        if self.pa:
            self.pa.terminate()
            self.pa = None


# CLI interface
def main():
    """
    CLI for the audio recorder.
    """
    import argparse
    import time
    import signal

    parser = argparse.ArgumentParser(description="Audio Recorder CLI")
    parser.add_argument("--mic", type=int, required=True, help="Microphone device ID")
    parser.add_argument("--loopback", type=int, required=True, help="Loopback device ID")
    parser.add_argument("--output", required=True, help="Output file path")
    parser.add_argument("--duration", type=int, default=0, help="Duration in seconds (0 for manual stop)")
    
    args = parser.parse_args()
    
    # Ensure output directory exists
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    recorder = AudioRecorder(
        mic_device_id=args.mic,
        loopback_device_id=args.loopback,
        output_path=str(output_path),
        sample_rate=48000,
        preroll_seconds=0  # Production mode: no preroll, countdown in Electron app handles device warm-up
    )

    # Handle interrupt signals for manual stop
    def signal_handler(sig, frame):
        print("\nStopping recording...", file=sys.stderr)
        recorder.stop_recording()
        recorder.cleanup()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    # signal.signal(signal.SIGTERM, signal_handler) # SIGTERM not supported gracefully on Windows

    # Start a thread to listen for stop command from stdin (for Electron)
    stop_event = threading.Event()
    
    def input_listener():
        try:
            # Read lines from stdin
            for line in sys.stdin:
                if "stop" in line.lower():
                    stop_event.set()
                    break
        except:
            pass

    input_thread = threading.Thread(target=input_listener, daemon=True)
    input_thread.start()

    try:
        recorder.start_recording()
        
        if args.duration > 0:
            # Record for fixed duration
            for i in range(args.duration):
                if not recorder.is_recording or stop_event.is_set():
                    break
                time.sleep(1)
            recorder.stop_recording()
        else:
            # Record until interrupted
            print("Recording... Send 'stop' to stdin or Press Ctrl+C to stop", file=sys.stderr)
            
            # Main loop - print audio levels for visualization
            # PERFORMANCE: Reduced from 20 FPS to 5 FPS to minimize CPU/IPC overhead
            # Visualization still looks smooth, but uses 75% less resources
            while not stop_event.is_set():
                # Print levels as JSON to stdout (buffered)
                # Electron will parse this
                levels = {
                    "type": "levels",
                    "mic": round(recorder.mic_level, 3),
                    "desktop": round(recorder.desktop_level, 3)
                }
                print(json.dumps(levels), flush=True)
                time.sleep(0.2) # 5 FPS updates (was 0.05 = 20 FPS)
            
            print("\nStopping recording...", file=sys.stderr)
            recorder.stop_recording()

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        recorder.cleanup()
        sys.exit(1)
    finally:
        recorder.cleanup()

        # Output recording info as JSON for Electron to capture
        if _final_output_path:
            recording_info = {
                "audioPath": str(_final_output_path),
                "duration": _recording_duration
            }
            print(json.dumps(recording_info))  # To stdout for Electron


if __name__ == "__main__":
    main()
