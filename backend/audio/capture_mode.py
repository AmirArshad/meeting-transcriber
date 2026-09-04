"""Closed capture-mode contract shared by platform recorders."""

from __future__ import annotations

CAPTURE_MODES = frozenset({"mic-and-desktop", "mic-only", "desktop-only"})

#: Stop-time failure message shared by every platform recorder when a
#: desktop-only capture committed no usable desktop frames. There is no second
#: source to degrade onto, so this is terminal rather than a warning, and the
#: copy must never imply microphone audio was captured or saved.
DESKTOP_ONLY_NO_AUDIO_MESSAGE = (
    "Desktop-only capture did not produce usable desktop audio. "
    "Confirm system audio is playing through the selected desktop source."
)


class CaptureModeError(ValueError):
    """Raised when a recorder receives an unsupported capture mode."""


def resolve_capture_mode(capture_mode: str) -> tuple[bool, bool]:
    """Return ``(include_mic, include_desktop)`` for a validated mode."""
    if capture_mode not in CAPTURE_MODES:
        raise CaptureModeError(f"Invalid capture mode: {capture_mode!r}")
    return capture_mode != "desktop-only", capture_mode != "mic-only"
