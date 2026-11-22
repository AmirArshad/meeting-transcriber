"""Disposable SQLite FTS5 full-text index over local AvaNevis meeting history.

``meetings.json``, committed ``.md`` transcripts, ``{stem}.captions.json``
sidecars, and summary sidecars inside ``recordings_dir`` remain the sole source
of truth. This index lives in ``userData/search/history-index.sqlite`` and is
atomically rebuilt whenever missing, stale in schema, or corrupted.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from meeting_manager import MeetingManager
from meetings import normalization as meeting_norm
from meetings.speaker_names import normalize_speaker_names, speaker_names_hash
from summaries import language_labels as summary_language_labels
from summaries import summary_pipeline
from transcription import captions as transcript_captions

INDEX_SCHEMA_VERSION = "3"
TOKENIZER_SPEC = "porter unicode61 remove_diacritics 2"
SNIPPET_START = "\x01"
SNIPPET_END = "\x02"

TARGET_MIN_PASSAGE_MS = 15_000
MAX_PASSAGE_DURATION_MS = 25_000
HARD_MAX_PASSAGE_DURATION_MS = 30_000
TARGET_MIN_PASSAGE_CHARS = 260
MAX_PASSAGE_CHARS = 500
HARD_MAX_PASSAGE_CHARS = 600

UNTIMED_CHUNK_CHARS = 450

_TOKEN_SPLIT_RE = re.compile(r'[^\s"*^():\[\]{}<>,.!?;:/\\|`~+=@#$%&-]+')
_CJK_CHAR_RE = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]"
)
_ISO_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _build_summary_meta_line_re() -> re.Pattern[str]:
    keys = {
        "Profile",
        "Model",
        "Generated",
        "Tag",
        "Type",
        "Template",
        "File",
        "Date",
        "Duration",
        "Language",
        "Status",
        "Last error",
    }
    for row in summary_language_labels.LANGUAGE_LABELS.values():
        keys.update(row[8:11])
    keys.update(summary_language_labels.TAG_META_LABELS.values())
    escaped = "|".join(sorted((re.escape(k) for k in keys if k), key=len, reverse=True))
    return re.compile(
        rf"^\*\*(?:{escaped}):?\*\*.*$",
        re.IGNORECASE,
    )


_SUMMARY_META_LINE_RE = _build_summary_meta_line_re()


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _strip_sentinels(value: Any) -> str:
    cleaned = str(value or "").replace(SNIPPET_START, "").replace(SNIPPET_END, "")
    return re.sub(r"[ \t]+", " ", cleaned).strip()


def _clean_inline(value: Any) -> str:
    cleaned = str(value or "").replace(SNIPPET_START, "").replace(SNIPPET_END, "")
    return re.sub(r"\s+", " ", cleaned).strip()


def _contains_cjk(text: str) -> bool:
    return bool(_CJK_CHAR_RE.search(str(text or "")))


def _has_searchable_char(token: str) -> bool:
    return any(unicodedata.category(ch)[0] in ("L", "N") for ch in token)


def extract_query_tokens(raw_query: Any) -> List[str]:
    """Extract safe literal search tokens, stripping FTS5 syntax operators."""
    raw = str(raw_query or "").replace("\x00", " ").strip()
    if not raw:
        return []

    tokens: List[str] = []
    seen = set()
    for match in _TOKEN_SPLIT_RE.finditer(raw):
        token = _strip_sentinels(match.group(0)).strip("'_-")
        if not token or not _has_searchable_char(token):
            continue
        key = token.casefold()
        if key in seen:
            continue
        seen.add(key)
        tokens.append(token)
    return tokens


def build_fts5_query(
    raw_query: Any,
    *,
    mode: str = "and",
    prefix_last: bool = False,
) -> Tuple[str, List[str]]:
    """Build an injection-safe FTS5 MATCH string and return (match_expr, tokens)."""
    tokens = extract_query_tokens(raw_query)
    if not tokens:
        return "", []

    quoted: List[str] = []
    last_index = len(tokens) - 1
    for index, token in enumerate(tokens):
        safe = token.replace('"', "")
        if not safe:
            continue
        if (
            prefix_last
            and index == last_index
            and len(safe) >= 2
            and not _contains_cjk(safe)
        ):
            quoted.append(f'"{safe}"*')
        else:
            quoted.append(f'"{safe}"')

    if not quoted:
        return "", []

    joiner = " OR " if mode == "or" else " AND "
    return joiner.join(quoted), tokens


def snippet_text_to_parts(raw_snippet: Any) -> List[Dict[str, Any]]:
    """Convert sentinel-delimited snippet text into safe structured highlight parts."""
    text = str(raw_snippet or "")
    if not text:
        return []

    parts: List[Dict[str, Any]] = []
    cursor = 0
    while cursor < len(text):
        start_idx = text.find(SNIPPET_START, cursor)
        if start_idx == -1:
            tail = text[cursor:].replace(SNIPPET_END, "")
            if tail:
                parts.append({"text": tail, "match": False})
            break

        if start_idx > cursor:
            plain = text[cursor:start_idx].replace(SNIPPET_END, "")
            if plain:
                parts.append({"text": plain, "match": False})

        end_idx = text.find(SNIPPET_END, start_idx + 1)
        if end_idx == -1:
            rem = text[start_idx + 1 :].replace(SNIPPET_START, "")
            if rem:
                parts.append({"text": rem, "match": True})
            break

        highlighted = text[start_idx + 1 : end_idx].replace(SNIPPET_START, "")
        if highlighted:
            parts.append({"text": highlighted, "match": True})
        cursor = end_idx + 1

    merged: List[Dict[str, Any]] = []
    for part in parts:
        if not part["text"]:
            continue
        if merged and merged[-1]["match"] == part["match"]:
            merged[-1]["text"] += part["text"]
        else:
            merged.append(part)
    return merged


def _build_window_snippet_parts(
    text: str,
    tokens: Sequence[str],
    *,
    max_chars: int = 180,
) -> List[Dict[str, Any]]:
    cleaned = _clean_inline(text)
    if not cleaned:
        return []

    valid_tokens = [tok for tok in tokens if tok]
    if not valid_tokens:
        excerpt = cleaned[:max_chars] + ("…" if len(cleaned) > max_chars else "")
        return [{"text": excerpt, "match": False}]

    pattern = re.compile(
        "|".join(re.escape(tok) for tok in sorted(valid_tokens, key=len, reverse=True)),
        re.IGNORECASE,
    )
    first_match = pattern.search(cleaned)
    if not first_match:
        excerpt = cleaned[:max_chars] + ("…" if len(cleaned) > max_chars else "")
        return [{"text": excerpt, "match": False}]

    if len(cleaned) <= max_chars:
        window = cleaned
        prefix_ellipsis = ""
        suffix_ellipsis = ""
    else:
        half = max_chars // 2
        center = (first_match.start() + first_match.end()) // 2
        start = max(0, center - half)
        end = min(len(cleaned), start + max_chars)
        if end - start < max_chars:
            start = max(0, end - max_chars)
        window = cleaned[start:end]
        prefix_ellipsis = "…" if start > 0 else ""
        suffix_ellipsis = "…" if end < len(cleaned) else ""

    parts: List[Dict[str, Any]] = []
    if prefix_ellipsis:
        parts.append({"text": prefix_ellipsis, "match": False})

    pos = 0
    for match in pattern.finditer(window):
        if match.start() > pos:
            parts.append({"text": window[pos : match.start()], "match": False})
        parts.append({"text": match.group(0), "match": True})
        pos = match.end()
    if pos < len(window):
        parts.append({"text": window[pos:], "match": False})
    if suffix_ellipsis:
        parts.append({"text": suffix_ellipsis, "match": False})

    merged: List[Dict[str, Any]] = []
    for part in parts:
        if not part["text"]:
            continue
        if merged and merged[-1]["match"] == part["match"]:
            merged[-1]["text"] += part["text"]
        else:
            merged.append(part)
    return merged


def _parts_to_excerpt(parts: Sequence[Dict[str, Any]]) -> str:
    return "".join(str(part.get("text") or "") for part in parts).strip()


def _parse_duration_seconds(meeting: Dict[str, Any]) -> float:
    raw_seconds = meeting.get("durationSeconds")
    if raw_seconds is not None:
        try:
            value = float(raw_seconds)
            if value >= 0:
                return value
        except (TypeError, ValueError):
            pass

    raw_str = str(meeting.get("duration") or "").strip()
    if ":" in raw_str:
        try:
            parts = [int(p) for p in raw_str.split(":")]
            if len(parts) == 2:
                return float(parts[0] * 60 + parts[1])
            if len(parts) == 3:
                return float(parts[0] * 3600 + parts[1] * 60 + parts[2])
        except ValueError:
            pass
    return 0.0


def _is_placeholder_transcript(text: str, transcription_status: str) -> bool:
    if transcription_status in ("pending", "failed"):
        return True
    stripped = str(text or "").lstrip()
    if (
        stripped.startswith("# Recording Awaiting Transcription")
        and "The recording was saved successfully, but a transcript is not available yet." in stripped
    ):
        return True
    return False


def _group_caption_cues(cues: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Group caption-scale cues into ~15-25s / ~300-500 char search passages."""
    passages: List[Dict[str, Any]] = []
    bucket_texts: List[str] = []
    bucket_start_ms: Optional[int] = None
    bucket_end_ms: Optional[int] = None
    bucket_speaker: str = ""
    bucket_chars = 0

    def flush() -> None:
        nonlocal bucket_texts, bucket_start_ms, bucket_end_ms, bucket_speaker, bucket_chars
        if not bucket_texts or bucket_start_ms is None or bucket_end_ms is None:
            bucket_texts = []
            bucket_start_ms = None
            bucket_end_ms = None
            bucket_speaker = ""
            bucket_chars = 0
            return
        joined = " ".join(bucket_texts).strip()
        if joined:
            passages.append(
                {
                    "kind": "transcript",
                    "start_ms": bucket_start_ms,
                    "end_ms": max(bucket_start_ms + 100, bucket_end_ms),
                    "speaker": bucket_speaker,
                    "text": joined,
                }
            )
        bucket_texts = []
        bucket_start_ms = None
        bucket_end_ms = None
        bucket_speaker = ""
        bucket_chars = 0

    for cue in cues:
        if not isinstance(cue, dict):
            continue
        text = _clean_inline(cue.get("text"))
        if not text:
            continue
        try:
            start_ms = max(0, int(cue["startMs"]))
            end_ms = max(start_ms + 1, int(cue["endMs"]))
        except (KeyError, TypeError, ValueError):
            continue
        speaker = _clean_inline(cue.get("speaker"))

        if bucket_texts and bucket_start_ms is not None and bucket_end_ms is not None:
            current_duration = bucket_end_ms - bucket_start_ms
            prospective_duration = max(bucket_end_ms, end_ms) - bucket_start_ms
            prospective_chars = bucket_chars + 1 + len(text)

            speaker_changed = speaker != bucket_speaker
            soft_dur_reached = (
                prospective_duration > MAX_PASSAGE_DURATION_MS
                and (current_duration >= TARGET_MIN_PASSAGE_MS or bucket_chars >= TARGET_MIN_PASSAGE_CHARS)
            )
            soft_chars_reached = (
                prospective_chars > MAX_PASSAGE_CHARS and bucket_chars >= TARGET_MIN_PASSAGE_CHARS
            )
            hard_limit_reached = (
                prospective_duration > HARD_MAX_PASSAGE_DURATION_MS
                or prospective_chars > HARD_MAX_PASSAGE_CHARS
            )

            if speaker_changed or soft_dur_reached or soft_chars_reached or hard_limit_reached:
                flush()

        if bucket_start_ms is None:
            bucket_start_ms = start_ms
            bucket_end_ms = end_ms
            bucket_speaker = speaker
            bucket_texts = [text]
            bucket_chars = len(text)
        else:
            bucket_end_ms = max(bucket_end_ms or end_ms, end_ms)
            bucket_texts.append(text)
            bucket_chars += 1 + len(text)

    flush()
    return passages


