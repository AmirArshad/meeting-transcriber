"""
Audio Recorder - Records audio from microphone and desktop simultaneously.
Uses WASAPI loopback for desktop audio capture and mixes both streams.
"""

import wave
import sys
import threading
import argparse
import json
from pathlib import Path
from datetime import datetime
from typing import Optional

try:
    import pyaudiowpatch as pyaudio
    import numpy as np
    from scipy import signal
except ImportError as e:
    print(f"ERROR: Missing dependency: {e}", file=sys.stderr)
    print("Run: pip install pyaudiowpatch numpy scipy", file=sys.stderr)
    sys.exit(1)


class AudioRecorder:
    """Records and mixes audio from microphone and desktop loopback."""

    def __init__(
        self,
        mic_device_id: int,
        loopback_device_id: int,
        output_path: str,
        sample_rate: int = 48000,
        channels: int = 2,
        chunk_size: int = 4096,  # Increased from 1024 for better stability
        mic_volume: float = 1.0,  # Full volume by default
        desktop_volume: float = 1.0  # Full volume by default
    ):
        """
        Initialize the audio recorder.

        Args:
            mic_device_id: Device ID for microphone input
            loopback_device_id: Device ID for desktop audio loopback
            output_path: Path to save the recorded audio file (.wav)
            sample_rate: Target output sample rate in Hz (default: 48000)
            channels: Number of audio channels (default: 2 for stereo)
            chunk_size: Audio buffer size in frames
            mic_volume: Volume multiplier for microphone (0.0 to 1.0)
            desktop_volume: Volume multiplier for desktop audio (0.0 to 1.0)
        """
        self.mic_device_id = mic_device_id
        self.loopback_device_id = loopback_device_id
        self.output_path = output_path
        self.target_sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.mic_volume = mic_volume
        self.desktop_volume = desktop_volume

        self.pa = pyaudio.PyAudio()

        # Get actual device sample rates
        mic_info = self.pa.get_device_info_by_index(mic_device_id)
        self.mic_sample_rate = int(mic_info['defaultSampleRate'])

        # Only get loopback info if device is valid
        if loopback_device_id is not None and loopback_device_id >= 0:
            loopback_info = self.pa.get_device_info_by_index(loopback_device_id)
            self.loopback_sample_rate = int(loopback_info['defaultSampleRate'])
        else:
            self.loopback_sample_rate = None

        print(f"Device sample rates:", file=sys.stderr)
        print(f"  Mic: {self.mic_sample_rate} Hz", file=sys.stderr)
        if self.loopback_sample_rate:
            print(f"  Loopback: {self.loopback_sample_rate} Hz", file=sys.stderr)
        else:
            print(f"  Loopback: DISABLED", file=sys.stderr)
        print(f"  Target output: {self.target_sample_rate} Hz", file=sys.stderr)

        # Determine output sample rate
        if self.loopback_sample_rate is None:
            # Mic-only mode - use mic's native rate
            self.sample_rate = self.mic_sample_rate
            print(f"  Mic-only mode - using {self.sample_rate} Hz", file=sys.stderr)
        elif self.mic_sample_rate == self.loopback_sample_rate:
            # Both devices match - no resampling needed
            self.sample_rate = self.mic_sample_rate
            print(f"  Both devices match - no resampling needed!", file=sys.stderr)
        else:
            # Different rates - use HIGHER rate to preserve desktop audio quality
            # Desktop audio quality is more important than mic upsampling artifacts
            self.sample_rate = max(self.mic_sample_rate, self.loopback_sample_rate)
            print(f"  Mixed rates detected - using HIGHER rate {self.sample_rate} Hz", file=sys.stderr)
            print(f"  Mic will be upsampled from {self.mic_sample_rate} Hz", file=sys.stderr)

        self.is_recording = False
        self.mixing_mode = False  # Will be set to True if using desktop audio
        self.frames = []
        self.lock = threading.Lock()

        # Streams
        self.mic_stream = None
        self.loopback_stream = None
        self.mixer_thread = None

        # Buffers for synchronization
        self.mic_buffer = []
        self.desktop_buffer = []

        # Track actual recording sample rate (set during recording)
        self.actual_sample_rate = self.sample_rate

    def _mic_callback(self, in_data, frame_count, time_info, status):
        """Callback for microphone audio stream."""
        if status:
            print(f"Mic callback status: {status}", file=sys.stderr)

        # Debug: Log callback invocation
        if len(self.frames) == 0 and len(self.mic_buffer) == 0:
            print(f"DEBUG: First mic callback - is_recording={self.is_recording}, mixing_mode={self.mixing_mode}", file=sys.stderr)

        if self.is_recording:
            if not self.mixing_mode:
                # Mic-only: direct recording - store raw bytes, no processing (just like test_mic_only.py)
                self.frames.append(in_data)
                if len(self.frames) == 1:
                    print(f"✓ Mic: Recording directly (raw bytes, no processing)", file=sys.stderr)
                elif len(self.frames) % 100 == 0:
                    print(f"  Mic: {len(self.frames)} frames captured...", file=sys.stderr)
            else:
                # Mixing mode: use buffer for the mixer thread
                audio_data = np.frombuffer(in_data, dtype=np.int16)
                with self.lock:
                    self.mic_buffer.append(audio_data)
                    if len(self.mic_buffer) == 1:
                        print(f"✓ Mic: First audio chunk buffered for mixing", file=sys.stderr)

        return (in_data, pyaudio.paContinue)

    def _loopback_callback(self, in_data, frame_count, time_info, status):
        """Callback for desktop audio loopback stream."""
        if status:
            print(f"Loopback status: {status}", file=sys.stderr)

        if self.is_recording:
            # Convert bytes to numpy array
            audio_data = np.frombuffer(in_data, dtype=np.int16)
            with self.lock:
                self.desktop_buffer.append(audio_data)
                if len(self.desktop_buffer) == 1:  # First chunk received
                    print(f"✓ Desktop: First audio chunk received ({len(audio_data)} samples)", file=sys.stderr)

        return (in_data, pyaudio.paContinue)

    def _resample(self, audio_data: np.ndarray, original_rate: int, target_rate: int) -> np.ndarray:
        """
        Resample audio data to target sample rate using high-quality polyphase filtering.

        Args:
            audio_data: Input audio as numpy array
            original_rate: Original sample rate
            target_rate: Target sample rate

        Returns:
            Resampled audio data
        """
        if original_rate == target_rate:
            return audio_data

        # Use scipy's polyphase resampling for high quality
        # resample_poly uses polyphase filtering which is much better than linear interpolation
        from math import gcd

        # Simplify the ratio to avoid huge intermediate arrays
        divisor = gcd(target_rate, original_rate)
        up = target_rate // divisor
        down = original_rate // divisor

        # Perform resampling with Kaiser window for better quality
        # Kaiser window reduces artifacts and provides smoother frequency response
        resampled = signal.resample_poly(audio_data, up, down, window=('kaiser', 5.0))

        return resampled.astype(audio_data.dtype)

    def _mixer_thread(self):
        """Background thread that mixes mic and desktop audio."""
        import time
        print("Mixer thread started", file=sys.stderr)
        mixed_count = 0
        mic_only_count = 0
        desktop_only_count = 0

        while self.is_recording:
            # Check buffer status without lock first
            has_data = False

            with self.lock:
                # Prevent buffer overflow - drop old chunks if buffer gets too large
                MAX_BUFFER_SIZE = 20  # Keep max 20 chunks (~0.5 seconds at 4096 chunk size)
                if len(self.mic_buffer) > MAX_BUFFER_SIZE:
                    dropped = len(self.mic_buffer) - MAX_BUFFER_SIZE
                    self.mic_buffer = self.mic_buffer[-MAX_BUFFER_SIZE:]
                    if dropped > 0:
                        print(f"⚠ Dropped {dropped} old mic chunks (buffer overflow)", file=sys.stderr)

                if len(self.desktop_buffer) > MAX_BUFFER_SIZE:
                    dropped = len(self.desktop_buffer) - MAX_BUFFER_SIZE
                    self.desktop_buffer = self.desktop_buffer[-MAX_BUFFER_SIZE:]
                    if dropped > 0:
                        print(f"⚠ Dropped {dropped} old desktop chunks (buffer overflow)", file=sys.stderr)

                # Try to mix both sources if available
                if self.mic_buffer and self.desktop_buffer:
                    has_data = True
                    mic_chunk = self.mic_buffer.pop(0)
                    desktop_chunk = self.desktop_buffer.pop(0)

                    # Resample if needed
                    if self.mic_sample_rate != self.sample_rate:
                        mic_chunk = self._resample(mic_chunk, self.mic_sample_rate, self.sample_rate)

                    if self.loopback_sample_rate != self.sample_rate:
                        desktop_chunk = self._resample(desktop_chunk, self.loopback_sample_rate, self.sample_rate)

                    # Ensure both chunks are the same length
                    min_length = min(len(mic_chunk), len(desktop_chunk))
                    mic_chunk = mic_chunk[:min_length]
                    desktop_chunk = desktop_chunk[:min_length]

                    # Convert to float32 for mixing (normalize to -1.0 to 1.0 range)
                    mic_float = mic_chunk.astype(np.float32) / 32768.0
                    desktop_float = desktop_chunk.astype(np.float32) / 32768.0

                    # Individual channel normalization (subtle - only boost very quiet signals)
                    mic_rms = np.sqrt(np.mean(mic_float**2))
                    desktop_rms = np.sqrt(np.mean(desktop_float**2))

                    # Only boost if quieter than 0.05 RMS (very quiet)
                    if mic_rms > 0.001 and mic_rms < 0.05:
                        mic_gain = min(0.1 / mic_rms, 2.0)  # Gentle boost, max 2x
                        mic_float = mic_float * mic_gain

                    if desktop_rms > 0.001 and desktop_rms < 0.05:
                        desktop_gain = min(0.1 / desktop_rms, 2.0)  # Gentle boost, max 2x
                        desktop_float = desktop_float * desktop_gain

                    # Apply user volume settings
                    mic_float = mic_float * self.mic_volume
                    desktop_float = desktop_float * self.desktop_volume

                    # Mix the audio (simple addition)
                    mixed = mic_float + desktop_float

                    # Apply soft limiting to prevent harsh clipping
                    max_val = np.max(np.abs(mixed))
                    if max_val > 1.0:
                        # Soft compression when signal is too loud
                        mixed = np.tanh(mixed * 0.85)

                    # Convert back to int16 with proper scaling
                    mixed = (mixed * 32767.0).astype(np.int16)

                    # Store mixed audio
                    self.frames.append(mixed.tobytes())

                    mixed_count += 1
                    if mixed_count == 1:
                        print(f"✓ Mixer: First mixed chunk created (mic + desktop)", file=sys.stderr)

                # Fallback: Use mic-only if desktop is not available
                elif self.mic_buffer:
                    has_data = True
                    mic_chunk = self.mic_buffer.pop(0)

                    # IMPORTANT: Resample to target rate to maintain consistent output
                    if self.mic_sample_rate != self.sample_rate:
                        mic_chunk = self._resample(mic_chunk, self.mic_sample_rate, self.sample_rate)

                    # Apply volume
                    audio = (mic_chunk.astype(np.float32) * self.mic_volume).clip(-32768, 32767).astype(np.int16)

                    self.frames.append(audio.tobytes())

                    mic_only_count += 1
                    if mic_only_count == 1:
                        print(f"⚠ Mixer: Desktop buffer empty, using mic-only (resampled to {self.sample_rate} Hz)", file=sys.stderr)

                # Fallback: Use desktop-only if mic is not available
                elif self.desktop_buffer:
                    has_data = True
                    desktop_chunk = self.desktop_buffer.pop(0)

                    # IMPORTANT: Resample to target rate to maintain consistent output
                    if self.loopback_sample_rate != self.sample_rate:
                        desktop_chunk = self._resample(desktop_chunk, self.loopback_sample_rate, self.sample_rate)

                    # Apply volume
                    audio = (desktop_chunk.astype(np.float32) * self.desktop_volume).clip(-32768, 32767).astype(np.int16)

                    self.frames.append(audio.tobytes())

                    desktop_only_count += 1
                    if desktop_only_count == 1:
                        print(f"⚠ Mixer: Mic buffer empty, using desktop-only (resampled to {self.sample_rate} Hz)", file=sys.stderr)

            # Only sleep if no data was processed (prevents CPU spinning when buffers empty)
            if not has_data:
                time.sleep(0.001)

        total_frames = len(self.frames)
        print(f"Mixer thread stopped:", file=sys.stderr)
        print(f"  Mixed chunks: {mixed_count}", file=sys.stderr)
        print(f"  Mic-only chunks: {mic_only_count}", file=sys.stderr)
        print(f"  Desktop-only chunks: {desktop_only_count}", file=sys.stderr)
        print(f"  Total frames: {total_frames}", file=sys.stderr)

    def start_recording(self):
        """Start recording audio from both microphone and desktop."""
        if self.is_recording:
            print("Already recording!", file=sys.stderr)
            return

        print(f"Starting recording...", file=sys.stderr)
        print(f"  Microphone device: {self.mic_device_id}", file=sys.stderr)
        print(f"  Loopback device: {self.loopback_device_id}", file=sys.stderr)
        print(f"  Output: {self.output_path}", file=sys.stderr)
        print(f"  Sample rate: {self.sample_rate} Hz", file=sys.stderr)
        print(f"  Channels: {self.channels}", file=sys.stderr)

        try:
            # Determine mode BEFORE opening streams (fix race condition)
            if self.loopback_device_id is not None and self.loopback_device_id >= 0:
                # Mixing mode - will need mixer thread
                self.mixing_mode = True
                self.actual_sample_rate = self.sample_rate
                print(f"✓ Mixing mode: Will mix mic + desktop at {self.actual_sample_rate} Hz", file=sys.stderr)
            else:
                # Mic-only mode - direct recording
                self.mixing_mode = False
                self.actual_sample_rate = self.mic_sample_rate
                print(f"✓ Mic-only mode: Recording directly at {self.actual_sample_rate} Hz (no mixer thread)", file=sys.stderr)

            # Open microphone stream with its native sample rate
            self.mic_stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=self.channels,
                rate=self.mic_sample_rate,
                input=True,
                input_device_index=self.mic_device_id,
                frames_per_buffer=self.chunk_size,
                stream_callback=self._mic_callback
            )

            # Only open loopback stream if device ID is valid
            if self.mixing_mode:
                # Open loopback stream with its native sample rate
                self.loopback_stream = self.pa.open(
                    format=pyaudio.paInt16,
                    channels=self.channels,
                    rate=self.loopback_sample_rate,
                    input=True,
                    input_device_index=self.loopback_device_id,
                    frames_per_buffer=self.chunk_size,
                    stream_callback=self._loopback_callback
                )
                # Start mixer thread
                self.mixer_thread = threading.Thread(target=self._mixer_thread, daemon=True)
                self.mixer_thread.start()
            else:
                self.loopback_stream = None
                self.mixer_thread = None

            self.is_recording = True

            # Start streams
            self.mic_stream.start_stream()
            if self.loopback_stream:
                self.loopback_stream.start_stream()

            print("Recording started!", file=sys.stderr)
            print(json.dumps({"status": "recording", "timestamp": datetime.now().isoformat()}))

        except Exception as e:
            print(f"ERROR starting recording: {e}", file=sys.stderr)
            self.stop_recording()
            raise

    def stop_recording(self):
        """Stop recording and save the audio file."""
        if not self.is_recording:
            print("Not currently recording", file=sys.stderr)
            return

        print("Stopping recording...", file=sys.stderr)
        self.is_recording = False

        # Stop and close streams
        if self.mic_stream:
            self.mic_stream.stop_stream()
            self.mic_stream.close()
            self.mic_stream = None

        if self.loopback_stream:
            self.loopback_stream.stop_stream()
            self.loopback_stream.close()
            self.loopback_stream = None

        # Wait for mixer thread to finish (if it exists)
        if hasattr(self, 'mixer_thread') and self.mixer_thread is not None:
            print("Waiting for mixer thread to finish...", file=sys.stderr)
            self.mixer_thread.join(timeout=2.0)

        # Save to WAV file
        self._save_wav()

        # Clear buffers
        self.frames = []
        self.mic_buffer = []
        self.desktop_buffer = []

        print("Recording stopped!", file=sys.stderr)

    def _save_wav(self):
        """Save recorded frames to WAV file."""
        if not self.frames:
            print("WARNING: No audio data recorded", file=sys.stderr)
            print(f"  Mic buffer had: {len(self.mic_buffer)} chunks", file=sys.stderr)
            print(f"  Desktop buffer had: {len(self.desktop_buffer)} chunks", file=sys.stderr)
            return

        print(f"Saving audio to {self.output_path}...", file=sys.stderr)
        print(f"  Total frames to save: {len(self.frames)}", file=sys.stderr)

        try:
            # Create output directory if needed
            Path(self.output_path).parent.mkdir(parents=True, exist_ok=True)

            # Write WAV file
            with wave.open(self.output_path, 'wb') as wf:
                wf.setnchannels(self.channels)
                wf.setsampwidth(self.pa.get_sample_size(pyaudio.paInt16))
                wf.setframerate(self.actual_sample_rate)  # Use actual recording rate, not target
                wf.writeframes(b''.join(self.frames))

            # Get file size
            file_size = Path(self.output_path).stat().st_size
            duration = len(self.frames) * self.chunk_size / self.actual_sample_rate

            print(f"Audio saved successfully!", file=sys.stderr)
            print(f"  File size: {file_size / 1024 / 1024:.2f} MB", file=sys.stderr)
            print(f"  Duration: {duration:.2f} seconds", file=sys.stderr)
            print(f"  Sample rate: {self.actual_sample_rate} Hz", file=sys.stderr)

            # Output JSON for IPC
            print(json.dumps({
                "status": "saved",
                "path": self.output_path,
                "size_bytes": file_size,
                "duration_seconds": duration,
                "timestamp": datetime.now().isoformat()
            }))

        except Exception as e:
            print(f"ERROR saving audio: {e}", file=sys.stderr)
            raise

    def cleanup(self):
        """Clean up resources."""
        if self.is_recording:
            self.stop_recording()

        if hasattr(self, 'pa'):
            self.pa.terminate()


