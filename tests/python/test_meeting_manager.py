import json
import os
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
    assert 'transcript' not in meeting


def test_add_meeting_keeps_originals_if_metadata_save_fails(tmp_path, monkeypatch):
    recordings_dir = tmp_path / 'recordings'
    source_audio, source_transcript = _create_source_files(tmp_path, 'rollback_test')
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    original_save = manager._save_meetings_unlocked

    def failing_save(meetings):
        raise OSError('metadata save failed')

    monkeypatch.setattr(manager, '_save_meetings_unlocked', failing_save)

    try:
        manager.add_meeting(
            audio_path=str(source_audio),
            transcript_path=str(source_transcript),
            duration=12.0,
        )
    except OSError:
        pass
    else:
        raise AssertionError('Expected metadata save failure to propagate')

    monkeypatch.setattr(manager, '_save_meetings_unlocked', original_save)

    assert source_audio.exists()
    assert source_transcript.exists()
    assert list(recordings_dir.glob('meeting_*')) == []
    assert manager.list_meetings() == []


def test_add_meeting_saves_metadata_before_removing_originals(tmp_path, monkeypatch):
    recordings_dir = tmp_path / 'recordings'
    source_audio, source_transcript = _create_source_files(tmp_path, 'transaction_order')
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    observed = {}
    original_save = manager._save_meetings_unlocked

    def tracking_save(meetings):
        observed['audio_exists_during_save'] = source_audio.exists()
        observed['transcript_exists_during_save'] = source_transcript.exists()
        original_save(meetings)

    monkeypatch.setattr(manager, '_save_meetings_unlocked', tracking_save)

    meeting = manager.add_meeting(
        audio_path=str(source_audio),
        transcript_path=str(source_transcript),
        duration=30.0,
    )

    assert observed == {
        'audio_exists_during_save': True,
        'transcript_exists_during_save': True,
    }
    assert not source_audio.exists()
    assert not source_transcript.exists()
    assert Path(meeting['audioPath']).exists()
    assert Path(meeting['transcriptPath']).exists()


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
    assert meeting['transcript'] == '**Duration:** 1:05\n\nTranscript text'


def test_scan_and_sync_recordings_preserves_suffixed_meeting_ids(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20250101_120000_1.opus'
    transcript_path = recordings_dir / 'meeting_20250101_120000_1.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('**Duration:** 0:05\n\nTranscript text', encoding='utf-8')

    result = manager.scan_and_sync_recordings()
    meeting = manager.get_meeting('20250101_120000_1')

    assert result == {'scanned': 1, 'added': 1, 'skipped': 0}
    assert meeting is not None
    assert meeting['id'] == '20250101_120000_1'
    assert meeting['title'] == 'Meeting 2025-01-01 12:00'


def test_list_meetings_omits_inline_transcript_bodies(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('stored transcript body', encoding='utf-8')

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
                'transcript': 'stored transcript body',
                'language': 'en',
                'model': 'small',
            }
        ]
    )

    meetings = manager.list_meetings()

    assert meetings[0]['id'] == '20260107_104555'
    assert 'transcript' not in meetings[0]


def test_get_meeting_hydrates_transcript_from_transcript_path(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('hydrated transcript body', encoding='utf-8')

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
                'language': 'en',
                'model': 'small',
            }
        ]
    )

    meeting = manager.get_meeting('20260107_104555')

    assert meeting is not None
    assert meeting['transcript'] == 'hydrated transcript body'


def test_save_meetings_writes_metadata_atomically(tmp_path, monkeypatch):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    original_replace = meeting_manager_module.os.replace
    captured = {}

    def tracking_replace(src, dst):
        captured['src'] = Path(src)
        captured['dst'] = Path(dst)
        assert captured['src'].exists()
        original_replace(src, dst)

    monkeypatch.setattr(meeting_manager_module.os, 'replace', tracking_replace)

    manager._save_meetings([
        {'id': 'atomic', 'date': '2026-01-01T00:00:00'}
    ])

    saved = json.loads(manager.metadata_file.read_text(encoding='utf-8'))
    assert saved == [{'id': 'atomic', 'date': '2026-01-01T00:00:00'}]
    assert captured['dst'] == manager.metadata_file
    assert not captured['src'].exists()


def test_save_meetings_removes_temp_file_on_replace_failure(tmp_path, monkeypatch):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    def failing_replace(src, dst):
        raise OSError('replace failed')

    monkeypatch.setattr(meeting_manager_module.os, 'replace', failing_replace)

    try:
        manager._save_meetings([
            {'id': 'broken', 'date': '2026-01-01T00:00:00'}
        ])
    except OSError:
        pass
    else:
        raise AssertionError('Expected OSError from failed atomic replace')

    temp_files = list(recordings_dir.glob('meetings.*.tmp'))
    assert temp_files == []


def test_metadata_guard_supports_repeated_saves(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    manager._save_meetings([
        {'id': 'locked', 'date': '2026-01-01T00:00:00'}
    ])
    manager._save_meetings([
        {'id': 'locked-again', 'date': '2026-01-02T00:00:00'}
    ])

    assert getattr(manager, '_metadata_file_lock') is not None
    saved = json.loads(manager.metadata_file.read_text(encoding='utf-8'))
    assert saved == [{'id': 'locked-again', 'date': '2026-01-02T00:00:00'}]


def test_list_meetings_backs_up_corrupt_metadata_file(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    manager.metadata_file.write_text('{not valid json', encoding='utf-8')

    meetings = manager.list_meetings()

    backups = list(recordings_dir.glob('meetings.corrupt.*.json'))
    assert meetings == []
    assert len(backups) == 1
    assert backups[0].read_text(encoding='utf-8') == '{not valid json'
    assert manager.metadata_file.read_text(encoding='utf-8') == '{not valid json'


def test_save_after_corrupt_metadata_preserves_backup_and_writes_new_file(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    manager.metadata_file.write_text('{not valid json', encoding='utf-8')

    source_audio, source_transcript = _create_source_files(tmp_path, 'recovery_save')
    meeting = manager.add_meeting(
        audio_path=str(source_audio),
        transcript_path=str(source_transcript),
        duration=10.0,
    )

    backups = list(recordings_dir.glob('meetings.corrupt.*.json'))
    saved = json.loads(manager.metadata_file.read_text(encoding='utf-8'))

    assert len(backups) == 1
    assert backups[0].read_text(encoding='utf-8') == '{not valid json'
    assert saved[0]['id'] == meeting['id']
