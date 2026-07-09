"""Characterization tests for Phase 6 meeting helper extractions."""

from __future__ import annotations

import tempfile
import unittest
from datetime import datetime
from pathlib import Path

from meeting_manager import MeetingManager
from meetings.normalization import (
    hash_text,
    normalize_text,
    normalize_transcription_error,
    normalize_transcription_status,
    parse_metadata,
    strip_inline_transcript,
)
from meetings.paths import (
    is_recordings_path,
    normalize_ai_feature_metadata,
    normalize_sidecar_path,
    resolve_accessible_recordings_file,
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


class MeetingPathsSecurityTests(unittest.TestCase):
    """Direct coverage for paths.py security helpers (review hardening)."""

    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.root = Path(self._tmpdir.name)
        self.recordings_dir = self.root / "recordings"
        self.manager = MeetingManager(recordings_dir=str(self.recordings_dir))

    def tearDown(self):
        self._tmpdir.cleanup()

    def test_is_recordings_path_rejects_outside_and_accepts_inside(self):
        inside = self.recordings_dir / "meeting.opus"
        outside = self.root / "outside.opus"
        inside.write_bytes(b"in")
        outside.write_bytes(b"out")
        self.assertTrue(is_recordings_path(self.manager, inside))
        self.assertFalse(is_recordings_path(self.manager, outside))

    def test_resolve_accessible_rejects_symlink_outside_and_bad_suffix(self):
        inside = self.recordings_dir / "ok.opus"
        outside = self.root / "outside.opus"
        bad_suffix = self.recordings_dir / "notes.txt"
        inside.write_bytes(b"ok")
        outside.write_bytes(b"out")
        bad_suffix.write_text("nope", encoding="utf-8")

        self.assertEqual(
            resolve_accessible_recordings_file(
                self.manager,
                inside,
                allowed_suffixes=(".opus",),
                label="audio",
            ),
            inside.resolve(strict=False),
        )
        self.assertIsNone(
            resolve_accessible_recordings_file(
                self.manager,
                outside,
                allowed_suffixes=(".opus",),
                label="audio",
            )
        )
        self.assertIsNone(
            resolve_accessible_recordings_file(
                self.manager,
                bad_suffix,
                allowed_suffixes=(".opus",),
                label="audio",
            )
        )

        link = self.recordings_dir / "linked.opus"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("symlinks unavailable in this environment")
        self.assertIsNone(
            resolve_accessible_recordings_file(
                self.manager,
                link,
                allowed_suffixes=(".opus",),
                label="audio",
            )
        )

    def test_normalize_sidecar_path_raises_on_unsafe_inputs(self):
        inside = self.recordings_dir / "segments.json"
        outside = self.root / "outside.json"
        bad_suffix = self.recordings_dir / "segments.txt"
        inside.write_text("{}", encoding="utf-8")
        outside.write_text("{}", encoding="utf-8")
        bad_suffix.write_text("{}", encoding="utf-8")

        self.assertEqual(
            normalize_sidecar_path(self.manager, inside, (".json",)),
            str(inside.resolve(strict=False)),
        )
        self.assertIsNone(normalize_sidecar_path(self.manager, None, (".json",)))
        with self.assertRaisesRegex(ValueError, "unsupported file extension"):
            normalize_sidecar_path(self.manager, bad_suffix, (".json",))
        with self.assertRaisesRegex(ValueError, "recordings directory"):
            normalize_sidecar_path(self.manager, outside, (".json",))

        link = self.recordings_dir / "linked.json"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("symlinks unavailable in this environment")
        with self.assertRaisesRegex(ValueError, "symlink"):
            normalize_sidecar_path(self.manager, link, (".json",))

    def test_normalize_ai_feature_metadata_filters_fields_and_hashes(self):
        segments = self.recordings_dir / "speakers.json"
        segments.write_text("{}", encoding="utf-8")
        good_hash = "sha256:" + ("ab" * 32)

        normalized = normalize_ai_feature_metadata(
            self.manager,
            "diarization",
            {
                "status": "  ready  ",
                "speakerCount": "3",
                "segmentsPath": str(segments),
                "error": "  boom  ",
                "unknownField": "drop-me",
            },
        )
        self.assertEqual(normalized["status"], "ready")
        self.assertEqual(normalized["speakerCount"], 3)
        self.assertEqual(normalized["segmentsPath"], str(segments.resolve(strict=False)))
        self.assertEqual(normalized["error"], "boom")
        self.assertNotIn("unknownField", normalized)

        summary = normalize_ai_feature_metadata(
            self.manager,
            "summary",
            {
                "sourceTranscriptHash": "not-a-hash",
                "model": "tiny",
            },
        )
        self.assertNotIn("sourceTranscriptHash", summary)
        self.assertEqual(summary["model"], "tiny")

        summary_ok = normalize_ai_feature_metadata(
            self.manager,
            "summary",
            {"sourceTranscriptHash": good_hash},
        )
        self.assertEqual(summary_ok["sourceTranscriptHash"], good_hash)

        with self.assertRaisesRegex(ValueError, "Unsupported AI metadata feature"):
            normalize_ai_feature_metadata(self.manager, "embeddings", {"status": "x"})


if __name__ == "__main__":
    unittest.main()
