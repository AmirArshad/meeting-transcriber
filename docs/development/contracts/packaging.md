# Packaging contract

Keep `prepare-resources`, download manifest pins/tests, `package.json` extra resources, and runtime path resolution aligned. Prepared resource manifests must invalidate stale resources. Speakrs CLI and validation fixture are bundled and integrity-checked fail-closed; hash raw bytes, not decoded executable text. Model packs and ORT archives remain setup-time downloads.

Packaged Python must set `AVANEVIS_PACKAGED=1`, ignore ambient Python paths, set `PYTHONNOUSERSITE=1` and `PYTHONDONTWRITEBYTECODE=1`, while allowing managed add-on paths ahead of bundled backend. Linux tray uses PNG assets and skips Tray construction without an SNI watcher. macOS ad-hoc signing, helper staging/signing, and updater filename coupling remain verified release gates.

### Platform traps

- **Windows save dialogs:** file basenames are sanitized against `WINDOWS_RESERVED_FILE_BASENAME` by `buildSafeSaveDialogDefaultPath` (`src/main/file-export-ipc.js`). A meeting titled `CON`, `PRN`, `AUX`, `NUL`, `COM1`… is unwritable on Windows even with an extension. Do not bypass that helper when adding an export path.
- **macOS tray icon:** call `setTemplateImage(false)` **before** `setImage` for the saturated recording-status icon. Template images get auto-tinted monochrome, which silently destroys the red REC indicator.
- **Windows capture cleanup:** see **Python backend** below — the lock must be released before `rmtree`.

### Build packaging

Keep aligned when bundled runtime locations or prepared-resource inputs change: `build/prepare-resources.js`, `build/download-manifest.js` (pinned URLs + checksums, with `tests/js/build-download-manifest.test.js`), `package.json` `extraResources`, and path resolution in `src/main.js`. Generated `build/resources/resource-manifest.json` must keep invalidating stale prepared resources. `prepare-resources.js` builds and stages `Resources/bin/speakrs-cli[.exe]` plus the validation fixture WAV; fail the build if that binary is missing. `ort` compile-time downloads stay pinned in `native/speakrs-cli/ort-compile-pins.json` — **not** in `download-manifest.js`. Model packs and the Windows ORT 1.27.1 archive are setup-time, not installer-bundled.

Windows packaged Python relies on `python311._pth` containing `../backend`; dev relies on `PYTHONPATH` set in `src/main.js`. Packaged macOS/Linux python-build-standalone **does** honor `PYTHONPATH`.

**Packaged-only path hardening.** Packaged apps set `process.env.AVANEVIS_PACKAGED=1` at main-process startup (so worker threads inherit it) and inject it via `buildPythonEnv()` for every Python child. Packaged `buildPythonEnv()` must not inherit ambient `PYTHONPATH`, `PYTHONHOME`, or `PYTHONUSERBASE`, must set `PYTHONNOUSERSITE=1`, and must force `PYTHONDONTWRITEBYTECODE=1` so normal recorder/transcriber/add-on subprocesses cannot mutate the signed app bundle with `__pycache__`. Caller-supplied `PYTHONPATH` extras (managed add-on site-packages) may still prepend the bundled backend path. When set, `backend/audio/swift_audio_capture.py` must **not** call `shutil.which("audiocapture-helper")` — only the bundled `Resources/bin/audiocapture-helper` or explicit dev build paths are valid. Summary tar extraction (`resolvePreferredTarExecutable`) likewise prefers absolute system tar over PATH. Dev/`npm start` leaves the var unset so PATH lookup still works.

**Release asset naming.** `src/updater.js` identifies installers by filename pattern. Change artifact naming in `package.json` or `.github/workflows/build-release.yml` and you must update `src/updater.js` too.

**Tray assets.** `resolveTrayImageFileName` (`src/main/recording-presence-service.js`) owns the per-platform tray image. Linux must use PNGs (`iconTrayLinux.png`, `iconTrayLinuxRecording.png`) — `nativeImage.createFromPath` cannot decode `.ico` outside Windows and returns an **empty** image, while `new Tray(emptyImage)` still succeeds on Linux, so the failure mode is a registered-but-invisible SNI item rather than an exception. Linux `createTray()` also probes `org.kde.StatusNotifierWatcher` via `busctl --user status` before constructing a Tray: Electron 44 `new Tray()` does **not** throw when no SNI host is running, and a successful constructor would make close **hide** with no visible icon. Missing watcher skips tray creation so idle/recording close **minimizes**. Any new tray image must also be added to `package.json` `extraResources`. Regeneration commands are in `docs/development/MACOS_ICONS.md`.

**macOS signing identity.** `build.mac.identity` is pinned to `"-"` so certificate-less builds ad-hoc sign the whole bundle (Gate B). Because an explicit identity beats `CSC_LINK`/keychain discovery, `npm run build:mac` first runs `scripts/check-mac-signing-identity.js`, which fails the build if that pin coexists with real signing credentials. Override with `-c.mac.identity=...`, or acknowledge with `AVANEVIS_ALLOW_ADHOC_MAC_SIGNING=1`.
