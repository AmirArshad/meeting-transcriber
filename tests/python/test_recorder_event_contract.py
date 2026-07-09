"""Characterization tests for recorder stdout event contracts (Phase 0.4).

Asserts emitter-side final-result key spellings and structured stdout helpers
without launching hardware-dependent recording loops.
"""

from __future__ import annotations

import ast
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WINDOWS_RECORDER = ROOT / "backend" / "audio" / "windows_recorder.py"
MACOS_RECORDER = ROOT / "backend" / "audio" / "macos_recorder.py"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _load_module_from_path(module_name: str, path: Path):
    """Load a recorder module by path without executing platform-only imports eagerly.

    We only need the message helper functions; importing the full recorder pulls
    in pyaudiowatch / sounddevice. Parse the AST and exec just the helper defs.
    """
    source = _read(path)
    tree = ast.parse(source, filename=str(path))
    keep_names = {
        "_send_json_message",
        "_send_event_message",
        "_send_warning_message",
        "_send_error_message",
    }
    body = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in keep_names:
            body.append(node)
        elif isinstance(node, ast.Assign):
            # Keep the stdout lock name binding if present (helpers close over it).
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "_stdout_lock":
                    body.append(node)

    if not body:
        raise AssertionError(f"Could not find recorder message helpers in {path}")

    module_ast = ast.Module(body=body, type_ignores=[])
    ast.fix_missing_locations(module_ast)
    code = compile(module_ast, str(path), "exec")

    # Provide a threading.Lock stand-in so _stdout_lock assignment works if present.
    import threading

    namespace = {
        "json": json,
        "sys": sys,
        "threading": threading,
        "print": print,
    }
    exec(code, namespace)  # noqa: S102 — intentional for characterization of helpers
    return namespace


def test_windows_and_macos_emitters_define_required_message_helpers():
    for path in (WINDOWS_RECORDER, MACOS_RECORDER):
        source = _read(path)
        for name in (
            "_send_json_message",
            "_send_event_message",
            "_send_warning_message",
            "_send_error_message",
        ):
            assert f"def {name}" in source, f"{path.name} missing {name}"


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
    helpers = _load_module_from_path("windows_recorder_helpers", WINDOWS_RECORDER)

    helpers["_send_event_message"]("recording_started", "Recording started")
    helpers["_send_warning_message"]("DESKTOP_AUDIO_DEGRADED", "Desktop audio weak")
    helpers["_send_error_message"]("RECORDER_FAILED", "Recorder failed")
    helpers["_send_json_message"]({"type": "levels", "mic": 0.1, "desktop": 0.2})

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
    helpers = _load_module_from_path("macos_recorder_helpers", MACOS_RECORDER)
    helpers["_send_event_message"]("configuring_devices", "Configuring audio devices...")
    captured = capsys.readouterr()
    payload = json.loads(captured.out.strip())
    assert payload["type"] == "event"
    assert payload["event"] == "configuring_devices"
    assert captured.err == ""


def test_stderr_debug_prints_are_not_structured_control_messages():
    for path in (WINDOWS_RECORDER, MACOS_RECORDER):
        source = _read(path)
        assert "file=sys.stderr" in source
        # Structured control helpers print via _send_json_message without stderr.
        send_json = source.split("def _send_json_message", 1)[1].split("def ", 1)[0]
        assert "sys.stderr" not in send_json
