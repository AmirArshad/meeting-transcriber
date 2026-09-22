import hashlib
import json
from pathlib import Path

import pytest

import backend.meeting_manager as meeting_manager_module
from backend.meeting_manager import MeetingManager
from meetings.normalization import (
    TranscriptionMetadataError,
    normalize_transcription_request,
    normalize_transcription_result,
)


ATTEMPT_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ATTEMPT_ID = "22222222-2222-4222-8222-222222222222"
LOCK_ID = "a" * 64
ONNX_REVISION = "0bbb45a3365852604aef28b538a8f066f4ccaa85"


def _request(engine="whisper", attempt_id=ATTEMPT_ID):
    if engine == "whisper":
        return {
            "schemaVersion": 1,
            "attemptId": attempt_id,
            "engine": "whisper",
            "language": "en",
            "modelSize": "small",
            "artifactRevision": None,
        }
    return {
        "schemaVersion": 1,
        "attemptId": attempt_id,
        "engine": "parakeet",
        "modelId": "parakeet-tdt-0.6b-v2",
        "artifactRevision": ONNX_REVISION,
        "adapterId": "parakeet-onnx-linux-cuda-v1",
        "runtimeLockId": LOCK_ID,
        "language": "en",
        "boundaryPolicy": "parakeet-boundaries-v1",
    }


def _result(engine="whisper", attempt_id=ATTEMPT_ID):
    result = {
        "schemaVersion": 1,
        "attemptId": attempt_id,
        "engine": engine,
        "language": "en",
        "device": "cuda",
        "computeType": "float32" if engine == "parakeet" else "float16",
    }
    if engine == "whisper":
        result["modelSize"] = "small"
    else:
        result.update({
            "modelId": "parakeet-tdt-0.6b-v2",
            "artifactRevision": ONNX_REVISION,
            "adapterId": "parakeet-onnx-linux-cuda-v1",
            "runtimeLockId": LOCK_ID,
            "boundaryPolicy": "parakeet-boundaries-v1",
        })
    return result


def _seed_meeting(tmp_path: Path):
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    audio = recordings / "source.opus"
    transcript = recordings / "source.md"
    audio.write_bytes(b"original-audio")
    transcript.write_text("# Transcript\n\nhello", encoding="utf-8")
    manager = MeetingManager(recordings_dir=str(recordings))
    meeting = manager.add_meeting(
        audio_path=str(audio),
        transcript_path=str(transcript),
        duration=3,
        language="en",
        model="small",
        transcription_device="cpu",
        transcription_compute_type="int8",
    )
    return manager, meeting


def _write_candidate(meeting, attempt_id, text):
    audio = Path(meeting["audioPath"])
    candidate = audio.with_name(f"{audio.stem}.transcript-{attempt_id}.md")
    candidate.write_text(text, encoding="utf-8")
    return candidate


def test_malformed_and_legacy_requests_keep_their_contracts():
    assert normalize_transcription_request(None) is None
    assert normalize_transcription_request({"language": "fa", "modelSize": "tiny"}) is None
    with pytest.raises(TranscriptionMetadataError) as unknown:
        normalize_transcription_request({"schemaVersion": 1, "engine": "nemo", "attemptId": ATTEMPT_ID, "language": "en"}, require_explicit=True)
    assert unknown.value.code == "UNKNOWN_ENGINE"
    with pytest.raises(TranscriptionMetadataError):
        normalize_transcription_request({
            **_request("parakeet"),
            "language": "/tmp/secret",
        }, require_explicit=True)


def test_failed_cross_engine_retry_retains_whisper_provenance(tmp_path):
    manager, meeting = _seed_meeting(tmp_path)
    audio_hash = hashlib.sha256(Path(meeting["audioPath"]).read_bytes()).hexdigest()
    original_transcript = Path(meeting["transcriptPath"]).read_text(encoding="utf-8")
    whisper_candidate = _write_candidate(meeting, ATTEMPT_ID, "# Transcript\n\nwhisper words")
    staged = manager.stage_transcription_request(meeting["id"], _request("whisper"), cancel_generation=1, delete_generation=1)
    committed = manager.commit_transcription_attempt(
        meeting["id"],
        attempt_id=ATTEMPT_ID,
        candidate_path=str(whisper_candidate),
        result=_result("whisper"),
        cancel_generation=1,
        delete_generation=1,
    )
    assert committed["transcriptionResult"]["engine"] == "whisper"
    assert committed["model"] == "small"

    parakeet = manager.stage_transcription_request(
        meeting["id"],
        _request("parakeet", OTHER_ATTEMPT_ID),
        cancel_generation=2,
        delete_generation=2,
    )
    assert parakeet["model"] == "small"
    assert parakeet["transcriptionResult"]["engine"] == "whisper"
    failed = manager.fail_transcription_attempt(meeting["id"], OTHER_ATTEMPT_ID, "PARAKEET_GPU_UNAVAILABLE")
    assert failed["transcriptionStatus"] == "failed"
    assert failed["transcriptionResult"]["engine"] == "whisper"
    assert failed["model"] == "small"
    assert failed["language"] == "en"
    assert Path(failed["transcriptPath"]).read_text(encoding="utf-8") == "# Transcript\n\nwhisper words"
    assert hashlib.sha256(Path(meeting["audioPath"]).read_bytes()).hexdigest() == audio_hash
    assert original_transcript != Path(failed["transcriptPath"]).read_text(encoding="utf-8")
    assert staged["transcriptionRequest"]["engine"] == "whisper"


