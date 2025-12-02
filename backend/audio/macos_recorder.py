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
import soxr

try:
    import sounddevice as sd
except ImportError:
    print("ERROR: sounddevice not installed. Install with: pip install sounddevice", file=sys.stderr)
    sys.exit(1)

# Import ScreenCaptureKit helper (optional - graceful fallback if not available)
try:
    from .screencapture_helper import ScreenCaptureAudioRecorder, check_screen_recording_permission
    SCREENCAPTURE_AVAILABLE = True
except ImportError:
    print("WARNING: ScreenCaptureKit not available (PyObjC not installed)", file=sys.stderr)
    print("  Desktop audio capture will be disabled", file=sys.stderr)
    print("  Install with: pip install pyobjc-framework-ScreenCaptureKit", file=sys.stderr)
    SCREENCAPTURE_AVAILABLE = False

# Store final output path for meeting manager
_final_output_path = None
_recording_duration = 0.0


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
        desktop_volume: float = 1.0
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
        self.mic_frames = []
        self.desktop_frames = []

        # Audio levels for visualization
        self.mic_level = 0.0
        self.desktop_level = 0.0
        self.level_lock = threading.Lock()

        # Threads
        self.mic_thread = None
        self.desktop_thread = None

        # Device info
        self.mic_info = None
        self.desktop_info = None

        # ScreenCaptureKit recorder (for desktop audio)
        self.screencapture_recorder = None
        if SCREENCAPTURE_AVAILABLE:
            try:
                self.screencapture_recorder = ScreenCaptureAudioRecorder(
                    sample_rate=sample_rate,
                    channels=channels
                )
                print(f"  ScreenCaptureKit initialized for desktop audio", file=sys.stderr)
            except Exception as e:
                print(f"  WARNING: Could not initialize ScreenCaptureKit: {e}", file=sys.stderr)
                self.screencapture_recorder = None

        # Pre-roll: discard first ~1.5 seconds (device warm-up)
        self.preroll_frames = int(1.5 * sample_rate / chunk_size)

        print(f"Initialized macOS audio recorder", file=sys.stderr)
        print(f"  Mic device: {mic_device_id}", file=sys.stderr)
        print(f"  Desktop device: {desktop_device_id}", file=sys.stderr)
        print(f"  Sample rate: {sample_rate} Hz", file=sys.stderr)
        print(f"  Output: {output_path}", file=sys.stderr)

    def start_recording(self):
        """Start recording from microphone and desktop (if available)."""
        if self.is_running:
            print("Already recording!", file=sys.stderr)
            return

        self.is_running = True
        self.mic_frames = []
        self.desktop_frames = []

        # Get device info
        try:
            devices = sd.query_devices()
            self.mic_info = devices[self.mic_device_id]
            print(f"Microphone: {self.mic_info['name']}", file=sys.stderr)

            # Desktop audio status
            if self.screencapture_recorder:
                print(f"Desktop audio: ScreenCaptureKit enabled", file=sys.stderr)
            else:
                print(f"Desktop audio: disabled (PyObjC not installed)", file=sys.stderr)

        except Exception as e:
            print(f"Error querying devices: {e}", file=sys.stderr)
            self.is_running = False
            return

        # Start microphone recording thread
        self.mic_thread = threading.Thread(target=self._record_microphone)
        self.mic_thread.daemon = True
        self.mic_thread.start()

        # Start desktop recording if ScreenCaptureKit is available
        if self.screencapture_recorder:
            self.desktop_thread = threading.Thread(target=self._record_desktop)
            self.desktop_thread.daemon = True
            self.desktop_thread.start()
        else:
            print(f"WARNING: Desktop audio capture disabled (ScreenCaptureKit not available)", file=sys.stderr)

        print(f"Recording started...", file=sys.stderr)

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

                # Skip pre-roll frames (device warm-up)
                if frame_count < self.preroll_frames:
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
                while self.is_running:
                    time.sleep(0.1)

            print(f"Mic recording stopped. Frames captured: {len(self.mic_frames)}", file=sys.stderr)

        except Exception as e:
            print(f"ERROR in mic recording: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            self.is_running = False

    def _record_desktop(self):
        """
        Record desktop audio using ScreenCaptureKit.

        Uses the ScreenCaptureAudioRecorder helper to capture system audio output.

        References:
        - https://developer.apple.com/documentation/screencapturekit
        - https://github.com/Mnpn/Azayaka (example implementation)
        """
        if not self.screencapture_recorder:
            print(f"ScreenCaptureKit not available, skipping desktop audio", file=sys.stderr)
            return

        try:
            print(f"Starting ScreenCaptureKit desktop audio capture...", file=sys.stderr)

            # Start ScreenCaptureKit recording
            if not self.screencapture_recorder.start_recording():
                print(f"Failed to start ScreenCaptureKit recording", file=sys.stderr)
                return

            # Monitor audio levels while recording
            while self.is_running:
                # Update desktop audio level from ScreenCaptureKit buffer
                if self.screencapture_recorder.audio_buffer:
                    try:
                        # Get the latest buffer
                        latest_buffer = self.screencapture_recorder.audio_buffer[-1]
                        level = np.max(np.abs(latest_buffer[::8]))  # Subsample for performance

                        with self.level_lock:
                            self.desktop_level = float(level)
                    except Exception:
                        pass  # Ignore errors in level calculation

                time.sleep(0.1)

            print(f"Desktop recording thread stopped", file=sys.stderr)

        except Exception as e:
            print(f"ERROR in desktop recording: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)

    def stop_recording(self):
        """Stop recording and process audio."""
        if not self.is_running:
            print("Not recording!", file=sys.stderr)
            return

        print(f"\nStopping recording...", file=sys.stderr)
        self.is_running = False

        # Wait for threads to finish
        if self.mic_thread:
            self.mic_thread.join(timeout=2.0)
        if self.desktop_thread:
            self.desktop_thread.join(timeout=2.0)

        # Stop ScreenCaptureKit and get desktop audio
        if self.screencapture_recorder:
            desktop_audio = self.screencapture_recorder.stop_recording()
            if desktop_audio is not None:
                # Convert to list of frames for consistency
                self.desktop_frames = [desktop_audio]
                print(f"Retrieved {len(desktop_audio)} desktop audio samples from ScreenCaptureKit", file=sys.stderr)

        # Process and save audio
        print(f"Processing audio...", file=sys.stderr)
        self._process_and_save()

        print(f"Recording complete!", file=sys.stderr)

    def _process_and_save(self):
        """Process recorded audio and save to file."""
        global _final_output_path, _recording_duration

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

            # Convert both to stereo if needed
            if mic_channels == 1:
                mic_audio = np.column_stack([mic_audio, mic_audio])
            if desktop_channels == 1:
                desktop_audio = np.column_stack([desktop_audio, desktop_audio])

            # Resample to match lengths if needed (use high-quality soxr resampling)
            if len(mic_audio) != len(desktop_audio):
                print(f"Resampling to match lengths: mic={len(mic_audio)}, desktop={len(desktop_audio)}", file=sys.stderr)

                target_length = max(len(mic_audio), len(desktop_audio))

                # Use soxr for high-quality resampling (VHQ quality - matches Windows)
                if len(mic_audio) < target_length:
                    ratio = target_length / len(mic_audio)
                    mic_audio = soxr.resample(
                        mic_audio,
                        self.sample_rate,
                        int(self.sample_rate * ratio),
                        quality='VHQ'  # Very High Quality - best algorithm
                    )
                    # Trim to exact length (resampling may overshoot slightly)
                    mic_audio = mic_audio[:target_length]
                elif len(desktop_audio) < target_length:
                    ratio = target_length / len(desktop_audio)
                    desktop_audio = soxr.resample(
                        desktop_audio,
                        self.sample_rate,
                        int(self.sample_rate * ratio),
                        quality='VHQ'  # Very High Quality - best algorithm
                    )
                    # Trim to exact length
                    desktop_audio = desktop_audio[:target_length]

            # Mix: apply volumes and add
            final_audio = (mic_audio * self.mic_volume) + (desktop_audio * self.desktop_volume)
            print(f"Mixed audio: {len(final_audio)} samples", file=sys.stderr)

        else:
            # Mic-only mode
            print(f"No desktop audio captured, using mic-only", file=sys.stderr)

            # Convert to stereo if mono
            if mic_channels == 1:
                final_audio = np.column_stack([mic_audio, mic_audio])
            else:
                final_audio = mic_audio

            # Apply mic volume
            final_audio = final_audio * self.mic_volume

        # Enhance microphone audio (same as Windows)
        final_audio = self._enhance_microphone(final_audio)

        # Save as temporary WAV file
        temp_wav_path = self.output_path.replace('.opus', '_temp.wav')
        self._save_wav(final_audio, temp_wav_path)

        # Compress with ffmpeg (same as Windows)
        self._compress_with_ffmpeg(temp_wav_path, self.output_path)

        # Clean up temp file
        try:
            Path(temp_wav_path).unlink()
        except:
            pass

        # Set globals for meeting manager
        _final_output_path = self.output_path
        duration_seconds = len(final_audio) / self.sample_rate
        _recording_duration = duration_seconds

        print(f"Final file: {self.output_path}", file=sys.stderr)
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
            else:
                print(f"ERROR: ffmpeg failed: {result.stderr}", file=sys.stderr)

        except Exception as e:
            print(f"ERROR during compression: {e}", file=sys.stderr)

    def get_audio_levels(self):
        """Get current audio levels for visualization."""
        with self.level_lock:
            return (self.mic_level, self.desktop_level)

    def is_recording(self):
        """Check if currently recording."""
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

    # Check Screen Recording permission if ScreenCaptureKit is available
    if SCREENCAPTURE_AVAILABLE:
        print(f"\nChecking Screen Recording permission...", file=sys.stderr)
        if check_screen_recording_permission():
            print(f"  ✓ Screen Recording permission granted", file=sys.stderr)
        else:
            print(f"  ✗ WARNING: Screen Recording permission not granted", file=sys.stderr)
            print(f"  Desktop audio capture will not work", file=sys.stderr)
            print(f"  Grant permission in: System Settings > Privacy & Security > Screen Recording", file=sys.stderr)
    else:
        print(f"\n✗ ScreenCaptureKit not available (PyObjC not installed)", file=sys.stderr)
        print(f"  Desktop audio capture disabled", file=sys.stderr)

    # List available devices for reference
    print(f"\nAvailable audio devices:", file=sys.stderr)
    devices = sd.query_devices()
    for i, dev in enumerate(devices):
        if dev['max_input_channels'] > 0:
            print(f"  [{i}] {dev['name']} ({dev['max_input_channels']} channels)", file=sys.stderr)
    print(f"", file=sys.stderr)

    # Create recorder
    recorder = MacOSAudioRecorder(
        mic_device_id=args.mic,
        desktop_device_id=args.loopback,
        output_path=args.output
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

        def wait_for_commands():
            """Listen for commands from Electron via stdin."""
            try:
                for line in sys.stdin:
                    command = line.strip().lower()
                    if command == 'stop':
                        print(f"Stop command received", file=sys.stderr)
                        recorder.stop_recording()
                        break
                    elif command == 'get_levels':
                        # Send audio levels as JSON to stdout
                        levels = recorder.get_audio_levels()
                        print(json.dumps(levels))
                        sys.stdout.flush()
            except Exception as e:
                print(f"Error in command listener: {e}", file=sys.stderr)

        command_thread = threading.Thread(target=wait_for_commands)
        command_thread.daemon = True
        command_thread.start()

        # Also support Ctrl+C
        try:
            while recorder.is_running:
                # Print levels every second for debugging
                mic, desktop = recorder.get_audio_levels()
                print(f"Levels - Mic: {mic:.3f}, Desktop: {desktop:.3f}", file=sys.stderr)
                time.sleep(1.0)
        except KeyboardInterrupt:
            print(f"\nCtrl+C received", file=sys.stderr)
            recorder.stop_recording()

    # Output result as JSON for Electron
    result = {
        'success': True,
        'outputPath': _final_output_path or args.output,
        'duration': _recording_duration
    }

    print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    main()
