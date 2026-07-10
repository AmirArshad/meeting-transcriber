"""User-triggered local summary generation runner."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

from common.sensitive_text import redact_sensitive_text

from .llama_runtime import build_summary_progress_event, resolve_llama_runtime, run_llama_prompt, smoke_test_llama_runtime
from .sidecar_io import save_summary_outputs, sidecar_paths
from .summary_pipeline import (
    SummaryValidationError,
    assert_summary_grounded_in_transcript,
    build_chunk_summary_prompt,
    build_final_merge_prompt,
    chunk_transcript,
    get_summary_profile,
    parse_markdown_transcript,
    repair_summary_json,
    validate_summary_json,
)


DEFAULT_PROFILE = "balanced"
MAX_SUMMARY_REPAIR_ATTEMPTS = 1
CHUNK_PROMPT_TOKEN_RESERVE = 6000


def _safe_message(message: Any) -> str:
    return redact_sensitive_text(message)


def emit_progress(meeting_id: str, phase: str, message: str, *, chunk_index: Optional[int] = None, chunk_total: Optional[int] = None) -> None:
    event = {
        "type": "progress",
        "feature": "summary",
        **build_summary_progress_event(
            meeting_id=meeting_id,
            phase=phase,
            message=_safe_message(message),
            chunk_index=chunk_index,
            chunk_total=chunk_total,
        ),
    }
    print(json.dumps(event), file=sys.stderr, flush=True)


def hash_transcript_text(transcript_text: str) -> str:
    return f"sha256:{hashlib.sha256(str(transcript_text or '').encode('utf-8')).hexdigest()}"


def read_transcript_text(transcript_path: str) -> str:
    return Path(transcript_path).read_text(encoding="utf-8", errors="replace")


def load_summary_segments(transcript_path: str, speakers_json_path: Optional[str] = None) -> List[Dict[str, Any]]:
    if speakers_json_path and Path(speakers_json_path).exists():
        with open(speakers_json_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        segments = payload.get("segments") if isinstance(payload, dict) else None
        if isinstance(segments, list) and segments:
            return [dict(segment) for segment in segments if isinstance(segment, dict)]

    transcript_text = read_transcript_text(transcript_path)
    segments = parse_markdown_transcript(transcript_text)
    if segments:
        return segments
    cleaned = transcript_text.strip()
    return [{"start": 0.0, "end": 0.0, "speaker": "Unknown", "text": cleaned}] if cleaned else []


def write_prompt(path: Path, prompt: str) -> None:
    path.write_text(prompt, encoding="utf-8")


def build_json_repair_prompt(raw_output: str) -> str:
    return "\n\n".join([
        "You are AvaNevis, a local-only meeting summarizer. The previous response was not valid summary JSON.",
        "Return only a corrected JSON object using the required summary schema. Do not include markdown or commentary.",
        "Invalid model output:",
        str(raw_output or "")[:12000],
    ])


def run_summary_prompt_with_repair(
    *,
    meeting_id: str,
    runtime: Dict[str, Any],
    prompt_path: Path,
    max_tokens: int,
    run_prompt: Callable[[Dict[str, Any], str, int], str],
    work_path: Path,
    repair_name: str,
    chunk_text: str = "",
) -> Dict[str, Any]:
    raw_output = run_prompt(runtime, str(prompt_path), max_tokens)
    last_error: Optional[SummaryValidationError] = None

    for attempt in range(0, MAX_SUMMARY_REPAIR_ATTEMPTS + 1):
        try:
            summary = repair_summary_json(raw_output)
            return assert_summary_grounded_in_transcript(summary, chunk_text)
        except SummaryValidationError as exc:
            last_error = exc
            if attempt >= MAX_SUMMARY_REPAIR_ATTEMPTS:
                break

            denied_transcript = "denied transcript content" in str(exc)
            emit_progress(
                meeting_id,
                "json-repair",
                "Regenerating summary after ungrounded model output."
                if denied_transcript
                else "Repairing malformed summary JSON.",
            )
            if denied_transcript:
                # Re-run the original grounded prompt; repairing the denial JSON
                # just teaches the model to polish an empty summary.
                raw_output = run_prompt(runtime, str(prompt_path), max_tokens)
                continue

            repair_prompt_path = work_path / f"{repair_name}-repair-{attempt + 1}.prompt.txt"
            write_prompt(repair_prompt_path, build_json_repair_prompt(raw_output))
            raw_output = run_prompt(runtime, str(repair_prompt_path), max_tokens)

    raise last_error or SummaryValidationError("summary JSON repair failed")


def resolve_chunk_token_budget(runtime: Dict[str, Any], profile_config: Dict[str, Any]) -> int:
    profile_budget = int(profile_config["chunk_tokens"])
    context_tokens = int(runtime.get("contextTokens") or 0)
    max_output_tokens = int(profile_config["max_output_tokens"])
    if context_tokens <= 0:
        return profile_budget

    context_budget = context_tokens - max_output_tokens - CHUNK_PROMPT_TOKEN_RESERVE
    if context_budget <= 0:
        return profile_budget
    return max(profile_budget, context_budget)


def generate_summary_from_segments(
    *,
    meeting_id: str,
    segments: Iterable[Dict[str, Any]],
    runtime: Dict[str, Any],
    profile: str = DEFAULT_PROFILE,
    run_prompt: Callable[[Dict[str, Any], str, int], str],
) -> Dict[str, Any]:
    profile_config = get_summary_profile(profile)
    chunks = chunk_transcript(segments, max_tokens=resolve_chunk_token_budget(runtime, profile_config), overlap_segments=1)
    if not chunks:
        raise SummaryValidationError("Transcript has no summary-ready segments.")

    chunk_summaries: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="avanevis-summary-") as work_dir:
        work_path = Path(work_dir)
        for chunk in chunks:
            emit_progress(meeting_id, "chunk-summary", "Summarizing transcript chunk.", chunk_index=chunk["index"], chunk_total=len(chunks))
            prompt_path = work_path / f"chunk-{chunk['index']}.prompt.txt"
            write_prompt(prompt_path, build_chunk_summary_prompt(chunk, profile=profile))
            chunk_summaries.append(run_summary_prompt_with_repair(
                meeting_id=meeting_id,
                runtime=runtime,
                prompt_path=prompt_path,
                max_tokens=int(profile_config["max_output_tokens"]),
                run_prompt=run_prompt,
                work_path=work_path,
                repair_name=f"chunk-{chunk['index']}",
                chunk_text=str(chunk.get("text") or ""),
            ))

        if len(chunk_summaries) == 1:
            return validate_summary_json(chunk_summaries[0])

        emit_progress(meeting_id, "final-merge", "Merging chunk summaries.")
        final_prompt_path = work_path / "final-merge.prompt.txt"
        write_prompt(final_prompt_path, build_final_merge_prompt(chunk_summaries, profile=profile))
        final_summary = run_summary_prompt_with_repair(
            meeting_id=meeting_id,
            runtime=runtime,
            prompt_path=final_prompt_path,
            max_tokens=int(profile_config["max_output_tokens"]),
            run_prompt=run_prompt,
            work_path=work_path,
            repair_name="final-merge",
            chunk_text="\n".join(
                str((item or {}).get("summary") or "") for item in chunk_summaries
            ),
        )

    return validate_summary_json(final_summary)


def generate_summary(
    *,
    meeting_id: str,
    transcript_path: str,
    runtime_dir: str,
    model_path: str,
    output_json: Optional[str] = None,
    output_markdown: Optional[str] = None,
    speakers_json_path: Optional[str] = None,
    profile: str = DEFAULT_PROFILE,
    model_label: str = "local-summary-model",
    platform: Optional[str] = None,
    arch: Optional[str] = None,
    run_prompt: Optional[Callable[[Dict[str, Any], str, int], str]] = None,
) -> Dict[str, Any]:
    emit_progress(meeting_id, "loading-transcript", "Loading transcript for local summary.")
    transcript_text = read_transcript_text(transcript_path)
    source_hash = hash_transcript_text(transcript_text)
    segments = load_summary_segments(transcript_path, speakers_json_path)
    runtime = resolve_llama_runtime(runtime_dir=runtime_dir, model_path=model_path, platform=platform, arch=arch)

    prompt_runner = run_prompt or (lambda resolved_runtime, prompt_path, max_tokens: run_llama_prompt(
        resolved_runtime,
        prompt_path=prompt_path,
        max_tokens=max_tokens,
    ))

    summary = generate_summary_from_segments(
        meeting_id=meeting_id,
        segments=segments,
        runtime=runtime,
        profile=profile,
        run_prompt=prompt_runner,
    )

    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    metadata = {
        "profile": profile,
        "model": model_label,
        "generatedAt": generated_at,
        "sourceTranscriptHash": source_hash,
    }
    paths = sidecar_paths(transcript_path)
    emit_progress(meeting_id, "saving", "Saving local summary.")
    saved_paths = save_summary_outputs(
        summary=summary,
        metadata=metadata,
        json_path=output_json or paths["jsonPath"],
        markdown_path=output_markdown or paths["markdownPath"],
    )
    emit_progress(meeting_id, "completed", "Local summary completed.")

    return {
        "status": "completed",
        "meetingId": meeting_id,
        "summary": summary,
        "metadata": metadata,
        **saved_paths,
    }


def validate_summary_runtime(
    *,
    runtime_dir: str,
    model_path: str,
    platform: Optional[str] = None,
    arch: Optional[str] = None,
) -> Dict[str, Any]:
    runtime = resolve_llama_runtime(runtime_dir=runtime_dir, model_path=model_path, platform=platform, arch=arch)
    smoke_test_llama_runtime(runtime)
    return {
        "status": "ready",
        "runtime": runtime["runtime"],
        "acceleration": runtime["acceleration"],
        "executable": runtime["executable"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a local AvaNevis meeting summary")
    parser.add_argument("--meeting-id", default="setup-validation")
    parser.add_argument("--transcript")
    parser.add_argument("--runtime-dir", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--output-json")
    parser.add_argument("--output-markdown")
    parser.add_argument("--speakers-json")
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--model-label", default="local-summary-model")
    parser.add_argument("--platform")
    parser.add_argument("--arch")
    parser.add_argument("--validate-runtime", action="store_true", help="Validate llama.cpp runtime and model paths without generating a summary")
    args = parser.parse_args()

    try:
        if args.validate_runtime:
            result = validate_summary_runtime(
                runtime_dir=args.runtime_dir,
                model_path=args.model_path,
                platform=args.platform,
                arch=args.arch,
            )
            print(json.dumps(result, ensure_ascii=True))
            return

        if not args.transcript:
            raise ValueError("--transcript is required unless --validate-runtime is used.")

        result = generate_summary(
            meeting_id=args.meeting_id,
            transcript_path=args.transcript,
            runtime_dir=args.runtime_dir,
            model_path=args.model_path,
            output_json=args.output_json,
            output_markdown=args.output_markdown,
            speakers_json_path=args.speakers_json,
            profile=args.profile,
            model_label=args.model_label,
            platform=args.platform,
            arch=args.arch,
        )
        print(json.dumps(result, ensure_ascii=True))
    except Exception as exc:
        emit_progress(args.meeting_id, "error", "Local summary generation failed.")
        print(f"ERROR: {_safe_message(exc)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
