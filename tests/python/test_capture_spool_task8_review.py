"""Regression tests for Task 8 review fixes (spool lifecycle / parity)."""

from __future__ import annotations

import io
import sys
import threading
import time
from types import SimpleNamespace
from unittest import mock

import numpy as np
import pytest

# windows_recorder imports pyaudiowpatch at module load; stub it for cross-platform CI.
_fake_pyaudio = mock.MagicMock()
_fake_pyaudio.paInt16 = 8
_fake_pyaudio.paContinue = 0
_fake_pyaudio.paComplete = 1
sys.modules.setdefault("pyaudiowpatch", _fake_pyaudio)

from backend.audio.timeline import reconstruct_desktop_timeline
from backend.audio.swift_audio_capture import SwiftAudioCapture
from backend.audio.capture_spool_runtime import load_track_pcm_array, load_track_segment_bytes
import backend.audio.macos_recorder as macos_mod
import backend.audio.windows_recorder as windows_mod


def _stereo_i2(samples):
    return np.asarray(samples, dtype=np.int16).tobytes()


def _wait_until(predicate, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def _make_windows_spool_recorder(tmp_path, *, sample_rate=4, channels=2):
    recorder = windows_mod.AudioRecorder.__new__(windows_mod.AudioRecorder)
    recorder.output_path = str(tmp_path / "meeting.opus")
    recorder.mic_sample_rate = sample_rate
    recorder.mic_channels = channels
    recorder.loopback_sample_rate = sample_rate
    recorder.loopback_channels = channels
    recorder.mixing_mode = True
    recorder.preroll_seconds = 0
    recorder.chunk_size = 2
    recorder.original_chunk_size = 2
    recorder.is_windows = False
    recorder.is_recording = False
    recorder.lock = threading.Lock()
    recorder.mic_total_bytes = 0
    recorder.mic_frame_count = 0
    recorder.desktop_frame_count = 0
    recorder.mic_level = 0.0
    recorder.desktop_level = 0.0
    recorder.recording_start_time = time.time()
    recorder.mic_first_capture_time = None
    recorder.desktop_first_capture_time = None
    recorder.mic_first_callback_time = None
    recorder.desktop_first_callback_time = None
    recorder.last_mic_callback_time = None
    recorder.last_desktop_callback_time = None
    recorder.callback_watchdog = None
    recorder.watchdog_running = False
    recorder.mic_stream = None
    recorder.desktop_stream = None
    recorder.pa = None
    recorder._capture_manifest = None
    recorder._mic_spool = None
    recorder._desktop_spool = None
    recorder._async_capture_error = None
    recorder._spool_error_lock = threading.Lock()
    recorder._deferred_desktop_chunks = []
    recorder._deferred_desktop_bytes = 0
    recorder._deferred_desktop_started_at = None
    recorder._desktop_spool_lock = threading.Lock()
    recorder._desktop_spool_accepted_any = False
    recorder._desktop_spool_warning = None
    recorder._open_capture_spools()
    recorder.is_recording = True
    return recorder


def test_windows_startup_callbacks_reach_spool_and_deferred_desktop_matches_reconstruct(tmp_path):
    """Critical 1: open spools first; defer desktop until mic reference; no silent drops."""
    recorder = _make_windows_spool_recorder(tmp_path)
    t0 = 100.0
    mic_payload = _stereo_i2([1, 1, 1, 1])  # 2 stereo frames
    desk_early = _stereo_i2([9, 9, 9, 9])
    desk_late = _stereo_i2([2, 2, 2, 2])

    # Desktop arrives before mic reference exists — must be deferred, not dropped.
    with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0):
        recorder.recording_start_time = t0
        recorder._desktop_callback(desk_early, 2, None, None)
        assert recorder._deferred_desktop_chunks
        assert recorder._desktop_spool_accepted_any is False

        recorder._mic_callback(mic_payload, 2, None, None)
        assert recorder.mic_first_capture_time == t0
        assert recorder._deferred_desktop_chunks == []

    with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0 + 1.0):
        recorder._desktop_callback(desk_late, 2, None, None)

    # Another mic chunk so mic duration matches reconstruct fixture (4 frames / 4 Hz = 1s... use 8 frames)
    mic2 = _stereo_i2([1] * 16)  # 8 frames
    with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0 + 0.1):
        recorder._mic_callback(mic2, 8, None, None)

    recorder.is_recording = False
    recorder._close_capture_spools_for_mix()

    expected = reconstruct_desktop_timeline(
        desktop_frames=[(t0, desk_early), (t0 + 1.0, desk_late)],
        mic_frames=[mic_payload, mic2],
        mic_first_capture_time=t0,
        mic_sample_rate=4,
        mic_channels=2,
        loopback_sample_rate=4,
        loopback_channels=2,
    )
    assert recorder.get_async_capture_error() is None
    desk_track = recorder._capture_manifest.get_track("desktop")
    desk_pcm = np.frombuffer(
        load_track_segment_bytes(
            recorder._capture_manifest.session_dir,
            desk_track["segments"],
        ),
        dtype=np.int16,
    )
    assert np.array_equal(desk_pcm, expected)
    mic_track = recorder._capture_manifest.get_track("mic")
    mic_bytes = load_track_segment_bytes(
        recorder._capture_manifest.session_dir,
        mic_track["segments"],
    )
    assert mic_payload in mic_bytes or mic_bytes.startswith(mic_payload)
    assert recorder._capture_manifest.to_dict().get("includeDesktop") is True
    assert recorder._capture_manifest.to_dict().get("processingProfile") == "windows-v1"
    recorder._release_capture_spools()


