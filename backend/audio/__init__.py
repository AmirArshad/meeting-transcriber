"""
Audio recording module with platform-specific implementations.
"""

import platform


def get_audio_recorder(*args, **kwargs):
    """
    Factory function to get the platform-specific audio recorder.

    Returns:
        BaseAudioRecorder: Platform-specific audio recorder instance
    """
    system = platform.system()

    if system == 'Windows':
        from .windows_recorder import AudioRecorder
        return AudioRecorder(*args, **kwargs)
    elif system == 'Darwin':
        from .macos_recorder import MacOSAudioRecorder
        return MacOSAudioRecorder(*args, **kwargs)
    else:
        raise NotImplementedError(
            f"Audio recording not supported on {system}. "
            "Supported platforms: Windows, macOS"
        )


# For backwards compatibility, import AudioRecorder class
if platform.system() == 'Windows':
    from .windows_recorder import AudioRecorder
elif platform.system() == 'Darwin':
    from .macos_recorder import MacOSAudioRecorder as AudioRecorder
else:
    AudioRecorder = None

__all__ = ['get_audio_recorder', 'AudioRecorder']
