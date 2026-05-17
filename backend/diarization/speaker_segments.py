"""Utilities for merging diarization speaker turns into transcript segments."""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional


UNKNOWN_SPEAKER = "Unknown"
MIN_SPLIT_SEGMENT_SECONDS = 12.0
MIN_SPLIT_OVERLAP_SECONDS = 0.75


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def temporal_overlap(first: Dict[str, Any], second: Dict[str, Any]) -> float:
    """Return the positive timestamp overlap between two segment-like dicts."""
    start = max(_to_float(first.get("start")), _to_float(second.get("start")))
    end = min(_to_float(first.get("end")), _to_float(second.get("end")))
    return max(0.0, end - start)


def _speaker_sort_key(label: str) -> tuple[int, Any]:
    suffix = label.rsplit("_", 1)[-1]
    if suffix.isdigit():
        return (0, int(suffix))
    return (1, label)


def _speaker_label_map(speaker_segments: Iterable[Dict[str, Any]]) -> Dict[str, str]:
    raw_labels = {
        str(segment.get("speaker", "")).strip()
        for segment in speaker_segments
        if str(segment.get("speaker", "")).strip()
    }
    return {
        raw_label: f"Speaker {index + 1}"
        for index, raw_label in enumerate(sorted(raw_labels, key=_speaker_sort_key))
    }


def _best_speaker_for_segment(
    transcript_segment: Dict[str, Any],
    speaker_segments: List[Dict[str, Any]],
) -> Optional[str]:
    best_speaker: Optional[str] = None
    best_overlap = 0.0
    best_duration = 0.0

    for speaker_segment in speaker_segments:
        raw_speaker = str(speaker_segment.get("speaker", "")).strip()
        if not raw_speaker:
            continue

        overlap = temporal_overlap(transcript_segment, speaker_segment)
        duration = max(0.0, _to_float(speaker_segment.get("end")) - _to_float(speaker_segment.get("start")))

        if overlap > best_overlap or (
            overlap == best_overlap and overlap > 0 and duration > best_duration
        ):
            best_speaker = raw_speaker
            best_overlap = overlap
            best_duration = duration

    return best_speaker if best_overlap > 0 else None


def _segment_duration(segment: Dict[str, Any]) -> float:
    return max(0.0, _to_float(segment.get("end")) - _to_float(segment.get("start")))


def _overlapping_speaker_blocks(
    transcript_segment: Dict[str, Any],
    speaker_segments: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    blocks: List[Dict[str, Any]] = []
    ordered_speaker_segments = sorted(
        speaker_segments,
        key=lambda segment: (_to_float(segment.get("start")), _to_float(segment.get("end"))),
    )
    for speaker_segment in ordered_speaker_segments:
        raw_speaker = str(speaker_segment.get("speaker", "")).strip()
        if not raw_speaker:
            continue

        start = max(_to_float(transcript_segment.get("start")), _to_float(speaker_segment.get("start")))
        end = min(_to_float(transcript_segment.get("end")), _to_float(speaker_segment.get("end")))
        if end - start < MIN_SPLIT_OVERLAP_SECONDS:
            continue

        if blocks and blocks[-1]["speaker"] == raw_speaker and start - blocks[-1]["end"] <= 0.5:
            blocks[-1]["end"] = end
            continue

        blocks.append({"start": start, "end": end, "speaker": raw_speaker})

    return blocks


def _split_words_by_block_durations(text: str, blocks: List[Dict[str, Any]]) -> List[str]:
    words = re.findall(r"\S+", str(text or ""))
    if not words or not blocks:
        return []

    total_duration = sum(_segment_duration(block) for block in blocks)
    if total_duration <= 0:
        return [" ".join(words)]

    chunks: List[str] = []
    cursor = 0
    for index, block in enumerate(blocks):
        remaining_words = len(words) - cursor
        remaining_blocks = len(blocks) - index
        if remaining_words <= 0:
            break

        if index == len(blocks) - 1:
            take = remaining_words
        else:
            proportional = round(len(words) * (_segment_duration(block) / total_duration))
            take = max(1, min(proportional, remaining_words - (remaining_blocks - 1)))

        chunks.append(" ".join(words[cursor:cursor + take]))
        cursor += take

    if cursor < len(words):
        if chunks:
            chunks[-1] = f"{chunks[-1]} {' '.join(words[cursor:])}".strip()
        else:
            chunks.append(" ".join(words[cursor:]))

    return chunks


def _split_coarse_transcript_segment(
    transcript_segment: Dict[str, Any],
    speaker_turns: List[Dict[str, Any]],
    speaker_map: Dict[str, str],
) -> Optional[List[Dict[str, Any]]]:
    text = str(transcript_segment.get("text", "") or "").strip()
    if not text or _segment_duration(transcript_segment) < MIN_SPLIT_SEGMENT_SECONDS:
        return None

    blocks = _overlapping_speaker_blocks(transcript_segment, speaker_turns)
    speaker_count = len({block["speaker"] for block in blocks})
    if speaker_count < 2 or len(blocks) < 2:
        return None

    text_chunks = _split_words_by_block_durations(text, blocks)
    if len(text_chunks) != len(blocks):
        return None

    split_segments: List[Dict[str, Any]] = []
    for block, chunk_text in zip(blocks, text_chunks):
        if not chunk_text.strip():
            continue
        split_segments.append({
            **transcript_segment,
            "start": block["start"],
            "end": block["end"],
            "text": chunk_text.strip(),
            "speaker": speaker_map.get(block["speaker"], UNKNOWN_SPEAKER),
        })

    return split_segments or None


def merge_speaker_labels(
    transcript_segments: Iterable[Dict[str, Any]],
    speaker_segments: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Attach normalized speaker labels to transcript segments by max overlap.

    The input segments are not mutated. Unknown is used when no diarization turn
    overlaps a transcript segment, which keeps summary generation usable without
    inventing owners.
    """
    speaker_turns = [dict(segment) for segment in speaker_segments]
    speaker_map = _speaker_label_map(speaker_turns)
    merged: List[Dict[str, Any]] = []

    for transcript_segment in transcript_segments:
        merged_segment = dict(transcript_segment)
        split_segments = _split_coarse_transcript_segment(merged_segment, speaker_turns, speaker_map)
        if split_segments:
            merged.extend(split_segments)
            continue

        best_speaker = _best_speaker_for_segment(merged_segment, speaker_turns)
        merged_segment["speaker"] = speaker_map.get(best_speaker, UNKNOWN_SPEAKER)
        merged.append(merged_segment)

    return merged
