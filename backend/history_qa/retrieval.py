"""Scoped SQLite FTS5 evidence retrieval for grounded local History Q&A."""

from __future__ import annotations

import argparse
import calendar
import json
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from meetings.normalization import normalize_recording_tag, recording_tag_display_label
from search.history_index import (
    _connect_sqlite,
    _ensure_synced_connection,
    _raise_if_busy,
    build_scope_sql_filters,
    extract_query_tokens,
    fetch_meeting_passages,
    fetch_neighbor_passages,
    list_indexed_meeting_headers,
    rebuild_history_index,
    search_history_index,
)

MAX_EVIDENCE_BLOCKS = 12
MAX_EVIDENCE_TOKENS = 14_000
OVERVIEW_MAX_EVIDENCE_BLOCKS = 40
OVERVIEW_MAX_EVIDENCE_TOKENS = 20_000
MAX_OVERVIEW_MEETINGS = 3
MAX_PASSAGES_PER_MEETING_CANDIDATE = 6
TARGETED_DIVERSITY_CAP = 3
TARGETED_DIVERSITY_MEETING_THRESHOLD = 4
MAX_MERGED_PASSAGE_GAP_MS = 10_000
MAX_MERGED_PASSAGE_CHARS = 1_200
OVERVIEW_MAX_MERGED_CHARS = 1_600

_QUESTION_STOPWORDS = frozenset(
    {
        "a",
        "about",
        "action",
        "after",
        "agenda",
        "agree",
        "agreed",
        "all",
        "an",
        "and",
        "another",
        "any",
        "anything",
        "are",
        "as",
        "at",
        "audio",
        "be",
        "before",
        "but",
        "by",
        "came",
        "can",
        "clarify",
        "come",
        "comes",
        "conclusion",
        "conclusions",
        "continue",
        "could",
        "cover",
        "covered",
        "deadline",
        "deadlines",
        "decide",
        "decided",
        "decision",
        "decisions",
        "detail",
        "details",
        "did",
        "discuss",
        "discussed",
        "do",
        "does",
        "elaborate",
        "else",
        "emerged",
        "everything",
        "expand",
        "explain",
        "file",
        "files",
        "follow",
        "followup",
        "followups",
        "for",
        "from",
        "give",
        "had",
        "happen",
        "happened",
        "has",
        "have",
        "he",
        "her",
        "here",
        "highlight",
        "highlights",
        "him",
        "his",
        "how",
        "i",
        "if",
        "important",
        "in",
        "into",
        "is",
        "issue",
        "issues",
        "it",
        "item",
        "items",
        "its",
        "key",
        "last",
        "latest",
        "left",
        "list",
        "made",
        "main",
        "me",
        "mean",
        "meant",
        "meeting",
        "meetings",
        "mention",
        "mentioned",
        "month",
        "more",
        "most",
        "my",
        "next",
        "note",
        "notes",
        "of",
        "on",
        "open",
        "or",
        "other",
        "our",
        "outcome",
        "outcomes",
        "overview",
        "plan",
        "plans",
        "please",
        "point",
        "points",
        "problem",
        "problems",
        "question",
        "questions",
        "raised",
        "recap",
        "recent",
        "recently",
        "recording",
        "recordings",
        "risk",
        "risks",
        "said",
        "say",
        "she",
        "should",
        "show",
        "so",
        "some",
        "something",
        "step",
        "steps",
        "summaries",
        "summarise",
        "summarized",
        "summarize",
        "summary",
        "takeaway",
        "takeaways",
        "talk",
        "talked",
        "task",
        "tasks",
        "tell",
        "that",
        "the",
        "their",
        "them",
        "there",
        "these",
        "they",
        "this",
        "those",
        "timeline",
        "to",
        "today",
        "topic",
        "topics",
        "transcript",
        "transcripts",
        "up",
        "update",
        "updates",
        "ups",
        "us",
        "was",
        "we",
        "week",
        "were",
        "what",
        "when",
        "where",
        "which",
        "who",
        "whom",
        "why",
        "will",
        "with",
        "would",
        "yesterday",
        "you",
        "your",
    }
)

_GENERIC_TITLE_TOKENS = frozenset(
    {
        "audio",
        "meeting",
        "meetings",
        "note",
        "notes",
        "recording",
        "recordings",
        "speaker",
        "speakers",
        "untitled",
    }
)

_FOLLOW_UP_CUES = frozenset(
    {
        "clarify",
        "continue",
        "detail",
        "details",
        "elaborate",
        "else",
        "expand",
        "he",
        "her",
        "him",
        "his",
        "it",
        "its",
        "more",
        "she",
        "that",
        "their",
        "them",
        "these",
        "they",
        "this",
        "those",
    }
)

_CONVERSATIONAL_FOLLOW_UP_WORDS = _QUESTION_STOPWORDS | _FOLLOW_UP_CUES | frozenset(
    {
        "again",
        "already",
        "also",
        "anyway",
        "basically",
        "bit",
        "brief",
        "briefly",
        "clear",
        "clearly",
        "concise",
        "concisely",
        "context",
        "deeper",
        "describe",
        "earlier",
        "exact",
        "exactly",
        "example",
        "examples",
        "extra",
        "full",
        "fuller",
        "further",
        "general",
        "generally",
        "meaning",
        "means",
        "missed",
        "paraphrase",
        "particular",
        "previously",
        "quick",
        "quickly",
        "really",
        "restate",
        "short",
        "shortly",
        "similar",
        "simply",
        "specific",
        "specifically",
        "still",
        "sum",
        "think",
        "thought",
        "together",
    }
)

_TAG_ALIASES: Dict[str, Tuple[str, ...]] = {
    "appointment": ("appointment", "appointments", "consultation", "consultations"),
    "call": ("call", "calls", "phone call", "phone calls", "support call", "support calls"),
    "interview": ("interview", "interviews"),
    "lecture": ("lecture", "lectures", "class", "study"),
    "podcast": ("podcast", "podcasts"),
    "video": ("video", "videos"),
    "voice-note": ("voice-note", "voice note", "voice notes", "voice memo", "voice memos"),
    "brainstorm": ("brainstorm", "brainstorms", "brainstorming"),
    "music": ("music", "rehearsal", "rehearsals"),
}

_MONTH_MAP = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

_MONTH_PATTERN = (
    r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|"
    r"jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
)
_ISO_DATE_RE = re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b")
_NUMERIC_DATE_RE = re.compile(r"\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b")
_DMY_MONTH_RE = re.compile(
    rf"\b(\d{{1,2}})(?:st|nd|rd|th)?(?:\s+of)?\s+({_MONTH_PATTERN})\.?(?:,?\s+(\d{{4}}))?\b",
    re.IGNORECASE,
)
_MDY_MONTH_RE = re.compile(
    rf"\b({_MONTH_PATTERN})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?(?:,?\s+(\d{{4}}))?\b",
    re.IGNORECASE,
)
_MONTH_YEAR_RE = re.compile(
    rf"\b(?:in\s+)?({_MONTH_PATTERN})\.?\s+(\d{{4}})\b",
    re.IGNORECASE,
)
_GENERIC_SPEAKER_RE = re.compile(r"^(?:speaker(?:\s+|_)\d+|unknown)$", re.IGNORECASE)


