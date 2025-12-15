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

        # Thread-safe state signaling using Events
        self._recording_event = threading.Event()  # Set when recording is active
        self._ready_event = threading.Event()  # Set when Swift helper is ready

        self._stdout_thread: Optional[threading.Thread] = None
        self._stderr_thread: Optional[threading.Thread] = None

        # Separate buffers for handling chunk boundaries at different alignment stages
        # _partial_bytes: leftover bytes not aligned to float32 (4-byte) boundary
        # _partial_samples: leftover samples not aligned to frame (channel count) boundary
        self._partial_bytes: bytes = b''
        self._partial_samples: Optional[np.ndarray] = None

        # Error signaling
        self.error_event = threading.Event()
        self.last_error = None

    @property
    def is_recording(self) -> bool:
        """Check if recording is active (for backwards compatibility)."""
        return self._recording_event.is_set()

    @is_recording.setter
    def is_recording(self, value: bool):
        """Set recording state (for backwards compatibility)."""
        if value:
            self._recording_event.set()
        else:
            self._recording_event.clear()

    @property
    def is_ready(self) -> bool:
        """Check if Swift helper is ready (for backwards compatibility)."""
        return self._ready_event.is_set()

    @is_ready.setter
    def is_ready(self, value: bool):
        """Set ready state (for backwards compatibility)."""
        if value:
            self._ready_event.set()
        else:
            self._ready_event.clear()

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

        if self._recording_event.is_set():
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
            self._partial_bytes = b''  # Clear byte alignment buffer
            self._partial_samples = None  # Clear sample alignment buffer
            self.error_event.clear()
            self._ready_event.clear()
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

            self._recording_event.set()

            # Start threads to read stdout (audio) and stderr (status)
            self._stdout_thread = threading.Thread(target=self._read_audio_data, daemon=True)
            self._stdout_thread.start()

            self._stderr_thread = threading.Thread(target=self._read_status_messages, daemon=True)
            self._stderr_thread.start()

            # Wait for ready signal (max 5 seconds) using Event.wait()
            if self._ready_event.wait(timeout=5.0):
                print("Swift audio capture ready!", file=sys.stderr)
                return True

            # Check if process exited during wait
            if self.process.poll() is not None:
                print("ERROR: Swift helper exited unexpectedly", file=sys.stderr)
                self.cleanup()
                return False

            print("WARNING: Swift helper did not send ready signal, but continuing...", file=sys.stderr)
            return True

        except Exception as e:
            print(f"ERROR starting Swift audio capture: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            # Clean up any resources that may have been allocated
            self.cleanup()
            return False

    def _read_audio_data(self):
        """Read raw PCM float32 audio data from stdout."""
        import os
        import select

        # Buffer size: ~100ms of audio at a time
        # float32 = 4 bytes per sample, stereo = 2 channels
        # Swift sends interleaved samples: L R L R L R ...
        bytes_per_sample = 4  # float32
        chunk_frames = int(self.sample_rate * 0.1)  # 100ms worth of frames
        chunk_bytes = chunk_frames * bytes_per_sample * self.channels

        # Track samples for debugging
        total_samples = 0
        chunk_count = 0

        # Get file descriptor for non-blocking reads
        stdout_fd = self.process.stdout.fileno()

        def bytes_to_samples(data: bytes) -> Optional[np.ndarray]:
            """
            Convert raw bytes to float32 samples, handling byte alignment.

            Stage 1: Byte alignment (4 bytes per float32 sample)
            Leftover bytes are stored in self._partial_bytes
            """
            # Prepend any leftover bytes from previous read
            if self._partial_bytes:
                data = self._partial_bytes + data
                self._partial_bytes = b''

            if not data:
                return None

            # Ensure byte alignment to float32 (4 bytes per sample)
            leftover_bytes = len(data) % bytes_per_sample
            if leftover_bytes:
                self._partial_bytes = data[-leftover_bytes:]
                data = data[:-leftover_bytes]

            if not data:
                return None

            # Convert bytes to float32 numpy array
            return np.frombuffer(data, dtype=np.float32)

        def samples_to_frames(samples: np.ndarray) -> Optional[np.ndarray]:
            """
            Reshape samples into frames, handling frame alignment.

            Stage 2: Frame alignment (channels samples per frame)
            Leftover samples are stored in self._partial_samples
            """
            # Prepend any leftover samples from previous read
            if self._partial_samples is not None:
                samples = np.concatenate([self._partial_samples, samples])
                self._partial_samples = None

            if len(samples) == 0:
                return None

            # For mono, no frame alignment needed
            if self.channels == 1:
                return samples.reshape(-1, 1).astype(np.float64)

            # Ensure frame alignment (all channels present for each frame)
            leftover_samples = len(samples) % self.channels
            if leftover_samples:
                self._partial_samples = samples[-leftover_samples:].copy()
                samples = samples[:-leftover_samples]

            if len(samples) == 0:
                return None

            # Reshape to (frames, channels) for interleaved stereo data
            # Convert to float64 for consistency with sounddevice mic input
            return samples.reshape(-1, self.channels).astype(np.float64)

        def process_audio_bytes(data: bytes) -> Optional[np.ndarray]:
            """Process raw bytes into audio frames through both alignment stages."""
            samples = bytes_to_samples(data)
            if samples is None:
                return None
            return samples_to_frames(samples)

        # Track time for "no audio" warning
        import time
        start_time = time.time()
        no_audio_warning_sent = False

        try:
            while self._recording_event.is_set() and self.process and self.process.poll() is None:
                # Use select to check if data is available (100ms timeout)
                # This prevents blocking forever and allows clean shutdown
                ready, _, _ = select.select([self.process.stdout], [], [], 0.1)

                if not ready:
                    # Warn if no audio received after 3 seconds (and helper is still running)
                    if not no_audio_warning_sent and chunk_count == 0 and time.time() - start_time > 3.0:
                        print("  WARNING: No audio data received after 3 seconds", file=sys.stderr)
                        print("    - Check that system audio is playing", file=sys.stderr)
                        print("    - Check Screen Recording permission in System Settings", file=sys.stderr)
                        no_audio_warning_sent = True
                    continue

                # Use os.read() which returns immediately with available data
                # Unlike file.read(n) which blocks until n bytes are available
                new_data = os.read(stdout_fd, chunk_bytes)
                if not new_data:
                    continue

                audio_data = process_audio_bytes(new_data)
                if audio_data is None:
                    continue

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
                        new_data = os.read(stdout_fd, chunk_bytes)
                        if not new_data:
                            break

                        audio_data = process_audio_bytes(new_data)
                        drained_total += len(new_data)

                        if audio_data is None:
                            continue

                        with self.buffer_lock:
                            self.audio_buffer.append(audio_data)
                        total_samples += len(audio_data)

                    if drained_total > 0:
                        print(f"  Drained {drained_total} bytes of remaining data", file=sys.stderr)
                except Exception as e:
                    print(f"  Warning: Error draining remaining data: {e}", file=sys.stderr)

            print(f"  Audio reader stopped: {total_samples} total samples in {chunk_count} chunks", file=sys.stderr)

        except Exception as e:
            if self._recording_event.is_set():
                msg = f"Error reading audio data: {e}"
                print(msg, file=sys.stderr)
                self.last_error = msg
                self.error_event.set()

    def _read_status_messages(self):
        """Read JSON status messages from stderr."""
        import select

        try:
            while self._recording_event.is_set() and self.process and self.process.poll() is None:
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
                        self._ready_event.set()
                        print("Swift helper: READY", file=sys.stderr)

                    elif msg_type == 'status':
                        status = msg.get('status', '')
                        message = msg.get('message', '')
                        print(f"Swift helper: {status} - {message}", file=sys.stderr)

                    elif msg_type == 'error':
                        error = msg.get('error', '')
                        code = msg.get('code', 'unknown')
                        help_text = msg.get('help', '')

                        print(f"Swift helper ERROR [{code}]: {error}", file=sys.stderr)
                        if help_text:
                            print(f"  Help: {help_text}", file=sys.stderr)

                        # Store error for main thread to access
                        self.last_error = error
                        if code == 'permission_denied':
                            self.last_error = f"PERMISSION_DENIED: {error}"
                        self.error_event.set()

                    elif msg_type == 'config':
                        print(f"Swift helper config: {msg}", file=sys.stderr)

                except json.JSONDecodeError:
                    # Not JSON, print as-is
                    print(f"Swift helper: {line}", file=sys.stderr)

        except Exception as e:
            if self._recording_event.is_set():
                print(f"Error reading status messages: {e}", file=sys.stderr)
                # Don't fail completely on status error, but log it


    def stop_recording(self) -> Optional[np.ndarray]:
        """
        Stop capturing and return the captured audio.

        Returns:
            numpy array with audio samples, or None if no audio captured
        """
        if not self._recording_event.is_set():
            return None

        print("Stopping Swift audio capture...", file=sys.stderr)

        # Log buffer state before stopping
        with self.buffer_lock:
            buffer_chunks = len(self.audio_buffer)
            print(f"  Buffer state before stop: {buffer_chunks} chunks", file=sys.stderr)

        # Send stop command to the helper BEFORE clearing recording event
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
        self._recording_event.clear()

        # Wait for reader threads to finish FIRST (they need to drain the pipe)
        if self._stdout_thread and self._stdout_thread.is_alive():
            self._stdout_thread.join(timeout=2.0)
            if self._stdout_thread.is_alive():
                print("  WARNING: Audio reader thread did not exit cleanly", file=sys.stderr)
        if self._stderr_thread and self._stderr_thread.is_alive():
            self._stderr_thread.join(timeout=1.0)

        # Now wait for process to exit and check exit code
        exit_code = None
        if self.process and self.process.poll() is None:
            try:
                exit_code = self.process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                print("  Swift helper did not exit gracefully, terminating...", file=sys.stderr)
                self.process.terminate()
                try:
                    exit_code = self.process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    print("  Swift helper did not respond to terminate, killing...", file=sys.stderr)
                    self.process.kill()
                    exit_code = self.process.wait(timeout=1.0)
        elif self.process:
            exit_code = self.process.poll()

        if exit_code is not None and exit_code != 0:
            print(f"  Swift helper exited with code {exit_code}", file=sys.stderr)

        # Clear process reference
        self.process = None

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
        self._recording_event.clear()
        self._ready_event.clear()

        if self.process and self.process.poll() is None:
            try:
                self.process.terminate()
                self.process.wait(timeout=1.0)
            except (subprocess.TimeoutExpired, OSError):
                try:
                    self.process.kill()
                    self.process.wait(timeout=0.5)
                except OSError:
                    pass  # Process already dead

        self.process = None
        self._stdout_thread = None
        self._stderr_thread = None


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
