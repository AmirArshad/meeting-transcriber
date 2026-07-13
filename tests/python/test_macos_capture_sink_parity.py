"""Sink-mode characterization for macOS desktop capture helpers."""

from __future__ import annotations

import threading
from types import SimpleNamespace

import numpy as np
import pytest

from backend.audio.macos_desktop_diagnostics import build_desktop_diagnostics
from backend.audio.swift_audio_capture import SwiftAudioCapture


def test_swift_ingest_sink_mode_keeps_float32_and_skips_session_buffer():
    chunks = []

    def sink(chunk):
        chunks.append(chunk.copy())
        return True

    capture = SwiftAudioCapture.__new__(SwiftAudioCapture)
    capture.channels = 2
    capture.audio_sink = sink
    capture.audio_buffer = []
    capture.buffer_lock = threading.Lock()
    capture._latest_chunk = None
    capture._sink_chunk_count = 0
    capture._sink_sample_count = 0
    capture.first_audio_time = None
    capture.last_audio_time = None
    capture.read_chunk_count = 0
    capture.read_sample_count = 0
    capture.read_peak_level = 0.0
    capture.error_event = threading.Event()
    capture.last_error = None

    payload = np.column_stack(
        [
            np.linspace(0.1, 0.2, 8, dtype=np.float32),
            np.linspace(-0.1, -0.2, 8, dtype=np.float32),
        ]
    )
    assert capture._ingest_audio_chunk(payload, chunk_peak=0.2) is True
    assert len(capture.audio_buffer) == 0
    assert len(chunks) == 1
    assert chunks[0].dtype == np.float32
    assert chunks[0].shape == (8, 2)
    assert capture._sink_sample_count == 8
    assert capture.latest_audio_chunk is not None
    assert np.allclose(capture.latest_audio_chunk, payload)


def test_swift_ingest_sink_rejection_sets_helper_error_event():
    capture = SwiftAudioCapture.__new__(SwiftAudioCapture)
    capture.channels = 2
    capture.audio_sink = lambda _chunk: False
    capture.audio_buffer = []
    capture.buffer_lock = threading.Lock()
    capture._latest_chunk = None
    capture._sink_chunk_count = 0
    capture._sink_sample_count = 0
    capture.first_audio_time = None
    capture.last_audio_time = None
    capture.read_chunk_count = 0
    capture.read_sample_count = 0
    capture.read_peak_level = 0.0
    capture.error_event = threading.Event()
    capture.last_error = None

    chunk = np.zeros((4, 2), dtype=np.float32)
    assert capture._ingest_audio_chunk(chunk, chunk_peak=0.0) is False
    assert capture.error_event.is_set()
    assert "sink rejected" in (capture.last_error or "").lower()
    assert capture._sink_chunk_count == 0
    assert capture._sink_sample_count == 0


def test_swift_stop_sink_mode_preserves_diagnostics_without_returning_buffer():
    capture = SwiftAudioCapture.__new__(SwiftAudioCapture)
    capture.channels = 2
    capture.audio_sink = lambda _chunk: True
    capture.audio_buffer = []
    capture.buffer_lock = threading.Lock()
    capture._sink_chunk_count = 3
    capture._sink_sample_count = 48
    capture.helper_total_sample_buffers = 3
    capture.helper_total_bytes = 384
    capture.process = None
    capture._stdout_thread = None
    capture._stderr_thread = None
    capture._recording_event = threading.Event()
    capture._ready_event = threading.Event()
    capture._recording_event.set()
    capture.warning_lock = threading.Lock()
    capture.warning_messages = []
    capture.warning_event = threading.Event()
    capture.last_captured_chunk_count = 0
    capture.last_captured_sample_count = 0
    capture.last_helper_sample_buffers = 0
    capture.last_helper_bytes = 0
    capture.error_event = threading.Event()
    capture.last_error = None
    capture.is_recording = True  # attribute may not exist; stop uses _recording_event

    result = capture.stop_recording()
    assert result is None
    assert capture.last_captured_chunk_count == 3
    assert capture.last_captured_sample_count == 48
    diagnostics = build_desktop_diagnostics(capture, "swift")
    assert diagnostics["bufferChunks"] == 3
    assert diagnostics["bufferSamples"] == 48
    assert diagnostics["helperSampleBuffers"] == 3


def test_macos_recorder_desktop_sink_failure_degrades_to_mic_only():
    """Late desktop sink/helper failure must warn and leave mic path intact."""
    from backend.audio import macos_recorder as macos_mod

    recorder = macos_mod.MacOSAudioRecorder.__new__(macos_mod.MacOSAudioRecorder)
    recorder._desktop_runtime_failure = None
    recorder._desktop_runtime_warning_sent = False
    recorder._error_event = threading.Event()
    recorder.desktop_capture = SimpleNamespace(
        error_event=threading.Event(),
        last_error="Desktop audio sink rejected audio (writer backpressure)",
    )
    recorder.desktop_capture.error_event.set()

    warned = []

    def fake_warning(code, message, **kwargs):
        warned.append((code, message, kwargs))

    original = macos_mod._send_warning_message
    macos_mod._send_warning_message = fake_warning
    try:
        message = recorder._consume_desktop_helper_failure()
    finally:
        macos_mod._send_warning_message = original

    assert message is not None
    assert recorder._desktop_runtime_failure is not None
    assert warned and warned[0][0] == "DESKTOP_AUDIO_FAILED"
    assert recorder._has_async_recording_error() is False
