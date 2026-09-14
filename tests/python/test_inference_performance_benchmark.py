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


def test_mlx_trial_reports_observable_stages_and_marks_hidden_runtime_load_unavailable(monkeypatch, tmp_path):
    """Catches a benchmark regression that folds hidden MLX loading into a made-up field."""
    fixture = tmp_path / "fixture.wav"
    fixture.write_bytes(b"local-fixture")
    output = tmp_path / "transcript.md"
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    (model_dir / "weights.npz").write_bytes(b"weights")
    (model_dir / "config.json").write_text("{}", encoding="utf-8")

    class FakeTranscriber:
        def __init__(self, *, model_size, language):
            self.model_size = model_size
            self.language = language
            self.device = "metal"
            self.compute_type = "float16"
            self.batch_size = 1
            self.model_key = "small"
            self.model_repo = "mlx-community/whisper-small-mlx"
            self.model_dir = model_dir

        def load_model(self):
            return None

        def _transcribe_audio(self, audio_path):
            assert audio_path == str(fixture)
            return {"language": "en", "segments": [
                {"start": 0, "end": 1, "text": "beginning 42"},
                {"start": 1, "end": 2, "text": "middle Ada"},
                {"start": 2, "end": 3, "text": "ending 7"},
            ]}

        def _probe_audio_duration(self, audio_path):
            return 3.0

        def _build_results_from_backend_result(self, result, audio_path, duration):
            return {"text": "beginning 42 middle Ada ending 7", "segments": result["segments"], "language": "en", "duration": duration}

        def _save_markdown(self, results, audio_path, output_path):
            Path(output_path).write_text(results["text"], encoding="utf-8")

        def cleanup(self):
            return None

    ticks = iter(range(10))
    monkeypatch.setattr(benchmark, "monotonic_ms", lambda: float(next(ticks)))
    monkeypatch.setattr(benchmark, "peak_rss_bytes", lambda: 2048)
    monkeypatch.setattr(benchmark, "mlx_transcriber_class", lambda: FakeTranscriber)

    trial = benchmark.mlx_trial(fixture, "small", "en", output)

    assert trial["outcome"] == "success"
    assert trial["configuration"] == {"kind": "mlx-whisper", "process_mode": "fresh-process", "model": "small", "language": "en", "batch_size": 1, "path": "standard"}
    assert trial["measurements_ms"]["python_import_ms"] == 1.0
    assert trial["measurements_ms"]["production_load_model_ms"] == 1.0
    assert trial["measurements_ms"]["decode_transcription_ms"] == 1.0
    assert trial["measurements_ms"]["runtime_model_load_ms"] is None
    assert trial["transcript_validation"] == {"reference": "unavailable", "wer": None, "beginning": "present", "middle": "present", "end": "present", "timestamps": "present", "names": "unavailable", "numbers": "unavailable"}
