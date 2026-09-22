#!/usr/bin/env python3
"""Fresh-process engine worker for parakeet_qualification.py.

Only this process imports faster-whisper, onnxruntime, or onnx-asr. It emits a
single aggregate JSON object on stdout; raw transcript text exists only in the
parent's private scratch buffer and is never placed in the public report.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import platform
import re
import sys
import time
import wave
from pathlib import Path
from typing import Any


def _duration(path: Path) -> float:
    with wave.open(str(path), "rb") as reader:
        return reader.getnframes() / reader.getframerate()


def _loaded_library_names() -> list[str]:
    names: set[str] = set()
    try:
        lines = Path("/proc/self/maps").read_text(encoding="ascii").splitlines()
    except OSError:
        return []
    for line in lines:
        path = line.rsplit(" ", 1)[-1]
        if "/" not in path or ".so" not in path:
            continue
        name = Path(path).name
        if any(token in name.lower() for token in ("cuda", "cublas", "cudnn", "onnxruntime")):
            names.add(name)
    return sorted(names)


def _session_provider_names(*objects: Any) -> list[str]:
    providers: set[str] = set()
    for obj in objects:
        if obj is None:
            continue
        try:
            getter = getattr(obj, "get_providers", None)
            if callable(getter):
                providers.update(str(item) for item in getter())
        except Exception:
            continue
        for attr in ("_model", "_encoder", "_decoder_joint", "_preprocessor"):
            try:
                nested = getattr(obj, attr, None)
                getter = getattr(nested, "get_providers", None)
                if callable(getter):
                    providers.update(str(item) for item in getter())
            except Exception:
                continue
    return sorted(providers)


def _failure(layer: str, code: str) -> dict[str, Any]:
    return {"outcome": "failed", "failure": {"layer": layer, "code": code}}


def _run_preflight(args: argparse.Namespace) -> dict[str, Any]:
    try:
        import onnxruntime as ort
        import onnx_asr
    except Exception:
        return {"status": "failed", "code": "candidate_import_failed"}
    available = [str(item) for item in ort.get_available_providers()]
    if "CUDAExecutionProvider" not in available:
        return {"status": "failed", "code": "cuda_execution_provider_unavailable", "available_providers": available}
    try:
        vad = onnx_asr.load_vad("silero", path=args.candidate_vad, providers=["CUDAExecutionProvider"])
        providers = _session_provider_names(vad)
    except Exception:
        return {"status": "failed", "code": "vad_cuda_session_failed", "available_providers": available}
    if "CUDAExecutionProvider" not in providers:
        return {"status": "failed", "code": "vad_cuda_provider_not_selected", "available_providers": available, "session_providers": providers}
    loaded = _loaded_library_names()
    if not any(name.startswith("libcublas.so.12") for name in loaded) or not any(name.startswith("libcudnn.so.9") for name in loaded):
        return {"status": "failed", "code": "candidate_cuda12_libraries_not_loaded", "available_providers": available, "session_providers": providers}
    return {
        "status": "ready", "onnx_asr_version": getattr(onnx_asr, "__version__", "unknown"),
        "onnxruntime_version": getattr(ort, "__version__", "unknown"), "available_providers": available,
        "session_providers": providers, "loaded_cuda_libraries": loaded,
    }


def _run_whisper(args: argparse.Namespace) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        from backend.transcription.faster_whisper_transcriber import TranscriberService
    except Exception:
        return _failure("managed_whisper", "whisper_import_failed")
    try:
        transcriber = TranscriberService(model_size="small", language="en", device=args.device, compute_type=args.compute_type)
        load_start = time.perf_counter()
        transcriber.load_model()
        load_ms = (time.perf_counter() - load_start) * 1000.0
        decode_start = time.perf_counter()
        result = transcriber._run_transcription_attempt(str(args.fixture))
        decode_ms = (time.perf_counter() - decode_start) * 1000.0
        result["device"] = transcriber.device
        result["computeType"] = transcriber.compute_type
        result["outcome"] = "success"
        result["load_ms"] = load_ms
        result["decode_ms"] = decode_ms
        result["timestamp_diagnostics"] = _segment_timestamp_diagnostics(result.get("segments", []), _duration(args.fixture))
        result["runtime"] = {"backend": "faster-whisper", "version": "1.2.1", "ctranslate2": "4.8.1"}
        result["worker_elapsed_ms"] = (time.perf_counter() - started) * 1000.0
        return result
    except Exception:
        return _failure("managed_whisper", "whisper_cuda_trial_failed")


def _segment_timestamp_diagnostics(segments: list[dict[str, Any]], duration: float) -> dict[str, int]:
    invalid = 0
    out_of_order = 0
    previous = -math.inf
    for segment in segments:
        try:
            start = float(segment["start"])
            end = float(segment["end"])
        except (KeyError, TypeError, ValueError):
            invalid += 1
            continue
        if start < 0 or end < start or end > duration + 0.05:
            invalid += 1
        if start < previous:
            out_of_order += 1
        previous = start
    return {"invalid_timestamps": invalid, "out_of_order_timestamps": out_of_order, "out_of_bounds_intervals": invalid}


def _run_parakeet(args: argparse.Namespace) -> dict[str, Any]:
    started = time.perf_counter()
    try:
        import onnxruntime as ort
        import onnx_asr
    except Exception:
        return _failure("candidate_runtime", "candidate_import_failed")
    available = [str(item) for item in ort.get_available_providers()]
    if "CUDAExecutionProvider" not in available:
        return _failure("candidate_runtime", "cuda_execution_provider_unavailable")
    try:
        load_start = time.perf_counter()
        vad = onnx_asr.load_vad("silero", path=args.candidate_vad, providers=["CUDAExecutionProvider"])
        model = onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v2", path=args.candidate_model, providers=["CUDAExecutionProvider"],
        )
        model = model.with_vad(vad, batch_size=1, min_silence_duration_ms=500, max_speech_duration_s=20).with_timestamps()
        load_ms = (time.perf_counter() - load_start) * 1000.0
        decode_start = time.perf_counter()
        segments: list[dict[str, Any]] = []
        timestamp_diagnostics = {"invalid_timestamps": 0, "out_of_order_timestamps": 0, "out_of_bounds_intervals": 0}
        duration = _duration(args.fixture)
        results = model.recognize(str(args.fixture), language="en")
        for result in results:
            token_starts = list(result.timestamps or [])
            segment = {"start": float(result.start), "end": float(result.end), "text": str(result.text).strip()}
            segments.append(segment)
            _intervals, diagnostics = _token_intervals(
                segment["start"], segment["end"], token_starts, duration,
            )
            for name, value in diagnostics.items():
                timestamp_diagnostics[name] += value
        decode_ms = (time.perf_counter() - decode_start) * 1000.0
        providers = _session_provider_names(model, getattr(model, "asr", None), vad)
        loaded = _loaded_library_names()
        if "CUDAExecutionProvider" not in providers:
            return _failure("candidate_runtime", "candidate_session_not_using_cuda")
        if not any(name.startswith("libcublas.so.12") for name in loaded) or not any(name.startswith("libcudnn.so.9") for name in loaded):
            return _failure("candidate_runtime", "candidate_cuda12_libraries_not_loaded")
        text = " ".join(segment["text"] for segment in segments).strip()
        return {
            "outcome": "success", "text": text, "segments": segments, "duration": duration,
            "device": "cuda", "computeType": "fp32", "load_ms": load_ms, "decode_ms": decode_ms,
            "timestamp_diagnostics": timestamp_diagnostics,
            "runtime": {"backend": "onnx-asr", "onnx_asr": getattr(onnx_asr, "__version__", "unknown"), "onnxruntime": getattr(ort, "__version__", "unknown"), "providers": providers, "loaded_cuda_libraries": loaded},
            "worker_elapsed_ms": (time.perf_counter() - started) * 1000.0,
        }
    except Exception:
        return _failure("candidate_runtime", "candidate_cuda_trial_failed")


def _token_intervals(segment_start: float, segment_end: float, token_starts: list[float], duration: float) -> tuple[list[tuple[float, float]], dict[str, int]]:
    diagnostics = {"invalid_timestamps": 0, "out_of_order_timestamps": 0, "out_of_bounds_intervals": 0}
    previous = -math.inf
    absolute: list[float] = []
    for raw in token_starts:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            diagnostics["invalid_timestamps"] += 1
            continue
        if not math.isfinite(value) or value < 0 or value > segment_end - segment_start + 0.05:
            diagnostics["invalid_timestamps"] += 1
            continue
        if value < previous:
            diagnostics["out_of_order_timestamps"] += 1
        previous = value
        absolute.append(segment_start + value)
    intervals: list[tuple[float, float]] = []
    for index, start in enumerate(absolute):
        end = absolute[index + 1] if index + 1 < len(absolute) else segment_end
        if start < 0 or end < start or end > duration + 0.05:
            diagnostics["out_of_bounds_intervals"] += 1
            continue
        intervals.append((start, end))
    return intervals, diagnostics


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fresh-process Parakeet qualification engine worker.")
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--engine", choices=("whisper", "parakeet"))
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--candidate-model", type=Path)
    parser.add_argument("--candidate-vad", type=Path)
    args = parser.parse_args(argv)
    if args.preflight:
        payload = _run_preflight(args)
    elif args.engine == "whisper" and args.fixture:
        payload = _run_whisper(args)
    elif args.engine == "parakeet" and args.fixture:
        payload = _run_parakeet(args)
    else:
        payload = _failure("benchmark", "worker_arguments_invalid")
    print(json.dumps(payload, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
