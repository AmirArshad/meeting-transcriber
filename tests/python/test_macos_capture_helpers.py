"""Characterization tests for macOS capture helpers (stereo repair, status, diagnostics, align)."""

from __future__ import annotations

import json
import threading
from types import SimpleNamespace

import numpy as np
import pytest

from backend.audio.macos_desktop_diagnostics import (
    build_desktop_diagnostics,
    format_desktop_diagnostics_summary,
)
from backend.audio.macos_stereo_repair import repair_one_sided_stereo
from backend.audio.macos_stream_alignment import align_streams_by_start_time
from backend.audio.swift_helper_status import process_helper_status_line


def _make_capture(**overrides):
    capture = SimpleNamespace(
        error_event=threading.Event(),
        last_error=None,
        _ready_event=threading.Event(),
        warning_messages=[],
        warning_event=threading.Event(),
        warning_lock=threading.Lock(),
        first_audio_time=None,
        last_audio_time=None,
        helper_capture_backend=None,
        helper_content_info=None,
        helper_stream_config=None,
        helper_audio_format=None,
        helper_screen_frames=0,
        helper_total_sample_buffers=0,
        helper_total_bytes=0,
        helper_dropped_chunks=0,
        helper_queued_bytes_remaining=0,
        buffer_lock=threading.Lock(),
        audio_buffer=[],
        read_chunk_count=0,
        read_sample_count=0,
        read_peak_level=0.0,
        last_captured_chunk_count=0,
        last_captured_sample_count=0,
        last_helper_sample_buffers=0,
        last_helper_bytes=0,
    )
    for key, value in overrides.items():
        setattr(capture, key, value)
    return capture


# --- macos_stereo_repair thresholds (product invariants) ---


def test_stereo_repair_leaves_balanced_audio_unchanged():
    audio = np.column_stack([
        np.ones(100, dtype=np.float32) * 0.5,
        np.ones(100, dtype=np.float32) * 0.45,
    ])
    repaired = repair_one_sided_stereo(audio, 'desktop')
    assert repaired is audio or np.allclose(repaired, audio)


def test_stereo_repair_duplicates_dominant_channel_when_one_sided():
    left = np.ones(200, dtype=np.float32) * 0.5
    right = np.zeros(200, dtype=np.float32)
    audio = np.column_stack([left, right])
    repaired = repair_one_sided_stereo(audio, 'desktop')
    assert np.allclose(repaired[:, 0], repaired[:, 1])
    assert float(np.max(np.abs(repaired[:, 0]))) > 0.4


def test_stereo_repair_skips_near_silent_audio():
    audio = np.column_stack([
        np.ones(50, dtype=np.float32) * 1e-6,
        np.zeros(50, dtype=np.float32),
    ])
    repaired = repair_one_sided_stereo(audio, 'mic')
    assert np.allclose(repaired, audio)


def test_stereo_repair_ignores_non_stereo():
    mono = np.ones((40, 1), dtype=np.float32)
    assert repair_one_sided_stereo(mono, 'mic') is mono


# --- swift_helper_status message parsing ---


def test_helper_status_ready_sets_event():
    capture = _make_capture()
    process_helper_status_line(capture, json.dumps({'type': 'ready'}))
    assert capture._ready_event.is_set()


def test_helper_status_warning_forwards_system_audio_help():
    capture = _make_capture()
    process_helper_status_line(capture, json.dumps({
        'type': 'warning',
        'code': 'coreaudio_tap_start_failed',
        'message': 'tap failed',
        'help': 'Grant System Audio Recording',
        'permissionLikely': True,
        'nsErrorCode': 1852796517,
        'nsErrorDomain': 'AudioCaptureHelper.CoreAudio',
        'error': "AudioHardwareCreateProcessTap failed (OSStatus 1852796517 ('nope'))",
    }))
    assert len(capture.warning_messages) == 1
    warning = capture.warning_messages[0]
    assert warning['code'] == 'coreaudio_tap_start_failed'
    assert warning['help'] == 'Grant System Audio Recording'
    assert warning['permissionLikely'] is True
    assert warning['nsErrorCode'] == 1852796517


def test_helper_status_capture_backend_and_silence_gap_filled(capsys):
    capture = _make_capture()
    process_helper_status_line(capture, json.dumps({
        'type': 'capture_backend',
        'backend': 'coreaudio_tap',
    }))
    process_helper_status_line(capture, json.dumps({
        'type': 'silence_gap_filled',
        'duration': 12.5,
        'message': 'Inserted 12.50s of silence for delivery gap',
    }))
    assert capture.helper_capture_backend == 'coreaudio_tap'
    err = capsys.readouterr().err
    assert 'Inserted 12.50s' in err


