"""Optional regeneration of the application-owned bridge icon (requires Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
im = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
draw = ImageDraw.Draw(im)
draw.rounded_rectangle((8, 8, 248, 248), radius=66, fill="#254f3d")
ink = "#e2efcf"
for left, right, top, bottom in [(52, 204, 55, 207), (81, 175, 84, 178)]:
    draw.arc((left, top, right, bottom), start=180, end=360, fill=ink, width=12)
    draw.line((left + 5, (top + bottom) // 2, left + 5, 202), fill=ink, width=12)
    draw.line((right - 5, (top + bottom) // 2, right - 5, 202), fill=ink, width=12)
draw.line((42, 207, 214, 207), fill=ink, width=12)
im.save(root / "assets" / "icon.png")
im.save(root / "assets" / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
