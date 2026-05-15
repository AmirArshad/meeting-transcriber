"""Utilities for merging diarization speaker turns into transcript segments."""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional


UNKNOWN_SPEAKER = "Unknown"


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
        best_speaker = _best_speaker_for_segment(merged_segment, speaker_turns)
        merged_segment["speaker"] = speaker_map.get(best_speaker, UNKNOWN_SPEAKER)
        merged.append(merged_segment)

    return merged
