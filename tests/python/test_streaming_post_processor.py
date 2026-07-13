"""Characterization and bounded-finalization tests for Task 9."""

from __future__ import annotations

import wave
from pathlib import Path

import numpy as np
import pytest

from backend.audio.capture_manifest import CaptureManifestCoordinator, MANIFEST_FILENAME
from backend.audio.constants import DEFAULT_FINALIZATION_CHUNK_FRAMES, FINAL_CAPTURE_PCM_NAME
from backend.audio.processor import (
    StatefulResampler,
    downmix_macos_frames_to_stereo,
    downmix_windows_frames_to_stereo,
)
from backend.audio.streaming_post_processor import (
    TrackFrameReader,
    finalize_capture,
    reference_macos_v1_process,
    reference_windows_v1_process,
)
from backend.audio.wav_io import probe_wav_pcm_geometry, write_int16_pcm_wav


def _write_segment(path: Path, frames: np.ndarray) -> None:
    path.write_bytes(np.ascontiguousarray(frames).tobytes())


def _build_session(
    tmp_path: Path,
    *,
    profile: str,
    mic: np.ndarray,
    desktop: np.ndarray | None,
    mic_rate: int = 48000,
    mic_channels: int | None = None,
    desk_rate: int = 48000,
    desk_channels: int | None = None,
    dtype: str = "<i2",
    include_desktop: bool = True,
):
    output = tmp_path / "meeting.opus"
    coordinator = CaptureManifestCoordinator.create(
        output,
        started_at_ns=1,
        started_at_iso="2026-07-13T12:00:00.000Z",
    )
    coordinator.set_processing_profile(profile)
    coordinator.set_mix_params()
    mic_ch = mic_channels or (1 if mic.ndim == 1 else mic.shape[1])
    mic_frames = mic if mic.ndim > 1 else mic.reshape(-1, 1)
    coordinator.add_track("mic", sample_rate=mic_rate, channels=mic_ch, dtype=dtype)
    mic_name = "mic_0000.pcm.part"
    _write_segment(coordinator.session_dir / mic_name, mic_frames.astype(np.dtype(dtype)))
    coordinator.commit_track("mic", [mic_name], committed_frames=int(mic_frames.shape[0]))

    if desktop is not None and include_desktop:
        desk_ch = desk_channels or (1 if desktop.ndim == 1 else desktop.shape[1])
        desk_frames = desktop if desktop.ndim > 1 else desktop.reshape(-1, 1)
        coordinator.add_track("desktop", sample_rate=desk_rate, channels=desk_ch, dtype=dtype)
        desk_name = "desktop_0000.pcm.part"
        _write_segment(coordinator.session_dir / desk_name, desk_frames.astype(np.dtype(dtype)))
        coordinator.commit_track("desktop", [desk_name], committed_frames=int(desk_frames.shape[0]))
        coordinator.set_include_desktop(True)
    else:
        coordinator.set_include_desktop(False)

    coordinator.set_state("finalizing")
    return coordinator, output


def _read_wav_int16(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wf:
        assert wf.getnchannels() == 2
        assert wf.getframerate() == 48000
        return np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)


def _mae_int16(a: np.ndarray, b: np.ndarray) -> float:
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    return float(np.mean(np.abs(a[:n].astype(np.int32) - b[:n].astype(np.int32))))


def test_track_frame_reader_rejects_oversize_chunk(tmp_path):
    part = tmp_path / "mic_0000.pcm.part"
    frames = np.zeros((100, 2), dtype=np.int16)
    _write_segment(part, frames)
    reader = TrackFrameReader(
        tmp_path,
        ["mic_0000.pcm.part"],
        channels=2,
        dtype="<i2",
        chunk_frames=16,
        max_chunk_frames=16,
    )
    with pytest.raises(ValueError, match="oversize chunk"):
        reader.read_frames(17)
    got = reader.read_frames(16)
    assert got.shape == (16, 2)
    reader.close()


