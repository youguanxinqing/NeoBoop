#!/usr/bin/env python3
"""Render the NeoBoop app icon.

Design intent ("沉着稳重"): a matte squircle — calm, steady, tool-like — with a
"scratchpad" glyph (rows of text, the last one "live"). Palette is a single cool
family (greenish slate + muted sage) so the background, the text rows, and the
live row belong together instead of clashing.
"""

import numpy as np
from PIL import Image, ImageDraw

S = 4  # supersample factor
N = 1024  # final size
W = N * S  # working size

# ---- squircle (superellipse) mask -----------------------------------------
inset = 88 * S  # padding inside the canvas, matches macOS app icons
n = 5.0  # superellipse exponent → Apple-like squircle
cx = cy = W / 2
a = (W - 2 * inset) / 2  # half-width of the squircle

ys, xs = np.mgrid[0:W, 0:W]
norm = (np.abs((xs - cx) / a) ** n) + (np.abs((ys - cy) / a) ** n)
edge = 1.5 * S / a  # soft 1px edge for anti-aliasing
mask = np.clip((1.0 - norm) / edge + 0.5, 0.0, 1.0)

# ---- vertical greenish-slate gradient --------------------------------------
top = np.array([49, 55, 52], dtype=float)  # #313734
bot = np.array([22, 27, 25], dtype=float)  # #161B19
t = (ys / W)[..., None]
grad = top * (1 - t) + bot * t

# subtle top sheen for depth
sheen = np.clip(1.0 - (ys / W) / 0.45, 0.0, 1.0)[..., None] ** 2
grad = np.clip(grad + sheen * 10.0, 0, 255)

rgba = np.zeros((W, W, 4), dtype=float)
rgba[..., :3] = grad
rgba[..., 3] = mask * 255
img = Image.fromarray(rgba.astype(np.uint8), "RGBA")
draw = ImageDraw.Draw(img)


def capsule(p1, p2, width, fill):
    """A line with round caps — the building block for the glyph strokes."""
    draw.line([p1, p2], fill=fill, width=int(width))
    r = width / 2
    for x, y in (p1, p2):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=fill)


LINE = (230, 233, 228, 255)  # #E6E9E4 — text rows
SAGE = (144, 174, 137, 255)  # #90AE89 — the muted-sage "live" row

stroke = 74 * S

# scratchpad: two text rows + one shorter "live" row in sage
capsule((316 * S, 400 * S), (708 * S, 400 * S), stroke, LINE)
capsule((316 * S, 512 * S), (708 * S, 512 * S), stroke, LINE)
capsule((316 * S, 624 * S), (560 * S, 624 * S), stroke, SAGE)

# ---- downsample to final size ----------------------------------------------
out = img.resize((N, N), Image.LANCZOS)
out.save("icon_source.png")
print("wrote icon_source.png", out.size)
