"""Clean and cut the score pages for transcription.

    python tools/omr/pages.py --work scores/<work>                # all pages
    python tools/omr/pages.py --work scores/<work> --pages 3-5    # some printed pages

The page images are those of <work>/work/source/ (tools/source.py writes them from the PDF or
the photos; another folder: --images DIR); image -> printed page from work/pages.tsv
(or --offset N: printed page = image number + N).

Writes into <work>/work/img/:
    pNNN.png            cleaned page (deskewed, dewarped, high contrast)
    pNNN.json           layout: systems, staves, barlines (page pixels)
    pNNN_overlay.png    the page with what was found: systems (green), barlines (red) with the
                        number of the measure each one ends, a ruler in pixels above each system
    pNNN_sK.png         system K, whole: an overview, too small to read the notes on
    pNNN_sK_ch_mAAA-BBB.png  vocal staves of system K, measures AAA..BBB, enlarged, with the
                        sounding pitch of each staff line in the left margin: what the notes
                        are read on (e.g. p008_s2_ch_m005-006.png)
    pNNN_sK_pf_mAAA-BBB.png  keyboard staves, same
    crops.txt           the crops of every system, in order
NNN = printed page number.

Measures. work/measures.tsv says how many measures each system holds; the numbers on the crops
come from it. The first run writes it from the barlines found. Check it against the overlays;
where a count is wrong (a stem taken for a barline, a faint barline missed), correct `systems`
in measures.tsv and run again: the numbers of every page are recomputed, and the barlines are
fitted to the counts (a doubtful stroke is taken for a missing barline, the narrowest measure
is merged when there is one too many). A movement that starts with a pickup: `first` = 0 on
its first page. A barline no fitting finds: work/bars.tsv, one line `page system x [x…]`
(tab-separated; x read on the ruler of the overlay).

Systems. The staves joined by a line at their left end form a system; where an edition joins
them with a bracket only, the page is cut into systems alike (the `staves` of work.yaml, when
given, say how many staves a system has). A page whose systems differ (a solo with the piano,
then the choir): column `staves` of work/pages.tsv, e.g. 3,3,3,6.
Staves are named by their count (6 = S A T B PR PL, 4 = S A T B, 2 = PR PL, 3-5 = voices
then PR PL) or as work.yaml (`staves`) and work/pages.tsv (`solo`) say: see
pipeline/cht/workdir.py. The pitch margin assumes the usual clefs (S A: treble, T: treble
sounding an octave lower, also when the print has a plain treble clef, B PL: bass, PR: treble):
where the page prints another clef, read the clef, not the margin.
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
from pipeline.cht.measures import PageRow, load_measures, renumber, save_measures  # noqa: E402
from pipeline.cht import workdir  # noqa: E402

def clean_page(bgr: np.ndarray, counts: list[int] | None = None,
               per_system: int | list[int] | None = None) -> tuple[np.ndarray, list[lay.System]]:
    """-> (normalised, deskewed, dewarped grayscale page, layout).
    `counts`: staves per system of this page (work/pages.tsv), forces the grouping;
    `per_system`: staves of a system of the work (work.yaml `staves`), see lay.regular_counts."""
    gray = ip.to_gray(bgr)
    norm = ip.normalize_background(gray)
    lines = lambda im: ip.line_mask(im) | ip.binarize(im, 205)  # noqa: E731
    norm = ip.rotate(norm, ip.estimate_skew(ip.binarize(norm, 205)))
    norm, centres = dewarp.dewarp(norm, lines(norm))
    systems = lay.analyse(ip.binarize(norm, 205), ip.binarize(norm), lines(norm), centres, counts, per_system)
    return norm, systems


def load_hand_bars(work: Path) -> dict[int, dict[int, list[int]]]:
    """work/bars.tsv: the barlines placed by hand, {page: {system: [x, …]}}. One line per system,
    tab-separated: page, system, the x of each barline to add (pixels of work/img/pNNN_overlay.png,
    read on its ruler; several x separated by spaces or commas). '#' lines are comments."""
    path = Path(work) / "bars.tsv"
    res: dict[int, dict[int, list[int]]] = {}
    if not path.exists():
        return res
    for line in path.read_text(encoding="utf-8").splitlines():
        f = line.split("#")[0].replace(",", " ").split()
        if len(f) < 3 or not f[0].isdigit():
            continue
        res.setdefault(int(f[0]), {}).setdefault(int(f[1]), []).extend(int(float(x)) for x in f[2:])
    return res


BAR_COLOURS = {"found": (0, 0, 255), "doubt": (0, 140, 255), "hand": (200, 0, 160)}   # red, orange, purple (BGR)


def overlay(page: np.ndarray, systems: list[lay.System], labels: list[list[str]],
            kinds: list[dict[int, str]] | None = None) -> np.ndarray:
    """The page with what was found. `kinds[k][x]`: 'doubt' for a barline taken from the doubtful
    strokes to reach the count of measures.tsv, 'hand' for one of work/bars.tsv."""
    vis = cv2.cvtColor(page, cv2.COLOR_GRAY2BGR)
    for k, s in enumerate(systems):
        for st in s.staves:
            for y in st.lines:
                cv2.line(vis, (st.x0, y), (st.x1, y), (255, 170, 0), 1)
        cv2.line(vis, (s.start_x, s.top), (s.start_x, s.bottom), (0, 170, 0), 3)
        cv2.putText(vis, f"s{k + 1}", (4, s.top + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 140, 0), 2)
        # a ruler in page pixels, to place a barline by hand (work/bars.tsv)
        ry = max(12, s.top - 34)
        for x in range(0, vis.shape[1], 50):
            cv2.line(vis, (x, ry), (x, ry + (9 if x % 100 == 0 else 4)), (150, 150, 150), 1)
            if x % 200 == 0 and x:
                cv2.putText(vis, str(x), (x - 14, ry - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.36, (120, 120, 120), 1)
        for x, lab in zip(s.barlines, labels[k]):
            colour = BAR_COLOURS[(kinds[k] if kinds else {}).get(x, "found")]
            cv2.line(vis, (x, s.top - 8), (x, s.bottom + 8), colour, 2)
            cv2.putText(vis, lab, (x - 26, s.top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, colour, 2)
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


# sounding pitch of the 5 lines (bottom -> top), then of the two ledger lines below (the nearest
# first) and above: the notes outside the staff are the ones most often misread
LINE_NAMES = {
    "treble": (["E4", "G4", "B4", "D5", "F5"], ["C4", "A3"], ["A5", "C6"]),
    "tenor": (["E3", "G3", "B3", "D4", "F4"], ["C3", "A2"], ["A4", "C5"]),     # treble-8: sounds an octave lower
    "bass": (["G2", "B2", "D3", "F3", "A3"], ["E2", "C2"], ["C4", "E4"]),
}

def roles_of(names: list[str]) -> list[tuple[str, str]]:
    return [(nm, workdir.ROLE_OF.get(nm, "treble")) for nm in names]

GUTTER = 120
# The pictures are made for the eye that reads them: a vision model sees about 1500 px across,
# a larger picture is reduced before it is read and its detail is lost. So the scale follows
# the staff space of the page: a working crop shows it at CROP_SPACE px (a 7 px staff space of
# a small photo x4, an 18 px one of a 300 dpi scan x1.5), a zoom at ZOOM_SPACE px.
CROP_SPACE = 28
KEYS_SPACE = 34        # a keyboard's chords and inner voices need more than a vocal line
KEYS_WIDTH = 1568      # ... and a wider crop, so that two measures still go together
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
        for k in (1, 2):                 # where the ledger lines would be drawn, were the print exact
            for y, nm in ((ys[-1] + k * sp, below[k - 1]), (ys[0] - k * sp, above[k - 1])):
                if 8 < y < height - 4:
                    cv2.line(g, (GUTTER - 12, int(y)), (GUTTER, int(y)), (120, 200, 120), 1)
                    cv2.putText(g, nm, (GUTTER - 64, int(y) + 7), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 140, 0), 1)
    return g


def reconcile(sysm: lay.System, want: int, hand: list[int] | None = None) -> bool:
    """Bring the detected barlines of a system to the `want` measures counted on the page.
    Barlines placed by hand (work/bars.tsv) are added first and never dropped. Too few: the
    strokes the detection was not sure of (sysm.weak, best first) are taken for barlines.
    Too many (a stem, the end of a courtesy signature): the narrowest measure is merged,
    repeatedly; the end barline is dropped when the last measure is the narrowest."""
    sp = sysm.staves[0].space
    kept = sorted(x for x in (hand or []) if x > sysm.start_x)
    bars = sorted(set(sysm.barlines) | set(kept))
    # a hand-placed barline replaces the detected one it stands on
    bars = [b for b in bars if b in kept or all(abs(b - k) >= 2 * sp for k in kept)]
    for x in sysm.weak:
        if len(bars) >= want:
            break
        if all(abs(x - b) >= 3 * sp for b in bars):
            bars = sorted(bars + [x])
    while len(bars) > want:
        edges = [sysm.start_x] + bars
        widths = [edges[i + 1] - edges[i] for i in range(len(bars))]
        for i in np.argsort(widths):                      # the narrowest measure that can be merged
            i = int(i)
            drop = i if i == len(bars) - 1 or i == 0 else i - 1
            if bars[drop] in kept and i > 0 and bars[i] not in kept:
                drop = i
            if bars[drop] not in kept:
                del bars[drop]
                break
        else:
            break                                         # only hand-placed barlines left
    ok = len(bars) == want
    if ok or kept:
        sysm.barlines = bars
    return ok


def measure_labels(systems, page: int, mtable, hand: dict[int, list[int]] | None = None):
    """-> (labels, numbers, absolute, kinds, remarks). Per system: the labels and numbers of
    its measures, absolute (movement numbers) when the page is in measures.tsv with as many
    systems as were found, else local (1..n on the page). A system whose barlines could not be
    fitted to its count keeps its numbers (those of measures.tsv): it then has more or fewer
    barlines than numbers, and is shown whole. `kinds[k][x]` names the barlines that were not
    plainly found ('doubt', 'hand'); `remarks` says what to look at.
    A page shared by two movements has two rows: numbering restarts."""
    rows = mtable.rows(page) if hasattr(mtable, "rows") else ([mtable[page]] if mtable and page in mtable else [])
    want_all = [c for r in rows for c in r.systems]
    hand = hand or {}
    kinds: list[dict[int, str]] = [{} for _ in systems]
    remarks: list[str] = []
    if rows and len(want_all) == len(systems):
        for k, (sysm, want) in enumerate(zip(systems, want_all)):
            found = list(sysm.barlines)
            extra = hand.get(k + 1)
            if len(found) != want or extra:
                ok = reconcile(sysm, want, extra)
                kinds[k] = {x: ("hand" if x in (extra or []) else "doubt") for x in sysm.barlines if x not in found}
                doubt = sum(v == "doubt" for v in kinds[k].values())
                if not ok:
                    remarks.append(f"s{k + 1}: {len(sysm.barlines)} barline(s) for the {want} measure(s) of measures.tsv: correct the count, "
                                   f"or place the missing ones in work/bars.tsv (x on the ruler of the overlay); its crops show it uncut")
                elif doubt:
                    remarks.append(f"s{k + 1}: {doubt} barline(s) taken from doubtful strokes to reach {want} measures (orange on the overlay)")
                elif len(found) > want:
                    remarks.append(f"s{k + 1}: {len(found)} barlines found, {want} measures in measures.tsv: the narrowest merged")
    elif rows:
        remarks.append(f"{len(systems)} system(s) found, measures.tsv lists {len(want_all)}: correct its `systems`, "
                       f"or the grouping of the staves (column `staves` of work/pages.tsv)")
    else:
        for k, sysm in enumerate(systems):                      # no count yet: the hand-placed ones are added
            if hand.get(k + 1):
                found = list(sysm.barlines)
                reconcile(sysm, len(set(found) | set(hand[k + 1])), hand[k + 1])
                kinds[k] = {x: "hand" for x in sysm.barlines if x not in found}
    counts = [len(s.barlines) for s in systems]
    absolute = bool(rows) and len(want_all) == len(systems)
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
    labels = [[(f"m{v}" if absolute else str(v)) for v in ns] if len(ns) == c else ["?"] * c for ns, c in zip(nums, counts)]
    return labels, nums, absolute, kinds, remarks


def system_movements(page: int, mtable, n_systems: int) -> list[int | None]:
    rows = mtable.rows(page) if hasattr(mtable, "rows") else ([mtable[page]] if mtable and page in mtable else [])
    mv = [r.movement for r in rows for _ in r.systems]
    return mv if len(mv) == n_systems else [rows[0].movement if rows else None] * n_systems


def _caption(img: np.ndarray, text: str) -> np.ndarray:
    """A line of text above a picture: what it is, read with it."""
    body = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR) if img.ndim == 2 else img
    strip = np.full((30, body.shape[1], 3), 238, np.uint8)
    cv2.putText(strip, text, (8, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (0, 0, 170), 2)
    return np.vstack([strip, body])


def save_crops(page_img: np.ndarray, systems, page: int, nums, absolute: bool, out: Path,
               names: list[list[str]] | None = None) -> list[list[str]]:
    """System images and, per system and staff group (voices / piano), chunks of a few
    measures with measure labels and a pitch gutter, at the scale of the page's staff space.
    -> the names of the crops of each system, in reading order."""
    h, w = page_img.shape
    written: list[list[str]] = []
    for k, s in enumerate(systems):
        top, bot = _bounds(systems, k, h)
        sysimg = page_img[top:bot]
        span = (f"m{nums[k][0]}-{nums[k][-1]}" if absolute else f"{nums[k][0]}-{nums[k][-1]} (numbers of the page)") if nums[k] else ""
        whole = _resize(sysimg, min(2.0, SYSTEM_WIDTH / sysimg.shape[1]))
        cv2.imwrite(str(out / f"p{page:03d}_s{k + 1}.png"),
                    _caption(whole, f"p{page} system {k + 1}  {span}  -  overview: the notes are read on the crops p{page:03d}_s{k + 1}_ch_/_pf_"))
        # the vocal staves together (ch), the piano's together (pf)
        nm = names[k] if names else workdir.staff_names(len(s.staves))
        keys = [i for i, v in enumerate(nm) if v in ("PR", "PL")]
        voc = [i for i in range(len(nm)) if i not in keys]
        groups = [(g, [s.staves[i] for i in ix], [nm[i] for i in ix]) for g, ix in (("ch", voc), ("pf", keys)) if ix]
        bars = [s.start_x] + list(s.barlines)
        fitted = len(bars) - 1 == len(nums[k])
        files: list[str] = []
        for gname, staves, gnames in groups:
            gt, gb = _group_bounds(systems, k, staves, h)
            roles = roles_of(gnames)
            scale = scale_for(s.staves[0].space, KEYS_SPACE if gname == "pf" else CROP_SPACE, 4)
            max_w = ((KEYS_WIDTH if gname == "pf" else CROP_WIDTH) - GUTTER) / scale
            edges = bars
            if not fitted:      # barlines and numbers do not match: the system in equal parts, each named after all of it
                parts = max(1, int(np.ceil((bars[-1] - bars[0]) / max_w)))
                edges = [int(bars[0] + (bars[-1] - bars[0]) * q / parts) for q in range(parts + 1)]
            for i, j in _chunks(edges, max_w):
                x0 = max(0, int(edges[0] - 2 * staves[0].space)) if i == 0 else max(0, edges[i] - 8)
                x1 = min(w, edges[j] + 8)
                crop = _resize(page_img[gt:gb, x0:x1], scale)
                crop = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
                crop = np.hstack([_gutter(crop.shape[0], staves, gt, roles, scale), crop])
                if fitted:
                    marks = [(int(GUTTER + (edges[m] - x0) * scale + (0 if m else 4 * scale)),
                              f"m{nums[k][m]}" if absolute else str(nums[k][m])) for m in range(i, j)]
                    a, b = nums[k][i], nums[k][j - 1]
                else:
                    a, b = (nums[k][0], nums[k][-1]) if nums[k] else (0, 0)
                    marks = [(GUTTER + 8, f"part {i + 1}/{len(edges) - 1} of m{a}-{b} (barlines not fitted)")]
                tag = (f"m{a:03d}-{b:03d}" if absolute else f"{a}-{b}") + ("" if fitted else f"_part{i + 1}")
                name = f"p{page:03d}_s{k + 1}_{gname}_{tag}.png"
                cv2.imwrite(str(out / name), _label_strip(crop, marks))
                files.append(name)
        written.append(files)
    return written


def process(raw: Path, page: int, out: Path, mtable, solo: list[str] | None = None,
            counts: list[int] | None = None, per_system: int | list[int] | None = None,
            hand: dict[int, list[int]] | None = None, new_row=None) -> dict:
    """One page: its cleaned image, layout, overlay and crops. `new_row(page, counts)` is called
    for a page measures.tsv does not list yet: it adds its row, from the barlines found."""
    bgr = cv2.imread(str(raw))
    norm, systems = clean_page(bgr, counts, per_system)
    page_img = norm            # plain normalisation reads best (stretching clips noteheads)
    for old in out.glob(f"p{page:03d}_*"):
        old.unlink()
    cv2.imwrite(str(out / f"p{page:03d}.png"), page_img)
    rows = mtable.rows(page) if page in mtable else []
    # a row still as the detection wrote it, for other systems than those found now (the staves of
    # the page have been put together otherwise since): written again
    stale = len(rows) == 1 and rows[0].note.startswith(AUTO_NOTE) and len(rows[0].systems) != len(systems)
    if new_row is not None and (page not in mtable or stale):
        for k, sysm in enumerate(systems):                      # hand-placed barlines count from the start
            if (hand or {}).get(k + 1):
                reconcile(sysm, len(set(sysm.barlines) | set(hand[k + 1])), hand[k + 1])
        new_row(page, [len(s.barlines) for s in systems])
    labels, nums, absolute, kinds, remarks = measure_labels(systems, page, mtable, hand)
    names = [workdir.staff_names(len(s.staves), solo) for s in systems]
    if any(sy.guessed for sy in systems):
        remarks.insert(0, f"no line joins the staves at their left: put together by their spacing as {len(systems)} system(s) of "
                          f"{' '.join(str(len(sy.staves)) for sy in systems)} staves. If the page shows otherwise: its staves per "
                          f"system in work/pages.tsv (column `staves`, e.g. 3,3,3,6)")
    sizes = [per_system] if isinstance(per_system, int) else list(per_system or [])
    odd = [k + 1 for k, sy in enumerate(systems) if len(sy.staves) not in sizes]
    if sizes and odd and not counts:
        remarks.insert(0, f"system(s) {', '.join(map(str, odd))}: {' '.join(str(len(systems[k - 1].staves)) for k in odd)} staves, where a system "
                          f"of this work has {' or '.join(map(str, sizes))} (work.yaml `staves`). A soloist with the keyboard, the keyboard "
                          f"alone? Look at the overlay: if the staves are put together otherwise on the page, its staves per system "
                          f"in work/pages.tsv (column `staves`, e.g. 3,3,3,6)")
    d = lay.to_dict(systems)
    d.update(page=page, measures=[len(s.barlines) for s in systems], absolute_numbers=absolute,
             first_measure=nums[0][0] if nums and nums[0] else None,
             staff_names=names, movements=system_movements(page, mtable, len(systems)), numbers=nums)
    (out / f"p{page:03d}.json").write_text(json.dumps(d, indent=1))
    ov = overlay(page_img, systems, labels, kinds)
    cv2.imwrite(str(out / f"p{page:03d}_overlay.png"), ov)
    d["crops"] = save_crops(page_img, systems, page, nums, absolute, out, names=names)
    d["remarks"] = remarks
    return d


def parse_range(spec: str | None, available) -> list[int]:
    if not spec:
        return sorted(available)
    res = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        res.extend(range(int(a), int(b or a) + 1))
    return [p for p in res if p in available]


AUTO_NOTE = "from the barlines found"     # the note of a row of measures.tsv nobody has corrected yet

TSV_HELP = [
    "# Measures per system, page by page: the numbers on the crops, in the .cht files and in the app come from here.",
    "# Written from the barlines found: check each page against work/img/pNNN_overlay.png.",
    "# To correct: `systems` (measures per system, e.g. 4,5,4), `movement`; a movement that starts with a pickup:",
    "# `first` = 0 on its first page. Then run tools/omr/pages.py again: count, first and last are recomputed.",
]


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
    mpath = work / "measures.tsv"
    comments = [l for l in mpath.read_text(encoding="utf-8").splitlines() if l.startswith("#")] if mpath.exists() else TSV_HELP
    mtable = load_measures(mpath)

    def numbered() -> None:
        """The numbers follow the counts (a movement whose first page says `first` 0 has a pickup)."""
        pickups: dict[int, bool] = {}
        for r in mtable.all_rows():
            pickups.setdefault(r.movement, r.first == 0)
        renumber(mtable, pickups)

    before = [(r.page, r.movement, r.first) for r in mtable.all_rows()]
    numbered()
    added: list[int] = []

    def new_row(page: int, counts: list[int]) -> None:
        if page in mtable:                                      # (written again: see process)
            row = mtable.rows(page)[0]
            row.systems = list(counts)
        else:
            earlier = [r for r in mtable.all_rows() if r.page < page]
            mtable.add(PageRow(page, earlier[-1].movement if earlier else 1, counts, 1, f"{AUTO_NOTE}: check the overlay"))
        added.append(page)
        numbered()

    hand = load_hand_bars(work)
    raws = workdir.page_images(work, args.images, args.offset)
    todo = parse_range(args.pages, raws)
    index: list[str] = []
    for p in todo:
        d = process(raws[p], p, out, mtable, workdir.solo_voices(work, p), workdir.staves_per_system(work, p),
                    workdir.system_sizes(work), hand.get(p), new_row)
        nums = [n for ns in d["numbers"] for n in ns]
        span = (f"m{nums[0]}-{nums[-1]}" if d["absolute_numbers"] else "numbers of the page only") if nums else "no measure"
        print(f"p{p:03d}: {span}; {len(d['systems'])} system(s) of {' '.join(str(len(s['staves'])) for s in d['systems'])} staves, "
              f"measures {' '.join(map(str, d['measures']))}")
        for r in d["remarks"]:
            print(f"      {r}")
        for k, files in enumerate(d["crops"]):
            ns = d["numbers"][k]
            index.append(f"p{p:03d} s{k + 1} {('m' if d['absolute_numbers'] else '')}{ns[0]}-{ns[-1]}: {' '.join(files)}" if ns else f"p{p:03d} s{k + 1}:")
    if added or [(r.page, r.movement, r.first) for r in mtable.all_rows()] != before:
        save_measures(mpath, mtable, comments)
    # the list of the crops, in reading order (kept for the pages not redone)
    listing = out / "crops.txt"
    kept = [l for l in (listing.read_text(encoding="utf-8").splitlines() if listing.exists() else [])
            if l[:4] not in {f"p{p:03d}" for p in todo}]
    listing.write_text("\n".join(sorted(kept + index)) + "\n", encoding="utf-8")
    if added:
        print(f"{mpath} written from the barlines found (page(s) {added[0]}-{added[-1]}): check the measures of each system against "
              f"{out}/pNNN_overlay.png. Right: nothing to do. Else correct `systems` there (see its first lines) and run again.")
    # pages left as they were whose numbers have changed since
    stale = []
    for r in mtable.all_rows():
        js = out / f"p{r.page:03d}.json"
        if r.page not in todo and js.exists() and r.sys0 == 1:
            if json.loads(js.read_text()).get("first_measure") != r.first:
                stale.append(r.page)
    if stale:
        print(f"the measure numbers of page(s) {', '.join(map(str, stale))} have changed: run again without --pages")
    print(f"crops, in reading order: {listing}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
