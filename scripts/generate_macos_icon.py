#!/usr/bin/env python3
"""Generate GuruTime macOS app icon assets.

Design direction:
- macOS-style graphite squircle
- electric blue/cyan timer ring
- bold rounded G mark for GuruTime
- high contrast at Dock/Finder sizes
"""
from __future__ import annotations

import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
OUT = ROOT / "design-output"
ICONSET = OUT / "GuruTime.iconset"

BASE = 1024
SCALE = 2
W = H = BASE * SCALE

RESAMPLE = getattr(Image, "Resampling", Image).LANCZOS


def sc(v: float) -> int:
    return int(round(v * SCALE))


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.strip().lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(round(lerp(a, b, t))) for a, b in zip(c1, c2))


def add_round_rect_shadow(canvas: Image.Image, mask: Image.Image) -> None:
    # Layered Apple-ish shadow: soft ambient + close contact shadow.
    for blur, alpha, y in [(80, 70, 34), (34, 95, 20), (12, 55, 5)]:
        shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        shifted = Image.new("L", (W, H), 0)
        shifted.paste(mask, (0, sc(y)))
        shadow.putalpha(shifted.filter(ImageFilter.GaussianBlur(sc(blur))))
        # tint alpha without changing shape
        tint = Image.new("RGBA", (W, H), (0, 0, 0, alpha))
        canvas.alpha_composite(Image.composite(tint, Image.new("RGBA", (W, H), (0, 0, 0, 0)), shadow.split()[-1]))


def rounded_squircle_mask() -> Image.Image:
    # Slightly conservative radius so it reads like modern macOS squircle once downsampled.
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    margin = sc(72)
    radius = sc(228)
    d.rounded_rectangle([margin, margin, W - margin, H - margin], radius=radius, fill=255)
    return mask.filter(ImageFilter.GaussianBlur(sc(0.35)))


def background(mask: Image.Image) -> Image.Image:
    top = hex_rgb("#182136")
    bottom = hex_rgb("#020611")
    left_glow = hex_rgb("#274BFF")
    cyan = hex_rgb("#11D7FF")
    violet = hex_rgb("#6738FF")
    amber = hex_rgb("#FFB238")

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = img.load()
    cx1, cy1 = sc(250), sc(170)
    cx2, cy2 = sc(690), sc(150)
    cx3, cy3 = sc(805), sc(820)

    for y in range(H):
        ty = y / (H - 1)
        for x in range(W):
            tx = x / (W - 1)
            base = mix(top, bottom, 0.72 * ty + 0.18 * tx)
            # radial glows, clamped and intentionally subtle
            d1 = math.hypot((x - cx1) / sc(600), (y - cy1) / sc(520))
            d2 = math.hypot((x - cx2) / sc(430), (y - cy2) / sc(420))
            d3 = math.hypot((x - cx3) / sc(500), (y - cy3) / sc(430))
            c = base
            if d1 < 1:
                c = mix(c, left_glow, (1 - d1) * 0.46)
            if d2 < 1:
                c = mix(c, cyan, (1 - d2) * 0.20)
            if d3 < 1:
                c = mix(c, amber, (1 - d3) * 0.12)
            # slight vignette
            edge = max(abs(tx - 0.5), abs(ty - 0.5)) * 2
            c = mix(c, (0, 1, 5), max(0, edge - 0.58) * 0.22)
            px[x, y] = (*c, 255)

    img.putalpha(mask)
    return img


