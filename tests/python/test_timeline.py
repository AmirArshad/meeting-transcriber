import numpy as np

from backend.audio.timeline import reconstruct_desktop_timeline


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
