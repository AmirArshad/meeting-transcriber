from types import SimpleNamespace

import pytest

import backend.device_manager as device_manager
from device_helpers import (
    LINUX_DESKTOP_OFF_DEVICE_ID,
    format_pulse_monitor_id,
    format_pulse_sink_id,
    format_pulse_source_id,
    is_linux_desktop_off_id,
    is_pulse_endpoint_unavailable,
    is_pulse_monitor_source,
    is_pulse_port_unavailable,
    parse_pulse_device_id,
)


PULSE_INVALID_INDEX = 0xFFFFFFFF


class FakeSampleSpec:
    def __init__(self, rate):
        self.rate = rate


class FakeSource:
    def __init__(self, name, description, *, monitor_of_sink=PULSE_INVALID_INDEX, monitor_of_sink_name=None, channels=1, rate=48000, port_active=None):
        self.name = name
        self.description = description
        self.monitor_of_sink = monitor_of_sink
        self.monitor_of_sink_name = monitor_of_sink_name
        self.channel_count = channels
        self.sample_spec = FakeSampleSpec(rate)
        self.port_active = port_active


class FakeSink:
    def __init__(self, name, description, monitor_source_name, *, channels=2, rate=48000, port_active=None):
        self.name = name
        self.description = description
        self.monitor_source_name = monitor_source_name
        self.channel_count = channels
        self.sample_spec = FakeSampleSpec(rate)
        self.port_active = port_active


class FakePort:
    def __init__(self, available):
        self.available = available
        self.name = 'hdmi-output'
        self.description = 'HDMI / DisplayPort'


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
    assert format_pulse_sink_id('alsa_output.pci') == 'pulse-sink:alsa_output.pci'
    assert parse_pulse_device_id('pulse-source:alsa_input.usb-mic') == ('source', 'alsa_input.usb-mic')
    assert parse_pulse_device_id('pulse-monitor:alsa_output.pci.monitor') == ('monitor', 'alsa_output.pci.monitor')
    assert parse_pulse_device_id('pulse-sink:alsa_output.pci') == ('sink', 'alsa_output.pci')
    assert parse_pulse_device_id('0') is None
    assert parse_pulse_device_id('alsa_output.pci') is None
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
    assert devices['output_devices'][0]['id'] == 'pulse-sink:avanevis_desktop'
    assert defaults['default_input'] == 'pulse-source:avanevis_mic'
    assert defaults['default_output'] == 'pulse-monitor:avanevis_desktop.monitor'

    manager.validate_input_device('pulse-source:avanevis_mic')
    with pytest.raises(ValueError, match='Pulse source id'):
        manager.validate_input_device('pulse-monitor:avanevis_desktop.monitor')
    with pytest.raises(ValueError, match='was not found'):
        manager.validate_input_device('pulse-source:missing')

    sink_info = manager.get_device_info('pulse-sink:avanevis_desktop')
    assert sink_info['id'] == 'pulse-sink:avanevis_desktop'
    assert sink_info['max_output_channels'] == 2
    monitor_info = manager.get_device_info('pulse-monitor:avanevis_desktop.monitor')
    assert monitor_info['is_loopback'] is True
    assert 'error' in manager.get_device_info('pulse-monitor:avanevis_mic')
    assert 'error' in manager.get_device_info('pulse-source:avanevis_desktop.monitor')


def test_linux_device_manager_fails_closed_without_pulse_server(monkeypatch):
    _linux_flags(monkeypatch)

    class BoomPulse:
        def __init__(self, name):
            raise ConnectionRefusedError('no pulse')

    monkeypatch.setattr(device_manager, 'load_audio_backend', lambda: SimpleNamespace(Pulse=BoomPulse))

    with pytest.raises(device_manager.DeviceManagerEnvironmentError) as exc:
        device_manager.DeviceManager()
    assert 'pipewire-pulse' in str(exc.value)
    assert 'user audio session' in str(exc.value)


def test_linux_enumerate_failure_keeps_raw_exception_off_the_error_line(monkeypatch, capsys):
    _linux_flags(monkeypatch)
    manager = device_manager.DeviceManager.__new__(device_manager.DeviceManager)

    class BoomPulse:
        def source_list(self):
            raise ConnectionRefusedError('no pulse at /run/user/1000/pulse/native')

        def sink_list(self):
            raise AssertionError('sink_list should not run after source_list fails')

    manager.pulse = BoomPulse()
    with pytest.raises(device_manager.DeviceManagerEnvironmentError) as exc:
        manager._list_devices_linux()
    assert 'pipewire-pulse' in str(exc.value)
    assert 'user audio session' in str(exc.value)

    captured = capsys.readouterr()
    assert captured.err.startswith('Warning:')
    assert 'ERROR:' not in captured.err
    assert '/run/user/1000/pulse/native' in captured.err


