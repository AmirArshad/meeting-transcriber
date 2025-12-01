"""
Abstract base class for platform-specific audio recorders.
"""

from abc import ABC, abstractmethod


class BaseAudioRecorder(ABC):
    """Abstract base class for audio recording implementations."""

    @abstractmethod
    def start_recording(self, mic_device_id, desktop_device_id, output_file):
        """
        Start recording audio from microphone and desktop sources.

        Args:
            mic_device_id: Device ID for microphone input
            desktop_device_id: Device ID for desktop audio capture
            output_file: Output file path for the recording
        """
        pass

    @abstractmethod
    def stop_recording(self):
        """Stop the current recording and finalize the output file."""
        pass

    @abstractmethod
    def get_audio_levels(self):
        """
        Get current audio levels for visualization.

        Returns:
            tuple: (mic_level, desktop_level) as floats between 0.0 and 1.0
        """
        pass

    @abstractmethod
    def is_recording(self):
        """
        Check if currently recording.

        Returns:
            bool: True if recording is active
        """
        pass
