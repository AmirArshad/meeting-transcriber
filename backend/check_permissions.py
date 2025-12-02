"""
Check macOS permissions for microphone and screen recording.

This script checks if the app has the necessary permissions to function properly
and provides helpful error messages if permissions are missing.

Outputs JSON to stdout with permission status.
"""

import json
import sys
import platform

# Only run on macOS
if platform.system() != 'Darwin':
    print(json.dumps({
        "platform": platform.system(),
        "microphone": True,
        "screen_recording": True,
        "message": "Permission checks only needed on macOS"
    }))
    sys.exit(0)


def check_microphone_permission() -> tuple[bool, str]:
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

        return True, ""

    except Exception as e:
        return False, f"Cannot access audio devices: {e}"


def check_screen_recording_permission() -> tuple[bool, str]:
    """
    Check if the app has Screen Recording permission.

    This permission is required for ScreenCaptureKit to capture desktop audio.

    Returns:
        Tuple of (has_permission, error_message)
    """
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
    # Check microphone permission
    mic_granted, mic_error = check_microphone_permission()

    # Check screen recording permission
    screen_granted, screen_error = check_screen_recording_permission()

    # Prepare result
    result = {
        "platform": "darwin",
        "microphone": {
            "granted": mic_granted,
            "error": mic_error if not mic_granted else None
        },
        "screen_recording": {
            "granted": screen_granted,
            "error": screen_error if not screen_granted else None
        },
        "all_granted": mic_granted and screen_granted
    }

    # Add helpful messages
    if not mic_granted:
        result["microphone"]["help"] = (
            "Grant microphone permission in: "
            "System Settings > Privacy & Security > Microphone"
        )

    if not screen_granted:
        result["screen_recording"]["help"] = (
            "Grant Screen Recording permission in: "
            "System Settings > Privacy & Security > Screen Recording"
        )

    # Output JSON
    print(json.dumps(result, indent=2), file=sys.stdout)

    # Exit with error code if any permission is missing
    if not (mic_granted and screen_granted):
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
