"""
Meeting Manager - Handles meeting history and metadata.

Stores meeting records in a JSON database and provides
operations for listing, retrieving, and deleting meetings.
"""

import errno
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
import stat
import threading
import tempfile

from filelock import FileLock

from meetings import delete_tx as meeting_delete
from meetings import normalization as meeting_norm
from meetings import paths as meeting_paths
from meetings import scan_import as meeting_scan
from meetings import store as meeting_store
from transcription import captions as transcript_captions


_UNSET = object()
_MAX_AI_METADATA_STRING_LENGTH = meeting_norm.MAX_AI_METADATA_STRING_LENGTH


def _nonnegative_generation(value: object) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_REQUEST')
    if number < 0 or number > 1_000_000_000:
        raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_REQUEST')
    return number
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
        self.scan_recovery_lock_file = self.recordings_dir / "scan_recovery.lock"
        self._scan_recovery_thread_lock = threading.RLock()
        self._scan_recovery_file_lock = FileLock(str(self.scan_recovery_lock_file), timeout=120)
        self._corrupt_metadata_backup_path: Optional[Path] = None
        self._corrupt_metadata_signature: Optional[tuple[int, int]] = None

        # Another process can initialize and write History while we wait for the lock.
        if not self.metadata_file.exists():
            with self._metadata_guard():
                if not self.metadata_file.exists():
                    self._save_meetings_unlocked([])

    @contextmanager
    def _metadata_guard(self):
        """Serialize metadata operations across threads and processes."""
        with meeting_store.metadata_guard(self):
            yield

    @contextmanager
    def _scan_recovery_guard(self):
        """Serialize slow scan/temp recovery without holding meetings.json.lock."""
        with meeting_scan.scan_recovery_guard(self):
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

    def _sync_recordings_dir(self):
        try:
            fd = os.open(self.recordings_dir, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        except (AttributeError, OSError):
            pass  # Directory fsync is unavailable on Windows.

    def _reconcile_import_transactions_unlocked(self):
        """Roll back interrupted imports before a scan can see their final files.

        A marker is created before either copy. Metadata is the commit point;
        after it, the final files belong to the meeting and must be retained.
        """
        import re
        markers = list(self.recordings_dir.glob('.meeting-import-*'))
        if not markers:
            return
        # An unreadable database cannot distinguish a committed import from an
        # interrupted copy. Preserve both files and markers until it is repaired.
        try:
            with self.metadata_file.open(encoding='utf-8') as metadata:
                meetings = json.load(metadata)
        except json.JSONDecodeError as exc:
            self._backup_corrupt_metadata(exc)
            raise RuntimeError('Cannot reconcile audio imports with corrupt meeting metadata') from exc
        if not isinstance(meetings, list) or any(
            not isinstance(meeting, dict)
            or not isinstance(meeting.get('audioPath'), str)
            or not meeting['audioPath']
            for meeting in meetings
        ):
            raise RuntimeError('Cannot reconcile audio imports with invalid meeting metadata')
        # Read every raw record before deduplication, which may otherwise discard
        # a record that still owns an import's audio.
        referenced = {str(Path(m['audioPath']).resolve(strict=False)) for m in meetings}
        for marker in markers:
            match = re.fullmatch(r'\.meeting-import-(\d{8}_\d{6}(?:_\d+)?)', marker.name)
            if not match or marker.is_symlink() or not marker.is_dir():
                continue
            stem = f'meeting_{match.group(1)}'
            audio = self.recordings_dir / f'{stem}.opus'
            transcript = self.recordings_dir / f'{stem}.md'
            if str(audio.resolve(strict=False)) not in referenced:
                for path in (audio, transcript):
                    path.unlink(missing_ok=True)
            marker.rmdir()

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
        transcription_request: Optional[Dict] = None,
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
        normalized_request = None
        if transcription_request is not None:
            normalized_request = meeting_norm.normalize_transcription_request(
                transcription_request,
                require_explicit=True,
            )

        now = datetime.now()
        base_id = now.strftime("%Y%m%d_%H%M%S")

        source_audio = Path(audio_path)
        source_transcript = Path(transcript_path)

        if source_audio.is_symlink() or source_transcript.is_symlink():
            raise ValueError('Symlinks are not allowed for meeting source files')

        source_audio = source_audio.resolve(strict=False)
        source_transcript = source_transcript.resolve(strict=False)

        is_import = (source_audio.parent == source_transcript.parent
                     and source_audio.parent.parent == self.recordings_dir.resolve(strict=False)
                     and source_audio.parent.name.startswith('.audio-import-')
                     and source_audio.name == 'audio.opus')

        if not self._is_recordings_path(source_audio):
            raise ValueError('Audio path must stay inside the recordings directory')
        if not self._is_recordings_path(source_transcript):
            raise ValueError('Transcript path must stay inside the recordings directory')
        if not source_audio.is_file():
            raise ValueError(f'Audio file not found: {source_audio}')
        if not self._wait_for_file(source_transcript):
            raise ValueError(f'Transcript file not found: {source_transcript}')

        if is_import:
            for source in (source_audio, source_transcript):
                # Windows needs a writable handle for FlushFileBuffers.
                source.chmod(source.stat().st_mode | stat.S_IWRITE)
                with source.open('r+b') as staged:
                    os.fsync(staged.fileno())

        with self._metadata_guard():
            self._reconcile_import_transactions_unlocked()
            meetings = self._list_meetings_locked()
            existing_ids = {m['id'] for m in meetings}

            # Ensure unique ID (handle rare case of multiple adds in same second)
            meeting_id = base_id
            counter = 1
            while (meeting_id in existing_ids
                   or (self.recordings_dir / f'meeting_{meeting_id}{source_audio.suffix}').exists()
                   or (self.recordings_dir / f'meeting_{meeting_id}.md').exists()):
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

            marker = self.recordings_dir / f'.meeting-import-{meeting_id}' if is_import else None
            if marker:
                marker.mkdir()
                self._sync_recordings_dir()

            try:
                if marker:
                    os.replace(source_audio, new_audio_path)
                else:
                    shutil.copy2(source_audio, new_audio_path)
                copied_audio = True
                persisted_audio_path = new_audio_path
                print(f"Persisted audio to: {new_audio_path}", file=sys.stderr)

                if marker:
                    os.replace(source_transcript, new_transcript_path)
                else:
                    shutil.copy2(source_transcript, new_transcript_path)
                copied_transcript = True
                persisted_transcript_path = new_transcript_path
                print(f"Persisted transcript to: {new_transcript_path}", file=sys.stderr)

                if marker:
                    self._sync_recordings_dir()

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
                if normalized_request is not None:
                    meeting["transcriptionRequest"] = normalized_request
                    meeting["transcriptionAttemptGuard"] = {
                        "attemptId": normalized_request["attemptId"],
                        "cancelGeneration": 0,
                        "deleteGeneration": 0,
                    }
                    meeting["transcriptionStatus"] = "pending"

                # Add to beginning of existing meetings (most recent first)
                meetings.insert(0, meeting)
                self._save_meetings_unlocked(meetings)

                if marker:
                    try:
                        marker.rmdir()
                    except OSError:
                        pass  # Metadata is committed; restart removes the marker.

            except Exception:
                # A committed metadata write owns its files even if marker
                # cleanup fails. Recovery will remove the marker later.
                if marker and any(m.get('id') == meeting_id for m in self._load_meetings_unlocked()):
                    raise
                if (copied_audio or marker) and new_audio_path.exists():
                    try:
                        new_audio_path.unlink()
                    except OSError:
                        pass

                if (copied_transcript or marker) and new_transcript_path.exists():
                    try:
                        new_transcript_path.unlink()
                    except OSError:
                        pass

                if marker and not new_audio_path.exists() and not new_transcript_path.exists():
                    try:
                        marker.rmdir()
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

    def _build_direct_meeting_record(
        self,
        *,
        meeting_id: str,
        audio_path: str,
        transcript_path: str,
        duration: float,
        language: str,
        model: str,
        title: str,
        transcription_status: str = "completed",
        transcription_error: Optional[str] = None,
        transcription_result: Optional[Dict] = None,
    ) -> Dict:
        """Build a normalized meeting metadata record for direct insertion/scan commit."""
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
        if transcription_result is not None:
            meeting['transcriptionResult'] = meeting_norm.normalize_transcription_result(transcription_result)
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
        transcription_result: Optional[Dict] = None,
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

            meeting = self._build_direct_meeting_record(
                meeting_id=meeting_id,
                audio_path=audio_path,
                transcript_path=transcript_path,
                duration=duration,
                language=language,
                model=model,
                title=title,
                transcription_status=transcription_status,
                transcription_error=transcription_error,
                transcription_result=transcription_result,
            )

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
            return [
                self._strip_inline_transcript(meeting_norm.public_transcription_provenance(meeting))
                for meeting in self._list_meetings_locked()
            ]

    def scan_and_sync_recordings(self) -> Dict[str, int]:
        """
        Scan the recordings directory for audio/transcript files and add any
        missing meetings to the database.

        Slow recorder-temp recovery and filesystem discovery run under
        ``scan_recovery.lock`` without holding ``meetings.json.lock`` so
        concurrent History reads/writes/deletes remain responsive.

        Returns:
            Dictionary with counts: {'scanned': N, 'added': M, 'skipped': K}
        """
        with self._scan_recovery_guard():
            # Phase A: reconcile pending import transactions and snapshot known
            # meetings under a short metadata guard.
            with self._metadata_guard():
                self._reconcile_import_transactions_unlocked()
                snapshot_meetings = self._list_meetings_locked()
                snapshot_audio_names = {
                    Path(m['audioPath']).name
                    for m in snapshot_meetings
                    if isinstance(m.get('audioPath'), str) and m['audioPath']
                }
                snapshot_ids = {m['id'] for m in snapshot_meetings if m.get('id')}

            # Phase B: perform slow temp recovery and candidate discovery outside
            # the metadata guard so History operations do not contend.
            scanned = 0
            added = 0
            skipped = 0
            candidates: List[meeting_scan.ScanCandidate] = []

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

            audio_files = self._select_scannable_audio_files(self.recordings_dir)

            for audio_file in audio_files:
                scanned += 1

                if audio_file.is_symlink():
                    print(f"Warning: Skipping symlink audio file during scan: {audio_file.name}", file=sys.stderr)
                    skipped += 1
                    continue

                if audio_file.name in snapshot_audio_names:
                    skipped += 1
                    continue

                transcript_file = meeting_scan.transcript_candidate_for_audio(audio_file)
                if transcript_file.is_symlink():
                    print(f"Warning: Skipping symlink transcript during scan: {transcript_file.name}", file=sys.stderr)
                    skipped += 1
                    continue

                resolved_audio = audio_file.resolve(strict=False)
                resolved_transcript = transcript_file.resolve(strict=False)
                if not self._is_recordings_path(resolved_audio) or not self._is_recordings_path(resolved_transcript):
                    print(
                        f"Warning: Skipping {audio_file.name}: resolved path escapes recordings directory",
                        file=sys.stderr,
                    )
                    skipped += 1
                    continue

                meeting_id, title = meeting_scan.parse_scan_meeting_id_and_title(audio_file.stem)
                if meeting_id in snapshot_ids:
                    print(f"Skipping {audio_file.name}: ID {meeting_id} already exists", file=sys.stderr)
                    skipped += 1
                    continue

                captions_file = transcript_captions.captions_sidecar_path_for_audio(resolved_audio)
                try:
                    transcript_identity = meeting_scan.file_identity(transcript_file)
                    captions_identity = meeting_scan.file_identity(captions_file)
                    has_existing_transcript = transcript_file.is_file()
                    duration = 0.0
                    matched_captions = None
                    if has_existing_transcript:
                        duration = meeting_scan.extract_duration_from_transcript_file(transcript_file)
                        transcript_text = self._read_transcript_text(resolved_transcript)
                        if transcript_text:
                            matched_captions = self._find_valid_sibling_captions(resolved_audio, transcript_text)
                    if (transcript_identity != meeting_scan.file_identity(transcript_file)
                            or captions_identity != meeting_scan.file_identity(captions_file)):
                        skipped += 1
                        continue
                except OSError:
                    skipped += 1
                    continue

                candidates.append(
                    meeting_scan.ScanCandidate(
                        audio_file=audio_file,
                        transcript_file=transcript_file,
                        meeting_id=meeting_id,
                        title=title,
                        duration=duration,
                        has_existing_transcript=has_existing_transcript,
                        transcript_identity=transcript_identity,
                        captions_identity=captions_identity,
                        matched_captions=matched_captions,
                    )
                )

            # Phase C: re-reconcile import transactions, re-verify candidates
            # against live metadata/filesystem state, write placeholders, and
            # commit all newly discovered meetings in one atomic metadata write.
            if candidates:
                with self._metadata_guard():
                    self._reconcile_import_transactions_unlocked()
                    existing_meetings = self._list_meetings_locked()
                    existing_audio_names = {
                        Path(m['audioPath']).name
                        for m in existing_meetings
                        if isinstance(m.get('audioPath'), str) and m['audioPath']
                    }
                    existing_ids = {m['id'] for m in existing_meetings if m.get('id')}

                    newly_added: List[tuple[Path, Dict]] = []
                    created_placeholders: List[Path] = []

                    try:
                        for candidate in candidates:
                            if candidate.audio_file.is_symlink() or not candidate.audio_file.is_file():
                                skipped += 1
                                continue
                            if meeting_scan.has_sibling_capture_session(candidate.audio_file):
                                skipped += 1
                                continue
                            if candidate.audio_file.name in existing_audio_names:
                                skipped += 1
                                continue
                            if candidate.meeting_id in existing_ids:
                                print(f"Skipping {candidate.audio_file.name}: ID {candidate.meeting_id} already exists", file=sys.stderr)
                                skipped += 1
                                continue
                            if candidate.transcript_file.is_symlink():
                                print(f"Warning: Skipping symlink transcript during scan: {candidate.transcript_file.name}", file=sys.stderr)
                                skipped += 1
                                continue

                            resolved_audio = candidate.audio_file.resolve(strict=False)
                            resolved_transcript = candidate.transcript_file.resolve(strict=False)
                            if not self._is_recordings_path(resolved_audio) or not self._is_recordings_path(resolved_transcript):
                                print(
                                    f"Warning: Skipping {candidate.audio_file.name}: resolved path escapes recordings directory",
                                    file=sys.stderr,
                                )
                                skipped += 1
                                continue

                            captions_file = transcript_captions.captions_sidecar_path_for_audio(resolved_audio)
                            try:
                                if (candidate.transcript_identity != meeting_scan.file_identity(candidate.transcript_file)
                                        or candidate.captions_identity != meeting_scan.file_identity(captions_file)):
                                    skipped += 1
                                    continue
                            except OSError:
                                skipped += 1
                                continue
                            if candidate.has_existing_transcript:
                                placeholder_created = False
                                duration = candidate.duration
                            elif candidate.transcript_identity is not None:
                                skipped += 1
                                continue
                            else:
                                placeholder = self._build_pending_transcript_placeholder(candidate.audio_file.name)
                                try:
                                    with candidate.transcript_file.open('x', encoding='utf-8') as output:
                                        output.write(placeholder)
                                except Exception as e:
                                    print(
                                        f"Warning: Could not create placeholder transcript for {candidate.audio_file.name}: {e}",
                                        file=sys.stderr,
                                    )
                                    skipped += 1
                                    continue
                                placeholder_created = True
                                created_placeholders.append(candidate.transcript_file)
                                print(
                                    f"Created pending transcript placeholder for {candidate.audio_file.name}",
                                    file=sys.stderr,
                                )
                                duration = 0.0

                            meeting = self._build_direct_meeting_record(
                                meeting_id=candidate.meeting_id,
                                audio_path=str(resolved_audio),
                                transcript_path=str(resolved_transcript),
                                duration=duration,
                                language="en",
                                model="unknown",
                                title=candidate.title,
                                transcription_status="pending" if placeholder_created else "completed",
                                transcription_result=None if placeholder_created else {
                                    "schemaVersion": 1,
                                    "engine": "unknown",
                                },
                            )
                            if not placeholder_created and candidate.matched_captions is not None:
                                meeting['captionsPath'] = str(candidate.matched_captions['path'])
                                meeting['captionsSourceTranscriptHash'] = candidate.matched_captions['hash']
                            existing_meetings.insert(0, meeting)
                            existing_ids.add(candidate.meeting_id)
                            existing_audio_names.add(Path(meeting['audioPath']).name)
                            newly_added.append((candidate.audio_file, meeting))

                        if newly_added:
                            self._save_meetings_unlocked(existing_meetings)
                    except Exception:
                        for placeholder_path in created_placeholders:
                            try:
                                placeholder_path.unlink(missing_ok=True)
                            except OSError:
                                pass
                        raise

                    for audio_file, meeting in newly_added:
                        print(
                            f"Added meeting from filesystem: {audio_file.name} (ID: {meeting['id']})",
                            file=sys.stderr,
                        )
                    added += len(newly_added)

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
                    hydrated = meeting_norm.public_transcription_provenance(meeting)
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
                    hydrated.update(self._inspect_meeting_captions(meeting, hydrated.get('transcript', '')))
                    return hydrated
            return None

    def _find_valid_sibling_captions(self, audio_path: Path, transcript_text: str) -> Optional[Dict]:
        candidate = transcript_captions.captions_sidecar_path_for_audio(audio_path)
        safe_path = self._resolve_accessible_recordings_file(
            candidate,
            allowed_suffixes=('.json',),
            must_exist=True,
            label='captions',
        )
        if safe_path is None:
            return None
        try:
            payload = json.loads(safe_path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return None
        expected_hash = transcript_captions.hash_transcript_text(transcript_text)
        valid, _reason = transcript_captions.validate_captions_payload(
            payload,
            expected_transcript_hash=expected_hash,
            require_non_empty=True,
        )
        if not valid:
            return None
        return {'path': safe_path, 'hash': expected_hash}

    def _inspect_meeting_captions(self, meeting: Dict, transcript_text: str) -> Dict:
        explicit_path = meeting.get('captionsPath')
        if explicit_path:
            target = Path(str(explicit_path))
        elif meeting.get('audioPath'):
            target = transcript_captions.captions_sidecar_path_for_audio(Path(str(meeting['audioPath'])))
        else:
            return {'captionsAvailable': False, 'captionsStatus': 'missing'}

        safe_captions_path = self._resolve_accessible_recordings_file(
            target,
            allowed_suffixes=('.json',),
            must_exist=True,
            label='captions',
        )
        if safe_captions_path is None:
            return {'captionsAvailable': False, 'captionsStatus': 'missing'}

        try:
            payload = json.loads(safe_captions_path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return {'captionsAvailable': False, 'captionsStatus': 'invalid'}

        struct_valid, _reason = transcript_captions.validate_captions_payload(
            payload,
            require_non_empty=False,
        )
        if not struct_valid:
            return {'captionsAvailable': False, 'captionsStatus': 'invalid'}

        expected_hash = transcript_captions.hash_transcript_text(transcript_text)
        if payload.get('sourceTranscriptHash') != expected_hash:
            return {'captionsAvailable': False, 'captionsStatus': 'stale'}

        cues = payload.get('cues') or []
        if not cues:
            return {'captionsAvailable': False, 'captionsStatus': 'missing'}

        return {
            'captionsAvailable': True,
            'captionsStatus': 'ready',
            'captionsCueCount': len(cues),
            'captionsTimingPrecision': payload.get('timingPrecision'),
        }

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

    def stage_transcription_request(
        self,
        meeting_id: str,
        request: Dict,
        *,
        cancel_generation: int = 0,
        delete_generation: int = 0,
    ) -> Optional[Dict]:
        """Persist a new attempt without changing completed transcript provenance."""
        normalized = meeting_norm.normalize_transcription_request(request, require_explicit=True)
        guard = {
            "attemptId": normalized["attemptId"],
            "cancelGeneration": _nonnegative_generation(cancel_generation),
            "deleteGeneration": _nonnegative_generation(delete_generation),
        }
        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            meeting = next((item for item in meetings if item['id'] == meeting_id), None)
            if not meeting:
                return None
            meeting['transcriptionRequest'] = normalized
            meeting['transcriptionAttemptGuard'] = guard
            meeting['transcriptionStatus'] = 'pending'
            meeting['transcriptionError'] = None
            self._save_meetings_unlocked(meetings)
            return meeting_norm.public_transcription_provenance(meeting)

    def exclude_incomplete_transcription(self, meeting_id: str) -> Optional[Dict]:
        """Stop resume for a pending meeting whose request was never stored."""
        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            meeting = next((item for item in meetings if item['id'] == meeting_id), None)
            if not meeting:
                return None
            if meeting.get('transcriptionRequest'):
                return meeting_norm.public_transcription_provenance(meeting)
            meeting['transcriptionStatus'] = 'failed'
            meeting['transcriptionResumeExcluded'] = True
            meeting['transcriptionError'] = self._normalize_transcription_error(
                'Transcription request was not saved.'
            ) or 'Transcription request was not saved.'
            self._save_meetings_unlocked(meetings)
            return meeting_norm.public_transcription_provenance(meeting)

    def fail_transcription_attempt(self, meeting_id: str, attempt_id: str, error: str) -> Optional[Dict]:
        """Record a failed attempt while retaining completed output and audio."""
        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            meeting = next((item for item in meetings if item['id'] == meeting_id), None)
            if not meeting:
                return None
            request = meeting.get('transcriptionRequest') or {}
            guard = meeting.get('transcriptionAttemptGuard') or {}
            if request.get('attemptId') != attempt_id or guard.get('attemptId') != attempt_id:
                raise meeting_norm.TranscriptionMetadataError('STALE_TRANSCRIPTION_ATTEMPT')
            meeting['transcriptionStatus'] = 'failed'
            meeting['transcriptionError'] = self._normalize_transcription_error(error) or 'Transcription failed.'
            meeting.pop('transcriptionAttemptGuard', None)
            self._save_meetings_unlocked(meetings)
            return meeting_norm.public_transcription_provenance(meeting)

    def commit_transcription_attempt(
        self,
        meeting_id: str,
        *,
        attempt_id: str,
        candidate_path: str,
        result: Dict,
        cancel_generation: int,
        delete_generation: int,
        captions_candidate_path: Optional[str] = None,
    ) -> Optional[Dict]:
        """Point metadata at a candidate transcript only after the attempt is still current."""
        previous_captions = None
        committed_captions = None
        canonical_captions_to_remove: Optional[Path] = None
        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            meeting = next((item for item in meetings if item['id'] == meeting_id), None)
            if not meeting:
                return None
            request = meeting.get('transcriptionRequest') or {}
            guard = meeting.get('transcriptionAttemptGuard') or {}
            if request.get('attemptId') != attempt_id or guard.get('attemptId') != attempt_id:
                raise meeting_norm.TranscriptionMetadataError('STALE_TRANSCRIPTION_ATTEMPT')
            if meeting.get('transcriptionStatus') != 'pending':
                raise meeting_norm.TranscriptionMetadataError('TRANSCRIPTION_ATTEMPT_SUPERSEDED')
            if (
                int(guard.get('cancelGeneration', -1)) != _nonnegative_generation(cancel_generation)
                or int(guard.get('deleteGeneration', -1)) != _nonnegative_generation(delete_generation)
            ):
                raise meeting_norm.TranscriptionMetadataError('TRANSCRIPTION_ATTEMPT_SUPERSEDED')

            expected_name = meeting_norm.expected_attempt_transcript_name(meeting.get('audioPath'), attempt_id)
            candidate = self._resolve_accessible_recordings_file(
                Path(candidate_path),
                allowed_suffixes=('.md',),
                must_exist=True,
                label='candidate transcript',
            )
            if candidate is None or candidate.name != expected_name:
                raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_RESULT')
            try:
                candidate_text = candidate.read_text(encoding='utf-8')
            except (OSError, UnicodeError):
                raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_RESULT')
            if not candidate_text.strip():
                raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_RESULT')

            normalized_result = meeting_norm.normalize_transcription_result(result, attempt_id=attempt_id)
            transcript_hash = self._hash_text(candidate_text)
            captions_transcript_hash = transcript_captions.hash_transcript_text(candidate_text)
            if normalized_result.get('transcriptHash') not in (None, transcript_hash):
                raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_RESULT')
            normalized_result['transcriptHash'] = transcript_hash
            if normalized_result.get('engine') != request.get('engine'):
                raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_RESULT')

            canonical_captions_target = transcript_captions.captions_sidecar_path_for_audio(Path(meeting['audioPath']))
            safe_captions_candidate: Optional[Path] = None
            safe_canonical_captions: Optional[Path] = None
            backup_captions_path: Optional[Path] = None
            replaced_canonical_captions = False
            if captions_candidate_path:
                expected_captions_name = meeting_norm.expected_attempt_captions_name(meeting.get('audioPath'), attempt_id)
                safe_captions_candidate = self._resolve_accessible_recordings_file(
                    Path(captions_candidate_path),
                    allowed_suffixes=('.json',),
                    must_exist=True,
                    label='candidate captions',
                )
                if safe_captions_candidate is None or safe_captions_candidate.name != expected_captions_name:
                    raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_RESULT')
                safe_canonical_captions = self._resolve_accessible_recordings_file(
                    canonical_captions_target,
                    allowed_suffixes=('.json',),
                    must_exist=False,
                    label='canonical captions',
                )
                if safe_canonical_captions is None:
                    raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_RESULT')
                try:
                    captions_payload = json.loads(safe_captions_candidate.read_text(encoding='utf-8'))
                except (OSError, UnicodeError, json.JSONDecodeError):
                    raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_RESULT')
                valid_captions, _reason = transcript_captions.validate_captions_payload(
                    captions_payload,
                    expected_transcript_hash=captions_transcript_hash,
                    require_non_empty=False,
                )
                if not valid_captions:
                    raise meeting_norm.TranscriptionMetadataError('INVALID_TRANSCRIPTION_RESULT')

            previous_transcript = meeting.get('transcriptPath')
            previous_captions = meeting.get('captionsPath')
            # Invalidate speakers in the same transaction as transcript replacement.
            # Failed attempts never reach this point; their prior AI outputs survive.
            if isinstance(meeting.get('ai'), dict):
                meeting['ai'].pop('diarization', None)
            meeting['transcriptPath'] = str(candidate.resolve(strict=False))
            meeting['transcriptionResult'] = normalized_result
            meeting['transcriptionStatus'] = 'completed'
            meeting['transcriptionError'] = None
            meeting['language'] = normalized_result.get('language') or meeting.get('language')
            if normalized_result.get('engine') == 'parakeet':
                meeting['model'] = normalized_result.get('modelId')
            else:
                meeting['model'] = normalized_result.get('modelSize') or meeting.get('model')
            meeting['transcriptionDevice'] = normalized_result.get('device')
            meeting['transcriptionComputeType'] = normalized_result.get('computeType')
            meeting.pop('transcriptionAttemptGuard', None)

            if safe_captions_candidate is not None and safe_canonical_captions is not None:
                if safe_canonical_captions.exists() and safe_canonical_captions != safe_captions_candidate:
                    try:
                        with tempfile.NamedTemporaryFile(
                            mode='wb', prefix=f".{safe_canonical_captions.name}.bak.",
                            dir=safe_canonical_captions.parent, delete=False,
                        ) as backup:
                            backup_captions_path = Path(backup.name)
                            with safe_canonical_captions.open('rb') as source:
                                shutil.copyfileobj(source, backup)
                    except Exception:
                        if backup_captions_path is not None:
                            try:
                                backup_captions_path.unlink(missing_ok=True)
                            except OSError:
                                pass
                        raise
                try:
                    os.replace(safe_captions_candidate, safe_canonical_captions)
                except Exception:
                    if backup_captions_path is not None:
                        try:
                            backup_captions_path.unlink(missing_ok=True)
                        except OSError:
                            pass
                    raise
                replaced_canonical_captions = True
                committed_captions = str(safe_canonical_captions.resolve(strict=False))
                meeting['captionsPath'] = committed_captions
                meeting['captionsSourceTranscriptHash'] = captions_transcript_hash
            else:
                meeting.pop('captionsPath', None)
                meeting.pop('captionsSourceTranscriptHash', None)
                canonical_captions_to_remove = canonical_captions_target

            try:
                self._save_meetings_unlocked(meetings)
            except Exception:
                if replaced_canonical_captions and safe_canonical_captions is not None and safe_captions_candidate is not None:
                    try:
                        if safe_canonical_captions.exists():
                            os.replace(safe_canonical_captions, safe_captions_candidate)
                    except OSError:
                        pass
                if backup_captions_path is not None and safe_canonical_captions is not None and backup_captions_path.exists():
                    try:
                        os.replace(backup_captions_path, safe_canonical_captions)
                    except OSError:
                        pass
                raise

            if backup_captions_path is not None and backup_captions_path.exists():
                try:
                    backup_captions_path.unlink()
                except OSError:
                    pass
            self._remove_obsolete_captions(previous_captions, committed_captions, canonical_captions_to_remove)

        self._remove_obsolete_transcript(previous_transcript, meeting['transcriptPath'])
        return meeting_norm.public_transcription_provenance(meeting)

    def _remove_obsolete_captions(
        self,
        previous_path: Optional[str],
        committed_path: Optional[str],
        canonical_target: Optional[Path] = None,
    ) -> None:
        candidates = []
        if previous_path and str(previous_path) != str(committed_path or ''):
            candidates.append(Path(previous_path))
        if canonical_target is not None and str(canonical_target.resolve(strict=False)) != str(committed_path or ''):
            candidates.append(canonical_target)
        for path in candidates:
            try:
                obsolete = self._resolve_accessible_recordings_file(
                    path,
                    allowed_suffixes=('.json',),
                    must_exist=True,
                    label='previous captions',
                )
            except Exception:
                continue
            if obsolete is None:
                continue
            try:
                obsolete.unlink()
            except OSError as exc:
                print(f"Warning: Could not remove obsolete captions: {exc}", file=sys.stderr)

    def _remove_obsolete_transcript(self, previous_path: Optional[str], committed_path: str) -> None:
        if not previous_path or str(previous_path) == str(committed_path):
            return
        try:
            obsolete = self._resolve_accessible_recordings_file(
                Path(previous_path),
                allowed_suffixes=('.md',),
                must_exist=True,
                label='previous transcript',
            )
        except Exception:
            return
        if obsolete is None:
            return
        try:
            obsolete.unlink()
        except OSError as exc:
            print(f"Warning: Could not remove obsolete transcript: {exc}", file=sys.stderr)

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

    exclude_parser = subparsers.add_parser(
        'exclude-incomplete-transcription',
        help='Mark a pending meeting failed when its transcription request was not stored',
    )
    exclude_parser.add_argument('id', help='Meeting ID')

    stage_parser = subparsers.add_parser('stage-transcription-request', help='Persist a transcription attempt without changing completed output')
    stage_parser.add_argument('id', help='Meeting ID')
    stage_parser.add_argument('--request-json', required=True, help='Bounded transcription request JSON')
    stage_parser.add_argument('--cancel-generation', type=int, default=0)
    stage_parser.add_argument('--delete-generation', type=int, default=0)

    fail_parser = subparsers.add_parser('fail-transcription-attempt', help='Record a failed attempt and keep completed output')
    fail_parser.add_argument('id', help='Meeting ID')
    fail_parser.add_argument('--attempt-id', required=True)
    fail_parser.add_argument('--error', required=True)

    commit_parser = subparsers.add_parser('commit-transcription-attempt', help='Commit a candidate transcript after the attempt is still current')
    commit_parser.add_argument('id', help='Meeting ID')
    commit_parser.add_argument('--attempt-id', required=True)
    commit_parser.add_argument('--candidate', required=True)
    commit_parser.add_argument('--captions-candidate', default=None)
    commit_parser.add_argument('--result-json', required=True)
    commit_parser.add_argument('--cancel-generation', type=int, required=True)
    commit_parser.add_argument('--delete-generation', type=int, required=True)

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
    add_parser.add_argument('--request-json', help='Bounded transcription request stored with the new meeting')

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

    elif args.command == 'exclude-incomplete-transcription':
        meeting = manager.exclude_incomplete_transcription(args.id)
        if meeting:
            print(json.dumps(meeting, indent=2))
        else:
            print(f"Meeting not found: {args.id}", file=sys.stderr)
            sys.exit(1)

    elif args.command == 'stage-transcription-request':
        try:
            request = json.loads(args.request_json)
            meeting = manager.stage_transcription_request(
                args.id,
                request,
                cancel_generation=args.cancel_generation,
                delete_generation=args.delete_generation,
            )
        except (json.JSONDecodeError, meeting_norm.TranscriptionMetadataError) as exc:
            print(getattr(exc, 'code', 'INVALID_TRANSCRIPTION_REQUEST'), file=sys.stderr)
            sys.exit(1)
        if meeting:
            print(json.dumps(meeting, indent=2))
        else:
            print(f"Meeting not found: {args.id}", file=sys.stderr)
            sys.exit(1)

    elif args.command == 'fail-transcription-attempt':
        try:
            meeting = manager.fail_transcription_attempt(args.id, args.attempt_id, args.error)
        except meeting_norm.TranscriptionMetadataError as exc:
            print(exc.code, file=sys.stderr)
            sys.exit(1)
        if meeting:
            print(json.dumps(meeting, indent=2))
        else:
            print(f"Meeting not found: {args.id}", file=sys.stderr)
            sys.exit(1)

    elif args.command == 'commit-transcription-attempt':
        try:
            result = json.loads(args.result_json)
            meeting = manager.commit_transcription_attempt(
                args.id,
                attempt_id=args.attempt_id,
                candidate_path=args.candidate,
                result=result,
                cancel_generation=args.cancel_generation,
                delete_generation=args.delete_generation,
                captions_candidate_path=args.captions_candidate,
            )
        except (json.JSONDecodeError, meeting_norm.TranscriptionMetadataError) as exc:
            print(getattr(exc, 'code', 'INVALID_TRANSCRIPTION_RESULT'), file=sys.stderr)
            sys.exit(1)
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
        request = None
        if getattr(args, 'request_json', None):
            try:
                request = json.loads(args.request_json)
            except json.JSONDecodeError:
                print('INVALID_TRANSCRIPTION_REQUEST', file=sys.stderr)
                sys.exit(1)
        try:
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
                transcription_request=request,
            )
        except meeting_norm.TranscriptionMetadataError as exc:
            print(exc.code, file=sys.stderr)
            sys.exit(1)
        except OSError as exc:
            if exc.errno not in (errno.ENOSPC, errno.EDQUOT):
                raise
            print('MEETING_STORAGE_FULL', file=sys.stderr)
            sys.exit(1)
        print(json.dumps(meeting, indent=2))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
