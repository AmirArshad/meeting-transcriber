"""Shared macOS/Linux capture start-alignment frame geometry."""

from __future__ import annotations

from backend.audio.capture_alignment import compute_capture_alignment_frames


def test_missing_timestamps_or_rate_yield_zero_alignment():
    assert compute_capture_alignment_frames(
        recording_start_time=None,
        mic_capture_start_time=1.0,
        desktop_capture_start_time=1.0,
        sample_rate=48000,
    ) == {
        "desktopTrimFrames": 0,
        "desktopLeadingPadFrames": 0,
        "micLeadingPadFrames": 0,
    }
    assert compute_capture_alignment_frames(
        recording_start_time=0.0,
        mic_capture_start_time=0.0,
        desktop_capture_start_time=0.0,
        sample_rate=0,
    )["desktopLeadingPadFrames"] == 0


def test_desktop_starting_later_sets_leading_pad_not_mic_pad():
    alignment = compute_capture_alignment_frames(
        recording_start_time=10.0,
        mic_capture_start_time=10.0,
        desktop_capture_start_time=10.25,
        sample_rate=48000,
        preroll_seconds=0.0,
    )
    assert alignment["desktopTrimFrames"] == 0
    assert alignment["desktopLeadingPadFrames"] == 12000
    assert alignment["micLeadingPadFrames"] == 0


def test_mic_starting_later_sets_mic_leading_pad():
    alignment = compute_capture_alignment_frames(
        recording_start_time=10.0,
        mic_capture_start_time=10.5,
        desktop_capture_start_time=10.0,
        sample_rate=48000,
        preroll_seconds=0.0,
    )
    assert alignment["desktopTrimFrames"] == 0
    assert alignment["desktopLeadingPadFrames"] == 0
    assert alignment["micLeadingPadFrames"] == 24000


def test_desktop_preroll_is_trimmed_before_pad_geometry():
    alignment = compute_capture_alignment_frames(
        recording_start_time=1000.0,
        mic_capture_start_time=1001.5,
        desktop_capture_start_time=1000.0,
        sample_rate=100,
        preroll_seconds=1.5,
    )
    # Desktop captured during the 1.5s mic preroll is trimmed; remaining
    # start times then match, so neither track needs a leading pad.
    assert alignment["desktopTrimFrames"] == 150
    assert alignment["desktopLeadingPadFrames"] == 0
    assert alignment["micLeadingPadFrames"] == 0
