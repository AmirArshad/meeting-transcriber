import backend.audio.screencapture_helper as helper_module
import backend.audio.swift_audio_capture as swift_capture_module


def test_classify_permission_error_detects_common_permission_failures():
    assert helper_module._classify_permission_error('User is not authorized for screen capture') is True
    assert helper_module._classify_permission_error('Permission denied by system settings') is True
    assert helper_module._classify_permission_error('Display stream failed to start') is False


def test_build_capture_start_error_uses_consistent_pyobjc_contract_wording():
    message = helper_module._build_capture_start_error('pyobjc', 'No displays available')
    assert message == 'pyobjc desktop audio failed to start: No displays available'


def test_check_screen_recording_permission_uses_last_permission_payload(monkeypatch):
    helper_path = '/tmp/audiocapture-helper'

    monkeypatch.setattr(swift_capture_module, 'get_audiocapture_helper_path', lambda: helper_path)

    stderr_output = '\n'.join([
        '{"type":"permission_check","granted":false}',
        '{"type":"permission_check","granted":true}',
    ])

    def fake_run(*args, **kwargs):
        return swift_capture_module.subprocess.CompletedProcess(
            args=[helper_path, '--check-permission'],
            returncode=0,
            stdout='',
            stderr=stderr_output,
        )

    monkeypatch.setattr(swift_capture_module.subprocess, 'run', fake_run)

    assert swift_capture_module.check_screen_recording_permission() is True


def test_swift_audio_capture_collects_helper_warning_messages():
    capture = swift_capture_module.SwiftAudioCapture.__new__(swift_capture_module.SwiftAudioCapture)
    capture.warning_messages = [
        {'type': 'warning', 'code': 'stdout_backpressure', 'message': 'dropped chunks'}
    ]
    capture.warning_event = swift_capture_module.threading.Event()
    capture.warning_event.set()
    capture.warning_lock = swift_capture_module.threading.Lock()

    warnings = capture.drain_warnings()

    assert warnings == [
        {'type': 'warning', 'code': 'stdout_backpressure', 'message': 'dropped chunks'}
    ]
    assert capture.warning_messages == []
    assert capture.warning_event.is_set() is False
