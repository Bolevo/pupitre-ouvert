"""Images and video of the help page (app/aide.html) from the raw shots of shots.cjs.

Usage: python tools/help/help_images.py <raw dir> [<out dir>, default app/src/aide/img]
WebP for the screenshots (precached by the app: the help works offline), MP4 (H.264, read by
every browser, iPhone included) for the short video, with a WebP poster (its first image after
the start, shown before it plays and when animations are reduced).
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image

raw = Path(sys.argv[1])
out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[2] / "app/src/aide/img"
out.mkdir(parents=True, exist_ok=True)

# name: largest width kept (px); phone shots are 720 px wide (360 CSS px at scale 2)
WIDTHS = {
    "voice": 720, "hero": 720, "tracks": 720, "hold": 720, "tempo": 720, "goto": 720, "rec": 720,
    "desk": 1600, "memo": 1600, "metro": 900,
}
# phone shots kept only where the control is (top, bottom in CSS pixels of the 360 x 780 screen)
CROPS = {"hold": (575, 780), "tempo": (470, 780), "goto": (350, 600), "rec": (575, 780)}
for name, width in WIDTHS.items():
    src = raw / f"{name}.png"
    if not src.exists():
        print(f"{name}: missing")
        continue
    im = Image.open(src).convert("RGB")
    if name in CROPS:
        top, bottom = CROPS[name]
        im = im.crop((0, top * 2, im.width, bottom * 2))
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(out / f"{name}.webp", quality=80, method=6)
    print(f"{name}.webp {im.width}x{im.height} {(out / f'{name}.webp').stat().st_size // 1024} KB")

frames = raw / "frames"
if (frames / "list.txt").exists():
    mp4 = out / "lecture.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(frames / "list.txt"),
         "-vf", "fps=25,format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "27",
         "-profile:v", "main", "-movflags", "+faststart", "-an", str(mp4)],
        check=True,
    )
    first = sorted(frames.glob("f*.png"))[len(list(frames.glob("f*.png"))) // 6]
    Image.open(first).convert("RGB").save(out / "lecture.webp", quality=80, method=6)
    print(f"lecture.mp4 {mp4.stat().st_size // 1024} KB, poster {first.name}")