def test_stale_attempt_and_crash_windows_leave_the_referenced_transcript(tmp_path, monkeypatch):
    manager, meeting = _seed_meeting(tmp_path)
    candidate = _write_candidate(meeting, ATTEMPT_ID, "# Transcript\n\nready")
    manager.stage_transcription_request(meeting["id"], _request("whisper"), cancel_generation=4, delete_generation=5)
    before = json.loads(manager.metadata_file.read_text(encoding="utf-8"))
    with pytest.raises(TranscriptionMetadataError) as stale:
        manager.commit_transcription_attempt(
            meeting["id"],
            attempt_id=OTHER_ATTEMPT_ID,
            candidate_path=str(candidate),
            result=_result("whisper", OTHER_ATTEMPT_ID),
            cancel_generation=4,
            delete_generation=5,
        )
    assert stale.value.code == "STALE_TRANSCRIPTION_ATTEMPT"
    assert json.loads(manager.metadata_file.read_text(encoding="utf-8"))[0]["transcriptPath"] == before[0]["transcriptPath"]
    assert candidate.exists()

    def fail_unlink(self):
        raise OSError("crash after commit")

    monkeypatch.setattr(Path, "unlink", fail_unlink)
    committed = manager.commit_transcription_attempt(
        meeting["id"],
        attempt_id=ATTEMPT_ID,
        candidate_path=str(candidate),
        result=_result("whisper"),
        cancel_generation=4,
        delete_generation=5,
    )
    assert Path(committed["transcriptPath"]) == candidate
    assert committed["transcriptionResult"]["transcriptHash"].startswith("sha256:")
    assert Path(before[0]["transcriptPath"]).exists()


def test_atomic_write_failure_does_not_publish_the_candidate_or_change_audio(tmp_path, monkeypatch):
    manager, meeting = _seed_meeting(tmp_path)
    audio_bytes = Path(meeting["audioPath"]).read_bytes()
    candidate = _write_candidate(meeting, ATTEMPT_ID, "# Transcript\n\nnot yet")
    manager.stage_transcription_request(meeting["id"], _request("parakeet"), cancel_generation=0, delete_generation=0)
    saved_before = manager.metadata_file.read_text(encoding="utf-8")

    def fail_replace(src, dst):
        raise OSError("replace failed")

    monkeypatch.setattr(meeting_manager_module.os, "replace", fail_replace)
    with pytest.raises(OSError):
        manager.commit_transcription_attempt(
            meeting["id"],
            attempt_id=ATTEMPT_ID,
            candidate_path=str(candidate),
            result=_result("parakeet"),
            cancel_generation=0,
            delete_generation=0,
        )

    assert manager.metadata_file.read_text(encoding="utf-8") == saved_before
    assert candidate.exists()
    assert Path(meeting["audioPath"]).read_bytes() == audio_bytes
    reloaded = MeetingManager(recordings_dir=str(tmp_path / "recordings")).get_meeting(meeting["id"])
    assert reloaded["transcriptionResult"]["engine"] != "parakeet" if reloaded.get("transcriptionResult") else True
    assert reloaded["model"] == "small"
    assert "not yet" not in reloaded["transcript"]


def test_scan_import_reports_unknown_engine_and_ignores_attempt_markdown(tmp_path):
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    audio = recordings / "meeting_20250101_120000.opus"
    transcript = recordings / "meeting_20250101_120000.md"
    attempt = recordings / f"meeting_20250101_120000.transcript-{ATTEMPT_ID}.md"
    audio.write_bytes(b"audio")
    transcript.write_text("**Duration:** 0:02\n\nimported", encoding="utf-8")
    attempt.write_text("unreferenced candidate", encoding="utf-8")
    manager = MeetingManager(recordings_dir=str(recordings))

    result = manager.scan_and_sync_recordings()
    meeting = manager.get_meeting("20250101_120000")

    assert result["added"] == 1
    assert meeting["transcriptionResult"]["engine"] == "unknown"
    assert meeting["model"] == "unknown"
    assert "transcriptionRequest" not in meeting
    assert meeting["transcriptPath"].endswith("meeting_20250101_120000.md")
    assert attempt.exists()
    assert manager.get_meeting(ATTEMPT_ID) is None


