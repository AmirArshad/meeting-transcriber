import backend.audio.screencapture_helper as helper_module
import backend.audio.swift_audio_capture as swift_capture_module
import backend.check_permissions as check_permissions_module
import pytest


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


def test_parse_permission_check_output_returns_helper_error_detail():
    stderr_output = '\n'.join([
        '{"type":"error","code":"permission_denied","error":"Screen Recording permission not granted"}',
    ])

    granted, error = swift_capture_module._parse_permission_check_output(stderr_output, 1)

    assert granted is False
    assert error == 'Screen Recording permission not granted'


def test_parse_permission_check_output_uses_last_permission_payload():
    stderr_output = '\n'.join([
        '{"type":"permission_check","granted":false}',
        '{"type":"permission_check","granted":true}',
    ])

    granted, error = swift_capture_module._parse_permission_check_output(stderr_output, 0)

    assert granted is True
    assert error is None


def test_check_permissions_uses_swift_helper_before_pyobjc(monkeypatch):
    monkeypatch.setattr(
        check_permissions_module,
        '_check_screen_recording_permission_with_swift_helper',
        lambda: (False, 'Screen Recording permission not granted'),
    )

    granted, error = check_permissions_module.check_screen_recording_permission()

    assert granted is False
    assert error == 'Screen Recording permission not granted'


def test_swift_audio_capture_preserves_first_startup_error():
    capture = swift_capture_module.SwiftAudioCapture.__new__(swift_capture_module.SwiftAudioCapture)
    capture.error_event = swift_capture_module.threading.Event()
    capture.last_error = None

    swift_capture_module._apply_helper_error(capture, {
        'type': 'error',
        'code': 'permission_denied',
        'error': 'Screen Recording permission not granted',
    })
    swift_capture_module._apply_helper_error(capture, {
        'type': 'error',
        'error': 'Failed to start capture: generic wrapper',
    })

    assert capture.last_error == 'PERMISSION_DENIED: Screen Recording permission not granted'


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


def test_swift_audio_capture_queues_no_audio_warning_once():
    capture = swift_capture_module.SwiftAudioCapture.__new__(swift_capture_module.SwiftAudioCapture)
    capture.warning_messages = []
    capture.warning_event = swift_capture_module.threading.Event()
    capture.warning_lock = swift_capture_module.threading.Lock()
    capture._warning_codes_sent = set()

    capture._queue_warning('NO_DESKTOP_AUDIO_CAPTURED', 'No desktop samples')
    capture._queue_warning('NO_DESKTOP_AUDIO_CAPTURED', 'No desktop samples again')

    warnings = capture.drain_warnings()

    assert warnings == [
        {
            'type': 'warning',
            'code': 'NO_DESKTOP_AUDIO_CAPTURED',
            'message': 'No desktop samples',
        }
    ]


def test_desktop_audio_availability_reports_missing_backends(monkeypatch):
    monkeypatch.setattr(check_permissions_module, '_is_swift_capture_available', lambda: (False, 'missing helper'))
    monkeypatch.setattr(check_permissions_module, '_is_pyobjc_screencapture_available', lambda: (False, 'missing pyobjc'))

    available, backend, error = check_permissions_module.check_desktop_audio_capture_availability()

    assert available is False
    assert backend is None
    assert 'missing helper' in error
    assert 'missing pyobjc' in error


def test_desktop_audio_availability_prefers_swift(monkeypatch):
    monkeypatch.setattr(check_permissions_module, '_is_swift_capture_available', lambda: (True, ''))
    monkeypatch.setattr(check_permissions_module, '_is_pyobjc_screencapture_available', lambda: (True, ''))

    available, backend, error = check_permissions_module.check_desktop_audio_capture_availability()

    assert available is True
    assert backend == 'swift'
    assert error == ''


def test_check_permissions_main_exits_nonzero_when_desktop_backend_missing(monkeypatch, capsys):
    monkeypatch.setattr(check_permissions_module.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(check_permissions_module, 'check_macos_version_compatibility', lambda: (True, '14.0', None))
    monkeypatch.setattr(check_permissions_module, 'check_microphone_permission', lambda mic_device_id=None: (True, ''))
    monkeypatch.setattr(
        check_permissions_module,
        'check_desktop_audio_capture_availability',
        lambda: (False, None, 'missing helper'),
    )
    monkeypatch.setattr(check_permissions_module.sys, 'argv', ['check_permissions.py'])

    with pytest.raises(SystemExit) as exc_info:
        check_permissions_module.main()

    output = capsys.readouterr().out
    assert exc_info.value.code == 1
    assert '"all_granted": false' in output
    assert 'missing helper' in output


def test_check_permissions_main_exits_zero_when_all_requirements_pass(monkeypatch, capsys):
    monkeypatch.setattr(check_permissions_module.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(check_permissions_module, 'check_macos_version_compatibility', lambda: (True, '14.0', None))
    monkeypatch.setattr(check_permissions_module, 'check_microphone_permission', lambda mic_device_id=None: (True, ''))
    monkeypatch.setattr(
        check_permissions_module,
        'check_desktop_audio_capture_availability',
        lambda: (True, 'swift', ''),
    )
    monkeypatch.setattr(check_permissions_module, 'check_screen_recording_permission', lambda: (True, ''))
    monkeypatch.setattr(check_permissions_module.sys, 'argv', ['check_permissions.py'])

    with pytest.raises(SystemExit) as exc_info:
        check_permissions_module.main()

    output = capsys.readouterr().out
    assert exc_info.value.code == 0
    assert '"all_granted": true' in output
