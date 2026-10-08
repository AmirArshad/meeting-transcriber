#!/usr/bin/env python3
"""Audit an exact-pinned requirements file with pip-audit, keeping tool
failures distinct from a clean result.

    python scripts/pip_audit_inventory.py <requirements.txt> [--report out.json] [--expect-findings]

Exit codes: 0 clean, 1 findings, 2 the audit did not run or produced no
report. With --expect-findings (canary mode for intentionally vulnerable
fixtures) the meaning flips: 0 when findings were reported, 1 when the audit
came back clean.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

AUDIT_FAILED = 2


def strip_local_version(version: str) -> str:
    """Advisory databases key on public versions; "2.11.0+cu126" would match nothing."""
    return version.split("+", 1)[0]


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
    try:
        dependencies = json.loads(audit.stdout).get("dependencies", [])
    except json.JSONDecodeError:
        print(audit.stderr[-4000:], file=sys.stderr)
        print("pip-audit did not produce a report; this is not a clean audit.", file=sys.stderr)
        return None
    audited = {dependency.get("name", "").lower() for dependency in dependencies if not dependency.get("skip_reason")}
    if len(audited) < len(pins):
        skipped = [dependency for dependency in dependencies if dependency.get("skip_reason")]
        for dependency in skipped:
            print(f"pip-audit skipped {dependency.get('name')}: {dependency.get('skip_reason')}", file=sys.stderr)
        print(f"pip-audit audited {len(audited)} of {len(pins)} pins; this is not a clean audit.", file=sys.stderr)
        return None
    findings = {}
    for dependency in dependencies:
        for vuln in dependency.get("vulns", []):
            key = (dependency["name"], dependency["version"], vuln["id"])
            findings[key] = (*key, vuln.get("fix_versions") or [])
    return sorted(findings.values())


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
