"""Linux recorder contract tests with injected Pulse/SoundCard fakes.

No live Pulse server is required. These cover the Phase 3 automated cases
that can run on a headless VPS.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from backend.audio.capture_manifest import MANIFEST_FILENAME
from backend.audio.capture_recovery import list_interrupted_captures, recover_capture
from backend.audio.linux_recorder import LinuxAudioRecorder
from backend.audio.streaming_post_processor import FinalizationError, FinalizationResult
import backend.audio.linux_recorder as linux_mod


MIC_NAME = "avanevis_mic"
MONITOR_NAME = "avanevis_desktop.monitor"
MIC_ID = f"pulse-source:{MIC_NAME}"
MONITOR_ID = f"pulse-monitor:{MONITOR_NAME}"


class FakeRecorder:
    def __init__(self, backend, pulse_name):
        self.backend = backend
        self.pulse_name = pulse_name
        self._records = 0

    def __enter__(self):
        fail = self.backend.fail_open.get(self.pulse_name)
        if fail:
            raise RuntimeError(fail)
        return self

    def __exit__(self, *args):
        fail = self.backend.fail_exit.get(self.pulse_name)
        if fail:
            raise RuntimeError(fail)
        return False

    def record(self, numframes=None):
        fail = self.backend.fail_record.get(self.pulse_name)
        if fail is not None and self._records >= fail:
            raise RuntimeError(f"simulated {self.pulse_name} capture failure")
        self._records += 1
        time.sleep(0.01)
        hook = self.backend.on_record.get(self.pulse_name)
        if hook is not None:
            hook(self._records)
        channels = self.backend.channels.get(self.pulse_name, 2)
        frames = int(numframes or 1024)
        return np.full((frames, channels), 0.2, dtype=np.float32)


class FakeMicrophone:
    def __init__(self, backend, pulse_name):
        self.backend = backend
        self.name = pulse_name
        self.id = pulse_name
        self.channels = backend.channels.get(pulse_name, 2)

    def recorder(self, samplerate=48000, channels=2, blocksize=1024):
        return FakeRecorder(self.backend, self.id)


class FakeSoundCard:
    def __init__(self):
        self.channels = {MIC_NAME: 1, MONITOR_NAME: 2}
        self.fail_open = {}
        self.fail_record = {}
        self.fail_exit = {}
        self.on_record = {}
        self.mismatched_fallback = set()

    def all_microphones(self, include_loopback=False):
        names = [MIC_NAME]
        if include_loopback:
            names.append(MONITOR_NAME)
        return [FakeMicrophone(self, name) for name in names]

    def get_microphone(self, name, include_loopback=False):
        if name in self.mismatched_fallback:
            # SoundCard matches by substring; emulate it binding another device.
            other = FakeMicrophone(self, name)
            other.id = f"{name}_some_other_device"
            other.name = other.id
            return other
        if name not in self.channels:
            raise ValueError(f"unknown SoundCard source {name}")
        return FakeMicrophone(self, name)


class FakePulse:
    def __init__(self, names):
        self._lock = threading.Lock()
        self._names = list(names)
        self.raise_on_list = False

    def source_list(self):
        with self._lock:
            if self.raise_on_list:
                raise RuntimeError("pulse source_list failed")
            return [SimpleNamespace(name=name) for name in self._names]

    def remove_source(self, name):
        with self._lock:
            self._names = [item for item in self._names if item != name]

    def close(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def _stdout_payloads(capsys):
    captured = capsys.readouterr()
    payloads = []
    for line in captured.out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payloads.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return payloads


def _make_recorder(tmp_path, *, soundcard, pulse, desktop_id=MONITOR_ID, factory_calls=None, **kwargs):
    def factory():
        if factory_calls is not None:
            factory_calls.append(1)
        return pulse

    return LinuxAudioRecorder(
        mic_device_id=MIC_ID,
        desktop_device_id=desktop_id,
        output_path=str(tmp_path / "recording.wav"),
        preroll_seconds=0,
        soundcard_module=soundcard,
        pulse_factory=factory,
        **kwargs,
    )


def _patch_finalize_success(monkeypatch):
    seen = {}

    def fake_finalize(manifest_path, output_path, *, progress_callback=None, coordinator=None, **kwargs):
        try:
            seen["manifest"] = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        except Exception:
            seen["manifest"] = None
        if progress_callback:
            for stage, message in (
                ("post_processing_started", "Finishing recording..."),
                ("audio_normalizing", "Normalizing audio..."),
                ("audio_mixing", "Mixing audio..."),
                ("audio_encoding", "Encoding audio..."),
                ("post_processing_complete", "Recording saved."),
            ):
                progress_callback(stage, message)
        dest = Path(str(output_path)).with_suffix(".opus")
        dest.write_bytes(b"opus-fake")
        if coordinator is not None:
            try:
                coordinator.set_state("complete")
                coordinator.close()
            except Exception:
                pass
        return FinalizationResult(
            final_path=str(dest),
            duration=0.25,
            temp_wav_path=None,
            recovered=False,
        )

    monkeypatch.setattr(linux_mod, "finalize_capture", fake_finalize)
    return seen


def _wait_until(predicate, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_mic_plus_desktop_stop_success(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._mic_spool is not None and recorder._mic_spool.written_frames > 0)
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    capture_dir = Path(str(tmp_path / "recording.wav")).with_name("recording.capture")
    assert capture_dir.is_dir()
    assert list(capture_dir.glob("mic_*.pcm.part"))
    assert list(capture_dir.glob("desktop_*.pcm.part"))
    recorder.stop_recording()

    payloads = _stdout_payloads(capsys)
    events = [item.get("event") for item in payloads if item.get("type") == "event"]
    assert "recording_started" in events
    assert "post_processing_started" in events
    assert "audio_normalizing" in events
    assert "audio_mixing" in events
    assert "audio_encoding" in events
    assert "post_processing_complete" in events
    assert recorder.recording_failure is None
    assert recorder.final_output_path
    assert Path(recorder.final_output_path).is_file()
    assert recorder._capture_manifest is None


def test_mic_only_success(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse, desktop_id="none")

    assert recorder.start_recording() is True
    assert recorder._desktop_spool is None
    time.sleep(0.08)
    recorder.stop_recording()
    payloads = _stdout_payloads(capsys)
    started = next(item for item in payloads if item.get("event") == "recording_started")
    assert started.get("desktopStatus") == "unavailable"
    assert recorder.recording_failure is None
    assert Path(recorder.final_output_path).is_file()


def test_desktop_startup_failure_warns_and_continues_mic_only(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    soundcard.fail_open[MONITOR_NAME] = "monitor open failed"
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    time.sleep(0.08)
    recorder.stop_recording()
    payloads = _stdout_payloads(capsys)
    warnings = [item for item in payloads if item.get("type") == "warning"]
    assert any(item.get("code") == "DESKTOP_START_FAILED" for item in warnings)
    errors = [item for item in payloads if item.get("type") == "error"]
    assert not any("DESKTOP" in (item.get("code") or "") for item in errors)
    assert recorder.recording_failure is None
    assert Path(recorder.final_output_path).is_file()


def test_late_desktop_failure_warns_and_continues_mic_only(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    pulse.remove_source(MONITOR_NAME)
    assert _wait_until(lambda: bool(recorder._desktop_runtime_failure), timeout=3.0)
    assert recorder.is_recording() is True
    recorder.stop_recording()
    payloads = _stdout_payloads(capsys)
    warnings = [item for item in payloads if item.get("type") == "warning"]
    assert any(item.get("code") == "DESKTOP_MONITOR_VANISHED" for item in warnings)
    assert recorder.recording_failure is None
    assert Path(recorder.final_output_path).is_file()


def test_mic_failure_is_structured_failure(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    soundcard.fail_record[MIC_NAME] = 3
    pulse = FakePulse([MIC_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse, desktop_id="none")

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._has_async_recording_error(), timeout=3.0)
    recorder.stop_recording()
    payloads = _stdout_payloads(capsys)
    errors = [item for item in payloads if item.get("type") == "error"]
    assert any(item.get("code") in {"MIC_RECORDING_FAILED", "RECORDING_THREAD_FAILED"} for item in errors)
    assert recorder.recording_failure is not None
    assert recorder.recording_failure["code"] == "RECORDING_THREAD_FAILED"


def test_recoverable_finalization_failure(tmp_path, monkeypatch):
    def fake_finalize(manifest_path, output_path, **kwargs):
        wav = Path(str(output_path)).with_suffix(".wav")
        wav.write_bytes(b"R" * 64)
        raise FinalizationError("encode failed", recoverable_path=str(wav))

    monkeypatch.setattr(linux_mod, "finalize_capture", fake_finalize)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse, desktop_id="none")
    assert recorder.start_recording() is True
    time.sleep(0.08)
    recorder.stop_recording()
    assert recorder.recording_failure["code"] == "CAPTURE_FINALIZE_FAILED"
    recovered = recorder._resolve_recoverable_output_path()
    assert recovered
    assert Path(recovered).is_file()
    assert not recovered.lower().endswith(".pcm.tmp")


def test_cancel_tombstone_does_not_finalize_or_resurrect(tmp_path, monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("finalize_capture must not run on cancel")

    monkeypatch.setattr(linux_mod, "finalize_capture", boom)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)
    assert recorder.start_recording() is True
    time.sleep(0.08)
    session_dir = recorder._capture_manifest.session_dir
    recorder.cancel_recording()
    assert recorder.recording_failure is None
    assert recorder.final_output_path is None
    candidates = list_interrupted_captures(tmp_path)
    assert candidates == []
    # Tombstone-then-delete: discarded sessions are cleanup-only.
    if session_dir.exists():
        manifest = json.loads((session_dir / MANIFEST_FILENAME).read_text())
        assert manifest.get("state") == "discarded"
        result = recover_capture(tmp_path, session_dir, ffmpeg_path="ffmpeg")
        assert result.get("cancelled") is True


def test_linux_v1_profile_is_written_to_manifest(tmp_path, monkeypatch):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse, desktop_id="none")
    assert recorder.start_recording() is True
    profile = recorder._capture_manifest.to_dict().get("processingProfile")
    assert profile == "linux-v1"
    recorder.cancel_recording()


def test_opaque_ids_are_not_parsed_as_integers():
    source = Path(linux_mod.__file__).read_text(encoding="utf-8")
    assert 'parser.add_argument("--mic"' in source
    argparse_block = source.split("argparse.ArgumentParser", 1)[1].split("args = parser.parse_args()", 1)[0]
    mic_arg = argparse_block.split('parser.add_argument("--mic"', 1)[1].split("parser.add_argument", 1)[0]
    loopback_arg = argparse_block.split('parser.add_argument(\n        "--loopback"', 1)
    if len(loopback_arg) == 1:
        loopback_arg = argparse_block.split('parser.add_argument("--loopback"', 1)
    loopback_block = loopback_arg[1].split("parser.add_argument", 1)[0]
    assert "type=int" not in mic_arg
    assert "type=int" not in loopback_block
    assert "parseInt" not in source
    assert "pulse-source:" in source
    assert "pulse-monitor:" in source


def test_no_whole_session_capture_array():
    source = Path(linux_mod.__file__).read_text(encoding="utf-8")
    assert "audio_buffer" not in source
    assert "mic_buffer" not in source
    assert "desktop_buffer" not in source
    assert "TrackSpool" in source
    assert "finalize_capture" in source


def test_missing_monitor_at_start_warns_and_continues_mic_only(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert recorder._desktop_spool is None
    time.sleep(0.08)
    recorder.stop_recording()
    payloads = _stdout_payloads(capsys)
    warnings = [item for item in payloads if item.get("type") == "warning"]
    assert any(item.get("code") == "DESKTOP_START_FAILED" for item in warnings)
    assert recorder.recording_failure is None
    assert Path(recorder.final_output_path).is_file()


def test_pulse_probe_exception_does_not_treat_monitor_as_vanished(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    pulse.raise_on_list = True
    time.sleep(0.8)
    assert recorder._desktop_runtime_failure is None
    assert recorder.is_recording() is True
    recorder.stop_recording()
    payloads = _stdout_payloads(capsys)
    warnings = [item for item in payloads if item.get("type") == "warning"]
    assert not any(item.get("code") == "DESKTOP_MONITOR_VANISHED" for item in warnings)
    assert recorder.recording_failure is None


def test_late_desktop_vanish_keeps_committed_desktop_audio(tmp_path, monkeypatch, capsys):
    """A monitor that vanishes mid-meeting must not discard the desktop audio
    already committed before it went away (routine on Linux when the user
    switches audio output)."""
    finalized = _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    pulse.remove_source(MONITOR_NAME)
    assert _wait_until(lambda: bool(recorder._desktop_runtime_failure), timeout=3.0)
    desktop_spool = recorder._desktop_spool
    mic_spool = recorder._mic_spool
    assert desktop_spool is not None
    assert mic_spool is not None
    desktop_at_vanish = desktop_spool.written_frames
    # A fixed 0.1s sleep is not enough for another mic block on a loaded macOS
    # runner (the CI flake was desktop == mic == 15360). Wait until the mic
    # thread actually continues past the truncated desktop track.
    assert _wait_until(
        lambda: mic_spool.written_frames > desktop_at_vanish,
        timeout=3.0,
    ), "microphone should keep writing after the desktop monitor vanishes"
    recorder.stop_recording()

    manifest = finalized.get("manifest")
    assert manifest is not None
    assert manifest["includeDesktop"] is True
    desktop_frames = manifest["tracks"]["desktop"]["committedFrames"]
    mic_frames = manifest["tracks"]["mic"]["committedFrames"]
    assert desktop_frames > 0
    # Truncated at the last real desktop frame — no invented silence to mic length.
    assert desktop_frames <= desktop_at_vanish + 1024
    assert desktop_frames < mic_frames

    payloads = _stdout_payloads(capsys)
    vanished = next(
        item for item in payloads
        if item.get("type") == "warning" and item.get("code") == "DESKTOP_MONITOR_VANISHED"
    )
    # Copy must not claim a mic-only save when desktop audio is kept.
    assert "microphone audio only" not in vanished.get("message", "")
    assert "kept" in vanished.get("message", "")
    assert recorder.recording_failure is None
    assert recorder._desktop_partial_capture is True


def test_desktop_start_failure_keeps_mic_only_copy(tmp_path, monkeypatch, capsys):
    """Nothing was ever captured, so the mic-only wording must stay."""
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    soundcard.fail_open[MONITOR_NAME] = "monitor open failed"
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    time.sleep(0.08)
    recorder.stop_recording()

    payloads = _stdout_payloads(capsys)
    warning = next(
        item for item in payloads
        if item.get("type") == "warning" and item.get("code") == "DESKTOP_START_FAILED"
    )
    assert "microphone audio only" in warning.get("message", "")
    assert recorder._desktop_partial_capture is False


def test_mic_append_after_stop_close_is_not_a_writer_stall(tmp_path, monkeypatch, capsys):
    """The mic thread blocks inside record(); stop can close and commit the spool
    underneath it. Waking up and appending to that closed spool must not be
    reported as a stall — that error makes stop skip finalization entirely."""
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse, desktop_id="none")

    raced = threading.Event()

    def close_spool_under_the_thread(call_index):
        # Reproduce the stop-vs-blocking-read window: running flag cleared and the
        # spool committed while this thread was inside record().
        if call_index < 3 or raced.is_set():
            return
        raced.set()
        recorder._set_running(False)
        spool = recorder._mic_spool
        if spool is not None:
            spool.close()

    soundcard.on_record[MIC_NAME] = close_spool_under_the_thread

    assert recorder.start_recording() is True
    assert _wait_until(lambda: raced.is_set(), timeout=3.0)
    if recorder.mic_thread:
        recorder.mic_thread.join(timeout=2.0)

    # This is exactly what stop_recording() consults before deciding whether to
    # skip finalization, so a false positive here loses the whole meeting.
    assert recorder._has_async_recording_error() is False
    assert recorder._resolve_async_recording_failure() is None
    assert recorder._last_error is None
    payloads = _stdout_payloads(capsys)
    errors = [item for item in payloads if item.get("type") == "error"]
    assert errors == []
    recorder._release_capture_spools()


def test_desktop_append_after_stop_close_emits_no_spurious_warning(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    raced = threading.Event()

    def close_spool_under_the_thread(call_index):
        if call_index < 3 or raced.is_set():
            return
        raced.set()
        recorder._set_running(False)
        spool = recorder._desktop_spool
        if spool is not None:
            spool.close()

    soundcard.on_record[MONITOR_NAME] = close_spool_under_the_thread

    assert recorder.start_recording() is True
    assert _wait_until(lambda: raced.is_set(), timeout=3.0)
    if recorder.desktop_thread:
        recorder.desktop_thread.join(timeout=2.0)

    assert recorder._desktop_runtime_failure is None
    payloads = _stdout_payloads(capsys)
    warnings = [item for item in payloads if item.get("type") == "warning"]
    assert not any(item.get("code") == "DESKTOP_SPOOL_FAILED" for item in warnings)
    recorder._release_capture_spools()


def test_monitor_watchdog_reuses_one_pulse_client(tmp_path, monkeypatch):
    """The vanished-monitor poll runs twice a second for the whole meeting; it
    must not open a fresh Pulse connection per poll."""
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    factory_calls = []
    recorder = _make_recorder(
        tmp_path, soundcard=soundcard, pulse=pulse, factory_calls=factory_calls
    )

    assert recorder.start_recording() is True
    startup_calls = len(factory_calls)
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    time.sleep(1.6)  # >= 3 watchdog polls
    watch_calls = len(factory_calls) - startup_calls
    recorder.stop_recording()

    assert watch_calls == 1, f"watchdog opened {watch_calls} Pulse clients"
    assert recorder._watch_pulse is None


def test_watchdog_pulse_client_is_rebuilt_after_a_failure(tmp_path, monkeypatch):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    factory_calls = []
    recorder = _make_recorder(
        tmp_path, soundcard=soundcard, pulse=pulse, factory_calls=factory_calls
    )

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    assert _wait_until(lambda: recorder._watch_pulse is not None, timeout=2.0)
    pulse.raise_on_list = True
    assert _wait_until(lambda: recorder._watch_pulse is None, timeout=2.0)
    before = len(factory_calls)
    pulse.raise_on_list = False
    assert _wait_until(lambda: len(factory_calls) > before, timeout=2.0)
    assert recorder._desktop_runtime_failure is None
    recorder.stop_recording()
    assert recorder.recording_failure is None


class InstrumentedPulse(FakePulse):
    """Detects a close() that lands while source_list() is still in flight.

    pulsectl frees a libpulse mainloop in close(); doing that under an active
    call is a native use-after-free, so the recorder must serialise them.
    """

    def __init__(self, names, *, list_delay=0.2):
        super().__init__(names)
        self.list_delay = list_delay
        self.in_flight = threading.Event()
        self.closed = False
        self.overlapped = False
        self.close_calls = 0

    def source_list(self):
        self.in_flight.set()
        try:
            if self.closed:
                self.overlapped = True
            time.sleep(self.list_delay)
            if self.closed:
                self.overlapped = True
            return super().source_list()
        finally:
            self.in_flight.clear()

    def close(self):
        if self.in_flight.is_set():
            self.overlapped = True
        self.close_calls += 1
        self.closed = True
        return None


def test_watchdog_probe_and_close_never_overlap(tmp_path, monkeypatch):
    """Stop joins capture threads with a bounded timeout, so a thread stalled in
    record() can still be inside source_list() when the main thread tears the
    watch client down. Closing there would segfault libpulse, not raise."""
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = InstrumentedPulse([MIC_NAME, MONITOR_NAME], list_delay=0.25)
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert _wait_until(lambda: pulse.in_flight.is_set(), timeout=3.0)
    # Close while the watchdog is demonstrably inside source_list().
    recorder._close_watch_pulse(final=True)

    assert pulse.overlapped is False, "close() ran while source_list() was in flight"
    assert pulse.closed is True
    recorder.stop_recording()


def test_watch_close_is_bounded_when_source_list_wedges(tmp_path, monkeypatch):
    """Serialising close against source_list must not make stop hang forever if
    the Pulse call itself wedges. Bounded give-up leaks one client (the capture
    thread's finally still closes it) instead of stalling the stop path."""
    _patch_finalize_success(monkeypatch)
    monkeypatch.setattr(linux_mod, "WATCH_PULSE_CLOSE_TIMEOUT_SECONDS", 0.2)
    soundcard = FakeSoundCard()
    pulse = InstrumentedPulse([MIC_NAME, MONITOR_NAME], list_delay=5.0)
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert _wait_until(lambda: pulse.in_flight.is_set(), timeout=3.0)

    started = time.monotonic()
    recorder._close_watch_pulse(final=True)
    elapsed = time.monotonic() - started

    assert elapsed < 2.0, f"close blocked for {elapsed:.2f}s behind a wedged source_list()"
    assert pulse.overlapped is False
    # The latch still applies even though the close itself was skipped.
    assert recorder._watch_pulse_closed is True
    assert recorder._monitor_still_listed() is True
    recorder.stop_recording()


def test_watchdog_does_not_reconnect_after_stop(tmp_path, monkeypatch):
    """A late loop iteration must not rebuild the client stop just closed, and
    must not report a vanish on the way out."""
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    factory_calls = []
    recorder = _make_recorder(
        tmp_path, soundcard=soundcard, pulse=pulse, factory_calls=factory_calls
    )

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    recorder.stop_recording()

    calls_after_stop = len(factory_calls)
    pulse.remove_source(MONITOR_NAME)
    # Simulates the late iteration: the monitor really is gone, but the session
    # is over, so this must fail open rather than reconnect or warn.
    assert recorder._monitor_still_listed() is True
    assert len(factory_calls) == calls_after_stop
    assert recorder._watch_pulse is None
    assert recorder.recording_failure is None


def test_mic_teardown_error_after_stop_still_finalizes(tmp_path, monkeypatch, capsys):
    """The SoundCard recorder's __exit__ unwinds at stop. An error there used to
    set _error_event, which stop_recording reads *after* closing the spools —
    skipping finalize_capture and losing an otherwise complete meeting to
    RECORDING_THREAD_FAILED with duration 0."""
    seen = _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    soundcard.fail_exit[MIC_NAME] = "stream already gone"
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    recorder.stop_recording()

    assert recorder.recording_failure is None
    assert recorder.final_output_path is not None
    assert seen.get("manifest") is not None
    payloads = _stdout_payloads(capsys)
    assert not [p for p in payloads if p.get("code") == "MIC_RECORDING_FAILED"]
    assert not [p for p in payloads if p.get("code") == "RECORDING_THREAD_FAILED"]


def test_desktop_teardown_error_after_stop_emits_no_warning(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    soundcard.fail_exit[MONITOR_NAME] = "monitor stream already gone"
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    recorder.stop_recording()

    assert recorder.recording_failure is None
    payloads = _stdout_payloads(capsys)
    assert not [p for p in payloads if p.get("code") == "DESKTOP_RECORDING_FAILED"]


def test_desktop_teardown_error_after_cancel_emits_no_warning(tmp_path, monkeypatch, capsys):
    """Discard must stay clean: a phantom desktop warning would contradict the
    `capture discarded` result the user just asked for."""
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    soundcard.fail_exit[MONITOR_NAME] = "monitor stream already gone"
    soundcard.fail_exit[MIC_NAME] = "mic stream already gone"
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    assert _wait_until(lambda: recorder._desktop_spool_accepted_any)
    recorder.cancel_recording()

    payloads = _stdout_payloads(capsys)
    assert not [p for p in payloads if p.get("type") == "warning"]
    assert not [p for p in payloads if p.get("type") == "error"]


def test_soundcard_fallback_must_match_the_requested_pulse_name(tmp_path, monkeypatch, capsys):
    """SoundCard's lookup matches by substring. Binding a different device than
    the one the user picked would silently record the wrong source."""
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()

    def only_the_monitor(include_loopback=False):
        # Force the get_microphone() fallback for the mic.
        return [FakeMicrophone(soundcard, MONITOR_NAME)] if include_loopback else []

    soundcard.all_microphones = only_the_monitor
    soundcard.mismatched_fallback.add(MIC_NAME)
    pulse = FakePulse([MIC_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse, desktop_id="none")

    assert recorder.start_recording() is False
    payloads = _stdout_payloads(capsys)
    errors = [item for item in payloads if item.get("type") == "error"]
    assert any("different device" in (item.get("message") or "") for item in errors)


def test_desktop_soundcard_mismatch_degrades_to_mic_only(tmp_path, monkeypatch, capsys):
    _patch_finalize_success(monkeypatch)
    soundcard = FakeSoundCard()
    real_all = soundcard.all_microphones

    def hide_the_monitor(include_loopback=False):
        return [mic for mic in real_all(include_loopback=include_loopback) if mic.id != MONITOR_NAME]

    soundcard.all_microphones = hide_the_monitor
    soundcard.mismatched_fallback.add(MONITOR_NAME)
    pulse = FakePulse([MIC_NAME, MONITOR_NAME])
    recorder = _make_recorder(tmp_path, soundcard=soundcard, pulse=pulse)

    assert recorder.start_recording() is True
    time.sleep(0.08)
    recorder.stop_recording()
    payloads = _stdout_payloads(capsys)
    warnings = [item for item in payloads if item.get("type") == "warning"]
    assert any(item.get("code") == "DESKTOP_START_FAILED" for item in warnings)
    assert recorder.recording_failure is None
    assert Path(recorder.final_output_path).is_file()
