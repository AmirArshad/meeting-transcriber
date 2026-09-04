# Packaging contract

Keep `prepare-resources`, download manifest pins/tests, `package.json` extra resources, and runtime path resolution aligned. Prepared resource manifests must invalidate stale resources. Speakrs CLI and validation fixture are bundled and integrity-checked fail-closed; hash raw bytes, not decoded executable text. Model packs and ORT archives remain setup-time downloads.

Packaged Python must set `AVANEVIS_PACKAGED=1`, ignore ambient Python paths, set `PYTHONNOUSERSITE=1` and `PYTHONDONTWRITEBYTECODE=1`, while allowing managed add-on paths ahead of bundled backend. Linux tray uses PNG assets and skips Tray construction without an SNI watcher. macOS ad-hoc signing, helper staging/signing, and updater filename coupling remain verified release gates.
