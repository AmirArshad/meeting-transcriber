from __future__ import annotations

import importlib
import sys
from unittest import mock

import numpy as np
import pytest

from backend.audio.capture_manifest import (
    CaptureManifestCoordinator,
    CaptureManifestError,
    validate_manifest_data,
)


def _install_fake_pyaudio(monkeypatch):
    """Provide a stand-in ``pyaudiowpatch`` without leaking it across tests.

    ``sys.modules.setdefault`` would persist for the whole session and hand a
    MagicMock to any later test that imports the real module.
    """
    fake_pyaudio = mock.MagicMock()
    fake_pyaudio.paInt16 = 8
    fake_pyaudio.paContinue = 0
    fake_pyaudio.paComplete = 1
    monkeypatch.setitem(sys.modules, "pyaudiowpatch", fake_pyaudio)
    return fake_pyaudio


def test_resolve_capture_mode_describes_requested_tracks() -> None:
    capture_mode = importlib.import_module("backend.audio.capture_mode")

    assert capture_mode.resolve_capture_mode("mic-and-desktop") == (True, True)
    assert capture_mode.resolve_capture_mode("mic-only") == (True, False)
    assert capture_mode.resolve_capture_mode("desktop-only") == (False, True)


def test_resolve_capture_mode_rejects_unknown_values() -> None:
    capture_mode = importlib.import_module("backend.audio.capture_mode")

    for value in ("all-the-audio", "", "MIC-ONLY", "mic", None, 0, -1):
        with pytest.raises(capture_mode.CaptureModeError, match="Invalid capture mode"):
            capture_mode.resolve_capture_mode(value)


def test_desktop_only_failure_copy_never_promises_microphone_audio() -> None:
    capture_mode = importlib.import_module("backend.audio.capture_mode")
    message = capture_mode.DESKTOP_ONLY_NO_AUDIO_MESSAGE

    assert "microphone" not in message.lower()
    assert "mic" not in message.lower()


def test_linux_recorder_rejects_an_invalid_capture_mode_before_touching_pulse() -> None:
    linux = importlib.import_module("backend.audio.linux_recorder")
    capture_mode = importlib.import_module("backend.audio.capture_mode")

    def exploding_pulse_factory():  # pragma: no cover - must never run
        raise AssertionError("an invalid capture mode must be rejected before device work")

    for bad_mode in ("all-the-audio", "", "MIC-ONLY", None):
        with pytest.raises(capture_mode.CaptureModeError):
            linux.LinuxAudioRecorder(
                mic_device_id="pulse-source:mic",
                desktop_device_id="pulse-monitor:out.monitor",
                output_path="/tmp/never-created.wav",
                capture_mode=bad_mode,
                pulse_factory=exploding_pulse_factory,
            )

    # The CLI default stays valid for direct invocation compatibility.
    recorder = linux.LinuxAudioRecorder(
        mic_device_id="pulse-source:mic",
        desktop_device_id="pulse-monitor:out.monitor",
        output_path="/tmp/never-created.wav",
        pulse_factory=exploding_pulse_factory,
    )
    assert recorder.capture_mode == "mic-and-desktop"
    assert (recorder.include_mic, recorder.include_desktop) == (True, True)


def test_macos_recorder_rejects_an_invalid_capture_mode_before_opening_capture(
    tmp_path, monkeypatch
) -> None:
    macos = importlib.import_module("backend.audio.macos_recorder")
    capture_mode = importlib.import_module("backend.audio.capture_mode")

    class ExplodingDesktopCapture:  # pragma: no cover - must never be constructed
        def __init__(self, **kwargs):
            raise AssertionError("an invalid capture mode must be rejected first")

    monkeypatch.setattr(macos, "SWIFT_CAPTURE_AVAILABLE", True)
    monkeypatch.setattr(macos, "SwiftAudioCapture", ExplodingDesktopCapture)
    monkeypatch.setattr(macos, "SCREENCAPTURE_AVAILABLE", False)

    with pytest.raises(capture_mode.CaptureModeError):
        macos.MacOSAudioRecorder(
            mic_device_id=0,
            desktop_device_id=-1,
            output_path=str(tmp_path / "meeting.wav"),
            capture_mode="all-the-audio",
        )


