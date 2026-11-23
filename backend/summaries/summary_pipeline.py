"""Pure transcript summary helpers.

This module intentionally avoids model/runtime imports. It owns the deterministic
parts of the summary pipeline so JSON validation and chunking can be tested
without downloading GGUF files or launching local inference.
"""

from __future__ import annotations

import json
import re

from .summary_language import language_instruction, summary_prose
from .language_labels import LANGUAGE_LABELS, PROFILE_LABELS, get_localized_labels
from .summary_grounding import LOCALIZED_DENIAL_RES
from .templates import (
    SCHEMA_PLACEHOLDER_SUMMARY,
    SUMMARY_TEMPLATES,
    get_template,
    render_schema_instruction,
)
from meetings.normalization import normalize_recording_tag
from typing import Any, Dict, Iterable, List, Optional


SUMMARY_ARRAY_FIELDS = SUMMARY_TEMPLATES["meeting"]["array_fields"]
TRANSCRIPT_TIMESTAMP_RE = re.compile(
    r"^(?:\*\*)?\[(?P<start>\d{1,2}:\d{2}(?::\d{2})?)\s+-\s+(?P<end>\d{1,2}:\d{2}(?::\d{2})?)\](?:\*\*)?\s*(?P<tail>.*)$"
)
SPEAKER_PREFIX_RE = re.compile(r"^(?:\*\*(?P<speaker>[^*\n:]{1,64}):\*\*|(?P<plain_speaker>Speaker\s+\d+|Unknown):)\s*(?P<text>.*)$", re.IGNORECASE)
UNTIMED_SPEAKER_RE = re.compile(r"^\*\*(?P<speaker>[^*\n:]{1,64}):\*\*\s*(?P<text>.*)$")
TOPIC_BOUNDARY_RE = re.compile(
    r"\b(next|new|another)\s+(topic|item|section)\b|"
    r"\b(moving|move)\s+on\b|"
    r"\b(switching|shift(?:ing)?)\s+(to|gears)\b|"
    r"\b(let'?s|we should)\s+(talk|discuss|cover)(\s+about)?\b|"
    r"\bagenda\s+item\b",
    re.IGNORECASE,
)
_THINK_BLOCK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)
_UNCLOSED_THINK_RE = re.compile(r"<think>[\s\S]*$", re.IGNORECASE)
_GEMMA_THOUGHT_BLOCK_RE = re.compile(r"<\|channel>thought[\s\S]*?<channel\|>", re.IGNORECASE)
_UNCLOSED_GEMMA_THOUGHT_RE = re.compile(r"<\|channel>thought[\s\S]*$", re.IGNORECASE)
_INKLING_THINK_BLOCK_RE = re.compile(r"\[Start thinking\][\s\S]*?\[End thinking\]", re.IGNORECASE)
_UNCLOSED_INKLING_THINK_RE = re.compile(r"\[Start thinking\][\s\S]*$", re.IGNORECASE)
_CHAT_CONTROL_TOKEN_RE = re.compile(
    r"<start_of_turn>|<end_of_turn>|<\|im_start\|>|<\|im_end\|>|<\|channel>|<channel\|>",
    re.IGNORECASE,
)

