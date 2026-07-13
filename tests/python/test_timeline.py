import numpy as np

from backend.audio.timeline import (
    interleaved_sample_position_to_frame_position,
    reconstruct_desktop_timeline,
    timestamp_to_frame_position,
)
from backend.audio.capture_manifest import CaptureManifestCoordinator
from backend.audio.track_spool import TrackSpool
from backend.audio.capture_spool_runtime import load_track_pcm_array


def _frame(samples):
    return np.array(samples, dtype=np.int16).tobytes()


def test_reconstruct_desktop_timeline_returns_empty_when_no_frames():
    output = reconstruct_desktop_timeline(
        desktop_frames=[],
        mic_frames=[_frame([1, 2, 3, 4])],
        mic_first_capture_time=100.0,
        mic_sample_rate=4,
        mic_channels=1,
        loopback_sample_rate=4,
        loopback_channels=1,
    )

    assert np.array_equal(output, np.array([], dtype=np.int16))


def test_reconstruct_desktop_timeline_inserts_silence_for_gaps():
    output = reconstruct_desktop_timeline(
        desktop_frames=[
            (100.0, _frame([1, 1])),
            (101.0, _frame([2, 2])),
        ],
        mic_frames=[_frame([9, 9, 9, 9, 9, 9, 9, 9])],
        mic_first_capture_time=100.0,
        mic_sample_rate=4,
        mic_channels=1,
        loopback_sample_rate=4,
        loopback_channels=1,
    )

    assert np.array_equal(
        output,
        np.array([1, 1, 0, 0, 2, 2, 0, 0], dtype=np.int16),
    )


def test_reconstruct_desktop_timeline_trims_overlap_and_skips_pre_reference_frames():
    output = reconstruct_desktop_timeline(
        desktop_frames=[
            (99.0, _frame([9, 9])),
            (100.0, _frame([1, 2, 3, 4])),
            (100.5, _frame([5, 6, 7, 8])),
        ],
        mic_frames=[_frame([0, 0, 0, 0, 0, 0])],
        mic_first_capture_time=100.0,
        mic_sample_rate=4,
        mic_channels=1,
        loopback_sample_rate=4,
        loopback_channels=1,
    )

    assert np.array_equal(output, np.array([1, 2, 3, 4, 7, 8], dtype=np.int16))


def test_reconstruct_desktop_timeline_accepts_precomputed_mic_total_bytes():
    desktop_frames = [
        (100.0, _frame([1, 1])),
        (101.0, _frame([2, 2])),
    ]
    mic_frames = [_frame([9, 9, 9, 9, 9, 9, 9, 9])]

    output = reconstruct_desktop_timeline(
        desktop_frames=desktop_frames,
        mic_frames=mic_frames,
        mic_first_capture_time=100.0,
        mic_sample_rate=4,
        mic_channels=1,
        loopback_sample_rate=4,
        loopback_channels=1,
        mic_total_bytes=len(mic_frames[0]),
    )

    assert np.array_equal(
        output,
        np.array([1, 1, 0, 0, 2, 2, 0, 0], dtype=np.int16),
    )


def test_timestamp_to_frame_position_is_per_channel_not_interleaved():
    # Stereo at 4 Hz: 1.0s offset → 4 frames, not 8 interleaved samples.
    assert timestamp_to_frame_position(101.0, 100.0, sample_rate=4) == 4
    assert interleaved_sample_position_to_frame_position(8, channels=2) == 4
    assert timestamp_to_frame_position(99.0, 100.0, sample_rate=4) == -1


def test_spool_frame_placement_matches_reconstruct_desktop_timeline(tmp_path):
    """Parity: materializing gaps via TrackSpool frame_position matches reconstruct()."""
    desktop_frames = [
        (100.0, _frame([1, 1, 1, 1])),  # stereo frames as interleaved int16
        (101.0, _frame([2, 2, 2, 2])),
    ]
    # 2 seconds of stereo mic at 4 Hz → 16 interleaved samples
    mic_frames = [_frame([9] * 16)]
    expected = reconstruct_desktop_timeline(
        desktop_frames=desktop_frames,
        mic_frames=mic_frames,
        mic_first_capture_time=100.0,
        mic_sample_rate=4,
        mic_channels=2,
        loopback_sample_rate=4,
        loopback_channels=2,
    )

    coordinator = CaptureManifestCoordinator.create(
        tmp_path / "recording_parity.opus",
        started_at_ns=1,
        started_at_iso="2026-07-13T20:00:00.000Z",
    )
    try:
        coordinator.add_track("desktop", sample_rate=4, channels=2, dtype="<i2")
        spool = TrackSpool(
            coordinator,
            coordinator.session_dir,
            "desktop",
            sample_rate=4,
            channels=2,
            dtype="<i2",
            max_queue_bytes=1024 * 1024,
            segment_bytes=64 * 1024,
            stall_timeout_s=5,
            flush_interval_s=0.05,
        )
        for timestamp, payload in desktop_frames:
            frame_pos = timestamp_to_frame_position(timestamp, 100.0, sample_rate=4)
            assert frame_pos >= 0
            assert spool.append(payload, frame_position=frame_pos)
        # Match reconstruct's mic-derived target: 16 interleaved samples / 2 ch = 8 frames
        result = spool.close(final_frame_count=8)
        assert result.committed_frames == 8
        track = coordinator.get_track("desktop")
        placed = load_track_pcm_array(
            coordinator.session_dir,
            track["segments"],
            dtype="<i2",
            channels=2,
        )
        assert np.array_equal(placed.reshape(-1), expected)
    finally:
        coordinator.close()