def test_windows_empty_desktop_spool_does_not_become_silence_track(tmp_path):
    recorder = _make_windows_spool_recorder(tmp_path)
    t0 = 50.0
    with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0):
        recorder.recording_start_time = t0
        recorder._mic_callback(_stereo_i2([3, 3, 3, 3]), 2, None, None)
        recorder._mic_callback(_stereo_i2([4, 4, 4, 4]), 2, None, None)
    recorder.is_recording = False
    recorder._close_capture_spools_for_mix()
    assert recorder._desktop_spool_accepted_any is False
    assert recorder._capture_manifest.to_dict().get("includeDesktop") is False
    recorder._release_capture_spools()


def test_windows_mic_spool_close_fail_reason_is_hard_failure(tmp_path):
    recorder = _make_windows_spool_recorder(tmp_path)
    try:
        t0 = 10.0
        with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0):
            recorder.recording_start_time = t0
            assert recorder._mic_callback(_stereo_i2([1, 1]), 1, None, None)[1] == windows_mod.pyaudio.paContinue

        recorder._mic_spool._test_raise_on_write = True
        assert recorder._mic_spool.append(_stereo_i2([2, 2])) is True
        assert _wait_until(lambda: recorder._mic_spool.fail_reason is not None)

        recorder.is_recording = False
        with pytest.raises(RuntimeError, match="Microphone capture spool failed"):
            recorder._close_capture_spools_for_mix()
    finally:
        recorder._release_capture_spools()


def test_windows_manual_cli_stops_and_closes_spools_before_failure_json(tmp_path, monkeypatch):
    """Critical 2: async error must not skip stop/close/commit."""
    import signal as signal_mod

    stop_calls = []
    close_calls = []
    results = []

    class FakeRecorder:
        def __init__(self, **kwargs):
            self.is_recording = True
            self.mic_level = 0.0
            self.desktop_level = 0.0
            self._err = None

        def start_recording(self):
            return None

        def get_async_capture_error(self):
            return self._err

        def stop_recording(self):
            stop_calls.append("stop")
            close_calls.extend(["mic", "desktop"])
            self.is_recording = False

        def cleanup(self):
            return None

    fake = FakeRecorder()
    monkeypatch.setattr(windows_mod, "AudioRecorder", lambda **kwargs: fake)
    monkeypatch.setattr(signal_mod, "signal", lambda *a, **k: None)
    monkeypatch.setattr(windows_mod.threading.Thread, "start", lambda self: None)

    loops = {"n": 0}

    def fake_sleep(_seconds):
        loops["n"] += 1
        if loops["n"] >= 1:
            fake._err = "spool stalled"
            fake.is_recording = False

    monkeypatch.setattr(windows_mod.time, "sleep", fake_sleep)
    monkeypatch.setattr(windows_mod, "_send_json_message", lambda payload: results.append(payload))
    monkeypatch.setattr(windows_mod, "_send_error_message", lambda *a, **k: None)
    monkeypatch.setattr(
        windows_mod.sys,
        "argv",
        ["windows_recorder.py", "--mic", "0", "--loopback", "1", "--output", str(tmp_path / "out.opus")],
    )
    monkeypatch.setattr(windows_mod.sys, "stdin", io.StringIO("keep-open\n"))

    with pytest.raises(SystemExit) as exc:
        windows_mod.main()
    assert exc.value.code == 1
    assert stop_calls == ["stop"]
    assert "mic" in close_calls and "desktop" in close_calls
    assert any(r.get("success") is False for r in results if isinstance(r, dict))
    assert not any(r.get("success") is True for r in results if isinstance(r, dict))


