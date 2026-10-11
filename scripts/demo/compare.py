"""Put the same moment of two demo.webp files side by side, to check quality.

  uv run --no-project --with pillow python scripts/demo/compare.py \
      OLD.webp NEW.webp OUTDIR NAME=T:X,Y,W,H ...

T is seconds into the animation; X,Y,W,H is the crop in its 1280x800 frame.
Writes OUTDIR/compare-NAME.png, old on the left.
"""
import sys
from PIL import Image, ImageDraw


def frame_at(path, t):
    im = Image.open(path)
    best = 0
    for i in range(im.n_frames):
        im.seek(i)
        im.load()
        if im._WebPImageFile__timestamp / 1000 > t:
            break
        best = i
    im.seek(best)
    return im.convert("RGB")


old, new, out, *shots = sys.argv[1:]
for shot in shots:
    name, spec = shot.split("=")
    t, box = spec.split(":")
    x, y, w, h = map(int, box.split(","))
    crop = (x, y, x + w, y + h)
    a, b = frame_at(old, float(t)).crop(crop), frame_at(new, float(t)).crop(crop)
    c = Image.new("RGB", (w * 2 + 10, h + 24), "white")
    c.paste(a, (0, 24))
    c.paste(b, (w + 10, 24))
    d = ImageDraw.Draw(c)
    d.text((4, 6), "old", fill="black")
    d.text((w + 14, 6), "new", fill="black")
    c.save(f"{out}/compare-{name}.png")
