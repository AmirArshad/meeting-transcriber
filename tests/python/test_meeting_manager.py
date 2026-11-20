import json
import hashlib
import os
from contextlib import contextmanager
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


def test_initialization_preserves_a_meeting_committed_while_waiting_for_the_lock(tmp_path):
    recordings = tmp_path / 'recordings'
    audio, transcript = _create_source_files(recordings, 'first_recording')
    committed = []

    class DelayedMeetingManager(MeetingManager):
        @contextmanager
        def _metadata_guard(self):
            if not committed:
                writer = MeetingManager(str(recordings))
                committed.append(writer.add_meeting(str(audio), str(transcript), 1))
            with super()._metadata_guard():
                yield

    manager = DelayedMeetingManager(str(recordings))
    assert len(committed) == 1
    assert manager.list_meetings() == committed


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
        transcription_device='CUDA',
        transcription_compute_type='float16',
    )

    persisted_audio = Path(meeting['audioPath'])
    persisted_transcript = Path(meeting['transcriptPath'])

    assert meeting['title'] == 'Test Meeting'
    assert meeting['duration'] == '1:05'
    assert meeting['transcriptionDevice'] == 'cuda'
    assert meeting['transcriptionComputeType'] == 'float16'
    assert persisted_audio.exists()
    assert persisted_transcript.exists()
    assert persisted_audio.name.startswith('meeting_')
    assert persisted_transcript.read_text(encoding='utf-8').startswith('# Transcript')
    assert not source_audio.exists()
    assert not source_transcript.exists()
    assert 'transcript' not in meeting


def test_add_meeting_maps_mlx_metal_device_to_mps(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    source_audio, source_transcript = _create_source_files(recordings_dir, 'temp_mlx')
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    meeting = manager.add_meeting(
        audio_path=str(source_audio),
        transcript_path=str(source_transcript),
        duration=12.0,
        language='en',
        model='base',
        transcription_device='metal',
    )

    assert meeting['transcriptionDevice'] == 'mps'
    assert Path(meeting['audioPath']).exists()
    assert not source_audio.exists()
    assert not source_transcript.exists()


def test_normalize_transcription_device_does_not_alias_coreml():
    from backend.meetings.normalization import normalize_transcription_device

    assert normalize_transcription_device('metal') == 'mps'
    assert normalize_transcription_device('coreml') is None
    assert normalize_transcription_device('cuda') == 'cuda'


def test_update_meeting_ai_preserves_sidecar_coreml_diarization_device(tmp_path):
    from backend.meetings.normalization import normalize_transcription_device

    recordings_dir = tmp_path / 'recordings'
    source_audio, source_transcript = _create_source_files(recordings_dir, 'coreml_sidecar')
    manager = MeetingManager(recordings_dir=str(recordings_dir))
    meeting = manager.add_meeting(
        audio_path=str(source_audio),
        transcript_path=str(source_transcript),
        duration=12.0,
        language='en',
        model='small',
        transcription_device='cuda',
    )

    speakers_path = Path(meeting['audioPath']).with_suffix('.speakers.json')
    sidecar = {
        'status': 'completed',
        'model': 'speakrs-community1-vbx',
        'device': 'coreml',
        'annotationSource': 'exclusive_speaker_diarization',
        'speakerSegments': [{'start': 0.0, 'end': 1.0, 'speaker': 'SPEAKER_00'}],
        'segments': [{'start': 0.0, 'end': 1.0, 'text': 'hello', 'speaker': 'SPEAKER_00'}],
    }
    speakers_path.write_text(json.dumps(sidecar), encoding='utf-8')

    updated = manager.update_meeting_ai(
        meeting['id'],
        diarization={
            'status': 'completed',
            'model': 'speakrs-community1-vbx',
            'segmentsPath': str(speakers_path),
            'device': 'coreml',
        },
    )

    assert updated is not None
    assert updated['transcriptionDevice'] == 'cuda'
    assert 'device' not in updated['ai']['diarization']
    assert updated['ai']['diarization']['segmentsPath'] == str(speakers_path)
    saved = json.loads(speakers_path.read_text(encoding='utf-8'))
    assert saved['device'] == 'coreml'
    assert saved['annotationSource'] == 'exclusive_speaker_diarization'
    assert normalize_transcription_device(saved['device']) is None


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
    assert meeting['transcriptionStatus'] == 'completed'


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
    assert meeting['transcriptionStatus'] == 'completed'


def test_scan_and_sync_recordings_recovers_audio_only_recordings_with_pending_status(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'recording_2025-01-01T12-00-00.opus'
    audio_path.write_bytes(b'audio')

    result = manager.scan_and_sync_recordings()
    meeting = manager.get_meeting('20250101_120000')

    assert result == {'scanned': 1, 'added': 1, 'skipped': 0}
    assert meeting is not None
    assert meeting['transcriptionStatus'] == 'pending'
    assert meeting['transcriptionError'] is None
    assert 'Recording Awaiting Transcription' in meeting['transcript']


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
            'language': 'es',
            'languageSource': 'userConfirmed',
            'languagePolicyVersion': 'qwen-language-v1',
            'modelId': 'qwen3.5-9b-q4-k-m',
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
        'language': 'es',
        'languageSource': 'userConfirmed',
        'languagePolicyVersion': 'qwen-language-v1',
        'modelId': 'qwen3.5-9b-q4-k-m',
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


def test_update_meeting_ai_clears_stale_diarization_path_on_terminal_error(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    speakers_path = recordings_dir / 'meeting_20260107_104555.speakers.json'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('transcript', encoding='utf-8')
    speakers_path.write_text('{}', encoding='utf-8')
    manager._save_meetings([{
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
            'diarization': {
                'status': 'completed',
                'segmentsPath': str(speakers_path),
            },
        },
    }])

    meeting = manager.update_meeting_ai(
        '20260107_104555',
        diarization={'status': 'error', 'error': 'retry failed'},
    )

    assert meeting['ai']['diarization']['status'] == 'error'
    assert meeting['ai']['diarization']['segmentsPath'] is None


def test_update_meeting_ai_persists_speakrs_fallback_error_metadata(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))

    audio_path = recordings_dir / 'meeting_20260903_112605.wav'
    transcript_path = recordings_dir / 'meeting_20260903_112605.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('ordinary transcript', encoding='utf-8')
    manager._save_meetings([{
        'id': '20260903_112605',
        'title': 'Task 5 fixed2 fallback fixture',
        'date': '2026-09-03T11:26:05.684456',
        'duration': '0:14',
        'durationSeconds': 14.2245,
        'audioPath': str(audio_path),
        'transcriptPath': str(transcript_path),
        'language': 'en',
        'model': 'tiny',
        'transcriptionStatus': 'completed',
        'transcriptionDevice': 'cuda',
        'transcriptionComputeType': 'float16',
    }])

    meeting = manager.update_meeting_ai(
        '20260903_112605',
        diarization={
            'status': 'error',
            'model': 'speakrs-community1-vbx',
            'completedAt': '2026-09-03T10:26:16.879Z',
            'error': 'Speakrs model pack is not installed.',
        },
    )

    persisted = meeting['ai']['diarization']
    assert persisted['status'] == 'error'
    assert persisted['model'] == 'speakrs-community1-vbx'
    assert persisted['completedAt'] == '2026-09-03T10:26:16.879Z'
    assert persisted['error'] == 'Speakrs model pack is not installed.'
    assert persisted['segmentsPath'] is None
    assert not (recordings_dir / 'meeting_20260903_112605.speakers.json').exists()

    fetched = manager.get_meeting('20260903_112605')
    assert fetched['ai']['diarization']['status'] == 'error'
    assert fetched['ai']['diarization']['model'] == 'speakrs-community1-vbx'
    assert fetched['ai']['diarization']['error'] == 'Speakrs model pack is not installed.'
    assert fetched['transcript'] == 'ordinary transcript'


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


def test_update_transcription_updates_status_fields_and_duration(tmp_path):
    recordings_dir = tmp_path / 'recordings'
    manager = MeetingManager(recordings_dir=str(recordings_dir))
    audio_path = recordings_dir / 'meeting_20260107_104555.opus'
    transcript_path = recordings_dir / 'meeting_20260107_104555.md'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text('# Transcript', encoding='utf-8')
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
            'transcriptionStatus': 'failed',
            'transcriptionError': 'old error',
        }
    ])

    updated = manager.update_transcription(
        '20260107_104555',
        status='completed',
        clear_error=True,
        language='fa',
        model='medium',
        duration=125.0,
        device='CUDA',
        compute_type='float16',
    )

    assert updated is not None
    assert updated['transcriptionStatus'] == 'completed'
    assert updated['transcriptionError'] is None
    assert updated['language'] == 'fa'
    assert updated['model'] == 'medium'
    assert updated['durationSeconds'] == 125.0
    assert updated['duration'] == '2:05'
    assert updated['transcriptionDevice'] == 'cuda'
    assert updated['transcriptionComputeType'] == 'float16'


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


