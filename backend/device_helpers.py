"""Pure helpers for audio device enumeration normalization."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, MutableMapping, Optional, Tuple

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

PULSE_INVALID_SINK_INDEX = 0xFFFFFFFF
PULSE_SOURCE_ID_PREFIX = "pulse-source:"
PULSE_MONITOR_ID_PREFIX = "pulse-monitor:"
PULSE_SINK_ID_PREFIX = "pulse-sink:"
LINUX_DESKTOP_OFF_DEVICE_ID = "none"


def is_blocked_windows_device_name(name: str) -> bool:
    return any(blocked in str(name or "") for blocked in WINDOWS_BLOCKED_DEVICE_NAME_FRAGMENTS)


def format_pulse_source_id(source_name: str) -> str:
    return f"{PULSE_SOURCE_ID_PREFIX}{source_name}"


def format_pulse_monitor_id(monitor_source_name: str) -> str:
    return f"{PULSE_MONITOR_ID_PREFIX}{monitor_source_name}"


def format_pulse_sink_id(sink_name: str) -> str:
    return f"{PULSE_SINK_ID_PREFIX}{sink_name}"


def is_linux_desktop_off_id(device_id: Any) -> bool:
    return str(device_id) == LINUX_DESKTOP_OFF_DEVICE_ID


def parse_pulse_device_id(device_id: Any) -> Optional[Tuple[str, str]]:
    value = str(device_id or "")
    if value.startswith(PULSE_SOURCE_ID_PREFIX):
        name = value[len(PULSE_SOURCE_ID_PREFIX):]
        return ("source", name) if name else None
    if value.startswith(PULSE_MONITOR_ID_PREFIX):
        name = value[len(PULSE_MONITOR_ID_PREFIX):]
        return ("monitor", name) if name else None
    if value.startswith(PULSE_SINK_ID_PREFIX):
        name = value[len(PULSE_SINK_ID_PREFIX):]
        return ("sink", name) if name else None
    return None


def is_pulse_monitor_source(source: Any) -> bool:
    monitor_of = getattr(source, "monitor_of_sink", None)
    if monitor_of is None:
        return bool(getattr(source, "monitor_of_sink_name", None))
    try:
        return int(monitor_of) != PULSE_INVALID_SINK_INDEX
    except (TypeError, ValueError):
        return bool(getattr(source, "monitor_of_sink_name", None))


_PULSE_PORT_UNAVAILABLE_TOKENS = frozenset({"no", "unavailable"})


def is_pulse_port_unavailable(port: Any) -> bool:
    """True only when Pulse reports the port as explicitly unavailable.

    pulsectl exposes ``available`` as ``pulsectl.EnumValue`` from
    ``PulsePortAvailableEnum`` (unknown=0, no=1, yes=2). Unknown / missing
    jack-detect stays usable — hiding those would drop analog devices that
    never report plug state.

    ``EnumValue`` is the shape this actually sees in production and it is
    deliberately awkward: ``__slots__`` is ``('_t', '_value', '_c_val')`` so it
    has no ``.name``, it is not an ``int`` subclass, and ``repr()`` is
    ``<EnumValue available=no>`` — so a ``str()``-and-split probe never matches.
    What it *does* implement is ``__eq__`` against native strings, which is the
    only reliable comparison. Read ``_value`` first, then fall back to that
    equality check; keep both so a future pulsectl rename cannot silently
    reintroduce an always-False probe.
    """
    if port is None:
        return False
    available = getattr(port, "available", None)
    if available is None:
        available = getattr(port, "available_state", None)
    if available is None:
        return False

    # pulsectl.EnumValue: the underlying token lives in the private _value slot.
    value = getattr(available, "_value", None)
    if isinstance(value, str):
        return value.lower() in _PULSE_PORT_UNAVAILABLE_TOKENS

    name = getattr(available, "name", None)
    if isinstance(name, str):
        return name.lower() in _PULSE_PORT_UNAVAILABLE_TOKENS
    if isinstance(available, bool):
        return False
    if isinstance(available, (int, float)):
        return int(available) == 1
    if isinstance(available, str):
        return available.rsplit(".", 1)[-1].lower() in _PULSE_PORT_UNAVAILABLE_TOKENS

    # EnumValue.__eq__ compares against native strings; anything that opts into
    # that protocol is answered correctly here even without a readable _value.
    for token in _PULSE_PORT_UNAVAILABLE_TOKENS:
        try:
            if available == token:
                return True
        except Exception:  # noqa: BLE001 - exotic __eq__ must not break enumerate
            break
    return str(available).rsplit(".", 1)[-1].lower() in _PULSE_PORT_UNAVAILABLE_TOKENS


def is_pulse_endpoint_unavailable(info: Any) -> bool:
    """True when a sink or source's active port is explicitly unplugged."""
    return is_pulse_port_unavailable(getattr(info, "port_active", None))


def build_device_record(
    *,
    device_id: int | str,
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
