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

            # For now, desktop audio via ScreenCaptureKit is TODO
            # We'll record mic-only until ScreenCaptureKit is implemented
            print(f"", file=sys.stderr)
            print(f"Note: Desktop audio (ScreenCaptureKit) not yet implemented.", file=sys.stderr)
            print(f"Recording microphone only for now.", file=sys.stderr)
            print(f"", file=sys.stderr)

        except Exception as e:
            print(f"Error querying devices: {e}", file=sys.stderr)
            self.is_running = False
            return

        # Start microphone recording thread
        self.mic_thread = threading.Thread(target=self._record_microphone)
        self.mic_thread.daemon = True
        self.mic_thread.start()

        # TODO: Start desktop recording thread when ScreenCaptureKit is implemented
        # self.desktop_thread = threading.Thread(target=self._record_desktop)
        # self.desktop_thread.daemon = True
        # self.desktop_thread.start()

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

        TODO: Implement ScreenCaptureKit integration via PyObjC.
        This requires:
        1. Request Screen Recording permission
        2. Create SCStream with audio capture configuration
        3. Handle audio samples from ScreenCaptureKit
        4. Convert to numpy arrays and store in self.desktop_frames

        References:
        - https://developer.apple.com/documentation/screencapturekit
        - https://github.com/Mnpn/Azayaka (example implementation)
        """
        print(f"Desktop audio recording not yet implemented", file=sys.stderr)
        print(f"TODO: Implement ScreenCaptureKit integration", file=sys.stderr)

        # For now, just sleep to avoid thread termination
        while self.is_running:
            time.sleep(0.1)

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

        # For now, since desktop audio is not implemented, use mic-only
        # TODO: When desktop audio is implemented, mix with mic
        final_audio = mic_audio

        # Convert to stereo if mono
        if mic_channels == 1:
            final_audio = np.column_stack([mic_audio, mic_audio])

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

        Same approach as Windows:
        - Remove DC offset (prevents pops/clicks)
        - Gentle normalization (preserves dynamics)
        - Soft limiting (prevents clipping)
        - 2x gain to make voice prominent
        """
        # Remove DC offset
        audio = audio - np.mean(audio, axis=0)

        # Calculate current peak
        current_peak = np.max(np.abs(audio))

        if current_peak > 0:
            # Gentle normalization (80% of max to preserve dynamics)
            target_peak = 0.8
            if current_peak < target_peak:
                # Boost to target
                gain = target_peak / current_peak
                audio = audio * gain

        # Apply 2x microphone boost (+6dB)
        audio = audio * 2.0

        # Soft limiting (prevent clipping)
        audio = np.tanh(audio * 0.8) * 0.95

        return audio

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

        def wait_for_stop():
            try:
                for line in sys.stdin:
                    if line.strip().lower() == 'stop':
                        print(f"Stop command received", file=sys.stderr)
                        recorder.stop_recording()
                        break
            except:
                pass

        stop_thread = threading.Thread(target=wait_for_stop)
        stop_thread.daemon = True
        stop_thread.start()

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