def test_windows_recorder_rejects_an_invalid_capture_mode_before_opening_pyaudio(
    tmp_path, monkeypatch
) -> None:
    fake_pyaudio = _install_fake_pyaudio(monkeypatch)
    windows = importlib.reload(importlib.import_module("backend.audio.windows_recorder"))
    capture_mode = importlib.import_module("backend.audio.capture_mode")

    opened = []
    monkeypatch.setattr(
        windows.pyaudio,
        "PyAudio",
        lambda *a, **k: opened.append(1) or mock.MagicMock(),
    )

    with pytest.raises(capture_mode.CaptureModeError):
        windows.AudioRecorder(
            mic_device_id=0,
            loopback_device_id=1,
            output_path=str(tmp_path / "meeting.wav"),
            capture_mode="all-the-audio",
        )

    # PyAudio must not be instantiated for a rejected mode.
    assert opened == []
    assert fake_pyaudio is sys.modules["pyaudiowpatch"]


def test_macos_mic_only_does_not_construct_desktop_capture(tmp_path, monkeypatch) -> None:
    macos = importlib.import_module("backend.audio.macos_recorder")
    constructed = []

    class DesktopCapture:
        def __init__(self, **kwargs):
            constructed.append(kwargs)

    monkeypatch.setattr(macos, "SWIFT_CAPTURE_AVAILABLE", True)
    monkeypatch.setattr(macos, "SwiftAudioCapture", DesktopCapture)
    monkeypatch.setattr(macos, "SCREENCAPTURE_AVAILABLE", False)

    recorder = macos.MacOSAudioRecorder(
        mic_device_id=0,
        desktop_device_id=-1,
        output_path=str(tmp_path / "meeting.wav"),
        capture_mode="mic-only",
    )

    assert constructed == []
    assert recorder.desktop_capture is None
    assert recorder.include_mic is True
    assert recorder.include_desktop is False


def test_macos_desktop_only_reports_a_missing_backend_before_creating_spools(
    tmp_path, monkeypatch, capsys
) -> None:
    """A desktop-less desktop-only start must not surface as a spool error."""
    macos = importlib.import_module("backend.audio.macos_recorder")

    monkeypatch.setattr(macos, "SWIFT_CAPTURE_AVAILABLE", False)
    monkeypatch.setattr(macos, "SCREENCAPTURE_AVAILABLE", False)

    output = tmp_path / "meeting.wav"
    recorder = macos.MacOSAudioRecorder(
        mic_device_id=0,
        desktop_device_id=-1,
        output_path=str(output),
        capture_mode="desktop-only",
    )
    assert recorder.desktop_capture is None

    assert recorder.start_recording() is False

    payloads = []
    for line in capsys.readouterr().out.splitlines():
        line = line.strip()
        if line.startswith("{"):
            import json

            try:
                payloads.append(json.loads(line))
            except ValueError:
                continue

    errors = [item for item in payloads if item.get("type") == "error"]
    assert any(item.get("code") == "NO_DESKTOP_AUDIO_BACKEND" for item in errors), errors
    assert not any(item.get("code") == "CAPTURE_SPOOL_OPEN_FAILED" for item in errors), errors
    # No orphan capture session directory may be left behind.
    assert not (tmp_path / "meeting.capture").exists()


def test_macos_cli_mic_only_skips_desktop_backend_requirement(monkeypatch, tmp_path) -> None:
    """The real CLI must let mic-only reach its recorder without desktop support."""
    macos = importlib.import_module("backend.audio.macos_recorder")
    queried = []

    monkeypatch.setattr(macos, "SWIFT_CAPTURE_AVAILABLE", False)
    monkeypatch.setattr(macos, "SCREENCAPTURE_AVAILABLE", False)
    monkeypatch.setattr(macos.sd, "query_devices", lambda: queried.append(True) or [])
    monkeypatch.setattr(sys, "argv", [
        "macos_recorder.py", "--mic", "0", "--loopback", "-1",
        "--capture-mode", "mic-only", "--output", str(tmp_path / "meeting.opus"),
    ])

    class RecorderExit(Exception):
        pass

    class FakeRecorder:
        recording_failure = None
        recording_duration = 1
        desktop_diagnostics = {}

        def __init__(self, **kwargs):
            assert kwargs["capture_mode"] == "mic-only"

        def start_recording(self):
            return True

        def is_recording(self):
            return False

        def _has_async_recording_error(self):
            return False

        def _consume_desktop_helper_failure(self):
            return None

        def stop_recording(self):
            return None

        def _resolve_recoverable_output_path(self):
            return str(tmp_path / "meeting.opus")

    monkeypatch.setattr(macos, "MacOSAudioRecorder", FakeRecorder)
    monkeypatch.setattr(macos.time, "sleep", lambda _: None)
    monkeypatch.setattr(sys, "exit", lambda code=0: (_ for _ in ()).throw(RecorderExit(code)))

    with pytest.raises(RecorderExit) as exit_info:
        macos.main()
    assert exit_info.value.args == (0,)
    assert queried == [True]


