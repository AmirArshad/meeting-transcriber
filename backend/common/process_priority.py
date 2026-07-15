"""Best-effort process priority lowering for batch AI children.

Transcription and diarization should not starve live audio capture when both
run at once. Call unconditionally at CLI ``main()`` entry — Node has no portable
spawn-time priority on Windows, and capture may start after the child is already
running.
"""

from __future__ import annotations

import os
import sys


def lower_process_priority() -> bool:
    """Lower this process to below-normal priority. Returns True on success."""
    try:
        if sys.platform == "win32":
            import ctypes

            # BELOW_NORMAL_PRIORITY_CLASS
            below_normal = 0x00004000
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            return bool(ctypes.windll.kernel32.SetPriorityClass(handle, below_normal))

        # POSIX: nice(+5) is a modest below-normal nudge; ignore permission errors.
        os.nice(5)
        return True
    except Exception:
        return False
