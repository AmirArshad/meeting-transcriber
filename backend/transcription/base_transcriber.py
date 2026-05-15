"""
Abstract base class for platform-specific transcription implementations.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional


class BaseTranscriber(ABC):
    """Abstract base class for transcription implementations."""

    @abstractmethod
    def load_model(self) -> None:
        """
        Load the transcription model.
        """
        raise NotImplementedError

    @abstractmethod
    def transcribe_file(
        self,
        audio_path: str,
        output_path: Optional[str] = None,
        save_markdown: bool = True,
    ) -> Dict[str, Any]:
        """
        Transcribe an audio file.

        Args:
            audio_path: Path to the audio file to transcribe
            output_path: Optional output markdown path
            save_markdown: Whether to save the markdown transcript

        Returns:
            dict: Transcription results with segments and metadata
        """
        raise NotImplementedError

    @abstractmethod
    def get_model_info(self) -> Dict[str, Any]:
        """
        Get information about the loaded model.

        Returns:
            dict: Model information (name, size, device, etc.)
        """
        raise NotImplementedError

    def transcribe(
        self,
        audio_path: str,
        output_path: Optional[str] = None,
        save_markdown: bool = True,
    ) -> Dict[str, Any]:
        """Compatibility wrapper for older callers."""
        return self.transcribe_file(audio_path, output_path=output_path, save_markdown=save_markdown)
