"""Expose pip-installed NVIDIA CUDA DLL directories on Windows."""

from __future__ import annotations

import os
import site
import sys
from pathlib import Path


_NVIDIA_DLL_DIRECTORY_HANDLES: list[object] = []


def add_python_nvidia_bin_dirs_to_path() -> None:
    """Expose pip-installed NVIDIA DLL directories to CTranslate2 on Windows."""
    if os.name != "nt":
        return

    try:
        candidate_dirs = []
        site_package_paths = []
        try:
            site_package_paths.extend(getattr(site, "getsitepackages", lambda: [])() or [])
        except Exception:
            pass
        try:
            user_site = getattr(site, "getusersitepackages", lambda: "")()
            if user_site:
                site_package_paths.append(user_site)
        except Exception:
            pass
        site_package_paths.extend(sys.path)
        seen = set()
        for site_packages in site_package_paths:
            if not site_packages:
                continue
            site_packages = str(site_packages)
            if site_packages in seen:
                continue
            seen.add(site_packages)
            root = Path(site_packages) / "nvidia"
            candidate_dirs.extend([
                root / "cublas" / "bin",
                root / "cudnn" / "bin",
            ])

        existing = [str(candidate) for candidate in candidate_dirs if candidate.exists()]
        if not existing:
            return

        os.environ["PATH"] = os.pathsep.join([*existing, os.environ.get("PATH", "")])
        add_dll_directory = getattr(os, "add_dll_directory", None)
        if add_dll_directory:
            for dll_dir in existing:
                _NVIDIA_DLL_DIRECTORY_HANDLES.append(add_dll_directory(dll_dir))
    except Exception:
        return
