"""Tests for Swift helper PCM byte/frame alignment."""

from __future__ import annotations

import numpy as np

from backend.audio.swift_pcm_alignment import SwiftPcmAligner


def test_swift_pcm_aligner_handles_partial_bytes_across_chunks():
    aligner = SwiftPcmAligner(channels=2)
    samples = np.array([0.1, -0.2, 0.3, -0.4], dtype=np.float32)
    raw = samples.tobytes()

    first = aligner.process_audio_bytes(raw[:3])
    assert first is None
    assert len(aligner.partial_bytes) == 3

    frames = aligner.process_audio_bytes(raw[3:])
    assert frames is not None
    assert frames.dtype == np.float32
    assert frames.shape == (2, 2)
    np.testing.assert_allclose(frames.reshape(-1), samples, rtol=0, atol=0)
    assert aligner.partial_bytes == b''
    assert aligner.partial_samples is None


def test_swift_pcm_aligner_handles_partial_samples_across_chunks():
    aligner = SwiftPcmAligner(channels=2)
    # Three float32 samples: one full frame + one leftover sample
    samples = np.array([0.5, -0.5, 0.25], dtype=np.float32)
    frames = aligner.process_audio_bytes(samples.tobytes())
    assert frames is not None
    assert frames.shape == (1, 2)
    assert aligner.partial_samples is not None
    assert len(aligner.partial_samples) == 1

    more = np.array([-0.25], dtype=np.float32)
    frames2 = aligner.process_audio_bytes(more.tobytes())
    assert frames2 is not None
    assert frames2.shape == (1, 2)
    np.testing.assert_allclose(frames2[0], np.array([0.25, -0.25], dtype=np.float32))
    assert aligner.partial_samples is None


def test_swift_pcm_aligner_reset_clears_partial_state():
    aligner = SwiftPcmAligner(channels=2)
    aligner.process_audio_bytes(np.array([0.1], dtype=np.float32).tobytes()[:3])
    assert aligner.partial_bytes
    aligner.reset()
    assert aligner.partial_bytes == b''
    assert aligner.partial_samples is None
