"""Local grounded Q&A execution runner for AvaNevis.

Reads one JSON request via ``--stdin-json``, supports a resident loopback
``llama-server`` (strictly ``http://127.0.0.1:<port>`` with Bearer auth and proxy
bypass) as well as single-turn ``llama-cli`` fallback, and always enforces
fail-closed citation verification.
"""

from __future__ import annotations

import argparse
import json
import re
import signal
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from common.sensitive_text import redact_sensitive_text
from meetings.normalization import recording_tag_display_label
from summaries.llama_runtime import apply_inference_descriptor, resolve_llama_runtime, run_llama_prompt

from .citation_verifier import (
    INSUFFICIENT_EVIDENCE_MESSAGE,
    NO_MATCHING_EXCERPTS_MESSAGE,
    VERIFICATION_FAILED_MESSAGE,
    build_repair_prompt,
    clip_repair_output,
    strip_model_artifacts,
    strip_reasoning_blocks,
    verify_general_response,
    verify_grounded_response,
)
from .retrieval import estimate_token_count, retrieve_evidence

MAX_HISTORY_TOKENS = 4_000
MAX_GENERATION_TOKENS = 2_048
DEFAULT_CONTEXT_TOKENS = 32_768
CONTEXT_SAFETY_TOKENS = 1_024
MIN_GENERATION_TOKENS = 128
MAX_REPAIR_ATTEMPTS = 1
DEFAULT_HTTP_TIMEOUT_SECONDS = 300
MAX_INSPECTED_SOURCES = 6
MAX_DRAFT_PREVIEW_CHARS = 16_000

_ANSWER_MARKDOWN_KEY_RE = re.compile(r'"answerMarkdown"\s*:\s*"')
_HEX_4_RE = re.compile(r"^[0-9a-fA-F]{4}$")
_STREAM_CITATION_RE = re.compile(r"\[E\d+(?:\s*[,;/]\s*E\d+)*\]")
_STREAM_TRAILING_CITATION_RE = re.compile(r"\s*\[E\d*(?:\s*[,;/]\s*(?:E\d*)?)*$")


def emit_progress(
    phase: str,
    message: str,
    *,
    percent: Optional[int] = None,
    draft_markdown: Optional[str] = None,
) -> None:
    event: Dict[str, Any] = {
        "type": "progress",
        "feature": "history-qa",
        "phase": str(phase),
        "message": redact_sensitive_text(message),
    }
    if percent is not None:
        event["percent"] = max(0, min(100, int(percent)))
    if isinstance(draft_markdown, str) and draft_markdown:
        event["draftMarkdown"] = redact_sensitive_text(
            draft_markdown, max_length=MAX_DRAFT_PREVIEW_CHARS, preserve_whitespace=True
        )
    print(json.dumps(event, ensure_ascii=False), file=sys.stderr, flush=True)


def validate_loopback_server_url(server_url: str) -> Tuple[str, int]:
    """Ensure resident llama-server URL is strictly plain HTTP on 127.0.0.1."""
    raw = str(server_url or "").strip()
    parsed = urllib.parse.urlparse(raw)
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Refusing non-loopback llama-server URL.")

    try:
        port = int(parsed.port or 0)
    except ValueError as exc:
        raise ValueError("Invalid llama-server port.") from exc
    if port < 1 or port > 65535:
        raise ValueError("Invalid llama-server port.")

    return f"http://127.0.0.1:{port}", port


