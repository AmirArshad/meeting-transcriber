"""Locked atomic meetings.json store helpers."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional


@contextmanager
def metadata_guard(manager):
    """Serialize metadata operations across threads and processes."""
    with manager._metadata_thread_lock:
        with manager._metadata_file_lock:
            yield


def load_meetings_unlocked(manager) -> List[Dict]:
    """Load meetings without acquiring the metadata guard."""
    try:
        with open(manager.metadata_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return []
    except json.JSONDecodeError as exc:
        backup_path = manager._backup_corrupt_metadata(exc)
        warning_path = backup_path.name if backup_path else manager.metadata_file.name
        print(
            f"Warning: meetings metadata was corrupt and has been backed up to {warning_path}",
            file=sys.stderr,
        )
        return []


def backup_corrupt_metadata(manager, error: json.JSONDecodeError) -> Optional[Path]:
    """Back up a corrupt metadata file before continuing with an empty in-memory list."""
    if not manager.metadata_file.exists():
        return None

    try:
        stat = manager.metadata_file.stat()
        signature = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        signature = None

    if (
        signature is not None
        and manager._corrupt_metadata_signature == signature
        and manager._corrupt_metadata_backup_path is not None
        and manager._corrupt_metadata_backup_path.exists()
    ):
        return manager._corrupt_metadata_backup_path

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = manager.recordings_dir / f"meetings.corrupt.{timestamp}.json"
    counter = 1
    while backup_path.exists():
        backup_path = manager.recordings_dir / f"meetings.corrupt.{timestamp}_{counter}.json"
        counter += 1

    shutil.copy2(manager.metadata_file, backup_path)
    manager._corrupt_metadata_backup_path = backup_path
    manager._corrupt_metadata_signature = signature
    print(
        f"Warning: Backed up corrupt meetings metadata after JSON decode failure at line {error.lineno}, column {error.colno}",
        file=sys.stderr,
    )
    return backup_path


def save_meetings_unlocked(manager, meetings: List[Dict]):
    """Atomically save meetings without acquiring the metadata guard.

    Uses ``meeting_manager.os`` so characterization tests that monkeypatch
    ``meeting_manager.os.replace`` still intercept the atomic write.
    """
    # Lazy import avoids circular import at module load time.
    import meeting_manager as meeting_manager_module

    os_mod = meeting_manager_module.os
    temp_fd, temp_path = tempfile.mkstemp(
        prefix='meetings.',
        suffix='.tmp',
        dir=str(manager.recordings_dir),
    )

    try:
        with os_mod.fdopen(temp_fd, 'w', encoding='utf-8') as f:
            json.dump(meetings, f, indent=2, ensure_ascii=False)
            f.flush()
            os_mod.fsync(f.fileno())

        os_mod.replace(temp_path, manager.metadata_file)
        manager._corrupt_metadata_backup_path = None
        manager._corrupt_metadata_signature = None

        try:
            dir_fd = os_mod.open(manager.recordings_dir, os_mod.O_RDONLY)
            try:
                os_mod.fsync(dir_fd)
            finally:
                os_mod.close(dir_fd)
        except (AttributeError, OSError):
            pass
    finally:
        if os_mod.path.exists(temp_path):
            os_mod.unlink(temp_path)


def list_meetings_locked(manager) -> List[Dict]:
    """Load and deduplicate meetings while already holding the metadata guard."""
    meetings = manager._load_meetings_unlocked()

    seen_ids = set()
    unique_meetings = []
    duplicates_found = 0

    for meeting in meetings:
        meeting_id = meeting.get('id')
        if meeting_id not in seen_ids:
            seen_ids.add(meeting_id)
            unique_meetings.append(meeting)
        else:
            duplicates_found += 1

    if duplicates_found > 0:
        print(f"Warning: Found and removed {duplicates_found} duplicate meeting(s) from database", file=sys.stderr)
        manager._save_meetings_unlocked(unique_meetings)

    unique_meetings.sort(key=lambda m: m.get('date', ''), reverse=True)
    return unique_meetings


def save_meetings(manager, meetings: List[Dict]):
    """Save meetings list to JSON file."""
    with manager._metadata_guard():
        manager._save_meetings_unlocked(meetings)
