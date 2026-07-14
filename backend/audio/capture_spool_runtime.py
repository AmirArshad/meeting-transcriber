"""Helpers for reading durable capture-spool PCM segments.

Capture always uses segmented track spools during recording. These loaders are
for tests and tooling that need to inspect on-disk segment bytes.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Union

import numpy as np

PathLike = Union[str, Path]


def load_track_segment_bytes(session_dir: PathLike, segments: List[str]) -> bytes:
    root = Path(session_dir)
    parts = []
    for name in segments:
        path = root / name
        if not path.is_file():
            raise FileNotFoundError(f"Missing capture segment: {path}")
        parts.append(path.read_bytes())
    return b"".join(parts)


def load_track_pcm_array(
    session_dir: PathLike,
    segments: List[str],
    *,
    dtype: str,
    channels: int,
) -> np.ndarray:
    payload = load_track_segment_bytes(session_dir, segments)
    if not payload:
        return np.zeros((0, channels), dtype=np.dtype(dtype)) if channels > 1 else np.array([], dtype=np.dtype(dtype))
    samples = np.frombuffer(payload, dtype=np.dtype(dtype))
    if channels <= 1:
        return samples
    if len(samples) % channels != 0:
        raise ValueError(
            f"PCM length {len(samples)} is not divisible by channels={channels}"
        )
    return samples.reshape(-1, channels)
