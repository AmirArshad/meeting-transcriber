#!/usr/bin/env python3
"""Audit an exact-pinned requirements file with pip-audit, keeping tool
failures distinct from a clean result.

    python scripts/pip_audit_inventory.py <requirements.txt> [--report out.json] [--expect-findings]

Exit codes: 0 clean, 1 findings, 2 the audit did not run, the process
failed, or the report is not the exact normalized name/version inventory.
With --expect-findings (canary mode for intentionally vulnerable fixtures)
the meaning flips: 0 when findings were reported, 1 when the audit came
back clean.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

AUDIT_FAILED = 2


def strip_local_version(version: str) -> str:
    """Advisory databases key on public versions; "2.11.0+cu126" would match nothing."""
    return version.split("+", 1)[0]


def normalize_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).strip().lower()


def pin_identity(line: str) -> tuple[str, str]:
    name, version = line.split("==", 1)
    name = re.sub(r"\[.*\]", "", name).strip()
    version = version.split(";", 1)[0].strip()
    return normalize_name(name), strip_local_version(version)


def dependency_identity(dependency: dict) -> tuple[str, str] | None:
    name = dependency.get("name")
    version = dependency.get("version")
    if not name or version is None or version == "":
        return None
    return normalize_name(str(name)), strip_local_version(str(version))


def audit_requirements(requirements: Path, report: Path | None = None):
    """Return a list of (name, version, advisory id, fix versions), or None if the audit did not run."""
    lines = [line.strip() for line in requirements.read_text(encoding="utf-8").splitlines()]
    pins = [line for line in lines if line and not line.startswith("#")]
    if not pins:
        print(f"{requirements} has no requirements; refusing to report an empty audit as clean.", file=sys.stderr)
        return None
    loose = [line for line in pins if "==" not in line]
    if loose:
        print(f"{requirements} has non-exact requirements: {', '.join(loose)}", file=sys.stderr)
        return None

    audit = subprocess.run(
        [sys.executable, "-m", "pip_audit", "--no-deps", "--disable-pip", "-r", str(requirements),
         "--format", "json", "--progress-spinner", "off"],
        capture_output=True, text=True,
    )
    if report is not None:
        report.write_text(audit.stdout, encoding="utf-8")
    if audit.returncode not in (0, 1):
        print(audit.stderr[-4000:], file=sys.stderr)
        print(f"pip-audit exited {audit.returncode}; this is not a clean audit.", file=sys.stderr)
        return None
    try:
        dependencies = json.loads(audit.stdout).get("dependencies", [])
    except json.JSONDecodeError:
        print(audit.stderr[-4000:], file=sys.stderr)
        print("pip-audit did not produce a report; this is not a clean audit.", file=sys.stderr)
        return None
    expected = sorted(pin_identity(pin) for pin in pins)
    audited = []
    for dependency in dependencies:
        if dependency.get("skip_reason"):
            print(f"pip-audit skipped {dependency.get('name')}: {dependency.get('skip_reason')}", file=sys.stderr)
            continue
        identity = dependency_identity(dependency)
        if identity is not None:
            audited.append(identity)
    audited.sort()
    if audited != expected:
        print(
            f"pip-audit report does not match the pinned inventory ({len(audited)} entries for {len(expected)} pins); this is not a clean audit.",
            file=sys.stderr,
        )
        return None
    findings = {}
    for dependency in dependencies:
        for vuln in dependency.get("vulns", []):
            key = (dependency["name"], dependency["version"], vuln["id"])
            findings[key] = (*key, vuln.get("fix_versions") or [])
    reported = sorted(findings.values())
    if audit.returncode == 1 and not reported:
        print("pip-audit exited 1 without reporting a vulnerability; this is not a clean audit.", file=sys.stderr)
        return None
    return reported


def print_findings(label: str, findings) -> None:
    print(f"{label}: {len(findings)} pip-audit finding(s)")
    for name, version, advisory, fixes in findings:
        print(f"  {name} {version} {advisory} fix: {', '.join(fixes) or 'none listed'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("requirements", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--expect-findings", action="store_true")
    args = parser.parse_args()

    findings = audit_requirements(args.requirements, args.report)
    if findings is None:
        return AUDIT_FAILED
    print_findings(str(args.requirements), findings)
    if args.expect_findings:
        if not findings:
            print("Canary fixture audited clean; the audit pipeline is not detecting known advisories.", file=sys.stderr)
        return 0 if findings else 1
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
