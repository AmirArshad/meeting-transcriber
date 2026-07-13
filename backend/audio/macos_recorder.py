"""
macOS audio recorder implementation using sounddevice and ScreenCaptureKit.

Uses sounddevice for microphone input and ScreenCaptureKit for desktop audio capture.
Implements the same post-processing mix approach as Windows for consistency.

Known constraint: mic frames are buffered in RAM (ChunkedAudioBuffer) for the
post-processing mix. Very long meetings can still peak high during stop-time
concatenate/mix; processing exceptions must emit structured failure JSON.
"""

import sys
import json
import threading
import time
from types import SimpleNamespace
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
import numpy as np

from .compressor import compress_and_report, verify_recording_integrity
from .chunked_audio_buffer import ChunkedAudioBuffer
from .capture_spool_runtime import capture_spool_enabled, load_track_pcm_array
from .capture_manifest import CaptureManifestCoordinator
from .track_spool import TrackSpool
from .macos_desktop_diagnostics import (
    build_desktop_diagnostics,
    format_desktop_diagnostics_summary,
)
from .macos_stereo_repair import repair_one_sided_stereo
from .macos_stream_alignment import align_streams_by_start_time
from .recorder_temp_paths import (
    build_recorder_temp_pcm_path,
    build_stable_wav_path_for_output,
    promote_recorder_temp_to_wav,
)
from .wav_io import write_float_stereo_wav
from . import recorder_stdout as _recorder_stdout

# Re-export for characterization tests that import macos_recorder._repair_one_sided_stereo
_repair_one_sided_stereo = repair_one_sided_stereo

# Desktop helper ready budget must cover Gatekeeper + first TCC registration.
# Outer wait exceeds the inner Swift ready wait so a boundary race still surfaces
# the specific helper error (e.g. permission-denied) instead of a generic timeout.
DESKTOP_START_TIMEOUT_SECONDS = 20.0
MIC_START_TIMEOUT_SECONDS = 5.0

try:
    # pyright: ignore[reportMissingImports]
    import sounddevice as sd
except ImportError:
    sd = SimpleNamespace(InputStream=None, query_devices=None)


# Lock for thread-safe JSON output to stdout
_stdout_lock = threading.Lock()
_configuring_devices_event_sent = False


def _send_json_message(message: dict):
    """Send a JSON message to stdout in a thread-safe manner."""
    _recorder_stdout.send_json_message(message, lock=_stdout_lock)


def _send_event_message(event: str, message: str, **extra):
    """Send a structured recorder event to stdout."""
    _recorder_stdout.send_event_message(
        event,
        message,
        lock=_stdout_lock,
        send_json=_send_json_message,
        **extra,
    )


def _send_configuring_devices_event():
    global _configuring_devices_event_sent
    if _configuring_devices_event_sent:
        return

    _send_event_message("configuring_devices", "Configuring audio devices...")
    _configuring_devices_event_sent = True


def _send_warning_message(code: str, message: str, **extra):
    """Send a structured warning to stdout."""
    _recorder_stdout.send_warning_message(
        code,
        message,
        lock=_stdout_lock,
        send_json=_send_json_message,
        **extra,
    )


def _send_error_message(code: str, message: str, **extra):
    """Send a structured error to stdout."""
    _recorder_stdout.send_error_message(
        code,
        message,
        lock=_stdout_lock,
        send_json=_send_json_message,
        **extra,
    )


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
SwiftAudioCapture = None
ScreenCaptureAudioRecorder = None