def test_interrupted_staged_import_is_not_scanned_and_committed_import_survives(tmp_path):
    import subprocess
    import sys

    recordings = tmp_path / 'recordings'
    staging = recordings / '.audio-import-test'
    audio, transcript = _create_source_files(staging, 'audio')
    manager = MeetingManager(str(recordings))
    script = '''
import os, sys
from meeting_manager import MeetingManager
original = os.replace
def crash_after_promotion(src, dst, *args, **kwargs):
    original(src, dst, *args, **kwargs)
    if str(dst).endswith('.opus'):
        os._exit(73)
os.replace = crash_after_promotion
MeetingManager(sys.argv[1]).add_meeting(sys.argv[2], sys.argv[3], 1)
'''
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[2] / 'backend'))
    result = subprocess.run([sys.executable, '-c', script, str(recordings), str(audio), str(transcript)], env=env)
    assert result.returncode == 73
    assert list(recordings.glob('meeting_*.opus'))
    assert manager.scan_and_sync_recordings()['added'] == 0
    assert not list(recordings.glob('meeting_*.opus'))
    assert not audio.exists()

    audio, transcript = _create_source_files(staging, 'audio')
    request = {'schemaVersion': 1, 'attemptId': '11111111-1111-4111-8111-111111111111',
               'engine': 'whisper', 'language': 'fr', 'modelSize': 'medium', 'artifactRevision': None}
    meeting = manager.add_meeting(str(audio), str(transcript), 1, title='Imported', transcription_request=request)
    # Simulate interruption after metadata commit and before marker removal.
    (recordings / f".meeting-import-{meeting['id']}").mkdir()
    restarted = MeetingManager(str(recordings))
    restarted.scan_and_sync_recordings()
    saved = restarted.list_meetings()
    assert len(saved) == 1
    assert saved[0]['transcriptionRequest'] == request
    assert saved[0]['transcriptionStatus'] == 'pending'
    assert Path(saved[0]['audioPath']).read_bytes() == b'audio-bytes'
    assert not list(recordings.glob('.meeting-import-*'))


def test_staged_import_flushes_read_only_copies(tmp_path):
    import stat

    recordings = tmp_path / 'recordings'
    audio, transcript = _create_source_files(recordings / '.audio-import-test', 'audio')
    audio.chmod(stat.S_IREAD)
    transcript.chmod(stat.S_IREAD)
    try:
        meeting = MeetingManager(str(recordings)).add_meeting(str(audio), str(transcript), 1)
        assert Path(meeting['audioPath']).is_file()
        assert Path(meeting['transcriptPath']).is_file()
    finally:
        for path in (audio, transcript):
            if path.exists():
                path.chmod(stat.S_IREAD | stat.S_IWRITE)


def test_import_recovery_preserves_files_when_metadata_is_corrupt(tmp_path):
    import pytest

    recordings = tmp_path / 'recordings'
    audio, transcript = _create_source_files(recordings / '.audio-import-test', 'audio')
    manager = MeetingManager(str(recordings))
    meeting = manager.add_meeting(str(audio), str(transcript), 1)
    marker = recordings / f".meeting-import-{meeting['id']}"
    marker.mkdir()
    manager.metadata_file.write_text('{corrupt', encoding='utf-8')

    with pytest.raises(RuntimeError, match='corrupt meeting metadata'):
        manager.scan_and_sync_recordings()

    assert Path(meeting['audioPath']).read_bytes() == b'audio-bytes'
    assert Path(meeting['transcriptPath']).is_file()
    assert marker.is_dir()
    assert list(recordings.glob('meetings.corrupt.*.json'))


