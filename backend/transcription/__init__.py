"""Transcription module with platform-specific implementations."""

import os
import platform

# Apply before optional native imports for standalone CLI use as well as Electron.
# ONNX's Python disable API alone can be too late for initialization telemetry.
os.environ['ORT_DISABLE_TELEMETRY'] = '1'
# ORT 1.31's internal telemetry-only signal prevents legacy Windows ETW
# registration. Keep the native ETW positive-control gate when changing pins.
os.environ['ORT_RUNNING_UNIT_TESTS'] = '1'


def _get_transcriber_class():
    """Resolve the platform-specific transcriber class lazily."""
    system = platform.system()

    if system == 'Darwin':
        from .mlx_whisper_transcriber import MLXWhisperTranscriber

        return MLXWhisperTranscriber

    from .faster_whisper_transcriber import TranscriberService

    return TranscriberService


def get_transcriber(*args, **kwargs):
    """
    Factory function to get the platform-specific transcriber.

    Returns:
        BaseTranscriber: Platform-specific transcriber instance
    """
    return _get_transcriber_class()(*args, **kwargs)


def __getattr__(name):
    """Provide lazy access to legacy transcriber exports."""
    if name == 'TranscriberService':
        from .faster_whisper_transcriber import TranscriberService

        return TranscriberService

    if name == 'MLXWhisperTranscriber':
        from .mlx_whisper_transcriber import MLXWhisperTranscriber

        return MLXWhisperTranscriber

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ['get_transcriber', 'TranscriberService', 'MLXWhisperTranscriber']
