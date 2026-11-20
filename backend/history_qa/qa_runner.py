"""Local grounded Q&A execution runner for AvaNevis.

Reads one JSON request via ``--stdin-json``, supports a resident loopback
``llama-server`` (strictly ``http://127.0.0.1:<port>`` with Bearer auth and proxy
bypass) as well as single-turn ``llama-cli`` fallback, and always enforces
fail-closed citation verification.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from common.sensitive_text import redact_sensitive_text
from summaries.llama_runtime import resolve_llama_runtime, run_llama_prompt

from .citation_verifier import (
    INSUFFICIENT_EVIDENCE_MESSAGE,
    build_repair_prompt,
    verify_grounded_response,
)
from .retrieval import estimate_token_count, retrieve_evidence

MAX_HISTORY_TOKENS = 4_000
MAX_GENERATION_TOKENS = 1_024
MAX_REPAIR_ATTEMPTS = 1
DEFAULT_HTTP_TIMEOUT_SECONDS = 300


def emit_progress(phase: str, message: str, *, percent: Optional[int] = None) -> None:
    event: Dict[str, Any] = {
        "type": "progress",
        "feature": "history-qa",
        "phase": str(phase),
        "message": redact_sensitive_text(message),
    }
    if percent is not None:
        event["percent"] = max(0, min(100, int(percent)))
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
        return "Summary / Untimed" if item.get("kind") == "summary" else "Untimed"
    total = max(0, int(float(start_sec)))
    hours = total // 3600
    minutes = (total % 3600) // 60
    secs = total % 60
    if hours > 0:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def bound_conversation_history(
    history: Optional[Sequence[Dict[str, Any]]],
    *,
    max_tokens: int = MAX_HISTORY_TOKENS,
) -> List[Dict[str, str]]:
    """Keep the most recent thread turns within the configured token budget."""
    if not history:
        return []

    kept_reversed: List[Dict[str, str]] = []
    used = 0
    for turn in reversed(list(history)):
        if not isinstance(turn, dict):
            continue
        role = str(turn.get("role") or "").strip().lower()
        content = str(turn.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        cost = estimate_token_count(content) + 12
        if used + cost > max_tokens:
            break
        kept_reversed.append({"role": role, "content": content})
        used += cost

    kept = list(reversed(kept_reversed))
    while kept and kept[0]["role"] != "user":
        kept.pop(0)
    return kept


def build_qa_messages(
    *,
    question: str,
    evidence: Sequence[Dict[str, Any]],
    history: Optional[Sequence[Dict[str, Any]]] = None,
) -> List[Dict[str, str]]:
    system_prompt = "\n".join(
        [
            "You are AvaNevis, a private local meeting history assistant running 100% offline.",
            "Answer the user's question ONLY using facts explicitly stated in the numbered evidence passages [E1]..[En] below.",
            "CRITICAL RULES:",
            "1. Cite supporting passages inline using exact square-bracket markers like [E1] or [E2] immediately after each claim.",
            "2. NEVER invent facts, decisions, numbers, quotes, meeting names, speakers, or timestamps not present in the evidence.",
            "3. If the evidence does not clearly answer the question, set insufficientEvidence to true.",
            "4. Respond ONLY with a valid JSON object matching this exact schema (no prose outside JSON, no markdown code fences):",
            '{"answerMarkdown": "<Markdown answer with inline [Ek] citations>", "citedEvidenceIds": ["E1"], "insufficientEvidence": false}',
        ]
    )

    evidence_lines: List[str] = []
    for item in evidence:
        eid = str(item.get("evidenceId") or "")
        title = str(item.get("meetingTitle") or "Untitled Meeting")
        date = str(item.get("meetingDate") or "")[:10]
        ts = _format_evidence_timestamp(item)
        speaker = str(item.get("speaker") or "").strip()
        speaker_label = f" | Speaker: {speaker}" if speaker else ""
        header = f"[{eid}] Meeting: {title} ({date}, {ts}{speaker_label})"
        evidence_lines.append(f"{header}\n{item.get('text') or ''}")

    user_content = "\n\n".join(
        [
            "Evidence passages from local meeting history:",
            "\n\n".join(evidence_lines),
            f"User question:\n{str(question or '').strip()}",
        ]
    )

    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
    messages.extend(bound_conversation_history(history))
    messages.append({"role": "user", "content": user_content})
    return messages


class _RejectRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def format_chatml_prompt(messages: Sequence[Dict[str, str]]) -> str:
    """Format multi-turn messages into ChatML text for single-turn llama-cli fallback."""
    parts: List[str] = []
    for msg in messages:
        role = msg["role"]
        content = str(msg['content']).replace('<|', '<\u200b|')
        parts.append(f"<|im_start|>{role}\n{content}<|im_end|>")
    parts.append("<|im_start|>assistant\n")
    return "\n".join(parts)


def call_llama_server(
    *,
    server_url: str,
    server_token: str,
    messages: Sequence[Dict[str, str]],
    max_tokens: int = MAX_GENERATION_TOKENS,
    temperature: float = 0.1,
    timeout_seconds: int = DEFAULT_HTTP_TIMEOUT_SECONDS,
) -> str:
    """Call resident loopback llama-server bypassing ambient HTTP proxy env vars."""
    base_url, _port = validate_loopback_server_url(server_url)
    token = str(server_token or "").strip()
    if not token:
        raise ValueError("Missing llama-server bearer token.")

    endpoint = f"{base_url}/v1/chat/completions"
    body = json.dumps(
        {
            "messages": list(messages),
            "temperature": float(temperature),
            "max_tokens": int(max_tokens),
            "stream": False,
            "chat_template_kwargs": {"enable_thinking": False},
        }
    ).encode("utf-8")

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
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
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


def execute_qa_request(payload: Dict[str, Any]) -> Dict[str, Any]:
    question = str(payload.get("question") or "").strip()
    if not question:
        raise ValueError("Question must not be empty.")

    evidence = payload.get("evidence")
    searched_meeting_count = int(payload.get("searchedMeetingCount") or 0)
    if evidence is None:
        recordings_dir = payload.get("recordingsDir")
        index_path = payload.get("indexPath")
        if not recordings_dir or not index_path:
            raise ValueError("QA runner requires pre-retrieved evidence or recordingsDir/indexPath.")
        emit_progress("retrieving", "Searching local meeting history…", percent=15)
        retrieval = retrieve_evidence(
            recordings_dir,
            index_path,
            question=question,
            scope=payload.get("scope"),
            sync=bool(payload.get("sync", True)),
        )
        evidence = retrieval["evidence"]
        searched_meeting_count = int(retrieval.get("searchedMeetingCount") or 0)

    if not evidence:
        return {
            "status": "insufficient_evidence",
            "answerMarkdown": INSUFFICIENT_EVIDENCE_MESSAGE,
            "citations": [],
            "searchedMeetingCount": searched_meeting_count,
            "evidenceCount": 0,
        }

    mode = str(payload.get("executionMode") or "server").strip().lower()
    max_tokens = max(128, min(2048, int(payload.get("maxTokens") or MAX_GENERATION_TOKENS)))
    temperature = float(payload.get("temperature") if payload.get("temperature") is not None else 0.1)
    messages = build_qa_messages(
        question=question,
        evidence=evidence,
        history=payload.get("history"),
    )

    def complete(turn_messages: Sequence[Dict[str, str]]) -> str:
        if mode == "server":
            return call_llama_server(
                server_url=str(payload.get("serverUrl") or ""),
                server_token=str(payload.get("serverToken") or ""),
                messages=turn_messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )
        runtime_dir = str(payload.get("runtimeDir") or "")
        model_path = str(payload.get("modelPath") or "")
        runtime = resolve_llama_runtime(runtime_dir=runtime_dir, model_path=model_path)
        with tempfile.TemporaryDirectory(prefix="avanevis-qa-cli-") as work_dir:
            prompt_file = Path(work_dir) / "qa.prompt.txt"
            prompt_file.write_text(format_chatml_prompt(turn_messages), encoding="utf-8")
            return run_llama_prompt(
                runtime,
                prompt_path=str(prompt_file),
                max_tokens=max_tokens,
                timeout_seconds=DEFAULT_HTTP_TIMEOUT_SECONDS,
            )

    emit_progress("generating", "Synthesizing grounded answer locally…", percent=55)
    raw_output = complete(messages)

    emit_progress("verifying", "Verifying citations against local evidence…", percent=88)
    verified = verify_grounded_response(raw_output, evidence)

    if verified.get("needsRepair") and MAX_REPAIR_ATTEMPTS > 0:
        emit_progress("json-repair", "Formatting grounded answer…", percent=92)
        repair_messages = [
            *messages,
            {"role": "assistant", "content": str(raw_output or "")[:2000]},
            {"role": "user", "content": build_repair_prompt(raw_output, evidence)},
        ]
        repaired_output = complete(repair_messages)
        verified = verify_grounded_response(repaired_output, evidence)

    if not verified.get("ok"):
        verified = {
            "status": "insufficient_evidence",
            "answerMarkdown": INSUFFICIENT_EVIDENCE_MESSAGE,
            "citations": [],
        }

    emit_progress("completed", "Done.", percent=100)
    return {
        "status": verified["status"],
        "answerMarkdown": verified["answerMarkdown"],
        "citations": verified["citations"],
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
