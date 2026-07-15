"""Tests for batch AI child process priority lowering."""

from __future__ import annotations

import sys
import unittest
from unittest import mock

from common.process_priority import lower_process_priority


class ProcessPriorityTests(unittest.TestCase):
    def test_lower_process_priority_posix_calls_nice(self):
        if sys.platform == "win32":
            self.skipTest("POSIX nice path")
        with mock.patch("common.process_priority.os.nice") as nice:
            nice.return_value = 5
            self.assertTrue(lower_process_priority())
            nice.assert_called_once_with(5)

    def test_lower_process_priority_windows_sets_below_normal(self):
        if sys.platform != "win32":
            self.skipTest("Windows SetPriorityClass path")
        with mock.patch("ctypes.windll.kernel32.GetCurrentProcess", return_value=1):
            with mock.patch("ctypes.windll.kernel32.SetPriorityClass", return_value=1) as set_priority:
                self.assertTrue(lower_process_priority())
                set_priority.assert_called_once()
                self.assertEqual(set_priority.call_args[0][1], 0x00004000)

    def test_lower_process_priority_swallows_errors(self):
        with mock.patch("common.process_priority.sys.platform", "linux"):
            with mock.patch(
                "common.process_priority.os.nice",
                side_effect=PermissionError("denied"),
                create=True,
            ):
                self.assertFalse(lower_process_priority())


if __name__ == "__main__":
    unittest.main()
