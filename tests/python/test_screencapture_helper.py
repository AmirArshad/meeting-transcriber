import backend.audio.screencapture_helper as helper_module


def test_classify_permission_error_detects_common_permission_failures():
    assert helper_module._classify_permission_error('User is not authorized for screen capture') is True
    assert helper_module._classify_permission_error('Permission denied by system settings') is True
    assert helper_module._classify_permission_error('Display stream failed to start') is False


def test_build_capture_start_error_uses_consistent_pyobjc_contract_wording():
    message = helper_module._build_capture_start_error('pyobjc', 'No displays available')
    assert message == 'pyobjc desktop audio failed to start: No displays available'
