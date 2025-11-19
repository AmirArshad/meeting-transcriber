"""
Audio Device Manager - Enumerates available audio input/output devices.
Uses pyaudiowpatch for WASAPI loopback support on Windows.
"""

import json
import sys
from typing import Dict, List, Any

try:
    import pyaudiowpatch as pyaudio
except ImportError:
    print("ERROR: pyaudiowpatch not installed. Run: pip install pyaudiowpatch", file=sys.stderr)
    sys.exit(1)


class DeviceManager:
    """Manages audio device enumeration and information retrieval."""

    def __init__(self):
        self.pa = pyaudio.PyAudio()

    def __del__(self):
        """Clean up PyAudio instance."""
        if hasattr(self, 'pa'):
            self.pa.terminate()

    def list_all_devices(self) -> Dict[str, List[Dict[str, Any]]]:
        """
        Enumerate all audio devices and categorize them.

        Returns:
            Dictionary with 'input_devices', 'output_devices', and 'loopback_devices'
        """
        input_devices = []
        output_devices = []
        loopback_devices = []

        device_count = self.pa.get_device_count()

        for i in range(device_count):
            try:
                device_info = self.pa.get_device_info_by_index(i)

                device_data = {
                    "id": i,
                    "name": device_info.get("name", "Unknown"),
                    "channels": device_info.get("maxInputChannels", 0),
                    "sample_rate": int(device_info.get("defaultSampleRate", 44100)),
                    "host_api": self.pa.get_host_api_info_by_index(
                        device_info.get("hostApi", 0)
                    ).get("name", "Unknown")
                }

                # Check if device is a loopback device (WASAPI specific)
                is_loopback = device_info.get("isLoopbackDevice", False)

                if is_loopback:
                    loopback_devices.append(device_data)
                elif device_info.get("maxInputChannels", 0) > 0:
                    input_devices.append(device_data)
                elif device_info.get("maxOutputChannels", 0) > 0:
                    # Store output devices for reference
                    output_devices.append(device_data)

            except Exception as e:
                print(f"Warning: Could not read device {i}: {e}", file=sys.stderr)
                continue

        return {
            "input_devices": input_devices,
            "output_devices": output_devices,
            "loopback_devices": loopback_devices
        }

    def get_device_info(self, device_id: int) -> Dict[str, Any]:
        """
        Get detailed information for a specific device.

        Args:
            device_id: Device index

        Returns:
            Dictionary with device details
        """
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

    def get_default_devices(self) -> Dict[str, int]:
        """
        Get the default input and output device IDs.

        Returns:
            Dictionary with 'default_input' and 'default_output' device IDs
        """
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
