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

## Phase 1b + 2 (2026-05-27, Windows)

| Change | Expected effect |
|--------|-----------------|
| Remove `scipy` from Windows build pins | ~112 MB less in `site-packages` (app uses `soxr` only in `processor.py`) |
| Remove `soxr` from macOS build pins | ~2 MB less on macOS (Windows-only resampling path) |
| `soxr` 0.3.7 → 1.1.0 on Windows | Similar wheel size; better resampler performance |

**macOS `scipy`:** Not removed from the bundle — `lightning-whisper-mlx==0.0.10` declares `scipy` as a dependency, so pip still installs it even without an explicit pin.
