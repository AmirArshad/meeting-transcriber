import json
import hashlib
import os
from datetime import datetime as real_datetime
from pathlib import Path

import backend.meeting_manager as meeting_manager_module
from backend.meeting_manager import MeetingManager


def _create_source_files(recordings_dir: Path, stem: str):
    recordings_dir.mkdir(parents=True, exist_ok=True)
    audio_path = recordings_dir / f'{stem}.opus'
    transcript_path = recordings_dir / f'{stem}.md'
    audio_path.write_bytes(b'audio-bytes')
    transcript_path.write_text('# Transcript\n\nHello world', encoding='utf-8')
    return audio_path, transcript_path


def test_add_meeting_persists_files_and_removes_originals(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    source_audio, source_transcript = _create_source_files(recordings_dir, 'temp_recording')
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


def test_add_meeting_rejects_paths_outside_recordings_dir(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    recordings_dir.mkdir()
    outside_audio, outside_transcript = _create_source_files(tmp_path / 'outside', 'outside')
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    try:
        manager.add_meeting(
            audio_path=str(outside_audio),
            transcript_path=str(outside_transcript),
            duration=12.0,
        )
    except ValueError as error:
        assert 'recordings directory' in str(error).lower()
    else:
        raise AssertionError('Expected add_meeting to reject paths outside recordings_dir')


def test_add_meeting_fails_fast_when_audio_missing(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    _, source_transcript = _create_source_files(recordings_dir, 'missing_audio')
    missing_audio = recordings_dir / 'missing_audio.opus'
    missing_audio.unlink()
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    try:
        manager.add_meeting(
            audio_path=str(missing_audio),
            transcript_path=str(source_transcript),
            duration=12.0,
        )
    except ValueError as error:
        assert 'audio file not found' in str(error).lower()
    else:
        raise AssertionError('Expected add_meeting to fail when audio is missing')


def test_add_meeting_waits_briefly_for_transcript(tmp_path, monkeypatch):
    recordings_dir = tmp_path / 'recordings'
    source_audio, source_transcript = _create_source_files(recordings_dir, 'delayed_transcript')
    source_transcript.unlink()
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    def restore_transcript(*args, **kwargs):
        source_transcript.write_text('# Transcript\n\nDelayed', encoding='utf-8')

    monkeypatch.setattr(meeting_manager_module.time, 'sleep', restore_transcript)

    meeting = manager.add_meeting(
        audio_path=str(source_audio),
        transcript_path=str(source_transcript),
        duration=12.0,
    )

    assert meeting['id']
    assert Path(meeting['transcriptPath']).exists()


def test_add_meeting_keeps_originals_if_metadata_save_fails(tmp_path, monkeypatch):
    recordings_dir = tmp_path / 'recordings'
    source_audio, source_transcript = _create_source_files(recordings_dir, 'rollback_test')
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
    source_audio, source_transcript = _create_source_files(recordings_dir, 'transaction_order')
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

    audio1, transcript1 = _create_source_files(recordings_dir, 'first')
    first = manager.add_meeting(str(audio1), str(transcript1), duration=1.0)

    audio2, transcript2 = _create_source_files(recordings_dir, 'second')
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


def test_delete_meeting_keeps_metadata_if_file_delete_fails(tmp_path, monkeypatch):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('transcript', encoding='utf-8')

    meeting = {
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
    manager._save_meetings([meeting])

    original_replace = Path.replace

    def failing_replace(self, target):
        if self == audio_path:
            raise PermissionError('audio locked')
        return original_replace(self, target)

    monkeypatch.setattr(Path, 'replace', failing_replace)

    try:
        manager.delete_meeting('20260107_104555')
    except RuntimeError as error:
        assert 'audio' in str(error)
        pass
    else:
        raise AssertionError('Expected file delete failure to propagate')

    assert audio_path.exists()
    assert transcript_path.exists()
    saved = json.loads(manager.metadata_file.read_text(encoding='utf-8'))
    assert saved == [meeting]


def test_delete_meeting_restores_files_if_metadata_save_fails(tmp_path, monkeypatch):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('transcript', encoding='utf-8')

    meeting = {
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
    manager._save_meetings([meeting])

    def failing_save(_meetings):
        raise OSError('metadata save failed')

    monkeypatch.setattr(manager, '_save_meetings_unlocked', failing_save)

    try:
        manager.delete_meeting('20260107_104555')
    except OSError:
        pass
    else:
        raise AssertionError('Expected metadata save failure to propagate')

    assert audio_path.exists()
    assert transcript_path.exists()
    assert list(recordings_dir.glob('*.deleting.*')) == []
    saved = json.loads(manager.metadata_file.read_text(encoding='utf-8'))
    assert saved == [meeting]


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


def test_update_meeting_ai_persists_derived_artifact_references(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    speakers_path = recordings_dir / 'meeting_20260107_104555.speakers.json'
    summary_json_path = recordings_dir / 'meeting_20260107_104555.summary.json'
    summary_md_path = recordings_dir / 'meeting_20260107_104555.summary.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('hydrated transcript body', encoding='utf-8')
    speakers_path.write_text('{"segments": []}', encoding='utf-8')
    summary_json_path.write_text('{"summary": "ok"}', encoding='utf-8')
    summary_md_path.write_text('# Summary', encoding='utf-8')
    source_hash = f"sha256:{hashlib.sha256('different transcript'.encode('utf-8')).hexdigest()}"

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

    meeting = manager.update_meeting_ai(
        '20260107_104555',
        diarization={
            'status': 'completed',
            'model': 'pyannote/speaker-diarization-community-1',
            'completedAt': '2026-05-16T00:00:00Z',
            'speakerCount': '3',
            'segmentsPath': str(speakers_path),
            'error': None,
            'token': 'hf_secret',
        },
        summary={
            'status': 'completed',
            'modelProfile': 'balanced',
            'model': 'Qwen3.5-9B-Q4_K_M',
            'generatedAt': '2026-05-16T00:05:00Z',
            'sourceTranscriptHash': source_hash,
            'jsonPath': str(summary_json_path),
            'markdownPath': str(summary_md_path),
            'error': None,
            'prompt': 'do not store this',
        },
    )

    assert meeting is not None
    assert meeting['ai']['diarization'] == {
        'status': 'completed',
        'model': 'pyannote/speaker-diarization-community-1',
        'completedAt': '2026-05-16T00:00:00Z',
        'speakerCount': 3,
        'segmentsPath': str(speakers_path),
        'error': None,
    }
    assert meeting['ai']['summary'] == {
        'status': 'completed',
        'modelProfile': 'balanced',
        'model': 'Qwen3.5-9B-Q4_K_M',
        'generatedAt': '2026-05-16T00:05:00Z',
        'sourceTranscriptHash': source_hash,
        'jsonPath': str(summary_json_path),
        'markdownPath': str(summary_md_path),
        'error': None,
    }
    assert 'hf_secret' not in json.dumps(meeting)
    assert 'prompt' not in json.dumps(meeting)

    hydrated = manager.get_meeting('20260107_104555')
    assert hydrated['summary'] == '# Summary'
    assert hydrated['summaryStale'] is True


def test_update_meeting_ai_sanitizes_and_caps_text_metadata(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))
    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('Transcript', encoding='utf-8')

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

    meeting = manager.update_meeting_ai(
        '20260107_104555',
        summary={
            'status': 'completed\nwith whitespace',
            'modelProfile': 'balanced\n' + ('x' * 400),
            'model': 'Qwen\tModel',
            'sourceTranscriptHash': 'not-a-hash',
            'error': 'failure\n' + ('y' * 400),
        },
    )

    summary = meeting['ai']['summary']
    assert summary['status'] == 'completed with whitespace'
    assert len(summary['modelProfile']) == 300
    assert summary['model'] == 'Qwen Model'
    assert 'sourceTranscriptHash' not in summary
    assert len(summary['error']) == 300


def test_update_meeting_ai_redacts_hf_tokens_in_error_field(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('# transcript', encoding='utf-8')
    manager._save_meetings([
        {
            'id': '20260107_104555',
            'title': 'Test',
            'date': '2026-01-07',
            'time': '10:45:55',
            'duration': '0:05',
            'durationSeconds': 5.0,
            'audioPath': str(audio_path),
            'transcriptPath': str(transcript_path),
            'language': 'en',
            'model': 'small',
        }
    ])

    meeting = manager.update_meeting_ai(
        '20260107_104555',
        diarization={'error': 'Auth failed for hf_secret_token_value'},
    )

    assert meeting['ai']['diarization']['error'] == 'Auth failed for [redacted-token]'


def test_get_meeting_marks_summary_fresh_when_transcript_hash_matches(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    summary_md_path = recordings_dir / 'meeting_20260107_104555.summary.md'
    transcript_text = 'hydrated transcript body'
    source_hash = f"sha256:{hashlib.sha256(transcript_text.encode('utf-8')).hexdigest()}"
    audio_path.write_bytes(b'audio')
    transcript_path.write_text(transcript_text, encoding='utf-8')
    summary_md_path.write_text('# Summary', encoding='utf-8')

    manager._save_meetings([
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
            'ai': {
                'summary': {
                    'sourceTranscriptHash': source_hash,
                    'markdownPath': str(summary_md_path),
                },
            },
        }
    ])

    hydrated = manager.get_meeting('20260107_104555')

    assert hydrated['summary'] == '# Summary'
    assert hydrated['summaryStale'] is False


def test_get_meeting_uses_replacement_decoding_for_summary_staleness(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    summary_md_path = recordings_dir / 'meeting_20260107_104555.summary.md'
    transcript_bytes = b'Valid text \xe2 invalid tail'
    transcript_text = transcript_bytes.decode('utf-8', errors='replace')
    source_hash = f"sha256:{hashlib.sha256(transcript_text.encode('utf-8')).hexdigest()}"
    audio_path.write_bytes(b'audio')
    transcript_path.write_bytes(transcript_bytes)
    summary_md_path.write_text('# Summary', encoding='utf-8')

    manager._save_meetings([
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
            'ai': {
                'summary': {
                    'sourceTranscriptHash': source_hash,
                    'markdownPath': str(summary_md_path),
                },
            },
        }
    ])

    hydrated = manager.get_meeting('20260107_104555')

    assert hydrated['transcript'] == 'Valid text \ufffd invalid tail'
    assert hydrated['summary'] == '# Summary'
    assert hydrated['summaryStale'] is False


def test_delete_meeting_removes_derived_ai_artifacts(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    speakers_path = recordings_dir / 'meeting_20260107_104555.speakers.json'
    summary_json_path = recordings_dir / 'meeting_20260107_104555.summary.json'
    summary_md_path = recordings_dir / 'meeting_20260107_104555.summary.md'
    for path in (audio_path, transcript_path, speakers_path, summary_json_path, summary_md_path):
        path.write_text('data', encoding='utf-8')

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
                'ai': {
                    'diarization': {'segmentsPath': str(speakers_path)},
                    'summary': {
                        'jsonPath': str(summary_json_path),
                        'markdownPath': str(summary_md_path),
                    },
                },
            }
        ]
    )

    assert manager.delete_meeting('20260107_104555') is True

    for path in (audio_path, transcript_path, speakers_path, summary_json_path, summary_md_path):
        assert not path.exists()
    assert manager.list_meetings() == []


def test_update_meeting_ai_rejects_artifact_paths_outside_recordings(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    outside_path = tmp_path / 'outside.speakers.json'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('transcript', encoding='utf-8')
    outside_path.write_text('{}', encoding='utf-8')

    manager._save_meetings([
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
    ])

    try:
        manager.update_meeting_ai('20260107_104555', diarization={'segmentsPath': str(outside_path)})
    except ValueError as error:
        assert 'recordings directory' in str(error)
    else:
        raise AssertionError('Expected unsafe AI artifact path to be rejected')


def test_delete_meeting_ignores_unsafe_ai_artifact_paths_in_existing_metadata(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    outside_path = tmp_path / 'outside.summary.json'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('transcript', encoding='utf-8')
    outside_path.write_text('do not delete', encoding='utf-8')

    manager._save_meetings([
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
            'ai': {'summary': {'jsonPath': str(outside_path)}},
        }
    ])

    assert manager.delete_meeting('20260107_104555') is True
    assert outside_path.exists()
    assert outside_path.read_text(encoding='utf-8') == 'do not delete'


def test_delete_meeting_ignores_unsafe_core_paths_in_existing_metadata(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    recordings_dir.mkdir()
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    outside_audio = tmp_path / 'outside.opus'
    outside_transcript = tmp_path / 'outside.md'
    outside_audio.write_bytes(b'outside-audio')
    outside_transcript.write_text('outside transcript', encoding='utf-8')

    manager._save_meetings([
        {
            'id': '20260107_104555',
            'title': 'Meeting',
            'date': '2026-01-07T10:45:55',
            'duration': '0:05',
            'durationSeconds': 5.0,
            'audioPath': str(outside_audio),
            'transcriptPath': str(outside_transcript),
            'language': 'en',
            'model': 'small',
        }
    ])

    assert manager.delete_meeting('20260107_104555') is True
    assert outside_audio.exists()
    assert outside_transcript.read_text(encoding='utf-8') == 'outside transcript'
    assert manager.list_meetings() == []


def test_get_meeting_does_not_read_outside_transcript_or_summary(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    recordings_dir.mkdir()
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    outside_transcript = tmp_path / 'outside.md'
    outside_summary = tmp_path / 'outside.summary.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('safe transcript', encoding='utf-8')
    outside_transcript.write_text('secret transcript', encoding='utf-8')
    outside_summary.write_text('secret summary', encoding='utf-8')

    manager._save_meetings([
        {
            'id': '20260107_104555',
            'title': 'Meeting',
            'date': '2026-01-07T10:45:55',
            'duration': '0:05',
            'durationSeconds': 5.0,
            'audioPath': str(audio_path),
            'transcriptPath': str(outside_transcript),
            'language': 'en',
            'model': 'small',
            'ai': {'summary': {'markdownPath': str(outside_summary)}},
        }
    ])

    hydrated = manager.get_meeting('20260107_104555')

    assert hydrated['transcript'] == ''
    assert hydrated['summary'] == ''
    assert outside_transcript.read_text(encoding='utf-8') == 'secret transcript'
    assert outside_summary.read_text(encoding='utf-8') == 'secret summary'


def test_add_meeting_rejects_symlink_sources(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    recordings_dir.mkdir()
    outside_audio = tmp_path / 'outside.opus'
    outside_audio.write_bytes(b'outside-audio')
    symlink_audio = recordings_dir / 'linked.opus'
    transcript_path = recordings_dir / 'linked.md'
    transcript_path.write_text('# Transcript', encoding='utf-8')

    try:
        symlink_audio.symlink_to(outside_audio)
    except OSError:
        return

    manager = MeetingManager(recordings_dir=str(recordings_dir))

    try:
        manager.add_meeting(
            audio_path=str(symlink_audio),
            transcript_path=str(transcript_path),
            duration=12.0,
        )
    except ValueError as error:
        assert 'symlink' in str(error).lower()
    else:
        raise AssertionError('Expected add_meeting to reject symlink sources')


def test_update_meeting_ai_merges_partial_feature_updates(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    summary_json_path = recordings_dir / 'meeting_20260107_104555.summary.json'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('transcript', encoding='utf-8')
    summary_json_path.write_text('{}', encoding='utf-8')

    manager._save_meetings([
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
    ])

    manager.update_meeting_ai('20260107_104555', summary={'status': 'completed', 'jsonPath': str(summary_json_path)})
    meeting = manager.update_meeting_ai('20260107_104555', summary={'error': 'later warning'})

    assert meeting['ai']['summary']['jsonPath'] == str(summary_json_path.resolve(strict=False))
    assert meeting['ai']['summary']['error'] == 'later warning'


def test_get_meeting_falls_back_to_inline_transcript_when_file_is_missing(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    audio_path.write_bytes(b'audio')

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
                'transcript': 'legacy inline transcript',
                'language': 'en',
                'model': 'small',
            }
        ]
    )

    meeting = manager.get_meeting('20260107_104555')

    assert meeting is not None
    assert meeting['transcript'] == 'legacy inline transcript'


def test_scan_and_sync_recordings_prefers_single_audio_candidate_per_stem(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    opus_path = recordings_dir / 'meeting_20250101_120000.opus'
    wav_path = recordings_dir / 'meeting_20250101_120000.wav'
    transcript_path = recordings_dir / 'meeting_20250101_120000.md'
    opus_path.write_bytes(b'broken opus placeholder')
    wav_path.write_bytes(b'healthy wav fallback')
    transcript_path.write_text('**Duration:** 0:10\n\nTranscript text', encoding='utf-8')

    result = manager.scan_and_sync_recordings()
    meeting = manager.get_meeting('20250101_120000')

    assert result == {'scanned': 1, 'added': 1, 'skipped': 0}
    assert meeting is not None
    assert meeting['audioPath'].endswith('meeting_20250101_120000.wav')


def test_select_scannable_audio_files_prefers_wav_fallback_when_both_exist(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    recordings_dir.mkdir()

    (recordings_dir / 'meeting_a.opus').write_bytes(b'opus')
    (recordings_dir / 'meeting_a.wav').write_bytes(b'wav')
    (recordings_dir / 'meeting_b.wav').write_bytes(b'wav')

    selected = MeetingManager._select_scannable_audio_files(recordings_dir)  # type: ignore[attr-defined]

    assert [path.name for path in selected] == ['meeting_a.wav', 'meeting_b.wav']


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


def test_repeated_corrupt_metadata_reads_reuse_backup_for_same_file(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    manager.metadata_file.write_text('{not valid json', encoding='utf-8')

    assert manager.list_meetings() == []
    assert manager.list_meetings() == []

    backups = list(recordings_dir.glob('meetings.corrupt.*.json'))
    assert len(backups) == 1


def test_save_after_corrupt_metadata_preserves_backup_and_writes_new_file(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    manager.metadata_file.write_text('{not valid json', encoding='utf-8')

    source_audio, source_transcript = _create_source_files(recordings_dir, 'recovery_save')
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