def draw_ring(draw: ImageDraw.ImageDraw) -> None:
    center = (sc(512), sc(512))
    r = sc(315)
    width = sc(58)

    # Backing track.
    for deg in range(-220, 42):
        a1 = math.radians(deg)
        a2 = math.radians(deg + 1.8)
        p1 = (center[0] + math.cos(a1) * r, center[1] + math.sin(a1) * r)
        p2 = (center[0] + math.cos(a2) * r, center[1] + math.sin(a2) * r)
        draw.line([p1, p2], fill=(255, 255, 255, 38), width=width)

    # Active timer arc. Gap at lower-left keeps it from becoming a generic clock icon.
    start, end = -130, 238
    n = end - start
    colors = [hex_rgb("#16D6FF"), hex_rgb("#2D7DFF"), hex_rgb("#6E42FF")]
    for i, deg in enumerate(range(start, end)):
        t = i / max(1, n - 1)
        if t < 0.58:
            col = mix(colors[0], colors[1], t / 0.58)
        else:
            col = mix(colors[1], colors[2], (t - 0.58) / 0.42)
        a1 = math.radians(deg)
        a2 = math.radians(deg + 1.5)
        p1 = (center[0] + math.cos(a1) * r, center[1] + math.sin(a1) * r)
        p2 = (center[0] + math.cos(a2) * r, center[1] + math.sin(a2) * r)
        draw.line([p1, p2], fill=(*col, 255), width=width)

    # Rounded arc caps.
    for deg, col in [(start, hex_rgb("#16D6FF")), (end, hex_rgb("#6E42FF"))]:
        a = math.radians(deg)
        p = (center[0] + math.cos(a) * r, center[1] + math.sin(a) * r)
        rr = width // 2
        draw.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill=(*col, 255))

    # Glow on the active arc.
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for deg in range(start, end, 2):
        t = (deg - start) / max(1, end - start)
        col = mix(hex_rgb("#16D6FF"), hex_rgb("#6E42FF"), t)
        a1 = math.radians(deg)
        a2 = math.radians(deg + 2.5)
        p1 = (center[0] + math.cos(a1) * r, center[1] + math.sin(a1) * r)
        p2 = (center[0] + math.cos(a2) * r, center[1] + math.sin(a2) * r)
        gd.line([p1, p2], fill=(*col, 88), width=sc(82))
    return glow.filter(ImageFilter.GaussianBlur(sc(13)))


def draw_ticks(draw: ImageDraw.ImageDraw) -> None:
    cx, cy = sc(512), sc(512)
    for deg in range(0, 360, 30):
        a = math.radians(deg - 90)
        major = deg % 90 == 0
        r1 = sc(238 if major else 250)
        r2 = sc(264)
        w = sc(8 if major else 4)
        alpha = 155 if major else 72
        p1 = (cx + math.cos(a) * r1, cy + math.sin(a) * r1)
        p2 = (cx + math.cos(a) * r2, cy + math.sin(a) * r2)
        draw.line([p1, p2], fill=(255, 255, 255, alpha), width=w)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/SFNSRounded.ttf",
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size=size)
        except Exception:
            pass
    return ImageFont.load_default()  # type: ignore[return-value]


def draw_mark(canvas: Image.Image) -> None:
    # Letter mark uses actual text because it remains readable at 32px; pure line-art clocks don't.
    txt_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    td = ImageDraw.Draw(txt_layer)
    font = load_font(sc(485))
    text = "G"
    bbox = td.textbbox((0, 0), text, font=font, stroke_width=0)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (W - tw) / 2 - bbox[0] + sc(1)
    y = (H - th) / 2 - bbox[1] + sc(24)

    # Shadow/depth.
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.text((x, y + sc(12)), text, font=font, fill=(0, 0, 0, 160))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(sc(18))))

    # Gradient fill for the G.
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    md.text((x, y), text, font=font, fill=255)
    grad = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gp = grad.load()
    c1, c2 = hex_rgb("#FFFFFF"), hex_rgb("#BEEAFF")
    for yy in range(max(0, int(y)), min(H, int(y + th + sc(40)))):
        t = (yy - y) / max(1, th)
        col = mix(c1, c2, t)
        for xx in range(max(0, int(x)), min(W, int(x + tw + sc(40)))):
            gp[xx, yy] = (*col, 255)
    grad.putalpha(mask)
    canvas.alpha_composite(grad)

    # Tiny clock hand cut/accent in the counter area; readable on large icon, harmless on small.
    hand = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hand)
    cx, cy = sc(524), sc(522)
    # dark underlay for separation
    hd.line([(cx, cy), (cx + sc(92), cy - sc(112))], fill=(5, 13, 31, 205), width=sc(20))
    hd.line([(cx, cy), (cx - sc(64), cy - sc(58))], fill=(5, 13, 31, 150), width=sc(16))
    hd.ellipse([cx - sc(18), cy - sc(18), cx + sc(18), cy + sc(18)], fill=(6, 15, 33, 235))
    # luminous center dot
    hd.ellipse([cx - sc(8), cy - sc(8), cx + sc(8), cy + sc(8)], fill=(20, 214, 255, 255))
    canvas.alpha_composite(hand)


