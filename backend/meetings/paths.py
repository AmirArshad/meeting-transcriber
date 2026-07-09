"""Safe recordings-path and AI sidecar reference helpers."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Dict, List, Optional

from common.sensitive_text import redact_sensitive_text
from meetings import normalization as meeting_norm


def is_recordings_path(manager, file_path: Path) -> bool:
    try:
        file_path.resolve(strict=False).relative_to(manager.recordings_dir.resolve(strict=False))
        return True
    except ValueError:
        return False


def resolve_accessible_recordings_file(
    manager,
    file_path: Path,
    *,
    allowed_suffixes: Optional[tuple[str, ...]] = None,
    must_exist: bool = True,
    label: str = 'file',
) -> Optional[Path]:
    candidate = Path(str(file_path))
    if candidate.is_symlink():
        print(f"Warning: Ignoring symlink {label}: {candidate}", file=sys.stderr)
        return None

    resolved = candidate.resolve(strict=False)
    if not manager._is_recordings_path(resolved):
        print(f"Warning: Ignoring unsafe {label} path: {candidate}", file=sys.stderr)
        return None

    if allowed_suffixes is not None:
        normalized_suffixes = tuple(suffix.lower() for suffix in allowed_suffixes)
        if resolved.suffix.lower() not in normalized_suffixes:
            print(
                f"Warning: Ignoring {label} path with unsupported extension: {candidate}",
                file=sys.stderr,
            )
            return None

    if must_exist and not resolved.is_file():
        return None

    return resolved


def normalize_sidecar_path(manager, value: object, allowed_suffixes: tuple[str, ...]) -> Optional[str]:
    if value in (None, ''):
        return None

    file_path = Path(str(value))
    if file_path.is_symlink():
        raise ValueError('AI artifact path must not be a symlink')
    file_path = file_path.resolve(strict=False)
    if file_path.suffix.lower() not in allowed_suffixes:
        raise ValueError('AI artifact path has an unsupported file extension')
    if not manager._is_recordings_path(file_path):
        raise ValueError('AI artifact path must stay inside the recordings directory')
    return str(file_path)


def normalize_ai_feature_metadata(manager, feature: str, metadata: Dict) -> Dict:
    allowed_fields = {
        'diarization': (
            'status',
            'model',
            'completedAt',
            'speakerCount',
            'segmentsPath',
            'error',
        ),
        'summary': (
            'status',
            'modelProfile',
            'model',
            'generatedAt',
            'sourceTranscriptHash',
            'jsonPath',
            'markdownPath',
            'error',
        ),
    }

    if feature not in allowed_fields:
        raise ValueError(f"Unsupported AI metadata feature: {feature}")
    if not isinstance(metadata, dict):
        raise ValueError(f"AI metadata for {feature} must be an object")

    normalized = {}
    for field in allowed_fields[feature]:
        if field not in metadata:
            continue

        value = metadata[field]
        if value is None:
            normalized[field] = None
        elif field == 'speakerCount':
            try:
                normalized[field] = int(value)
            except (TypeError, ValueError):
                continue
        elif field in ('segmentsPath', 'jsonPath'):
            normalized_path = manager._normalize_sidecar_path(value, ('.json',))
            if normalized_path is not None:
                normalized[field] = normalized_path
        elif field == 'markdownPath':
            normalized_path = manager._normalize_sidecar_path(value, ('.md',))
            if normalized_path is not None:
                normalized[field] = normalized_path
        elif field == 'sourceTranscriptHash':
            text = meeting_norm.normalize_text(value)
            if re.fullmatch(r"sha256:[a-fA-F0-9]{64}", text):
                normalized[field] = text
        else:
            if field == 'error':
                normalized[field] = redact_sensitive_text(value)
            else:
                normalized[field] = meeting_norm.normalize_text(value)

    return normalized


def iter_ai_file_references(manager, meeting: Dict) -> List[tuple[str, Path]]:
    ai = meeting.get('ai')
    if not isinstance(ai, dict):
        return []

    references: List[tuple[str, Path]] = []
    feature_file_fields = {
        'diarization': (
            ('speaker labels', 'segmentsPath', ('.json',)),
        ),
        'summary': (
            ('summary JSON', 'jsonPath', ('.json',)),
            ('summary Markdown', 'markdownPath', ('.md',)),
        ),
    }

    for feature, fields in feature_file_fields.items():
        feature_metadata = ai.get(feature)
        if not isinstance(feature_metadata, dict):
            continue

        for label, field, allowed_suffixes in fields:
            file_path = feature_metadata.get(field)
            if not file_path:
                continue
            safe_path = manager._resolve_accessible_recordings_file(
                Path(str(file_path)),
                allowed_suffixes=allowed_suffixes,
                must_exist=True,
                label=label,
            )
            if safe_path is not None:
                references.append((label, safe_path))

    return references


def meeting_file_references(manager, meeting: Dict) -> List[tuple[str, Path]]:
    references: List[tuple[str, Path]] = []
    core_file_fields = (
        ('audio', meeting.get('audioPath'), ('.opus', '.wav', '.m4a', '.mp3', '.flac')),
        ('transcript', meeting.get('transcriptPath'), ('.md',)),
    )

    for label, raw_path, allowed_suffixes in core_file_fields:
        if not raw_path:
            continue
        safe_path = manager._resolve_accessible_recordings_file(
            Path(str(raw_path)),
            allowed_suffixes=allowed_suffixes,
            must_exist=True,
            label=label,
        )
        if safe_path is not None:
            references.append((label, safe_path))

    references.extend(manager._iter_ai_file_references(meeting))

    unique_references: List[tuple[str, Path]] = []
    seen_paths = set()
    for label, file_path in references:
        path_key = str(file_path.resolve(strict=False))
        if path_key in seen_paths:
            continue
        seen_paths.add(path_key)
        unique_references.append((label, file_path))

    return unique_references
