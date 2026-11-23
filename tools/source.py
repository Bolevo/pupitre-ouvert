"""The pages of a score, from the files a singer has: a scanned PDF, photos, or both.

    python tools/source.py scores/<work> partition.pdf
    python tools/source.py scores/<work> photos/*.jpg --first-page 2
    python tools/source.py scores/<work> a.pdf b.pdf --pages 3-40      # leave the covers out

Writes, in reading order (the order given; a PDF gives its pages in order):
    scores/<work>/work/source/NNNN.png   one image per page
    scores/<work>/work/pages.tsv         image -> printed page (first image = --first-page,
                                         default 1), to correct by hand where the print skips
                                         or restarts its numbers (pipeline/cht/workdir.py)
The printed page number names everything that follows (src/NNN.cht, work/img/pNNN.png,
pages/pNNN.webp) and is what the app shows.

`--pages A-B[,C…]`: keep only these (counted from 1 over all the files given).
A PDF page is rendered at --dpi (default 300), the long side kept under --max-side pixels
(default 3600: a staff space of 15-20 px, what the page tools are tuned for). A photo is
taken as it is (turned upright from its EXIF data), reduced the same way if it is larger.
A photo of two facing pages must be cut in two first (one page per image).

PDF rendering: pypdfium2 (`pip install pypdfium2`), else the command pdftoppm (poppler).
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".bmp"}


def pdf_pages(pdf: Path, dpi: int):
    """The pages of a PDF as BGR images, one at a time."""
    try:
        import pypdfium2
    except ImportError:
        pypdfium2 = None
    if pypdfium2 is not None:
        doc = pypdfium2.PdfDocument(str(pdf))
        for i in range(len(doc)):
            yield cv2.cvtColor(np.asarray(doc[i].render(scale=dpi / 72).to_pil().convert("RGB")), cv2.COLOR_RGB2BGR)
        return
    if not shutil.which("pdftoppm"):
        raise SystemExit("to read a PDF: pip install pypdfium2 (or install poppler's pdftoppm)")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdftoppm", "-r", str(dpi), "-png", str(pdf), str(Path(tmp) / "p")], check=True)
        for f in sorted(Path(tmp).glob("p-*.png"), key=lambda f: int(f.stem.split("-")[-1])):
            yield cv2.imread(str(f))


def images_of(files: list[Path], dpi: int):
    for f in files:
        if f.suffix.lower() == ".pdf":
            yield from pdf_pages(f, dpi)
        elif f.suffix.lower() in IMAGES:
            img = cv2.imread(str(f))   # turned upright from the EXIF orientation
            if img is None:
                raise SystemExit(f"unreadable image: {f}")
            yield img
        else:
            raise SystemExit(f"{f}: a PDF or an image is expected ({', '.join(sorted(IMAGES))})")


def parse_pages(spec: str | None) -> set[int] | None:
    if not spec:
        return None
    keep: set[int] = set()
    for part in spec.split(","):
        a, _, b = part.partition("-")
        keep.update(range(int(a), int(b or a) + 1))
    return keep


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("work", type=Path, help="score folder (scores/<work>)")
    ap.add_argument("files", type=Path, nargs="+", help="PDF files and images, in reading order")
    ap.add_argument("--pages", help="images to keep, counted from 1 over all the files, e.g. 3-40")
    ap.add_argument("--first-page", type=int, default=1, help="printed number of the first page kept")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--max-side", type=int, default=3600)
    ap.add_argument("--force", action="store_true", help="replace the pages already there")
    a = ap.parse_args(argv)
    out = a.work / "work" / "source"
    tsv = a.work / "work" / "pages.tsv"
    if (tsv.exists() or (out.exists() and any(out.iterdir()))) and not a.force:
        raise SystemExit(f"{out} already holds pages (--force to replace them and work/pages.tsv)")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    keep = parse_pages(a.pages)
    rows, n = ["image\tpage\tstaves\tsolo\tnote"], 0
    for i, img in enumerate(images_of(a.files, a.dpi), 1):
        if keep is not None and i not in keep:
            continue
        h, w = img.shape[:2]
        if max(h, w) > a.max_side:
            f = a.max_side / max(h, w)
            img = cv2.resize(img, (round(w * f), round(h * f)), interpolation=cv2.INTER_AREA)
        n += 1
        name = f"{n:04d}.png"
        cv2.imwrite(str(out / name), img)
        rows.append(f"{name}\t{a.first_page + n - 1}\t\t\t")
        print(f"{name}: page {a.first_page + n - 1}, {img.shape[1]}x{img.shape[0]} px")
    if not n:
        raise SystemExit("no page kept")
    tsv.write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(f"{n} page(s) -> {out}, {tsv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
