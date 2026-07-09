"""Pure helpers for audio device enumeration normalization."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, MutableMapping

WINDOWS_BLOCKED_DEVICE_NAME_FRAGMENTS = (
    "Microsoft Sound Mapper",
    "Primary Sound Capture Driver",
    "Primary Sound Driver",
)

MACOS_SCREENCAPTURE_LOOPBACK_DEVICE = {
    "id": -1,
    "name": "System Audio (ScreenCaptureKit)",
    "channels": 2,
    "sample_rate": 48000,
    "host_api": "ScreenCaptureKit",
}


def is_blocked_windows_device_name(name: str) -> bool:
    return any(blocked in str(name or "") for blocked in WINDOWS_BLOCKED_DEVICE_NAME_FRAGMENTS)


def build_device_record(
    *,
    device_id: int,
    name: str,
    channels: int,
    sample_rate: int,
    host_api: str,
) -> Dict[str, Any]:
    return {
        "id": device_id,
        "name": name,
        "channels": channels,
        "sample_rate": int(sample_rate),
        "host_api": host_api,
    }


def dedupe_device_by_name(
    seen: MutableMapping[str, Dict[str, Any]],
    candidate: Dict[str, Any],
) -> None:
    """Keep unique device names, preferring the higher sample rate on collision."""
    name = str(candidate.get("name") or "")
    if name not in seen:
        seen[name] = candidate
        return
    if int(candidate.get("sample_rate") or 0) > int(seen[name].get("sample_rate") or 0):
        seen[name] = candidate


def sort_devices_by_name(devices: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(list(devices), key=lambda item: item.get("name") or "")


def macos_virtual_loopback_devices() -> List[Dict[str, Any]]:
    return [dict(MACOS_SCREENCAPTURE_LOOPBACK_DEVICE)]