def test_helper_status_capture_stats_updates_timestamps():
    capture = _make_capture()
    process_helper_status_line(capture, json.dumps({
        'type': 'capture_stats',
        'totalSamples': 10,
        'totalBytes': 1600,
        'captureBackend': 'screencapturekit',
        'firstAudioTimestamp': 100.0,
        'lastAudioTimestamp': 110.0,
        'droppedChunks': 2,
        'screenFrames': 3,
    }))
    assert capture.helper_capture_backend == 'screencapturekit'
    assert capture.first_audio_time == 100.0
    assert capture.last_audio_time == 110.0
    assert capture.helper_dropped_chunks == 2
    assert capture.helper_screen_frames == 3


@pytest.mark.parametrize('msg_type', [
    'config',
    'content_info',
    'stream_config',
    'audio_format',
    'extraction_error',
    'silence_detected',
    'audio_resumed',
    'progress',
    'status',
])
def test_helper_status_known_message_types_do_not_raise(msg_type):
    capture = _make_capture()
    payload = {'type': msg_type, 'message': 'ok', 'status': 'recording', 'samples': 1, 'bytesWritten': 4}
    if msg_type == 'content_info':
        payload.update({'displayCount': 1, 'applicationCount': 2, 'windowCount': 3, 'captureBackend': 'screencapturekit'})
    if msg_type in ('stream_config', 'audio_format', 'status'):
        payload['captureBackend'] = 'coreaudio_tap'
    if msg_type == 'status':
        payload['timestamp'] = 42.0
        payload['status'] = 'first_sample'
    process_helper_status_line(capture, json.dumps(payload))


# --- macos_desktop_diagnostics ---


def test_desktop_diagnostics_empty_capture():
    diagnostics = build_desktop_diagnostics(None, None)
    assert diagnostics['available'] is False
    assert diagnostics['captureType'] == 'none'
    assert diagnostics['bufferChunks'] == 0


def test_desktop_diagnostics_reads_helper_fields():
    capture = _make_capture(
        helper_capture_backend='coreaudio_tap',
        helper_total_sample_buffers=7,
        helper_total_bytes=128,
        helper_dropped_chunks=1,
        read_chunk_count=3,
        read_sample_count=300,
        read_peak_level=0.25,
        audio_buffer=[np.ones((10, 2), dtype=np.float32)],
    )
    diagnostics = build_desktop_diagnostics(capture, 'swift')
    assert diagnostics['helperCaptureBackend'] == 'coreaudio_tap'
    assert diagnostics['helperSampleBuffers'] == 7
    assert diagnostics['helperBytes'] == 128
    assert diagnostics['helperDroppedChunks'] == 1
    assert diagnostics['bufferChunks'] == 1
    assert diagnostics['peakLevel'] == 0.25
    summary = format_desktop_diagnostics_summary(diagnostics)
    assert 'coreaudio_tap' in summary
    assert 'chunks=1' in summary


# --- macos_stream_alignment / preroll trim ---


def test_align_streams_trims_desktop_preroll_samples():
    sample_rate = 100
    preroll = 1.5
    recording_start = 1000.0
    # Desktop started immediately; mic only after preroll.
    mic = np.ones((200, 2), dtype=np.float32)
    desktop = np.arange(350, dtype=np.float32).reshape(350, 1)
    desktop = np.column_stack([desktop, desktop])

    aligned_mic, aligned_desktop = align_streams_by_start_time(
        mic,
        desktop,
        sample_rate=sample_rate,
        recording_start_time=recording_start,
        mic_capture_start_time=recording_start + preroll,
        desktop_capture_start_time=recording_start,
        preroll_seconds=preroll,
    )

    # 1.5s * 100 Hz = 150 samples trimmed from desktop head
    assert len(aligned_desktop) == 200
    assert np.allclose(aligned_desktop[0], [150.0, 150.0])
    assert len(aligned_mic) == 200


def test_align_streams_pads_desktop_when_it_starts_late():
    sample_rate = 100
    mic = np.ones((100, 2), dtype=np.float32)
    desktop = np.ones((100, 2), dtype=np.float32) * 2

    aligned_mic, aligned_desktop = align_streams_by_start_time(
        mic,
        desktop,
        sample_rate=sample_rate,
        recording_start_time=0.0,
        mic_capture_start_time=0.0,
        desktop_capture_start_time=0.5,
        preroll_seconds=0.0,
    )

    assert len(aligned_desktop) == 150
    assert np.allclose(aligned_desktop[:50], 0.0)
    assert np.allclose(aligned_desktop[50:], 2.0)
    assert len(aligned_mic) == 100


def test_align_streams_missing_timestamps_returns_unchanged():
    mic = np.ones((10, 2), dtype=np.float32)
    desktop = np.ones((12, 2), dtype=np.float32)
    out_mic, out_desktop = align_streams_by_start_time(
        mic,
        desktop,
        sample_rate=48000,
        recording_start_time=None,
        mic_capture_start_time=1.0,
        desktop_capture_start_time=1.0,
        preroll_seconds=0.0,
    )
    assert out_mic is mic
    assert out_desktop is desktop