def _chunk_plain_paragraphs(
    text: str,
    *,
    kind: str,
    max_chars: int = UNTIMED_CHUNK_CHARS,
) -> List[Dict[str, Any]]:
    """Split untimed Markdown/text into bounded passages while skipping header boilerplate."""
    lines = str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    paragraphs: List[Tuple[str, str]] = []
    current_lines: List[str] = []
    current_speaker = ""
    in_header_preamble = True
    before_first_section = True

    def flush_para(*, reset_speaker: bool = False) -> None:
        nonlocal current_speaker
        if current_lines:
            joined = _clean_inline(" ".join(current_lines))
            if joined:
                paragraphs.append((current_speaker, joined))
            current_lines.clear()
        if reset_speaker:
            current_speaker = ""

    for raw_line in lines:
        stripped = raw_line.strip()
        if not stripped:
            flush_para()
            continue
        if re.match(r"^#{2,6}\s+", stripped):
            before_first_section = False
        if in_header_preamble and re.match(r"^#\s+", stripped):
            continue
        if (in_header_preamble or (kind == "summary" and before_first_section)) and _SUMMARY_META_LINE_RE.match(stripped):
            continue
        if stripped in ("---", "***", "___"):
            flush_para(reset_speaker=True)
            continue
        if stripped.startswith("## ") and stripped[3:].strip().lower() == "transcript":
            in_header_preamble = False
            flush_para(reset_speaker=True)
            continue
        in_header_preamble = False
        if stripped.startswith("#"):
            flush_para(reset_speaker=True)
            heading_text = _clean_inline(re.sub(r"^#{1,6}\s+", "", stripped))
            if heading_text:
                current_lines.append(heading_text)
            continue

        line_body = re.sub(r"^[-*]\s+", "", stripped)
        if kind == "transcript":
            detected_speaker, speaker_text = _split_markdown_speaker_prefix(line_body)
            if detected_speaker:
                if current_lines and current_speaker != detected_speaker:
                    flush_para()
                current_speaker = detected_speaker
                if speaker_text:
                    current_lines.append(speaker_text)
                continue

        cleaned_line = _clean_inline(line_body)
        if cleaned_line:
            current_lines.append(cleaned_line)
    flush_para(reset_speaker=True)

    chunks: List[Dict[str, Any]] = []
    buf: List[str] = []
    buf_len = 0
    buf_speaker = ""

    def flush_chunk() -> None:
        nonlocal buf, buf_len, buf_speaker
        if buf:
            chunks.append(
                {
                    "kind": kind,
                    "start_ms": None,
                    "end_ms": None,
                    "speaker": buf_speaker,
                    "text": " ".join(buf).strip(),
                }
            )
            buf = []
            buf_len = 0
            buf_speaker = ""

    for speaker, para in paragraphs:
        if buf and speaker != buf_speaker:
            flush_chunk()

        if len(para) > max_chars:
            flush_chunk()
            for idx in range(0, len(para), max_chars):
                piece = para[idx : idx + max_chars].strip()
                if piece:
                    chunks.append(
                        {
                            "kind": kind,
                            "start_ms": None,
                            "end_ms": None,
                            "speaker": speaker,
                            "text": piece,
                        }
                    )
            continue

        if buf and buf_len + 1 + len(para) > max_chars:
            flush_chunk()
        if not buf:
            buf_speaker = speaker
        buf.append(para)
        buf_len += (1 if buf_len else 0) + len(para)

    flush_chunk()
    return chunks


