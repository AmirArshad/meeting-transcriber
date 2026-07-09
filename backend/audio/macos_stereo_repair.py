"""macOS one-sided stereo repair for mono-compatible transcription downmixes."""

from __future__ import annotations

import sys

import numpy as np


def repair_one_sided_stereo(audio: np.ndarray, stream_name: str) -> np.ndarray:
    """Duplicate a dominant stereo channel so transcription downmixes do not lose speech.

    Thresholds are intentional product invariants — do not change without audio QA:
    silence gates ``1e-5`` / ``1e-4``, balance gates ``0.20`` / ``0.35``.
    """
    if len(audio.shape) != 2 or audio.shape[1] != 2 or len(audio) == 0:
        return audio

    left = audio[:, 0]
    right = audio[:, 1]
    left_rms = float(np.sqrt(np.mean(np.square(left)))) if left.size else 0.0
    right_rms = float(np.sqrt(np.mean(np.square(right)))) if right.size else 0.0
    left_peak = float(np.max(np.abs(left))) if left.size else 0.0
    right_peak = float(np.max(np.abs(right))) if right.size else 0.0

    max_rms = max(left_rms, right_rms)
    min_rms = min(left_rms, right_rms)
    max_peak = max(left_peak, right_peak)
    min_peak = min(left_peak, right_peak)

    if max_rms < 1e-5 or max_peak < 1e-4:
        return audio

    if min_rms > max_rms * 0.20 or min_peak > max_peak * 0.35:
        return audio

    dominant = left if left_rms >= right_rms else right
    print(
        f"  Repairing one-sided {stream_name} stereo for mono-compatible transcription "
        f"(left_rms={left_rms:.6f}, right_rms={right_rms:.6f})",
        file=sys.stderr,
    )
    return np.column_stack([dominant, dominant])
