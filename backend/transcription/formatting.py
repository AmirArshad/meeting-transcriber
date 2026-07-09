"""Shared transcript timestamp, segment merge, and Markdown helpers."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional


def format_timestamp(seconds: Any) -> str:
    """Format seconds as HH:MM:SS or MM:SS."""
    total_seconds = max(0, int(float(seconds or 0)))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def merge_segments(
    segments: List[Dict[str, Any]],
    target_duration: float = 20.0,
    *,
    skip_empty_text: bool = False,
    log: bool = True,
) -> List[Dict[str, Any]]:
    """Merge consecutive segments into larger chunks for readability."""
    if not segments:
        return []

    merged: List[Dict[str, Any]] = []
    current_chunk = None

    for segment in segments:
        if skip_empty_text and not str(segment.get("text", "") or "").strip():
            continue
        if current_chunk is None:
            current_chunk = {
                "start": segment["start"],
                "end": segment["end"],
                "text": segment["text"],
            }
        else:
            chunk_duration = current_chunk["end"] - current_chunk["start"]
            if chunk_duration >= target_duration:
                merged.append(current_chunk)
                current_chunk = {
                    "start": segment["start"],
                    "end": segment["end"],
                    "text": segment["text"],
                }
            else:
                current_chunk["end"] = segment["end"]
                current_chunk["text"] += " " + segment["text"]

    if current_chunk is not None:
        merged.append(current_chunk)

    if log:
        print(f"  Merged into {len(merged)} chunks (target: {target_duration}s each)", file=sys.stderr)
    return merged


def build_transcript_markdown(
    *,
    audio_path: str,
    language_label: str,
    duration: float,
    segments: List[Dict[str, Any]],
    engine_label: Optional[str] = None,
    include_speakers: bool = False,
    dated_at: Optional[datetime] = None,
) -> str:
    """Build AvaNevis transcript Markdown content."""
    audio_file = Path(audio_path)
    stamp = dated_at or datetime.now()
    duration_text = str(timedelta(seconds=max(0, int(duration))))
    lines = [
        "# Meeting Transcription",
        "",
        f"**File:** {audio_file.name}",
        f"**Date:** {stamp.strftime('%Y-%m-%d %H:%M:%S')}",
        f"**Duration:** {duration_text}",
        f"**Language:** {language_label}",
    ]
    if engine_label:
        lines.append(f"**Transcribed with:** {engine_label}")
    lines.extend([
        "",
        "---",
        "",
        "## Transcript",
        "",
    ])

    for segment in segments:
        start_time = format_timestamp(segment.get("start", 0))
        end_time = format_timestamp(segment.get("end", 0))
        text = str(segment.get("text", "") or "")
        if include_speakers:
            # Preserve guided-transcript spacing: "**[t - t]** **Speaker:**"
            speaker = f" **{segment.get('speaker')}:**" if segment.get("speaker") else ""
            lines.append(f"**[{start_time} - {end_time}]**{speaker}")
            lines.append(text)
        else:
            lines.append(f"**[{start_time} - {end_time}]**  ")
            lines.append(text)
        lines.append("")

    return "\n".join(lines)


def save_transcript_markdown(
    output_path: str,
    *,
    audio_path: str,
    language_label: str,
    duration: float,
    segments: List[Dict[str, Any]],
    engine_label: Optional[str] = None,
    include_speakers: bool = False,
    dated_at: Optional[datetime] = None,
    log: bool = True,
) -> None:
    """Write transcript Markdown to disk."""
    markdown_content = build_transcript_markdown(
        audio_path=audio_path,
        language_label=language_label,
        duration=duration,
        segments=segments,
        engine_label=engine_label,
        include_speakers=include_speakers,
        dated_at=dated_at,
    )
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(markdown_content)
    if log:
        print(f"\nTranscript saved to: {output_path}", file=sys.stderr)
