import json
import sqlite3
import subprocess
import sys
from contextlib import closing
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


def test_unbound_summary_is_not_indexed(tmp_path):
    rec_dir = tmp_path / 'recordings'
    index_path = tmp_path / 'search' / 'history-index.sqlite'
    _seed_meeting(
        rec_dir,
        meeting_id='m_mismatched',
        title='Mismatched',
        date_iso='2026-11-10',
        transcript_md='ordinary transcript',
        summary_md='secretmismatchedsummary',
        summary_hash_override='sha256:badhash',
    )
    _seed_meeting(
        rec_dir,
        meeting_id='m_incomplete',
        title='Incomplete',
        date_iso='2026-11-10',
        transcript_md='ordinary transcript',
        summary_md='secretincompletesummary',
    )
    _seed_meeting(
        rec_dir,
        meeting_id='m_legacy_completed',
        title='Legacy Completed',
        date_iso='2026-11-10',
        transcript_md='ordinary transcript',
        summary_md='secretlegacysummary',
    )
    metadata = json.loads((rec_dir / 'meetings.json').read_text())
    del metadata[1]['ai']['summary']['sourceTranscriptHash']
    metadata[1]['ai']['summary']['status'] = 'failed'
    del metadata[2]['ai']['summary']['sourceTranscriptHash']
    (rec_dir / 'meetings.json').write_text(json.dumps(metadata))

    assert search_history_index(rec_dir, index_path, query='secretmismatchedsummary')['matchedMeetingCount'] == 0
    assert search_history_index(rec_dir, index_path, query='secretincompletesummary')['matchedMeetingCount'] == 0
    legacy_res = search_history_index(rec_dir, index_path, query='secretlegacysummary')
    assert [m['meetingId'] for m in legacy_res['meetings']] == ['m_legacy_completed']
    assert legacy_res['meetings'][0]['bestPassage']['kind'] == 'summary'


def test_schema_rebuild_from_v1_untimed_speakers_and_tag_sync(tmp_path):
    rec_dir = tmp_path / 'recordings'
    index_path = tmp_path / 'search' / 'history-index.sqlite'
    _seed_meeting(
        rec_dir,
        meeting_id='m_untimed_spk',
        title='Untimed Sync',
        date_iso='2026-11-19T09:00:00',
        transcript_md=(
            '# Audio Transcript\n\n'
            '**Alice:** Welcome everyone to the quarterly planning session.\n\n'
            '**Bob:** Let us review the shipping checklist next.\n'
        ),
    )

    # Seed an obsolete v1 SQLite database missing tag & speaker_names_hash columns.
    index_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(index_path))
    conn.executescript(
        """
        CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO index_meta (key, value) VALUES ('schema_version', '1');
        CREATE TABLE indexed_meetings (
            meeting_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            date_iso TEXT NOT NULL,
            duration_sec REAL NOT NULL,
            language TEXT NOT NULL,
            transcript_hash TEXT NOT NULL,
            summary_hash TEXT NOT NULL,
            captions_hash TEXT NOT NULL,
            title_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE passages (
            passage_id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            seq_index INTEGER NOT NULL,
            start_ms INTEGER,
            end_ms INTEGER,
            title TEXT NOT NULL,
            speaker TEXT NOT NULL,
            text TEXT NOT NULL,
            source_transcript_hash TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE passages_fts USING fts5(title, speaker, text, content='passages', content_rowid='passage_id');
        """
    )
    conn.commit()
    conn.close()

    stats = sync_history_index(rec_dir, index_path)
    assert stats['rebuilt'] is True
    assert stats['schemaVersion'] == INDEX_SCHEMA_VERSION
    assert INDEX_SCHEMA_VERSION == '3'

    res = search_history_index(rec_dir, index_path, query='quarterly planning')
    assert res['matchedMeetingCount'] == 1
    assert res['meetings'][0]['bestPassage']['speaker'] == 'Alice'

    # Updating tag in meetings.json incrementally re-syncs without full rebuild.
    metadata = json.loads((rec_dir / 'meetings.json').read_text())
    metadata[0]['tag'] = 'interview'
    (rec_dir / 'meetings.json').write_text(json.dumps(metadata))

    inc_stats = sync_history_index(rec_dir, index_path)
    assert inc_stats['rebuilt'] is False
    assert inc_stats['syncedMeetings'] == 1

    res_tagged = search_history_index(rec_dir, index_path, query='shipping checklist')
    assert res_tagged['meetings'][0]['tag'] == 'interview'
    assert res_tagged['meetings'][0]['bestPassage']['speaker'] == 'Bob'


