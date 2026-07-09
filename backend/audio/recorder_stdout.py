"""Shared structured stdout emitters for platform recorders.

Recorder control flow uses stdout JSON only (`levels`, `event`, `warning`,
`error`). stderr must remain debug-only. Keep emitted shapes byte-stable —
Electron parses these in the main process.
"""

from __future__ import annotations

import json
import threading
from typing import Any, Callable, Dict, Optional

# Per-process lock; each recorder child has its own interpreter.
_stdout_lock = threading.Lock()


def send_json_message(message: Any, *, lock: Optional[threading.Lock] = None) -> None:
    """Print one JSON control message to stdout (thread-safe)."""
    with lock or _stdout_lock:
        print(json.dumps(message), flush=True)


def send_event_message(
    event: str,
    message: str,
    *,
    lock: Optional[threading.Lock] = None,
    send_json: Optional[Callable[[Any], None]] = None,
    **extra: Any,
) -> None:
    payload: Dict[str, Any] = {
        "type": "event",
        "event": event,
        "message": message,
    }
    payload.update(extra)
    (send_json or (lambda msg: send_json_message(msg, lock=lock)))(payload)


def send_warning_message(
    code: str,
    message: str,
    *,
    lock: Optional[threading.Lock] = None,
    send_json: Optional[Callable[[Any], None]] = None,
    **extra: Any,
) -> None:
    payload: Dict[str, Any] = {
        "type": "warning",
        "code": code,
        "message": message,
    }
    payload.update(extra)
    (send_json or (lambda msg: send_json_message(msg, lock=lock)))(payload)


def send_error_message(
    code: str,
    message: str,
    *,
    lock: Optional[threading.Lock] = None,
    send_json: Optional[Callable[[Any], None]] = None,
    **extra: Any,
) -> None:
    payload: Dict[str, Any] = {
        "type": "error",
        "code": code,
        "message": message,
    }
    payload.update(extra)
    (send_json or (lambda msg: send_json_message(msg, lock=lock)))(payload)


def bind_recorder_stdout_emitters(lock: Optional[threading.Lock] = None) -> Dict[str, Callable[..., None]]:
    """Return `_send_*` callables closed over a shared lock (recorder Pattern A seam)."""
    active_lock = lock or _stdout_lock

    def _send_json_message(message: Any) -> None:
        send_json_message(message, lock=active_lock)

    def _send_event_message(event: str, message: str, **extra: Any) -> None:
        send_event_message(event, message, lock=active_lock, send_json=_send_json_message, **extra)

    def _send_warning_message(code: str, message: str, **extra: Any) -> None:
        send_warning_message(code, message, lock=active_lock, send_json=_send_json_message, **extra)

    def _send_error_message(code: str, message: str, **extra: Any) -> None:
        send_error_message(code, message, lock=active_lock, send_json=_send_json_message, **extra)

    return {
        "_send_json_message": _send_json_message,
        "_send_event_message": _send_event_message,
        "_send_warning_message": _send_warning_message,
        "_send_error_message": _send_error_message,
    }