def test_windows_fixed_duration_cli_reports_failure_on_async_error(tmp_path, monkeypatch):
    import signal as signal_mod

    stop_calls = []
    results = []

    class FakeRecorder:
        def __init__(self, **kwargs):
            self.is_recording = True
            self.mic_level = 0.0
            self.desktop_level = 0.0
            self._err = "writer stalled"

        def start_recording(self):
            return None

        def get_async_capture_error(self):
            return self._err

        def stop_recording(self):
            stop_calls.append("stop")
            self.is_recording = False

        def cleanup(self):
            return None

    monkeypatch.setattr(windows_mod, "AudioRecorder", lambda **k: FakeRecorder())
    monkeypatch.setattr(signal_mod, "signal", lambda *a, **k: None)
    monkeypatch.setattr(windows_mod.threading.Thread, "start", lambda self: None)
    monkeypatch.setattr(windows_mod.time, "sleep", lambda s: None)
    monkeypatch.setattr(windows_mod, "_send_json_message", lambda p: results.append(p))
    monkeypatch.setattr(windows_mod, "_send_error_message", lambda *a, **k: None)
    monkeypatch.setattr(
        windows_mod.sys,
        "argv",
        [
            "windows_recorder.py",
            "--mic",
            "0",
            "--loopback",
            "1",
            "--output",
            str(tmp_path / "out.opus"),
            "--duration",
            "30",
        ],
    )

    with pytest.raises(SystemExit) as exc:
        windows_mod.main()
    assert exc.value.code == 1
    assert stop_calls == ["stop"]
    assert any(r.get("success") is False for r in results if isinstance(r, dict))
    assert not any(r.get("success") is True for r in results if isinstance(r, dict))

def _make_macos_spool_recorder(tmp_path, *, channels=2):
    recorder = macos_mod.MacOSAudioRecorder.__new__(macos_mod.MacOSAudioRecorder)
    recorder.output_path = str(tmp_path / "meeting.opus")
    recorder.sample_rate = 4
    recorder.channels = channels
    recorder.mic_volume = 1.0
    recorder.desktop_volume = 1.0
    recorder.preroll_seconds = 0
    recorder.recording_failure = None
    recorder.final_output_path = None
    recorder.recording_duration = 0.0
    recorder.desktop_diagnostics = {}
    recorder._capture_manifest = None
    recorder._mic_spool = None
    recorder._desktop_spool = None
    recorder._mic_spool_channels = channels
    recorder._desktop_spool_accepted_any = False
    recorder._spool_close_fail_reason = None
    recorder._error_event = threading.Event()
    recorder._last_error = None
    recorder._error_lock = threading.Lock()
    recorder._desktop_runtime_failure = None
    recorder._desktop_runtime_warning_sent = False
    recorder.desktop_capture = SimpleNamespace(
        error_event=threading.Event(),
        last_error=None,
        first_audio_time=None,
        last_audio_time=None,
        audio_sink=None,
        stop_recording=lambda: None,
        drain_warnings=lambda: [],
    )
    recorder.desktop_capture_type = "swift"
    recorder.recording_start_time = time.time()
    recorder.mic_capture_start_time = recorder.recording_start_time
    recorder.desktop_capture_start_time = None
    recorder.desktop_capture_end_time = None
    recorder._running = True
    recorder._running_lock = threading.Lock()
    recorder._get_running = lambda: recorder._running
    recorder._set_running = lambda v: setattr(recorder, "_running", bool(v))
    recorder.mic_thread = None
    recorder.desktop_thread = None
    recorder._open_capture_spools(mic_channels=channels)
    return recorder