SUMMARY_PROFILE_CONFIGS: Dict[str, Dict[str, Any]] = {
    "concise": {
        "label": "Concise",
        "max_output_tokens": 900,
        "chunk_tokens": 12000,
        "instructions": "Be brief. Capture only the most important overview, takeaways, and next steps.",
    },
    "balanced": {
        "label": "Balanced",
        "max_output_tokens": 1600,
        "chunk_tokens": 16000,
        "instructions": "Create balanced, well-structured notes covering the active template sections.",
    },
    "detailed": {
        "label": "Detailed",
        "max_output_tokens": 2600,
        "chunk_tokens": 20000,
        "instructions": "Include broader coverage, supporting details, important timestamps, and nuanced context.",
    },
    "action-items": {
        "label": "Action items",
        "max_output_tokens": 1400,
        "chunk_tokens": 14000,
        "instructions": "Prioritize concrete follow-ups, next steps, owners, deadlines, and open items.",
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


def sanitize_prompt_control_tokens(value: Any) -> str:
    """Strip chat-template control tokens from untrusted text before prompting."""
    return _CHAT_CONTROL_TOKEN_RE.sub(" ", str(value or ""))


def _strip_model_reasoning(raw_output: str) -> str:
    cleaned = str(raw_output or "").strip()
    cleaned = _THINK_BLOCK_RE.sub("", cleaned)
    cleaned = _UNCLOSED_THINK_RE.sub("", cleaned)
    cleaned = _GEMMA_THOUGHT_BLOCK_RE.sub("", cleaned)
    cleaned = _UNCLOSED_GEMMA_THOUGHT_RE.sub("", cleaned)
    cleaned = _INKLING_THINK_BLOCK_RE.sub("", cleaned)
    cleaned = _UNCLOSED_INKLING_THINK_RE.sub("", cleaned)
    return cleaned.strip()


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
        "speaker": _clean_text(match.group("speaker") or match.group("plain_speaker")) or "Unknown",
        "text": _clean_text(match.group("text")),
    }


def _next_nonempty_line(lines: List[str], start_index: int) -> tuple[int, str]:
    """Return (index, cleaned text) for the next non-empty line, or (-1, "")."""
    next_index = start_index
    while next_index < len(lines) and not lines[next_index].strip():
        next_index += 1
    if next_index >= len(lines):
        return -1, ""
    return next_index, _clean_text(lines[next_index])


def _pull_following_body_line(lines: List[str], index: int) -> tuple[int, str]:
    """Pull the next body line, refusing to consume a following timestamp header."""
    next_index, next_text = _next_nonempty_line(lines, index + 1)
    if next_index < 0:
        return index, ""
    if (TRANSCRIPT_TIMESTAMP_RE.match(lines[next_index].strip())
            or UNTIMED_SPEAKER_RE.match(lines[next_index].strip())
            or _is_transcript_structure(lines[next_index].strip())):
        return index, ""
    return next_index, next_text


def _is_transcript_structure(line: str) -> bool:
    return bool(re.match(r"^#{1,6}(?:\s|$)", line)) or line in ("---", "***", "___")


def parse_markdown_transcript(markdown_text: str) -> List[Dict[str, Any]]:
    """Parse AvaNevis Markdown transcripts into timed and untimed segments.

    Supports both common shapes produced by the app:

    - ``**[00:01 - 00:03]**`` then body text on the following line
    - ``**[00:01 - 00:03]** **Speaker 1:**`` then body text on the following line
      (guided / diarization-labeled transcripts)
    - ``[00:01 - 00:03] **Speaker 2:** Follow up`` on one line
    """
    lines = str(markdown_text or "").splitlines()
    segments: List[Dict[str, Any]] = []
    index = 0

    while index < len(lines):
        line = lines[index].strip()
        match = TRANSCRIPT_TIMESTAMP_RE.match(line)
        if not match:
            untimed = UNTIMED_SPEAKER_RE.match(line)
            if not line or _is_transcript_structure(line):
                index += 1
                continue
            speaker = _clean_text(untimed.group("speaker")) if untimed else "Unknown"
            text_parts = [untimed.group("text") if untimed else line]
            cursor = index + 1
            while cursor < len(lines):
                body = lines[cursor].strip()
                if (not body or _is_transcript_structure(body) or TRANSCRIPT_TIMESTAMP_RE.match(body)
                        or UNTIMED_SPEAKER_RE.match(body)):
                    break
                text_parts.append(_clean_text(body))
                cursor += 1
            text = _clean_text(" ".join(text_parts))
            if text:
                segments.append({"start": None, "end": None, "speaker": speaker, "text": text})
            index = cursor
            continue

        tail = _clean_text(match.group("tail"))
        if not tail:
            next_index, next_text = _pull_following_body_line(lines, index)
            if next_text:
                tail = next_text
                index = next_index

        speaker_text = _split_speaker_prefix(tail)
        # Guided transcripts put only the speaker label on the timestamp line and
        # the spoken text on the following line. Pull that body in when needed.
        if not speaker_text["text"]:
            next_index, next_text = _pull_following_body_line(lines, index)
            if next_text:
                speaker_text = {
                    "speaker": speaker_text["speaker"],
                    "text": next_text,
                }
                index = next_index

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
        text = _clean_text(sanitize_prompt_control_tokens(segment.get("text")))
        if not text:
            continue

        start = _to_float(segment.get("start"))
        end = _to_float(segment.get("end"), start)
        speaker_value = segment.get("speaker")
        speaker = _clean_text(sanitize_prompt_control_tokens(speaker_value)) if isinstance(speaker_value, str) else ""
        speaker = speaker or "Unknown"
        if segment.get("start") is None or segment.get("end") is None:
            line = f"{speaker}: {text}"
        else:
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
    """Estimate chunk tokens from UTF-8 bytes without tokenizer dependencies.

    Character counts badly underbudget CJK text. Bytes preserve the existing
    ASCII estimate while allowing more room for multilingual tokenization.
    This is still a heuristic, not an exact tokenizer/context guarantee.
    """
    if not text:
        return 0
    return max(1, (len(text.encode("utf-8")) + 3) // 4)


def is_topic_boundary_segment(segment: Dict[str, Any]) -> bool:
    """Return True when a transcript segment likely starts a new discussion topic."""
    text = _clean_text(segment.get("text"))
    if not text:
        return False
    return bool(TOPIC_BOUNDARY_RE.search(text))


def _split_oversized_segment(segment: Dict[str, Any], max_bytes: int) -> Iterable[Dict[str, Any]]:
    if len(segment["line"].encode("utf-8")) <= max_bytes:
        yield segment
        return

    text = segment["text"].encode("utf-8")
    prefix = segment["line"][:-len(segment["text"])]
    # Keep attribution on every piece when it fits beside a Unicode character.
    if max_bytes - len(prefix.encode("utf-8")) < 4:
        prefix = ""
    body_budget = max_bytes - len(prefix.encode("utf-8"))
    offset = 0
    while offset < len(text):
        body = text[offset : offset + body_budget].decode("utf-8", errors="ignore")
        if offset + body_budget < len(text):
            sentence_ends = list(re.finditer(r"(?:[.!?؟](?=\s)|[。！？])", body))
            if sentence_ends:
                body = body[:sentence_ends[-1].end()]
            elif " " in body:
                body = body.rsplit(" ", 1)[0] or body
        offset += len(body.encode("utf-8"))
        if offset < len(text) and text[offset] == ord(" "):
            offset += 1
        if body.strip():
            yield {**segment, "text": body.strip(), "line": prefix + body.strip()}


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

    max_bytes = max_tokens * 4
    normalized = (
        piece
        for segment in normalize_transcript_segments(segments)
        for piece in _split_oversized_segment(segment, max_bytes)
    )
    chunks: List[Dict[str, Any]] = []
    current_segments: List[Dict[str, Any]] = []
    current_bytes = 0
    topic_threshold = min_topic_chunk_tokens if min_topic_chunk_tokens is not None else max(1, int(max_tokens * 0.5))

    def flush_current() -> None:
        nonlocal current_segments, current_bytes
        if not current_segments:
            return

        text = "\n".join(item["line"] for item in current_segments)
        chunks.append({
            "index": len(chunks) + 1,
            "start": current_segments[0]["start"],
            "end": current_segments[-1]["end"],
            "text": text,
            "segments": [dict(item) for item in current_segments],
            "estimatedTokens": estimate_token_count(text),
        })

        current_segments = current_segments[-overlap_segments:] if overlap_segments else []
        current_bytes = len("\n".join(item["line"] for item in current_segments).encode("utf-8"))

    for segment in normalized:
        segment_bytes = len(segment["line"].encode("utf-8"))
        if current_segments and (
            current_bytes + 1 + segment_bytes > max_bytes
            or (prefer_topic_boundaries
                and (current_bytes + 3) // 4 >= topic_threshold
                and is_topic_boundary_segment(segment))
        ):
            flush_current()
            while current_segments and current_bytes + 1 + segment_bytes > max_bytes:
                current_bytes -= len(current_segments.pop(0)["line"].encode("utf-8")) + 1

        current_bytes += segment_bytes + bool(current_segments)
        current_segments.append(segment)

    flush_current()

    return chunks


def build_profile_instruction(profile: str = "balanced", tag: Optional[str] = None) -> str:
    """Combine profile verbosity instructions with template-aware action hints."""
    normalized_profile = str(profile or "").strip() or "balanced"
    profile_config = get_summary_profile(normalized_profile)
    base = str(profile_config["instructions"])
    if normalized_profile == "action-items" and tag:
        template = get_template(tag, fallback="meeting")
        hint = str(template.get("action_style_hint") or "").strip()
        if hint:
            return f"{base} {hint}"
    return base


def summary_json_schema_instruction(tag: Optional[str] = None) -> str:
    return render_schema_instruction(tag, fallback="meeting")


def no_thinking_instruction() -> str:
    return "Do not use a thinking or reasoning section. Do not output <think> tags. Return the JSON object directly."


def build_chunk_summary_prompt(
    chunk: Dict[str, Any],
    *,
    profile: str = "balanced",
    language: Optional[str] = None,
    tag: Optional[str] = None,
) -> str:
    """Build the local LLM prompt for one transcript chunk."""
    template = get_template(tag, fallback="meeting")
    return "\n\n".join([
        template["persona"],
        no_thinking_instruction(),
        language_instruction(language) if language else "Write summary prose in the transcript language.",
        build_profile_instruction(profile, template["template_id"]),
        summary_json_schema_instruction(template["template_id"]),
        template["chunk_instructions"],
        "Do not claim the transcript is missing, empty, or only system/CLI status.",
        f"Chunk {chunk.get('index', 1)} transcript:",
        sanitize_prompt_control_tokens(chunk.get("text", "")),
    ])


def build_final_merge_prompt(
    chunk_summaries: Iterable[Dict[str, Any]],
    *,
    profile: str = "balanced",
    language: Optional[str] = None,
    tag: Optional[str] = None,
) -> str:
    """Build the local LLM prompt that merges validated chunk summaries."""
    template = get_template(tag, fallback="meeting")
    normalized_summaries = [
        validate_summary_json(summary, tag=template["template_id"])
        for summary in chunk_summaries
    ]
    return "\n\n".join([
        template["merge_persona"],
        no_thinking_instruction(),
        language_instruction(language) if language else "Write summary prose in the transcript language.",
        build_profile_instruction(profile, template["template_id"]),
        template["merge_instructions"],
        summary_json_schema_instruction(template["template_id"]),
        "Validated chunk summaries JSON:",
        sanitize_prompt_control_tokens(json.dumps(normalized_summaries, ensure_ascii=False, indent=2)),
    ])


def extract_json_object(raw_output: str) -> Dict[str, Any]:
    """Extract one JSON object from model output, tolerating fenced text."""
    output = _strip_model_reasoning(raw_output)
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
    if _clean_text(parsed.get("summary")) == SCHEMA_PLACEHOLDER_SUMMARY:
        raise SummaryValidationError("model output echoed the schema example")
    return parsed


def repair_summary_json(raw_output: str, *, tag: Optional[str] = None) -> Dict[str, Any]:
    """Best-effort local repair for common wrapper text around JSON output."""
    return validate_summary_json(extract_json_object(raw_output), tag=tag)


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


def validate_summary_json(summary: Any, *, tag: Optional[str] = None) -> Dict[str, Any]:
    """Validate and normalize generated summary JSON before persistence."""
    if not isinstance(summary, dict):
        raise SummaryValidationError("summary must be a JSON object")

    overview = _clean_text(summary.get("summary"))
    if not overview:
        raise SummaryValidationError("summary.summary must be a non-empty string")

    explicit_template = tag or summary.get("template")
    template = get_template(explicit_template, fallback="meeting")
    normalized: Dict[str, Any] = {"summary": overview}
    if explicit_template is not None:
        normalized["template"] = template["template_id"]
    for field in template["array_fields"]:
        normalized[field] = _require_list(summary, field)

    return normalized


# Match only clear denials that the transcript/content was absent. Do not match
# affirmative phrases like "the transcript provided by the vendor".
UNGROUNDED_SUMMARY_RE = re.compile(
    r"(?i)\b(?:"
    r"no (?:meeting|recording|audio|appointment|call|interview|lecture|podcast|video|voice[- ]note|brainstorm|music|session)?\s*(?:content|transcript)|"
    r"(?:transcript|content)\s+(?:was\s+|were\s+)?not\s+(?:provided|found|available)|"
    r"(?:transcript|content)\s+(?:is|was|were)\s+(?:missing|empty)|"
    r"only\s+.{0,80}?(?:system\s+status|exit\s+commands?)"
    r")\b",
)


def transcript_chunk_has_speech(chunk_text: str) -> bool:
    """Return True when a chunk looks like real spoken transcript content."""
    cleaned = _clean_text(chunk_text)
    if len(cleaned) < 24:
        return False
    # Require at least one alphabetic token beyond timestamps/speaker labels.
    # Use Unicode letters so non-Latin transcripts still enable grounding checks.
    without_labels = re.sub(
        r"^[ \t]*(?:\[\d{1,2}:\d{2}(?::\d{2})?(?:\s+-\s+\d{1,2}:\d{2}(?::\d{2})?)?\][ \t]*)?"
        r"[^:\n]{1,64}:[ \t]*",
        "",
        str(chunk_text or ""),
        flags=re.MULTILINE,
    )
    # Combining vowel signs can separate alphabetic characters in Hindi/Panjabi
    # words. Count letters within a whitespace-delimited word, not consecutive
    # regex letters, so real speech still activates the denial guard.
    return any(sum(character.isalpha() for character in word) >= 3 for word in without_labels.split())


def assert_summary_grounded_in_transcript(
    summary: Dict[str, Any],
    chunk_text: str,
    *,
    language: Optional[str] = None,
    tag: Optional[str] = None,
) -> Dict[str, Any]:
    """Reject summaries that deny transcript content when speech was provided."""
    normalized = validate_summary_json(summary, tag=tag)
    if not transcript_chunk_has_speech(chunk_text):
        return normalized
    localized_denial = LOCALIZED_DENIAL_RES.get(language)
    if UNGROUNDED_SUMMARY_RE.search(normalized["summary"]) or (
        localized_denial and localized_denial.search(normalized["summary"])
    ):
        raise SummaryValidationError(
            "summary denied transcript content even though speech was provided"
        )
    return normalized


def _format_scalar_or_list(value: Any) -> str:
    if isinstance(value, list):
        parts = [_clean_text(v) for v in value]
        return ", ".join(p for p in parts if p)
    return _clean_text(value)


def _item_text(item: Dict[str, Any], keys: Iterable[str], untitled="Untitled", *, detail_key: Optional[str] = None) -> str:
    primary = ""
    for key in keys:
        value = _clean_text(item.get(key))
        if value:
            primary = value
            break
    detail = _clean_text(item.get(detail_key)) if detail_key else ""
    if not primary:
        return detail or untitled
    if detail_key:
        if detail and detail != primary:
            return f"{primary}: {detail}"
    return primary


def _item_metadata(item: Dict[str, Any], keys: Iterable[str], labels=None) -> str:
    parts = []
    for key in keys:
        value = _format_scalar_or_list(item.get(key))
        if value:
            parts.append(f"{(labels or {}).get(key, key)}: {value}")
    return f" ({'; '.join(parts)})" if parts else ""


def _render_items(
    title: str,
    items: List[Dict[str, Any]],
    text_keys: Iterable[str],
    metadata_keys: Iterable[str],
    labels=None,
    *,
    detail_key: Optional[str] = None,
    field_labels=None,
    empty_policy: str = "show_empty",
) -> List[str]:
    labels = labels or {}
    if not items and empty_policy == "omit":
        return []
    lines = [f"## {title}", ""]
    if not items:
        lines.extend([labels.get("empty", "None captured."), ""])
        return lines

    meta_labels = field_labels if field_labels is not None else labels
    for item in items:
        text = _item_text(item, text_keys, labels.get("untitled", "Untitled"), detail_key=detail_key)
        lines.append(f"- {text}{_item_metadata(item, metadata_keys, meta_labels)}")
    lines.append("")
    return lines


def render_summary_markdown(summary: Dict[str, Any], metadata: Optional[Dict[str, Any]] = None) -> str:
    """Render a validated structured summary to Markdown for History display/export."""
    metadata = metadata or {}
    explicit_template = metadata.get("template") or metadata.get("tag") or (
        summary.get("template") if isinstance(summary, dict) else None
    )
    template = get_template(explicit_template, fallback="meeting")
    validated = validate_summary_json(summary, tag=template["template_id"] if explicit_template is not None else None)
    profile = _clean_text(metadata.get("profile"))
    model = _clean_text(metadata.get("model"))
    generated_at = _clean_text(metadata.get("generatedAt"))
    meta_tag = normalize_recording_tag(metadata.get("tag"), strict=False)

    language = metadata.get("language", "en")
    # Match the generated script for languages with two retained writing systems.
    prose = summary_prose(validated, tag=template["template_id"])
    if language == "pa" and re.search(r"[\u0600-\u06ff]", prose):
        language = "pa-Arab"
    elif language == "zh" and re.search(r"[會議們週準備預還設備問題負責試驗擴學習課講重點總結內容資訊觀眾聲樂錄音聽說話記錄這個為與從後發現關於經過進行應該時間開創藝術製作實踐設計]", prose):
        language = "zh-Hant"
    labels = get_localized_labels(language)
    field_labels = dict(labels["fields"])
    if "language" in metadata:
        profiles = dict(zip(("concise", "balanced", "detailed", "action-items"), PROFILE_LABELS.get(language, PROFILE_LABELS["en"])))
        profile = profiles.get(profile, profile)
    if "language" not in metadata:
        field_labels.update({key: key for key in field_labels})
    tag_display = labels["tag_names"].get(meta_tag, "") if meta_tag else ""

    template_id = template["template_id"]
    format_display = labels["tag_names"].get(template_id, template_id) if (
        metadata.get("template") and template_id != (meta_tag or "other")
    ) else ""

    lines = [f"# {labels['title']}", "", validated["summary"], ""]
    if tag_display or format_display or profile or model or generated_at:
        lines.append("---")
        lines.append("")
        if tag_display:
            lines.append(f"**{labels['tag']}:** {tag_display}")
        if format_display:
            lines.append(f"**Format:** {format_display}")
        if profile:
            lines.append(f"**{labels['profile']}:** {profile}")
        if model:
            lines.append(f"**{labels['model']}:** {model}")
        if generated_at:
            lines.append(f"**{labels['generated']}:** {generated_at}")
        lines.append("")

    empty_policy = template.get("empty_section_policy", "omit")
    for field in template["array_fields"]:
        spec = template["field_schemas"][field]
        section_title = labels["sections"].get(field, field.replace("_", " ").title())
        lines.extend(
            _render_items(
                section_title,
                validated[field],
                spec["text_keys"],
                spec["metadata_keys"],
                labels,
                detail_key=spec.get("detail_key"),
                field_labels=field_labels,
                empty_policy=empty_policy,
            )
        )

    return "\n".join(lines).rstrip() + "\n"
