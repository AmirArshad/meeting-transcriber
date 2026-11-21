"""Keep Windows Summaries & Chat launcher descendants in a queryable job."""

import ctypes
from ctypes import wintypes
import os
import subprocess
import sys


class BasicLimits(ctypes.Structure):
    _fields_ = [
        ("process_time", ctypes.c_longlong),
        ("job_time", ctypes.c_longlong),
        ("flags", wintypes.DWORD),
        ("min_working_set", ctypes.c_size_t),
        ("max_working_set", ctypes.c_size_t),
        ("active_limit", wintypes.DWORD),
        ("affinity", ctypes.c_size_t),
        ("priority", wintypes.DWORD),
        ("scheduling_class", wintypes.DWORD),
    ]


class ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("basic", BasicLimits),
        ("io_counters", ctypes.c_ulonglong * 6),
        ("process_memory_limit", ctypes.c_size_t),
        ("job_memory_limit", ctypes.c_size_t),
        ("peak_process_memory", ctypes.c_size_t),
        ("peak_job_memory", ctypes.c_size_t),
    ]


class BasicAccounting(ctypes.Structure):
    _fields_ = [
        ("times", ctypes.c_longlong * 4),
        ("page_faults", wintypes.DWORD),
        ("total_processes", wintypes.DWORD),
        ("active_processes", wintypes.DWORD),
        ("terminated_processes", wintypes.DWORD),
    ]


def windows_api():
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    handle, dword, pointer = wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p
    signatures = {
        "CreateJobObjectW": (handle, [pointer, wintypes.LPCWSTR]),
        "OpenJobObjectW": (handle, [dword, wintypes.BOOL, wintypes.LPCWSTR]),
        "SetInformationJobObject": (wintypes.BOOL, [handle, ctypes.c_int, pointer, dword]),
        "QueryInformationJobObject": (wintypes.BOOL, [handle, ctypes.c_int, pointer, dword, pointer]),
        "AssignProcessToJobObject": (wintypes.BOOL, [handle, handle]),
        "GetCurrentProcess": (handle, []),
        "CloseHandle": (wintypes.BOOL, [handle]),
    }
    for name, (result, arguments) in signatures.items():
        function = getattr(api, name)
        function.restype = result
        function.argtypes = arguments
    return api


def run(api, name, command):
    job = api.CreateJobObjectW(None, name)
    if not job or ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        raise ctypes.WinError(ctypes.get_last_error())
    limits = ExtendedLimits()
    limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not api.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not api.AssignProcessToJobObject(job, api.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
    # Keep the non-inherited job handle open until this launcher exits. A forced
    # launcher exit closes it as well, terminating any remaining model processes.
    return subprocess.call(command, close_fds=False)


def check(api, name):
    job = api.OpenJobObjectW(4, False, name)  # JOB_OBJECT_QUERY
    if not job:
        if ctypes.get_last_error() == 2:  # ERROR_FILE_NOT_FOUND
            return 0
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        accounting = BasicAccounting()
        if not api.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return 1 if accounting.active_processes else 0
    finally:
        api.CloseHandle(job)


def main():
    mode, name, *args = sys.argv[1:]
    if os.name != "nt" or not name.startswith("Local\\AvaNevis-Summary-"):
        return 2
    api = windows_api()
    if mode == "check" and not args:
        return check(api, name)
    if mode == "python":
        return run(api, name, [sys.executable, *args])
    if mode == "server" and args:
        return run(api, name, args)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"Could not manage the local model process tree: {error}", file=sys.stderr)
        sys.exit(2)
