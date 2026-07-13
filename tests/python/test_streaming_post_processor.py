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
    _stream_final_wav_via_ffmpeg,
)
from backend.audio.wav_io import probe_wav_pcm_geometry, write_int16_pcm_wav
import backend.audio.streaming_post_processor as spp


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


def _patch_finalize_io(monkeypatch):
    """Use in-memory float→WAV writer for equivalence; still exercise real mix path."""

    def fake_finalize_ffmpeg(*, ffmpeg_path, output_path, frame_iter, sample_rate=48000):
        frames = [chunk for chunk in frame_iter if chunk.size]
        audio = np.concatenate(frames, axis=0) if frames else np.zeros((0, 2), dtype=np.float32)
        int16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
        write_int16_pcm_wav(output_path, int16.reshape(-1), channels=2, sample_rate=sample_rate)
        return int(audio.shape[0])

    def compress_copy(input_path, output_path, sample_rate, **kwargs):
        dest = Path(output_path).with_suffix(".wav")
        dest.write_bytes(Path(input_path).read_bytes())
        return str(dest), {
            "input_size": dest.stat().st_size,
            "output_size": dest.stat().st_size,
            "ratio": 0.0,
        }

    monkeypatch.setattr(spp, "_stream_final_wav_via_ffmpeg", fake_finalize_ffmpeg)
    monkeypatch.setattr(spp, "_verify_final_temp", lambda *a, **k: None)
    monkeypatch.setattr(spp, "compress_and_report", compress_copy)
    monkeypatch.setattr(spp, "ffmpeg_can_decode", lambda *a, **k: True)


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


def test_track_frame_reader_stops_at_committed_frames(tmp_path):
    part = tmp_path / "mic_0000.pcm.part"
    # File has 20 frames but manifest commits only 8.
    frames = np.arange(40, dtype=np.int16).reshape(20, 2)
    _write_segment(part, frames)
    reader = TrackFrameReader(
        tmp_path,
        ["mic_0000.pcm.part"],
        channels=2,
        dtype="<i2",
        chunk_frames=16,
        max_chunk_frames=16,
        committed_frames=8,
    )
    got = reader.read_frames()
    assert got.shape == (8, 2)
    assert np.array_equal(got, frames[:8])
    assert reader.read_frames().shape[0] == 0
    reader.close()


def test_streaming_post_processor_source_forbids_bytes_join():
    source = Path(spp.__file__).read_text(encoding="utf-8")
    assert 'b"".join' not in source
    assert "b''.join" not in source