def test_macos_empty_desktop_spool_stays_mic_only(tmp_path):
    recorder = _make_macos_spool_recorder(tmp_path)
    mic = np.ones((4, 2), dtype=np.float32) * 0.25
    assert recorder._mic_spool.append(mic.tobytes())
    recorder._close_capture_spools_for_mix()
    assert recorder._desktop_spool_accepted_any is False
    assert recorder._capture_manifest.to_dict().get("includeDesktop") is False
    mic_track = recorder._capture_manifest.get_track("mic")
    loaded = load_track_pcm_array(
        recorder._capture_manifest.session_dir,
        mic_track["segments"],
        dtype="<f4",
        channels=2,
    )
    assert loaded.shape[0] == 4
    recorder._release_capture_spools()


def test_macos_desktop_sink_failure_closes_without_pad_and_uses_mic_only(tmp_path, monkeypatch):
    """Critical 4: late desktop failure must not mix a partial desktop track."""
    recorder = _make_macos_spool_recorder(tmp_path)
    warnings = []
    monkeypatch.setattr(
        macos_mod,
        "_send_warning_message",
        lambda code, message, **kw: warnings.append((code, message)),
    )
    monkeypatch.setattr(macos_mod, "_send_event_message", lambda *a, **k: None)
    monkeypatch.setattr(macos_mod, "_send_error_message", lambda *a, **k: None)

    # Commit mic first so pad_to would otherwise equal mic length.
    mic = np.ones((8, 2), dtype=np.float32) * 0.2
    assert recorder._mic_spool.append(mic.tobytes())

    good = np.ones((2, 2), dtype=np.float32) * 0.5
    assert recorder._desktop_audio_sink(good) is True
    assert _wait_until(lambda: recorder._desktop_spool.committed_frames > 0)
    committed_before = recorder._desktop_spool.committed_frames
    # Force a sink rejection path via helper error + rejected further appends.
    recorder._desktop_spool._mark_failed("injected desktop stall")
    assert recorder._desktop_audio_sink(good) is False
    recorder.desktop_capture.error_event.set()
    recorder.desktop_capture.last_error = "Desktop audio sink rejected audio (writer backpressure)"
    recorder._consume_desktop_helper_failure()
    assert any(code == "DESKTOP_AUDIO_FAILED" for code, _ in warnings)

    close_calls = []
    original_close = recorder._desktop_spool.close

    def tracking_close(final_frame_count=None):
        close_calls.append(final_frame_count)
        return original_close(final_frame_count=final_frame_count)

    recorder._desktop_spool.close = tracking_close
    recorder._close_capture_spools_for_mix()
    assert recorder._desktop_runtime_failure is not None
    assert recorder._capture_manifest.to_dict().get("includeDesktop") is False
    # Close must not pad desktop to mic length after failure.
    assert close_calls == [None]
    assert committed_before > 0
    recorder._release_capture_spools()


def test_macos_mic_spool_close_fail_reason_sets_hard_error(tmp_path):
    recorder = _make_macos_spool_recorder(tmp_path)
    try:
        assert recorder._mic_spool.append(np.ones((2, 2), dtype=np.float32).tobytes())
        recorder._mic_spool._test_raise_on_write = True
        assert recorder._mic_spool.append(np.ones((2, 2), dtype=np.float32).tobytes())
        assert _wait_until(lambda: recorder._mic_spool.fail_reason is not None)
        recorder._close_capture_spools_for_mix()
        assert recorder._error_event.is_set()
        assert "Microphone capture spool failed" in (recorder._last_error or "")
    finally:
        recorder._release_capture_spools()


