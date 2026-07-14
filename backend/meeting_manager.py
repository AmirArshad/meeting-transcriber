"""
Meeting Manager - Handles meeting history and metadata.

Stores meeting records in a JSON database and provides
operations for listing, retrieving, and deleting meetings.
"""

import json
# Kept as module attributes so characterization tests can monkeypatch
# ``meeting_manager.os.replace`` / ``meeting_manager.time.sleep``.
import os  # noqa: F401
import time  # noqa: F401
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
import sys
import shutil
import threading

from filelock import FileLock

from meetings import delete_tx as meeting_delete
from meetings import normalization as meeting_norm
from meetings import paths as meeting_paths
from meetings import scan_import as meeting_scan
from meetings import store as meeting_store


_UNSET = object()
_MAX_AI_METADATA_STRING_LENGTH = meeting_norm.MAX_AI_METADATA_STRING_LENGTH
_VALID_TRANSCRIPTION_STATUSES = meeting_norm.VALID_TRANSCRIPTION_STATUSES
_TRANSCRIPTION_DEVICE_CLI_CHOICES = meeting_norm.TRANSCRIPTION_DEVICE_CLI_CHOICES


class MeetingManager:
    """
    Manages meeting history with persistent JSON storage.

    Stores metadata about recorded meetings including:
    - Audio file paths
    - Transcript file paths
    - Recording details (date, duration, language, model)
    """

    def __init__(self, recordings_dir: str = "recordings"):
        """Initialize the meeting manager."""
        self.recordings_dir = Path(recordings_dir)
        self.recordings_dir.mkdir(parents=True, exist_ok=True)

        self.metadata_file = self.recordings_dir / "meetings.json"
        self.metadata_lock_file = self.recordings_dir / "meetings.json.lock"
        self._metadata_thread_lock = threading.RLock()
        self._metadata_file_lock = FileLock(str(self.metadata_lock_file), timeout=10)
        self._corrupt_metadata_backup_path: Optional[Path] = None
        self._corrupt_metadata_signature: Optional[tuple[int, int]] = None

        # Create empty metadata file if it doesn't exist
        if not self.metadata_file.exists():
            self._save_meetings([])

    @contextmanager
    def _metadata_guard(self):
        """Serialize metadata operations across threads and processes."""
        with meeting_store.metadata_guard(self):
            yield

    def _load_meetings_unlocked(self) -> List[Dict]:
        """Load meetings without acquiring the metadata guard."""
        return meeting_store.load_meetings_unlocked(self)

    def _backup_corrupt_metadata(self, error: json.JSONDecodeError) -> Optional[Path]:
        """Back up a corrupt metadata file before continuing with an empty in-memory list."""
        return meeting_store.backup_corrupt_metadata(self, error)

    def _save_meetings_unlocked(self, meetings: List[Dict]):
        """Atomically save meetings without acquiring the metadata guard."""
        meeting_store.save_meetings_unlocked(self, meetings)

    def _list_meetings_locked(self) -> List[Dict]:
        """Load and deduplicate meetings while already holding the metadata guard."""
        return meeting_store.list_meetings_locked(self)

    @staticmethod
    def _read_text_file(file_path: Optional[Path], label: str) -> str:
        return meeting_norm.read_text_file(file_path, label)

    @staticmethod
    def _read_transcript_text(transcript_path: Optional[Path]) -> str:
        return meeting_norm.read_transcript_text(transcript_path)

    @staticmethod
    def _hash_text(text: str) -> str:
        return meeting_norm.hash_text(text)

    @staticmethod
    def _normalize_transcription_status(value: object, default: str = "completed") -> str:
        return meeting_norm.normalize_transcription_status(value, default=default)

    @staticmethod
    def _normalize_transcription_error(value: object) -> Optional[str]:
        return meeting_norm.normalize_transcription_error(value)

    @staticmethod
    def _build_pending_transcript_placeholder(audio_file_name: str) -> str:
        return meeting_norm.build_pending_transcript_placeholder(audio_file_name)

    @staticmethod
    def _select_scannable_audio_files(recordings_dir: Path) -> List[Path]:
        return meeting_scan.select_scannable_audio_files(recordings_dir)

    @staticmethod
    def _strip_inline_transcript(meeting: Dict) -> Dict:
        return meeting_norm.strip_inline_transcript(meeting)

    def _is_recordings_path(self, file_path: Path) -> bool:
        return meeting_paths.is_recordings_path(self, file_path)

    def _resolve_accessible_recordings_file(
        self,
        file_path: Path,
        *,
        allowed_suffixes: Optional[tuple[str, ...]] = None,
        must_exist: bool = True,
        label: str = 'file',
    ) -> Optional[Path]:
        return meeting_paths.resolve_accessible_recordings_file(
            self,
            file_path,
            allowed_suffixes=allowed_suffixes,
            must_exist=must_exist,
            label=label,
        )

    def _normalize_sidecar_path(self, value: object, allowed_suffixes: tuple[str, ...]) -> Optional[str]:
        return meeting_paths.normalize_sidecar_path(self, value, allowed_suffixes)

    def _normalize_ai_feature_metadata(self, feature: str, metadata: Dict) -> Dict:
        return meeting_paths.normalize_ai_feature_metadata(self, feature, metadata)

    def _iter_ai_file_references(self, meeting: Dict) -> List[tuple[str, Path]]:
        return meeting_paths.iter_ai_file_references(self, meeting)

    def _meeting_file_references(self, meeting: Dict) -> List[tuple[str, Path]]:
        return meeting_paths.meeting_file_references(self, meeting)

    def _wait_for_file(self, file_path: Path, attempts: int = 5, delay_seconds: float = 0.1) -> bool:
        return meeting_delete.wait_for_file(file_path, attempts=attempts, delay_seconds=delay_seconds)

    def add_meeting(
        self,
        audio_path: str,
        transcript_path: str,
        duration: float,
        language: str = "en",
        model: str = "base",
        title: Optional[str] = None,
        transcription_status: str = "completed",
        transcription_error: Optional[str] = None,
        transcription_device: Optional[str] = None,
        transcription_compute_type: Optional[str] = None,
    ) -> Dict:
        """
        Add a new meeting to the history.

        Callers must pass audio and transcript paths that already live under
        ``recordings_dir``. The Electron renderer writes the transcript file
        before invoking ``add-meeting``; a short transcript wait covers races
        with antivirus or slow filesystem sync.

        Args:
            audio_path: Path to audio file (.opus)
            transcript_path: Path to transcript file (.md)
            duration: Duration in seconds
            language: Language code
            model: Whisper model used
            title: Optional custom title

        Returns:
            Meeting object with metadata
        """
        now = datetime.now()
        base_id = now.strftime("%Y%m%d_%H%M%S")

        source_audio = Path(audio_path)
        source_transcript = Path(transcript_path)

        if source_audio.is_symlink() or source_transcript.is_symlink():
            raise ValueError('Symlinks are not allowed for meeting source files')

        source_audio = source_audio.resolve(strict=False)
        source_transcript = source_transcript.resolve(strict=False)

        if not self._is_recordings_path(source_audio):
            raise ValueError('Audio path must stay inside the recordings directory')
        if not self._is_recordings_path(source_transcript):
            raise ValueError('Transcript path must stay inside the recordings directory')
        if not source_audio.is_file():
            raise ValueError(f'Audio file not found: {source_audio}')
        if not self._wait_for_file(source_transcript):
            raise ValueError(f'Transcript file not found: {source_transcript}')

        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            existing_ids = {m['id'] for m in meetings}

            # Ensure unique ID (handle rare case of multiple adds in same second)
            meeting_id = base_id
            counter = 1
            while meeting_id in existing_ids:
                meeting_id = f"{base_id}_{counter}"
                counter += 1
                if counter > 100:  # Safety limit
                    raise RuntimeError(f"Failed to generate unique meeting ID after {counter} attempts")

            # Auto-generate title if not provided
            if not title:
                title = f"Meeting {now.strftime('%Y-%m-%d %H:%M')}"

            # Format duration
            minutes = int(duration // 60)
            seconds = int(duration % 60)
            duration_str = f"{minutes}:{seconds:02d}"

            # Generate unique filenames to persist data
            # This prevents overwriting when temp files are reused
            new_audio_filename = f"meeting_{meeting_id}{source_audio.suffix}"
            new_transcript_filename = f"meeting_{meeting_id}.md"

            new_audio_path = self.recordings_dir / new_audio_filename
            new_transcript_path = self.recordings_dir / new_transcript_filename
            persisted_audio_path = source_audio
            persisted_transcript_path = source_transcript
            copied_audio = False
            copied_transcript = False

            try:
                shutil.copy2(source_audio, new_audio_path)
                copied_audio = True
                persisted_audio_path = new_audio_path
                print(f"Persisted audio to: {new_audio_path}", file=sys.stderr)

                shutil.copy2(source_transcript, new_transcript_path)
                copied_transcript = True
                persisted_transcript_path = new_transcript_path
                print(f"Persisted transcript to: {new_transcript_path}", file=sys.stderr)

                meeting = {
                    "id": meeting_id,
                    "title": title,
                    "date": now.isoformat(),
                    "duration": duration_str,
                    "durationSeconds": duration,
                    "audioPath": str(persisted_audio_path.absolute()),
                    "transcriptPath": str(persisted_transcript_path.absolute()),
                    "language": language,
                    "model": model,
                    "transcriptionStatus": self._normalize_transcription_status(transcription_status),
                    "transcriptionError": self._normalize_transcription_error(transcription_error),
                }
                normalized_device = meeting_norm.normalize_transcription_device(transcription_device)
                normalized_compute_type = meeting_norm.normalize_transcription_compute_type(transcription_compute_type)
                if normalized_device:
                    meeting["transcriptionDevice"] = normalized_device
                if normalized_compute_type:
                    meeting["transcriptionComputeType"] = normalized_compute_type

                # Add to beginning of existing meetings (most recent first)
                meetings.insert(0, meeting)
                self._save_meetings_unlocked(meetings)

            except Exception:
                if copied_audio and new_audio_path.exists():
                    try:
                        new_audio_path.unlink()
                    except OSError:
                        pass

                if copied_transcript and new_transcript_path.exists():
                    try:
                        new_transcript_path.unlink()
                    except OSError:
                        pass

                raise

        # Remove originals only after metadata is durably saved
        if copied_audio and source_audio.exists():
            try:
                source_audio.unlink()
                print(f"Removed original audio: {source_audio}", file=sys.stderr)
            except Exception as del_err:
                print(f"Warning: Could not remove original audio: {del_err}", file=sys.stderr)

        if copied_transcript and source_transcript.exists():
            try:
                source_transcript.unlink()
                print(f"Removed original transcript: {source_transcript}", file=sys.stderr)
            except Exception as del_err:
                print(f"Warning: Could not remove original transcript: {del_err}", file=sys.stderr)

        print(f"Meeting saved: {meeting_id}", file=sys.stderr)
        return meeting

    def _add_meeting_direct(
        self,
        meeting_id: str,
        audio_path: str,
        transcript_path: str,
        duration: float,
        language: str,
        model: str,
        title: str,
        transcription_status: str = "completed",
        transcription_error: Optional[str] = None,
    ) -> Optional[Dict]:
        """
        Add a meeting directly without copying files (used by scan).
        Files are assumed to already be in the correct location.

        Returns:
            Meeting object if added, None if ID already exists (duplicate prevention)
        """
        with self._metadata_guard():
            meetings = self._list_meetings_locked()

            # Check for duplicate ID (defense-in-depth)
            existing_ids = {m['id'] for m in meetings}
            if meeting_id in existing_ids:
                print(f"Warning: Skipping duplicate meeting ID: {meeting_id}", file=sys.stderr)
                return None

            # Format duration
            minutes = int(duration // 60)
            seconds = int(duration % 60)
            duration_str = f"{minutes}:{seconds:02d}"

            # Parse meeting_id to get date
            # Handle suffixed IDs like "20260107_104555_1" by extracting base ID
            try:
                parts = meeting_id.split('_')
                if len(parts) >= 2:
                    base_id = f"{parts[0]}_{parts[1]}"
                    dt = datetime.strptime(base_id, "%Y%m%d_%H%M%S")
                else:
                    dt = datetime.strptime(meeting_id, "%Y%m%d_%H%M%S")
                date_iso = dt.isoformat()
            except (ValueError, IndexError):
                date_iso = datetime.now().isoformat()

            meeting = {
                'id': meeting_id,
                'title': title,
                'date': date_iso,
                'duration': duration_str,
                'durationSeconds': duration,
                'audioPath': audio_path,
                'transcriptPath': transcript_path,
                'language': language,
                'model': model,
                'transcriptionStatus': self._normalize_transcription_status(transcription_status),
                'transcriptionError': self._normalize_transcription_error(transcription_error),
            }

            # Add to beginning of existing meetings (most recent first)
            meetings.insert(0, meeting)

            self._save_meetings_unlocked(meetings)
            return meeting

    def list_meetings(self) -> List[Dict]:
        """
        Get all meetings sorted by date (newest first).

        Automatically deduplicates entries by ID and saves cleaned data
        if duplicates are found.

        Returns:
            List of meeting objects
        """
        with self._metadata_guard():
            return [self._strip_inline_transcript(meeting) for meeting in self._list_meetings_locked()]

    def scan_and_sync_recordings(self) -> Dict[str, int]:
        """
        Scan the recordings directory for audio/transcript files and add any
        missing meetings to the database.

        This is useful for recovering from situations where transcriptions
        completed but weren't added to the database, or for importing
        recordings from other sources.

        Returns:
            Dictionary with counts: {'scanned': N, 'added': M, 'skipped': K}
        """
        existing_meetings = self.list_meetings()
        existing_audio_paths = {Path(m['audioPath']).name for m in existing_meetings}

        scanned = 0
        added = 0
        skipped = 0

        # Promote orphaned recorder temps (.pcm.tmp / legacy *.temp.wav) to
        # scannable WAVs, or delete temps when a final Opus/WAV already exists.
        try:
            temp_recovery = meeting_scan.recover_or_cleanup_recorder_temps(self.recordings_dir)
            if temp_recovery.get("recovered") or temp_recovery.get("cleaned"):
                print(
                    "Recorder temp recovery: "
                    f"recovered={temp_recovery.get('recovered', 0)} "
                    f"cleaned={temp_recovery.get('cleaned', 0)} "
                    f"skipped={temp_recovery.get('skipped', 0)}",
                    file=sys.stderr,
                )
        except Exception as temp_err:
            print(f"Warning: Recorder temp recovery failed: {temp_err}", file=sys.stderr)

        # Find all .opus and .wav audio files, preferring one candidate per stem
        audio_files = self._select_scannable_audio_files(self.recordings_dir)

        for audio_file in audio_files:
            scanned += 1

            if audio_file.is_symlink():
                print(f"Warning: Skipping symlink audio file during scan: {audio_file.name}", file=sys.stderr)
                skipped += 1
                continue

            # Skip if already in database
            if audio_file.name in existing_audio_paths:
                skipped += 1
                continue

            # Look for corresponding transcript
            transcript_file = audio_file.with_suffix('.md')
            placeholder_created = False
            if transcript_file.is_symlink():
                print(f"Warning: Skipping symlink transcript during scan: {transcript_file.name}", file=sys.stderr)
                skipped += 1
                continue
            if not transcript_file.exists():
                placeholder = self._build_pending_transcript_placeholder(audio_file.name)
                try:
                    transcript_file.write_text(placeholder, encoding='utf-8')
                    placeholder_created = True
                    print(f"Created pending transcript placeholder for {audio_file.name}", file=sys.stderr)
                except Exception as e:
                    print(f"Warning: Could not create placeholder transcript for {audio_file.name}: {e}", file=sys.stderr)
                    skipped += 1
                    continue

            # Try to extract duration from transcript
            duration = meeting_scan.extract_duration_from_transcript_file(transcript_file)

            # Extract ID and title from filename
            meeting_id, title = meeting_scan.parse_scan_meeting_id_and_title(audio_file.stem)

            # Check if this ID already exists in database
            existing_ids = {m['id'] for m in existing_meetings}
            if meeting_id in existing_ids:
                print(f"Skipping {audio_file.name}: ID {meeting_id} already exists", file=sys.stderr)
                skipped += 1
                continue

            # Add meeting to database directly (don't copy files - they're already in place)
            try:
                resolved_audio = audio_file.resolve(strict=False)
                resolved_transcript = transcript_file.resolve(strict=False)
                if not self._is_recordings_path(resolved_audio) or not self._is_recordings_path(resolved_transcript):
                    print(
                        f"Warning: Skipping {audio_file.name}: resolved path escapes recordings directory",
                        file=sys.stderr,
                    )
                    skipped += 1
                    continue

                meeting = self._add_meeting_direct(
                    meeting_id=meeting_id,
                    audio_path=str(resolved_audio),
                    transcript_path=str(resolved_transcript),
                    duration=duration,
                    language="en",
                    model="unknown",
                    title=title,
                    transcription_status="pending" if placeholder_created else "completed",
                )
                if meeting is not None:
                    existing_meetings.append(meeting)
                    existing_audio_paths.add(Path(meeting['audioPath']).name)
                    added += 1
                    print(f"Added meeting from filesystem: {audio_file.name} (ID: {meeting_id})", file=sys.stderr)
                else:
                    # Duplicate detected by _add_meeting_direct
                    skipped += 1
            except Exception as e:
                print(f"Error adding meeting {audio_file.name}: {e}", file=sys.stderr)
                skipped += 1

        return {
            'scanned': scanned,
            'added': added,
            'skipped': skipped
        }

    def get_meeting(self, meeting_id: str) -> Optional[Dict]:
        """
        Get a single meeting by ID.

        Args:
            meeting_id: Meeting ID to retrieve

        Returns:
            Meeting object or None if not found
        """
        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            for meeting in meetings:
                if meeting['id'] == meeting_id:
                    hydrated = dict(meeting)
                    safe_transcript_path = self._resolve_accessible_recordings_file(
                        Path(meeting['transcriptPath']),
                        allowed_suffixes=('.md',),
                        must_exist=True,
                        label='transcript',
                    )
                    transcript_text = self._read_transcript_text(safe_transcript_path) if safe_transcript_path else ""
                    if transcript_text:
                        hydrated['transcript'] = transcript_text
                    elif meeting.get('transcript'):
                        hydrated['transcript'] = meeting['transcript']
                    else:
                        hydrated['transcript'] = ""
                    summary = (meeting.get('ai') or {}).get('summary')
                    summary_path = summary.get('markdownPath') if isinstance(summary, dict) else None
                    safe_summary_path = self._resolve_accessible_recordings_file(
                        Path(summary_path),
                        allowed_suffixes=('.md',),
                        must_exist=True,
                        label='summary',
                    ) if summary_path else None
                    hydrated['summary'] = self._read_text_file(safe_summary_path, 'summary') if safe_summary_path else ""
                    if isinstance(summary, dict) and summary.get('sourceTranscriptHash'):
                        hydrated['summaryStale'] = summary.get('sourceTranscriptHash') != self._hash_text(hydrated.get('transcript', ''))
                    else:
                        hydrated['summaryStale'] = False
                    return hydrated
            return None

    def update_meeting(self, meeting_id: str, *, title: Optional[str] = None) -> Optional[Dict]:
        """
        Update editable fields on a meeting (currently: display title).

        The on-disk audio/transcript filenames are intentionally left untouched
        so the underlying recording can always be located by ID. Only the
        display label stored in metadata changes.

        Args:
            meeting_id: Meeting ID to update.
            title: New display title. If None, no change is made.

        Returns:
            Updated meeting dict, or None if the meeting was not found.
        """
        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            meeting = next((m for m in meetings if m['id'] == meeting_id), None)

            if not meeting:
                return None

            changed = False
            if title is not None:
                clean = title.strip()
                if clean and clean != meeting.get('title'):
                    meeting['title'] = clean
                    changed = True

            if changed:
                self._save_meetings_unlocked(meetings)
                print(f"Meeting updated: {meeting_id}", file=sys.stderr)

            return meeting

    def update_transcription(
        self,
        meeting_id: str,
        *,
        status: Optional[str] = None,
        error: Optional[str] = None,
        clear_error: bool = False,
        language: Optional[str] = None,
        model: Optional[str] = None,
        duration: Optional[float] = None,
        device: Optional[str] = None,
        compute_type: Optional[str] = None,
    ) -> Optional[Dict]:
        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            meeting = next((m for m in meetings if m['id'] == meeting_id), None)
            if not meeting:
                return None

            changed = False
            if status is not None:
                normalized_status = self._normalize_transcription_status(status, default=meeting.get('transcriptionStatus', 'completed'))
                if meeting.get('transcriptionStatus') != normalized_status:
                    meeting['transcriptionStatus'] = normalized_status
                    changed = True

            if clear_error:
                if meeting.get('transcriptionError') is not None:
                    meeting['transcriptionError'] = None
                    changed = True
            elif error is not None:
                normalized_error = self._normalize_transcription_error(error)
                if meeting.get('transcriptionError') != normalized_error:
                    meeting['transcriptionError'] = normalized_error
                    changed = True

            if language is not None and language != '':
                normalized_language = str(language).strip() or meeting.get('language') or 'en'
                if meeting.get('language') != normalized_language:
                    meeting['language'] = normalized_language
                    changed = True

            if model is not None and model != '':
                normalized_model = str(model).strip() or meeting.get('model') or 'unknown'
                if meeting.get('model') != normalized_model:
                    meeting['model'] = normalized_model
                    changed = True

            if duration is not None:
                duration_value = max(0.0, float(duration))
                minutes = int(duration_value // 60)
                seconds = int(duration_value % 60)
                duration_str = f"{minutes}:{seconds:02d}"
                if meeting.get('durationSeconds') != duration_value:
                    meeting['durationSeconds'] = duration_value
                    changed = True
                if meeting.get('duration') != duration_str:
                    meeting['duration'] = duration_str
                    changed = True

            if device is not None:
                normalized_device = meeting_norm.normalize_transcription_device(device)
                if meeting.get('transcriptionDevice') != normalized_device:
                    meeting['transcriptionDevice'] = normalized_device
                    changed = True

            if compute_type is not None:
                normalized_compute_type = meeting_norm.normalize_transcription_compute_type(compute_type)
                if meeting.get('transcriptionComputeType') != normalized_compute_type:
                    meeting['transcriptionComputeType'] = normalized_compute_type
                    changed = True

            if changed:
                self._save_meetings_unlocked(meetings)
            return meeting

    def update_meeting_ai(
        self,
        meeting_id: str,
        *,
        diarization=_UNSET,
        summary=_UNSET,
    ) -> Optional[Dict]:
        """Persist derived local AI artifact references for a meeting.

        Large derived outputs stay in sidecar files. This method stores only
        concise metadata and paths while reusing the existing locked atomic
        metadata write path.
        """
        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            meeting = next((m for m in meetings if m['id'] == meeting_id), None)

            if not meeting:
                return None

            ai = dict(meeting.get('ai') or {})
            changed = False

            for feature, value in (
                ('diarization', diarization),
                ('summary', summary),
            ):
                if value is _UNSET:
                    continue

                if value is None:
                    if feature in ai:
                        ai.pop(feature, None)
                        changed = True
                    continue

                existing_feature = ai.get(feature) if isinstance(ai.get(feature), dict) else {}
                normalized = self._normalize_ai_feature_metadata(feature, value)
                if (
                    feature == 'diarization'
                    and normalized.get('status')
                    and normalized.get('status') != 'completed'
                ):
                    normalized['segmentsPath'] = None
                merged = {**existing_feature, **normalized}
                if ai.get(feature) != merged:
                    ai[feature] = merged
                    changed = True

            if changed:
                if ai:
                    meeting['ai'] = ai
                else:
                    meeting.pop('ai', None)
                self._save_meetings_unlocked(meetings)
                print(f"Meeting AI metadata updated: {meeting_id}", file=sys.stderr)

            return meeting

    def delete_meeting(self, meeting_id: str) -> bool:
        """
        Delete a meeting and its associated files.

        Args:
            meeting_id: Meeting ID to delete

        Returns:
            True if deleted, False if not found
        """
        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            meeting = next((m for m in meetings if m['id'] == meeting_id), None)

            if not meeting:
                return False

            # FIX: Windows retry logic for file locks
            # Files may be locked by antivirus, file explorer, audio player, etc.
            max_retries = 3
            retry_delay = 0.5  # 500ms

            moved_files: List[tuple[Path, Path, str]] = []
            try:
                for label, file_path in self._meeting_file_references(meeting):
                    tombstone_path = meeting_delete.move_file_to_tombstone(
                        file_path,
                        label,
                        max_retries=max_retries,
                        retry_delay=retry_delay,
                    )
                    if tombstone_path is not None:
                        moved_files.append((tombstone_path, file_path, label))

                # Commit metadata only after files have been moved out of their
                # canonical paths. If metadata save fails, files are restored.
                meetings = [m for m in meetings if m['id'] != meeting_id]
                self._save_meetings_unlocked(meetings)
            except Exception:
                meeting_delete.restore_moved_files(moved_files)
                raise

            for tombstone_path, _original_path, label in moved_files:
                try:
                    meeting_delete.delete_file_with_retry(
                        tombstone_path,
                        label,
                        max_retries=max_retries,
                        retry_delay=retry_delay,
                    )
                except RuntimeError as deletion_error:
                    print(f"Warning: {deletion_error}", file=sys.stderr)

            print(f"Meeting deleted: {meeting_id}", file=sys.stderr)
            return True

    def _save_meetings(self, meetings: List[Dict]):
        """Save meetings list to JSON file."""
        meeting_store.save_meetings(self, meetings)


# CLI interface for testing
def main():
    """CLI for testing meeting manager."""
    import argparse

    parser = argparse.ArgumentParser(description="Meeting Manager CLI")
    parser.add_argument('--recordings-dir', default='recordings', help='Recordings directory path')
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')

    # List meetings
    subparsers.add_parser('list', help='List all meetings')

    # Scan and sync recordings
    subparsers.add_parser('scan', help='Scan recordings directory and add missing meetings to database')

    # Get meeting
    get_parser = subparsers.add_parser('get', help='Get meeting details')
    get_parser.add_argument('id', help='Meeting ID')

    # Delete meeting
    delete_parser = subparsers.add_parser('delete', help='Delete meeting')
    delete_parser.add_argument('id', help='Meeting ID')

    # Update meeting (rename, etc.)
    update_parser = subparsers.add_parser('update', help='Update meeting metadata')
    update_parser.add_argument('id', help='Meeting ID')
    update_parser.add_argument('--title', help='New display title')

    update_transcription_parser = subparsers.add_parser('update-transcription', help='Update transcription metadata for a meeting')
    update_transcription_parser.add_argument('id', help='Meeting ID')
    update_transcription_parser.add_argument('--status', choices=sorted(_VALID_TRANSCRIPTION_STATUSES), help='Transcription status')
    update_transcription_parser.add_argument('--error', help='Sanitized transcription error')
    update_transcription_parser.add_argument('--clear-error', action='store_true', help='Clear transcription error')
    update_transcription_parser.add_argument('--language', help='Updated language code')
    update_transcription_parser.add_argument('--model', help='Updated model name')
    update_transcription_parser.add_argument('--duration', type=float, help='Updated duration in seconds')
    update_transcription_parser.add_argument(
        '--device',
        choices=_TRANSCRIPTION_DEVICE_CLI_CHOICES,
        help='Resolved transcription device (metal accepted as mps alias)',
    )
    update_transcription_parser.add_argument('--compute-type', help='Resolved transcription compute type')

    update_ai_parser = subparsers.add_parser('update-ai', help='Update derived local AI metadata')
    update_ai_parser.add_argument('id', help='Meeting ID')
    update_ai_parser.add_argument('--diarization-json', help='Diarization metadata JSON object')
    update_ai_parser.add_argument('--summary-json', help='Summary metadata JSON object')
    update_ai_parser.add_argument('--clear-diarization', action='store_true', help='Remove diarization metadata')
    update_ai_parser.add_argument('--clear-summary', action='store_true', help='Remove summary metadata')

    # Add meeting (for testing)
    add_parser = subparsers.add_parser('add', help='Add meeting')
    add_parser.add_argument('--audio', required=True, help='Audio file path')
    add_parser.add_argument('--transcript', required=True, help='Transcript file path')
    add_parser.add_argument('--duration', type=float, required=True, help='Duration in seconds')
    add_parser.add_argument('--language', default='en', help='Language code')
    add_parser.add_argument('--model', default='base', help='Model size')
    add_parser.add_argument('--title', help='Custom title')
    add_parser.add_argument('--transcription-status', choices=sorted(_VALID_TRANSCRIPTION_STATUSES), default='completed', help='Transcription status')
    add_parser.add_argument('--transcription-error', help='Sanitized transcription error')
    add_parser.add_argument(
        '--transcription-device',
        choices=_TRANSCRIPTION_DEVICE_CLI_CHOICES,
        help='Resolved transcription device (metal accepted as mps alias)',
    )
    add_parser.add_argument('--transcription-compute-type', help='Resolved transcription compute type')

    args = parser.parse_args()

    manager = MeetingManager(recordings_dir=args.recordings_dir)

    if args.command == 'list':
        meetings = manager.list_meetings()
        print(json.dumps(meetings, indent=2))

    elif args.command == 'scan':
        result = manager.scan_and_sync_recordings()
        print(json.dumps(result, indent=2))

    elif args.command == 'get':
        meeting = manager.get_meeting(args.id)
        if meeting:
            print(json.dumps(meeting, indent=2))
        else:
            print(f"Meeting not found: {args.id}", file=sys.stderr)
            sys.exit(1)

    elif args.command == 'delete':
        if manager.delete_meeting(args.id):
            print(f"Deleted: {args.id}")
        else:
            print(f"Meeting not found: {args.id}", file=sys.stderr)
            sys.exit(1)

    elif args.command == 'update':
        meeting = manager.update_meeting(args.id, title=args.title)
        if meeting:
            print(json.dumps(meeting, indent=2))
        else:
            print(f"Meeting not found: {args.id}", file=sys.stderr)
            sys.exit(1)

    elif args.command == 'update-transcription':
        meeting = manager.update_transcription(
            args.id,
            status=args.status,
            error=args.error,
            clear_error=args.clear_error,
            language=args.language,
            model=args.model,
            duration=args.duration,
            device=args.device,
            compute_type=args.compute_type,
        )
        if meeting:
            print(json.dumps(meeting, indent=2))
        else:
            print(f"Meeting not found: {args.id}", file=sys.stderr)
            sys.exit(1)

    elif args.command == 'update-ai':
        diarization_metadata = None if args.clear_diarization else meeting_norm.parse_metadata(
            args.diarization_json,
            'diarization',
            unset=_UNSET,
        )
        summary_metadata = None if args.clear_summary else meeting_norm.parse_metadata(
            args.summary_json,
            'summary',
            unset=_UNSET,
        )
        meeting = manager.update_meeting_ai(
            args.id,
            diarization=diarization_metadata,
            summary=summary_metadata,
        )
        if meeting:
            print(json.dumps(meeting, indent=2))
        else:
            print(f"Meeting not found: {args.id}", file=sys.stderr)
            sys.exit(1)

    elif args.command == 'add':
        meeting = manager.add_meeting(
            audio_path=args.audio,
            transcript_path=args.transcript,
            duration=args.duration,
            language=args.language,
            model=args.model,
            title=args.title,
            transcription_status=args.transcription_status,
            transcription_error=args.transcription_error,
            transcription_device=args.transcription_device,
            transcription_compute_type=args.transcription_compute_type,
        )
        print(json.dumps(meeting, indent=2))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
