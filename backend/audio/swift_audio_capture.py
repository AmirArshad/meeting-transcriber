"""
Swift AudioCaptureHelper integration for macOS desktop audio capture.

This module interfaces with the native Swift audiocapture-helper binary
to capture desktop audio using ScreenCaptureKit. This bypasses PyObjC
compatibility issues on macOS 15+.

The Swift helper:
- Uses ScreenCaptureKit directly (native Swift, not PyObjC)
- Outputs raw PCM float32 audio to stdout
- Outputs JSON status messages to stderr
- Accepts "stop" command on stdin
"""

import sys
import subprocess
import threading
import json
import struct
import numpy as np
from pathlib import Path
from typing import Optional, Callable


def get_audiocapture_helper_path() -> Optional[Path]:
    """
    Find the audiocapture-helper binary.

    Searches in order:
    1. Bundled in Electron app resources
    2. Development path (swift/AudioCaptureHelper/.build/release)
    3. System PATH

    Returns:
        Path to the binary, or None if not found
    """
    import shutil

    # Check for bundled binary in Electron app
    # When running in Electron, __file__ is in resources/backend/audio/
    current_dir = Path(__file__).parent
    possible_paths = [
        # Bundled in Electron app (macOS .app bundle)
        current_dir.parent.parent.parent / "bin" / "audiocapture-helper",
        # Bundled in resources
        current_dir.parent.parent / "bin" / "audiocapture-helper",
        # Development path (Swift Package Manager build)
        current_dir.parent.parent.parent / "swift" / "AudioCaptureHelper" / ".build" / "release" / "audiocapture-helper",
        current_dir.parent.parent.parent / "swift" / "AudioCaptureHelper" / ".build" / "arm64-apple-macosx" / "release" / "audiocapture-helper",
    ]

    for path in possible_paths:
        if path.exists() and path.is_file():
            print(f"Found audiocapture-helper at: {path}", file=sys.stderr)
            return path

    # Check system PATH
    which_path = shutil.which("audiocapture-helper")
    if which_path:
        print(f"Found audiocapture-helper in PATH: {which_path}", file=sys.stderr)
        return Path(which_path)

    print(f"audiocapture-helper not found. Searched:", file=sys.stderr)
    for p in possible_paths:
        print(f"  - {p}", file=sys.stderr)

    return None


