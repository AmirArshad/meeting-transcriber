# Installer size notes (dependency phases)

Short log of bundled Python size changes from phased dependency work. Measure on the **native** build host after `npm run prepare-build`:

## macOS vs Windows installer gap (2026-06-09 analysis)

Packaged builds do **not** bundle Whisper models by default (`DOWNLOAD_MODELS` is off). The ~1.3 GB macOS DMG vs ~200 MB Windows installer gap is almost entirely the **bundled Python runtime**, not Electron or ffmpeg.

| Component | Windows | macOS | Notes |
|-----------|---------|-------|-------|
| Transcription stack | `faster-whisper` + `ctranslate2` (~80–120 MB) | `lightning-whisper-mlx` + `mlx` + `scipy` + `numba` (~150–250 MB) | macOS needs Metal/MLX path |
| PyTorch (`torch`) | Not bundled | Was ~400–600 MB | **Removed post-install** — MLX inference never imports `lightning_whisper_mlx/torch_whisper.py`; diarization installs its own torch into `userData` |
| PyObjC frameworks | N/A | ~50–100 MB | Required for ScreenCaptureKit / CoreAudio capture |
| Python runtime | Embedded (~15 MB) | python-build-standalone (~45 MB) | macOS uses relocatable standalone build |
| ffmpeg | gyan.dev x64 (~50 MB) | arm64 static (~32 MB) | Switched from evermeet.cx Intel-only build (Rosetta) to shaka `ffmpeg-osx-arm64` |
| Electron shell | ~100 MB | ~100 MB | macOS target is `arm64` only |

**Expected savings from this branch**

- arm64 ffmpeg: ~25–30 MB smaller vs evermeet Intel static binary; removes Rosetta deprecation warning
- torch + PyTorch-only transitive packages removed after `pip install`: **~400–600 MB** (measure on Mac with `du -sh build/resources/python`)

**Still not trimmable without product/architecture changes**

- `scipy` — required at runtime by `lightning-whisper-mlx` (`timing.py` imports `scipy.signal`)
- PyObjC capture frameworks — required for desktop audio
- `mlx` / `numba` / `llvmlite` — MLX transcription runtime

**Measure after `npm run prepare-build` on macOS:**

```bash
du -sh build/resources/python build/resources/ffmpeg dist/mac-arm64/AvaNevis.app
du -sh build/resources/python/lib/python3.11/site-packages/{torch,scipy,mlx,torchgen} 2>/dev/null || true
```

```bash
# macOS
du -sh build/resources/python
du -sh dist/mac-arm64/AvaNevis.app

# Windows (PowerShell)
"{0:N1} MB" -f ((Get-ChildItem build\resources\python -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
"{0:N1} MB" -f ((Get-ChildItem dist\win-unpacked -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
```

## Bundled Python by platform (after Phases 1b + 2)

| Package | Windows installer | macOS installer | Notes |
|---------|-------------------|-----------------|-------|
| **soxr** | `1.1.0` (direct pin) | Not bundled | Resampling only in `backend/audio/processor.py` (Windows recorder). |
| **scipy** | Not bundled | `1.11.4` (direct pin) | Windows dropped in 1b. macOS kept: `lightning-whisper-mlx==0.0.10` requires `scipy`; no app `import scipy` in `backend/`. |

**Dev / CI:** `requirements-dev.txt` includes `soxr>=1.1.0` so macOS and Windows can run `tests/python/test_processor.py` without bundling soxr in the mac app.

## Phase 1b + 2 (2026-05-27)

| Change | Expected effect |
|--------|-----------------|
| Remove `scipy` from Windows build pins | ~112 MB less in `site-packages` (app uses `soxr` only in `processor.py`) |
| Remove `soxr` from macOS build pins | ~2 MB less on macOS (Windows-only resampling path) |
| `soxr` 0.3.7 → 1.1.0 on Windows | Similar wheel size; better resampler performance |

**macOS `scipy` trim (investigated, not done):** Removing the explicit `scipy` pin does not shrink the bundle — pip still installs scipy for `lightning-whisper-mlx`. Post-install removal would break MLX transcription unless upstream drops the dependency.

## Phase 4 (2026-05-27)

| Change | Pin update |
|--------|------------|
| NumPy | `1.26.4` -> `2.4.6` (Windows + macOS build pins, shared/dev floors) |
| SciPy (macOS MLX stack) | `1.11.4` -> `1.17.1` |
| CTranslate2 (Windows) | `4.7.1` -> `4.7.2` (latest patch) |

Compatibility notes:

- `soxr` 1.1.0 keeps `quality='VHQ'` API and has Python 3.11 Windows/macOS wheels.
- `lightning-whisper-mlx==0.0.10` still depends on `scipy`, `numba`, and `torch`; those remain pinned on macOS.
- `numba` / `llvmlite` pins already satisfy NumPy 2 support ranges per upstream compatibility tables.

## Smoke validation

| Platform | Phase 1b + 2 packaged smoke |
|----------|----------------------------|
| **Windows** | Passed (2026-05-27): `dist\win-unpacked\AvaNevis.exe` — launch, record, transcribe, save with `soxr==1.1.0` and no bundled `scipy`. |
| **macOS** | Re-verify on a Mac after `npm run build:mac:dir`: launch + short MLX transcribe (soxr removed from bundle; scipy unchanged). |
