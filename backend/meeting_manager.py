"""
Meeting Manager - Handles meeting history and metadata.

Stores meeting records in a JSON database and provides
operations for listing, retrieving, and deleting meetings.
"""

import json
import os
from contextlib import contextmanager
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
import sys
import shutil
import tempfile
import threading
import re
import hashlib

from filelock import FileLock


_UNSET = object()
_MAX_AI_METADATA_STRING_LENGTH = 300


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
        with self._metadata_thread_lock:
            with self._metadata_file_lock:
                yield

    def _load_meetings_unlocked(self) -> List[Dict]:
        """Load meetings without acquiring the metadata guard."""
        try:
            with open(self.metadata_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            return []
        except json.JSONDecodeError as exc:
            backup_path = self._backup_corrupt_metadata(exc)
            warning_path = backup_path.name if backup_path else self.metadata_file.name
            print(
                f"Warning: meetings metadata was corrupt and has been backed up to {warning_path}",
                file=sys.stderr,
            )
            return []

    def _backup_corrupt_metadata(self, error: json.JSONDecodeError) -> Optional[Path]:
        """Back up a corrupt metadata file before continuing with an empty in-memory list."""
        if not self.metadata_file.exists():
            return None

        try:
            stat = self.metadata_file.stat()
            signature = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            signature = None

        if (
            signature is not None
            and self._corrupt_metadata_signature == signature
            and self._corrupt_metadata_backup_path is not None
            and self._corrupt_metadata_backup_path.exists()
        ):
            return self._corrupt_metadata_backup_path

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = self.recordings_dir / f"meetings.corrupt.{timestamp}.json"
        counter = 1
        while backup_path.exists():
            backup_path = self.recordings_dir / f"meetings.corrupt.{timestamp}_{counter}.json"
            counter += 1

        shutil.copy2(self.metadata_file, backup_path)
        self._corrupt_metadata_backup_path = backup_path
        self._corrupt_metadata_signature = signature
        print(
            f"Warning: Backed up corrupt meetings metadata after JSON decode failure at line {error.lineno}, column {error.colno}",
            file=sys.stderr,
        )
        return backup_path

    def _save_meetings_unlocked(self, meetings: List[Dict]):
        """Atomically save meetings without acquiring the metadata guard."""
        temp_fd, temp_path = tempfile.mkstemp(
            prefix='meetings.',
            suffix='.tmp',
            dir=str(self.recordings_dir),
        )

        try:
            with os.fdopen(temp_fd, 'w', encoding='utf-8') as f:
                json.dump(meetings, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())

            os.replace(temp_path, self.metadata_file)
            self._corrupt_metadata_backup_path = None
            self._corrupt_metadata_signature = None

            try:
                dir_fd = os.open(self.recordings_dir, os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except (AttributeError, OSError):
                pass
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)

    def _list_meetings_locked(self) -> List[Dict]:
        """Load and deduplicate meetings while already holding the metadata guard."""
        meetings = self._load_meetings_unlocked()

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
            self._save_meetings_unlocked(unique_meetings)

        unique_meetings.sort(key=lambda m: m.get('date', ''), reverse=True)
        return unique_meetings

    @staticmethod
    def _read_text_file(file_path: Path, label: str) -> str:
        if not file_path.exists():
            return ""

        try:
            return file_path.read_text(encoding='utf-8', errors='replace')
        except Exception as exc:
            print(f"Warning: Could not read {label}: {exc}", file=sys.stderr)
            return ""

    @staticmethod
    def _read_transcript_text(transcript_path: Path) -> str:
        return MeetingManager._read_text_file(transcript_path, 'transcript')

    @staticmethod
    def _hash_text(text: str) -> str:
        return f"sha256:{hashlib.sha256(str(text or '').encode('utf-8')).hexdigest()}"

    @staticmethod
    def _select_scannable_audio_files(recordings_dir: Path) -> List[Path]:
        preferred_files = {}

        for audio_file in list(recordings_dir.glob('*.opus')) + list(recordings_dir.glob('*.wav')):
            stem = audio_file.stem
            current = preferred_files.get(stem)

            if current is None:
                preferred_files[stem] = audio_file
                continue

            if current.suffix == '.opus' and audio_file.suffix == '.wav':
                preferred_files[stem] = audio_file

        return sorted(preferred_files.values(), key=lambda item: item.name)

    @staticmethod
    def _strip_inline_transcript(meeting: Dict) -> Dict:
        stripped = dict(meeting)
        stripped.pop('transcript', None)
        return stripped

    def _is_recordings_path(self, file_path: Path) -> bool:
        try:
            file_path.resolve(strict=False).relative_to(self.recordings_dir.resolve(strict=False))
            return True
        except ValueError:
            return False

    def _normalize_sidecar_path(self, value: object, allowed_suffixes: tuple[str, ...]) -> Optional[str]:
        if value in (None, ''):
            return None

        file_path = Path(str(value)).resolve(strict=False)
        if file_path.suffix.lower() not in allowed_suffixes:
            raise ValueError('AI artifact path has an unsupported file extension')
        if not self._is_recordings_path(file_path):
            raise ValueError('AI artifact path must stay inside the recordings directory')
        return str(file_path)

    def _normalize_ai_feature_metadata(self, feature: str, metadata: Dict) -> Dict:
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

        def normalize_text(value: object) -> str:
            text = re.sub(r"\s+", " ", str(value or "")).strip()
            return text[:_MAX_AI_METADATA_STRING_LENGTH]

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
                normalized_path = self._normalize_sidecar_path(value, ('.json',))
                if normalized_path is not None:
                    normalized[field] = normalized_path
            elif field == 'markdownPath':
                normalized_path = self._normalize_sidecar_path(value, ('.md',))
                if normalized_path is not None:
                    normalized[field] = normalized_path
            elif field == 'sourceTranscriptHash':
                text = normalize_text(value)
                if re.fullmatch(r"sha256:[a-fA-F0-9]{64}", text):
                    normalized[field] = text
            else:
                normalized[field] = normalize_text(value)

        return normalized

    def _iter_ai_file_references(self, meeting: Dict) -> List[tuple[str, Path]]:
        ai = meeting.get('ai')
        if not isinstance(ai, dict):
            return []

        references: List[tuple[str, Path]] = []
        feature_file_fields = {
            'diarization': (
                ('speaker labels', 'segmentsPath'),
            ),
            'summary': (
                ('summary JSON', 'jsonPath'),
                ('summary Markdown', 'markdownPath'),
            ),
        }

        for feature, fields in feature_file_fields.items():
            feature_metadata = ai.get(feature)
            if not isinstance(feature_metadata, dict):
                continue

            for label, field in fields:
                file_path = feature_metadata.get(field)
                if file_path:
                    candidate = Path(str(file_path))
                    if self._is_recordings_path(candidate):
                        references.append((label, candidate))
                    else:
                        print(f"Warning: Ignoring unsafe AI artifact path for deletion: {candidate}", file=sys.stderr)

        return references

    def _meeting_file_references(self, meeting: Dict) -> List[tuple[str, Path]]:
        references = [
            ('audio', Path(meeting['audioPath'])),
            ('transcript', Path(meeting['transcriptPath'])),
            *self._iter_ai_file_references(meeting),
        ]

        unique_references: List[tuple[str, Path]] = []
        seen_paths = set()
        for label, file_path in references:
            path_key = str(file_path.resolve(strict=False))
            if path_key in seen_paths:
                continue
            seen_paths.add(path_key)
            unique_references.append((label, file_path))

        return unique_references

    def add_meeting(
        self,
        audio_path: str,
        transcript_path: str,
        duration: float,
        language: str = "en",
        model: str = "base",
        title: Optional[str] = None
    ) -> Dict:
        """
        Add a new meeting to the history.

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
                if source_audio.exists():
                    shutil.copy2(source_audio, new_audio_path)
                    copied_audio = True
                    persisted_audio_path = new_audio_path
                    print(f"Persisted audio to: {new_audio_path}", file=sys.stderr)

                if source_transcript.exists():
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
                    "model": model
                }

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
        title: str
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
                'model': model
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

        # Find all .opus and .wav audio files, preferring one candidate per stem
        audio_files = self._select_scannable_audio_files(self.recordings_dir)

        for audio_file in audio_files:
            scanned += 1

            # Skip if already in database
            if audio_file.name in existing_audio_paths:
                skipped += 1
                continue

            # Look for corresponding transcript
            transcript_file = audio_file.with_suffix('.md')
            if not transcript_file.exists():
                print(f"Warning: No transcript found for {audio_file.name}", file=sys.stderr)
                skipped += 1
                continue

            # Try to extract duration from transcript
            duration = 0.0
            try:
                content = transcript_file.read_text(encoding='utf-8', errors='replace')
                # Look for "Duration: HH:MM:SS" or "Duration: MM:SS"
                duration_match = re.search(r'\*\*Duration:\*\*\s*(\d+):(\d+):(\d+)', content)
                if duration_match:
                    hours, mins, secs = map(int, duration_match.groups())
                    duration = hours * 3600 + mins * 60 + secs
                else:
                    duration_match = re.search(r'\*\*Duration:\*\*\s*(\d+):(\d+)', content)
                    if duration_match:
                        mins, secs = map(int, duration_match.groups())
                        duration = mins * 60 + secs
            except Exception as e:
                print(f"Warning: Could not extract duration from {transcript_file.name}: {e}", file=sys.stderr)
                duration = 0.0

            # Extract ID and title from filename
            # Files can be: meeting_YYYYMMDD_HHMMSS.opus or recording_YYYY-MM-DDTHH-MM-SS.opus
            filename_base = audio_file.stem
            meeting_id = None
            title = None

            # Check if it's already a meeting_* file (extract existing ID, including suffixes)
            meeting_match = re.match(r'meeting_(\d{8}_\d{6}(?:_\d+)?)$', filename_base)
            if meeting_match:
                meeting_id = meeting_match.group(1)
                # Parse ID to create title: 20251208_170225 -> 2025-12-08 17:02
                try:
                    parts = meeting_id.split('_')
                    base_id = f"{parts[0]}_{parts[1]}" if len(parts) >= 2 else meeting_id
                    dt = datetime.strptime(base_id, "%Y%m%d_%H%M%S")
                    title = f"Meeting {dt.strftime('%Y-%m-%d %H:%M')}"
                except ValueError:
                    title = f"Meeting {meeting_id}"
            else:
                # Try recording_* format: recording_2025-12-01T13-31-43.opus
                recording_match = re.search(r'(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})', filename_base)
                if recording_match:
                    date_str, time_str = recording_match.groups()
                    # Generate ID from the timestamp
                    meeting_id = date_str.replace('-', '') + '_' + time_str.replace('-', '')
                    title = f"Meeting {date_str} {time_str.replace('-', ':')}"
                else:
                    # Fallback: generate new ID
                    meeting_id = datetime.now().strftime("%Y%m%d_%H%M%S")
                    title = f"Meeting {audio_file.stem}"

            # Check if this ID already exists in database
            existing_ids = {m['id'] for m in existing_meetings}
            if meeting_id in existing_ids:
                print(f"Skipping {audio_file.name}: ID {meeting_id} already exists", file=sys.stderr)
                skipped += 1
                continue

            # Add meeting to database directly (don't copy files - they're already in place)
            try:
                meeting = self._add_meeting_direct(
                    meeting_id=meeting_id,
                    audio_path=str(audio_file.absolute()),
                    transcript_path=str(transcript_file.absolute()),
                    duration=duration,
                    language="en",
                    model="unknown",
                    title=title
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
                    transcript_path = Path(meeting['transcriptPath'])
                    transcript_text = self._read_transcript_text(transcript_path)
                    if transcript_text:
                        hydrated['transcript'] = transcript_text
                    elif meeting.get('transcript'):
                        hydrated['transcript'] = meeting['transcript']
                    else:
                        hydrated['transcript'] = ""
                    summary = (meeting.get('ai') or {}).get('summary')
                    summary_path = summary.get('markdownPath') if isinstance(summary, dict) else None
                    hydrated['summary'] = self._read_text_file(Path(summary_path), 'summary') if summary_path else ""
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
        import time

        with self._metadata_guard():
            meetings = self._list_meetings_locked()
            meeting = next((m for m in meetings if m['id'] == meeting_id), None)

            if not meeting:
                return False

            # FIX: Windows retry logic for file locks
            # Files may be locked by antivirus, file explorer, audio player, etc.
            max_retries = 3
            retry_delay = 0.5  # 500ms

            def delete_file_with_retry(file_path: Path, label: str):
                if not file_path.exists():
                    return

                for attempt in range(max_retries):
                    try:
                        file_path.unlink()
                        print(f"Deleted {label}: {file_path}", file=sys.stderr)
                        return
                    except PermissionError as e:
                        if attempt < max_retries - 1:
                            print(f"File locked (attempt {attempt + 1}/{max_retries}), retrying... ({e})", file=sys.stderr)
                            time.sleep(retry_delay)
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

            def move_file_to_tombstone(file_path: Path, label: str) -> Optional[Path]:
                if not file_path.exists():
                    return None

                tombstone_path = tombstone_path_for(file_path)
                for attempt in range(max_retries):
                    try:
                        file_path.replace(tombstone_path)
                        print(f"Prepared {label} for deletion: {file_path}", file=sys.stderr)
                        return tombstone_path
                    except PermissionError as e:
                        if attempt < max_retries - 1:
                            print(f"File locked (attempt {attempt + 1}/{max_retries}), retrying... ({e})", file=sys.stderr)
                            time.sleep(retry_delay)
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

            moved_files: List[tuple[Path, Path, str]] = []
            try:
                for label, file_path in self._meeting_file_references(meeting):
                    tombstone_path = move_file_to_tombstone(file_path, label)
                    if tombstone_path is not None:
                        moved_files.append((tombstone_path, file_path, label))

                # Commit metadata only after files have been moved out of their
                # canonical paths. If metadata save fails, files are restored.
                meetings = [m for m in meetings if m['id'] != meeting_id]
                self._save_meetings_unlocked(meetings)
            except Exception:
                restore_moved_files(moved_files)
                raise

            for tombstone_path, _original_path, label in moved_files:
                try:
                    delete_file_with_retry(tombstone_path, label)
                except RuntimeError as deletion_error:
                    print(f"Warning: {deletion_error}", file=sys.stderr)

            print(f"Meeting deleted: {meeting_id}", file=sys.stderr)
            return True

    def _save_meetings(self, meetings: List[Dict]):
        """Save meetings list to JSON file."""
        with self._metadata_guard():
            self._save_meetings_unlocked(meetings)


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

    elif args.command == 'update-ai':
        def parse_metadata(raw_value: Optional[str], label: str):
            if raw_value is None:
                return _UNSET
            try:
                parsed = json.loads(raw_value)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"Invalid {label} metadata JSON: {exc}")
            if not isinstance(parsed, dict):
                raise SystemExit(f"Invalid {label} metadata JSON: expected object")
            return parsed

        diarization_metadata = None if args.clear_diarization else parse_metadata(args.diarization_json, 'diarization')
        summary_metadata = None if args.clear_summary else parse_metadata(args.summary_json, 'summary')
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
            title=args.title
        )
        print(json.dumps(meeting, indent=2))

    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