def test_macos_fixed_duration_exits_promptly_on_async_error(monkeypatch):
    sleeps = []

    class FakeRecorder:
        def __init__(self, **kwargs):
            self._error_event = threading.Event()
            self._last_error = "mic spool stalled"
            self._error_lock = threading.Lock()
            self.recording_duration = 0
            self.desktop_diagnostics = {}
            self.final_output_path = None
            self.recording_failure = {"code": "X", "message": "mic spool stalled"}

        def start_recording(self):
            return True

        def is_recording(self):
            return not self._error_event.is_set()

        def _has_async_recording_error(self):
            return self._error_event.is_set()

        def _consume_desktop_helper_failure(self):
            return None

        def stop_recording(self):
            return None

        def _resolve_recoverable_output_path(self):
            return None

        def get_audio_levels(self):
            return 0.0, 0.0

    fake_holder = {"rec": None}

    def fake_ctor(**kwargs):
        fake_holder["rec"] = FakeRecorder(**kwargs)
        return fake_holder["rec"]

    def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) >= 1 and fake_holder["rec"] is not None:
            fake_holder["rec"]._error_event.set()

    monkeypatch.setattr(macos_mod, "MacOSAudioRecorder", fake_ctor)
    monkeypatch.setattr(macos_mod, "SWIFT_CAPTURE_AVAILABLE", True)
    monkeypatch.setattr(macos_mod, "SCREENCAPTURE_AVAILABLE", False)
    monkeypatch.setattr(macos_mod, "_send_configuring_devices_event", lambda: None)
    monkeypatch.setattr(
        macos_mod.sd,
        "query_devices",
        lambda: [{"name": "mic", "max_input_channels": 1}],
    )
    monkeypatch.setattr(macos_mod.time, "sleep", fake_sleep)
    monkeypatch.setattr(macos_mod, "_send_json_message", lambda *a, **k: None)
    monkeypatch.setattr(macos_mod, "_send_error_message", lambda *a, **k: None)
    monkeypatch.setattr(macos_mod, "_send_event_message", lambda *a, **k: None)
    monkeypatch.setattr(
        macos_mod.sys,
        "argv",
        [
            "macos_recorder.py",
            "--mic",
            "0",
            "--loopback",
            "1",
            "--output",
            "out.opus",
            "--duration",
            "60",
        ],
    )

    with pytest.raises(SystemExit) as exc:
        macos_mod.main()
    assert exc.value.code == 1
    # Must not sleep the full 60s after the error is set.
    assert len(sleeps) < 60


def test_swift_sink_counters_exclude_rejected_chunks():
    calls = {"n": 0}

    def sink(_chunk):
        calls["n"] += 1
        return calls["n"] == 1  # accept first, reject second

    capture = SwiftAudioCapture.__new__(SwiftAudioCapture)
    capture.channels = 2
    capture.audio_sink = sink
    capture.audio_buffer = []
    capture.buffer_lock = threading.Lock()
    capture._latest_chunk = None
    capture._sink_chunk_count = 0
    capture._sink_sample_count = 0
    capture.first_audio_time = None
    capture.last_audio_time = None
    capture.read_chunk_count = 0
    capture.read_sample_count = 0
    capture.read_peak_level = 0.0
    capture.error_event = threading.Event()
    capture.last_error = None

    chunk = np.zeros((4, 2), dtype=np.float32)
    assert capture._ingest_audio_chunk(chunk, chunk_peak=0.0) is True
    assert capture._sink_chunk_count == 1
    assert capture._sink_sample_count == 4
    assert capture._ingest_audio_chunk(chunk, chunk_peak=0.0) is False
    assert capture._sink_chunk_count == 1
    assert capture._sink_sample_count == 4
    assert capture.error_event.is_set()


def test_swift_reject_first_chunk_keeps_sink_counters_zero():
    capture = SwiftAudioCapture.__new__(SwiftAudioCapture)
    capture.channels = 2
    capture.audio_sink = lambda _c: False
    capture.audio_buffer = []
    capture.buffer_lock = threading.Lock()
    capture._latest_chunk = None
    capture._sink_chunk_count = 0
    capture._sink_sample_count = 0
    capture.first_audio_time = None
    capture.last_audio_time = None
    capture.read_chunk_count = 0
    capture.read_sample_count = 0
    capture.read_peak_level = 0.0
    capture.error_event = threading.Event()
    capture.last_error = None
    assert capture._ingest_audio_chunk(np.zeros((2, 2), dtype=np.float32), chunk_peak=0.0) is False
    assert capture._sink_chunk_count == 0
    assert capture._sink_sample_count == 0


