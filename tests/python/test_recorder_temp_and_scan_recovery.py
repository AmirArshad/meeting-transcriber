"""Recorder temp path + scan-import recovery characterization tests."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from audio.recorder_temp_paths import (  # noqa: E402
    MIN_RECOVERABLE_PCM_BYTES,
    RECORDER_TEMP_PCM_SUFFIX,
    build_recorder_temp_pcm_path,
    build_stable_wav_path_for_output,
    is_recorder_temp_pcm_path,
    is_recoverable_recorder_temp,
    promote_recorder_temp_to_wav,
)
from meetings.scan_import import (  # noqa: E402
    is_recorder_temp_audio_file,
    recover_or_cleanup_recorder_temps,
    recording_stem_from_audio_path,
    select_scannable_audio_files,
)


def _valid_temp_bytes() -> bytes:
    return b"R" * (MIN_RECOVERABLE_PCM_BYTES + 1)


class RecorderTempPathTests(unittest.TestCase):
    def test_build_temp_path_uses_non_scanned_suffix(self):
        path = build_recorder_temp_pcm_path(r"C:\Users\me\recordings\recording_2026.opus")
        self.assertTrue(path.endswith(RECORDER_TEMP_PCM_SUFFIX))
        self.assertFalse(path.endswith(".wav"))
        self.assertFalse(path.endswith(".opus"))
        self.assertTrue(
            build_stable_wav_path_for_output(r"C:\Users\me\recordings\recording_2026.opus").endswith(".wav")
        )

    def test_is_recorder_temp_recognizes_current_and_legacy(self):
        self.assertTrue(is_recorder_temp_pcm_path("recording_x.pcm.tmp"))
        self.assertTrue(is_recorder_temp_pcm_path("recording_x.temp.wav"))
        self.assertTrue(is_recorder_temp_pcm_path("recording_x_temp.wav"))
        self.assertFalse(is_recorder_temp_pcm_path("recording_x.wav"))
        self.assertFalse(is_recorder_temp_pcm_path("recording_x.opus"))

    def test_promote_rejects_truncated_temp(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            temp_pcm = recordings_dir / "recording_x.pcm.tmp"
            temp_pcm.write_bytes(b"RIFF")
            self.assertFalse(is_recoverable_recorder_temp(temp_pcm))
            promoted = promote_recorder_temp_to_wav(temp_pcm, recordings_dir / "recording_x.wav")
            self.assertIsNone(promoted)
            self.assertFalse(temp_pcm.exists())
            self.assertFalse((recordings_dir / "recording_x.wav").exists())

    def test_promote_moves_valid_temp_to_stable_wav(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            temp_pcm = recordings_dir / "recording_x.pcm.tmp"
            temp_pcm.write_bytes(_valid_temp_bytes())
            promoted = promote_recorder_temp_to_wav(temp_pcm, recordings_dir / "recording_x.wav")
            self.assertEqual(Path(promoted).name, "recording_x.wav")
            self.assertFalse(temp_pcm.exists())
            self.assertTrue((recordings_dir / "recording_x.wav").exists())


class ScanImportTempRecoveryTests(unittest.TestCase):
    def test_select_scannable_skips_legacy_temp_wav_names(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            (recordings_dir / "meeting_20260101_120000.opus").write_bytes(b"opus")
            (recordings_dir / "meeting_20260101_120000.temp.wav").write_bytes(b"temp")
            (recordings_dir / "meeting_20260101_120000_temp.wav").write_bytes(b"temp2")
            selected = select_scannable_audio_files(recordings_dir)
            self.assertEqual([path.name for path in selected], ["meeting_20260101_120000.opus"])

    def test_recover_promotes_orphan_temp_to_wav(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            temp_pcm = recordings_dir / "recording_2026-01-01T12-00-00.pcm.tmp"
            temp_pcm.write_bytes(_valid_temp_bytes())
            result = recover_or_cleanup_recorder_temps(recordings_dir)
            self.assertEqual(result["recovered"], 1)
            self.assertFalse(temp_pcm.exists())
            promoted = recordings_dir / "recording_2026-01-01T12-00-00.wav"
            self.assertTrue(promoted.exists())
            selected = select_scannable_audio_files(recordings_dir)
            self.assertEqual([path.name for path in selected], [promoted.name])

    def test_recover_drops_truncated_temp(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            temp_pcm = recordings_dir / "recording_2026-01-01T12-00-00.pcm.tmp"
            temp_pcm.write_bytes(b"RIFF")  # header-only junk
            result = recover_or_cleanup_recorder_temps(recordings_dir)
            self.assertEqual(result["dropped"], 1)
            self.assertEqual(result["recovered"], 0)
            self.assertFalse(temp_pcm.exists())
            self.assertEqual(select_scannable_audio_files(recordings_dir), [])

    def test_recover_cleans_temp_when_final_opus_exists(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            stem = "recording_2026-01-01T12-00-00"
            (recordings_dir / f"{stem}.opus").write_bytes(b"opus")
            temp_pcm = recordings_dir / f"{stem}.pcm.tmp"
            temp_pcm.write_bytes(_valid_temp_bytes())
            result = recover_or_cleanup_recorder_temps(recordings_dir)
            self.assertEqual(result["cleaned"], 1)
            self.assertFalse(temp_pcm.exists())
            self.assertEqual(
                [path.name for path in select_scannable_audio_files(recordings_dir)],
                [f"{stem}.opus"],
            )

    def test_stem_helpers_strip_temp_suffixes(self):
        self.assertEqual(
            recording_stem_from_audio_path(Path("recording_x.pcm.tmp")),
            "recording_x",
        )
        self.assertEqual(
            recording_stem_from_audio_path(Path("recording_x.temp.wav")),
            "recording_x",
        )
        self.assertTrue(is_recorder_temp_audio_file(Path("recording_x_temp.wav")))

    def test_select_scannable_skips_capture_session_artifacts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            meeting = recordings_dir / "meeting_20260101_120000.opus"
            meeting.write_bytes(b"opus")
            capture_dir = recordings_dir / "recording_x.capture"
            capture_dir.mkdir()
            (capture_dir / "mic_0000.pcm.part").write_bytes(b"\x00" * 16)
            (capture_dir / "inside.wav").write_bytes(b"RIFF")
            (recordings_dir / "loose.pcm.part").write_bytes(b"\x00" * 8)
            selected = select_scannable_audio_files(recordings_dir)
            self.assertEqual([path.name for path in selected], [meeting.name])

    def test_select_scannable_skips_same_stem_opus_beside_live_capture(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            stem = "meeting_20260101_120000"
            partial = recordings_dir / f"{stem}.opus"
            partial.write_bytes(b"truncated-opus")
            capture_dir = recordings_dir / f"{stem}.capture"
            capture_dir.mkdir()
            (capture_dir / "manifest.json").write_text("{}", encoding="utf-8")
            other = recordings_dir / "meeting_20260101_130000.opus"
            other.write_bytes(b"ok")
            selected = select_scannable_audio_files(recordings_dir)
            self.assertEqual([path.name for path in selected], [other.name])


if __name__ == "__main__":
    unittest.main()
