import backend.audio.screencapture_helper as helper_module
import backend.audio.macos_recorder as macos_recorder_module
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


def test_get_audiocapture_helper_path_skips_which_when_packaged(tmp_path, monkeypatch):
    import shutil

    which_calls = []
    monkeypatch.setattr(shutil, 'which', lambda name: which_calls.append(name))
    monkeypatch.setenv('AVANEVIS_PACKAGED', '1')

    fake_module_file = tmp_path / 'resources' / 'backend' / 'audio' / 'swift_audio_capture.py'
    monkeypatch.setattr(swift_capture_module, '__file__', str(fake_module_file))

    assert swift_capture_module.get_audiocapture_helper_path() is None
    assert which_calls == []


def test_get_audiocapture_helper_path_packaged_uses_bundle_without_which(tmp_path, monkeypatch):
    import shutil

    which_calls = []
    monkeypatch.setattr(shutil, 'which', lambda name: which_calls.append(name))
    monkeypatch.setenv('AVANEVIS_PACKAGED', '1')

    audio_dir = tmp_path / 'resources' / 'backend' / 'audio'
    helper_path = tmp_path / 'resources' / 'bin' / 'audiocapture-helper'
    helper_path.parent.mkdir(parents=True)
    helper_path.write_text('')

    monkeypatch.setattr(swift_capture_module, '__file__', str(audio_dir / 'swift_audio_capture.py'))

    assert swift_capture_module.get_audiocapture_helper_path() == helper_path
    assert which_calls == []


def test_get_audiocapture_helper_path_finds_repo_local_swift_build(tmp_path, monkeypatch):
    repo_root = tmp_path / 'meeting-transcriber'
    helper_path = repo_root / 'swift' / 'AudioCaptureHelper' / '.build' / 'release' / 'audiocapture-helper'
    helper_path.parent.mkdir(parents=True)
    helper_path.write_text('')

    fake_module_file = repo_root / 'backend' / 'audio' / 'swift_audio_capture.py'
    monkeypatch.setattr(swift_capture_module, '__file__', str(fake_module_file))

    assert swift_capture_module.get_audiocapture_helper_path() == helper_path


def test_get_audiocapture_helper_path_prefers_repo_swift_build_over_parent_bin(tmp_path, monkeypatch):
    """Stale <repo-parent>/bin must not shadow a fresh in-repo Swift build."""
    repo_root = tmp_path / 'meeting-transcriber'
    swift_build = (
        repo_root / 'swift' / 'AudioCaptureHelper' / '.build' / 'release' / 'audiocapture-helper'
    )
    swift_build.parent.mkdir(parents=True)
    swift_build.write_text('fresh')

    stale_parent = tmp_path / 'bin' / 'audiocapture-helper'
    stale_parent.parent.mkdir(parents=True)
    stale_parent.write_text('stale')

    monkeypatch.setattr(
        swift_capture_module,
        '__file__',
        str(repo_root / 'backend' / 'audio' / 'swift_audio_capture.py'),
    )
    monkeypatch.delenv('AVANEVIS_PACKAGED', raising=False)

    assert swift_capture_module.get_audiocapture_helper_path() == swift_build


def test_swift_helper_info_plist_declares_audio_capture_usage():
    info_plist = Path(__file__).resolve().parents[2] / 'swift' / 'AudioCaptureHelper' / 'Info.plist'
    contents = info_plist.read_text(encoding='utf-8')

    assert 'NSAudioCaptureUsageDescription' in contents
    assert 'NSScreenCaptureUsageDescription' in contents


def test_swift_helper_uses_coreaudio_tap_before_screencapturekit():
    helper_source = Path(__file__).resolve().parents[2] / 'swift' / 'AudioCaptureHelper' / 'Sources' / 'main.swift'
    contents = helper_source.read_text(encoding='utf-8')

    assert 'AudioHardwareCreateProcessTap' in contents
    assert 'CATapDescription(stereoGlobalTapButExcludeProcesses:' in contents
    assert 'AudioHardwareCreateAggregateDevice' in contents
    assert 'audioBuffer.mNumberChannels' in contents
    assert 'buffers.count > 1 || isNonInterleaved(streamFormat)' in contents
    assert 'isInterleaved && audioBuffers.count == 1' in contents
    assert 'verifyAggregateNominalSampleRate' in contents
    assert 'usleep(useconds_t((attempt + 1) * 10_000))' in contents
    assert '--screencapturekit' in contents


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


def test_swift_audio_capture_missing_audio_help_prefers_system_audio_for_coreaudio_tap():
    capture = swift_capture_module.SwiftAudioCapture.__new__(swift_capture_module.SwiftAudioCapture)
    capture.helper_capture_backend = 'coreaudio_tap'

    assert 'System Audio Recording permission' in capture._missing_audio_help()
    assert 'Screen Recording permission' not in capture._missing_audio_help()


def test_swift_audio_capture_missing_audio_help_keeps_screen_recording_for_screencapturekit():
    capture = swift_capture_module.SwiftAudioCapture.__new__(swift_capture_module.SwiftAudioCapture)
    capture.helper_capture_backend = 'screencapturekit'

    assert 'Screen Recording permission' in capture._missing_audio_help()


