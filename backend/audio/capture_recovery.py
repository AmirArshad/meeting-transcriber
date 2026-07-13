"""Discover and recover interrupted capture sessions (Task 10).

CLI:
  python -m audio.capture_recovery --recordings-dir <dir> --list
  python -m audio.capture_recovery --recordings-dir <dir> --ffmpeg <path> --recover <capture-dir>

Discovery is read-only. Recovery acquires ``session.lock`` with ``timeout=0``,
marks the session ``finalizing``, and calls ``finalize_capture()``. Failure never
deletes capture files or a verified final output.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from filelock import FileLock, Timeout

from .capture_manifest import (
    CAPTURE_DIR_SUFFIX,
    MANIFEST_FILENAME,
    SESSION_LOCK_FILENAME,
    CaptureManifestError,
    validate_manifest_data,
    validate_started_at_iso,
)
from .constants import (
    FINAL_CAPTURE_PCM_NAME,
    NORMALIZED_DESKTOP_NAME,
    NORMALIZED_MIC_NAME,
)
from .streaming_post_processor import FinalizationError, finalize_capture

PathLike = Union[str, Path]


class CaptureRecoveryError(ValueError):
    """Invalid recovery path or discovery input."""


def _is_capture_dir_name(name: str) -> bool:
    return name.lower().endswith(CAPTURE_DIR_SUFFIX)


def resolve_recordings_root(recordings_dir: PathLike) -> Path:
    root = Path(recordings_dir).expanduser()
    try:
        resolved = root.resolve(strict=False)
    except OSError as exc:
        raise CaptureRecoveryError(f"Cannot resolve recordings directory: {exc}") from exc
    if not resolved.is_dir():
        raise CaptureRecoveryError(f"Recordings directory does not exist: {resolved}")
    return resolved


def resolve_capture_under_recordings(
    recordings_dir: PathLike,
    capture_dir: PathLike,
) -> Path:
    """Require a direct ``*.capture`` child under the resolved recordings root.

    Rejects symlink/junction escapes by comparing resolved parents.
    """
    root = resolve_recordings_root(recordings_dir)
    target = Path(capture_dir).expanduser()
    try:
        resolved = target.resolve(strict=False)
    except OSError as exc:
        raise CaptureRecoveryError(f"Cannot resolve capture directory: {exc}") from exc

    if not _is_capture_dir_name(resolved.name):
        raise CaptureRecoveryError(
            f"Recovery target must be a {CAPTURE_DIR_SUFFIX} directory: {resolved.name!r}"
        )
    if not resolved.is_dir():
        raise CaptureRecoveryError(f"Capture directory does not exist: {resolved}")
    if resolved.parent != root:
        raise CaptureRecoveryError(
            "Capture directory must be a direct child of the recordings root"
        )
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise CaptureRecoveryError("Capture directory escapes the recordings root") from exc
    return resolved


def _approx_duration_seconds(data: Dict[str, Any]) -> Optional[float]:
    tracks = data.get("tracks") or {}
    best: Optional[float] = None
    for track in tracks.values():
        if not isinstance(track, dict):
            continue
        try:
            frames = int(track.get("committedFrames") or 0)
            rate = int(track.get("sampleRate") or 0)
        except (TypeError, ValueError):
            continue
        if frames <= 0 or rate <= 0:
            continue
        seconds = float(frames) / float(rate)
        if best is None or seconds > best:
            best = seconds
    return best


def _approx_bytes(session_dir: Path, data: Dict[str, Any]) -> Optional[int]:
    tracks = data.get("tracks") or {}
    total = 0
    saw_any = False
    for track in tracks.values():
        if not isinstance(track, dict):
            continue
        for name in track.get("segments") or []:
            if not isinstance(name, str) or not name:
                continue
            path = session_dir / name
            try:
                if path.is_file():
                    total += path.stat().st_size
                    saw_any = True
            except OSError:
                continue
    # Include known intermediate files when present (display only).
    for name in (NORMALIZED_MIC_NAME, NORMALIZED_DESKTOP_NAME, FINAL_CAPTURE_PCM_NAME):
        path = session_dir / name
        try:
            if path.is_file():
                total += path.stat().st_size
                saw_any = True
        except OSError:
            continue
    return total if saw_any else (0 if tracks else None)


def _candidate_from_manifest(
    session_dir: Path,
    data: Dict[str, Any],
) -> Dict[str, Any]:
    return {
        "captureDir": str(session_dir),
        "outputStem": data.get("outputStem") if isinstance(data.get("outputStem"), str) else None,
        "startedAtIso": validate_started_at_iso(data.get("startedAtIso")),
        "approxDurationSeconds": _approx_duration_seconds(data),
        "approxBytes": _approx_bytes(session_dir, data),
        "state": data.get("state") if isinstance(data.get("state"), str) else None,
    }


def _try_read_manifest_readonly(session_dir: Path) -> Optional[Dict[str, Any]]:
    """Acquire session.lock with timeout=0, validate, release. Skip if locked."""
    lock_path = session_dir / SESSION_LOCK_FILENAME
    manifest_path = session_dir / MANIFEST_FILENAME
    if not manifest_path.is_file():
        return None

    lock = FileLock(str(lock_path))
    try:
        lock.acquire(timeout=0)
    except Timeout:
        return None

    try:
        raw = json.loads(manifest_path.read_text(encoding="utf-8"))
        validate_manifest_data(raw)
        return raw
    except (OSError, json.JSONDecodeError, CaptureManifestError, TypeError, ValueError):
        return None
    finally:
        try:
            lock.release()
        except Exception:
            pass


def list_interrupted_captures(recordings_dir: PathLike) -> List[Dict[str, Any]]:
    """Read-only discovery of recoverable ``*.capture`` sessions.

    Skips sessions whose ``session.lock`` cannot be acquired with ``timeout=0``.
    Orders valid candidates oldest-first by ``startedAtIso`` (nulls last).
    """
    root = resolve_recordings_root(recordings_dir)
    candidates: List[Dict[str, Any]] = []

    try:
        entries = list(root.iterdir())
    except OSError:
        return []

    for entry in entries:
        if not entry.is_dir() or not _is_capture_dir_name(entry.name):
            continue
        # Resolve each candidate; skip symlink/junction escapes.
        try:
            resolved = resolve_capture_under_recordings(root, entry)
        except CaptureRecoveryError:
            continue
        data = _try_read_manifest_readonly(resolved)
        if data is None:
            continue
        # Complete sessions with a missing directory are already cleaned; a
        # remaining complete dir is still recoverable (idempotent finalize).
        candidates.append(_candidate_from_manifest(resolved, data))

    def sort_key(item: Dict[str, Any]) -> Tuple[int, str]:
        iso = item.get("startedAtIso")
        if isinstance(iso, str) and iso:
            return (0, iso)
        return (1, item.get("captureDir") or "")

    candidates.sort(key=sort_key)
    return candidates


def recover_capture(
    recordings_dir: PathLike,
    capture_dir: PathLike,
    ffmpeg_path: str = "ffmpeg",
    *,
    progress_callback=None,
) -> Dict[str, Any]:
    """Finalize one capture directory under the recordings root.

    Never deletes capture files on failure. A verified final output path from a
    prior partial success is left untouched when finalization fails afterward.
    """
    root = resolve_recordings_root(recordings_dir)
    session_dir = resolve_capture_under_recordings(root, capture_dir)
    manifest_path = session_dir / MANIFEST_FILENAME
    if not manifest_path.is_file():
        raise CaptureRecoveryError(f"Missing capture manifest: {manifest_path}")

    # Peek outputStem without holding the lock across finalize (finalize opens it).
    try:
        peek = json.loads(manifest_path.read_text(encoding="utf-8"))
        validate_manifest_data(peek)
        stem = peek.get("outputStem")
        if not isinstance(stem, str) or not stem:
            raise CaptureRecoveryError("Capture manifest missing outputStem")
    except (OSError, json.JSONDecodeError, CaptureManifestError) as exc:
        raise CaptureRecoveryError(f"Invalid capture manifest: {exc}") from exc

    # Prefer .opus beside the recordings root (same as live recorder output_path).
    output_path = root / f"{stem}.opus"
    # Preserve an already-verified final if present (never delete on fail).
    preexisting_final: Optional[Path] = None
    for candidate in (root / f"{stem}.opus", root / f"{stem}.wav"):
        if candidate.is_file():
            preexisting_final = candidate
            break

    try:
        result = finalize_capture(
            manifest_path,
            output_path,
            ffmpeg_path=ffmpeg_path or "ffmpeg",
            progress_callback=progress_callback,
            recovered=True,
        )
    except Timeout as exc:
        raise CaptureRecoveryError(
            f"Capture session is locked (recording may still be active): {session_dir}"
        ) from exc
    except FinalizationError:
        # Failure never deletes a verified final that already existed.
        if preexisting_final is not None and not preexisting_final.is_file():
            raise CaptureRecoveryError(
                f"Finalization failed and verified output disappeared: {preexisting_final}"
            )
        raise

    return {
        "captureDir": str(session_dir),
        "audioPath": result.final_path,
        "duration": float(result.duration),
    }


def recover_captures(
    recordings_dir: PathLike,
    capture_dirs: List[PathLike],
    ffmpeg_path: str = "ffmpeg",
) -> Dict[str, Any]:
    recovered: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []
    for capture_dir in capture_dirs:
        try:
            item = recover_capture(recordings_dir, capture_dir, ffmpeg_path=ffmpeg_path)
            recovered.append(item)
        except (CaptureRecoveryError, FinalizationError, Timeout, OSError) as exc:
            code = "RECOVERY_FAILED"
            if isinstance(exc, Timeout) or "locked" in str(exc).lower():
                code = "SESSION_LOCKED"
            elif isinstance(exc, CaptureRecoveryError):
                code = "INVALID_CAPTURE"
            failed.append(
                {
                    "captureDir": str(capture_dir),
                    "code": code,
                    "message": str(exc),
                }
            )
    return {
        "success": len(failed) == 0,
        "recovered": recovered,
        "failed": failed,
    }


def _emit_json(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Interrupted capture discovery and recovery")
    parser.add_argument("--recordings-dir", required=True, help="Recordings directory")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="Path to ffmpeg executable")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--list", action="store_true", help="List recoverable captures (read-only)")
    group.add_argument(
        "--recover",
        metavar="CAPTURE_DIR",
        help="Recover one capture directory under the recordings root",
    )
    args = parser.parse_args(argv)

    try:
        if args.list:
            candidates = list_interrupted_captures(args.recordings_dir)
            _emit_json({"success": True, "candidates": candidates})
            return 0

        result = recover_captures(
            args.recordings_dir,
            [args.recover],
            ffmpeg_path=args.ffmpeg,
        )
        _emit_json(result)
        return 0 if result["success"] else 1
    except CaptureRecoveryError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        _emit_json(
            {
                "success": False,
                "recovered": [],
                "failed": [{"captureDir": args.recover, "code": "INVALID_CAPTURE", "message": str(exc)}],
            }
            if args.recover
            else {"success": False, "candidates": [], "error": str(exc)}
        )
        return 1
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        _emit_json(
            {
                "success": False,
                "recovered": [],
                "failed": [
                    {
                        "captureDir": args.recover if args.recover else None,
                        "code": "RECOVERY_FAILED",
                        "message": str(exc),
                    }
                ],
            }
            if args.recover
            else {"success": False, "candidates": [], "error": str(exc)}
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
