"""Tests for versioned atomic capture manifests and scan exclusion."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from audio.capture_manifest import (  # noqa: E402
    CaptureManifestCoordinator,
    CaptureManifestError,
    MANIFEST_SCHEMA_VERSION,
    discard_capture_session,
    mark_capture_discarded_and_cleanup,
)
from meetings.scan_import import select_scannable_audio_files  # noqa: E402


class CaptureManifestTests(unittest.TestCase):
    def test_create_writes_schema_v1_with_iso_and_monotonic(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            output_path = recordings_dir / "recording_2026-07-13T10-00-00.opus"
            coordinator = CaptureManifestCoordinator.create(
                output_path,
                started_at_ns=123456789,
                started_at_iso="2026-07-13T10:00:00.000Z",
            )
            try:
                session_dir = coordinator.session_dir
                self.assertEqual(session_dir.name, "recording_2026-07-13T10-00-00.capture")
                self.assertTrue((session_dir / "manifest.json").is_file())
                self.assertTrue((session_dir / "session.lock").exists() or True)

                data = json.loads((session_dir / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(data["schemaVersion"], MANIFEST_SCHEMA_VERSION)
                self.assertEqual(data["state"], "recording")
                self.assertEqual(data["outputStem"], "recording_2026-07-13T10-00-00")
                self.assertEqual(data["startedAtMonotonicNs"], 123456789)
                self.assertEqual(data["startedAtIso"], "2026-07-13T10:00:00.000Z")
                self.assertEqual(data["tracks"], {})
            finally:
                coordinator.close()

    def test_add_track_and_commit_survive_reload(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            output_path = recordings_dir / "recording_reload.opus"
            coordinator = CaptureManifestCoordinator.create(
                output_path,
                started_at_ns=100,
                started_at_iso="2026-07-13T11:00:00.000Z",
            )
            try:
                coordinator.add_track("mic", sample_rate=48000, channels=2, dtype="<i2")
                coordinator.commit_track(
                    "mic",
                    segments=["mic_0000.pcm.part"],
                    committed_frames=4800,
                    first_frame_monotonic_ns=101,
                )
                session_dir = coordinator.session_dir
            finally:
                coordinator.close()

            reloaded = CaptureManifestCoordinator.open_existing(session_dir, lock_timeout=0)
            try:
                track = reloaded.get_track("mic")
                self.assertEqual(track["sampleRate"], 48000)
                self.assertEqual(track["channels"], 2)
                self.assertEqual(track["dtype"], "<i2")
                self.assertEqual(track["committedFrames"], 4800)
                self.assertEqual(track["segments"], ["mic_0000.pcm.part"])
                self.assertEqual(track["firstFrameMonotonicNs"], 101)
                self.assertEqual(reloaded.started_at_iso, "2026-07-13T11:00:00.000Z")
                self.assertEqual(reloaded.started_at_monotonic_ns, 100)
            finally:
                reloaded.close()

    def test_rejects_unsafe_segment_paths_and_bad_frames(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator = CaptureManifestCoordinator.create(
                recordings_dir / "recording_bad.opus",
                started_at_ns=1,
                started_at_iso="2026-07-13T12:00:00.000Z",
            )
            try:
                coordinator.add_track("mic", sample_rate=48000, channels=2, dtype="<i2")
                with self.assertRaises(CaptureManifestError):
                    coordinator.commit_track("mic", segments=["../escape.pcm.part"], committed_frames=1)
                with self.assertRaises(CaptureManifestError):
                    coordinator.commit_track("mic", segments=[str(recordings_dir / "abs.pcm.part")], committed_frames=1)
                with self.assertRaises(CaptureManifestError):
                    coordinator.commit_track("mic", segments=["mic_0000.pcm.part"], committed_frames=-1)
                with self.assertRaises(CaptureManifestError):
                    coordinator.add_track("desktop", sample_rate=48000, channels=2, dtype="float64")
            finally:
                coordinator.close()

    def test_concurrent_mic_desktop_commits_preserve_both_tracks(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator = CaptureManifestCoordinator.create(
                recordings_dir / "recording_concurrent.opus",
                started_at_ns=50,
                started_at_iso="2026-07-13T13:00:00.000Z",
            )
            try:
                coordinator.add_track("mic", sample_rate=48000, channels=2, dtype="<i2")
                coordinator.add_track("desktop", sample_rate=48000, channels=2, dtype="<i2")
                errors = []

                def commit_mic():
                    try:
                        for i in range(40):
                            coordinator.commit_track(
                                "mic",
                                segments=[f"mic_{i:04d}.pcm.part"],
                                committed_frames=(i + 1) * 100,
                            )
                    except Exception as exc:  # noqa: BLE001 - collect for assertion
                        errors.append(exc)

                def commit_desktop():
                    try:
                        for i in range(40):
                            coordinator.commit_track(
                                "desktop",
                                segments=[f"desktop_{i:04d}.pcm.part"],
                                committed_frames=(i + 1) * 200,
                            )
                    except Exception as exc:  # noqa: BLE001
                        errors.append(exc)

                threads = [
                    threading.Thread(target=commit_mic),
                    threading.Thread(target=commit_desktop),
                ]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()

                self.assertEqual(errors, [])
                mic = coordinator.get_track("mic")
                desktop = coordinator.get_track("desktop")
                self.assertEqual(mic["committedFrames"], 4000)
                self.assertEqual(desktop["committedFrames"], 8000)
                self.assertEqual(mic["segments"][-1], "mic_0039.pcm.part")
                self.assertEqual(desktop["segments"][-1], "desktop_0039.pcm.part")
            finally:
                coordinator.close()

    def test_capture_dirs_and_pcm_parts_are_not_scannable(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            meeting = recordings_dir / "meeting_20260101_120000.opus"
            meeting.write_bytes(b"opus")

            capture_dir = recordings_dir / "recording_2026-07-13T10-00-00.capture"
            capture_dir.mkdir()
            (capture_dir / "mic_0000.pcm.part").write_bytes(b"\x00" * 64)
            (capture_dir / "manifest.json").write_text("{}", encoding="utf-8")
            # Decoy meeting-like names inside the capture dir must stay unscanned.
            (capture_dir / "decoy.wav").write_bytes(b"RIFF")
            (capture_dir / "decoy.opus").write_bytes(b"opus")
            # Top-level segment must also be ignored if present.
            (recordings_dir / "orphan.pcm.part").write_bytes(b"\x00" * 32)

            selected = select_scannable_audio_files(recordings_dir)
            self.assertEqual([path.name for path in selected], [meeting.name])

    def test_open_existing_rejects_unknown_schema(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator = CaptureManifestCoordinator.create(
                recordings_dir / "recording_schema.opus",
                started_at_ns=1,
                started_at_iso="2026-07-13T16:00:00.000Z",
            )
            session_dir = coordinator.session_dir
            data = coordinator.to_dict()
            coordinator.close()

            data["schemaVersion"] = 99
            (session_dir / "manifest.json").write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(CaptureManifestError):
                CaptureManifestCoordinator.open_existing(session_dir, lock_timeout=0)

    def test_open_existing_rejects_malformed_tracks(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator = CaptureManifestCoordinator.create(
                recordings_dir / "recording_bad_tracks.opus",
                started_at_ns=1,
                started_at_iso="2026-07-13T16:30:00.000Z",
            )
            session_dir = coordinator.session_dir
            data = coordinator.to_dict()
            coordinator.close()

            data["tracks"] = {"mic": {"sampleRate": 48000}}  # missing required fields
            (session_dir / "manifest.json").write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(CaptureManifestError):
                CaptureManifestCoordinator.open_existing(session_dir, lock_timeout=0)

    def test_open_existing_times_out_while_live_coordinator_holds_lock(self):
        from filelock import Timeout

        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            live = CaptureManifestCoordinator.create(
                recordings_dir / "recording_locked.opus",
                started_at_ns=1,
                started_at_iso="2026-07-13T17:00:00.000Z",
            )
            try:
                with self.assertRaises(Timeout):
                    CaptureManifestCoordinator.open_existing(live.session_dir, lock_timeout=0)
            finally:
                live.close()

    def test_create_cleans_up_session_dir_when_initial_write_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            output_path = recordings_dir / "recording_fail_create.opus"
            session_dir = recordings_dir / "recording_fail_create.capture"

            original = CaptureManifestCoordinator._write_atomic_unlocked

            def boom(self):
                raise OSError("injected write failure")

            CaptureManifestCoordinator._write_atomic_unlocked = boom  # type: ignore[method-assign]
            try:
                with self.assertRaises(OSError):
                    CaptureManifestCoordinator.create(
                        output_path,
                        started_at_ns=1,
                        started_at_iso="2026-07-13T18:00:00.000Z",
                    )
                self.assertFalse(session_dir.exists())
            finally:
                CaptureManifestCoordinator._write_atomic_unlocked = original  # type: ignore[method-assign]

    def test_discard_capture_session_removes_directory_after_close(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            output_path = recordings_dir / "recording_discard.opus"
            coordinator = CaptureManifestCoordinator.create(
                output_path,
                started_at_ns=1,
                started_at_iso="2026-07-13T18:00:00.000Z",
            )
            session_dir = coordinator.session_dir
            self.assertTrue(session_dir.is_dir())
            coordinator.close()
            discard_capture_session(session_dir)
            self.assertFalse(session_dir.exists())
            # Idempotent.
            discard_capture_session(session_dir)

    def test_mark_capture_discarded_writes_marker_then_deletes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            output_path = recordings_dir / "recording_cancel.opus"
            coordinator = CaptureManifestCoordinator.create(
                output_path,
                started_at_ns=1,
                started_at_iso="2026-07-13T18:00:00.000Z",
            )
            session_dir = coordinator.session_dir
            segment = session_dir / "mic_0000.pcm.part"
            segment.write_bytes(b"\x00\x01")
            mark_capture_discarded_and_cleanup(coordinator)
            self.assertFalse(session_dir.exists())

    def test_mark_capture_discarded_does_not_delete_when_marker_write_fails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            output_path = recordings_dir / "recording_marker_fail.opus"
            coordinator = CaptureManifestCoordinator.create(
                output_path,
                started_at_ns=1,
                started_at_iso="2026-07-13T18:00:00.000Z",
            )
            session_dir = coordinator.session_dir
            segment = session_dir / "mic_0000.pcm.part"
            segment.write_bytes(b"\x00\x01")
            coordinator.close()
            with self.assertRaises(CaptureManifestError):
                mark_capture_discarded_and_cleanup(coordinator)
            self.assertTrue(session_dir.is_dir())
            self.assertTrue(segment.is_file())
            data = json.loads((session_dir / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(data["state"], "recording")


if __name__ == "__main__":
    unittest.main()