def test_abort_startup_awaits_helper_reader_before_spool_release(tmp_path):
    """Important 7: no sink call after spool release during startup abort."""
    recorder = _make_macos_spool_recorder(tmp_path)
    sink_after_release = []
    entered = threading.Event()
    release_gate = threading.Event()

    original_sink = recorder._desktop_audio_sink

    def blocking_sink(chunk):
        entered.set()
        release_gate.wait(timeout=2.0)
        ok = original_sink(chunk)
        if recorder._desktop_spool is None:
            sink_after_release.append(True)
        return ok

    recorder.desktop_capture.audio_sink = blocking_sink

    def reader():
        # Simulate Swift reader calling sink while abort runs.
        blocking_sink(np.ones((2, 2), dtype=np.float32))

    thread = threading.Thread(target=reader)
    # Fake helper cleanup joins this thread.
    join_calls = []

    def fake_cleanup():
        release_gate.set()
        if thread.is_alive():
            thread.join(timeout=2.0)
        join_calls.append("joined")

    recorder.desktop_capture.cleanup = fake_cleanup
    thread.start()
    assert entered.wait(timeout=1.0)
    recorder._abort_startup()
    assert join_calls == ["joined"]
    assert recorder._mic_spool is None
    assert recorder._desktop_spool is None
    assert recorder._capture_manifest is None
    assert sink_after_release == []
    assert not (tmp_path / "meeting.capture").exists()


def test_macos_abort_startup_deletes_empty_capture_directory(tmp_path):
    """Startup abort must not leave an unrecoverable empty .capture for discovery."""
    recorder = _make_macos_spool_recorder(tmp_path)
    session_dir = recorder._capture_manifest.session_dir
    assert session_dir.is_dir()
    assert (session_dir / "manifest.json").is_file()

    recorder._abort_startup()

    assert recorder._capture_manifest is None
    assert not session_dir.exists()
    from backend.audio.capture_recovery import list_interrupted_captures

    assert list_interrupted_captures(tmp_path) == []


def test_windows_abort_start_deletes_empty_capture_directory(tmp_path):
    """Windows startup abort must discard the capture dir after streams/handles close."""
    recorder = _make_windows_spool_recorder(tmp_path)
    session_dir = recorder._capture_manifest.session_dir
    assert session_dir.is_dir()
    assert (session_dir / "manifest.json").is_file()

    closed = {"streams": False}
    original_close = recorder._close_streams

    def tracking_close():
        # Spools must still be open while streams close (no discard race).
        assert recorder._capture_manifest is not None
        closed["streams"] = True
        return original_close()

    recorder._close_streams = tracking_close
    recorder._abort_start_recording()

    assert closed["streams"] is True
    assert recorder._capture_manifest is None
    assert not session_dir.exists()
    from backend.audio.capture_recovery import list_interrupted_captures

    assert list_interrupted_captures(tmp_path) == []


