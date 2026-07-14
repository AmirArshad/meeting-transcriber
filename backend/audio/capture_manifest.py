"""Versioned atomic capture-session manifests for durable track spools.

Schema version 1 stores explicit UTC ``startedAtIso`` alongside
``startedAtMonotonicNs``. Session directories are ``{output_stem}.capture`` and
must never be scan-imported as meeting audio.
"""

from __future__ import annotations

import json
import os
import re
import shutil
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
VALID_PROCESSING_PROFILES = frozenset({"windows-v1", "macos-v1"})
_SAFE_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+\.pcm\.part$")
_SAFE_RELATIVE_FILE_RE = re.compile(r"^[A-Za-z0-9._-]+$")
_WINDOWS_RESERVED_STEM_RE = re.compile(
    r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)",
    re.IGNORECASE,
)
_REQUIRED_TOP_LEVEL = (
    "schemaVersion",
    "state",
    "outputStem",
    "startedAtMonotonicNs",
    "startedAtIso",
    "tracks",
)
_REQUIRED_TRACK_FIELDS = (
    "sampleRate",
    "channels",
    "dtype",
    "committedFrames",
    "segments",
)


class CaptureManifestError(ValueError):
    """Invalid capture manifest mutation or payload."""


def capture_session_dir_for_output(output_path: PathLike) -> Path:
    output = Path(output_path)
    return output.with_name(f"{output.stem}{CAPTURE_DIR_SUFFIX}")


def discard_capture_session(session_dir: PathLike) -> None:
    """Best-effort removal of a capture directory that never became recoverable.

    Used after a failed recording start so empty/partial ``*.capture`` dirs are
    not later offered as interrupted-recording recovery candidates.
    Caller must close spool handles and release ``session.lock`` first.
    """
    root = Path(session_dir)
    if not root.exists():
        return
    shutil.rmtree(root, ignore_errors=True)


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


def _validate_track_dict(name: str, track: Any) -> Dict[str, Any]:
    if not isinstance(name, str) or not name:
        raise CaptureManifestError(f"Invalid track name: {name!r}")
    if not isinstance(track, dict):
        raise CaptureManifestError(f"Track {name!r} must be an object")
    for field in _REQUIRED_TRACK_FIELDS:
        if field not in track:
            raise CaptureManifestError(f"Track {name!r} missing field: {field}")
    if not isinstance(track["sampleRate"], int) or track["sampleRate"] <= 0:
        raise CaptureManifestError(f"Track {name!r} has invalid sampleRate")
    if not isinstance(track["channels"], int) or track["channels"] <= 0:
        raise CaptureManifestError(f"Track {name!r} has invalid channels")
    _normalize_dtype(track["dtype"])
    _validate_frame_count(track["committedFrames"], field_name="committedFrames")
    segments = track["segments"]
    if not isinstance(segments, list):
        raise CaptureManifestError(f"Track {name!r} segments must be a list")
    for item in segments:
        _validate_segment_name(item)
    if "firstFrameMonotonicNs" in track and track["firstFrameMonotonicNs"] is not None:
        _validate_frame_count(
            track["firstFrameMonotonicNs"],
            field_name="firstFrameMonotonicNs",
        )
    return track


