"""Fail-closed citation verification for local History Q&A responses."""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

INSUFFICIENT_EVIDENCE_MESSAGE = (
    "I couldn't find enough grounded evidence in the matched local meeting "
    "transcripts or summaries to answer that confidently."
)
JSON_REPAIR_BYTE_CAP = 12_000

_THINK_BLOCK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)
_UNCLOSED_THINK_RE = re.compile(r"<think>[\s\S]*$", re.IGNORECASE)
_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$", re.IGNORECASE)
_EVIDENCE_GROUP_RE = re.compile(r"\[((?:E\d+)(?:\s*,\s*E\d+)+)\]")
_SINGLE_EVIDENCE_RE = re.compile(r"\[(E\d+)\]")


def strip_model_artifacts(raw_text: Any) -> str:
    """Remove Qwen/llama <think> blocks and outer Markdown code fences."""
    cleaned = str(raw_text or "").strip()
    cleaned = _THINK_BLOCK_RE.sub("", cleaned)
    cleaned = _UNCLOSED_THINK_RE.sub("", cleaned).strip()
    fence_match = _CODE_FENCE_RE.match(cleaned)
    if fence_match:
        cleaned = fence_match.group(1).strip()
    return cleaned


def _extract_balanced_json_object(text: str) -> Optional[str]:
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escape = False
        for idx in range(start, len(text)):
            ch = text[idx]
            if in_string:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_string = False
                continue
            if ch == '"':
                in_string = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[start : idx + 1]
        start = text.find("{", start + 1)
    return None


def parse_qa_json(raw_text: Any) -> Optional[Dict[str, Any]]:
    """Parse strict Q&A JSON output after stripping thinking/code chrome."""
    cleaned = strip_model_artifacts(raw_text)
    if not cleaned:
        return None

    for candidate in (cleaned, _extract_balanced_json_object(cleaned)):
        if not candidate:
            continue
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and (
            isinstance(parsed.get("answerMarkdown"), str)
            or isinstance(parsed.get("insufficientEvidence"), bool)
        ):
            return parsed
    return None


def _normalize_inline_citations(markdown: str, valid_ids: set[str]) -> Tuple[str, List[str]]:
    """Expand multi-ID groups `[E1, E2]` -> `[E1] [E2]` and strip unverified `[Ek]`."""
    expanded = _EVIDENCE_GROUP_RE.sub(
        lambda m: " ".join(f"[{tok.strip()}]" for tok in m.group(1).split(",")),
        markdown,
    )
    found_valid: List[str] = []

    def replace_marker(match: re.Match[str]) -> str:
        eid = match.group(1)
        if eid in valid_ids:
            if eid not in found_valid:
                found_valid.append(eid)
            return f"[{eid}]"
        return ""

    sanitized = _SINGLE_EVIDENCE_RE.sub(replace_marker, expanded)
    # Collapse leftover extra spaces before punctuation when hallucinated markers were stripped.
    sanitized = re.sub(r"[ \t]+([.,;:!?])", r"\1", sanitized)
    sanitized = re.sub(r"[ \t]{2,}", " ", sanitized)
    sanitized = "\n".join(line.rstrip() for line in sanitized.splitlines()).strip()
    return sanitized, found_valid