def test_broken_schema_version_does_not_escape_history_listing(tmp_path):
    manager, meeting = _seed_meeting(tmp_path)
    stored = json.loads(manager.metadata_file.read_text(encoding="utf-8"))
    stored[0]["transcriptionRequest"] = {
        "schemaVersion": "broken",
        "engine": "whisper",
        "attemptId": ATTEMPT_ID,
        "language": "en",
        "modelSize": "small",
    }
    stored[0]["transcriptionResult"] = {"schemaVersion": "broken", "engine": "whisper"}
    manager.metadata_file.write_text(json.dumps(stored), encoding="utf-8")

    listed = manager.list_meetings()

    assert len(listed) == 1
    assert listed[0]["id"] == meeting["id"]
    assert "transcriptionRequest" not in listed[0]
    assert "transcriptionResult" not in listed[0]


def test_add_meeting_stores_the_request_with_the_pending_row(tmp_path):
    recordings = tmp_path / "recordings"
    recordings.mkdir()
    audio = recordings / "source.opus"
    transcript = recordings / "source.md"
    audio.write_bytes(b"audio")
    transcript.write_text("hello", encoding="utf-8")
    manager = MeetingManager(recordings_dir=str(recordings))
    with pytest.raises(TranscriptionMetadataError):
        manager.add_meeting(
            audio_path=str(audio),
            transcript_path=str(transcript),
            duration=1,
            language="en",
            model="small",
            transcription_request={**_request(), "schemaVersion": "broken"},
        )
    assert manager.list_meetings() == []
    assert audio.exists()

    saved = manager.add_meeting(
        audio_path=str(audio),
        transcript_path=str(transcript),
        duration=1,
        language="en",
        model="small",
        transcription_status="completed",
        transcription_request=_request(),
    )
    assert saved["transcriptionStatus"] == "pending"
    assert saved["transcriptionRequest"]["attemptId"] == ATTEMPT_ID
    assert saved["transcriptionAttemptGuard"]["attemptId"] == ATTEMPT_ID


def test_exclude_incomplete_transcription_blocks_only_a_row_without_a_request(tmp_path):
    manager, meeting = _seed_meeting(tmp_path)
    excluded = manager.exclude_incomplete_transcription(meeting["id"])
    assert excluded["transcriptionStatus"] == "failed"
    assert excluded["transcriptionResumeExcluded"] is True
    assert "transcriptionRequest" not in excluded

    staged = manager.stage_transcription_request(meeting["id"], _request())
    unchanged = manager.exclude_incomplete_transcription(meeting["id"])
    assert unchanged["transcriptionStatus"] == "pending"
    assert unchanged["transcriptionRequest"]["attemptId"] == staged["transcriptionRequest"]["attemptId"]


def test_result_validator_keeps_device_compute_type_and_transcript_hash():
    accepted = normalize_transcription_result({
        **_result(),
        "transcriptHash": "sha256:" + ("ab" * 32),
        "modelPath": "/tmp/secret/model.bin",
    })
    assert accepted["device"] == "cuda"
    assert accepted["computeType"] == "float16"
    assert accepted["transcriptHash"] == "sha256:" + ("ab" * 32)
    assert "modelPath" not in accepted
    with pytest.raises(TranscriptionMetadataError):
        normalize_transcription_result({key: value for key, value in _result().items() if key != "device"})
    with pytest.raises(TranscriptionMetadataError):
        normalize_transcription_result({**_result(), "schemaVersion": "broken"})


def test_cancelled_attempt_cannot_commit_candidate(tmp_path):
    manager, meeting = _seed_meeting(tmp_path)
    manager.stage_transcription_request(meeting['id'], _request('parakeet'))
    candidate = _write_candidate(meeting, ATTEMPT_ID, '# Transcript\n\nlate output')
    manager.update_transcription(meeting['id'], status='failed', error='TRANSCRIPTION_CANCELLED')
    with pytest.raises(TranscriptionMetadataError) as exc:
        manager.commit_transcription_attempt(
            meeting['id'], attempt_id=ATTEMPT_ID, candidate_path=str(candidate),
            result=_result('parakeet'), cancel_generation=0, delete_generation=0,
        )
    assert exc.value.code == 'TRANSCRIPTION_ATTEMPT_SUPERSEDED'
    saved = manager.get_meeting(meeting['id'])
    assert saved['transcriptionStatus'] == 'failed'
    assert Path(saved['transcriptPath']).read_text(encoding='utf-8') == '# Transcript\n\nhello'