def test_import_recovery_rejects_invalid_metadata_structure(tmp_path):
    import pytest

    recordings = tmp_path / 'recordings'
    manager = MeetingManager(str(recordings))
    audio = recordings / 'meeting_20261118_120000.opus'
    audio.write_bytes(b'preserve')
    marker = recordings / '.meeting-import-20261118_120000'
    marker.mkdir()
    for invalid in ({}, [None], [{'id': 'missing-path'}]):
        manager.metadata_file.write_text(json.dumps(invalid), encoding='utf-8')
        with pytest.raises(RuntimeError, match='invalid meeting metadata'):
            manager.scan_and_sync_recordings()
        assert audio.read_bytes() == b'preserve'
        assert marker.is_dir()


def test_import_recovery_checks_duplicate_records_before_deduplication(tmp_path):
    recordings = tmp_path / 'recordings'
    manager = MeetingManager(str(recordings))
    audio = recordings / 'meeting_20261118_120000.opus'
    audio.write_bytes(b'preserve')
    marker = recordings / '.meeting-import-20261118_120000'
    marker.mkdir()
    records = [
        {'id': 'duplicate', 'audioPath': str(recordings / 'other.opus')},
        {'id': 'duplicate', 'audioPath': str(audio)},
    ]
    manager.metadata_file.write_text(json.dumps(records), encoding='utf-8')
    with manager._metadata_guard():
        manager._reconcile_import_transactions_unlocked()
    assert audio.read_bytes() == b'preserve'
    assert not marker.exists()
    assert json.loads(manager.metadata_file.read_text(encoding='utf-8')) == records


def test_scan_waits_for_staged_import_metadata_lock(tmp_path, monkeypatch):
    import threading
    import time

    recordings = tmp_path / 'recordings'
    audio, transcript = _create_source_files(recordings / '.audio-import-test', 'audio')
    writer = MeetingManager(str(recordings))
    scanner = MeetingManager(str(recordings))
    copied = threading.Event()
    release = threading.Event()
    original = meeting_manager_module.os.replace

    def pause_after_promotion(src, dst, *args, **kwargs):
        result = original(src, dst, *args, **kwargs)
        if Path(dst).suffix == '.opus':
            copied.set()
            assert release.wait(5)
        return result

    monkeypatch.setattr(meeting_manager_module.os, 'replace', pause_after_promotion)
    writer_thread = threading.Thread(target=lambda: writer.add_meeting(str(audio), str(transcript), 1))
    writer_thread.start()
    assert copied.wait(5)
    scan_results = []
    scan_thread = threading.Thread(target=lambda: scan_results.append(scanner.scan_and_sync_recordings()))
    scan_thread.start()
    time.sleep(0.2)
    assert scan_thread.is_alive()
    release.set()
    writer_thread.join(5)
    scan_thread.join(5)
    assert not writer_thread.is_alive() and not scan_thread.is_alive()
    assert scan_results[0]['added'] == 0
    assert len(scanner.list_meetings()) == 1


def test_concurrent_metadata_ops_succeed_during_slow_recovery_scan(tmp_path, monkeypatch):
    import threading
    from filelock import FileLock

    recordings = tmp_path / 'recordings'
    seed_manager = MeetingManager(str(recordings))

    existing_audio, existing_md = _create_source_files(recordings, 'existing_seed')
    existing = seed_manager.add_meeting(str(existing_audio), str(existing_md), 10.0, title='Existing')

    deletable_audio, deletable_md = _create_source_files(recordings, 'deletable_seed')
    deletable = seed_manager.add_meeting(str(deletable_audio), str(deletable_md), 8.0, title='Deletable')

    # Orphan recorder temp that will be promoted during slow recovery.
    orphan_pcm = recordings / 'recording_2026-03-01T10-00-00.pcm.tmp'
    orphan_pcm.write_bytes(b'R' * 64)

    entered = threading.Event()
    release = threading.Event()
    original_recover = meeting_manager_module.meeting_scan.recover_or_cleanup_recorder_temps

    def slowed_recover(recordings_dir):
        entered.set()
        assert release.wait(5), 'timed out waiting for release signal'
        return original_recover(recordings_dir)

    monkeypatch.setattr(
        meeting_manager_module.meeting_scan,
        'recover_or_cleanup_recorder_temps',
        slowed_recover,
    )

    scanner = MeetingManager(str(recordings))
    scan_results = []
    scan_errors = []

    def run_scan():
        try:
            scan_results.append(scanner.scan_and_sync_recordings())
        except BaseException as exc:  # pragma: no cover - surfaced by assertion below
            scan_errors.append(exc)

    scan_thread = threading.Thread(target=run_scan)
    scan_thread.start()
    assert entered.wait(5)

    # Use a second MeetingManager with a short metadata lock timeout to prove
    # meetings.json.lock is NOT held during slow recovery.
    worker = MeetingManager(str(recordings))
    worker._metadata_file_lock = FileLock(str(worker.metadata_lock_file), timeout=0.5)

    listed = worker.list_meetings()
    assert {m['id'] for m in listed} == {existing['id'], deletable['id']}

    renamed = worker.update_meeting(existing['id'], title='Renamed During Slow Scan')
    assert renamed is not None and renamed['title'] == 'Renamed During Slow Scan'

    new_audio, new_md = _create_source_files(recordings, 'concurrent_add')
    added_meeting = worker.add_meeting(
        str(new_audio),
        str(new_md),
        12.0,
        title='Added During Slow Scan',
    )
    assert added_meeting['title'] == 'Added During Slow Scan'

    assert worker.delete_meeting(deletable['id']) is True

    release.set()
    scan_thread.join(5)
    assert not scan_thread.is_alive()
    assert not scan_errors
    assert scan_results == [{'scanned': 3, 'added': 1, 'skipped': 2}]

    final_meetings = worker.list_meetings()
    ids = [m['id'] for m in final_meetings]
    assert len(ids) == len(set(ids))
    assert existing['id'] in ids
    assert added_meeting['id'] in ids
    assert deletable['id'] not in ids
    assert '20260301_100000' in ids

    by_id = {m['id']: m for m in final_meetings}
    assert by_id[existing['id']]['title'] == 'Renamed During Slow Scan'
    assert by_id[added_meeting['id']]['title'] == 'Added During Slow Scan'
    assert Path(by_id[added_meeting['id']]['transcriptPath']).read_text(encoding='utf-8').startswith('# Transcript')
    assert by_id['20260301_100000']['transcriptionStatus'] == 'pending'


