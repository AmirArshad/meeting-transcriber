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
from datetime import datetime
from pathlib import Path
import numpy as np
from scipy import signal
import pyaudiowpatch as pyaudio


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
        desktop_volume: float = 1.0
    ):
        """Initialize the recorder."""
        self.mic_device_id = mic_device_id
        self.loopback_device_id = loopback_device_id
        self.output_path = output_path
        self.target_sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.mic_volume = mic_volume
        self.desktop_volume = desktop_volume

        self.pa = pyaudio.PyAudio()

        # Get device info
        mic_info = self.pa.get_device_info_by_index(mic_device_id)
        self.mic_sample_rate = int(mic_info['defaultSampleRate'])

        if loopback_device_id >= 0:
            loopback_info = self.pa.get_device_info_by_index(loopback_device_id)
            self.loopback_sample_rate = int(loopback_info['defaultSampleRate'])
            self.mixing_mode = True
        else:
            self.loopback_sample_rate = None
            self.mixing_mode = False

        print(f"Device sample rates:", file=sys.stderr)
        print(f"  Mic: {self.mic_sample_rate} Hz", file=sys.stderr)
        if self.mixing_mode:
            print(f"  Loopback: {self.loopback_sample_rate} Hz", file=sys.stderr)
        print(f"  Target output: {self.target_sample_rate} Hz", file=sys.stderr)

        # Separate frame buffers
        self.mic_frames = []
        self.desktop_frames = []
        self.is_recording = False
        self.lock = threading.Lock()

        # Streams
        self.mic_stream = None
        self.desktop_stream = None

    def _mic_callback(self, in_data, frame_count, time_info, status):
        """Callback for microphone."""
        if status:
            print(f"Mic status: {status}", file=sys.stderr)

        if self.is_recording:
            with self.lock:
                self.mic_frames.append(in_data)

        return (in_data, pyaudio.paContinue)

    def _desktop_callback(self, in_data, frame_count, time_info, status):
        """Callback for desktop audio."""
        if status:
            print(f"Desktop status: {status}", file=sys.stderr)

        if self.is_recording:
            with self.lock:
                self.desktop_frames.append(in_data)

        return (in_data, pyaudio.paContinue)

    def start_recording(self):
        """Start recording from both sources."""
        print("Starting recording...", file=sys.stderr)

        self.is_recording = True

        # Open mic stream
        self.mic_stream = self.pa.open(
            format=pyaudio.paInt16,
            channels=self.channels,
            rate=self.mic_sample_rate,
            input=True,
            input_device_index=self.mic_device_id,
            frames_per_buffer=self.chunk_size,
            stream_callback=self._mic_callback
        )

        if self.mixing_mode:
            # Open desktop stream
            self.desktop_stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=self.channels,
                rate=self.loopback_sample_rate,
                input=True,
                input_device_index=self.loopback_device_id,
                frames_per_buffer=self.chunk_size,
                stream_callback=self._desktop_callback
            )

        # Start streams
        self.mic_stream.start_stream()
        if self.desktop_stream:
            self.desktop_stream.start_stream()

        print("✓ Recording started!", file=sys.stderr)

    def stop_recording(self):
        """Stop recording and mix the audio."""
        print("Stopping recording...", file=sys.stderr)
        self.is_recording = False

        # Stop streams
        if self.mic_stream:
            self.mic_stream.stop_stream()
            self.mic_stream.close()
            self.mic_stream = None

        if self.desktop_stream:
            self.desktop_stream.stop_stream()
            self.desktop_stream.close()
            self.desktop_stream = None

        print(f"✓ Streams stopped", file=sys.stderr)
        print(f"  Mic frames: {len(self.mic_frames)}", file=sys.stderr)
        print(f"  Desktop frames: {len(self.desktop_frames)}", file=sys.stderr)

        # Mix and save
        self._mix_and_save()

        # Clear buffers
        self.mic_frames = []
        self.desktop_frames = []

        print("✓ Recording stopped!", file=sys.stderr)

    def _mix_and_save(self):
        """Mix the two audio sources and save to file."""
        print("Mixing audio...", file=sys.stderr)

        # Convert to numpy arrays
        mic_audio = np.frombuffer(b''.join(self.mic_frames), dtype=np.int16)

        if self.mixing_mode and self.desktop_frames:
            desktop_audio = np.frombuffer(b''.join(self.desktop_frames), dtype=np.int16)

            # Resample both to target rate
            if self.mic_sample_rate != self.target_sample_rate:
                print(f"  Resampling mic: {self.mic_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                mic_audio = self._resample(mic_audio, self.mic_sample_rate, self.target_sample_rate)

            if self.loopback_sample_rate != self.target_sample_rate:
                print(f"  Resampling desktop: {self.loopback_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                desktop_audio = self._resample(desktop_audio, self.loopback_sample_rate, self.target_sample_rate)

            # Align to same length
            min_length = min(len(mic_audio), len(desktop_audio))
            mic_audio = mic_audio[:min_length]
            desktop_audio = desktop_audio[:min_length]

            # Mix
            print("  Mixing mic + desktop...", file=sys.stderr)
            mic_float = mic_audio.astype(np.float32) / 32768.0 * self.mic_volume
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

            final_audio = mic_audio

        # Save to WAV
        print(f"Saving to {self.output_path}...", file=sys.stderr)
        with wave.open(self.output_path, 'wb') as wf:
            wf.setnchannels(self.channels)
            wf.setsampwidth(self.pa.get_sample_size(pyaudio.paInt16))
            wf.setframerate(self.target_sample_rate)
            wf.writeframes(final_audio.tobytes())

        file_size = Path(self.output_path).stat().st_size
        duration = len(final_audio) / (self.target_sample_rate * self.channels)

        print(f"✓ Audio saved!", file=sys.stderr)
        print(f"  File size: {file_size / 1024 / 1024:.2f} MB", file=sys.stderr)
        print(f"  Duration: {duration:.2f} seconds", file=sys.stderr)
        print(f"  Sample rate: {self.target_sample_rate} Hz", file=sys.stderr)

    def _resample(self, audio_data, original_rate, target_rate):
        """Resample audio using scipy."""
        from math import gcd

        divisor = gcd(target_rate, original_rate)
        up = target_rate // divisor
        down = original_rate // divisor

        resampled = signal.resample_poly(audio_data, up, down, window=('kaiser', 5.0))
        return resampled.astype(np.int16)

    def cleanup(self):
        """Clean up resources."""
        if self.pa:
            self.pa.terminate()
            self.pa = None


# Test
if __name__ == "__main__":
    import time

    mic_id = 39
    loopback_id = 41
    duration = 10

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_file = f"test_v2_{timestamp}.wav"

    print("Testing AudioRecorder (post-processing mix)")
    print(f"Duration: {duration} seconds")
    print()

    recorder = AudioRecorder(
        mic_device_id=mic_id,
        loopback_device_id=loopback_id,
        output_path=output_file,
        sample_rate=48000,
        mic_volume=1.0,
        desktop_volume=1.0
    )

    try:
        recorder.start_recording()

        for i in range(duration):
            print(f"  {duration - i} seconds...", end='\r')
            time.sleep(1)

        print()
        recorder.stop_recording()

        print()
        print(f"✓ Test complete: {output_file}")

    finally:
        recorder.cleanup()
