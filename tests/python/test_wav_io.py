"""Tests for shared WAV writing helpers."""

from __future__ import annotations

import wave

import numpy as np

from backend.audio.wav_io import write_float_stereo_wav, write_int16_pcm_wav


def test_write_int16_pcm_wav_writes_stereo_frames(tmp_path):
    path = tmp_path / "out.wav"
    pcm = np.array([0, 1000, -1000, 2000], dtype=np.int16)

    write_int16_pcm_wav(path, pcm, channels=2, sample_rate=48000)

    with wave.open(str(path), "rb") as wf:
        assert wf.getnchannels() == 2
        assert wf.getsampwidth() == 2
        assert wf.getframerate() == 48000
        assert wf.readframes(wf.getnframes()) == pcm.tobytes()


def test_write_float_stereo_wav_duplicates_mono_and_clips(tmp_path):
    path = tmp_path / "float.wav"
    mono = np.array([0.0, 2.0, -2.0], dtype=np.float32)

    write_float_stereo_wav(path, mono, sample_rate=16000, log=False)

    with wave.open(str(path), "rb") as wf:
        assert wf.getnchannels() == 2
        assert wf.getframerate() == 16000
        frames = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16).reshape(-1, 2)

    assert frames.shape == (3, 2)
    assert frames[0, 0] == 0
    assert frames[0, 1] == 0
    assert frames[1, 0] == 32767
    assert frames[1, 1] == 32767
    assert frames[2, 0] == -32768
    assert frames[2, 1] == -32768


def test_probe_wav_pcm_geometry_reads_standard_wav(tmp_path):
    from backend.audio.wav_io import probe_wav_pcm_geometry

    path = tmp_path / "probe.wav"
    pcm = np.array([1, 2, 3, 4, 5, 6], dtype=np.int16)
    write_int16_pcm_wav(path, pcm, channels=2, sample_rate=48000)
    assert probe_wav_pcm_geometry(path) == {
        "channels": 2,
        "sample_rate": 48000,
        "sample_width": 2,
        "frames": 3,
    }
