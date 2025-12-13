"""
macOS audio recorder implementation using sounddevice and ScreenCaptureKit.

Uses sounddevice for microphone input and ScreenCaptureKit for desktop audio capture.
Implements the same post-processing mix approach as Windows for consistency.
"""

import sys
import wave
import json
import threading
import time
from datetime import datetime
from pathlib import Path
import numpy as np

try:
    import sounddevice as sd
except ImportError:
    print("ERROR: sounddevice not installed. Install with: pip install sounddevice", file=sys.stderr)
    sys.exit(1)


# Lock for thread-safe JSON output to stdout
_stdout_lock = threading.Lock()


def _send_json_message(message: dict):
    """Send a JSON message to stdout in a thread-safe manner."""
    with _stdout_lock:
        print(json.dumps(message), flush=True)


# Audio processing constants
CENTER_CHANNEL_ATTENUATION = 0.707  # -3dB, equivalent to 1/sqrt(2)
SURROUND_CHANNEL_ATTENUATION = 0.5  # -6dB for extra surround channels


def _downmix_to_stereo(audio: np.ndarray, num_channels: int) -> np.ndarray:
    """
    Downmix multi-channel audio to stereo.

    Uses standard downmix coefficients:
    - Center channel at -3dB (0.707) mixed equally to L and R
    - Surround channels at -6dB (0.5) mixed equally to L and R

    Args:
        audio: numpy array with shape (samples, channels)
        num_channels: number of channels in the audio

    Returns:
        numpy array with shape (samples, 2) for stereo output
    """
    if num_channels <= 2:
        if num_channels == 1:
            # Mono to stereo: duplicate the channel
            if len(audio.shape) == 1:
                return np.column_stack([audio, audio])
            return np.column_stack([audio[:, 0], audio[:, 0]])
        # Already stereo
        return audio

    # Multi-channel downmix to stereo
    # Standard layout: L, R, C, LFE, SL, SR, ...
    left = audio[:, 0].copy()
    right = audio[:, 1].copy()

    # Add Center (channel 2) if available - at -3dB to both L and R
    if num_channels >= 3:
        center = audio[:, 2] * CENTER_CHANNEL_ATTENUATION
        left = left + center
        right = right + center

    # Add remaining channels (surround, etc.) at -6dB
    if num_channels > 3:
        for i in range(3, num_channels):
            ch = audio[:, i] * SURROUND_CHANNEL_ATTENUATION
            left = left + ch
            right = right + ch

    return np.column_stack([left, right])

# Import Swift audio capture helper (preferred for macOS 13+)
# Falls back to PyObjC ScreenCaptureKit if Swift helper not available
SWIFT_CAPTURE_AVAILABLE = False
SCREENCAPTURE_AVAILABLE = False

try:
    from .swift_audio_capture import SwiftAudioCapture, is_swift_capture_available, check_screen_recording_permission
    if is_swift_capture_available():
        SWIFT_CAPTURE_AVAILABLE = True
        print("Using Swift audiocapture-helper for desktop audio", file=sys.stderr)
    else:
        print("Swift audiocapture-helper not found, trying PyObjC fallback...", file=sys.stderr)
except ImportError as e:
    print(f"Swift audio capture import failed: {e}", file=sys.stderr)

# Fallback to PyObjC ScreenCaptureKit (may not work on macOS 15+)
if not SWIFT_CAPTURE_AVAILABLE:
    try:
        from .screencapture_helper import ScreenCaptureAudioRecorder, check_screen_recording_permission
        SCREENCAPTURE_AVAILABLE = True
        print("Using PyObjC ScreenCaptureKit for desktop audio (fallback)", file=sys.stderr)
    except ImportError:
        print("WARNING: No desktop audio capture available", file=sys.stderr)
        print("  Desktop audio capture will be disabled", file=sys.stderr)
        # Define fallback function
        def check_screen_recording_permission():
            return False