def estimate_token_count(text: Any) -> int:
    """Estimate tokens safely using UTF-8 byte ceiling (4 bytes per token)."""
    raw = str(text or "").encode("utf-8", errors="replace")
    if not raw:
        return 0
    return max(1, (len(raw) + 3) // 4)


def build_retrieval_query(
    question: str,
    *,
    extra_stopwords: Optional[Set[str]] = None,
    allow_raw_fallback: bool = True,
) -> Tuple[str, List[str]]:
    """Strip conversational filler & meta-words while preserving real topic terms."""
    raw_tokens = extract_query_tokens(question)
    if not raw_tokens:
        return "", []

    stop = _QUESTION_STOPWORDS | {tok.casefold() for tok in (extra_stopwords or ())}
    content_tokens = [tok for tok in raw_tokens if tok.casefold() not in stop]
    if content_tokens:
        return " ".join(content_tokens), content_tokens
    if not allow_raw_fallback:
        return "", []
    return " ".join(raw_tokens), raw_tokens


def _safe_iso_date(year: int, month: int, day: int) -> Optional[str]:
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def _resolve_year_for_month_day(
    month: int,
    day: int,
    available_dates: Set[str],
    today: date,
) -> Optional[str]:
    suffix = f"-{month:02d}-{day:02d}"
    matching = sorted((d for d in available_dates if d.endswith(suffix)), reverse=True)
    if matching:
        return matching[0]
    return _safe_iso_date(today.year, month, day)


def _strip_spans(text: str, spans: Sequence[Tuple[int, int]]) -> str:
    if not spans:
        return text
    chars = list(text)
    for start, end in spans:
        for idx in range(max(0, start), min(len(chars), end)):
            chars[idx] = " "
    return re.sub(r"\s+", " ", "".join(chars)).strip()


def parse_temporal_constraints(
    question: str,
    available_dates: Sequence[str],
    *,
    now: Optional[date | datetime] = None,
) -> Dict[str, Any]:
    """Parse explicit and relative dates deterministically against indexed dates."""
    raw = str(question or "")
    today = (
        now.date()
        if isinstance(now, datetime)
        else (now if isinstance(now, date) else datetime.now(timezone.utc).date())
    )
    date_set = {str(d)[:10] for d in available_dates if str(d or "").strip()}
    spans: List[Tuple[int, int]] = []
    candidate_dates: List[str] = []
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    detected_label: Optional[str] = None
    latest_only = False
    recent_hint = False

    def add_span(match: re.Match[str]) -> None:
        spans.append((match.start(), match.end()))

    # 1. Explicit YYYY-MM-DD
    for match in _ISO_DATE_RE.finditer(raw):
        iso = _safe_iso_date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        if iso:
            candidate_dates.append(iso)
            add_span(match)

    # 2. Numeric DD/MM/YYYY or MM/DD/YYYY disambiguated against indexed_meetings
    for match in _NUMERIC_DATE_RE.finditer(raw):
        first = int(match.group(1))
        second = int(match.group(2))
        year = int(match.group(3))
        dmy = _safe_iso_date(year, second, first)
        mdy = _safe_iso_date(year, first, second)
        if not dmy and not mdy:
            continue
        add_span(match)
        if dmy and mdy and dmy != mdy:
            dmy_exists = dmy in date_set
            mdy_exists = mdy in date_set
            if dmy_exists and not mdy_exists:
                candidate_dates.append(dmy)
            elif mdy_exists and not dmy_exists:
                candidate_dates.append(mdy)
            else:
                candidate_dates.extend([dmy, mdy])
        else:
            candidate_dates.append(dmy or mdy)  # type: ignore[arg-type]

    # 3. Month-name dates ("5 Sep 2026", "Sep 5, 2026")
    for match in _DMY_MONTH_RE.finditer(raw):
        day = int(match.group(1))
        month = _MONTH_MAP.get(match.group(2).lower())
        year = int(match.group(3)) if match.group(3) else None
        if not month:
            continue
        iso = _safe_iso_date(year, month, day) if year else _resolve_year_for_month_day(month, day, date_set, today)
        if iso:
            candidate_dates.append(iso)
            add_span(match)

    for match in _MDY_MONTH_RE.finditer(raw):
        month = _MONTH_MAP.get(match.group(1).lower())
        day = int(match.group(2))
        year = int(match.group(3)) if match.group(3) else None
        if not month:
            continue
        iso = _safe_iso_date(year, month, day) if year else _resolve_year_for_month_day(month, day, date_set, today)
        if iso:
            candidate_dates.append(iso)
            add_span(match)

    # 4. Month + Year ("September 2026") when no specific day matched inside that span
    if not candidate_dates:
        for match in _MONTH_YEAR_RE.finditer(raw):
            month = _MONTH_MAP.get(match.group(1).lower())
            year = int(match.group(2))
            if not month:
                continue
            last_day = calendar.monthrange(year, month)[1]
            date_from = date(year, month, 1).isoformat()
            date_to = date(year, month, last_day).isoformat()
            detected_label = f"{date_from} – {date_to}"
            add_span(match)
            break

    candidate_dates = list(dict.fromkeys(candidate_dates))
    if candidate_dates:
        date_from = min(candidate_dates)
        date_to = max(candidate_dates)
        detected_label = " / ".join(candidate_dates)

    # 5. Relative phrases when no explicit date was supplied
    if not candidate_dates and not date_from:
        rel_patterns: List[Tuple[re.Pattern[str], str]] = [
            (re.compile(r"\btoday\b", re.IGNORECASE), "today"),
            (re.compile(r"\byesterday\b", re.IGNORECASE), "yesterday"),
            (re.compile(r"\bthis\s+week\b", re.IGNORECASE), "this_week"),
            (re.compile(r"\b(?:past\s+week|last\s+7\s+days|past\s+7\s+days)\b", re.IGNORECASE), "past_7d"),
            (re.compile(r"\blast\s+week\b", re.IGNORECASE), "last_week"),
            (re.compile(r"\b(?:most\s+recent|latest)\b", re.IGNORECASE), "latest"),
            (re.compile(r"\brecent(?:ly)?\b", re.IGNORECASE), "recent"),
        ]
        for pattern, kind in rel_patterns:
            m = pattern.search(raw)
            if not m:
                continue
            add_span(m)
            if kind == "today":
                date_from = date_to = today.isoformat()
                detected_label = date_from
            elif kind == "yesterday":
                yday = (today - timedelta(days=1)).isoformat()
                date_from = date_to = yday
                detected_label = yday
            elif kind == "this_week":
                monday = today - timedelta(days=today.weekday())
                date_from = monday.isoformat()
                date_to = today.isoformat()
                detected_label = f"{date_from} – {date_to}"
            elif kind == "past_7d":
                date_from = (today - timedelta(days=7)).isoformat()
                date_to = today.isoformat()
                detected_label = f"{date_from} – {date_to}"
            elif kind == "last_week":
                prev_mon = today - timedelta(days=today.weekday() + 7)
                prev_sun = today - timedelta(days=today.weekday() + 1)
                date_from = prev_mon.isoformat()
                date_to = prev_sun.isoformat()
                detected_label = f"{date_from} – {date_to}"
            elif kind == "latest":
                latest_only = True
            elif kind == "recent":
                recent_hint = True
            break

    return {
        "dateFrom": date_from,
        "dateTo": date_to,
        "candidateDates": candidate_dates,
        "latestOnly": latest_only,
        "recentHint": recent_hint,
        "strippedQuestion": _strip_spans(raw, spans),
        "detectedLabel": detected_label,
    }


def _is_generic_token(token: str) -> bool:
    cf = token.casefold()
    if cf in _QUESTION_STOPWORDS or cf in _GENERIC_TITLE_TOKENS:
        return True
    if token.isdigit():
        return True
    return False


def match_entities(
    question: str,
    headers: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    """Pre-match recording titles, non-generic speaker names, and canonical tags."""
    q_norm = " ".join(re.findall(r"[^\W_]+", str(question or ""), re.UNICODE)).casefold()
    q_tokens = {tok.casefold() for tok in extract_query_tokens(question) if not _is_generic_token(tok)}
    if not q_norm:
        return {
            "meetingIds": [],
            "strongMeetingIds": [],
            "matchedTokens": set(),
            "matchedTitles": [],
            "matchedSpeakers": [],
            "matchedTags": [],
        }

    matched_ids: List[str] = []
    exact_title_ids: List[str] = []
    strong_ids: List[str] = []
    matched_tokens: Set[str] = set()
    matched_titles: List[str] = []
    matched_speakers: List[str] = []
    matched_tags: List[str] = []

    for header in headers:
        mid = str(header.get("meetingId") or "")
        if not mid:
            continue
        title = str(header.get("title") or "")
        raw_title_tokens = extract_query_tokens(title)
        title_tokens = [tok for tok in raw_title_tokens if not _is_generic_token(tok)]
        title_phrase = " ".join(title_tokens).casefold()
        full_title_phrase = " ".join(raw_title_tokens).casefold()
        distinctive_title_tokens = [tok for tok in title_tokens if len(tok) >= 3]

        is_title_match = False
        is_exact_title = False
        is_strong_title = False
        if (
            full_title_phrase
            and title_tokens
            and len(raw_title_tokens) >= 2
            and re.search(rf"\b{re.escape(full_title_phrase)}\b", q_norm)
        ):
            is_title_match = True
            is_exact_title = True
            is_strong_title = True
            matched_tokens.update(tok.casefold() for tok in raw_title_tokens)
        elif title_phrase and len(title_tokens) >= 2 and re.search(rf"\b{re.escape(title_phrase)}\b", q_norm):
            is_title_match = True
            is_strong_title = True
            matched_tokens.update(tok.casefold() for tok in title_tokens)
        elif distinctive_title_tokens:
            overlap = [tok.casefold() for tok in distinctive_title_tokens if tok.casefold() in q_tokens]
            if len(overlap) >= 2 or (len(distinctive_title_tokens) == 1 and len(overlap) == 1):
                is_title_match = True
                is_strong_title = len(overlap) >= 2
                matched_tokens.update(overlap)

        speaker_hit = False
        for speaker in header.get("speakers") or []:
            spk = str(speaker or "").strip()
            if not spk or _GENERIC_SPEAKER_RE.match(spk):
                continue
            spk_tokens = [tok.casefold() for tok in extract_query_tokens(spk) if len(tok) >= 2 and not _is_generic_token(tok)]
            if not spk_tokens:
                continue
            spk_phrase = " ".join(spk_tokens)
            if re.search(rf"\b{re.escape(spk_phrase)}\b", q_norm) or any(tok in q_tokens and len(tok) >= 3 for tok in spk_tokens):
                speaker_hit = True
                matched_speakers.append(spk)
                matched_tokens.update(tok for tok in spk_tokens if tok in q_tokens)

        tag_hit = False
        tag = str(header.get("tag") or "").strip().lower()
        if tag and tag in _TAG_ALIASES:
            for alias in _TAG_ALIASES[tag]:
                if re.search(rf"\b{re.escape(alias)}\b", q_norm):
                    tag_hit = True
                    matched_tags.append(tag)
                    matched_tokens.update(tok.casefold() for tok in extract_query_tokens(alias))
                    break

        if is_title_match or speaker_hit or tag_hit:
            matched_ids.append(mid)
            if is_exact_title:
                exact_title_ids.append(mid)
            if is_title_match:
                matched_titles.append(title)
            if is_strong_title or speaker_hit or tag_hit:
                strong_ids.append(mid)

    final_ids = exact_title_ids if exact_title_ids and not matched_speakers and not matched_tags else matched_ids
    final_strong_ids = exact_title_ids if exact_title_ids and not matched_speakers and not matched_tags else strong_ids

    return {
        "meetingIds": list(dict.fromkeys(final_ids)),
        "strongMeetingIds": list(dict.fromkeys(final_strong_ids)),
        "matchedTokens": matched_tokens,
        "matchedTitles": list(dict.fromkeys(matched_titles)),
        "matchedSpeakers": list(dict.fromkeys(matched_speakers)),
        "matchedTags": list(dict.fromkeys(matched_tags)),
    }


def normalize_scope(raw_scope: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if raw_scope is None:
        return {"type": "all", "meetingIds": None, "dateFrom": None, "dateTo": None, "tags": []}

    if not isinstance(raw_scope, dict):
        raise ValueError("Invalid history scope.")
    if "type" not in raw_scope and ("meetingIds" in raw_scope or "meetingId" in raw_scope):
        raise ValueError("Missing history scope type.")
    scope_type = raw_scope.get("type", "all")
    if not isinstance(scope_type, str) or scope_type.strip().lower() not in ("all", "single_meeting", "selected_meetings"):
        raise ValueError("Invalid history scope type.")
    scope_type = scope_type.strip().lower()
    date_pattern = r"\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?"
    for key in ("dateFrom", "dateTo"):
        value = raw_scope.get(key)
        if value is not None:
            if not isinstance(value, str) or (value.strip() and not re.fullmatch(date_pattern, value.strip())):
                raise ValueError("Invalid history scope date.")
    raw_ids = raw_scope.get("meetingIds")
    if raw_ids is not None:
        if not isinstance(raw_ids, list) or any(not isinstance(item, str) or not item.strip() for item in raw_ids):
            raise ValueError("Invalid history scope meeting IDs.")
    meeting_id = raw_scope.get("meetingId")
    if meeting_id is not None and (not isinstance(meeting_id, str) or not meeting_id.strip()):
        raise ValueError("Invalid history scope meeting ID.")

    raw_tags = raw_scope.get("tags")
    cleaned_tags: List[str] = []
    if raw_tags is not None:
        if not isinstance(raw_tags, list):
            raise ValueError("Invalid history scope tags.")
        seen_tags = set()
        for item in raw_tags:
            if not isinstance(item, str) or not item.strip():
                raise ValueError("Invalid history scope tags.")
            try:
                normalized_tag = normalize_recording_tag(item, strict=True)
            except ValueError as exc:
                raise ValueError("Invalid history scope tags.") from exc
            if normalized_tag and normalized_tag not in seen_tags:
                seen_tags.add(normalized_tag)
                cleaned_tags.append(normalized_tag)

    cleaned_ids: Optional[List[str]] = None
    if scope_type in ("single_meeting", "selected_meetings"):
        ids: List[str] = []
        if isinstance(raw_ids, list):
            ids.extend(str(item).strip() for item in raw_ids if str(item or "").strip())
        if meeting_id is not None and str(meeting_id).strip():
            ids.append(str(meeting_id).strip())
        # Preserve caller order without duplicates.
        cleaned_ids = list(dict.fromkeys(ids))
        scope_type = "selected_meetings"
    else:
        scope_type = "all"

    date_from = str(raw_scope.get("dateFrom") or "").strip() or None
    date_to = str(raw_scope.get("dateTo") or "").strip() or None
    return {
        "type": scope_type,
        "meetingIds": cleaned_ids,
        "dateFrom": date_from,
        "dateTo": date_to,
        "tags": cleaned_tags,
    }


def _count_scoped_meetings(
    recordings_dir: Path,
    index_path: Path,
    *,
    meeting_ids: Optional[Sequence[str]],
    date_from: Optional[str],
    date_to: Optional[str],
    tags: Optional[Sequence[str]] = None,
    conn: Optional[sqlite3.Connection] = None,
) -> Tuple[int, int]:
    owned_conn: Optional[sqlite3.Connection] = None
    active_conn = conn
    if active_conn is None:
        if not index_path.exists():
            return 0, 0
        owned_conn, _stats = _ensure_synced_connection(recordings_dir, index_path, perform_sync=False)
        active_conn = owned_conn
    try:
        total_meetings = int(active_conn.execute("SELECT COUNT(*) FROM indexed_meetings").fetchone()[0])
        if meeting_ids is not None:
            cleaned_ids = [str(mid).strip() for mid in meeting_ids if str(mid or "").strip()]
            if not cleaned_ids:
                return total_meetings, 0
        clauses, params = build_scope_sql_filters(
            meeting_ids=meeting_ids,
            date_from=date_from,
            date_to=date_to,
            tags=tags,
        )
        # build_scope_sql_filters emits p.meeting_id for meeting_ids; rewrite alias to m.
        m_clauses = [clause.replace("p.meeting_id", "m.meeting_id") for clause in clauses]
        where_sql = f"WHERE {' AND '.join(m_clauses)}" if m_clauses else ""
        scoped_count = int(
            active_conn.execute(f"SELECT COUNT(*) FROM indexed_meetings m {where_sql}", params).fetchone()[0]
        )
        return total_meetings, scoped_count
    finally:
        if owned_conn is not None:
            owned_conn.close()


def _format_overview_segments(segments: Sequence[Tuple[str, str]]) -> str:
    if not segments:
        return ""
    distinct_speakers = {spk for spk, _ in segments if spk}
    if len(distinct_speakers) <= 1 and all(spk == segments[0][0] for spk, _ in segments):
        return " ".join(text for _, text in segments if text).strip()

    grouped: List[Tuple[str, List[str]]] = []
    for spk, text in segments:
        if not text:
            continue
        if grouped and grouped[-1][0] == spk:
            grouped[-1][1].append(text)
        else:
            grouped.append((spk, [text]))

    lines: List[str] = []
    for spk, parts in grouped:
        body = " ".join(parts).strip()
        if not body:
            continue
        lines.append(f"{spk}: {body}" if spk else body)
    return "\n".join(lines).strip()


def _format_targeted_segments(
    segments: Sequence[Tuple[str, str]],
) -> str:
    turns = [(speaker, text) for speaker, text in segments if text]
    if len({speaker for speaker, _ in turns}) <= 1:
        return " ".join(text for _, text in turns).strip()
    return "\n".join(f"[{speaker or 'Unknown'}]: {text}" for speaker, text in turns)


def _merge_adjacent_candidates(
    candidates: List[Dict[str, Any]],
    *,
    max_merged_chars: int = MAX_MERGED_PASSAGE_CHARS,
    chronological: bool = False,
) -> List[Dict[str, Any]]:
    """Coalesce contiguous transcript hits within the same meeting."""
    by_meeting: Dict[str, List[Dict[str, Any]]] = {}
    meeting_order: List[str] = []
    other_hits: List[Dict[str, Any]] = []

    for cand in candidates:
        if cand["kind"] == "transcript":
            mid = cand["meetingId"]
            if mid not in by_meeting:
                by_meeting[mid] = []
                meeting_order.append(mid)
            by_meeting[mid].append(cand)
        else:
            other_hits.append(cand)

    merged: List[Dict[str, Any]] = []
    seen_spans = set()

    for mid in meeting_order:
        items = sorted(by_meeting[mid], key=lambda item: item["seqIndex"])
        current: Optional[Dict[str, Any]] = None

        def start_block(item: Dict[str, Any]) -> Dict[str, Any]:
            block = dict(item)
            block["_lastEndMs"] = item.get("endMs")
            if chronological:
                block["_overviewSegments"] = [(str(item.get("speaker") or ""), str(item.get("text") or "").strip())]
            else:
                is_nb = bool(item.get("isNeighbor"))
                block["_hasDirect"] = not is_nb
                block["_targetedSegments"] = [
                    (str(item.get("speaker") or ""), str(item.get("text") or "").strip())
                ]
            return block

        def finalize_block(block: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            block.pop("_lastEndMs", None)
            block.pop("_overviewSegments", None)
            block.pop("_hasDirect", None)
            block.pop("_targetedSegments", None)
            if not chronological and block.get("isNeighbor"):
                return None
            return block

        for item in items:
            span_key = (mid, item["kind"], item["seqIndex"])
            if span_key in seen_spans:
                continue
            seen_spans.add(span_key)

            if current is None:
                current = start_block(item)
                continue

            adjacent_seq = item["seqIndex"] == current["seqLastIndex"] + 1
            item_speaker = str(item.get("speaker") or "")
            item_text = str(item.get("text") or "").strip()

            if chronological:
                prospective_segments = [*current["_overviewSegments"], (item_speaker, item_text)]
                combined_text = _format_overview_segments(prospective_segments)
                if adjacent_seq and len(combined_text) <= max_merged_chars:
                    current["seqLastIndex"] = item["seqIndex"]
                    if item["endMs"] is not None:
                        current["endMs"] = max(current["endMs"] or 0, item["endMs"])
                        current["endSec"] = round(current["endMs"] / 1000.0, 3)
                    current["_lastEndMs"] = item.get("endMs")
                    current["_overviewSegments"] = prospective_segments
                    current["text"] = combined_text
                    current["rank"] = min(current["rank"], item["rank"])
                    current["diversityTier"] = min(int(current.get("diversityTier", 0)), int(item.get("diversityTier", 0)))
                    continue
            else:
                gap_ok = True
                if current["_lastEndMs"] is not None and item["startMs"] is not None:
                    gap_ok = (item["startMs"] - current["_lastEndMs"]) <= MAX_MERGED_PASSAGE_GAP_MS
                item_is_neighbor = bool(item.get("isNeighbor"))
                current_has_direct = bool(current["_hasDirect"])
                same_speaker = item_speaker == str(current.get("speaker") or "")

                can_merge_targeted = adjacent_seq and gap_ok and (
                    (current_has_direct and not item_is_neighbor and same_speaker)
                    or (not current_has_direct and not item_is_neighbor)
                    or (current_has_direct and item_is_neighbor)
                )
                if can_merge_targeted:
                    prospective_segments = [*current["_targetedSegments"], (item_speaker, item_text)]
                    combined_text = _format_targeted_segments(prospective_segments)
                    if len(combined_text) <= max_merged_chars:
                        current["seqLastIndex"] = item["seqIndex"]
                        if not current_has_direct and not item_is_neighbor:
                            # Preceding neighbor (k-1) merged into first direct hit (k): preserve k's timestamp, speaker, and excerpt.
                            current["startMs"] = item.get("startMs")
                            current["startSec"] = item.get("startSec")
                            current["speaker"] = item_speaker
                            current["excerpt"] = item.get("excerpt") or current.get("excerpt") or ""
                            current["rank"] = item["rank"]
                            current["diversityTier"] = int(item.get("diversityTier", 0))
                            current["isNeighbor"] = False
                            current["_hasDirect"] = True
                            if item.get("endMs") is not None:
                                current["endMs"] = item.get("endMs")
                                current["endSec"] = round(item["endMs"] / 1000.0, 3)
                        else:
                            if item.get("endMs") is not None:
                                current["endMs"] = max(current["endMs"] or 0, item["endMs"])
                                current["endSec"] = round(current["endMs"] / 1000.0, 3)
                            current["rank"] = min(current["rank"], item["rank"])
                            current["diversityTier"] = min(int(current.get("diversityTier", 0)), int(item.get("diversityTier", 0)))
                        current["_lastEndMs"] = item.get("endMs")
                        current["_targetedSegments"] = prospective_segments
                        current["text"] = combined_text
                        continue

            done = finalize_block(current)
            if done is not None:
                merged.append(done)
            current = start_block(item)

        if current is not None:
            done = finalize_block(current)
            if done is not None:
                merged.append(done)

    for item in other_hits:
        span_key = (item["meetingId"], item["kind"], item["seqIndex"])
        if span_key in seen_spans:
            continue
        seen_spans.add(span_key)
        merged.append(item)

    if chronological:
        merged.sort(
            key=lambda item: (
                0 if item["kind"] == "summary" else (1 if item["kind"] == "transcript" else 2),
                item.get("meetingOrder", 0),
                item["seqIndex"],
            )
        )
    else:
        merged.sort(
            key=lambda item: (
                1 if item.get("isNeighbor") else 0,
                int(item.get("diversityTier", 0)),
                0 if item["kind"] == "transcript" else (1 if item["kind"] == "summary" else 2),
                item["rank"],
                item["meetingDate"],
                item["seqIndex"],
            )
        )
    return merged


def _build_source_hash_lookup(
    recordings_dir: Path,
    index_path: Path,
    meeting_ids: Sequence[str],
    *,
    conn: Optional[sqlite3.Connection] = None,
) -> Dict[str, str]:
    clean_ids = [mid for mid in set(meeting_ids) if mid]
    if not clean_ids:
        return {}
    owned_conn: Optional[sqlite3.Connection] = None
    active_conn = conn
    if active_conn is None:
        if not index_path.exists():
            return {}
        owned_conn, _stats = _ensure_synced_connection(recordings_dir, index_path, perform_sync=False)
        active_conn = owned_conn
    try:
        placeholders = ", ".join("?" for _ in clean_ids)
        rows = active_conn.execute(
            f"SELECT meeting_id, transcript_hash FROM indexed_meetings WHERE meeting_id IN ({placeholders})",
            clean_ids,
        ).fetchall()
        return {str(row["meeting_id"]): str(row["transcript_hash"] or "") for row in rows}
    finally:
        if owned_conn is not None:
            owned_conn.close()


def _intersect_date_bounds(
    base_from: Optional[str],
    base_to: Optional[str],
    parsed_from: Optional[str],
    parsed_to: Optional[str],
) -> Tuple[Optional[str], Optional[str], bool]:
    eff_from = base_from
    if parsed_from:
        eff_from = max(eff_from[:10], parsed_from[:10]) if eff_from else parsed_from
    eff_to = base_to
    if parsed_to:
        eff_to = min(eff_to[:10], parsed_to[:10]) if eff_to else parsed_to
    conflict = bool(eff_from and eff_to and eff_from[:10] > eff_to[:10])
    return eff_from, eff_to, conflict


def _uniform_sample(items: List[Dict[str, Any]], cap: int) -> List[Dict[str, Any]]:
    if cap <= 0 or len(items) <= cap:
        return items[: max(0, cap)]
    if cap == 1:
        return [items[0]]
    indices = sorted({round(i * (len(items) - 1) / (cap - 1)) for i in range(cap)})
    return [items[idx] for idx in indices]


def _estimate_item_tokens(item: Dict[str, Any]) -> int:
    title = str(item.get("meetingTitle") or "Untitled recording").encode("utf-8", errors="replace")[:512].decode("utf-8", errors="ignore")
    speaker = str(item.get("speaker") or "").encode("utf-8", errors="replace")[:512].decode("utf-8", errors="ignore")
    raw_tag = str(item.get("tag") or "").encode("utf-8", errors="replace")[:64].decode("utf-8", errors="ignore")
    tag_display = recording_tag_display_label(raw_tag) or raw_tag
    date_str = str(item.get("meetingDate") or "")[:10]
    tag_part = f" [Tag: {tag_display}]" if tag_display else ""
    speaker_part = f", Speaker: {speaker}" if speaker else ""
    overhead = len(
        f"[E10] Recording: {title}{tag_part} ({date_str}, Summary / Untimed{speaker_part})\n\n".encode("utf-8")
    ) + 128
    text_bytes = len(str(item.get("text") or "").encode("utf-8", errors="replace"))
    return (overhead + text_bytes + 3) // 4


def _allocate_fair_counts(
    meeting_ids: Sequence[str],
    tx_map: Dict[str, List[Dict[str, Any]]],
    budget: int,
) -> Dict[str, int]:
    counts = {mid: 0 for mid in meeting_ids}
    remaining = max(0, int(budget))
    active = [mid for mid in meeting_ids if tx_map.get(mid)]
    while remaining > 0 and active:
        share = max(1, remaining // len(active))
        next_active: List[str] = []
        progressed = False
        for mid in active:
            if remaining <= 0:
                break
            avail = len(tx_map[mid]) - counts[mid]
            if avail <= 0:
                continue
            take = min(avail, share, remaining)
            if take > 0:
                counts[mid] += take
                remaining -= take
                progressed = True
            if len(tx_map[mid]) > counts[mid]:
                next_active.append(mid)
        if not progressed:
            break
        active = next_active
    return counts


def _pack_evidence_items(
    items: Sequence[Dict[str, Any]],
    *,
    block_cap: int,
    token_cap: int,
    hash_lookup: Dict[str, str],
) -> List[Dict[str, Any]]:
    selected: List[Dict[str, Any]] = []
    used_tokens = 0
    for item in items:
        if len(selected) >= block_cap:
            break
        remaining_bytes = (token_cap - used_tokens) * 4
        title = str(item.get("meetingTitle") or "Untitled recording").encode("utf-8", errors="replace")[:512].decode("utf-8", errors="ignore")
        speaker = str(item.get("speaker") or "").encode("utf-8", errors="replace")[:512].decode("utf-8", errors="ignore")
        tag = str(item.get("tag") or "").encode("utf-8", errors="replace")[:64].decode("utf-8", errors="ignore")
        tag_display = recording_tag_display_label(tag) or tag
        date_str = str(item.get("meetingDate") or "")[:10]
        tag_part = f" [Tag: {tag_display}]" if tag_display else ""
        speaker_part = f", Speaker: {speaker}" if speaker else ""
        overhead = len(
            f"[E{len(selected) + 1}] Recording: {title}{tag_part} ({date_str}, Summary / Untimed{speaker_part})\n\n".encode("utf-8")
        ) + 128
        if remaining_bytes <= overhead:
            break
        text = str(item.get("text") or "").encode("utf-8", errors="replace")[: remaining_bytes - overhead].decode("utf-8", errors="ignore")
        if not text.strip():
            break
        block_cost = (overhead + len(text.encode("utf-8")) + 3) // 4
        evidence_id = f"E{len(selected) + 1}"
        raw_excerpt = str(item.get("excerpt") or "").strip()
        if raw_excerpt:
            excerpt = raw_excerpt if len(raw_excerpt) <= 280 else f"{raw_excerpt[:279]}…"
        else:
            excerpt = text if len(text) <= 280 else f"{text[:279]}…"
        selected.append(
            {
                "evidenceId": evidence_id,
                "meetingId": item["meetingId"],
                "meetingTitle": title,
                "meetingDate": item.get("meetingDate") or "",
                "tag": tag,
                "kind": item.get("kind") or "transcript",
                "startSec": item.get("startSec"),
                "endSec": item.get("endSec"),
                "speaker": speaker,
                "excerpt": excerpt,
                "text": text,
                "sourceTranscriptHash": item.get("sourceTranscriptHash") or hash_lookup.get(item["meetingId"], ""),
            }
        )
        used_tokens += block_cost
    return selected


def _retrieve_overview_evidence(
    conn_headers: Sequence[Dict[str, Any]],
    *,
    rec_dir: Path,
    idx_path: Path,
    block_cap: int,
    token_cap: int,
    conn: Optional[sqlite3.Connection] = None,
) -> Tuple[List[Dict[str, Any]], int]:
    if not conn_headers:
        return [], 0

    chosen_headers = list(conn_headers[:MAX_OVERVIEW_MEETINGS])
    chosen_ids = [h["meetingId"] for h in chosen_headers]
    order_map = {mid: idx for idx, mid in enumerate(chosen_ids)}

    owned_conn: Optional[sqlite3.Connection] = None
    active_conn = conn
    if active_conn is None:
        if not idx_path.exists():
            return [], 0
        owned_conn, _ = _ensure_synced_connection(rec_dir, idx_path, perform_sync=False)
        active_conn = owned_conn
    try:
        raw_passages = fetch_meeting_passages(active_conn, chosen_ids, kinds=("summary", "transcript"))
        hash_lookup: Dict[str, str] = {
            h["meetingId"]: str(h.get("transcriptHash") or "")
            for h in chosen_headers
            if h.get("transcriptHash")
        }
        for p in raw_passages:
            if p.get("sourceTranscriptHash") and p["meetingId"] not in hash_lookup:
                hash_lookup[p["meetingId"]] = str(p["sourceTranscriptHash"])
        missing_ids = [mid for mid in chosen_ids if mid not in hash_lookup]
        if missing_ids:
            hash_lookup.update(_build_source_hash_lookup(rec_dir, idx_path, missing_ids, conn=active_conn))
    finally:
        if owned_conn is not None:
            owned_conn.close()

    candidates: List[Dict[str, Any]] = []
    for p in raw_passages:
        if not str(p.get("text") or "").strip():
            continue
        candidates.append(
            {
                **p,
                "seqLastIndex": p["seqIndex"],
                "rank": 0.0,
                "meetingOrder": order_map.get(p["meetingId"], 0),
                "isNeighbor": False,
            }
        )

    if not candidates:
        return [], 0

    merged = _merge_adjacent_candidates(
        candidates,
        max_merged_chars=OVERVIEW_MAX_MERGED_CHARS,
        chronological=True,
    )
    summaries = [item for item in merged if item["kind"] == "summary"]
    transcripts = [item for item in merged if item["kind"] == "transcript"]

    # Check both remaining block count and token_cap; if long, sample transcripts
    # uniformly across start/middle/end after keeping summary coverage.
    remaining_blocks = max(0, block_cap - len(summaries))
    if remaining_blocks <= 0:
        transcripts = []
    elif transcripts:
        summary_tokens = sum(_estimate_item_tokens(item) for item in summaries)
        remaining_tokens = max(0, token_cap - summary_tokens)
        total_tx_tokens = sum(_estimate_item_tokens(item) for item in transcripts)
        over_blocks = len(transcripts) > remaining_blocks
        over_tokens = token_cap > 0 and total_tx_tokens > remaining_tokens
        if over_blocks or over_tokens:
            per_meeting_tx: Dict[str, List[Dict[str, Any]]] = {}
            for item in transcripts:
                per_meeting_tx.setdefault(item["meetingId"], []).append(item)

            target_blocks = min(remaining_blocks, len(transcripts))
            sampled_tx: List[Dict[str, Any]] = []
            while target_blocks >= 1:
                counts = _allocate_fair_counts(chosen_ids, per_meeting_tx, target_blocks)
                sampled_tx = []
                for mid in chosen_ids:
                    cnt = counts.get(mid, 0)
                    if cnt > 0:
                        sampled_tx.extend(_uniform_sample(per_meeting_tx.get(mid, []), cnt))
                if token_cap <= 0:
                    break
                sampled_tokens = sum(_estimate_item_tokens(item) for item in sampled_tx)
                if sampled_tokens <= remaining_tokens or target_blocks == 1:
                    break
                ratio_target = int(target_blocks * remaining_tokens / max(1, sampled_tokens))
                target_blocks = min(target_blocks - 1, max(1, ratio_target))
            transcripts = sampled_tx[:remaining_blocks]

    ordered = [*summaries, *transcripts]
    packed = _pack_evidence_items(
        ordered,
        block_cap=block_cap,
        token_cap=token_cap,
        hash_lookup=hash_lookup,
    )
    return packed, len(dict.fromkeys(item["meetingId"] for item in packed))


def retrieve_evidence(
    recordings_dir: str | Path,
    index_path: str | Path,
    *,
    question: str,
    scope: Optional[Dict[str, Any]] = None,
    thread_context: Optional[Dict[str, Any]] = None,
    max_evidence_blocks: Optional[int] = None,
    max_evidence_tokens: Optional[int] = None,
    sync: bool = True,
    now: Optional[date | datetime] = None,
) -> Dict[str, Any]:
    """Retrieve bounded, immutable evidence passages from SQLite FTS5.

    Routes cleanly between ``overview`` mode (summary-first + chronological
    transcript coverage for 1-3 date/entity/selected recordings) and
    ``targeted`` mode (body-match keyword search with per-meeting diversity
    and ``k+-1`` neighbor expansion), staying fail-closed on zero hits.
    """
    rec_dir = Path(recordings_dir)
    idx_path = Path(index_path)
    normalized_scope = normalize_scope(scope)
    raw_question = str(question or "").strip()

    def _run_with_conn(conn: Optional[sqlite3.Connection]) -> Dict[str, Any]:
        scoped_tags = normalized_scope["tags"] or None
        scoped_headers: List[Dict[str, Any]] = []
        if conn is not None:
            scoped_headers = list_indexed_meeting_headers(
                conn,
                meeting_ids=normalized_scope["meetingIds"],
                date_from=normalized_scope["dateFrom"],
                date_to=normalized_scope["dateTo"],
                tags=scoped_tags,
            )

        total_indexed, scoped_count = _count_scoped_meetings(
            rec_dir,
            idx_path,
            meeting_ids=normalized_scope["meetingIds"],
            date_from=normalized_scope["dateFrom"],
            date_to=normalized_scope["dateTo"],
            tags=scoped_tags,
            conn=conn,
        )

        available_dates = [str(h.get("date") or "")[:10] for h in scoped_headers if h.get("date")]
        temporal = parse_temporal_constraints(raw_question, available_dates, now=now)

        eff_from, eff_to, date_conflict = _intersect_date_bounds(
            normalized_scope["dateFrom"],
            normalized_scope["dateTo"],
            temporal["dateFrom"],
            temporal["dateTo"],
        )

        # Filter headers by parsed temporal constraint (respecting disambiguated candidate dates).
        candidate_date_set = set(temporal["candidateDates"])
        filtered_headers = list(scoped_headers)
        if date_conflict:
            filtered_headers = []
        else:
            if eff_from:
                filtered_headers = [h for h in filtered_headers if str(h.get("date") or "")[:10] >= eff_from[:10]]
            if eff_to:
                filtered_headers = [h for h in filtered_headers if str(h.get("date") or "")[:10] <= eff_to[:10]]
            if candidate_date_set:
                filtered_headers = [h for h in filtered_headers if str(h.get("date") or "")[:10] in candidate_date_set]

        if temporal["latestOnly"] and filtered_headers:
            filtered_headers = filtered_headers[:1]

        entities = match_entities(temporal["strippedQuestion"], filtered_headers)
        entity_matched_ids = entities["meetingIds"]

        _, cleaned_tokens = build_retrieval_query(
            temporal["strippedQuestion"],
            allow_raw_fallback=False,
        )
        non_entity_tokens = [tok for tok in cleaned_tokens if tok.casefold() not in entities["matchedTokens"]]

        # Follow-up continuity: anchor pronoun / conversational follow-ups to prior cited meetings in scope.
        raw_tokens_cf = {tok.casefold() for tok in extract_query_tokens(raw_question)}
        has_follow_up_cue = bool(raw_tokens_cf & _FOLLOW_UP_CUES)
        prior_cited_ids = [
            str(mid).strip()
            for mid in (thread_context or {}).get("lastCitedMeetingIds") or []
            if str(mid or "").strip()
        ]
        header_id_set = {h["meetingId"] for h in filtered_headers}
        prior_in_scope = [mid for mid in prior_cited_ids if mid in header_id_set]
        prior_headers = [h for h in filtered_headers if h["meetingId"] in set(prior_in_scope)]

        has_date_constraint = bool(temporal["dateFrom"] or temporal["dateTo"] or temporal["latestOnly"])
        use_overview = False
        overview_headers: List[Dict[str, Any]] = []

        if not non_entity_tokens and raw_tokens_cf:
            if entity_matched_ids:
                id_set = set(entity_matched_ids)
                overview_headers = [h for h in filtered_headers if h["meetingId"] in id_set]
                use_overview = len(overview_headers) > 0
            elif has_date_constraint and filtered_headers:
                overview_headers = list(filtered_headers)
                use_overview = True
            elif has_follow_up_cue and prior_headers:
                overview_headers = prior_headers
                use_overview = True
            elif filtered_headers:
                # Queries composed entirely of overview/starter/stopword cues summarize up to
                # MAX_OVERVIEW_MEETINGS most recent matching recordings even in "All" scope.
                overview_headers = list(filtered_headers)
                use_overview = True

        def _make_overview_result(target_headers: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
            ov_block_cap = max(1, int(max_evidence_blocks if max_evidence_blocks is not None else OVERVIEW_MAX_EVIDENCE_BLOCKS))
            ov_token_cap = max(0, int(max_evidence_tokens if max_evidence_tokens is not None else OVERVIEW_MAX_EVIDENCE_TOKENS))
            ov_evidence, ov_matched_count = _retrieve_overview_evidence(
                target_headers,
                rec_dir=rec_dir,
                idx_path=idx_path,
                block_cap=ov_block_cap,
                token_cap=ov_token_cap,
                conn=conn,
            )
            return {
                "question": raw_question,
                "retrievalQuery": "",
                "queryTokens": [],
                "retrievalMode": "overview",
                "detectedDateFilter": temporal["detectedLabel"] or "",
                "matchedEntities": {
                    "titles": entities["matchedTitles"],
                    "speakers": entities["matchedSpeakers"],
                    "tags": entities["matchedTags"],
                },
                "totalIndexedMeetings": total_indexed,
                "searchedMeetingCount": scoped_count,
                "matchedMeetingCount": ov_matched_count,
                "evidence": ov_evidence,
            }

        if use_overview:
            return _make_overview_result(overview_headers)

        # Targeted keyword mode
        block_cap = max(1, int(max_evidence_blocks if max_evidence_blocks is not None else MAX_EVIDENCE_BLOCKS))
        token_cap = max(0, int(max_evidence_tokens if max_evidence_tokens is not None else MAX_EVIDENCE_TOKENS))

        # Strip generic title boilerplate tokens (e.g. "recording", "2026") from targeted keywords.
        targeted_tokens = [tok for tok in non_entity_tokens if not _is_generic_token(tok)]
        if not targeted_tokens:
            targeted_tokens = non_entity_tokens
        if not targeted_tokens:
            return {
                "question": raw_question,
                "retrievalQuery": "",
                "queryTokens": [],
                "retrievalMode": "targeted",
                "detectedDateFilter": temporal["detectedLabel"] or "",
                "matchedEntities": {
                    "titles": entities["matchedTitles"],
                    "speakers": entities["matchedSpeakers"],
                    "tags": entities["matchedTags"],
                },
                "totalIndexedMeetings": total_indexed,
                "searchedMeetingCount": scoped_count,
                "matchedMeetingCount": 0,
                "evidence": [],
            }

        # If a date constraint eliminated all meetings in scope, fail closed immediately.
        if date_conflict or (scoped_headers and not filtered_headers):
            return {
                "question": raw_question,
                "retrievalQuery": " ".join(targeted_tokens),
                "queryTokens": targeted_tokens,
                "retrievalMode": "targeted",
                "detectedDateFilter": temporal["detectedLabel"] or "",
                "matchedEntities": {
                    "titles": entities["matchedTitles"],
                    "speakers": entities["matchedSpeakers"],
                    "tags": entities["matchedTags"],
                },
                "totalIndexedMeetings": total_indexed,
                "searchedMeetingCount": scoped_count,
                "matchedMeetingCount": 0,
                "evidence": [],
            }

        anchored_to_prior = False
        anchored_to_entities = False
        if candidate_date_set:
            effective_meeting_ids: Optional[List[str]] = [h["meetingId"] for h in filtered_headers]
        elif temporal["latestOnly"] and filtered_headers:
            effective_meeting_ids = [h["meetingId"] for h in filtered_headers]
        elif entities["strongMeetingIds"] and not has_follow_up_cue:
            effective_meeting_ids = entities["strongMeetingIds"]
            anchored_to_entities = True
        elif has_follow_up_cue and prior_in_scope:
            effective_meeting_ids = prior_in_scope
            anchored_to_prior = True
        elif entities["strongMeetingIds"]:
            effective_meeting_ids = entities["strongMeetingIds"]
            anchored_to_entities = True
        else:
            effective_meeting_ids = normalized_scope["meetingIds"]

        retrieval_query = " ".join(targeted_tokens)
        search_res = search_history_index(
            rec_dir,
            idx_path,
            query=retrieval_query,
            limit=25,
            max_matches_per_meeting=MAX_PASSAGES_PER_MEETING_CANDIDATE,
            meeting_ids=effective_meeting_ids,
            date_from=eff_from,
            date_to=eff_to,
            tags=scoped_tags,
            sync=False,
            conn=conn,
        )

        def extract_body_candidates(res_obj: Dict[str, Any]) -> List[Dict[str, Any]]:
            out: List[Dict[str, Any]] = []
            for meeting_hit in res_obj.get("meetings") or []:
                mid = str(meeting_hit.get("meetingId") or "")
                if not mid:
                    continue
                for passage in meeting_hit.get("matches") or []:
                    text = str(passage.get("text") or "").strip()
                    kind = str(passage.get("kind") or "transcript")
                    if not text or kind == "title":
                        continue
                    if passage.get("matchedBody") is False:
                        continue
                    start_ms = passage.get("startMs")
                    end_ms = passage.get("endMs")
                    out.append(
                        {
                            "meetingId": mid,
                            "meetingTitle": str(meeting_hit.get("title") or "Untitled recording"),
                            "meetingDate": str(meeting_hit.get("date") or ""),
                            "tag": str(meeting_hit.get("tag") or ""),
                            "kind": kind,
                            "seqIndex": int(passage.get("seqIndex") or 0),
                            "seqLastIndex": int(passage.get("seqIndex") or 0),
                            "startMs": int(start_ms) if start_ms is not None else None,
                            "endMs": int(end_ms) if end_ms is not None else None,
                            "startSec": passage.get("startSec"),
                            "endSec": passage.get("endSec"),
                            "speaker": str(passage.get("speaker") or ""),
                            "text": text,
                            "excerpt": str(passage.get("excerpt") or text[:220]),
                            "sourceTranscriptHash": str(passage.get("sourceTranscriptHash") or ""),
                            "rank": float(passage.get("rank") or 0.0),
                            "isNeighbor": False,
                        }
                    )
            return out

        candidates = extract_body_candidates(search_res)
        if not candidates and anchored_to_prior and prior_headers and all(
            tok.casefold() in _CONVERSATIONAL_FOLLOW_UP_WORDS for tok in targeted_tokens
        ):
            return _make_overview_result(prior_headers)

        if not candidates and (anchored_to_prior or anchored_to_entities):
            broader_ids = (
                [h["meetingId"] for h in filtered_headers]
                if (candidate_date_set or temporal["latestOnly"])
                else normalized_scope["meetingIds"]
            )
            if broader_ids != effective_meeting_ids:
                search_res = search_history_index(
                    rec_dir,
                    idx_path,
                    query=retrieval_query,
                    limit=25,
                    max_matches_per_meeting=MAX_PASSAGES_PER_MEETING_CANDIDATE,
                    meeting_ids=broader_ids,
                    date_from=eff_from,
                    date_to=eff_to,
                    tags=scoped_tags,
                    sync=False,
                    conn=conn,
                )
                candidates = extract_body_candidates(search_res)

        if not candidates:
            return {
                "question": raw_question,
                "retrievalQuery": retrieval_query,
                "queryTokens": targeted_tokens,
                "retrievalMode": "targeted",
                "detectedDateFilter": temporal["detectedLabel"] or "",
                "matchedEntities": {
                    "titles": entities["matchedTitles"],
                    "speakers": entities["matchedSpeakers"],
                    "tags": entities["matchedTags"],
                },
                "totalIndexedMeetings": total_indexed,
                "searchedMeetingCount": scoped_count,
                "matchedMeetingCount": 0,
                "evidence": [],
            }

        # Per-meeting diversity cap across "All recordings" when > 4 meetings match.
        unique_matched_meetings = list(dict.fromkeys(c["meetingId"] for c in candidates))
        if len(unique_matched_meetings) > TARGETED_DIVERSITY_MEETING_THRESHOLD:
            per_meeting_counts: Dict[str, int] = {}
            diverse: List[Dict[str, Any]] = []
            overflow: List[Dict[str, Any]] = []
            for cand in candidates:
                mid = cand["meetingId"]
                cnt = per_meeting_counts.get(mid, 0)
                if cnt < TARGETED_DIVERSITY_CAP:
                    cand["diversityTier"] = 0
                    diverse.append(cand)
                    per_meeting_counts[mid] = cnt + 1
                else:
                    cand["diversityTier"] = 1
                    overflow.append(cand)
            candidates = [*diverse, *overflow]

        # Neighbor passage expansion (k+-1) on direct transcript hits before merging.
        if conn is not None:
            needed_neighbors: Dict[str, Set[int]] = {}
            existing_keys = {(c["meetingId"], c["kind"], c["seqIndex"]) for c in candidates}
            for cand in candidates[:block_cap]:
                if cand["kind"] == "transcript" and cand["seqIndex"] >= 1:
                    seqs = needed_neighbors.setdefault(cand["meetingId"], set())
                    for offset in (-1, 1):
                        nb_seq = cand["seqIndex"] + offset
                        if nb_seq >= 1 and (cand["meetingId"], "transcript", nb_seq) not in existing_keys:
                            seqs.add(nb_seq)
            if needed_neighbors:
                for mid, seqs in needed_neighbors.items():
                    for nb in fetch_neighbor_passages(conn, mid, sorted(seqs)):
                        candidates.append(
                            {
                                **nb,
                                "seqLastIndex": nb["seqIndex"],
                                "rank": 0.0,
                                "isNeighbor": True,
                            }
                        )

        merged = _merge_adjacent_candidates(candidates)
        header_hashes: Dict[str, str] = {
            h["meetingId"]: str(h.get("transcriptHash") or "")
            for h in scoped_headers
            if h.get("transcriptHash")
        }
        missing_hash_ids = [
            c["meetingId"]
            for c in merged
            if not c.get("sourceTranscriptHash") and c["meetingId"] not in header_hashes
        ]
        if missing_hash_ids:
            header_hashes.update(_build_source_hash_lookup(rec_dir, idx_path, missing_hash_ids, conn=conn))
        selected = _pack_evidence_items(
            merged,
            block_cap=block_cap,
            token_cap=token_cap,
            hash_lookup=header_hashes,
        )

        return {
            "question": raw_question,
            "retrievalQuery": retrieval_query,
            "queryTokens": targeted_tokens,
            "retrievalMode": "targeted",
            "detectedDateFilter": temporal["detectedLabel"] or "",
            "matchedEntities": {
                "titles": entities["matchedTitles"],
                "speakers": entities["matchedSpeakers"],
                "tags": entities["matchedTags"],
            },
            "totalIndexedMeetings": total_indexed,
            "searchedMeetingCount": scoped_count,
            "matchedMeetingCount": len(dict.fromkeys(item["meetingId"] for item in selected)),
            "evidence": selected,
        }

    conn: Optional[sqlite3.Connection] = None
    if sync or idx_path.exists():
        conn, _ = _ensure_synced_connection(rec_dir, idx_path, perform_sync=sync)
    try:
        try:
            return _run_with_conn(conn)
        except sqlite3.DatabaseError as error:
            _raise_if_busy(error)
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
                conn = None
            rebuild_history_index(rec_dir, idx_path)
            conn = _connect_sqlite(idx_path)
            return _run_with_conn(conn)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="AvaNevis local FTS5 evidence retrieval preflight")
    parser.add_argument("--recordings-dir", required=True)
    parser.add_argument("--index-path", required=True)
    parser.add_argument("--stdin-json", action="store_true", required=True)
    args = parser.parse_args()

    payload = json.loads(sys.stdin.read() or "{}")
    result = retrieve_evidence(
        Path(args.recordings_dir),
        Path(args.index_path),
        question=str(payload.get("question") or ""),
        scope=payload.get("scope"),
        thread_context=payload.get("threadContext"),
        max_evidence_blocks=(
            int(payload["maxEvidenceBlocks"])
            if payload.get("maxEvidenceBlocks") is not None
            else None
        ),
        max_evidence_tokens=(
            int(payload["maxEvidenceTokens"])
            if payload.get("maxEvidenceTokens") is not None
            else None
        ),
        sync=bool(payload.get("sync", True)),
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