def test_stateful_resampler_matches_whole_array_quality():
    rng = np.random.default_rng(0)
    mono = rng.standard_normal(4800).astype(np.float32) * 0.2
    stream = StatefulResampler(44100, 48000, 1, quality="VHQ")
    out_chunks = []
    for start in range(0, len(mono), 512):
        last = start + 512 >= len(mono)
        out_chunks.append(stream.process(mono[start : start + 512], last=last))
    streamed = np.concatenate(out_chunks) if out_chunks else np.zeros(0, dtype=np.float32)

    oneshot = StatefulResampler(44100, 48000, 1, quality="VHQ").process(mono, last=True)
    # Streaming and one-shot with the same ResampleStream API should stay close.
    n = min(len(streamed), len(oneshot))
    assert n > 1000
    assert float(np.mean(np.abs(streamed[:n] - oneshot[:n]))) < 1e-5


def test_windows_downmix_selects_front_pair():
    frames = np.arange(12, dtype=np.float32).reshape(2, 6)
    stereo = downmix_windows_frames_to_stereo(frames, 6)
    assert np.array_equal(stereo, frames[:, :2])


def test_macos_downmix_folds_center_and_surround():
    frames = np.ones((1, 4), dtype=np.float32)
    stereo = downmix_macos_frames_to_stereo(frames, 4)
    # L/R + center*0.707 + surround*0.5
    expected = 1.0 + 0.707 + 0.5
    assert stereo.shape == (1, 2)
    assert abs(float(stereo[0, 0]) - expected) < 1e-5


@pytest.mark.parametrize(
    "name,builder",
    [
        (
            "mono",
            lambda: (
                np.linspace(-0.4, 0.4, 2400, dtype=np.float32).reshape(-1, 1),
                None,
                1,
                1,
            ),
        ),
        (
            "stereo",
            lambda: (
                np.column_stack(
                    [
                        np.linspace(-0.3, 0.3, 2400, dtype=np.float32),
                        np.linspace(0.2, -0.2, 2400, dtype=np.float32),
                    ]
                ),
                np.column_stack(
                    [
                        np.sin(np.linspace(0, 20, 2400, dtype=np.float32)) * 0.2,
                        np.cos(np.linspace(0, 20, 2400, dtype=np.float32)) * 0.2,
                    ]
                ),
                2,
                2,
            ),
        ),
            (
                "quiet_mic",
                lambda: (
                    np.sin(np.linspace(0, 12, 2400, dtype=np.float32)).reshape(-1, 1)
                    * np.array([0.02, 0.02], dtype=np.float32),
                    np.zeros((2400, 2), dtype=np.float32),
                    2,
                    2,
                ),
            ),
        (
            "clipping_mix",
            lambda: (
                np.full((2400, 2), 0.9, dtype=np.float32),
                np.full((2400, 2), 0.9, dtype=np.float32),
                2,
                2,
            ),
        ),
        (
            "unequal_length",
            lambda: (
                np.full((3000, 2), 0.1, dtype=np.float32),
                np.full((1800, 2), 0.05, dtype=np.float32),
                2,
                2,
            ),
        ),
        (
            "one_sided_desktop",
            lambda: (
                np.full((2400, 2), 0.05, dtype=np.float32),
                np.column_stack(
                    [
                        np.sin(np.linspace(0, 40, 2400, dtype=np.float32)) * 0.4,
                        np.zeros(2400, dtype=np.float32),
                    ]
                ),
                2,
                2,
            ),
        ),
    ],
)
def test_macos_v1_fixture_equivalence(tmp_path, name, builder, monkeypatch):
    mic, desk, mic_ch, desk_ch = builder()
    ref = reference_macos_v1_process(
        mic,
        desk,
        mic_channels=mic_ch,
        desktop_channels=desk_ch,
    )
    coordinator, output = _build_session(
        tmp_path,
        profile="macos-v1",
        mic=mic,
        desktop=desk,
        mic_channels=mic_ch,
        desk_channels=desk_ch,
        dtype="<f4",
        include_desktop=desk is not None,
    )

    # Capture the float mix by short-circuiting ffmpeg encode: write wav ourselves
    # from streamed float via a fake ffmpeg that copies stdin as s16 WAV.
    def fake_finalize_ffmpeg(*, ffmpeg_path, output_path, frame_iter, sample_rate=48000):
        frames = []
        for chunk in frame_iter:
            frames.append(chunk)
        if frames:
            audio = np.concatenate(frames, axis=0)
        else:
            audio = np.zeros((0, 2), dtype=np.float32)
        int16 = np.clip(audio, -1.0, 1.0)
        int16 = (int16 * 32767.0).astype(np.int16)
        write_int16_pcm_wav(output_path, int16.reshape(-1), channels=2, sample_rate=sample_rate)
        return int(audio.shape[0])

    monkeypatch.setattr(
        "backend.audio.streaming_post_processor._stream_final_wav_via_ffmpeg",
        fake_finalize_ffmpeg,
    )
    monkeypatch.setattr(
        "backend.audio.streaming_post_processor._verify_final_temp",
        lambda path, expected_frames, ffmpeg_path: None,
    )
    monkeypatch.setattr(
        "backend.audio.streaming_post_processor.compress_and_report",
        lambda input_path, output_path, sample_rate, **kwargs: (
            str(Path(output_path).with_suffix(".wav")),
            {"copied": True},
        ),
    )

    # compress_and_report is mocked to pretend success without copying; copy temp → final.
    def compress_copy(input_path, output_path, sample_rate, **kwargs):
        dest = Path(output_path).with_suffix(".wav")
        dest.write_bytes(Path(input_path).read_bytes())
        return str(dest), {"input_size": dest.stat().st_size, "output_size": dest.stat().st_size, "ratio": 0.0}

    monkeypatch.setattr(
        "backend.audio.streaming_post_processor.compress_and_report",
        compress_copy,
    )

    result = finalize_capture(
        coordinator.session_dir / MANIFEST_FILENAME,
        output,
        ffmpeg_path="ffmpeg",
        chunk_frames=512,
        coordinator=coordinator,
    )
    got = _read_wav_int16(Path(result.final_path))
    assert got.size % 2 == 0
    assert abs(len(got) - len(ref)) <= 2
    assert _mae_int16(got, ref) <= 2.0
    assert float(np.max(np.abs(got.astype(np.int32)))) <= 32767


