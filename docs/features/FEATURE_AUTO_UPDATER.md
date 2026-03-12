# Update Checks

Status: implemented (manual download flow)

## Overview

Meeting Transcriber checks GitHub Releases for a newer version and notifies the renderer when one is available.

The current implementation does not download or install updates inside the app. Instead, it opens the matching release asset in the user's browser.

## Current Behavior

### Startup check

- `src/main.js` waits 5 seconds after app startup, then calls `checkForUpdates()`.
- `src/updater.js` fetches the latest GitHub release from the Releases API.
- If the latest version is newer than `app.getVersion()`, the main process sends an `update-available` event to the renderer.

### Manual check

- The app menu includes `Help > Check for Updates...`.
- Running the menu action calls the same `checkForUpdates()` path used at startup.
- If no update is available, the app shows a simple dialog confirming the current version is up to date.

### Renderer notification

- `src/preload.js` exposes `window.electronAPI.onUpdateAvailable(...)`.
- `src/renderer/app.js` listens for update events and shows the banner at the top of the window.
- `src/renderer/update-notification-helpers.js` owns the banner view state so repeated update events are handled safely in one renderer session.

### Download action

- Clicking `Download Update` calls the `download-update` IPC handler.
- `src/main.js` forwards that request to `src/updater.js`.
- `src/updater.js` opens the download URL with `shell.openExternal(...)`.

## Release Asset Selection

The updater looks for release assets that match the packaged artifact naming convention from `package.json`:

- Windows: `Meeting Transcriber-Setup-<version>.exe`
- macOS: `Meeting Transcriber-Setup-<version>.dmg`

If a platform-specific installer asset is not present, the updater falls back to the release page URL.

## Important Properties

- No `electron-updater`
- No background download manager
- No `Install and Restart` flow
- No code-signing-dependent in-place patching
- No mandatory updates

This keeps the update path simple and compatible with the project's unsigned/manual-install distribution model.

## Repeatable Notifications

The renderer now supports more than one `update-available` event in a single session.

That matters because both of these paths can fire during normal use:

1. the delayed startup auto-check
2. a later manual `Help > Check for Updates...`

If the user dismisses the first banner and a later check finds the same or a newer release, the banner can appear again.

## Files Involved

- `src/updater.js`
- `src/main.js`
- `src/preload.js`
- `src/renderer/app.js`
- `src/renderer/update-notification-helpers.js`
- `tests/js/updater.test.js`
- `tests/js/update-notification-helpers.test.js`

## Known Limitations

- Only the latest GitHub release is checked.
- The banner does not show download progress.
- The app does not verify or apply updates locally.
- Update failures are intentionally silent unless the user triggers a manual check.

## If We Ever Move To True Auto-Install Updates

That would be a separate product change, not a small refactor. It would require coordinated updates across:

- release packaging and signing
- `package.json` publish/build settings
- `src/updater.js`
- main/renderer IPC surface
- CI/release workflows
- user-facing docs for installation and recovery
