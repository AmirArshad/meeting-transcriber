"""Audio recording module with platform-specific implementations."""

import platform


def _get_audio_recorder_class():
    """Resolve the platform-specific recorder class lazily."""
    system = platform.system()

    if system == 'Windows':
        from .windows_recorder import AudioRecorder

        return AudioRecorder

    if system == 'Darwin':
        from .macos_recorder import MacOSAudioRecorder

        return MacOSAudioRecorder

    raise NotImplementedError(
        f"Audio recording not supported on {system}. "
        "Supported platforms: Windows, macOS"
    )


def get_audio_recorder(*args, **kwargs):
    """
    Factory function to get the platform-specific audio recorder.

    Returns:
        BaseAudioRecorder: Platform-specific audio recorder instance
    """
    return _get_audio_recorder_class()(*args, **kwargs)


def __getattr__(name):
    """Provide lazy access to the legacy AudioRecorder export."""
    if name == 'AudioRecorder':
        return _get_audio_recorder_class()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ['get_audio_recorder', 'AudioRecorder']
