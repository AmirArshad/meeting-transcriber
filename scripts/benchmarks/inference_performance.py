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
import json
import os
import platform
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

try:
    import resource
except ImportError:
    resource = None


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


def peak_rss_bytes() -> int | None:
    if resource is None:
        return None
    try:
        # macOS reports ru_maxrss in bytes; Linux reports KiB. The harness labels
        # this explicitly and normalizes Linux only, retaining unavailable on error.
        value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(value if sys.platform == "darwin" else value * 1024)
    except (AttributeError, OSError):
        return None


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
        decode_ok = decoded_info["channels"] == source_info["channels"] and abs(decoded_info["duration_ms"] - source_info["duration_ms"]) <= 25.0
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
            decode_ok = decoded_info["channels"] == 2 and abs(decoded_info["duration_ms"] - result.duration * 1000.0) <= 25.0
        return {"measurements_ms": {"recording_finalization": elapsed_ms, "stop_to_ready_backend": elapsed_ms, "end_to_end": elapsed_ms}, "resources": {"cpu_time_ms": cpu_ms, "peak_rss_bytes": peak_rss_bytes(), "baseline_rss_bytes": before_rss, "peak_vram_bytes": None}, "output": {"bytes": final_path.stat().st_size, **(decoded_info or {"duration_ms": None, "channels": None, "sample_rate": None}), "decode_ok": decode_ok, "fallback_wav": final_path.suffix.lower() == ".wav"}}
    finally:
        try:
            coordinator.close()
        except Exception:
            pass


def worker(args: argparse.Namespace) -> dict[str, Any]:
    _parsed_id, fixture = args.fixture[0]
    fixture = fixture.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="avanevis-inference-performance-", dir=args.scratch_dir) as temp:
        result = finalization_trial(fixture, args.ffmpeg, Path(temp)) if args.kind == "finalization" else encode_trial(fixture, args.ffmpeg, args.effort, Path(temp))
    configuration = {"kind": args.kind, "process_mode": "fresh-process"}
    if args.kind == "encode":
        configuration["effort"] = args.effort
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
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--kind", choices=("encode", "finalization"), default="encode", help=argparse.SUPPRESS)
    parser.add_argument("--fixture-id", help=argparse.SUPPRESS)
    parser.add_argument("--effort", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--scratch-dir", type=Path, help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.worker:
        print(json.dumps(worker(args), sort_keys=True))
        return 0
    if not args.fixture or not args.ffmpeg or not args.output_dir:
        raise SystemExit("--fixture, --ffmpeg, and --output-dir are required; the harness never discovers or downloads inputs")
    if args.trials < 3:
        raise SystemExit("--trials must be at least 3 for qualification")
    if not Path(args.ffmpeg).is_file():
        raise SystemExit("--ffmpeg must be an explicit existing runtime path")
    efforts = [int(item) for item in args.efforts.split(",")]
    if any(effort < 0 or effort > 10 for effort in efforts):
        raise SystemExit("Opus efforts must be between 0 and 10")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    trials = []
    for fixture_id, fixture in args.fixture:
        if not fixture.is_file():
            raise SystemExit(f"fixture {fixture_id!r} is unavailable: {fixture}")
        for trial_index in range(args.trials):
            trials.append(run_worker(fixture_id, fixture, args.ffmpeg, "finalization", None, args.output_dir))
            rotated = efforts[trial_index % len(efforts):] + efforts[:trial_index % len(efforts)]
            for effort in rotated:
                trials.append(run_worker(fixture_id, fixture, args.ffmpeg, "encode", effort, args.output_dir))
    metadata = {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version(), "app_revision": app_revision(), "ffmpeg_version": executable_version(args.ffmpeg), "fixture_identities": [{"id": fixture_id, "sha256": sha256_file(fixture)} for fixture_id, fixture in args.fixture], "process_modes": ["fresh-process"], "filesystem_cache": "state not controlled", "model_resident": False, "power_mode": UNAVAILABLE, "unavailable_measurements": ["queue_wait_ms", "admission_ms", "spawn_import_load_ms", "peak_vram_bytes"]}
    report = build_report(metadata, trials)
    (args.output_dir / "inference-performance-report-v1.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