def test_macos_cli_desktop_only_skips_microphone_enumeration(monkeypatch, tmp_path) -> None:
    """The real CLI must not touch microphone APIs for desktop-only capture."""
    macos = importlib.import_module("backend.audio.macos_recorder")

    monkeypatch.setattr(macos, "SWIFT_CAPTURE_AVAILABLE", True)
    monkeypatch.setattr(macos, "SCREENCAPTURE_AVAILABLE", False)
    monkeypatch.setattr(
        macos.sd,
        "query_devices",
        lambda: (_ for _ in ()).throw(AssertionError("desktop-only must not enumerate microphones")),
    )
    monkeypatch.setattr(sys, "argv", [
        "macos_recorder.py", "--mic", "0", "--loopback", "-1",
        "--capture-mode", "desktop-only", "--output", str(tmp_path / "meeting.opus"),
    ])

    class RecorderExit(Exception):
        pass

    class FakeRecorder:
        recording_failure = None
        recording_duration = 1
        desktop_diagnostics = {}

        def __init__(self, **kwargs):
            assert kwargs["capture_mode"] == "desktop-only"

        def start_recording(self):
            return True

        def is_recording(self):
            return False

        def _has_async_recording_error(self):
            return False

        def _consume_desktop_helper_failure(self):
            return None

        def stop_recording(self):
            return None

        def _resolve_recoverable_output_path(self):
            return str(tmp_path / "meeting.opus")

    monkeypatch.setattr(macos, "MacOSAudioRecorder", FakeRecorder)
    monkeypatch.setattr(macos.time, "sleep", lambda _: None)
    monkeypatch.setattr(sys, "exit", lambda code=0: (_ for _ in ()).throw(RecorderExit(code)))

    with pytest.raises(RecorderExit) as exit_info:
        macos.main()
    assert exit_info.value.args == (0,)


def test_macos_cli_desktop_request_reports_missing_backend_with_structured_stdout(
    monkeypatch, tmp_path, capsys
) -> None:
    macos = importlib.import_module("backend.audio.macos_recorder")

    monkeypatch.setattr(macos, "SWIFT_CAPTURE_AVAILABLE", False)
    monkeypatch.setattr(macos, "SCREENCAPTURE_AVAILABLE", False)
    monkeypatch.setattr(sys, "argv", [
        "macos_recorder.py", "--mic", "0", "--loopback", "-1",
        "--capture-mode", "desktop-only", "--output", str(tmp_path / "meeting.opus"),
    ])

    with pytest.raises(SystemExit) as exit_info:
        macos.main()

    assert exit_info.value.code == 1
    assert '"code": "NO_DESKTOP_AUDIO_BACKEND"' in capsys.readouterr().out


def test_capture_manifest_persists_desktop_primary_track(tmp_path) -> None:
    coordinator = CaptureManifestCoordinator.create(
        tmp_path / "desktop-only.opus",
        started_at_ns=1,
        started_at_iso="2026-09-04T12:00:00.000Z",
    )
    coordinator.add_track("desktop", sample_rate=48_000, channels=2, dtype="<f4")

    coordinator.set_primary_track("desktop")

    assert coordinator.to_dict()["primaryTrack"] == "desktop"
    coordinator.close()


def test_capture_manifest_rejects_a_primary_track_without_its_track(tmp_path) -> None:
    coordinator = CaptureManifestCoordinator.create(
        tmp_path / "desktop-only.opus",
        started_at_ns=1,
        started_at_iso="2026-09-04T12:00:00.000Z",
    )
    try:
        with pytest.raises(CaptureManifestError, match="missing from capture tracks"):
            coordinator.set_primary_track("desktop")
        with pytest.raises(CaptureManifestError, match="Invalid primaryTrack"):
            coordinator.set_primary_track("system")
    finally:
        coordinator.close()


def test_validate_manifest_data_rejects_unknown_and_dangling_primary_tracks() -> None:
    base = {
        "schemaVersion": 1,
        "state": "recording",
        "outputStem": "meeting",
        "startedAtMonotonicNs": 1,
        "startedAtIso": "2026-09-04T12:00:00.000Z",
        "tracks": {
            "mic": {
                "sampleRate": 48000,
                "channels": 2,
                "dtype": "<f4",
                "committedFrames": 0,
                "segments": [],
            },
        },
    }

    # Sanity: the baseline manifest itself is valid, so the failures below are
    # attributable to primaryTrack and not to a malformed fixture.
    validate_manifest_data(dict(base))
    validate_manifest_data({**base, "primaryTrack": "mic"})

    with pytest.raises(CaptureManifestError, match="Invalid primaryTrack"):
        validate_manifest_data({**base, "primaryTrack": "system"})
    with pytest.raises(CaptureManifestError, match="missing from capture tracks"):
        validate_manifest_data({**base, "primaryTrack": "desktop"})


