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
    estimate_meeting_transcripts,
    extract_query_tokens,
    fetch_meeting_passages,
    fetch_neighbor_passages,
    list_indexed_meeting_headers,
    rebuild_history_index,
    search_history_index,
)

MAX_EVIDENCE_BLOCKS = 32
MAX_EVIDENCE_TOKENS = 20_000
MAX_DIRECT_EVIDENCE_BLOCKS = 64
OVERVIEW_MAX_EVIDENCE_BLOCKS = 64
MAX_OVERVIEW_MEETINGS = 3
MAX_MERGED_PASSAGE_GAP_MS = 10_000
MAX_MERGED_PASSAGE_SPAN_MS = 35_000
MAX_MERGED_PASSAGE_CHARS = 550

_QUESTION_STOPWORDS = frozenset(
    {
        "a",
        "about",
        "action",
        "actually",
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
        "deep",
        "deeper",
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
        "further",
        "give",
        "go",
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
        "just",
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
        "really",
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
        "specific",
        "specifics",
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
        "than",
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
        "want",
        "wanted",
    }
)

_DEEPEN_RE = re.compile(
    r"\b(?:go deep(?:er)?|tell me more|said more than that|elaborate|what else|"
    r"expand on (?:that|this)|give (?:me )?(?:more )?details?|continue|say more)\b",
    re.IGNORECASE,
)
_PRONOUN_FOLLOW_UP_RE = re.compile(
    r"^(?:(?:what|why|when|where|how)\s+)?(?:(?:did|does|was|were|is|are|would|could|should)\s+)?"
    r"(?:he|she|they|it|that|this|those)\b",
    re.IGNORECASE,
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
    """Estimate tokens at four UTF-8 bytes per token, rounded up."""
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
    if not isinstance(scope_type, str) or scope_type.strip().lower() not in (
        "all",
        "single_meeting",
        "selected_meetings",
        "none",
    ):
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

    if scope_type == "none":
        return {
            "type": "none",
            "meetingIds": [],
            "dateFrom": None,
            "dateTo": None,
            "tags": [],
        }

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


def _merge_adjacent_candidates(
    candidates: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Coalesce only short, contiguous passages from the same speaker."""
    groups: Dict[Tuple[str, str], Dict[int, Dict[str, Any]]] = {}
    for item in candidates:
        key = (item["meetingId"], item["kind"])
        groups.setdefault(key, {}).setdefault(item["seqIndex"], item)

    merged: List[Dict[str, Any]] = []
    for (_, kind), by_seq in groups.items():
        current: Optional[Dict[str, Any]] = None
        for item in sorted(by_seq.values(), key=lambda item: item["seqIndex"]):
            if (
                current is not None
                and kind == "transcript"
                and item["seqIndex"] == current["seqLastIndex"] + 1
                and item.get("speaker") == current.get("speaker")
                and item.get("isNeighbor") == current.get("isNeighbor")
                and item.get("alreadyCited") == current.get("alreadyCited")
                and ("contextDistance" in item) == ("contextDistance" in current)
                and current["startMs"] is not None
                and current["endMs"] is not None
                and item["startMs"] is not None
                and item["endMs"] is not None
                and item["startMs"] - current["endMs"] <= MAX_MERGED_PASSAGE_GAP_MS
                and max(current["endMs"], item["endMs"]) - current["startMs"] <= MAX_MERGED_PASSAGE_SPAN_MS
                and len(current["text"]) + 1 + len(item["text"]) <= MAX_MERGED_PASSAGE_CHARS
            ):
                current["seqLastIndex"] = item["seqIndex"]
                current["endMs"] = max(current["endMs"], item["endMs"])
                current["endSec"] = round(current["endMs"] / 1000.0, 3)
                current["text"] += " " + item["text"]
                if "contextDistance" in item:
                    current["contextDistance"] = min(current["contextDistance"], item["contextDistance"])
                if item.get("rank", 0.0) < current.get("rank", 0.0):
                    current["rank"] = item["rank"]
                    if item.get("excerpt"):
                        current["excerpt"] = item["excerpt"]
                elif current.get("rank", 0.0) == 0.0 and item.get("rank", 0.0) == 0.0:
                    current["excerpt"] = ""
                continue

            current = {**item, "seqLastIndex": item["seqIndex"]}
            merged.append(current)
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
                "passageKey": f'{item["meetingId"]}:{item["seqIndex"]}',
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


def _retrieve_direct_evidence(
    conn: sqlite3.Connection,
    headers: Sequence[Dict[str, Any]],
    *,
    block_cap: int,
    token_cap: int,
) -> List[Dict[str, Any]]:
    if not 1 <= len(headers) <= MAX_OVERVIEW_MEETINGS or block_cap <= 0 or token_cap <= 0:
        return []
    ordered_headers = sorted(headers, key=lambda h: (h["date"], h["meetingId"]))
    meeting_ids = [h["meetingId"] for h in ordered_headers]
    sizes = estimate_meeting_transcripts(conn, meeting_ids)
    if (
        len(sizes) != len(meeting_ids)
        or sum(size for _, size in sizes.values()) > token_cap * 4
    ):
        return []
    order = {mid: idx for idx, mid in enumerate(meeting_ids)}
    raw_items = [
        item
        for item in fetch_meeting_passages(conn, meeting_ids, kinds=("transcript",))
        if str(item.get("text") or "").strip()
    ]
    items = sorted(
        _merge_adjacent_candidates(raw_items),
        key=lambda item: (order[item["meetingId"]], item["seqIndex"]),
    )
    if (
        len(items) > block_cap
        or {item["meetingId"] for item in items} != order.keys()
        or sum(_estimate_item_tokens(item) for item in items) > token_cap
    ):
        return []
    hash_lookup = {
        h["meetingId"]: str(h.get("transcriptHash") or "")
        for h in ordered_headers
        if h.get("transcriptHash")
    }
    return _pack_evidence_items(items, block_cap=block_cap, token_cap=token_cap, hash_lookup=hash_lookup)


def _retrieve_overview_evidence(
    conn_headers: Sequence[Dict[str, Any]],
    *,
    rec_dir: Path,
    idx_path: Path,
    block_cap: int,
    token_cap: int,
    conn: Optional[sqlite3.Connection] = None,
) -> List[Dict[str, Any]]:
    if not conn_headers or block_cap <= 0 or token_cap <= 0:
        return []

    chosen_headers = list(conn_headers[:MAX_OVERVIEW_MEETINGS])
    chosen_ids = [h["meetingId"] for h in chosen_headers]
    order_map = {mid: idx for idx, mid in enumerate(chosen_ids)}

    owned_conn: Optional[sqlite3.Connection] = None
    active_conn = conn
    if active_conn is None:
        if not idx_path.exists():
            return []
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
                "meetingOrder": order_map.get(p["meetingId"], 0),
            }
        )

    if not candidates:
        return []

    merged = sorted(
        _merge_adjacent_candidates(candidates),
        key=lambda item: (item["meetingOrder"], item["seqIndex"]),
    )
    transcripts = [item for item in merged if item["kind"] == "transcript"]
    all_summaries = [item for item in merged if item["kind"] == "summary"]
    per_meeting_tx: Dict[str, List[Dict[str, Any]]] = {}
    for item in transcripts:
        per_meeting_tx.setdefault(item["meetingId"], []).append(item)

    timed_meeting_ids = {
        mid for mid, items in per_meeting_tx.items()
        if all(item.get("startSec") is not None for item in items)
    }
    needed_summaries = [item for item in all_summaries if item["meetingId"] not in timed_meeting_ids]
    summary_tokens = sum(_estimate_item_tokens(item) for item in needed_summaries)
    total_tx_tokens = sum(_estimate_item_tokens(item) for item in transcripts)

    counts = {mid: len(items) for mid, items in per_meeting_tx.items()}
    if len(transcripts) + len(needed_summaries) > block_cap or total_tx_tokens + summary_tokens > token_cap:
        summaries = list(needed_summaries)
        for _ in range(2):
            rem_blocks = max(0, block_cap - len(summaries))
            rem_tokens = max(0, token_cap - sum(_estimate_item_tokens(item) for item in summaries))
            if rem_blocks <= 0 or rem_tokens <= 0 or not transcripts:
                counts = {mid: 0 for mid in per_meeting_tx}
                sampled_tx: List[Dict[str, Any]] = []
            else:
                target_blocks = min(rem_blocks, len(transcripts))
                sampled_tx = []
                while target_blocks >= 1:
                    counts = _allocate_fair_counts(chosen_ids, per_meeting_tx, target_blocks)
                    sampled_tx = [
                        item
                        for mid in per_meeting_tx
                        for item in _uniform_sample(per_meeting_tx[mid], counts[mid])
                    ]
                    sampled_tokens = sum(_estimate_item_tokens(item) for item in sampled_tx)
                    if sampled_tokens <= rem_tokens or target_blocks == 1:
                        break
                    target_blocks = min(
                        target_blocks - 1,
                        max(1, target_blocks * rem_tokens // max(1, sampled_tokens)),
                    )
            fully_timed_ids = {
                mid for mid in timed_meeting_ids
                if counts.get(mid, 0) == len(per_meeting_tx[mid])
            }
            next_summaries = [item for item in all_summaries if item["meetingId"] not in fully_timed_ids]
            if len(next_summaries) == len(summaries):
                transcripts = sampled_tx
                break
            summaries = next_summaries
            transcripts = sampled_tx
        needed_summaries = summaries

    ordered_evidence = [*transcripts, *needed_summaries]
    if needed_summaries and (
        len(ordered_evidence) > block_cap
        or sum(_estimate_item_tokens(item) for item in ordered_evidence) > token_cap
    ):
        ordered_evidence = [*needed_summaries, *transcripts]
    return _pack_evidence_items(
        ordered_evidence,
        block_cap=block_cap,
        token_cap=token_cap,
        hash_lookup=hash_lookup,
    )


def _context_strings(context: Dict[str, Any], key: str) -> List[str]:
    values = context.get(key)
    if not isinstance(values, (list, tuple)):
        return []
    return [value.strip() for value in values if isinstance(value, str) and value.strip()][:64]


def _passage_budget(recording_count: int, *, deepen: bool) -> int:
    if recording_count <= 1:
        return 48 if deepen else 40
    if recording_count <= 4:
        return 16 if deepen else 12
    return 6 if deepen else 5


def _nearby_candidates(
    conn: sqlite3.Connection,
    hits: Sequence[Dict[str, Any]],
    cited_keys: Set[str],
    *,
    anchors: Sequence[str],
    passage_budget: int,
    deepen: bool,
) -> List[Dict[str, Any]]:
    by_meeting: Dict[str, Dict[int, Dict[str, Any]]] = {}
    for hit in hits:
        if hit["kind"] == "transcript":
            by_meeting.setdefault(hit["meetingId"], {})[hit["seqIndex"]] = hit

    extra = []
    for mid in anchors:
        direct = by_meeting.get(mid, {})
        prefix = f"{mid}:"
        cited = {
            int(key[len(prefix):])
            for key in cited_keys
            if key.startswith(prefix) and re.fullmatch(r"[0-9]{1,9}", key[len(prefix):])
        }
        expansion_seeds = (cited or direct.keys()) if deepen else ()
        if expansion_seeds:
            # Look farther forward than backward to surface the next part of the discussion.
            radius = min(2 * passage_budget, 96)
            seqs = {
                seq
                for anchor in expansion_seeds
                for seq in range(max(1, anchor - radius // 2), anchor + radius + 1)
            }
            distances = {seq: min(abs(seq - anchor) for anchor in expansion_seeds) for seq in seqs}
            seqs = set(sorted(seqs, key=lambda seq: (distances[seq], -seq))[:radius * 2])
        else:
            seqs = {seq + offset for seq in direct for offset in (-1, 1) if seq + offset >= 1}
        if not seqs:
            continue
        for passage in fetch_neighbor_passages(conn, mid, sorted(seqs - direct.keys())):
            seq = passage["seqIndex"]
            if expansion_seeds:
                extra.append({**passage, "contextDistance": distances[seq]})
                continue
            for adjacent in (direct.get(seq - 1), direct.get(seq + 1)):
                if adjacent is None:
                    continue
                before, after = sorted((passage, adjacent), key=lambda item: item["seqIndex"])
                if (
                    before["endMs"] is None
                    or after["startMs"] is None
                    or after["startMs"] - before["endMs"] <= MAX_MERGED_PASSAGE_GAP_MS
                ):
                    extra.append({**passage, "isNeighbor": True})
                    break
    return extra


def retrieve_evidence(
    recordings_dir: str | Path,
    index_path: str | Path,
    *,
    question: str,
    scope: Optional[Dict[str, Any]] = None,
    thread_context: Optional[Dict[str, Any]] = None,
    prior_turn_context: Optional[Dict[str, Any]] = None,
    max_evidence_blocks: Optional[int] = None,
    max_evidence_tokens: Optional[int] = None,
    sync: bool = True,
    now: Optional[date | datetime] = None,
) -> Dict[str, Any]:
    """Route scoped Q&A to full transcripts, targeted passages, or an overview."""
    rec_dir = Path(recordings_dir)
    idx_path = Path(index_path)
    normalized_scope = normalize_scope(scope)
    raw_question = str(question or "").strip()
    if normalized_scope["type"] == "none":
        return {
            "question": raw_question,
            "retrievalQuery": "",
            "queryTokens": [],
            "retrievalMode": "none",
            "detectedDateFilter": "",
            "matchedEntities": {"titles": [], "speakers": [], "tags": []},
            "totalIndexedMeetings": 0,
            "searchedMeetingCount": 0,
            "matchedMeetingCount": 0,
            "evidence": [],
        }
    raw_query_tokens = extract_query_tokens(raw_question)
    block_limit = max(0, int(max_evidence_blocks)) if max_evidence_blocks is not None else None

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
        entity_ids = set(entities["meetingIds"])
        entity_headers = [h for h in filtered_headers if h["meetingId"] in entity_ids]
        _, cleaned_tokens = build_retrieval_query(temporal["strippedQuestion"], allow_raw_fallback=False)
        topic_tokens = [
            tok for tok in cleaned_tokens
            if tok.casefold() not in entities["matchedTokens"] and not _is_generic_token(tok)
        ]

        thread = thread_context if isinstance(thread_context, dict) else {}
        prior_turn = prior_turn_context or thread.get("priorTurnContext")
        prior = {**thread, **(prior_turn if isinstance(prior_turn, dict) else {})}
        last_question = str(prior.get("lastQuestion") or "")
        deepen = bool(_DEEPEN_RE.search(raw_question))
        pronoun = bool(_PRONOUN_FOLLOW_UP_RE.search(raw_question))
        # An explicit current entity or time constraint takes precedence over the thread.
        has_date_filter = bool(temporal["dateFrom"] or temporal["dateTo"] or temporal["latestOnly"])
        conversational = all(tok.casefold() in _CONVERSATIONAL_FOLLOW_UP_WORDS for tok in topic_tokens)
        has_cue = any(tok.casefold() in _FOLLOW_UP_CUES for tok in raw_query_tokens)
        follow_up = (deepen or pronoun or (conversational and has_cue)) and not entity_ids and not has_date_filter
        deepen = deepen and follow_up
        prior_ids = set(_context_strings(prior, "lastCitedMeetingIds"))
        cited_keys = set(_context_strings(prior, "lastCitedPassageKeys"))
        prior_ids.update(key.rsplit(":", 1)[0] for key in cited_keys if ":" in key)
        prior_headers = [h for h in filtered_headers if follow_up and h["meetingId"] in prior_ids]
        explicit_hints = _context_strings(prior, "priorEntities") + _context_strings(prior, "speakers")
        carry_tokens: List[str] = []
        if follow_up and (deepen or pronoun or prior_headers):
            hint_headers = prior_headers or filtered_headers
            prior_entities = match_entities(last_question, hint_headers)
            hinted_speakers = prior_entities["matchedSpeakers"]
            if not explicit_hints and not hinted_speakers:
                hinted_speakers = match_entities(
                    str(prior.get("lastAssistantSummary") or ""), hint_headers
                )["matchedSpeakers"]
            hints = [*explicit_hints, *hinted_speakers]
            _, prior_tokens = build_retrieval_query(last_question, allow_raw_fallback=False)
            prior_topic = [
                tok
                for tok in prior_tokens
                if tok.casefold() not in prior_entities["matchedTokens"]
                and tok.casefold() not in _CONVERSATIONAL_FOLLOW_UP_WORDS
                and not _is_generic_token(tok)
            ]
            if not hints:
                # A name mentioned in speech may not be a named speaker in the index.
                hints = [tok for tok in prior_topic if tok[0].isupper()]
            if not hints:
                hints = prior_topic
            _, carry_tokens = build_retrieval_query(" ".join(hints), allow_raw_fallback=False)
            if not prior_headers:
                carry_ids = set(prior_entities["strongMeetingIds"]) or set(
                    match_entities(" ".join(hints), hint_headers)["strongMeetingIds"]
                )
                prior_headers = [h for h in hint_headers if h["meetingId"] in carry_ids]
            topic_tokens = [tok for tok in topic_tokens if tok.casefold() not in _CONVERSATIONAL_FOLLOW_UP_WORDS]

        def result(
            mode: str,
            evidence: List[Dict[str, Any]],
            tokens: Sequence[str] = (),
        ) -> Dict[str, Any]:
            return {
                "question": raw_question,
                "retrievalQuery": " ".join(tokens),
                "queryTokens": list(tokens),
                "retrievalMode": mode,
                "detectedDateFilter": temporal["detectedLabel"] or "",
                "matchedEntities": {
                    "titles": entities["matchedTitles"],
                    "speakers": entities["matchedSpeakers"],
                    "tags": entities["matchedTags"],
                },
                "totalIndexedMeetings": total_indexed,
                "searchedMeetingCount": scoped_count,
                "matchedMeetingCount": len({item["meetingId"] for item in evidence}),
                "evidence": evidence,
            }

        if not raw_query_tokens or date_conflict or (scoped_headers and not filtered_headers):
            return result("targeted", [], topic_tokens)

        token_cap = max(0, min(MAX_EVIDENCE_TOKENS, (
            max_evidence_tokens if max_evidence_tokens is not None else MAX_EVIDENCE_TOKENS
        )))
        direct_headers = prior_headers if (deepen or not topic_tokens) and prior_headers else filtered_headers
        if entity_headers and (not topic_tokens or (len(entity_headers) == 1 and entities["strongMeetingIds"])):
            direct_headers = entity_headers
        if conn is not None:
            direct = _retrieve_direct_evidence(
                conn, direct_headers,
                block_cap=min(MAX_DIRECT_EVIDENCE_BLOCKS, block_limit) if block_limit is not None else MAX_DIRECT_EVIDENCE_BLOCKS,
                token_cap=token_cap,
            )
            if direct:
                return result("direct_full", direct)

        def overview(headers: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
            evidence = _retrieve_overview_evidence(
                headers,
                rec_dir=rec_dir,
                idx_path=idx_path,
                block_cap=block_limit if block_limit is not None else OVERVIEW_MAX_EVIDENCE_BLOCKS,
                token_cap=token_cap,
                conn=conn,
            )
            return result("overview", evidence)

        if not topic_tokens and not (follow_up and (deepen or pronoun) and (carry_tokens or cited_keys)):
            return overview(entity_headers or prior_headers or filtered_headers)

        strong_ids = set(entities["strongMeetingIds"])
        target_headers = prior_headers or [h for h in entity_headers if h["meetingId"] in strong_ids] or filtered_headers
        query_tokens = list(dict.fromkeys([*topic_tokens, *carry_tokens])) if follow_up and deepen else topic_tokens or carry_tokens

        def search(headers: Sequence[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
            per_meeting = _passage_budget(len(headers), deepen=deepen)
            if not query_tokens:
                return [], per_meeting
            meeting_ids = normalized_scope["meetingIds"]
            if conn is not None and (headers != scoped_headers or meeting_ids is not None):
                meeting_ids = [h["meetingId"] for h in headers]
            response = search_history_index(
                rec_dir,
                idx_path,
                query=" ".join(query_tokens),
                limit=12,
                max_matches_per_meeting=per_meeting,
                meeting_ids=meeting_ids,
                date_from=eff_from,
                date_to=eff_to,
                tags=scoped_tags,
                sync=False,
                conn=conn,
                qa_stopwords=_CONVERSATIONAL_FOLLOW_UP_WORDS,
            )
            hits = []
            for meeting in response["meetings"]:
                mid = meeting["meetingId"]
                for passage in meeting["matches"]:
                    text = str(passage.get("text") or "").strip()
                    kind = passage.get("kind") or "transcript"
                    if not text or kind == "title" or passage.get("matchedBody") is False:
                        continue
                    hits.append({
                        **passage,
                        "meetingId": mid,
                        "meetingTitle": meeting.get("title") or "Untitled recording",
                        "meetingDate": meeting.get("date") or "",
                        "tag": meeting.get("tag") or "",
                        "kind": kind,
                        "seqIndex": passage.get("seqIndex") or 0,
                        "startMs": passage.get("startMs"),
                        "endMs": passage.get("endMs"),
                        "speaker": passage.get("speaker") or "",
                        "text": text,
                    })
            return hits, per_meeting

        candidates, per_meeting = search(target_headers)
        if not candidates and target_headers != filtered_headers and not (deepen and prior_headers):
            target_headers = filtered_headers
            candidates, per_meeting = search(target_headers)

        meeting_order = list(dict.fromkeys(c["meetingId"] for c in candidates))
        if conn is not None and 1 <= len(meeting_order) <= 4:
            upgraded_budget = _passage_budget(len(meeting_order), deepen=deepen)
            if upgraded_budget > per_meeting:
                matched_id_set = set(meeting_order)
                matched_headers = [h for h in target_headers if h["meetingId"] in matched_id_set]
                if matched_headers:
                    candidates, per_meeting = search(matched_headers)
                    meeting_order = list(dict.fromkeys(c["meetingId"] for c in candidates))
        if conn is not None:
            anchor_ids = list(dict.fromkeys([*meeting_order, *(h["meetingId"] for h in prior_headers)]))
            candidates += _nearby_candidates(
                conn, candidates, cited_keys, anchors=anchor_ids, passage_budget=per_meeting, deepen=deepen,
            )
        if not candidates:
            if follow_up and (deepen or not topic_tokens) and prior_headers:
                return overview(prior_headers)
            return result("targeted", [], query_tokens)

        for item in candidates:
            item["alreadyCited"] = f'{item["meetingId"]}:{item["seqIndex"]}' in cited_keys
        # Spend the first slots across recordings in router order. Within each recording,
        # put fresh matching passages and expansion context ahead of previously cited text.
        carried = {tok.casefold() for tok in carry_tokens}
        by_meeting: Dict[str, List[Dict[str, Any]]] = {}
        for item in _merge_adjacent_candidates(candidates):
            by_meeting.setdefault(item["meetingId"], []).append(item)
        routed_ids = list(dict.fromkeys([*meeting_order, *by_meeting]))
        for items in by_meeting.values():
            items.sort(key=lambda item: (
                deepen and item["alreadyCited"],
                bool(item.get("isNeighbor")),
                item["kind"] != "transcript",
                item.get("contextDistance", 0),
                not any(tok.casefold() in carried for tok in extract_query_tokens(item.get("speaker"))),
                item.get("rank", 0),
                item["seqIndex"],
            ))

        matched_recordings = len(routed_ids)
        final_per_meeting = _passage_budget(matched_recordings, deepen=deepen)
        ordered = [
            by_meeting[mid][slot]
            for slot in range(final_per_meeting)
            for mid in routed_ids
            if mid in by_meeting and slot < len(by_meeting[mid])
        ]
        block_cap = block_limit if block_limit is not None else (
            final_per_meeting if matched_recordings <= 1 else MAX_EVIDENCE_BLOCKS
        )
        if matched_recordings >= 5:
            token_cap = min(token_cap, 18_000)
        missing_hash_ids = [c["meetingId"] for c in ordered if not c.get("sourceTranscriptHash")]
        header_hashes = _build_source_hash_lookup(rec_dir, idx_path, missing_hash_ids, conn=conn) if missing_hash_ids else {}
        evidence = _pack_evidence_items(ordered, block_cap=block_cap, token_cap=token_cap, hash_lookup=header_hashes)
        return result("targeted", evidence, query_tokens)

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
    from history_qa.qa_runner import QAPromptBudget

    parser = argparse.ArgumentParser(description="AvaNevis local FTS5 evidence retrieval preflight")
    parser.add_argument("--recordings-dir", required=True)
    parser.add_argument("--index-path", required=True)
    parser.add_argument("--stdin-json", action="store_true", required=True)
    args = parser.parse_args()

    payload = json.loads(sys.stdin.read() or "{}")
    question = str(payload.get("question") or "")
    result = retrieve_evidence(
        Path(args.recordings_dir),
        Path(args.index_path),
        question=question,
        scope=payload.get("scope"),
        thread_context=payload.get("threadContext"),
        prior_turn_context=payload.get("priorTurnContext"),
        max_evidence_blocks=(
            int(payload["maxEvidenceBlocks"])
            if payload.get("maxEvidenceBlocks") is not None
            else None
        ),
        max_evidence_tokens=QAPromptBudget(payload, question).evidence_tokens(),
        sync=bool(payload.get("sync", True)),
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
