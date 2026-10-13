#!/usr/bin/env bash
# Verify the exact app delivered by the DMG without modifying it or installing it.
set -euo pipefail

version="$(node -p "require('./package.json').version")"
dmg="dist/AvaNevis-Setup-${version}.dmg"
test -s "$dmg"
hdiutil verify "$dmg"

mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/avanevis-dmg.XXXXXX")"
attached=0
cleanup() {
  if [[ "$attached" == '1' ]]; then hdiutil detach "$mount_dir"; fi
  rmdir "$mount_dir"
}
trap cleanup EXIT
hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$dmg"
attached=1
bash scripts/verify-macos-packaged-app.sh "$mount_dir/AvaNevis.app"
echo 'macOS DMG payload verified read-only'