def test_finalizer_primary_track_defaults_legacy_manifests_to_mic() -> None:
    finalizer = importlib.import_module("backend.audio.streaming_post_processor")

    # A pre-2.9 manifest has no primaryTrack at all and must stay mic-primary,
    # including the two-track default with a secondary desktop mix.
    assert finalizer.resolve_primary_track({"tracks": {"mic": {}}}) == "mic"
    assert finalizer.resolve_primary_track(
        {"tracks": {"mic": {}, "desktop": {}}, "includeDesktop": True}
    ) == "mic"
    assert finalizer.resolve_primary_track(
        {"primaryTrack": "mic", "tracks": {"mic": {}, "desktop": {}}, "includeDesktop": True}
    ) == "mic"
    assert finalizer.resolve_primary_track(
        {"primaryTrack": "desktop", "tracks": {"desktop": {}}}
    ) == "desktop"


def test_finalizer_rejects_contradictory_desktop_primary_manifests() -> None:
    finalizer = importlib.import_module("backend.audio.streaming_post_processor")

    contradictions = [
        # Secondary-mix flag set on a one-track desktop-primary manifest.
        {"primaryTrack": "desktop", "tracks": {"desktop": {}}, "includeDesktop": True},
        # A microphone track must never coexist with a desktop-primary manifest.
        {"primaryTrack": "desktop", "tracks": {"desktop": {}, "mic": {}}},
    ]
    for data in contradictions:
        with pytest.raises(finalizer.FinalizationError, match="desktop-primary"):
            finalizer.resolve_primary_track(data)

    # Dangling / unknown primary tracks are rejected too.
    with pytest.raises(finalizer.FinalizationError, match="invalid primaryTrack"):
        finalizer.resolve_primary_track({"primaryTrack": "desktop", "tracks": {"mic": {}}})
    with pytest.raises(finalizer.FinalizationError, match="invalid primaryTrack"):
        finalizer.resolve_primary_track({"primaryTrack": "system", "tracks": {"mic": {}}})
    with pytest.raises(finalizer.FinalizationError, match="invalid tracks"):
        finalizer.resolve_primary_track({"tracks": None})


def test_expected_duration_uses_desktop_timeline_for_desktop_primary() -> None:
    finalizer = importlib.import_module("backend.audio.streaming_post_processor")
    assert finalizer.expected_output_duration_seconds({
        "primaryTrack": "desktop",
        "tracks": {"desktop": {"committedFrames": 96_000, "sampleRate": 48_000}},
        "processingProfile": "macos-v1",
    }) == 2.0

    # A contradictory manifest must not yield a duration a recovery pass could
    # match against a stale final file.
    assert finalizer.expected_output_duration_seconds({
        "primaryTrack": "desktop",
        "includeDesktop": True,
        "tracks": {"desktop": {"committedFrames": 96_000, "sampleRate": 48_000}},
    }) is None


def test_expected_duration_still_follows_the_mic_timeline_by_default() -> None:
    finalizer = importlib.import_module("backend.audio.streaming_post_processor")

    # Default two-track: duration is bounded by the microphone timeline even
    # when the desktop track is longer.
    assert finalizer.expected_output_duration_seconds({
        "primaryTrack": "mic",
        "includeDesktop": True,
        "tracks": {
            "mic": {"committedFrames": 48_000, "sampleRate": 48_000},
            "desktop": {"committedFrames": 96_000, "sampleRate": 48_000},
        },
        "processingProfile": "windows-v1",
    }) == 1.0


def test_one_sided_repair_is_keyed_on_the_profile_not_the_primary_track() -> None:
    """Desktop-primary must keep the channel-balance repair.

    macOS CoreAudio taps (and Pulse monitors) can land all energy on one
    channel; without the repair the transcription mono downmix loses the
    speech. The repair is not mic enhancement and must not be gated on
    mic-primary.
    """
    finalizer = importlib.import_module("backend.audio.streaming_post_processor")

    one_sided = np.zeros((4_800, 2), dtype=np.float32)
    one_sided[:, 0] = 0.5  # everything on the left channel

    stats = finalizer._TrackStats()
    finalizer._accumulate_stereo_stats(stats, one_sided)
    decision = finalizer._decide_one_sided(stats)

    assert decision.repair is True, "a fully one-sided track must be repairable"
    for profile in ("macos-v1", "linux-v1"):
        assert finalizer._profile_uses_one_sided(profile) is True
    assert finalizer._profile_uses_one_sided("windows-v1") is False
