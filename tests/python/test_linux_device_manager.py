from types import SimpleNamespace

import pytest

import backend.device_manager as device_manager
from device_helpers import (
    LINUX_DESKTOP_OFF_DEVICE_ID,
    format_pulse_monitor_id,
    format_pulse_source_id,
    is_linux_desktop_off_id,
    is_pulse_monitor_source,
    parse_pulse_device_id,
)


PULSE_INVALID_INDEX = 0xFFFFFFFF


class FakeSampleSpec:
    def __init__(self, rate):
        self.rate = rate


class FakeSource:
    def __init__(self, name, description, *, monitor_of_sink=PULSE_INVALID_INDEX, monitor_of_sink_name=None, channels=1, rate=48000):
        self.name = name
        self.description = description
        self.monitor_of_sink = monitor_of_sink
        self.monitor_of_sink_name = monitor_of_sink_name
        self.channel_count = channels
        self.sample_spec = FakeSampleSpec(rate)


class FakeSink:
    def __init__(self, name, description, monitor_source_name, *, channels=2, rate=48000):
        self.name = name
        self.description = description
        self.monitor_source_name = monitor_source_name
        self.channel_count = channels
        self.sample_spec = FakeSampleSpec(rate)


class FakePulse:
    def __init__(self, sources, sinks, default_source, default_sink):
        self._sources = sources
        self._sinks = sinks
        self._default_source = default_source
        self._default_sink = default_sink
        self.closed = False

    def source_list(self):
        return list(self._sources)

    def sink_list(self):
        return list(self._sinks)

    def server_info(self):
        return SimpleNamespace(
            default_source_name=self._default_source,
            default_sink_name=self._default_sink,
        )

    def close(self):
        self.closed = True


def _linux_flags(monkeypatch):
    monkeypatch.setattr(device_manager, 'IS_WINDOWS', False)
    monkeypatch.setattr(device_manager, 'IS_MACOS', False)
    monkeypatch.setattr(device_manager, 'IS_LINUX', True)


def test_pulse_device_id_helpers_round_trip():
    assert format_pulse_source_id('alsa_input.usb-mic') == 'pulse-source:alsa_input.usb-mic'
    assert format_pulse_monitor_id('alsa_output.pci.monitor') == 'pulse-monitor:alsa_output.pci.monitor'
    assert parse_pulse_device_id('pulse-source:alsa_input.usb-mic') == ('source', 'alsa_input.usb-mic')
    assert parse_pulse_device_id('pulse-monitor:alsa_output.pci.monitor') == ('monitor', 'alsa_output.pci.monitor')
    assert parse_pulse_device_id('0') is None
    assert is_linux_desktop_off_id(LINUX_DESKTOP_OFF_DEVICE_ID)
    assert is_pulse_monitor_source(FakeSource('out.monitor', 'Monitor', monitor_of_sink=1, monitor_of_sink_name='out'))
    assert not is_pulse_monitor_source(FakeSource('mic', 'Mic'))


def test_linux_device_manager_enumerates_opaque_pulse_ids(monkeypatch):
    _linux_flags(monkeypatch)
    pulse = FakePulse(
        sources=[
            FakeSource('avanevis_desktop.monitor', 'Monitor of Desktop', monitor_of_sink=1, monitor_of_sink_name='avanevis_desktop', channels=2),
            FakeSource('avanevis_mic', 'Sine source', channels=1),
        ],
        sinks=[
            FakeSink('avanevis_desktop', 'Desktop', 'avanevis_desktop.monitor'),
        ],
        default_source='avanevis_mic',
        default_sink='avanevis_desktop',
    )
    monkeypatch.setattr(device_manager, 'pulsectl', SimpleNamespace(Pulse=lambda name: pulse), raising=False)
    monkeypatch.setattr(device_manager, 'load_audio_backend', lambda: SimpleNamespace(Pulse=lambda name: pulse))

    manager = device_manager.DeviceManager()
    devices = manager.list_all_devices()
    defaults = manager.get_default_devices()

    assert devices['input_devices'][0]['id'] == 'pulse-source:avanevis_mic'
    assert devices['loopback_devices'][0]['id'] == 'pulse-monitor:avanevis_desktop.monitor'
    assert defaults['default_input'] == 'pulse-source:avanevis_mic'
    assert defaults['default_output'] == 'pulse-monitor:avanevis_desktop.monitor'

    manager.validate_input_device('pulse-source:avanevis_mic')
    with pytest.raises(ValueError, match='Pulse source id'):
        manager.validate_input_device('pulse-monitor:avanevis_desktop.monitor')
    with pytest.raises(ValueError, match='was not found'):
        manager.validate_input_device('pulse-source:missing')


def test_linux_device_manager_fails_closed_without_pulse_server(monkeypatch):
    _linux_flags(monkeypatch)

    class BoomPulse:
        def __init__(self, name):
            raise ConnectionRefusedError('no pulse')

    monkeypatch.setattr(device_manager, 'load_audio_backend', lambda: SimpleNamespace(Pulse=BoomPulse))

    with pytest.raises(device_manager.DeviceManagerEnvironmentError, match='PulseAudio/PipeWire is not running'):
        device_manager.DeviceManager()