def verify_grounded_response(
    raw_text: Any,
    evidence_items: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    """Verify Q&A JSON output strictly against the immutable retrieved evidence map.

    The LLM can NEVER invent meeting IDs, meeting titles, timestamps, or excerpts:
    every returned citation object is populated exclusively from ``evidence_items``.
    """
    evidence_map: Dict[str, Dict[str, Any]] = {}
    for item in evidence_items:
        if isinstance(item, dict) and item.get("evidenceId"):
            evidence_map[str(item["evidenceId"])] = dict(item)

    if not evidence_map:
        return {
            "ok": True,
            "needsRepair": False,
            "status": "insufficient_evidence",
            "answerMarkdown": INSUFFICIENT_EVIDENCE_MESSAGE,
            "citations": [],
        }

    parsed = parse_qa_json(raw_text)
    if parsed is None:
        return {
            "ok": False,
            "needsRepair": True,
            "status": "error",
            "answerMarkdown": "",
            "citations": [],
            "reason": "malformed_json",
        }

    if bool(parsed.get("insufficientEvidence")):
        return {
            "ok": True,
            "needsRepair": False,
            "status": "insufficient_evidence",
            "answerMarkdown": INSUFFICIENT_EVIDENCE_MESSAGE,
            "citations": [],
        }

    raw_answer = str(parsed.get("answerMarkdown") or "").strip()
    if not raw_answer:
        return {
            "ok": True,
            "needsRepair": False,
            "status": "insufficient_evidence",
            "answerMarkdown": INSUFFICIENT_EVIDENCE_MESSAGE,
            "citations": [],
        }

    cleaned_answer, inline_valid_ids = _normalize_inline_citations(raw_answer, set(evidence_map))

    raw_listed = parsed.get("citedEvidenceIds")
    listed_valid_ids: List[str] = []
    if isinstance(raw_listed, list):
        for raw_id in raw_listed:
            eid = str(raw_id or "").strip()
            if eid in evidence_map and eid not in listed_valid_ids:
                listed_valid_ids.append(eid)

    ordered_valid_ids: List[str] = list(inline_valid_ids)
    for eid in listed_valid_ids:
        if eid not in ordered_valid_ids:
            ordered_valid_ids.append(eid)

    # Fail closed if no retrieved passage ID actually supports the response.
    if not ordered_valid_ids or not cleaned_answer.strip():
        return {
            "ok": True,
            "needsRepair": False,
            "status": "insufficient_evidence",
            "answerMarkdown": INSUFFICIENT_EVIDENCE_MESSAGE,
            "citations": [],
        }

    if not inline_valid_ids and listed_valid_ids:
        suffix = " ".join(f"[{eid}]" for eid in listed_valid_ids)
        cleaned_answer = f"{cleaned_answer} {suffix}".strip()

    citations: List[Dict[str, Any]] = []
    for eid in ordered_valid_ids:
        ev = evidence_map[eid]
        citations.append(
            {
                "evidenceId": eid,
                "meetingId": ev["meetingId"],
                "meetingTitle": ev["meetingTitle"],
                "meetingDate": ev.get("meetingDate") or "",
                "startSec": ev.get("startSec"),
                "endSec": ev.get("endSec"),
                "speaker": ev.get("speaker") or "",
                "excerpt": ev.get("excerpt") or "",
                "sourceTranscriptHash": ev.get("sourceTranscriptHash") or "",
            }
        )

    return {
        "ok": True,
        "needsRepair": False,
        "status": "answered",
        "answerMarkdown": cleaned_answer,
        "citations": citations,
    }


def build_repair_prompt(raw_output: Any, evidence_items: Sequence[Dict[str, Any]]) -> str:
    """Build a bounded single-retry JSON-repair user message (max 12 KB quoted output)."""
    valid_ids = ", ".join(str(item["evidenceId"]) for item in evidence_items if item.get("evidenceId"))
    clipped = (
        str(raw_output or "")
        .encode("utf-8", errors="ignore")[:JSON_REPAIR_BYTE_CAP]
        .decode("utf-8", errors="ignore")
    )
    return "\n\n".join(
        [
            "Your previous answer was not valid JSON.",
            "Return ONLY a valid JSON object matching this exact schema (no markdown fences, no commentary):",
            '{"answerMarkdown": "<concise Markdown answer citing [E1] etc.>", "citedEvidenceIds": ["E1"], "insufficientEvidence": false}',
            f"Valid evidence IDs: {valid_ids or 'none'}",
            "If the evidence does not clearly support an answer, return:",
            '{"answerMarkdown": "", "citedEvidenceIds": [], "insufficientEvidence": true}',
            "Previous malformed output:",
            clipped,
        ]
    )