def test_swift_audio_capture_preserves_final_diagnostics_after_buffer_clear():
    import numpy as np

    capture = swift_capture_module.SwiftAudioCapture.__new__(swift_capture_module.SwiftAudioCapture)
    capture._recording_event = swift_capture_module.threading.Event()
    capture._recording_event.set()
    capture.buffer_lock = swift_capture_module.threading.Lock()
    capture.warning_lock = swift_capture_module.threading.Lock()
    capture.warning_event = swift_capture_module.threading.Event()
    capture.warning_messages = []
    capture._warning_codes_sent = set()
    capture.audio_buffer = [np.ones((10, 2), dtype=np.float64)]
    capture.process = None
    capture._stdout_thread = None
    capture._stderr_thread = None
    capture.helper_total_sample_buffers = 3
    capture.helper_total_bytes = 80

    audio = capture.stop_recording()

    assert audio.shape == (10, 2)
    assert capture.audio_buffer == []
    assert capture.last_captured_chunk_count == 1
    assert capture.last_captured_sample_count == 10
    assert capture.last_helper_sample_buffers == 3
    assert capture.last_helper_bytes == 80


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
    capture.helper_capture_backend = None
    capture.first_audio_time = None
    capture.last_audio_time = None

    messages = [
        '{"type":"capture_backend","backend":"coreaudio_tap"}',
        '{"type":"content_info","captureBackend":"screencapturekit","displayCount":1,"applicationCount":12,"windowCount":34}',
        '{"type":"stream_config","captureBackend":"screencapturekit","width":1728,"height":1117,"capturesAudio":true}',
        '{"type":"status","status":"screen_sample","message":"screen","screenFrames":1}',
        '{"type":"capture_stats","captureBackend":"screencapturekit","totalSamples":0,"totalBytes":0,"screenFrames":5}',
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
    assert capture.helper_capture_backend == 'screencapturekit'


def test_macos_desktop_diagnostics_fall_back_to_read_counts_after_buffer_clear():
    capture = swift_capture_module.SwiftAudioCapture.__new__(swift_capture_module.SwiftAudioCapture)
    capture.buffer_lock = swift_capture_module.threading.Lock()
    capture.audio_buffer = []
    capture.last_captured_chunk_count = 0
    capture.last_captured_sample_count = 0
    capture.read_chunk_count = 12
    capture.read_sample_count = 48000
    capture.read_peak_level = 0.5
    capture.first_audio_time = 1000.0
    capture.last_audio_time = 1001.0
    capture.helper_total_sample_buffers = 12
    capture.helper_total_bytes = 384000
    capture.last_helper_sample_buffers = 0
    capture.last_helper_bytes = 0
    capture.helper_screen_frames = 0
    capture.helper_dropped_chunks = 0
    capture.helper_queued_bytes_remaining = 0
    capture.helper_capture_backend = 'coreaudio_tap'
    capture.helper_audio_format = None
    capture.helper_content_info = None
    capture.helper_stream_config = None

    recorder = macos_recorder_module.MacOSAudioRecorder.__new__(macos_recorder_module.MacOSAudioRecorder)
    recorder.desktop_capture = capture
    recorder.desktop_capture_type = 'swift'

    diagnostics = recorder._build_desktop_diagnostics()

    assert diagnostics['bufferChunks'] == 12
    assert diagnostics['bufferSamples'] == 48000
    assert diagnostics['readChunks'] == 12
    assert diagnostics['readSamples'] == 48000
    assert diagnostics['peakLevel'] == 0.5
    assert diagnostics['helperCaptureBackend'] == 'coreaudio_tap'


def test_macos_one_sided_stereo_repair_preserves_mono_transcription_energy():
    import numpy as np

    audio = np.column_stack([
        np.array([0.0, 0.5, -0.5, 0.25], dtype=np.float64),
        np.zeros(4, dtype=np.float64),
    ])

    repaired = macos_recorder_module._repair_one_sided_stereo(audio, 'desktop')

    assert np.allclose(repaired[:, 0], audio[:, 0])
    assert np.allclose(repaired[:, 1], audio[:, 0])


def test_macos_one_sided_stereo_repair_keeps_balanced_stereo_unchanged():
    import numpy as np

    audio = np.column_stack([
        np.array([0.0, 0.5, -0.5, 0.25], dtype=np.float64),
        np.array([0.1, -0.4, 0.4, -0.2], dtype=np.float64),
    ])

    repaired = macos_recorder_module._repair_one_sided_stereo(audio, 'desktop')

    assert np.allclose(repaired, audio)


def test_macos_one_sided_stereo_repair_preserves_float32_desktop_frames():
    import numpy as np

    audio = np.column_stack([
        np.array([0.0, 0.5, -0.5, 0.25], dtype=np.float32),
        np.zeros(4, dtype=np.float32),
    ])

    repaired = macos_recorder_module._repair_one_sided_stereo(audio, 'desktop')

    assert repaired.dtype == np.float32
    assert np.allclose(repaired[:, 0], audio[:, 0])
    assert np.allclose(repaired[:, 1], audio[:, 0])


def test_macos_one_sided_stereo_repair_keeps_balanced_float32_unchanged():
    import numpy as np

    audio = np.column_stack([
        np.array([0.0, 0.5, -0.5, 0.25], dtype=np.float32),
        np.array([0.1, -0.4, 0.4, -0.2], dtype=np.float32),
    ])

    repaired = macos_recorder_module._repair_one_sided_stereo(audio, 'desktop')

    assert repaired.dtype == np.float32
    assert np.allclose(repaired, audio)


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
