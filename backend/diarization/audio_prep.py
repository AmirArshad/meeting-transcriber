"""Diarization audio preparation helpers (ffmpeg 16 kHz mono WAV + in-memory load)."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, Dict

MAX_IN_MEMORY_AUDIO_SECONDS = 45 * 60


def build_audio_conversion_command(ffmpeg_path: str, source_path: Path, target_path: Path) -> list[str]:
    return [
        ffmpeg_path,
        "-y",
        "-i",
        str(source_path),
        "-ac",
        "1",
        "-ar",
        "16000",
        str(target_path),
    ]


def prepare_diarization_audio(audio_path: str, work_dir: str, *, ffmpeg_path: str = "ffmpeg") -> Path:
    source_path = Path(audio_path)
    if not source_path.exists():
        raise FileNotFoundError(f"Audio file not found: {source_path}")

    target_path = Path(work_dir) / f"{source_path.stem}.diarization.16k.wav"
    command = build_audio_conversion_command(ffmpeg_path, source_path, target_path)
    result = subprocess.run(command, capture_output=True, text=True, check=False)

    if result.returncode != 0:
        raise RuntimeError(f"Could not prepare audio for diarization with ffmpeg (exit code {result.returncode}).")
    if not target_path.exists():
        raise RuntimeError("ffmpeg did not create the diarization WAV file.")

    return target_path


def get_audio_duration_seconds(audio_path: Path) -> float:
    import wave

    try:
        # prepare_diarization_audio writes uncompressed PCM WAV. If that ever
        # changes, fail closed into file-path mode instead of loading blindly.
        with wave.open(str(audio_path), "rb") as handle:
            frame_rate = handle.getframerate()
            if frame_rate <= 0:
                return 0.0
            return float(handle.getnframes()) / float(frame_rate)
    except (wave.Error, OSError):
        return 0.0


def should_load_audio_in_memory(audio_path: Path, *, max_seconds: int = MAX_IN_MEMORY_AUDIO_SECONDS) -> bool:
    duration = get_audio_duration_seconds(audio_path)
    return duration > 0 and duration <= max_seconds


def load_prepared_audio_for_pipeline(audio_path: Path) -> Dict[str, Any]:
    """Load prepared 16 kHz mono WAV into memory for pyannote inference.

    Uses the stdlib ``wave`` module so diarization does not depend on torchcodec
    or torchaudio file decoders. pyannote 4.x only defines ``AudioDecoder`` when
    torchcodec loads successfully; passing a file path crashes with
    ``NameError: name 'AudioDecoder' is not defined`` when it does not.
    """
    import wave

    try:
        import torch  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError("PyTorch is not installed for speaker diarization.") from exc

    try:
        with wave.open(str(audio_path), "rb") as handle:
            sample_rate = handle.getframerate()
            channels = handle.getnchannels()
            sample_width = handle.getsampwidth()
            n_frames = handle.getnframes()
            raw = handle.readframes(n_frames)
    except (wave.Error, OSError) as exc:
        raise RuntimeError(f"Could not read prepared diarization WAV: {audio_path}") from exc

    if sample_rate <= 0 or n_frames <= 0:
        raise RuntimeError("Prepared diarization WAV is empty or has an invalid sample rate.")

    if sample_width == 2:
        samples = torch.frombuffer(bytearray(raw), dtype=torch.int16).to(torch.float32) / 32768.0
    elif sample_width == 4:
        samples = torch.frombuffer(bytearray(raw), dtype=torch.int32).to(torch.float32) / 2147483648.0
    elif sample_width == 1:
        samples = torch.frombuffer(bytearray(raw), dtype=torch.uint8).to(torch.float32)
        samples = (samples - 128.0) / 128.0
    else:
        raise RuntimeError(f"Unsupported diarization WAV sample width: {sample_width} bytes.")

    if channels > 1:
        samples = samples.view(-1, channels).mean(dim=1)

    return {"waveform": samples.unsqueeze(0), "sample_rate": int(sample_rate)}
