"""Pure scan/import helpers for meeting recordings."""

from __future__ import annotations

import re
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple


# Legacy recorder temps (pre-.pcm.tmp) plus the current non-scanned extension.
_LEGACY_TEMP_WAV_SUFFIXES = (".temp.wav", "_temp.wav")
_RECORDER_TEMP_PCM_SUFFIX = ".pcm.tmp"
_CAPTURE_SESSION_DIR_SUFFIX = ".capture"
_CAPTURE_SEGMENT_SUFFIX = ".pcm.part"
_RECOVERY_STAGING_OPUS_SUFFIX = ".recovering.opus"

# RIFF/WAVE header is 44 bytes. Keep aligned with audio.recorder_temp_paths.
_MIN_RECOVERABLE_PCM_BYTES = 44


def recording_stem_from_audio_path(path: Path) -> str:
    """Return the meeting/recording stem, stripping recorder temp suffixes."""
    name = path.name
    lowered = name.lower()
    for suffix in (_RECORDER_TEMP_PCM_SUFFIX, *_LEGACY_TEMP_WAV_SUFFIXES):
        if lowered.endswith(suffix):
            return name[: -len(suffix)]
    return path.stem


def is_recorder_temp_audio_file(path: Path) -> bool:
    """True for recorder post-processing temps that must not be scan-imported as-is."""
    lowered = path.name.lower()
    return lowered.endswith(_RECORDER_TEMP_PCM_SUFFIX) or any(
        lowered.endswith(suffix) for suffix in _LEGACY_TEMP_WAV_SUFFIXES
    )


def is_capture_session_path(path: Path) -> bool:
    """True for durable capture-session dirs or files inside them / raw track segments."""
    lowered_name = path.name.lower()
    if lowered_name.endswith(_CAPTURE_SEGMENT_SUFFIX):
        return True
    if lowered_name.endswith(_RECOVERY_STAGING_OPUS_SUFFIX):
        # Recovery staging must never be imported as a meeting.
        return True
    if path.is_dir() and lowered_name.endswith(_CAPTURE_SESSION_DIR_SUFFIX):
        return True
    for parent in path.parents:
        if parent.name.lower().endswith(_CAPTURE_SESSION_DIR_SUFFIX):
            return True
    return False


def iter_recorder_temp_audio_files(recordings_dir: Path) -> List[Path]:
    """List leftover recorder temp PCM/WAV files in the recordings directory."""
    temps: List[Path] = []
    for path in recordings_dir.iterdir() if recordings_dir.is_dir() else []:
        if path.is_file() and is_recorder_temp_audio_file(path):
            temps.append(path)
    return sorted(temps, key=lambda item: item.name)


def _temp_byte_size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return -1


def recover_or_cleanup_recorder_temps(recordings_dir: Path) -> Dict[str, int]:
    """
    Recover orphaned recorder temps into scannable WAVs, or delete stale temps.

    Decision:
    - If a final ``.opus`` / ``.wav`` already exists for the same recording stem,
      delete the temp (cleanup after a successful compress that could not unlink).
    - If the temp is truncated (≤ WAV header size), delete it — do not import junk.
    - Otherwise promote the temp to ``{stem}.wav`` so the next scan can import
      a kill-mid-compress recording instead of leaving it orphaned.
    """
    recovered = 0
    cleaned = 0
    skipped = 0
    dropped = 0

    for temp_path in iter_recorder_temp_audio_files(recordings_dir):
        stem = recording_stem_from_audio_path(temp_path)
        if not stem:
            skipped += 1
            continue

        final_opus = recordings_dir / f"{stem}.opus"
        final_wav = recordings_dir / f"{stem}.wav"
        if final_opus.exists() or final_wav.exists():
            try:
                temp_path.unlink()
                cleaned += 1
                print(f"Removed stale recorder temp after final exists: {temp_path.name}", file=sys.stderr)
            except OSError as exc:
                skipped += 1
                print(f"Warning: Could not remove recorder temp {temp_path.name}: {exc}", file=sys.stderr)
            continue

        size = _temp_byte_size(temp_path)
        if size <= _MIN_RECOVERABLE_PCM_BYTES:
            try:
                temp_path.unlink()
                dropped += 1
                print(
                    f"Dropped truncated recorder temp ({size} bytes, "
                    f"need >{_MIN_RECOVERABLE_PCM_BYTES}): {temp_path.name}",
                    file=sys.stderr,
                )
            except OSError as exc:
                skipped += 1
                print(f"Warning: Could not remove truncated recorder temp {temp_path.name}: {exc}", file=sys.stderr)
            continue

        target_wav = final_wav
        try:
            temp_path.replace(target_wav)
            recovered += 1
            print(
                f"Recovered orphaned recorder temp as scannable WAV: {temp_path.name} -> {target_wav.name}",
                file=sys.stderr,
            )
        except OSError:
            try:
                shutil.copy2(temp_path, target_wav)
                try:
                    temp_path.unlink()
                except OSError:
                    pass
                recovered += 1
                print(
                    f"Recovered orphaned recorder temp as scannable WAV: {temp_path.name} -> {target_wav.name}",
                    file=sys.stderr,
                )
            except OSError as exc:
                skipped += 1
                print(f"Warning: Could not recover recorder temp {temp_path.name}: {exc}", file=sys.stderr)

    return {
        "recovered": recovered,
        "cleaned": cleaned,
        "dropped": dropped,
        "skipped": skipped,
    }


def select_scannable_audio_files(recordings_dir: Path) -> List[Path]:
    preferred_files = {}

    for audio_file in list(recordings_dir.glob("*.opus")) + list(recordings_dir.glob("*.wav")):
        if is_recorder_temp_audio_file(audio_file):
            # Defense in depth for any legacy *.temp.wav that still matches *.wav.
            continue
        if is_capture_session_path(audio_file):
            # Durable capture dirs / raw track segments are never meetings.
            continue

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
