"""Regression coverage for the local-only inference performance harness."""

from __future__ import annotations

import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "scripts" / "benchmarks" / "inference_performance.py"
SPEC = importlib.util.spec_from_file_location("inference_performance", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


def _successful_trial(**overrides):
    trial = {
        "fixture_id": "speech-en",
        "configuration": {"kind": "encode", "effort": 10},
        "outcome": "success",
        "measurements_ms": {"encode": 12.0, "end_to_end": 16.0},
        "resources": {"cpu_time_ms": 7.0, "peak_rss_bytes": 1024},
        "output": {"bytes": 128, "duration_ms": 1000.0, "channels": 2, "decode_ok": True},
    }
    trial.update(overrides)
    return trial


def test_build_report_formats_versioned_milliseconds_and_median_range():
    report = benchmark.build_report(
        {"hardware": "Apple M4 Pro", "fixture_identities": [{"id": "speech-en", "sha256": "abc"}]},
        [_successful_trial(measurements_ms={"encode": 10.0, "end_to_end": 20.0}),
         _successful_trial(measurements_ms={"encode": 20.0, "end_to_end": 30.0}),
         _successful_trial(measurements_ms={"encode": 30.0, "end_to_end": 40.0})],
    )

    assert report["report_version"] == 1
    summary = report["summaries"][0]
    assert summary["successful_trials"] == 3
    assert summary["measurements_ms"]["encode"] == {"median": 20.0, "range": [10.0, 30.0]}
    assert "seconds" not in str(report)


def test_missing_measurements_remain_unavailable_not_zero():
    report = benchmark.build_report({}, [_successful_trial(measurements_ms={"encode": None})])

    assert report["summaries"][0]["measurements_ms"]["encode"] == "unavailable"


def test_failed_and_cancelled_trials_are_excluded_from_success_summary():
    report = benchmark.build_report(
        {},
        [_successful_trial(), _successful_trial(outcome="failed"), _successful_trial(outcome="cancelled")],
    )

    summary = report["summaries"][0]
    assert summary["successful_trials"] == 1
    assert summary["excluded_trials"] == 2


def test_validate_trial_rejects_non_millisecond_timing_keys_and_negative_values():
    trial = _successful_trial(measurements_ms={"encode_seconds": 1.0})

    try:
        benchmark.validate_trial(trial)
    except ValueError as exc:
        assert "_ms" in str(exc)
    else:
        raise AssertionError("expected unit validation to reject seconds")


def test_measure_lazy_segments_consumes_generator_before_stopping_clock():
    clock = iter((10.0, 13.5))
    consumed = []

    elapsed, values = benchmark.measure_lazy_segments(
        lambda: iter((consumed.append("first") or "a", consumed.append("second") or "b")),
        clock=lambda: next(clock),
    )

    assert values == ["a", "b"]
    assert consumed == ["first", "second"]
    assert elapsed == 3500.0


def test_redaction_removes_paths_machine_identifiers_and_free_text():
    redacted = benchmark.redact_metadata({
        "fixture_path": "/Users/alice/Meetings/customer.wav",
        "serial_number": "C02SECRETSERIAL",
        "hardware_uuid": "abc-123",
        "meeting_title": "Acme acquisition discussion",
        "runtime_version": "ffmpeg 8.0.1",
    })

    assert redacted["fixture_path"] == "redacted"
    assert redacted["serial_number"] == "redacted"
    assert redacted["hardware_uuid"] == "redacted"
    assert redacted["meeting_title"] == "redacted"
    assert redacted["runtime_version"] == "ffmpeg 8.0.1"


def test_output_validation_requires_48khz_stereo_and_duration_tolerance():
    source = {"duration_ms": 1_000.0, "channels": 2, "sample_rate": 48_000}

    assert benchmark.output_is_valid(source, {"duration_ms": 1_020.0, "channels": 2, "sample_rate": 48_000})
    assert not benchmark.output_is_valid(source, {"duration_ms": 1_020.0, "channels": 2, "sample_rate": 44_100})


def test_finalization_measurements_obey_the_report_millisecond_schema():
    trial = _successful_trial(
        configuration={"kind": "finalization", "process_mode": "fresh-process"},
        measurements_ms=benchmark.finalization_measurements(42.0),
    )

    benchmark.validate_trial(trial)
    assert trial["measurements_ms"]["recording_finalization_ms"] == 42.0
