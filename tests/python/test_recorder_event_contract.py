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
    # Success and recoverable-failure payloads both use the macOS spelling.
    assert "result['outputPath'] = recovered_path" in source or 'result["outputPath"] = recovered_path' in source
    assert "'outputPath': recovered_path or args.output" in source


def test_windows_emits_result_json_before_cleanup():
    """Stop recovery requires success JSON before pa.terminate()-prone cleanup."""
    source = _read(WINDOWS_RECORDER)
    # Use the main() finally block (last occurrence), not an earlier stream finally.
    finally_block = source.rsplit("finally:", 1)[1]
    json_pos = finally_block.find("_send_json_message(recording_info)")
    cleanup_pos = finally_block.find("recorder.cleanup()")
    assert json_pos != -1, "finally must emit recording_info JSON"
    assert cleanup_pos != -1, "finally must still call cleanup"
    assert json_pos < cleanup_pos, "success JSON must be emitted before cleanup"


def test_windows_sets_final_path_before_temp_unlink():
    """Final path / recoverable is set before segment/temp unlink (spool finalize)."""
    source = _read(ROOT / "backend" / "audio" / "streaming_post_processor.py")
    # compress_and_report → recoverable = final_path → cleanup unlinks with except OSError
    compress_pos = source.find("final_path, compress_stats = compress_and_report(")
    assert compress_pos != -1
    after_compress = source[compress_pos:]
    recoverable_pos = after_compress.find("recoverable = final_path")
    unlink_pos = after_compress.find("path.unlink()")
    assert recoverable_pos != -1
    assert unlink_pos != -1
    assert recoverable_pos < unlink_pos
    assert "except OSError" in after_compress[unlink_pos - 80 : unlink_pos + 120]


def test_macos_stop_path_guards_processing_exceptions():
    source = _read(MACOS_RECORDER)
    stop = source.split("def stop_recording", 1)[1].split(
        "def _resolve_desktop_capture_start_time", 1
    )[0]
    assert "except Exception as process_err" in stop
    assert "RECORDER_FAILED" in stop
    assert "_resolve_recoverable_output_path" in stop
    assert "_finalize_from_capture_spools" in stop


def test_macos_late_desktop_failure_does_not_hard_fail_stop():
    source = _read(MACOS_RECORDER)
    assert "def _note_desktop_runtime_failure" in source
    resolve = source.split("def _resolve_async_recording_failure", 1)[1].split(
        "def _finalize_recording_failure", 1
    )[0]
    assert "DESKTOP_AUDIO_FAILED" not in resolve
    assert "_consume_desktop_helper_failure" in resolve
    desktop_except = source.split("ERROR in desktop recording", 1)[1].split(
        "def _note_desktop_runtime_failure", 1
    )[0]
    assert "_note_desktop_runtime_failure" in desktop_except
    assert "_error_event.set()" not in desktop_except


def test_macos_recoverable_path_promotes_temp_not_returns_pcm_tmp():
    source = _read(MACOS_RECORDER)
    resolve = source.split("def _resolve_recoverable_output_path", 1)[1].split(
        "def stop_recording", 1
    )[0]
    assert "promote_recorder_temp_to_wav" in resolve
    assert "build_stable_wav_path_for_output" in resolve
    assert "endswith('.pcm.tmp')" in resolve or 'endswith(".pcm.tmp")' in resolve
    # Volatile temp must be promoted, never returned raw.
    assert "promote_recorder_temp_to_wav(temp_path" in resolve


def test_macos_generic_except_does_not_toast_before_best_effort_stop():
    source = _read(MACOS_RECORDER)
    # Use the recording-loop except (last in main), not the startup except.
    main_src = source.split("def main(", 1)[1]
    except_block = main_src.rsplit("except Exception as e:", 1)[1].split("emit_final_result()", 1)[0]
    # Error toast must come after best-effort stop, and only when recovery failed.
    stop_pos = except_block.find("recorder.stop_recording()")
    toast_pos = except_block.find('_send_error_message("RECORDER_FAILED"')
    assert stop_pos != -1
    assert toast_pos != -1
    assert stop_pos < toast_pos
    assert "Recovered recording after error" in except_block
    assert "no error toast" in except_block


def test_recorders_use_non_scanned_temp_pcm_extension():
    # Active finalize path uses non-scanned .pcm.tmp under the capture session.
    spp = _read(ROOT / "backend" / "audio" / "streaming_post_processor.py")
    assert "FINAL_CAPTURE_PCM_NAME" in spp
    assert ".pcm.tmp" in spp or "pcm.tmp" in spp
    # macOS recovery still promotes orphan recorder temps via the shared helper.
    macos = _read(MACOS_RECORDER)
    assert "build_recorder_temp_pcm_path" in macos
    for path in (WINDOWS_RECORDER, MACOS_RECORDER):
        source = _read(path)
        # Active write path must not use scannable .temp.wav / _temp.wav.
        assert "with_suffix('.temp.wav')" not in source
        assert "'_temp.wav'" not in source
        assert '"_temp.wav"' not in source


def test_recorders_emit_structured_stop_stage_events():
    required_stages = (
        "post_processing_started",
        "audio_normalizing",
        "audio_mixing",
        "audio_encoding",
        "post_processing_complete",
    )
    # Bounded finalization owns the stage sequence; recorders forward via progress_callback.
    spp = _read(ROOT / "backend" / "audio" / "streaming_post_processor.py")
    positions = []
    for stage in required_stages:
        token = f'"{stage}"'
        pos = spp.find(token)
        assert pos != -1, f"streaming_post_processor missing stop stage {stage}"
        positions.append(pos)
    assert positions == sorted(positions), (
        "streaming_post_processor stop stages must appear in processing order"
    )
    for path in (WINDOWS_RECORDER, MACOS_RECORDER):
        source = _read(path)
        assert "finalize_capture" in source
        assert "progress_callback" in source


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


def test_recorder_stdin_uses_exact_token_matching():
    from audio.recorder_stdin import parse_recorder_stdin_command

    assert parse_recorder_stdin_command("stop\n") == "stop"
    assert parse_recorder_stdin_command("  CANCEL  ") == "cancel"
    assert parse_recorder_stdin_command("stopgap") is None
    assert parse_recorder_stdin_command("please stop") is None
    assert parse_recorder_stdin_command("cancelation") is None

    for path in (WINDOWS_RECORDER, MACOS_RECORDER):
        source = _read(path)
        assert "parse_recorder_stdin_command" in source
        assert '"stop" in line' not in source
        assert "cancel_recording" in source
        assert '"cancelled": True' in source or "'cancelled': True" in source
        assert "mark_capture_discarded_and_cleanup" in source
