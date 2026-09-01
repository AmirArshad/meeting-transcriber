"""Shared macOS/Linux capture start-alignment frame geometry.

Timestamp math for spool manifests and the legacy in-memory aligner lives
here so both platforms persist the same trim/pad counts. Mix duration is
capped separately in ``streaming_post_processor`` against the microphone
timeline.
"""

from __future__ import annotations

from typing import Optional


def compute_capture_alignment_frames(
    *,
    recording_start_time: Optional[float],
    mic_capture_start_time: Optional[float],
    desktop_capture_start_time: Optional[float],
    sample_rate: int,
    preroll_seconds: float = 0.0,
) -> dict[str, int]:
    """Return spool alignment pads/trims without loading PCM.

    ``desktopTrimFrames`` are samples captured before the microphone preroll
    reference. A positive ``desktopLeadingPadFrames`` means desktop started
    later than the microphone; ``micLeadingPadFrames`` is the opposite.
    """
    empty = {
        "desktopTrimFrames": 0,
        "desktopLeadingPadFrames": 0,
        "micLeadingPadFrames": 0,
    }
    if (
        recording_start_time is None
        or mic_capture_start_time is None
        or desktop_capture_start_time is None
        or sample_rate <= 0
    ):
        return empty

    reference_start = float(recording_start_time) + max(float(preroll_seconds), 0.0)
    desktop_trim = 0
    desktop_capture_start = float(desktop_capture_start_time)
    if desktop_capture_start < reference_start:
        desktop_trim = int(round((reference_start - desktop_capture_start) * sample_rate))
        desktop_capture_start = reference_start

    mic_reference = max(float(mic_capture_start_time), reference_start)
    desktop_reference = max(desktop_capture_start, reference_start)
    offset_samples = int(round((desktop_reference - mic_reference) * sample_rate))
    if offset_samples > 0:
        return {
            "desktopTrimFrames": max(0, desktop_trim),
            "desktopLeadingPadFrames": offset_samples,
            "micLeadingPadFrames": 0,
        }
    if offset_samples < 0:
        return {
            "desktopTrimFrames": max(0, desktop_trim),
            "desktopLeadingPadFrames": 0,
            "micLeadingPadFrames": abs(offset_samples),
        }
    return {
        "desktopTrimFrames": max(0, desktop_trim),
        "desktopLeadingPadFrames": 0,
        "micLeadingPadFrames": 0,
    }
