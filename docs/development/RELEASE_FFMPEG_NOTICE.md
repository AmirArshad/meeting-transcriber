
### FFmpeg (GPLv3)

Installers bundle **ffmpeg 8.0.1** as a separate program (not linked into the AvaNevis UI binary) for Opus audio compression.

| Platform | Binary source |
|----------|----------------|
| Windows | [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) essentials build (GPLv3) |
| macOS | [shaka-project/static-ffmpeg-binaries](https://github.com/shaka-project/static-ffmpeg-binaries/releases/tag/n8.0.1-1) `ffmpeg-osx-arm64` (GPLv3, Apple Silicon) |

**Corresponding source** for FFmpeg 8.0.1 (pinned SHA-256 in [legal/FFMPEG-COMPLIANCE.json](../../legal/FFMPEG-COMPLIANCE.json)):

- Download **`ffmpeg-8.0.1.tar.xz`** attached to the GitHub release, or
- https://ffmpeg.org/releases/ffmpeg-8.0.1.tar.xz

The macOS installer bundles a **statically linked** arm64 binary built from [shaka-project/static-ffmpeg-binaries](https://github.com/shaka-project/static-ffmpeg-binaries/releases/tag/n8.0.1-1). That build also statically links GPLv3 libraries such as x264 and x265. See `binaryProvenance.darwin.staticLinkedComponents` and `correspondingSource.staticBinaryNote` in [legal/FFMPEG-COMPLIANCE.json](../../legal/FFMPEG-COMPLIANCE.json) for pinned component versions and rebuild instructions.

Full third-party attributions: [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) (also bundled in installers under `resources/legal/`).
