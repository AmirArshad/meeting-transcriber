#!/usr/bin/env python3
"""Local-only v2.10 recording-finalization and Opus qualification harness.

The parent process schedules isolated worker processes.  Every worker receives
an explicit fixture and packaged/runtime binary path; it never downloads or
installs anything.  Reports intentionally exclude user paths, meeting text and
machine identifiers.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import json
import os
import platform
import re
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import wave
from collections import defaultdict
from pathlib import Path
from statistics import median
from typing import Any, Callable, Iterable


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.audio.compressor import compress_to_opus, get_file_info, verify_recording_integrity
from backend.audio.capture_manifest import CaptureManifestCoordinator, MANIFEST_FILENAME
from backend.audio.streaming_post_processor import finalize_capture


REPORT_VERSION = 1
UNAVAILABLE = "unavailable"
REDACTED_KEYS = {"fixture_path", "serial_number", "hardware_uuid", "meeting_title", "transcript", "prompt", "user_name"}


def redact_metadata(value: Any) -> Any:
    """Keep reproducibility metadata while removing paths and user content."""
    if isinstance(value, dict):
        return {key: ("redacted" if key in REDACTED_KEYS else redact_metadata(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_metadata(item) for item in value]
    return value


def validate_trial(trial: dict[str, Any]) -> None:
    measurements = trial.get("measurements_ms", {})
    for name, value in measurements.items():
        if not name.endswith("_ms") and name not in {"encode", "end_to_end"}:
            raise ValueError(f"measurement {name!r} must use a _ms name")
        if value is not None and (not isinstance(value, (int, float)) or value < 0):
            raise ValueError(f"measurement {name!r} must be a non-negative millisecond value or null")


def _measurement_summary(values: list[float | None]) -> dict[str, float | list[float]] | str:
    available = [float(value) for value in values if value is not None]
    if not available:
        return UNAVAILABLE
    return {"median": median(available), "range": [min(available), max(available)]}


def build_report(metadata: dict[str, Any], trials: list[dict[str, Any]]) -> dict[str, Any]:
    """Build stable v1 JSON; failed/cancelled trials remain raw-only evidence."""
    for trial in trials:
        validate_trial(trial)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for trial in trials:
        grouped[json.dumps({"fixture_id": trial["fixture_id"], "configuration": trial["configuration"]}, sort_keys=True)].append(trial)
    summaries = []
    for key, group in sorted(grouped.items()):
        successful = [trial for trial in group if trial.get("outcome") == "success"]
        all_keys = sorted({name for trial in successful for name in trial.get("measurements_ms", {})})
        descriptor = json.loads(key)
        summaries.append({
            **descriptor,
            "successful_trials": len(successful),
            "excluded_trials": len(group) - len(successful),
            "measurements_ms": {
                name: _measurement_summary([trial.get("measurements_ms", {}).get(name) for trial in successful])
                for name in all_keys
            },
        })
    return {"report_version": REPORT_VERSION, "units": {"timings": "ms", "duration": "ms", "memory": "bytes"}, "metadata": redact_metadata(metadata), "trials": trials, "summaries": summaries}


def measure_lazy_segments(factory: Callable[[], Iterable[Any]], *, clock: Callable[[], float] = time.perf_counter) -> tuple[float, list[Any]]:
    """Time until all lazily-produced decoder segments have actually been read."""
    started = clock()
    values = list(factory())
    return (clock() - started) * 1000.0, values


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def executable_version(path: str) -> str | None:
    try:
        result = subprocess.run([path, "-version"], capture_output=True, text=True, timeout=15, check=False)
    except OSError:
        return None
    return result.stdout.splitlines()[0] if result.returncode == 0 and result.stdout else None


def app_revision() -> str | None:
    try:
        result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=15, check=False)
    except OSError:
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def ffmpeg_to_wav(ffmpeg: str, source: Path, destination: Path) -> None:
    subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(source), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(destination)], check=True, capture_output=True)


def wav_metadata(path: Path) -> dict[str, float | int]:
    with wave.open(str(path), "rb") as reader:
        return {"duration_ms": reader.getnframes() * 1000.0 / reader.getframerate(), "channels": reader.getnchannels(), "sample_rate": reader.getframerate()}


def output_is_valid(source: dict[str, float | int], decoded: dict[str, float | int]) -> bool:
    """Enforce the recording contract for a decoded qualification output."""
    return (
        decoded["sample_rate"] == 48_000
        and decoded["channels"] == 2
        and abs(decoded["duration_ms"] - source["duration_ms"]) <= 25.0
    )


def finalization_measurements(elapsed_ms: float) -> dict[str, float]:
    """Name finalizer timing fields consistently with the report's units."""
    return {
        "recording_finalization_ms": elapsed_ms,
        "stop_to_ready_backend_ms": elapsed_ms,
        "end_to_end": elapsed_ms,
    }


