"""Capture-time transcription selection on manifests and recovery."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from audio.capture_manifest import (  # noqa: E402
    CaptureManifestCoordinator,
    CaptureManifestError,
    parse_transcription_selection_argument,
)
from audio.capture_recovery import (  # noqa: E402
    list_interrupted_captures,
    recover_capture,
)
from audio.capture_spool_runtime import with_transcription_selection  # noqa: E402
from meetings.scan_import import select_scannable_audio_files  # noqa: E402

WHISPER_SELECTION = {
    "schemaVersion": 1,
    "attemptId": "11111111-1111-4111-8111-111111111111",
    "engine": "whisper",
    "language": "fr",
    "modelSize": "medium",
    "artifactRevision": None,
}


def _parakeet_selection() -> dict:
    lock = json.loads((ROOT / "build/parakeet/linux-cuda.lock.json").read_text(encoding="utf-8"))
    return {
        "schemaVersion": 1,
        "attemptId": "22222222-2222-4222-8222-222222222222",
        "engine": "parakeet",
        "modelId": "parakeet-tdt-0.6b-v2",
        "artifactRevision": lock["model"]["revision"],
        "adapterId": lock["adapterId"],
        "runtimeLockId": lock["lockDigest"],
        "language": "en",
        "boundaryPolicy": "parakeet-boundaries-v1",
    }


class CaptureTranscriptionSelectionTests(unittest.TestCase):
    def test_create_persists_selection_before_tracks_exist(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "recording_selection.opus"
            coordinator = CaptureManifestCoordinator.create(
                output_path,
                started_at_ns=10,
                started_at_iso="2026-09-22T12:00:00.000Z",
                transcription_selection=WHISPER_SELECTION,
            )
            try:
                session_dir = coordinator.session_dir
                self.assertEqual(list(session_dir.glob("*.pcm.part")), [])
                data = json.loads((session_dir / "manifest.json").read_text(encoding="utf-8"))
            finally:
                coordinator.close()
        self.assertEqual(data["transcriptionSelection"]["engine"], "whisper")
        self.assertEqual(data["transcriptionSelection"]["language"], "fr")
        self.assertEqual(data["transcriptionSelection"]["modelSize"], "medium")
        self.assertNotIn("modelPath", data["transcriptionSelection"])

    def test_legacy_manifest_omits_selection(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "recording_legacy.opus"
            coordinator = CaptureManifestCoordinator.create(
                output_path,
                started_at_ns=10,
                started_at_iso="2026-09-22T12:00:00.000Z",
            )
            try:
                data = json.loads((coordinator.session_dir / "manifest.json").read_text(encoding="utf-8"))
            finally:
                coordinator.close()
        self.assertNotIn("transcriptionSelection", data)

    def test_invalid_selection_fails_open_and_removes_the_session(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "recording_invalid.opus"
            with self.assertRaises(CaptureManifestError):
                CaptureManifestCoordinator.create(
                    output_path,
                    started_at_ns=10,
                    started_at_iso="2026-09-22T12:00:00.000Z",
                    transcription_selection={"engine": "cloud", "schemaVersion": 1},
                )
            self.assertFalse(output_path.with_suffix(".capture").exists())
            self.assertFalse(output_path.exists())

    def test_empty_cli_selection_stays_absent(self):
        self.assertIsNone(parse_transcription_selection_argument(""))
        self.assertIsNone(parse_transcription_selection_argument(None))

    def test_success_payload_carries_selection_and_cancel_does_not(self):
        payload = with_transcription_selection(
            {"success": True, "audioPath": "meeting.opus", "duration": 1},
            WHISPER_SELECTION,
        )
        self.assertEqual(payload["transcriptionSelection"]["language"], "fr")
        cancelled = with_transcription_selection(
            {"success": True, "cancelled": True},
            None,
        )
        self.assertNotIn("transcriptionSelection", cancelled)

    def test_interrupted_recovery_keeps_selection_and_discard_does_not_import(self):
        selection = _parakeet_selection()
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            output_path = recordings_dir / "recording_recover.opus"
            coordinator = CaptureManifestCoordinator.create(
                output_path,
                started_at_ns=10,
                started_at_iso="2026-09-22T12:00:00.000Z",
                transcription_selection=selection,
            )
            session_dir = coordinator.session_dir
            coordinator.close()

            candidates = list_interrupted_captures(recordings_dir)
            self.assertEqual(len(candidates), 1)
            self.assertEqual(candidates[0]["transcriptionSelection"]["engine"], "parakeet")
            self.assertEqual(
                candidates[0]["transcriptionSelection"]["runtimeLockId"],
                selection["runtimeLockId"],
            )

            reopened = CaptureManifestCoordinator.open_existing(session_dir, lock_timeout=0)
            reopened.set_state("discarded")
            reopened.close()
            self.assertEqual(list_interrupted_captures(recordings_dir), [])
            self.assertFalse(session_dir.exists())
            self.assertEqual(select_scannable_audio_files(recordings_dir), [])

    def test_discarded_recover_result_omits_selection(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            output_path = recordings_dir / "recording_discard.opus"
            coordinator = CaptureManifestCoordinator.create(
                output_path,
                started_at_ns=10,
                started_at_iso="2026-09-22T12:00:00.000Z",
                transcription_selection=WHISPER_SELECTION,
            )
            session_dir = coordinator.session_dir
            coordinator.set_state("discarded")
            coordinator.close()
            result = recover_capture(recordings_dir, session_dir)
        self.assertTrue(result["cancelled"])
        self.assertNotIn("transcriptionSelection", result)
        self.assertNotIn("audioPath", result)


if __name__ == "__main__":
    unittest.main()
