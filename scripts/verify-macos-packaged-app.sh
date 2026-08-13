#!/usr/bin/env bash
# Smoke-check a packaged macOS app directory build (dist/mac-arm64/AvaNevis.app).
# Safe to run without an Apple Developer account (ad-hoc signed builds).
set -euo pipefail

APP_PATH="${1:-dist/mac-arm64/AvaNevis.app}"

if [[ ! -d "$APP_PATH" ]]; then
  echo "ERROR: Packaged app not found: $APP_PATH" >&2
  exit 1
fi

HELPER_PATH="$APP_PATH/Contents/Resources/bin/audiocapture-helper"
SPEAKRS_CLI_PATH="$APP_PATH/Contents/Resources/bin/speakrs-cli"
SPEAKRS_WAV_BIN="$APP_PATH/Contents/Resources/bin/speakrs-two-speaker-16k.wav"
SPEAKRS_WAV_BACKEND="$APP_PATH/Contents/Resources/backend/diarization/fixtures/speakrs-two-speaker-16k.wav"
PYTHON_PATH="$APP_PATH/Contents/Resources/python/bin/python3"
FFMPEG_PATH="$APP_PATH/Contents/Resources/ffmpeg/ffmpeg"
SITE_PACKAGES="$APP_PATH/Contents/Resources/python/lib/python3.11/site-packages"
BACKEND_PATH="$APP_PATH/Contents/Resources/backend"

echo "Verifying packaged macOS app: $APP_PATH"
echo ""

test -f "$HELPER_PATH"
test -x "$HELPER_PATH"
test -f "$SPEAKRS_CLI_PATH"
test -x "$SPEAKRS_CLI_PATH"
test -s "$SPEAKRS_CLI_PATH"
file "$SPEAKRS_CLI_PATH" | grep -q "arm64"
if [[ ! -f "$SPEAKRS_WAV_BIN" ]]; then
  echo "ERROR: Packaged Speakrs validation fixture WAV is missing at Contents/Resources/bin/speakrs-two-speaker-16k.wav" >&2
  exit 1
fi
test -s "$SPEAKRS_WAV_BIN"
if [[ -f "$SPEAKRS_WAV_BACKEND" ]]; then
  echo "ERROR: Packaged app must not ship a duplicate Speakrs fixture under backend/diarization/fixtures" >&2
  exit 1
fi
if [[ -f "$APP_PATH/Contents/Resources/tests/fixtures/speakrs-two-speaker-16k.wav" ]]; then
  echo "ERROR: Packaged app must not ship tests/fixtures as the Speakrs validation path" >&2
  exit 1
fi
test -f "$PYTHON_PATH"
test -f "$FFMPEG_PATH"
test -x "$FFMPEG_PATH"

file "$FFMPEG_PATH" | grep -q "arm64"
codesign --verify --strict --verbose=2 "$FFMPEG_PATH"
"$FFMPEG_PATH" -version | grep -q "ffmpeg version"

codesign --verify --strict --verbose=2 "$HELPER_PATH"
codesign -d --entitlements :- "$HELPER_PATH" | grep -q "com.apple.security.inherit"
codesign --verify --strict --verbose=2 "$SPEAKRS_CLI_PATH"
codesign -d --entitlements :- "$SPEAKRS_CLI_PATH" | grep -q "com.apple.security.inherit"

helper_output="$(
python3 - "$HELPER_PATH" 2>&1 <<'PY'
import subprocess
import sys

helper_path = sys.argv[1]
result = subprocess.run(
    [helper_path, "--help"],
    capture_output=True,
    text=True,
    timeout=10,
    check=False,
)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
sys.exit(result.returncode)
PY
)"
echo "$helper_output" | grep -q "AudioCaptureHelper"

if [[ -d "$SITE_PACKAGES/torch" ]]; then
  echo "ERROR: Bundled torch should be removed from packaged Python runtime" >&2
  exit 1
fi

PYTHONPATH="$BACKEND_PATH" "$PYTHON_PATH" -c "
import lightning_whisper_mlx
from lightning_whisper_mlx.lightning import LightningWhisperMLX
import transcription.mlx_whisper_transcriber
"

SMOKE_DIR="$(mktemp -d)"
trap 'rm -rf "$SMOKE_DIR"' EXIT

"$FFMPEG_PATH" -hide_banner -loglevel error \
  -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.1 -y "$SMOKE_DIR/smoke.wav"
"$FFMPEG_PATH" -hide_banner -loglevel error \
  -i "$SMOKE_DIR/smoke.wav" -c:a libopus -b:a 128k -ar 48000 -y "$SMOKE_DIR/smoke.opus"
test -s "$SMOKE_DIR/smoke.opus"

echo ""
echo "Bundle sizes:"
du -sh "$APP_PATH" "$APP_PATH/Contents/Resources/python" "$FFMPEG_PATH" 2>/dev/null || true
echo ""
echo "✓ Packaged macOS app verification passed (arm64 ffmpeg, arm64 speakrs-cli, Opus encode, MLX imports, speakrs-cli codesigned, no bundled torch)"
