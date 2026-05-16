"""Pure transcript summary helpers.

This module intentionally avoids model/runtime imports. It owns the deterministic
parts of the summary pipeline so JSON validation and chunking can be tested
without downloading GGUF files or launching local inference.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterable, List, Optional


SUMMARY_ARRAY_FIELDS = ("topics", "decisions", "action_items", "risks", "open_questions")
TRANSCRIPT_TIMESTAMP_RE = re.compile(
    r"^(?:\*\*)?\[(?P<start>\d{1,2}:\d{2}(?::\d{2})?)\s+-\s+(?P<end>\d{1,2}:\d{2}(?::\d{2})?)\](?:\*\*)?\s*(?P<tail>.*)$"
)
SPEAKER_PREFIX_RE = re.compile(r"^(?:\*\*)?(?P<speaker>Speaker\s+\d+|Unknown):(?:\*\*)?\s*(?P<text>.*)$", re.IGNORECASE)
TOPIC_BOUNDARY_RE = re.compile(
    r"\b(next|new|another)\s+(topic|item|section)\b|"
    r"\b(moving|move)\s+on\b|"
    r"\b(switching|shift(?:ing)?)\s+(to|gears)\b|"
    r"\b(let'?s|we should)\s+(talk|discuss|cover)(\s+about)?\b|"
    r"\bagenda\s+item\b",
    re.IGNORECASE,
)

SUMMARY_PROFILE_CONFIGS: Dict[str, Dict[str, Any]] = {
    "concise": {
        "label": "Concise",
        "max_output_tokens": 900,
        "chunk_tokens": 12000,
        "instructions": "Be brief. Capture only the most important outcome, decisions, and next steps.",
    },
    "balanced": {
        "label": "Balanced",
        "max_output_tokens": 1600,
        "chunk_tokens": 16000,
        "instructions": "Create balanced meeting notes with topics, decisions, action items, risks, and open questions.",
    },
    "detailed": {
        "label": "Detailed",
        "max_output_tokens": 2600,
        "chunk_tokens": 20000,
        "instructions": "Include broader topic coverage, important supporting timestamps, and nuanced risks or open questions.",
    },
    "action-items": {
        "label": "Action items",
        "max_output_tokens": 1400,
        "chunk_tokens": 14000,
        "instructions": "Prioritize tasks, owners, due dates, blockers, decisions, and follow-up questions.",
    },
}


class SummaryValidationError(ValueError):
    """Raised when a generated summary does not match the persisted shape."""


def get_summary_profile(profile: str = "balanced") -> Dict[str, Any]:
    """Return a safe profile config, defaulting unknown values to balanced."""
    config = SUMMARY_PROFILE_CONFIGS.get(str(profile or "").strip(), SUMMARY_PROFILE_CONFIGS["balanced"])
    return dict(config)


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


def parse_timestamp(value: str) -> float:
    parts = [int(part) for part in str(value or "").split(":")]
    if len(parts) == 2:
        minutes, seconds = parts
        return float(minutes * 60 + seconds)
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return float(hours * 3600 + minutes * 60 + seconds)
    raise ValueError(f"Unsupported timestamp: {value}")


def _split_speaker_prefix(text: str) -> Dict[str, str]:
    cleaned = _clean_text(text)
    match = SPEAKER_PREFIX_RE.match(cleaned)
    if not match:
        return {"speaker": "Unknown", "text": cleaned}

    return {
        "speaker": _clean_text(match.group("speaker")) or "Unknown",
        "text": _clean_text(match.group("text")),
    }


def parse_markdown_transcript(markdown_text: str) -> List[Dict[str, Any]]:
    """Parse AvaNevis Markdown transcripts back into timestamped segments."""
    lines = str(markdown_text or "").splitlines()
    segments: List[Dict[str, Any]] = []
    index = 0

    while index < len(lines):
        line = lines[index].strip()
        match = TRANSCRIPT_TIMESTAMP_RE.match(line)
        if not match:
            index += 1
            continue

        tail = _clean_text(match.group("tail"))
        if not tail:
            next_index = index + 1
            while next_index < len(lines) and not lines[next_index].strip():
                next_index += 1
            if next_index < len(lines):
                tail = _clean_text(lines[next_index])
                index = next_index

        speaker_text = _split_speaker_prefix(tail)
        if speaker_text["text"]:
            segments.append({
                "start": parse_timestamp(match.group("start")),
                "end": parse_timestamp(match.group("end")),
                "speaker": speaker_text["speaker"],
                "text": speaker_text["text"],
            })

        index += 1

    return segments


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


def is_topic_boundary_segment(segment: Dict[str, Any]) -> bool:
    """Return True when a transcript segment likely starts a new discussion topic."""
    text = _clean_text(segment.get("text"))
    if not text:
        return False
    return bool(TOPIC_BOUNDARY_RE.search(text))


def chunk_transcript(
    segments: Iterable[Dict[str, Any]],
    *,
    max_tokens: int,
    overlap_segments: int = 0,
    prefer_topic_boundaries: bool = True,
    min_topic_chunk_tokens: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Split normalized transcript lines into timestamped chunks.

    Chunks always honor the token budget. When a segment appears to start a
    new agenda/topic and the current chunk has enough content, flush before the
    boundary so map prompts receive more coherent discussion units.
    """
    if max_tokens <= 0:
        raise ValueError("max_tokens must be greater than 0")
    if overlap_segments < 0:
        raise ValueError("overlap_segments must not be negative")
    if min_topic_chunk_tokens is not None and min_topic_chunk_tokens < 0:
        raise ValueError("min_topic_chunk_tokens must not be negative")

    normalized = normalize_transcript_segments(segments)
    chunks: List[Dict[str, Any]] = []
    current_segments: List[Dict[str, Any]] = []
    current_tokens = 0
    topic_threshold = min_topic_chunk_tokens if min_topic_chunk_tokens is not None else max(1, int(max_tokens * 0.5))

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
        if (
            prefer_topic_boundaries
            and current_segments
            and current_tokens >= topic_threshold
            and is_topic_boundary_segment(segment)
        ):
            flush_current()

        if current_segments and current_tokens + segment_tokens > max_tokens:
            flush_current()
            if current_segments and current_tokens + segment_tokens > max_tokens:
                current_segments = []
                current_tokens = 0

        current_segments.append(segment)
        current_tokens += segment_tokens

    flush_current()

    return chunks


