#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
REQUIRE_SIGNED="${AVANEVIS_REQUIRE_SIGNED_RELEASE:-0}"
DMG_PATH="${1:-}"

require_signed_enabled() {
  local normalized
  normalized="$(printf '%s' "$REQUIRE_SIGNED" | tr '[:upper:]' '[:lower:]')"
  [[ "$normalized" == "1" || "$normalized" == "true" ]]
}

if [[ -z "$DMG_PATH" ]]; then
  DMG_CANDIDATES=()
  shopt -s nullglob
  for candidate in "$DIST_DIR"/AvaNevis-*.dmg; do
    if [[ "$candidate" != *.blockmap ]]; then
      DMG_CANDIDATES+=("$candidate")
    fi
  done
  shopt -u nullglob

  if [[ "${#DMG_CANDIDATES[@]}" -eq 0 ]]; then
    echo "ERROR: No packaged macOS DMG found under $DIST_DIR." >&2
    exit 1
  elif [[ "${#DMG_CANDIDATES[@]}" -gt 1 ]]; then
    echo "ERROR: Expected 1 packaged macOS DMG under $DIST_DIR, found ${#DMG_CANDIDATES[@]}." >&2
    printf '  %s\n' "${DMG_CANDIDATES[@]}" >&2
    exit 1
  fi
  DMG_PATH="${DMG_CANDIDATES[0]}"
fi

if [[ ! -f "$DMG_PATH" ]]; then
  echo "ERROR: macOS DMG does not exist: $DMG_PATH" >&2
  exit 1
fi

AUTH_ARGS=()
if [[ -n "${APPLE_ID:-}" || -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -n "${APPLE_TEAM_ID:-}" ]]; then
  if [[ -z "${APPLE_ID:-}" || -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" || -z "${APPLE_TEAM_ID:-}" ]]; then
    echo "ERROR: Partial Apple ID notarization credentials set; require APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID." >&2
    exit 1
  fi
  AUTH_ARGS=(
    --apple-id "$APPLE_ID"
    --password "$APPLE_APP_SPECIFIC_PASSWORD"
    --team-id "$APPLE_TEAM_ID"
  )
elif [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_KEY_ID:-}" || -n "${APPLE_API_ISSUER:-}" ]]; then
  if [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
    echo "ERROR: Partial App Store Connect API notarization credentials set; require APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER." >&2
    exit 1
  fi
  AUTH_ARGS=(
    --key "$APPLE_API_KEY"
    --key-id "$APPLE_API_KEY_ID"
    --issuer "$APPLE_API_ISSUER"
  )
elif [[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]]; then
  AUTH_ARGS=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
  if [[ -n "${APPLE_KEYCHAIN:-}" ]]; then
    AUTH_ARGS+=(--keychain "$APPLE_KEYCHAIN")
  fi
fi

if [[ "${#AUTH_ARGS[@]}" -eq 0 ]]; then
  if require_signed_enabled; then
    echo "ERROR: AVANEVIS_REQUIRE_SIGNED_RELEASE=1 requires Apple notarization credentials for $DMG_PATH." >&2
    exit 1
  fi
  echo "Skipping macOS DMG notarization and stapling (no notarization credentials configured)."
  exit 0
fi

# Ensure the DMG itself carries a timestamped Developer ID signature before notarization.
# electron-builder deletes its temporary CSC_LINK keychain at build exit and its built-in
# dmg.sign omits --timestamp, so sign cleanly here using CSC_LINK / keychain discovery.
sign_dmg_with_developer_id() {
  local target_dmg="$1"
  node - "$ROOT_DIR" "$target_dmg" <<'NODE'
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [rootDir, dmgPath] = process.argv.slice(2);
const appBuilderPath = require.resolve('app-builder-lib', { paths: [rootDir] });
const macCodeSign = require(path.join(path.dirname(appBuilderPath), 'codeSign', 'macCodeSign.js'));

function createTempDirManager(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  let seq = 0;
  return {
    async getTempFile({ suffix = '' } = {}) {
      seq += 1;
      return path.join(dir, `cert-${seq}${suffix}`);
    },
    async cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

(async () => {
  const tmpDir = createTempDirManager('avanevis-dmg-sign');
  let keychainFile = null;
  try {
    const cscLink = (process.env.CSC_LINK || '').trim();
    if (cscLink) {
      const info = await macCodeSign.createKeychain({
        tmpDir,
        cscLink,
        cscKeyPassword: process.env.CSC_KEY_PASSWORD || '',
        cscILink: process.env.CSC_INTERMEDIATE_LINK || undefined,
        cscIKeyPassword: process.env.CSC_INTERMEDIATE_KEY_PASSWORD || undefined,
        currentDir: rootDir,
      });
      keychainFile = info.keychainFile;
    }

    const qualifier = (process.env.CSC_NAME || '').trim() || undefined;
    const identity = await macCodeSign.findIdentity('Developer ID Application', qualifier, keychainFile);
    if (!identity) {
      if (process.env.AVANEVIS_REQUIRE_SIGNED_RELEASE === '1' || process.env.AVANEVIS_REQUIRE_SIGNED_RELEASE === 'true') {
        throw new Error('Could not find a valid Developer ID Application identity to sign DMG.');
      }
      console.warn('No Developer ID Application identity found; notarizing DMG unsigned.');
      return;
    }

    const args = ['--sign', identity.hash || identity.name, '--timestamp', '--force'];
    if (keychainFile) {
      args.push('--keychain', keychainFile);
    }
    args.push(dmgPath);
    execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmgPath], { stdio: 'inherit' });
  } finally {
    if (keychainFile) {
      await macCodeSign.removeKeychain(keychainFile, false).catch(() => {});
    }
    await tmpDir.cleanup().catch(() => {});
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
NODE
}

echo "Codesigning macOS DMG with Developer ID Application + secure timestamp..."
sign_dmg_with_developer_id "$DMG_PATH"

echo "Submitting macOS DMG to Apple notarytool: $DMG_PATH"
xcrun notarytool submit "$DMG_PATH" "${AUTH_ARGS[@]}" --wait

echo "Stapling notarization ticket to DMG: $DMG_PATH"
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

echo "macOS DMG signed, notarized, and stapled: $DMG_PATH"
