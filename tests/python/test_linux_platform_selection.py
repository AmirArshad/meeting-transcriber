import platform as std_platform

import pytest

import backend.audio as audio
import backend.device_manager as device_manager


def test_audio_factory_fails_closed_on_linux(monkeypatch):
    monkeypatch.setattr(std_platform, 'system', lambda: 'Linux')
    with pytest.raises(NotImplementedError, match='Linux'):
        audio.get_audio_recorder()


def test_device_manager_fails_closed_on_linux(monkeypatch):
    monkeypatch.setattr(device_manager, 'IS_WINDOWS', False)
    monkeypatch.setattr(device_manager, 'IS_MACOS', False)
    monkeypatch.setattr(std_platform, 'system', lambda: 'Linux')
    with pytest.raises(device_manager.DeviceManagerEnvironmentError, match='Unsupported platform'):
        device_manager.load_audio_backend()