def test_windows_desktop_spool_close_fail_reason_is_mic_only_warning(tmp_path, monkeypatch):
    """High 1: desktop close fail_reason must not hard-fail or pad-to-mic."""
    warnings = []
    monkeypatch.setattr(
        windows_mod,
        "_send_warning_message",
        lambda code, message, **extra: warnings.append((code, message)),
    )
    recorder = _make_windows_spool_recorder(tmp_path)
    try:
        t0 = 20.0
        mic = _stereo_i2([1] * 16)  # 8 frames
        desk = _stereo_i2([5] * 8)  # 4 frames
        with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0):
            recorder.recording_start_time = t0
            recorder._mic_callback(mic, 8, None, None)
            recorder._desktop_callback(desk, 4, None, None)

        # Inject writer failure after some desktop PCM was accepted.
        recorder._desktop_spool._test_raise_on_write = True
        assert recorder._desktop_spool.append(_stereo_i2([6] * 8), frame_position=4) is True
        assert _wait_until(lambda: recorder._desktop_spool.fail_reason is not None)

        close_calls = []
        original_close = recorder._desktop_spool.close

        def tracking_close(final_frame_count=None):
            close_calls.append(final_frame_count)
            return original_close(final_frame_count=final_frame_count)

        recorder._desktop_spool.close = tracking_close
        recorder.is_recording = False
        recorder._close_capture_spools_for_mix()

        assert close_calls == [None], "failed desktop spool must not pad to mic duration"
        assert recorder._capture_manifest.to_dict().get("includeDesktop") is False
        mic_track = recorder._capture_manifest.get_track("mic")
        assert load_track_segment_bytes(
            recorder._capture_manifest.session_dir,
            mic_track["segments"],
        )
        assert recorder._desktop_spool_warning
        assert warnings and warnings[0][0] == "DESKTOP_SPOOL_FAILED"
        assert recorder.get_async_capture_error() is None
    finally:
        recorder._release_capture_spools()


def test_windows_start_recording_opens_spools_after_sample_rate_fallback(tmp_path, monkeypatch):
    """High 2: settle rates with start=False streams before creating spool manifests."""
    open_calls = []
    start_calls = []
    spool_rates = []

    class FakeStream:
        def __init__(self, rate):
            self.rate = rate
            self._active = False

        def start_stream(self):
            start_calls.append(self.rate)
            self._active = True

        def is_active(self):
            return self._active

        def stop_stream(self):
            self._active = False

        def close(self):
            self._active = False

    class FakePa:
        def open(self, **kwargs):
            open_calls.append(dict(kwargs))
            rate = kwargs["rate"]
            if rate == 48000 and kwargs.get("input_device_index") == 0:
                raise OSError("48 kHz unsupported")
            assert kwargs.get("start") is False
            return FakeStream(rate)

        def get_device_info_by_index(self, index):
            assert index == 0
            return {"defaultSampleRate": 44100.0}

    recorder = windows_mod.AudioRecorder.__new__(windows_mod.AudioRecorder)
    recorder.output_path = str(tmp_path / "meeting.opus")
    recorder.mic_device_id = 0
    recorder.loopback_device_id = 1
    recorder.mic_sample_rate = 48000
    recorder.mic_requested_higher_rate = True
    recorder.mic_channels = 2
    recorder.loopback_sample_rate = 48000
    recorder.loopback_channels = 2
    recorder.mixing_mode = True
    recorder.preroll_seconds = 0
    recorder.chunk_size = 256
    recorder.original_chunk_size = 256
    recorder.is_windows = False
    recorder.pa = FakePa()
    recorder.lock = threading.Lock()
    recorder.mic_stream = None
    recorder.desktop_stream = None
    recorder.callback_watchdog = None
    recorder.watchdog_running = False
    recorder._capture_manifest = None
    recorder._mic_spool = None
    recorder._desktop_spool = None
    recorder._async_capture_error = None
    recorder._spool_error_lock = threading.Lock()
    recorder._deferred_desktop_chunks = []
    recorder._deferred_desktop_bytes = 0
    recorder._deferred_desktop_started_at = None
    recorder._desktop_spool_lock = threading.Lock()
    recorder._desktop_spool_accepted_any = False
    recorder._desktop_spool_warning = None
    recorder.mic_watchdog_warning_shown = False
    recorder.desktop_watchdog_warning_shown = False

    real_open = recorder._open_capture_spools

    def tracking_open():
        spool_rates.append(recorder.mic_sample_rate)
        return real_open()

    recorder._open_capture_spools = tracking_open
    monkeypatch.setattr(windows_mod.threading.Thread, "start", lambda self: None)
    monkeypatch.setattr(windows_mod, "_send_event_message", lambda *a, **k: None)

    try:
        recorder.start_recording()
        assert recorder.mic_sample_rate == 44100
        assert spool_rates == [44100]
        assert all(call.get("start") is False for call in open_calls)
        assert start_calls == [44100, 48000]
        mic_track = recorder._capture_manifest.get_track("mic")
        assert mic_track["sampleRate"] == 44100
    finally:
        recorder.is_recording = False
        recorder._abort_start_recording()