def validate_manifest_data(data: Any) -> Dict[str, Any]:
    """Validate a loaded manifest payload (used by open/reload and Task 10 discovery)."""
    if not isinstance(data, dict):
        raise CaptureManifestError("Capture manifest must be a JSON object")
    for field in _REQUIRED_TOP_LEVEL:
        if field not in data:
            raise CaptureManifestError(f"Missing capture manifest field: {field}")
    if data.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise CaptureManifestError(
            f"Unsupported capture manifest schemaVersion: {data.get('schemaVersion')!r}"
        )
    if data["state"] not in VALID_STATES:
        raise CaptureManifestError(f"Invalid capture state: {data['state']!r}")
    if not isinstance(data["outputStem"], str) or not data["outputStem"]:
        raise CaptureManifestError("outputStem must be a non-empty string")
    stem = data["outputStem"]
    if (
        os.path.isabs(stem)
        or "/" in stem
        or "\\" in stem
        or ".." in stem
        or not _SAFE_RELATIVE_FILE_RE.match(stem)
    ):
        raise CaptureManifestError(f"Unsafe outputStem: {stem!r}")
    if _WINDOWS_RESERVED_STEM_RE.match(stem):
        raise CaptureManifestError(f"Unsafe outputStem (Windows reserved): {stem!r}")
    _validate_frame_count(data["startedAtMonotonicNs"], field_name="startedAtMonotonicNs")
    # Malformed ISO is discovery-safe as null via validate_started_at_iso; keep the
    # raw string in the payload so recovery can report it without blocking open.
    if not isinstance(data["startedAtIso"], str):
        raise CaptureManifestError("startedAtIso must be a string")
    tracks = data["tracks"]
    if not isinstance(tracks, dict):
        raise CaptureManifestError("tracks must be an object")
    for name, track in tracks.items():
        _validate_track_dict(name, track)
    if "processingProfile" in data and data["processingProfile"] is not None:
        if data["processingProfile"] not in VALID_PROCESSING_PROFILES:
            raise CaptureManifestError(
                f"Invalid processingProfile: {data['processingProfile']!r}"
            )
    if "finalRelativePath" in data and data["finalRelativePath"] is not None:
        rel = data["finalRelativePath"]
        if not isinstance(rel, str) or not rel or "/" in rel or "\\" in rel or ".." in rel:
            raise CaptureManifestError(f"Unsafe finalRelativePath: {rel!r}")
        if not _SAFE_RELATIVE_FILE_RE.match(rel):
            raise CaptureManifestError(f"Invalid finalRelativePath: {rel!r}")
    if "mix" in data and data["mix"] is not None:
        mix = data["mix"]
        if not isinstance(mix, dict):
            raise CaptureManifestError("mix must be an object")
        for key in ("micVolume", "desktopVolume", "micBoost"):
            if key in mix and not isinstance(mix[key], (int, float)):
                raise CaptureManifestError(f"mix.{key} must be a number")
    if "alignment" in data and data["alignment"] is not None:
        alignment = data["alignment"]
        if not isinstance(alignment, dict):
            raise CaptureManifestError("alignment must be an object")
        for key in (
            "desktopTrimFrames",
            "desktopLeadingPadFrames",
            "micLeadingPadFrames",
        ):
            if key in alignment and alignment[key] is not None:
                _validate_frame_count(alignment[key], field_name=key)
    if "includeDesktop" in data and data["includeDesktop"] is not None:
        if not isinstance(data["includeDesktop"], bool):
            raise CaptureManifestError("includeDesktop must be a bool")
    return data


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

        lock: Optional[FileLock] = None
        try:
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
        except Exception:
            if lock is not None:
                try:
                    lock.release()
                except Exception:
                    pass
            shutil.rmtree(session_dir, ignore_errors=True)
            raise

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
            validate_manifest_data(data)
        except Exception:
            try:
                lock.release()
            except Exception:
                pass
            raise

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

    def set_processing_profile(self, profile: str) -> None:
        with self._thread_lock:
            self._ensure_open()
            if profile not in VALID_PROCESSING_PROFILES:
                raise CaptureManifestError(f"Invalid processingProfile: {profile!r}")
            self._data["processingProfile"] = profile
            self._write_atomic_unlocked()

    def set_mix_params(
        self,
        *,
        mic_volume: float = 1.0,
        desktop_volume: float = 1.0,
        mic_boost: float = 2.0,
    ) -> None:
        with self._thread_lock:
            self._ensure_open()
            self._data["mix"] = {
                "micVolume": float(mic_volume),
                "desktopVolume": float(desktop_volume),
                "micBoost": float(mic_boost),
            }
            self._write_atomic_unlocked()

    def set_alignment(
        self,
        *,
        desktop_trim_frames: int = 0,
        desktop_leading_pad_frames: int = 0,
        mic_leading_pad_frames: int = 0,
    ) -> None:
        with self._thread_lock:
            self._ensure_open()
            self._data["alignment"] = {
                "desktopTrimFrames": _validate_frame_count(
                    int(desktop_trim_frames), field_name="desktopTrimFrames"
                ),
                "desktopLeadingPadFrames": _validate_frame_count(
                    int(desktop_leading_pad_frames),
                    field_name="desktopLeadingPadFrames",
                ),
                "micLeadingPadFrames": _validate_frame_count(
                    int(mic_leading_pad_frames), field_name="micLeadingPadFrames"
                ),
            }
            self._write_atomic_unlocked()

    def set_include_desktop(self, include: bool) -> None:
        with self._thread_lock:
            self._ensure_open()
            self._data["includeDesktop"] = bool(include)
            self._write_atomic_unlocked()

    def set_final_relative_path(self, relative_path: str) -> None:
        with self._thread_lock:
            self._ensure_open()
            if (
                not isinstance(relative_path, str)
                or not relative_path
                or "/" in relative_path
                or "\\" in relative_path
                or ".." in relative_path
            ):
                raise CaptureManifestError(f"Unsafe finalRelativePath: {relative_path!r}")
            if not _SAFE_RELATIVE_FILE_RE.match(relative_path):
                raise CaptureManifestError(f"Invalid finalRelativePath: {relative_path!r}")
            self._data["finalRelativePath"] = relative_path
            self._write_atomic_unlocked()

    def get_track(self, name: str) -> Dict[str, Any]:
        with self._thread_lock:
            track = self._data["tracks"].get(name)
            if track is None:
                raise CaptureManifestError(f"Unknown track: {name}")
            return dict(track)

    def has_track(self, name: str) -> bool:
        with self._thread_lock:
            return name in self._data["tracks"]

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