def test_linux_device_manager_main_surfaces_sanitized_enumerate_error(monkeypatch, capsys):
    _linux_flags(monkeypatch)

    class ConnectedButBroken:
        def list_all_devices(self):
            raise device_manager.DeviceManagerEnvironmentError(
                'Could not list PulseAudio/PipeWire devices. Is the session audio service running?'
            )

        def get_default_devices(self):
            raise AssertionError('defaults should not run after enumerate failure')

    monkeypatch.setattr(device_manager, 'DeviceManager', ConnectedButBroken)
    with pytest.raises(SystemExit) as exc:
        device_manager.main()
    assert exc.value.code == 1
    captured = capsys.readouterr()
    assert captured.out == ''
    assert captured.err.startswith(
        'ERROR: Could not list PulseAudio/PipeWire devices. Is the session audio service running?'
    )
    assert '/run/user' not in captured.err


def test_pulse_port_unavailable_only_when_explicitly_no():
    assert is_pulse_port_unavailable(None) is False
    assert is_pulse_port_unavailable(FakePort('unknown')) is False
    assert is_pulse_port_unavailable(FakePort('yes')) is False
    assert is_pulse_port_unavailable(FakePort('no')) is True
    assert is_pulse_port_unavailable(FakePort(1)) is True
    assert is_pulse_port_unavailable(FakePort(0)) is False
    assert is_pulse_port_unavailable(FakePort(2)) is False

    class EnumLike:
        name = 'no'

        def __str__(self):
            return 'available.no'

    assert is_pulse_port_unavailable(FakePort(EnumLike())) is True
    assert is_pulse_endpoint_unavailable(FakeSink('hdmi', 'HDMI', 'hdmi.monitor', port_active=FakePort('no'))) is True
    assert is_pulse_endpoint_unavailable(FakeSink('analog', 'Speakers', 'analog.monitor')) is False


def test_pulse_port_unavailable_matches_the_real_pulsectl_enum_value():
    """Guard against a probe that only satisfies hand-written fakes.

    ``pulsectl.EnumValue`` has no ``.name``, is not an ``int`` subclass, and
    reprs as ``<EnumValue available=no>``. An earlier implementation matched
    every fake in the test above yet returned False for every real port, which
    silently disabled unplugged-HDMI filtering in production.
    """
    pulsectl = pytest.importorskip('pulsectl')
    available_enum = pulsectl.pulsectl.PulsePortAvailableEnum

    assert is_pulse_port_unavailable(FakePort(available_enum.no)) is True
    assert is_pulse_port_unavailable(FakePort(available_enum.yes)) is False
    assert is_pulse_port_unavailable(FakePort(available_enum.unknown)) is False

    # available_state is pulsectl's <=17.6.0 compatibility alias for the same value.
    class LegacyPort:
        available = None
        available_state = available_enum.no

    assert is_pulse_port_unavailable(LegacyPort()) is True

    class RealisticSink:
        port_active = FakePort(available_enum.no)

    assert is_pulse_endpoint_unavailable(RealisticSink()) is True


def test_linux_device_manager_keeps_distinct_pulse_ids_with_the_same_description(monkeypatch):
    _linux_flags(monkeypatch)
    pulse = FakePulse(
        sources=[
            FakeSource('usb_mic_a', 'Microphone', channels=1),
            FakeSource('usb_mic_b', 'Microphone', channels=1),
            FakeSource('analog.monitor', 'Monitor of Analog', monitor_of_sink=1, monitor_of_sink_name='analog', channels=2),
        ],
        sinks=[
            FakeSink('analog', 'Analog', 'analog.monitor'),
        ],
        default_source='usb_mic_a',
        default_sink='analog',
    )
    monkeypatch.setattr(device_manager, 'load_audio_backend', lambda: SimpleNamespace(Pulse=lambda name: pulse))

    devices = device_manager.DeviceManager().list_all_devices()
    input_ids = [item['id'] for item in devices['input_devices']]
    assert 'pulse-source:usb_mic_a' in input_ids
    assert 'pulse-source:usb_mic_b' in input_ids


def test_linux_device_manager_omits_unavailable_hdmi_monitor(monkeypatch):
    _linux_flags(monkeypatch)
    pulse = FakePulse(
        sources=[
            FakeSource('analog_mic', 'Internal Mic', channels=1),
            FakeSource('analog.monitor', 'Monitor of Analog', monitor_of_sink=1, monitor_of_sink_name='analog', channels=2),
            FakeSource(
                'hdmi.monitor',
                'Monitor of HDMI',
                monitor_of_sink=2,
                monitor_of_sink_name='hdmi',
                channels=2,
            ),
        ],
        sinks=[
            FakeSink('analog', 'Analog', 'analog.monitor', port_active=FakePort('yes')),
            FakeSink('hdmi', 'HDMI', 'hdmi.monitor', port_active=FakePort('no')),
        ],
        default_source='analog_mic',
        default_sink='analog',
    )
    monkeypatch.setattr(device_manager, 'load_audio_backend', lambda: SimpleNamespace(Pulse=lambda name: pulse))

    devices = device_manager.DeviceManager().list_all_devices()
    loopback_ids = [item['id'] for item in devices['loopback_devices']]
    output_ids = [item['id'] for item in devices['output_devices']]
    assert loopback_ids == ['pulse-monitor:analog.monitor']
    assert output_ids == ['pulse-sink:analog']
    assert 'pulse-monitor:hdmi.monitor' not in loopback_ids
    assert 'pulse-sink:hdmi' not in output_ids
