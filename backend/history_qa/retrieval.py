"""Scoped SQLite FTS5 evidence retrieval for grounded local History Q&A."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from search.history_index import (
    _ensure_synced_connection,
    build_scope_sql_filters,
    extract_query_tokens,
    search_history_index,
)

MAX_EVIDENCE_BLOCKS = 12
MAX_EVIDENCE_TOKENS = 14_000
MAX_PASSAGES_PER_MEETING_CANDIDATE = 6
MAX_MERGED_PASSAGE_GAP_MS = 10_000
MAX_MERGED_PASSAGE_CHARS = 1_200

_QUESTION_STOPWORDS = frozenset(
    {
        "a",
        "about",
        "after",
        "all",
        "an",
        "and",
        "any",
        "anything",
        "are",
        "as",
        "at",
        "be",
        "before",
        "but",
        "by",
        "can",
        "could",
        "did",
        "discuss",
        "discussed",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "here",
        "his",
        "how",
        "i",
        "if",
        "in",
        "into",
        "is",
        "it",
        "its",
        "me",
        "mention",
        "mentioned",
        "my",
        "of",
        "on",
        "or",
        "our",
        "please",
        "said",
        "say",
        "she",
        "should",
        "so",
        "some",
        "something",
        "talk",
        "talked",
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
        "to",
        "us",
        "was",
        "we",
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
        "you",
        "your",
    }
)


def estimate_token_count(text: Any) -> int:
    """Estimate tokens safely using UTF-8 byte ceiling (4 bytes per token)."""
    raw = str(text or "").encode("utf-8", errors="replace")
    if not raw:
        return 0
    return max(1, (len(raw) + 3) // 4)


def build_retrieval_query(question: str) -> Tuple[str, List[str]]:
    """Strip conversational filler stopwords while keeping at least one searchable token."""
    raw_tokens = extract_query_tokens(question)
    if not raw_tokens:
        return "", []

    content_tokens = [tok for tok in raw_tokens if tok.casefold() not in _QUESTION_STOPWORDS]
    chosen = content_tokens if content_tokens else raw_tokens
    return " ".join(chosen), chosen


def normalize_scope(raw_scope: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if raw_scope is None:
        return {"type": "all", "meetingIds": None, "dateFrom": None, "dateTo": None}

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
    }


def _count_scoped_meetings(
    recordings_dir: Path,
    index_path: Path,
    *,
    meeting_ids: Optional[Sequence[str]],
    date_from: Optional[str],
    date_to: Optional[str],
) -> Tuple[int, int]:
    conn, _stats = _ensure_synced_connection(recordings_dir, index_path, perform_sync=False)
    try:
        total_meetings = int(conn.execute("SELECT COUNT(*) FROM indexed_meetings").fetchone()[0])
        if meeting_ids is not None:
            cleaned_ids = [str(mid).strip() for mid in meeting_ids if str(mid or "").strip()]
            if not cleaned_ids:
                return total_meetings, 0
        clauses, params = build_scope_sql_filters(
            meeting_ids=meeting_ids,
            date_from=date_from,
            date_to=date_to,
        )
        # build_scope_sql_filters emits p.meeting_id for meeting_ids; rewrite alias to m.
        m_clauses = [clause.replace("p.meeting_id", "m.meeting_id") for clause in clauses]
        where_sql = f"WHERE {' AND '.join(m_clauses)}" if m_clauses else ""
        scoped_count = int(
            conn.execute(f"SELECT COUNT(*) FROM indexed_meetings m {where_sql}", params).fetchone()[0]
        )
        return total_meetings, scoped_count
    finally:
        conn.close()


def _merge_adjacent_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Coalesce contiguous transcript hits within the same meeting and speaker."""
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
        for item in items:
            span_key = (mid, item["kind"], item["seqIndex"])
            if span_key in seen_spans:
                continue
            seen_spans.add(span_key)

            if current is None:
                current = dict(item)
                continue

            adjacent_seq = item["seqIndex"] == current["seqLastIndex"] + 1
            same_speaker = item["speaker"] == current["speaker"]
            gap_ok = True
            if current["endMs"] is not None and item["startMs"] is not None:
                gap_ok = (item["startMs"] - current["endMs"]) <= MAX_MERGED_PASSAGE_GAP_MS
            combined_text = f"{current['text']} {item['text']}".strip()
            if adjacent_seq and same_speaker and gap_ok and len(combined_text) <= MAX_MERGED_PASSAGE_CHARS:
                current["seqLastIndex"] = item["seqIndex"]
                if item["endMs"] is not None:
                    current["endMs"] = max(current["endMs"] or 0, item["endMs"])
                    current["endSec"] = round(current["endMs"] / 1000.0, 3)
                current["text"] = combined_text
                current["rank"] = min(current["rank"], item["rank"])
            else:
                merged.append(current)
                current = dict(item)
        if current is not None:
            merged.append(current)

    for item in other_hits:
        span_key = (item["meetingId"], item["kind"], item["seqIndex"])
        if span_key in seen_spans:
            continue
        seen_spans.add(span_key)
        merged.append(item)

    merged.sort(
        key=lambda item: (
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
) -> Dict[str, str]:
    clean_ids = [mid for mid in set(meeting_ids) if mid]
    if not clean_ids or not index_path.exists():
        return {}
    conn, _stats = _ensure_synced_connection(recordings_dir, index_path, perform_sync=False)
    try:
        placeholders = ", ".join("?" for _ in clean_ids)
        rows = conn.execute(
            f"SELECT meeting_id, transcript_hash FROM indexed_meetings WHERE meeting_id IN ({placeholders})",
            clean_ids,
        ).fetchall()
        return {str(row["meeting_id"]): str(row["transcript_hash"] or "") for row in rows}
    finally:
        conn.close()


def retrieve_evidence(
    recordings_dir: str | Path,
    index_path: str | Path,
    *,
    question: str,
    scope: Optional[Dict[str, Any]] = None,
    max_evidence_blocks: int = MAX_EVIDENCE_BLOCKS,
    max_evidence_tokens: int = MAX_EVIDENCE_TOKENS,
    sync: bool = True,
) -> Dict[str, Any]:
    """Retrieve bounded, immutable evidence passages from SQLite FTS5.

    Fail-closed: returns an empty ``evidence`` list whenever nothing in the
    scoped history matches the question tokens (never dumps whole transcripts).
    """
    rec_dir = Path(recordings_dir)
    idx_path = Path(index_path)
    normalized_scope = normalize_scope(scope)
    retrieval_query, query_tokens = build_retrieval_query(question)

    if not retrieval_query or not query_tokens:
        if sync:
            conn, _ = _ensure_synced_connection(rec_dir, idx_path, perform_sync=True)
            conn.close()
        total_indexed, scoped_count = _count_scoped_meetings(
            rec_dir,
            idx_path,
            meeting_ids=normalized_scope["meetingIds"],
            date_from=normalized_scope["dateFrom"],
            date_to=normalized_scope["dateTo"],
        )
        return {
            "question": str(question or "").strip(),
            "retrievalQuery": "",
            "queryTokens": [],
            "totalIndexedMeetings": total_indexed,
            "searchedMeetingCount": scoped_count,
            "matchedMeetingCount": 0,
            "evidence": [],
        }

    search_res = search_history_index(
        rec_dir,
        idx_path,
        query=retrieval_query,
        limit=25,
        max_matches_per_meeting=MAX_PASSAGES_PER_MEETING_CANDIDATE,
        meeting_ids=normalized_scope["meetingIds"],
        date_from=normalized_scope["dateFrom"],
        date_to=normalized_scope["dateTo"],
        sync=sync,
    )

    total_indexed, scoped_count = _count_scoped_meetings(
        rec_dir,
        idx_path,
        meeting_ids=normalized_scope["meetingIds"],
        date_from=normalized_scope["dateFrom"],
        date_to=normalized_scope["dateTo"],
    )

    candidates: List[Dict[str, Any]] = []
    matched_meeting_ids: List[str] = []
    for meeting_hit in search_res.get("meetings") or []:
        mid = str(meeting_hit.get("meetingId") or "")
        if not mid:
            continue
        matched_meeting_ids.append(mid)
        for passage in meeting_hit.get("matches") or []:
            text = str(passage.get("text") or "").strip()
            kind = str(passage.get("kind") or "transcript")
            if not text and kind == "title":
                # Title-only passage carries no spoken excerpt body; skip for evidence quotes.
                continue
            if not text:
                continue
            start_ms = passage.get("startMs")
            end_ms = passage.get("endMs")
            candidates.append(
                {
                    "meetingId": mid,
                    "meetingTitle": str(meeting_hit.get("title") or "Untitled Meeting"),
                    "meetingDate": str(meeting_hit.get("date") or ""),
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
                    "rank": float(passage.get("rank") or 0.0),
                }
            )

    if not candidates:
        return {
            "question": str(question or "").strip(),
            "retrievalQuery": retrieval_query,
            "queryTokens": query_tokens,
            "totalIndexedMeetings": total_indexed,
            "searchedMeetingCount": scoped_count,
            "matchedMeetingCount": 0,
            "evidence": [],
        }

    merged = _merge_adjacent_candidates(candidates)
    hash_lookup = _build_source_hash_lookup(rec_dir, idx_path, [c["meetingId"] for c in merged])

    selected: List[Dict[str, Any]] = []
    used_tokens = 0
    block_cap = max(1, int(max_evidence_blocks))
    token_cap = max(0, int(max_evidence_tokens))

    for item in merged:
        if len(selected) >= block_cap:
            break
        # Budget the actual serialized header as well as the passage, using UTF-8
        # bytes so clipping never splits a Unicode code point.
        remaining_bytes = (token_cap - used_tokens) * 4
        title = item["meetingTitle"].encode("utf-8", errors="replace")[:512].decode("utf-8", errors="ignore")
        speaker = item["speaker"].encode("utf-8", errors="replace")[:512].decode("utf-8", errors="ignore")
        date = item["meetingDate"][:10]
        overhead = len(f"[E{len(selected) + 1}] Meeting: {title} ({date}, 999999:59:59 | Speaker: {speaker})\n\n".encode("utf-8")) + 128
        if remaining_bytes <= overhead:
            break
        text = item["text"].encode("utf-8", errors="replace")[:remaining_bytes - overhead].decode("utf-8", errors="ignore")
        if not text.strip():
            break
        block_cost = (overhead + len(text.encode("utf-8")) + 3) // 4
        evidence_id = f"E{len(selected) + 1}"
        excerpt = text if len(text) <= 280 else f"{text[:279]}…"
        selected.append(
            {
                "evidenceId": evidence_id,
                "meetingId": item["meetingId"],
                "meetingTitle": title,
                "meetingDate": item["meetingDate"],
                "kind": item["kind"],
                "startSec": item["startSec"],
                "endSec": item["endSec"],
                "speaker": speaker,
                "excerpt": excerpt,
                "text": text,
                "sourceTranscriptHash": hash_lookup.get(item["meetingId"], ""),
            }
        )
        used_tokens += block_cost

    return {
        "question": str(question or "").strip(),
        "retrievalQuery": retrieval_query,
        "queryTokens": query_tokens,
        "totalIndexedMeetings": total_indexed,
        "searchedMeetingCount": scoped_count,
        "matchedMeetingCount": len(dict.fromkeys(item["meetingId"] for item in selected)),
        "evidence": selected,
    }


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
        max_evidence_blocks=int(payload.get("maxEvidenceBlocks") or MAX_EVIDENCE_BLOCKS),
        max_evidence_tokens=int(payload.get("maxEvidenceTokens") or MAX_EVIDENCE_TOKENS),
        sync=bool(payload.get("sync", True)),
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
