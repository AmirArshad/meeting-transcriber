import json
import sqlite3
import subprocess
import sys
from pathlib import Path

from backend.meeting_manager import MeetingManager
from backend.search.history_index import (
    INDEX_SCHEMA_VERSION,
    build_fts5_query,
    get_history_index_status,
    rebuild_history_index,
    search_history_index,
    snippet_text_to_parts,
    sync_history_index,
)
from backend.transcription import captions as transcript_captions


ROOT = Path(__file__).resolve().parents[2]


def _seed_meeting(
    recordings_dir: Path,
    *,
    meeting_id: str,
    title: str,
    date_iso: str,
    transcript_md: str,
    duration: str = "03:00",
    duration_seconds: float = 180.0,
    language: str = "en",
    cues=None,
    summary_md: str = "",
    summary_hash_override: str = "",
    transcription_status: str = "completed",
) -> dict:
    recordings_dir.mkdir(parents=True, exist_ok=True)
    stem = meeting_id
    audio_path = recordings_dir / f"{stem}.opus"
    audio_path.write_bytes(b"OggS-fake-audio")

    transcript_path = recordings_dir / f"{stem}_transcript.md"
    transcript_path.write_text(transcript_md, encoding="utf-8")

    transcript_hash = transcript_captions.hash_transcript_text(transcript_md)

    captions_path = None
    if cues is not None:
        captions_file = recordings_dir / f"{stem}.captions.json"
        payload = transcript_captions.build_captions_payload(
            cues=cues,
            source_transcript_hash=transcript_hash,
            engine="faster-whisper",
        )
        captions_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        captions_path = str(captions_file)

    summary_meta = None
    if summary_md:
        summary_file = recordings_dir / f"{stem}_summary.md"
        summary_file.write_text(summary_md, encoding="utf-8")
        summary_meta = {
            "status": "completed",
            "markdownPath": str(summary_file),
            "sourceTranscriptHash": summary_hash_override or transcript_hash,
            "modelId": "qwen3.5-9b-q4-k-m",
        }

    meetings_file = recordings_dir / "meetings.json"
    existing = json.loads(meetings_file.read_text(encoding="utf-8")) if meetings_file.exists() else []
    entry = {
        "id": meeting_id,
        "title": title,
        "date": date_iso,
        "duration": duration,
        "durationSeconds": duration_seconds,
        "language": language,
        "audioPath": str(audio_path),
        "transcriptPath": str(transcript_path),
        "transcriptionStatus": transcription_status,
        **({"captionsPath": captions_path} if captions_path else {}),
        **({"ai": {"summary": summary_meta}} if summary_meta else {}),
    }
    existing = [m for m in existing if m.get("id") != meeting_id]
    existing.append(entry)
    meetings_file.write_text(json.dumps(existing, indent=2), encoding="utf-8")
    return entry


def test_indexes_captions_passages_groups_cues_and_splits_on_speaker_change(tmp_path):
    rec_dir = tmp_path / "recordings"
    index_path = tmp_path / "search" / "history-index.sqlite"

    cues = [
        {"id": 1, "startMs": 1_000, "endMs": 6_000, "speaker": "Alice", "text": "Let us review the telemetry rollout schedule."},
        {"id": 2, "startMs": 6_500, "endMs": 12_000, "speaker": "Alice", "text": "The alpha builds passed every latency budget."},
        {"id": 3, "startMs": 13_000, "endMs": 19_000, "speaker": "Alice", "text": "Storage quotas stay strictly inside userData."},
        {"id": 4, "startMs": 20_000, "endMs": 28_000, "speaker": "Bob", "text": "Wait, what about the GPU memory cap on CachyOS Linux?"},
    ]
    _seed_meeting(
        rec_dir,
        meeting_id="meeting_20261110_090000",
        title="Platform Engineering Sync",
        date_iso="2026-11-10T09:00:00",
        transcript_md="# Transcript\n\nPlaceholder text replaced by captions hash match.",
        cues=cues,
    )

    stats = sync_history_index(rec_dir, index_path)
    assert stats["totalMeetings"] == 1
    assert stats["syncedMeetings"] == 1

    conn = sqlite3.connect(str(index_path))
    conn.row_factory = sqlite3.Row
    transcript_rows = conn.execute(
        "SELECT speaker, start_ms, end_ms, text FROM passages WHERE kind='transcript' ORDER BY seq_index"
    ).fetchall()
    conn.close()

    # Alice cues (1s..19s, <25s) grouped into one passage; speaker change to Bob flushes new passage.
    assert len(transcript_rows) == 2
    assert transcript_rows[0]["speaker"] == "Alice"
    assert transcript_rows[0]["start_ms"] == 1_000
    assert transcript_rows[0]["end_ms"] == 19_000
    assert transcript_rows[1]["speaker"] == "Bob"
    assert transcript_rows[1]["start_ms"] == 20_000

    res = search_history_index(rec_dir, index_path, query="CachyOS")
    assert res["matchedMeetingCount"] == 1
    hit = res["meetings"][0]["bestPassage"]
    assert hit["startSec"] == 20.0
    assert hit["speaker"] == "Bob"
    assert any(p["match"] and "CachyOS" in p["text"] for p in hit["snippetParts"])


