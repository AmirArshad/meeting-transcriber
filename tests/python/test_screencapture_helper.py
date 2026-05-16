import backend.audio.screencapture_helper as helper_module
import backend.audio.swift_audio_capture as swift_capture_module
import backend.check_permissions as check_permissions_module
from pathlib import Path
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


def test_get_audiocapture_helper_path_finds_repo_local_swift_build(tmp_path, monkeypatch):
    repo_root = tmp_path / 'meeting-transcriber'
    helper_path = repo_root / 'swift' / 'AudioCaptureHelper' / '.build' / 'release' / 'audiocapture-helper'
    helper_path.parent.mkdir(parents=True)
    helper_path.write_text('')

    fake_module_file = repo_root / 'backend' / 'audio' / 'swift_audio_capture.py'
    monkeypatch.setattr(swift_capture_module, '__file__', str(fake_module_file))

    assert swift_capture_module.get_audiocapture_helper_path() == helper_path


def test_swift_helper_info_plist_declares_audio_capture_usage():
    info_plist = Path(__file__).resolve().parents[2] / 'swift' / 'AudioCaptureHelper' / 'Info.plist'
    contents = info_plist.read_text(encoding='utf-8')

    assert 'NSAudioCaptureUsageDescription' in contents
    assert 'NSScreenCaptureUsageDescription' in contents


def test_check_permissions_uses_swift_helper_before_pyobjc(monkeypatch):
    monkeypatch.setattr(
        check_permissions_module,
        '_check_screen_recording_permission_with_swift_helper',
        lambda: (False, 'Screen Recording permission not granted'),
    )

    granted, error = check_permissions_module.check_screen_recording_permission()

    assert granted is False
    assert error == 'Screen Recording permission not granted'


def test_check_permissions_can_skip_proactive_screen_recording_check(monkeypatch, capsys):
    monkeypatch.setattr(check_permissions_module.platform, 'system', lambda: 'Darwin')
    monkeypatch.setattr(check_permissions_module, 'check_macos_version_compatibility', lambda: (True, '14.0', None))
    monkeypatch.setattr(check_permissions_module, 'check_microphone_permission', lambda mic_device_id=None: (True, ''))
    monkeypatch.setattr(
        check_permissions_module,
        'check_desktop_audio_capture_availability',
        lambda: (True, 'swift', ''),
    )
    monkeypatch.setattr(
        check_permissions_module,
        'check_screen_recording_permission',
        lambda: (_ for _ in ()).throw(AssertionError('should not run screen permission check')),
    )
    monkeypatch.setattr(check_permissions_module.sys, 'argv', ['check_permissions.py', '--skip-screen-recording-check'])

    with pytest.raises(SystemExit) as exc_info:
        check_permissions_module.main()

    output = capsys.readouterr().out
    assert exc_info.value.code == 0
    assert '"all_granted": true' in output



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


def test_swift_audio_capture_records_helper_diagnostics(monkeypatch):
    import select

    capture = swift_capture_module.SwiftAudioCapture.__new__(swift_capture_module.SwiftAudioCapture)
    capture._recording_event = swift_capture_module.threading.Event()
    capture.process = None
    capture.helper_screen_frames = 0
    capture.helper_content_info = None
    capture.helper_stream_config = None
    capture.helper_total_sample_buffers = 0
    capture.helper_total_bytes = 0
    capture.helper_dropped_chunks = 0
    capture.helper_queued_bytes_remaining = 0
    capture.first_audio_time = None
    capture.last_audio_time = None

    messages = [
        '{"type":"content_info","displayCount":1,"applicationCount":12,"windowCount":34}',
        '{"type":"stream_config","width":1728,"height":1117,"capturesAudio":true}',
        '{"type":"status","status":"screen_sample","message":"screen","screenFrames":1}',
        '{"type":"capture_stats","totalSamples":0,"totalBytes":0,"screenFrames":5}',
    ]

    class FakeStderr:
        def __init__(self, lines):
            self.lines = [line.encode('utf-8') + b'\n' for line in lines]

        def fileno(self):
            return 0

        def readline(self):
            if self.lines:
                return self.lines.pop(0)
            return b''

    class FakeProcess:
        def __init__(self, lines):
            self.stderr = FakeStderr(lines)

        def poll(self):
            return None if self.stderr.lines else 0

    capture.process = FakeProcess(messages)
    capture._recording_event.set()

    def fake_select(readers, _writers, _errors, _timeout):
        if capture.process.stderr.lines:
            return readers, [], []
        return [], [], []

    monkeypatch.setattr(select, 'select', fake_select)

    capture._read_status_messages()

    assert capture.helper_content_info['displayCount'] == 1
    assert capture.helper_stream_config['width'] == 1728
    assert capture.helper_screen_frames == 5


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