class SwiftAudioCapture:
    """
    Captures desktop audio using the native Swift audiocapture-helper.

    This class spawns the Swift binary as a subprocess and reads
    raw PCM float32 audio data from its stdout.
    """

    def __init__(
        self,
        sample_rate: int = 48000,
        channels: int = 2,
        helper_path: Optional[Path] = None
    ):
        """
        Initialize the Swift audio capture.

        Args:
            sample_rate: Sample rate in Hz (default: 48000)
            channels: Number of audio channels (default: 2)
            helper_path: Optional path to audiocapture-helper binary
        """
        self.sample_rate = sample_rate
        self.channels = channels
        self.helper_path = helper_path or get_audiocapture_helper_path()

        self.process: Optional[subprocess.Popen] = None
        self.audio_buffer: list = []
        self.buffer_lock = threading.Lock()
        self.is_recording = False
        self.is_ready = False

        self._stdout_thread: Optional[threading.Thread] = None

        self._stderr_thread: Optional[threading.Thread] = None
        
        # Error signaling
        self.error_event = threading.Event()
        self.last_error = None

    def is_available(self) -> bool:
        """Check if the Swift helper is available."""
        return self.helper_path is not None and self.helper_path.exists()

    def start_recording(self) -> bool:
        """
        Start capturing desktop audio.

        Returns:
            True if capture started successfully, False otherwise
        """
        if not self.is_available():
            print("ERROR: audiocapture-helper not available", file=sys.stderr)
            return False

        if self.is_recording:
            print("Already recording", file=sys.stderr)
            return True

        print(f"Starting Swift audio capture...", file=sys.stderr)
        print(f"  Helper: {self.helper_path}", file=sys.stderr)
        print(f"  Sample rate: {self.sample_rate} Hz", file=sys.stderr)
        print(f"  Channels: {self.channels}", file=sys.stderr)

        try:
            # Clear buffer and error state
            with self.buffer_lock:
                self.audio_buffer = []
            self.error_event.clear()
            self.last_error = None

            # Start the Swift helper process
            self.process = subprocess.Popen(
                [
                    str(self.helper_path),
                    "--sample-rate", str(self.sample_rate),
                    "--channels", str(self.channels)
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0  # Unbuffered for real-time audio
            )

            self.is_recording = True
            self.is_ready = False

            # Start threads to read stdout (audio) and stderr (status)
            self._stdout_thread = threading.Thread(target=self._read_audio_data, daemon=True)
            self._stdout_thread.start()

            self._stderr_thread = threading.Thread(target=self._read_status_messages, daemon=True)
            self._stderr_thread.start()

            # Wait for ready signal (max 5 seconds)
            for _ in range(50):
                if self.is_ready:
                    print("Swift audio capture ready!", file=sys.stderr)
                    return True
                if self.process.poll() is not None:
                    # Process exited
                    print("ERROR: Swift helper exited unexpectedly", file=sys.stderr)
                    self.is_recording = False
                    return False
                import time
                time.sleep(0.1)

            print("WARNING: Swift helper did not send ready signal, but continuing...", file=sys.stderr)
            return True

        except Exception as e:
            print(f"ERROR starting Swift audio capture: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            self.is_recording = False
            return False

    def _read_audio_data(self):
        """Read raw PCM float32 audio data from stdout."""
        import os
        import select

        # Buffer size: ~100ms of audio at a time
        # float32 = 4 bytes per sample, stereo = 2 channels
        # Swift sends interleaved samples: L R L R L R ...
        bytes_per_frame = 4 * self.channels  # bytes for one frame (all channels)
        chunk_frames = int(self.sample_rate * 0.1)  # 100ms worth of frames
        chunk_bytes = chunk_frames * bytes_per_frame

        # Track samples for debugging
        total_samples = 0
        chunk_count = 0

        # Get file descriptor for non-blocking reads
        stdout_fd = self.process.stdout.fileno()

        try:
            while self.is_recording and self.process and self.process.poll() is None:
                # Use select to check if data is available (100ms timeout)
                # This prevents blocking forever and allows clean shutdown
                ready, _, _ = select.select([self.process.stdout], [], [], 0.1)

                if not ready:
                    continue

                # Use os.read() which returns immediately with available data
                # Unlike file.read(n) which blocks until n bytes are available
                data = os.read(stdout_fd, chunk_bytes)
                if not data:
                    continue

                # Convert bytes to float32 numpy array
                audio_data = np.frombuffer(data, dtype=np.float32)

                # Reshape to (frames, channels) for interleaved stereo data
                # Swift sends interleaved: [L0, R0, L1, R1, ...]
                if self.channels > 1 and len(audio_data) >= self.channels:
                    # Ensure we have complete frames
                    complete_frames = len(audio_data) // self.channels
                    audio_data = audio_data[:complete_frames * self.channels]
                    audio_data = audio_data.reshape(-1, self.channels)

                # Convert to float64 for consistency with sounddevice mic input
                audio_data = audio_data.astype(np.float64)

                # Add to buffer (thread-safe)
                with self.buffer_lock:
                    self.audio_buffer.append(audio_data)

                total_samples += len(audio_data)
                chunk_count += 1

                # Log first chunk to confirm data is flowing
                if chunk_count == 1:
                    print(f"  First audio chunk received: {len(audio_data)} samples", file=sys.stderr)

            # Drain any remaining data after stop signal (with size limit to prevent blocking)
            # This ensures we capture audio right up to the stop point
            if self.process and self.process.stdout:
                try:
                    # Drain up to 1MB of remaining data (enough for ~5 seconds of audio)
                    max_drain = 1024 * 1024
                    drained_total = 0
                    while drained_total < max_drain:
                        ready, _, _ = select.select([self.process.stdout], [], [], 0.1)
                        if not ready:
                            break
                        remaining = os.read(stdout_fd, chunk_bytes)
                        if not remaining:
                            break
                        audio_data = np.frombuffer(remaining, dtype=np.float32)
                        if self.channels > 1 and len(audio_data) >= self.channels:
                            complete_frames = len(audio_data) // self.channels
                            audio_data = audio_data[:complete_frames * self.channels]
                            audio_data = audio_data.reshape(-1, self.channels)
                        audio_data = audio_data.astype(np.float64)
                        with self.buffer_lock:
                            self.audio_buffer.append(audio_data)
                        total_samples += len(audio_data)
                        drained_total += len(remaining)
                    if drained_total > 0:
                        print(f"  Drained {drained_total} bytes of remaining data", file=sys.stderr)
                except Exception:
                    pass

            print(f"  Audio reader stopped: {total_samples} total samples in {chunk_count} chunks", file=sys.stderr)

        except Exception as e:
            if self.is_recording:
                msg = f"Error reading audio data: {e}"
                print(msg, file=sys.stderr)
                self.last_error = msg
                self.error_event.set()

    def _read_status_messages(self):
        """Read JSON status messages from stderr."""
        import select

        try:
            while self.is_recording and self.process and self.process.poll() is None:
                # Use select to avoid blocking forever on readline
                ready, _, _ = select.select([self.process.stderr], [], [], 0.1)
                if not ready:
                    continue

                line = self.process.stderr.readline()
                if not line:
                    continue

                line = line.decode('utf-8').strip()
                if not line:
                    continue

                try:
                    msg = json.loads(line)
                    msg_type = msg.get('type', '')

                    if msg_type == 'ready':
                        self.is_ready = True
                        print("Swift helper: READY", file=sys.stderr)

                    elif msg_type == 'status':
                        status = msg.get('status', '')
                        message = msg.get('message', '')
                        print(f"Swift helper: {status} - {message}", file=sys.stderr)

                    elif msg_type == 'error':
                        error = msg.get('error', '')
                        print(f"Swift helper ERROR: {error}", file=sys.stderr)

                    elif msg_type == 'config':
                        print(f"Swift helper config: {msg}", file=sys.stderr)

                except json.JSONDecodeError:
                    # Not JSON, print as-is
                    print(f"Swift helper: {line}", file=sys.stderr)

        except Exception as e:
            if self.is_recording:
                print(f"Error reading status messages: {e}", file=sys.stderr)
                # Don't fail completely on status error, but log it


    def stop_recording(self) -> Optional[np.ndarray]:
        """
        Stop capturing and return the captured audio.

        Returns:
            numpy array with audio samples, or None if no audio captured
        """
        if not self.is_recording:
            return None

        print("Stopping Swift audio capture...", file=sys.stderr)

        # Log buffer state before stopping
        with self.buffer_lock:
            buffer_chunks = len(self.audio_buffer)
            print(f"  Buffer state before stop: {buffer_chunks} chunks", file=sys.stderr)

        # Send stop command to the helper BEFORE setting is_recording = False
        # This allows reader threads to drain remaining data
        if self.process and self.process.poll() is None:
            try:
                self.process.stdin.write(b"stop\n")
                self.process.stdin.flush()
                print("  Sent stop command to Swift helper", file=sys.stderr)
            except (BrokenPipeError, OSError) as e:
                # Process may have already exited
                print(f"  Could not send stop command (process may have exited): {e}", file=sys.stderr)

        # Give the reader thread a moment to drain remaining data
        import time
        time.sleep(0.3)

        # Now signal threads to stop
        self.is_recording = False

        # Wait for reader threads to finish FIRST (they need to drain the pipe)
        if self._stdout_thread and self._stdout_thread.is_alive():
            self._stdout_thread.join(timeout=2.0)
            if self._stdout_thread.is_alive():
                print("  WARNING: Audio reader thread did not exit cleanly", file=sys.stderr)
        if self._stderr_thread and self._stderr_thread.is_alive():
            self._stderr_thread.join(timeout=1.0)

        # Now wait for process to exit
        if self.process and self.process.poll() is None:
            try:
                self.process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                print("  Swift helper did not exit gracefully, terminating...", file=sys.stderr)
                self.process.terminate()
                try:
                    self.process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    print("  Swift helper did not respond to terminate, killing...", file=sys.stderr)
                    self.process.kill()
                    self.process.wait(timeout=1.0)

        # Concatenate all audio buffers
        with self.buffer_lock:
            if not self.audio_buffer:
                print("No desktop audio captured", file=sys.stderr)
                return None

            try:
                audio_data = np.concatenate(self.audio_buffer, axis=0)
                print(f"Captured {len(audio_data)} desktop audio samples", file=sys.stderr)

                # Clear buffer
                self.audio_buffer = []

                return audio_data

            except Exception as e:
                print(f"Error concatenating audio buffers: {e}", file=sys.stderr)
                import traceback
                traceback.print_exc(file=sys.stderr)
                return None

    def cleanup(self):
        """Clean up resources."""
        self.is_recording = False

        if self.process and self.process.poll() is None:
            try:
                self.process.terminate()
                self.process.wait(timeout=1.0)
            except:
                self.process.kill()

        self.process = None


def check_screen_recording_permission() -> bool:
    """
    Check if Screen Recording permission is granted.

    Note: On macOS, there's no direct API to check this.
    The Swift helper will fail to capture if permission is not granted.

    Returns:
        True (we assume permission is granted, helper will fail if not)
    """
    # We can't easily check this from Python
    # The Swift helper will report an error if permission is denied
    return True


# For backwards compatibility with existing code
def is_swift_capture_available() -> bool:
    """Check if Swift audio capture is available on this system."""
    import platform

    # Only available on macOS
    if platform.system() != 'Darwin':
        return False

    # Check macOS version (need 13.0+)
    try:
        version = platform.mac_ver()[0]
        major = int(version.split('.')[0])
        if major < 13:
            return False
    except:
        return False

    # Check if helper binary exists
    return get_audiocapture_helper_path() is not None


# CLI for testing
if __name__ == "__main__":
    import time

    print("Swift Audio Capture Test")
    print("=" * 40)

    if not is_swift_capture_available():
        print("ERROR: Swift audio capture not available")
        print("  - Requires macOS 13.0+")
        print("  - Requires audiocapture-helper binary")
        sys.exit(1)

    capture = SwiftAudioCapture(sample_rate=48000, channels=2)

    print(f"\nHelper path: {capture.helper_path}")
    print(f"Starting capture for 5 seconds...")

    if not capture.start_recording():
        print("Failed to start capture")
        sys.exit(1)

    # Record for 5 seconds
    time.sleep(5)

    # Stop and get audio
    audio = capture.stop_recording()

    if audio is not None:
        print(f"\nCaptured audio:")
        print(f"  Shape: {audio.shape}")
        print(f"  Duration: {len(audio) / 48000:.2f} seconds")
        print(f"  Max amplitude: {np.max(np.abs(audio)):.4f}")

        # Save to WAV for testing
        import wave
        audio_int16 = (audio * 32767).astype(np.int16)
        with wave.open("test_swift_capture.wav", 'wb') as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)
            wf.setframerate(48000)
            wf.writeframes(audio_int16.tobytes())
        print(f"\nSaved to test_swift_capture.wav")
    else:
        print("No audio captured")

    capture.cleanup()
