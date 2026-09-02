"""Probe CUDA runtime compatibility for the packaged transcription stack."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterable
from typing import Any

from .nvidia_dll_loader import add_python_nvidia_bin_dirs_to_path


add_python_nvidia_bin_dirs_to_path()


def classify_cuda_probe_status(
    *,
    device_available: bool,
    runtime_loadable: bool,
    missing_libraries: list[str],
    unsupported_detected_profiles: list[str],
) -> str:
    if device_available and runtime_loadable:
        return "ready"
    if unsupported_detected_profiles:
        return "unsupportedRuntimeMajor"
    if device_available and missing_libraries:
        return "missingLibraries"
    if not device_available:
        return "deviceUnavailable"
    return "runtimeUnavailable"


def _iter_unique_search_dirs(path_value: str) -> Iterable[str]:
    seen: set[str] = set()
    for raw_part in str(path_value or "").split(os.pathsep):
        part = raw_part.strip()
        if not part or part in seen:
            continue
        seen.add(part)
        yield part


def find_unsupported_runtime_profiles(
    unsupported_hints: list[dict[str, Any]],
    *,
    path_value: str | None = None,
    listdir: Callable[[str], list[str]] | Callable[[str], list[Any]] = os.listdir,
    isdir: Callable[[str], bool] = os.path.isdir,
) -> list[str]:
    search_path = os.environ.get("PATH", "") if path_value is None else path_value
    search_dirs = [part for part in _iter_unique_search_dirs(search_path) if isdir(part)]
    detected: list[str] = []

    for hint in unsupported_hints:
        profile_id = str(hint.get("id") or "").strip()
        prefixes = [
            str(prefix).lower()
            for prefix in hint.get("expectedDllPrefixes", [])
            if prefix
        ]
        if not profile_id or not prefixes:
            continue

        found = False
        for folder in search_dirs:
            try:
                names = listdir(folder)
            except Exception:
                continue

            for name in names:
                lower_name = str(name).lower()
                if not (lower_name.endswith(".dll") or ".so" in lower_name):
                    continue
                if any(lower_name.startswith(prefix) for prefix in prefixes):
                    found = True
                    break
            if found:
                break

        if found:
            detected.append(profile_id)

    return detected


class NvidiaSmiProbeError(Exception):
    """Structured NVIDIA-device probe failure that must surface as probeError."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


def _load_windows_dll(dll_name: str) -> Any:
    return ctypes.WinDLL(dll_name)  # type: ignore[attr-defined]


def _load_linux_shared_library(library_name: str) -> Any:
    return ctypes.CDLL(library_name)


