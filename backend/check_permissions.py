"""
Check macOS permissions for microphone and screen recording.

This script checks if the app has the necessary permissions to function properly
and provides helpful error messages if permissions are missing.

Outputs JSON to stdout with permission status.
"""

import json
import sys
import platform
import argparse

def get_macos_version() -> tuple:
    """
    Get macOS version as tuple (major, minor).

    Returns:
        Tuple of (major, minor) version numbers, e.g., (14, 0) for Sonoma
    """
    try:
        version_str = platform.mac_ver()[0]
        parts = version_str.split('.')
        major = int(parts[0]) if len(parts) > 0 else 0
        minor = int(parts[1]) if len(parts) > 1 else 0
        return (major, minor)
    except Exception:
        return (0, 0)


def check_macos_version_compatibility() -> tuple:
    """
    Check if macOS version supports ScreenCaptureKit.

    ScreenCaptureKit requires macOS 13 (Ventura) or later.

    Returns:
        Tuple of (is_compatible, version_string, warning_message)
    """
    version = get_macos_version()
    version_str = f"{version[0]}.{version[1]}"

    if version[0] >= 13:
        return True, version_str, None
    elif version[0] >= 12:
        return False, version_str, (
            f"macOS {version_str} detected. ScreenCaptureKit requires macOS 13 (Ventura) or later. "
            "Desktop audio capture will not be available. Only microphone recording will work."
        )
    else:
        return False, version_str, (
            f"macOS {version_str} detected. This version is not supported. "
            "Please upgrade to macOS 13 (Ventura) or later for full functionality."
        )


def check_microphone_permission(mic_device_id: int | None = None) -> tuple[bool, str]:
    """
    Check if the app has microphone permission.

    Returns:
        Tuple of (has_permission, error_message)
    """
    try:
        import sounddevice as sd

        # Try to query devices - this requires microphone permission
        devices = sd.query_devices()

        # Check if we got any input devices
        has_input = any(d['max_input_channels'] > 0 for d in devices)

        if not has_input:
            return False, "No input devices found (permission may be denied)"

        if mic_device_id is not None:
            try:
                selected_device = devices[mic_device_id]
            except Exception:
                return False, f"Selected microphone device (ID: {mic_device_id}) not found"

            input_channels = int(selected_device.get('max_input_channels', 0))
            if input_channels <= 0:
                return False, f"Selected microphone device (ID: {mic_device_id}) has no input channels"

            if getattr(sd, 'InputStream', None) is None:
                return False, "Cannot open selected microphone: sounddevice InputStream is unavailable"

            sample_rate = 48000
            channels = min(input_channels, 2)

            try:
                # Opening the selected stream verifies the specific TCC/device path
                # that recording will use, not just that devices can be listed.
                with sd.InputStream(
                    device=mic_device_id,
                    channels=channels,
                    samplerate=sample_rate,
                    blocksize=256,
                ):
                    pass
            except Exception as e:
                return False, f"Cannot open selected microphone device (ID: {mic_device_id}): {e}"

        return True, ""

    except Exception as e:
        return False, f"Cannot access audio devices: {e}"


def _is_swift_capture_available() -> tuple[bool, str]:
    try:
        try:
            from audio.swift_audio_capture import is_swift_capture_available
        except ImportError:
            from backend.audio.swift_audio_capture import is_swift_capture_available

        if is_swift_capture_available():
            return True, ""
        return False, "audiocapture-helper not available"
    except Exception as e:
        return False, str(e)


def _is_pyobjc_screencapture_available() -> tuple[bool, str]:
    try:
        import ScreenCaptureKit  # noqa: F401
        import AVFoundation  # noqa: F401
        import CoreAudio  # noqa: F401
        return True, ""
    except Exception as e:
        return False, str(e)


def check_desktop_audio_capture_availability() -> tuple[bool, str | None, str]:
    """
    Check whether this runtime has a desktop-audio backend available.

    Returns:
        Tuple of (available, backend_name, error_message)
    """
    swift_available, swift_error = _is_swift_capture_available()
    if swift_available:
        return True, "swift", ""

    pyobjc_available, pyobjc_error = _is_pyobjc_screencapture_available()
    if pyobjc_available:
        return True, "pyobjc", "Swift audiocapture-helper unavailable; using PyObjC ScreenCaptureKit fallback"

    return False, None, (
        "Desktop audio capture backend unavailable. "
        f"Swift helper: {swift_error or 'not available'}. "
        f"PyObjC fallback: {pyobjc_error or 'not available'}."
    )


def _check_screen_recording_permission_with_swift_helper() -> tuple[bool, str] | None:
    try:
        try:
            from audio.swift_audio_capture import check_screen_recording_permission_detail
        except ImportError:
            from backend.audio.swift_audio_capture import check_screen_recording_permission_detail

        return check_screen_recording_permission_detail()
    except Exception as e:
        print(f"Warning: Swift helper permission check unavailable: {e}", file=sys.stderr)
        return None


