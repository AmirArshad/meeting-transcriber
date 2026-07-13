"""Bounded segmented PCM track spool with non-blocking callback enqueue.

Callbacks copy contiguous PCM into a byte-counted queue and return immediately.
A writer thread owns segment files, rolls at ``segment_bytes``, fsyncs at least
once per ``flush_interval_s``, then atomically advances ``committedFrames``.
In-memory ``writtenFrames`` may be newer between commits.

``append`` returns ``False`` on hard-cap overflow, sustained no-progress, or a
writer exception. It never blocks and never silently drops the chunk.
"""

from __future__ import annotations

import os
import queue
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, List, Optional, Union

import numpy as np

from .capture_manifest import CaptureManifestCoordinator, CaptureManifestError

PathLike = Union[str, Path]

DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024
DEFAULT_SEGMENT_BYTES = 64 * 1024 * 1024
DEFAULT_STALL_TIMEOUT_S = 30.0
DEFAULT_FLUSH_INTERVAL_S = 1.0
SOFT_HIGH_WATER_RATIO = 0.75
# Bound silence-fill allocations independently of segment size (64 MiB segments
# must not imply 64 MiB zero buffers for long Windows desktop gaps).
MAX_SILENCE_CHUNK_BYTES = 1 * 1024 * 1024


class TrackSpoolBackpressureError(RuntimeError):
    """Raised by recorders when ``TrackSpool.append`` returns False."""


@dataclass
class TrackSpoolResult:
    written_frames: int
    committed_frames: int
    segments: List[str]
    soft_warning_emitted: bool
    fail_reason: Optional[str] = None


def _dtype_itemsize(dtype: str) -> int:
    return int(np.dtype(dtype).itemsize)


def frame_byte_size(channels: int, dtype: str) -> int:
    if channels <= 0:
        raise ValueError("channels must be positive")
    return channels * _dtype_itemsize(dtype)


def queue_headroom_seconds(
    *,
    max_queue_bytes: int,
    sample_rate: int,
    channels: int,
    dtype: str,
) -> float:
    if sample_rate <= 0:
        raise ValueError("sample_rate must be positive")
    bytes_per_second = sample_rate * frame_byte_size(channels, dtype)
    return float(max_queue_bytes) / float(bytes_per_second)


