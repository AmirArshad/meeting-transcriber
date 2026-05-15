"""Local speaker diarization helpers.

Runtime integration with pyannote is intentionally separate from these pure
alignment helpers so timestamp merge behavior can be tested without model
downloads or hardware-specific dependencies.
"""

from .speaker_segments import merge_speaker_labels, temporal_overlap

__all__ = ["merge_speaker_labels", "temporal_overlap"]
