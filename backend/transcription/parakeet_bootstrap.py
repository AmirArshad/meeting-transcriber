"""Import isolation for a Parakeet child.

This module must stay importable without onnxruntime, mlx, or any add-on
site-packages. It prepares sys.path and rejects unsafe wheel entries.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import sysconfig
import zipfile
from pathlib import Path
from typing import Iterable, List, Optional, Sequence


LIBRARY_SUFFIXES = (".dll", ".pyd", ".dylib", ".so")
_DISALLOWED_IMPORT_PARTS = {"site-packages", "dist-packages"}
# Tiny Identity graph used only to prove a CUDA session executes. It is not a model download.
_CUDA_PROBE_MODEL = bytes.fromhex(
    "08084202100d3a550a190a05696e70757412066f757470757422084964656e74697479"
    "120570726f62655a170a05696e707574120e0a0c080112080a0208010a02080462180a"
    "066f7574707574120e0a0c080112080a0208010a020804"
)
_DLL_DIR_HANDLES: List[object] = []


def _is_disallowed_import_root(entry: str) -> bool:
    parts = [part for part in str(entry).replace("\\", "/").split("/") if part]
    return any(part in _DISALLOWED_IMPORT_PARTS for part in parts)


def read_pth_paths(pth_file: Path) -> List[str]:
    """Resolve embedded ``._pth`` entries beside that file, not the process cwd.

    ``import site`` is ignored. Enabling site would pull ambient site-packages
    back onto the path the ``_pth`` file is meant to control.
    """
    pth = Path(pth_file)
    root = pth.resolve().parent
    paths: List[str] = []
    for line in pth.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped == "import site":
            continue
        candidate = Path(stripped)
        if candidate.is_absolute():
            paths.append(str(candidate))
        else:
            paths.append(str((root / candidate).resolve()))
    return paths


def positive_stdlib_paths(*, executable: Optional[str] = None) -> List[str]:
    """Return standard-library roots only.

    Ambient ``sys.path`` entries are not filtered by name. ``dist-packages`` and
    other non-stdlib directories stay off the path because they are never added.
    """
    found: List[str] = []

    def add(entry: Optional[str]) -> None:
        if not entry:
            return
        text = str(entry)
        if text in found or _is_disallowed_import_root(text):
            return
        found.append(text)

    for key in ("stdlib", "platstdlib"):
        add(sysconfig.get_path(key))
    stdlib = sysconfig.get_path("stdlib")
    if stdlib:
        dynload = Path(stdlib) / "lib-dynload"
        if dynload.is_dir():
            add(str(dynload))
    exe = Path(executable or sys.executable).resolve()
    bundled_zip = exe.parent / f"python{sys.version_info.major}{sys.version_info.minor}.zip"
    if bundled_zip.is_file():
        add(str(bundled_zip))
    return found


def build_isolated_sys_path(
    *,
    runtime_dir: str,
    backend_dir: str,
    pth_file: Optional[str] = None,
    current_path: Optional[Sequence[str]] = None,
    ambient_pythonpath: str = "",
    stdlib_paths: Optional[Sequence[str]] = None,
    executable: Optional[str] = None,
) -> List[str]:
    """Return the only import roots a Parakeet child may use.

    A Windows ``python311._pth`` file contributes its listed roots. Standard
    library directories are added by identity. ``current_path`` is accepted so
    older callers keep working, and it is not an allowlist: ambient modules,
    ``site-packages``, and ``dist-packages`` are never copied in.
    """
    del current_path
    runtime = str(Path(runtime_dir).resolve())
    backend = str(Path(backend_dir).resolve())
    ordered: List[str] = []

    def add(entry: str) -> None:
        if entry and entry not in ordered and not _is_disallowed_import_root(entry):
            ordered.append(entry)

    add(runtime)
    add(backend)
    if pth_file:
        for entry in read_pth_paths(Path(pth_file)):
            add(entry)
    discovered = list(stdlib_paths) if stdlib_paths is not None else positive_stdlib_paths(executable=executable)
    for entry in discovered:
        add(str(entry))
    blocked = set(_ambient_entries(ambient_pythonpath))
    for entry in list(blocked):
        try:
            blocked.add(str(Path(entry).resolve()))
        except OSError:
            continue
    return [entry for entry in ordered if entry not in blocked]


def _ambient_entries(ambient_pythonpath: str) -> set[str]:
    if not ambient_pythonpath:
        return set()
    return {entry for entry in ambient_pythonpath.split(os.pathsep) if entry}


def apply_isolated_path(paths: Iterable[str]) -> None:
    sys.path[:] = list(paths)


def assert_device(actual: str, expected: str) -> None:
    if str(actual or "").strip().lower() in {"", "cpu"} or str(actual).strip().lower() != str(expected).strip().lower():
        raise SystemExit("PARAKEET_GPU_UNAVAILABLE")


def _unavailable_device() -> dict:
    return {"device": "cpu", "deviceAvailable": False}


def _retain_windows_dll_directories(runtime_dir: str) -> None:
    if os.name != "nt" or not hasattr(os, "add_dll_directory") or not runtime_dir:
        return
    root = Path(runtime_dir).resolve()
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        current = Path(dirpath)
        dirnames[:] = [name for name in dirnames if not (current / name).is_symlink()]
        if not any(name.lower().endswith(".dll") for name in filenames):
            continue
        try:
            _DLL_DIR_HANDLES.append(os.add_dll_directory(dirpath))
        except OSError:
            continue


def probe_cuda_device(
    runtime_dir: str = "",
    *,
    ort_module=None,
    array_module=None,
) -> dict:
    """Run a CUDA session inside this interpreter. Provider lists are not enough."""
    try:
        _retain_windows_dll_directories(runtime_dir)
        ort = ort_module
        if ort is None:
            import onnxruntime as ort  # type: ignore
        numpy = array_module
        if numpy is None:
            import numpy as numpy  # type: ignore
    except Exception:
        return _unavailable_device()
    try:
        if "CUDAExecutionProvider" not in list(ort.get_available_providers()):
            return _unavailable_device()
        session = ort.InferenceSession(_CUDA_PROBE_MODEL, providers=["CUDAExecutionProvider"])
        providers = list(session.get_providers())
        if not providers or providers[0] != "CUDAExecutionProvider":
            return _unavailable_device()
        output = session.run(None, {"input": numpy.ones((1, 4), dtype=numpy.float32)})
        if not output:
            return _unavailable_device()
        return {"device": "cuda", "deviceAvailable": True}
    except Exception:
        return _unavailable_device()


def probe_metal_device(*, mlx_core=None) -> dict:
    """Require Metal to be available and to evaluate a GPU operation."""
    try:
        mx = mlx_core
        if mx is None:
            import mlx.core as mx  # type: ignore
        if not mx.metal.is_available():
            return _unavailable_device()
        mx.set_default_device(mx.gpu)
        value = mx.ones((2, 2))
        result = value.sum()
        mx.eval(result)
        if float(result) != 4.0:
            return _unavailable_device()
        return {"device": "metal", "deviceAvailable": True}
    except Exception:
        return _unavailable_device()


def probe_device(expected: str, runtime_dir: str = "") -> dict:
    kind = str(expected or "").strip().lower()
    if kind == "cuda":
        return probe_cuda_device(runtime_dir)
    if kind == "metal":
        return probe_metal_device()
    return _unavailable_device()


def _is_unsafe_zip_name(name: str) -> bool:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or normalized.startswith("../") or "/../" in f"/{normalized}/":
        return True
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    return ".." in parts or any(part.endswith(":") for part in parts)


def safe_extract_wheel(wheel_path: Path, destination: Path) -> None:
    """Extract a wheel zip, rejecting absolute paths, parent segments, and links."""
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    with zipfile.ZipFile(wheel_path) as archive:
        for info in archive.infolist():
            if _is_unsafe_zip_name(info.filename):
                raise SystemExit("UNSAFE_ARCHIVE")
            mode = (info.external_attr >> 16) & 0xFFFF
            if mode and (mode & 0xF000) == 0xA000:
                raise SystemExit("UNSAFE_ARCHIVE")
            target = (root / info.filename).resolve()
            if target != root and root not in target.parents:
                raise SystemExit("UNSAFE_ARCHIVE")
        archive.extractall(root)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Parakeet import isolation")
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--backend", required=True)
    parser.add_argument("--pth", default="")
    parser.add_argument("--ambient-pythonpath", default="")
    parser.add_argument("--expect-device", default="")
    parser.add_argument("--actual-device", default="")
    parser.add_argument("--probe-device", default="")
    parser.add_argument("--extract-wheel", default="")
    parser.add_argument("--extract-dest", default="")
    args = parser.parse_args(argv)

    paths = build_isolated_sys_path(
        runtime_dir=args.runtime,
        backend_dir=args.backend,
        pth_file=args.pth or None,
        ambient_pythonpath=args.ambient_pythonpath,
    )
    apply_isolated_path(paths)
    if args.extract_wheel:
        safe_extract_wheel(Path(args.extract_wheel), Path(args.extract_dest or args.runtime))
        return 0
    if args.probe_device:
        sys.stdout.write(json.dumps(probe_device(args.probe_device, args.runtime)) + "\n")
        return 0
    if args.expect_device:
        assert_device(args.actual_device, args.expect_device)
    sys.stdout.write("\n".join(paths) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
