"""Capture-mode isolation for the macOS permission preflight.

A capture mode that does not record the microphone must never open it: the
open-test is exactly what raises the macOS microphone privacy prompt. These
tests drive ``check_permissions.main()`` directly (patching the macOS-only
probes) so the argument wiring and payload shape are pinned on any host.
"""

from __future__ import annotations

import json
import sys

import pytest

from backend import check_permissions as cp


def _run_main(monkeypatch, capsys, argv, *, platform_name="Darwin"):
    monkeypatch.setattr(cp.platform, "system", lambda: platform_name)
    monkeypatch.setattr(sys, "argv", ["check_permissions.py", *argv])
    try:
        cp.main()
    except SystemExit as exc:  # main() exits non-zero when a grant is missing
        exit_code = exc.code or 0
    else:
        exit_code = 0
    return json.loads(capsys.readouterr().out), exit_code


@pytest.fixture()
def macos_probes(monkeypatch):
    """Patch every macOS-only probe and record whether the mic was opened."""
    calls = {"microphone": 0, "screen_recording": 0, "desktop_audio": 0}

    def fake_microphone(device_id=None):
        calls["microphone"] += 1
        return True, ""

    def fake_desktop():
        calls["desktop_audio"] += 1
        return True, "swift", ""

    def fake_screen():
        calls["screen_recording"] += 1
        return True, ""

    monkeypatch.setattr(cp, "check_microphone_permission", fake_microphone)
    monkeypatch.setattr(cp, "check_desktop_audio_capture_availability", fake_desktop)
    monkeypatch.setattr(cp, "check_screen_recording_permission", fake_screen)
    monkeypatch.setattr(
        cp, "check_macos_version_compatibility", lambda: (True, "14.5", None)
    )
    return calls


def test_skip_microphone_check_never_opens_the_microphone(
    monkeypatch, capsys, macos_probes
):
    payload, exit_code = _run_main(
        monkeypatch,
        capsys,
        ["--skip-screen-recording-check", "--skip-microphone-check"],
    )

    # The prompting probe must not run at all.
    assert macos_probes["microphone"] == 0
    # Desktop diagnostics must still be collected for a desktop-only recording.
    assert macos_probes["desktop_audio"] == 1

    assert payload["microphone"]["granted"] is None
    assert payload["microphone"]["skipped"] is True
    assert "help" not in payload["microphone"]
    assert payload["microphone"].get("error") is None
    assert payload["desktop_audio"]["available"] is True
    # A skipped probe is excluded from all_granted, not counted as a grant.
    assert payload["all_granted"] is True
    assert exit_code == 0


def test_default_preflight_still_open_tests_the_microphone(
    monkeypatch, capsys, macos_probes
):
    payload, exit_code = _run_main(
        monkeypatch,
        capsys,
        ["--mic-device-id", "3", "--skip-screen-recording-check"],
    )

    assert macos_probes["microphone"] == 1
    assert payload["microphone"]["granted"] is True
    assert payload["microphone"]["skipped"] is False
    assert payload["all_granted"] is True
    assert exit_code == 0


def test_skipped_microphone_does_not_mask_a_missing_desktop_backend(
    monkeypatch, capsys, macos_probes
):
    monkeypatch.setattr(
        cp,
        "check_desktop_audio_capture_availability",
        lambda: (False, None, "Desktop audio capture backend unavailable."),
    )

    payload, exit_code = _run_main(
        monkeypatch,
        capsys,
        ["--skip-screen-recording-check", "--skip-microphone-check"],
    )

    assert macos_probes["microphone"] == 0
    assert payload["desktop_audio"]["available"] is False
    assert "help" in payload["desktop_audio"]
    assert payload["all_granted"] is False
    assert exit_code == 1


def test_denied_microphone_still_fails_when_it_is_requested(
    monkeypatch, capsys, macos_probes
):
    monkeypatch.setattr(
        cp,
        "check_microphone_permission",
        lambda device_id=None: (False, "No input devices found"),
    )

    payload, exit_code = _run_main(
        monkeypatch,
        capsys,
        ["--mic-device-id", "0", "--skip-screen-recording-check"],
    )

    assert payload["microphone"]["granted"] is False
    assert payload["microphone"]["skipped"] is False
    assert payload["microphone"]["error"] == "No input devices found"
    assert "Privacy & Security > Microphone" in payload["microphone"]["help"]
    assert payload["all_granted"] is False
    assert exit_code == 1


def test_non_macos_payload_reports_a_skipped_microphone_consistently(
    monkeypatch, capsys
):
    payload, exit_code = _run_main(
        monkeypatch,
        capsys,
        ["--skip-microphone-check"],
        platform_name="Linux",
    )

    assert payload["microphone"] == {"granted": None, "skipped": True}
    assert payload["all_granted"] is True
    assert exit_code == 0

    payload, exit_code = _run_main(
        monkeypatch, capsys, [], platform_name="Linux"
    )
    assert payload["microphone"] == {"granted": True, "skipped": False}
    assert exit_code == 0
