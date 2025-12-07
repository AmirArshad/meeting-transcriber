"""
Abstract base class for platform-specific transcription implementations.
"""

from abc import ABC, abstractmethod


class BaseTranscriber(ABC):
    """Abstract base class for transcription implementations."""

    @abstractmethod
    def load_model(self, model_size='base', language='en'):
        """
        Load the transcription model.

        Args:
            model_size: Size of the model (tiny, base, small, medium, large)
            language: Target language for transcription (default: 'en')
        """
        pass

    @abstractmethod
    def transcribe(self, audio_path, language=None):
        """
        Transcribe an audio file.

        Args:
            audio_path: Path to the audio file to transcribe
            language: Override language for this transcription

        Returns:
            dict: Transcription results with segments and metadata
        """
        pass

    @abstractmethod
    def get_model_info(self):
        """
        Get information about the loaded model.

        Returns:
            dict: Model information (name, size, device, etc.)
        """
        pass
