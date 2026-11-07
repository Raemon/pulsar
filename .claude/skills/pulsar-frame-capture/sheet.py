#!/usr/bin/env python3
"""Tile a run of captured frames into one labelled contact sheet.

    python3 sheet.py OUT.png FRAME.png [FRAME.png ...] [--cols 4] [--scale 1.5] [--crop L,T,R,B]

Frames are pasted in the order given (sort the glob yourself), each labelled
with its file name, so a whole animation can be read in one image.
"""
import argparse
import os

from PIL import Image, ImageDraw

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("frames", nargs="+")
ap.add_argument("--cols", type=int, default=4)
ap.add_argument("--scale", type=float, default=1.0)
ap.add_argument("--crop", default=None, help="L,T,R,B in frame pixels")
args = ap.parse_args()

tiles = []
for f in args.frames:
    im = Image.open(f).convert("RGB")
    if args.crop:
        im = im.crop(tuple(int(v) for v in args.crop.split(",")))
    if args.scale != 1:
        im = im.resize((int(im.width * args.scale), int(im.height * args.scale)), Image.LANCZOS)
    ImageDraw.Draw(im).text((6, 6), os.path.splitext(os.path.basename(f))[0], fill=(255, 255, 0))
    tiles.append(im)

w = max(t.width for t in tiles)
h = max(t.height for t in tiles)
rows = (len(tiles) + args.cols - 1) // args.cols
sheet = Image.new("RGB", (w * args.cols, h * rows))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % args.cols) * w, (i // args.cols) * h))
sheet.save(args.out)
print(f"{args.out} {sheet.size[0]}x{sheet.size[1]} ({len(tiles)} frames)")
