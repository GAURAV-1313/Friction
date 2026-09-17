#!/usr/bin/env python3
"""
Turn raw screen captures into Chrome Web Store assets.

The store accepts screenshots at exactly 1280x800 or 640x400 and rejects anything
else, and a raw macOS capture is never either. It also dislikes PNGs that carry an
alpha channel, so everything is flattened onto an opaque background.

Rather than letterboxing onto black, the padding uses the Friction landing page's
own cream (#f9f5ef), so a capture narrower than 16:10 reads as a deliberate
framing instead of a badly cropped photo.

    python3 store-images.py shot1.png shot2.png ...          -> 1280x800 screenshots
    python3 store-images.py --tile logo.png                  -> 440x280 small promo tile
    python3 store-images.py --marquee hero.png               -> 1400x560 marquee tile
    python3 store-images.py --out ~/Desktop/store shot1.png  -> choose the output folder

Writes to ./store-assets/ by default and never overwrites the originals.
"""

import argparse
import os
import sys

from PIL import Image

BG = (249, 245, 239)  # --bg from web/public/landing.html
SIZES = {
    "screenshot": (1280, 800),
    "tile": (440, 280),
    "marquee": (1400, 560),
}


def fit(src_path, out_dir, size, label, index):
    with Image.open(src_path) as im:
        im = im.convert("RGB")  # drops alpha; the store rejects some alpha PNGs
        target_w, target_h = size

        # Scale to fit inside the target without distorting or cropping content.
        scale = min(target_w / im.width, target_h / im.height)
        new_w = max(1, round(im.width * scale))
        new_h = max(1, round(im.height * scale))
        im = im.resize((new_w, new_h), Image.LANCZOS)

        canvas = Image.new("RGB", (target_w, target_h), BG)
        canvas.paste(im, ((target_w - new_w) // 2, (target_h - new_h) // 2))

        base = os.path.splitext(os.path.basename(src_path))[0]
        out = os.path.join(out_dir, f"{label}-{index:02d}-{base}.png")
        canvas.save(out, "PNG", optimize=True)

    pad = "no padding" if (new_w, new_h) == size else f"padded from {new_w}x{new_h}"
    kb = os.path.getsize(out) // 1024
    print(f"  {os.path.basename(out)}  {target_w}x{target_h}  {pad}  {kb} KB")
    return out


def main():
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument("images", nargs="+")
    p.add_argument("--out", default="store-assets")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--tile", action="store_true", help="440x280 small promo tile")
    g.add_argument("--marquee", action="store_true", help="1400x560 marquee tile")
    args = p.parse_args()

    label = "tile" if args.tile else "marquee" if args.marquee else "screenshot"
    size = SIZES[label]

    missing = [i for i in args.images if not os.path.isfile(i)]
    if missing:
        print("not found:\n  " + "\n  ".join(missing), file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    print(f"{label} -> {size[0]}x{size[1]}, writing to {args.out}/")
    for i, src in enumerate(args.images, 1):
        fit(src, args.out, size, label, i)
    print(f"\n{len(args.images)} file(s) ready to upload.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
