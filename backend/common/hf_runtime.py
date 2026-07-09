"""Shared Hugging Face offline-mode helpers for local AI runtimes."""

from __future__ import annotations

import contextlib
import os
from typing import Any, Iterator


@contextlib.contextmanager
def hugging_face_offline_mode(enabled: bool) -> Iterator[None]:
    """Temporarily set HF offline env vars, then restore prior values."""
    keys = ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
    previous = {key: os.environ.get(key) for key in keys}
    if enabled:
        for key in keys:
            os.environ[key] = "1"
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