def test_v2_markdown_and_untimed_markdown_and_placeholder_exclusion(tmp_path):
    rec_dir = tmp_path / "recordings"
    index_path = tmp_path / "search" / "history-index.sqlite"

    _seed_meeting(
        rec_dir,
        meeting_id="meeting_v2",
        title="Roadmap Review",
        date_iso="2026-11-11T10:00:00",
        transcript_md=(
            "# Meeting Transcription\n\n---\n\n## Transcript\n\n"
            "**[02:15 - 02:40]** **Dana:**\n"
            "We finalized the quarterly procurement budget today.\n"
            "Follow-up signoff happens next Tuesday with finance.\n"
        ),
    )
    _seed_meeting(
        rec_dir,
        meeting_id="meeting_untimed",
        title="Quick Voice Note",
        date_iso="2026-11-12T10:00:00",
        transcript_md=(
            "# Meeting Transcription\n\n"
            "**File:** note.opus\n"
            "**Date:** 2026-11-12\n\n---\n\n"
            "Remember to double-check the microphone gain curve tomorrow.\n"
        ),
    )
    _seed_meeting(
        rec_dir,
        meeting_id="meeting_pending",
        title="Awaiting Audio",
        date_iso="2026-11-13T10:00:00",
        transcript_md=(
            "# Recording Awaiting Transcription\n\n"
            "The recording was saved successfully, but a transcript is not available yet.\n"
        ),
        transcription_status="pending",
    )

    sync_history_index(rec_dir, index_path)

    r1 = search_history_index(rec_dir, index_path, query="procurement budget")
    assert [m["meetingId"] for m in r1["meetings"]] == ["meeting_v2"]
    assert r1["meetings"][0]["bestPassage"]["startSec"] == 135.0
    assert r1["meetings"][0]["bestPassage"]["speaker"] == "Dana"
    assert "Tuesday" in r1["meetings"][0]["bestPassage"]["text"]

    r2 = search_history_index(rec_dir, index_path, query="microphone gain")
    assert [m["meetingId"] for m in r2["meetings"]] == ["meeting_untimed"]
    assert r2["meetings"][0]["bestPassage"]["startSec"] is None

    # Boilerplate placeholder text must never pollute search hits.
    r3 = search_history_index(rec_dir, index_path, query="saved successfully")
    assert all(m["meetingId"] != "meeting_pending" for m in r3["meetings"])


def test_summary_hash_gating_and_hard_delete_zero_hits(tmp_path):
    rec_dir = tmp_path / "recordings"
    index_path = tmp_path / "search" / "history-index.sqlite"

    _seed_meeting(
        rec_dir,
        meeting_id="meeting_fresh_summary",
        title="Launch Checklist",
        date_iso="2026-11-14T10:00:00",
        transcript_md="**[00:10 - 00:25]**\nLet us walk through release items.\n",
        summary_md="# Summary\n\n**Model:** qwen\n\nMain deliverable is zephryx hardware certification.\n",
    )
    _seed_meeting(
        rec_dir,
        meeting_id="meeting_stale_summary",
        title="Old Sync",
        date_iso="2026-11-14T11:00:00",
        transcript_md="**[00:10 - 00:25]**\nNothing unusual discussed here.\n",
        summary_md="# Summary\n\nOrphaned mention of zephryx from old transcript.\n",
        summary_hash_override="sha256:0000000000000000000000000000000000000000000000000000000000000000",
    )

    sync_history_index(rec_dir, index_path)

    res = search_history_index(rec_dir, index_path, query="zephryx")
    assert [m["meetingId"] for m in res["meetings"]] == ["meeting_fresh_summary"]
    assert res["meetings"][0]["bestPassage"]["kind"] == "summary"

    # Hard-delete the meeting via MeetingManager and verify incremental sync leaves zero hits.
    manager = MeetingManager(recordings_dir=str(rec_dir))
    assert manager.delete_meeting("meeting_fresh_summary") is True

    stats = sync_history_index(rec_dir, index_path)
    assert stats["removedMeetings"] == 1
    after = search_history_index(rec_dir, index_path, query="zephryx")
    assert after["matchedMeetingCount"] == 0
    assert after["meetings"] == []


