"""Fail-closed citation verification for local History Q&A responses."""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Sequence, Tuple

INSUFFICIENT_EVIDENCE_MESSAGE = (
    "Not enough matching information in the selected transcripts "
    "or summaries to answer that."
)
NO_MATCHING_EXCERPTS_MESSAGE = (
    "No matching excerpts were found in the selected recordings for that question."
)
VERIFICATION_FAILED_MESSAGE = (
    "The local model returned a response whose citations could not be verified "
    "against the retrieved transcripts."
)
JSON_REPAIR_BYTE_CAP = 12_000

_THINK_BLOCK_RE = re.compile(r"<think>[\s\S]*?</think>", re.IGNORECASE)
_UNCLOSED_THINK_RE = re.compile(r"<think>[\s\S]*$", re.IGNORECASE)
_GEMMA_THOUGHT_BLOCK_RE = re.compile(
    r"<\|channel>thought[\s\S]*?<channel\|>",
    re.IGNORECASE,
)
_UNCLOSED_GEMMA_THOUGHT_RE = re.compile(
    r"<\|channel>thought[\s\S]*$",
    re.IGNORECASE,
)
_CODE_FENCE_RE = re.compile(r"^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$", re.IGNORECASE)
_EVIDENCE_GROUP_RE = re.compile(r"\[((?:E\d+)(?:\s*[,;/]\s*E\d+)+)\]")
_SINGLE_EVIDENCE_RE = re.compile(r"\[(E\d+)\]")

_ATX_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}(?:\s+.*|\s*)$")
_HR_RE = re.compile(r"^\s*([-*_])(?:\s*\1){2,}\s*$")
_FENCE_LINE_RE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
_LIST_ITEM_START_RE = re.compile(r"^\s*(?:[-+*]|\d+[.)])\s+")
_BLOCKQUOTE_LINE_RE = re.compile(r"^\s*>")
_TABLE_SEP_MULTI_RE = re.compile(
    r"^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)+\|?\s*$"
)
_TABLE_SEP_SINGLE_RE = re.compile(r"^\s*\|\s*:?-{1,}:?\s*\|\s*$")
_BOLD_LEAD_IN_RE = re.compile(r"^\*\*[^*\n]{1,120}\*\*:?$")


def strip_model_artifacts(raw_text: Any) -> str:
    """Remove Qwen/Gemma reasoning blocks and outer Markdown code fences."""
    cleaned = str(raw_text or "").strip()
    cleaned = _THINK_BLOCK_RE.sub("", cleaned)
    cleaned = _UNCLOSED_THINK_RE.sub("", cleaned)
    cleaned = _GEMMA_THOUGHT_BLOCK_RE.sub("", cleaned)
    cleaned = _UNCLOSED_GEMMA_THOUGHT_RE.sub("", cleaned).strip()
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


def _normalize_inline_citations(markdown: str, valid_ids: set[str]) -> Tuple[str, bool]:
    """Expand grouped citations and detect citation-only lines before stripping invalid IDs."""
    def replace_marker(match: re.Match[str]) -> str:
        return match.group(0) if match.group(1) in valid_ids else ""

    out_lines: List[str] = []
    standalone_citation = False
    close_fence_re: Optional[re.Pattern[str]] = None
    for line in str(markdown or "").splitlines():
        if close_fence_re is not None and close_fence_re.match(line):
            close_fence_re = None
            out_lines.append(line)
            continue

        fence_match = _FENCE_LINE_RE.match(line) if close_fence_re is None else None
        if fence_match:
            fence_char = fence_match.group(1)[0]
            fence_len = len(fence_match.group(1))
            close_fence_re = re.compile(rf"^\s{{0,3}}{re.escape(fence_char)}{{{fence_len},}}\s*$")

        expanded = _EVIDENCE_GROUP_RE.sub(
            lambda m: " ".join(f"[{tok}]" for tok in re.split(r"\s*[,;/]\s*", m.group(1))),
            line,
        )
        body = re.sub(r"^\s*(?:>\s*)+", "", expanded)
        body = _LIST_ITEM_START_RE.sub("", body, count=1)
        # Table cells are handled as blocks, including the header exemption.
        if "|" not in body and _SINGLE_EVIDENCE_RE.search(body) and not _block_has_factual_text(body):
            standalone_citation = True

        sanitized_line = _SINGLE_EVIDENCE_RE.sub(replace_marker, expanded)
        if close_fence_re is None:
            # Collapse spaces left by removed citations without changing indentation.
            sanitized_line = re.sub(r"(?<=\S)[ \t]+([.,;:!?])", r"\1", sanitized_line)
            sanitized_line = re.sub(r"(?<=\S)[ \t]{2,}", " ", sanitized_line).rstrip()
        out_lines.append(sanitized_line)

    return "\n".join(out_lines).strip("\n"), standalone_citation


