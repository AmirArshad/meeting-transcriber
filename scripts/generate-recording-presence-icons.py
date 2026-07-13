#!/usr/bin/env python3
"""Generate Release 1 recording presence PNG assets."""

import math
import struct
import zlib
from pathlib import Path


def write_png(path, width, height, rgba_pixels):
    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
        )

    raw = b''.join(
        b'\x00' + bytes(rgba_pixels[y * width * 4:(y + 1) * width * 4])
        for y in range(height)
    )
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    data = (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(raw, 9))
        + chunk(b'IEND', b'')
    )
    Path(path).write_bytes(data)


def circle_icon(
    size,
    radius,
    fill=(239, 68, 68, 255),
    outline=(254, 226, 226, 255),
    outline_width=1.0,
    halo=None,
):
    cx = cy = (size - 1) / 2.0
    pixels = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            dx = x - cx
            dy = y - cy
            dist = math.sqrt(dx * dx + dy * dy)
            i = (y * size + x) * 4
            if halo and dist <= radius + halo[0]:
                t = max(0.0, min(1.0, (radius + halo[0] - dist) / max(halo[0], 1e-6)))
                a = int(halo[1][3] * t)
                pixels[i:i + 4] = bytes((halo[1][0], halo[1][1], halo[1][2], a))
            if abs(dist - radius) <= outline_width * 0.75:
                pixels[i:i + 4] = bytes(outline)
            elif dist <= radius - outline_width * 0.35:
                pixels[i:i + 4] = bytes(fill)
    return pixels


def main():
    root = Path(__file__).resolve().parents[1] / 'build'
    overlay = circle_icon(16, radius=5.0, outline_width=1.0)
    write_png(root / 'recording-overlay.png', 16, 16, overlay)

    mac18 = circle_icon(
        18,
        radius=6.2,
        outline=(255, 255, 255, 220),
        outline_width=1.2,
        halo=(1.8, (239, 68, 68, 90)),
    )
    mac36 = circle_icon(
        36,
        radius=12.4,
        outline=(255, 255, 255, 220),
        outline_width=2.2,
        halo=(3.5, (239, 68, 68, 90)),
    )
    write_png(root / 'iconRecording.png', 18, 18, mac18)
    write_png(root / 'iconRecording@2x.png', 36, 36, mac36)

    for name in ('recording-overlay.png', 'iconRecording.png', 'iconRecording@2x.png'):
        path = root / name
        print(f'{name}: {path.stat().st_size} bytes')


if __name__ == '__main__':
    main()
