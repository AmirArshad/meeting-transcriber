"""
Audio Device Manager - Enumerates available audio input/output devices.

Platform-specific implementations:
- Windows: Uses pyaudiowpatch for WASAPI loopback support
- macOS: Uses sounddevice for device enumeration
"""

import json
import sys
import platform
from typing import Dict, List, Any

# Platform detection
IS_WINDOWS = platform.system() == 'Windows'
IS_MACOS = platform.system() == 'Darwin'

# Import platform-specific audio library
if IS_WINDOWS:
    try:
        import pyaudiowpatch as pyaudio
    except ImportError:
        print("ERROR: pyaudiowpatch not installed. Run: pip install pyaudiowpatch", file=sys.stderr)
        sys.exit(1)
elif IS_MACOS:
    try:
        import sounddevice as sd
    except ImportError:
        print("ERROR: sounddevice not installed. Run: pip install sounddevice", file=sys.stderr)
        sys.exit(1)
else:
    print(f"ERROR: Unsupported platform: {platform.system()}", file=sys.stderr)
    sys.exit(1)


class DeviceManager:
    """Manages audio device enumeration and information retrieval."""

    def __init__(self):
        if IS_WINDOWS:
            self.pa = pyaudio.PyAudio()
        elif IS_MACOS:
            self.pa = None  # sounddevice doesn't need initialization

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

    def _list_devices_windows(self) -> Dict[str, List[Dict[str, Any]]]:
        """Windows-specific device enumeration using pyaudiowpatch."""
        input_devices = []
        output_devices = []
        loopback_devices = []

        # Track seen devices to remove duplicates
        # Map name -> device_data
        seen_inputs = {}
        seen_outputs = {}
        seen_loopbacks = {}

        device_count = self.pa.get_device_count()

        for i in range(device_count):
            try:
                device_info = self.pa.get_device_info_by_index(i)
                name = device_info.get("name", "Unknown")

                # Filter out system mappers/drivers which are usually duplicates
                # Check if name contains blocked terms (handles "[Loopback]" suffix)
                if any(blocked in name for blocked in [
                    "Microsoft Sound Mapper",
                    "Primary Sound Capture Driver",
                    "Primary Sound Driver"
                ]):
                    continue

                device_data = {
                    "id": i,
                    "name": name,
                    "channels": device_info.get("maxInputChannels", 0),
                    "sample_rate": int(device_info.get("defaultSampleRate", 44100)),
                    "host_api": self.pa.get_host_api_info_by_index(
                        device_info.get("hostApi", 0)
                    ).get("name", "Unknown")
                }

                # Check if device is a loopback device (WASAPI specific)
                is_loopback = device_info.get("isLoopbackDevice", False)

                if is_loopback:
                    # For loopback, we want unique names
                    if name not in seen_loopbacks:
                        seen_loopbacks[name] = device_data
                    else:
                        # If duplicate, keep the one with higher sample rate
                        if device_data["sample_rate"] > seen_loopbacks[name]["sample_rate"]:
                            seen_loopbacks[name] = device_data

                elif device_info.get("maxInputChannels", 0) > 0:
                    # For inputs, we want unique names
                    # MME is usually the most compatible host API on Windows, but WASAPI is better quality
                    # For now, we'll just deduplicate by name and prefer higher sample rate
                    if name not in seen_inputs:
                        seen_inputs[name] = device_data
                    else:
                        if device_data["sample_rate"] > seen_inputs[name]["sample_rate"]:
                            seen_inputs[name] = device_data

                elif device_info.get("maxOutputChannels", 0) > 0:
                    if name not in seen_outputs:
                        seen_outputs[name] = device_data
                    else:
                        if device_data["sample_rate"] > seen_outputs[name]["sample_rate"]:
                            seen_outputs[name] = device_data

            except Exception as e:
                print(f"Warning: Could not read device {i}: {e}", file=sys.stderr)
                continue

        # Convert dict values back to lists
        input_devices = list(seen_inputs.values())
        output_devices = list(seen_outputs.values())
        loopback_devices = list(seen_loopbacks.values())

        # Sort by name for cleaner UI
        input_devices.sort(key=lambda x: x['name'])
        output_devices.sort(key=lambda x: x['name'])
        loopback_devices.sort(key=lambda x: x['name'])

        return {
            "input_devices": input_devices,
            "output_devices": output_devices,
            "loopback_devices": loopback_devices
        }

    def _list_devices_macos(self) -> Dict[str, List[Dict[str, Any]]]:
        """macOS-specific device enumeration using sounddevice."""
        input_devices = []
        output_devices = []
        loopback_devices = []  # macOS doesn't have native loopback, will be empty for now

        devices = sd.query_devices()

        for i, device in enumerate(devices):
            # Skip devices with no channels
            if device['max_input_channels'] == 0 and device['max_output_channels'] == 0:
                continue

            device_data = {
                "id": i,
                "name": device['name'],
                "channels": device['max_input_channels'],
                "sample_rate": int(device['default_samplerate']),
                "host_api": sd.query_hostapis(device['hostapi'])['name']
            }

            if device['max_input_channels'] > 0:
                input_devices.append(device_data)

            if device['max_output_channels'] > 0:
                output_device = device_data.copy()
                output_device['channels'] = device['max_output_channels']
                output_devices.append(output_device)

        # Sort by name
        input_devices.sort(key=lambda x: x['name'])
        output_devices.sort(key=lambda x: x['name'])

        return {
            "input_devices": input_devices,
            "output_devices": output_devices,
            "loopback_devices": loopback_devices  # Empty for now, will use ScreenCaptureKit
        }

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
    manager = DeviceManager()

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
