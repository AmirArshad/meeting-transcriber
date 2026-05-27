# Installer size notes (dependency phases)

Short log of bundled Python size changes from phased dependency work. Measure on the **native** build host after `npm run prepare-build`:

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

## Smoke validation

| Platform | Phase 1b + 2 packaged smoke |
|----------|----------------------------|
| **Windows** | Passed (2026-05-27): `dist\win-unpacked\AvaNevis.exe` — launch, record, transcribe, save with `soxr==1.1.0` and no bundled `scipy`. |
| **macOS** | Re-verify on a Mac after `npm run build:mac:dir`: launch + short MLX transcribe (soxr removed from bundle; scipy unchanged). |
