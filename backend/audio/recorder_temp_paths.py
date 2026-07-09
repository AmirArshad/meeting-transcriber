"""Shared recorder temporary-file path helpers.

Temp PCM is written beside the final recording but must not use a scannable
``.wav`` / ``.opus`` extension — leftover temps would otherwise be imported as
duplicate meetings by ``meetings.scan_import.select_scannable_audio_files``.

When recovery must expose a path to Electron, promote the temp to a stable
``{stem}.wav`` first so a later scan-import pass cannot rename it out from
under a saved meeting's ``audioPath``.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path
from typing import Optional, Union

PathLike = Union[str, Path]

# Written during post-processing mix; never scanned as a meeting audio file.
RECORDER_TEMP_PCM_SUFFIX = ".pcm.tmp"

# RIFF/WAVE header is 44 bytes. Anything at or below that is truncated junk
# (force-kill mid-write), not a recoverable recording.
MIN_RECOVERABLE_PCM_BYTES = 44


def build_recorder_temp_pcm_path(output_path: PathLike) -> str:
    """Return the sidecar temp PCM path for a recorder output path."""
    return str(Path(output_path).with_suffix(RECORDER_TEMP_PCM_SUFFIX))


def build_stable_wav_path_for_output(output_path: PathLike) -> str:
    """Stable scannable WAV path for a recorder output (recovery / fallback)."""
    return str(Path(output_path).with_suffix(".wav"))


def is_recorder_temp_pcm_path(path: PathLike) -> bool:
    """True when ``path`` looks like a recorder post-processing temp file."""
    name = Path(path).name.lower()
    return (
        name.endswith(RECORDER_TEMP_PCM_SUFFIX)
        or name.endswith(".temp.wav")
        or name.endswith("_temp.wav")
    )


def is_recoverable_recorder_temp(path: PathLike) -> bool:
    """True when the temp exists and is larger than a bare WAV header."""
    try:
        candidate = Path(path)
        return candidate.is_file() and candidate.stat().st_size > MIN_RECOVERABLE_PCM_BYTES
    except OSError:
        return False


def promote_recorder_temp_to_wav(
    temp_path: PathLike,
    target_wav: PathLike,
    *,
    log: bool = True,
) -> Optional[str]:
    """
    Promote a recoverable recorder temp to a stable ``.wav``.

    Returns the target path on success. Deletes truncated/header-only temps
    instead of promoting them (avoids junk meetings on the next scan).
    """
    temp = Path(temp_path)
    target = Path(target_wav)

    if not temp.is_file():
        return None

    if not is_recoverable_recorder_temp(temp):
        try:
            size = temp.stat().st_size
        except OSError:
            size = -1
        try:
            temp.unlink()
            if log:
                print(
                    f"Dropped truncated recorder temp ({size} bytes): {temp.name}",
                    file=sys.stderr,
                )
        except OSError as exc:
            if log:
                print(
                    f"Warning: Could not remove truncated recorder temp {temp.name}: {exc}",
                    file=sys.stderr,
                )
        return None

    try:
        temp.replace(target)
        if log:
            print(
                f"Promoted recorder temp to stable WAV: {temp.name} -> {target.name}",
                file=sys.stderr,
            )
        return str(target)
    except OSError:
        try:
            shutil.copy2(temp, target)
            try:
                temp.unlink()
            except OSError:
                pass
            if log:
                print(
                    f"Promoted recorder temp to stable WAV: {temp.name} -> {target.name}",
                    file=sys.stderr,
                )
            return str(target)
        except OSError as exc:
            if log:
                print(
                    f"Warning: Could not promote recorder temp {temp.name}: {exc}",
                    file=sys.stderr,
                )
            return None
