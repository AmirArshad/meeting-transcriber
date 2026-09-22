"""Parakeet bootstrap isolation without importing onnx or mlx."""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from transcription.parakeet_bootstrap import (  # noqa: E402
    _CUDA_PROBE_MODEL,
    assert_device,
    build_isolated_sys_path,
    probe_cuda_device,
    probe_metal_device,
    safe_extract_wheel,
)


def test_windows_pth_ignores_ambient_pythonpath(tmp_path: Path):
    runtime = tmp_path / "runtime"
    backend = tmp_path / "backend"
    runtime.mkdir()
    backend.mkdir()
    pth = tmp_path / "python311._pth"
    pth.write_text("python311.zip\n.\n../dist-packages\nimport site\n", encoding="utf-8")
    ambient = str(tmp_path / "evil-ambient")
    paths = build_isolated_sys_path(
        runtime_dir=str(runtime),
        backend_dir=str(backend),
        pth_file=str(pth),
        current_path=[
            "/usr/lib/python3.11",
            str(tmp_path / "other" / "site-packages"),
            "/usr/lib/python3/dist-packages",
            str(tmp_path / "ambient-modules"),
        ],
        ambient_pythonpath=ambient,
        stdlib_paths=["/usr/lib/python3.11"],
    )
    assert str(runtime.resolve()) in paths
    assert str(backend.resolve()) in paths
    assert "/usr/lib/python3.11" in paths
    assert ambient not in paths
    assert str(tmp_path / "ambient-modules") not in paths
    assert all("site-packages" not in entry and "dist-packages" not in entry for entry in paths)


def test_isolated_path_does_not_keep_ambient_sys_path(tmp_path: Path):
    runtime = tmp_path / "runtime"
    backend = tmp_path / "backend"
    runtime.mkdir()
    backend.mkdir()
    ambient = tmp_path / "ambient-modules"
    paths = build_isolated_sys_path(
        runtime_dir=str(runtime),
        backend_dir=str(backend),
        current_path=[str(ambient), "/usr/lib/python3/dist-packages", "/usr/lib/python3.11"],
        stdlib_paths=["/usr/lib/python3.11", "/usr/lib/python3/dist-packages"],
        ambient_pythonpath=str(ambient),
    )
    assert paths == [str(runtime.resolve()), str(backend.resolve()), "/usr/lib/python3.11"]


class _FakeArray:
    float32 = "float32"

    def ones(self, shape, dtype=None):
        return {"shape": shape, "dtype": dtype}


def test_cuda_probe_rejects_a_cpu_fallback():
    class FakeOrt:
        @staticmethod
        def get_available_providers():
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]

        @staticmethod
        def InferenceSession(model, providers):
            assert model == _CUDA_PROBE_MODEL
            assert providers == ["CUDAExecutionProvider"]

            class Session:
                def get_providers(self):
                    return ["CPUExecutionProvider"]

                def run(self, *_args, **_kwargs):
                    raise AssertionError("cpu fallback must not execute")

            return Session()

    assert probe_cuda_device(ort_module=FakeOrt, array_module=_FakeArray()) == {
        "device": "cpu",
        "deviceAvailable": False,
    }


def test_cuda_probe_requires_executed_cuda_output():
    class FakeOrt:
        @staticmethod
        def get_available_providers():
            return ["CUDAExecutionProvider"]

        @staticmethod
        def InferenceSession(model, providers):
            assert providers == ["CUDAExecutionProvider"]

            class Session:
                def get_providers(self):
                    return ["CUDAExecutionProvider"]

                def run(self, _names, feeds):
                    assert feeds["input"]["shape"] == (1, 4)
                    return [feeds["input"]]

            return Session()

    assert probe_cuda_device(ort_module=FakeOrt, array_module=_FakeArray()) == {
        "device": "cuda",
        "deviceAvailable": True,
    }


def test_metal_probe_requires_an_evaluated_gpu_result():
    class Value:
        def sum(self):
            return self

        def __float__(self):
            return 4.0

    class FakeMx:
        gpu = "gpu"
        evaluated = False

        class metal:
            @staticmethod
            def is_available():
                return True

        @staticmethod
        def set_default_device(device):
            assert device == "gpu"

        @staticmethod
        def ones(shape):
            assert shape == (2, 2)
            return Value()

        @staticmethod
        def eval(result):
            FakeMx.evaluated = True
            assert float(result) == 4.0

    evidence = probe_metal_device(mlx_core=FakeMx)
    assert evidence == {"device": "metal", "deviceAvailable": True}
    assert FakeMx.evaluated is True


def test_cpu_device_is_rejected():
    with pytest.raises(SystemExit, match="PARAKEET_GPU_UNAVAILABLE"):
        assert_device("cpu", "cuda")
    with pytest.raises(SystemExit, match="PARAKEET_GPU_UNAVAILABLE"):
        assert_device("metal", "cuda")


def test_unsafe_wheel_entry_is_rejected(tmp_path: Path):
    wheel = tmp_path / "bad.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("../evil.so", b"nope")
    with pytest.raises(SystemExit, match="UNSAFE_ARCHIVE"):
        safe_extract_wheel(wheel, tmp_path / "dest")
    assert not (tmp_path / "evil.so").exists()


def test_safe_wheel_extracts_inside_destination(tmp_path: Path):
    wheel = tmp_path / "ok.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("pkg/model.bin", b"data")
    destination = tmp_path / "dest"
    safe_extract_wheel(wheel, destination)
    assert (destination / "pkg" / "model.bin").read_bytes() == b"data"
