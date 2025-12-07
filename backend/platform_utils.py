"""
Platform detection and utility functions.
"""

import platform


def get_platform():
    """
    Get the current platform.

    Returns:
        str: 'windows', 'macos', or 'linux'
    """
    system = platform.system()
    if system == 'Windows':
        return 'windows'
    elif system == 'Darwin':
        return 'macos'
    elif system == 'Linux':
        return 'linux'
    else:
        return 'unknown'


def is_windows():
    """Check if running on Windows."""
    return platform.system() == 'Windows'


def is_macos():
    """Check if running on macOS."""
    return platform.system() == 'Darwin'


def is_linux():
    """Check if running on Linux."""
    return platform.system() == 'Linux'


def get_platform_info():
    """
    Get detailed platform information.

    Returns:
        dict: Platform details including OS, version, architecture
    """
    return {
        'system': platform.system(),
        'release': platform.release(),
        'version': platform.version(),
        'machine': platform.machine(),
        'processor': platform.processor(),
        'platform': get_platform()
    }
