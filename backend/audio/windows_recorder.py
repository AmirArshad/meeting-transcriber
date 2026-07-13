"""
Windows Audio Recorder (v2).

Records microphone and desktop audio to separate buffers, then mixes them
after recording completes (post-processing). This avoids real-time buffer
synchronization issues that cause choppy audio.

Key features:
- Separate mic and desktop audio capture using WASAPI
- Timestamp-based gap preservation for desktop audio (WASAPI loopback only
  sends callbacks when audio is playing)
- Post-processing mix with minimal enhancement for natural sound quality
- High-quality Opus compression via ffmpeg

Module structure:
- constants.py: Configuration values
- processor.py: Audio processing (resampling, enhancement, mixing)
- compressor.py: ffmpeg compression wrapper
- timeline.py: WASAPI gap reconstruction
"""

import sys
import json
import os
import threading
import time
import platform
from pathlib import Path
import numpy as np
import pyaudiowpatch as pyaudio

from . import recorder_stdout as _recorder_stdout


# Lock for thread-safe JSON output to stdout
_stdout_lock = threading.Lock()


def _send_json_message(message):
    _recorder_stdout.send_json_message(message, lock=_stdout_lock)


def _send_event_message(event: str, message: str, **extra):
    _recorder_stdout.send_event_message(
        event,
        message,
        lock=_stdout_lock,
        send_json=_send_json_message,
        **extra,
    )


def _send_warning_message(code: str, message: str, **extra):
    _recorder_stdout.send_warning_message(
        code,
        message,
        lock=_stdout_lock,
        send_json=_send_json_message,
        **extra,
    )


def _send_error_message(code: str, message: str, **extra):
    _recorder_stdout.send_error_message(
        code,
        message,
        lock=_stdout_lock,
        send_json=_send_json_message,
        **extra,
    )

# Import from our modular components
from .constants import (
    DEFAULT_SAMPLE_RATE,
    DEFAULT_CHANNELS,
    DEFAULT_CHUNK_SIZE,
    WINDOWS_CHUNK_MULTIPLIER,
    DEFAULT_PREROLL_SECONDS,
    COMMON_SAMPLE_RATES,
    WATCHDOG_CHECK_INTERVAL,
    WATCHDOG_STALL_THRESHOLD,
    LEVEL_SUBSAMPLE_FACTOR,
    LEVEL_UPDATE_FPS,
    MIC_BOOST_LINEAR,
)
from .processor import (
    resample,
    enhance_microphone,
    downmix_to_stereo,
    mono_to_stereo,
    mix_audio,
    align_audio_lengths,
)
from .compressor import compress_and_report
from .recorder_temp_paths import build_recorder_temp_pcm_path
from .timeline import reconstruct_desktop_timeline, timestamp_to_frame_position
from .wav_io import write_int16_pcm_wav
from .windows_callback_health import evaluate_callback_stalls
from .capture_spool_runtime import capture_spool_enabled
from .capture_manifest import CaptureManifestCoordinator, MANIFEST_FILENAME
from .track_spool import (
    DEFAULT_MAX_QUEUE_BYTES,
    DEFAULT_STALL_TIMEOUT_S,
    TrackSpool,
)
from .streaming_post_processor import FinalizationError, finalize_capture

# Bound desktop PCM deferred until mic_first_capture_time exists (matches spool queue).
DEFERRED_DESKTOP_MAX_BYTES = DEFAULT_MAX_QUEUE_BYTES
# Hard-fail if the mic never produces a first capture while desktop is deferred.
DEFERRED_DESKTOP_MAX_WAIT_S = DEFAULT_STALL_TIMEOUT_S

# Store final output path for meeting manager (legacy interface)
_final_output_path = None
_recording_duration = 0.0

