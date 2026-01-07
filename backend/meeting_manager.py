"""
Meeting Manager - Handles meeting history and metadata.

Stores meeting records in a JSON database and provides
operations for listing, retrieving, and deleting meetings.
"""

import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional
import sys
import shutil


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

        # Create empty metadata file if it doesn't exist
        if not self.metadata_file.exists():
            self._save_meetings([])

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

        # Ensure unique ID (handle rare case of multiple adds in same second)
        existing_ids = {m['id'] for m in self.list_meetings()}
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
        source_audio = Path(audio_path)
        source_transcript = Path(transcript_path)
        
        new_audio_filename = f"meeting_{meeting_id}{source_audio.suffix}"
        new_transcript_filename = f"meeting_{meeting_id}.md"
        
        new_audio_path = self.recordings_dir / new_audio_filename
        new_transcript_path = self.recordings_dir / new_transcript_filename

        # Copy files to persistent storage (then remove originals to prevent duplicates)
        try:
            if source_audio.exists():
                shutil.copy2(source_audio, new_audio_path)
                print(f"Persisted audio to: {new_audio_path}", file=sys.stderr)
                # Remove original to prevent scan from re-adding it
                try:
                    source_audio.unlink()
                    print(f"Removed original audio: {source_audio}", file=sys.stderr)
                except Exception as del_err:
                    print(f"Warning: Could not remove original audio: {del_err}", file=sys.stderr)

            if source_transcript.exists():
                shutil.copy2(source_transcript, new_transcript_path)
                print(f"Persisted transcript to: {new_transcript_path}", file=sys.stderr)
                # Remove original transcript too
                try:
                    source_transcript.unlink()
                    print(f"Removed original transcript: {source_transcript}", file=sys.stderr)
                except Exception as del_err:
                    print(f"Warning: Could not remove original transcript: {del_err}", file=sys.stderr)
        except Exception as e:
            print(f"Error persisting files: {e}", file=sys.stderr)
            # Fallback to original paths if copy fails
            if not new_audio_path.exists():
                new_audio_path = source_audio
            if not new_transcript_path.exists():
                new_transcript_path = source_transcript

        # Read transcript text
        transcript_text = ""
        if new_transcript_path.exists():
            transcript_text = new_transcript_path.read_text(encoding='utf-8')

        meeting = {
            "id": meeting_id,
            "title": title,
            "date": now.isoformat(),
            "duration": duration_str,
            "durationSeconds": duration,
            "audioPath": str(new_audio_path.absolute()),
            "transcriptPath": str(new_transcript_path.absolute()),
            "transcript": transcript_text,
            "language": language,
            "model": model
        }

        # Load existing meetings and append
        meetings = self.list_meetings()
        meetings.insert(0, meeting)  # Add to beginning (most recent first)

        self._save_meetings(meetings)

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
        # Check for duplicate ID (defense-in-depth)
        existing_ids = {m['id'] for m in self.list_meetings()}
        if meeting_id in existing_ids:
            print(f"Warning: Skipping duplicate meeting ID: {meeting_id}", file=sys.stderr)
            return None

        # Format duration
        minutes = int(duration // 60)
        seconds = int(duration % 60)
        duration_str = f"{minutes}:{seconds:02d}"

        # Parse meeting_id to get date
        try:
            dt = datetime.strptime(meeting_id, "%Y%m%d_%H%M%S")
            date_iso = dt.isoformat()
        except ValueError:
            date_iso = datetime.now().isoformat()

        # Read transcript text
        transcript_text = ""
        transcript_file = Path(transcript_path)
        if transcript_file.exists():
            try:
                transcript_text = transcript_file.read_text(encoding='utf-8')
            except Exception as e:
                print(f"Warning: Could not read transcript: {e}", file=sys.stderr)

        meeting = {
            'id': meeting_id,
            'title': title,
            'date': date_iso,
            'duration': duration_str,
            'durationSeconds': duration,
            'audioPath': audio_path,
            'transcriptPath': transcript_path,
            'transcript': transcript_text,
            'language': language,
            'model': model
        }

        # Load existing meetings and append
        meetings = self.list_meetings()
        meetings.insert(0, meeting)

        self._save_meetings(meetings)
        return meeting

    def list_meetings(self) -> List[Dict]:
        """
        Get all meetings sorted by date (newest first).

        Automatically deduplicates entries by ID and saves cleaned data
        if duplicates are found.

        Returns:
            List of meeting objects
        """
        try:
            with open(self.metadata_file, 'r', encoding='utf-8') as f:
                meetings = json.load(f)

            # Deduplicate by ID (keep first occurrence, which is newest after sort)
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

            # If duplicates were found, save the cleaned list
            if duplicates_found > 0:
                print(f"Warning: Found and removed {duplicates_found} duplicate meeting(s) from database", file=sys.stderr)
                self._save_meetings(unique_meetings)

            # Sort by date (newest first)
            unique_meetings.sort(key=lambda m: m.get('date', ''), reverse=True)
            return unique_meetings
        except (FileNotFoundError, json.JSONDecodeError):
            return []

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

        # Find all .opus and .wav audio files
        audio_files = list(self.recordings_dir.glob('*.opus')) + list(self.recordings_dir.glob('*.wav'))

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
                content = transcript_file.read_text(encoding='utf-8')
                # Look for "Duration: HH:MM:SS" or "Duration: MM:SS"
                import re
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

            # Check if it's already a meeting_* file (extract existing ID)
            meeting_match = re.match(r'meeting_(\d{8}_\d{6})', filename_base)
            if meeting_match:
                meeting_id = meeting_match.group(1)
                # Parse ID to create title: 20251208_170225 -> 2025-12-08 17:02
                try:
                    dt = datetime.strptime(meeting_id, "%Y%m%d_%H%M%S")
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
        meetings = self.list_meetings()
        for meeting in meetings:
            if meeting['id'] == meeting_id:
                return meeting
        return None

    def delete_meeting(self, meeting_id: str) -> bool:
        """
        Delete a meeting and its associated files.

        Args:
            meeting_id: Meeting ID to delete

        Returns:
            True if deleted, False if not found
        """
        import time

        meetings = self.list_meetings()
        meeting = self.get_meeting(meeting_id)

        if not meeting:
            return False

        # FIX: Windows retry logic for file locks
        # Files may be locked by antivirus, file explorer, audio player, etc.
        max_retries = 3
        retry_delay = 0.5  # 500ms

        # Delete audio file with retry
        audio_path = Path(meeting['audioPath'])
        if audio_path.exists():
            for attempt in range(max_retries):
                try:
                    audio_path.unlink()
                    print(f"Deleted audio: {audio_path}", file=sys.stderr)
                    break
                except PermissionError as e:
                    if attempt < max_retries - 1:
                        print(f"File locked (attempt {attempt + 1}/{max_retries}), retrying... ({e})", file=sys.stderr)
                        time.sleep(retry_delay)
                    else:
                        raise RuntimeError(f"Failed to delete audio file after {max_retries} attempts: {e}")
                except Exception as e:
                    raise RuntimeError(f"Failed to delete audio file: {e}")

        # Delete transcript file with retry
        transcript_path = Path(meeting['transcriptPath'])
        if transcript_path.exists():
            for attempt in range(max_retries):
                try:
                    transcript_path.unlink()
                    print(f"Deleted transcript: {transcript_path}", file=sys.stderr)
                    break
                except PermissionError as e:
                    if attempt < max_retries - 1:
                        print(f"File locked (attempt {attempt + 1}/{max_retries}), retrying... ({e})", file=sys.stderr)
                        time.sleep(retry_delay)
                    else:
                        raise RuntimeError(f"Failed to delete transcript file after {max_retries} attempts: {e}")
                except Exception as e:
                    raise RuntimeError(f"Failed to delete transcript file: {e}")

        # Remove from list
        meetings = [m for m in meetings if m['id'] != meeting_id]
        self._save_meetings(meetings)

        print(f"Meeting deleted: {meeting_id}", file=sys.stderr)
        return True

    def _save_meetings(self, meetings: List[Dict]):
        """Save meetings list to JSON file."""
        with open(self.metadata_file, 'w', encoding='utf-8') as f:
            json.dump(meetings, f, indent=2, ensure_ascii=False)


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