_BOLD_SPEAKER_RE = re.compile(r"^\*\*(?P<speaker>[^*\n]{1,64}):\*\*\s*(?P<text>.*)$")
_PLAIN_SPEAKER_RE = re.compile(r"^(?P<speaker>Speaker\s+\d+|SPEAKER_\d{2}|Unknown):\s*(?P<text>.*)$", re.IGNORECASE)


def _split_markdown_speaker_prefix(raw_line: str) -> Tuple[str, str]:
    cleaned = _clean_inline(raw_line)
    for pattern in (_BOLD_SPEAKER_RE, _PLAIN_SPEAKER_RE):
        match = pattern.match(cleaned)
        if match:
            speaker = _clean_inline(match.group("speaker"))
            numbered = re.fullmatch(r"speaker\s+(\d+)", speaker, re.IGNORECASE)
            underscored = re.fullmatch(r"speaker_(\d{2})", speaker, re.IGNORECASE)
            if numbered:
                speaker = f"Speaker {numbered.group(1).lstrip('0') or '0'}"
            elif underscored:
                speaker = f"SPEAKER_{underscored.group(1)}"
            if speaker.lower() == "unknown":
                speaker = ""
            return speaker, _clean_inline(match.group("text"))
    return "", cleaned


def _build_markdown_passages(transcript_text: str) -> List[Dict[str, Any]]:
    lines = str(transcript_text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    passages: List[Dict[str, Any]] = []
    index = 0
    plain_lines: List[str] = []

    def flush_plain() -> None:
        for passage in _chunk_plain_paragraphs("\n".join(plain_lines), kind="transcript"):
            passages.append({**passage, "speaker": passage["speaker"] or None})
        plain_lines.clear()

    while index < len(lines):
        stripped = lines[index].strip()
        ts_match = summary_pipeline.TRANSCRIPT_TIMESTAMP_RE.match(stripped)
        if not ts_match:
            untimed = summary_pipeline.UNTIMED_SPEAKER_RE.match(stripped)
            if not untimed:
                plain_lines.append(lines[index])
                index += 1
                continue
            flush_plain()
            speaker = _clean_inline(untimed.group("speaker"))
            initial_text = _clean_inline(untimed.group("text"))
            text_parts = [initial_text] if initial_text else []
            cursor = index + 1
            while cursor < len(lines):
                body = lines[cursor].strip()
                if (not body or body.startswith("#") or body in ("---", "***", "___")
                        or summary_pipeline.TRANSCRIPT_TIMESTAMP_RE.match(body)
                        or summary_pipeline.UNTIMED_SPEAKER_RE.match(body)):
                    break
                text_parts.append(_clean_inline(body))
                cursor += 1
            joined = _clean_inline(" ".join(text_parts))
            if joined:
                passages.append({"kind": "transcript", "start_ms": None, "end_ms": None,
                                 "speaker": speaker, "text": joined})
            index = cursor
            continue

        flush_plain()
        start_sec = max(0.0, float(summary_pipeline.parse_timestamp(ts_match.group("start"))))
        end_sec = max(start_sec, float(summary_pipeline.parse_timestamp(ts_match.group("end"))))
        start_ms = int(round(start_sec * 1000.0))
        end_ms = max(start_ms + 100, int(round(end_sec * 1000.0)))

        speaker = ""
        text_parts: List[str] = []
        tail = _clean_inline(ts_match.group("tail"))
        if tail:
            inline_speaker, inline_text = _split_markdown_speaker_prefix(tail)
            if inline_speaker:
                speaker = inline_speaker
            if inline_text:
                text_parts.append(inline_text)

        cursor = index + 1
        while cursor < len(lines):
            next_stripped = lines[cursor].strip()
            if (
                summary_pipeline.TRANSCRIPT_TIMESTAMP_RE.match(next_stripped)
                or summary_pipeline.UNTIMED_SPEAKER_RE.match(next_stripped)
                or re.match(r"^#{1,6}\s+", next_stripped)
                or next_stripped in ("---", "***", "___")
            ):
                break
            if next_stripped:
                if not speaker and not text_parts:
                    body_speaker, body_text = _split_markdown_speaker_prefix(next_stripped)
                    if body_speaker:
                        speaker = body_speaker
                    if body_text:
                        text_parts.append(body_text)
                else:
                    cleaned_part = _clean_inline(next_stripped)
                    if cleaned_part:
                        text_parts.append(cleaned_part)
            cursor += 1

        joined = _clean_inline(" ".join(text_parts))
        if joined:
            passages.append(
                {
                    "kind": "transcript",
                    "start_ms": start_ms,
                    "end_ms": end_ms,
                    "speaker": speaker,
                    "text": joined,
                }
            )
        index = cursor

    flush_plain()
    return passages


def _resolve_meeting_captions(
    manager: MeetingManager,
    meeting: Dict[str, Any],
    transcript_hash: str,
) -> Tuple[str, Optional[List[Dict[str, Any]]]]:
    candidates: List[Path] = []
    explicit_path = meeting.get("captionsPath")
    if explicit_path:
        candidates.append(Path(str(explicit_path)))
    audio_path = meeting.get("audioPath")
    if audio_path:
        candidates.append(transcript_captions.captions_sidecar_path_for_audio(Path(str(audio_path))))

    seen = set()
    for candidate in candidates:
        safe_path = manager._resolve_accessible_recordings_file(
            candidate,
            allowed_suffixes=(".json",),
            must_exist=True,
            label="captions",
        )
        if safe_path is None:
            continue
        key = str(safe_path)
        if key in seen:
            continue
        seen.add(key)
        try:
            raw_text = safe_path.read_text(encoding="utf-8")
            payload = json.loads(raw_text)
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        valid, _reason = transcript_captions.validate_captions_payload(
            payload,
            expected_transcript_hash=transcript_hash,
            require_non_empty=True,
        )
        if valid:
            return transcript_captions.hash_transcript_text(raw_text), list(payload["cues"])

    return "", None


def _resolve_meeting_summary_text(
    manager: MeetingManager,
    meeting: Dict[str, Any],
    transcript_hash: str,
) -> Tuple[str, str]:
    summary_meta = (meeting.get("ai") or {}).get("summary")
    if not isinstance(summary_meta, dict):
        return "", ""
    status = summary_meta.get("status")
    if status not in (None, "completed"):
        return "", ""

    expected_hash = str(summary_meta.get("sourceTranscriptHash") or "").strip()
    if expected_hash:
        if expected_hash != transcript_hash:
            return "", ""
    else:
        if status != "completed":
            return "", ""
        transcription_result = meeting.get("transcriptionResult")
        has_attempt_id = isinstance(transcription_result, dict) and bool(transcription_result.get("attemptId"))
        has_attempt_path = ".transcript-" in Path(str(meeting.get("transcriptPath") or "")).name
        if has_attempt_id or has_attempt_path:
            return "", ""

    summary_path = summary_meta.get("markdownPath")
    if not summary_path:
        return "", ""
    safe_path = manager._resolve_accessible_recordings_file(
        Path(str(summary_path)),
        allowed_suffixes=(".md",),
        must_exist=True,
        label="summary",
    )
    if safe_path is None:
        return "", ""
    text = manager._read_text_file(safe_path, "summary")
    if not text.strip():
        return "", ""
    return transcript_captions.hash_transcript_text(text), text


def _connect_sqlite(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=5.0)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        conn.execute("PRAGMA foreign_keys = ON;")
        return conn
    except BaseException:
        conn.close()
        raise


def _create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        f"""
        CREATE TABLE IF NOT EXISTS index_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS indexed_meetings (
            meeting_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            date_iso TEXT NOT NULL,
            duration_sec REAL NOT NULL,
            language TEXT NOT NULL,
            tag TEXT NOT NULL DEFAULT '',
            speaker_names_hash TEXT NOT NULL DEFAULT '',
            transcript_hash TEXT NOT NULL,
            summary_hash TEXT NOT NULL,
            captions_hash TEXT NOT NULL,
            title_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS passages (
            passage_id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL REFERENCES indexed_meetings(meeting_id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            seq_index INTEGER NOT NULL,
            start_ms INTEGER,
            end_ms INTEGER,
            title TEXT NOT NULL,
            speaker TEXT NOT NULL,
            text TEXT NOT NULL,
            source_transcript_hash TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_passages_meeting_seq
            ON passages(meeting_id, seq_index);

        CREATE INDEX IF NOT EXISTS idx_indexed_meetings_date
            ON indexed_meetings(date_iso DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(
            title,
            speaker,
            text,
            content='passages',
            content_rowid='passage_id',
            tokenize='{TOKENIZER_SPEC}'
        );

        CREATE TRIGGER IF NOT EXISTS passages_ai AFTER INSERT ON passages BEGIN
            INSERT INTO passages_fts(rowid, title, speaker, text)
            VALUES (new.passage_id, new.title, new.speaker, new.text);
        END;

        CREATE TRIGGER IF NOT EXISTS passages_ad AFTER DELETE ON passages BEGIN
            INSERT INTO passages_fts(passages_fts, rowid, title, speaker, text)
            VALUES ('delete', old.passage_id, old.title, old.speaker, old.text);
        END;

        CREATE TRIGGER IF NOT EXISTS passages_au AFTER UPDATE ON passages BEGIN
            INSERT INTO passages_fts(passages_fts, rowid, title, speaker, text)
            VALUES ('delete', old.passage_id, old.title, old.speaker, old.text);
            INSERT INTO passages_fts(rowid, title, speaker, text)
            VALUES (new.passage_id, new.title, new.speaker, new.text);
        END;
        """
    )
    conn.execute(
        "INSERT OR REPLACE INTO index_meta(key, value) VALUES ('schema_version', ?)",
        (INDEX_SCHEMA_VERSION,),
    )