class MacOSAudioRecorder:
    """
    macOS audio recorder with sounddevice (microphone) and ScreenCaptureKit (desktop).

    Uses post-processing mix approach:
    - Records mic and desktop to separate buffers
    - Mixes them after recording completes
    - Applies audio enhancement and compression
    """

    def __init__(
        self,
        mic_device_id: int,
        desktop_device_id: int,  # For ScreenCaptureKit or future implementation
        output_path: str,
        sample_rate: int = 48000,
        channels: int = 2,
        chunk_size: int = 4096,
        mic_volume: float = 1.0,
        desktop_volume: float = 1.0,
        preroll_seconds: float = None  # None = use default 1.5s, 0 = no preroll (for production with countdown)
    ):
        """Initialize the macOS recorder."""
        self.mic_device_id = mic_device_id
        self.desktop_device_id = desktop_device_id
        self.output_path = output_path
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.mic_volume = mic_volume
        self.desktop_volume = desktop_volume

        # Recording state
        self.is_running = False
        self._running_lock = threading.Lock()  # Protects is_running access
        self.mic_frames = []
        self.desktop_frames = []

        # Audio levels for visualization
        self.mic_level = 0.0
        self.desktop_level = 0.0
        self.level_lock = threading.Lock()

        # Error tracking for async thread errors
        self._error_event = threading.Event()
        self._last_error = None
        self._error_lock = threading.Lock()

        # Threads
        self.mic_thread = None
        self.desktop_thread = None

        # Device info
        self.mic_info = None
        self.desktop_info = None

        # Desktop audio recorder (Swift helper preferred, PyObjC fallback)
        self.desktop_capture = None
        self.desktop_capture_type = None  # 'swift' or 'pyobjc'

        if SWIFT_CAPTURE_AVAILABLE:
            try:
                self.desktop_capture = SwiftAudioCapture(
                    sample_rate=sample_rate,
                    channels=channels
                )
                self.desktop_capture_type = 'swift'
                print(f"  Swift AudioCaptureHelper initialized for desktop audio", file=sys.stderr)
            except Exception as e:
                print(f"  WARNING: Could not initialize Swift capture: {e}", file=sys.stderr)
                self.desktop_capture = None

        # Fallback to PyObjC ScreenCaptureKit
        if self.desktop_capture is None and SCREENCAPTURE_AVAILABLE:
            try:
                self.desktop_capture = ScreenCaptureAudioRecorder(
                    sample_rate=sample_rate,
                    channels=channels
                )
                self.desktop_capture_type = 'pyobjc'
                print(f"  PyObjC ScreenCaptureKit initialized for desktop audio (fallback)", file=sys.stderr)
            except Exception as e:
                print(f"  WARNING: Could not initialize PyObjC capture: {e}", file=sys.stderr)
                self.desktop_capture = None

        # Legacy alias for compatibility
        self.screencapture_recorder = self.desktop_capture

        # Pre-roll: discard first ~1.5 seconds (device warm-up)
        # PRODUCTION FIX: In the real app, the 3-second countdown handles warm-up
        # so we can skip preroll entirely. For direct API usage (tests), we still need it.
        self.preroll_seconds = 1.5 if preroll_seconds is None else preroll_seconds
        self.preroll_frames = int(self.preroll_seconds * sample_rate / chunk_size)

        # Time-based synchronization - SINGLE reference point set at recording start
        # Both streams use the same reference to ensure they stay in sync
        self.recording_start_time = None

        # Output tracking (instance variables instead of globals)
        self.final_output_path = None
        self.recording_duration = 0.0

        print(f"Initialized macOS audio recorder", file=sys.stderr)
        print(f"  Mic device: {mic_device_id}", file=sys.stderr)
        print(f"  Desktop device: {desktop_device_id}", file=sys.stderr)
        print(f"  Sample rate: {sample_rate} Hz", file=sys.stderr)
        print(f"  Output: {output_path}", file=sys.stderr)

    def start_recording(self):
        """Start recording from microphone and desktop (if available)."""
        if self._get_running():
            print("Already recording!", file=sys.stderr)
            return

        self._set_running(True)
        self.mic_frames = []
        self.desktop_frames = []

        # Clear error state
        self._error_event.clear()
        with self._error_lock:
            self._last_error = None

        # Set recording start time BEFORE anything else
        # This is the single reference point for preroll timing
        self.recording_start_time = time.time()

        # Get device info
        try:
            devices = sd.query_devices()
            self.mic_info = devices[self.mic_device_id]
            print(f"Microphone: {self.mic_info['name']}", file=sys.stderr)

            # Desktop audio status
            if self.desktop_capture:
                capture_type = self.desktop_capture_type or 'unknown'
                print(f"Desktop audio: {capture_type} capture enabled", file=sys.stderr)
            else:
                print(f"Desktop audio: disabled (no capture method available)", file=sys.stderr)

        except Exception as e:
            print(f"Error querying devices: {e}", file=sys.stderr)
            self._set_running(False)
            return

        # Start microphone recording thread
        self.mic_thread = threading.Thread(target=self._record_microphone)
        self.mic_thread.daemon = True
        self.mic_thread.start()

        # Start desktop recording if capture method is available
        if self.desktop_capture:
            self.desktop_thread = threading.Thread(target=self._record_desktop)
            self.desktop_thread.daemon = True
            self.desktop_thread.start()
        else:
            print(f"Desktop audio capture disabled (no capture method available)", file=sys.stderr)
            print(f"  Swift helper or PyObjC ScreenCaptureKit required", file=sys.stderr)
            # Send JSON warning to Electron for UI display (thread-safe)
            _send_json_message({
                "type": "warning",
                "code": "NO_DESKTOP_AUDIO",
                "message": "Desktop audio capture is disabled. Only microphone will be recorded.",
                "help": "Ensure audiocapture-helper is bundled or install PyObjC as fallback."
            })

        print(f"Recording started!", file=sys.stderr)

    def _record_microphone(self):
        """Record from microphone using sounddevice."""
        try:
            # Determine mic channels (mono or stereo)
            mic_channels = min(self.mic_info.get('max_input_channels', 1), 2)

            print(f"Starting mic capture ({mic_channels} channel(s))...", file=sys.stderr)

            frame_count = 0

            def audio_callback(indata, frames, time_info, status):
                """Callback for audio input."""
                nonlocal frame_count

                if status:
                    print(f"Mic status: {status}", file=sys.stderr)

                # TIME-BASED SYNCHRONIZATION: Use shared reference set at recording start
                # Both streams use the same recording_start_time (set in start_recording)
                # This ensures they skip the same wall-clock period and stay in sync
                elapsed = time.time() - self.recording_start_time

                # Skip pre-roll based on TIME, not frame counts
                if elapsed < self.preroll_seconds:
                    frame_count += 1
                    return

                # Store audio data
                self.mic_frames.append(indata.copy())

                # Calculate audio level (for visualization)
                # Subsample by 8 for performance
                level = np.max(np.abs(indata[::8]))

                with self.level_lock:
                    self.mic_level = float(level)

                frame_count += 1

            # Open stream and start recording
            with sd.InputStream(
                device=self.mic_device_id,
                channels=mic_channels,
                samplerate=self.sample_rate,
                blocksize=self.chunk_size,
                callback=audio_callback
            ):
                while self._get_running():
                    time.sleep(0.1)

            print(f"Mic recording stopped. Frames captured: {len(self.mic_frames)}", file=sys.stderr)

        except Exception as e:
            print(f"ERROR in mic recording: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)

            # Set error state for main thread to detect
            with self._error_lock:
                self._last_error = f"Microphone recording failed: {str(e)}"
            self._error_event.set()

            self._set_running(False)
            # Send error to Electron UI (thread-safe)
            _send_json_message({
                "type": "error",
                "code": "MIC_RECORDING_FAILED",
                "message": f"Microphone recording failed: {str(e)}"
            })

    def _record_desktop(self):
        """
        Record desktop audio using Swift helper or ScreenCaptureKit fallback.

        Uses the native Swift audiocapture-helper (preferred) or PyObjC
        ScreenCaptureKit to capture system audio output.

        References:
        - https://developer.apple.com/documentation/screencapturekit
        - https://github.com/Mnpn/Azayaka (example implementation)
        """
        if not self.desktop_capture:
            print(f"Desktop audio capture not available, skipping", file=sys.stderr)
            return

        try:
            capture_type = self.desktop_capture_type or 'unknown'
            print(f"Starting desktop audio capture ({capture_type})...", file=sys.stderr)

            # Start recording
            if not self.desktop_capture.start_recording():
                print(f"Failed to start {capture_type} desktop recording", file=sys.stderr)
                return

            # Monitor audio levels while recording
            # Track if we've logged level calculation errors to avoid spam
            level_error_logged = False

            while self._get_running():
                # Update desktop audio level from capture buffer (thread-safe)
                # Avoid nested locks by copying data first, then updating level
                try:
                    level = None
                    with self.desktop_capture.buffer_lock:
                        if self.desktop_capture.audio_buffer:
                            # Get the latest buffer and calculate level while holding lock
                            latest_buffer = self.desktop_capture.audio_buffer[-1]
                            level = float(np.max(np.abs(latest_buffer[::8])))  # Subsample for performance

                    # Update level outside of buffer_lock to avoid nested locks
                    if level is not None:
                        with self.level_lock:
                            self.desktop_level = level
                except Exception as level_err:
                    # Log the first error to aid debugging, but don't spam
                    if not level_error_logged:
                        print(f"Warning: Error calculating desktop audio level: {level_err}", file=sys.stderr)
                        level_error_logged = True

                time.sleep(0.1)

            print(f"Desktop recording thread stopped", file=sys.stderr)

        except Exception as e:
            print(f"ERROR in desktop recording: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)

            # Set error state for main thread to detect
            with self._error_lock:
                self._last_error = f"Desktop audio recording failed: {str(e)}"
            self._error_event.set()

            # Send error to Electron UI (thread-safe)
            _send_json_message({
                "type": "error",
                "code": "DESKTOP_RECORDING_FAILED",
                "message": f"Desktop audio recording failed: {str(e)}"
            })

    def stop_recording(self):
        """Stop recording and process audio."""
        if not self._get_running():
            print("Not recording!", file=sys.stderr)
            return

        print(f"\nStopping recording...", file=sys.stderr)
        self._set_running(False)

        # Wait for threads to finish
        if self.mic_thread:
            self.mic_thread.join(timeout=2.0)
        if self.desktop_thread:
            self.desktop_thread.join(timeout=2.0)

        # Stop desktop capture and get desktop audio
        if self.desktop_capture:
            capture_type = self.desktop_capture_type or 'unknown'
            print(f"Stopping {capture_type} desktop capture...", file=sys.stderr)
            desktop_audio = self.desktop_capture.stop_recording()
            if desktop_audio is not None:
                # Convert to list of frames for consistency
                self.desktop_frames = [desktop_audio]
                print(f"Retrieved {len(desktop_audio)} desktop audio samples from {capture_type}", file=sys.stderr)
            else:
                print(f"No desktop audio captured from {capture_type}", file=sys.stderr)

        # Process and save audio
        print(f"Processing audio...", file=sys.stderr)
        self._process_and_save()

        print(f"Recording complete!", file=sys.stderr)

    def _process_and_save(self):
        """Process recorded audio and save to file."""
        if not self.mic_frames:
            print(f"ERROR: No audio recorded from microphone!", file=sys.stderr)
            return

        # Convert mic frames to numpy array
        mic_audio = np.concatenate(self.mic_frames, axis=0)
        mic_channels = mic_audio.shape[1] if len(mic_audio.shape) > 1 else 1

        print(f"Mic audio: {len(mic_audio)} samples, {mic_channels} channel(s)", file=sys.stderr)

        # Mix desktop audio if available
        if self.desktop_frames:
            desktop_audio = np.concatenate(self.desktop_frames, axis=0)
            desktop_channels = desktop_audio.shape[1] if len(desktop_audio.shape) > 1 else 1

            print(f"Desktop audio: {len(desktop_audio)} samples, {desktop_channels} channel(s)", file=sys.stderr)

            # Downmix to stereo if needed
            if mic_channels != 2:
                print(f"  Downmixing mic audio from {mic_channels} channel(s) to stereo...", file=sys.stderr)
                mic_audio = _downmix_to_stereo(mic_audio, mic_channels)

            if desktop_channels != 2:
                print(f"  Downmixing desktop audio from {desktop_channels} channel(s) to stereo...", file=sys.stderr)
                desktop_audio = _downmix_to_stereo(desktop_audio, desktop_channels)

            # Match lengths by padding shorter stream with silence (NOT resampling)
            # Resampling would change pitch/speed - we just need to align the streams
            if len(mic_audio) != len(desktop_audio):
                print(f"Aligning stream lengths: mic={len(mic_audio)}, desktop={len(desktop_audio)}", file=sys.stderr)

                target_length = max(len(mic_audio), len(desktop_audio))

                # Pad shorter stream with silence (zeros)
                if len(mic_audio) < target_length:
                    padding_length = target_length - len(mic_audio)
                    padding = np.zeros((padding_length, mic_audio.shape[1]), dtype=mic_audio.dtype)
                    mic_audio = np.concatenate([mic_audio, padding], axis=0)
                    print(f"  Padded mic audio with {padding_length} samples of silence", file=sys.stderr)
                elif len(desktop_audio) < target_length:
                    padding_length = target_length - len(desktop_audio)
                    padding = np.zeros((padding_length, desktop_audio.shape[1]), dtype=desktop_audio.dtype)
                    desktop_audio = np.concatenate([desktop_audio, padding], axis=0)
                    print(f"  Padded desktop audio with {padding_length} samples of silence", file=sys.stderr)

            # Mix: apply volumes with mic boost (match Windows behavior)
            # Mic boost of 2.0 (6dB) makes voice prominent over desktop audio
            MIC_BOOST = 2.0
            final_audio = (mic_audio * self.mic_volume * MIC_BOOST) + (desktop_audio * self.desktop_volume)

            # Soft limiting if clipping would occur (match Windows behavior)
            max_val = np.max(np.abs(final_audio))
            if max_val > 1.0:
                final_audio = np.tanh(final_audio * 0.85)

            print(f"Mixed audio: {len(final_audio)} samples (mic boost: {MIC_BOOST}x)", file=sys.stderr)

        else:
            # Mic-only mode
            print(f"No desktop audio captured, using mic-only", file=sys.stderr)

            # Downmix to stereo if needed
            if mic_channels != 2:
                print(f"  Converting mic audio from {mic_channels} channel(s) to stereo...", file=sys.stderr)
                final_audio = _downmix_to_stereo(mic_audio, mic_channels)
            else:
                final_audio = mic_audio

            # Apply mic volume
            final_audio = final_audio * self.mic_volume

        # Enhance microphone audio (same as Windows)
        final_audio = self._enhance_microphone(final_audio)

        # Save as temporary WAV file
        temp_wav_path = self.output_path.replace('.opus', '_temp.wav').replace('.wav', '_temp.wav')
        self._save_wav(final_audio, temp_wav_path)

        # Determine final output path (replace .wav with .opus)
        final_output_path = self.output_path.replace('.wav', '.opus')

        # Compress with ffmpeg (same as Windows)
        self._compress_with_ffmpeg(temp_wav_path, final_output_path)

        # Clean up temp file
        try:
            Path(temp_wav_path).unlink()
        except OSError:
            pass  # File may already be deleted or locked

        # Set instance variables for meeting manager
        self.final_output_path = final_output_path
        duration_seconds = len(final_audio) / self.sample_rate
        self.recording_duration = duration_seconds

        print(f"Final file: {final_output_path}", file=sys.stderr)
        print(f"Duration: {duration_seconds:.1f} seconds", file=sys.stderr)

    def _enhance_microphone(self, audio):
        """
        Apply minimal audio enhancement to microphone (Google Meet style).

        MATCHES WINDOWS IMPLEMENTATION:
        - Per-channel processing for stereo
        - Remove DC offset (prevents pops/clicks)
        - Gentle normalization (preserves dynamics)
        - Soft limiting (prevents clipping)
        """
        # Handle stereo by processing each channel separately
        if len(audio.shape) > 1 and audio.shape[1] == 2:
            # Process left and right channels independently
            left = self._process_channel(audio[:, 0])
            right = self._process_channel(audio[:, 1])
            return np.column_stack((left, right))
        else:
            # Mono audio
            return self._process_channel(audio.flatten()).reshape(-1, 1)

    def _process_channel(self, channel_data):
        """
        MINIMAL processing for natural sound quality (matches Windows).

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
        elif peak < 0.1 and peak > 0:  # Boost very quiet audio
            # Gentle boost for quiet mics
            channel_data = channel_data * (0.3 / peak)

        # 3. Very soft limiting ONLY if clipping would occur
        # Uses tanh for smooth clipping prevention
        abs_max = np.max(np.abs(channel_data))
        if abs_max > 0.95:
            channel_data = np.tanh(channel_data * 0.9) * 0.85

        return channel_data

    def _save_wav(self, audio, path):
        """Save audio as WAV file."""
        # Ensure audio is in correct format
        if len(audio.shape) == 1:
            audio = np.column_stack([audio, audio])  # Mono to stereo

        # Convert to int16
        audio_int = np.clip(audio * 32767, -32768, 32767).astype(np.int16)

        # Save WAV
        with wave.open(path, 'wb') as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)  # 16-bit
            wf.setframerate(self.sample_rate)
            wf.writeframes(audio_int.tobytes())

        print(f"Saved WAV: {path}", file=sys.stderr)

    def _compress_with_ffmpeg(self, input_path, output_path):
        """Compress WAV to Opus using ffmpeg (same as Windows)."""
        import subprocess
        import shutil

        # Check if ffmpeg is available
        if not shutil.which('ffmpeg'):
            print(f"WARNING: ffmpeg not found. Saving as WAV instead.", file=sys.stderr)
            shutil.copy(input_path, output_path.replace('.opus', '.wav'))
            return

        try:
            print(f"Compressing with ffmpeg (Opus codec)...", file=sys.stderr)

            cmd = [
                'ffmpeg',
                '-i', input_path,
                '-c:a', 'libopus',
                '-b:a', '128k',
                '-vbr', 'on',
                '-compression_level', '10',
                '-application', 'audio',
                '-y',
                output_path
            ]

            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )

            if result.returncode == 0:
                # Calculate compression ratio
                input_size = Path(input_path).stat().st_size
                output_size = Path(output_path).stat().st_size
                ratio = (1 - output_size / input_size) * 100

                print(f"Compression complete!", file=sys.stderr)
                print(f"  Original: {input_size / 1024 / 1024:.1f} MB", file=sys.stderr)
                print(f"  Compressed: {output_size / 1024 / 1024:.1f} MB", file=sys.stderr)
                print(f"  Savings: {ratio:.1f}%", file=sys.stderr)

                # Verify the output file integrity
                if not self._verify_recording_integrity(output_path):
                    print(f"WARNING: Recording integrity check failed", file=sys.stderr)
            else:
                print(f"ERROR: ffmpeg failed: {result.stderr}", file=sys.stderr)

        except Exception as e:
            print(f"ERROR during compression: {e}", file=sys.stderr)

    def _verify_recording_integrity(self, file_path):
        """
        Verify the recording file is valid and playable.

        Uses ffprobe to check file integrity.

        Returns:
            True if file is valid, False otherwise.
        """
        import subprocess
        import shutil

        # Check if ffprobe is available
        ffprobe_path = shutil.which('ffprobe')
        if not ffprobe_path:
            print(f"  Skipping integrity check (ffprobe not found)", file=sys.stderr)
            return True  # Assume OK if we can't check

        try:
            cmd = [
                ffprobe_path,
                '-v', 'error',
                '-show_format',
                '-show_streams',
                '-of', 'json',
                file_path
            ]

            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=30
            )

            if result.returncode != 0:
                print(f"  Integrity check FAILED: {result.stderr}", file=sys.stderr)
                return False

            # Parse ffprobe output
            probe_data = json.loads(result.stdout)

            # Check for valid format
            if 'format' not in probe_data:
                print(f"  Integrity check FAILED: No format info", file=sys.stderr)
                return False

            # Check for audio stream
            streams = probe_data.get('streams', [])
            audio_streams = [s for s in streams if s.get('codec_type') == 'audio']

            if not audio_streams:
                print(f"  Integrity check FAILED: No audio streams", file=sys.stderr)
                return False

            # Check duration is positive
            duration = float(probe_data['format'].get('duration', 0))
            if duration <= 0:
                print(f"  Integrity check FAILED: Invalid duration ({duration}s)", file=sys.stderr)
                return False

            print(f"  Integrity check: OK ({duration:.1f}s, {audio_streams[0].get('codec_name', 'unknown')})", file=sys.stderr)
            return True

        except subprocess.TimeoutExpired:
            print(f"  Integrity check TIMEOUT", file=sys.stderr)
            return False
        except json.JSONDecodeError as e:
            print(f"  Integrity check ERROR: Invalid ffprobe output: {e}", file=sys.stderr)
            return False
        except Exception as e:
            print(f"  Integrity check ERROR: {e}", file=sys.stderr)
            return False

    def get_audio_levels(self):
        """Get current audio levels for visualization."""
        with self.level_lock:
            # Ensure values are valid floats between 0.0 and 1.0
            mic = max(0.0, min(1.0, float(self.mic_level) if self.mic_level is not None else 0.0))
            desktop = max(0.0, min(1.0, float(self.desktop_level) if self.desktop_level is not None else 0.0))
            return (mic, desktop)

    def is_recording(self):
        """Check if currently recording (thread-safe)."""
        with self._running_lock:
            return self.is_running

    def _set_running(self, value: bool):
        """Set the running state (thread-safe)."""
        with self._running_lock:
            self.is_running = value

    def _get_running(self) -> bool:
        """Get the running state (thread-safe)."""
        with self._running_lock:
            return self.is_running


# CLI interface (same as Windows for consistency)
def main():
    """CLI for the macOS audio recorder."""
    import argparse

    parser = argparse.ArgumentParser(description="macOS Audio Recorder CLI")
    parser.add_argument("--mic", type=int, required=True, help="Microphone device ID")
    parser.add_argument("--loopback", type=int, required=True, help="Desktop audio device ID (reserved for future use)")
    parser.add_argument("--output", required=True, help="Output file path")
    parser.add_argument("--duration", type=int, default=0, help="Duration in seconds (0 for manual stop)")

    args = parser.parse_args()

    # Check Screen Recording permission if desktop capture is available
    if SWIFT_CAPTURE_AVAILABLE or SCREENCAPTURE_AVAILABLE:
        print(f"\nChecking Screen Recording permission...", file=sys.stderr)
        if check_screen_recording_permission():
            print(f"  ✓ Screen Recording permission granted", file=sys.stderr)
        else:
            print(f"  ✗ WARNING: Screen Recording permission may not be granted", file=sys.stderr)
            print(f"  Desktop audio capture may not work", file=sys.stderr)
            print(f"  Grant permission in: System Settings > Privacy & Security > Screen Recording", file=sys.stderr)

        if SWIFT_CAPTURE_AVAILABLE:
            print(f"  Using: Swift audiocapture-helper (native)", file=sys.stderr)
        else:
            print(f"  Using: PyObjC ScreenCaptureKit (fallback)", file=sys.stderr)
    else:
        print(f"\n✗ Desktop audio capture not available", file=sys.stderr)
        print(f"  Neither Swift helper nor PyObjC found", file=sys.stderr)

    # List available devices for reference
    print(f"\nAvailable audio devices:", file=sys.stderr)
    try:
        devices = sd.query_devices()
        for i, dev in enumerate(devices):
            if dev['max_input_channels'] > 0:
                print(f"  [{i}] {dev['name']} ({dev['max_input_channels']} channels)", file=sys.stderr)
        print(f"", file=sys.stderr)
    except Exception as e:
        print(f"  ERROR: Could not enumerate audio devices", file=sys.stderr)
        print(f"  {e}", file=sys.stderr)
        print(f"  Microphone permission may not be granted.", file=sys.stderr)
        print(f"  Grant permission in: System Settings > Privacy & Security > Microphone", file=sys.stderr)
        sys.exit(1)

    # Create recorder
    recorder = MacOSAudioRecorder(
        mic_device_id=args.mic,
        desktop_device_id=args.loopback,
        output_path=args.output,
        preroll_seconds=0  # Production mode: no preroll, countdown in Electron app handles device warm-up
    )

    # Start recording
    recorder.start_recording()

    if args.duration > 0:
        # Fixed duration
        print(f"Recording for {args.duration} seconds...", file=sys.stderr)
        time.sleep(args.duration)
        recorder.stop_recording()
    else:
        # Manual stop (wait for stdin command from Electron)
        print(f"Recording... (send 'stop' to stdin to stop)", file=sys.stderr)

        # Thread to listen for stop command from stdin
        stop_event = threading.Event()
        
        def input_listener():
            """Listen for stop command from Electron via stdin."""
            try:
                for line in sys.stdin:
                    if "stop" in line.strip().lower():
                        stop_event.set()
                        break
            except Exception as e:
                print(f"Error in command listener: {e}", file=sys.stderr)

        input_thread = threading.Thread(target=input_listener, daemon=True)
        input_thread.start()

        # Main loop - continuously send audio levels for visualization
        # PERFORMANCE: 5 FPS updates to minimize CPU/IPC overhead (matches Windows)
        try:
            while not stop_event.is_set() and recorder.is_recording():
                # CHECK FOR ASYNC ERRORS from recording threads
                if recorder._error_event.is_set():
                    with recorder._error_lock:
                        error_msg = recorder._last_error or "Unknown recording error"
                    print(f"CRITICAL: Recording thread error: {error_msg}", file=sys.stderr)
                    _send_json_message({
                        "type": "error",
                        "code": "RECORDING_THREAD_FAILED",
                        "message": error_msg
                    })
                    recorder.stop_recording()
                    break

                # CHECK FOR ASYNC ERRORS from Swift helper
                if recorder.desktop_capture and hasattr(recorder.desktop_capture, 'error_event'):
                    if recorder.desktop_capture.error_event.is_set():
                        error_msg = recorder.desktop_capture.last_error or "Unknown desktop capture error"
                        print(f"CRITICAL: Swift capture failed: {error_msg}", file=sys.stderr)
                        # Send error to Electron (thread-safe)
                        _send_json_message({
                            "type": "error",
                            "code": "DESKTOP_AUDIO_FAILED",
                            "message": f"Desktop audio capture failed: {error_msg}"
                        })
                        recorder.stop_recording()
                        break

                try:
                    # Send audio levels as JSON to stdout (Electron will parse this)
                    mic, desktop = recorder.get_audio_levels()
                    _send_json_message({
                        "type": "levels",
                        "mic": round(mic, 3),
                        "desktop": round(desktop, 3)
                    })
                except Exception as e:
                    # Don't crash recording if visualization fails
                    print(f"Warning: Failed to send audio levels: {e}", file=sys.stderr)

                time.sleep(0.2)  # 5 FPS updates (200ms interval)

            print(f"\nStopping recording...", file=sys.stderr)
            recorder.stop_recording()
        except KeyboardInterrupt:
            print(f"\nCtrl+C received", file=sys.stderr)
            recorder.stop_recording()

    # Output result as JSON for Electron
    # Note: This final result uses the original format without 'type' field
    # for backwards compatibility with existing Electron parsing
    result = {
        'success': True,
        'outputPath': recorder.final_output_path or args.output,
        'duration': recorder.recording_duration
    }
    # Use lock since other threads may still be winding down
    with _stdout_lock:
        print(json.dumps(result), flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