def check_screen_recording_permission() -> tuple[bool, str]:
    """
    Check if the app has Screen Recording permission.

    This permission is required for ScreenCaptureKit to capture desktop audio.

    Returns:
        Tuple of (has_permission, error_message)
    """
    swift_result = _check_screen_recording_permission_with_swift_helper()
    if swift_result is not None:
        swift_granted, swift_error = swift_result
        if swift_granted:
            return True, ""

        swift_error_lower = (swift_error or "").lower()

        # If the shipped helper is available, its result matches the runtime path.
        if "not available" not in swift_error_lower and "not found" not in swift_error_lower:
            return False, swift_error or "Screen Recording permission denied"

    try:
        from ScreenCaptureKit import SCShareableContent
        from Foundation import NSRunLoop, NSDate

        # Track permission status
        permission_granted = [None]  # Use list for callback modification
        error_message = [None]

        def completion_handler(content, error):
            """Callback when shareable content is retrieved."""
            if error:
                permission_granted[0] = False
                error_message[0] = str(error)
            else:
                permission_granted[0] = True

        # Request shareable content (triggers permission prompt if needed)
        SCShareableContent.getShareableContentWithCompletionHandler_(completion_handler)

        # Run the event loop for up to 2 seconds to wait for callback
        timeout = NSDate.dateWithTimeIntervalSinceNow_(2.0)
        NSRunLoop.currentRunLoop().runUntilDate_(timeout)

        # Check result
        if permission_granted[0] is None:
            return False, "Timeout waiting for Screen Recording permission check"
        elif permission_granted[0]:
            return True, ""
        else:
            return False, error_message[0] or "Screen Recording permission denied"

    except ImportError as e:
        return False, f"ScreenCaptureKit not available: {e}"
    except Exception as e:
        return False, f"Error checking Screen Recording permission: {e}"


def main():
    """
    Check all permissions and output JSON result.
    """
    parser = argparse.ArgumentParser(description="Check macOS recording permissions")
    parser.add_argument("--mic-device-id", type=int, default=None, help="Selected microphone device ID to open-test")
    args = parser.parse_args()

    if platform.system() != 'Darwin':
        print(json.dumps({
            "platform": platform.system(),
            "microphone": {"granted": True},
            "screen_recording": {"granted": True},
            "desktop_audio": {"available": True, "backend": "native"},
            "all_granted": True,
            "message": "Permission checks only needed on macOS"
        }))
        sys.exit(0)

    # Check macOS version compatibility first
    version_compatible, version_str, version_warning = check_macos_version_compatibility()

    # Check microphone permission
    mic_granted, mic_error = check_microphone_permission(args.mic_device_id)

    # Check whether the selected macOS runtime can capture desktop audio at all.
    if version_compatible:
        desktop_available, desktop_backend, desktop_error = check_desktop_audio_capture_availability()
    else:
        desktop_available = False
        desktop_backend = None
        desktop_error = version_warning

    # Check screen recording permission (only if macOS version supports it)
    if not version_compatible:
        screen_granted = False
        screen_error = version_warning
    elif desktop_available:
        screen_granted, screen_error = check_screen_recording_permission()
    else:
        # No capture backend means Screen Recording cannot be meaningfully tested.
        # Report the backend problem separately so the UI does not send users to
        # privacy settings for a packaging/runtime failure.
        screen_granted = True
        screen_error = ""

    # Prepare result
    result = {
        "platform": "darwin",
        "macos_version": {
            "version": version_str,
            "compatible": version_compatible,
            "warning": version_warning
        },
        "microphone": {
            "granted": mic_granted,
            "error": mic_error if not mic_granted else None
        },
        "screen_recording": {
            "granted": screen_granted,
            "error": screen_error if not screen_granted else None
        },
        "desktop_audio": {
            "available": desktop_available,
            "backend": desktop_backend,
            "error": desktop_error if not desktop_available else None
        },
        "all_granted": mic_granted and screen_granted and desktop_available
    }

    # Add helpful messages
    if not mic_granted:
        result["microphone"]["help"] = (
            "Grant microphone permission in: "
            "System Settings > Privacy & Security > Microphone"
        )

    if not screen_granted and version_compatible:
        result["screen_recording"]["help"] = (
            "Grant Screen Recording permission in: "
            "System Settings > Privacy & Security > Screen Recording"
        )
    elif not version_compatible:
        result["screen_recording"]["help"] = (
            "Upgrade to macOS 13 (Ventura) or later to enable desktop audio capture."
        )

    if not desktop_available:
        result["desktop_audio"]["help"] = (
            "Reinstall AvaNevis or rebuild the macOS package so the bundled "
            "audiocapture-helper is present and signed."
        )

    # Output JSON
    print(json.dumps(result, indent=2), file=sys.stdout)

    # Exit with error code if any required permission or capture backend is missing
    if not result["all_granted"]:
        sys.exit(1)

    sys.exit(0)


if __name__ == "__main__":
    main()
