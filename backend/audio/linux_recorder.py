"""
Linux audio recorder using pulsectl + SoundCard.

Records microphone and desktop (sink monitor) audio to durable
``{stem}.capture/`` track spools, then finalizes with bounded
``finalize_capture`` (linux-v1). No whole-session RAM mix.

Electron contract matches Windows/macOS: structured stdout JSON only
(levels, event, warning, error, stop stages, final result). stderr is
diagnostics-only. Stdin commands are exact-token ``stop`` / ``cancel``.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np

from . import recorder_stdout as _recorder_stdout
from .capture_manifest import (
    CaptureManifestCoordinator,
    MANIFEST_FILENAME,
    discard_capture_session,
    mark_capture_discarded_and_cleanup,
)
from .compressor import verify_recording_integrity
from .constants import (
    DEFAULT_CHANNELS,
    DEFAULT_SAMPLE_RATE,
    LEVEL_SUBSAMPLE_FACTOR,
    LINUX_CHUNK_SIZE,
    MIC_BOOST_LINEAR,
)
from .recorder_temp_paths import (
    build_recorder_temp_pcm_path,
    build_stable_wav_path_for_output,
    promote_recorder_temp_to_wav,
)
from .streaming_post_processor import FinalizationError, finalize_capture
from .track_spool import TrackSpool

try:
    from device_helpers import (
        is_linux_desktop_off_id,
        parse_pulse_device_id,
    )
except ImportError:  # pragma: no cover - package import fallback
    from backend.device_helpers import (  # type: ignore
        is_linux_desktop_off_id,
        parse_pulse_device_id,
    )

MIC_START_TIMEOUT_SECONDS = 5.0
DESKTOP_START_TIMEOUT_SECONDS = 5.0
DESKTOP_MONITOR_POLL_SECONDS = 0.5
LINUX_PROCESSING_PROFILE = "linux-v1"

_stdout_lock = threading.Lock()
_configuring_devices_event_sent = False


def _send_json_message(message: Any) -> None:
    _recorder_stdout.send_json_message(message, lock=_stdout_lock)


def _send_event_message(event: str, message: str, **extra: Any) -> None:
    _recorder_stdout.send_event_message(
        event,
        message,
        lock=_stdout_lock,
        send_json=_send_json_message,
        **extra,
    )


def _send_configuring_devices_event() -> None:
    global _configuring_devices_event_sent
    if _configuring_devices_event_sent:
        return
    _send_event_message("configuring_devices", "Configuring audio devices...")
    _configuring_devices_event_sent = True


def _send_warning_message(code: str, message: str, **extra: Any) -> None:
    _recorder_stdout.send_warning_message(
        code,
        message,
        lock=_stdout_lock,
        send_json=_send_json_message,
        **extra,
    )


def _send_error_message(code: str, message: str, **extra: Any) -> None:
    _recorder_stdout.send_error_message(
        code,
        message,
        lock=_stdout_lock,
        send_json=_send_json_message,
        **extra,
    )


def _load_soundcard():
    """Import SoundCard after padding argv (Pulse backend indexes sys.argv[1])."""
    argv_before = list(sys.argv)
    if len(sys.argv) < 2:
        sys.argv = [*sys.argv, "linux-recorder"]
    try:
        import soundcard as sc  # noqa: WPS433 - lazy, test-injectable
        return sc
    finally:
        sys.argv = argv_before


def _default_pulse_factory():
    import pulsectl  # noqa: WPS433 - lazy, test-injectable
    return pulsectl.Pulse("avanevis-linux-recorder")


def _normalize_capture_frames(chunk: np.ndarray, expected_channels: int) -> np.ndarray:
    data = np.asarray(chunk, dtype=np.float32)
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    if data.ndim != 2:
        raise ValueError(f"Expected 1-D or 2-D capture frames, got shape {data.shape}")
    have = int(data.shape[1])
    want = int(expected_channels)
    if have == want:
        return np.ascontiguousarray(data, dtype=np.float32)
    if have == 1 and want > 1:
        return np.ascontiguousarray(np.repeat(data, want, axis=1), dtype=np.float32)
    if have > want:
        return np.ascontiguousarray(data[:, :want], dtype=np.float32)
    pad = np.zeros((data.shape[0], want - have), dtype=np.float32)
    return np.ascontiguousarray(np.concatenate([data, pad], axis=1), dtype=np.float32)


def _pulse_source_names(pulse: Any) -> list[str]:
    return [str(getattr(source, "name", "") or "") for source in pulse.source_list()]


class LinuxAudioRecorder:
    """Linux recorder: SoundCard PCM + pulsectl device/monitor watch."""

    def __init__(
        self,
        mic_device_id: str,
        desktop_device_id: str,
        output_path: str,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        channels: int = DEFAULT_CHANNELS,
        chunk_size: int = LINUX_CHUNK_SIZE,
        mic_volume: float = 1.0,
        desktop_volume: float = 1.0,
        preroll_seconds: Optional[float] = None,
        *,
        soundcard_module: Any = None,
        pulse_factory: Optional[Callable[[], Any]] = None,
    ):
        _send_configuring_devices_event()
        self.mic_device_id = str(mic_device_id)
        self.desktop_device_id = str(desktop_device_id)
        self.output_path = output_path
        self.sample_rate = int(sample_rate)
        self.channels = int(channels)
        self.chunk_size = int(chunk_size)
        self.mic_volume = float(mic_volume)
        self.desktop_volume = float(desktop_volume)
        self.preroll_seconds = 1.5 if preroll_seconds is None else float(preroll_seconds)

        self._soundcard = soundcard_module
        self._pulse_factory = pulse_factory or _default_pulse_factory

        self.is_running = False
        self._running_lock = threading.Lock()
        self.recording_failure = None

        self._capture_manifest = None
        self._mic_spool = None
        self._desktop_spool = None
        self._mic_spool_channels = None
        self._desktop_spool_channels = None
        self._desktop_spool_accepted_any = False
        self._spool_close_fail_reason = None

        self.mic_level = 0.0
        self.desktop_level = 0.0
        self.level_lock = threading.Lock()

        self._error_event = threading.Event()
        self._last_error = None
        self._error_lock = threading.Lock()

        self._mic_started_event = threading.Event()
        self._desktop_started_event = threading.Event()
        self._mic_start_error = None
        self._desktop_start_error = None
        self._desktop_give_up = False

        self.mic_thread = None
        self.desktop_thread = None

        self._mic_pulse_name = None
        self._desktop_pulse_name = None
        self._desktop_requested = False
        self._desktop_enabled = False

        self.recording_start_time = None
        self.mic_capture_start_time = None
        self.desktop_capture_start_time = None

        self.final_output_path = None
        self.recording_duration = 0.0
        self._desktop_runtime_failure = None
        self._desktop_runtime_warning_sent = False

        print("Initialized Linux audio recorder", file=sys.stderr)
        print(f"  Mic device: {self.mic_device_id}", file=sys.stderr)
        print(f"  Desktop device: {self.desktop_device_id}", file=sys.stderr)
        print(f"  Sample rate: {self.sample_rate} Hz", file=sys.stderr)
        print(f"  Output: {self.output_path}", file=sys.stderr)

    def _ensure_soundcard(self):
        if self._soundcard is None:
            self._soundcard = _load_soundcard()
        return self._soundcard

    def _with_pulse(self, callback: Callable[[Any], Any]) -> Any:
        pulse = self._pulse_factory()
        enter = getattr(pulse, "__enter__", None)
        if enter is not None:
            with pulse as client:
                return callback(client)
        try:
            return callback(pulse)
        finally:
            closer = getattr(pulse, "close", None)
            if closer is not None:
                closer()

    def _list_source_names(self) -> list[str]:
        return self._with_pulse(_pulse_source_names)

    def _monitor_still_listed(self) -> bool:
        if not self._desktop_pulse_name:
            return False
        try:
            return self._desktop_pulse_name in self._list_source_names()
        except Exception as exc:
            print(f"Warning: Pulse source_list() probe failed: {exc}", file=sys.stderr)
            return True

    def _resolve_soundcard_microphone(self, pulse_name: str, *, include_loopback: bool):
        sc = self._ensure_soundcard()
        try:
            microphones = sc.all_microphones(include_loopback=include_loopback)
        except Exception:
            microphones = []
        for mic in microphones or []:
            mic_id = str(getattr(mic, "id", "") or "")
            mic_name = str(getattr(mic, "name", "") or "")
            if mic_id == pulse_name or mic_name == pulse_name:
                return mic
        return sc.get_microphone(pulse_name, include_loopback=include_loopback)

    def start_recording(self) -> bool:
        if self._get_running():
            print("Already recording!", file=sys.stderr)
            return True

        self._set_running(True)
        self._error_event.clear()
        with self._error_lock:
            self._last_error = None
        self._desktop_runtime_failure = None
        self._desktop_runtime_warning_sent = False
        self._desktop_give_up = False
        self._mic_started_event.clear()
        self._desktop_started_event.clear()
        self._mic_start_error = None
        self._desktop_start_error = None
        self.mic_capture_start_time = None
        self.desktop_capture_start_time = None
        self.recording_start_time = time.time()

        try:
            mic_parsed = parse_pulse_device_id(self.mic_device_id)
            if mic_parsed is None or mic_parsed[0] != "source":
                raise ValueError(
                    f"Microphone device ID {self.mic_device_id} is not a pulse-source id"
                )
            self._mic_pulse_name = mic_parsed[1]

            source_names = self._list_source_names()
            if self._mic_pulse_name not in source_names:
                raise ValueError(
                    f"Microphone device ID {self.mic_device_id} was not found"
                )

            self._desktop_requested = not is_linux_desktop_off_id(self.desktop_device_id)
            self._desktop_enabled = False
            self._desktop_pulse_name = None
            if self._desktop_requested:
                desk_parsed = parse_pulse_device_id(self.desktop_device_id)
                if desk_parsed is None or desk_parsed[0] != "monitor":
                    self._note_desktop_runtime_failure(
                        f"Desktop device ID {self.desktop_device_id} is not a pulse-monitor id",
                        code="DESKTOP_START_FAILED",
                    )
                elif desk_parsed[1] not in source_names:
                    self._note_desktop_runtime_failure(
                        f"Desktop monitor {self.desktop_device_id} was not found",
                        code="DESKTOP_START_FAILED",
                    )
                else:
                    self._desktop_pulse_name = desk_parsed[1]
                    self._desktop_enabled = True
        except Exception as exc:
            message = f"Error querying devices: {exc}"
            print(message, file=sys.stderr)
            _send_error_message("DEVICE_QUERY_FAILED", message)
            self._set_running(False)
            return False

        try:
            mic_obj = self._resolve_soundcard_microphone(
                self._mic_pulse_name, include_loopback=False
            )
            mic_channels = max(1, min(int(getattr(mic_obj, "channels", 1) or 1), 8))
            desktop_channels = None
            if self._desktop_enabled:
                try:
                    desk_obj = self._resolve_soundcard_microphone(
                        self._desktop_pulse_name, include_loopback=True
                    )
                    desktop_channels = max(
                        1, min(int(getattr(desk_obj, "channels", 2) or 2), 8)
                    )
                except Exception as desk_err:
                    self._note_desktop_runtime_failure(
                        f"Desktop audio failed to open: {desk_err}",
                        code="DESKTOP_START_FAILED",
                    )
                    self._desktop_enabled = False
            self._open_capture_spools(
                mic_channels=mic_channels,
                desktop_channels=desktop_channels,
            )
        except Exception as spool_err:
            message = f"Failed to open capture spools: {spool_err}"
            print(f"ERROR: {message}", file=sys.stderr)
            _send_error_message("CAPTURE_SPOOL_OPEN_FAILED", message)
            self._set_running(False)
            self._release_and_discard_startup_capture()
            return False

        self.mic_thread = threading.Thread(target=self._record_microphone, name="linux-mic")
        self.mic_thread.daemon = True
        self.mic_thread.start()

        if self._desktop_enabled:
            self.desktop_thread = threading.Thread(
                target=self._record_desktop, name="linux-desktop"
            )
            self.desktop_thread.daemon = True
            self.desktop_thread.start()

        if not self._mic_started_event.wait(timeout=MIC_START_TIMEOUT_SECONDS):
            message = (
                f"Microphone stream did not become ready within "
                f"{MIC_START_TIMEOUT_SECONDS:g} seconds."
            )
            print(f"ERROR: {message}", file=sys.stderr)
            _send_error_message("MIC_START_TIMEOUT", message)
            self._abort_startup()
            return False

        if self._mic_start_error:
            self._abort_startup()
            return False

        if self._desktop_enabled:
            if not self._desktop_started_event.wait(timeout=DESKTOP_START_TIMEOUT_SECONDS):
                self._desktop_give_up = True
                self._note_desktop_runtime_failure(
                    f"Desktop audio did not become ready within "
                    f"{DESKTOP_START_TIMEOUT_SECONDS:g} seconds.",
                    code="DESKTOP_START_TIMEOUT",
                )
            elif self._desktop_start_error:
                self._desktop_give_up = True
                self._note_desktop_runtime_failure(
                    self._desktop_start_error,
                    code="DESKTOP_START_FAILED",
                )

        if self._desktop_enabled and not self._desktop_runtime_failure:
            desktop_status = "active"
        else:
            desktop_status = "unavailable"
        _send_event_message(
            "recording_started",
            "Recording started!",
            desktopStatus=desktop_status,
        )
        print("Recording started!", file=sys.stderr)
        return True

    def _abort_startup(self) -> None:
        self._set_running(False)
        self._desktop_give_up = True
        if self.mic_thread and self.mic_thread.is_alive():
            self.mic_thread.join(timeout=1.0)
        if self.desktop_thread and self.desktop_thread.is_alive():
            self.desktop_thread.join(timeout=1.0)
        self._release_and_discard_startup_capture()

    def _open_capture_spools(
        self, *, mic_channels: int, desktop_channels: Optional[int]
    ) -> None:
        started_ns = time.time_ns()
        started_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"
        self._mic_spool_channels = int(mic_channels)
        self._desktop_spool_channels = (
            int(desktop_channels) if desktop_channels is not None else None
        )
        self._desktop_spool_accepted_any = False
        self._spool_close_fail_reason = None
        self._capture_manifest = CaptureManifestCoordinator.create(
            self.output_path,
            started_at_ns=started_ns,
            started_at_iso=started_iso,
        )
        self._capture_manifest.set_processing_profile(LINUX_PROCESSING_PROFILE)
        self._capture_manifest.set_mix_params(
            mic_volume=self.mic_volume,
            desktop_volume=self.desktop_volume,
            mic_boost=MIC_BOOST_LINEAR,
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
        if desktop_channels is not None:
            self._capture_manifest.add_track(
                "desktop",
                sample_rate=self.sample_rate,
                channels=self._desktop_spool_channels,
                dtype="<f4",
            )
            self._desktop_spool = TrackSpool(
                self._capture_manifest,
                self._capture_manifest.session_dir,
                "desktop",
                sample_rate=self.sample_rate,
                channels=self._desktop_spool_channels,
                dtype="<f4",
            )

    def _compute_spool_alignment_frames(self) -> dict:
        if (
            self.recording_start_time is None
            or self.mic_capture_start_time is None
            or self.desktop_capture_start_time is None
            or self.sample_rate <= 0
        ):
            return {
                "desktopTrimFrames": 0,
                "desktopLeadingPadFrames": 0,
                "micLeadingPadFrames": 0,
            }

        reference_start = self.recording_start_time + max(float(self.preroll_seconds), 0.0)
        desktop_trim = 0
        desktop_capture_start = self.desktop_capture_start_time
        if desktop_capture_start < reference_start:
            desktop_trim = int(round((reference_start - desktop_capture_start) * self.sample_rate))
            desktop_capture_start = reference_start

        mic_reference = max(self.mic_capture_start_time, reference_start)
        desktop_reference = max(desktop_capture_start, reference_start)
        offset_samples = int(round((desktop_reference - mic_reference) * self.sample_rate))
        if offset_samples > 0:
            return {
                "desktopTrimFrames": max(0, desktop_trim),
                "desktopLeadingPadFrames": offset_samples,
                "micLeadingPadFrames": 0,
            }
        if offset_samples < 0:
            return {
                "desktopTrimFrames": max(0, desktop_trim),
                "desktopLeadingPadFrames": 0,
                "micLeadingPadFrames": abs(offset_samples),
            }
        return {
            "desktopTrimFrames": max(0, desktop_trim),
            "desktopLeadingPadFrames": 0,
            "micLeadingPadFrames": 0,
        }

    def _close_capture_spools_for_mix(self) -> None:
        mic_frames = 0
        include_desktop = False
        if self._mic_spool is not None:
            mic_result = self._mic_spool.close()
            self._mic_spool = None
            if mic_result.fail_reason:
                self._spool_close_fail_reason = (
                    f"Microphone capture spool failed: {mic_result.fail_reason}"
                )
                with self._error_lock:
                    self._last_error = self._spool_close_fail_reason
                self._error_event.set()
            else:
                mic_frames = mic_result.committed_frames

        if self._desktop_spool is not None:
            desktop_failed = bool(self._desktop_runtime_failure) or bool(
                self._spool_close_fail_reason
            )
            pad_to = None
            if (
                not desktop_failed
                and self._desktop_spool_accepted_any
                and mic_frames > 0
            ):
                pad_to = mic_frames
            desk_result = self._desktop_spool.close(final_frame_count=pad_to)
            self._desktop_spool = None
            if desk_result.fail_reason and not desktop_failed:
                self._note_desktop_runtime_failure(
                    f"Desktop capture spool failed: {desk_result.fail_reason}",
                    code="DESKTOP_SPOOL_FAILED",
                )
                desktop_failed = True
            include_desktop = (
                not desktop_failed
                and self._desktop_spool_accepted_any
                and desk_result.committed_frames > 0
            )

        if self._capture_manifest is not None:
            try:
                self._capture_manifest.set_include_desktop(include_desktop)
                if include_desktop:
                    alignment = self._compute_spool_alignment_frames()
                    self._capture_manifest.set_alignment(**{
                        "desktop_trim_frames": alignment["desktopTrimFrames"],
                        "desktop_leading_pad_frames": alignment["desktopLeadingPadFrames"],
                        "mic_leading_pad_frames": alignment["micLeadingPadFrames"],
                    })
                self._capture_manifest.set_state("finalizing")
            except Exception as exc:
                if include_desktop:
                    raise RuntimeError(
                        f"Failed to persist desktop mix settings before finalization: {exc}"
                    ) from exc
                try:
                    _send_warning_message(
                        "DESKTOP_MANIFEST_UPDATE_FAILED",
                        f"Could not update capture manifest ({exc}); continuing with microphone only.",
                        help="The meeting audio was saved from the microphone. Desktop/system audio may be missing.",
                    )
                except Exception:
                    pass
                try:
                    self._capture_manifest.set_include_desktop(False)
                    self._capture_manifest.set_state("finalizing")
                except Exception as retry_exc:
                    raise RuntimeError(
                        f"Failed to update capture manifest before finalization: {retry_exc}"
                    ) from retry_exc

    def _finalize_from_capture_spools(self) -> bool:
        if self._capture_manifest is None:
            message = "Capture manifest missing for spool finalization"
            self.recording_failure = {
                "code": "CAPTURE_FINALIZE_FAILED",
                "message": message,
            }
            return False

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
            message = str(exc)
            print(f"ERROR: {message}", file=sys.stderr)
            if exc.recoverable_path:
                self.final_output_path = exc.recoverable_path
            self.recording_failure = {
                "code": "CAPTURE_FINALIZE_FAILED",
                "message": message,
            }
            return False

        self.final_output_path = result.final_path
        self.recording_duration = float(result.duration)
        self.recording_failure = None
        print(f"Final file: {result.final_path}", file=sys.stderr)
        print(f"Duration: {result.duration:.1f} seconds", file=sys.stderr)
        return True

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
        self._desktop_spool_channels = None

    def _release_and_discard_startup_capture(self) -> None:
        session_dir = None
        if self._capture_manifest is not None:
            session_dir = self._capture_manifest.session_dir
        self._release_capture_spools()
        if session_dir is not None:
            discard_capture_session(session_dir)

    def _close_spool_handles_for_discard(self) -> None:
        for spool in (self._mic_spool, self._desktop_spool):
            if spool is None:
                continue
            try:
                spool.close()
            except Exception:
                pass
        self._mic_spool = None
        self._desktop_spool = None

    def cancel_recording(self) -> None:
        print("Cancelling recording (discard)...", file=sys.stderr)
        if self._get_running():
            self._set_running(False)
        self._desktop_give_up = True
        if self.mic_thread:
            self.mic_thread.join(timeout=2.0)
        if self.desktop_thread:
            self.desktop_thread.join(timeout=2.0)
        self._close_spool_handles_for_discard()
        mark_capture_discarded_and_cleanup(self._capture_manifest)
        self._capture_manifest = None
        print("Recording cancelled; capture discarded.", file=sys.stderr)

    def _record_microphone(self) -> None:
        stream_opened = False
        try:
            mic = self._resolve_soundcard_microphone(
                self._mic_pulse_name, include_loopback=False
            )
            channels = int(self._mic_spool_channels or 1)
            print(f"Starting mic capture ({channels} channel(s))...", file=sys.stderr)
            with mic.recorder(
                samplerate=self.sample_rate,
                channels=channels,
                blocksize=self.chunk_size,
            ) as recorder:
                stream_opened = True
                self._mic_start_error = None
                self._mic_started_event.set()
                print("Microphone stream opened", file=sys.stderr)
                _send_event_message("mic_stream_opened", "Microphone stream opened")

                while self._get_running():
                    chunk = recorder.record(numframes=self.chunk_size)
                    elapsed = time.time() - (self.recording_start_time or time.time())
                    if elapsed < self.preroll_seconds:
                        continue
                    if self.mic_capture_start_time is None:
                        self.mic_capture_start_time = time.time()
                    frames = _normalize_capture_frames(chunk, channels)
                    if self._mic_spool is not None:
                        if not self._mic_spool.append(frames.tobytes()):
                            message = (
                                "Audio capture writer stalled; recording was stopped "
                                "to preserve committed audio."
                            )
                            with self._error_lock:
                                self._last_error = message
                            self._error_event.set()
                            self._set_running(False)
                            return
                    level = float(np.max(np.abs(frames[::LEVEL_SUBSAMPLE_FACTOR])))
                    with self.level_lock:
                        self.mic_level = level
        except Exception as exc:
            print(f"ERROR in mic recording: {exc}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            error_message = f"Microphone recording failed: {exc}"
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

    def _record_desktop(self) -> None:
        capture_started = False
        try:
            if self._desktop_give_up or not self._desktop_enabled:
                self._desktop_started_event.set()
                return
            mic = self._resolve_soundcard_microphone(
                self._desktop_pulse_name, include_loopback=True
            )
            channels = int(self._desktop_spool_channels or 2)
            print(f"Starting desktop capture ({channels} channel(s))...", file=sys.stderr)
            with mic.recorder(
                samplerate=self.sample_rate,
                channels=channels,
                blocksize=self.chunk_size,
            ) as recorder:
                capture_started = True
                self._desktop_start_error = None
                self._desktop_started_event.set()
                print("Desktop audio stream opened", file=sys.stderr)
                _send_event_message("desktop_stream_opened", "Desktop audio stream opened")

                last_watch = time.monotonic()
                while self._get_running() and not self._desktop_give_up:
                    chunk = recorder.record(numframes=self.chunk_size)
                    now = time.monotonic()
                    if now - last_watch >= DESKTOP_MONITOR_POLL_SECONDS:
                        last_watch = now
                        if not self._monitor_still_listed():
                            self._note_desktop_runtime_failure(
                                f"Desktop monitor {self.desktop_device_id} disappeared from Pulse",
                                code="DESKTOP_MONITOR_VANISHED",
                            )
                            break
                    if self._desktop_runtime_failure or self._desktop_give_up:
                        break
                    elapsed = time.time() - (self.recording_start_time or time.time())
                    if elapsed < self.preroll_seconds:
                        continue
                    if self.desktop_capture_start_time is None:
                        self.desktop_capture_start_time = time.time()
                    frames = _normalize_capture_frames(chunk, channels)
                    if self._desktop_spool is not None:
                        if self._desktop_spool.append(frames.tobytes()):
                            self._desktop_spool_accepted_any = True
                        else:
                            self._note_desktop_runtime_failure(
                                "Desktop capture writer stalled",
                                code="DESKTOP_SPOOL_FAILED",
                            )
                            break
                    level = float(np.max(np.abs(frames[::LEVEL_SUBSAMPLE_FACTOR])))
                    with self.level_lock:
                        self.desktop_level = level
        except Exception as exc:
            print(f"ERROR in desktop recording: {exc}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            error_message = f"Desktop audio recording failed: {exc}"
            if not capture_started:
                self._desktop_start_error = error_message
                self._desktop_started_event.set()
            else:
                self._note_desktop_runtime_failure(
                    error_message, code="DESKTOP_RECORDING_FAILED"
                )
        finally:
            if not self._desktop_started_event.is_set():
                self._desktop_started_event.set()

    def _note_desktop_runtime_failure(self, message: str, *, code: str = "DESKTOP_RECORDING_FAILED") -> None:
        if not self._desktop_runtime_failure:
            self._desktop_runtime_failure = message
        if self._desktop_runtime_warning_sent:
            return
        self._desktop_runtime_warning_sent = True
        print(f"WARNING: {message}", file=sys.stderr)
        _send_warning_message(
            code,
            f"{message} Continuing with microphone audio only.",
            help="Desktop audio capture failed. The saved file will contain microphone audio only.",
        )

    def _has_async_recording_error(self) -> bool:
        return self._error_event.is_set()

    def _resolve_async_recording_failure(self) -> Optional[dict]:
        if self._error_event.is_set():
            with self._error_lock:
                error_msg = self._last_error or "Unknown recording error"
            return {
                "code": "RECORDING_THREAD_FAILED",
                "message": error_msg,
            }
        return None

    def _finalize_recording_failure(self, failure: dict) -> None:
        self.recording_failure = failure
        if not self.final_output_path:
            self.recording_duration = self.recording_duration or 0.0

    def _resolve_recoverable_output_path(self) -> Optional[str]:
        if self.final_output_path and Path(self.final_output_path).exists():
            return self.final_output_path
        preferred = self.output_path.replace(".wav", ".opus")
        for candidate in (preferred, self.output_path):
            if candidate and Path(candidate).exists() and not str(candidate).lower().endswith(".pcm.tmp"):
                return candidate
        temp_path = build_recorder_temp_pcm_path(self.output_path)
        if Path(temp_path).exists():
            stable_wav = build_stable_wav_path_for_output(self.output_path)
            promoted = promote_recorder_temp_to_wav(temp_path, stable_wav)
            if promoted:
                self.final_output_path = promoted
                return promoted
        return None

    def stop_recording(self) -> None:
        pending_error = self._has_async_recording_error()
        desktop_degraded = bool(self._desktop_runtime_failure)
        if not self._get_running() and not pending_error and not desktop_degraded:
            print("Not recording!", file=sys.stderr)
            return

        if self._get_running():
            print("\nStopping recording...", file=sys.stderr)
            self._set_running(False)
        self._desktop_give_up = True

        if self.mic_thread:
            self.mic_thread.join(timeout=2.0)
        if self.desktop_thread:
            self.desktop_thread.join(timeout=2.0)

        try:
            self._close_capture_spools_for_mix()
        except Exception as spool_err:
            message = f"Failed to close capture spools: {spool_err}"
            print(f"ERROR: {message}", file=sys.stderr)
            self.recording_failure = {
                "code": "CAPTURE_SPOOL_CLOSE_FAILED",
                "message": message,
            }
            self._release_capture_spools()
            return

        include_desktop = False
        if self._capture_manifest is not None:
            include_desktop = bool(self._capture_manifest.to_dict().get("includeDesktop"))
        if include_desktop:
            print("Desktop track committed for bounded finalization", file=sys.stderr)
        elif self._desktop_requested and not self._desktop_runtime_failure:
            _send_warning_message(
                "NO_DESKTOP_AUDIO_CAPTURED",
                "No desktop audio was captured; saved recording contains microphone audio only.",
                help="If system audio was playing, confirm the selected Pulse monitor is still available.",
            )

        async_failure = self._resolve_async_recording_failure()
        if async_failure:
            if not self.recording_failure:
                self._finalize_recording_failure(async_failure)
            self._release_capture_spools()
            return

        print("Processing audio...", file=sys.stderr)
        try:
            ok = self._finalize_from_capture_spools()
            self._capture_manifest = None
            if not ok:
                self._release_capture_spools()
                return
            self._release_capture_spools()
        except Exception as process_err:
            message = f"Recorder failed during post-processing: {process_err}"
            print(message, file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            recovered = self._resolve_recoverable_output_path()
            self.recording_failure = {
                "code": "RECORDER_FAILED",
                "message": message,
            }
            if recovered:
                self.final_output_path = recovered
            self._release_capture_spools()
            return

        print("Recording complete!", file=sys.stderr)

    def _verify_recording_integrity(self, file_path):
        return verify_recording_integrity(file_path)

    def get_audio_levels(self):
        with self.level_lock:
            mic = max(0.0, min(1.0, float(self.mic_level) if self.mic_level is not None else 0.0))
            desktop = max(0.0, min(1.0, float(self.desktop_level) if self.desktop_level is not None else 0.0))
            return (mic, desktop)

    def is_recording(self) -> bool:
        with self._running_lock:
            return self.is_running

    def _set_running(self, value: bool) -> None:
        with self._running_lock:
            self.is_running = value

    def _get_running(self) -> bool:
        with self._running_lock:
            return self.is_running


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Linux Audio Recorder CLI")
    parser.add_argument("--mic", required=True, help="Opaque pulse-source:<name> microphone id")
    parser.add_argument(
        "--loopback",
        required=True,
        help="Opaque pulse-monitor:<name> desktop id, or none",
    )
    parser.add_argument("--output", required=True, help="Output file path")
    parser.add_argument("--duration", type=int, default=0, help="Duration in seconds (0 for manual stop)")
    args = parser.parse_args()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    _send_configuring_devices_event()

    recorder = None
    try:
        recorder = LinuxAudioRecorder(
            mic_device_id=args.mic,
            desktop_device_id=args.loopback,
            output_path=str(output_path),
            preroll_seconds=0,
        )
        if not recorder.start_recording():
            sys.exit(1)
    except Exception as exc:
        message = f"Recorder failed: {exc}"
        print(message, file=sys.stderr)
        _send_error_message("RECORDER_FAILED", message)
        if recorder is not None:
            recorder._abort_startup()
        sys.exit(1)

    result_emitted = False
    recording_cancelled = False
    stdin_command = {"cmd": "stop"}

    def emit_final_result(*, exit_code: int = 0) -> None:
        nonlocal result_emitted
        if result_emitted or recorder is None:
            return
        result_emitted = True

        if recording_cancelled:
            _send_json_message({
                "success": True,
                "cancelled": True,
            })
            sys.exit(exit_code)
            return

        failure = getattr(recorder, "recording_failure", None)
        recovered_path = recorder._resolve_recoverable_output_path()

        if not failure and not recovered_path:
            failure = {
                "code": "RECORDING_FAILED",
                "message": "Recording did not produce an output file.",
            }

        if failure:
            result = {
                "success": False,
                "code": failure.get("code", "RECORDING_FAILED"),
                "message": failure.get("message", "Recording failed."),
                "duration": recorder.recording_duration or 0,
            }
            if recovered_path:
                result["outputPath"] = recovered_path
            _send_json_message(result)
            sys.exit(1 if exit_code == 0 else exit_code)

        result = {
            "success": True,
            "outputPath": recovered_path or args.output,
            "duration": recorder.recording_duration,
        }
        _send_json_message(result)
        sys.exit(exit_code)

    from .recorder_stdin import (
        RECORDER_STDIN_CANCEL,
        parse_recorder_stdin_command,
        resolve_post_exception_capture_action,
    )

    stop_event = threading.Event()

    def input_listener():
        try:
            for line in sys.stdin:
                cmd = parse_recorder_stdin_command(line)
                if cmd is not None:
                    stdin_command["cmd"] = cmd
                    stop_event.set()
                    break
            else:
                stdin_command["cmd"] = "stop"
                stop_event.set()
        except Exception as exc:
            print(f"Error in command listener: {exc}", file=sys.stderr)
            stdin_command["cmd"] = "stop"
            stop_event.set()

    input_thread = threading.Thread(target=input_listener, daemon=True)
    input_thread.start()

    def finish_capture_from_stdin_or_duration():
        nonlocal recording_cancelled
        if stdin_command["cmd"] == RECORDER_STDIN_CANCEL:
            print("\nCancelling recording...", file=sys.stderr)
            recorder.cancel_recording()
            recording_cancelled = True
        else:
            print("\nStopping recording...", file=sys.stderr)
            recorder.stop_recording()

    try:
        if args.duration > 0:
            print(f"Recording for {args.duration} seconds...", file=sys.stderr)
            for _ in range(int(args.duration)):
                if stop_event.is_set():
                    break
                if recorder._has_async_recording_error():
                    with recorder._error_lock:
                        error_msg = recorder._last_error or "Unknown recording error"
                    print(f"CRITICAL: Recording thread error: {error_msg}", file=sys.stderr)
                    _send_error_message("RECORDING_THREAD_FAILED", error_msg)
                    break
                if not recorder.is_recording():
                    break
                time.sleep(1)
            finish_capture_from_stdin_or_duration()
        else:
            print("Recording... (send 'stop' or 'cancel' to stdin)", file=sys.stderr)
            while not stop_event.is_set():
                if recorder._has_async_recording_error():
                    with recorder._error_lock:
                        error_msg = recorder._last_error or "Unknown recording error"
                    print(f"CRITICAL: Recording thread error: {error_msg}", file=sys.stderr)
                    _send_error_message("RECORDING_THREAD_FAILED", error_msg)
                    break
                if not recorder.is_recording():
                    break
                try:
                    mic, desktop = recorder.get_audio_levels()
                    _send_json_message({
                        "type": "levels",
                        "mic": round(mic, 3),
                        "desktop": round(desktop, 3),
                    })
                except Exception as exc:
                    print(f"Warning: Failed to send audio levels: {exc}", file=sys.stderr)
                time.sleep(0.2)
            finish_capture_from_stdin_or_duration()
    except KeyboardInterrupt:
        print("\nCtrl+C received", file=sys.stderr)
        try:
            if stdin_command["cmd"] == RECORDER_STDIN_CANCEL:
                recorder.cancel_recording()
                recording_cancelled = True
            else:
                recorder.stop_recording()
        except Exception as stop_err:
            message = f"Recorder failed during stop: {stop_err}"
            print(message, file=sys.stderr)
            recorder.recording_failure = {
                "code": "RECORDER_FAILED",
                "message": message,
            }
    except Exception as exc:
        message = f"Recorder failed: {exc}"
        print(message, file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        if recorder is not None:
            cancel_requested = stdin_command.get("cmd") == RECORDER_STDIN_CANCEL
            action = resolve_post_exception_capture_action(
                cancel_requested=cancel_requested,
                recording_cancelled=recording_cancelled,
            )
            if action == "cancel":
                try:
                    recorder.cancel_recording()
                    recording_cancelled = True
                except Exception as cancel_err:
                    print(f"Cancel after failure also failed: {cancel_err}", file=sys.stderr)
                    if not getattr(recorder, "recording_failure", None):
                        recorder.recording_failure = {
                            "code": "RECORDING_CANCEL_FAILED",
                            "message": f"{message}; cancel also failed: {cancel_err}",
                        }
                    _send_error_message("RECORDING_CANCEL_FAILED", recorder.recording_failure["message"])
            elif action == "stop":
                try:
                    if (
                        recorder._get_running()
                        or recorder._capture_manifest is not None
                        or recorder._mic_spool is not None
                        or getattr(recorder, "recording_failure", None)
                    ):
                        recorder.stop_recording()
                except Exception as stop_err:
                    print(f"Stop after failure also failed: {stop_err}", file=sys.stderr)

                recovered = recorder._resolve_recoverable_output_path()
                if recovered and not getattr(recorder, "recording_failure", None):
                    print(
                        f"Recovered recording after error (no error toast): {recovered}",
                        file=sys.stderr,
                    )
                else:
                    if not getattr(recorder, "recording_failure", None):
                        recorder.recording_failure = {
                            "code": "RECORDER_FAILED",
                            "message": message,
                        }
                    _send_error_message("RECORDER_FAILED", message)
        else:
            _send_error_message("RECORDER_FAILED", message)

    emit_final_result()


if __name__ == "__main__":
    main()
