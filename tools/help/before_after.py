"""The picture « a photo, and the page the app shows » of the page « Créer l'archive ».

    python tools/help/before_after.py        # -> app/src/aide/img/avant-apres.webp

Made from the scan of the example (scores/locus-iste, public domain): no photo of a protected
score is shown. The photo is simulated - the page seen at an angle on a table, a little
curled, in uneven light with a shadow across it. What the page tools make of it is real: the
second half of the picture is what tools/page_assets.py writes from that photo.
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools import source  # noqa: E402

WORK = ROOT / "scores" / "locus-iste"
OUT = ROOT / "app" / "src" / "aide" / "img" / "avant-apres.webp"


def photo_of(scan: np.ndarray) -> np.ndarray:
    """The scanned page as a phone would photograph it on a table."""
    rng = np.random.default_rng(7)
    gray = scan if scan.ndim == 2 else cv2.cvtColor(scan, cv2.COLOR_BGR2GRAY)
    w = 1500
    gray = cv2.resize(gray, (w, round(gray.shape[0] * w / gray.shape[1])), interpolation=cv2.INTER_AREA)
    h = gray.shape[0]
    # the sheet: cream paper, ink a little grey
    ink = gray.astype(np.float32)[..., None] / 255
    sheet = ink * np.array([198, 222, 232], np.float32) + (1 - ink) * np.array([52, 48, 46], np.float32)
    # a gentle curl: the lines sag towards the middle of the page
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    sheet = cv2.remap(sheet, xs, ys - 14 * np.sin(np.pi * xs / w) * (0.4 + 0.6 * ys / h), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    # the table, and the sheet seen at an angle on it
    W, H = 2000, 2700
    grain = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 9, sigmaY=1.2)
    table = np.array([70, 95, 128], np.float32) + grain[..., None] * 60
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]),
                                    np.float32([[330, 250], [1760, 330], [1690, 2470], [215, 2380]]))
    warped = cv2.warpPerspective(sheet, M, (W, H), flags=cv2.INTER_LINEAR)
    mask = cv2.warpPerspective(np.ones((h, w), np.float32), M, (W, H))
    cast = np.clip(cv2.GaussianBlur(np.roll(mask, (18, 14), (0, 1)), (0, 0), 16) - mask, 0, 1)   # the sheet's shadow on the table
    photo = table * (1 - 0.45 * cast)[..., None] * (1 - mask[..., None]) + warped * mask[..., None]
    # the light: brighter at the top right, a shadow across the lower left
    Y, X = np.mgrid[0:H, 0:W].astype(np.float32)
    light = 0.72 + 0.34 * (X / W) * (1 - Y / H) + 0.10 * (1 - Y / H)
    shadow = 1 - 0.30 * np.clip(1.25 - np.hypot((X - 250) / 900, (Y - 2350) / 800), 0, 1)
    photo = cv2.GaussianBlur(photo * (light * shadow)[..., None], (0, 0), 1.1) + rng.normal(0, 3.2, photo.shape)
    return np.clip(photo, 0, 255).astype(np.uint8)


def main() -> int:
    scan = list(source.pdf_pages(WORK / "source.pdf", 300))[1]             # after the cover: printed page 8
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "photo"
        work.mkdir()
        shot = Path(tmp) / "photo.jpg"
        cv2.imwrite(str(shot), photo_of(scan), [cv2.IMWRITE_JPEG_QUALITY, 82])
        for f in ("work.yaml", "mvt1.musicxml"):
            shutil.copy(WORK / f, work / f)
        run = lambda *a: subprocess.run([sys.executable, *a], cwd=ROOT, check=True, capture_output=True)  # noqa: E731
        run("tools/source.py", str(work), str(shot), "--first-page", "8")
        run("tools/omr/pages.py", "--work", str(work))
        run("tools/page_assets.py", str(work))
        before = cv2.imread(str(shot))
        after = cv2.imread(str(work / "pages" / "p008.webp"))
    h = 900
    fit = lambda im: cv2.resize(im, (round(im.shape[1] * h / im.shape[0]), h), interpolation=cv2.INTER_AREA)  # noqa: E731
    a, b = fit(before), fit(after)
    b = cv2.copyMakeBorder(b, 0, 0, 1, 1, cv2.BORDER_CONSTANT, value=(205, 205, 205))
    gap = np.full((h, 28, 3), 255, np.uint8)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(OUT), np.hstack([a, gap, b]), [cv2.IMWRITE_WEBP_QUALITY, 82])
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