def test_corrupt_sqlite_file_triggers_atomic_rebuild(tmp_path):
    rec_dir = tmp_path / "recordings"
    index_path = tmp_path / "search" / "history-index.sqlite"

    _seed_meeting(
        rec_dir,
        meeting_id="meeting_corrupt_test",
        title="Recovery Check",
        date_iso="2026-11-15T12:00:00",
        transcript_md="**[00:05 - 00:15]**\nQuantum espresso extraction notes.\n",
    )

    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_bytes(b"NOT A VALID SQLITE DATABASE FILE AT ALL")

    before_status = get_history_index_status(rec_dir, index_path)
    assert before_status["exists"] is True
    assert before_status["valid"] is False

    res = search_history_index(rec_dir, index_path, query="espresso")
    assert res["matchedMeetingCount"] == 1
    assert res["meetings"][0]["meetingId"] == "meeting_corrupt_test"

    status = get_history_index_status(rec_dir, index_path)
    assert status["valid"] is True
    assert status["schemaVersion"] == INDEX_SCHEMA_VERSION
    assert status["dbSizeBytes"] > 0
    assert status["totalMeetings"] == 1


def test_fts5_injection_diacritics_non_latin_and_long_meeting_fairness(tmp_path):
    rec_dir = tmp_path / "recordings"
    index_path = tmp_path / "search" / "history-index.sqlite"

    # Meeting A has 8 matching passages; Meeting B has 1 matching passage.
    # Asking for limit=2, max_matches_per_meeting=2 must return BOTH meetings instead of starving Meeting B.
    lines_a = "\n".join(
        f"**[00:{i:02d} - 00:{i + 2:02d}]**\nDiscussion item {i} about budgeting forecasts.\n"
        for i in range(1, 16, 2)
    )
    _seed_meeting(
        rec_dir,
        meeting_id="meeting_many",
        title="Café résumé planning",
        date_iso="2026-11-16T09:00:00",
        transcript_md=lines_a,
    )
    _seed_meeting(
        rec_dir,
        meeting_id="meeting_other",
        title="Tokyo Architecture",
        date_iso="2026-11-16T15:00:00",
        transcript_md="**[01:00 - 01:10]**\nApproved budgeting targets for नमस्ते and 東京プロジェクト release.\n",
    )

    rebuild_history_index(rec_dir, index_path)

    # FTS5 operator injection attempt should be safely quoted and not raise OperationalError.
    match_expr, _ = build_fts5_query('budgeting AND NOT OR * " () NEAR/3')
    assert "NEAR" in match_expr and '"' in match_expr

    res_fair = search_history_index(
        rec_dir,
        index_path,
        query="budgeting",
        limit=2,
        max_matches_per_meeting=2,
    )
    assert res_fair["matchedMeetingCount"] == 2
    assert {m["meetingId"] for m in res_fair["meetings"]} == {"meeting_many", "meeting_other"}
    assert all(len(m["matches"]) <= 2 for m in res_fair["meetings"])

    # Diacritics stripped in title search.
    res_diacritics = search_history_index(rec_dir, index_path, query="cafe resume")
    assert [m["meetingId"] for m in res_diacritics["meetings"]] == ["meeting_many"]

    # Non-Latin Devanagari + CJK fallback.
    res_hindi = search_history_index(rec_dir, index_path, query="नमस्ते")
    assert [m["meetingId"] for m in res_hindi["meetings"]] == ["meeting_other"]

    res_cjk = search_history_index(rec_dir, index_path, query="東京プロ")
    assert [m["meetingId"] for m in res_cjk["meetings"]] == ["meeting_other"]


def test_date_range_scope_and_cli_json_roundtrip(tmp_path):
    rec_dir = tmp_path / "recordings"
    index_path = tmp_path / "search" / "history-index.sqlite"

    _seed_meeting(
        rec_dir,
        meeting_id="m_oct",
        title="October Sync",
        date_iso="2026-10-05T10:00:00",
        transcript_md="**[00:05 - 00:15]**\nAlpha milestone review.\n",
    )
    _seed_meeting(
        rec_dir,
        meeting_id="m_nov",
        title="November Sync",
        date_iso="2026-11-18T10:00:00",
        transcript_md="**[00:05 - 00:15]**\nAlpha milestone review.\n",
    )

    scoped = search_history_index(
        rec_dir,
        index_path,
        query="Alpha",
        date_from="2026-11-01",
        date_to="2026-11-30",
    )
    assert [m["meetingId"] for m in scoped["meetings"]] == ["m_nov"]

    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "search.cli",
            "--recordings-dir",
            str(rec_dir),
            "--index-path",
            str(index_path),
            "search",
            "--query",
            "Alpha",
        ],
        cwd=str(ROOT / "backend"),
        capture_output=True,
        text=True,
        check=True,
    )
    cli_payload = json.loads(proc.stdout)
    assert cli_payload["matchedMeetingCount"] == 2
    assert snippet_text_to_parts("\x01Alpha\x02 review") == [
        {"text": "Alpha", "match": True},
        {"text": " review", "match": False},
    ]
