"""Meeting metadata helpers (normalization, scan/import, paths, store, delete)."""

from .delete_tx import (
    delete_file_with_retry,
    move_file_to_tombstone,
    restore_moved_files,
    tombstone_path_for,
    wait_for_file,
)
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
from .paths import (
    is_recordings_path,
    iter_ai_file_references,
    meeting_file_references,
    normalize_ai_feature_metadata,
    normalize_sidecar_path,
    resolve_accessible_recordings_file,
)
from .scan_import import (
    extract_duration_from_transcript_file,
    extract_duration_seconds_from_transcript,
    parse_scan_meeting_id_and_title,
    select_scannable_audio_files,
)
from .store import (
    backup_corrupt_metadata,
    list_meetings_locked,
    load_meetings_unlocked,
    metadata_guard,
    save_meetings,
    save_meetings_unlocked,
)

__all__ = [
    "MAX_AI_METADATA_STRING_LENGTH",
    "VALID_TRANSCRIPTION_STATUSES",
    "backup_corrupt_metadata",
    "build_pending_transcript_placeholder",
    "delete_file_with_retry",
    "extract_duration_from_transcript_file",
    "extract_duration_seconds_from_transcript",
    "hash_text",
    "is_recordings_path",
    "iter_ai_file_references",
    "list_meetings_locked",
    "load_meetings_unlocked",
    "meeting_file_references",
    "metadata_guard",
    "move_file_to_tombstone",
    "normalize_ai_feature_metadata",
    "normalize_sidecar_path",
    "normalize_text",
    "normalize_transcription_error",
    "normalize_transcription_status",
    "parse_metadata",
    "parse_scan_meeting_id_and_title",
    "read_text_file",
    "read_transcript_text",
    "resolve_accessible_recordings_file",
    "restore_moved_files",
    "save_meetings",
    "save_meetings_unlocked",
    "select_scannable_audio_files",
    "strip_inline_transcript",
    "tombstone_path_for",
    "wait_for_file",
]
