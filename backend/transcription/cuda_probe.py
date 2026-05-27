"""Probe CUDA runtime compatibility for the packaged transcription stack."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
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
                if not lower_name.endswith(".dll"):
                    continue
                if any(lower_name.startswith(prefix) for prefix in prefixes):
                    found = True
                    break
            if found:
                break

        if found:
            detected.append(profile_id)

    return detected


def _load_windows_dll(dll_name: str) -> Any:
    return ctypes.WinDLL(dll_name)  # type: ignore[attr-defined]


def _get_ctranslate2_cuda_device_count() -> int:
    import ctranslate2  # imported lazily so tests can run without CUDA runtime DLLs

    return int(ctranslate2.get_cuda_device_count())


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
) -> dict[str, Any]:
    probe_error = ""
    get_device_count = device_count_getter or _get_ctranslate2_cuda_device_count
    dll_loader = load_dll or _load_windows_dll

    try:
        device_count = get_device_count()
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
    unsupported_detected_profiles = find_unsupported_runtime_profiles(
        unsupported_hints,
        path_value=path_value,
        listdir=listdir,
        isdir=isdir,
    )
    installed_profile = matched_profile or (unsupported_detected_profiles[0] if unsupported_detected_profiles else "")
    status_code = classify_cuda_probe_status(
        device_available=device_count > 0,
        runtime_loadable=runtime_loadable,
        missing_libraries=missing_libraries,
        unsupported_detected_profiles=unsupported_detected_profiles,
    )

    return {
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


def _print_report(report: dict[str, Any]) -> None:
    print(f"deviceAvailable:{report['deviceAvailable']}")
    print(f"runtimeLoadable:{report['runtimeLoadable']}")
    print(f"missingLibraries:{','.join(report['missingLibraries'])}")
    print(f"runtime:{report['runtime']}")
    print(f"matchedProfile:{report['matchedProfile']}")
    print(f"installedProfile:{report['installedProfile']}")
    print(f"unsupportedDetectedProfiles:{','.join(report['unsupportedDetectedProfiles'])}")
    print(f"supportedProfiles:{','.join(report['supportedProfiles'])}")
    print(f"recommendedInstallProfile:{report['recommendedInstallProfile']}")
    print(f"statusCode:{report['statusCode']}")
    print(f"error:{report['error']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Probe AvaNevis transcription CUDA runtime compatibility.")
    parser.add_argument("--profiles-json", required=True)
    parser.add_argument("--supported-profiles", required=True)
    parser.add_argument("--unsupported-hints-json", required=True)
    args = parser.parse_args(argv)

    profiles = json.loads(args.profiles_json)
    supported_profiles = [item.strip() for item in args.supported_profiles.split(",") if item.strip()]
    unsupported_hints = json.loads(args.unsupported_hints_json)
    _print_report(build_probe_report(
        profiles=profiles,
        supported_profiles=supported_profiles,
        unsupported_hints=unsupported_hints,
    ))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
