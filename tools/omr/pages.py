"""Clean and cut the score pages for transcription.

    python tools/omr/pages.py --work scores/<work>                # all pages
    python tools/omr/pages.py --work scores/<work> --pages 3-5    # some printed pages

The page images are those of <work>/work/source/ (tools/source.py writes them from the PDF or
the photos; another folder: --images DIR); image -> printed page from work/pages.tsv
(or --offset N: printed page = image number + N).

Writes into <work>/work/img/:
    pNNN.png            cleaned page (deskewed, dewarped, high contrast)
    pNNN.json           layout: systems, staves, barlines (page pixels)
    pNNN_overlay.png    page with detected staves/barlines (to check counts)
    pNNN_sK.png         system K, whole
    pNNN_sK_ch_mA-B.png vocal staves of system K, measures A..B, enlarged, labelled,
                        with the sounding pitch of each staff line in the left margin
    pNNN_sK_pf_mA-B.png piano staves, same
NNN = printed page number. Measure labels are absolute movement measure
numbers when work/measures.tsv lists the page, else local (1..n) numbers.
Staves are named by their count (6 = S A T B PR PL, 4 = S A T B, 2 = PR PL, 3-5 = voices
then PR PL) or as work.yaml (`staves`) and work/pages.tsv (`solo`) say: see
pipeline/cht/workdir.py. The pitch margin assumes the usual clefs (S A: treble, T: treble
sounding an octave lower, B PL: bass, PR: treble): where the page prints another clef, read
the clef, not the margin. The names, movements and measure numbers of every system go to
pNNN.json.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.omr import dewarp, imgproc as ip, layout as lay  # noqa: E402
from pipeline.cht.measures import load_measures  # noqa: E402
from pipeline.cht import workdir  # noqa: E402

def clean_page(bgr: np.ndarray, counts: list[int] | None = None) -> tuple[np.ndarray, list[lay.System]]:
    """-> (normalised, deskewed, dewarped grayscale page, layout).
    `counts`: expected staves per system (work/pages.tsv), forces the grouping."""
    gray = ip.to_gray(bgr)
    norm = ip.normalize_background(gray)
    lines = lambda im: ip.line_mask(im) | ip.binarize(im, 205)  # noqa: E731
    norm = ip.rotate(norm, ip.estimate_skew(ip.binarize(norm, 205)))
    norm, centres = dewarp.dewarp(norm, lines(norm))
    systems = lay.analyse(ip.binarize(norm, 205), ip.binarize(norm), lines(norm), centres, counts)
    return norm, systems


def overlay(page: np.ndarray, systems: list[lay.System], labels: list[list[str]]) -> np.ndarray:
    vis = cv2.cvtColor(page, cv2.COLOR_GRAY2BGR)
    for k, s in enumerate(systems):
        for st in s.staves:
            for y in st.lines:
                cv2.line(vis, (st.x0, y), (st.x1, y), (255, 170, 0), 1)
        cv2.line(vis, (s.start_x, s.top), (s.start_x, s.bottom), (0, 170, 0), 3)
        cv2.putText(vis, f"s{k + 1}", (4, s.top + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 140, 0), 2)
        for x, lab in zip(s.barlines, labels[k]):
            cv2.line(vis, (x, s.top - 8), (x, s.bottom + 8), (0, 0, 255), 2)
            cv2.putText(vis, lab, (x - 26, s.top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)
    return vis


def _bounds(systems: list[lay.System], k: int, h: int) -> tuple[int, int]:
    s = systems[k]
    sp = s.staves[0].space
    top = (systems[k - 1].bottom + s.top) // 2 if k > 0 else max(0, int(s.top - 12 * sp))
    bot = (s.bottom + systems[k + 1].top) // 2 if k + 1 < len(systems) else min(h, int(s.bottom + 10 * sp))
    return top, bot


def _group_bounds(systems, k: int, staves: list[lay.Staff], h: int) -> tuple[int, int]:
    """Vertical extent of a staff group with the lyrics under its last staff."""
    s = systems[k]
    stop, sbot = _bounds(systems, k, h)
    i0 = s.staves.index(staves[0])
    i1 = s.staves.index(staves[-1])
    sp = staves[0].space
    top = stop if i0 == 0 else int(s.staves[i0 - 1].bottom + 0.35 * (staves[0].top - s.staves[i0 - 1].bottom))
    bot = sbot if i1 == len(s.staves) - 1 else int(staves[-1].bottom + 0.85 * (s.staves[i1 + 1].top - staves[-1].bottom))
    return max(0, min(top, int(staves[0].top - 4 * sp))), bot


def _chunks(edges: list[int], max_w: int) -> list[tuple[int, int]]:
    """Group measures (between consecutive edges) into runs no wider than max_w."""
    out, i = [], 0
    n = len(edges) - 1
    while i < n:
        j = i + 1
        while j < n and edges[j + 1] - edges[i] <= max_w:
            j += 1
        out.append((i, j))          # measures i..j-1
        i = j
    return out


def _label_strip(img: np.ndarray, marks: list[tuple[int, str]], height: int = 44) -> np.ndarray:
    strip = np.full((height, img.shape[1], 3), 255, np.uint8)
    for x, lab in marks:
        cv2.line(strip, (x, height - 14), (x, height), (0, 0, 255), 2)
        cv2.putText(strip, lab, (x + 6, height - 14), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
    body = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR) if img.ndim == 2 else img
    return np.vstack([strip, body])


# sounding pitch of the 5 lines (bottom -> top) and of the first ledger lines
LINE_NAMES = {
    "treble": (["E4", "G4", "B4", "D5", "F5"], "C4", "A5"),
    "tenor": (["E3", "G3", "B3", "D4", "F4"], "C3", "A4"),     # treble-8: sounds an octave lower
    "bass": (["G2", "B2", "D3", "F3", "A3"], "E2", "C4"),
}

def roles_of(names: list[str]) -> list[tuple[str, str]]:
    return [(nm, workdir.ROLE_OF.get(nm, "treble")) for nm in names]

GUTTER = 120
# The pictures are made for the eye that reads them: a vision model sees about 1500 px across,
# a larger picture is reduced before it is read and its detail is lost. So the scale follows
# the staff space of the page: a working crop shows it at CROP_SPACE px (a 7 px staff space of
# a small photo x4, an 18 px one of a 300 dpi scan x1.5), a zoom at ZOOM_SPACE px.
CROP_SPACE = 28
ZOOM_SPACE = 49
CROP_WIDTH = 1440      # widest working crop, margin included (px)
SYSTEM_WIDTH = 2200    # widest system overview (px)


def scale_for(space: float, target: float, most: float) -> float:
    """The enlargement that shows a staff space of `space` px at `target` px (0.5 .. most)."""
    return round(max(0.5, min(most, target / max(space, 1))), 2)


def _resize(img: np.ndarray, f: float) -> np.ndarray:
    return cv2.resize(img, None, fx=f, fy=f, interpolation=cv2.INTER_LANCZOS4 if f >= 1 else cv2.INTER_AREA)


def _gutter(height: int, staves, top: int, roles, scale: float) -> np.ndarray:
    """Left margin naming the (sounding) pitch of every staff line."""
    g = np.full((height, GUTTER, 3), 255, np.uint8)
    for st, (name, kind) in zip(staves, roles):
        lines, below, above = LINE_NAMES[kind]
        ys = [(y - top) * scale for y in st.lines]
        sp = (ys[-1] - ys[0]) / 4
        cv2.putText(g, name, (4, int(ys[0] + 2 * sp + 12)), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 0, 200), 3)
        for y, nm in zip(reversed(ys), lines):
            cv2.line(g, (GUTTER - 22, int(y)), (GUTTER, int(y)), (160, 160, 160), 1)
            cv2.putText(g, nm, (GUTTER - 64, int(y) + 7), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (90, 90, 90), 1)
        for y, nm in ((ys[-1] + sp, below), (ys[0] - sp, above)):
            cv2.putText(g, nm, (GUTTER - 64, int(y) + 7), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 140, 0), 1)
    return g


def reconcile(sysm: lay.System, want: int) -> bool:
    """Drop surplus detected barlines (stems, courtesy-signature ends) until the
    system has `want` measures: repeatedly merge the narrowest measure. The end
    barline is dropped when the last measure is the narrowest (courtesy area)."""
    bars = list(sysm.barlines)
    while len(bars) > want:
        edges = [sysm.start_x] + bars
        widths = [edges[i + 1] - edges[i] for i in range(len(bars))]
        i = int(np.argmin(widths))
        del bars[i if i == len(bars) - 1 or i == 0 else i - 1]
    ok = len(bars) == want
    if ok:
        sysm.barlines = bars
    return ok


def measure_labels(systems, page: int, mtable) -> tuple[list[list[str]], list[list[int]], bool]:
    """Per system: labels and numbers of its measures (absolute if the page is
    in measures.tsv and the detection can be reconciled with its counts).
    A page shared by two movements has two rows: numbering restarts."""
    rows = mtable.rows(page) if hasattr(mtable, "rows") else ([mtable[page]] if mtable and page in mtable else [])
    want_all = [c for r in rows for c in r.systems]
    if rows and len(want_all) == len(systems):
        for sysm, want in zip(systems, want_all):
            if len(sysm.barlines) != want:
                reconcile(sysm, want)
    counts = [len(s.barlines) for s in systems]
    absolute = bool(rows) and want_all == counts
    nums = []
    if absolute:
        for r in rows:
            n = r.first
            for c in r.systems:
                nums.append(list(range(n, n + c)))
                n += c
    else:
        n = 1
        for c in counts:
            nums.append(list(range(n, n + c)))
            n += c
    labels = [[(f"m{v}" if absolute else str(v)) for v in ns] for ns in nums]
    return labels, nums, absolute


def system_movements(page: int, mtable, n_systems: int) -> list[int | None]:
    rows = mtable.rows(page) if hasattr(mtable, "rows") else ([mtable[page]] if mtable and page in mtable else [])
    mv = [r.movement for r in rows for _ in r.systems]
    return mv if len(mv) == n_systems else [rows[0].movement if rows else None] * n_systems


def save_crops(page_img: np.ndarray, systems, page: int, nums, absolute: bool, out: Path,
               names: list[list[str]] | None = None) -> None:
    """System images and, per system and staff group (voices / piano), chunks of a few
    measures with measure labels and a pitch gutter, at the scale of the page's staff space."""
    h, w = page_img.shape
    for k, s in enumerate(systems):
        top, bot = _bounds(systems, k, h)
        sysimg = page_img[top:bot]
        scale = scale_for(s.staves[0].space, CROP_SPACE, 4)
        max_w = (CROP_WIDTH - GUTTER) / scale
        cv2.imwrite(str(out / f"p{page:03d}_s{k + 1}.png"), _resize(sysimg, min(2.0, SYSTEM_WIDTH / sysimg.shape[1])))
        # the vocal staves together (ch), the piano's together (pf)
        nm = names[k] if names else workdir.staff_names(len(s.staves))
        keys = [i for i, v in enumerate(nm) if v in ("PR", "PL")]
        voc = [i for i in range(len(nm)) if i not in keys]
        groups = [(g, [s.staves[i] for i in ix], [nm[i] for i in ix]) for g, ix in (("ch", voc), ("pf", keys)) if ix]
        edges = [s.start_x] + list(s.barlines)
        for gname, staves, gnames in groups:
            gt, gb = _group_bounds(systems, k, staves, h)
            roles = roles_of(gnames)
            for i, j in _chunks(edges, max_w):
                x0 = max(0, int(edges[0] - 2 * staves[0].space)) if i == 0 else max(0, edges[i] - 8)
                x1 = min(w, edges[j] + 8)
                crop = _resize(page_img[gt:gb, x0:x1], scale)
                crop = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
                crop = np.hstack([_gutter(crop.shape[0], staves, gt, roles, scale), crop])
                marks = [(int(GUTTER + (edges[m] - x0) * scale + (0 if m else 4 * scale)),
                          f"m{nums[k][m]}" if absolute else str(nums[k][m])) for m in range(i, j)]
                a, b = nums[k][i], nums[k][j - 1]
                tag = f"m{a:03d}-{b:03d}" if absolute else f"{a}-{b}"
                cv2.imwrite(str(out / f"p{page:03d}_s{k + 1}_{gname}_{tag}.png"), _label_strip(crop, marks))


