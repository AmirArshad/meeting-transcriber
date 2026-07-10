"""Swift helper stderr JSON status payload application."""

from __future__ import annotations

import json
import sys
from typing import Any


def apply_helper_error(capture: Any, payload: dict) -> None:
    """Store the first actionable helper error for startup reporting."""
    error = payload.get('error', '')
    code = payload.get('code', 'unknown')

    if not capture.error_event.is_set():
        capture.last_error = error
        if code == 'permission_denied':
            capture.last_error = f"PERMISSION_DENIED: {error}"
    capture.error_event.set()


def process_helper_status_line(capture: Any, line: str) -> None:
    """Handle one stderr status line from the Swift helper."""
    try:
        msg = json.loads(line)
        msg_type = msg.get('type', '')

        if msg_type == 'ready':
            capture._ready_event.set()
            print("Swift helper: READY", file=sys.stderr)

        elif msg_type == 'status':
            status = msg.get('status', '')
            message = msg.get('message', '')
            timestamp = msg.get('timestamp')

            if status == 'first_sample' and isinstance(timestamp, (int, float)):
                helper_timestamp = float(timestamp)
                if capture.first_audio_time is None or helper_timestamp < capture.first_audio_time:
                    capture.first_audio_time = helper_timestamp
            elif status == 'screen_sample':
                screen_frames = msg.get('screenFrames')
                if isinstance(screen_frames, int):
                    capture.helper_screen_frames = screen_frames
            capture_backend = msg.get('captureBackend')
            if isinstance(capture_backend, str) and capture_backend:
                capture.helper_capture_backend = capture_backend

            print(f"Swift helper: {status} - {message}", file=sys.stderr)

        elif msg_type == 'warning':
            code = msg.get('code', 'warning')
            message = msg.get('message', 'Swift helper warning')
            warning_payload = {
                'type': 'warning',
                'code': code,
                'message': message,
            }

            for key in ('help', 'droppedChunks', 'queuedBytes', 'permissionLikely',
                        'nsErrorCode', 'nsErrorDomain', 'error'):
                if key in msg:
                    warning_payload[key] = msg[key]

            with capture.warning_lock:
                capture.warning_messages.append(warning_payload)
                capture.warning_event.set()
            print(f"Swift helper WARNING [{code}]: {message}", file=sys.stderr)

        elif msg_type == 'error':
            error = msg.get('error', '')
            code = msg.get('code', 'unknown')
            help_text = msg.get('help', '')

            print(f"Swift helper ERROR [{code}]: {error}", file=sys.stderr)
            if help_text:
                print(f"  Help: {help_text}", file=sys.stderr)

            msg['error'] = error
            msg['code'] = code
            apply_helper_error(capture, msg)

        elif msg_type == 'config':
            print(f"Swift helper config: {msg}", file=sys.stderr)

        elif msg_type == 'content_info':
            capture.helper_content_info = dict(msg)
            capture_backend = msg.get('captureBackend')
            if isinstance(capture_backend, str) and capture_backend:
                capture.helper_capture_backend = capture_backend
            print(
                "Swift helper: content - "
                f"displays={msg.get('displayCount', 'unknown')}, "
                f"apps={msg.get('applicationCount', 'unknown')}, "
                f"windows={msg.get('windowCount', 'unknown')}",
                file=sys.stderr,
            )

        elif msg_type == 'stream_config':
            capture.helper_stream_config = dict(msg)
            capture_backend = msg.get('captureBackend')
            if isinstance(capture_backend, str) and capture_backend:
                capture.helper_capture_backend = capture_backend
            print(f"Swift helper stream config: {msg}", file=sys.stderr)

        elif msg_type == 'capture_backend':
            capture_backend = msg.get('backend')
            if isinstance(capture_backend, str) and capture_backend:
                capture.helper_capture_backend = capture_backend
            print(f"Swift helper backend: {capture_backend or 'unknown'}", file=sys.stderr)

        elif msg_type == 'audio_format':
            rate = msg.get('sampleRate', 'unknown')
            channels = msg.get('channels', 'unknown')
            capture.helper_audio_format = dict(msg)
            capture_backend = msg.get('captureBackend')
            if isinstance(capture_backend, str) and capture_backend:
                capture.helper_capture_backend = capture_backend
            print(f"Swift helper: Audio format - {rate}Hz, {channels} channels", file=sys.stderr)

        elif msg_type == 'extraction_error':
            error = msg.get('error', 'unknown')
            count = msg.get('count', 0)
            print(f"Swift helper: Audio extraction error #{count}: {error}", file=sys.stderr)

        elif msg_type == 'silence_detected':
            message = msg.get('message', 'Silence detected')
            print(f"Swift helper: {message}", file=sys.stderr)

        elif msg_type == 'silence_gap_filled':
            message = msg.get('message', 'Silence gap filled')
            duration = msg.get('duration')
            print(
                f"Swift helper: {message}"
                + (f" (duration={duration}s)" if duration is not None else ""),
                file=sys.stderr,
            )

        elif msg_type == 'audio_resumed':
            message = msg.get('message', 'Audio resumed')
            print(f"Swift helper: {message}", file=sys.stderr)

        elif msg_type == 'progress':
            samples = msg.get('samples', 0)
            bytes_written = msg.get('bytesWritten', 0)
            print(f"Swift helper: Progress - {samples} samples, {bytes_written / 1024:.1f} KB", file=sys.stderr)

        elif msg_type == 'capture_stats':
            total_samples = msg.get('totalSamples', 0)
            total_bytes = msg.get('totalBytes', 0)
            capture_backend = msg.get('captureBackend')
            if isinstance(capture_backend, str) and capture_backend:
                capture.helper_capture_backend = capture_backend
            capture.helper_total_sample_buffers = int(total_samples) if isinstance(total_samples, int) else 0
            capture.helper_total_bytes = int(total_bytes) if isinstance(total_bytes, int) else 0
            capture.helper_screen_frames = int(msg.get('screenFrames', 0) or 0)
            capture.helper_dropped_chunks = int(msg.get('droppedChunks', 0) or 0)
            capture.helper_queued_bytes_remaining = int(msg.get('queuedBytesRemaining', 0) or 0)
            first_audio_timestamp = msg.get('firstAudioTimestamp')
            last_audio_timestamp = msg.get('lastAudioTimestamp')
            if isinstance(first_audio_timestamp, (int, float)):
                helper_timestamp = float(first_audio_timestamp)
                if capture.first_audio_time is None or helper_timestamp < capture.first_audio_time:
                    capture.first_audio_time = helper_timestamp
            if isinstance(last_audio_timestamp, (int, float)):
                capture.last_audio_time = float(last_audio_timestamp)
            print(f"Swift helper: Final stats - {total_samples} samples, {total_bytes / 1024:.1f} KB", file=sys.stderr)

    except json.JSONDecodeError:
        print(f"Swift helper: {line}", file=sys.stderr)
