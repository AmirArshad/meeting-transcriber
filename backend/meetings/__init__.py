"""Meeting metadata helpers (normalization, scan/import; paths/store/delete deferred)."""

from .normalization import (
    MAX_AI_METADATA_STRING_LENGTH,
    VALID_TRANSCRIPTION_STATUSES,
    build_pending_transcript_placeholder,
    hash_text,
    normalize_text,
    normalize_transcription_error,
    normalize_transcription_status,
    parse_metadata,
    read_text_file,
    read_transcript_text,
    strip_inline_transcript,
)
from .scan_import import (
    extract_duration_from_transcript_file,
    extract_duration_seconds_from_transcript,
    parse_scan_meeting_id_and_title,
    select_scannable_audio_files,
)

__all__ = [
    "MAX_AI_METADATA_STRING_LENGTH",
    "VALID_TRANSCRIPTION_STATUSES",
    "build_pending_transcript_placeholder",
    "extract_duration_from_transcript_file",
    "extract_duration_seconds_from_transcript",
    "hash_text",
    "normalize_text",
    "normalize_transcription_error",
    "normalize_transcription_status",
    "parse_metadata",
    "parse_scan_meeting_id_and_title",
    "read_text_file",
    "read_transcript_text",
    "select_scannable_audio_files",
    "strip_inline_transcript",
]
