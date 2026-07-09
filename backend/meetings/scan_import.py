"""Pure scan/import helpers for meeting recordings."""

from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple


def select_scannable_audio_files(recordings_dir: Path) -> List[Path]:
    preferred_files = {}

    for audio_file in list(recordings_dir.glob("*.opus")) + list(recordings_dir.glob("*.wav")):
        stem = audio_file.stem
        current = preferred_files.get(stem)

        if current is None:
            preferred_files[stem] = audio_file
            continue

        if current.suffix == ".opus" and audio_file.suffix == ".wav":
            preferred_files[stem] = audio_file

    return sorted(preferred_files.values(), key=lambda item: item.name)


def extract_duration_seconds_from_transcript(content: str) -> float:
    """Parse Duration lines from AvaNevis transcript Markdown."""
    duration_match = re.search(r"\*\*Duration:\*\*\s*(\d+):(\d+):(\d+)", content)
    if duration_match:
        hours, mins, secs = map(int, duration_match.groups())
        return float(hours * 3600 + mins * 60 + secs)

    duration_match = re.search(r"\*\*Duration:\*\*\s*(\d+):(\d+)", content)
    if duration_match:
        mins, secs = map(int, duration_match.groups())
        return float(mins * 60 + secs)

    return 0.0


def extract_duration_from_transcript_file(transcript_file: Path) -> float:
    try:
        content = transcript_file.read_text(encoding="utf-8", errors="replace")
        return extract_duration_seconds_from_transcript(content)
    except Exception as exc:
        print(f"Warning: Could not extract duration from {transcript_file.name}: {exc}", file=sys.stderr)
        return 0.0


def parse_scan_meeting_id_and_title(
    filename_stem: str,
    *,
    now: Optional[datetime] = None,
) -> Tuple[str, str]:
    """
    Derive meeting id/title from a recording filename stem.

    Supports:
    - meeting_YYYYMMDD_HHMMSS[_N]
    - recording_* with ISO-like timestamp
    - fallback to current timestamp
    """
    meeting_match = re.match(r"meeting_(\d{8}_\d{6}(?:_\d+)?)$", filename_stem)
    if meeting_match:
        meeting_id = meeting_match.group(1)
        try:
            parts = meeting_id.split("_")
            base_id = f"{parts[0]}_{parts[1]}" if len(parts) >= 2 else meeting_id
            dt = datetime.strptime(base_id, "%Y%m%d_%H%M%S")
            title = f"Meeting {dt.strftime('%Y-%m-%d %H:%M')}"
        except ValueError:
            title = f"Meeting {meeting_id}"
        return meeting_id, title

    recording_match = re.search(r"(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})", filename_stem)
    if recording_match:
        date_str, time_str = recording_match.groups()
        meeting_id = date_str.replace("-", "") + "_" + time_str.replace("-", "")
        title = f"Meeting {date_str} {time_str.replace('-', ':')}"
        return meeting_id, title

    stamp = now or datetime.now()
    meeting_id = stamp.strftime("%Y%m%d_%H%M%S")
    title = f"Meeting {filename_stem}"
    return meeting_id, title