def test_stream_final_wav_via_ffmpeg_writes_real_wav(tmp_path):
    """P0 regression: ffmpeg must get an explicit wav muxer for .pcm.tmp."""
    import shutil

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("ffmpeg not available")

    out = tmp_path / FINAL_CAPTURE_PCM_NAME
    frames = [
        np.full((480, 2), 0.1, dtype=np.float32),
        np.full((480, 2), -0.1, dtype=np.float32),
    ]
    written = _stream_final_wav_via_ffmpeg(
        ffmpeg_path=ffmpeg,
        output_path=out,
        frame_iter=iter(frames),
    )
    assert written == 960
    geometry = probe_wav_pcm_geometry(out)
    assert geometry is not None
    assert geometry["channels"] == 2
    assert geometry["sample_rate"] == 48000
    assert geometry["sample_width"] == 2
    assert abs(geometry["frames"] - 960) <= 1


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
        (
            "mid_stream_gap",
            lambda: (
                np.full((2400, 2), 0.08, dtype=np.float32),
                np.concatenate(
                    [
                        np.zeros((600, 2), dtype=np.float32),
                        np.full((1200, 2), 0.2, dtype=np.float32),
                        np.zeros((600, 2), dtype=np.float32),
                    ],
                    axis=0,
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
    _patch_finalize_io(monkeypatch)

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


def test_macos_v1_initial_offset_alignment_equivalence(tmp_path, monkeypatch):
    mic = np.full((2000, 2), 0.1, dtype=np.float32)
    desk = np.full((1800, 2), 0.05, dtype=np.float32)
    # Simulate desktop starting 200 frames later (leading pad).
    pad = 200
    desk_aligned = np.concatenate(
        [np.zeros((pad, 2), dtype=np.float32), desk],
        axis=0,
    )
    ref = reference_macos_v1_process(mic, desk_aligned, mic_channels=2, desktop_channels=2)
    coordinator, output = _build_session(
        tmp_path,
        profile="macos-v1",
        mic=mic,
        desktop=desk,
        dtype="<f4",
    )
    coordinator.set_alignment(desktop_leading_pad_frames=pad)
    _patch_finalize_io(monkeypatch)
    result = finalize_capture(
        coordinator.session_dir / MANIFEST_FILENAME,
        output,
        chunk_frames=250,
        coordinator=coordinator,
    )
    got = _read_wav_int16(Path(result.final_path))
    assert abs(len(got) - len(ref)) <= 2
    assert _mae_int16(got, ref) <= 2.0


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
    _patch_finalize_io(monkeypatch)

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
    _patch_finalize_io(monkeypatch)

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


def test_finalize_leaves_manifest_on_failure_and_promotes_stable_wav(tmp_path, monkeypatch):
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
        # Write a minimal valid temp then fail verify-equivalent path via raise after write.
        frames = [chunk for chunk in frame_iter if chunk.size]
        audio = np.concatenate(frames, axis=0) if frames else np.zeros((0, 2), dtype=np.float32)
        int16 = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
        write_int16_pcm_wav(output_path, int16.reshape(-1), channels=2, sample_rate=sample_rate)
        raise RuntimeError("ffmpeg exploded after write")

    monkeypatch.setattr(spp, "_stream_final_wav_via_ffmpeg", boom)

    with pytest.raises(Exception) as exc:
        finalize_capture(
            session_dir / MANIFEST_FILENAME,
            output,
            chunk_frames=120,
            coordinator=coordinator,
        )

    assert session_dir.is_dir()
    assert (session_dir / MANIFEST_FILENAME).is_file()
    assert list(session_dir.glob("mic_*.pcm.part"))
    # Recoverable path must be a stable meeting-dir wav, not .capture/final.pcm.tmp
    err = exc.value
    while hasattr(err, "__cause__") and err.__cause__ is not None and not getattr(err, "recoverable_path", None):
        err = err.__cause__
    # FinalizationError may wrap RuntimeError; walk for recoverable_path
    from backend.audio.streaming_post_processor import FinalizationError

    recoverable = None
    cur = exc.value
    while cur is not None:
        if isinstance(cur, FinalizationError):
            recoverable = cur.recoverable_path
            break
        cur = cur.__cause__
    if recoverable:
        assert FINAL_CAPTURE_PCM_NAME not in recoverable
        assert recoverable.endswith(".wav")
        assert Path(recoverable).is_file()
    coordinator.close()


def test_finalize_honors_committed_frames_not_segment_tail(tmp_path, monkeypatch):
    mic = np.full((100, 2), 0.2, dtype=np.float32)
    coordinator, output = _build_session(
        tmp_path,
        profile="macos-v1",
        mic=mic,
        desktop=None,
        dtype="<f4",
        include_desktop=False,
    )
    # Append uncommitted tail bytes to the segment file after commit.
    seg = coordinator.session_dir / "mic_0000.pcm.part"
    with open(seg, "ab") as handle:
        handle.write(np.full((500, 2), 0.9, dtype=np.float32).tobytes())
    # Manifest still says 100 frames.
    assert coordinator.get_track("mic")["committedFrames"] == 100
    _patch_finalize_io(monkeypatch)
    result = finalize_capture(
        coordinator.session_dir / MANIFEST_FILENAME,
        output,
        chunk_frames=32,
        coordinator=coordinator,
    )
    got = _read_wav_int16(Path(result.final_path))
    assert got.shape[0] // 2 == 100


def test_finalize_rejects_short_committed_track_and_preserves_capture(
    tmp_path, monkeypatch
):
    """P1: over-claimed committedFrames must fail; never delete .capture."""
    from backend.audio.streaming_post_processor import FinalizationError

    mic = np.full((480, 2), 0.1, dtype=np.float32)
    coordinator, output = _build_session(
        tmp_path,
        profile="macos-v1",
        mic=mic,
        desktop=None,
        dtype="<f4",
        include_desktop=False,
    )
    # Manifest claims 960 but only 480 frames exist on disk.
    coordinator.commit_track("mic", ["mic_0000.pcm.part"], committed_frames=960)
    session_dir = coordinator.session_dir
    _patch_finalize_io(monkeypatch)
    with pytest.raises(FinalizationError, match="short of committed"):
        finalize_capture(
            session_dir / MANIFEST_FILENAME,
            output,
            chunk_frames=120,
            coordinator=coordinator,
        )
    assert session_dir.is_dir()
    assert (session_dir / MANIFEST_FILENAME).is_file()
    assert (session_dir / "mic_0000.pcm.part").is_file()
    assert coordinator.get_track("mic")["committedFrames"] == 960


def test_ffmpeg_can_decode_rejects_truncated_wav(tmp_path):
    """P1: geometry-readable truncated WAVs must fail decode with -xerror."""
    import shutil

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("ffmpeg not available")

    path = tmp_path / "truncated.wav"
    pcm = np.zeros(2000 * 2, dtype=np.int16)
    write_int16_pcm_wav(path, pcm, channels=2, sample_rate=48000)
    data = path.read_bytes()
    # Keep RIFF header + only a fraction of PCM so ffmpeg hits Invalid PCM packet.
    path.write_bytes(data[:44 + 200 * 4])
    assert probe_wav_pcm_geometry(path) is not None
    assert spp.ffmpeg_can_decode(path, ffmpeg) is False
    assert (
        spp._copy_recoverable_wav(path, tmp_path / "meeting.opus", ffmpeg_path=ffmpeg)
        is None
    )


def test_windows_enhance_skips_alignment_silence(tmp_path):
    """P1: Windows mic enhance must not DC-shift zero-padded alignment silence."""
    from backend.audio.processor import plan_channel_enhance
    from backend.audio.streaming_post_processor import _OneSidedDecision

    mic = np.full((100, 2), 0.2, dtype=np.float32)
    desk = np.full((200, 2), 0.05, dtype=np.float32)
    mic_path = tmp_path / "norm_mic.f32"
    desk_path = tmp_path / "norm_desk.f32"
    spp._write_float32_chunk(mic_path, mic, append=False)
    spp._write_float32_chunk(desk_path, desk, append=False)
    left = plan_channel_enhance(mic[:, 0])
    right = plan_channel_enhance(mic[:, 1])
    assert abs(left.mean - 0.2) < 1e-5

    # Leading mic pad + longer desktop (desktop-only tail).
    mixed = np.concatenate(
        list(
            spp._iter_aligned_mix_chunks(
                mic_path=mic_path,
                desk_path=desk_path,
                mic_frames=100,
                desk_frames=200,
                total_frames=220,
                chunk_frames=50,
                mic_pad=20,
                desk_pad=0,
                desk_trim=0,
                include_desktop=True,
                profile="windows-v1",
                mic_volume=1.0,
                desktop_volume=0.0,
                mic_boost=1.0,
                mic_one_sided=_OneSidedDecision(False),
                desk_one_sided=_OneSidedDecision(False),
                mic_enhance=(left, right),
                apply_mix_limit=False,
            )
        ),
        axis=0,
    )
    assert mixed.shape == (220, 2)
    # Buggy path subtracted mic mean from pads → ~-0.2; correct path keeps true zeros.
    leading = mixed[:20]
    trailing = mixed[120:]
    assert float(np.max(np.abs(leading))) < 1e-6
    assert float(np.max(np.abs(trailing))) < 1e-6


def test_finalize_never_requests_oversize_chunks(tmp_path, monkeypatch):
    mic = np.full((64, 2), 0.1, dtype=np.float32)
    coordinator, output = _build_session(
        tmp_path,
        profile="macos-v1",
        mic=mic,
        desktop=None,
        dtype="<f4",
        include_desktop=False,
    )
    chunk_frames = 16
    reader_requests = []
    original_reader = TrackFrameReader.read_frames

    def spy_reader(self, frame_count=None):
        requested = self.chunk_frames if frame_count is None else int(frame_count)
        reader_requests.append(requested)
        assert requested <= self._max_chunk_frames
        return original_reader(self, frame_count)

    original_float_read = spp._read_float32_stereo_chunk

    def spy_float_read(path, start_frame, frame_count):
        assert frame_count <= chunk_frames
        return original_float_read(path, start_frame, frame_count)

    monkeypatch.setattr(TrackFrameReader, "read_frames", spy_reader)
    monkeypatch.setattr(spp, "_read_float32_stereo_chunk", spy_float_read)
    _patch_finalize_io(monkeypatch)
    finalize_capture(
        coordinator.session_dir / MANIFEST_FILENAME,
        output,
        chunk_frames=chunk_frames,
        coordinator=coordinator,
    )
    assert reader_requests
    assert max(reader_requests) <= chunk_frames


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


def test_windows_aligned_frame_count_caps_at_mic():
    from audio.streaming_post_processor import _aligned_frame_count

    mic_pad, desk_pad, total = _aligned_frame_count(
        1000,
        5000,
        include_desktop=True,
        alignment={
            "micLeadingPadFrames": 0,
            "desktopTrimFrames": 0,
            "desktopLeadingPadFrames": 0,
        },
        profile="windows-v1",
    )
    assert total == 1000
    assert mic_pad == 0
    assert desk_pad == 0

    _, _, macos_total = _aligned_frame_count(
        1000,
        5000,
        include_desktop=True,
        alignment={
            "micLeadingPadFrames": 0,
            "desktopTrimFrames": 0,
            "desktopLeadingPadFrames": 0,
        },
        profile="macos-v1",
    )
    assert macos_total == 5000


def test_final_duration_matches_expectation():
    from audio.streaming_post_processor import final_duration_matches_expectation

    assert final_duration_matches_expectation(120.0, 120.0) is True
    assert final_duration_matches_expectation(118.0, 120.0) is True  # within 3s slack
    assert final_duration_matches_expectation(110.0, 120.0) is False  # 10% short is NOT ok
    assert final_duration_matches_expectation(12.0, 120.0) is False
    assert final_duration_matches_expectation(None, 120.0) is False
    assert final_duration_matches_expectation(120.0, None) is False


def test_expected_output_duration_windows_caps_at_mic():
    from audio.streaming_post_processor import expected_output_duration_seconds

    data = {
        "processingProfile": "windows-v1",
        "includeDesktop": True,
        "alignment": {
            "micLeadingPadFrames": 0,
            "desktopTrimFrames": 0,
            "desktopLeadingPadFrames": 0,
        },
        "tracks": {
            "mic": {"committedFrames": 48000 * 60, "sampleRate": 48000},
            "desktop": {"committedFrames": 48000 * 120, "sampleRate": 48000},
        },
    }
    assert expected_output_duration_seconds(data) == 60.0

    data["processingProfile"] = "macos-v1"
    assert expected_output_duration_seconds(data) == 120.0
