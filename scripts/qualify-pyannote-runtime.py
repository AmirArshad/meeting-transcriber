#!/usr/bin/env python3
"""Qualify a pyannote dependency closure on a matching host.

Installs the catalog's pinned requirements with the same pip flags as
in-app setup into a throwaway target, audits the fully resolved closure, and
runs a device smoke with randomly initialised pyannote architectures. No
Hugging Face token or gated model is used, so this proves resolution, native
extension loading and GPU kernels -- not diarization accuracy.

  python scripts/qualify-pyannote-runtime.py --work-dir <tmp> [--requirement torch==...]
  python scripts/qualify-pyannote-runtime.py --work-dir <tmp> --resolve-only

--resolve-only resolves the same closure with `pip install --dry-run --report`
and audits it without installing or running the smoke, for CI on runners
without a GPU. Run either mode with a Python 3.11 interpreter on the matching
host OS so environment markers resolve as they do in the app.

Exit codes: 0 clean, 1 audit findings, 2 audit did not run, 3 smoke failed,
4 wrong accelerator.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from pip_audit_inventory import AUDIT_FAILED, audit_requirements, print_findings, strip_local_version  # noqa: E402


def platform_key() -> str:
    system = {"win32": "win32", "darwin": "darwin", "linux": "linux"}.get(sys.platform, sys.platform)
    machine = platform.machine().lower()
    arch = {"amd64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}.get(machine, machine)
    return f"{system}-{arch}"


def load_artifact(key: str) -> dict:
    script = (
        "const s=require('./src/ai-addon-state.js');"
        "const a=s.AI_MODEL_CATALOG.diarization.dependencyArtifacts[process.argv[1]];"
        "process.stdout.write(JSON.stringify(a||null));"
    )
    out = subprocess.run(["node", "-e", script, key], cwd=ROOT, check=True, capture_output=True, text=True).stdout
    artifact = json.loads(out)
    if not artifact:
        raise SystemExit(f"No pyannote dependency artifact for {key}.")
    return artifact


def install_args(artifact: dict, requirements: list[str], target: Path) -> list[str]:
    pip = artifact["pip"]
    source_packages = [item["package"] for item in pip.get("sourceArtifacts", [])]
    args = [sys.executable, "-m", "pip", "install", "--upgrade", "--ignore-installed", "--target", str(target),
            "--no-warn-script-location", "--index-url", pip["indexUrl"]]
    for extra in pip.get("extraIndexUrls", []):
        args += ["--extra-index-url", extra]
    if not pip.get("allowSourceBuilds"):
        args.append("--only-binary=:all:")
    if source_packages:
        args.append(f"--no-binary={','.join(source_packages)}")
    return args + requirements


def resolved_inventory(target: Path) -> list[tuple[str, str]]:
    found = []
    for dist_info in sorted(target.glob("*.dist-info")):
        metadata = dist_info / "METADATA"
        if not metadata.exists():
            continue
        name = version = None
        for line in metadata.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("Name: "):
                name = line[6:].strip()
            elif line.startswith("Version: "):
                version = line[9:].strip()
            if not line or (name and version):
                break
        if name and version:
            found.append((name, version))
    return found


def dry_run_inventory(artifact: dict, requirements: list[str], work_dir: Path) -> list[tuple[str, str]]:
    report = work_dir / "pip-dry-run-report.json"
    args = install_args(artifact, requirements, work_dir / "dry-run-target")
    args[args.index("install") + 1:args.index("install") + 1] = ["--dry-run", "--quiet", "--report", str(report)]
    subprocess.run(args, check=True)
    entries = json.loads(report.read_text(encoding="utf-8")).get("install", [])
    return sorted((entry["metadata"]["name"], entry["metadata"]["version"]) for entry in entries)


SMOKE = r"""
import json, os, sys, warnings
warnings.filterwarnings("ignore")
os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
report = {}
import torch
report["torch"] = torch.__version__
report["cuda_build"] = torch.version.cuda
device = "cpu"
if torch.cuda.is_available():
    device = "cuda"
    report["gpu"] = torch.cuda.get_device_name(0)
elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
    device = "mps"
report["device"] = device
import torchaudio
report["torchaudio"] = torchaudio.__version__
import torchaudio.compliance.kaldi as kaldi
try:
    import torchcodec
    from torchcodec.decoders import AudioDecoder  # noqa: F401  loads the native core
    report["torchcodec"] = torchcodec.__version__
except Exception as error:  # pyannote tolerates a missing decoder; record it
    report["torchcodec_error"] = f"{type(error).__name__}: {error}"[:300]
import pyannote.audio
report["pyannote.audio"] = pyannote.audio.__version__
from pyannote.audio.models.embedding import WeSpeakerResNet34
torch.manual_seed(0)
wave = torch.randn(2, 1, 16000 * 3, device=device)
fbank = kaldi.fbank(wave[0].cpu() * 32768, num_mel_bins=80, sample_frequency=16000)
report["kaldi_fbank_shape"] = list(fbank.shape)
model = WeSpeakerResNet34().to(device).eval()
with torch.inference_mode():
    embedding = model(wave)
report["embedding_shape"] = list(embedding.shape)
report["embedding_finite"] = bool(torch.isfinite(embedding).all().item())
print(json.dumps(report))
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work-dir", required=True, type=Path)
    parser.add_argument("--platform-key", default=platform_key())
    parser.add_argument("--requirement", action="append", default=[],
                        help="Replace a catalog requirement (by package name) for candidate testing.")
    parser.add_argument("--skip-install", action="store_true")
    parser.add_argument("--resolve-only", action="store_true")
    args = parser.parse_args()

    artifact = load_artifact(args.platform_key)
    requirements = list(artifact["pip"]["requirements"])
    for override in args.requirement:
        name = override.split("=")[0].split("<")[0].split(">")[0].strip().lower()
        requirements = [r for r in requirements if r.split("=")[0].strip().lower() != name] + [override]
    args.work_dir.mkdir(parents=True, exist_ok=True)
    target = args.work_dir / "site-packages"
    if args.resolve_only:
        inventory = dry_run_inventory(artifact, requirements, args.work_dir)
    else:
        if not args.skip_install:
            target.mkdir(parents=True, exist_ok=True)
            subprocess.run(install_args(artifact, requirements, target), check=True)
        inventory = resolved_inventory(target)
    frozen = args.work_dir / "resolved-requirements.txt"
    frozen.write_text("".join(f"{name}=={strip_local_version(version)}\n" for name, version in inventory),
                      encoding="utf-8")
    print(f"Resolved {len(inventory)} distributions for {artifact['id']} -> {frozen}")

    findings = audit_requirements(frozen, args.work_dir / "pip-audit.json")
    if findings is None:
        return AUDIT_FAILED
    print_findings(artifact["id"], findings)
    if args.resolve_only:
        return 1 if findings else 0

    env = {key: value for key, value in os.environ.items()
           if key not in {"PYTHONPATH", "PYTHONHOME", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGING_FACE_HUB_TOKEN"}}
    env["PYTHONPATH"] = str(target)
    env["PYTHONNOUSERSITE"] = "1"
    env["HF_HUB_OFFLINE"] = "1"
    smoke = subprocess.run([sys.executable, "-c", SMOKE], env=env, capture_output=True, text=True)
    if smoke.returncode != 0:
        print(smoke.stderr[-4000:], file=sys.stderr)
        print("Device smoke failed.", file=sys.stderr)
        return 3
    report = json.loads(smoke.stdout.strip().splitlines()[-1])
    (args.work_dir / "smoke.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    expected = {"win32-x64": "cuda", "linux-x64": "cuda", "darwin-arm64": "mps"}.get(args.platform_key)
    if expected and report.get("device") != expected:
        print(f"Expected device {expected}, got {report.get('device')}.", file=sys.stderr)
        return 4
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
