"""Download pinned Hugging Face summary model artifacts.

This wrapper lets the Electron main process use Hugging Face's native
``huggingface_hub``/``hf_xet`` download path for large GGUF files while keeping
the app's catalog pinning and checksum verification in JavaScript.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Any, Dict


def _emit(event: Dict[str, Any]) -> None:
    print(json.dumps(event, ensure_ascii=True), flush=True)


def _safe_error(exc: BaseException) -> str:
    cleaned = re.sub(r"hf_[A-Za-z0-9_-]+", "[redacted-token]", str(exc or ""))
    cleaned = re.sub(r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted-token]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"(Authorization:\s*token\s+)[A-Za-z0-9._~+/=-]+", r"\1[redacted-token]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"((?:access_)?token=|api_key=)[^&#\s]+", r"\1[redacted-token]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"(X-Api-Key:\s*)[^\r\n\s]+", r"\1[redacted-token]", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"(https?://)[^/?#@\s]+@", r"\1[redacted]@", cleaned, flags=re.IGNORECASE)
    return " ".join(cleaned.split())[:500]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_path_inside(path: Path, directory: Path) -> bool:
    if path == directory:
        return True
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        return False


def download_hugging_face_file(
    *,
    repo: str,
    revision: str,
    filename: str,
    destination: str,
    destination_root: str,
    expected_size: int = 0,
    expected_sha256: str = "",
    cache_root: str | None = None,
) -> Dict[str, Any]:
    if "/" in filename or "\\" in filename or Path(filename).name != filename or any(part in {"", ".", ".."} for part in Path(filename).parts):
        raise ValueError("Hugging Face artifact filename must be a safe basename.")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256 or ""):
        raise ValueError("Pinned Hugging Face artifact checksum is required.")

    destination_path = Path(destination).resolve()
    destination_root_path = Path(destination_root).resolve()
    if not _is_path_inside(destination_path, destination_root_path):
        raise ValueError("Hugging Face artifact destination is outside the expected cache directory.")

    destination_path.parent.mkdir(parents=True, exist_ok=True)
    download_dir = Path(f"{destination_path}.hf-download").resolve()
    if not _is_path_inside(download_dir, destination_root_path):
        raise ValueError("Hugging Face artifact temporary download directory is outside the expected cache directory.")

    from huggingface_hub import hf_hub_download  # type: ignore[import-not-found]

    if download_dir.exists():
        shutil.rmtree(download_dir, ignore_errors=True)
    download_dir.mkdir(parents=True, exist_ok=True)

    _emit({
        "type": "progress",
        "phase": "downloading",
        "message": "Downloading local summary model through Hugging Face accelerated transfer.",
        "downloadedBytes": 0,
        "totalBytes": expected_size or None,
        "percent": 0,
    })

    try:
        downloaded_path = hf_hub_download(
            repo_id=repo,
            filename=filename,
            revision=revision,
            local_dir=str(download_dir),
            token=False,
        )
        source_path = Path(downloaded_path).resolve()
        if not _is_path_inside(source_path, download_dir):
            raise RuntimeError("Hugging Face download resolved outside the temporary download directory.")
        if source_path.name != filename:
            raise RuntimeError("Hugging Face download did not produce the expected filename.")
        if not source_path.exists() or not source_path.is_file():
            raise RuntimeError("Hugging Face download did not produce the expected file.")
        size = source_path.stat().st_size
        if expected_size and size > int(expected_size * 1.1):
            raise RuntimeError("Hugging Face download is larger than the pinned expected size.")
        actual_sha256 = _sha256_file(source_path)
        if actual_sha256.lower() != expected_sha256.lower():
            raise RuntimeError("Hugging Face download checksum does not match the pinned checksum.")
        if destination_path.exists():
            destination_path.unlink()
        shutil.move(str(source_path), str(destination_path))
    finally:
        shutil.rmtree(download_dir, ignore_errors=True)

    final_size = destination_path.stat().st_size
    _emit({
        "type": "progress",
        "phase": "downloaded",
        "message": "Downloaded local summary model through Hugging Face accelerated transfer.",
        "downloadedBytes": final_size,
        "totalBytes": expected_size or final_size,
        "percent": 100,
    })
    return {"status": "ok", "path": str(destination_path), "sizeBytes": final_size}


def main() -> None:
    parser = argparse.ArgumentParser(description="Download a pinned Hugging Face summary model artifact")
    parser.add_argument("--repo", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--filename", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--destination-root", required=True)
    parser.add_argument("--expected-size", type=int, default=0)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--cache-root")
    args = parser.parse_args()

    if args.cache_root:
        cache_root = Path(args.cache_root).resolve()
        cache_root.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(cache_root))
        os.environ.setdefault("HF_HUB_CACHE", str(cache_root / "hub"))
        os.environ.setdefault("HF_XET_CACHE", str(cache_root / "xet"))

    os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("DO_NOT_TRACK", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

    try:
        result = download_hugging_face_file(
            repo=args.repo,
            revision=args.revision,
            filename=args.filename,
            destination=args.destination,
            destination_root=args.destination_root,
            expected_size=args.expected_size,
            expected_sha256=args.expected_sha256,
            cache_root=args.cache_root,
        )
        _emit({"type": "result", **result})
    except Exception as exc:
        _emit({"type": "error", "message": _safe_error(exc)})
        print(f"ERROR: {_safe_error(exc)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
