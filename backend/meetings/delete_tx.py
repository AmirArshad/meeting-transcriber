"""Delete tombstone / rollback helpers for meeting files."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import List, Optional


def _time_mod():
    """Return ``meeting_manager.time`` so sleep monkeypatches stay effective."""
    import meeting_manager as meeting_manager_module

    return meeting_manager_module.time


def wait_for_file(file_path: Path, attempts: int = 5, delay_seconds: float = 0.1) -> bool:
    """Wait briefly for a file to appear.

    Uses ``meeting_manager.time`` so characterization tests that monkeypatch
    ``meeting_manager.time.sleep`` still intercept the wait loop.
    """
    time_mod = _time_mod()
    for attempt in range(attempts):
        if file_path.is_file():
            return True
        if attempt < attempts - 1:
            time_mod.sleep(delay_seconds)
    return False


def delete_file_with_retry(
    file_path: Path,
    label: str,
    *,
    max_retries: int = 3,
    retry_delay: float = 0.5,
):
    if not file_path.exists():
        return

    time_mod = _time_mod()
    for attempt in range(max_retries):
        try:
            file_path.unlink()
            print(f"Deleted {label}: {file_path}", file=sys.stderr)
            return
        except PermissionError as e:
            if attempt < max_retries - 1:
                print(f"File locked (attempt {attempt + 1}/{max_retries}), retrying... ({e})", file=sys.stderr)
                time_mod.sleep(retry_delay)
            else:
                raise RuntimeError(f"Failed to delete {label} file after {max_retries} attempts: {e}")
        except Exception as e:
            raise RuntimeError(f"Failed to delete {label} file: {e}")


def tombstone_path_for(file_path: Path) -> Path:
    base_name = f".{file_path.name}.deleting.{os.getpid()}"
    candidate = file_path.with_name(base_name)
    counter = 1
    while candidate.exists():
        candidate = file_path.with_name(f"{base_name}.{counter}")
        counter += 1
    return candidate


def move_file_to_tombstone(
    file_path: Path,
    label: str,
    *,
    max_retries: int = 3,
    retry_delay: float = 0.5,
) -> Optional[Path]:
    if not file_path.exists():
        return None

    time_mod = _time_mod()
    tombstone_path = tombstone_path_for(file_path)
    for attempt in range(max_retries):
        try:
            file_path.replace(tombstone_path)
            print(f"Prepared {label} for deletion: {file_path}", file=sys.stderr)
            return tombstone_path
        except PermissionError as e:
            if attempt < max_retries - 1:
                print(f"File locked (attempt {attempt + 1}/{max_retries}), retrying... ({e})", file=sys.stderr)
                time_mod.sleep(retry_delay)
            else:
                raise RuntimeError(f"Failed to prepare {label} file for deletion after {max_retries} attempts: {e}")
        except Exception as e:
            raise RuntimeError(f"Failed to prepare {label} file for deletion: {e}")

    return None


def restore_moved_files(moved_files: List[tuple[Path, Path, str]]):
    for tombstone_path, original_path, label in reversed(moved_files):
        if tombstone_path.exists() and not original_path.exists():
            try:
                tombstone_path.replace(original_path)
                print(f"Restored {label} after delete rollback: {original_path}", file=sys.stderr)
            except Exception as restore_error:
                print(f"Warning: Could not restore {label} after delete rollback: {restore_error}", file=sys.stderr)