def main():
    """Command-line interface for testing audio recording."""
    parser = argparse.ArgumentParser(description="Record audio from microphone and desktop")
    parser.add_argument("--mic", type=int, required=True, help="Microphone device ID")
    parser.add_argument("--loopback", type=int, required=True, help="Loopback device ID")
    parser.add_argument("--output", type=str, default=None, help="Output file path (.wav)")
    parser.add_argument("--duration", type=int, default=10, help="Recording duration in seconds")
    parser.add_argument("--sample-rate", type=int, default=48000, help="Sample rate (Hz)")
    parser.add_argument("--mic-volume", type=float, default=0.7, help="Microphone volume (0.0-1.0)")
    parser.add_argument("--desktop-volume", type=float, default=0.5, help="Desktop audio volume (0.0-1.0)")

    args = parser.parse_args()

    # Generate default output path if not specified
    if args.output is None:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        args.output = f"recording_{timestamp}.wav"

    print(f"\n{'='*60}", file=sys.stderr)
    print("Audio Recorder - Test Mode", file=sys.stderr)
    print(f"{'='*60}\n", file=sys.stderr)

    # Create recorder
    recorder = AudioRecorder(
        mic_device_id=args.mic,
        loopback_device_id=args.loopback,
        output_path=args.output,
        sample_rate=args.sample_rate,
        mic_volume=args.mic_volume,
        desktop_volume=args.desktop_volume
    )

    try:
        # Start recording
        recorder.start_recording()

        # Record for specified duration
        import time
        print(f"\nRecording for {args.duration} seconds...", file=sys.stderr)
        for i in range(args.duration):
            time.sleep(1)
            print(f"  {i+1}/{args.duration} seconds", file=sys.stderr)

        # Stop recording
        recorder.stop_recording()

        print(f"\n{'='*60}", file=sys.stderr)
        print("Recording completed successfully!", file=sys.stderr)
        print(f"{'='*60}\n", file=sys.stderr)

    except KeyboardInterrupt:
        print("\nRecording interrupted by user", file=sys.stderr)
        recorder.stop_recording()
    except Exception as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        recorder.cleanup()


if __name__ == "__main__":
    main()
