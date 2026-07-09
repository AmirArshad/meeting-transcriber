"""Pure meeting metadata normalization helpers."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional

from common.sensitive_text import redact_sensitive_text

MAX_AI_METADATA_STRING_LENGTH = 300
VALID_TRANSCRIPTION_STATUSES = {"pending", "failed", "completed"}


def read_text_file(file_path: Optional[Path], label: str) -> str:
    if file_path is None or not file_path.exists():
        return ""

    try:
        return file_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"Warning: Could not read {label}: {exc}", file=sys.stderr)
        return ""


def read_transcript_text(transcript_path: Optional[Path]) -> str:
    return read_text_file(transcript_path, "transcript")


def hash_text(text: str) -> str:
    return f"sha256:{hashlib.sha256(str(text or '').encode('utf-8')).hexdigest()}"


def normalize_transcription_status(value: object, default: str = "completed") -> str:
    candidate = str(value or "").strip().lower()
    if candidate in VALID_TRANSCRIPTION_STATUSES:
        return candidate
    return default


def normalize_transcription_error(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    text = redact_sensitive_text(value)
    text = re.sub(r"\s+", " ", str(text)).strip()
    return text[:MAX_AI_METADATA_STRING_LENGTH] if text else None


def build_pending_transcript_placeholder(audio_file_name: str) -> str:
    return "\n".join([
        "# Recording Awaiting Transcription",
        "",
        f"**File:** {audio_file_name}",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "**Status:** Transcription pending",
        "",
        "The recording was saved successfully, but a transcript is not available yet.",
        "Use Retry transcription in AvaNevis to generate a transcript.",
        "",
    ])


def strip_inline_transcript(meeting: Dict) -> Dict:
    stripped = dict(meeting)
    stripped.pop("transcript", None)
    return stripped


def normalize_text(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:MAX_AI_METADATA_STRING_LENGTH]


def parse_metadata(raw_value: Optional[str], label: str, *, unset):
    """Parse CLI AI metadata JSON. Returns `unset` when raw_value is None."""
    if raw_value is None:
        return unset
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid {label} metadata JSON: {exc}")
    if not isinstance(parsed, dict):
        raise SystemExit(f"Invalid {label} metadata JSON: expected object")
    return parsed
