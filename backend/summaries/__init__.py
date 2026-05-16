"""Local transcript summary helpers."""

import importlib

from .summary_pipeline import (
    SummaryValidationError,
    build_chunk_summary_prompt,
    build_final_merge_prompt,
    chunk_transcript,
    get_summary_profile,
    is_topic_boundary_segment,
    normalize_transcript_segments,
    parse_markdown_transcript,
    repair_summary_json,
    render_summary_markdown,
    validate_summary_json,
)

_SUMMARY_RUNNER_EXPORTS = {
    "hash_transcript_text",
    "load_summary_segments",
    "sidecar_paths",
}


def __getattr__(name):
    if name in _SUMMARY_RUNNER_EXPORTS:
        module = importlib.import_module(f"{__name__}.summary_runner")
        return getattr(module, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

__all__ = [
    "SummaryValidationError",
    "build_chunk_summary_prompt",
    "build_final_merge_prompt",
    "chunk_transcript",
    "get_summary_profile",
    "is_topic_boundary_segment",
    "normalize_transcript_segments",
    "parse_markdown_transcript",
    "repair_summary_json",
    "render_summary_markdown",
    "hash_transcript_text",
    "load_summary_segments",
    "sidecar_paths",
    "validate_summary_json",
]