def test_rebuild_refuses_live_wal_reader(tmp_path):
    rec_dir = tmp_path / 'recordings'
    index_path = tmp_path / 'search' / 'history-index.sqlite'
    sync_history_index(rec_dir, index_path)
    conn = sqlite3.connect(index_path)
    try:
        conn.execute('BEGIN')
        conn.execute('SELECT * FROM index_meta').fetchall()
        try:
            rebuild_history_index(rec_dir, index_path)
        except sqlite3.OperationalError:
            pass
        else:
            raise AssertionError('rebuild replaced a live WAL')
        assert index_path.exists()
    finally:
        conn.close()


def test_cli_reads_leading_hyphen_query_from_stdin(tmp_path):
    result = subprocess.run(
        [sys.executable, '-m', 'backend.search.cli', '--recordings-dir', str(tmp_path / 'recordings'),
         '--index-path', str(tmp_path / 'search' / 'history-index.sqlite'), 'search', '--stdin-json'],
        input=json.dumps({'query': '-private'}), text=True, capture_output=True, cwd=ROOT,
        env={**__import__('os').environ, 'PYTHONPATH': str(ROOT / 'backend')},
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['query'] == '-private'


def test_mixed_untimed_speech_is_indexed_and_superseded_legacy_summary_excluded(tmp_path):
    rec_dir = tmp_path / "recordings"
    index_path = tmp_path / "search" / "history-index.sqlite"

    # 1. Untimed labeled speech, continuation lines and unlabeled paragraphs.
    _seed_meeting(
        rec_dir,
        meeting_id="m_untimed_multi",
        title="Untimed Multi-Para",
        date_iso="2026-11-20T10:00:00",
        transcript_md=(
            "# Audio Transcript\n\n"
            "Opening paragraph on inventory.\n\n"
            "**Alice:** First paragraph by Alice about onboarding.\n"
            "Continuation about training.\n\n"
            "Second paragraph on quotas.\n\n"
            "---\n\n"
            "Third paragraph after divider with no speaker.\n\n"
            "**Dr. Li:** Closing remarks.\n"
        ),
    )

    # 2. Legacy completed summary without sourceTranscriptHash must be rejected when transcript was superseded.
    _seed_meeting(
        rec_dir,
        meeting_id="m_superseded_attempt",
        title="Retranscribed Attempt",
        date_iso="2026-11-20T11:00:00",
        transcript_md="Fresh transcript body.",
        summary_md="# Summary\n\nStaleAttemptSummarySecret from old transcription.\n",
    )
    _seed_meeting(
        rec_dir,
        meeting_id="m_superseded_path",
        title="Retranscribed Path",
        date_iso="2026-11-20T12:00:00",
        transcript_md="Fresh transcript body.",
        summary_md="# Summary\n\nStalePathSummarySecret from old transcription.\n",
    )
    metadata = json.loads((rec_dir / "meetings.json").read_text(encoding="utf-8"))
    for row in metadata:
        if row["id"] == "m_superseded_attempt":
            del row["ai"]["summary"]["sourceTranscriptHash"]
            row["transcriptionResult"] = {
                "schemaVersion": 1,
                "attemptId": "11111111-1111-4111-8111-111111111111",
                "engine": "whisper",
                "modelSize": "small",
                "language": "en",
                "device": "cpu",
                "computeType": "int8",
                "artifactRevision": None,
                "transcriptHash": None,
            }
        elif row["id"] == "m_superseded_path":
            del row["ai"]["summary"]["sourceTranscriptHash"]
            old_path = Path(row["transcriptPath"])
            new_path = rec_dir / "m_superseded_path.transcript-att3.md"
            new_path.write_text(old_path.read_text(encoding="utf-8"), encoding="utf-8")
            row["transcriptPath"] = str(new_path)
    (rec_dir / "meetings.json").write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    sync_history_index(rec_dir, index_path)

    with closing(sqlite3.connect(index_path)) as conn, conn:
        conn.execute("UPDATE index_meta SET value = '2' WHERE key = 'schema_version'")
    assert sync_history_index(rec_dir, index_path)["rebuilt"] is True
    assert search_history_index(rec_dir, index_path, query="quotas")["meetings"][0]["meetingId"] == "m_untimed_multi"

    from backend.search.history_index import list_indexed_meeting_headers

    conn = sqlite3.connect(str(index_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT speaker, text FROM passages WHERE meeting_id = 'm_untimed_multi' AND kind = 'transcript' ORDER BY seq_index"
        ).fetchall()
        assert [(row["speaker"], row["text"]) for row in rows] == [
            ("", "Opening paragraph on inventory."),
            ("Alice", "First paragraph by Alice about onboarding. Continuation about training."),
            ("", "Second paragraph on quotas. Third paragraph after divider with no speaker."),
            ("Dr. Li", "Closing remarks."),
        ]

        headers = list_indexed_meeting_headers(conn, meeting_ids=["m_untimed_multi"])
        assert len(headers) == 1
        assert headers[0]["speakers"] == ["Alice", "Dr. Li"]
    finally:
        conn.close()

    assert search_history_index(rec_dir, index_path, query="StaleAttemptSummarySecret")["matchedMeetingCount"] == 0
    assert search_history_index(rec_dir, index_path, query="StalePathSummarySecret")["matchedMeetingCount"] == 0


def test_tags_filtering_cli_and_localized_summary_metadata_stripping(tmp_path):
    rec_dir = tmp_path / "recordings"
    index_path = tmp_path / "search" / "history-index.sqlite"

    _seed_meeting(
        rec_dir,
        meeting_id="m_interview",
        title="Candidate Screen",
        date_iso="2026-11-10T09:00:00",
        transcript_md="**[00:10 - 00:20]** **Interviewer:**\nLet us discuss distributed consensus.\n",
        summary_md=(
            "# Resumo\n\n"
            "**Etiqueta:** Entrevista · **Perfil:** Equilibrado\n\n"
            "Candidato explicou consenso distribuído.\n"
        ),
    )
    _seed_meeting(
        rec_dir,
        meeting_id="m_lecture",
        title="Systems Class",
        date_iso="2026-11-12T09:00:00",
        transcript_md="**[00:10 - 00:20]** **Prof:**\nDistributed consensus guarantees safety under partitions.\n",
        summary_md=(
            "# Zusammenfassung\n\n"
            "**Kategorie:** Vorlesung / Studium · **Profil:** Ausgewogen\n\n"
            "Der Kurs behandelte verteilten Konsens.\n"
        ),
    )
    _seed_meeting(
        rec_dir,
        meeting_id="m_untagged",
        title="Quick Sync",
        date_iso="2026-11-14T09:00:00",
        transcript_md="**[00:10 - 00:20]** **Alice:**\nDistributed consensus notes.\n",
    )

    metadata = json.loads((rec_dir / "meetings.json").read_text(encoding="utf-8"))
    metadata[0]["tag"] = "interview"
    metadata[1]["tag"] = "lecture"
    (rec_dir / "meetings.json").write_text(json.dumps(metadata), encoding="utf-8")

    sync_history_index(rec_dir, index_path)

    # Filter by single and multiple tags
    res_single = search_history_index(rec_dir, index_path, query="consensus", tags=["interview"])
    assert [m["meetingId"] for m in res_single["meetings"]] == ["m_interview"]

    res_multi = search_history_index(rec_dir, index_path, query="consensus", tags=["interview", "lecture"])
    assert {m["meetingId"] for m in res_multi["meetings"]} == {"m_interview", "m_lecture"}

    # Localized Tag/Tipo metadata lines are stripped from summary passages
    conn = sqlite3.connect(str(index_path))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT meeting_id, text FROM passages WHERE kind = 'summary' ORDER BY meeting_id"
        ).fetchall()
        joined_by_id = {r["meeting_id"]: r["text"] for r in rows}
        assert "Etiqueta:" not in joined_by_id.get("m_interview", "")
        assert "Kategorie:" not in joined_by_id.get("m_lecture", "")
    finally:
        conn.close()

    # Incremental re-sync clears tag cleanly when tag is removed
    metadata[0]["tag"] = None
    (rec_dir / "meetings.json").write_text(json.dumps(metadata), encoding="utf-8")
    sync_stats = sync_history_index(rec_dir, index_path)
    assert sync_stats["syncedMeetings"] == 1
    res_after_clear = search_history_index(rec_dir, index_path, query="consensus", tags=["interview"])
    assert res_after_clear["matchedMeetingCount"] == 0

    # CLI --tags and --stdin-json tags filtering
    env = {**__import__("os").environ, "PYTHONPATH": str(ROOT / "backend")}
    cli_flag = subprocess.run(
        [
            sys.executable, "-m", "backend.search.cli",
            "--recordings-dir", str(rec_dir),
            "--index-path", str(index_path),
            "search", "--query", "consensus", "--tags", "lecture",
        ],
        text=True, capture_output=True, check=True, cwd=ROOT, env=env,
    )
    assert [m["meetingId"] for m in json.loads(cli_flag.stdout)["meetings"]] == ["m_lecture"]

    cli_stdin = subprocess.run(
        [
            sys.executable, "-m", "backend.search.cli",
            "--recordings-dir", str(rec_dir),
            "--index-path", str(index_path),
            "search", "--stdin-json",
        ],
        input=json.dumps({"query": "consensus", "tags": ["lecture"]}),
        text=True, capture_output=True, check=True, cwd=ROOT, env=env,
    )
    assert [m["meetingId"] for m in json.loads(cli_stdin.stdout)["meetings"]] == ["m_lecture"]


def test_rendered_summary_metadata_after_overview_is_not_indexed(tmp_path):
    from backend.summaries.summary_pipeline import render_summary_markdown

    rec_dir = tmp_path / 'recordings'
    index_path = tmp_path / 'index.sqlite'
    markdown = render_summary_markdown(
        {'summary': 'Overview contains unique content.', 'topics': [{'title': 'A topic'}]},
        {'tag': 'meeting', 'profile': 'balanced', 'model': 'Example', 'generatedAt': '2026-11-21T00:00:00Z'},
    )
    _seed_meeting(rec_dir, meeting_id='m1', title='Test', date_iso='2026-11-21',
                  transcript_md='Transcript text', summary_md=markdown)
    sync_history_index(rec_dir, index_path)
    with sqlite3.connect(index_path) as conn:
        text = ' '.join(row[0] for row in conn.execute("SELECT text FROM passages WHERE kind = 'summary'"))
    assert 'Overview contains unique content' in text
    for label in ('Tag:', 'Profile:', 'Model:', 'Generated:'):
        assert label not in text


def test_invalid_tags_rejected_even_without_query_tokens(tmp_path):
    import pytest
    for tags in ([''], ['lecture', '  '], 7, {'lecture': True}):
        with pytest.raises(ValueError):
            search_history_index(tmp_path, tmp_path / 'index', query='', tags=tags, sync=False)
    for tags in ([''], ['lecture', ''], 7, {'lecture': True}, None):
        proc = subprocess.run(
            [sys.executable, '-m', 'backend.search.cli', '--recordings-dir', str(tmp_path),
             '--index-path', str(tmp_path / 'index'), 'search', '--stdin-json'],
            input=json.dumps({'query': '', 'tags': tags}), text=True, capture_output=True, cwd=ROOT,
            env={**__import__('os').environ, 'PYTHONPATH': str(ROOT / 'backend')},
        )
        assert proc.returncode != 0
        assert 'Invalid recording tag' in proc.stderr


def test_speaker_name_overlay_reindexes_captions_and_markdown(tmp_path):
    rec_dir = tmp_path / 'recordings'
    index_path = tmp_path / 'search' / 'history-index.sqlite'
    for meeting_id, cues in [('timed', [{'id': 1, 'startMs': 0, 'endMs': 1000, 'speaker': 'Speaker 1', 'text': 'Hello there'}]), ('untimed', None)]:
        _seed_meeting(rec_dir, meeting_id=meeting_id, title=meeting_id, date_iso='2026-11-10', transcript_md='# Transcript\n\n**Speaker 1:** Hello there', cues=cues)
    sync_history_index(rec_dir, index_path)
    manager = MeetingManager(str(rec_dir))
    for meeting_id in ('timed', 'untimed'):
        manager.update_meeting(meeting_id, speaker_names={'Speaker 1': 'Alice'})
    stats = sync_history_index(rec_dir, index_path)
    assert stats['syncedMeetings'] == 2
    results = search_history_index(rec_dir, index_path, query='Alice')
    assert results['matchedMeetingCount'] == 2
    manager.update_meeting('timed', speaker_names={'Speaker 1': 'Bob'})
    assert sync_history_index(rec_dir, index_path)['syncedMeetings'] == 1
    assert search_history_index(rec_dir, index_path, query='Bob')['matchedMeetingCount'] == 1


def test_mixed_markdown_speaker_boundaries_overlays_and_highlighting(tmp_path):
    rec_dir = tmp_path / 'recordings'
    index_path = tmp_path / 'search' / 'history-index.sqlite'
    _seed_meeting(rec_dir, meeting_id='mixed', title='Mixed', date_iso='2026-11-10', transcript_md=(
        '**Speaker 1:** Before timing\n'
        '[00:01 - 00:03] **speaker 1:** Timed words\n'
        '[00:04 - 00:05] **Speaker 1:**\n'
        '**Speaker 2:** After timing\n'
        '[00:06 - 00:07] speaker_00: Final words\n'
        '[00:08 - 00:09]\n'
        '**Speaker 1:** Untimed after a bare timestamp\n'
    ))
    manager = MeetingManager(str(rec_dir))
    manager.update_meeting('mixed', speaker_names={'Speaker 1': 'Alice', 'Speaker 2': 'Bob', 'SPEAKER_00': 'Carol'})
    sync_history_index(rec_dir, index_path)
    with sqlite3.connect(index_path) as conn:
        rows = conn.execute("SELECT speaker, text, start_ms FROM passages WHERE kind='transcript' ORDER BY seq_index").fetchall()
    assert rows == [('Alice', 'Before timing', None), ('Alice', 'Timed words', 1000),
                    ('Bob', 'After timing', None), ('Carol', 'Final words', 6000),
                    ('Alice', 'Untimed after a bare timestamp', None)]
    hit = search_history_index(rec_dir, index_path, query='Bob')['meetings'][0]['bestPassage']
    assert hit['snippetParts'][0] == {'text': 'Bob', 'match': True}
    assert hit['snippetParts'][1] == {'text': ': ', 'match': False}
    assert 'After timing' in hit['excerpt']
