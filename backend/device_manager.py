"""
Audio Device Manager - Enumerates available audio input/output devices.

Platform-specific implementations:
- Windows: Uses pyaudiowpatch for WASAPI loopback support
- macOS: Uses sounddevice for device enumeration
"""

import json
import sys
import platform
from typing import Dict, List, Any, Optional

from device_helpers import (
    build_device_record,
    dedupe_device_by_name,
    is_blocked_windows_device_name,
    macos_virtual_loopback_devices,
    sort_devices_by_name,
)

# Platform detection
IS_WINDOWS = platform.system() == 'Windows'
IS_MACOS = platform.system() == 'Darwin'

pyaudio: Optional[object] = None
sd: Optional[object] = None


class DeviceManagerEnvironmentError(RuntimeError):
    """Raised when the device manager environment is unsupported or incomplete."""


def load_audio_backend():
    global pyaudio, sd

    if IS_WINDOWS:
        if pyaudio is None:
            try:
                import pyaudiowpatch as imported_pyaudio
                pyaudio = imported_pyaudio
            except ImportError as exc:
                raise DeviceManagerEnvironmentError(
                    "pyaudiowpatch not installed. Run: pip install pyaudiowpatch"
                ) from exc
        return pyaudio

    if IS_MACOS:
        if sd is None:
            try:
                import sounddevice as imported_sd
                sd = imported_sd
            except ImportError as exc:
                raise DeviceManagerEnvironmentError(
                    "sounddevice not installed. Run: pip install sounddevice"
                ) from exc
        return sd

    raise DeviceManagerEnvironmentError(f"Unsupported platform: {platform.system()}")