def test_multiprocess_metadata_ops_succeed_during_slow_recovery_scan(tmp_path):
    import subprocess
    import sys
    import time
    from filelock import FileLock

    recordings = tmp_path / 'recordings'
    manager = MeetingManager(str(recordings))
    manager._metadata_file_lock = FileLock(str(manager.metadata_lock_file), timeout=0.75)

    existing_audio, existing_md = _create_source_files(recordings, 'mp_existing')
    existing = manager.add_meeting(str(existing_audio), str(existing_md), 10.0, title='MP Existing')

    deletable_audio, deletable_md = _create_source_files(recordings, 'mp_deletable')
    deletable = manager.add_meeting(str(deletable_audio), str(deletable_md), 5.0, title='MP Deletable')

    orphan_pcm = recordings / 'recording_2026-04-01T11-30-00.pcm.tmp'
    orphan_pcm.write_bytes(b'R' * 64)

    ready_flag = tmp_path / 'scan_paused.flag'
    go_flag = tmp_path / 'scan_resume.flag'

    script = '''
import json, sys, time
from pathlib import Path
import meeting_manager

recordings_dir, ready_path, go_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
orig_recover = meeting_manager.meeting_scan.recover_or_cleanup_recorder_temps

def paused_recover(rec_dir):
    ready_path.write_text('paused', encoding='utf-8')
    deadline = time.monotonic() + 15.0
    while not go_path.exists():
        if time.monotonic() > deadline:
            raise TimeoutError('timed out waiting for go flag')
        time.sleep(0.02)
    return orig_recover(rec_dir)

meeting_manager.meeting_scan.recover_or_cleanup_recorder_temps = paused_recover
mgr = meeting_manager.MeetingManager(recordings_dir)
result = mgr.scan_and_sync_recordings()
print(json.dumps(result))
'''
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[2] / 'backend'))
    proc = subprocess.Popen(
        [sys.executable, '-c', script, str(recordings), str(ready_flag), str(go_flag)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        deadline = time.monotonic() + 10.0
        while not ready_flag.exists():
            assert proc.poll() is None, f'child exited early: {proc.stderr.read()}'
            assert time.monotonic() < deadline, 'timed out waiting for child scan pause'
            time.sleep(0.02)

        # All four metadata operations must complete without hitting 0.75s FileLock timeout.
        assert {m['id'] for m in manager.list_meetings()} == {existing['id'], deletable['id']}
        renamed = manager.update_meeting(existing['id'], title='MP Renamed During Scan')
        assert renamed is not None and renamed['title'] == 'MP Renamed During Scan'

        new_audio, new_md = _create_source_files(recordings, 'mp_added')
        added = manager.add_meeting(str(new_audio), str(new_md), 15.0, title='MP Added During Scan')
        assert manager.delete_meeting(deletable['id']) is True
    finally:
        go_flag.write_text('go', encoding='utf-8')

    stdout, stderr = proc.communicate(timeout=15)
    assert proc.returncode == 0, f'child failed: {stderr}'
    scan_result = json.loads(stdout.strip().splitlines()[-1])
    assert scan_result['added'] == 1

    final_meetings = manager.list_meetings()
    by_id = {m['id']: m for m in final_meetings}
    assert len(final_meetings) == 3
    assert set(by_id.keys()) == {existing['id'], added['id'], '20260401_113000'}
    assert by_id[existing['id']]['title'] == 'MP Renamed During Scan'
    assert by_id[added['id']]['title'] == 'MP Added During Scan'
    assert by_id['20260401_113000']['transcriptionStatus'] == 'pending'


def test_scan_handles_staged_import_committed_or_crashed_during_phase_b(tmp_path, monkeypatch):
    import threading

    recordings = tmp_path / 'recordings'
    scanner = MeetingManager(str(recordings))
    writer = MeetingManager(str(recordings))

    # Pre-existing unrecorded audio so Phase B discovers something.
    orphan_audio = recordings / 'meeting_20260501_080000.opus'
    orphan_audio.write_bytes(b'orphan')

    entered = threading.Event()
    release = threading.Event()
    original_select = scanner._select_scannable_audio_files

    def simulate_concurrent_phase_b_activity(recordings_dir):
        # Case A: a staged import commits cleanly during Phase B.
        staged_ok = recordings / '.audio-import-ok'
        ok_audio, ok_md = _create_source_files(staged_ok, 'audio')
        ok_md.write_text('**Duration:** 0:09\n\nReal staged transcript', encoding='utf-8')
        # Add directly via staged import while scan is outside _metadata_guard.
        committed = writer.add_meeting(str(ok_audio), str(ok_md), 9.0, title='Committed Mid-Scan')
        assert committed['id']

        # Case B: a crashed staged import leaves marker + partial opus before select runs.
        crashed_id = '20260501_080005'
        (recordings / f'.meeting-import-{crashed_id}').mkdir()
        (recordings / f'meeting_{crashed_id}.opus').write_bytes(b'partial-import')

        entered.set()
        assert release.wait(5)
        return original_select(recordings_dir)

    monkeypatch.setattr(scanner, '_select_scannable_audio_files', simulate_concurrent_phase_b_activity)

    results = []
    scan_thread = threading.Thread(target=lambda: results.append(scanner.scan_and_sync_recordings()))
    scan_thread.start()
    assert entered.wait(5)
    release.set()
    scan_thread.join(5)
    assert not scan_thread.is_alive()

    meetings = scanner.list_meetings()
    by_id = {m['id']: m for m in meetings}
    assert len(meetings) == 2
    assert '20260501_080000' in by_id
    # Committed import kept its real transcript and wasn't duplicated or overwritten.
    committed_id = next(mid for mid in by_id if mid != '20260501_080000')
    assert by_id[committed_id]['title'] == 'Committed Mid-Scan'
    assert 'Real staged transcript' in Path(by_id[committed_id]['transcriptPath']).read_text(encoding='utf-8')
    # Crashed import partial audio, marker, and placeholder must NOT exist.
    assert not (recordings / 'meeting_20260501_080005.opus').exists()
    assert not (recordings / 'meeting_20260501_080005.md').exists()
    assert not (recordings / '.meeting-import-20260501_080005').exists()


def test_concurrent_scans_serialize_on_scan_recovery_lock_without_blocking_metadata(tmp_path, monkeypatch):
    import threading
    import time
    from filelock import FileLock

    recordings = tmp_path / 'recordings'
    seed = MeetingManager(str(recordings))
    a1, m1 = _create_source_files(recordings, 'seed_scan')
    existing = seed.add_meeting(str(a1), str(m1), 4.0, title='Seed')

    (recordings / 'meeting_20260601_100000.opus').write_bytes(b'new-audio')

    entered = threading.Event()
    release = threading.Event()
    call_count = 0
    original_recover = meeting_manager_module.meeting_scan.recover_or_cleanup_recorder_temps

    def guarded_recover(recordings_dir):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            entered.set()
            assert release.wait(5)
        return original_recover(recordings_dir)

    monkeypatch.setattr(
        meeting_manager_module.meeting_scan,
        'recover_or_cleanup_recorder_temps',
        guarded_recover,
    )

    scanner1 = MeetingManager(str(recordings))
    scanner2 = MeetingManager(str(recordings))
    res1 = []
    res2 = []

    t1 = threading.Thread(target=lambda: res1.append(scanner1.scan_and_sync_recordings()))
    t1.start()
    assert entered.wait(5)

    t2 = threading.Thread(target=lambda: res2.append(scanner2.scan_and_sync_recordings()))
    t2.start()
    time.sleep(0.15)
    # Scan 2 must be blocked on scan_recovery.lock, not running Phase B concurrently.
    assert t2.is_alive()
    assert call_count == 1

    # Third reader/writer still accesses metadata immediately with short lock timeout.
    reader = MeetingManager(str(recordings))
    reader._metadata_file_lock = FileLock(str(reader.metadata_lock_file), timeout=0.5)
    assert len(reader.list_meetings()) == 1
    assert reader.update_meeting(existing['id'], title='Updated While Two Scans Wait')['title'] == 'Updated While Two Scans Wait'

    release.set()
    t1.join(5)
    t2.join(5)
    assert not t1.is_alive() and not t2.is_alive()
    assert call_count == 2
    assert res1[0]['added'] == 1
    assert res2[0]['added'] == 0
    final = {m['id']: m for m in reader.list_meetings()}
    assert set(final.keys()) == {existing['id'], '20260601_100000'}
    assert final[existing['id']]['title'] == 'Updated While Two Scans Wait'


def test_scan_commits_multiple_discovered_meetings_in_single_atomic_save_and_rolls_back_placeholders(tmp_path, monkeypatch):
    recordings = tmp_path / 'recordings'
    manager = MeetingManager(str(recordings))

    stems = [
        'meeting_20260701_090000',
        'meeting_20260701_090500',
        'meeting_20260701_091000',
    ]
    for stem in stems:
        (recordings / f'{stem}.opus').write_bytes(b'audio')

    save_calls = 0
    original_save = manager._save_meetings_unlocked

    def counting_save(meetings):
        nonlocal save_calls
        save_calls += 1
        return original_save(meetings)

    monkeypatch.setattr(manager, '_save_meetings_unlocked', counting_save)
    result = manager.scan_and_sync_recordings()

    assert result == {'scanned': 3, 'added': 3, 'skipped': 0}
    assert save_calls == 1
    for stem in stems:
        assert (recordings / f'{stem}.md').is_file()

    # Now add a pre-existing .md meeting and two audio-only meetings, and force save failure.
    pre_stem = 'meeting_20260701_092000'
    (recordings / f'{pre_stem}.opus').write_bytes(b'audio')
    (recordings / f'{pre_stem}.md').write_text('**Duration:** 0:04\n\nKeep me', encoding='utf-8')

    fail_stems = ['meeting_20260701_092500', 'meeting_20260701_093000']
    for stem in fail_stems:
        (recordings / f'{stem}.opus').write_bytes(b'audio')

    def failing_save(_meetings):
        raise OSError('disk full')

    monkeypatch.setattr(manager, '_save_meetings_unlocked', failing_save)
    try:
        manager.scan_and_sync_recordings()
    except OSError as exc:
        assert 'disk full' in str(exc)
    else:
        raise AssertionError('Expected OSError from failing atomic save')

    # Newly created placeholders must be rolled back; pre-existing transcript preserved.
    for stem in fail_stems:
        assert not (recordings / f'{stem}.md').exists()
    assert (recordings / f'{pre_stem}.md').read_text(encoding='utf-8') == '**Duration:** 0:04\n\nKeep me'
    monkeypatch.setattr(manager, '_save_meetings_unlocked', original_save)
    assert len(manager.list_meetings()) == 3


def _write_captions_sidecar(path: Path, transcript_text: str, *, engine: str = 'faster-whisper', precision: str = 'word'):
    from backend.transcription.captions import (
        build_captions_payload,
        hash_transcript_text,
        write_captions_sidecar_atomic,
    )

    payload = build_captions_payload(
        source_transcript_hash=hash_transcript_text(transcript_text),
        engine=engine,
        cues=[
            {'startMs': 0, 'endMs': 1200, 'text': 'First caption cue.'},
            {'startMs': 1300, 'endMs': 2600, 'text': 'Second caption cue.'},
        ],
        timing_precision=precision,
    )
    write_captions_sidecar_atomic(path, payload)
    return payload


def test_commit_transcription_attempt_promotes_captions_hydrates_ready_and_detects_stale_edit(tmp_path):
    from backend.transcription.captions import hash_transcript_text

    recordings = tmp_path / 'recordings'
    audio, transcript = _create_source_files(recordings, 'initial_cap')
    manager = MeetingManager(str(recordings))

    attempt_1 = '11111111-1111-4111-8111-111111111111'
    request_1 = {
        'schemaVersion': 1,
        'attemptId': attempt_1,
        'engine': 'whisper',
        'language': 'en',
        'modelSize': 'small',
        'artifactRevision': None,
    }
    meeting = manager.add_meeting(str(audio), str(transcript), 12.0, transcription_request=request_1)
    audio_path = Path(meeting['audioPath'])
    candidate_md = recordings / f'{audio_path.stem}.transcript-{attempt_1}.md'
    candidate_captions = recordings / f'{audio_path.stem}.captions-{attempt_1}.json'
    candidate_text = '# Meeting Transcription\n\nFirst caption cue. Second caption cue.\n'
    candidate_md.write_text(candidate_text, encoding='utf-8')
    _write_captions_sidecar(candidate_captions, candidate_text, engine='faster-whisper', precision='word')

    committed = manager.commit_transcription_attempt(
        meeting['id'],
        attempt_id=attempt_1,
        candidate_path=str(candidate_md),
        captions_candidate_path=str(candidate_captions),
        result={
            'schemaVersion': 1,
            'attemptId': attempt_1,
            'engine': 'whisper',
            'language': 'en',
            'device': 'cpu',
            'computeType': 'int8',
            'modelSize': 'small',
            'artifactRevision': None,
            'transcriptHash': hash_transcript_text(candidate_text),
        },
        cancel_generation=0,
        delete_generation=0,
    )

    canonical_captions = audio_path.with_suffix('.captions.json')
    assert committed is not None
    assert committed['captionsPath'] == str(canonical_captions.resolve(strict=False))
    assert committed['captionsSourceTranscriptHash'] == hash_transcript_text(candidate_text)
    assert canonical_captions.is_file()
    assert not candidate_captions.exists()

    hydrated = manager.get_meeting(meeting['id'])
    assert hydrated is not None
    assert hydrated['captionsAvailable'] is True
    assert hydrated['captionsStatus'] == 'ready'
    assert hydrated['captionsCueCount'] == 2
    assert hydrated['captionsTimingPrecision'] == 'word'

    # External edit to the .md file invalidates captions freshness.
    Path(committed['transcriptPath']).write_text('# Meeting Transcription\n\nEdited externally.\n', encoding='utf-8')
    stale = manager.get_meeting(meeting['id'])
    assert stale is not None
    assert stale['captionsAvailable'] is False
    assert stale['captionsStatus'] == 'stale'


def test_commit_transcription_attempt_rejects_corrupt_sidecar_invalidates_stale_and_rolls_back(tmp_path, monkeypatch):
    import pytest
    from meetings.normalization import TranscriptionMetadataError
    from backend.transcription.captions import hash_transcript_text

    recordings = tmp_path / 'recordings'
    audio, transcript = _create_source_files(recordings, 'retranscribe_cap')
    manager = MeetingManager(str(recordings))

    attempt_1 = '11111111-1111-4111-8111-111111111111'
    request_1 = {
        'schemaVersion': 1,
        'attemptId': attempt_1,
        'engine': 'whisper',
        'language': 'en',
        'modelSize': 'small',
        'artifactRevision': None,
    }
    meeting = manager.add_meeting(str(audio), str(transcript), 10.0, transcription_request=request_1)
    audio_path = Path(meeting['audioPath'])
    canonical_captions = audio_path.with_suffix('.captions.json')

    md_1 = recordings / f'{audio_path.stem}.transcript-{attempt_1}.md'
    cap_1 = recordings / f'{audio_path.stem}.captions-{attempt_1}.json'
    text_1 = '# Transcript v1\n\nInitial version.\n'
    md_1.write_text(text_1, encoding='utf-8')
    payload_1 = _write_captions_sidecar(cap_1, text_1)

    manager.commit_transcription_attempt(
        meeting['id'],
        attempt_id=attempt_1,
        candidate_path=str(md_1),
        captions_candidate_path=str(cap_1),
        result={
            'schemaVersion': 1,
            'attemptId': attempt_1,
            'engine': 'whisper',
            'language': 'en',
            'device': 'cpu',
            'computeType': 'int8',
            'modelSize': 'small',
            'artifactRevision': None,
            'transcriptHash': hash_transcript_text(text_1),
        },
        cancel_generation=0,
        delete_generation=0,
    )
    assert canonical_captions.is_file()

    # Stage attempt 2: corrupt captions candidate must be rejected BEFORE touching prior captions.
    attempt_2 = '22222222-2222-4222-8222-222222222222'
    request_2 = {**request_1, 'attemptId': attempt_2}
    manager.stage_transcription_request(meeting['id'], request_2, cancel_generation=0, delete_generation=0)
    md_2 = recordings / f'{audio_path.stem}.transcript-{attempt_2}.md'
    cap_2 = recordings / f'{audio_path.stem}.captions-{attempt_2}.json'
    text_2 = '# Transcript v2\n\nUpdated transcript.\n'
    md_2.write_text(text_2, encoding='utf-8')
    cap_2.write_text('{corrupt-json', encoding='utf-8')

    with pytest.raises(TranscriptionMetadataError) as exc_info:
        manager.commit_transcription_attempt(
            meeting['id'],
            attempt_id=attempt_2,
            candidate_path=str(md_2),
            captions_candidate_path=str(cap_2),
            result={
                'schemaVersion': 1,
                'attemptId': attempt_2,
                'engine': 'whisper',
                'language': 'en',
                'device': 'cpu',
                'computeType': 'int8',
                'modelSize': 'small',
                'artifactRevision': None,
                'transcriptHash': hash_transcript_text(text_2),
            },
            cancel_generation=0,
            delete_generation=0,
        )
    assert exc_info.value.code == 'INVALID_TRANSCRIPTION_RESULT'
    assert json.loads(canonical_captions.read_text(encoding='utf-8')) == payload_1

    # Valid captions candidate for attempt 2, but _save_meetings_unlocked fails -> both candidate and prior captions roll back.
    payload_2 = _write_captions_sidecar(cap_2, text_2, engine='mlx-whisper', precision='segment')
    # A pre-existing predictable backup symlink must never be followed.
    unrelated = recordings / 'unrelated.json'
    unrelated.write_text('untouched', encoding='utf-8')
    predictable_backup = recordings / f'.{canonical_captions.name}.bak.{os.getpid()}'
    try:
        predictable_backup.symlink_to(unrelated)
    except (OSError, NotImplementedError):
        predictable_backup = None

    def fail_partial_copy(source, destination):
        destination.write(source.read(8))
        raise OSError('backup copy failed')

    with monkeypatch.context() as patch:
        patch.setattr(meeting_manager_module.shutil, 'copyfileobj', fail_partial_copy)
        with pytest.raises(OSError, match='backup copy failed'):
            manager.commit_transcription_attempt(
                meeting['id'], attempt_id=attempt_2, candidate_path=str(md_2),
                captions_candidate_path=str(cap_2),
                result={'schemaVersion': 1, 'attemptId': attempt_2, 'engine': 'whisper',
                        'language': 'en', 'device': 'cpu', 'computeType': 'int8',
                        'modelSize': 'small', 'artifactRevision': None,
                        'transcriptHash': hash_transcript_text(text_2)},
                cancel_generation=0, delete_generation=0,
            )
    assert unrelated.read_text(encoding='utf-8') == 'untouched'
    assert json.loads(canonical_captions.read_text(encoding='utf-8')) == payload_1
    assert json.loads(cap_2.read_text(encoding='utf-8')) == payload_2
    assert set(recordings.glob('*.bak.*')) == ({predictable_backup} if predictable_backup else set())
    original_replace = meeting_manager_module.os.replace

    def fail_caption_promotion(source, destination):
        if Path(source) == cap_2 and Path(destination) == canonical_captions:
            raise OSError('promotion failed')
        return original_replace(source, destination)

    with monkeypatch.context() as patch:
        patch.setattr(meeting_manager_module.os, 'replace', fail_caption_promotion)
        with pytest.raises(OSError, match='promotion failed'):
            manager.commit_transcription_attempt(
                meeting['id'], attempt_id=attempt_2, candidate_path=str(md_2),
                captions_candidate_path=str(cap_2),
                result={'schemaVersion': 1, 'attemptId': attempt_2, 'engine': 'whisper',
                        'language': 'en', 'device': 'cpu', 'computeType': 'int8',
                        'modelSize': 'small', 'artifactRevision': None,
                        'transcriptHash': hash_transcript_text(text_2)},
                cancel_generation=0, delete_generation=0,
            )
    assert json.loads(canonical_captions.read_text(encoding='utf-8')) == payload_1
    assert json.loads(cap_2.read_text(encoding='utf-8')) == payload_2
    assert unrelated.read_text(encoding='utf-8') == 'untouched'
    if predictable_backup:
        assert predictable_backup.is_symlink()
        predictable_backup.unlink()

    original_save = manager._save_meetings_unlocked

    def failing_save(_meetings):
        raise OSError('disk full during commit')

    monkeypatch.setattr(manager, '_save_meetings_unlocked', failing_save)
    with pytest.raises(OSError, match='disk full during commit'):
        manager.commit_transcription_attempt(
            meeting['id'],
            attempt_id=attempt_2,
            candidate_path=str(md_2),
            captions_candidate_path=str(cap_2),
            result={
                'schemaVersion': 1,
                'attemptId': attempt_2,
                'engine': 'whisper',
                'language': 'en',
                'device': 'cpu',
                'computeType': 'int8',
                'modelSize': 'small',
                'artifactRevision': None,
                'transcriptHash': hash_transcript_text(text_2),
            },
            cancel_generation=0,
            delete_generation=0,
        )

    monkeypatch.setattr(manager, '_save_meetings_unlocked', original_save)
    assert json.loads(canonical_captions.read_text(encoding='utf-8')) == payload_1
    assert json.loads(cap_2.read_text(encoding='utf-8')) == payload_2
    assert list(recordings.glob('*.bak.*')) == []

    # Obsolete cleanup must complete before another commit can acquire the lock.
    original_cleanup = manager._remove_obsolete_captions
    def assert_cleanup_locked(*args):
        assert manager._metadata_thread_lock._is_owned()
        return original_cleanup(*args)
    monkeypatch.setattr(manager, '_remove_obsolete_captions', assert_cleanup_locked)

    # Commit attempt 2 WITHOUT captions_candidate_path -> stale prior .captions.json is removed.
    committed_2 = manager.commit_transcription_attempt(
        meeting['id'],
        attempt_id=attempt_2,
        candidate_path=str(md_2),
        captions_candidate_path=None,
        result={
            'schemaVersion': 1,
            'attemptId': attempt_2,
            'engine': 'whisper',
            'language': 'en',
            'device': 'cpu',
            'computeType': 'int8',
            'modelSize': 'small',
            'artifactRevision': None,
            'transcriptHash': hash_transcript_text(text_2),
        },
        cancel_generation=0,
        delete_generation=0,
    )
    assert committed_2 is not None
    assert 'captionsPath' not in committed_2
    assert 'captionsSourceTranscriptHash' not in committed_2
    assert not canonical_captions.exists()
    hydrated_2 = manager.get_meeting(meeting['id'])
    assert hydrated_2 is not None
    assert hydrated_2['captionsAvailable'] is False
    assert hydrated_2['captionsStatus'] == 'missing'


def test_scan_and_sync_recordings_adopts_valid_sibling_captions_and_ignores_stale(tmp_path):
    from backend.transcription.captions import hash_transcript_text

    recordings = tmp_path / 'recordings'
    manager = MeetingManager(str(recordings))

    # 1. Hash-matched sibling captions sidecar is adopted.
    valid_audio = recordings / 'meeting_20260801_100000.opus'
    valid_md = recordings / 'meeting_20260801_100000.md'
    valid_cap = recordings / 'meeting_20260801_100000.captions.json'
    valid_text = '**Duration:** 0:08\n\nMatched transcript.\n'
    valid_audio.write_bytes(b'audio')
    valid_md.write_text(valid_text, encoding='utf-8')
    _write_captions_sidecar(valid_cap, valid_text, engine='parakeet', precision='word')

    # 2. Stale sibling captions sidecar is NOT adopted and remains untouched on disk.
    stale_audio = recordings / 'meeting_20260801_100500.opus'
    stale_md = recordings / 'meeting_20260801_100500.md'
    stale_cap = recordings / 'meeting_20260801_100500.captions.json'
    stale_audio.write_bytes(b'audio')
    stale_md.write_text('**Duration:** 0:08\n\nCurrent transcript.\n', encoding='utf-8')
    stale_payload = _write_captions_sidecar(stale_cap, 'Different older transcript')

    scan_result = manager.scan_and_sync_recordings()
    assert scan_result == {'scanned': 2, 'added': 2, 'skipped': 0}

    saved = {m['id']: m for m in manager.list_meetings()}
    assert saved['20260801_100000']['captionsPath'] == str(valid_cap.resolve(strict=False))
    assert saved['20260801_100000']['captionsSourceTranscriptHash'] == hash_transcript_text(valid_text)
    assert 'captionsPath' not in saved['20260801_100500']

    valid_meeting = manager.get_meeting('20260801_100000')
    assert valid_meeting is not None
    assert valid_meeting['captionsAvailable'] is True
    assert valid_meeting['captionsStatus'] == 'ready'
    assert valid_meeting['captionsTimingPrecision'] == 'word'

    stale_meeting = manager.get_meeting('20260801_100500')
    assert stale_meeting is not None
    assert stale_meeting['captionsAvailable'] is False
    assert stale_meeting['captionsStatus'] == 'stale'
    assert json.loads(stale_cap.read_text(encoding='utf-8')) == stale_payload


def test_delete_meeting_removes_captions_sidecar_and_rolls_back_on_save_failure(tmp_path, monkeypatch):
    import pytest

    recordings = tmp_path / 'recordings'
    manager = MeetingManager(str(recordings))

    audio_path = recordings / 'meeting_20260802_120000.opus'
    transcript_path = recordings / 'meeting_20260802_120000.md'
    captions_path = recordings / 'meeting_20260802_120000.captions.json'
    transcript_text = 'Transcript for deletion'
    audio_path.write_bytes(b'audio')
    transcript_path.write_text(transcript_text, encoding='utf-8')
    payload = _write_captions_sidecar(captions_path, transcript_text)

    manager._save_meetings([
        {
            'id': '20260802_120000',
            'title': 'Delete Captions',
            'date': '2026-08-02T12:00:00',
            'duration': '0:05',
            'durationSeconds': 5.0,
            'audioPath': str(audio_path),
            'transcriptPath': str(transcript_path),
            'captionsPath': str(captions_path),
            'language': 'en',
            'model': 'small',
        }
    ])

    original_save = manager._save_meetings_unlocked

    def failing_save(_meetings):
        raise OSError('metadata write failed')

    monkeypatch.setattr(manager, '_save_meetings_unlocked', failing_save)
    with pytest.raises(OSError, match='metadata write failed'):
        manager.delete_meeting('20260802_120000')

    assert audio_path.exists()
    assert transcript_path.exists()
    assert captions_path.exists()
    assert json.loads(captions_path.read_text(encoding='utf-8')) == payload

    monkeypatch.setattr(manager, '_save_meetings_unlocked', original_save)
    assert manager.delete_meeting('20260802_120000') is True
    assert not audio_path.exists()
    assert not transcript_path.exists()
    assert not captions_path.exists()
    assert manager.list_meetings() == []


def test_commit_transcription_attempt_matches_crlf_transcript_to_lf_normalized_captions(tmp_path):
    from backend.transcription.captions import hash_transcript_text

    recordings = tmp_path / 'recordings'
    audio, transcript = _create_source_files(recordings, 'crlf_cap')
    manager = MeetingManager(str(recordings))

    attempt_1 = '33333333-3333-4333-8333-333333333333'
    request_1 = {
        'schemaVersion': 1,
        'attemptId': attempt_1,
        'engine': 'whisper',
        'language': 'en',
        'modelSize': 'small',
        'artifactRevision': None,
    }
    meeting = manager.add_meeting(str(audio), str(transcript), 5.0, transcription_request=request_1)
    audio_path = Path(meeting['audioPath'])
    candidate_md = recordings / f'{audio_path.stem}.transcript-{attempt_1}.md'
    candidate_captions = recordings / f'{audio_path.stem}.captions-{attempt_1}.json'
    crlf_text = '# Meeting Transcription\r\n\r\nLine one.\r\n'
    candidate_md.write_bytes(crlf_text.encode('utf-8'))
    _write_captions_sidecar(candidate_captions, crlf_text, engine='faster-whisper', precision='word')

    committed = manager.commit_transcription_attempt(
        meeting['id'],
        attempt_id=attempt_1,
        candidate_path=str(candidate_md),
        captions_candidate_path=str(candidate_captions),
        result={
            'schemaVersion': 1,
            'attemptId': attempt_1,
            'engine': 'whisper',
            'language': 'en',
            'device': 'cpu',
            'computeType': 'int8',
            'modelSize': 'small',
            'artifactRevision': None,
        },
        cancel_generation=0,
        delete_generation=0,
    )

    assert committed is not None
    assert committed['captionsSourceTranscriptHash'] == hash_transcript_text(crlf_text)
    hydrated = manager.get_meeting(meeting['id'])
    assert hydrated is not None
    assert hydrated['captionsAvailable'] is True
    assert hydrated['captionsStatus'] == 'ready'


def test_scan_reads_outside_metadata_lock_and_rejects_changed_transcript(tmp_path, monkeypatch):
    recordings = tmp_path / 'recordings'
    manager = MeetingManager(str(recordings))
    audio, transcript = _create_source_files(recordings, 'meeting_20260803_120000')
    _write_captions_sidecar(audio.with_suffix('.captions.json'), transcript.read_text())
    original_read = manager._read_transcript_text
    original_find = manager._find_valid_sibling_captions

    def read_unlocked(path):
        assert not manager._metadata_thread_lock._is_owned()
        return original_read(path)

    def change_after_caption_read(path, text):
        assert not manager._metadata_thread_lock._is_owned()
        result = original_find(path, text)
        transcript.write_text('changed while scanning', encoding='utf-8')
        return result

    monkeypatch.setattr(manager, '_read_transcript_text', read_unlocked)
    monkeypatch.setattr(manager, '_find_valid_sibling_captions', change_after_caption_read)
    assert manager.scan_and_sync_recordings()['added'] == 0
    assert manager.list_meetings() == []