def peak_rss_bytes() -> int | None:
    try:
        # macOS reports ru_maxrss in bytes; Linux reports KiB. The harness labels
        # this explicitly and normalizes Linux only, retaining unavailable on error.
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value if sys.platform == "darwin" else value * 1024)
    except (AttributeError, OSError):
        return None


def monotonic_ms() -> float:
    """Return the monotonic clock in report units."""
    return time.perf_counter() * 1000.0


def mlx_transcriber_class() -> Any:
    """Import the production MLX transcriber only inside a fresh MLX worker."""
    return importlib.import_module("backend.transcription.mlx_whisper_transcriber").MLXWhisperTranscriber


def _normalized_words(value: str) -> list[str]:
    return re.findall(r"[\w']+", value.casefold())


def _word_error_rate(reference: list[str], actual: list[str]) -> float | None:
    if not reference:
        return None
    prior = list(range(len(actual) + 1))
    for index, expected in enumerate(reference, start=1):
        current = [index]
        for actual_index, observed in enumerate(actual, start=1):
            current.append(min(
                prior[actual_index] + 1,
                current[actual_index - 1] + 1,
                prior[actual_index - 1] + (expected != observed),
            ))
        prior = current
    return prior[-1] / len(reference)


def _reference_section_status(reference: list[str], actual: list[str], section: str) -> str:
    if not reference:
        return UNAVAILABLE
    span = max(1, len(reference) // 8)
    if section == "beginning":
        expected = reference[:span]
    elif section == "end":
        expected = reference[-span:]
    else:
        midpoint = len(reference) // 2
        expected = reference[max(0, midpoint - span // 2): midpoint + (span + 1) // 2]
    expected_text = " ".join(expected)
    return "present" if expected_text in " ".join(actual) else "missing"


def transcript_validation(results: dict[str, Any], reference_text: str | None, expected_names: list[str], expected_numbers: list[str]) -> dict[str, Any]:
    """Return content-only parity evidence without retaining transcript text."""
    actual = _normalized_words(str(results.get("text", "")))
    reference = _normalized_words(reference_text or "")
    segments = results.get("segments") or []
    timestamp_status = "present" if segments and all(
        isinstance(segment, dict)
        and isinstance(segment.get("start"), (int, float))
        and isinstance(segment.get("end"), (int, float))
        and float(segment["end"]) >= float(segment["start"])
        for segment in segments
    ) else "missing"
    return {
        "reference": "available" if reference else UNAVAILABLE,
        "wer": _word_error_rate(reference, actual),
        "beginning": _reference_section_status(reference, actual, "beginning") if reference else ("present" if actual else "missing"),
        "middle": _reference_section_status(reference, actual, "middle") if reference else ("present" if actual else "missing"),
        "end": _reference_section_status(reference, actual, "end") if reference else ("present" if actual else "missing"),
        "timestamps": timestamp_status,
        "names": "present" if expected_names and all(name.casefold() in actual for name in expected_names) else (UNAVAILABLE if not expected_names else "missing"),
        "numbers": "present" if expected_numbers and all(number.casefold() in actual for number in expected_numbers) else (UNAVAILABLE if not expected_numbers else "missing"),
    }


def mlx_trial(
    fixture: Path,
    model: str,
    language: str,
    output_path: Path,
    reference_text: str | None = None,
    expected_names: list[str] | None = None,
    expected_numbers: list[str] | None = None,
) -> dict[str, Any]:
    """Run the production MLX calls and expose only directly observable stages.

    lightning-whisper-mlx loads its native model internally during
    ``transcribe_audio``. That component cannot be separated without changing
    the runtime, so it is deliberately recorded as unavailable.
    """
    expected_names = expected_names or []
    expected_numbers = expected_numbers or []
    # The production CLI starts with backend/ as its cwd; the benchmark is
    # intentionally launched from the repository root, so use the package path.
    from backend.common.process_priority import lower_process_priority
    lower_process_priority()
    before_rss = peak_rss_bytes()
    before_cpu = time.process_time()
    started = monotonic_ms()
    imported_at = monotonic_ms()
    transcriber_type = mlx_transcriber_class()
    imported_done = monotonic_ms()
    transcriber = transcriber_type(model_size=model, language=language)
    load_started = monotonic_ms()
    transcriber.load_model()
    load_done = monotonic_ms()
    decode_started = monotonic_ms()
    backend_result = transcriber._transcribe_audio(str(fixture))
    decode_done = monotonic_ms()
    duration = transcriber._probe_audio_duration(str(fixture))
    results = transcriber._build_results_from_backend_result(backend_result, str(fixture), duration)
    transcriber._save_markdown(results, str(fixture), str(output_path))
    transcriber.cleanup()
    completed = monotonic_ms()
    validation = transcript_validation(results, reference_text, expected_names, expected_numbers)
    return {
        "configuration": {"kind": "mlx-whisper", "process_mode": "fresh-process", "model": model, "language": language, "batch_size": transcriber.batch_size, "path": "standard"},
        "outcome": "success" if output_path.is_file() and validation["timestamps"] == "present" else "failed",
        "measurements_ms": {
            "python_import_ms": imported_done - imported_at,
            "production_load_model_ms": load_done - load_started,
            "decode_transcription_ms": decode_done - decode_started,
            "transcript_processing_persistence_ms": completed - decode_done,
            "worker_end_to_end_ms": completed - started,
            "process_startup_ms": None,
            "runtime_model_load_ms": None,
        },
        "resources": {"cpu_time_ms": (time.process_time() - before_cpu) * 1000.0, "peak_rss_bytes": peak_rss_bytes(), "baseline_rss_bytes": before_rss, "peak_vram_bytes": None},
        "output": {"bytes": output_path.stat().st_size if output_path.is_file() else None, "duration_ms": float(results.get("duration", 0) or 0) * 1000.0, "segments": len(results.get("segments") or []), "device": results.get("device", transcriber.device), "compute_type": results.get("computeType", transcriber.compute_type)},
        "runtime": {"backend": "lightning-whisper-mlx", "model_key": transcriber.model_key, "model_repo": transcriber.model_repo, "model_files": {name: sha256_file(transcriber.model_dir / name) for name in ("weights.npz", "config.json")}},
        "transcript_validation": validation,
    }


def encode_trial(fixture: Path, ffmpeg: str, effort: int, scratch: Path) -> dict[str, Any]:
    source_wav = scratch / "source.wav"
    ffmpeg_to_wav(ffmpeg, fixture, source_wav)
    source_info = wav_metadata(source_wav)
    output = scratch / "output.opus"
    before_cpu = time.process_time()
    before_rss = peak_rss_bytes()
    started = time.perf_counter()
    final_path = Path(compress_to_opus(str(source_wav), str(output), 48000, compression_level=effort, ffmpeg_path=ffmpeg))
    encode_ms = (time.perf_counter() - started) * 1000.0
    cpu_ms = (time.process_time() - before_cpu) * 1000.0
    decoded = scratch / "decoded.wav"
    decode_ok = verify_recording_integrity(str(final_path), ffmpeg_path=ffmpeg)
    decoded_info: dict[str, float | int] | None = None
    if decode_ok:
        ffmpeg_to_wav(ffmpeg, final_path, decoded)
        decoded_info = wav_metadata(decoded)
        decode_ok = output_is_valid(source_info, decoded_info)
    return {
        "measurements_ms": {"encode": encode_ms, "end_to_end": encode_ms},
        "resources": {"cpu_time_ms": cpu_ms, "peak_rss_bytes": peak_rss_bytes(), "baseline_rss_bytes": before_rss, "peak_vram_bytes": None},
        "output": {"bytes": final_path.stat().st_size, **(decoded_info or {"duration_ms": None, "channels": None, "sample_rate": None}), "decode_ok": decode_ok, "fallback_wav": final_path.suffix.lower() == ".wav"},
    }


def finalization_trial(fixture: Path, ffmpeg: str, scratch: Path) -> dict[str, Any]:
    """Measure the real macOS capture finalizer; setup conversion is excluded."""
    output = scratch / "meeting.opus"
    coordinator = CaptureManifestCoordinator.create(output, started_at_ns=1, started_at_iso="2026-09-14T00:00:00.000Z")
    try:
        coordinator.set_processing_profile("macos-v1")
        coordinator.set_mix_params()
        segment = coordinator.session_dir / "mic_0000.pcm.part"
        subprocess.run([ffmpeg, "-v", "error", "-i", str(fixture), "-f", "f32le", "-ar", "48000", "-ac", "2", "-y", str(segment)], check=True, capture_output=True)
        frames = segment.stat().st_size // (4 * 2)
        if frames <= 0:
            raise ValueError("fixture decoded to no 48 kHz stereo frames")
        coordinator.add_track("mic", sample_rate=48000, channels=2, dtype="<f4")
        coordinator.commit_track("mic", [segment.name], committed_frames=frames)
        coordinator.set_include_desktop(False)
        coordinator.set_state("finalizing")
        before_cpu = time.process_time()
        before_rss = peak_rss_bytes()
        started = time.perf_counter()
        result = finalize_capture(coordinator.session_dir / MANIFEST_FILENAME, output, ffmpeg_path=ffmpeg, coordinator=coordinator)
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        cpu_ms = (time.process_time() - before_cpu) * 1000.0
        final_path = Path(result.final_path)
        decoded = scratch / "finalization-decoded.wav"
        decode_ok = verify_recording_integrity(str(final_path), ffmpeg_path=ffmpeg)
        decoded_info: dict[str, float | int] | None = None
        if decode_ok:
            ffmpeg_to_wav(ffmpeg, final_path, decoded)
            decoded_info = wav_metadata(decoded)
            decode_ok = output_is_valid(
                {"duration_ms": result.duration * 1000.0, "channels": 2, "sample_rate": 48_000},
                decoded_info,
            )
        return {"measurements_ms": finalization_measurements(elapsed_ms), "resources": {"cpu_time_ms": cpu_ms, "peak_rss_bytes": peak_rss_bytes(), "baseline_rss_bytes": before_rss, "peak_vram_bytes": None}, "output": {"bytes": final_path.stat().st_size, **(decoded_info or {"duration_ms": None, "channels": None, "sample_rate": None}), "decode_ok": decode_ok, "fallback_wav": final_path.suffix.lower() == ".wav"}}
    finally:
        try:
            coordinator.close()
        except Exception:
            pass


def worker(args: argparse.Namespace) -> dict[str, Any]:
    _parsed_id, fixture = args.fixture[0]
    fixture = fixture.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="avanevis-inference-performance-", dir=args.scratch_dir) as temp:
        scratch = Path(temp)
        if args.kind == "finalization":
            result = finalization_trial(fixture, args.ffmpeg, scratch)
        elif args.kind == "encode":
            result = encode_trial(fixture, args.ffmpeg, args.effort, scratch)
        else:
            reference_text = args.reference_path.read_text(encoding="utf-8") if args.reference_path else None
            result = mlx_trial(fixture, args.model, args.language, scratch / "transcript.md", reference_text, args.expected_name, args.expected_number)
    configuration = {"kind": args.kind, "process_mode": "fresh-process"}
    if args.kind == "encode":
        configuration["effort"] = args.effort
    if args.kind == "mlx":
        return {"fixture_id": args.fixture_id, **result}
    return {"fixture_id": args.fixture_id, "configuration": configuration, "outcome": "success" if result["output"]["decode_ok"] else "failed", **result}


def run_worker(fixture_id: str, fixture: Path, ffmpeg: str, kind: str, effort: int | None, scratch_dir: Path) -> dict[str, Any]:
    command = [sys.executable, str(Path(__file__).resolve()), "--worker", "--fixture-id", fixture_id, "--fixture", f"{fixture_id}={fixture}", "--ffmpeg", ffmpeg, "--kind", kind, "--scratch-dir", str(scratch_dir)]
    if effort is not None:
        command.extend(["--effort", str(effort)])
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode:
        configuration = {"kind": kind, "process_mode": "fresh-process"}
        if effort is not None:
            configuration["effort"] = effort
        return {"fixture_id": fixture_id, "configuration": configuration, "outcome": "failed", "measurements_ms": {}, "resources": {}, "output": {}, "failure": "worker failed"}
    return json.loads(result.stdout)


def run_mlx_worker(fixture_id: str, fixture: Path, model: str, language: str, reference_path: Path | None, expected_names: list[str], expected_numbers: list[str], scratch_dir: Path) -> dict[str, Any]:
    command = [sys.executable, str(Path(__file__).resolve()), "--worker", "--fixture-id", fixture_id, "--fixture", f"{fixture_id}={fixture}", "--kind", "mlx", "--model", model, "--language", language, "--scratch-dir", str(scratch_dir)]
    if reference_path:
        command.extend(["--reference-path", str(reference_path)])
    for name in expected_names:
        command.extend(["--expected-name", name])
    for number in expected_numbers:
        command.extend(["--expected-number", number])
    started = monotonic_ms()
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    wall_ms = monotonic_ms() - started
    if result.returncode:
        return {"fixture_id": fixture_id, "configuration": {"kind": "mlx-whisper", "process_mode": "fresh-process", "model": model, "language": language, "batch_size": 1, "path": "standard"}, "outcome": "failed", "measurements_ms": {"fresh_process_wall_ms": wall_ms, "process_startup_ms": None, "runtime_model_load_ms": None}, "resources": {}, "output": {}, "failure": "worker failed"}
    trial = json.loads(result.stdout)
    trial["measurements_ms"]["fresh_process_wall_ms"] = wall_ms
    return trial


def parse_fixture(value: str) -> tuple[str, Path]:
    fixture_id, separator, raw_path = value.partition("=")
    if not separator or not fixture_id or not raw_path:
        raise argparse.ArgumentTypeError("fixtures must use ID=/absolute/or/relative/path.wav")
    if not fixture_id.replace("-", "").replace("_", "").isalnum():
        raise argparse.ArgumentTypeError("fixture IDs may contain only letters, numbers, hyphens, and underscores")
    return fixture_id, Path(raw_path).resolve()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", action="append", type=parse_fixture, help="Explicit ID=path input; repeat for each fixture")
    parser.add_argument("--ffmpeg", help="Explicit packaged ffmpeg path")
    parser.add_argument("--output-dir", type=Path, help="New or empty report directory outside recordings")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--efforts", default="10,5,6")
    parser.add_argument("--mlx", action="store_true", help="Run the Apple Silicon production-equivalent MLX Whisper path only")
    parser.add_argument("--model", default="small", help="Existing MLX model size (default: production small)")
    parser.add_argument("--language", default="en", help="Existing MLX language code (default: en)")
    parser.add_argument("--reference", type=Path, help="Explicit local plaintext reference transcript for WER-style validation")
    parser.add_argument("--expected-name", action="append", default=[], help="Expected local reference name; repeatable")
    parser.add_argument("--expected-number", action="append", default=[], help="Expected local reference number token; repeatable")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--kind", choices=("encode", "finalization", "mlx"), default="encode", help=argparse.SUPPRESS)
    parser.add_argument("--fixture-id", help=argparse.SUPPRESS)
    parser.add_argument("--effort", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--scratch-dir", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--reference-path", type=Path, help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.worker:
        print(json.dumps(worker(args), sort_keys=True))
        return 0
    if not args.fixture or not args.output_dir or (not args.mlx and not args.ffmpeg):
        raise SystemExit("--fixture, --output-dir, and --ffmpeg (unless --mlx) are required; the harness never discovers or downloads inputs")
    if args.trials < 3:
        raise SystemExit("--trials must be at least 3 for qualification")
    if args.ffmpeg and not Path(args.ffmpeg).is_file():
        raise SystemExit("--ffmpeg must be an explicit existing runtime path")
    if args.reference and not args.reference.is_file():
        raise SystemExit("--reference must be an explicit existing local plaintext file")
    efforts = [int(item) for item in args.efforts.split(",")]
    if any(effort < 0 or effort > 10 for effort in efforts):
        raise SystemExit("Opus efforts must be between 0 and 10")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    trials = []
    for fixture_id, fixture in args.fixture:
        if not fixture.is_file():
            raise SystemExit(f"fixture {fixture_id!r} is unavailable: {fixture}")
        for trial_index in range(args.trials):
            if args.mlx:
                trials.append(run_mlx_worker(fixture_id, fixture, args.model, args.language, args.reference, args.expected_name, args.expected_number, args.output_dir))
            else:
                trials.append(run_worker(fixture_id, fixture, args.ffmpeg, "finalization", None, args.output_dir))
                rotated = efforts[trial_index % len(efforts):] + efforts[:trial_index % len(efforts)]
                for effort in rotated:
                    trials.append(run_worker(fixture_id, fixture, args.ffmpeg, "encode", effort, args.output_dir))
    mlx_version = None
    if args.mlx:
        try:
            mlx_version = importlib.metadata.version("lightning-whisper-mlx")
        except importlib.metadata.PackageNotFoundError:
            mlx_version = UNAVAILABLE
    metadata = {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version(), "app_revision": app_revision(), "ffmpeg_version": executable_version(args.ffmpeg) if args.ffmpeg else UNAVAILABLE, "mlx_runtime_version": mlx_version, "fixture_identities": [{"id": fixture_id, "sha256": sha256_file(fixture)} for fixture_id, fixture in args.fixture], "reference_identity": {"sha256": sha256_file(args.reference)} if args.reference else UNAVAILABLE, "process_modes": ["fresh-process"], "filesystem_cache": "state not controlled", "model_resident": False, "power_mode": UNAVAILABLE, "unavailable_measurements": ["queue_wait_ms", "admission_ms", "process_startup_ms", "runtime_model_load_ms", "peak_vram_bytes"]}
    report = build_report(metadata, trials)
    (args.output_dir / "inference-performance-report-v1.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