try:
    from .swift_audio_capture import SwiftAudioCapture, is_swift_capture_available
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
        from .screencapture_helper import ScreenCaptureAudioRecorder
        SCREENCAPTURE_AVAILABLE = True
        print("Using PyObjC ScreenCaptureKit for desktop audio (fallback)", file=sys.stderr)
    except ImportError:
        print("WARNING: No desktop audio capture available", file=sys.stderr)
        print("  Desktop audio capture will be disabled", file=sys.stderr)


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
        preroll_seconds: Optional[float] = None  # None = use default 1.5s, 0 = no preroll (for production with countdown)
    ):
        """Initialize the macOS recorder."""
        _send_configuring_devices_event()
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
        self.mic_frames = ChunkedAudioBuffer()
        self.desktop_frames = []
        self.recording_failure = None

        # Optional durable spool path (AVANEVIS_CAPTURE_SPOOL=1). Default off.
        self._use_capture_spool = False
        self._capture_manifest = None
        self._mic_spool = None
        self._desktop_spool = None
        self._mic_spool_channels = None

        # Audio levels for visualization
        self.mic_level = 0.0
        self.desktop_level = 0.0
        self.level_lock = threading.Lock()

        # Error tracking for async thread errors
        self._error_event = threading.Event()
        self._last_error = None
        self._error_lock = threading.Lock()

        # Startup readiness tracking
        self._mic_started_event = threading.Event()
        self._desktop_started_event = threading.Event()
        self._mic_start_error = None
        self._desktop_start_error = None
        self._desktop_start_details = None

        # Threads
        self.mic_thread = None
        self.desktop_thread = None

        # Device info
        self.mic_info: Optional[dict[str, Any]] = None
        self.desktop_info = None

        # Desktop audio recorder (Swift helper preferred, PyObjC fallback)
        self.desktop_capture: Optional[Any] = None
        self.desktop_capture_type = None  # 'swift' or 'pyobjc'

        if SWIFT_CAPTURE_AVAILABLE:
            try:
                if SwiftAudioCapture is None:
                    raise RuntimeError("SwiftAudioCapture unavailable")
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
                if ScreenCaptureAudioRecorder is None:
                    raise RuntimeError("ScreenCaptureAudioRecorder unavailable")
                self.desktop_capture = ScreenCaptureAudioRecorder(
                    sample_rate=sample_rate,
                    channels=channels
                )
                self.desktop_capture_type = 'pyobjc'
                print(f"  PyObjC ScreenCaptureKit initialized for desktop audio (fallback)", file=sys.stderr)
                _send_warning_message(
                    "PYOBJC_FALLBACK_ACTIVE",
                    "Using PyObjC ScreenCaptureKit fallback for desktop audio capture.",
                    help="The native Swift helper is preferred. Re-test desktop capture carefully when running on the PyObjC fallback.",
                )
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
        self.mic_capture_start_time = None
        self.desktop_capture_start_time = None
        self.desktop_capture_end_time = None

        # Output tracking (instance variables instead of globals)
        self.final_output_path = None
        self.recording_duration = 0.0
        self.desktop_diagnostics = {}
        # Late desktop failures degrade to mic-only; mic failures remain hard errors.
        self._desktop_runtime_failure = None
        self._desktop_runtime_warning_sent = False

        print(f"Initialized macOS audio recorder", file=sys.stderr)
        print(f"  Mic device: {mic_device_id}", file=sys.stderr)
        print(f"  Desktop device: {desktop_device_id}", file=sys.stderr)
        print(f"  Sample rate: {sample_rate} Hz", file=sys.stderr)
        print(f"  Output: {output_path}", file=sys.stderr)

    def _drain_desktop_warnings(self, capture_type: Optional[str] = None):
        if not self.desktop_capture or not hasattr(self.desktop_capture, 'drain_warnings'):
            return set()

        resolved_capture_type = capture_type or self.desktop_capture_type or 'unknown'
        warning_codes = set()
        for warning in self.desktop_capture.drain_warnings():
            warning_code = warning.get('code', 'DESKTOP_CAPTURE_WARNING')
            warning_codes.add(warning_code)
            _send_warning_message(
                warning_code,
                warning.get('message', 'Desktop audio capture warning'),
                help=warning.get('help'),
                droppedChunks=warning.get('droppedChunks'),
                queuedBytes=warning.get('queuedBytes'),
                permissionLikely=warning.get('permissionLikely'),
                captureType=resolved_capture_type,
            )

        return warning_codes

    def _build_desktop_diagnostics(self):
        return build_desktop_diagnostics(self.desktop_capture, self.desktop_capture_type)

    def _emit_desktop_diagnostics_warning(self, emit_warning: bool = True):
        diagnostics = self._build_desktop_diagnostics()
        self.desktop_diagnostics = diagnostics
        summary = format_desktop_diagnostics_summary(diagnostics)
        print(summary, file=sys.stderr)
        if emit_warning:
            _send_warning_message(
                'DESKTOP_CAPTURE_DIAGNOSTICS',
                summary,
                captureType=diagnostics['captureType'],
                bufferChunks=diagnostics['bufferChunks'],
                bufferSamples=diagnostics['bufferSamples'],
                peakLevel=round(diagnostics['peakLevel'], 6),
                helperSampleBuffers=diagnostics['helperSampleBuffers'],
                helperBytes=diagnostics['helperBytes'],
                helperScreenFrames=diagnostics['helperScreenFrames'],
                helperDroppedChunks=diagnostics['helperDroppedChunks'],
                helperCaptureBackend=diagnostics['helperCaptureBackend'],
                helperContentInfo=diagnostics['helperContentInfo'],
                helperStreamConfig=diagnostics['helperStreamConfig'],
            )
        return diagnostics

    def start_recording(self):
        """Start recording from microphone and desktop (if available)."""
        if self._get_running():
            print("Already recording!", file=sys.stderr)
            return True

        self._set_running(True)
        self.mic_frames.clear()
        self.desktop_frames = []

        # Clear error state
        self._error_event.clear()
        with self._error_lock:
            self._last_error = None
        self._desktop_runtime_failure = None
        self._desktop_runtime_warning_sent = False

        self._mic_started_event.clear()
        self._desktop_started_event.clear()
        self._mic_start_error = None
        self._desktop_start_error = None
        self._desktop_start_details = None
        self.mic_capture_start_time = None
        self.desktop_capture_start_time = None
        self.desktop_capture_end_time = None

        # Set recording start time BEFORE anything else
        # This is the single reference point for preroll timing
        self.recording_start_time = time.time()

        self._use_capture_spool = capture_spool_enabled()
        if self.desktop_capture is not None:
            self.desktop_capture.audio_sink = None

        # Get device info
        try:
            if sd.query_devices is None:
                raise RuntimeError("sounddevice is not available")
            devices = sd.query_devices()
            if self.mic_device_id < 0 or self.mic_device_id >= len(devices):
                raise ValueError(
                    f"Microphone device ID {self.mic_device_id} is out of range (0-{len(devices) - 1})"
                )
            self.mic_info = devices[self.mic_device_id]
            if self.mic_info.get('max_input_channels', 0) <= 0:
                raise ValueError(f"Microphone device {self.mic_device_id} has no input channels")
            print(f"Microphone: {(self.mic_info or {}).get('name', 'unknown')}", file=sys.stderr)

            # Desktop audio status
            if self.desktop_capture:
                capture_type = self.desktop_capture_type or 'unknown'
                print(f"Desktop audio: {capture_type} capture enabled", file=sys.stderr)
            else:
                print(f"Desktop audio: disabled (no capture method available)", file=sys.stderr)

        except Exception as e:
            message = f"Error querying devices: {e}"
            print(message, file=sys.stderr)
            _send_error_message("DEVICE_QUERY_FAILED", message)
            self._set_running(False)
            return False

        if self._use_capture_spool:
            try:
                mic_channels = min(int(self.mic_info.get('max_input_channels', 1) or 1), 2)
                self._open_capture_spools(mic_channels=mic_channels)
            except Exception as spool_err:
                message = f"Failed to open capture spools: {spool_err}"
                print(f"ERROR: {message}", file=sys.stderr)
                _send_error_message("CAPTURE_SPOOL_OPEN_FAILED", message)
                self._set_running(False)
                self._release_capture_spools()
                return False
            if self.desktop_capture is not None:
                self.desktop_capture.audio_sink = self._desktop_audio_sink

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
            message = "Desktop audio capture is unavailable because no ScreenCaptureKit backend is available."
            help_text = "Reinstall AvaNevis or rebuild the macOS package so audiocapture-helper is bundled and signed."
            print(message, file=sys.stderr)
            print(f"  Swift helper or PyObjC ScreenCaptureKit required", file=sys.stderr)
            _send_error_message("NO_DESKTOP_AUDIO_BACKEND", message, help=help_text)
            self._mic_started_event.wait(timeout=1.0)
            self._abort_startup()
            return False

        if not self._mic_started_event.wait(timeout=MIC_START_TIMEOUT_SECONDS):
            message = f"Microphone stream did not become ready within {MIC_START_TIMEOUT_SECONDS:g} seconds."
            print(f"ERROR: {message}", file=sys.stderr)
            _send_error_message("MIC_START_TIMEOUT", message)
            self._abort_startup()
            return False

        if self._mic_start_error:
            self._abort_startup()
            return False

        if self.desktop_capture:
            if not self._desktop_started_event.wait(timeout=DESKTOP_START_TIMEOUT_SECONDS):
                capture_type = self.desktop_capture_type or 'unknown'
                message = (
                    f"{capture_type} desktop audio did not become ready within "
                    f"{DESKTOP_START_TIMEOUT_SECONDS:g} seconds."
                )
                print(f"ERROR: {message}", file=sys.stderr)
                _send_error_message("DESKTOP_START_TIMEOUT", message)
                self._abort_startup()
                return False

            if self._desktop_start_error:
                self._abort_startup()
                return False

        desktop_status = 'active' if self.desktop_capture else 'unavailable'
        _send_event_message("recording_started", "Recording started!", desktopStatus=desktop_status)
        print(f"Recording started!", file=sys.stderr)
        return True

    def _abort_startup(self):
        """Stop any partially started streams without saving output."""
        self._set_running(False)

        if self.desktop_capture and hasattr(self.desktop_capture, 'cleanup'):
            try:
                self.desktop_capture.cleanup()
            except Exception as e:
                print(f"Warning: Failed to clean up desktop capture after startup error: {e}", file=sys.stderr)

        if self.mic_thread and self.mic_thread.is_alive():
            self.mic_thread.join(timeout=1.0)

        if self.desktop_thread and self.desktop_thread.is_alive():
            self.desktop_thread.join(timeout=1.0)

        self.mic_frames.clear()
        self.desktop_frames = []
        if self.desktop_capture is not None:
            self.desktop_capture.audio_sink = None
        self._release_capture_spools()

    def _desktop_audio_sink(self, chunk: np.ndarray) -> bool:
        """Forward helper float32 chunks to the desktop spool (sink mode)."""
        if self._desktop_spool is None:
            return False
        pcm = np.ascontiguousarray(chunk, dtype=np.float32).tobytes()
        return bool(self._desktop_spool.append(pcm))

    def _open_capture_spools(self, *, mic_channels: int) -> None:
        started_ns = time.time_ns()
        started_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"
        self._mic_spool_channels = int(mic_channels)
        self._capture_manifest = CaptureManifestCoordinator.create(
            self.output_path,
            started_at_ns=started_ns,
            started_at_iso=started_iso,
        )
        self._capture_manifest.add_track(
            "mic",
            sample_rate=self.sample_rate,
            channels=self._mic_spool_channels,
            dtype="<f4",
        )
        self._mic_spool = TrackSpool(
            self._capture_manifest,
            self._capture_manifest.session_dir,
            "mic",
            sample_rate=self.sample_rate,
            channels=self._mic_spool_channels,
            dtype="<f4",
        )
        if self.desktop_capture is not None:
            self._capture_manifest.add_track(
                "desktop",
                sample_rate=self.sample_rate,
                channels=self.channels,
                dtype="<f4",
            )
            self._desktop_spool = TrackSpool(
                self._capture_manifest,
                self._capture_manifest.session_dir,
                "desktop",
                sample_rate=self.sample_rate,
                channels=self.channels,
                dtype="<f4",
            )

    def _close_capture_spools_for_mix(self) -> None:
        """Close spools and hydrate RAM buffers for the existing mix path (Task 9 replaces this)."""
        if not self._use_capture_spool:
            return

        mic_frames = 0
        if self._mic_spool is not None:
            mic_result = self._mic_spool.close()
            mic_frames = mic_result.committed_frames
            track = self._capture_manifest.get_track("mic")
            mic_arr = load_track_pcm_array(
                self._capture_manifest.session_dir,
                track["segments"],
                dtype="<f4",
                channels=self._mic_spool_channels or self.channels,
            )
            self.mic_frames = ChunkedAudioBuffer()
            if mic_arr.size:
                self.mic_frames.append(mic_arr)

        if self._desktop_spool is not None:
            desk_result = self._desktop_spool.close(
                final_frame_count=mic_frames if mic_frames > 0 else None
            )
            track = self._capture_manifest.get_track("desktop")
            if desk_result.committed_frames > 0 and track.get("segments"):
                desk_arr = load_track_pcm_array(
                    self._capture_manifest.session_dir,
                    track["segments"],
                    dtype="<f4",
                    channels=self.channels,
                )
                self.desktop_frames = [desk_arr] if desk_arr.size else []
            else:
                self.desktop_frames = []

        if self._capture_manifest is not None:
            try:
                self._capture_manifest.set_state("finalizing")
            except Exception:
                pass

        self._mic_spool = None
        self._desktop_spool = None

    def _release_capture_spools(self) -> None:
        for spool in (self._mic_spool, self._desktop_spool):
            if spool is None:
                continue
            try:
                spool.close()
            except Exception:
                pass
        self._mic_spool = None
        self._desktop_spool = None
        if self._capture_manifest is not None:
            try:
                self._capture_manifest.close()
            except Exception:
                pass
            self._capture_manifest = None
        self._mic_spool_channels = None
        self._use_capture_spool = False

    def _record_microphone(self):
        """Record from microphone using sounddevice."""
        stream_opened = False
        try:
            # Determine mic channels (mono or stereo)
            mic_info = self.mic_info or {}
            mic_channels = min(mic_info.get('max_input_channels', 1), 2)

            print(f"Starting mic capture ({mic_channels} channel(s))...", file=sys.stderr)

            frame_count = 0

            def audio_callback(indata, frames, time_info, status):
                """Callback for audio input."""
                nonlocal frame_count

                if not self._get_running():
                    return

                if status:
                    print(f"Mic status: {status}", file=sys.stderr)

                # TIME-BASED SYNCHRONIZATION: Use shared reference set at recording start
                # Both streams use the same recording_start_time (set in start_recording)
                # This ensures they skip the same wall-clock period and stay in sync
                reference_start = self.recording_start_time or time.time()
                elapsed = time.time() - reference_start

                # Skip pre-roll based on TIME, not frame counts
                if elapsed < self.preroll_seconds:
                    frame_count += 1
                    return

                if self.mic_capture_start_time is None:
                    self.mic_capture_start_time = time.time()

                # Store audio data (RAM path) or durable spool (flagged path)
                if self._use_capture_spool and self._mic_spool is not None:
                    pcm = np.ascontiguousarray(indata, dtype=np.float32).tobytes()
                    if not self._mic_spool.append(pcm):
                        message = (
                            "Audio capture writer stalled; recording was stopped "
                            "to preserve committed audio."
                        )
                        with self._error_lock:
                            self._last_error = message
                        self._error_event.set()
                        self._set_running(False)
                        return
                else:
                    self.mic_frames.append(indata)

                # Calculate audio level (for visualization)
                # Subsample by 8 for performance
                level = np.max(np.abs(indata[::8]))

                with self.level_lock:
                    self.mic_level = float(level)

                frame_count += 1

            # Open stream and start recording
            if sd.InputStream is None:
                raise RuntimeError("sounddevice InputStream is not available")
            with sd.InputStream(
                device=self.mic_device_id,
                channels=mic_channels,
                samplerate=self.sample_rate,
                blocksize=self.chunk_size,
                callback=audio_callback
            ):
                stream_opened = True
                self._mic_start_error = None
                self._mic_started_event.set()
                print("Microphone stream opened", file=sys.stderr)
                _send_event_message("mic_stream_opened", "Microphone stream opened")

                while self._get_running():
                    time.sleep(0.1)

            print(
                f"Mic recording stopped. Chunks captured: {len(self.mic_frames)} "
                f"({self.mic_frames.nbytes / 1024 / 1024:.2f} MB)",
                file=sys.stderr,
            )

        except Exception as e:
            print(f"ERROR in mic recording: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)

            error_message = f"Microphone recording failed: {str(e)}"
            with self._error_lock:
                self._last_error = error_message
            self._error_event.set()

            if not stream_opened:
                self._mic_start_error = error_message
                self._mic_started_event.set()
                _send_error_message("MIC_START_FAILED", error_message)
            else:
                _send_error_message("MIC_RECORDING_FAILED", error_message)

            self._set_running(False)

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

        capture_started = False
        try:
            capture_type = self.desktop_capture_type or 'unknown'
            print(f"Starting desktop audio capture ({capture_type})...", file=sys.stderr)

            # Start recording
            if not self.desktop_capture.start_recording():
                detailed_message = self.desktop_capture.last_error or f"{capture_type} desktop audio failed to start."
                message = detailed_message
                error_code = "DESKTOP_START_FAILED"
                if detailed_message.startswith('PERMISSION_DENIED:'):
                    message = detailed_message.replace('PERMISSION_DENIED:', '', 1).strip()
                    error_code = "PERMISSION_DENIED"
                elif 'failed to start' not in detailed_message.lower():
                    message = f"{capture_type} desktop audio failed to start: {detailed_message}"
                print(message, file=sys.stderr)
                self._desktop_start_error = message
                self._desktop_start_details = {
                    'captureType': capture_type,
                    'rawMessage': detailed_message,
                }
                self._desktop_started_event.set()
                _send_error_message(error_code, message)
                self._set_running(False)
                return

            capture_started = True
            self._desktop_start_error = None
            self._desktop_started_event.set()
            print("Desktop audio stream opened", file=sys.stderr)
            _send_event_message(
                "desktop_stream_opened",
                "Desktop audio stream opened",
                captureType=capture_type,
            )

            # Monitor audio levels while recording
            # Track if we've logged level calculation errors to avoid spam
            level_error_logged = False

            while self._get_running():
                self._drain_desktop_warnings(capture_type)

                # Update desktop audio level from capture buffer (thread-safe).
                # Sink mode keeps only the latest chunk; RAM mode uses audio_buffer.
                try:
                    level = None
                    latest = getattr(self.desktop_capture, "latest_audio_chunk", None)
                    if latest is not None:
                        level = float(np.max(np.abs(latest[::8])))
                    else:
                        with self.desktop_capture.buffer_lock:
                            if self.desktop_capture.audio_buffer:
                                latest_buffer = self.desktop_capture.audio_buffer[-1]
                                level = float(np.max(np.abs(latest_buffer[::8])))

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

            error_message = f"Desktop audio recording failed: {str(e)}"

            if not capture_started:
                # Startup failures still abort the whole recording.
                with self._error_lock:
                    self._last_error = error_message
                self._desktop_start_error = error_message
                self._desktop_started_event.set()
                _send_error_message("DESKTOP_START_FAILED", error_message)
                self._set_running(False)
            else:
                # After a successful start, keep mic capture running and degrade
                # to mic-only at stop (matches Windows warn-and-continue policy).
                self._note_desktop_runtime_failure(error_message, code="DESKTOP_RECORDING_FAILED")

    def _note_desktop_runtime_failure(self, message: str, *, code: str = "DESKTOP_RECORDING_FAILED") -> None:
        """Record a late desktop failure without discarding microphone audio."""
        if not self._desktop_runtime_failure:
            self._desktop_runtime_failure = message
        if self._desktop_runtime_warning_sent:
            return
        self._desktop_runtime_warning_sent = True
        print(f"WARNING: {message}", file=sys.stderr)
        _send_warning_message(
            code,
            f"{message} Continuing with microphone audio only.",
            help="Desktop audio capture failed after recording started. The saved file will contain microphone audio only.",
        )

    def _consume_desktop_helper_failure(self) -> Optional[str]:
        """If the Swift/PyObjC helper failed mid-session, warn once and continue mic-only."""
        if not self.desktop_capture or not hasattr(self.desktop_capture, 'error_event'):
            return None
        if not self.desktop_capture.error_event.is_set():
            return None
        error_msg = getattr(self.desktop_capture, 'last_error', None) or "Unknown desktop capture error"
        message = f"Desktop audio capture failed: {error_msg}"
        self._note_desktop_runtime_failure(message, code="DESKTOP_AUDIO_FAILED")
        return message

    def _has_async_recording_error(self) -> bool:
        """True only for hard (microphone) failures that must stop the session."""
        return self._error_event.is_set()

    def _resolve_async_recording_failure(self) -> Optional[dict]:
        """Return a hard failure for mic-thread errors only.

        Late desktop failures are converted to warnings so stop can still
        process whatever microphone audio was captured.
        """
        if self._error_event.is_set():
            with self._error_lock:
                error_msg = self._last_error or "Unknown recording error"
            return {
                'code': 'RECORDING_THREAD_FAILED',
                'message': error_msg,
            }

        self._consume_desktop_helper_failure()
        return None

    def _finalize_recording_failure(self, failure: dict) -> None:
        self.recording_failure = failure
        # Keep any already-produced output path so Electron can recover it.
        if not self.final_output_path:
            self.recording_duration = self.recording_duration or 0.0

    def _resolve_recoverable_output_path(self) -> Optional[str]:
        """Prefer the final Opus/WAV; promote a temp PCM to a stable .wav if needed.

        Never return a volatile ``.pcm.tmp`` path to Electron — scan-import would
        later rename it to ``{stem}.wav`` and orphan any meeting that stored the
        temp path.
        """
        if self.final_output_path and Path(self.final_output_path).exists():
            return self.final_output_path
        preferred = self.output_path.replace('.wav', '.opus')
        for candidate in (preferred, self.output_path):
            if candidate and Path(candidate).exists() and not str(candidate).lower().endswith('.pcm.tmp'):
                return candidate

        temp_path = build_recorder_temp_pcm_path(self.output_path)
        if Path(temp_path).exists():
            stable_wav = build_stable_wav_path_for_output(self.output_path)
            promoted = promote_recorder_temp_to_wav(temp_path, stable_wav)
            if promoted:
                self.final_output_path = promoted
                return promoted
        return None

    def stop_recording(self):
        """Stop recording and process audio."""
        pending_error = self._has_async_recording_error()
        desktop_degraded = bool(self._desktop_runtime_failure) or (
            self.desktop_capture is not None
            and hasattr(self.desktop_capture, 'error_event')
            and self.desktop_capture.error_event.is_set()
        )
        if not self._get_running() and not pending_error and not desktop_degraded:
            print("Not recording!", file=sys.stderr)
            return

        if self._get_running():
            print(f"\nStopping recording...", file=sys.stderr)
            self._set_running(False)

        # Wait for threads to finish
        if self.mic_thread:
            self.mic_thread.join(timeout=2.0)
        if self.desktop_thread:
            self.desktop_thread.join(timeout=2.0)

        # Stop desktop capture and get desktop audio (RAM path). Sink mode returns None;
        # committed desktop PCM is hydrated from the spool below.
        if self.desktop_capture:
            capture_type = self.desktop_capture_type or 'unknown'
            print(f"Stopping {capture_type} desktop capture...", file=sys.stderr)
            desktop_audio = None
            warning_codes = set()
            try:
                desktop_audio = self.desktop_capture.stop_recording()
                warning_codes = self._drain_desktop_warnings(capture_type)
            except Exception as stop_err:
                self._note_desktop_runtime_failure(
                    f"Desktop audio stop failed: {stop_err}",
                    code="DESKTOP_STOP_FAILED",
                )
            if self.desktop_capture is not None:
                self.desktop_capture.audio_sink = None

            if desktop_audio is not None and len(desktop_audio) > 0:
                diagnostics = self._emit_desktop_diagnostics_warning(emit_warning=False)
                if diagnostics.get('bufferSamples', 0) <= 0:
                    diagnostics['bufferChunks'] = max(int(diagnostics.get('bufferChunks', 0) or 0), 1)
                    diagnostics['bufferSamples'] = int(len(desktop_audio))
                    self.desktop_diagnostics = diagnostics
                # Convert to list of frames for consistency
                self.desktop_frames = [desktop_audio]
                self.desktop_capture_start_time = self._resolve_desktop_capture_start_time()
                self.desktop_capture_end_time = getattr(self.desktop_capture, 'last_audio_time', None)
                if self.desktop_capture_start_time is None and self.recording_start_time is not None:
                    self.desktop_capture_start_time = self.recording_start_time + self.preroll_seconds
                desktop_peak = float(np.max(np.abs(desktop_audio))) if desktop_audio.size else 0.0
                desktop_rms = float(np.sqrt(np.mean(np.square(desktop_audio)))) if desktop_audio.size else 0.0
                print(
                    f"Retrieved {len(desktop_audio)} desktop audio samples from {capture_type} "
                    f"(peak={desktop_peak:.6f}, rms={desktop_rms:.6f})",
                    file=sys.stderr,
                )
            elif not self._use_capture_spool:
                self._consume_desktop_helper_failure()
                self._emit_desktop_diagnostics_warning()
                print(f"No desktop audio captured from {capture_type}", file=sys.stderr)
                if self._desktop_runtime_failure:
                    # Already warned via _note_desktop_runtime_failure.
                    self.desktop_frames = []
                elif "NO_DESKTOP_AUDIO_CAPTURED" not in warning_codes:
                    helper_backend = self.desktop_diagnostics.get('helperCaptureBackend') if self.desktop_diagnostics else None
                    if helper_backend == 'coreaudio_tap':
                        help_text = (
                            "If system audio was playing, check macOS System Audio Recording permission, "
                            "restart AvaNevis, and try another short recording."
                        )
                    elif helper_backend == 'screencapturekit':
                        help_text = (
                            "If system audio was playing, check Screen Recording permission, restart AvaNevis, "
                            "and try another short recording."
                        )
                    else:
                        help_text = (
                            "If system audio was playing, check macOS System Audio Recording and Screen Recording "
                            "permissions, restart AvaNevis, and try another short recording."
                        )
                    _send_warning_message(
                        "NO_DESKTOP_AUDIO_CAPTURED",
                        "No desktop audio was captured; saved recording contains microphone audio only.",
                        help=help_text,
                        captureType=capture_type,
                    )
            else:
                # Sink mode: timestamps still come from the helper; PCM loads from spool.
                self._consume_desktop_helper_failure()
                self.desktop_capture_start_time = self._resolve_desktop_capture_start_time()
                self.desktop_capture_end_time = getattr(self.desktop_capture, 'last_audio_time', None)
                if self.desktop_capture_start_time is None and self.recording_start_time is not None:
                    self.desktop_capture_start_time = self.recording_start_time + self.preroll_seconds
                self._emit_desktop_diagnostics_warning(emit_warning=False)

        if self._use_capture_spool:
            try:
                self._close_capture_spools_for_mix()
            except Exception as spool_err:
                message = f"Failed to close capture spools: {spool_err}"
                print(f"ERROR: {message}", file=sys.stderr)
                self.recording_failure = {
                    'code': 'CAPTURE_SPOOL_CLOSE_FAILED',
                    'message': message,
                }
                self._release_capture_spools()
                return

            if self.desktop_frames:
                desk = self.desktop_frames[0]
                desktop_peak = float(np.max(np.abs(desk))) if desk.size else 0.0
                desktop_rms = float(np.sqrt(np.mean(np.square(desk)))) if desk.size else 0.0
                print(
                    f"Hydrated {len(desk)} desktop samples from capture spool "
                    f"(peak={desktop_peak:.6f}, rms={desktop_rms:.6f})",
                    file=sys.stderr,
                )
                diagnostics = self.desktop_diagnostics or {}
                if diagnostics.get('bufferSamples', 0) <= 0:
                    diagnostics = dict(diagnostics)
                    diagnostics['bufferChunks'] = max(int(diagnostics.get('bufferChunks', 0) or 0), 1)
                    diagnostics['bufferSamples'] = int(len(desk))
                    self.desktop_diagnostics = diagnostics
            elif not self._desktop_runtime_failure:
                capture_type = self.desktop_capture_type or 'unknown'
                self._emit_desktop_diagnostics_warning()
                print(f"No desktop audio captured from {capture_type}", file=sys.stderr)
                helper_backend = self.desktop_diagnostics.get('helperCaptureBackend') if self.desktop_diagnostics else None
                if helper_backend == 'coreaudio_tap':
                    help_text = (
                        "If system audio was playing, check macOS System Audio Recording permission, "
                        "restart AvaNevis, and try another short recording."
                    )
                elif helper_backend == 'screencapturekit':
                    help_text = (
                        "If system audio was playing, check Screen Recording permission, restart AvaNevis, "
                        "and try another short recording."
                    )
                else:
                    help_text = (
                        "If system audio was playing, check macOS System Audio Recording and Screen Recording "
                        "permissions, restart AvaNevis, and try another short recording."
                    )
                _send_warning_message(
                    "NO_DESKTOP_AUDIO_CAPTURED",
                    "No desktop audio was captured; saved recording contains microphone audio only.",
                    help=help_text,
                    captureType=capture_type,
                )

        async_failure = self._resolve_async_recording_failure()
        if async_failure:
            if not self.recording_failure:
                self._finalize_recording_failure(async_failure)
            self._release_capture_spools()
            return

        # Process and save audio (mic-only when desktop failed late)
        print(f"Processing audio...", file=sys.stderr)
        try:
            if not self._process_and_save():
                self._release_capture_spools()
                return
            if self._capture_manifest is not None:
                try:
                    self._capture_manifest.set_state("complete")
                except Exception:
                    pass
                self._release_capture_spools()
        except Exception as process_err:
            message = f"Recorder failed during post-processing: {process_err}"
            print(message, file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            recovered = self._resolve_recoverable_output_path()
            self.recording_failure = {
                'code': 'RECORDER_FAILED',
                'message': message,
            }
            if recovered:
                self.final_output_path = recovered
            self._release_capture_spools()
            return

        print(f"Recording complete!", file=sys.stderr)

    def _process_and_save(self):
        """Process recorded audio and save to file."""
        _send_event_message("post_processing_started", "Finishing recording...")

        if not self.mic_frames:
            message = "No audio was captured from the microphone."
            print(f"ERROR: {message}", file=sys.stderr)
            _send_error_message(
                "NO_MIC_AUDIO_CAPTURED",
                message,
                help="Check Microphone permission and confirm the selected input device is still connected.",
            )
            self.recording_failure = {
                'code': 'NO_MIC_AUDIO_CAPTURED',
                'message': message,
            }
            self.final_output_path = None
            self.recording_duration = 0.0
            return False

        _send_event_message("audio_normalizing", "Normalizing audio...")

        # Convert mic chunks to numpy array once at stop time
        mic_audio = self.mic_frames.to_array()
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

            mic_audio = _repair_one_sided_stereo(mic_audio, 'microphone')
            desktop_audio = _repair_one_sided_stereo(desktop_audio, 'desktop')

            mic_audio, desktop_audio = self._align_streams_by_start_time(mic_audio, desktop_audio)

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
            # MEMORY: build the mix in place to avoid holding mic, desktop and the
            # result as separate full-size float buffers at the same time.
            _send_event_message("audio_mixing", "Mixing audio...")
            MIC_BOOST = 2.0
            final_audio = mic_audio * (self.mic_volume * MIC_BOOST)
            final_audio += desktop_audio * self.desktop_volume

            # Soft limiting if clipping would occur (match Windows behavior)
            max_val = max(abs(float(final_audio.min())), abs(float(final_audio.max())))
            if max_val > 1.0:
                final_audio *= 0.85
                np.tanh(final_audio, out=final_audio)

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

            final_audio = _repair_one_sided_stereo(final_audio, 'microphone')

            # Apply mic volume
            _send_event_message("audio_mixing", "Preparing microphone audio...")
            final_audio = final_audio * self.mic_volume

        # Enhance microphone audio (same as Windows)
        final_audio = self._enhance_microphone(final_audio)

        # Save as temporary PCM WAV with a non-scanned extension (.pcm.tmp).
        # Leftover .wav temps were previously imported as duplicate meetings.
        temp_wav_path = build_recorder_temp_pcm_path(self.output_path)
        self._save_wav(final_audio, temp_wav_path)

        # Determine preferred final output path (shared compressor may return .wav fallback)
        preferred_output_path = self.output_path.replace('.wav', '.opus')
        duration_seconds = len(final_audio) / self.sample_rate
        self.recording_duration = duration_seconds

        # Compress with ffmpeg (same shared helper as Windows)
        _send_event_message("audio_encoding", "Encoding audio...")
        final_output_path = self._compress_with_ffmpeg(temp_wav_path, preferred_output_path)

        # Publish the final path before temp cleanup so unlink failures still
        # leave Electron with a recoverable success/failure payload.
        self.final_output_path = final_output_path

        # Clean up temp file
        try:
            Path(temp_wav_path).unlink()
        except OSError:
            pass  # File may already be deleted or locked

        print(f"Final file: {final_output_path}", file=sys.stderr)
        print(f"Duration: {duration_seconds:.1f} seconds", file=sys.stderr)
        self.recording_failure = None
        _send_event_message("post_processing_complete", "Recording saved.")
        return True

    def _resolve_desktop_capture_start_time(self):
        """Prefer helper-provided capture timestamps over Python receive times."""
        if self.desktop_capture is None:
            return None

        first_audio_time = getattr(self.desktop_capture, 'first_audio_time', None)
        if first_audio_time is not None:
            return first_audio_time

        return getattr(self.desktop_capture, 'last_audio_time', None)

    def _align_streams_by_start_time(self, mic_audio: np.ndarray, desktop_audio: np.ndarray):
        """Align mic and desktop streams by observed first-audio timestamps."""
        return align_streams_by_start_time(
            mic_audio,
            desktop_audio,
            sample_rate=self.sample_rate,
            recording_start_time=self.recording_start_time,
            mic_capture_start_time=self.mic_capture_start_time,
            desktop_capture_start_time=self.desktop_capture_start_time,
            preroll_seconds=self.preroll_seconds,
        )

    def _enhance_microphone(self, audio):
        """
        Apply minimal audio enhancement to microphone (Google Meet style).

        MATCHES WINDOWS IMPLEMENTATION:
        - Per-channel processing for stereo
        - Remove DC offset (prevents pops/clicks)
        - Gentle normalization (preserves dynamics)
        - Soft limiting (prevents clipping)
        """
        # MEMORY: process channels in place on column views to avoid building
        # extra full-size copies (np.column_stack + per-channel copies). This
        # mirrors the shared Windows processor and keeps peak memory low for long
        # recordings, where each float buffer can be >1 GiB.
        if len(audio.shape) > 1 and audio.shape[1] == 2:
            self._process_channel_inplace(audio[:, 0])
            self._process_channel_inplace(audio[:, 1])
            return audio
        else:
            # Mono audio
            flat = audio.flatten()
            self._process_channel_inplace(flat)
            return flat.reshape(-1, 1)

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

    def _process_channel_inplace(self, channel):
        """
        In-place equivalent of ``_process_channel`` for memory-sensitive paths.

        Mutates ``channel`` directly (which may be a non-contiguous strided column
        view) so long recordings can be enhanced without allocating extra
        full-size copies. Peak magnitudes use min/max instead of ``np.abs`` to
        avoid a temporary array the size of the channel.
        """
        # 1. Remove DC offset (essential - prevents pops/clicks)
        channel -= channel.mean()

        # 2. Very gentle normalization to -3dB peak (preserves dynamics)
        peak = max(abs(float(channel.min())), abs(float(channel.max())))
        if peak > 0.7:  # Only normalize if too loud
            channel *= 0.7 / peak
        elif 0 < peak < 0.1:  # Boost very quiet audio
            channel *= 0.3 / peak

        # 3. Very soft limiting ONLY if clipping would occur
        abs_max = max(abs(float(channel.min())), abs(float(channel.max())))
        if abs_max > 0.95:
            channel *= 0.9
            np.tanh(channel, out=channel)
            channel *= 0.85

    def _save_wav(self, audio, path):
        """Save audio as WAV file."""
        write_float_stereo_wav(path, audio, sample_rate=self.sample_rate)

    def _compress_with_ffmpeg(self, input_path, output_path):
        """Compress WAV to Opus using the shared compressor helper."""
        final_path, stats = compress_and_report(
            input_path,
            output_path,
            self.sample_rate,
            verify_again=True,
            progress_message="Compressing with ffmpeg (Opus codec)...",
        )

        print(f"Compression complete!", file=sys.stderr)
        print(f"  Original: {stats['input_size'] / 1024 / 1024:.1f} MB", file=sys.stderr)
        print(f"  Output: {stats['output_size'] / 1024 / 1024:.1f} MB", file=sys.stderr)
        print(f"  Savings: {stats['ratio']:.1f}%", file=sys.stderr)

        return final_path

    def _verify_recording_integrity(self, file_path):
        """
        Verify the recording file is valid and playable.

        Uses ffprobe to check file integrity.

        Returns:
            True if file is valid, False otherwise.
        """
        return verify_recording_integrity(file_path)

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

    if SWIFT_CAPTURE_AVAILABLE or SCREENCAPTURE_AVAILABLE:
        if SWIFT_CAPTURE_AVAILABLE:
            print(f"  Using: Swift audiocapture-helper (native)", file=sys.stderr)
        else:
            print(f"  Using: PyObjC ScreenCaptureKit (fallback)", file=sys.stderr)
    else:
        message = "Desktop audio capture is unavailable because neither Swift helper nor PyObjC ScreenCaptureKit is available."
        print(f"\n✗ {message}", file=sys.stderr)
        _send_error_message(
            "NO_DESKTOP_AUDIO_BACKEND",
            message,
            help="Reinstall AvaNevis or rebuild the macOS package so audiocapture-helper is bundled and signed.",
        )
        sys.exit(1)

    _send_configuring_devices_event()

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
        _send_error_message(
            "DEVICE_ENUMERATION_FAILED",
            f"Could not enumerate audio devices: {e}",
            help="Grant Microphone permission in System Settings > Privacy & Security > Microphone.",
        )
        sys.exit(1)

    recorder = None
    try:
        # Create recorder
        recorder = MacOSAudioRecorder(
            mic_device_id=args.mic,
            desktop_device_id=args.loopback,
            output_path=args.output,
            preroll_seconds=0  # Production mode: no preroll, countdown in Electron app handles device warm-up
        )

        # Start recording
        if not recorder.start_recording():
            sys.exit(1)
    except Exception as e:
        message = f"Recorder failed: {e}"
        print(message, file=sys.stderr)
        _send_error_message("RECORDER_FAILED", message)
        if recorder is not None:
            recorder._abort_startup()
        sys.exit(1)

    result_emitted = False

    def emit_final_result(*, exit_code: int = 0) -> None:
        nonlocal result_emitted
        if result_emitted or recorder is None:
            return
        result_emitted = True

        failure = getattr(recorder, 'recording_failure', None)
        recovered_path = None
        if hasattr(recorder, '_resolve_recoverable_output_path'):
            recovered_path = recorder._resolve_recoverable_output_path()
        elif getattr(recorder, 'final_output_path', None):
            recovered_path = recorder.final_output_path

        if not failure and not recovered_path:
            failure = {
                'code': 'RECORDING_FAILED',
                'message': 'Recording did not produce an output file.',
            }

        if failure:
            result = {
                'success': False,
                'code': failure.get('code', 'RECORDING_FAILED'),
                'message': failure.get('message', 'Recording failed.'),
                'duration': recorder.recording_duration or 0,
                'desktopDiagnostics': recorder.desktop_diagnostics,
            }
            if recovered_path:
                result['outputPath'] = recovered_path
            _send_json_message(result)
            sys.exit(1 if exit_code == 0 else exit_code)

        result = {
            'success': True,
            'outputPath': recovered_path or args.output,
            'duration': recorder.recording_duration,
            'desktopDiagnostics': recorder.desktop_diagnostics,
        }
        _send_json_message(result)
        sys.exit(exit_code)

    try:
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
                    else:
                        # stdin EOF while capture is active — stop cleanly (no orphan).
                        stop_event.set()
                except Exception as e:
                    print(f"Error in command listener: {e}", file=sys.stderr)
                    stop_event.set()

            input_thread = threading.Thread(target=input_listener, daemon=True)
            input_thread.start()

            # Main loop - continuously send audio levels for visualization
            # PERFORMANCE: 5 FPS updates to minimize CPU/IPC overhead (matches Windows)
            while not stop_event.is_set():
                if recorder._has_async_recording_error():
                    with recorder._error_lock:
                        error_msg = recorder._last_error or "Unknown recording error"
                    print(f"CRITICAL: Recording thread error: {error_msg}", file=sys.stderr)
                    _send_error_message("RECORDING_THREAD_FAILED", error_msg)
                    break

                # Late desktop helper failures degrade to mic-only; keep recording.
                recorder._consume_desktop_helper_failure()

                if not recorder.is_recording():
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
        try:
            recorder.stop_recording()
        except Exception as stop_err:
            message = f"Recorder failed during stop: {stop_err}"
            print(message, file=sys.stderr)
            recorder.recording_failure = {
                'code': 'RECORDER_FAILED',
                'message': message,
            }
    except Exception as e:
        # Best-effort finalize first. Do not emit a structured error toast yet —
        # stop_recording() may still produce a successful mic-only/mixed file
        # (recording_failure cleared). Only toast when recovery failed.
        #
        # Guard: do not set recording_failure after a successful stop_recording()
        # just because this outer handler caught an earlier exception. Anything
        # added after stop_recording() in the try block must not convert a
        # finished save into RECORDER_FAILED.
        message = f"Recorder failed: {e}"
        print(message, file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        if recorder is not None:
            try:
                if recorder._get_running() or recorder.mic_frames:
                    recorder.stop_recording()
            except Exception as stop_err:
                print(f"Stop after failure also failed: {stop_err}", file=sys.stderr)

            recovered = None
            if hasattr(recorder, '_resolve_recoverable_output_path'):
                recovered = recorder._resolve_recoverable_output_path()
            elif getattr(recorder, 'final_output_path', None):
                recovered = recorder.final_output_path

            if recovered and not getattr(recorder, 'recording_failure', None):
                print(
                    f"Recovered recording after error (no error toast): {recovered}",
                    file=sys.stderr,
                )
            else:
                if not getattr(recorder, 'recording_failure', None):
                    recorder.recording_failure = {
                        'code': 'RECORDER_FAILED',
                        'message': message,
                    }
                _send_error_message("RECORDER_FAILED", message)
        else:
            _send_error_message("RECORDER_FAILED", message)

    emit_final_result()


if __name__ == "__main__":
    main()
