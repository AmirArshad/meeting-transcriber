from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from scripts import pip_audit_inventory as audit


def _fake_pip_audit(monkeypatch, stdout: str, stderr: str = "") -> list[list[str]]:
    calls: list[list[str]] = []

    def run(args, **_kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, 1, stdout=stdout, stderr=stderr)

    monkeypatch.setattr(audit.subprocess, "run", run)
    return calls


def _requirements(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "requirements.txt"
    path.write_text(text, encoding="utf-8")
    return path


def test_findings_are_deduplicated_and_reported(monkeypatch, tmp_path):
    vuln = {"id": "PYSEC-2026-4175", "fix_versions": ["2.8.0"]}
    report = {"dependencies": [
        {"name": "urllib3", "version": "2.7.0", "vulns": [vuln, vuln]},
        {"name": "msgpack", "version": "1.2.3", "vulns": []},
    ]}
    calls = _fake_pip_audit(monkeypatch, json.dumps(report))

    findings = audit.audit_requirements(_requirements(tmp_path, "urllib3==2.7.0\nmsgpack==1.2.3\n"), tmp_path / "r.json")

    assert findings == [("urllib3", "2.7.0", "PYSEC-2026-4175", ["2.8.0"])]
    assert "--no-deps" in calls[0] and "--disable-pip" in calls[0]
    assert json.loads((tmp_path / "r.json").read_text(encoding="utf-8")) == report


@pytest.mark.parametrize("text", ["", "# only a comment\n", "torch>=2.13\n"])
def test_empty_or_loose_inputs_are_not_reported_clean(monkeypatch, tmp_path, text):
    calls = _fake_pip_audit(monkeypatch, json.dumps({"dependencies": []}))

    assert audit.audit_requirements(_requirements(tmp_path, text)) is None
    assert calls == []


def test_missing_report_or_skipped_pins_is_an_audit_failure(monkeypatch, tmp_path):
    requirements = _requirements(tmp_path, "urllib3==2.8.0\nmsgpack==1.2.3\n")

    _fake_pip_audit(monkeypatch, "", stderr="network unreachable")
    assert audit.audit_requirements(requirements) is None

    skipped = {"dependencies": [
        {"name": "urllib3", "version": "2.8.0", "vulns": []},
        {"name": "msgpack", "skip_reason": "Dependency not found on PyPI"},
    ]}
    _fake_pip_audit(monkeypatch, json.dumps(skipped))
    assert audit.audit_requirements(requirements) is None


@pytest.mark.parametrize(
    ("report", "expect_findings", "exit_code"),
    [
        ({"dependencies": [{"name": "urllib3", "version": "2.5.0", "vulns": [{"id": "X"}]}]}, False, 1),
        ({"dependencies": [{"name": "urllib3", "version": "2.5.0", "vulns": []}]}, False, 0),
        ({"dependencies": [{"name": "urllib3", "version": "2.5.0", "vulns": [{"id": "X"}]}]}, True, 0),
        ({"dependencies": [{"name": "urllib3", "version": "2.5.0", "vulns": []}]}, True, 1),
        (None, True, audit.AUDIT_FAILED),
    ],
)
def test_exit_codes_keep_canary_and_tool_failures_distinct(monkeypatch, tmp_path, report, expect_findings, exit_code):
    _fake_pip_audit(monkeypatch, json.dumps(report) if report else "not json")
    argv = ["pip_audit_inventory.py", str(_requirements(tmp_path, "urllib3==2.5.0\n"))]
    monkeypatch.setattr(audit.sys, "argv", argv + (["--expect-findings"] if expect_findings else []))

    assert audit.main() == exit_code


def test_local_version_labels_are_stripped_for_advisory_matching():
    assert audit.strip_local_version("2.13.0+cu126") == "2.13.0"
    assert audit.strip_local_version("4.0.7") == "4.0.7"
