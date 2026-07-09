"""Characterization tests for Phase 6 meeting helper extractions."""

from __future__ import annotations

import unittest
from datetime import datetime
from pathlib import Path

from meetings.normalization import (
    hash_text,
    normalize_text,
    normalize_transcription_error,
    normalize_transcription_status,
    parse_metadata,
    strip_inline_transcript,
)
from meetings.scan_import import (
    extract_duration_seconds_from_transcript,
    parse_scan_meeting_id_and_title,
    select_scannable_audio_files,
)


class MeetingNormalizationTests(unittest.TestCase):
    def test_normalize_transcription_status_and_error(self):
        self.assertEqual(normalize_transcription_status("COMPLETED"), "completed")
        self.assertEqual(normalize_transcription_status("nope", default="pending"), "pending")
        self.assertIsNone(normalize_transcription_error(""))
        self.assertEqual(normalize_transcription_error("  boom  "), "boom")

    def test_hash_and_strip_and_normalize_text(self):
        digest = hash_text("hello")
        self.assertTrue(digest.startswith("sha256:"))
        self.assertEqual(len(digest), len("sha256:") + 64)
        self.assertEqual(strip_inline_transcript({"id": "1", "transcript": "x"})["id"], "1")
        self.assertNotIn("transcript", strip_inline_transcript({"id": "1", "transcript": "x"}))
        self.assertEqual(normalize_text("  a\n b  "), "a b")

    def test_parse_metadata_unset_and_object(self):
        unset = object()
        self.assertIs(parse_metadata(None, "summary", unset=unset), unset)
        self.assertEqual(parse_metadata('{"status":"ready"}', "summary", unset=unset)["status"], "ready")
        with self.assertRaises(SystemExit):
            parse_metadata("{", "summary", unset=unset)


class MeetingScanImportTests(unittest.TestCase):
    def test_select_scannable_prefers_wav_over_opus(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            (recordings_dir / "meeting_20260101_120000.opus").write_bytes(b"opus")
            (recordings_dir / "meeting_20260101_120000.wav").write_bytes(b"wav")
            selected = select_scannable_audio_files(recordings_dir)
            self.assertEqual([path.name for path in selected], ["meeting_20260101_120000.wav"])

    def test_duration_and_id_parsing(self):
        self.assertEqual(
            extract_duration_seconds_from_transcript("**Duration:** 01:02:03\n"),
            3723.0,
        )
        self.assertEqual(
            extract_duration_seconds_from_transcript("**Duration:** 12:34\n"),
            754.0,
        )
        meeting_id, title = parse_scan_meeting_id_and_title("meeting_20260107_104555_1")
        self.assertEqual(meeting_id, "20260107_104555_1")
        self.assertEqual(title, "Meeting 2026-01-07 10:45")

        meeting_id, title = parse_scan_meeting_id_and_title(
            "recording_2025-12-01T13-31-43",
            now=datetime(2026, 1, 1, 0, 0, 0),
        )
        self.assertEqual(meeting_id, "20251201_133143")
        self.assertEqual(title, "Meeting 2025-12-01 13:31:43")


if __name__ == "__main__":
    unittest.main()
