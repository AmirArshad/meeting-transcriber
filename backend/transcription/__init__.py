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
        # macOS: Use MLX-based transcription (when implemented)
        # For now, fall back to faster-whisper until MLX is implemented
        from .faster_whisper_transcriber import TranscriberService
        return TranscriberService(*args, **kwargs)
    else:
        # Windows and others: Use faster-whisper
        from .faster_whisper_transcriber import TranscriberService
        return TranscriberService(*args, **kwargs)


# For backwards compatibility, import TranscriberService class
from .faster_whisper_transcriber import TranscriberService

__all__ = ['get_transcriber', 'TranscriberService']