def _raise_if_busy(error: sqlite3.DatabaseError) -> None:
    if getattr(error, "sqlite_errorcode", 0) & 0xff in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
        raise error


def _schema_is_valid(conn: sqlite3.Connection) -> bool:
    try:
        tables = {
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
            ).fetchall()
        }
        if not {"index_meta", "indexed_meetings", "passages", "passages_fts"}.issubset(tables):
            return False
        row = conn.execute(
            "SELECT value FROM index_meta WHERE key = 'schema_version'"
        ).fetchone()
        if not row or row["value"] != INDEX_SCHEMA_VERSION:
            return False
        cols = {
            str(info["name"])
            for info in conn.execute("PRAGMA table_info(indexed_meetings)").fetchall()
        }
        if not {"tag", "speaker_names_hash"}.issubset(cols):
            return False
        conn.execute("SELECT count(*) FROM passages_fts").fetchone()
        return True
    except sqlite3.DatabaseError as error:
        _raise_if_busy(error)
        return False


def _remove_sqlite_sidecars(db_path: Path) -> None:
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(f"{db_path}{suffix}")
        try:
            sidecar.unlink(missing_ok=True)
        except OSError:
            pass


def _extract_meeting_snapshot(
    manager: MeetingManager,
    meeting: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    meeting_id = str(meeting.get("id") or "").strip()
    if not meeting_id:
        return None

    title = _clean_inline(meeting.get("title") or "Untitled recording") or "Untitled recording"
    date_iso = _clean_inline(meeting.get("date") or "")
    duration_sec = _parse_duration_seconds(meeting)
    language = _clean_inline(meeting.get("language") or "")
    tag = meeting_norm.normalize_recording_tag(meeting.get("tag"), strict=False) or ""
    diarization_meta = (meeting.get("ai") or {}).get("diarization")
    speaker_names = diarization_meta.get("speakerNames") if isinstance(diarization_meta, dict) else None
    speaker_names = normalize_speaker_names(speaker_names)
    names_hash = speaker_names_hash(speaker_names)
    status = str(meeting.get("transcriptionStatus") or "completed").strip().lower()
    title_hash = transcript_captions.hash_transcript_text(
        f"{title}|{date_iso}|{language}|{status}|{tag}|{names_hash}"
    )

    transcript_text = ""
    raw_transcript_path = meeting.get("transcriptPath")
    if raw_transcript_path:
        safe_transcript_path = manager._resolve_accessible_recordings_file(
            Path(str(raw_transcript_path)),
            allowed_suffixes=(".md",),
            must_exist=True,
            label="transcript",
        )
        if safe_transcript_path is not None:
            transcript_text = manager._read_transcript_text(safe_transcript_path)

    if not transcript_text and meeting.get("transcript"):
        transcript_text = str(meeting["transcript"])

    transcript_hash = ""
    captions_hash = ""
    summary_hash = ""
    caption_cues: Optional[List[Dict[str, Any]]] = None
    summary_text = ""

    if transcript_text.strip() and not _is_placeholder_transcript(transcript_text, status):
        transcript_hash = transcript_captions.hash_transcript_text(transcript_text)
        captions_hash, caption_cues = _resolve_meeting_captions(manager, meeting, transcript_hash)
        summary_hash, summary_text = _resolve_meeting_summary_text(manager, meeting, transcript_hash)
        if summary_hash:
            # Reindex existing summaries when passage extraction rules change.
            summary_hash = transcript_captions.hash_transcript_text(f"summary-passages-v2|{summary_hash}")

    return {
        "meeting_id": meeting_id,
        "title": title,
        "date_iso": date_iso,
        "duration_sec": duration_sec,
        "language": language,
        "tag": tag,
        "speaker_names_hash": names_hash,
        "speaker_names": speaker_names,
        "transcript_hash": transcript_hash,
        "summary_hash": summary_hash,
        "captions_hash": captions_hash,
        "title_hash": title_hash,
        "transcript_text": transcript_text,
        "caption_cues": caption_cues,
        "summary_text": summary_text,
    }


def _build_passages_for_snapshot(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    title = snapshot["title"]
    transcript_hash = snapshot["transcript_hash"]

    passages: List[Dict[str, Any]] = [
        {
            "kind": "title",
            "seq_index": 0,
            "start_ms": None,
            "end_ms": None,
            "title": title,
            "speaker": "",
            "text": "",
            "source_transcript_hash": transcript_hash,
        }
    ]

    seq = 1
    if transcript_hash:
        if snapshot["caption_cues"]:
            transcript_passages = _group_caption_cues(snapshot["caption_cues"])
        else:
            transcript_passages = _build_markdown_passages(snapshot["transcript_text"])

        for item in transcript_passages:
            text = _strip_sentinels(item["text"])
            if not text:
                continue
            passages.append(
                {
                    "kind": "transcript",
                    "seq_index": seq,
                    "start_ms": item["start_ms"],
                    "end_ms": item["end_ms"],
                    "title": title,
                    "speaker": _strip_sentinels(snapshot["speaker_names"].get(item.get("speaker", "")) or item.get("speaker", "")),
                    "text": text,
                    "source_transcript_hash": transcript_hash,
                }
            )
            seq += 1

        if snapshot["summary_text"]:
            for item in _chunk_plain_paragraphs(snapshot["summary_text"], kind="summary"):
                text = _strip_sentinels(item["text"])
                if not text:
                    continue
                passages.append(
                    {
                        "kind": "summary",
                        "seq_index": seq,
                        "start_ms": None,
                        "end_ms": None,
                        "title": title,
                        "speaker": "",
                        "text": text,
                        "source_transcript_hash": transcript_hash,
                    }
                )
                seq += 1

    return passages


def _sync_connection(conn: sqlite3.Connection, recordings_dir: Path) -> Dict[str, Any]:
    manager = MeetingManager(recordings_dir=str(recordings_dir))
    meetings = manager.list_meetings()

    existing_rows = {
        row["meeting_id"]: dict(row)
        for row in conn.execute(
            "SELECT meeting_id, transcript_hash, summary_hash, captions_hash, title_hash, tag, speaker_names_hash FROM indexed_meetings"
        ).fetchall()
    }

    snapshots: List[Dict[str, Any]] = []
    live_ids = set()
    for meeting in meetings:
        snap = _extract_meeting_snapshot(manager, meeting)
        if snap is None or snap["meeting_id"] in live_ids:
            continue
        live_ids.add(snap["meeting_id"])
        snapshots.append(snap)

    removed_ids = [mid for mid in existing_rows if mid not in live_ids]
    added_or_updated = 0
    now_iso = _utc_now_iso()

    with conn:
        for mid in removed_ids:
            conn.execute("DELETE FROM passages WHERE meeting_id = ?", (mid,))
            conn.execute("DELETE FROM indexed_meetings WHERE meeting_id = ?", (mid,))

        for snap in snapshots:
            mid = snap["meeting_id"]
            prev = existing_rows.get(mid)
            if (
                prev
                and prev["title_hash"] == snap["title_hash"]
                and prev["transcript_hash"] == snap["transcript_hash"]
                and prev["captions_hash"] == snap["captions_hash"]
                and prev["summary_hash"] == snap["summary_hash"]
                and prev["tag"] == snap["tag"]
                and prev["speaker_names_hash"] == snap["speaker_names_hash"]
            ):
                continue

            passages = _build_passages_for_snapshot(snap)
            conn.execute("DELETE FROM passages WHERE meeting_id = ?", (mid,))
            conn.execute(
                """
                INSERT OR REPLACE INTO indexed_meetings (
                    meeting_id, title, date_iso, duration_sec, language,
                    tag, speaker_names_hash,
                    transcript_hash, summary_hash, captions_hash, title_hash, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    mid,
                    snap["title"],
                    snap["date_iso"],
                    snap["duration_sec"],
                    snap["language"],
                    snap["tag"],
                    snap["speaker_names_hash"],
                    snap["transcript_hash"],
                    snap["summary_hash"],
                    snap["captions_hash"],
                    snap["title_hash"],
                    now_iso,
                ),
            )
            conn.executemany(
                """
                INSERT INTO passages (
                    meeting_id, kind, seq_index, start_ms, end_ms,
                    title, speaker, text, source_transcript_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        mid,
                        p["kind"],
                        p["seq_index"],
                        p["start_ms"],
                        p["end_ms"],
                        p["title"],
                        p["speaker"],
                        p["text"],
                        p["source_transcript_hash"],
                    )
                    for p in passages
                ],
            )
            added_or_updated += 1

        conn.execute(
            "INSERT OR REPLACE INTO index_meta(key, value) VALUES ('last_synced_at', ?)",
            (now_iso,),
        )

    total_meetings = conn.execute("SELECT COUNT(*) FROM indexed_meetings").fetchone()[0]
    total_passages = conn.execute("SELECT COUNT(*) FROM passages").fetchone()[0]
    return {
        "schemaVersion": INDEX_SCHEMA_VERSION,
        "syncedMeetings": added_or_updated,
        "removedMeetings": len(removed_ids),
        "totalMeetings": int(total_meetings),
        "totalPassages": int(total_passages),
        "lastSyncedAt": now_iso,
    }


def rebuild_history_index(recordings_dir: str | Path, index_path: str | Path) -> Dict[str, Any]:
    """Atomically build a fresh SQLite FTS5 index via temp file + os.replace."""
    rec_dir = Path(recordings_dir)
    target = Path(index_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{target.name}.rebuild.",
        suffix=".sqlite.tmp",
        dir=str(target.parent),
    )
    os.close(fd)
    tmp_path = Path(tmp_name)

    try:
        conn = _connect_sqlite(tmp_path)
        try:
            _create_schema(conn)
            stats = _sync_connection(conn, rec_dir)
            # Switch temp file to DELETE mode before replacing so no stale -wal
            # from the temp filename remains orphaned.
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            conn.execute("PRAGMA journal_mode = DELETE;")
        finally:
            conn.close()

        _remove_sqlite_sidecars(tmp_path)
        if target.exists():
            # Refuse replacement while another connection owns the WAL.  A
            # successful mode switch checkpoints it before any sidecar removal.
            existing = sqlite3.connect(str(target), timeout=5.0)
            try:
                existing.execute("PRAGMA busy_timeout = 5000")
                checkpoint = existing.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
                if checkpoint and checkpoint[0]:
                    raise sqlite3.OperationalError("History index WAL is busy")
                mode = existing.execute("PRAGMA journal_mode = DELETE").fetchone()
                if not mode or mode[0].lower() != "delete":
                    raise sqlite3.OperationalError("History index WAL could not be closed")
            except sqlite3.DatabaseError as error:
                if getattr(error, "sqlite_errorcode", 0) & 0xff not in (sqlite3.SQLITE_CORRUPT, sqlite3.SQLITE_NOTADB):
                    raise
                # Corrupt databases cannot be checkpointed.
            finally:
                existing.close()
        _remove_sqlite_sidecars(target)
        os.replace(tmp_path, target)
    finally:
        if tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        _remove_sqlite_sidecars(tmp_path)

    return {
        **stats,
        "indexPath": str(target),
        "rebuilt": True,
    }


def _ensure_synced_connection(
    recordings_dir: Path,
    index_path: Path,
    *,
    perform_sync: bool = True,
) -> Tuple[sqlite3.Connection, Optional[Dict[str, Any]]]:
    if not index_path.exists():
        stats = rebuild_history_index(recordings_dir, index_path)
        conn = _connect_sqlite(index_path)
        return conn, stats

    conn = None
    try:
        conn = _connect_sqlite(index_path)
        if not _schema_is_valid(conn):
            conn.close()
            stats = rebuild_history_index(recordings_dir, index_path)
            return _connect_sqlite(index_path), stats
        if perform_sync:
            stats = _sync_connection(conn, recordings_dir)
            stats["indexPath"] = str(index_path)
            stats["rebuilt"] = False
            return conn, stats
        return conn, None
    except sqlite3.DatabaseError as error:
        if conn is not None:
            conn.close()
        _raise_if_busy(error)
        stats = rebuild_history_index(recordings_dir, index_path)
        return _connect_sqlite(index_path), stats


def sync_history_index(recordings_dir: str | Path, index_path: str | Path) -> Dict[str, Any]:
    """Incrementally sync the SQLite FTS5 index against live meeting history."""
    rec_dir = Path(recordings_dir)
    target = Path(index_path)
    conn, stats = _ensure_synced_connection(rec_dir, target, perform_sync=True)
    conn.close()
    return stats or {"indexPath": str(target), "rebuilt": False}


def _safe_file_size(path: Path) -> int:
    try:
        return int(path.stat().st_size)
    except OSError:
        return 0


def get_history_index_status(recordings_dir: str | Path, index_path: str | Path) -> Dict[str, Any]:
    """Inspect current SQLite FTS5 index counts and metadata without forcing rebuild."""
    target = Path(index_path)
    db_size_bytes = _safe_file_size(target) if target.exists() else 0
    if not target.exists():
        return {
            "indexPath": str(target),
            "exists": False,
            "valid": False,
            "schemaVersion": INDEX_SCHEMA_VERSION,
            "totalMeetings": 0,
            "totalPassages": 0,
            "dbSizeBytes": 0,
            "lastSyncedAt": None,
        }
    try:
        conn = _connect_sqlite(target)
        try:
            valid = _schema_is_valid(conn)
            if not valid:
                return {
                    "indexPath": str(target),
                    "exists": True,
                    "valid": False,
                    "schemaVersion": INDEX_SCHEMA_VERSION,
                    "totalMeetings": 0,
                    "totalPassages": 0,
                    "dbSizeBytes": db_size_bytes,
                    "lastSyncedAt": None,
                }
            total_meetings = conn.execute("SELECT COUNT(*) FROM indexed_meetings").fetchone()[0]
            total_passages = conn.execute("SELECT COUNT(*) FROM passages").fetchone()[0]
            synced_row = conn.execute(
                "SELECT value FROM index_meta WHERE key = 'last_synced_at'"
            ).fetchone()
            return {
                "indexPath": str(target),
                "exists": True,
                "valid": True,
                "schemaVersion": INDEX_SCHEMA_VERSION,
                "totalMeetings": int(total_meetings),
                "totalPassages": int(total_passages),
                "dbSizeBytes": _safe_file_size(target),
                "lastSyncedAt": synced_row["value"] if synced_row else None,
            }
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        return {
            "indexPath": str(target),
            "exists": True,
            "valid": False,
            "schemaVersion": INDEX_SCHEMA_VERSION,
            "totalMeetings": 0,
            "totalPassages": 0,
            "dbSizeBytes": db_size_bytes,
            "lastSyncedAt": None,
        }


def build_scope_sql_filters(
    *,
    meeting_ids: Optional[Sequence[str]] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    tags: Optional[Sequence[str]] = None,
) -> Tuple[List[str], List[Any]]:
    clauses: List[str] = []
    params: List[Any] = []

    if meeting_ids is not None:
        cleaned_ids = [str(mid).strip() for mid in meeting_ids if str(mid or "").strip()]
        if not cleaned_ids:
            clauses.append("1 = 0")
        else:
            placeholders = ", ".join("?" for _ in cleaned_ids)
            clauses.append(f"p.meeting_id IN ({placeholders})")
            params.extend(cleaned_ids)

    if tags is not None:
        if not isinstance(tags, (list, tuple)):
            raise ValueError("Invalid recording tags in scope filter.")
        cleaned_tags: List[str] = []
        seen_tags = set()
        for raw_tag in tags:
            if not isinstance(raw_tag, str) or not raw_tag.strip():
                raise ValueError("Invalid recording tag in scope filter.")
            normalized_tag = meeting_norm.normalize_recording_tag(raw_tag, strict=True)
            if normalized_tag and normalized_tag not in seen_tags:
                seen_tags.add(normalized_tag)
                cleaned_tags.append(normalized_tag)
        if cleaned_tags:
            placeholders = ", ".join("?" for _ in cleaned_tags)
            clauses.append(f"m.tag IN ({placeholders})")
            params.extend(cleaned_tags)

    clean_from = str(date_from or "").strip()
    if clean_from:
        if _ISO_DAY_RE.fullmatch(clean_from):
            clauses.append("substr(m.date_iso, 1, 10) >= ?")
        else:
            clauses.append("m.date_iso >= ?")
        params.append(clean_from)

    clean_to = str(date_to or "").strip()
    if clean_to:
        if _ISO_DAY_RE.fullmatch(clean_to):
            clauses.append("substr(m.date_iso, 1, 10) <= ?")
        else:
            clauses.append("m.date_iso <= ?")
        params.append(clean_to)

    return clauses, params


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _format_passage_hit(
    row: sqlite3.Row,
    tokens: Sequence[str],
) -> Dict[str, Any]:
    kind = row["kind"]
    title = row["meeting_title"]
    text = row["text"] or ""
    speaker = row["speaker"] or ""
    raw_text_snippet = row["text_snippet"] if "text_snippet" in row.keys() else ""
    raw_speaker_snippet = row["speaker_snippet"] if "speaker_snippet" in row.keys() else ""
    raw_title_snippet = row["title_snippet"] if "title_snippet" in row.keys() else ""

    has_body_match = (
        SNIPPET_START in str(raw_text_snippet or "")
        or SNIPPET_START in str(raw_speaker_snippet or "")
    )
    has_title_match = SNIPPET_START in str(raw_title_snippet or "")

    if kind == "title":
        parts = (
            snippet_text_to_parts(raw_title_snippet)
            if has_title_match
            else _build_window_snippet_parts(title, tokens, max_chars=120)
        )
    elif SNIPPET_START in str(raw_text_snippet or ""):
        parts = snippet_text_to_parts(raw_text_snippet)
    elif has_body_match:
        parts = _build_window_snippet_parts(text or speaker, tokens, max_chars=180)
    else:
        parts = _build_window_snippet_parts(text or title, tokens, max_chars=180)

    if kind != "title" and speaker and SNIPPET_START in str(raw_speaker_snippet or ""):
        parts = [*snippet_text_to_parts(raw_speaker_snippet), {"text": ": ", "match": False}, *parts]

    body_token_match = kind != "title" and any(
        tok.casefold() in text.casefold() or tok.casefold() in speaker.casefold()
        for tok in tokens
        if tok
    )

    start_ms = row["start_ms"]
    end_ms = row["end_ms"]
    return {
        "passageId": int(row["passage_id"]),
        "kind": kind,
        "seqIndex": int(row["seq_index"]),
        "startMs": int(start_ms) if start_ms is not None else None,
        "endMs": int(end_ms) if end_ms is not None else None,
        "startSec": round(start_ms / 1000.0, 3) if start_ms is not None else None,
        "endSec": round(end_ms / 1000.0, 3) if end_ms is not None else None,
        "speaker": speaker,
        "text": text,
        "excerpt": _parts_to_excerpt(parts),
        "snippetParts": parts,
        "rank": float(row["rank_score"]),
        "matchedBody": bool(has_body_match or body_token_match),
        "sourceTranscriptHash": str(row["source_transcript_hash"] or ""),
    }


def _query_passages(
    conn: sqlite3.Connection,
    *,
    raw_query: str,
    meeting_ids: Optional[Sequence[str]],
    date_from: Optional[str],
    date_to: Optional[str],
    tags: Optional[Sequence[str]] = None,
    limit_rows: int,
    max_matches_per_meeting: int = 3,
) -> Tuple[List[sqlite3.Row], List[str]]:
    scope_clauses, scope_params = build_scope_sql_filters(
        meeting_ids=meeting_ids,
        date_from=date_from,
        date_to=date_to,
        tags=tags,
    )
    per_meeting_cap = max(1, int(max_matches_per_meeting))

    match_and, tokens = build_fts5_query(raw_query, mode="and", prefix_last=True)
    if not match_and or not tokens:
        return [], []

    def run_fts(match_expr: str) -> List[sqlite3.Row]:
        where_parts = ["passages_fts MATCH ?", *scope_clauses]
        where_sql = " AND ".join(where_parts)
        sql = f"""
            WITH matched AS (
                SELECT
                    p.passage_id,
                    p.meeting_id,
                    p.kind,
                    p.seq_index,
                    p.start_ms,
                    p.end_ms,
                    p.speaker,
                    p.text,
                    p.source_transcript_hash,
                    m.title AS meeting_title,
                    m.date_iso AS meeting_date,
                    m.language AS meeting_language,
                    m.duration_sec AS meeting_duration_sec,
                    m.tag AS meeting_tag,
                    bm25(passages_fts, 4.0, 1.5, 1.0) AS rank_score,
                    snippet(passages_fts, 0, '{SNIPPET_START}', '{SNIPPET_END}', '…', 20) AS title_snippet,
                    snippet(passages_fts, 1, '{SNIPPET_START}', '{SNIPPET_END}', '…', 20) AS speaker_snippet,
                    snippet(passages_fts, 2, '{SNIPPET_START}', '{SNIPPET_END}', '…', 20) AS text_snippet,
                    (CASE
                        WHEN instr(snippet(passages_fts, 2, '{SNIPPET_START}', '{SNIPPET_END}', '…', 20), '{SNIPPET_START}') > 0
                          OR instr(snippet(passages_fts, 1, '{SNIPPET_START}', '{SNIPPET_END}', '…', 20), '{SNIPPET_START}') > 0
                        THEN 0
                        WHEN p.kind = 'title' THEN 1
                        ELSE 2
                    END) AS body_tier,
                    (CASE WHEN p.kind = 'transcript' THEN 0 WHEN p.kind = 'summary' THEN 1 ELSE 2 END) AS kind_tier
                FROM passages_fts
                JOIN passages p ON p.passage_id = passages_fts.rowid
                JOIN indexed_meetings m ON m.meeting_id = p.meeting_id
                WHERE {where_sql}
            ),
            ranked AS (
                SELECT
                    *,
                    ROW_NUMBER() OVER (
                        PARTITION BY meeting_id
                        ORDER BY body_tier ASC, kind_tier ASC, rank_score ASC, seq_index ASC
                    ) AS rn
                FROM matched
            )
            SELECT
                passage_id,
                meeting_id,
                kind,
                seq_index,
                start_ms,
                end_ms,
                speaker,
                text,
                source_transcript_hash,
                meeting_title,
                meeting_date,
                meeting_language,
                meeting_duration_sec,
                meeting_tag,
                rank_score,
                title_snippet,
                speaker_snippet,
                text_snippet
            FROM ranked
            WHERE rn <= ?
            ORDER BY
                body_tier ASC,
                kind_tier ASC,
                rank_score ASC,
                meeting_date DESC,
                seq_index ASC
            LIMIT ?
        """
        return conn.execute(sql, [match_expr, *scope_params, per_meeting_cap, limit_rows]).fetchall()

    rows = run_fts(match_and)
    if not rows and len(tokens) > 1:
        match_or, _ = build_fts5_query(raw_query, mode="or", prefix_last=True)
        if match_or:
            rows = run_fts(match_or)

    # CJK queries without word boundaries fall back to parameterized LIKE matching
    # because SQLite's unicode61 tokenizer treats unspaced CJK runs as one token.
    if not rows and any(_contains_cjk(tok) for tok in tokens):
        like_clauses: List[str] = []
        like_params: List[Any] = []
        body_check_clauses: List[str] = []
        body_check_params: List[Any] = []
        for tok in tokens:
            pattern = f"%{_escape_like(tok)}%"
            like_clauses.append(
                "(p.text LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\' OR p.speaker LIKE ? ESCAPE '\\')"
            )
            like_params.extend([pattern, pattern, pattern])
            body_check_clauses.append("(p.text LIKE ? ESCAPE '\\' OR p.speaker LIKE ? ESCAPE '\\')")
            body_check_params.extend([pattern, pattern])
        where_parts = [*like_clauses, *scope_clauses]
        where_sql = " AND ".join(where_parts)
        body_check_sql = " OR ".join(body_check_clauses)
        sql = f"""
            WITH matched AS (
                SELECT
                    p.passage_id,
                    p.meeting_id,
                    p.kind,
                    p.seq_index,
                    p.start_ms,
                    p.end_ms,
                    p.speaker,
                    p.text,
                    p.source_transcript_hash,
                    m.title AS meeting_title,
                    m.date_iso AS meeting_date,
                    m.language AS meeting_language,
                    m.duration_sec AS meeting_duration_sec,
                    m.tag AS meeting_tag,
                    (CASE WHEN p.kind = 'transcript' THEN -2.0 WHEN p.kind = 'summary' THEN -1.5 ELSE -1.0 END) AS rank_score,
                    '' AS title_snippet,
                    '' AS speaker_snippet,
                    '' AS text_snippet,
                    (CASE
                        WHEN ({body_check_sql}) THEN 0
                        WHEN p.kind = 'title' THEN 1
                        ELSE 2
                    END) AS body_tier,
                    (CASE WHEN p.kind = 'transcript' THEN 0 WHEN p.kind = 'summary' THEN 1 ELSE 2 END) AS kind_tier
                FROM passages p
                JOIN indexed_meetings m ON m.meeting_id = p.meeting_id
                WHERE {where_sql}
            ),
            ranked AS (
                SELECT
                    *,
                    ROW_NUMBER() OVER (
                        PARTITION BY meeting_id
                        ORDER BY body_tier ASC, kind_tier ASC, seq_index ASC
                    ) AS rn
                FROM matched
            )
            SELECT
                passage_id,
                meeting_id,
                kind,
                seq_index,
                start_ms,
                end_ms,
                speaker,
                text,
                source_transcript_hash,
                meeting_title,
                meeting_date,
                meeting_language,
                meeting_duration_sec,
                meeting_tag,
                rank_score,
                title_snippet,
                speaker_snippet,
                text_snippet
            FROM ranked
            WHERE rn <= ?
            ORDER BY
                body_tier ASC,
                kind_tier ASC,
                meeting_date DESC,
                seq_index ASC
            LIMIT ?
        """
        rows = conn.execute(
            sql,
            [*body_check_params, *like_params, *scope_params, per_meeting_cap, limit_rows],
        ).fetchall()

    return rows, tokens


def search_history_index(
    recordings_dir: str | Path,
    index_path: str | Path,
    *,
    query: str,
    limit: int = 50,
    max_matches_per_meeting: int = 3,
    meeting_id: Optional[str] = None,
    meeting_ids: Optional[Sequence[str]] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    tags: Optional[Sequence[str]] = None,
    sync: bool = True,
    conn: Optional[sqlite3.Connection] = None,
) -> Dict[str, Any]:
    """Search meeting titles, transcripts, speakers, and summaries via SQLite FTS5."""
    rec_dir = Path(recordings_dir)
    target = Path(index_path)
    raw_query = str(query or "").strip()

    scoped_ids: Optional[List[str]] = None
    if meeting_id is not None:
        scoped_ids = [str(meeting_id).strip()]
    elif meeting_ids is not None:
        scoped_ids = [str(mid).strip() for mid in meeting_ids]

    build_scope_sql_filters(meeting_ids=scoped_ids, date_from=date_from, date_to=date_to, tags=tags)
    tokens = extract_query_tokens(raw_query)
    if not tokens:
        total = 0
        if conn is not None:
            total = int(conn.execute("SELECT COUNT(*) FROM indexed_meetings").fetchone()[0])
        elif sync:
            stats = sync_history_index(rec_dir, target)
            total = int(stats.get("totalMeetings") or 0)
        elif target.exists():
            status = get_history_index_status(rec_dir, target)
            if status.get("valid"):
                total = int(status.get("totalMeetings") or 0)
        return {
            "query": raw_query,
            "totalMeetings": total,
            "matchedMeetingCount": 0,
            "meetings": [],
        }

    def run_search(active_conn: sqlite3.Connection) -> Dict[str, Any]:
        total_meetings = active_conn.execute("SELECT COUNT(*) FROM indexed_meetings").fetchone()[0]
        capped_matches = max(1, int(max_matches_per_meeting))
        row_limit = max(1, int(limit)) * capped_matches
        rows, matched_tokens = _query_passages(
            active_conn,
            raw_query=raw_query,
            meeting_ids=scoped_ids,
            date_from=date_from,
            date_to=date_to,
            tags=tags,
            limit_rows=row_limit,
            max_matches_per_meeting=capped_matches,
        )

        grouped: Dict[str, Dict[str, Any]] = {}
        order: List[str] = []
        for row in rows:
            mid = row["meeting_id"]
            hit = _format_passage_hit(row, matched_tokens)
            entry = grouped.get(mid)
            if entry is None:
                entry = {
                    "meetingId": mid,
                    "title": row["meeting_title"],
                    "date": row["meeting_date"],
                    "language": row["meeting_language"],
                    "durationSeconds": float(row["meeting_duration_sec"] or 0.0),
                    "tag": str(row["meeting_tag"] or ""),
                    "score": hit["rank"],
                    "bestPassage": hit,
                    "matches": [hit],
                }
                grouped[mid] = entry
                order.append(mid)
                continue

            if len(entry["matches"]) < max(1, int(max_matches_per_meeting)):
                if hit["matchedBody"]:
                    entry["matches"].append(hit)
                    if not entry["bestPassage"]["matchedBody"]:
                        entry["bestPassage"] = hit
                elif hit["kind"] == "title" and not any(m["kind"] == "title" for m in entry["matches"]) and not entry["bestPassage"]["matchedBody"]:
                    entry["matches"].append(hit)

        meetings_out = [grouped[mid] for mid in order[: max(1, int(limit))]]
        return {
            "query": raw_query,
            "totalMeetings": int(total_meetings),
            "matchedMeetingCount": len(meetings_out),
            "meetings": meetings_out,
        }

    if conn is not None:
        return run_search(conn)

    owned_conn, _stats = _ensure_synced_connection(rec_dir, target, perform_sync=sync)
    try:
        try:
            return run_search(owned_conn)
        except sqlite3.DatabaseError as error:
            _raise_if_busy(error)
            owned_conn.close()
            rebuild_history_index(rec_dir, target)
            owned_conn = _connect_sqlite(target)
            return run_search(owned_conn)
    finally:
        try:
            owned_conn.close()
        except Exception:
            pass


def list_indexed_meeting_headers(
    conn: sqlite3.Connection,
    *,
    meeting_ids: Optional[Sequence[str]] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    tags: Optional[Sequence[str]] = None,
) -> List[Dict[str, Any]]:
    """Return lightweight metadata headers and distinct speakers for scoped indexed meetings."""
    if meeting_ids is not None:
        cleaned_ids = [str(mid).strip() for mid in meeting_ids if str(mid or "").strip()]
        if not cleaned_ids:
            return []
    clauses, params = build_scope_sql_filters(
        meeting_ids=meeting_ids,
        date_from=date_from,
        date_to=date_to,
        tags=tags,
    )
    m_clauses = [clause.replace("p.meeting_id", "m.meeting_id") for clause in clauses]
    where_sql = f"WHERE {' AND '.join(m_clauses)}" if m_clauses else ""

    rows = conn.execute(
        f"""
        SELECT
            m.meeting_id,
            m.title,
            m.date_iso,
            m.duration_sec,
            m.language,
            m.tag,
            m.transcript_hash,
            (CASE WHEN m.summary_hash != '' THEN 1 ELSE 0 END) AS has_summary
        FROM indexed_meetings m
        {where_sql}
        ORDER BY m.date_iso DESC, m.meeting_id DESC
        """,
        params,
    ).fetchall()
    if not rows:
        return []

    speaker_clauses = [*m_clauses, "p.speaker != ''"]
    speaker_where_sql = f"WHERE {' AND '.join(speaker_clauses)}"
    speaker_rows = conn.execute(
        f"""
        SELECT DISTINCT p.meeting_id, p.speaker
        FROM passages p
        JOIN indexed_meetings m ON m.meeting_id = p.meeting_id
        {speaker_where_sql}
        """,
        params,
    ).fetchall()
    speakers_by_meeting: Dict[str, List[str]] = {}
    for srow in speaker_rows:
        mid = str(srow["meeting_id"])
        spk = str(srow["speaker"] or "").strip()
        if spk:
            speakers_by_meeting.setdefault(mid, []).append(spk)

    return [
        {
            "meetingId": str(row["meeting_id"]),
            "title": str(row["title"] or "Untitled recording"),
            "date": str(row["date_iso"] or ""),
            "durationSeconds": float(row["duration_sec"] or 0.0),
            "language": str(row["language"] or ""),
            "tag": str(row["tag"] or ""),
            "transcriptHash": str(row["transcript_hash"] or ""),
            "hasSummary": bool(row["has_summary"]),
            "speakers": speakers_by_meeting.get(str(row["meeting_id"]), []),
        }
        for row in rows
    ]


def _row_to_passage_record(row: sqlite3.Row) -> Dict[str, Any]:
    start_ms = row["start_ms"]
    end_ms = row["end_ms"]
    text = str(row["text"] or "").strip()
    return {
        "passageId": int(row["passage_id"]),
        "meetingId": str(row["meeting_id"]),
        "meetingTitle": str(row["meeting_title"] or "Untitled recording"),
        "meetingDate": str(row["meeting_date"] or ""),
        "tag": str(row["meeting_tag"] or ""),
        "kind": str(row["kind"] or "transcript"),
        "seqIndex": int(row["seq_index"]),
        "startMs": int(start_ms) if start_ms is not None else None,
        "endMs": int(end_ms) if end_ms is not None else None,
        "startSec": round(start_ms / 1000.0, 3) if start_ms is not None else None,
        "endSec": round(end_ms / 1000.0, 3) if end_ms is not None else None,
        "speaker": str(row["speaker"] or ""),
        "text": text,
        "excerpt": text if len(text) <= 220 else f"{text[:219]}…",
        "sourceTranscriptHash": str(row["source_transcript_hash"] or ""),
    }


def fetch_meeting_passages(
    conn: sqlite3.Connection,
    meeting_ids: Sequence[str],
    *,
    kinds: Optional[Sequence[str]] = None,
) -> List[Dict[str, Any]]:
    """Fetch passages for specific meeting IDs in deterministic chronological order."""
    clean_ids = [str(mid).strip() for mid in meeting_ids if str(mid or "").strip()]
    if not clean_ids:
        return []
    id_placeholders = ", ".join("?" for _ in clean_ids)
    clauses = [f"p.meeting_id IN ({id_placeholders})"]
    params: List[Any] = list(clean_ids)
    if kinds:
        clean_kinds = [str(k).strip() for k in kinds if str(k or "").strip()]
        if clean_kinds:
            kind_placeholders = ", ".join("?" for _ in clean_kinds)
            clauses.append(f"p.kind IN ({kind_placeholders})")
            params.extend(clean_kinds)
    where_sql = " AND ".join(clauses)
    rows = conn.execute(
        f"""
        SELECT
            p.passage_id,
            p.meeting_id,
            p.kind,
            p.seq_index,
            p.start_ms,
            p.end_ms,
            p.speaker,
            p.text,
            p.source_transcript_hash,
            m.title AS meeting_title,
            m.date_iso AS meeting_date,
            m.tag AS meeting_tag
        FROM passages p
        JOIN indexed_meetings m ON m.meeting_id = p.meeting_id
        WHERE {where_sql}
        ORDER BY p.meeting_id ASC, p.seq_index ASC
        """,
        params,
    ).fetchall()
    return [_row_to_passage_record(row) for row in rows]


def fetch_neighbor_passages(
    conn: sqlite3.Connection,
    meeting_id: str,
    seq_indices: Sequence[int],
) -> List[Dict[str, Any]]:
    """Fetch adjacent transcript passages for k+-1 context expansion."""
    clean_id = str(meeting_id or "").strip()
    clean_seqs = sorted({int(idx) for idx in seq_indices if int(idx) >= 1})
    if not clean_id or not clean_seqs:
        return []
    placeholders = ", ".join("?" for _ in clean_seqs)
    rows = conn.execute(
        f"""
        SELECT
            p.passage_id,
            p.meeting_id,
            p.kind,
            p.seq_index,
            p.start_ms,
            p.end_ms,
            p.speaker,
            p.text,
            p.source_transcript_hash,
            m.title AS meeting_title,
            m.date_iso AS meeting_date,
            m.tag AS meeting_tag
        FROM passages p
        JOIN indexed_meetings m ON m.meeting_id = p.meeting_id
        WHERE p.meeting_id = ?
          AND p.kind = 'transcript'
          AND p.seq_index IN ({placeholders})
        ORDER BY p.seq_index ASC
        """,
        [clean_id, *clean_seqs],
    ).fetchall()
    return [_row_to_passage_record(row) for row in rows]
