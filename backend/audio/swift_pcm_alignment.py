"""Swift helper stdout PCM byte/sample/frame alignment helpers."""

from __future__ import annotations

from typing import Optional

import numpy as np


class SwiftPcmAligner:
    """
    Two-stage alignment for interleaved float32 helper stdout.

    Stage 1: byte alignment to float32 (4 bytes per sample) via ``_partial_bytes``.
    Stage 2: frame alignment to channel count via ``_partial_samples``.
    """

    def __init__(self, channels: int, *, bytes_per_sample: int = 4):
        self.channels = channels
        self.bytes_per_sample = bytes_per_sample
        self.partial_bytes: bytes = b''
        self.partial_samples: Optional[np.ndarray] = None

    def reset(self) -> None:
        self.partial_bytes = b''
        self.partial_samples = None

    def bytes_to_samples(self, data: bytes) -> Optional[np.ndarray]:
        """
        Convert raw bytes to float32 samples, handling byte alignment.

        Stage 1: Byte alignment (4 bytes per float32 sample)
        Leftover bytes are stored in ``partial_bytes``.
        """
        if self.partial_bytes:
            data = self.partial_bytes + data
            self.partial_bytes = b''

        if not data:
            return None

        leftover_bytes = len(data) % self.bytes_per_sample
        if leftover_bytes:
            self.partial_bytes = data[-leftover_bytes:]
            data = data[:-leftover_bytes]

        if not data:
            return None

        return np.frombuffer(data, dtype=np.float32)

    def samples_to_frames(self, samples: np.ndarray) -> Optional[np.ndarray]:
        """
        Reshape samples into frames, handling frame alignment.

        Stage 2: Frame alignment (channels samples per frame)
        Leftover samples are stored in ``partial_samples``.
        """
        if self.partial_samples is not None:
            samples = np.concatenate([self.partial_samples, samples])
            self.partial_samples = None

        if len(samples) == 0:
            return None

        if self.channels == 1:
            return samples.reshape(-1, 1)

        leftover_samples = len(samples) % self.channels
        if leftover_samples:
            self.partial_samples = samples[-leftover_samples:].copy()
            samples = samples[:-leftover_samples]

        if len(samples) == 0:
            return None

        # Reshape to (frames, channels); keep float32 from helper stdout (matches mic path)
        return samples.reshape(-1, self.channels)

    def process_audio_bytes(self, data: bytes) -> Optional[np.ndarray]:
        """Process raw bytes into audio frames through both alignment stages."""
        samples = self.bytes_to_samples(data)
        if samples is None:
            return None
        return self.samples_to_frames(samples)