def probe_nvidia_smi_devices(
    *,
    runner: Callable[..., Any] | None = None,
    timeout: int = 10,
) -> list[dict[str, str]]:
    """Return structured NVIDIA GPU rows from an approved nvidia-smi query."""
    command = [
        "nvidia-smi",
        "--query-gpu=name,driver_version,compute_cap",
        "--format=csv,noheader",
    ]
    run = runner or subprocess.run
    try:
        result = run(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError as exc:
        raise NvidiaSmiProbeError("missing_executable", "nvidia-smi was not found on PATH.") from exc
    except subprocess.TimeoutExpired as exc:
        raise NvidiaSmiProbeError("timeout", "nvidia-smi timed out.") from exc
    except OSError as exc:
        raise NvidiaSmiProbeError("missing_executable", str(exc)) from exc

    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise NvidiaSmiProbeError(
            "nonzero_exit",
            f"nvidia-smi exited with code {result.returncode}" + (f": {stderr}" if stderr else "."),
        )

    devices: list[dict[str, str]] = []
    for raw_line in (result.stdout or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 3 or not parts[0] or not parts[1] or not parts[2]:
            raise NvidiaSmiProbeError("malformed_output", f"Unexpected nvidia-smi row: {line}")
        devices.append({
            "name": parts[0],
            "driverVersion": parts[1],
            "computeCapability": parts[2],
        })
    return devices


def _get_nvidia_smi_device_count() -> int:
    """Probe the NVIDIA driver, independently from managed CUDA wheel loading."""
    return len(probe_nvidia_smi_devices())


def _get_ctranslate2_cuda_device_count() -> int:
    import ctranslate2  # imported lazily so tests can run without CUDA runtime DLLs

    return int(ctranslate2.get_cuda_device_count())


def _validate_ctranslate2_cuda() -> None:
    import ctranslate2  # imported lazily so tests can run without CUDA runtime DLLs

    int(ctranslate2.get_cuda_device_count())


def build_probe_report(
    *,
    profiles: list[dict[str, Any]],
    supported_profiles: list[str],
    unsupported_hints: list[dict[str, Any]],
    device_count_getter: Callable[[], int] | None = None,
    load_dll: Callable[[str], Any] | None = None,
    path_value: str | None = None,
    listdir: Callable[[str], list[str]] | Callable[[str], list[Any]] = os.listdir,
    isdir: Callable[[str], bool] = os.path.isdir,
    platform: str = "win32",
    validate_ctranslate2_cuda: bool = False,
    ctranslate2_validator: Callable[[], None] | None = None,
    device_probe: dict[str, Any] | None = None,
) -> dict[str, Any]:
    probe_error = ""
    status_override = ""
    get_device_count = device_count_getter or _get_ctranslate2_cuda_device_count
    dll_loader = load_dll or (_load_linux_shared_library if platform.startswith("linux") else _load_windows_dll)
    resolved_device_probe = device_probe

    try:
        device_count = get_device_count()
    except NvidiaSmiProbeError as exc:
        device_count = 0
        probe_error = str(exc)
        status_override = "probeError"
    except Exception as exc:
        device_count = 0
        probe_error = str(exc)

    profile_missing: dict[str, list[str]] = {}
    for profile in profiles:
        profile_id = str(profile.get("id") or "").strip()
        if not profile_id:
            continue
        missing: list[str] = []
        for dll in profile.get("requiredDlls", []):
            dll_name = str(dll)
            try:
                dll_loader(dll_name)
            except Exception:
                missing.append(dll_name)
        profile_missing[profile_id] = missing

    matched_profile = ""
    missing_libraries: list[str] = []
    for profile_id in supported_profiles:
        current_missing = profile_missing.get(profile_id, [])
        if not current_missing:
            matched_profile = profile_id
            break
        if not missing_libraries:
            missing_libraries = current_missing

    runtime_loadable = bool(matched_profile)
    if validate_ctranslate2_cuda and runtime_loadable:
        validator = ctranslate2_validator or _validate_ctranslate2_cuda
        try:
            validator()
        except Exception as exc:
            runtime_loadable = False
            matched_profile = ""
            probe_error = str(exc)

    unsupported_detected_profiles = find_unsupported_runtime_profiles(
        unsupported_hints,
        path_value=path_value,
        listdir=listdir,
        isdir=isdir,
    )
    installed_profile = matched_profile or (unsupported_detected_profiles[0] if unsupported_detected_profiles else "")
    status_code = status_override or classify_cuda_probe_status(
        device_available=device_count > 0,
        runtime_loadable=runtime_loadable,
        missing_libraries=missing_libraries,
        unsupported_detected_profiles=unsupported_detected_profiles,
    )

    report = {
        "deviceAvailable": device_count > 0,
        "runtimeLoadable": runtime_loadable,
        "missingLibraries": missing_libraries,
        "runtime": "ctranslate2",
        "matchedProfile": matched_profile,
        "installedProfile": installed_profile,
        "unsupportedDetectedProfiles": unsupported_detected_profiles,
        "supportedProfiles": supported_profiles,
        "recommendedInstallProfile": supported_profiles[0] if supported_profiles else "",
        "statusCode": status_code,
        "error": probe_error,
    }
    if resolved_device_probe is not None:
        report["deviceProbe"] = resolved_device_probe
    return report


def _print_report(report: dict[str, Any]) -> None:
    # Single JSON object — avoids fragile key:value line parsing when error
    # messages contain newlines or look like probe keys.
    print(json.dumps(report, separators=(",", ":")), flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe AvaNevis transcription CUDA runtime compatibility.")
    parser.add_argument("--profiles-json", required=True)
    parser.add_argument("--supported-profiles", required=True)
    parser.add_argument("--unsupported-hints-json", required=True)
    parser.add_argument("--platform", default=sys.platform)
    parser.add_argument("--device-check", choices=["ctranslate2", "nvidia-smi"], default="ctranslate2")
    parser.add_argument("--library-search-dirs-json", default="")
    parser.add_argument("--validate-ctranslate2-cuda", action="store_true")
    args = parser.parse_args(argv)

    profiles = json.loads(args.profiles_json)
    supported_profiles = [item.strip() for item in args.supported_profiles.split(",") if item.strip()]
    unsupported_hints = json.loads(args.unsupported_hints_json)
    # When the caller supplies --library-search-dirs-json, even as [], search
    # only those directories. Falling back to ambient PATH would let an
    # unsupported CUDA major on PATH masquerade as the managed runtime.
    path_value = None
    if args.library_search_dirs_json:
        parsed_dirs = json.loads(args.library_search_dirs_json)
        path_value = os.pathsep.join(str(item) for item in parsed_dirs if item)

    device_probe = None
    nvidia_smi_error: NvidiaSmiProbeError | None = None
    nvidia_smi_devices: list[dict[str, str]] | None = None
    if args.device_check == "nvidia-smi":
        try:
            nvidia_smi_devices = probe_nvidia_smi_devices()
            device_probe = {
                "devices": nvidia_smi_devices,
                "driverVersion": nvidia_smi_devices[0]["driverVersion"] if nvidia_smi_devices else "",
            }
        except NvidiaSmiProbeError as exc:
            nvidia_smi_error = exc

        def device_count_getter() -> int:
            if nvidia_smi_error is not None:
                raise nvidia_smi_error
            return len(nvidia_smi_devices or [])
    else:
        device_count_getter = None

    _print_report(build_probe_report(
        profiles=profiles,
        supported_profiles=supported_profiles,
        unsupported_hints=unsupported_hints,
        device_count_getter=device_count_getter,
        path_value=path_value,
        platform=args.platform,
        validate_ctranslate2_cuda=args.validate_ctranslate2_cuda,
        device_probe=device_probe,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
