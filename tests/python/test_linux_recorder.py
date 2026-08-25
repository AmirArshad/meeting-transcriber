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
        return False

    def record(self, numframes=None):
        fail = self.backend.fail_record.get(self.pulse_name)
        if fail is not None and self._records >= fail:
            raise RuntimeError(f"simulated {self.pulse_name} capture failure")
        self._records += 1
        time.sleep(0.01)
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

    def all_microphones(self, include_loopback=False):
        names = [MIC_NAME]
        if include_loopback:
            names.append(MONITOR_NAME)
        return [FakeMicrophone(self, name) for name in names]

    def get_microphone(self, name, include_loopback=False):
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


def _make_recorder(tmp_path, *, soundcard, pulse, desktop_id=MONITOR_ID, **kwargs):
    return LinuxAudioRecorder(
        mic_device_id=MIC_ID,
        desktop_device_id=desktop_id,
        output_path=str(tmp_path / "recording.wav"),
        preroll_seconds=0,
        soundcard_module=soundcard,
        pulse_factory=lambda: pulse,
        **kwargs,
    )


def _patch_finalize_success(monkeypatch):
    def fake_finalize(manifest_path, output_path, *, progress_callback=None, coordinator=None, **kwargs):
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
    return fake_finalize


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
