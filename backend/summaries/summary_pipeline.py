"""Pure transcript summary helpers.

This module intentionally avoids model/runtime imports. It owns the deterministic
parts of the summary pipeline so JSON validation and chunking can be tested
without downloading GGUF files or launching local inference.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional


SUMMARY_ARRAY_FIELDS = ("topics", "decisions", "action_items", "risks", "open_questions")


class SummaryValidationError(ValueError):
    """Raised when a generated summary does not match the persisted shape."""


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def format_timestamp(seconds: Any) -> str:
    total_seconds = max(0, int(_to_float(seconds)))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60

    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def normalize_transcript_segments(segments: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Normalize transcript segments into prompt-safe timestamped text lines."""
    normalized: List[Dict[str, Any]] = []

    for segment in segments:
        text = _clean_text(segment.get("text"))
        if not text:
            continue

        start = _to_float(segment.get("start"))
        end = _to_float(segment.get("end"), start)
        speaker = _clean_text(segment.get("speaker")) or "Unknown"
        line = f"[{format_timestamp(start)} - {format_timestamp(end)}] {speaker}: {text}"

        normalized.append({
            "start": start,
            "end": end,
            "speaker": speaker,
            "text": text,
            "line": line,
        })

    return normalized


def estimate_token_count(text: str) -> int:
    """Conservative token estimate for chunking without tokenizer dependencies."""
    if not text:
        return 0
    return max(1, (len(text) + 3) // 4)


def chunk_transcript(
    segments: Iterable[Dict[str, Any]],
    *,
    max_tokens: int,
    overlap_segments: int = 0,
) -> List[Dict[str, Any]]:
    """Split normalized transcript lines into token-budgeted chunks."""
    if max_tokens <= 0:
        raise ValueError("max_tokens must be greater than 0")
    if overlap_segments < 0:
        raise ValueError("overlap_segments must not be negative")

    normalized = normalize_transcript_segments(segments)
    chunks: List[Dict[str, Any]] = []
    current_segments: List[Dict[str, Any]] = []
    current_tokens = 0

    def flush_current() -> None:
        nonlocal current_segments, current_tokens
        if not current_segments:
            return

        chunk_index = len(chunks) + 1
        chunks.append({
            "index": chunk_index,
            "start": current_segments[0]["start"],
            "end": current_segments[-1]["end"],
            "text": "\n".join(item["line"] for item in current_segments),
            "segments": [dict(item) for item in current_segments],
            "estimatedTokens": current_tokens,
        })

        if overlap_segments:
            current_segments = current_segments[-overlap_segments:]
            current_tokens = sum(estimate_token_count(item["line"]) for item in current_segments)
        else:
            current_segments = []
            current_tokens = 0

    for segment in normalized:
        segment_tokens = estimate_token_count(segment["line"])
        if current_segments and current_tokens + segment_tokens > max_tokens:
            flush_current()

        current_segments.append(segment)
        current_tokens += segment_tokens

    flush_current()

    return chunks


def _require_list(summary: Dict[str, Any], field: str) -> List[Dict[str, Any]]:
    value = summary.get(field, [])
    if value is None:
        return []
    if not isinstance(value, list):
        raise SummaryValidationError(f"summary field '{field}' must be a list")

    normalized: List[Dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise SummaryValidationError(f"summary field '{field}[{index}]' must be an object")
        normalized.append(dict(item))
    return normalized


def validate_summary_json(summary: Any) -> Dict[str, Any]:
    """Validate and normalize generated summary JSON before persistence."""
    if not isinstance(summary, dict):
        raise SummaryValidationError("summary must be a JSON object")

    overview = _clean_text(summary.get("summary"))
    if not overview:
        raise SummaryValidationError("summary.summary must be a non-empty string")

    normalized: Dict[str, Any] = {"summary": overview}
    for field in SUMMARY_ARRAY_FIELDS:
        normalized[field] = _require_list(summary, field)

    return normalized


def _item_text(item: Dict[str, Any], keys: Iterable[str]) -> str:
    for key in keys:
        value = _clean_text(item.get(key))
        if value:
            return value
    return "Untitled"


def _item_metadata(item: Dict[str, Any], keys: Iterable[str]) -> str:
    parts = []
    for key in keys:
        value = _clean_text(item.get(key))
        if value:
            parts.append(f"{key}: {value}")
    return f" ({'; '.join(parts)})" if parts else ""


def _render_items(title: str, items: List[Dict[str, Any]], text_keys: Iterable[str], metadata_keys: Iterable[str]) -> List[str]:
    lines = [f"## {title}", ""]
    if not items:
        lines.extend(["None captured.", ""])
        return lines

    for item in items:
        lines.append(f"- {_item_text(item, text_keys)}{_item_metadata(item, metadata_keys)}")
    lines.append("")
    return lines


def render_summary_markdown(summary: Dict[str, Any], metadata: Optional[Dict[str, Any]] = None) -> str:
    """Render a validated structured summary to Markdown for History display/export."""
    validated = validate_summary_json(summary)
    metadata = metadata or {}
    profile = _clean_text(metadata.get("profile"))
    model = _clean_text(metadata.get("model"))
    generated_at = _clean_text(metadata.get("generatedAt"))

    lines = ["# Meeting Summary", "", validated["summary"], ""]
    if profile or model or generated_at:
        lines.append("---")
        lines.append("")
        if profile:
            lines.append(f"**Profile:** {profile}")
        if model:
            lines.append(f"**Model:** {model}")
        if generated_at:
            lines.append(f"**Generated:** {generated_at}")
        lines.append("")

    lines.extend(_render_items("Topics", validated["topics"], ("title", "topic"), ("timestamps",)))
    lines.extend(_render_items("Decisions", validated["decisions"], ("decision",), ("owner", "timestamp")))
    lines.extend(_render_items("Action Items", validated["action_items"], ("task", "action"), ("owner", "due", "timestamp")))
    lines.extend(_render_items("Risks", validated["risks"], ("risk",), ("timestamp",)))
    lines.extend(_render_items("Open Questions", validated["open_questions"], ("question",), ("timestamp",)))

    return "\n".join(lines).rstrip() + "\n"
