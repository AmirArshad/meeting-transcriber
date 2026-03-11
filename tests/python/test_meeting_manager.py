import json
from datetime import datetime as real_datetime
from pathlib import Path

import backend.meeting_manager as meeting_manager_module
from backend.meeting_manager import MeetingManager


def _create_source_files(base_dir: Path, stem: str):
    audio_path = base_dir / f'{stem}.opus'
    transcript_path = base_dir / f'{stem}.md'
    audio_path.write_bytes(b'audio-bytes')
    transcript_path.write_text('# Transcript\n\nHello world', encoding='utf-8')
    return audio_path, transcript_path


def test_add_meeting_persists_files_and_removes_originals(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    source_audio, source_transcript = _create_source_files(tmp_path, 'temp_recording')
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    meeting = manager.add_meeting(
        audio_path=str(source_audio),
        transcript_path=str(source_transcript),
        duration=65.0,
        language='en',
        model='small',
        title='Test Meeting',
    )

    persisted_audio = Path(meeting['audioPath'])
    persisted_transcript = Path(meeting['transcriptPath'])

    assert meeting['title'] == 'Test Meeting'
    assert meeting['duration'] == '1:05'
    assert persisted_audio.exists()
    assert persisted_transcript.exists()
    assert persisted_audio.name.startswith('meeting_')
    assert persisted_transcript.read_text(encoding='utf-8').startswith('# Transcript')
    assert not source_audio.exists()
    assert not source_transcript.exists()


def test_add_meeting_generates_unique_suffix_for_same_second(tmp_path, monkeypatch):
    fixed_now = real_datetime(2026, 1, 7, 10, 45, 55)

    class FrozenDateTime:
        @classmethod
        def now(cls):
            return fixed_now

        @classmethod
        def strptime(cls, value, fmt):
            return real_datetime.strptime(value, fmt)

    monkeypatch.setattr(meeting_manager_module, 'datetime', FrozenDateTime)

    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio1, transcript1 = _create_source_files(tmp_path, 'first')
    first = manager.add_meeting(str(audio1), str(transcript1), duration=1.0)

    audio2, transcript2 = _create_source_files(tmp_path, 'second')
    second = manager.add_meeting(str(audio2), str(transcript2), duration=2.0)

    assert first['id'] == '20260107_104555'
    assert second['id'] == '20260107_104555_1'


def test_list_meetings_deduplicates_by_id_and_rewrites_metadata(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    manager.metadata_file.write_text(
        json.dumps(
            [
                {'id': 'dup', 'date': '2024-01-01T00:00:00'},
                {'id': 'dup', 'date': '2024-01-02T00:00:00'},
                {'id': 'unique', 'date': '2024-01-03T00:00:00'},
            ],
            indent=2,
        ),
        encoding='utf-8',
    )

    meetings = manager.list_meetings()
    saved = json.loads(manager.metadata_file.read_text(encoding='utf-8'))

    assert [meeting['id'] for meeting in meetings] == ['unique', 'dup']
    assert [meeting['id'] for meeting in saved] == ['dup', 'unique']


def test_delete_meeting_removes_associated_files_and_metadata(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('transcript', encoding='utf-8')

    manager._save_meetings(
        [
            {
                'id': '20260107_104555',
                'title': 'Meeting',
                'date': '2026-01-07T10:45:55',
                'duration': '0:05',
                'durationSeconds': 5.0,
                'audioPath': str(audio_path),
                'transcriptPath': str(transcript_path),
                'transcript': 'transcript',
                'language': 'en',
                'model': 'small',
            }
        ]
    )

    deleted = manager.delete_meeting('20260107_104555')

    assert deleted is True
    assert not audio_path.exists()
    assert not transcript_path.exists()
    assert manager.list_meetings() == []


def test_scan_and_sync_recordings_imports_missing_filesystem_meeting(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20250101_120000.opus'
    transcript_path = recordings_dir / 'meeting_20250101_120000.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('**Duration:** 1:05\n\nTranscript text', encoding='utf-8')

    result = manager.scan_and_sync_recordings()
    meeting = manager.get_meeting('20250101_120000')

    assert result == {'scanned': 1, 'added': 1, 'skipped': 0}
    assert meeting is not None
    assert meeting['duration'] == '1:05'
    assert meeting['audioPath'].endswith('meeting_20250101_120000.opus')