def summary_json_schema_instruction() -> str:
    return """Return only valid JSON with this exact shape:
{
  "summary": "short grounded overview",
  "topics": [{"title": "topic", "summary": "what was discussed", "timestamps": ["MM:SS"]}],
  "decisions": [{"decision": "decision made", "owner": "Speaker or Unknown", "timestamp": "MM:SS"}],
  "action_items": [{"task": "task", "owner": "Speaker or Unknown", "due": "date or null", "timestamp": "MM:SS"}],
  "risks": [{"risk": "risk or blocker", "timestamp": "MM:SS"}],
  "open_questions": [{"question": "question", "timestamp": "MM:SS"}]
}
Use only evidence from the transcript. If an owner is not explicit, use "Unknown". Do not include markdown."""


def build_chunk_summary_prompt(chunk: Dict[str, Any], *, profile: str = "balanced") -> str:
    """Build the local LLM prompt for one transcript chunk."""
    profile_config = get_summary_profile(profile)
    return "\n\n".join([
        "You are AvaNevis, a local-only meeting summarizer. The transcript never leaves this device.",
        profile_config["instructions"],
        summary_json_schema_instruction(),
        f"Chunk {chunk.get('index', 1)} transcript:",
        str(chunk.get("text", "")),
    ])


def build_final_merge_prompt(chunk_summaries: Iterable[Dict[str, Any]], *, profile: str = "balanced") -> str:
    """Build the local LLM prompt that merges validated chunk summaries."""
    profile_config = get_summary_profile(profile)
    normalized_summaries = [validate_summary_json(summary) for summary in chunk_summaries]
    return "\n\n".join([
        "You are AvaNevis, a local-only meeting summarizer. Merge these chunk summaries into one final meeting summary.",
        profile_config["instructions"],
        summary_json_schema_instruction(),
        "Validated chunk summaries JSON:",
        json.dumps(normalized_summaries, ensure_ascii=False, indent=2),
    ])


def extract_json_object(raw_output: str) -> Dict[str, Any]:
    """Extract one JSON object from model output, tolerating fenced text."""
    output = str(raw_output or "").strip()
    if output.startswith("```"):
        output = re.sub(r"^```(?:json)?\s*", "", output, flags=re.IGNORECASE)
        output = re.sub(r"\s*```$", "", output).strip()

    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        start = output.find("{")
        end = output.rfind("}")
        if start == -1 or end == -1 or end <= start:
            raise SummaryValidationError("model output did not contain a JSON object")
        try:
            parsed = json.loads(output[start:end + 1])
        except json.JSONDecodeError as exc:
            raise SummaryValidationError(f"model output JSON could not be parsed: {exc}") from exc

    if not isinstance(parsed, dict):
        raise SummaryValidationError("model output must be a JSON object")
    return parsed


def repair_summary_json(raw_output: str) -> Dict[str, Any]:
    """Best-effort local repair for common wrapper text around JSON output."""
    return validate_summary_json(extract_json_object(raw_output))


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
