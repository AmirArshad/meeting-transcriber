"""macOS desktop-capture diagnostics payload helpers."""

from __future__ import annotations

from typing import Any, Optional


def build_desktop_diagnostics(capture: Any, capture_type: Optional[str]) -> dict:
    """Build the desktop capture diagnostics dict from a capture object."""
    diagnostics = {
        'captureType': capture_type or 'none',
        'available': capture is not None,
        'bufferChunks': 0,
        'bufferSamples': 0,
        'peakLevel': 0.0,
        'firstAudioTime': None,
        'lastAudioTime': None,
        'helperSampleBuffers': 0,
        'helperBytes': 0,
        'helperScreenFrames': 0,
        'helperDroppedChunks': 0,
        'helperQueuedBytesRemaining': 0,
        'helperCaptureBackend': None,
        'helperAudioFormat': None,
        'helperContentInfo': None,
        'helperStreamConfig': None,
    }

    if capture is None:
        return diagnostics

    read_chunks = int(getattr(capture, 'read_chunk_count', 0) or 0)
    read_samples = int(getattr(capture, 'read_sample_count', 0) or 0)
    try:
        with capture.buffer_lock:
            live_buffer = getattr(capture, 'audio_buffer', []) or []
            buffer_chunks = int(
                getattr(capture, 'last_captured_chunk_count', 0) or len(live_buffer)
            )
            buffer_samples = int(
                getattr(capture, 'last_captured_sample_count', 0) or sum(len(chunk) for chunk in live_buffer)
            )
            diagnostics['bufferChunks'] = buffer_chunks if buffer_chunks > 0 else read_chunks
            diagnostics['bufferSamples'] = buffer_samples if buffer_samples > 0 else read_samples
            diagnostics['peakLevel'] = float(getattr(capture, 'read_peak_level', 0.0) or 0.0)
    except Exception as error:
        diagnostics['error'] = f'Could not read desktop buffer diagnostics: {error}'

    diagnostics['firstAudioTime'] = getattr(capture, 'first_audio_time', None)
    diagnostics['lastAudioTime'] = getattr(capture, 'last_audio_time', None)
    diagnostics['readChunks'] = read_chunks
    diagnostics['readSamples'] = read_samples
    diagnostics['helperSampleBuffers'] = int(
        getattr(capture, 'helper_total_sample_buffers', 0)
        or getattr(capture, 'last_helper_sample_buffers', 0)
        or 0
    )
    diagnostics['helperBytes'] = int(
        getattr(capture, 'helper_total_bytes', 0)
        or getattr(capture, 'last_helper_bytes', 0)
        or 0
    )
    diagnostics['helperScreenFrames'] = int(getattr(capture, 'helper_screen_frames', 0) or 0)
    diagnostics['helperDroppedChunks'] = int(getattr(capture, 'helper_dropped_chunks', 0) or 0)
    diagnostics['helperQueuedBytesRemaining'] = int(getattr(capture, 'helper_queued_bytes_remaining', 0) or 0)
    diagnostics['helperCaptureBackend'] = getattr(capture, 'helper_capture_backend', None)
    diagnostics['helperAudioFormat'] = getattr(capture, 'helper_audio_format', None)
    diagnostics['helperContentInfo'] = getattr(capture, 'helper_content_info', None)
    diagnostics['helperStreamConfig'] = getattr(capture, 'helper_stream_config', None)
    return diagnostics


def format_desktop_diagnostics_summary(diagnostics: dict) -> str:
    """Human-readable one-line summary for stderr / warning payloads."""
    return (
        f"Desktop capture diagnostics: type={diagnostics['captureType']}, "
        f"backend={diagnostics['helperCaptureBackend'] or 'unknown'}, "
        f"chunks={diagnostics['bufferChunks']}, samples={diagnostics['bufferSamples']}, "
        f"peak={diagnostics['peakLevel']:.6f}, helperBuffers={diagnostics['helperSampleBuffers']}, "
        f"helperBytes={diagnostics['helperBytes']}, helperScreenFrames={diagnostics['helperScreenFrames']}"
    )
