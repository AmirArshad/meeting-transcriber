"""macOS mic/desktop stream start-time alignment and preroll trimming."""

from __future__ import annotations

import sys
from typing import Optional, Tuple

import numpy as np

from .capture_alignment import compute_capture_alignment_frames


def align_streams_by_start_time(
    mic_audio: np.ndarray,
    desktop_audio: np.ndarray,
    *,
    sample_rate: int,
    recording_start_time: Optional[float],
    mic_capture_start_time: Optional[float],
    desktop_capture_start_time: Optional[float],
    preroll_seconds: float = 0.0,
) -> Tuple[np.ndarray, np.ndarray]:
    """Align mic and desktop by first-audio timestamps; trim desktop preroll samples.

    Mic callbacks discard the preroll window before appending frames. Desktop PCM
    from the helper is buffered from the first sample, so without an explicit trim
    desktop speech lands late by up to ``preroll_seconds`` after alignment clamps
    the reference time.
    """
    if (
        recording_start_time is None
        or mic_capture_start_time is None
        or desktop_capture_start_time is None
    ):
        print(
            "Stream alignment: missing first-audio timestamp, falling back to length padding only",
            file=sys.stderr,
        )
        return mic_audio, desktop_audio

    if sample_rate <= 0:
        return mic_audio, desktop_audio

    alignment = compute_capture_alignment_frames(
        recording_start_time=recording_start_time,
        mic_capture_start_time=mic_capture_start_time,
        desktop_capture_start_time=desktop_capture_start_time,
        sample_rate=sample_rate,
        preroll_seconds=preroll_seconds,
    )

    trim_samples = int(alignment["desktopTrimFrames"])
    if trim_samples > 0 and len(desktop_audio) > 0:
        trim_seconds = trim_samples / float(sample_rate)
        if trim_samples >= len(desktop_audio):
            print(
                f"Stream alignment: trimmed all {len(desktop_audio)} desktop samples "
                f"captured during {trim_seconds:.3f}s preroll",
                file=sys.stderr,
            )
            channels = desktop_audio.shape[1] if len(desktop_audio.shape) > 1 else 1
            desktop_audio = np.zeros((0, channels), dtype=desktop_audio.dtype)
        else:
            desktop_audio = desktop_audio[trim_samples:]
            print(
                f"Stream alignment: trimmed {trim_samples} desktop preroll samples "
                f"({trim_seconds:.3f}s)",
                file=sys.stderr,
            )

    offset_samples = int(alignment["desktopLeadingPadFrames"])
    mic_padding = int(alignment["micLeadingPadFrames"])
    if offset_samples > 0:
        channels = desktop_audio.shape[1] if len(desktop_audio.shape) > 1 else 1
        padding = np.zeros((offset_samples, channels), dtype=desktop_audio.dtype)
        desktop_audio = np.concatenate([padding, desktop_audio], axis=0)
        print(
            f"Aligned desktop stream with {offset_samples} leading silence samples "
            f"({offset_samples / float(sample_rate):.3f}s startup lag)",
            file=sys.stderr,
        )
    elif mic_padding > 0:
        channels = mic_audio.shape[1] if len(mic_audio.shape) > 1 else 1
        padding = np.zeros((mic_padding, channels), dtype=mic_audio.dtype)
        mic_audio = np.concatenate([padding, mic_audio], axis=0)
        print(
            f"Aligned mic stream with {mic_padding} leading silence samples "
            f"({mic_padding / float(sample_rate):.3f}s startup lag)",
            file=sys.stderr,
        )

    return mic_audio, desktop_audio