class DeviceManager:
    """Manages audio device enumeration and information retrieval."""

    def __init__(self):
        if IS_WINDOWS:
            backend = load_audio_backend()
            self.audio_backend = backend
            self.pa = backend.PyAudio()
        elif IS_MACOS:
            self.audio_backend = load_audio_backend()
            self.pa = None  # sounddevice doesn't need initialization
        else:
            raise DeviceManagerEnvironmentError(f"Unsupported platform: {platform.system()}")

    def __del__(self):
        """Clean up PyAudio instance."""
        if IS_WINDOWS and hasattr(self, 'pa') and self.pa:
            self.pa.terminate()

    def list_all_devices(self) -> Dict[str, List[Dict[str, Any]]]:
        """
        Enumerate all audio devices and categorize them.
        Filters duplicates and system virtual devices.

        Returns:
            Dictionary with 'input_devices', 'output_devices', and 'loopback_devices'
        """
        if IS_WINDOWS:
            return self._list_devices_windows()
        elif IS_MACOS:
            return self._list_devices_macos()

        raise DeviceManagerEnvironmentError(f"Unsupported platform: {platform.system()}")

    def _list_devices_windows(self) -> Dict[str, List[Dict[str, Any]]]:
        """Windows-specific device enumeration using pyaudiowpatch."""
        seen_inputs = {}
        seen_outputs = {}
        seen_loopbacks = {}

        device_count = self.pa.get_device_count()

        for i in range(device_count):
            try:
                device_info = self.pa.get_device_info_by_index(i)
                name = device_info.get("name", "Unknown")

                if is_blocked_windows_device_name(name):
                    continue

                device_data = build_device_record(
                    device_id=i,
                    name=name,
                    channels=device_info.get("maxInputChannels", 0),
                    sample_rate=int(device_info.get("defaultSampleRate", 44100)),
                    host_api=self.pa.get_host_api_info_by_index(
                        device_info.get("hostApi", 0)
                    ).get("name", "Unknown"),
                )

                is_loopback = device_info.get("isLoopbackDevice", False)

                if is_loopback:
                    dedupe_device_by_name(seen_loopbacks, device_data)
                elif device_info.get("maxInputChannels", 0) > 0:
                    dedupe_device_by_name(seen_inputs, device_data)
                elif device_info.get("maxOutputChannels", 0) > 0:
                    dedupe_device_by_name(seen_outputs, device_data)

            except Exception as e:
                print(f"Warning: Could not read device {i}: {e}", file=sys.stderr)
                continue

        return {
            "input_devices": sort_devices_by_name(seen_inputs.values()),
            "output_devices": sort_devices_by_name(seen_outputs.values()),
            "loopback_devices": sort_devices_by_name(seen_loopbacks.values()),
        }

    def _list_devices_macos(self) -> Dict[str, List[Dict[str, Any]]]:
        """macOS-specific device enumeration using sounddevice."""
        input_devices = []
        output_devices = []
        loopback_devices = macos_virtual_loopback_devices()

        try:
            devices = sd.query_devices()
        except Exception as e:
            print(f"ERROR: Could not enumerate audio devices: {e}", file=sys.stderr)
            print(f"Microphone permission may not be granted.", file=sys.stderr)
            print(f"Grant permission in: System Settings > Privacy & Security > Microphone", file=sys.stderr)

            return {
                "input_devices": [],
                "output_devices": [],
                "loopback_devices": loopback_devices
            }

        for i, device in enumerate(devices):
            if device['max_input_channels'] == 0 and device['max_output_channels'] == 0:
                continue

            device_data = build_device_record(
                device_id=i,
                name=device['name'],
                channels=device['max_input_channels'],
                sample_rate=int(device['default_samplerate']),
                host_api=sd.query_hostapis(device['hostapi'])['name'],
            )

            if device['max_input_channels'] > 0:
                input_devices.append(device_data)

            if device['max_output_channels'] > 0:
                output_device = device_data.copy()
                output_device['channels'] = device['max_output_channels']
                output_devices.append(output_device)

        return {
            "input_devices": sort_devices_by_name(input_devices),
            "output_devices": sort_devices_by_name(output_devices),
            "loopback_devices": loopback_devices,
        }

    def validate_input_device(self, device_id: int, *, label: str = "Microphone") -> None:
        """Raise ValueError when device_id is not a usable input device."""
        if IS_WINDOWS:
            device_count = self.pa.get_device_count()
            if device_id < 0 or device_id >= device_count:
                raise ValueError(f"{label} device ID {device_id} is out of range (0-{device_count - 1})")
            device_info = self.pa.get_device_info_by_index(device_id)
            if device_info.get("maxInputChannels", 0) <= 0:
                raise ValueError(f"{label} device {device_id} has no input channels")
            return

        if IS_MACOS:
            devices = sd.query_devices()
            if device_id < 0 or device_id >= len(devices):
                raise ValueError(f"{label} device ID {device_id} is out of range (0-{len(devices) - 1})")
            if devices[device_id]["max_input_channels"] <= 0:
                raise ValueError(f"{label} device {device_id} has no input channels")
            return

        raise ValueError(f"{label} device validation is not supported on this platform")

    def get_device_info(self, device_id: int) -> Dict[str, Any]:
        """
        Get detailed information for a specific device.

        Args:
            device_id: Device index

        Returns:
            Dictionary with device details
        """
        if IS_WINDOWS:
            return self._get_device_info_windows(device_id)
        elif IS_MACOS:
            return self._get_device_info_macos(device_id)

        return {"error": f"Unsupported platform: {platform.system()}"}

    def _get_device_info_windows(self, device_id: int) -> Dict[str, Any]:
        """Windows-specific device info retrieval."""
        try:
            device_info = self.pa.get_device_info_by_index(device_id)
            return {
                "id": device_id,
                "name": device_info.get("name", "Unknown"),
                "max_input_channels": device_info.get("maxInputChannels", 0),
                "max_output_channels": device_info.get("maxOutputChannels", 0),
                "default_sample_rate": device_info.get("defaultSampleRate", 0),
                "is_loopback": device_info.get("isLoopbackDevice", False),
                "host_api": self.pa.get_host_api_info_by_index(
                    device_info.get("hostApi", 0)
                ).get("name", "Unknown")
            }
        except Exception as e:
            return {"error": str(e)}

    def _get_device_info_macos(self, device_id: int) -> Dict[str, Any]:
        """macOS-specific device info retrieval."""
        try:
            device = sd.query_devices(device_id)
            return {
                "id": device_id,
                "name": device['name'],
                "max_input_channels": device['max_input_channels'],
                "max_output_channels": device['max_output_channels'],
                "default_sample_rate": device['default_samplerate'],
                "is_loopback": False,  # macOS doesn't have native loopback devices
                "host_api": sd.query_hostapis(device['hostapi'])['name']
            }
        except Exception as e:
            return {"error": str(e)}

    def get_default_devices(self) -> Dict[str, int]:
        """
        Get the default input and output device IDs.

        Returns:
            Dictionary with 'default_input' and 'default_output' device IDs
        """
        if IS_WINDOWS:
            return self._get_default_devices_windows()
        elif IS_MACOS:
            return self._get_default_devices_macos()

        return {"default_input": -1, "default_output": -1}

    def _get_default_devices_windows(self) -> Dict[str, int]:
        """Windows-specific default device retrieval."""
        try:
            default_input = self.pa.get_default_input_device_info()
            default_output = self.pa.get_default_output_device_info()

            return {
                "default_input": default_input.get("index", -1),
                "default_output": default_output.get("index", -1)
            }
        except Exception as e:
            print(f"Warning: Could not get default devices: {e}", file=sys.stderr)
            return {"default_input": -1, "default_output": -1}

    def _get_default_devices_macos(self) -> Dict[str, int]:
        """macOS-specific default device retrieval."""
        try:
            default_input = sd.query_devices(kind='input')
            default_output = sd.query_devices(kind='output')

            # sounddevice returns device info directly, need to find the index
            input_idx = -1
            output_idx = -1

            devices = sd.query_devices()
            for i, device in enumerate(devices):
                if device['name'] == default_input['name']:
                    input_idx = i
                if device['name'] == default_output['name']:
                    output_idx = i

            return {
                "default_input": input_idx,
                "default_output": output_idx
            }
        except Exception as e:
            print(f"Warning: Could not get default devices: {e}", file=sys.stderr)
            return {"default_input": -1, "default_output": -1}


def main():
    """
    Command-line interface for testing device enumeration.
    Outputs JSON to stdout for easy parsing by Electron.
    """
    try:
        manager = DeviceManager()
    except DeviceManagerEnvironmentError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    # Get all devices
    devices = manager.list_all_devices()

    # Get default devices
    defaults = manager.get_default_devices()

    # Combine into single output
    output = {
        **devices,
        "defaults": defaults
    }

    # Output as JSON
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
