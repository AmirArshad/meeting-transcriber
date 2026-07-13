"""Shared WAV writing helpers for recorder post-processing."""

from __future__ import annotations

import struct
import sys
import wave
from pathlib import Path
from typing import Dict, Optional, Union

import numpy as np

from .constants import FINAL_CAPTURE_PCM_NAME

PathLike = Union[str, Path]

__all__ = [
    "FINAL_CAPTURE_PCM_NAME",
    "write_int16_pcm_wav",
    "write_float_stereo_wav",
    "probe_wav_pcm_geometry",
]


def write_int16_pcm_wav(
    path: PathLike,
    pcm: np.ndarray | bytes,
    *,
    channels: int,
    sample_rate: int,
    sample_width: int = 2,
) -> str:
    """
    Write already-encoded int16 PCM to a WAV file.

    ``pcm`` may be a flat/interleaved int16 ndarray (Windows mix output) or raw bytes.
    """
    output = str(path)
    frames = pcm.tobytes() if isinstance(pcm, np.ndarray) else pcm
    with wave.open(output, 'wb') as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(frames)
    return output


def write_float_stereo_wav(
    path: PathLike,
    audio: np.ndarray,
    *,
    sample_rate: int,
    log: bool = True,
) -> str:
    """
    Write float audio in roughly ``[-1, 1]`` as a 16-bit stereo WAV.

    Mono input is duplicated to stereo. Matches the previous macOS ``_save_wav`` behavior.
    """
    output = str(path)
    if len(audio.shape) == 1:
        audio = np.column_stack([audio, audio])

    audio_int = np.clip(audio * 32767, -32768, 32767).astype(np.int16)

    with wave.open(output, 'wb') as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(audio_int.tobytes())

    if log:
        print(f"Saved WAV: {output}", file=sys.stderr)
    return output


def probe_wav_pcm_geometry(path: PathLike) -> Optional[Dict[str, int]]:
    """Return channels/sample_rate/sample_width/frames for a standard or RF64 WAV.

    Returns ``None`` when the file is missing or not a recognizable PCM WAV.
    """
    candidate = Path(path)
    if not candidate.is_file():
        return None

    try:
        with wave.open(str(candidate), "rb") as wf:
            return {
                "channels": int(wf.getnchannels()),
                "sample_rate": int(wf.getframerate()),
                "sample_width": int(wf.getsampwidth()),
                "frames": int(wf.getnframes()),
            }
    except wave.Error:
        pass

    # Minimal RF64 reader for Task 9 temps written with ffmpeg ``-rf64 auto``.
    try:
        with open(candidate, "rb") as handle:
            header = handle.read(12)
            if len(header) < 12:
                return None
            riff = header[0:4]
            wave_tag = header[8:12]
            if wave_tag != b"WAVE":
                return None
            if riff not in (b"RIFF", b"RF64"):
                return None
            handle.seek(12)
            channels = sample_rate = sample_width = None
            data_bytes = None
            while True:
                chunk_header = handle.read(8)
                if len(chunk_header) < 8:
                    break
                chunk_id, chunk_size = struct.unpack("<4sI", chunk_header)
                chunk_size = int(chunk_size)
                payload_start = handle.tell()
                if chunk_id == b"ds64":
                    ds64 = handle.read(min(chunk_size, 28))
                    if len(ds64) >= 28:
                        data_bytes = int(struct.unpack("<Q", ds64[8:16])[0])
                elif chunk_id == b"fmt ":
                    fmt = handle.read(min(chunk_size, 16))
                    if len(fmt) >= 16:
                        _audio_format, ch, rate, _byte_rate, _align, bits = struct.unpack(
                            "<HHIIHH", fmt[:16]
                        )
                        channels = int(ch)
                        sample_rate = int(rate)
                        sample_width = int(bits) // 8
                elif chunk_id == b"data":
                    if data_bytes is None:
                        data_bytes = chunk_size if chunk_size != 0xFFFFFFFF else None
                    break
                handle.seek(payload_start + chunk_size + (chunk_size & 1))
            if channels and sample_rate and sample_width and data_bytes is not None:
                frame_bytes = channels * sample_width
                if frame_bytes <= 0 or data_bytes % frame_bytes != 0:
                    return None
                return {
                    "channels": channels,
                    "sample_rate": sample_rate,
                    "sample_width": sample_width,
                    "frames": data_bytes // frame_bytes,
                }
    except OSError:
        return None
    return None