def test_windows_deferred_flush_serializes_ahead_of_live_desktop_append(tmp_path):
    """Medium 3: live desktop append must not leapfrog deferred flush."""
    recorder = _make_windows_spool_recorder(tmp_path)
    t0 = 100.0
    early = _stereo_i2([9, 9, 9, 9])  # 2 frames at t0
    live = _stereo_i2([2, 2, 2, 2])  # 2 frames at t0+1
    mic = _stereo_i2([1, 1, 1, 1])

    with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0):
        recorder.recording_start_time = t0
        recorder._desktop_callback(early, 2, None, None)
        assert len(recorder._deferred_desktop_chunks) == 1

    append_order = []
    original_append = recorder._append_desktop_spool_chunk

    def tracking_append(timestamp, in_data, reference):
        append_order.append((timestamp, in_data))
        # While mic holds the desktop lock during flush, a concurrent live desktop
        # callback must block — simulate that by attempting a nested desktop write.
        return original_append(timestamp, in_data, reference)

    recorder._append_desktop_spool_chunk = tracking_append

    barrier = threading.Barrier(2)
    results = {}

    def mic_thread():
        barrier.wait(timeout=2.0)
        with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0):
            recorder._mic_callback(mic, 2, None, None)
        results["mic"] = True

    def desktop_thread():
        barrier.wait(timeout=2.0)
        # Brief yield so mic can acquire the lock first when scheduling allows.
        time.sleep(0.01)
        with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0 + 1.0):
            recorder._desktop_callback(live, 2, None, None)
        results["desk"] = True

    threads = [
        threading.Thread(target=mic_thread),
        threading.Thread(target=desktop_thread),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3.0)

    assert results == {"mic": True, "desk": True}
    assert recorder._deferred_desktop_chunks == []
    assert append_order[0][0] == t0
    assert append_order[0][1] == early
    assert append_order[-1][0] == t0 + 1.0
    assert append_order[-1][1] == live
    recorder.is_recording = False
    recorder._release_capture_spools()


def test_windows_deferred_desktop_bytes_bound_hard_fails(tmp_path):
    """Medium 4: deferred desktop PCM must not grow unbounded without mic capture."""
    recorder = _make_windows_spool_recorder(tmp_path)
    t0 = 5.0
    chunk = _stereo_i2([7, 7])  # 1 stereo frame = 4 bytes
    with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0):
        recorder.recording_start_time = t0
        # Fill just under the bound, then one more chunk must hard-fail.
        max_bytes = windows_mod.DEFERRED_DESKTOP_MAX_BYTES
        while recorder._deferred_desktop_bytes + len(chunk) <= max_bytes:
            status = recorder._desktop_callback(chunk, 1, None, None)[1]
            assert status == windows_mod.pyaudio.paContinue
        status = recorder._desktop_callback(chunk, 1, None, None)[1]
        assert status == windows_mod.pyaudio.paComplete
    err = recorder.get_async_capture_error()
    assert err and "Deferred desktop audio exceeded" in err
    recorder._release_capture_spools()


def test_windows_deferred_desktop_wait_bound_hard_fails(tmp_path):
    """Medium 4: prolonged missing mic capture while deferring desktop hard-fails."""
    recorder = _make_windows_spool_recorder(tmp_path)
    t0 = 5.0
    chunk = _stereo_i2([8, 8])
    with mock.patch("backend.audio.windows_recorder.time.time", return_value=t0):
        recorder.recording_start_time = t0
        assert recorder._desktop_callback(chunk, 1, None, None)[1] == windows_mod.pyaudio.paContinue
    late = t0 + windows_mod.DEFERRED_DESKTOP_MAX_WAIT_S + 0.1
    with mock.patch("backend.audio.windows_recorder.time.time", return_value=late):
        status = recorder._desktop_callback(chunk, 1, None, None)[1]
        assert status == windows_mod.pyaudio.paComplete
    err = recorder.get_async_capture_error()
    assert err and "Microphone capture did not start" in err
    recorder._release_capture_spools()