def _format_evidence_timestamp(item: Dict[str, Any]) -> str:
    start_sec = item.get("startSec")
    if start_sec is None:
        return "Summary" if item.get("kind") == "summary" else "Untimed"
    total = max(0, int(float(start_sec)))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def extract_partial_answer_markdown(raw_text: Any) -> Optional[str]:
    """Safely extract progressive `answerMarkdown` text from partial JSON output."""
    cleaned = strip_model_artifacts(raw_text)
    if not cleaned:
        return None
    match = _ANSWER_MARKDOWN_KEY_RE.search(cleaned)
    if not match:
        return None

    idx = match.end()
    length = len(cleaned)
    out: List[str] = []
    escape_map = {
        '"': '"',
        "\\": "\\",
        "/": "/",
        "b": "\b",
        "f": "\f",
        "n": "\n",
        "r": "\r",
        "t": "\t",
    }

    while idx < length:
        ch = cleaned[idx]
        if ch == '"':
            break
        if ch != "\\":
            out.append(ch)
            idx += 1
            continue

        if idx + 1 >= length:
            break
        nxt = cleaned[idx + 1]
        if nxt in escape_map:
            out.append(escape_map[nxt])
            idx += 2
            continue
        if nxt == "u":
            if idx + 6 > length:
                break
            hex_digits = cleaned[idx + 2 : idx + 6]
            if not _HEX_4_RE.match(hex_digits):
                break
            out.append(chr(int(hex_digits, 16)))
            idx += 6
            continue
        out.append(nxt)
        idx += 2

    text = "".join(out)
    text = _STREAM_CITATION_RE.sub("", text)
    text = _STREAM_TRAILING_CITATION_RE.sub("", text)
    text = re.sub(r"(?<=\S)[ \t]+([.,;:!?])", r"\1", text)
    text = re.sub(r"(?<=\S)[ \t]{2,}", " ", text)
    text = text.rstrip(" \t")
    return text if text.strip() else None


def extract_partial_general_markdown(raw_text: Any) -> Optional[str]:
    """Safely extract progressive plain Markdown from streamed general-chat output."""
    cleaned = strip_reasoning_blocks(raw_text)
    if not cleaned:
        return None
    cleaned = _STREAM_CITATION_RE.sub("", cleaned)
    cleaned = _STREAM_TRAILING_CITATION_RE.sub("", cleaned)
    cleaned = re.sub(r"(?<=\S)[ \t]+([.,;:!?])", r"\1", cleaned)
    cleaned = cleaned.rstrip(" \t")
    return cleaned if cleaned.strip() else None


