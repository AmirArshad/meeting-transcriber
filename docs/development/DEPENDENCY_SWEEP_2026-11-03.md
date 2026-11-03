# Dependency sweep — 2026-11-03

This records the local review of every open Dependabot branch, the pinned
Python build inventories, npm and Cargo advisories, and the separate Parakeet
locks. It includes the fixes for the failed CI run. It does not claim that
GitHub Actions, Windows/macOS installers, or audio hardware checks passed on
these uncommitted changes.

| PR | Local decision |
|---|---|
| [#142 Actions](https://github.com/AmirArshad/meeting-transcriber/pull/142) | Apply the four immutable action revisions and update workflow assertions. Confirmed release tags for setup-python 7.1.0, rust-cache 2.9.3 and markdownlint 25.0.0; the rust-toolchain revision is upstream master and its one-commit change updates its revision script. Rust itself remains 1.88.0. |
| [#141 Electron](https://github.com/AmirArshad/meeting-transcriber/pull/141) | Supersede 45.1.0 with stable 45.2.1. The actual sandboxed preload is tested for invoke, event delivery and unsubscribe. Native installer, tray, recording and safeStorage gates remain. |
| [#140 Python runtime pins](https://github.com/AmirArshad/meeting-transcriber/pull/140) | Supersede with filelock 4.2.7 and certifi 2026.10.23 in the build pins; update the macOS Parakeet filelock wheel using the real-wheel generator. |
| [#139 filelock](https://github.com/AmirArshad/meeting-transcriber/pull/139) | Superseded by 4.2.7 in the local requirements and macOS Parakeet lock. |
| [#136 setuptools](https://github.com/AmirArshad/meeting-transcriber/pull/136) | Apply 84.2.1 to all three build closures. |
| [#135 electron-builder](https://github.com/AmirArshad/meeting-transcriber/pull/135) | Apply 26.18.0. A Linux unpacked build and layout check ran using previously prepared resources. Full native installer qualification remains. |
| [#132 serde_json](https://github.com/AmirArshad/meeting-transcriber/pull/132) | Apply 1.0.154; the Rust locked tests and audit pass. |
| [#130 CTranslate2](https://github.com/AmirArshad/meeting-transcriber/pull/130) | Supersede 4.8.3 with 4.8.5 on Linux only. On CachyOS with an RTX 4070, the same cached tiny model and local speech fixture produced identical transcripts on CPU and CUDA with 4.8.2 and 4.8.5. Windows remains 4.8.2 pending native CUDA/CPU and shutdown qualification. |
| [#129 more-itertools](https://github.com/AmirArshad/meeting-transcriber/pull/129) | Apply 11.2.1 to the macOS build closure. |
| [#127 MLX](https://github.com/AmirArshad/meeting-transcriber/pull/127) | Hold the paired 0.32.4 update until actual Apple Silicon Metal Whisper inference can be checked. Wheel resolution alone cannot qualify GPU behavior. |

Additional build pins updated: AnyIO 4.16.0 and pycparser 3.12. The pinned bootstrap pip wheel is now 26.3; its downloaded SHA-256 was verified against the PyPI release metadata and it imports under isolated Python 3.11. The latest
compatible PyPI inventory also identifies Numba 0.68.1, ONNX Runtime 1.31.1,
hf-xet 1.8.0, Torch 2.15.0 and PyObjC 13.0. These remain unchanged: they
need native inference, telemetry/ETW, download, or macOS compatibility
qualification respectively. Python 3.11 and the existing constraints also
hold back newer NumPy, PyAV, SciPy, NetworkX, huggingface-hub, tiktoken and
mpmath releases. Pyannote's separate certifi 2026.10.19 pin remains patched;
its installed environments are not invalidated for a routine root-bundle
refresh. The three isolated Parakeet inventories and updated bootstrap pip audit clean.

The Electron 45 release removes several sandboxed-preload Node shims, changes
screen-capture permission routing and deprecates synchronous safeStorage APIs
for removal in Electron 46. AvaNevis's preload uses the Electron bridge only;
recording uses native helpers, and the new fixture exercises actual sandboxed
IPC. The async safeStorage migration is a separate future requirement and
must preserve existing encrypted tokens. See [Electron 45 release notes](https://www.electronjs.org/blog/electron-45-0).

Security audits report no high or critical npm advisories, zero findings in
the three exact Python build inventories and Parakeet lock inventories, and no
unignored Cargo warnings. npm still reports 15 moderate findings through the
packaging toolchain's minimatch dependencies; npm's suggested force fix is a
breaking electron-builder downgrade. The prior zip 6 exceptions were removed
because the compatibility patch now uses zip 9.0.5. The separate webpki-roots
compatibility-facade exception remains documented in the Cargo audit config.

Local `npm run test:all` under a virtual X display passed: 1,132 JavaScript
and 852 Python tests, with two and four skips respectively. The Linux and
cross-host Windows pin closures passed; cross-host Windows does not replace the
native CI run. A macOS cross-host closure attempt cannot establish the macOS
closure because pip evaluates Linux environment markers. The macOS Python
inventory audit nevertheless reported no known advisories. All action and
platform-native checks must run on the final changes before release. Existing
macOS Parakeet installations will require the normal repair flow because the
lock identity changed.
