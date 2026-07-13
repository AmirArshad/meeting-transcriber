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


def _clamp01(value):
    return max(0.0, min(1.0, value))


def _smoothstep(edge0, edge1, value):
    t = _clamp01((value - edge0) / max(edge1 - edge0, 1e-6))
    return t * t * (3.0 - 2.0 * t)


def _blend(dst, src):
    """Premultiplied-style over blend of src RGBA onto dst RGBA (0-255 ints)."""
    sr, sg, sb, sa = src
    dr, dg, db, da = dst
    if sa <= 0:
        return dst
    if sa >= 255 and da <= 0:
        return src
    a = sa / 255.0
    out_a = a + (da / 255.0) * (1.0 - a)
    if out_a <= 0:
        return (0, 0, 0, 0)
    out_r = int(round((sr * a + dr * (da / 255.0) * (1.0 - a)) / out_a))
    out_g = int(round((sg * a + dg * (da / 255.0) * (1.0 - a)) / out_a))
    out_b = int(round((sb * a + db * (da / 255.0) * (1.0 - a)) / out_a))
    return (out_r, out_g, out_b, int(round(out_a * 255.0)))


def circle_icon(
    size,
    radius,
    fill=(239, 68, 68, 255),
    outline=(254, 226, 226, 255),
    outline_width=1.0,
    halo=None,
    aa=1.15,
):
    """Antialiased filled circle with optional outline ring and outer halo."""
    cx = cy = (size - 1) / 2.0
    pixels = bytearray(size * size * 4)
    aa = max(aa, 0.75)
    for y in range(size):
        for x in range(size):
            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
            color = (0, 0, 0, 0)

            if halo:
                halo_width, halo_rgba = halo
                outer = radius + halo_width
                # Soft falloff outside the fill radius.
                coverage = 1.0 - _smoothstep(radius - aa * 0.25, outer, dist)
                if coverage > 0:
                    hr, hg, hb, ha = halo_rgba
                    color = _blend(color, (hr, hg, hb, int(round(ha * coverage))))

            # Fill disk with soft edge.
            fill_coverage = 1.0 - _smoothstep(radius - outline_width * 0.55 - aa, radius - outline_width * 0.55, dist)
            if fill_coverage > 0:
                fr, fg, fb, fa = fill
                color = _blend(color, (fr, fg, fb, int(round(fa * fill_coverage))))

            # Outline ring (annulus) with AA on both edges.
            if outline_width > 0:
                ring_outer = radius + outline_width * 0.35
                ring_inner = radius - outline_width * 0.85
                outer_cov = 1.0 - _smoothstep(ring_outer - aa, ring_outer + aa * 0.25, dist)
                inner_cov = _smoothstep(ring_inner - aa * 0.25, ring_inner + aa, dist)
                ring_coverage = outer_cov * inner_cov
                if ring_coverage > 0:
                    or_, og, ob, oa = outline
                    color = _blend(color, (or_, og, ob, int(round(oa * ring_coverage))))

            i = (y * size + x) * 4
            pixels[i:i + 4] = bytes(color)
    return pixels


def main():
    root = Path(__file__).resolve().parents[1] / 'build'
    # 64x64 source: Windows taskbar overlay upscales a 16px bitmap on HiDPI and
    # looks soft; a larger AA source downscales cleanly at 100/150/200% DPI.
    overlay = circle_icon(
        64,
        radius=20.0,
        outline=(254, 226, 226, 235),
        outline_width=3.0,
        aa=1.6,
    )
    write_png(root / 'recording-overlay.png', 64, 64, overlay)

    mac18 = circle_icon(
        18,
        radius=6.2,
        outline=(255, 255, 255, 220),
        outline_width=1.2,
        halo=(1.8, (239, 68, 68, 90)),
        aa=1.1,
    )
    mac36 = circle_icon(
        36,
        radius=12.4,
        outline=(255, 255, 255, 220),
        outline_width=2.2,
        halo=(3.5, (239, 68, 68, 90)),
        aa=1.4,
    )
    write_png(root / 'iconRecording.png', 18, 18, mac18)
    write_png(root / 'iconRecording@2x.png', 36, 36, mac36)

    for name in ('recording-overlay.png', 'iconRecording.png', 'iconRecording@2x.png'):
        path = root / name
        print(f'{name}: {path.stat().st_size} bytes')


if __name__ == '__main__':
    main()
