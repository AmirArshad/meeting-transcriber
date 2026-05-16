"""Helpers for resolving a local llama.cpp summary runtime.

This module is intentionally deterministic and side-effect-light. It does not
download models or start inference; it validates the paths and arguments the
future generation runner will use.
"""

from __future__ import annotations

import platform as platform_module
import subprocess
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional


LLAMA_CONTEXT_TOKENS = 32768
DEFAULT_GPU_LAYERS = -1


class SummaryRuntimeError(ValueError):
    """Raised when the local summary runtime cannot be resolved safely."""


def normalize_platform(system: Optional[str] = None, machine: Optional[str] = None) -> Dict[str, str]:
    raw_system = (system or platform_module.system()).lower()
    raw_machine = (machine or platform_module.machine()).lower()

    if raw_system.startswith("windows"):
        os_name = "win32"
    elif raw_system == "darwin":
        os_name = "darwin"
    else:
        os_name = raw_system or "unknown"

    if raw_machine in ("amd64", "x86_64"):
        arch = "x64"
    elif raw_machine in ("arm64", "aarch64"):
        arch = "arm64"
    else:
        arch = raw_machine or "unknown"

    return {"platform": os_name, "arch": arch}


def get_platform_acceleration(platform: str, arch: str) -> str:
    if platform == "win32" and arch == "x64":
        return "cuda"
    if platform == "darwin" and arch == "arm64":
        return "metal"
    return "unsupported"


def default_llama_executable_name(platform: str) -> str:
    return "llama-cli.exe" if platform == "win32" else "llama-cli"


def resolve_llama_runtime(
    *,
    runtime_dir: str,
    model_path: str,
    platform: Optional[str] = None,
    arch: Optional[str] = None,
) -> Dict[str, Any]:
    normalized = normalize_platform(platform, arch)
    acceleration = get_platform_acceleration(normalized["platform"], normalized["arch"])
    if acceleration == "unsupported":
        raise SummaryRuntimeError("Local summaries are not supported on this platform.")

    executable = Path(runtime_dir) / default_llama_executable_name(normalized["platform"])
    model = Path(model_path)

    if normalized["platform"] == "darwin":
        # GitHub's llama.cpp macOS tarballs keep dylibs beside llama-cli in a
        # versioned subdirectory. Preserve that layout by letting dyld resolve
        # libraries from the executable directory.
        nested_executable = next(Path(runtime_dir).glob(f"llama-*/{executable.name}"), None)
        if nested_executable:
            executable = nested_executable

    if not executable.exists():
        raise SummaryRuntimeError(f"llama.cpp runtime not found: {executable}")
    if not model.exists():
        raise SummaryRuntimeError(f"Summary model file not found: {model}")

    return {
        "runtime": "llama.cpp",
        "platform": normalized["platform"],
        "arch": normalized["arch"],
        "acceleration": acceleration,
        "executable": str(executable),
        "modelPath": str(model),
        "contextTokens": LLAMA_CONTEXT_TOKENS,
        "gpuLayers": DEFAULT_GPU_LAYERS,
    }


def build_llama_cli_args(
    runtime: Dict[str, Any],
    *,
    prompt_path: str,
    temperature: float = 0.1,
    max_tokens: int = 2048,
) -> List[str]:
    if not runtime.get("executable") or not runtime.get("modelPath"):
        raise SummaryRuntimeError("Resolved llama.cpp runtime must include executable and modelPath.")
    if max_tokens <= 0:
        raise SummaryRuntimeError("max_tokens must be greater than 0.")

    return [
        str(runtime["executable"]),
        "--model",
        str(runtime["modelPath"]),
        "--file",
        str(prompt_path),
        "--ctx-size",
        str(runtime.get("contextTokens") or LLAMA_CONTEXT_TOKENS),
        "--n-gpu-layers",
        str(runtime.get("gpuLayers", DEFAULT_GPU_LAYERS)),
        "--temp",
        str(temperature),
        "--predict",
        str(max_tokens),
        "--no-display-prompt",
    ]


def run_llama_prompt(
    runtime: Dict[str, Any],
    *,
    prompt_path: str,
    max_tokens: int,
    timeout_seconds: int = 900,
) -> str:
    args = build_llama_cli_args(runtime, prompt_path=prompt_path, max_tokens=max_tokens)
    result = subprocess.run(args, capture_output=True, text=True, check=False, timeout=timeout_seconds)
    if result.returncode != 0:
        raise SummaryRuntimeError("llama.cpp summary generation failed.")
    return result.stdout.strip()


def smoke_test_llama_runtime(runtime: Dict[str, Any], *, timeout_seconds: int = 30) -> None:
    executable = runtime.get("executable")
    if not executable:
        raise SummaryRuntimeError("Resolved llama.cpp runtime must include executable.")

    result = subprocess.run([str(executable), "--help"], capture_output=True, text=True, check=False, timeout=timeout_seconds)
    combined = f"{result.stdout}\n{result.stderr}".lower()
    if result.returncode != 0 or "llama" not in combined:
        raise SummaryRuntimeError("llama.cpp runtime smoke validation failed.")


def build_summary_progress_event(
    *,
    meeting_id: str,
    phase: str,
    message: str,
    chunk_index: Optional[int] = None,
    chunk_total: Optional[int] = None,
) -> Dict[str, Any]:
    event: Dict[str, Any] = {
        "meetingId": str(meeting_id),
        "phase": str(phase),
        "message": str(message),
    }
    if chunk_index is not None:
        event["chunkIndex"] = int(chunk_index)
    if chunk_total is not None:
        event["chunkTotal"] = int(chunk_total)
    return event
