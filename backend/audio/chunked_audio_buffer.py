"""Compact audio chunk buffering helpers for long recordings."""

from __future__ import annotations

from typing import Optional

import numpy as np


class ChunkedAudioBuffer:
    """Store audio chunks in a compact byte buffer while preserving chunk access."""

    def __init__(self):
        self.clear()

    def clear(self) -> None:
        self._buffer = bytearray()
        self._dtype: Optional[np.dtype] = None
        self._ndim: Optional[int] = None
        self._channel_count: Optional[int] = None
        self._chunk_count = 0
        self._last_chunk: Optional[np.ndarray] = None

    def append(self, chunk: np.ndarray) -> None:
        array = np.ascontiguousarray(chunk)

        if array.ndim not in (1, 2):
            raise ValueError(f"Expected 1D or 2D audio chunk, got {array.ndim}D")

        dtype = array.dtype
        channel_count = array.shape[1] if array.ndim == 2 else None

        if self._dtype is None:
            self._dtype = dtype
            self._ndim = array.ndim
            self._channel_count = channel_count
        else:
            if dtype != self._dtype:
                raise ValueError(f"Mismatched chunk dtype: expected {self._dtype}, got {dtype}")
            if array.ndim != self._ndim:
                raise ValueError(f"Mismatched chunk rank: expected {self._ndim}D, got {array.ndim}D")
            if channel_count != self._channel_count:
                raise ValueError(
                    f"Mismatched channel count: expected {self._channel_count}, got {channel_count}"
                )

        self._buffer.extend(memoryview(array).cast('B'))
        self._chunk_count += 1
        self._last_chunk = array

    def to_array(self) -> np.ndarray:
        if self._dtype is None:
            return np.array([], dtype=np.float32)

        result = np.frombuffer(self._buffer, dtype=self._dtype)
        if self._ndim == 2:
            return result.reshape(-1, self._channel_count)
        return result

    def __bool__(self) -> bool:
        return self._chunk_count > 0

    def __len__(self) -> int:
        return self._chunk_count

    def __getitem__(self, index: int) -> np.ndarray:
        if index == -1 and self._last_chunk is not None:
            return self._last_chunk
        raise IndexError('ChunkedAudioBuffer only supports access to the latest chunk')

    @property
    def nbytes(self) -> int:
        return len(self._buffer)
