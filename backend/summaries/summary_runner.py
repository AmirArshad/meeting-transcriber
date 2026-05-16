"""User-triggered local summary generation runner."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional

from .llama_runtime import build_summary_progress_event, resolve_llama_runtime, run_llama_prompt, smoke_test_llama_runtime
from .summary_pipeline import (
    SummaryValidationError,
    build_chunk_summary_prompt,
    build_final_merge_prompt,
    chunk_transcript,
    get_summary_profile,
    parse_markdown_transcript,
    repair_summary_json,
    render_summary_markdown,
    validate_summary_json,
)


DEFAULT_PROFILE = "balanced"
MAX_SUMMARY_REPAIR_ATTEMPTS = 1


def _safe_message(message: Any) -> str:
    return re.sub(r"\s+", " ", str(message or "")).strip()[:300]


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


def load_summary_segments(transcript_path: str, speakers_json_path: Optional[str] = None) -> List[Dict[str, Any]]:
    if speakers_json_path and Path(speakers_json_path).exists():
        with open(speakers_json_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        segments = payload.get("segments") if isinstance(payload, dict) else None
        if isinstance(segments, list) and segments:
            return [dict(segment) for segment in segments if isinstance(segment, dict)]

    transcript_text = Path(transcript_path).read_text(encoding="utf-8")
    segments = parse_markdown_transcript(transcript_text)
    if segments:
        return segments
    cleaned = transcript_text.strip()
    return [{"start": 0.0, "end": 0.0, "speaker": "Unknown", "text": cleaned}] if cleaned else []


def sidecar_paths(transcript_path: str) -> Dict[str, str]:
    source = Path(transcript_path)
    base = source.with_suffix("")
    return {
        "jsonPath": str(base.with_suffix(".summary.json")),
        "markdownPath": str(base.with_suffix(".summary.md")),
    }


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
) -> Dict[str, Any]:
    raw_output = run_prompt(runtime, str(prompt_path), max_tokens)
    try:
        return repair_summary_json(raw_output)
    except SummaryValidationError:
        emit_progress(meeting_id, "json-repair", "Repairing malformed summary JSON.")

    last_error: Optional[SummaryValidationError] = None
    for attempt in range(1, MAX_SUMMARY_REPAIR_ATTEMPTS + 1):
        repair_prompt_path = work_path / f"{repair_name}-repair-{attempt}.prompt.txt"
        write_prompt(repair_prompt_path, build_json_repair_prompt(raw_output))
        repaired_output = run_prompt(runtime, str(repair_prompt_path), max_tokens)
        try:
            return repair_summary_json(repaired_output)
        except SummaryValidationError as exc:
            raw_output = repaired_output
            last_error = exc

    raise last_error or SummaryValidationError("summary JSON repair failed")


def generate_summary_from_segments(
    *,
    meeting_id: str,
    segments: Iterable[Dict[str, Any]],
    runtime: Dict[str, Any],
    profile: str = DEFAULT_PROFILE,
    run_prompt: Callable[[Dict[str, Any], str, int], str],
) -> Dict[str, Any]:
    profile_config = get_summary_profile(profile)
    chunks = chunk_transcript(segments, max_tokens=int(profile_config["chunk_tokens"]), overlap_segments=1)
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
            ))

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
        )

    return validate_summary_json(final_summary)


def save_summary_outputs(
    *,
    summary: Dict[str, Any],
    metadata: Dict[str, Any],
    json_path: str,
    markdown_path: str,
) -> Dict[str, str]:
    json_target = Path(json_path)
    markdown_target = Path(markdown_path)
    json_target.parent.mkdir(parents=True, exist_ok=True)
    markdown_target.parent.mkdir(parents=True, exist_ok=True)

    json_payload = {"summary": validate_summary_json(summary), "metadata": dict(metadata)}
    temp_json = json_target.with_name(f".{json_target.name}.tmp")
    temp_markdown = markdown_target.with_name(f".{markdown_target.name}.tmp")
    try:
        temp_json.write_text(json.dumps(json_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temp_markdown.write_text(render_summary_markdown(summary, metadata), encoding="utf-8")
        temp_json.replace(json_target)
        temp_markdown.replace(markdown_target)
    finally:
        for temp_path in (temp_json, temp_markdown):
            if temp_path.exists():
                temp_path.unlink()
    return {"jsonPath": str(json_target), "markdownPath": str(markdown_target)}


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
    transcript_text = Path(transcript_path).read_text(encoding="utf-8")
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
