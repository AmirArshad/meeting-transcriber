"""
Transcription module with platform-specific implementations.
"""

import platform


def get_transcriber(*args, **kwargs):
    """
    Factory function to get the platform-specific transcriber.

    Returns:
        BaseTranscriber: Platform-specific transcriber instance
    """
    system = platform.system()

    if system == 'Darwin':
        # macOS: Use MLX-based transcription for Apple Silicon GPU acceleration
        from .mlx_whisper_transcriber import MLXWhisperTranscriber
        return MLXWhisperTranscriber(*args, **kwargs)
    else:
        # Windows and others: Use faster-whisper
        from .faster_whisper_transcriber import TranscriberService
        return TranscriberService(*args, **kwargs)


# For backwards compatibility, import TranscriberService class
from .faster_whisper_transcriber import TranscriberService

__all__ = ['get_transcriber', 'TranscriberService', 'MLXWhisperTranscriber']
