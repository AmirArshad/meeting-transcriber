"""
Alternative audio recorder implementation (v2).

Key difference: Uses separate sequential recordings instead of real-time mixing.
This avoids the buffer synchronization issues that cause choppy audio.

Approach:
- Record mic and desktop to SEPARATE in-memory buffers simultaneously
- Mix them AFTER recording completes (post-processing)
- Results in smooth, artifact-free audio
"""

import sys
import wave
import json
import threading
import time
from datetime import datetime
from pathlib import Path
import numpy as np
import soxr
import pyaudiowpatch as pyaudio

# Store final output path for meeting manager
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
        sample_rate: int = 48000,
        channels: int = 2,
        chunk_size: int = 4096,
        mic_volume: float = 1.0,
        desktop_volume: float = 1.0,
        preroll_seconds: float = None  # None = use default 1.5s, 0 = no preroll (for production with countdown)
    ):
        """Initialize the recorder."""
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
                print(f"⚠️  WARNING: Sample rate probing failed!", file=sys.stderr)
                print(f"⚠️  Using default rate - audio may be distorted", file=sys.stderr)
                print(f"⚠️  Error: {e}", file=sys.stderr)
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
        self.mic_frames = []
        self.desktop_frames = []
        self.is_recording = False
        self.lock = threading.Lock()

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

        # Audio levels (0.0 to 1.0)
        self.mic_level = 0.0
        self.desktop_level = 0.0

        # Streams
        self.mic_stream = None
        self.desktop_stream = None

        # FIX 6: Callback watchdog to detect audio stream stalls
        self.last_callback_time = 0
        self.callback_watchdog = None
        self.watchdog_running = False
        self.watchdog_warning_shown = False  # Track if we've already warned

        # FIX 5: Check platform once instead of repeatedly
        import platform
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

    def _mic_callback(self, in_data, frame_count, time_info, status):
        """Callback for microphone."""
        # FIX 6: Update watchdog timestamp
        self.last_callback_time = time.time()

        if status:
            print(f"Mic status: {status}", file=sys.stderr)

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
                
                # Calculate level for visualization
                # PERFORMANCE: Optimized to avoid array allocation in hot path
                try:
                    # Convert to numpy view (no copy)
                    data = np.frombuffer(in_data, dtype=np.int16)
                    # Use numpy's abs with subsample (::8 instead of ::4 for 2x speedup)
                    # Even with less samples, still accurate enough for visualization
                    peak = np.abs(data[::8]).max() if len(data) > 0 else 0
                    # Normalize (int16 max is 32768)
                    self.mic_level = float(peak) / 32768.0
                except:
                    self.mic_level = 0.0

        return (in_data, pyaudio.paContinue)

    def _desktop_callback(self, in_data, frame_count, time_info, status):
        """Callback for desktop audio."""
        # FIX 6 (CRITICAL): Update watchdog timestamp for desktop too!
        self.last_callback_time = time.time()

        if status:
            print(f"Desktop status: {status}", file=sys.stderr)

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

                # Calculate level for visualization
                # PERFORMANCE: Optimized to avoid array allocation in hot path
                try:
                    data = np.frombuffer(in_data, dtype=np.int16)
                    peak = np.abs(data[::8]).max() if len(data) > 0 else 0
                    self.desktop_level = float(peak) / 32768.0
                except:
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

        # FIX 5 (REFINED): Increase chunk size on Windows for better resilience to backgrounding
        # Larger buffers = more tolerance for process scheduling delays
        # Since we do post-processing, latency doesn't matter
        if self.is_windows:
            self.chunk_size = self.original_chunk_size * 4  # 4x larger buffer
            print(f"Windows detected: Using larger audio buffer ({self.chunk_size} frames) for background resilience", file=sys.stderr)

            # CRITICAL FIX: Recalculate preroll_frames with new chunk size
            if self.preroll_seconds > 0:
                self.preroll_frames_mic = int(self.preroll_seconds * self.mic_sample_rate / self.chunk_size)
                if self.mixing_mode and self.loopback_sample_rate > 0:
                    # Recalculate desktop preroll - MUST match same time duration for sync
                    self.preroll_frames_desktop = int(self.preroll_seconds * self.loopback_sample_rate / self.chunk_size)
                print(f"  Adjusted preroll: mic={self.preroll_frames_mic} frames, desktop={self.preroll_frames_desktop} frames", file=sys.stderr)
            else:
                print(f"  Preroll disabled (using countdown)", file=sys.stderr)

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
            # COMPATIBILITY FIX: Open desktop stream with robust fallback
            # If the probed rate doesn't work at recording time (device state changed),
            # try re-probing to find current working rate
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
                print(f"✓ Desktop audio stream opened at {self.loopback_sample_rate} Hz", file=sys.stderr)

            except Exception as e:
                print(f"", file=sys.stderr)
                print(f"⚠️  Failed to open loopback at {self.loopback_sample_rate} Hz", file=sys.stderr)
                print(f"⚠️  Error: {e}", file=sys.stderr)
                print(f"", file=sys.stderr)

                # Try re-probing in case device changed state since initialization
                # (e.g., Bluetooth switched profiles, device sample rate changed)
                print(f"Attempting to re-probe loopback device...", file=sys.stderr)
                try:
                    loopback_info = self.pa.get_device_info_by_index(self.loopback_device_id)
                    new_rate, new_channels = self._probe_loopback_sample_rate(
                        self.loopback_device_id,
                        loopback_info
                    )

                    # Update to new detected rate
                    if new_rate != self.loopback_sample_rate or new_channels != self.loopback_channels:
                        print(f"", file=sys.stderr)
                        print(f"📢 Device configuration changed:", file=sys.stderr)
                        print(f"   Old: {self.loopback_sample_rate} Hz, {self.loopback_channels} ch", file=sys.stderr)
                        print(f"   New: {new_rate} Hz, {new_channels} ch", file=sys.stderr)
                        print(f"", file=sys.stderr)
                        self.loopback_sample_rate = new_rate
                        self.loopback_channels = new_channels

                    # Try again with new rate
                    self.desktop_stream = self.pa.open(
                        format=pyaudio.paInt16,
                        channels=self.loopback_channels,
                        rate=self.loopback_sample_rate,
                        input=True,
                        input_device_index=self.loopback_device_id,
                        frames_per_buffer=self.chunk_size,
                        stream_callback=self._desktop_callback
                    )
                    print(f"✓ Desktop audio stream opened at {self.loopback_sample_rate} Hz (after re-probe)", file=sys.stderr)

                except Exception as e2:
                    # Close mic stream if desktop fails completely
                    if self.mic_stream:
                        self.mic_stream.stop_stream()
                        self.mic_stream.close()
                        self.mic_stream = None

                    # Provide detailed error with troubleshooting steps
                    raise RuntimeError(
                        f"Failed to open desktop audio stream after multiple attempts:\n\n"
                        f"First attempt error:\n"
                        f"  {str(e)}\n\n"
                        f"Re-probe attempt error:\n"
                        f"  {str(e2)}\n\n"
                        f"Troubleshooting suggestions:\n"
                        f"  1. Try selecting a different desktop audio device\n"
                        f"  2. Check that the device is not in use by another application\n"
                        f"  3. If using Bluetooth headset:\n"
                        f"     - Ensure it's in 'Stereo' mode, not 'Headset/Hands-free' mode\n"
                        f"     - Try disconnecting and reconnecting the Bluetooth device\n"
                        f"     - In Windows Sound settings, set the Bluetooth device as default\n"
                        f"  4. Restart the application and try again\n"
                        f"  5. As a workaround, you can record microphone-only (disable desktop audio)"
                    )

        # Start streams
        try:
            self.mic_stream.start_stream()
            if self.desktop_stream:
                self.desktop_stream.start_stream()
        except Exception as e:
            self.cleanup()
            raise RuntimeError(f"Failed to start audio streams: {e}")

        # FIX 6 (REFINED): Start watchdog thread to detect callback stalls
        def watchdog():
            """Monitor audio callback health and warn if stalled."""
            self.watchdog_running = True
            self.last_callback_time = time.time()  # Initialize

            while self.is_recording and self.watchdog_running:
                time.sleep(5)  # Check every 5 seconds

                if self.is_recording:
                    elapsed = time.time() - self.last_callback_time

                    # If no callback for 10 seconds, something is very wrong
                    # CRITICAL FIX: Only warn ONCE to avoid console spam
                    if elapsed > 10 and not self.watchdog_warning_shown:
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
        print(f"  Raw mic audio: {len(mic_audio)} samples ({len(mic_audio) / self.mic_sample_rate / self.mic_channels:.2f} seconds at {self.mic_sample_rate} Hz, {self.mic_channels} ch)", file=sys.stderr)

        if self.mixing_mode and self.desktop_frames:
            desktop_audio = np.frombuffer(b''.join(self.desktop_frames), dtype=np.int16)
            print(f"  Raw desktop audio: {len(desktop_audio)} samples ({len(desktop_audio) / self.loopback_sample_rate / self.loopback_channels:.2f} seconds at {self.loopback_sample_rate} Hz, {self.loopback_channels} ch)", file=sys.stderr)

            # Resample both to target rate
            if self.mic_sample_rate != self.target_sample_rate:
                print(f"  Resampling mic: {self.mic_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                mic_audio = self._resample(mic_audio, self.mic_sample_rate, self.target_sample_rate)

            # Convert mono mic to stereo if needed
            if self.mic_channels == 1 and self.target_channels == 2:
                print(f"  Converting mic from mono to stereo...", file=sys.stderr)
                mic_audio = np.repeat(mic_audio, 2)  # Duplicate mono to both channels

            # Apply noise reduction to microphone audio only
            print(f"  Applying noise reduction to mic...", file=sys.stderr)
            mic_audio = self._enhance_microphone(mic_audio, self.target_sample_rate)

            if self.loopback_sample_rate != self.target_sample_rate:
                print(f"  Resampling desktop: {self.loopback_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                desktop_audio = self._resample(desktop_audio, self.loopback_sample_rate, self.target_sample_rate)

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

            # Align to same length by padding shorter stream with silence
            # This preserves timing - truncating would cause misalignment
            mic_len = len(mic_audio)
            desktop_len = len(desktop_audio)
            max_length = max(mic_len, desktop_len)

            # Safety check: ensure we have valid audio data
            if max_length == 0:
                raise RuntimeError(
                    "Audio alignment failed - both audio tracks are empty after resampling. "
                    "This may be due to audio buffer corruption or device issues."
                )

            print(f"  Aligning audio: mic={mic_len} samples, desktop={desktop_len} samples, padding to={max_length}", file=sys.stderr)

            # Pad shorter stream with silence at the end
            if mic_len < max_length:
                padding = np.zeros(max_length - mic_len, dtype=np.int16)
                mic_audio = np.concatenate([mic_audio, padding])
                print(f"  Padded mic with {max_length - mic_len} samples of silence", file=sys.stderr)

            if desktop_len < max_length:
                padding = np.zeros(max_length - desktop_len, dtype=np.int16)
                desktop_audio = np.concatenate([desktop_audio, padding])
                print(f"  Padded desktop with {max_length - desktop_len} samples of silence", file=sys.stderr)

            # Mix
            print("  Mixing mic + desktop...", file=sys.stderr)
            # Boost mic by 2x (6 dB) to make voice more prominent
            mic_float = mic_audio.astype(np.float32) / 32768.0 * self.mic_volume * 2.0
            desktop_float = desktop_audio.astype(np.float32) / 32768.0 * self.desktop_volume

            mixed = mic_float + desktop_float

            # Soft limiting
            max_val = np.max(np.abs(mixed))
            if max_val > 1.0:
                mixed = np.tanh(mixed * 0.85)

            final_audio = (mixed * 32767.0).astype(np.int16)

        else:
            # Mic-only
            if self.mic_sample_rate != self.target_sample_rate:
                print(f"  Resampling mic: {self.mic_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                mic_audio = self._resample(mic_audio, self.mic_sample_rate, self.target_sample_rate)

            # Convert mono mic to stereo if needed
            if self.mic_channels == 1 and self.target_channels == 2:
                print(f"  Converting mic from mono to stereo...", file=sys.stderr)
                mic_audio = np.repeat(mic_audio, 2)

            # Apply noise reduction to microphone audio
            print(f"  Applying noise reduction to mic...", file=sys.stderr)
            mic_audio = self._enhance_microphone(mic_audio, self.target_sample_rate)

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

        # Compress with ffmpeg
        print(f"Compressing with ffmpeg (128 kbps Opus)...", file=sys.stderr)
        final_path = self._compress_audio(temp_wav, self.output_path)

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

    def _compress_audio(self, input_path, output_path):
        """Compress audio using ffmpeg to Opus format."""
        import subprocess

        # Change extension to .opus
        opus_path = str(Path(output_path).with_suffix('.opus'))

        # AUDIO QUALITY FIX: Use higher bitrate and better settings
        # - 128 kbps for archival/transcription quality (was 96k)
        # - 'audio' mode instead of 'voip' for better quality
        # - Explicit sample rate to prevent downsampling
        # Still ~8-10x smaller than WAV, but much better quality
        cmd = [
            'ffmpeg',
            '-i', input_path,
            '-c:a', 'libopus',
            '-b:a', '128k',  # Higher bitrate for better quality (was 96k)
            '-vbr', 'on',  # Variable bitrate for better quality
            '-compression_level', '10',  # Maximum quality (0-10, higher = better)
            '-application', 'audio',  # Audio mode (better quality than 'voip')
            '-ar', str(self.target_sample_rate),  # Preserve sample rate
            '-y',  # Overwrite output
            '-loglevel', 'error',  # Only show errors
            opus_path
        ]

        try:
            result = subprocess.run(cmd, check=True, capture_output=True)
            return opus_path
        except FileNotFoundError:
            print(f"Warning: ffmpeg not found in PATH", file=sys.stderr)
            print(f"Falling back to WAV format (audio will be larger)...", file=sys.stderr)
            # If ffmpeg is not installed, just copy the temp WAV to output
            import shutil
            shutil.copy(input_path, output_path)
            return output_path
        except subprocess.CalledProcessError as e:
            print(f"Warning: ffmpeg compression failed: {e.stderr.decode()}", file=sys.stderr)
            print(f"Falling back to WAV format...", file=sys.stderr)
            # If ffmpeg fails, just copy the temp WAV to output
            import shutil
            shutil.copy(input_path, output_path)
            return output_path

    def _enhance_microphone(self, audio_data, sample_rate):
        """
        Apply MINIMAL enhancement to microphone audio.

        AUDIO QUALITY FIX: Reduced processing to preserve natural quality
        - Only basic DC offset removal and very gentle normalization
        - Removed aggressive filtering that was degrading quality
        - Google Meet-style: minimal processing, let the codec handle it

        Goal: Natural, unprocessed sound - like Google Meet
        """
        # Convert to float for processing
        audio_float = audio_data.astype(np.float32) / 32768.0

        # Handle stereo by processing each channel
        if len(audio_float) % 2 == 0 and self.target_channels == 2:
            # Reshape to stereo
            audio_stereo = audio_float.reshape(-1, 2)
            left = audio_stereo[:, 0]
            right = audio_stereo[:, 1]

            # Process each channel
            left_processed = self._process_channel(left, sample_rate)
            right_processed = self._process_channel(right, sample_rate)

            # Recombine
            audio_processed = np.column_stack((left_processed, right_processed)).flatten()
        else:
            # Mono
            audio_processed = self._process_channel(audio_float, sample_rate)

        # Convert back to int16
        return (audio_processed * 32767.0).astype(np.int16)

    def _process_channel(self, channel_data, sample_rate):
        """
        MINIMAL processing for natural sound quality.

        AUDIO QUALITY FIX: Simplified to match Google Meet's approach
        - Only DC offset removal (essential)
        - Light normalization (preserve dynamics)
        - NO aggressive filtering, gating, or compression
        """

        # 1. Remove DC offset (essential - prevents pops/clicks)
        channel_data = channel_data - np.mean(channel_data)

        # 2. Very gentle normalization to -3dB peak
        # This preserves dynamics while ensuring good levels
        peak = np.max(np.abs(channel_data))
        if peak > 0.7:  # Only normalize if too loud
            # Target -3dB (0.7) to leave headroom
            channel_data = channel_data * (0.7 / peak)
        elif peak < 0.1:  # Boost very quiet audio
            # Gentle boost for quiet mics
            channel_data = channel_data * (0.3 / peak)

        # 3. Very soft limiting ONLY if clipping would occur
        # Uses tanh for smooth clipping prevention
        abs_max = np.max(np.abs(channel_data))
        if abs_max > 0.95:
            channel_data = np.tanh(channel_data * 0.9) * 0.85

        return channel_data

    def _resample(self, audio_data, original_rate, target_rate):
        """Resample audio using soxr (high-quality, fast resampling)."""
        # Convert int16 to float32 for soxr processing
        audio_float = audio_data.astype(np.float32) / 32768.0

        # Resample with soxr (VHQ quality setting)
        resampled = soxr.resample(
            audio_float,
            original_rate,
            target_rate,
            quality='VHQ'  # Very High Quality - best for voice
        )

        # Convert back to int16
        return (resampled * 32767.0).astype(np.int16)

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
