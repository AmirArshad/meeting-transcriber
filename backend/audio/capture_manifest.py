"""Versioned atomic capture-session manifests for durable track spools.

Schema version 1 stores explicit UTC ``startedAtIso`` alongside
``startedAtMonotonicNs``. Session directories are ``{output_stem}.capture`` and
must never be scan-imported as meeting audio.
"""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from filelock import FileLock, Timeout

PathLike = Union[str, Path]

MANIFEST_SCHEMA_VERSION = 1
MANIFEST_FILENAME = "manifest.json"
SESSION_LOCK_FILENAME = "session.lock"
CAPTURE_DIR_SUFFIX = ".capture"
VALID_STATES = frozenset({"recording", "finalizing", "complete", "error"})
SUPPORTED_DTYPES = frozenset({"<i2", "<f4"})
_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+\.pcm\.part$")


class CaptureManifestError(ValueError):
    """Invalid capture manifest mutation or payload."""


def capture_session_dir_for_output(output_path: PathLike) -> Path:
    output = Path(output_path)
    return output.with_name(f"{output.stem}{CAPTURE_DIR_SUFFIX}")


def _normalize_dtype(dtype: str) -> str:
    raw = str(dtype).strip()
    aliases = {
        "i2": "<i2",
        "int16": "<i2",
        "f4": "<f4",
        "float32": "<f4",
        "<i2": "<i2",
        "<f4": "<f4",
    }
    normalized = aliases.get(raw, raw)
    if normalized not in SUPPORTED_DTYPES:
        raise CaptureManifestError(f"Unsupported capture dtype: {dtype!r}")
    return normalized


def _validate_segment_name(name: str) -> str:
    if not isinstance(name, str) or not name:
        raise CaptureManifestError("Segment names must be non-empty relative strings")
    if os.path.isabs(name) or "\\" in name or "/" in name or ".." in name:
        raise CaptureManifestError(f"Unsafe capture segment path: {name!r}")
    if not _SAFE_SEGMENT_RE.match(name):
        raise CaptureManifestError(f"Invalid capture segment name: {name!r}")
    return name


