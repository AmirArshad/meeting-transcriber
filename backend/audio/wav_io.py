"""Shared WAV writing helpers for recorder post-processing."""

from __future__ import annotations

import sys
import wave
from pathlib import Path
from typing import Union

import numpy as np

PathLike = Union[str, Path]


def write_int16_pcm_wav(
    path: PathLike,
    pcm: np.ndarray | bytes,
    *,
    channels: int,
    sample_rate: int,
    sample_width: int = 2,
) -> str:
    """
    Write already-encoded int16 PCM to a WAV file.

    ``pcm`` may be a flat/interleaved int16 ndarray (Windows mix output) or raw bytes.
    """
    output = str(path)
    frames = pcm.tobytes() if isinstance(pcm, np.ndarray) else pcm
    with wave.open(output, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(frames)
    return output


def write_float_stereo_wav(
    path: PathLike,
    audio: np.ndarray,
    *,
    sample_rate: int,
    log: bool = True,
) -> str:
    """
    Write float audio in roughly ``[-1, 1]`` as a 16-bit stereo WAV.

    Mono input is duplicated to stereo. Matches the previous macOS ``_save_wav`` behavior.
    """
    output = str(path)
    if len(audio.shape) == 1:
        audio = np.column_stack([audio, audio])

    audio_int = np.clip(audio * 32767, -32768, 32767).astype(np.int16)

    with wave.open(output, 'wb') as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_int.tobytes())

    if log:
        print(f"Saved WAV: {output}", file=sys.stderr)
    return output
