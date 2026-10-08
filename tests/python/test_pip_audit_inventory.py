from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from scripts import pip_audit_inventory as audit


def _fake_pip_audit(monkeypatch, stdout: str, stderr: str = "", returncode: int = 0) -> list[list[str]]:
    calls: list[list[str]] = []

    def run(args, **_kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, returncode, stdout=stdout, stderr=stderr)

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
    calls = _fake_pip_audit(monkeypatch, json.dumps(report), returncode=1)

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

    _fake_pip_audit(monkeypatch, "", stderr="network unreachable", returncode=2)
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
    has_findings = bool(report and any(item.get("vulns") for item in report.get("dependencies", [])))
    _fake_pip_audit(
        monkeypatch,
        json.dumps(report) if report else "not json",
        returncode=1 if has_findings else 0 if report else 2,
    )
    argv = ["pip_audit_inventory.py", str(_requirements(tmp_path, "urllib3==2.5.0\n"))]
    monkeypatch.setattr(audit.sys, "argv", argv + (["--expect-findings"] if expect_findings else []))

    assert audit.main() == exit_code


def test_failed_process_and_foreign_inventory_are_not_clean(monkeypatch, tmp_path):
    requirements = _requirements(tmp_path, "URLLib3==2.8.0\nMsgPack==1.2.3\n")
    clean = {"dependencies": [
        {"name": "urllib3", "version": "2.8.0", "vulns": []},
        {"name": "msgpack", "version": "1.2.3", "vulns": []},
    ]}
    _fake_pip_audit(monkeypatch, json.dumps(clean), returncode=2)
    assert audit.audit_requirements(requirements) is None

    unrelated = {"dependencies": [{"name": "idna", "version": "3.10", "vulns": []}]}
    _fake_pip_audit(monkeypatch, json.dumps(unrelated))
    assert audit.audit_requirements(requirements) is None

    wrong_version = {"dependencies": [
        {"name": "urllib3", "version": "2.5.0", "vulns": []},
        {"name": "msgpack", "version": "1.2.3", "vulns": []},
    ]}
    _fake_pip_audit(monkeypatch, json.dumps(wrong_version))
    assert audit.audit_requirements(requirements) is None

    _fake_pip_audit(monkeypatch, json.dumps(clean), returncode=1)
    assert audit.audit_requirements(requirements) is None

    normalized = {"dependencies": [
        {"name": "msgpack", "version": "1.2.3", "vulns": []},
        {"name": "urllib3", "version": "2.8.0+cu126", "vulns": []},
    ]}
    _fake_pip_audit(monkeypatch, json.dumps(normalized))
    assert audit.audit_requirements(requirements) == []


def test_local_version_labels_are_stripped_for_advisory_matching():
    assert audit.strip_local_version("2.13.0+cu126") == "2.13.0"
    assert audit.strip_local_version("4.0.7") == "4.0.7"
