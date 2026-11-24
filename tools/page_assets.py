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
  - writes <work>/pages/staves.json: every staff printed in each system (first and fifth line,
    in the webp's pixels) - kept with the sources of the archive (pipeline/reopen.py)
  - draws <work>/work/boxes/<work>_pNNN.png: the page as the app has it, the box of every
    measure in grey, the staff of each part of the score in colour - what to look at
Barlines are fitted to the counts of measures.tsv as tools/omr/pages.py does (doubtful strokes
taken, narrowest measure merged, work/bars.tsv). A system that still does not fit is reported
(WARN): its measures get evenly spaced boxes so the app still works (correct measures.tsv or
place the barlines in work/bars.tsv, then rerun).
"""
from __future__ import annotations

import argparse
import json
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
from tools.omr.pages import load_hand_bars, reconcile  # noqa: E402
from tools.omr.surface import ANALYSIS_W, lines_of, rectify  # noqa: E402
from pipeline.cht.measures import load_measures  # noqa: E402
from pipeline.cht.workdir import load_pages_tsv, page_images, system_sizes  # noqa: E402
from tools import page_starts  # noqa: E402
from tools.page_staves import annotate, draw, score_staves, vocal_staves_of, write_pages  # noqa: E402

WIDTH = 1300


def process(args):
    img_path, page, rows, out, counts, frame, per_system, hand = args
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
    systems = lay.analyse(ip.binarize(det, 205), ip.binarize(det), lines_of(det), centres, counts or None, per_system)

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
    measures, sys_out, printed = [], [], []
    n = rows[0].first
    for k, want in enumerate(sys_counts):
        if k in sys_first:
            n = sys_first[k]
        if k < len(systems):
            s = systems[k]
            # barlines placed by hand (work/bars.tsv): given as shares of the system's width, the
            # same on this picture as on the one they were read on
            end = s.barlines[-1] if s.barlines else w - 40
            placed = [round(s.start_x + f * (end - s.start_x)) for f in hand.get(k + 1, [])]
            if (len(s.barlines) != want or placed) and not reconcile(s, want, placed):
                warn.append(f"p{page} s{k + 1}: {len(s.barlines)} barlines for the {want} measures of measures.tsv: "
                            f"boxes evenly spaced (correct the count, or place the barlines in work/bars.tsv)")
                x0s, x1 = s.start_x, (s.barlines[-1] if s.barlines else w - 40)
                step = (x1 - x0s) / want
                edges = [x0s + i * step for i in range(want + 1)]
            else:
                edges = [s.start_x] + list(s.barlines)
            top, bottom = back(s, s.top), back(s, s.bottom)
            # every staff printed in the system, first and fifth line (pages/staves.json)
            printed.append([[round(back(s, st.top) * scale), round(back(s, st.bottom) * scale)] for st in s.staves])
        else:  # system missing: share the remaining height
            printed.append([])
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
            "systems": sys_out, "measures": measures}, warn, printed


def hand_shares(work: Path, page: int, bars: dict[int, list[int]]) -> dict[int, list[float]]:
    """The barlines of work/bars.tsv (pixels of work/img/pNNN_overlay.png) as shares of the width of
    their system, from its opening line to its last barline (work/img/pNNN.json)."""
    js = work / "img" / f"p{page:03d}.json"
    if not bars or not js.exists():
        return {}
    systems = json.loads(js.read_text())["systems"]
    out: dict[int, list[float]] = {}
    for k, xs in bars.items():
        if 1 <= k <= len(systems) and systems[k - 1]["barlines"]:
            x0, x1 = systems[k - 1]["start_x"], systems[k - 1]["barlines"][-1]
            out[k] = [(x - x0) / (x1 - x0) for x in xs if x0 < x <= x1]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
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
    sizes = system_sizes(a.work / "work")
    hand_px = load_hand_bars(a.work / "work")
    jobs = []
    for page, img in sorted(page_images(a.work / "work", a.images, a.offset).items()):
        if page in mt:
            jobs.append((img, page, mt.rows(page), out, tsv.get(page, {}).get("staves"), not a.no_frame,
                         sizes, hand_shares(a.work / "work", page, hand_px.get(page, {}))))
    if not jobs:
        raise SystemExit("no page to prepare: work/measures.tsv lists no page that has an image")
    with ProcessPoolExecutor(a.jobs) as ex:
        results = list(ex.map(process, jobs))
    pages, warns = [r[0] for r in results], [w for r in results for w in r[1]]
    # where every printed staff is, system by system: not for the app (its own are systems[].staves,
    # those of the score only); pipeline/reopen.py reads it when the archive is opened again
    staves = sorted(({"page": r[0]["page"], "systems": r[2]} for r in results), key=lambda p: p["page"])
    (out / "staves.json").write_text(json.dumps(staves, separators=(",", ":")), encoding="utf-8")
    pages.sort(key=lambda p: p["page"])
    layout, detected = score_staves(a.work), {}
    staff_notes = annotate(pages, out, {m: n for m, (n, _) in layout.items()}, detected,   # systems[].staves, from the webp files
                           {m: k for m, (_, k) in layout.items()}, vocal_staves_of(a.work))
    start_notes = page_starts.annotate(pages, out, page_starts.signatures(a.work))   # measures[].xn, after the staves
    write_pages(out / "pages.json", pages)
    boxes = a.work / "work" / "boxes"
    draw(pages, out, boxes, a.work.name, detected)
    print(f"{len(pages)} pages -> {out}")
    for n in staff_notes:
        print("staves:", n)
    for n in start_notes:
        print("starts:", n)
    for w in warns:
        print("WARN", w)
    print(f"to look at: {boxes}/{a.work.name}_pNNN.png (grey: the box of each measure; colours: the staff of each part)")


if __name__ == "__main__":
    main()
