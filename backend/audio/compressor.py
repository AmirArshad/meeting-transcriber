"""
Audio compression utilities using ffmpeg.

Provides high-quality Opus compression with fallback to WAV.
"""

import sys
import subprocess
import shutil
import json
from pathlib import Path

from .constants import OPUS_BITRATE, OPUS_COMPRESSION_LEVEL, OPUS_APPLICATION


def compress_to_opus(
    input_path: str,
    output_path: str,
    sample_rate: int,
    bitrate: str | None = None,
    compression_level: int | None = None,
    application: str | None = None
) -> str:
    """
    Compress audio to Opus format using ffmpeg.

    Args:
        input_path: Path to input WAV file
        output_path: Desired output path (extension will be changed to .opus)
        sample_rate: Output sample rate to preserve
        bitrate: Opus bitrate (e.g., '128k'). Defaults to OPUS_BITRATE
        compression_level: 0-10, higher = better quality. Defaults to OPUS_COMPRESSION_LEVEL
        application: 'audio', 'voip', or 'lowdelay'. Defaults to OPUS_APPLICATION

    Returns:
        Path to the output file (`.opus` on success, `.wav` fallback on failure)
    """
    bitrate = bitrate or OPUS_BITRATE
    compression_level = compression_level if compression_level is not None else OPUS_COMPRESSION_LEVEL
    application = application or OPUS_APPLICATION

    # Change extension to .opus
    opus_path = str(Path(output_path).with_suffix('.opus'))
    wav_path = str(Path(output_path).with_suffix('.wav'))

    def _cleanup_bad_opus_file():
        opus_file = Path(opus_path)
        if opus_file.exists():
            try:
                opus_file.unlink()
            except OSError:
                pass

    cmd = [
        'ffmpeg',
        '-i', input_path,
        '-c:a', 'libopus',
        '-b:a', bitrate,
        '-vbr', 'on',
        '-compression_level', str(compression_level),
        '-application', application,
        '-ar', str(sample_rate),
        '-y',  # Overwrite output
        '-loglevel', 'error',
        opus_path
    ]

    try:
        result = subprocess.run(cmd, check=True, capture_output=True)

        # Verify recording integrity
        if not verify_recording_integrity(opus_path):
            print(f"WARNING: Recording integrity check failed", file=sys.stderr)
            print(f"Falling back to WAV format...", file=sys.stderr)
            _cleanup_bad_opus_file()
            shutil.copy(input_path, wav_path)
            return wav_path

        return opus_path

    except FileNotFoundError:
        print(f"Warning: ffmpeg not found in PATH", file=sys.stderr)
        print(f"Falling back to WAV format (audio will be larger)...", file=sys.stderr)
        _cleanup_bad_opus_file()
        shutil.copy(input_path, wav_path)
        return wav_path

    except subprocess.CalledProcessError as e:
        print(f"Warning: ffmpeg compression failed: {e.stderr.decode()}", file=sys.stderr)
        print(f"Falling back to WAV format...", file=sys.stderr)
        _cleanup_bad_opus_file()
        shutil.copy(input_path, wav_path)
        return wav_path


def verify_recording_integrity(file_path: str) -> bool:
    """
    Verify the recording file is valid and playable using ffprobe.

    Args:
        file_path: Path to audio file to verify

    Returns:
        True if file is valid, False otherwise
    """
    ffprobe_path = shutil.which('ffprobe')
    if not ffprobe_path:
        print(f"  Skipping integrity check (ffprobe not found)", file=sys.stderr)
        return True  # Assume OK if we can't check

    try:
        cmd = [
            ffprobe_path,
            '-v', 'error',
            '-show_format',
            '-show_streams',
            '-of', 'json',
            file_path
        ]

        result = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=30
        )

        if result.returncode != 0:
            print(f"  Integrity check FAILED: {result.stderr}", file=sys.stderr)
            return False

        probe_data = json.loads(result.stdout)

        # Check for valid format
        if 'format' not in probe_data:
            print(f"  Integrity check FAILED: No format info", file=sys.stderr)
            return False

        # Check for audio stream
        streams = probe_data.get('streams', [])
        audio_streams = [s for s in streams if s.get('codec_type') == 'audio']

        if not audio_streams:
            print(f"  Integrity check FAILED: No audio streams", file=sys.stderr)
            return False

        # Check duration is positive
        duration = float(probe_data['format'].get('duration', 0))
        if duration <= 0:
            print(f"  Integrity check FAILED: Invalid duration ({duration}s)", file=sys.stderr)
            return False

        print(f"  Integrity check: OK ({duration:.1f}s, {audio_streams[0].get('codec_name', 'unknown')})", file=sys.stderr)
        return True

    except subprocess.TimeoutExpired:
        print(f"  Integrity check TIMEOUT", file=sys.stderr)
        return False
    except Exception as e:
        print(f"  Integrity check ERROR: {e}", file=sys.stderr)
        return False


def get_file_info(file_path: str) -> dict:
    """
    Get audio file information using ffprobe.

    Args:
        file_path: Path to audio file

    Returns:
        Dict with 'duration', 'codec', 'sample_rate', 'channels', or empty dict on error
    """
    ffprobe_path = shutil.which('ffprobe')
    if not ffprobe_path:
        return {}

    try:
        cmd = [
            ffprobe_path,
            '-v', 'error',
            '-show_format',
            '-show_streams',
            '-of', 'json',
            file_path
        ]

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        if result.returncode != 0:
            return {}

        probe_data = json.loads(result.stdout)

        info = {}
        if 'format' in probe_data:
            info['duration'] = float(probe_data['format'].get('duration', 0))

        if 'streams' in probe_data:
            for stream in probe_data['streams']:
                if stream.get('codec_type') == 'audio':
                    info['codec'] = stream.get('codec_name', 'unknown')
                    info['sample_rate'] = int(stream.get('sample_rate', 0))
                    info['channels'] = int(stream.get('channels', 0))
                    break

        return info

    except Exception:
        return {}