def bound_conversation_history(
    history: Optional[Sequence[Dict[str, Any]]],
    *,
    max_tokens: int = MAX_HISTORY_TOKENS,
) -> List[Dict[str, str]]:
    """Keep recent turn pairs intact and digest older turns within the same budget."""
    pairs: List[List[Dict[str, Any]]] = []
    for turn in history or ():
        if not isinstance(turn, dict):
            continue
        role = str(turn.get("role") or "").strip().lower()
        content = str(turn.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        if role == "user":
            pairs.append([])
        if pairs:
            pairs[-1].append({**turn, "role": role, "content": content})

    kept: List[List[Dict[str, str]]] = []
    remaining = max_tokens
    for index, pair in enumerate(reversed(pairs)):
        cost = sum(estimate_token_count(turn["content"]) + 12 for turn in pair)
        reserve = min(400, max_tokens // 10) if index >= 2 and index < len(pairs) - 1 else 0
        if len(kept) == 4 or cost + reserve > remaining:
            break
        kept.append([{"role": turn["role"], "content": turn["content"]} for turn in pair])
        remaining -= cost

    def compact(text: str, limit: int) -> str:
        cleaned = " ".join(_STREAM_CITATION_RE.sub("", text).split())
        encoded = cleaned.encode("utf-8", errors="replace")
        if len(encoded) <= limit:
            return cleaned
        return encoded[:limit].decode("utf-8", errors="ignore") + "…"

    header = "Earlier conversation for resolving follow-ups:"
    remaining -= estimate_token_count(header) + 12
    summaries = []
    for pair in reversed(pairs[:len(pairs) - len(kept)]):
        if remaining <= 0:
            break
        question = compact(pair[0]["content"], 100)
        topic = compact(pair[1]["content"], 100) if len(pair) > 1 else ""
        titles = dict.fromkeys(
            cite["meetingTitle"]
            for turn in pair[1:]
            for cite in (turn.get("citations") or [])
            if isinstance(cite, dict) and isinstance(cite.get("meetingTitle"), str) and cite["meetingTitle"]
        )
        sources = compact(", ".join(titles), 100)
        parts = [question]
        if topic:
            parts.append(f"Topics: {topic}")
        if sources:
            parts.append(f"Recordings: {sources}")
        for details in (parts, [question]):
            digest = f"[Prior Q → {' | '.join(details)}]"
            cost = estimate_token_count(digest + "\n")
            if cost <= remaining:
                summaries.append(digest)
                remaining -= cost
                break

    turns = [{"role": "context", "content": "\n".join([header, *reversed(summaries)])}] if summaries else []
    turns.extend(turn for pair in reversed(kept) for turn in pair)
    return turns


def _resolve_chat_mode(payload: Dict[str, Any]) -> str:
    raw_mode = str(payload.get("chatMode") or "").strip().lower()
    if raw_mode == "general":
        return "general"
    if raw_mode == "grounded":
        return "grounded"
    scope = payload.get("scope")
    if isinstance(scope, dict) and str(scope.get("type") or "").strip().lower() == "none":
        return "general"
    return "grounded"


def build_general_chat_messages(
    *,
    question: str,
    history: Optional[Sequence[Dict[str, Any]]] = None,
    history_max_tokens: int = MAX_HISTORY_TOKENS,
) -> List[Dict[str, str]]:
    system_prompt = "\n".join(
        [
            "You are AvaNevis, a private local AI assistant running 100% offline.",
            "No recordings are attached to this conversation. Answer helpfully using general knowledge.",
            "Do not invent recording quotes, timestamps, or [E1] citations.",
            "Respond directly in clear, concise Markdown (do not wrap your answer in JSON).",
        ]
    )

    turns = bound_conversation_history(history, max_tokens=history_max_tokens)
    digest = next((turn["content"] for turn in turns if turn["role"] == "context"), "")
    user_content = "\n\n".join(
        [
            *([digest] if digest else []),
            str(question or "").strip(),
        ]
    )

    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
    messages.extend(turn for turn in turns if turn["role"] != "context")
    messages.append({"role": "user", "content": user_content})
    return messages


def build_qa_messages(
    *,
    question: str,
    evidence: Sequence[Dict[str, Any]],
    history: Optional[Sequence[Dict[str, Any]]] = None,
    history_max_tokens: int = MAX_HISTORY_TOKENS,
) -> List[Dict[str, str]]:
    system_prompt = "\n".join(
        [
            "You are AvaNevis, a private local audio transcript assistant running 100% offline.",
            "Ground all facts about recordings ONLY in numbered passages [E1]..[En] below.",
            "RULES:",
            "1. Synthesize, explain concepts mentioned, or draft follow-ups (emails, checklists, summaries) from [Ek] passages; cite transcript facts inline with [Ek] and briefly note any uncovered parts.",
            "2. Use concise Markdown headings, bullets, or GFM tables when helpful.",
            "3. Put inline [E1] or [E1] [E2] citations on the SAME line at the end of EVERY factual paragraph, bullet, blockquote, and table row (e.g. '- Approved calibration [E1].'). NEVER put [E1] on a separate line or standalone bullet like '- [E1]'. [E1]..[En] applies only to the current turn's `Evidence passages` list. (Headings, table headers/separators, and short colon lead-ins need no citations.)",
            "4. NEVER invent facts, numbers, quotes, titles, speakers, or timestamps.",
            "Cite the specific timestamped [Ek] supporting each claim; prefer timestamped transcript passages over summaries. The passage header's Speaker label identifies who spoke (and overrides differing summary attribution). Use prior turns to resolve follow-ups, citing this turn's evidence.",
            "5. Set insufficientEvidence to true ONLY if no passage addresses the question; briefly explain in answerMarkdown what was covered versus missing.",
            "6. Reply ONLY with valid JSON (no fences or prose):",
            '{"answerMarkdown": "<Markdown with inline [Ek] citations>", "citedEvidenceIds": ["E1"], "insufficientEvidence": false}',
        ]
    )

    evidence_lines: List[str] = []
    for item in evidence:
        eid = str(item.get("evidenceId") or "")
        title = str(item.get("meetingTitle") or "Untitled recording")
        raw_tag = str(item.get("tag") or "").strip()
        tag_display = recording_tag_display_label(raw_tag) or raw_tag
        tag_label = f" [Tag: {tag_display}]" if tag_display else ""
        date = str(item.get("meetingDate") or "")[:10]
        ts = _format_evidence_timestamp(item)
        speaker = str(item.get("speaker") or "").strip()
        meta_parts = [part for part in (date, f"Speaker: {speaker}" if speaker else "") if part]
        metadata = f" ({', '.join(meta_parts)})" if meta_parts else ""
        header = f"[{eid}] {ts} — Recording: {title}{tag_label}{metadata}"
        evidence_lines.append(f"{header}\n{item.get('text') or ''}")

    turns = bound_conversation_history(history, max_tokens=history_max_tokens)
    digest = next((turn["content"] for turn in turns if turn["role"] == "context"), "")
    user_content = "\n\n".join(
        [
            *([digest] if digest else []),
            "Evidence passages from local recording history:",
            "\n\n".join(evidence_lines),
            f"User question:\n{str(question or '').strip()}",
        ]
    )

    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
    messages.extend(turn for turn in turns if turn["role"] != "context")
    messages.append({"role": "user", "content": user_content})
    return messages


class QAPromptBudget:
    """Share the context limit between retrieval, history and both generation calls."""

    def __init__(self, payload: Dict[str, Any], question: str):
        descriptor = payload.get("inferenceDescriptor")
        descriptor_context = descriptor.get("contextTokens") if isinstance(descriptor, dict) else None
        context_tokens = int(
            payload.get("modelContextTokens") or payload.get("contextTokens")
            or descriptor_context or DEFAULT_CONTEXT_TOKENS
        )
        self.context_limit = max(0, context_tokens - CONTEXT_SAFETY_TOKENS)
        self.generation_reserve = max(
            MIN_GENERATION_TOKENS, min(MAX_GENERATION_TOKENS, int(payload.get("maxTokens") or MAX_GENERATION_TOKENS))
        )
        self.evidence_limit = payload.get("maxEvidenceTokens")
        self.question = question
        self.history = payload.get("history")
        self.chat_mode = _resolve_chat_mode(payload)
        if self.chat_mode == "general":
            fixed_tokens = self.message_tokens(build_general_chat_messages(question=question))
            available = self.context_limit - fixed_tokens
            self.history_limit = max(0, min(MAX_HISTORY_TOKENS, available - self._reserve_for_evidence(available)))
        else:
            fixed_tokens = self.message_tokens(build_qa_messages(question=question, evidence=[]))
            available = self.context_limit - fixed_tokens
            self.history_limit = max(0, min(MAX_HISTORY_TOKENS, (available - self._reserve_for_evidence(available)) // 4))

    @staticmethod
    def message_tokens(messages: Sequence[Dict[str, str]]) -> int:
        return sum(estimate_token_count(message["content"]) + 12 for message in messages)

    def general_messages(self) -> List[Dict[str, str]]:
        return build_general_chat_messages(
            question=self.question,
            history=self.history,
            history_max_tokens=self.history_limit,
        )

    def messages(self, evidence: Sequence[Dict[str, Any]]) -> List[Dict[str, str]]:
        return build_qa_messages(
            question=self.question, evidence=evidence, history=self.history,
            history_max_tokens=self.history_limit,
        )

    def generation_tokens(self, messages: Sequence[Dict[str, str]]) -> int:
        return max(0, min(self.generation_reserve, self.context_limit - self.message_tokens(messages)))

    def _reserve_for_evidence(self, available: int) -> int:
        return min(self.generation_reserve, max(MIN_GENERATION_TOKENS, available // 2))

    def evidence_tokens(self) -> int:
        # Allow small-context models to retain some evidence by reducing their generation reserve.
        available = self.context_limit - self.message_tokens(self.messages([]))
        reserve = self._reserve_for_evidence(available)
        available -= reserve
        if self.evidence_limit is not None:
            available = min(available, int(self.evidence_limit))
        return max(0, available)

    def fit_evidence(
        self, evidence: Sequence[Dict[str, Any]],
    ) -> Tuple[Sequence[Dict[str, Any]], List[Dict[str, str]]]:
        base_available = self.context_limit - self.message_tokens(self.messages([]))
        target_reserve = self._reserve_for_evidence(base_available)
        messages = self.messages(evidence)
        if self.generation_tokens(messages) >= target_reserve:
            return evidence, messages

        def max_fitting(min_gen: int) -> int:
            low, high = 0, len(evidence)
            while low < high:
                middle = (low + high + 1) // 2
                if self.generation_tokens(self.messages(evidence[:middle])) >= min_gen:
                    low = middle
                else:
                    high = middle - 1
            return low

        fitted_count = max_fitting(target_reserve)
        if fitted_count == 0 and target_reserve > MIN_GENERATION_TOKENS:
            fitted_count = max_fitting(MIN_GENERATION_TOKENS)
        return evidence[:fitted_count], self.messages(evidence[:fitted_count])


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def format_chatml_prompt(messages: Sequence[Dict[str, str]]) -> str:
    """Format multi-turn messages into ChatML text for single-turn llama-cli fallback."""
    parts: List[str] = []
    for msg in messages:
        role = msg["role"]
        content = str(msg["content"]).replace("<|", "<\u200b|")
        parts.append(f"<|im_start|>{role}\n{content}<|im_end|>")
    parts.append("<|im_start|>assistant\n")
    return "\n".join(parts)


def format_gemma_prompt(messages: Sequence[Dict[str, str]]) -> str:
    """Pass plain conversation text to llama-cli's native GGUF chat template."""
    parts = []
    for msg in messages:
        role = str(msg.get("role") or "user")
        content = str(msg.get("content") or "")
        # Prevent supplied content from impersonating template control tokens.
        content = content.replace("<start_of_turn>", "< start_of_turn>").replace("<end_of_turn>", "< end_of_turn>")
        parts.append(f"{role.capitalize()}: {content}")
    return "\n\n".join(parts)


def call_llama_server(
    *,
    server_url: str,
    server_token: str,
    messages: Sequence[Dict[str, str]],
    max_tokens: int = MAX_GENERATION_TOKENS,
    temperature: float = 0.1,
    timeout_seconds: int = DEFAULT_HTTP_TIMEOUT_SECONDS,
    stream: bool = False,
    json_mode: bool = True,
    on_draft_update: Optional[Callable[[str], None]] = None,
) -> str:
    """Call resident loopback llama-server bypassing ambient HTTP proxy env vars."""
    base_url, _port = validate_loopback_server_url(server_url)
    token = str(server_token or "").strip()
    if not token:
        raise ValueError("Missing llama-server bearer token.")

    endpoint = f"{base_url}/v1/chat/completions"
    request_payload: Dict[str, Any] = {
        "messages": list(messages),
        "temperature": float(temperature),
        "max_tokens": int(max_tokens),
        "stream": bool(stream),
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if json_mode:
        request_payload["response_format"] = {"type": "json_object"}
    body = json.dumps(request_payload).encode("utf-8")

    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _RejectRedirects())
    preview_extractor = extract_partial_answer_markdown if json_mode else extract_partial_general_markdown
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            content_type = str(response.headers.get("Content-Type") or "").lower()
            if stream and "text/event-stream" in content_type:
                chunks: List[str] = []
                last_emitted_preview = ""
                last_emitted_len = 0
                last_emit_time = 0.0

                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line or line.startswith(":"):
                        continue
                    if not line.startswith("data:"):
                        continue
                    data_str = line[5:].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        event = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    choices = event.get("choices") or []
                    if not choices or not isinstance(choices[0], dict):
                        continue
                    delta = choices[0].get("delta")
                    if isinstance(delta, dict):
                        piece = str(delta.get("content") or "")
                    else:
                        msg = choices[0].get("message")
                        piece = str((msg or {}).get("content") or "") if isinstance(msg, dict) else ""
                    if not piece:
                        continue
                    chunks.append(piece)

                    if on_draft_update is not None:
                        preview = preview_extractor("".join(chunks))
                        now = time.monotonic()
                        if (
                            preview
                            and preview != last_emitted_preview
                            and (len(preview) - last_emitted_len >= 24 or (now - last_emit_time) >= 0.08)
                        ):
                            last_emitted_preview = preview
                            last_emitted_len = len(preview)
                            last_emit_time = now
                            on_draft_update(preview)

                full_content = "".join(chunks)
                if on_draft_update is not None:
                    final_preview = preview_extractor(full_content)
                    if final_preview and final_preview != last_emitted_preview:
                        on_draft_update(final_preview)
                return full_content

            raw_body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Local Q&A server returned HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach local Q&A server: {exc.reason}") from exc

    parsed = json.loads(raw_body)
    choices = parsed.get("choices") or []
    if not choices or not isinstance(choices[0], dict):
        raise RuntimeError("Local Q&A server returned no completion choices.")
    message = choices[0].get("message") or {}
    return str(message.get("content") or "")


def _build_inspected_sources(evidence: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    sources: List[Dict[str, Any]] = []
    for item in evidence[:MAX_INSPECTED_SOURCES]:
        if not isinstance(item, dict) or not item.get("evidenceId") or not item.get("meetingId"):
            continue
        sources.append(
            {
                "evidenceId": str(item["evidenceId"]),
                "meetingId": str(item["meetingId"]),
                "meetingTitle": str(item.get("meetingTitle") or "Untitled recording"),
                "meetingDate": str(item.get("meetingDate") or ""),
                "startSec": item.get("startSec"),
                "endSec": item.get("endSec"),
                "speaker": str(item.get("speaker") or ""),
                "tag": str(item.get("tag") or ""),
                "kind": str(item.get("kind") or ""),
                "excerpt": str(item.get("excerpt") or ""),
                "sourceTranscriptHash": str(item.get("sourceTranscriptHash") or ""),
            }
        )
    return sources


def execute_qa_request(payload: Dict[str, Any]) -> Dict[str, Any]:
    question = str(payload.get("question") or "").strip()
    if not question:
        raise ValueError("Question must not be empty.")

    chat_mode = _resolve_chat_mode(payload)
    budget = QAPromptBudget(payload, question)
    mode = str(payload.get("executionMode") or "server").strip().lower()
    use_stream = bool(payload.get("stream", False)) and mode == "server"
    default_temp = 0.3 if chat_mode == "general" else 0.1
    temperature = float(payload.get("temperature") if payload.get("temperature") is not None else default_temp)

    def complete(
        turn_messages: Sequence[Dict[str, str]],
        *,
        allow_stream: bool = False,
        json_mode: bool = True,
    ) -> str:
        max_tokens = budget.generation_tokens(turn_messages)
        if mode == "server":
            on_draft = (
                (lambda preview: emit_progress(
                    "streaming",
                    "Writing answer locally…",
                    percent=65,
                    draft_markdown=preview,
                ))
                if allow_stream
                else None
            )
            server_kwargs: Dict[str, Any] = {
                "server_url": str(payload.get("serverUrl") or ""),
                "server_token": str(payload.get("serverToken") or ""),
                "messages": turn_messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "stream": allow_stream,
                "on_draft_update": on_draft,
            }
            if not json_mode:
                server_kwargs["json_mode"] = False
            return call_llama_server(**server_kwargs)
        runtime_dir = str(payload.get("runtimeDir") or "")
        model_path = str(payload.get("modelPath") or "")
        runtime = apply_inference_descriptor(resolve_llama_runtime(runtime_dir=runtime_dir, model_path=model_path), payload.get("inferenceDescriptor"))
        with tempfile.TemporaryDirectory(prefix="avanevis-qa-cli-") as work_dir:
            prompt_file = Path(work_dir) / "qa.prompt.txt"
            formatter = format_gemma_prompt if runtime["inference"].get("promptFormat") == "gemma" else format_chatml_prompt
            prompt_file.write_text(formatter(turn_messages), encoding="utf-8")
            return run_llama_prompt(
                runtime,
                prompt_path=str(prompt_file),
                max_tokens=max_tokens,
                timeout_seconds=DEFAULT_HTTP_TIMEOUT_SECONDS,
            )

    if chat_mode == "general":
        messages = budget.general_messages()
        emit_progress("generating", "Writing answer locally…", percent=55)
        raw_output = complete(messages, allow_stream=use_stream, json_mode=False)
        verified = verify_general_response(raw_output)
        emit_progress("completed", "Done.", percent=100)
        if not verified.get("ok"):
            return {
                "status": "verification_failed",
                "chatMode": "general",
                "failureReason": str(verified.get("reason") or "empty_answer"),
                "answerMarkdown": "",
                "citations": [],
                "inspectedSources": [],
                "detectedDateFilter": "",
                "retrievalMode": "",
                "searchedMeetingCount": 0,
                "evidenceCount": 0,
            }
        return {
            "status": "answered",
            "chatMode": "general",
            "answerMarkdown": redact_sensitive_text(verified["answerMarkdown"], max_length=0, preserve_whitespace=True),
            "citations": [],
            "detectedDateFilter": "",
            "retrievalMode": "",
            "searchedMeetingCount": 0,
            "evidenceCount": 0,
        }

    evidence = payload.get("evidence")
    searched_meeting_count = int(payload.get("searchedMeetingCount") or 0)
    detected_date_filter = str(payload.get("detectedDateFilter") or "")
    retrieval_mode = str(payload.get("retrievalMode") or "")
    if evidence is None:
        recordings_dir = payload.get("recordingsDir")
        index_path = payload.get("indexPath")
        if not recordings_dir or not index_path:
            raise ValueError("QA runner requires pre-retrieved evidence or recordingsDir/indexPath.")
        emit_progress("retrieving", "Searching your transcripts…", percent=15)
        retrieval = retrieve_evidence(
            recordings_dir,
            index_path,
            question=question,
            scope=payload.get("scope"),
            thread_context=payload.get("threadContext"),
            prior_turn_context=payload.get("priorTurnContext"),
            max_evidence_blocks=payload.get("maxEvidenceBlocks"),
            max_evidence_tokens=budget.evidence_tokens(),
            sync=bool(payload.get("sync", True)),
        )
        evidence = retrieval["evidence"]
        searched_meeting_count = int(retrieval.get("searchedMeetingCount") or 0)
        detected_date_filter = str(retrieval.get("detectedDateFilter") or "")
        retrieval_mode = str(retrieval.get("retrievalMode") or "")

    if evidence:
        fitted_evidence, messages = budget.fit_evidence(evidence)
        if retrieval_mode == "direct_full" and len(fitted_evidence) < len(evidence):
            retrieval_mode = "overview"
        evidence = fitted_evidence
    if not evidence:
        return {
            "status": "no_matching_excerpts",
            "chatMode": "grounded",
            "failureReason": "no_matching_excerpts",
            "answerMarkdown": NO_MATCHING_EXCERPTS_MESSAGE,
            "citations": [],
            "inspectedSources": [],
            "detectedDateFilter": detected_date_filter,
            "retrievalMode": retrieval_mode,
            "searchedMeetingCount": searched_meeting_count,
            "evidenceCount": 0,
        }

    emit_progress("generating", "Writing answer locally…", percent=55)
    raw_output = complete(messages, allow_stream=use_stream)

    emit_progress("verifying", "Checking citations against transcripts…", percent=88)
    verified = verify_grounded_response(raw_output, evidence)

    if verified.get("needsRepair") and MAX_REPAIR_ATTEMPTS > 0:
        repair_reason = str(verified.get("reason") or "malformed_json")
        clipped_prev = clip_repair_output(raw_output) or "(empty response)"
        repair_messages = [
            *messages,
            {"role": "assistant", "content": clipped_prev},
            {
                "role": "user",
                "content": build_repair_prompt(
                    raw_output,
                    evidence,
                    reason=repair_reason,
                    include_previous_output=False,
                ),
            },
        ]
        if len(messages) > 2 and budget.generation_tokens(repair_messages) < MIN_GENERATION_TOKENS:
            repair_messages = [messages[0], *repair_messages[-3:]]
        if budget.generation_tokens(repair_messages) >= MIN_GENERATION_TOKENS:
            if repair_reason == "missing_citations":
                emit_progress("citation-repair", "Adding inline citations…", percent=92)
            else:
                emit_progress("json-repair", "Formatting answer…", percent=92)
            repaired_output = complete(repair_messages, allow_stream=False)
            verified = verify_grounded_response(repaired_output, evidence)

    emit_progress("completed", "Done.", percent=100)

    if not verified.get("ok"):
        return {
            "status": "verification_failed",
            "chatMode": "grounded",
            "failureReason": str(verified.get("reason") or "verification_failed"),
            "answerMarkdown": VERIFICATION_FAILED_MESSAGE,
            "citations": [],
            "inspectedSources": _build_inspected_sources(evidence),
            "detectedDateFilter": detected_date_filter,
            "retrievalMode": retrieval_mode,
            "searchedMeetingCount": searched_meeting_count,
            "evidenceCount": len(evidence),
        }

    if verified["status"] == "insufficient_evidence":
        return {
            "status": "insufficient_evidence",
            "chatMode": "grounded",
            "failureReason": "insufficient_evidence",
            "answerMarkdown": redact_sensitive_text(verified["answerMarkdown"], max_length=0, preserve_whitespace=True),
            "citations": [],
            "inspectedSources": _build_inspected_sources(evidence),
            "detectedDateFilter": detected_date_filter,
            "retrievalMode": retrieval_mode,
            "searchedMeetingCount": searched_meeting_count,
            "evidenceCount": len(evidence),
        }

    return {
        "status": verified["status"],
        "chatMode": "grounded",
        "answerMarkdown": redact_sensitive_text(verified["answerMarkdown"], max_length=0, preserve_whitespace=True),
        "citations": verified["citations"],
        "detectedDateFilter": detected_date_filter,
        "retrievalMode": retrieval_mode,
        "searchedMeetingCount": searched_meeting_count,
        "evidenceCount": len(evidence),
    }


def main() -> None:
    def handle_sigterm(_signum, _frame):
        sys.exit(143)

    signal.signal(signal.SIGTERM, handle_sigterm)

    parser = argparse.ArgumentParser(description="AvaNevis local grounded History Q&A runner")
    parser.add_argument("--stdin-json", action="store_true", required=True)
    parser.parse_args()

    payload = json.loads(sys.stdin.read() or "{}")
    result = execute_qa_request(payload)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