class TrackSpool:
    def __init__(
        self,
        manifest_coordinator: CaptureManifestCoordinator,
        session_dir: PathLike,
        track_name: str,
        sample_rate: int,
        channels: int,
        dtype: str,
        *,
        max_queue_bytes: int = DEFAULT_MAX_QUEUE_BYTES,
        segment_bytes: int = DEFAULT_SEGMENT_BYTES,
        stall_timeout_s: float = DEFAULT_STALL_TIMEOUT_S,
        flush_interval_s: float = DEFAULT_FLUSH_INTERVAL_S,
        on_soft_warning: Optional[Callable[..., None]] = None,
        clock: Callable[[], float] = time.monotonic,
        pause_writer: Optional[threading.Event] = None,
        close_join_timeout_s: Optional[float] = None,
    ) -> None:
        if max_queue_bytes <= 0:
            raise ValueError("max_queue_bytes must be positive")
        if segment_bytes <= 0:
            raise ValueError("segment_bytes must be positive")
        if stall_timeout_s <= 0:
            raise ValueError("stall_timeout_s must be positive")
        if flush_interval_s <= 0:
            raise ValueError("flush_interval_s must be positive")

        self._coordinator = manifest_coordinator
        self._session_dir = Path(session_dir)
        self._track_name = track_name
        self._sample_rate = sample_rate
        self._channels = channels
        self._dtype = dtype
        self._frame_bytes = frame_byte_size(channels, dtype)
        self._max_queue_bytes = int(max_queue_bytes)
        self._segment_bytes = int(segment_bytes)
        self._stall_timeout_s = float(stall_timeout_s)
        self._flush_interval_s = float(flush_interval_s)
        self._on_soft_warning = on_soft_warning
        self._clock = clock
        self._close_join_timeout_s = close_join_timeout_s

        self._queue: queue.Queue[Optional[tuple[bytes, Optional[int]]]] = queue.Queue()
        self._queued_bytes = 0
        self._queued_lock = threading.Lock()
        self._soft_warning_emitted = False
        self._failed = False
        self._fail_reason: Optional[str] = None
        self._closed = False

        self._written_frames = 0
        self._committed_frames = 0
        self._segments: List[str] = []
        self._current_handle = None
        self._current_segment_name: Optional[str] = None
        self._current_segment_bytes = 0
        self._segment_index = 0
        self._last_commit_advance_at = self._clock()
        self._commit_lock = threading.Lock()

        # Test seams (optional).
        self._test_block_writer = pause_writer
        self._test_raise_on_write = False

        self._worker = threading.Thread(
            target=self._writer_loop,
            name=f"track-spool-{track_name}",
            daemon=True,
        )
        self._worker.start()

    @property
    def queue_headroom_seconds(self) -> float:
        return queue_headroom_seconds(
            max_queue_bytes=self._max_queue_bytes,
            sample_rate=self._sample_rate,
            channels=self._channels,
            dtype=self._dtype,
        )

    @property
    def written_frames(self) -> int:
        return self._written_frames

    @property
    def committed_frames(self) -> int:
        with self._commit_lock:
            return self._committed_frames

    @property
    def fail_reason(self) -> Optional[str]:
        return self._fail_reason

    def append(self, pcm: bytes, frame_position: Optional[int] = None) -> bool:
        if self._closed or self._failed:
            return False
        if not isinstance(pcm, (bytes, bytearray, memoryview)):
            raise TypeError("pcm must be bytes-like")
        payload = bytes(pcm)
        if len(payload) % self._frame_bytes != 0:
            raise ValueError(
                f"PCM byte length {len(payload)} is not divisible by frame size {self._frame_bytes}"
            )
        if frame_position is not None:
            if isinstance(frame_position, bool) or not isinstance(frame_position, int) or frame_position < 0:
                raise ValueError("frame_position must be a non-negative int")

        if self._is_stalled():
            self._mark_failed("sustained no-progress")
            return False

        with self._queued_lock:
            if self._queued_bytes + len(payload) > self._max_queue_bytes:
                self._mark_failed("hard queue cap exceeded")
                return False
            self._queued_bytes += len(payload)
            queued_after = self._queued_bytes

        soft_limit = int(self._max_queue_bytes * SOFT_HIGH_WATER_RATIO)
        if (
            not self._soft_warning_emitted
            and queued_after >= soft_limit
            and callable(self._on_soft_warning)
        ):
            self._soft_warning_emitted = True
            try:
                self._on_soft_warning(
                    track=self._track_name,
                    queued_bytes=queued_after,
                    max_queue_bytes=self._max_queue_bytes,
                )
            except Exception:
                pass

        try:
            self._queue.put_nowait((payload, frame_position))
        except queue.Full:
            with self._queued_lock:
                self._queued_bytes = max(0, self._queued_bytes - len(payload))
            self._mark_failed("queue put failed")
            return False

        if self._failed:
            return False
        return True

    def close(self, final_frame_count: Optional[int] = None) -> TrackSpoolResult:
        if self._closed:
            return self._result()

        if final_frame_count is not None:
            if (
                isinstance(final_frame_count, bool)
                or not isinstance(final_frame_count, int)
                or final_frame_count < 0
            ):
                raise ValueError("final_frame_count must be a non-negative int")

        self._closed = True
        try:
            self._queue.put(None)
        except Exception:
            pass

        if self._close_join_timeout_s is not None:
            join_timeout = float(self._close_join_timeout_s)
        else:
            join_timeout = max(5.0, self._stall_timeout_s + 1.0)
        self._worker.join(timeout=join_timeout)

        # If the writer is still hung (slow fsync/disk), do not mutate segment
        # handles or frame counters from this thread — last committed state is
        # the durable contract.
        if self._worker.is_alive():
            self._mark_failed("writer did not exit at close")
            return self._result()

        try:
            if final_frame_count is not None and final_frame_count > self._written_frames:
                pad_frames = final_frame_count - self._written_frames
                self._write_silence(pad_frames)
                self._written_frames = final_frame_count

            self._flush_and_commit(force=True)
            self._close_current_segment()
        except Exception as exc:  # noqa: BLE001 - close must not raise into stop path
            self._mark_failed(f"close failed: {exc}")

        return self._result()

    def _result(self) -> TrackSpoolResult:
        return TrackSpoolResult(
            written_frames=self._written_frames,
            committed_frames=self.committed_frames,
            segments=list(self._segments),
            soft_warning_emitted=self._soft_warning_emitted,
            fail_reason=self._fail_reason,
        )

    def _is_stalled(self) -> bool:
        with self._queued_lock:
            pending = self._queued_bytes
        if pending <= 0:
            return False
        with self._commit_lock:
            last_advance = self._last_commit_advance_at
        return (self._clock() - last_advance) >= self._stall_timeout_s

    def _mark_failed(self, reason: str) -> None:
        self._failed = True
        if self._fail_reason is None:
            self._fail_reason = reason

    def _writer_loop(self) -> None:
        try:
            while True:
                if self._test_block_writer is not None and not self._test_block_writer.is_set():
                    # Test seam: wait until the test unblocks the writer.
                    self._test_block_writer.wait(timeout=0.05)
                    continue

                try:
                    item = self._queue.get(timeout=0.05)
                except queue.Empty:
                    self._flush_and_commit(force=False)
                    continue

                if item is None:
                    self._flush_and_commit(force=True)
                    return

                payload, frame_position = item
                with self._queued_lock:
                    self._queued_bytes = max(0, self._queued_bytes - len(payload))

                if self._test_raise_on_write:
                    raise RuntimeError("injected writer failure")

                self._apply_chunk(payload, frame_position)
                self._flush_and_commit(force=False)
        except Exception as exc:  # noqa: BLE001 - surface via append False
            self._mark_failed(f"writer exception: {exc}")
            try:
                self._flush_and_commit(force=True)
            except Exception:
                pass
        finally:
            try:
                self._close_current_segment()
            except Exception:
                pass

    def _apply_chunk(self, payload: bytes, frame_position: Optional[int]) -> None:
        if frame_position is None:
            frame_position = self._written_frames

        if frame_position > self._written_frames:
            self._write_silence(frame_position - self._written_frames)
            self._written_frames = frame_position
        elif frame_position < self._written_frames:
            overlap_frames = self._written_frames - frame_position
            overlap_bytes = overlap_frames * self._frame_bytes
            if overlap_bytes >= len(payload):
                return
            payload = payload[overlap_bytes:]
            frame_position = self._written_frames

        if not payload:
            return

        self._write_bytes(payload)
        self._written_frames = frame_position + (len(payload) // self._frame_bytes)

    def _write_silence(self, frame_count: int) -> None:
        if frame_count <= 0:
            return
        max_chunk_frames = max(1, MAX_SILENCE_CHUNK_BYTES // self._frame_bytes)
        remaining = frame_count
        while remaining > 0:
            chunk_frames = min(remaining, max_chunk_frames)
            self._write_bytes(b"\x00" * (chunk_frames * self._frame_bytes))
            remaining -= chunk_frames

    def _write_bytes(self, payload: bytes) -> None:
        offset = 0
        while offset < len(payload):
            self._ensure_segment_open()
            remaining_capacity = self._segment_bytes - self._current_segment_bytes
            if remaining_capacity <= 0:
                self._roll_segment()
                continue
            take = min(len(payload) - offset, remaining_capacity)
            # Keep frame alignment inside a segment.
            take -= take % self._frame_bytes
            if take <= 0:
                self._roll_segment()
                continue
            view = payload[offset : offset + take]
            self._current_handle.write(view)
            self._current_segment_bytes += take
            offset += take
            if self._current_segment_bytes >= self._segment_bytes:
                self._roll_segment()

    def _ensure_segment_open(self) -> None:
        if self._current_handle is not None:
            return
        name = f"{self._track_name}_{self._segment_index:04d}.pcm.part"
        path = self._session_dir / name
        self._current_handle = open(path, "ab")
        self._current_segment_name = name
        self._current_segment_bytes = path.stat().st_size if path.exists() else 0
        if name not in self._segments:
            self._segments.append(name)

    def _roll_segment(self) -> None:
        self._flush_and_commit(force=True)
        self._close_current_segment()
        self._segment_index += 1

    def _close_current_segment(self) -> None:
        if self._current_handle is None:
            return
        try:
            self._current_handle.flush()
            os.fsync(self._current_handle.fileno())
        finally:
            self._current_handle.close()
            self._current_handle = None
            self._current_segment_name = None
            self._current_segment_bytes = 0

    def _flush_and_commit(self, *, force: bool) -> None:
        """Fsync + manifest commit at most once per flush_interval unless forced.

        ``writtenFrames`` may be ahead of ``committedFrames`` between intervals.
        Stall detection uses ``_last_commit_advance_at``, which advances only when
        committed frames actually increase (or on a forced finalization).
        """
        now = self._clock()
        with self._commit_lock:
            elapsed = now - self._last_commit_advance_at
            interval_due = elapsed >= self._flush_interval_s

        if not force and not interval_due:
            return

        if self._current_handle is not None:
            self._current_handle.flush()
            os.fsync(self._current_handle.fileno())

        with self._commit_lock:
            previous = self._committed_frames
            try:
                self._coordinator.commit_track(
                    self._track_name,
                    segments=list(self._segments),
                    committed_frames=self._written_frames,
                )
            except CaptureManifestError as exc:
                self._mark_failed(f"manifest commit failed: {exc}")
                return
            self._committed_frames = self._written_frames
            if self._committed_frames != previous or force:
                self._last_commit_advance_at = self._clock()
