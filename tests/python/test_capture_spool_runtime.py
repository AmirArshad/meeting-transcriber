"""Unit tests for capture-spool segment loaders."""

from __future__ import annotations

import numpy as np

from backend.audio.capture_spool_runtime import (
    load_track_pcm_array,
    load_track_segment_bytes,
)


def test_load_track_pcm_array_float32_stereo(tmp_path):
    chunk = np.array([[0.1, -0.2], [0.3, -0.4]], dtype=np.float32)
    part = tmp_path / "desktop_0000.pcm.part"
    part.write_bytes(chunk.tobytes())
    loaded = load_track_pcm_array(tmp_path, ["desktop_0000.pcm.part"], dtype="<f4", channels=2)
    assert loaded.dtype == np.float32
    assert loaded.shape == (2, 2)
    assert np.allclose(loaded, chunk)


def test_load_track_segment_bytes_concatenates(tmp_path):
    a = tmp_path / "a.pcm.part"
    b = tmp_path / "b.pcm.part"
    a.write_bytes(b"\x01\x02")
    b.write_bytes(b"\x03\x04")
    assert load_track_segment_bytes(tmp_path, ["a.pcm.part", "b.pcm.part"]) == b"\x01\x02\x03\x04"
