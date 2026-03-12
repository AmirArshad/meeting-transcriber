import backend.device_manager as device_manager


def test_load_audio_backend_raises_structured_error_for_unsupported_platform(monkeypatch):
    monkeypatch.setattr(device_manager, 'IS_WINDOWS', False)
    monkeypatch.setattr(device_manager, 'IS_MACOS', False)

    try:
        device_manager.load_audio_backend()
    except device_manager.DeviceManagerEnvironmentError as exc:
        assert 'Unsupported platform' in str(exc)
    else:
        raise AssertionError('Expected DeviceManagerEnvironmentError for unsupported platform')
