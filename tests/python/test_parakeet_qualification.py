"""Focused regression tests for the developer-only Parakeet qualification harness."""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest

from scripts.benchmarks import parakeet_qualification as qualification


def test_reference_normalization_and_wer_are_engine_neutral():
    reference = qualification.normalize_words("We're testing, AvaNevis's CUDA path.")
    actual = qualification.normalize_words("we are testing avanevis's cuda path")

    assert reference == ["we're", "testing", "avanevis's", "cuda", "path"]
    assert qualification.word_error_rate(reference, actual) == pytest.approx(2 / 5)


def test_token_timestamps_are_offset_into_segment_intervals_and_bounds_checked():
    intervals, diagnostics = qualification.build_token_intervals(
        segment_start=10.0,
        segment_end=12.0,
        token_starts=[0.25, 0.75, 1.5],
        audio_duration=20.0,
    )

    assert intervals == [(10.25, 10.75), (10.75, 11.5), (11.5, 12.0)]
    assert diagnostics == {
        "invalid_timestamps": 0,
        "out_of_order_timestamps": 0,
        "out_of_bounds_intervals": 0,
    }


def test_malformed_and_out_of_order_timestamps_are_counted():
    intervals, diagnostics = qualification.build_token_intervals(
        segment_start=3.0,
        segment_end=4.0,
        token_starts=[0.4, 0.2, 3.0],
        audio_duration=4.0,
    )

    assert intervals == []
    assert diagnostics["out_of_order_timestamps"] == 1
    assert diagnostics["invalid_timestamps"] == 1
    assert diagnostics["out_of_bounds_intervals"] >= 1


def test_boundary_quality_does_not_claim_zero_when_reference_words_are_missing():
    missing = qualification._boundary_missing_words(
        [
            {"start": 0.0, "end": 1.0, "text": "alpha"},
            {"start": 1.0, "end": 2.0, "text": "gamma"},
        ],
        [
            {"start": 0.98, "text": "alpha"},
            {"start": 1.02, "text": "beta"},
            {"start": 1.08, "text": "gamma"},
        ],
    )

    assert missing == 1


def test_report_redaction_never_exposes_paths_or_raw_text():
    redacted = qualification.sanitize_report({
        "fixture_path": "/private/meeting.wav",
        "reference_text": "secret customer discussion",
        "stderr": "Traceback in /home/alice/private.py",
        "summary": {"wall_ms": [10.0, 20.0]},
    })

    serialized = json.dumps(redacted)
    assert "/private/meeting.wav" not in serialized
    assert "secret customer discussion" not in serialized
    assert "Traceback" not in serialized
    assert redacted["fixture_path"] == "redacted"
    assert redacted["reference_text"] == "redacted"
    assert redacted["stderr"] == "redacted"


def test_missing_gpu_telemetry_remains_unavailable():
    summary = qualification.summarize_trials([
        {
            "outcome": "success",
            "engine": "candidate",
            "wall_ms": 100.0,
            "audio_duration_s": 10.0,
            "resources": {"peak_rss_bytes": 1000, "peak_gpu_memory_bytes": None},
        },
    ], engine="candidate")

    assert summary["peak_gpu_memory_bytes"] == "unavailable"


@pytest.mark.skipif(not Path("/proc").is_dir(), reason="CachyOS process-tree telemetry requires /proc")
def test_timeout_terminates_descendant_process_group(tmp_path):
    worker = tmp_path / "hang.py"
    worker.write_text(
        "import subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "time.sleep(60)\n",
        encoding="utf-8",
    )
    result = qualification.run_worker_process(
        python_executable=sys.executable,
        worker_path=worker,
        worker_args=[],
        env=os.environ.copy(),
        timeout_seconds=0.2,
        output_log=tmp_path / "worker.log",
        sample_interval_ms=10,
        collect_gpu=False,
    )

    assert result["outcome"] == "timeout"
    assert result["failure"]["code"] == "worker_timeout"
    assert result["descendant_pids_at_termination"] >= 1
    time.sleep(0.1)
    assert not qualification.pid_exists(result["pid"])


def test_reference_loader_accepts_text_and_timestamped_json(tmp_path):
    text_path = tmp_path / "reference.txt"
    text_path.write_text("One two three", encoding="utf-8")
    json_path = tmp_path / "reference.json"
    json_path.write_text(json.dumps({
        "segments": [{"start": 0.0, "end": 1.0, "text": "One two"}, {"start": 1.0, "end": 2.0, "text": "three"}],
    }), encoding="utf-8")

    text_reference = qualification.load_reference(text_path)
    json_reference = qualification.load_reference(json_path)

    assert text_reference["text"] == "One two three"
    assert text_reference["words"] == ["one", "two", "three"]
    assert json_reference["text"] == "One two three"
    assert json_reference["timed_words"] == []


def test_preflight_reports_missing_reference_as_benchmark_input_failure(tmp_path):
    args = qualification.QualificationArgs(
        fixture=tmp_path / "missing.wav",
        reference=tmp_path / "missing.txt",
        baseline_python=Path(sys.executable),
        candidate_python=Path(sys.executable),
        baseline_model_dir=tmp_path / "baseline",
        candidate_model_dir=tmp_path / "candidate",
        candidate_vad_dir=tmp_path / "vad",
        baseline_library_dirs=[],
        candidate_library_dirs=[],
        baseline_driver_dirs=[],
        candidate_driver_dirs=[],
        output_dir=tmp_path / "output",
        trials=1,
        timeout_seconds=1.0,
        sample_interval_ms=10,
        ffmpeg="ffmpeg",
        fixture_source="public",
        fixture_license="CC BY 4.0",
        fixture_revision="rev",
        candidate_model_revision="rev",
        vad_revision="rev",
    )

    report = qualification.run_preflight(args, run_hardware=False)

    assert report["status"] == "failed"
    assert any(item["layer"] == "benchmark_input" for item in report["failures"])
