"""Shared redaction helpers for user-visible error and progress text."""

from __future__ import annotations

import re
from typing import Any

_DEFAULT_MAX_LENGTH = 300


def redact_sensitive_text(value: Any, *, max_length: int = _DEFAULT_MAX_LENGTH) -> str:
    cleaned = re.sub(r"hf_[A-Za-z0-9_-]+", "[redacted-token]", str(value or ""))
    cleaned = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted-token]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(
        r"(Authorization:\s*token\s+)[A-Za-z0-9._~+/=-]+",
        r"\1[redacted-token]",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"((?:access_)?token=|api_key=)[^&#\s]+", r"\1[redacted-token]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"(X-Api-Key:\s*)[^\r\n\s]+", r"\1[redacted-token]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"(https?://)[^/?#@\s]+@", r"\1[redacted]@", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if max_length > 0:
        return cleaned[:max_length]
    return cleaned