def make_icon() -> Image.Image:
    mask = rounded_squircle_mask()
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    add_round_rect_shadow(canvas, mask)
    bg = background(mask)
    canvas.alpha_composite(bg)

    # Inner highlight on top-left edge.
    edge = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ed = ImageDraw.Draw(edge)
    m = sc(84)
    ed.rounded_rectangle([m, m, W - m, H - m], radius=sc(214), outline=(255, 255, 255, 40), width=sc(3))
    edge.putalpha(Image.composite(edge.split()[-1], Image.new("L", (W, H), 0), mask))
    canvas.alpha_composite(edge)

    ring_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring_layer)
    glow = draw_ring(rd)
    canvas.alpha_composite(Image.composite(glow, Image.new("RGBA", (W, H), (0, 0, 0, 0)), mask))
    canvas.alpha_composite(Image.composite(ring_layer, Image.new("RGBA", (W, H), (0, 0, 0, 0)), mask))

    tick_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw_ticks(ImageDraw.Draw(tick_layer))
    canvas.alpha_composite(Image.composite(tick_layer, Image.new("RGBA", (W, H), (0, 0, 0, 0)), mask))

    draw_mark(canvas)

    # Final clipped squircle, downsampled.
    clipped = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    clipped.alpha_composite(canvas)
    # Keep external shadow but prevent any hard square edges.
    icon = clipped.resize((BASE, BASE), RESAMPLE)
    return icon


def save_iconset(icon: Image.Image) -> None:
    ICONSET.mkdir(parents=True, exist_ok=True)
    sizes = [16, 32, 64, 128, 256, 512, 1024]
    for size in sizes:
        icon.resize((size, size), RESAMPLE).save(OUT / f"GuruTime-icon-{size}.png")
    mapping = [
        (16, "icon_16x16.png"),
        (32, "icon_16x16@2x.png"),
        (32, "icon_32x32.png"),
        (64, "icon_32x32@2x.png"),
        (128, "icon_128x128.png"),
        (256, "icon_128x128@2x.png"),
        (256, "icon_256x256.png"),
        (512, "icon_256x256@2x.png"),
        (512, "icon_512x512.png"),
        (1024, "icon_512x512@2x.png"),
    ]
    for size, name in mapping:
        icon.resize((size, size), RESAMPLE).save(ICONSET / name)


def save_preview(icon: Image.Image) -> None:
    # Contact sheet: light/dark Finder-like backgrounds plus size sanity checks.
    preview = Image.new("RGBA", (1600, 950), (245, 247, 250, 255))
    d = ImageDraw.Draw(preview)
    font_big = load_font(52)
    font_small = load_font(28)
    d.text((80, 60), "GuruTime macOS icon", font=font_big, fill=(20, 24, 34, 255))
    d.text((82, 122), "Graphite squircle · timer ring · bold G mark", font=font_small, fill=(92, 101, 118, 255))

    # Light card
    d.rounded_rectangle([80, 190, 720, 830], radius=42, fill=(255, 255, 255, 255), outline=(223, 229, 239, 255), width=2)
    preview.alpha_composite(icon.resize((420, 420), RESAMPLE), (190, 275))
    d.text((260, 735), "Light desktop", font=font_small, fill=(80, 88, 105, 255))

    # Dark card
    d.rounded_rectangle([780, 190, 1420, 830], radius=42, fill=(13, 16, 26, 255), outline=(34, 42, 62, 255), width=2)
    preview.alpha_composite(icon.resize((420, 420), RESAMPLE), (890, 275))
    d.text((958, 735), "Dark desktop", font=font_small, fill=(202, 211, 230, 255))

    # Small sizes along bottom right.
    x, y = 1100, 96
    for size in [128, 64, 32, 16]:
        preview.alpha_composite(icon.resize((size, size), RESAMPLE), (x, y + (128 - size) // 2))
        d.text((x + 150, y + 48), f"{size}px", font=font_small, fill=(72, 81, 98, 255))
        y += 92
    preview.convert("RGB").save(OUT / "GuruTime-icon-preview.png", quality=96)


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    OUT.mkdir(exist_ok=True)
    icon = make_icon()
    icon.save(ASSETS / "icon.png")
    icon.resize((512, 512), RESAMPLE).save(ASSETS / "favicon.png")
    icon.save(OUT / "GuruTime-icon-1024.png")
    save_iconset(icon)
    save_preview(icon)
    print(ASSETS / "icon.png")
    print(ASSETS / "favicon.png")
    print(ICONSET)
    print(OUT / "GuruTime-icon-preview.png")


if __name__ == "__main__":
    main()
