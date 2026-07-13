"""Tests for bounded per-track capture spools."""

from __future__ import annotations

import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from audio.capture_manifest import CaptureManifestCoordinator  # noqa: E402
from audio.track_spool import (  # noqa: E402
    TrackSpool,
    TrackSpoolBackpressureError,
    queue_headroom_seconds,
)


def _int16_stereo_frames(frame_count: int, value: int = 1000) -> bytes:
    samples = np.full((frame_count, 2), value, dtype="<i2")
    return samples.tobytes()


class TrackSpoolTests(unittest.TestCase):
    def _open_spool(self, recordings_dir: Path, **kwargs):
        coordinator = CaptureManifestCoordinator.create(
            recordings_dir / "recording_spool.opus",
            started_at_ns=1,
            started_at_iso="2026-07-13T14:00:00.000Z",
        )
        coordinator.add_track("mic", sample_rate=48000, channels=2, dtype="<i2")
        spool = TrackSpool(
            coordinator,
            coordinator.session_dir,
            "mic",
            sample_rate=48000,
            channels=2,
            dtype="<i2",
            **kwargs,
        )
        return coordinator, spool

    def test_queue_headroom_uses_declared_format(self):
        # 8 MiB / (48000 * 2 * 2) ≈ 43.69 s for stereo int16
        seconds = queue_headroom_seconds(
            max_queue_bytes=8 * 1024 * 1024,
            sample_rate=48000,
            channels=2,
            dtype="<i2",
        )
        self.assertAlmostEqual(seconds, (8 * 1024 * 1024) / (48000 * 2 * 2), places=6)

    def test_sequential_writes_and_close_commit_frames(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator, spool = self._open_spool(
                recordings_dir,
                max_queue_bytes=1024 * 1024,
                segment_bytes=64 * 1024,
                stall_timeout_s=5,
                flush_interval_s=0.05,
            )
            try:
                chunk = _int16_stereo_frames(100)
                self.assertTrue(spool.append(chunk))
                self.assertTrue(spool.append(chunk, frame_position=100))
                result = spool.close(final_frame_count=200)
                self.assertEqual(result.committed_frames, 200)
                self.assertEqual(result.written_frames, 200)
                self.assertGreaterEqual(len(result.segments), 1)
                track = coordinator.get_track("mic")
                self.assertEqual(track["committedFrames"], 200)
                total_bytes = sum(
                    (coordinator.session_dir / name).stat().st_size for name in track["segments"]
                )
                self.assertEqual(total_bytes, 200 * 2 * 2)
            finally:
                coordinator.close()

    def test_frame_position_inserts_silence_and_trims_overlap(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator, spool = self._open_spool(
                recordings_dir,
                max_queue_bytes=1024 * 1024,
                segment_bytes=64 * 1024,
                stall_timeout_s=5,
                flush_interval_s=0.05,
            )
            try:
                first = _int16_stereo_frames(50, value=11)
                self.assertTrue(spool.append(first, frame_position=0))
                # Gap of 25 frames should become silence.
                second = _int16_stereo_frames(50, value=22)
                self.assertTrue(spool.append(second, frame_position=75))
                # Overlap of 10 frames should trim the start of the new chunk.
                third = _int16_stereo_frames(20, value=33)
                self.assertTrue(spool.append(third, frame_position=115))
                result = spool.close()
                self.assertEqual(result.committed_frames, 135)

                pcm = b"".join(
                    (coordinator.session_dir / name).read_bytes()
                    for name in coordinator.get_track("mic")["segments"]
                )
                samples = np.frombuffer(pcm, dtype="<i2").reshape(-1, 2)
                self.assertEqual(len(samples), 135)
                self.assertTrue(np.all(samples[0:50] == 11))
                self.assertTrue(np.all(samples[50:75] == 0))
                self.assertTrue(np.all(samples[75:125] == 22))
                self.assertTrue(np.all(samples[125:135] == 33))
            finally:
                coordinator.close()

    def test_segment_rollover_with_small_threshold(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            # 400 bytes/segment → 100 stereo int16 frames per segment
            coordinator, spool = self._open_spool(
                recordings_dir,
                max_queue_bytes=1024 * 1024,
                segment_bytes=400,
                stall_timeout_s=5,
                flush_interval_s=0.05,
            )
            try:
                for i in range(5):
                    self.assertTrue(spool.append(_int16_stereo_frames(100), frame_position=i * 100))
                result = spool.close()
                self.assertGreaterEqual(len(result.segments), 5)
                self.assertEqual(result.committed_frames, 500)
            finally:
                coordinator.close()

    def test_hard_cap_rejects_without_dropping_or_blocking(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            soft_warnings = []
            pause = threading.Event()  # cleared → writer paused
            coordinator, spool = self._open_spool(
                recordings_dir,
                max_queue_bytes=64,
                segment_bytes=1024,
                stall_timeout_s=30,
                flush_interval_s=60,
                on_soft_warning=lambda **kwargs: soft_warnings.append(kwargs),
                pause_writer=pause,
            )
            try:
                frame_bytes = 2 * 2  # stereo int16
                chunk = _int16_stereo_frames(4)  # 16 bytes
                self.assertEqual(len(chunk), 16)
                accepted = 0
                while spool.append(chunk):
                    accepted += 1
                    if accepted > 20:
                        self.fail("hard cap never fired")
                self.assertGreater(accepted, 0)
                self.assertFalse(spool.append(chunk))
                self.assertGreaterEqual(len(soft_warnings), 1)

                # Unblock writer and close committed audio.
                pause.set()
                result = spool.close()
                self.assertGreaterEqual(result.committed_frames, 0)
                self.assertLessEqual(
                    result.committed_frames * frame_bytes,
                    accepted * len(chunk),
                )
            finally:
                pause.set()
                coordinator.close()

    def test_writer_exception_makes_append_return_false(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator, spool = self._open_spool(
                recordings_dir,
                max_queue_bytes=1024 * 1024,
                segment_bytes=64 * 1024,
                stall_timeout_s=5,
                flush_interval_s=0.01,
            )
            try:
                spool._test_raise_on_write = True
                # Give the writer a chance to fail on the first chunk.
                self.assertTrue(spool.append(_int16_stereo_frames(10)))
                deadline = time.time() + 2.0
                rejected = False
                while time.time() < deadline:
                    if not spool.append(_int16_stereo_frames(10)):
                        rejected = True
                        break
                    time.sleep(0.01)
                self.assertTrue(rejected)
            finally:
                coordinator.close()

    def test_close_pads_to_final_frame_count(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator, spool = self._open_spool(
                recordings_dir,
                max_queue_bytes=1024 * 1024,
                segment_bytes=64 * 1024,
                stall_timeout_s=5,
                flush_interval_s=0.05,
            )
            try:
                self.assertTrue(spool.append(_int16_stereo_frames(40)))
                result = spool.close(final_frame_count=100)
                self.assertEqual(result.committed_frames, 100)
                pcm = b"".join(
                    (coordinator.session_dir / name).read_bytes()
                    for name in coordinator.get_track("mic")["segments"]
                )
                self.assertEqual(len(pcm), 100 * 4)
            finally:
                coordinator.close()

    def test_rejects_misaligned_pcm_bytes(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator, spool = self._open_spool(recordings_dir)
            try:
                with self.assertRaises(ValueError):
                    spool.append(b"\x00\x01\x02")  # not divisible by frame size
            finally:
                spool.close()
                coordinator.close()

    def test_backpressure_error_message_contract(self):
        err = TrackSpoolBackpressureError(
            "Audio capture writer stalled; recording was stopped to preserve committed audio."
        )
        self.assertIn("preserve committed audio", str(err))

    def test_flush_interval_throttles_manifest_commits(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator, spool = self._open_spool(
                recordings_dir,
                max_queue_bytes=8 * 1024 * 1024,
                segment_bytes=8 * 1024 * 1024,
                stall_timeout_s=30,
                flush_interval_s=0.2,
            )
            commits = []
            original = coordinator.commit_track

            def counting_commit(*args, **kwargs):
                commits.append(time.monotonic())
                return original(*args, **kwargs)

            coordinator.commit_track = counting_commit  # type: ignore[method-assign]
            try:
                started = time.monotonic()
                # ~100 callbacks over ~0.55s — without throttling this would be ~100 commits.
                for i in range(100):
                    self.assertTrue(spool.append(_int16_stereo_frames(10), frame_position=i * 10))
                    time.sleep(0.005)
                elapsed = time.monotonic() - started
                result = spool.close()
                self.assertEqual(result.committed_frames, 1000)
                # Expect roughly elapsed/flush_interval (+ close force + optional rolls).
                expected_upper = int(elapsed / 0.2) + 5
                self.assertLessEqual(
                    len(commits),
                    expected_upper,
                    f"commit_track called {len(commits)} times over {elapsed:.2f}s "
                    f"(upper bound {expected_upper}); flush_interval throttling is broken",
                )
                self.assertGreaterEqual(len(commits), 1)
            finally:
                coordinator.commit_track = original  # type: ignore[method-assign]
                coordinator.close()

    def test_sustained_no_progress_stall_rejects_append(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            pause = threading.Event()
            clock = {"t": 100.0}

            def fake_clock():
                return clock["t"]

            coordinator, spool = self._open_spool(
                recordings_dir,
                max_queue_bytes=1024 * 1024,
                segment_bytes=64 * 1024,
                stall_timeout_s=1.0,
                flush_interval_s=60.0,
                clock=fake_clock,
                pause_writer=pause,
            )
            try:
                chunk = _int16_stereo_frames(4)
                self.assertTrue(spool.append(chunk))
                # Still below stall timeout.
                clock["t"] += 0.5
                self.assertTrue(spool.append(chunk))
                # Past stall_timeout with queued bytes and no commit progress.
                clock["t"] += 1.0
                self.assertFalse(spool.append(chunk))
                self.assertEqual(spool.fail_reason, "sustained no-progress")
            finally:
                pause.set()
                spool.close()
                coordinator.close()

    def test_close_skips_mutation_when_writer_still_alive(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            pause = threading.Event()
            coordinator, spool = self._open_spool(
                recordings_dir,
                max_queue_bytes=1024 * 1024,
                segment_bytes=64 * 1024,
                stall_timeout_s=0.2,
                flush_interval_s=60.0,
                pause_writer=pause,
                close_join_timeout_s=0.3,
            )
            try:
                self.assertTrue(spool.append(_int16_stereo_frames(20)))
                # Keep writer paused so join times out; close must not pad/write.
                result = spool.close(final_frame_count=5000)
                self.assertEqual(result.fail_reason, "writer did not exit at close")
                self.assertLess(result.committed_frames, 5000)
                track = coordinator.get_track("mic")
                total_bytes = sum(
                    (coordinator.session_dir / name).stat().st_size
                    for name in track["segments"]
                ) if track["segments"] else 0
                self.assertLess(total_bytes, 5000 * 4)
            finally:
                pause.set()
                try:
                    spool._queue.put(None)
                except Exception:
                    pass
                spool._worker.join(timeout=2.0)
                coordinator.close()

    def test_float32_stereo_spool_round_trip(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            recordings_dir = Path(temp_dir)
            coordinator = CaptureManifestCoordinator.create(
                recordings_dir / "recording_f4.opus",
                started_at_ns=1,
                started_at_iso="2026-07-13T15:00:00.000Z",
            )
            try:
                coordinator.add_track("mic", sample_rate=48000, channels=2, dtype="<f4")
                spool = TrackSpool(
                    coordinator,
                    coordinator.session_dir,
                    "mic",
                    sample_rate=48000,
                    channels=2,
                    dtype="<f4",
                    max_queue_bytes=1024 * 1024,
                    segment_bytes=64 * 1024,
                    stall_timeout_s=5,
                    flush_interval_s=0.05,
                )
                samples = np.full((80, 2), 0.25, dtype="<f4")
                self.assertTrue(spool.append(samples.tobytes()))
                result = spool.close()
                self.assertEqual(result.committed_frames, 80)
                pcm = b"".join(
                    (coordinator.session_dir / name).read_bytes()
                    for name in coordinator.get_track("mic")["segments"]
                )
                out = np.frombuffer(pcm, dtype="<f4").reshape(-1, 2)
                self.assertEqual(len(out), 80)
                self.assertTrue(np.allclose(out, 0.25))
            finally:
                coordinator.close()


if __name__ == "__main__":
    unittest.main()
