#!/usr/bin/env python3
"""Recursively syntax-check every .py file under backend/ via compileall.

Replaces hardcoded CI py_compile globs so new packages (meetings/,
summaries/, diarization/, common/, …) cannot silently drift out of coverage.
"""

from __future__ import annotations

import compileall
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_ROOT = ROOT / "backend"

REQUIRED_RELATIVE_DIRS = (
    "backend/audio",
    "backend/transcription",
    "backend/meetings",
    "backend/summaries",
    "backend/diarization",
    "backend/common",
)


def main() -> int:
    if not BACKEND_ROOT.is_dir():
        print(f"Python syntax check expected directory missing: backend", file=sys.stderr)
        return 1

    for relative_dir in REQUIRED_RELATIVE_DIRS:
        absolute_dir = ROOT / relative_dir
        if not absolute_dir.is_dir():
            print(
                f"Python syntax check expected directory missing: {relative_dir}",
                file=sys.stderr,
            )
            return 1

    # quiet=1: only show errors; force=True: recompile even if .pyc looks fresh
    ok = compileall.compile_dir(
        str(BACKEND_ROOT),
        quiet=1,
        force=True,
        workers=0,
    )
    if not ok:
        print(f"python -m compileall failed for {BACKEND_ROOT.relative_to(ROOT)}", file=sys.stderr)
        return 1

    print(f"Checked Python syntax under {BACKEND_ROOT.relative_to(ROOT)}/ (recursive)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