def process(raw: Path, page: int, out: Path, mtable, solo: list[str] | None = None,
            counts: list[int] | None = None) -> dict:
    bgr = cv2.imread(str(raw))
    norm, systems = clean_page(bgr, counts)
    page_img = norm            # plain normalisation reads best (stretching clips noteheads)
    for old in out.glob(f"p{page:03d}_*"):
        old.unlink()
    cv2.imwrite(str(out / f"p{page:03d}.png"), page_img)
    labels, nums, absolute = measure_labels(systems, page, mtable)
    names = [workdir.staff_names(len(s.staves), solo) for s in systems]
    d = lay.to_dict(systems)
    d.update(page=page, measures=[len(s.barlines) for s in systems], absolute_numbers=absolute,
             first_measure=nums[0][0] if nums and nums[0] else None,
             staff_names=names, movements=system_movements(page, mtable, len(systems)), numbers=nums)
    (out / f"p{page:03d}.json").write_text(json.dumps(d, indent=1))
    ov = overlay(page_img, systems, labels)
    cv2.imwrite(str(out / f"p{page:03d}_overlay.png"), ov)
    save_crops(page_img, systems, page, nums, absolute, out, names=names)
    return d


def parse_range(spec: str | None, available) -> list[int]:
    if not spec:
        return sorted(available)
    res = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        res.extend(range(int(a), int(b or a) + 1))
    return [p for p in res if p in available]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--work", type=Path, required=True, help="score folder (scores/<work>)")
    ap.add_argument("--images", type=Path, help="folder of page images (default: <work>/work/source)")
    ap.add_argument("--offset", type=int, help="printed page = image number + OFFSET (instead of pages.tsv)")
    ap.add_argument("--pages", help="printed pages, e.g. 3-5,8")
    args = ap.parse_args(argv)
    work: Path = workdir.work_folder(args.work)
    out = work / "img"
    out.mkdir(parents=True, exist_ok=True)
    mtable = load_measures(work / "measures.tsv")
    raws = workdir.page_images(work, args.images, args.offset)
    for p in parse_range(args.pages, raws):
        d = process(raws[p], p, out, mtable, workdir.solo_voices(work, p),
                    workdir.staves_per_system(work, p))
        flag = "" if d["absolute_numbers"] else "  (local numbers: page not in measures.tsv or counts differ)"
        print(f"p{p:03d}: systems={len(d['systems'])} staves={[len(s['staves']) for s in d['systems']]} "
              f"measures={d['measures']}{flag}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
