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
        meeting_id = now.strftime("%Y%m%d_%H%M%S")

        # Auto-generate title if not provided
        if not title:
            title = f"Meeting {now.strftime('%Y-%m-%d %H:%M')}"

        # Format duration
        minutes = int(duration // 60)
        seconds = int(duration % 60)
        duration_str = f"{minutes}:{seconds:02d}"

        # Read transcript text
        transcript_text = ""
        transcript_file = Path(transcript_path)
        if transcript_file.exists():
            transcript_text = transcript_file.read_text(encoding='utf-8')

        meeting = {
            "id": meeting_id,
            "title": title,
            "date": now.isoformat(),
            "duration": duration_str,
            "durationSeconds": duration,
            "audioPath": str(audio_path),
            "transcriptPath": str(transcript_path),
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

    def list_meetings(self) -> List[Dict]:
        """
        Get all meetings sorted by date (newest first).

        Returns:
            List of meeting objects
        """
        try:
            with open(self.metadata_file, 'r', encoding='utf-8') as f:
                meetings = json.load(f)

            # Sort by date (newest first)
            meetings.sort(key=lambda m: m.get('date', ''), reverse=True)
            return meetings
        except (FileNotFoundError, json.JSONDecodeError):
            return []

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
        meetings = self.list_meetings()
        meeting = self.get_meeting(meeting_id)

        if not meeting:
            return False

        # Delete audio file
        audio_path = Path(meeting['audioPath'])
        if audio_path.exists():
            audio_path.unlink()
            print(f"Deleted audio: {audio_path}", file=sys.stderr)

        # Delete transcript file
        transcript_path = Path(meeting['transcriptPath'])
        if transcript_path.exists():
            transcript_path.unlink()
            print(f"Deleted transcript: {transcript_path}", file=sys.stderr)

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
    subparsers = parser.add_subparsers(dest='command', help='Command to execute')

    # List meetings
    subparsers.add_parser('list', help='List all meetings')

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

    manager = MeetingManager()

    if args.command == 'list':
        meetings = manager.list_meetings()
        print(json.dumps(meetings, indent=2))

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
