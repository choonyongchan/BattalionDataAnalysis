"""Regenerates `dashboard/src/assets/40SARlogo.png` from the source crest.

The source (`40SARlogo.webp`, repo root) ships on a solid black square, not a real
alpha channel. This flood-fills that background to transparent from the four corners
and crops to the crest's bounding box, so the same asset sits cleanly on both the
light and dark sidebar. Re-run this whenever the source crest image changes; the PNG
it writes is what `dashboard/src/app/Logo.jsx` actually imports.

Requires Pillow: `pip install pillow`.
"""

from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SOURCE = REPO_ROOT / "40SARlogo.webp"
DEST = REPO_ROOT / "dashboard" / "src" / "assets" / "40SARlogo.png"

# Flood-fill tolerance for the near-black anti-aliased pixels ringing the crest's
# white border. High enough to clear those without eating into the border itself.
FLOOD_FILL_THRESHOLD = 40


def make_logo() -> None:
    """Writes a transparent, cropped PNG of the crest to `DEST`.

    Raises:
        FileNotFoundError: If `SOURCE` does not exist.
    """
    image = Image.open(SOURCE).convert("RGBA")
    width, height = image.size

    corners = [(0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)]
    for seed in corners:
        if image.getpixel(seed)[3] != 0:
            ImageDraw.floodfill(image, seed, (0, 0, 0, 0), thresh=FLOOD_FILL_THRESHOLD)

    bbox = image.getbbox()
    if bbox:
        image = image.crop(bbox)

    DEST.parent.mkdir(parents=True, exist_ok=True)
    image.save(DEST)
    print(f"Wrote {DEST} ({image.size[0]}x{image.size[1]})")


if __name__ == "__main__":
    make_logo()