def _validate_frame_count(value: Any, *, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CaptureManifestError(f"{field_name} must be an integral int")
    if value < 0:
        raise CaptureManifestError(f"{field_name} must be non-negative")
    return value


def validate_started_at_iso(value: Any) -> Optional[str]:
    """Return a normalized ISO string or None when malformed (discovery-safe)."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    # Accept trailing Z or explicit offset; do not invent wall time from stems.
    if not re.match(
        r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$",
        text,
    ):
        return None
    return text


class CaptureManifestCoordinator:
    """Process-owned capture manifest with thread-serialized RMW commits.

    Holds ``session.lock`` for the recorder process's capture/finalization
    lifetime. Recovery should call ``open_existing(..., lock_timeout=0)`` and
    skip on ``filelock.Timeout``.
    """

    def __init__(
        self,
        session_dir: Path,
        data: Dict[str, Any],
        *,
        file_lock: FileLock,
    ) -> None:
        self._session_dir = Path(session_dir)
        self._data = data
        self._file_lock = file_lock
        self._thread_lock = threading.RLock()
        self._closed = False

    @property
    def session_dir(self) -> Path:
        return self._session_dir

    @property
    def started_at_iso(self) -> Optional[str]:
        return validate_started_at_iso(self._data.get("startedAtIso"))

    @property
    def started_at_monotonic_ns(self) -> int:
        return int(self._data["startedAtMonotonicNs"])

    @property
    def state(self) -> str:
        return str(self._data["state"])

    @classmethod
    def create(
        cls,
        output_path: PathLike,
        started_at_ns: int,
        started_at_iso: str,
    ) -> "CaptureManifestCoordinator":
        output = Path(output_path)
        session_dir = capture_session_dir_for_output(output)
        session_dir.mkdir(parents=True, exist_ok=False)

        iso = validate_started_at_iso(started_at_iso)
        if iso is None:
            raise CaptureManifestError(f"Invalid startedAtIso: {started_at_iso!r}")
        started_ns = _validate_frame_count(started_at_ns, field_name="startedAtMonotonicNs")

        data = {
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "state": "recording",
            "outputStem": output.stem,
            "startedAtMonotonicNs": started_ns,
            "startedAtIso": iso,
            "tracks": {},
        }
        lock = FileLock(str(session_dir / SESSION_LOCK_FILENAME))
        lock.acquire()
        coordinator = cls(session_dir, data, file_lock=lock)
        coordinator._write_atomic_unlocked()
        return coordinator

    @classmethod
    def open_existing(
        cls,
        session_dir: PathLike,
        *,
        lock_timeout: Optional[float] = None,
    ) -> "CaptureManifestCoordinator":
        session_path = Path(session_dir)
        manifest_path = session_path / MANIFEST_FILENAME
        if not manifest_path.is_file():
            raise CaptureManifestError(f"Missing capture manifest: {manifest_path}")

        lock = FileLock(str(session_path / SESSION_LOCK_FILENAME))
        try:
            if lock_timeout is None:
                lock.acquire()
            else:
                lock.acquire(timeout=lock_timeout)
        except Timeout as exc:
            raise Timeout(str(exc)) from exc

        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            lock.release()
            raise

        if data.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
            lock.release()
            raise CaptureManifestError(
                f"Unsupported capture manifest schemaVersion: {data.get('schemaVersion')!r}"
            )
        return cls(session_path, data, file_lock=lock)

    def add_track(
        self,
        name: str,
        sample_rate: int,
        channels: int,
        dtype: str,
        *,
        first_frame_monotonic_ns: Optional[int] = None,
    ) -> None:
        with self._thread_lock:
            self._ensure_open()
            if not isinstance(name, str) or not name or "/" in name or "\\" in name or ".." in name:
                raise CaptureManifestError(f"Invalid track name: {name!r}")
            if name in self._data["tracks"]:
                raise CaptureManifestError(f"Track already exists: {name}")
            if not isinstance(sample_rate, int) or sample_rate <= 0:
                raise CaptureManifestError("sample_rate must be a positive int")
            if not isinstance(channels, int) or channels <= 0:
                raise CaptureManifestError("channels must be a positive int")
            normalized = _normalize_dtype(dtype)
            track = {
                "sampleRate": sample_rate,
                "channels": channels,
                "dtype": normalized,
                "firstFrameMonotonicNs": first_frame_monotonic_ns,
                "committedFrames": 0,
                "segments": [],
            }
            self._data["tracks"][name] = track
            self._write_atomic_unlocked()

    def commit_track(
        self,
        name: str,
        segments: List[str],
        committed_frames: int,
        *,
        first_frame_monotonic_ns: Optional[int] = None,
    ) -> None:
        with self._thread_lock:
            self._ensure_open()
            track = self._data["tracks"].get(name)
            if track is None:
                raise CaptureManifestError(f"Unknown track: {name}")
            safe_segments = [_validate_segment_name(item) for item in segments]
            frames = _validate_frame_count(committed_frames, field_name="committedFrames")
            track["segments"] = safe_segments
            track["committedFrames"] = frames
            if first_frame_monotonic_ns is not None:
                track["firstFrameMonotonicNs"] = _validate_frame_count(
                    first_frame_monotonic_ns,
                    field_name="firstFrameMonotonicNs",
                )
            self._write_atomic_unlocked()

    def set_state(self, state: str) -> None:
        with self._thread_lock:
            self._ensure_open()
            if state not in VALID_STATES:
                raise CaptureManifestError(f"Invalid capture state: {state!r}")
            self._data["state"] = state
            self._write_atomic_unlocked()

    def get_track(self, name: str) -> Dict[str, Any]:
        with self._thread_lock:
            track = self._data["tracks"].get(name)
            if track is None:
                raise CaptureManifestError(f"Unknown track: {name}")
            return dict(track)

    def to_dict(self) -> Dict[str, Any]:
        with self._thread_lock:
            return json.loads(json.dumps(self._data))

    def close(self) -> None:
        with self._thread_lock:
            if self._closed:
                return
            self._closed = True
            try:
                self._file_lock.release()
            except Exception:
                pass

    def _ensure_open(self) -> None:
        if self._closed:
            raise CaptureManifestError("Capture manifest coordinator is closed")

    def _write_atomic_unlocked(self) -> None:
        manifest_path = self._session_dir / MANIFEST_FILENAME
        temp_path = self._session_dir / f"{MANIFEST_FILENAME}.tmp"
        payload = json.dumps(self._data, indent=2, sort_keys=True) + "\n"
        with open(temp_path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, manifest_path)