def test_windows_v1_fixture_equivalence_stereo(tmp_path, monkeypatch):
    mic = np.column_stack(
        [
            (np.linspace(-0.2, 0.2, 2400) * 32767).astype(np.int16),
            (np.linspace(0.1, -0.1, 2400) * 32767).astype(np.int16),
        ]
    )
    desk = np.column_stack(
        [
            (np.sin(np.linspace(0, 30, 2400)) * 0.15 * 32767).astype(np.int16),
            (np.cos(np.linspace(0, 30, 2400)) * 0.15 * 32767).astype(np.int16),
        ]
    )
    ref = reference_windows_v1_process(
        mic.reshape(-1),
        desk.reshape(-1),
        mic_rate=48000,
        mic_channels=2,
        desktop_rate=48000,
        desktop_channels=2,
    )
    coordinator, output = _build_session(
        tmp_path,
        profile="windows-v1",
        mic=mic,
        desktop=desk,
        dtype="<i2",
    )

    def fake_finalize_ffmpeg(*, ffmpeg_path, output_path, frame_iter, sample_rate=48000):
        frames = [chunk for chunk in frame_iter if chunk.size]
        audio = np.concatenate(frames, axis=0) if frames else np.zeros((0, 2), dtype=np.float32)
        int16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
        write_int16_pcm_wav(output_path, int16.reshape(-1), channels=2, sample_rate=sample_rate)
        return int(audio.shape[0])

    monkeypatch.setattr(
        "backend.audio.streaming_post_processor._stream_final_wav_via_ffmpeg",
        fake_finalize_ffmpeg,
    )
    monkeypatch.setattr(
        "backend.audio.streaming_post_processor._verify_final_temp",
        lambda *a, **k: None,
    )

    def compress_copy(input_path, output_path, sample_rate, **kwargs):
        dest = Path(output_path).with_suffix(".wav")
        dest.write_bytes(Path(input_path).read_bytes())
        return str(dest), {"input_size": 1, "output_size": 1, "ratio": 0.0}

    monkeypatch.setattr(
        "backend.audio.streaming_post_processor.compress_and_report",
        compress_copy,
    )

    result = finalize_capture(
        coordinator.session_dir / MANIFEST_FILENAME,
        output,
        chunk_frames=480,
        coordinator=coordinator,
    )
    got = _read_wav_int16(Path(result.final_path))
    assert abs(len(got) - len(ref)) <= 2
    assert _mae_int16(got, ref) <= 2.0