# Known constraint: mic/desktop frames are buffered in RAM for the post-processing
# mix unless AVANEVIS_CAPTURE_SPOOL=1 (segmented track spools during capture;
# Task 9 bounded finalization avoids whole-array hydration on the spool path).
# Long meetings (≈2h stereo 48 kHz) can still peak at several GB on the RAM path;
# MemoryError on that path should still emit structured failure JSON.


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
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        channels: int = DEFAULT_CHANNELS,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        mic_volume: float = 1.0,
        desktop_volume: float = 1.0,
        preroll_seconds: float = None  # None = use default, 0 = no preroll (for production with countdown)
    ):
        """
        Initialize the Windows audio recorder.

        Args:
            mic_device_id: PyAudio device index for microphone
            loopback_device_id: PyAudio device index for desktop audio (-1 to disable)
            output_path: Path for output audio file
            sample_rate: Target output sample rate (default: 48000)
            channels: Target output channels (default: 2 for stereo)
            chunk_size: Audio buffer size in frames (default: 4096)
            mic_volume: Microphone volume multiplier (0.0-1.0)
            desktop_volume: Desktop audio volume multiplier (0.0-1.0)
            preroll_seconds: Seconds to discard at start for device warm-up
                            (None = default 1.5s, 0 = disabled for production)
        """
        _send_event_message("configuring_devices", "Configuring audio devices...")
        self.mic_device_id = mic_device_id
        self.loopback_device_id = loopback_device_id
        self.output_path = output_path
        self.target_sample_rate = sample_rate
        self.target_channels = channels  # Target output channels (always 2 for stereo)
        self.chunk_size = chunk_size
        self.mic_volume = mic_volume
        self.desktop_volume = desktop_volume

        self.pa = pyaudio.PyAudio()
        loopback_info = None

        try:
            # Get device info and auto-detect channel counts
            device_count = self.pa.get_device_count()
            if mic_device_id < 0 or mic_device_id >= device_count:
                raise RuntimeError(
                    f"Microphone device ID {mic_device_id} is out of range (0-{device_count - 1})"
                )

            mic_info = self.pa.get_device_info_by_index(mic_device_id)
            if mic_info.get('maxInputChannels', 0) <= 0:
                raise RuntimeError(f"Microphone device {mic_device_id} has no input channels")

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
                if loopback_device_id >= device_count:
                    raise RuntimeError(
                        f"Loopback device ID {loopback_device_id} is out of range (0-{device_count - 1})"
                    )
                loopback_info = self.pa.get_device_info_by_index(loopback_device_id)
                if loopback_info.get('maxInputChannels', 0) <= 0:
                    raise RuntimeError(f"Loopback device {loopback_device_id} has no input channels")
        except Exception:
            self.pa.terminate()
            self.pa = None
            raise

        if loopback_device_id >= 0 and loopback_info is not None:
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
                print(f"WARNING: Sample rate probing failed!", file=sys.stderr)
                print(f"WARNING: Using default rate - audio may be distorted", file=sys.stderr)
                print(f"WARNING: Error: {e}", file=sys.stderr)
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
        # Mic frames: just audio data (continuous callbacks even during silence)
        # Desktop frames: (timestamp, audio_data) tuples to preserve gaps
        # WASAPI loopback only sends callbacks when audio is playing, so we need
        # timestamps to reconstruct the timeline with proper silence gaps
        self.mic_frames = []
        self.desktop_frames = []  # List of (timestamp, audio_data) tuples
        self.is_recording = False
        self.lock = threading.Lock()

        # Optional durable spool path (AVANEVIS_CAPTURE_SPOOL=1). Default off.
        self._use_capture_spool = capture_spool_enabled()
        self._capture_manifest = None
        self._mic_spool = None
        self._desktop_spool = None
        self._async_capture_error = None
        self._spool_desktop_pcm = None  # loaded int16 samples when spool path used
        self._spool_error_lock = threading.Lock()
        # Desktop chunks that arrived before mic_first_capture_time was known.
        # Serialized with direct desktop appends via `_desktop_spool_lock`.
        self._deferred_desktop_chunks = []
        self._deferred_desktop_bytes = 0
        self._deferred_desktop_started_at = None
        self._desktop_spool_lock = threading.Lock()
        self._desktop_spool_accepted_any = False
        self._desktop_spool_warning = None

        # Pre-roll: discard first N seconds for device warm-up
        # In production, the 3-second countdown handles warm-up, so preroll can be 0
        # NOTE: Preroll is time-based (checked in callbacks), not frame-count based
        self.preroll_seconds = DEFAULT_PREROLL_SECONDS if preroll_seconds is None else preroll_seconds

        self.mic_frame_count = 0
        self.desktop_frame_count = 0
        self.mic_total_bytes = 0

        # Time-based synchronization - SINGLE reference point set at recording start
        # Both streams use the same reference to ensure they stay in sync
        self.recording_start_time = None

        # Audio levels (0.0 to 1.0)
        self.mic_level = 0.0
        self.desktop_level = 0.0

        # Streams
        self.mic_stream = None
        self.desktop_stream = None

        # Callback watchdog to detect audio stream stalls
        self.last_mic_callback_time = None
        self.last_desktop_callback_time = None
        self.callback_watchdog = None
        self.watchdog_running = False
        self.mic_watchdog_warning_shown = False
        self.desktop_watchdog_warning_shown = False

        # Platform detection (already imported at module level)
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

        # Priority order: default first, then common rates from constants
        rates_to_try = [default_rate]
        for rate in COMMON_SAMPLE_RATES:
            if rate != default_rate and rate not in rates_to_try:
                rates_to_try.append(rate)

        print(f"Probing loopback device sample rates...", file=sys.stderr)
        print(f"  Device: {device_info.get('name', 'Unknown')}", file=sys.stderr)
        if channels > 2:
            print(f"  Device has {channels} channels (surround sound), will downmix to stereo after recording", file=sys.stderr)
        print(f"  Trying rates: {rates_to_try}", file=sys.stderr)

        for rate in rates_to_try:
            test_stream = None
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
                print(f"Success!", file=sys.stderr)
                print(f"  Loopback device will use {rate} Hz, {channels} channel(s)", file=sys.stderr)
                return (rate, channels)

            except Exception as e:
                print(f"Failed: {str(e)[:50]}", file=sys.stderr)
                continue
            finally:
                # Always close the stream if it was opened (prevents resource leak)
                if test_stream is not None:
                    try:
                        test_stream.close()
                    except Exception:
                        pass  # Ignore errors during cleanup

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
        current_time = time.time()
        self.last_mic_callback_time = current_time

        if status:
            print(f"Mic status: {status}", file=sys.stderr)

        if self.is_recording:
            self.mic_frame_count += 1

            # DEBUG: Track first callback time
            if self.mic_first_callback_time is None:
                self.mic_first_callback_time = current_time
                print(f"DEBUG MIC: First callback at {current_time - self.recording_start_time:.4f}s after recording start", file=sys.stderr)

            # TIME-BASED SYNCHRONIZATION: Use shared reference set at recording start
            # Both streams use the same recording_start_time (set in start_recording)
            # This ensures they skip the same wall-clock period and stay in sync
            elapsed = current_time - self.recording_start_time

            # Calculate level for visualization (subsampled for performance)
            try:
                data = np.frombuffer(in_data, dtype=np.int16)
                peak = np.abs(data[::LEVEL_SUBSAMPLE_FACTOR]).max() if len(data) > 0 else 0
                self.mic_level = float(peak) / 32768.0
            except Exception:
                self.mic_level = 0.0

            if elapsed >= self.preroll_seconds:
                # DEBUG: Track first capture time
                if self.mic_first_capture_time is None and not self._use_capture_spool:
                    self.mic_first_capture_time = current_time
                    print(f"DEBUG MIC: First CAPTURE at {elapsed:.4f}s elapsed (preroll={self.preroll_seconds}s)", file=sys.stderr)

                if self._use_capture_spool:
                    if self._mic_spool is None:
                        self._note_async_capture_error(
                            "Capture spool was not ready when microphone audio arrived."
                        )
                        return (in_data, pyaudio.paComplete)
                    accepted = self._mic_spool.append(in_data)
                    if not accepted:
                        self._note_async_capture_error(
                            "Audio capture writer stalled; recording was stopped to preserve committed audio."
                        )
                        return (in_data, pyaudio.paComplete)
                    with self.lock:
                        self.mic_total_bytes += len(in_data)
                    # Set mic reference and flush deferred desktop under one lock so a
                    # concurrent desktop callback cannot append ahead of older deferred PCM.
                    with self._desktop_spool_lock:
                        if self.mic_first_capture_time is None:
                            self.mic_first_capture_time = current_time
                            print(
                                f"DEBUG MIC: First CAPTURE at {elapsed:.4f}s elapsed "
                                f"(preroll={self.preroll_seconds}s)",
                                file=sys.stderr,
                            )
                        self._flush_deferred_desktop_spool_locked()
                else:
                    with self.lock:
                        self.mic_frames.append(in_data)
                        self.mic_total_bytes += len(in_data)

        return (in_data, pyaudio.paContinue)

    def _desktop_callback(self, in_data, frame_count, time_info, status):
        """Callback for desktop audio."""
        current_time = time.time()
        self.last_desktop_callback_time = current_time

        if status:
            print(f"Desktop status: {status}", file=sys.stderr)

        if self.is_recording:
            self.desktop_frame_count += 1

            # DEBUG: Track first callback time
            if self.desktop_first_callback_time is None:
                self.desktop_first_callback_time = current_time
                print(f"DEBUG DESKTOP: First callback at {current_time - self.recording_start_time:.4f}s after recording start", file=sys.stderr)

            # TIME-BASED SYNCHRONIZATION: Use shared reference set at recording start
            # Both streams use the same recording_start_time (set in start_recording)
            # This ensures they skip the same wall-clock period and stay in sync
            elapsed = current_time - self.recording_start_time

            # Calculate level for visualization (subsampled for performance)
            try:
                data = np.frombuffer(in_data, dtype=np.int16)
                peak = np.abs(data[::LEVEL_SUBSAMPLE_FACTOR]).max() if len(data) > 0 else 0
                self.desktop_level = float(peak) / 32768.0
            except Exception:
                self.desktop_level = 0.0

            if elapsed >= self.preroll_seconds:
                # DEBUG: Track first capture time
                if self.desktop_first_capture_time is None:
                    self.desktop_first_capture_time = current_time
                    print(f"DEBUG DESKTOP: First CAPTURE at {elapsed:.4f}s elapsed (preroll={self.preroll_seconds}s)", file=sys.stderr)

                if self._use_capture_spool:
                    with self._desktop_spool_lock:
                        if self._desktop_spool is None:
                            self._note_async_capture_error(
                                "Capture spool was not ready when desktop audio arrived."
                            )
                            return (in_data, pyaudio.paComplete)
                        reference = self.mic_first_capture_time
                        if reference is None:
                            # Defer until mic reference exists (do not silently drop).
                            if not self._enqueue_deferred_desktop_locked(current_time, in_data):
                                return (in_data, pyaudio.paComplete)
                            return (in_data, pyaudio.paContinue)
                        # Flush any leftover deferred chunks before accepting live audio.
                        self._flush_deferred_desktop_spool_locked()
                        if not self._append_desktop_spool_chunk(current_time, in_data, reference):
                            return (in_data, pyaudio.paComplete)
                else:
                    with self.lock:
                        # Store timestamp with audio data to preserve gaps
                        # WASAPI loopback only sends callbacks when audio is playing
                        # We need timestamps to reconstruct timeline with proper silence
                        self.desktop_frames.append((current_time, in_data))

        return (in_data, pyaudio.paContinue)

    def _note_async_capture_error(self, message: str) -> None:
        with self._spool_error_lock:
            if self._async_capture_error is None:
                self._async_capture_error = message
        self.is_recording = False

    def get_async_capture_error(self):
        with self._spool_error_lock:
            return self._async_capture_error

    def _append_desktop_spool_chunk(self, timestamp: float, in_data: bytes, reference: float) -> bool:
        """Place one desktop chunk on the spool. Returns False on hard spool failure.

        Caller must hold ``_desktop_spool_lock``.
        """
        frame_pos = timestamp_to_frame_position(
            timestamp,
            reference,
            self.loopback_sample_rate,
        )
        if frame_pos < 0:
            # Pre-mic-reference frames are trimmed (matches reconstruct_desktop_timeline).
            return True
        accepted = self._desktop_spool.append(in_data, frame_position=frame_pos)
        if not accepted:
            self._note_async_capture_error(
                "Audio capture writer stalled; recording was stopped to preserve committed audio."
            )
            return False
        self._desktop_spool_accepted_any = True
        return True

    def _enqueue_deferred_desktop_locked(self, timestamp: float, in_data: bytes) -> bool:
        """Queue desktop PCM until mic reference exists. Caller holds ``_desktop_spool_lock``."""
        payload = bytes(in_data)
        if self._deferred_desktop_started_at is None:
            self._deferred_desktop_started_at = timestamp
        waited = timestamp - self._deferred_desktop_started_at
        if waited > DEFERRED_DESKTOP_MAX_WAIT_S:
            self._note_async_capture_error(
                "Microphone capture did not start while desktop audio was deferred; "
                "recording was stopped to bound memory use."
            )
            return False
        next_bytes = self._deferred_desktop_bytes + len(payload)
        if next_bytes > DEFERRED_DESKTOP_MAX_BYTES:
            self._note_async_capture_error(
                "Deferred desktop audio exceeded the capture memory bound while waiting "
                "for microphone capture; recording was stopped to preserve committed audio."
            )
            return False
        self._deferred_desktop_chunks.append((timestamp, payload))
        self._deferred_desktop_bytes = next_bytes
        return True

    def _flush_deferred_desktop_spool(self) -> None:
        """Write desktop chunks that arrived before the mic reference existed."""
        with self._desktop_spool_lock:
            self._flush_deferred_desktop_spool_locked()

    def _flush_deferred_desktop_spool_locked(self) -> None:
        """Flush deferred desktop PCM. Caller must hold ``_desktop_spool_lock``."""
        if not self._deferred_desktop_chunks or self._desktop_spool is None:
            return
        reference = self.mic_first_capture_time
        if reference is None:
            return
        deferred = self._deferred_desktop_chunks
        self._deferred_desktop_chunks = []
        self._deferred_desktop_bytes = 0
        self._deferred_desktop_started_at = None
        for timestamp, payload in deferred:
            if not self._append_desktop_spool_chunk(timestamp, payload, reference):
                return

    def _close_streams(self):
        """Stop and close any partially opened PyAudio streams."""
        if self.mic_stream is not None:
            try:
                if self.mic_stream.is_active():
                    self.mic_stream.stop_stream()
            except Exception:
                pass
            try:
                self.mic_stream.close()
            except Exception:
                pass
            self.mic_stream = None

        if self.desktop_stream is not None:
            try:
                if self.desktop_stream.is_active():
                    self.desktop_stream.stop_stream()
            except Exception:
                pass
            try:
                self.desktop_stream.close()
            except Exception:
                pass
            self.desktop_stream = None

    def _open_capture_spools(self) -> None:
        started_ns = time.time_ns()
        started_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"
        self._capture_manifest = CaptureManifestCoordinator.create(
            self.output_path,
            started_at_ns=started_ns,
            started_at_iso=started_iso,
        )
        self._capture_manifest.set_processing_profile("windows-v1")
        self._capture_manifest.set_mix_params(
            mic_volume=float(getattr(self, "mic_volume", 1.0)),
            desktop_volume=float(getattr(self, "desktop_volume", 1.0)),
            mic_boost=MIC_BOOST_LINEAR,
        )
        self._capture_manifest.add_track(
            "mic",
            sample_rate=self.mic_sample_rate,
            channels=self.mic_channels,
            dtype="<i2",
        )
        self._mic_spool = TrackSpool(
            self._capture_manifest,
            self._capture_manifest.session_dir,
            "mic",
            sample_rate=self.mic_sample_rate,
            channels=self.mic_channels,
            dtype="<i2",
        )
        if self.mixing_mode:
            self._capture_manifest.add_track(
                "desktop",
                sample_rate=self.loopback_sample_rate,
                channels=self.loopback_channels,
                dtype="<i2",
            )
            self._desktop_spool = TrackSpool(
                self._capture_manifest,
                self._capture_manifest.session_dir,
                "desktop",
                sample_rate=self.loopback_sample_rate,
                channels=self.loopback_channels,
                dtype="<i2",
            )

    def _close_capture_spools_for_mix(self) -> None:
        """Close/commit spools and prepare the manifest for bounded finalization."""
        if not self._use_capture_spool:
            return

        # Place any remaining deferred desktop audio before closing.
        self._flush_deferred_desktop_spool()

        mic_result = None
        desk_result = None
        mic_spool = self._mic_spool
        desk_spool = self._desktop_spool
        self._mic_spool = None
        self._desktop_spool = None
        include_desktop = False

        try:
            if mic_spool is not None:
                mic_result = mic_spool.close()
            if desk_spool is not None:
                # Never materialize an empty or failed desktop track as full-duration silence.
                desktop_failed = bool(desk_spool.fail_reason)
                pad_to = None
                mic_frames = 0 if mic_result is None else mic_result.committed_frames
                if (
                    not desktop_failed
                    and self._desktop_spool_accepted_any
                    and mic_frames > 0
                    and self.mic_sample_rate > 0
                    and (mic_result is None or not mic_result.fail_reason)
                ):
                    mic_duration = mic_frames / float(self.mic_sample_rate)
                    pad_to = int(mic_duration * self.loopback_sample_rate)
                desk_result = desk_spool.close(final_frame_count=pad_to)
        except Exception:
            for leftover in (mic_spool, desk_spool):
                if leftover is None:
                    continue
                try:
                    leftover.close()
                except Exception:
                    pass
            raise

        if mic_result is not None and mic_result.fail_reason:
            raise RuntimeError(
                f"Microphone capture spool failed: {mic_result.fail_reason}"
            )

        if desk_result is not None and desk_result.fail_reason:
            warning = (
                f"Desktop capture spool failed; continuing with microphone only. "
                f"({desk_result.fail_reason})"
            )
            self._desktop_spool_warning = warning
            print(f"WARNING: {warning}", file=sys.stderr)
            try:
                _send_warning_message(
                    "DESKTOP_SPOOL_FAILED",
                    warning,
                    help="The meeting audio was saved from the microphone. Desktop/system audio may be missing.",
                )
            except Exception:
                pass
            include_desktop = False
        elif desk_result is not None:
            include_desktop = bool(
                self._desktop_spool_accepted_any
                and desk_result.committed_frames > 0
            )

        # Spool path no longer hydrates whole tracks into RAM (Task 9).
        self.mic_frames = []
        self.desktop_frames = []
        self._spool_desktop_pcm = np.array([], dtype=np.int16)
        if mic_result is not None:
            self.mic_total_bytes = (
                mic_result.committed_frames * self.mic_channels * 2
            )

        if self._capture_manifest is not None:
            try:
                self._capture_manifest.set_include_desktop(include_desktop)
                self._capture_manifest.set_state("finalizing")
            except Exception:
                pass

    def _finalize_from_capture_spools(self) -> None:
        """Run bounded multi-pass finalization for the spool path."""
        global _final_output_path, _recording_duration
        if self._capture_manifest is None:
            raise RuntimeError("Capture manifest missing for spool finalization")

        def _progress(stage: str, message: str) -> None:
            try:
                _send_event_message(stage, message)
            except Exception:
                pass

        manifest_path = self._capture_manifest.session_dir / MANIFEST_FILENAME
        try:
            result = finalize_capture(
                manifest_path,
                self.output_path,
                ffmpeg_path=os.environ.get("AVANEVIS_FFMPEG") or "ffmpeg",
                progress_callback=_progress,
                coordinator=self._capture_manifest,
            )
        except FinalizationError as exc:
            if exc.recoverable_path:
                _final_output_path = exc.recoverable_path
                self.output_path = exc.recoverable_path
            raise

        self.output_path = result.final_path
        _final_output_path = result.final_path
        _recording_duration = float(result.duration)
        print(f"Audio saved!", file=sys.stderr)
        print(f"  File: {Path(result.final_path).name}", file=sys.stderr)
        print(f"  Duration: {result.duration:.2f} seconds", file=sys.stderr)

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

    def _abort_start_recording(self):
        """Reset recording state and close any streams opened during a failed start."""
        self.is_recording = False
        self._release_capture_spools()
        self.watchdog_running = False
        if self.callback_watchdog and self.callback_watchdog.is_alive():
            self.callback_watchdog.join(timeout=1.0)
        self._close_streams()

    def start_recording(self):
        """Start recording from both sources."""
        print("Starting recording...", file=sys.stderr)

        # Reset buffers and counters
        self.mic_frames = []
        self.desktop_frames = []
        self.mic_frame_count = 0
        self.desktop_frame_count = 0
        self.mic_total_bytes = 0
        self.is_recording = True
        self.mic_watchdog_warning_shown = False
        self.desktop_watchdog_warning_shown = False
        self.last_mic_callback_time = None
        self.last_desktop_callback_time = None
        self._async_capture_error = None
        self._spool_desktop_pcm = None
        self._use_capture_spool = capture_spool_enabled()
        self._deferred_desktop_chunks = []
        self._deferred_desktop_bytes = 0
        self._deferred_desktop_started_at = None
        self._desktop_spool_accepted_any = False
        self._desktop_spool_warning = None

        # Increase chunk size on Windows for better resilience to backgrounding
        # Larger buffers = more tolerance for process scheduling delays
        if self.is_windows:
            self.chunk_size = self.original_chunk_size * WINDOWS_CHUNK_MULTIPLIER
            print(f"Windows: Using {self.chunk_size} frame buffer for background resilience", file=sys.stderr)
            if self.preroll_seconds > 0:
                print(f"  Preroll: {self.preroll_seconds}s (time-based)", file=sys.stderr)
            else:
                print(f"  Preroll disabled (production mode)", file=sys.stderr)

        # Set recording start time BEFORE starting streams
        # This is the single reference point for both streams' preroll timing
        # Setting it here (not in callbacks) ensures both streams use the SAME reference
        self.recording_start_time = time.time()

        # DEBUG: Track first capture times to verify synchronization
        self.mic_first_capture_time = None
        self.desktop_first_capture_time = None
        self.mic_first_callback_time = None
        self.desktop_first_callback_time = None

        # NOTE: Thread priority boost removed - it only affects main thread, not audio callbacks
        # PyAudio's internal callback threads cannot be easily accessed from Python

        # Open streams with start=False so sample-rate fallback can settle before
        # capture spools/manifests are created with the final rates.
        try:
            self.mic_stream = self.pa.open(
                format=pyaudio.paInt16,
                channels=self.mic_channels,
                rate=self.mic_sample_rate,  # Try higher quality rate
                input=True,
                input_device_index=self.mic_device_id,
                frames_per_buffer=self.chunk_size,
                stream_callback=self._mic_callback,
                start=False,
            )
            print(f"✓ Microphone stream opened at {self.mic_sample_rate} Hz", file=sys.stderr)
            _send_event_message("mic_stream_opened", "Microphone stream opened")
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
                        stream_callback=self._mic_callback,
                        start=False,
                    )
                    print(f"✓ Microphone stream opened at {self.mic_sample_rate} Hz (fallback)", file=sys.stderr)
                    _send_event_message("mic_stream_opened", "Microphone stream opened")
                except Exception as e2:
                    self._abort_start_recording()
                    raise RuntimeError(f"Failed to open microphone stream: {e2}")
            else:
                self._abort_start_recording()
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
                    stream_callback=self._desktop_callback,
                    start=False,
                )
                print(f"✓ Desktop audio stream opened successfully", file=sys.stderr)
                _send_event_message("desktop_stream_opened", "Desktop audio stream opened")
            except Exception as e:
                self._abort_start_recording()
                raise RuntimeError(f"Failed to open desktop audio stream (device {self.loopback_device_id}): {e}")

        # Open durable spools AFTER rates settle and BEFORE streams start so the
        # first callbacks cannot fall through to the RAM path and be discarded at stop.
        if self._use_capture_spool:
            try:
                self._open_capture_spools()
                print("Capture spool path enabled (AVANEVIS_CAPTURE_SPOOL=1)", file=sys.stderr)
            except Exception as spool_err:
                self._abort_start_recording()
                raise RuntimeError(f"Failed to open capture spools: {spool_err}") from spool_err

        # Start streams
        try:
            self.mic_stream.start_stream()
            if self.desktop_stream:
                self.desktop_stream.start_stream()
        except Exception as e:
            self._abort_start_recording()
            raise RuntimeError(f"Failed to start audio streams: {e}")

        # Start watchdog thread to detect callback stalls
        def watchdog():
            """Monitor audio callback health and warn if stalled."""
            self.watchdog_running = True

            while self.is_recording and self.watchdog_running:
                time.sleep(WATCHDOG_CHECK_INTERVAL)

                if self.is_recording:
                    stall_state = evaluate_callback_stalls(
                        now=time.time(),
                        threshold_seconds=WATCHDOG_STALL_THRESHOLD,
                        mixing_mode=self.mixing_mode,
                        last_mic_callback_time=self.last_mic_callback_time,
                        last_desktop_callback_time=self.last_desktop_callback_time,
                        mic_warning_shown=self.mic_watchdog_warning_shown,
                        desktop_warning_shown=self.desktop_watchdog_warning_shown,
                    )

                    if stall_state['warn_mic']:
                        elapsed = stall_state['mic_elapsed']
                        print(f"", file=sys.stderr)
                        print(f"=" * 70, file=sys.stderr)
                        print(f"ERROR: Microphone callback stalled!", file=sys.stderr)
                        print(f"  No microphone callback received for {elapsed:.1f} seconds", file=sys.stderr)
                        print(f"  This may indicate the process was suspended by Windows", file=sys.stderr)
                        print(f"  when the app was sent to the background.", file=sys.stderr)
                        print(f"", file=sys.stderr)
                        print(f"  Microphone audio may be incomplete.", file=sys.stderr)
                        print(f"=" * 70, file=sys.stderr)
                        print(f"", file=sys.stderr)
                        _send_warning_message(
                            "MIC_CALLBACK_STALLED",
                            f"No microphone callback received for {elapsed:.1f} seconds. Microphone audio may be incomplete.",
                            help="Keep the app in the foreground and confirm the selected microphone is still active.",
                        )
                        self.mic_watchdog_warning_shown = True

                    if stall_state['warn_desktop']:
                        elapsed = stall_state['desktop_elapsed']
                        print(f"", file=sys.stderr)
                        print(f"=" * 70, file=sys.stderr)
                        print(f"ERROR: Desktop audio callback stalled!", file=sys.stderr)
                        print(f"  No desktop callback received for {elapsed:.1f} seconds", file=sys.stderr)
                        print(f"  This may indicate the process was suspended by Windows", file=sys.stderr)
                        print(f"  when the app was sent to the background.", file=sys.stderr)
                        print(f"", file=sys.stderr)
                        print(f"  Desktop audio may be incomplete.", file=sys.stderr)
                        print(f"=" * 70, file=sys.stderr)
                        print(f"", file=sys.stderr)
                        _send_warning_message(
                            "DESKTOP_CALLBACK_STALLED",
                            f"No desktop callback received for {elapsed:.1f} seconds. Desktop audio may be incomplete.",
                            help="Keep the app in the foreground and confirm system audio is still playing to the selected desktop device.",
                        )
                        self.desktop_watchdog_warning_shown = True

        self.callback_watchdog = threading.Thread(target=watchdog, daemon=True)
        self.callback_watchdog.start()

        _send_event_message("recording_started", "Recording started!")
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
        self._close_streams()

        print(f"Streams stopped", file=sys.stderr)
        if self._use_capture_spool:
            try:
                self._close_capture_spools_for_mix()
            except Exception as spool_err:
                self._note_async_capture_error(f"Failed to close capture spools: {spool_err}")
                # Still release handles; caller / CLI treats async error as failure.
                self._release_capture_spools()
                raise
            print(f"  Mic spool bytes: {self.mic_total_bytes}", file=sys.stderr)
            include = False
            if self._capture_manifest is not None:
                include = bool(self._capture_manifest.to_dict().get("includeDesktop"))
            print(f"  Desktop spool included: {include}", file=sys.stderr)
        else:
            print(f"  Mic frames: {len(self.mic_frames)}", file=sys.stderr)
            print(f"  Desktop frames: {len(self.desktop_frames)}", file=sys.stderr)

        # Async spool failures discovered at close must not continue into mix/success.
        async_err = self.get_async_capture_error()
        if async_err:
            raise RuntimeError(async_err)

        # DEBUG: Print timing diagnostics
        print(f"", file=sys.stderr)
        print(f"=" * 60, file=sys.stderr)
        print(f"DEBUG: TIMING DIAGNOSTICS", file=sys.stderr)
        print(f"=" * 60, file=sys.stderr)
        print(f"  Recording start time: {self.recording_start_time}", file=sys.stderr)
        print(f"  Preroll seconds: {self.preroll_seconds}", file=sys.stderr)
        print(f"", file=sys.stderr)

        if self.mic_first_callback_time is not None:
            mic_cb_offset = self.mic_first_callback_time - self.recording_start_time
            print(f"  MIC first callback: {mic_cb_offset:.4f}s after recording start", file=sys.stderr)
        else:
            print(f"  MIC first callback: NEVER (no callbacks received!)", file=sys.stderr)

        if self.mic_first_capture_time is not None:
            mic_cap_offset = self.mic_first_capture_time - self.recording_start_time
            print(f"  MIC first capture:  {mic_cap_offset:.4f}s after recording start", file=sys.stderr)
        else:
            print(f"  MIC first capture: NEVER (preroll never elapsed or no callbacks)", file=sys.stderr)

        print(f"", file=sys.stderr)

        if self.desktop_first_callback_time is not None:
            desk_cb_offset = self.desktop_first_callback_time - self.recording_start_time
            print(f"  DESKTOP first callback: {desk_cb_offset:.4f}s after recording start", file=sys.stderr)
        else:
            print(f"  DESKTOP first callback: NEVER (no callbacks received!)", file=sys.stderr)

        if self.desktop_first_capture_time is not None:
            desk_cap_offset = self.desktop_first_capture_time - self.recording_start_time
            print(f"  DESKTOP first capture:  {desk_cap_offset:.4f}s after recording start", file=sys.stderr)
        else:
            print(f"  DESKTOP first capture: NEVER (preroll never elapsed or no callbacks)", file=sys.stderr)

        # KEY DIAGNOSTIC: Compare when each stream first captured audio.
        # NOTE: WASAPI loopback only delivers callbacks while desktop audio is
        # actually playing, so a positive delta just means the desktop was silent
        # for that long at the start. timeline.py reconstructs the desktop track
        # relative to the mic's first capture and inserts exactly that much leading
        # silence, so this offset is corrected during mixing (no overlap, no lost
        # audio). A negative delta (desktop before mic) is also handled by the
        # overlap-trim logic in timeline.reconstruct_desktop_timeline.
        if self.mic_first_capture_time is not None and self.desktop_first_capture_time is not None:
            capture_delta = self.desktop_first_capture_time - self.mic_first_capture_time
            print(f"", file=sys.stderr)
            print(f"  CAPTURE TIME DELTA: {capture_delta:.4f}s", file=sys.stderr)
            if capture_delta > 0.1:
                print(
                    f"  Desktop audio started {capture_delta:.4f}s after the mic "
                    f"(expected for loopback when the desktop is initially silent; "
                    f"timeline reconstruction inserts matching leading silence).",
                    file=sys.stderr,
                )
            elif capture_delta < -0.1:
                print(
                    f"  Desktop audio started {abs(capture_delta):.4f}s before the mic "
                    f"(timeline reconstruction trims pre-reference frames).",
                    file=sys.stderr,
                )
            else:
                print(f"  (Captures started within 100ms - timing looks OK)", file=sys.stderr)

        print(f"=" * 60, file=sys.stderr)
        print(f"", file=sys.stderr)

        # Mix and save with detailed error handling
        try:
            if self._use_capture_spool:
                self._finalize_from_capture_spools()
            else:
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
        if self._use_capture_spool:
            # Manifest lock released after successful finalize cleanup; best-effort
            # close if finalize left the coordinator open after a partial failure.
            self._release_capture_spools()

        print("Recording stopped!", file=sys.stderr)

    def _reconstruct_desktop_timeline(self):
        """
        Reconstruct desktop audio timeline from timestamped frames.

        Delegates to the timeline module for the actual reconstruction.
        See timeline.py for implementation details.
        """
        return reconstruct_desktop_timeline(
            desktop_frames=self.desktop_frames,
            mic_frames=self.mic_frames,
            mic_first_capture_time=self.mic_first_capture_time,
            mic_sample_rate=self.mic_sample_rate,
            mic_channels=self.mic_channels,
            loopback_sample_rate=self.loopback_sample_rate,
            loopback_channels=self.loopback_channels,
            mic_total_bytes=self.mic_total_bytes,
        )

    def _mix_and_save(self):
        """Mix the two audio sources and save to file."""
        _send_event_message("post_processing_started", "Finishing recording...")
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

        _send_event_message("audio_normalizing", "Normalizing audio...")

        # Convert to numpy arrays
        mic_audio = np.frombuffer(b''.join(self.mic_frames), dtype=np.int16)
        mic_duration = len(mic_audio) / self.mic_sample_rate / self.mic_channels
        print(f"  Raw mic audio: {len(mic_audio)} samples ({mic_duration:.2f} seconds at {self.mic_sample_rate} Hz, {self.mic_channels} ch)", file=sys.stderr)

        has_desktop = (
            (self._spool_desktop_pcm is not None and len(self._spool_desktop_pcm) > 0)
            or bool(self.desktop_frames)
        )
        if self.mixing_mode and has_desktop:
            # TIMELINE RECONSTRUCTION: Desktop frames have timestamps to preserve gaps
            # WASAPI loopback only sends callbacks when audio is playing, so we need
            # to reconstruct the full timeline with silence where there was no audio.
            # Spool path materializes silence on disk during capture.
            if self._spool_desktop_pcm is not None and len(self._spool_desktop_pcm) > 0:
                desktop_audio = self._spool_desktop_pcm
            else:
                desktop_audio = self._reconstruct_desktop_timeline()
            desktop_duration = len(desktop_audio) / self.loopback_sample_rate / self.loopback_channels
            print(f"  Reconstructed desktop audio: {len(desktop_audio)} samples ({desktop_duration:.2f} seconds at {self.loopback_sample_rate} Hz, {self.loopback_channels} ch)", file=sys.stderr)

            # Resample both to target rate (using processor module)
            if self.mic_sample_rate != self.target_sample_rate:
                print(f"  Resampling mic: {self.mic_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                mic_audio = resample(
                    mic_audio,
                    self.mic_sample_rate,
                    self.target_sample_rate,
                    num_channels=self.mic_channels,
                )

            # CHANNEL FIX: Handle multi-channel mic (some USB mics have 4+ channels)
            if self.mic_channels > 2:
                mic_audio = downmix_to_stereo(mic_audio, self.mic_channels)
            elif self.mic_channels == 1 and self.target_channels == 2:
                print(f"  Converting mic from mono to stereo...", file=sys.stderr)
                mic_audio = mono_to_stereo(mic_audio)

            # Apply noise reduction to microphone audio only (using processor module)
            print(f"  Applying noise reduction to mic...", file=sys.stderr)
            mic_audio = enhance_microphone(mic_audio, self.target_sample_rate, self.target_channels)

            if self.loopback_sample_rate != self.target_sample_rate:
                print(f"  Resampling desktop: {self.loopback_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                desktop_audio = resample(
                    desktop_audio,
                    self.loopback_sample_rate,
                    self.target_sample_rate,
                    num_channels=self.loopback_channels,
                )

            # CHANNEL FIX: Downmix multi-channel audio to stereo (using processor module)
            if self.loopback_channels > 2:
                desktop_audio = downmix_to_stereo(desktop_audio, self.loopback_channels)
            elif self.loopback_channels == 1 and self.target_channels == 2:
                print(f"  Converting desktop audio from mono to stereo...", file=sys.stderr)
                desktop_audio = mono_to_stereo(desktop_audio)

            # Align audio lengths (using processor module)
            mic_len = len(mic_audio)
            desktop_len = len(desktop_audio)

            # Safety check: ensure we have valid audio data
            if max(mic_len, desktop_len) == 0:
                raise RuntimeError(
                    "Audio alignment failed - both audio tracks are empty after resampling. "
                    "This may be due to audio buffer corruption or device issues."
                )

            print(f"  Aligning audio lengths: mic={mic_len} samples, desktop={desktop_len} samples", file=sys.stderr)
            mic_audio, desktop_audio = align_audio_lengths(mic_audio, desktop_audio)

            if len(mic_audio) != mic_len:
                print(f"  Padded mic END with {len(mic_audio) - mic_len} samples of silence", file=sys.stderr)
            if len(desktop_audio) != desktop_len:
                print(f"  Padded desktop END with {len(desktop_audio) - desktop_len} samples of silence", file=sys.stderr)

            # Mix (using processor module)
            _send_event_message("audio_mixing", "Mixing audio...")
            print("  Mixing mic + desktop...", file=sys.stderr)
            final_audio = mix_audio(
                mic_audio, desktop_audio,
                mic_volume=self.mic_volume,
                desktop_volume=self.desktop_volume,
                mic_boost=MIC_BOOST_LINEAR
            )

        else:
            # Mic-only
            if self.mic_sample_rate != self.target_sample_rate:
                print(f"  Resampling mic: {self.mic_sample_rate} Hz → {self.target_sample_rate} Hz", file=sys.stderr)
                mic_audio = resample(
                    mic_audio,
                    self.mic_sample_rate,
                    self.target_sample_rate,
                    num_channels=self.mic_channels,
                )

            # CHANNEL FIX: Handle multi-channel mic (some USB mics have 4+ channels)
            if self.mic_channels > 2:
                mic_audio = downmix_to_stereo(mic_audio, self.mic_channels)
            elif self.mic_channels == 1 and self.target_channels == 2:
                print(f"  Converting mic from mono to stereo...", file=sys.stderr)
                mic_audio = mono_to_stereo(mic_audio)

            # Apply noise reduction to microphone audio (using processor module)
            print(f"  Applying noise reduction to mic...", file=sys.stderr)
            mic_audio = enhance_microphone(mic_audio, self.target_sample_rate, self.target_channels)

            # Mic-only still reports the mixing stage so Electron progress stays aligned.
            _send_event_message("audio_mixing", "Preparing microphone audio...")
            final_audio = mic_audio

        # Validate final audio is not empty
        if len(final_audio) == 0:
            raise RuntimeError(
                "Audio processing resulted in empty output. "
                "This may be due to audio buffer corruption or processing errors."
            )

        duration = len(final_audio) / (self.target_sample_rate * self.target_channels)
        print(f"  Final audio length: {len(final_audio)} samples ({duration:.2f} seconds)", file=sys.stderr)

        # Save to temporary PCM with a non-scanned extension (.pcm.tmp).
        # Leftover .temp.wav files were previously imported as duplicate meetings.
        temp_wav = build_recorder_temp_pcm_path(self.output_path)
        print(f"Saving temporary WAV...", file=sys.stderr)
        write_int16_pcm_wav(
            temp_wav,
            final_audio,
            channels=self.target_channels,
            sample_rate=self.target_sample_rate,
            sample_width=self.pa.get_sample_size(pyaudio.paInt16),
        )

        # Compress with ffmpeg (using compressor module)
        _send_event_message("audio_encoding", "Encoding audio...")
        final_path, stats = compress_and_report(
            temp_wav,
            self.output_path,
            self.target_sample_rate,
            progress_message="Compressing with ffmpeg (128 kbps Opus)...",
        )

        # Publish the final path before temp cleanup so antivirus/OneDrive
        # PermissionError on unlink still leaves Electron a recoverable payload.
        self.output_path = final_path
        global _final_output_path, _recording_duration
        _final_output_path = final_path
        _recording_duration = duration

        # Clean up temp file (best-effort; locked temps are cleaned by scan-import)
        try:
            Path(temp_wav).unlink()
        except OSError as unlink_err:
            print(f"Warning: Could not remove temp recording file: {unlink_err}", file=sys.stderr)

        file_size = stats['output_size']
        temp_size = stats['input_size']
        compression_ratio = stats['ratio']

        print(f"Audio saved!", file=sys.stderr)
        print(f"  File: {Path(final_path).name}", file=sys.stderr)
        print(f"  Size: {file_size / 1024 / 1024:.2f} MB (was {temp_size / 1024 / 1024:.2f} MB, {compression_ratio:.1f}% smaller)", file=sys.stderr)
        print(f"  Duration: {duration:.2f} seconds", file=sys.stderr)
        print(f"  Sample rate: {self.target_sample_rate} Hz", file=sys.stderr)
        _send_event_message("post_processing_complete", "Recording saved.")

    def cleanup(self):
        """Clean up resources."""
        self.is_recording = False
        self.watchdog_running = False
        if self.callback_watchdog and self.callback_watchdog.is_alive():
            self.callback_watchdog.join(timeout=1.0)
        self._close_streams()
        # Safety net when stop_recording did not run (should be rare after CLI fix).
        if self._mic_spool is not None or self._desktop_spool is not None or self._capture_manifest is not None:
            self._release_capture_spools()
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

    recorder = None

    # Handle interrupt signals for manual stop
    def signal_handler(sig, frame):
        print("\nStopping recording...", file=sys.stderr)
        if recorder is not None:
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
            else:
                # stdin EOF while capture is active — stop cleanly (no orphan).
                stop_event.set()
        except Exception:
            stop_event.set()

    input_thread = threading.Thread(target=input_listener, daemon=True)
    input_thread.start()

    try:
        recorder = AudioRecorder(
            mic_device_id=args.mic,
            loopback_device_id=args.loopback,
            output_path=str(output_path),
            sample_rate=48000,
            preroll_seconds=0  # Production mode: no preroll, countdown in Electron app handles device warm-up
        )
        recorder.start_recording()
        
        if args.duration > 0:
            # Record for fixed duration (interruptible on async spool / stop)
            for i in range(args.duration):
                if not recorder.is_recording or stop_event.is_set() or recorder.get_async_capture_error():
                    break
                time.sleep(1)
            recorder.stop_recording()
            async_err = recorder.get_async_capture_error()
            if async_err:
                raise RuntimeError(async_err)
        else:
            # Record until interrupted
            print("Recording... Send 'stop' to stdin or Press Ctrl+C to stop", file=sys.stderr)
            
            # Main loop - print audio levels for visualization
            # PERFORMANCE: Reduced from 20 FPS to 5 FPS to minimize CPU/IPC overhead
            # Visualization still looks smooth, but uses 75% less resources
            while not stop_event.is_set():
                async_err = recorder.get_async_capture_error()
                if async_err or not recorder.is_recording:
                    break
                # Print levels as JSON to stdout (buffered)
                # Electron will parse this
                levels = {
                    "type": "levels",
                    "mic": round(recorder.mic_level, 3),
                    "desktop": round(recorder.desktop_level, 3)
                }
                _send_json_message(levels)
                time.sleep(0.2) # 5 FPS updates (was 0.05 = 20 FPS)
            
            print("\nStopping recording...", file=sys.stderr)
            # Always close/commit spools before emitting structured failure.
            recorder.stop_recording()
            async_err = recorder.get_async_capture_error()
            if async_err:
                raise RuntimeError(async_err)

    except Exception as e:
        global _final_output_path
        message = f"Recorder failed: {e}"
        print(f"Error: {e}", file=sys.stderr)
        _send_error_message("RECORDER_FAILED", message)
        # Prefer a structured stop payload when post-processing already produced
        # an output file, so Electron can recover audioPath even on exit 1.
        if _final_output_path:
            _send_json_message({
                "success": False,
                "code": "RECORDER_FAILED",
                "message": message,
                "audioPath": str(_final_output_path),
                "duration": _recording_duration,
            })
            # Prevent finally from emitting a conflicting success payload.
            _final_output_path = None
        else:
            # Still emit a structured failure so Electron never sees exit≠0
            # with an empty stop buffer (e.g. MemoryError before compress).
            _send_json_message({
                "success": False,
                "code": "RECORDER_FAILED",
                "message": message,
                "duration": _recording_duration,
            })
        sys.exit(1)
    finally:
        # Emit the success payload BEFORE cleanup. pa.terminate() has historically
        # been crash-prone; a raise there must not convert a finished save into
        # exit-1-with-no-payload.
        if _final_output_path:
            recording_info = {
                "success": True,
                "audioPath": str(_final_output_path),
                "duration": _recording_duration,
            }
            _send_json_message(recording_info)
            _final_output_path = None

        if recorder is not None:
            try:
                recorder.cleanup()
            except Exception as cleanup_err:
                print(f"Warning: Recorder cleanup failed: {cleanup_err}", file=sys.stderr)


if __name__ == "__main__":
    main()
