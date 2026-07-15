"""Exact-token stdin command parsing for platform recorders.

Electron writes ``stop\\n`` or ``cancel\\n``. Substring matching is unsafe
because ``cancel`` must never trigger finalize, and tokens like ``stopgap``
must not match ``stop``.
"""

from __future__ import annotations

from typing import Optional

RECORDER_STDIN_STOP = "stop"
RECORDER_STDIN_CANCEL = "cancel"
_VALID_COMMANDS = frozenset({RECORDER_STDIN_STOP, RECORDER_STDIN_CANCEL})


def parse_recorder_stdin_command(line: str) -> Optional[str]:
    """Return ``stop`` / ``cancel`` for an exact token line, else None."""
    if not isinstance(line, str):
        return None
    token = line.strip().lower()
    if token in _VALID_COMMANDS:
        return token
    return None


def resolve_post_exception_capture_action(
    *,
    cancel_requested: bool,
    recording_cancelled: bool,
) -> str:
    """Decide capture cleanup after an outer recorder exception.

    Returns:
      - ``\"cancel\"``: attempt discard (never finalize)
      - ``\"stop\"``: best-effort finalize / recover audio
      - ``\"noop\"``: cancel already completed; do not finalize
    """
    if recording_cancelled:
        return "noop"
    if cancel_requested:
        return "cancel"
    return "stop"
