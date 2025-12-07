"""
macOS-specific device enumeration helper.

This will be integrated into device_manager.py once tested.
"""

import sounddevice as sd
from typing import Dict, List, Any


def list_devices_macos() -> Dict[str, List[Dict[str, Any]]]:
    """
    Enumerate macOS audio devices using sounddevice.

    Returns:
        Dictionary with 'input_devices', 'output_devices', and 'loopback_devices'
    """
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


if __name__ == "__main__":
    import json
    devices = list_devices_macos()
    print(json.dumps(devices, indent=2))
