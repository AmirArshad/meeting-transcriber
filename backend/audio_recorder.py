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
        desktop_volume: float = 1.0
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
        self.mic_sample_rate = int(mic_info['defaultSampleRate'])
        self.mic_channels = int(mic_info['maxInputChannels'])

        if loopback_device_id >= 0:
            loopback_info = self.pa.get_device_info_by_index(loopback_device_id)
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

        # Open mic stream with error handling
        try:
            self.mic_stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=self.mic_channels,  # Use detected channel count
                rate=self.mic_sample_rate,
                input=True,
                input_device_index=self.mic_device_id,
                frames_per_buffer=self.chunk_size,
                stream_callback=self._mic_callback
            )
            print(f"✓ Microphone stream opened successfully", file=sys.stderr)
        except Exception as e:
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

        print("Recording started!", file=sys.stderr)

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

        print(f"Streams stopped", file=sys.stderr)
        print(f"  Mic frames: {len(self.mic_frames)}", file=sys.stderr)
        print(f"  Desktop frames: {len(self.desktop_frames)}", file=sys.stderr)

        # Mix and save
        self._mix_and_save()

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

        if self.mixing_mode and self.desktop_frames:
            desktop_audio = np.frombuffer(b''.join(self.desktop_frames), dtype=np.int16)

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

            # Convert mono loopback to stereo if needed (rare but possible)
            if self.loopback_channels == 1 and self.target_channels == 2:
                print(f"  Converting desktop audio from mono to stereo...", file=sys.stderr)
                desktop_audio = np.repeat(desktop_audio, 2)

            # Align to same length
            min_length = min(len(mic_audio), len(desktop_audio))
            mic_audio = mic_audio[:min_length]
            desktop_audio = desktop_audio[:min_length]

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

        duration = len(final_audio) / (self.target_sample_rate * self.target_channels)

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
        print(f"Compressing with ffmpeg (96 kbps Opus)...", file=sys.stderr)
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

        # Use Opus codec at 96 kbps (excellent quality for speech, ~12x smaller than WAV)
        # Opus is better than MP3 for speech and produces smaller files
        cmd = [
            'ffmpeg',
            '-i', input_path,
            '-c:a', 'libopus',
            '-b:a', '96k',
            '-vbr', 'on',  # Variable bitrate for better quality
            '-application', 'voip',  # Optimized for speech
            '-y',  # Overwrite output
            '-loglevel', 'error',  # Only show errors
            opus_path
        ]

        try:
            result = subprocess.run(cmd, check=True, capture_output=True)
            return opus_path
        except subprocess.CalledProcessError as e:
            print(f"Warning: ffmpeg compression failed: {e.stderr.decode()}", file=sys.stderr)
            print(f"Falling back to WAV format...", file=sys.stderr)
            # If ffmpeg fails, just copy the temp WAV to output
            import shutil
            shutil.copy(input_path, output_path)
            return output_path

    def _enhance_microphone(self, audio_data, sample_rate):
        """
        Apply natural-sounding enhancement to microphone audio.

        Optimized for listening quality (not just transcription):
        1. Gentle high-pass filter (50 Hz) - Remove only deep rumble, preserve warmth
        2. Voice frequency boost (1-3 kHz) - Enhance speech clarity naturally
        3. Gentle low-pass filter (8 kHz) - Reduce tinny high-frequency harshness
        4. Very light noise gate - Preserve natural sound
        5. Gentle compression - Even out volume without artifacts
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
        Process a single audio channel for natural, broadcast-quality sound.

        Goal: Warm, clear, natural voice - not robotic or tinny.
        """
        from scipy.signal import butter, filtfilt

        nyquist = sample_rate / 2

        # 1. GENTLE High-pass filter - Remove only deep rumble (50 Hz)
        # Lower cutoff = preserve more warmth in voice
        cutoff_hp = 50 / nyquist
        if cutoff_hp < 1.0:
            b, a = butter(2, cutoff_hp, btype='high')  # 2nd order = gentler roll-off
            channel_data = filtfilt(b, a, channel_data)

        # 2. VOICE CLARITY BOOST - Enhance 1-3 kHz (speech intelligibility range)
        # This makes voice sound clearer without harshness
        voice_low = 1000 / nyquist
        voice_high = 3000 / nyquist
        if voice_low < 1.0 and voice_high < 1.0:
            # Bandpass filter for voice frequencies
            b, a = butter(2, [voice_low, voice_high], btype='band')
            voice_band = filtfilt(b, a, channel_data)
            # Boost voice frequencies by 20% (subtle enhancement)
            channel_data = channel_data + (voice_band * 0.2)

        # 3. GENTLE Low-pass filter - Remove harsh high frequencies (8 kHz)
        # This eliminates the "tinny" sound
        cutoff_lp = 8000 / nyquist
        if cutoff_lp < 1.0:
            b, a = butter(2, cutoff_lp, btype='low')  # 2nd order = smooth
            channel_data = filtfilt(b, a, channel_data)

        # 4. VERY LIGHT Noise gate - Preserve natural ambience
        rms = np.sqrt(np.mean(channel_data ** 2))
        threshold = rms * 0.05  # Only gate very quiet noise (5% of RMS)
        gate_ratio = 1.5  # Minimal reduction (was 2.0)

        mask = np.abs(channel_data) < threshold
        channel_data[mask] = channel_data[mask] / gate_ratio

        # 5. GENTLE Compression - Even out levels naturally
        # Broadcast-style compression: gentle ratio, high threshold
        compression_threshold = 0.3  # -10.5 dB (higher = less compression)
        compression_ratio = 1.3  # Very gentle (was 1.5)

        abs_data = np.abs(channel_data)
        above_threshold = abs_data > compression_threshold

        compressed = channel_data.copy()
        compressed[above_threshold] = np.sign(channel_data[above_threshold]) * (
            compression_threshold +
            (abs_data[above_threshold] - compression_threshold) / compression_ratio
        )

        # 6. Moderate makeup gain - Boost to comfortable listening level
        compressed = compressed * 1.4  # Slightly less aggressive (was 1.5)

        # 7. Soft limiting - Prevent clipping without harshness
        max_val = np.max(np.abs(compressed))
        if max_val > 0.9:
            # Soft knee limiting
            compressed = np.tanh(compressed * 1.1) * 0.85

        return compressed

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
        sample_rate=48000
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
            while not stop_event.is_set():
                time.sleep(0.1)
            
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
