"""Characterization tests for recorder stdout event contracts (Phase 0.4).

Asserts emitter-side final-result key spellings and structured stdout helpers
without launching hardware-dependent recording loops. Shared emitters live in
``backend/audio/recorder_stdout.py``; platform recorders keep thin ``_send_*``
wrappers so call sites and Electron contracts stay stable.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from audio import recorder_stdout  # noqa: E402

WINDOWS_RECORDER = ROOT / "backend" / "audio" / "windows_recorder.py"
MACOS_RECORDER = ROOT / "backend" / "audio" / "macos_recorder.py"
RECORDER_STDOUT = ROOT / "backend" / "audio" / "recorder_stdout.py"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_shared_recorder_stdout_module_exists():
    assert RECORDER_STDOUT.is_file()
    source = _read(RECORDER_STDOUT)
    for name in (
        "send_json_message",
        "send_event_message",
        "send_warning_message",
        "send_error_message",
    ):
        assert f"def {name}" in source, f"recorder_stdout.py missing {name}"


def test_windows_and_macos_emitters_define_required_message_helpers():
    for path in (WINDOWS_RECORDER, MACOS_RECORDER):
        source = _read(path)
        assert "from . import recorder_stdout" in source or "import recorder_stdout" in source
        for name in (
            "_send_json_message",
            "_send_event_message",
            "_send_warning_message",
            "_send_error_message",
        ):
            assert f"def {name}" in source, f"{path.name} missing {name}"
            assert f"_recorder_stdout." in source or "recorder_stdout." in source


def test_windows_final_result_uses_audio_path_key():
    source = _read(WINDOWS_RECORDER)
    assert '"audioPath"' in source or "'audioPath'" in source
    # Final payload construction must not use the macOS spelling.
    assert "recording_info" in source
    recording_info_block = source.split("recording_info", 1)[1][:400]
    assert "audioPath" in recording_info_block
    assert "outputPath" not in recording_info_block


def test_macos_final_result_uses_output_path_key():
    source = _read(MACOS_RECORDER)
    assert '"outputPath"' in source or "'outputPath'" in source
    success_block_marker = "'outputPath': recorder.final_output_path"
    alt_marker = '"outputPath": recorder.final_output_path'
    assert success_block_marker in source or alt_marker in source


def test_structured_message_helpers_emit_expected_stdout_shapes(capsys):
    recorder_stdout.send_event_message("recording_started", "Recording started")
    recorder_stdout.send_warning_message("DESKTOP_AUDIO_DEGRADED", "Desktop audio weak")
    recorder_stdout.send_error_message("RECORDER_FAILED", "Recorder failed")
    recorder_stdout.send_json_message({"type": "levels", "mic": 0.1, "desktop": 0.2})

    captured = capsys.readouterr()
    stdout_lines = [line for line in captured.out.splitlines() if line.strip()]
    assert len(stdout_lines) == 4

    event_msg, warning_msg, error_msg, levels_msg = [json.loads(line) for line in stdout_lines]
    assert event_msg == {
        "type": "event",
        "event": "recording_started",
        "message": "Recording started",
    }
    assert warning_msg == {
        "type": "warning",
        "code": "DESKTOP_AUDIO_DEGRADED",
        "message": "Desktop audio weak",
    }
    assert error_msg == {
        "type": "error",
        "code": "RECORDER_FAILED",
        "message": "Recorder failed",
    }
    assert levels_msg == {"type": "levels", "mic": 0.1, "desktop": 0.2}
    # Helpers must not write control JSON to stderr.
    assert captured.err == ""


def test_macos_structured_message_helpers_match_windows_shapes(capsys):
    recorder_stdout.send_event_message("configuring_devices", "Configuring audio devices...")
    captured = capsys.readouterr()
    payload = json.loads(captured.out.strip())
    assert payload["type"] == "event"
    assert payload["event"] == "configuring_devices"
    assert captured.err == ""


def test_bound_recorder_wrappers_preserve_shapes(capsys):
    wrappers = recorder_stdout.bind_recorder_stdout_emitters()
    wrappers["_send_event_message"]("recording_started", "Recording started")
    wrappers["_send_warning_message"]("DESKTOP_AUDIO_DEGRADED", "Desktop audio weak")
    wrappers["_send_error_message"]("RECORDER_FAILED", "Recorder failed")
    wrappers["_send_json_message"]({"type": "levels", "mic": 0.1, "desktop": 0.2})

    captured = capsys.readouterr()
    stdout_lines = [line for line in captured.out.splitlines() if line.strip()]
    assert len(stdout_lines) == 4
    event_msg, warning_msg, error_msg, levels_msg = [json.loads(line) for line in stdout_lines]
    assert event_msg["type"] == "event"
    assert warning_msg["type"] == "warning"
    assert error_msg["type"] == "error"
    assert levels_msg["type"] == "levels"
    assert captured.err == ""


def test_stderr_debug_prints_are_not_structured_control_messages():
    shared = _read(RECORDER_STDOUT)
    send_json = shared.split("def send_json_message", 1)[1].split("def ", 1)[0]
    assert "sys.stderr" not in send_json

    for path in (WINDOWS_RECORDER, MACOS_RECORDER):
        source = _read(path)
        assert "file=sys.stderr" in source
        # Thin wrappers must not print control JSON to stderr themselves.
        send_json_wrapper = source.split("def _send_json_message", 1)[1].split("def ", 1)[0]
        assert "sys.stderr" not in send_json_wrapper
        assert "print(" not in send_json_wrapper or "_recorder_stdout" in send_json_wrapper
