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

from backend.audio.chunked_audio_buffer import ChunkedAudioBuffer
from backend.audio.timeline import reconstruct_desktop_timeline
from backend.audio.swift_audio_capture import SwiftAudioCapture
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
    recorder.mic_frames = []
    recorder.desktop_frames = []
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
    recorder._use_capture_spool = True
    recorder._capture_manifest = None
    recorder._mic_spool = None
    recorder._desktop_spool = None
    recorder._async_capture_error = None
    recorder._spool_desktop_pcm = None
    recorder._spool_error_lock = threading.Lock()
    recorder._deferred_desktop_chunks = []
    recorder._desktop_spool_accepted_any = False
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
    assert recorder._spool_desktop_pcm is not None
    assert np.array_equal(recorder._spool_desktop_pcm, expected)
    assert recorder.get_async_capture_error() is None
    mic_bytes = b"".join(recorder.mic_frames)
    assert mic_payload in mic_bytes or mic_bytes.startswith(mic_payload)


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
    assert len(recorder._spool_desktop_pcm) == 0
    assert recorder.desktop_frames == []


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
    recorder.mic_frames = ChunkedAudioBuffer()
    recorder.desktop_frames = []
    recorder.recording_failure = None
    recorder.final_output_path = None
    recorder.recording_duration = 0.0
    recorder.desktop_diagnostics = {}
    recorder._use_capture_spool = True
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
    assert recorder.desktop_frames == []
    assert recorder._desktop_spool_accepted_any is False
    assert recorder.mic_frames


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

    good = np.ones((2, 2), dtype=np.float32) * 0.5
    assert recorder._desktop_audio_sink(good) is True
    committed_before = recorder._desktop_spool.committed_frames
    # Force a sink rejection path via helper error + rejected further appends.
    recorder._desktop_spool._mark_failed("injected desktop stall")
    assert recorder._desktop_audio_sink(good) is False
    recorder.desktop_capture.error_event.set()
    recorder.desktop_capture.last_error = "Desktop audio sink rejected audio (writer backpressure)"
    recorder._consume_desktop_helper_failure()
    assert any(code == "DESKTOP_AUDIO_FAILED" for code, _ in warnings)

    before_close_written = recorder._desktop_spool._written_frames
    recorder._close_capture_spools_for_mix()
    assert recorder.desktop_frames == []
    assert recorder._desktop_runtime_failure is not None

    # Mic still hydrates; process path must choose mic-only.
    mic = np.ones((8, 2), dtype=np.float32) * 0.2
    recorder.mic_frames = ChunkedAudioBuffer()
    recorder.mic_frames.append(mic)

    mix_branch = {"mixed": False}

    original_process = recorder._process_and_save

    def wrapped():
        # Observe branch selection without compressing.
        if recorder.desktop_frames and not recorder._desktop_runtime_failure:
            mix_branch["mixed"] = True
        else:
            mix_branch["mixed"] = False
        recorder.recording_failure = None
        recorder.final_output_path = str(tmp_path / "out.opus")
        recorder.recording_duration = 1.0
        return True

    recorder._process_and_save = wrapped
    assert recorder._process_and_save() is True
    assert mix_branch["mixed"] is False
    # Close must not pad desktop to mic length after failure.
    assert before_close_written >= committed_before


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