def _is_table_separator(line: str) -> bool:
    return not _HR_RE.match(line) and bool(_TABLE_SEP_MULTI_RE.match(line) or _TABLE_SEP_SINGLE_RE.match(line))


def _is_lead_in_line(text: str) -> bool:
    stripped = str(text or "").strip()
    if not stripped or _SINGLE_EVIDENCE_RE.search(stripped):
        return False
    without_trailing_markup = re.sub(r"[*_~`]+$", "", stripped)
    if without_trailing_markup.endswith(":") and len(stripped) <= 200:
        return True
    return bool(_BOLD_LEAD_IN_RE.match(stripped))


def _is_pipe_row(line: str) -> bool:
    stripped = line.strip()
    return "|" in stripped and not _ATX_HEADING_RE.match(stripped) and not _LIST_ITEM_START_RE.match(stripped)


def _block_has_factual_text(text: str) -> bool:
    stripped = _SINGLE_EVIDENCE_RE.sub("", text)
    return bool(re.search(r"\w", stripped, re.UNICODE))


def _parse_markdown_blocks(markdown: str) -> List[Dict[str, str]]:
    """Parse Markdown into logical structural and factual blocks."""
    lines = markdown.splitlines()
    blocks: List[Dict[str, str]] = []
    i = 0
    n = len(lines)

    while i < n:
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue

        # 1. Fenced code block
        fence_match = _FENCE_LINE_RE.match(line)
        if fence_match:
            fence_char = fence_match.group(1)[0]
            fence_len = len(fence_match.group(1))
            code_lines = []
            i += 1
            close_re = re.compile(rf"^\s{{0,3}}{re.escape(fence_char)}{{{fence_len},}}\s*$")
            while i < n:
                if close_re.match(lines[i]):
                    i += 1
                    break
                code_lines.append(lines[i])
                i += 1
            blocks.append({"type": "code", "text": "\n".join(code_lines)})
            continue

        # 2. Horizontal rule
        if _HR_RE.match(line):
            blocks.append({"type": "hr", "text": stripped})
            i += 1
            continue

        # 3. ATX heading
        if _ATX_HEADING_RE.match(line):
            blocks.append({"type": "heading", "text": stripped})
            i += 1
            continue

        # 4. GFM table (header row followed by separator row)
        if i + 1 < n and _is_pipe_row(line) and _is_table_separator(lines[i + 1]):
            blocks.append({"type": "table_header", "text": line})
            blocks.append({"type": "table_sep", "text": lines[i + 1]})
            i += 2
            while i < n:
                row_line = lines[i]
                row_stripped = row_line.strip()
                if (
                    not row_stripped
                    or _FENCE_LINE_RE.match(row_line)
                    or _ATX_HEADING_RE.match(row_line)
                    or _HR_RE.match(row_line)
                    or _LIST_ITEM_START_RE.match(row_line)
                    or _BLOCKQUOTE_LINE_RE.match(row_line)
                    or "|" not in row_stripped
                ):
                    break
                blocks.append({"type": "table_row", "text": row_line})
                i += 1
            continue

        # 5. List item (ordered or unordered) with indented continuation lines
        if _LIST_ITEM_START_RE.match(line):
            item_lines = [line]
            i += 1
            while i < n:
                cont = lines[i]
                cont_stripped = cont.strip()
                if (
                    not cont_stripped
                    or _FENCE_LINE_RE.match(cont)
                    or _ATX_HEADING_RE.match(cont)
                    or _HR_RE.match(cont)
                    or _LIST_ITEM_START_RE.match(cont)
                    or _BLOCKQUOTE_LINE_RE.match(cont)
                ):
                    break
                if i + 1 < n and _is_pipe_row(cont) and _is_table_separator(lines[i + 1]):
                    break
                item_lines.append(cont)
                i += 1
            blocks.append({"type": "list_item", "text": "\n".join(item_lines)})
            continue

        # 6. Blockquote (split on blank blockquote lines)
        if _BLOCKQUOTE_LINE_RE.match(line):
            quote_lines: List[str] = []
            while i < n and _BLOCKQUOTE_LINE_RE.match(lines[i]):
                inner = re.sub(r"^\s*>\s?", "", lines[i]).strip()
                if not inner:
                    if quote_lines:
                        blocks.append({"type": "blockquote", "text": "\n".join(quote_lines)})
                        quote_lines = []
                    i += 1
                    continue
                quote_lines.append(inner)
                i += 1
            if quote_lines:
                blocks.append({"type": "blockquote", "text": "\n".join(quote_lines)})
            continue

        # 7. Paragraph (contiguous plain lines)
        para_lines = [line]
        i += 1
        while i < n:
            nxt = lines[i]
            nxt_stripped = nxt.strip()
            if (
                not nxt_stripped
                or _FENCE_LINE_RE.match(nxt)
                or _ATX_HEADING_RE.match(nxt)
                or _HR_RE.match(nxt)
                or _LIST_ITEM_START_RE.match(nxt)
                or _BLOCKQUOTE_LINE_RE.match(nxt)
            ):
                break
            if i + 1 < n and _is_pipe_row(nxt) and _is_table_separator(lines[i + 1]):
                break
            para_lines.append(nxt)
            i += 1

        last_stripped = para_lines[-1].strip()
        if _is_lead_in_line(last_stripped):
            if len(para_lines) > 1:
                blocks.append({"type": "paragraph", "text": "\n".join(para_lines[:-1])})
            blocks.append({"type": "lead_in_candidate", "text": last_stripped})
        else:
            blocks.append({"type": "paragraph", "text": "\n".join(para_lines)})

    return blocks


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
            "status": "no_matching_excerpts",
            "answerMarkdown": NO_MATCHING_EXCERPTS_MESSAGE,
            "citations": [],
            "reason": "no_matching_excerpts",
        }

    parsed = parse_qa_json(raw_text)
    if parsed is None:
        return {
            "ok": False,
            "needsRepair": True,
            "status": "verification_failed",
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

    cleaned_answer, standalone_citation = _normalize_inline_citations(raw_answer, set(evidence_map))
    blocks = _parse_markdown_blocks(cleaned_answer)

    has_content = False
    unsupported = standalone_citation
    ordered_valid_ids: Dict[str, None] = {}
    exempt_types = {"heading", "table_header", "table_sep", "hr"}

    for idx, block in enumerate(blocks):
        btype = block["type"]
        if btype in exempt_types:
            continue

        if btype == "lead_in_candidate":
            next_block = blocks[idx + 1] if idx + 1 < len(blocks) else None
            if next_block and next_block["type"] in ("list_item", "table_header", "table_row"):
                # Exempt short lead-in lines immediately preceding a cited list or table.
                has_following_citation = False
                for follow in blocks[idx + 1 :]:
                    if follow["type"] in ("list_item", "table_row"):
                        if _SINGLE_EVIDENCE_RE.search(follow["text"]):
                            has_following_citation = True
                            break
                    elif follow["type"] in ("table_header", "table_sep"):
                        continue
                    else:
                        break
                if has_following_citation:
                    continue
            btype = "paragraph"

        if btype == "list_item" and "\n" not in block["text"].strip() and not _SINGLE_EVIDENCE_RE.search(block["text"]):
            item_body = _LIST_ITEM_START_RE.sub("", block["text"].strip(), count=1).strip()
            if _is_lead_in_line(item_body):
                has_following_citation = False
                for follow in blocks[idx + 1 :]:
                    if follow["type"] == "list_item":
                        if _SINGLE_EVIDENCE_RE.search(follow["text"]):
                            has_following_citation = True
                            break
                    else:
                        break
                if has_following_citation:
                    continue

        body = block["text"]
        if btype == "list_item":
            body = _LIST_ITEM_START_RE.sub("", body, count=1)
        ids = _SINGLE_EVIDENCE_RE.findall(body)
        if not _block_has_factual_text(body):
            unsupported |= bool(ids)
            continue

        has_content = True
        if not ids:
            unsupported = True
            break
        ordered_valid_ids.update(dict.fromkeys(ids))

    if not has_content and not unsupported:
        return {
            "ok": False,
            "needsRepair": True,
            "status": "verification_failed",
            "answerMarkdown": "",
            "citations": [],
            "reason": "empty_answer",
        }

    if not ordered_valid_ids or unsupported:
        return {
            "ok": False,
            "needsRepair": True,
            "status": "verification_failed",
            "answerMarkdown": "",
            "citations": [],
            "reason": "missing_citations",
        }

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
                "tag": ev.get("tag") or "",
                "kind": ev.get("kind") or "",
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


def clip_repair_output(raw_output: Any) -> str:
    """Strip reasoning artifacts and clip invalid output to the 12 KB UTF-8 repair budget."""
    cleaned = strip_model_artifacts(raw_output)
    source = cleaned if cleaned else str(raw_output or "")
    return (
        source
        .encode("utf-8", errors="ignore")[:JSON_REPAIR_BYTE_CAP]
        .decode("utf-8", errors="ignore")
    )


def build_repair_prompt(
    raw_output: Any,
    evidence_items: Sequence[Dict[str, Any]],
    *,
    reason: str = "malformed_json",
    include_previous_output: bool = True,
) -> str:
    """Build a bounded single-retry JSON/citation-repair user message (max 12 KB quoted output)."""
    valid_ids = ", ".join(str(item["evidenceId"]) for item in evidence_items if item.get("evidenceId"))
    if reason == "missing_citations":
        header = (
            "Your previous JSON answer omitted valid inline [Ek] citation markers on one or more "
            "factual paragraphs, bullet items, or table rows (or placed a standalone citation bullet like '- [E1]' on its own line)."
        )
        guidance = (
            "Rewrite the answer so EVERY factual paragraph, bullet point, blockquote, and table data row "
            "includes at least one valid inline citation on that SAME line (for example: '- Approved the calibration [E1].'). "
            "Remove any standalone citation-only bullets or lines like '- [E1]'. "
            "(Markdown headings, table header/separator rows, and short colon lead-in lines do not need citations.)"
        )
    else:
        header = "Your previous answer was not valid JSON."
        guidance = "Return ONLY a valid JSON object matching this exact schema (no markdown fences, no commentary):"

    parts = [
        header,
        guidance,
        '{"answerMarkdown": "<concise Markdown answer citing [E1] etc.>", "citedEvidenceIds": ["E1"], "insufficientEvidence": false}',
        f"Valid evidence IDs: {valid_ids or 'none'}",
        "If the evidence does not clearly support an answer, return:",
        '{"answerMarkdown": "", "citedEvidenceIds": [], "insufficientEvidence": true}',
    ]
    if include_previous_output:
        parts.extend(["Previous output:", clip_repair_output(raw_output)])
    return "\n\n".join(parts)
