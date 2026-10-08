#!/usr/bin/env python3
"""Prove a requirements-*-build.txt file is a closed, exactly pinned set.

prepare-resources installs build requirements with the pip resolver enabled,
so an unpinned transitive dependency would silently enter the packaged app.
This resolves the file for its target platform (any host can check any
target) and fails when the resolved set differs from the pinned set.

  python scripts/check-build-requirements-closure.py [windows|macos|linux ...]
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {
    "windows": ["win_amd64"],
    "macos": ["macosx_14_0_arm64"],
    "linux": ["manylinux_2_28_x86_64", "manylinux_2_17_x86_64", "manylinux2014_x86_64", "linux_x86_64"],
}


TARGET_SYS_PLATFORM = {"windows": "win32", "macos": "darwin", "linux": "linux"}
# pip evaluates environment markers against the running host, not --platform.
# These packages enter only through host-OS markers (click: colorama on Windows).
HOST_MARKER_ONLY = {"win32": {"colorama"}}


def canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def read_pins(path: Path) -> dict[str, str]:
    pins = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.\-]+)==([^\s;]+)", line)
        if not match:
            raise SystemExit(f"{path.name}: not an exact pin: {raw!r}")
        pins[canonical(match.group(1))] = match.group(2)
    return pins


def resolve(path: Path, platforms: list[str]) -> dict[str, str]:
    with tempfile.TemporaryDirectory() as tmp:
        report = Path(tmp) / "report.json"
        args = [sys.executable, "-m", "pip", "install", "--dry-run", "--quiet", "--ignore-installed",
                "--only-binary=:all:", "--python-version", "3.11", "--implementation", "cp", "--abi", "cp311",
                "--target", str(Path(tmp) / "target"), "--report", str(report), "-r", str(path)]
        for platform in platforms:
            args += ["--platform", platform]
        result = subprocess.run(args, capture_output=True, text=True)
        if result.returncode != 0:
            print(result.stdout[-3000:], result.stderr[-3000:], sep="\n", file=sys.stderr)
            raise SystemExit(f"{path.name}: pip could not resolve the pinned set (this is a failure, not a clean result).")
        data = json.loads(report.read_text(encoding="utf-8"))
    return {canonical(item["metadata"]["name"]): item["metadata"]["version"] for item in data["install"]}


def compare(pins: dict[str, str], resolved: dict[str, str]) -> list[str]:
    problems = []
    for name in sorted(set(resolved) - set(pins)):
        problems.append(f"unpinned transitive dependency {name}=={resolved[name]}")
    for name in sorted(set(pins) - set(resolved)):
        problems.append(f"pinned {name}=={pins[name]} is not part of the resolved closure")
    for name in sorted(set(pins) & set(resolved)):
        if pins[name] != resolved[name]:
            problems.append(f"{name} pinned {pins[name]} but resolved {resolved[name]}")
    return problems


def main(argv: list[str]) -> int:
    names = argv or list(TARGETS)
    failed = False
    for name in names:
        if name not in TARGETS:
            raise SystemExit(f"Unknown target {name}; expected one of {', '.join(TARGETS)}.")
        path = ROOT / f"requirements-{name}-build.txt"
        pins = read_pins(path)
        resolved = resolve(path, TARGETS[name])
        if sys.platform != TARGET_SYS_PLATFORM[name]:
            ignored = sorted((HOST_MARKER_ONLY.get(sys.platform, set()) & set(resolved)) - set(pins))
            for package in ignored:
                resolved.pop(package)
            print(f"note {path.name}: cross-host check from {sys.platform}; markers use the host"
                  + (f", ignoring {', '.join(ignored)}" if ignored else ""))
        problems = compare(pins, resolved)
        status = "FAIL" if problems else "ok"
        print(f"{status:4} {path.name}")
        for problem in problems:
            print(f"     {problem}")
        failed = failed or bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
