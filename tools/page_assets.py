"""Page images + measure boxes for the app's page view.

    python tools/page_assets.py scores/<work>

The page images are those of <work>/work/source/ (another folder: --images DIR); image ->
printed page from work/pages.tsv (or --offset N: printed page = image number + N).

For every page listed in <work>/work/measures.tsv:
  - straightens the photo at full resolution (white background, deskew, one smooth surface:
    tools/omr/surface.py), frames it (what surrounds the printed page is cut away:
    tools/omr/frame.py; --no-frame keeps the whole image), then reduces it once
  - detects systems and barlines, reconciles them with the measure counts of measures.tsv
  - writes <work>/pages/pNNN.webp (grayscale, WIDTH px wide) and <work>/pages/pages.json:
    [{page, img, w, h, systems:[{top,bottom}], measures:[{mv, n, x0, x1, y0, y1, sys}]}]
    (coordinates in the webp's pixels; mv = movement number, n = printed measure number)
  - adds systems[].staves (staff positions, for the per-voice highlight) with
    tools/page_staves.py, which can also be rerun alone on the webp files
  - adds xn to the first measure of every system (where its music starts, after the clef
    and the signatures: the playhead's start) with tools/page_starts.py, same remark
Pages whose detection cannot be reconciled are reported; their measures get evenly
spaced boxes so the app still works (fix measures.tsv or the photo, then rerun).
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from tools.omr import imgproc as ip, layout as lay  # noqa: E402
from tools.omr import dewarp  # noqa: E402
from tools.omr.frame import content_box  # noqa: E402
from tools.omr.pages import reconcile  # noqa: E402
from tools.omr.surface import ANALYSIS_W, lines_of, rectify  # noqa: E402
from pipeline.cht.measures import load_measures  # noqa: E402
from pipeline.cht.workdir import load_pages_tsv, page_images  # noqa: E402
from tools import page_starts  # noqa: E402
from tools.page_staves import annotate, staff_counts, write_pages  # noqa: E402

WIDTH = 1300


def process(args):
    img_path, page, rows, out, counts, frame = args
    gray = cv2.imread(str(img_path), cv2.IMREAD_GRAYSCALE)
    # straightened once at full resolution with one smooth surface (tools/omr/surface.py);
    # the layout detector is tuned for ~1100 px wide pages: it works on a reduced copy
    flat, surf, _angle = rectify(gray)
    if frame:
        # framed: what surrounds the printed page (margins, the table, a shadow) is cut away
        box = content_box(flat)
        if box:
            flat = np.ascontiguousarray(flat[box[1]:box[3], box[0]:box[2]])
    H, W = flat.shape
    norm = cv2.resize(flat, (ANALYSIS_W, round(H * ANALYSIS_W / W)), interpolation=cv2.INTER_AREA)
    # the layout is found on a copy flattened further by the local dewarp (exactly straight staff
    # lines help the barline search; its small kinks do not matter there): it only moves pixels
    # vertically, so x positions are those of the displayed page and heights are mapped back.
    # `counts` (work/pages.tsv): staves per system, forces the grouping when the detection differs
    mx, my, centres = dewarp.displacement_field(norm.shape, dewarp.staff_tracks(lines_of(norm)), norm.shape[1] / 2)
    det = cv2.remap(norm, mx, my, interpolation=cv2.INTER_CUBIC, borderValue=255)
    systems = lay.analyse(ip.binarize(det, 205), ip.binarize(det), lines_of(det), centres, counts or None)

    def back(s, y):
        """A height on the analysis copy -> the same point on the displayed page."""
        xc = min(norm.shape[1] - 1, max(0, (s.start_x + (s.barlines[-1] if s.barlines else norm.shape[1] - 40)) // 2))
        return float(my[min(max(int(y), 0), norm.shape[0] - 1), xc])
    h, w = norm.shape
    scale = WIDTH / w
    # the displayed page: reduced once from full resolution, the faded zones of the print brought
    # back (tone only: tools/omr/imgproc.py restore_faded), paper made white (the other side of the
    # sheet showing through), ink a little darker
    small = cv2.resize(flat, (WIDTH, round(H * WIDTH / W)), interpolation=cv2.INTER_AREA)
    small = ip.enhance(ip.restore_faded(small), black=50, white=218)
    cv2.imwrite(str(out / f"p{page:03d}.webp"), small, [cv2.IMWRITE_WEBP_QUALITY, 85])
    # a flat scan needs no more than the deskew: said only when a curved page could not be flattened
    warn = [] if surf.accepted or surf.reason == "already_flat" else [f"p{page}: page only deskewed ({surf.reason})"]
    # a page shared by two movements has one row per movement, systems in page order
    sys_counts = [c for r in rows for c in r.systems]
    sys_mv = [r.movement for r in rows for _ in r.systems]
    sys_first = {}  # page system index -> first measure number of a row
    k0 = 0
    for r in rows:
        sys_first[k0] = r.first
        k0 += len(r.systems)
    if len(systems) != len(sys_counts):
        warn.append(f"p{page}: {len(systems)} systems detected, {len(sys_counts)} expected")
    measures, sys_out = [], []
    n = rows[0].first
    for k, want in enumerate(sys_counts):
        if k in sys_first:
            n = sys_first[k]
        if k < len(systems):
            s = systems[k]
            if len(s.barlines) != want and not reconcile(s, want):
                warn.append(f"p{page} s{k + 1}: {len(s.barlines)} barlines, {want} expected (evenly spaced)")
                x0s, x1 = s.start_x, (s.barlines[-1] if s.barlines else w - 40)
                step = (x1 - x0s) / want
                edges = [x0s + i * step for i in range(want + 1)]
            else:
                edges = [s.start_x] + list(s.barlines)
            top, bottom = back(s, s.top), back(s, s.bottom)
        else:  # system missing: share the remaining height
            top = sys_out[-1]["bottom"] / scale + 40 if sys_out else 80
            bottom = h - 60
            edges = [60 + i * (w - 120) / want for i in range(want + 1)]
        # extend the band to lyrics below / marks above, halfway to the neighbours
        pad_top = 20
        pad_bot = 35
        sys_out.append({"top": round((top - pad_top) * scale), "bottom": round((bottom + pad_bot) * scale)})
        for i in range(want):
            mv = sys_mv[k]
            measures.append({
                "mv": mv, "n": n, "sys": k,
                "x0": round(edges[i] * scale), "x1": round(edges[i + 1] * scale),
                "y0": round((top - pad_top) * scale), "y1": round((bottom + pad_bot) * scale),
            })
            n += 1
    return {"page": page, "img": f"p{page:03d}.webp", "w": small.shape[1], "h": small.shape[0],
            "systems": sys_out, "measures": measures}, warn


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work", type=Path, help="scores/<work>")
    ap.add_argument("--images", type=Path, help="folder of page images (default: <work>/work/source)")
    ap.add_argument("--offset", type=int, help="printed page = image number + OFFSET (instead of work/pages.tsv)")
    ap.add_argument("--jobs", type=int, default=2)
    ap.add_argument("--no-frame", action="store_true", help="keep the whole image (default: cut to what is printed)")
    a = ap.parse_args()
    mt = load_measures(a.work / "work" / "measures.tsv")
    tsv = load_pages_tsv(a.work / "work")
    out = a.work / "pages"
    out.mkdir(exist_ok=True)
    jobs = []
    for page, img in sorted(page_images(a.work / "work", a.images, a.offset).items()):
        if page in mt:
            jobs.append((img, page, mt.rows(page), out, tsv.get(page, {}).get("staves"), not a.no_frame))
    if not jobs:
        raise SystemExit("no page to prepare: work/measures.tsv lists no page that has an image")
    with ProcessPoolExecutor(a.jobs) as ex:
        results = list(ex.map(process, jobs))
    pages, warns = [r[0] for r in results], [w for r in results for w in r[1]]
    pages.sort(key=lambda p: p["page"])
    staff_notes = annotate(pages, out, staff_counts(a.work))   # systems[].staves, from the webp files
    start_notes = page_starts.annotate(pages, out, page_starts.signatures(a.work))   # measures[].xn, after the staves
    write_pages(out / "pages.json", pages)
    print(f"{len(pages)} pages -> {out}")
    for n in staff_notes:
        print("staves:", n)
    for n in start_notes:
        print("starts:", n)
    for w in warns:
        print("WARN", w)


if __name__ == "__main__":
    main()