def test_windows_multichannel_and_resample_fixture(tmp_path, monkeypatch):
    # 4-channel mic at 44100 → front L/R + resample to 48k
    frames = 2205
    mic = np.zeros((frames, 4), dtype=np.int16)
    mic[:, 0] = (np.linspace(-0.3, 0.3, frames) * 20000).astype(np.int16)
    mic[:, 1] = (np.linspace(0.2, -0.2, frames) * 20000).astype(np.int16)
    mic[:, 2] = 1000
    mic[:, 3] = -1000
    ref = reference_windows_v1_process(
        mic.reshape(-1),
        None,
        mic_rate=44100,
        mic_channels=4,
    )
    coordinator, output = _build_session(
        tmp_path,
        profile="windows-v1",
        mic=mic,
        desktop=None,
        mic_rate=44100,
        mic_channels=4,
        dtype="<i2",
        include_desktop=False,
    )

    def fake_finalize_ffmpeg(*, ffmpeg_path, output_path, frame_iter, sample_rate=48000):
        frames_out = [chunk for chunk in frame_iter if chunk.size]
        audio = np.concatenate(frames_out, axis=0) if frames_out else np.zeros((0, 2), dtype=np.float32)
        int16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
        write_int16_pcm_wav(output_path, int16.reshape(-1), channels=2, sample_rate=sample_rate)
        return int(audio.shape[0])

    monkeypatch.setattr(
        "backend.audio.streaming_post_processor._stream_final_wav_via_ffmpeg",
        fake_finalize_ffmpeg,
    )
    monkeypatch.setattr(
        "backend.audio.streaming_post_processor._verify_final_temp",
        lambda *a, **k: None,
    )

    def compress_copy(input_path, output_path, sample_rate, **kwargs):
        dest = Path(output_path).with_suffix(".wav")
        dest.write_bytes(Path(input_path).read_bytes())
        return str(dest), {"input_size": 1, "output_size": 1, "ratio": 0.0}

    monkeypatch.setattr(
        "backend.audio.streaming_post_processor.compress_and_report",
        compress_copy,
    )

    result = finalize_capture(
        coordinator.session_dir / MANIFEST_FILENAME,
        output,
        chunk_frames=256,
        coordinator=coordinator,
    )
    got = _read_wav_int16(Path(result.final_path))
    # Resampled lengths can differ by a few frames due to filter delay flush.
    assert abs(len(got) // 2 - len(ref) // 2) <= 8
    n = min(len(got), len(ref))
    assert _mae_int16(got[:n], ref[:n]) <= 2.0


def test_finalize_leaves_manifest_on_failure(tmp_path, monkeypatch):
    mic = np.full((480, 2), 0.1, dtype=np.float32)
    coordinator, output = _build_session(
        tmp_path,
        profile="macos-v1",
        mic=mic,
        desktop=None,
        dtype="<f4",
        include_desktop=False,
    )
    session_dir = coordinator.session_dir

    def boom(*, ffmpeg_path, output_path, frame_iter, sample_rate=48000):
        # Consume iterator so normalized files exist, then fail.
        for _ in frame_iter:
            pass
        raise RuntimeError("ffmpeg exploded")

    monkeypatch.setattr(
        "backend.audio.streaming_post_processor._stream_final_wav_via_ffmpeg",
        boom,
    )

    with pytest.raises(Exception):
        finalize_capture(
            session_dir / MANIFEST_FILENAME,
            output,
            chunk_frames=120,
            coordinator=coordinator,
        )

    assert session_dir.is_dir()
    assert (session_dir / MANIFEST_FILENAME).is_file()
    assert list(session_dir.glob("mic_*.pcm.part"))
    coordinator.close()


def test_probe_wav_pcm_geometry_roundtrip(tmp_path):
    path = tmp_path / FINAL_CAPTURE_PCM_NAME
    pcm = np.array([0, 1000, -1000, 2000], dtype=np.int16)
    write_int16_pcm_wav(path, pcm, channels=2, sample_rate=48000)
    geometry = probe_wav_pcm_geometry(path)
    assert geometry == {
        "channels": 2,
        "sample_rate": 48000,
        "sample_width": 2,
        "frames": 2,
    }


def test_default_chunk_frames_constant():
    assert DEFAULT_FINALIZATION_CHUNK_FRAMES == 48000
