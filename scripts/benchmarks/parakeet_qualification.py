#!/usr/bin/env python3
"""Bounded, local-only CachyOS Parakeet-vs-Whisper screening harness.

The parent process owns validation, process isolation, telemetry, normalization,
and report redaction. Engine packages are imported only by the fresh worker.
This is a developer benchmark; it is deliberately not part of the application
runtime or production dependency graph.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import signal
import statistics
import subprocess
import sys
import time
import unicodedata
import wave
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[2]
WORKER = Path(__file__).with_name("parakeet_qualification_worker.py")
REPORT_VERSION = 1
DEFAULT_TIMEOUT_SECONDS = 15 * 60
DEFAULT_SAMPLE_INTERVAL_MS = 25
ENGINE_NAMES = ("whisper", "parakeet")

CANDIDATE_MODEL_FILES: dict[str, tuple[int, str]] = {
    "config.json": (97, "666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466"),
    "vocab.txt": (9384, "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d"),
    "nemo128.onnx": (139764, "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f"),
    "decoder_joint-model.onnx": (35792059, "cbb52a07bd70ab5b67f8439d4b3cd8704b18467b4430bcacb5adabe154b8d191"),
    "encoder-model.onnx": (41770866, "3987bcd28175d829d12888a996a84e8f62a0e374d9ffd640662c1515adc679d3"),
    "encoder-model.onnx.data": (2435420160, "4dab7362d4874d85965045b1e41b2d61dd2cc0fb25671a7f6b3dc47bf120cc41"),
}
CANDIDATE_VAD_FILES: dict[str, tuple[int, str]] = {
    "silero_vad.onnx": (2327524, "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"),
}
WHISPER_BASELINES: dict[str, dict[str, str]] = {
    "small": {
        "folder": "models--Systran--faster-whisper-small",
        "revision": "536b0662742c02347bc0e980a01041f333bce120",
        "model_bin_sha256": "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
    },
    "medium": {
        "folder": "models--Systran--faster-whisper-medium",
        "revision": "08e178d48790749d25932bbc082711ddcfdfbc4f",
        "model_bin_sha256": "9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae",
    },
}
WHISPER_MODEL_SHA256 = WHISPER_BASELINES["small"]["model_bin_sha256"]
WHISPER_MODEL_REVISION = WHISPER_BASELINES["small"]["revision"]


@dataclass(frozen=True)
class QualificationArgs:
    fixture: Path
    reference: Path
    baseline_python: Path
    candidate_python: Path
    baseline_model_dir: Path
    candidate_model_dir: Path
    candidate_vad_dir: Path
    baseline_library_dirs: list[Path]
    candidate_library_dirs: list[Path]
    baseline_driver_dirs: list[Path]
    candidate_driver_dirs: list[Path]
    output_dir: Path
    trials: int
    timeout_seconds: float
    sample_interval_ms: int
    ffmpeg: str
    fixture_source: str
    fixture_license: str
    fixture_revision: str
    candidate_model_revision: str
    vad_revision: str
    preflight_only: bool = False
    baseline_model_size: str = "small"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_words(value: str) -> list[str]:
    """Normalize both reference and engine text using one documented rule."""
    normalized = unicodedata.normalize("NFKC", str(value)).casefold()
    return re.findall(r"[\w']+", normalized, flags=re.UNICODE)


def word_error_rate(reference: list[str], actual: list[str]) -> float | None:
    if not reference:
        return None
    prior = list(range(len(actual) + 1))
    for row, expected in enumerate(reference, start=1):
        current = [row]
        for column, observed in enumerate(actual, start=1):
            current.append(min(
                prior[column] + 1,
                current[column - 1] + 1,
                prior[column - 1] + (expected != observed),
            ))
        prior = current
    return prior[-1] / len(reference)


def load_reference(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    if path.suffix.lower() == ".json":
        payload = json.loads(raw)
        segments = payload.get("segments", []) if isinstance(payload, dict) else []
        text = " ".join(str(item.get("text", "")) for item in segments if isinstance(item, dict))
        timed_words = payload.get("timed_words", []) if isinstance(payload, dict) else []
        return {
            "text": text,
            "words": normalize_words(text),
            "timed_words": timed_words if isinstance(timed_words, list) else [],
        }
    return {"text": raw, "words": normalize_words(raw), "timed_words": []}


def build_token_intervals(
    *, segment_start: float, segment_end: float, token_starts: Iterable[float], audio_duration: float,
) -> tuple[list[tuple[float, float]], dict[str, int]]:
    """Offset token starts relative to a VAD chunk and close intervals at the next start.

    onnx-asr returns token starts relative to the VAD chunk, while its segment
    start/end fields are absolute. The last token closes at the VAD segment end;
    token starts are never treated as segment end timestamps.
    """
    starts = list(token_starts)
    diagnostics = {"invalid_timestamps": 0, "out_of_order_timestamps": 0, "out_of_bounds_intervals": 0}
    if segment_end < segment_start or segment_start < 0 or segment_end > audio_duration + 0.05:
        diagnostics["out_of_bounds_intervals"] += 1
        return [], diagnostics
    local_duration = segment_end - segment_start
    local_values: list[float] = []
    previous = -math.inf
    for value in starts:
        try:
            current = float(value)
        except (TypeError, ValueError):
            diagnostics["invalid_timestamps"] += 1
            continue
        if not math.isfinite(current) or current < 0 or current > local_duration + 0.05:
            diagnostics["invalid_timestamps"] += 1
            continue
        if current < previous:
            diagnostics["out_of_order_timestamps"] += 1
        previous = current
        local_values.append(current)
    if diagnostics["invalid_timestamps"] or diagnostics["out_of_order_timestamps"]:
        if starts:
            diagnostics["out_of_bounds_intervals"] += 1
        return [], diagnostics
    absolute = [segment_start + value for value in local_values]
    intervals: list[tuple[float, float]] = []
    for index, start in enumerate(absolute):
        end = absolute[index + 1] if index + 1 < len(absolute) else segment_end
        if start < 0 or end < start or end > audio_duration + 0.05:
            diagnostics["out_of_bounds_intervals"] += 1
            continue
        intervals.append((start, end))
    return intervals, diagnostics


def _proc_stat(pid: int) -> tuple[int, int] | None:
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
        closing = text.rfind(")")
        fields = text[closing + 2 :].split()
        return int(fields[1]), int(fields[21])  # ppid, starttime
    except (OSError, ValueError, IndexError):
        return None


def process_tree_pids(root_pid: int) -> set[int]:
    tree = {root_pid}
    changed = True
    while changed:
        changed = False
        for entry in Path("/proc").iterdir():
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            stat = _proc_stat(pid)
            if stat and stat[0] in tree and pid not in tree:
                tree.add(pid)
                changed = True
    return tree


def pid_exists(pid: int) -> bool:
    return Path(f"/proc/{pid}").exists()


def _rss_bytes(pid: int) -> int | None:
    try:
        for line in Path(f"/proc/{pid}/status").read_text(encoding="ascii").splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def _sample_gpu(pids: set[int]) -> tuple[int | None, float | None]:
    try:
        memory = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2, check=False,
        )
        utilization = subprocess.run(
            ["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=2, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    peak = 0
    observed = False
    if memory.returncode == 0:
        for line in memory.stdout.splitlines():
            fields = [part.strip() for part in line.split(",")]
            try:
                pid = int(fields[0])
                mib = float(re.sub(r"[^0-9.]", "", fields[1]))
            except (ValueError, IndexError):
                continue
            if pid in pids:
                peak += int(mib * 1024 * 1024)
                observed = True
    gpu_util: float | None = None
    if utilization.returncode == 0:
        try:
            gpu_util = float(re.sub(r"[^0-9.]", "", utilization.stdout.splitlines()[0]))
        except (ValueError, IndexError):
            pass
    return (peak if observed else None), gpu_util


def _terminate_process_group(proc: subprocess.Popen[str]) -> None:
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, OSError):
        pass
    try:
        proc.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, OSError):
            pass
        try:
            proc.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            pass


def run_worker_process(
    *, python_executable: Path, worker_path: Path, worker_args: list[str], env: dict[str, str],
    timeout_seconds: float, output_log: Path, sample_interval_ms: int, collect_gpu: bool = True,
) -> dict[str, Any]:
    output_log.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    proc = subprocess.Popen(
        [str(python_executable), str(worker_path), *worker_args],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    peak_rss = 0
    peak_gpu: int | None = None
    gpu_utilization: list[float] = []
    descendant_count = 0
    while proc.poll() is None:
        pids = process_tree_pids(proc.pid)
        descendant_count = max(descendant_count, len(pids) - 1)
        rss = sum(value for pid in pids if (value := _rss_bytes(pid)) is not None)
        peak_rss = max(peak_rss, rss)
        if collect_gpu:
            gpu_memory, gpu_util = _sample_gpu(pids)
            if gpu_memory is not None:
                peak_gpu = max(peak_gpu or 0, gpu_memory)
            if gpu_util is not None:
                gpu_utilization.append(gpu_util)
        if time.perf_counter() - started >= timeout_seconds:
            _terminate_process_group(proc)
            stdout, stderr = proc.communicate()
            output_log.write_text(stdout + "\n--- stderr ---\n" + stderr, encoding="utf-8")
            return {
                "pid": proc.pid,
                "outcome": "timeout",
                "failure": {"layer": "benchmark", "code": "worker_timeout"},
                "elapsed_ms": (time.perf_counter() - started) * 1000.0,
                "peak_rss_bytes": peak_rss or None,
                "peak_gpu_memory_bytes": peak_gpu,
                "gpu_utilization": gpu_utilization,
                "descendant_pids_at_termination": descendant_count,
            }
        time.sleep(sample_interval_ms / 1000.0)
    pids = process_tree_pids(proc.pid)
    rss = sum(value for pid in pids if (value := _rss_bytes(pid)) is not None)
    peak_rss = max(peak_rss, rss)
    stdout, stderr = proc.communicate()
    output_log.write_text(stdout + "\n--- stderr ---\n" + stderr, encoding="utf-8")
    result: dict[str, Any] = {
        "pid": proc.pid,
        "outcome": "success" if proc.returncode == 0 else "failed",
        "elapsed_ms": (time.perf_counter() - started) * 1000.0,
        "peak_rss_bytes": peak_rss or None,
        "peak_gpu_memory_bytes": peak_gpu,
        "gpu_utilization": gpu_utilization,
        "descendant_pids_at_termination": descendant_count,
    }
    lines = [line for line in stdout.splitlines() if line.strip()]
    try:
        result["worker"] = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError):
        result["outcome"] = "failed"
        result["failure"] = {"layer": "benchmark", "code": "malformed_worker_output"}
    if proc.returncode != 0 and "failure" not in result:
        result["failure"] = {"layer": "benchmark", "code": "worker_nonzero_exit"}
    return result


def _metric_values(trials: list[dict[str, Any]], key: str) -> list[float]:
    return [float(trial[key]) for trial in trials if trial.get("outcome") == "success" and isinstance(trial.get(key), (int, float))]


def _metric_summary(values: list[float]) -> dict[str, float | list[float]] | str:
    if not values:
        return "unavailable"
    return {"median": statistics.median(values), "range": [min(values), max(values)]}


def summarize_trials(trials: list[dict[str, Any]], *, engine: str) -> dict[str, Any]:
    successful = [trial for trial in trials if trial.get("engine") == engine and trial.get("outcome") == "success"]
    wall = _metric_values(successful, "wall_ms")
    rss = [int(trial["resources"]["peak_rss_bytes"]) for trial in successful if isinstance(trial.get("resources", {}).get("peak_rss_bytes"), int)]
    gpu = [int(trial["resources"]["peak_gpu_memory_bytes"]) for trial in successful if isinstance(trial.get("resources", {}).get("peak_gpu_memory_bytes"), int)]
    rtfs = _metric_values(successful, "rtf")
    return {
        "engine": engine,
        "successful_trials": len(successful),
        "excluded_trials": len([trial for trial in trials if trial.get("engine") == engine]) - len(successful),
        "wall_ms_values": wall,
        "wall_ms": _metric_summary(wall),
        "end_to_end_rtf": _metric_summary(rtfs),
        "peak_rss_bytes": _metric_summary([float(value) for value in rss]),
        "peak_gpu_memory_bytes": _metric_summary([float(value) for value in gpu]),
        "load_ms": _metric_summary(_metric_values(successful, "load_ms")),
        "decode_ms": _metric_summary(_metric_values(successful, "decode_ms")),
        "gpu_utilization_percent": _metric_summary([
            float(value) for trial in successful for value in trial.get("resources", {}).get("gpu_utilization_percent", [])
        ]),
        "quality": {
            "wer_values": [trial.get("quality", {}).get("wer") for trial in successful],
            "wer_median": _metric_summary([float(trial["quality"]["wer"]) for trial in successful if isinstance(trial.get("quality", {}).get("wer"), (int, float))]),
            "empty_output_count": sum(bool(trial.get("quality", {}).get("empty_output")) for trial in successful),
            "missing_chunk_boundary_words": _sum_quality(successful, "missing_chunk_boundary_words"),
            "duplicated_chunk_boundary_words": _sum_quality(successful, "duplicated_chunk_boundary_words"),
            "invalid_timestamps": _sum_quality(successful, "invalid_timestamps"),
            "out_of_order_timestamps": _sum_quality(successful, "out_of_order_timestamps"),
            "omitted_opening_words": _sum_quality(successful, "omitted_opening_words"),
            "omitted_closing_words": _sum_quality(successful, "omitted_closing_words"),
        },
    }


def _sum_quality(trials: list[dict[str, Any]], key: str) -> int | str:
    values = [trial.get("quality", {}).get(key) for trial in trials]
    if any(value == "unavailable" for value in values) or not values:
        return "unavailable"
    return sum(int(value or 0) for value in values)


def _boundary_missing_words(segments: list[dict[str, Any]], timed_words: list[Any]) -> int | str:
    """Count reference words near a result boundary absent from adjacent output.

    This is a screening diagnostic, not a word-alignment algorithm. Each timed
    reference word is assigned to its nearest result boundary within 0.5 s, so
    adjacent boundaries cannot double-count it. Without both inputs the metric
    remains explicitly unavailable.
    """
    if len(segments) < 2 or not timed_words:
        return "unavailable"
    boundaries: list[tuple[float, list[str]]] = []
    for left, right in zip(segments, segments[1:]):
        try:
            boundary = (float(left["end"]) + float(right["start"])) / 2.0
        except (KeyError, TypeError, ValueError):
            continue
        context = normalize_words(f"{left.get('text', '')} {right.get('text', '')}")
        boundaries.append((boundary, context))
    if not boundaries:
        return "unavailable"
    expected_by_boundary: list[list[str]] = [[] for _ in boundaries]
    for item in timed_words:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item["start"])
            text = normalize_words(str(item.get("text", "")))
        except (KeyError, TypeError, ValueError):
            continue
        if not text:
            continue
        distances = [abs(start - boundary) for boundary, _context in boundaries]
        nearest = min(range(len(distances)), key=distances.__getitem__)
        if distances[nearest] <= 0.5:
            expected_by_boundary[nearest].extend(text)
    missing = 0
    for (_boundary, context), expected in zip(boundaries, expected_by_boundary):
        actual = Counter(context)
        for word, count in (Counter(expected) - actual).items():
            missing += count
    return missing


def _redact_key(key: str) -> bool:
    return key.lower() in {
        "fixture_path", "reference_path", "model_path", "vad_path", "audio_path", "log_path",
        "raw_text", "reference_text", "stdout", "stderr", "traceback",
    }


def sanitize_report(value: Any, *, key: str = "") -> Any:
    if _redact_key(key):
        return "redacted"
    if isinstance(value, dict):
        return {str(name): sanitize_report(item, key=str(name)) for name, item in value.items()}
    if isinstance(value, list):
        return [sanitize_report(item, key=key) for item in value]
    return value


def _path_status(path: Path, *, directory: bool = False) -> tuple[bool, str]:
    if not path.exists():
        return False, "missing"
    if directory and not path.is_dir():
        return False, "not_directory"
    if not directory and not path.is_file():
        return False, "not_file"
    return True, "ok"


def _verify_pins(directory: Path, pins: dict[str, tuple[int, str]]) -> list[dict[str, Any]]:
    failures = []
    for name, (expected_size, expected_hash) in pins.items():
        path = directory / name
        if not path.is_file():
            failures.append({"code": "missing_artifact", "artifact": name})
            continue
        if path.stat().st_size != expected_size:
            failures.append({"code": "artifact_size_mismatch", "artifact": name})
            continue
        if sha256_file(path) != expected_hash:
            failures.append({"code": "artifact_hash_mismatch", "artifact": name})
    return failures


def _read_fixture_info(path: Path) -> dict[str, Any]:
    with wave.open(str(path), "rb") as reader:
        frames = reader.getnframes()
        rate = reader.getframerate()
        return {"duration_s": frames / rate, "sample_rate": rate, "channels": reader.getnchannels(), "frames": frames}


def _run_host_probe() -> dict[str, Any]:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version,compute_cap,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "failed", "code": "nvidia_smi_unavailable"}
    if result.returncode != 0 or not result.stdout.strip():
        return {"status": "failed", "code": "nvidia_smi_failed"}
    first = [part.strip() for part in result.stdout.splitlines()[0].split(",")]
    if len(first) < 4:
        return {"status": "failed", "code": "nvidia_smi_malformed"}
    contention = {"status": "not_observable", "compute_process_count": None, "used_memory_mib": None}
    try:
        apps = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if apps.returncode == 0:
            rows = []
            for line in apps.stdout.splitlines():
                fields = [part.strip() for part in line.split(",")]
                try:
                    rows.append(float(re.sub(r"[^0-9.]", "", fields[1])))
                except (IndexError, ValueError):
                    continue
            contention = {
                "status": "blocked" if rows else "clear",
                "compute_process_count": len(rows),
                "used_memory_mib": sum(rows),
            }
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {
        "status": "ready", "gpu": first[0], "driver": first[1], "compute_capability": first[2],
        "memory_total": first[3], "contention": contention,
    }


def _run_managed_whisper_probe(args: QualificationArgs) -> dict[str, Any]:
    managed_dirs = [str(item) for item in args.baseline_library_dirs]
    required = []
    for name in ("libcublas.so.12", "libcudnn.so.9"):
        matches = [directory / name for directory in args.baseline_library_dirs if (directory / name).is_file()]
        if matches:
            required.append(str(matches[0]))
    profile = [{"id": "cuda12", "requiredDlls": required}]
    hints = [{"id": "cuda13", "expectedDllPrefixes": ["libcublas.so.13", "libcublaslt.so.13"]}]
    command = [
        str(args.baseline_python), "-m", "backend.transcription.cuda_probe",
        "--profiles-json", json.dumps(profile), "--supported-profiles", "cuda12",
        "--unsupported-hints-json", json.dumps(hints), "--device-check", "nvidia-smi",
        "--library-search-dirs-json", json.dumps(managed_dirs), "--validate-ctranslate2-cuda",
    ]
    env = _offline_env(args.baseline_library_dirs + args.baseline_driver_dirs)
    env["PYTHONPATH"] = str(ROOT)
    try:
        result = subprocess.run(command, cwd=ROOT, env=env, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "failed", "code": "managed_probe_unavailable"}
    try:
        payload = json.loads([line for line in result.stdout.splitlines() if line.strip()][-1])
    except (IndexError, json.JSONDecodeError):
        return {"status": "failed", "code": "managed_probe_malformed"}
    if result.returncode != 0 or payload.get("statusCode") != "ready":
        return {"status": "failed", "code": f"managed_probe_{payload.get('statusCode', 'failed')}"}
    return {
        "status": "ready", "status_code": payload.get("statusCode"), "matched_profile": payload.get("matchedProfile"),
        "device_available": payload.get("deviceAvailable"), "runtime_loadable": payload.get("runtimeLoadable"),
        "unsupported_detected_profiles": payload.get("unsupportedDetectedProfiles", []),
    }


def _offline_env(library_dirs: list[Path]) -> dict[str, str]:
    env = os.environ.copy()
    for name in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_TOKEN_PATH"):
        env.pop(name, None)
    env["HF_HUB_OFFLINE"] = "1"
    env["TRANSFORMERS_OFFLINE"] = "1"
    env["HF_DATASETS_OFFLINE"] = "1"
    env["PYTHONNOUSERSITE"] = "1"
    env["LD_LIBRARY_PATH"] = os.pathsep.join(str(item) for item in library_dirs if item)
    return env


def _baseline_worker_env(args: QualificationArgs) -> dict[str, str]:
    env = _offline_env(args.baseline_library_dirs + args.baseline_driver_dirs)
    env.update({
        "PYTHONPATH": os.pathsep.join((str(ROOT), str(ROOT / "backend"))),
        "AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR": str(args.baseline_model_dir),
        "AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY": "1",
        "AVANEVIS_LINUX_CUDA_REQUIRED": "1",
    })
    return env


def _candidate_worker_env(args: QualificationArgs) -> dict[str, str]:
    return _offline_env(args.candidate_library_dirs + args.candidate_driver_dirs)


def run_preflight(args: QualificationArgs, *, run_hardware: bool = True) -> dict[str, Any]:
    failures: list[dict[str, Any]] = []
    fixture_ok, fixture_status = _path_status(args.fixture)
    reference_ok, reference_status = _path_status(args.reference)
    if not fixture_ok:
        failures.append({"layer": "benchmark_input", "code": "fixture_" + fixture_status})
    if not reference_ok:
        failures.append({"layer": "benchmark_input", "code": "reference_" + reference_status})
    if fixture_ok:
        try:
            info = _read_fixture_info(args.fixture)
            if info["duration_s"] < 300 or info["duration_s"] > 900:
                failures.append({"layer": "benchmark_input", "code": "fixture_duration_outside_5_to_15_minutes"})
        except (OSError, wave.Error):
            failures.append({"layer": "benchmark_input", "code": "fixture_not_pcm_wav"})
    baseline_ok, baseline_status = _path_status(args.baseline_python)
    candidate_ok, candidate_status = _path_status(args.candidate_python)
    if not baseline_ok:
        failures.append({"layer": "managed_whisper", "code": "baseline_python_" + baseline_status})
    if not candidate_ok:
        failures.append({"layer": "candidate_runtime", "code": "candidate_python_" + candidate_status})
    if not args.baseline_model_dir.is_dir():
        failures.append({"layer": "managed_whisper", "code": "baseline_model_cache_missing"})
    else:
        baseline = _whisper_baseline(args.baseline_model_size)
        snapshot = args.baseline_model_dir / baseline["folder"] / "snapshots" / baseline["revision"]
        model_bin = snapshot / "model.bin"
        if not model_bin.is_file() or sha256_file(model_bin) != baseline["model_bin_sha256"]:
            failures.append({"layer": "managed_whisper", "code": "baseline_model_hash_mismatch"})
    failures.extend({"layer": "candidate_runtime", **item} for item in _verify_pins(args.candidate_model_dir, CANDIDATE_MODEL_FILES))
    failures.extend({"layer": "candidate_runtime", **item} for item in _verify_pins(args.candidate_vad_dir, CANDIDATE_VAD_FILES))
    for label, dirs in (("baseline", args.baseline_library_dirs), ("candidate", args.candidate_library_dirs)):
        for directory in dirs:
            if not directory.is_dir():
                failures.append({"layer": "managed_whisper" if label == "baseline" else "candidate_runtime", "code": label + "_library_directory_missing"})
    host = _run_host_probe() if run_hardware else {"status": "not_run"}
    if run_hardware and host.get("status") != "ready":
        failures.append({"layer": "host_driver", "code": host.get("code", "host_probe_failed")})
    if run_hardware and host.get("contention", {}).get("status") == "blocked":
        failures.append({"layer": "benchmark_environment", "code": "host_gpu_contention"})
    managed = _run_managed_whisper_probe(args) if run_hardware and not any(item["layer"] == "managed_whisper" for item in failures) else {"status": "not_run"}
    if run_hardware and managed.get("status") != "ready":
        failures.append({"layer": "managed_whisper", "code": managed.get("code", "managed_probe_failed")})
    candidate = {"status": "not_run"}
    if candidate_ok and args.candidate_vad_dir.is_dir() and args.candidate_model_dir.is_dir() and not any(item["layer"] == "candidate_runtime" for item in failures):
        preflight = run_worker_process(
            python_executable=args.candidate_python, worker_path=WORKER,
            worker_args=["--preflight", "--candidate-model", str(args.candidate_model_dir), "--candidate-vad", str(args.candidate_vad_dir)],
            env=_candidate_worker_env(args),
            timeout_seconds=min(args.timeout_seconds, 120), output_log=args.output_dir / "private" / "candidate-preflight.log",
            sample_interval_ms=args.sample_interval_ms, collect_gpu=False,
        )
        candidate_payload = preflight.get("worker", {})
        candidate = candidate_payload if isinstance(candidate_payload, dict) else {"status": "failed", "code": "candidate_preflight_malformed"}
        if preflight.get("outcome") != "success" or candidate.get("status") != "ready":
            failures.append({"layer": "candidate_runtime", "code": candidate.get("code", "candidate_preflight_failed")})
    return {
        "status": "ready" if not failures else "failed",
        "failures": failures,
        "host_driver": host,
        "managed_whisper": managed,
        "candidate_runtime": candidate,
    }


def _quality(result: dict[str, Any], reference: dict[str, Any]) -> dict[str, Any]:
    actual = normalize_words(str(result.get("text", "")))
    expected = reference["words"]
    span = max(1, len(expected) // 8) if expected else 1
    beginning = expected[:span]
    closing = expected[-span:] if expected else []
    actual_set = set(actual)
    segments = result.get("segments") or []
    duplicate = 0
    for left, right in zip(segments, segments[1:]):
        left_words = normalize_words(str(left.get("text", "")))
        right_words = normalize_words(str(right.get("text", "")))
        if left_words and right_words and left_words[-1] == right_words[0]:
            duplicate += 1
    return {
        "wer": word_error_rate(expected, actual),
        "empty_output": not bool(actual),
        "missing_chunk_boundary_words": _boundary_missing_words(segments, reference.get("timed_words", [])),
        "duplicated_chunk_boundary_words": duplicate,
        "invalid_timestamps": int(result.get("timestamp_diagnostics", {}).get("invalid_timestamps", 0)),
        "out_of_order_timestamps": int(result.get("timestamp_diagnostics", {}).get("out_of_order_timestamps", 0)),
        "omitted_opening_words": sum(word not in actual_set for word in beginning),
        "omitted_closing_words": sum(word not in actual_set for word in closing),
        "beginning_present": all(word in actual_set for word in beginning),
        "closing_present": all(word in actual_set for word in closing),
    }


def _run_trial(args: QualificationArgs, engine: str, phase: str, number: int, fixture: Path, reference: dict[str, Any]) -> dict[str, Any]:
    if engine == "whisper":
        python = args.baseline_python
        env = _baseline_worker_env(args)
        worker_args = [
            "--engine", "whisper", "--fixture", str(fixture), "--device", "cuda", "--compute-type", "float16",
            "--model-size", args.baseline_model_size,
        ]
    else:
        python = args.candidate_python
        env = _candidate_worker_env(args)
        worker_args = [
            "--engine", "parakeet", "--fixture", str(fixture), "--candidate-model", str(args.candidate_model_dir),
            "--candidate-vad", str(args.candidate_vad_dir),
        ]
    result = run_worker_process(
        python_executable=python, worker_path=WORKER, worker_args=worker_args, env=env,
        timeout_seconds=args.timeout_seconds, output_log=args.output_dir / "private" / f"{phase}-{engine}-{number}.log",
        sample_interval_ms=args.sample_interval_ms, collect_gpu=True,
    )
    worker = result.get("worker", {}) if isinstance(result.get("worker"), dict) else {}
    audio_duration = float(reference.get("duration_s") or 0.0)
    if not audio_duration:
        audio_duration = _read_fixture_info(fixture)["duration_s"]
    trial = {
        "engine": engine, "phase": phase, "trial": number,
        "outcome": "success" if result.get("outcome") == "success" and worker.get("outcome") == "success" else "failed",
        "wall_ms": result.get("elapsed_ms"), "audio_duration_s": audio_duration,
        "load_ms": worker.get("load_ms"), "decode_ms": worker.get("decode_ms"),
        "rtf": (float(result["elapsed_ms"]) / (audio_duration * 1000.0)) if audio_duration and isinstance(result.get("elapsed_ms"), (int, float)) else None,
        "resources": {
            "peak_rss_bytes": result.get("peak_rss_bytes"), "peak_gpu_memory_bytes": result.get("peak_gpu_memory_bytes"),
            "gpu_utilization_percent": result.get("gpu_utilization", []),
            "rss_method": "sampled /proc process-tree VmRSS sum",
            "gpu_memory_method": "nvidia-smi compute-apps PID matching; unavailable when not observable",
        },
        "quality": _quality(worker, reference) if worker.get("outcome") == "success" else {
            "wer": None, "empty_output": True, "missing_chunk_boundary_words": "unavailable",
            "duplicated_chunk_boundary_words": "unavailable", "invalid_timestamps": "unavailable",
            "out_of_order_timestamps": "unavailable", "omitted_opening_words": "unavailable", "omitted_closing_words": "unavailable",
        },
    }
    if trial["outcome"] != "success":
        trial["failure"] = result.get("failure") or worker.get("failure") or {"layer": "benchmark", "code": "trial_failed"}
    return trial


def _decision(summaries: dict[str, dict[str, Any]], preflight: dict[str, Any], fixture: dict[str, Any]) -> dict[str, Any]:
    if preflight.get("status") != "ready":
        return {"classification": "inconclusive", "reason": "preflight_failed", "missing_evidence": preflight.get("failures", [])}
    baseline = summaries["whisper"]
    candidate = summaries["parakeet"]
    if baseline["successful_trials"] < 5 or candidate["successful_trials"] < 5:
        return {"classification": "inconclusive", "reason": "required_five_trial_batch_not_complete", "missing_evidence": ["five successful measured trials per engine"]}
    base_wall = baseline["wall_ms"]["median"] if isinstance(baseline.get("wall_ms"), dict) else None
    cand_wall = candidate["wall_ms"]["median"] if isinstance(candidate.get("wall_ms"), dict) else None
    if not isinstance(base_wall, (int, float)) or not isinstance(cand_wall, (int, float)):
        return {"classification": "inconclusive", "reason": "timing_unavailable"}
    speed_gain = 1.0 - cand_wall / base_wall
    ranges_overlap = (
        isinstance(baseline["wall_ms"], dict) and isinstance(candidate["wall_ms"], dict)
        and baseline["wall_ms"]["range"][0] <= candidate["wall_ms"]["range"][1]
        and candidate["wall_ms"]["range"][0] <= baseline["wall_ms"]["range"][1]
    )
    resource_missing = baseline.get("peak_gpu_memory_bytes") == "unavailable" or candidate.get("peak_gpu_memory_bytes") == "unavailable"
    base_wer = baseline.get("quality", {}).get("wer_median")
    cand_wer = candidate.get("quality", {}).get("wer_median")
    if resource_missing or not isinstance(base_wer, dict) or not isinstance(cand_wer, dict):
        return {"classification": "inconclusive", "reason": "required_resource_or_quality_measurement_missing", "missing_evidence": ["isolated per-process VRAM and/or comparable WER"]}
    wer_delta = float(cand_wer["median"]) - float(base_wer["median"])
    no_truncation = candidate["quality"]["empty_output_count"] == 0 and candidate["quality"]["omitted_opening_words"] == 0 and candidate["quality"]["omitted_closing_words"] == 0
    rss_ok = isinstance(baseline.get("peak_rss_bytes"), dict) and isinstance(candidate.get("peak_rss_bytes"), dict) and candidate["peak_rss_bytes"]["median"] <= baseline["peak_rss_bytes"]["median"] * 1.05
    vram_ok = candidate["peak_gpu_memory_bytes"]["median"] <= baseline["peak_gpu_memory_bytes"]["median"] * 1.05
    if speed_gain >= 0.20 and rss_ok and vram_ok and no_truncation and wer_delta <= 0.01:
        return {"classification": "promising", "speed_gain": speed_gain, "wer_delta": wer_delta}
    if speed_gain >= 0.05 and not ranges_overlap:
        return {"classification": "tradeoff", "speed_gain": speed_gain, "wer_delta": wer_delta, "rss_ok": rss_ok, "vram_ok": vram_ok}
    if ranges_overlap:
        return {"classification": "inconclusive", "reason": "timing_ranges_overlap", "speed_gain": speed_gain, "wer_delta": wer_delta}
    return {"classification": "defer_this_candidate", "reason": "no_meaningful_complete_meeting_speed_gain_or_quality_failure", "speed_gain": speed_gain, "wer_delta": wer_delta}


def _materialize_fixture(args: QualificationArgs) -> Path:
    target = args.output_dir / "derived-mono-16k.wav"
    args.output_dir.mkdir(parents=True, exist_ok=True)
    command = [args.ffmpeg, "-nostdin", "-v", "error", "-y", "-i", str(args.fixture), "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(target)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("fixture_materialization_failed") from exc
    if result.returncode != 0:
        raise RuntimeError("fixture_materialization_failed")
    info = _read_fixture_info(target)
    if info["sample_rate"] != 16000 or info["channels"] != 1:
        raise RuntimeError("fixture_materialization_schema_failed")
    return target


def run_benchmark(args: QualificationArgs) -> dict[str, Any]:
    preflight = run_preflight(args)
    fixture_info = _read_fixture_info(args.fixture) if args.fixture.is_file() else {}
    base_report: dict[str, Any] = {
        "report_version": REPORT_VERSION,
        "scope": "CachyOS x86_64 managed CUDA 12 screening only",
        "provisional_rules": {"promising_speed_gain": 0.20, "max_wer_delta": 0.01, "measured_trials_per_engine": 5},
        "fixture": {
            "id": "public-ami-is1009a",
            "source": args.fixture_source, "license": args.fixture_license, "source_revision": args.fixture_revision,
            "sha256": sha256_file(args.fixture) if args.fixture.is_file() else None,
            "reference_sha256": sha256_file(args.reference) if args.reference.is_file() else None,
            **fixture_info,
        },
        "artifacts": {
            "candidate_model": {"revision": args.candidate_model_revision, "files": {name: {"size_bytes": size, "sha256": digest} for name, (size, digest) in CANDIDATE_MODEL_FILES.items()}},
            "candidate_vad": {"revision": args.vad_revision, "files": {name: {"size_bytes": size, "sha256": digest} for name, (size, digest) in CANDIDATE_VAD_FILES.items()}, "license": "MIT"},
            "whisper_model": {"size": args.baseline_model_size, **_whisper_baseline(args.baseline_model_size)},
        },
        "environment": {"os": "CachyOS", "architecture": platform.machine(), "kernel": platform.release(), "app_revision": _app_revision()},
        "preflight": preflight,
    }
    if preflight.get("status") != "ready":
        base_report["decision"] = {"classification": "inconclusive", "reason": "preflight_failed", "missing_evidence": preflight.get("failures", [])}
        return sanitize_report(base_report)
    try:
        fixture = _materialize_fixture(args)
        reference = load_reference(args.reference)
        reference["duration_s"] = _read_fixture_info(fixture)["duration_s"]
    except (OSError, ValueError, RuntimeError, wave.Error):
        base_report["decision"] = {"classification": "inconclusive", "reason": "fixture_materialization_failed"}
        return sanitize_report(base_report)
    trials: list[dict[str, Any]] = []
    for engine in ENGINE_NAMES:
        trials.append(_run_trial(args, engine, "cold", 0, fixture, reference))
    stopped: set[str] = {trial["engine"] for trial in trials if trial["outcome"] != "success"}
    for index in range(args.trials):
        for engine in ("whisper", "parakeet") if index % 2 == 0 else ("parakeet", "whisper"):
            if engine in stopped:
                trials.append({"engine": engine, "phase": "measured", "trial": index + 1, "outcome": "failed", "failure": {"layer": "candidate_runtime" if engine == "parakeet" else "managed_whisper", "code": "row_stopped_after_prior_failure"}})
                continue
            trial = _run_trial(args, engine, "measured", index + 1, fixture, reference)
            trials.append(trial)
            if trial["outcome"] != "success":
                stopped.add(engine)
    measured = [trial for trial in trials if trial.get("phase") == "measured"]
    summaries = {engine: summarize_trials(measured, engine=engine) for engine in ENGINE_NAMES}
    base_report["trials"] = measured
    base_report["cold_trials"] = [trial for trial in trials if trial.get("phase") == "cold"]
    base_report["summaries"] = summaries
    base_report["decision"] = _decision(summaries, preflight, {**fixture_info, "duration_s": reference["duration_s"]})
    base_report["limitations"] = [
        "Fresh cached-model process is first-run evidence; disk cache eviction is not claimed.",
        "GPU utilization is host-wide nvidia-smi sampling; per-process VRAM is reported unavailable when compute-app telemetry cannot observe it.",
        "Boundary missing-word counts require time-aligned reference words and are unavailable for plain text references.",
        "This screen does not qualify 60-minute meetings, silence/noise, accents, overlap, guided execution, lifecycle failure cases, or packaged acceptance.",
    ]
    return sanitize_report(base_report)


def _app_revision() -> str | None:
    try:
        result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, timeout=5, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    except OSError:
        return None


def _parse_args(argv: list[str] | None = None) -> QualificationArgs:
    parser = argparse.ArgumentParser(description="Run the bounded CachyOS Parakeet ONNX CUDA 12 screening benchmark.")
    parser.add_argument("--fixture", type=Path, required=True, help="Representative meeting WAV; kept outside the repository.")
    parser.add_argument("--reference", type=Path, required=True, help="Human reference transcript text or JSON; kept outside the repository.")
    parser.add_argument("--baseline-python", type=Path, required=True)
    parser.add_argument("--candidate-python", type=Path, required=True)
    parser.add_argument("--baseline-model-dir", type=Path, required=True)
    parser.add_argument("--candidate-model-dir", type=Path, required=True)
    parser.add_argument("--candidate-vad-dir", type=Path, required=True)
    parser.add_argument("--baseline-library-dir", type=Path, action="append", default=[])
    parser.add_argument("--candidate-library-dir", type=Path, action="append", default=[])
    parser.add_argument("--baseline-driver-dir", type=Path, action="append", default=[])
    parser.add_argument("--candidate-driver-dir", type=Path, action="append", default=[])
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--trials", type=int, default=5, choices=range(1, 6), metavar="1..5")
    parser.add_argument("--timeout-seconds", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--sample-interval-ms", type=int, default=DEFAULT_SAMPLE_INTERVAL_MS)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--fixture-source", default="unspecified")
    parser.add_argument("--fixture-license", default="unspecified")
    parser.add_argument("--fixture-revision", default="unspecified")
    parser.add_argument("--candidate-model-revision", default="0bbb45a3365852604aef28b538a8f066f4ccaa85")
    parser.add_argument("--vad-revision", default="b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6")
    parser.add_argument("--baseline-model-size", default="small", choices=tuple(WHISPER_BASELINES), help="Whisper baseline size. Defaults to small; medium is the alternate pinned cache.")
    parser.add_argument("--preflight-only", action="store_true", help="Validate host, managed Whisper, candidate, and fixture inputs without inference.")
    args = parser.parse_args(argv)
    if args.timeout_seconds <= 0 or args.sample_interval_ms <= 0:
        parser.error("timeout and sampling interval must be positive")
    return QualificationArgs(
        fixture=args.fixture, reference=args.reference, baseline_python=args.baseline_python, candidate_python=args.candidate_python,
        baseline_model_dir=args.baseline_model_dir, candidate_model_dir=args.candidate_model_dir, candidate_vad_dir=args.candidate_vad_dir,
        baseline_library_dirs=args.baseline_library_dir, candidate_library_dirs=args.candidate_library_dir,
        baseline_driver_dirs=args.baseline_driver_dir, candidate_driver_dirs=args.candidate_driver_dir, output_dir=args.output_dir,
        trials=args.trials, timeout_seconds=args.timeout_seconds, sample_interval_ms=args.sample_interval_ms, ffmpeg=args.ffmpeg,
        fixture_source=args.fixture_source, fixture_license=args.fixture_license, fixture_revision=args.fixture_revision,
        candidate_model_revision=args.candidate_model_revision, vad_revision=args.vad_revision, preflight_only=args.preflight_only,
        baseline_model_size=args.baseline_model_size,
    )


def _whisper_baseline(model_size: str) -> dict[str, str]:
    try:
        return WHISPER_BASELINES[model_size]
    except KeyError as exc:
        raise ValueError(f"unsupported_whisper_baseline:{model_size}") from exc


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    report = run_preflight(args) if args.preflight_only else run_benchmark(args)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    decision = report.get("decision", {})
    status = report.get("status") if args.preflight_only else report.get("preflight", {}).get("status")
    print(json.dumps({"status": status, "decision": decision.get("classification"), "report_version": REPORT_VERSION}, sort_keys=True))
    return 0 if status == "ready" else 2


if __name__ == "__main__":
    raise SystemExit(main())
