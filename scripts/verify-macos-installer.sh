#!/usr/bin/env bash
# Verify the exact app delivered by the DMG without modifying it or installing it.
set -euo pipefail

version="$(node -p "require('./package.json').version")"
dmg="dist/AvaNevis-Setup-${version}.dmg"
test -s "$dmg"
hdiutil verify "$dmg"
node -e "require('./scripts/check-mac-signing-identity').verifyMacUpdateMetadata({ distDir: 'dist', version: process.argv[1] })" "$version"

REQUIRE_SIGNED_RAW="$(printf '%s' "${AVANEVIS_REQUIRE_SIGNED_RELEASE:-0}" | tr '[:upper:]' '[:lower:]')"
DMG_CODESIGN_INFO="$(codesign -dv --verbose=4 "$dmg" 2>&1 || true)"
if [[ "$REQUIRE_SIGNED_RAW" == "1" || "$REQUIRE_SIGNED_RAW" == "true" ]]; then
  if ! printf '%s\n' "$DMG_CODESIGN_INFO" | grep -q "Authority=Developer ID Application:"; then
    echo "ERROR: AVANEVIS_REQUIRE_SIGNED_RELEASE=1 requires Developer ID Application signature on $dmg" >&2
    printf '%s\n' "$DMG_CODESIGN_INFO" >&2
    exit 1
  fi
  codesign --verify --strict --verbose=2 "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
elif printf '%s\n' "$DMG_CODESIGN_INFO" | grep -q "Authority=Developer ID Application:"; then
  codesign --verify --strict --verbose=2 "$dmg"
  if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
    spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
  fi
fi

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
