"""Zoom on one or a few measures of a page, for doubtful notes.

    python tools/omr/zoom.py 4 50 --work scores/<work>              # page 4, measure 50, all staves, enlarged
    python tools/omr/zoom.py 4 50-51 --staff T --work scores/<work> # tenor only (with lyrics below it)
    python tools/omr/zoom.py 3 12 --staff PR,PL --scale 8 --work scores/<work>
    python tools/omr/zoom.py 9 3 --movement 2 --work scores/<work>
        # a page shared by two movements: --movement picks the measure

Writes work/zoom/pNNN_mA-B[_STAFF].png. The left margin names the sounding
pitch of every staff line (tenor: an octave below the written treble clef).
Needs work/img/pNNN.png + .json from tools/omr/pages.py (measure numbers come
from work/measures.tsv).
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

from tools.omr import layout as lay  # noqa: E402
from tools.omr import pages  # noqa: E402
from pipeline.cht import workdir  # noqa: E402


def zoom(work: Path, page: int, lo: int, hi: int, staves_sel: list[str] | None, scale: float | None,
         movement: int | None = None) -> Path:
    d = json.loads((work / "img" / f"p{page:03d}.json").read_text())
    img = cv2.imread(str(work / "img" / f"p{page:03d}.png"), cv2.IMREAD_GRAYSCALE)
    systems = lay.from_dict(d)
    first = d.get("first_measure") or 1
    if not d.get("absolute_numbers"):
        print("warning: page not in measures.tsv (or counts differ): measures numbered 1..n on this page")
    all_nums = d.get("numbers")
    if not all_nums:                       # older pNNN.json
        all_nums, n = [], first
        for s in systems:
            all_nums.append(list(range(n, n + len(s.barlines))))
            n += len(s.barlines)
    mvts = d.get("movements") or [None] * len(systems)
    for k, s in enumerate(systems):
        nums = all_nums[k]
        if lo in nums and (movement is None or mvts[k] in (None, movement)):
            break
    else:
        raise SystemExit(f"measure {lo} is not on page {page} (systems: {all_nums})")
    i = nums.index(lo)
    j = nums.index(hi) if hi in nums else len(nums) - 1
    edges = [s.start_x] + s.barlines
    names = (d.get("staff_names") or [None] * len(systems))[k] or workdir.staff_names(len(s.staves))
    chosen = [st for st, nm in zip(s.staves, names) if not staves_sel or nm in staves_sel]
    if not chosen:
        raise SystemExit(f"no staff {staves_sel} in this system ({names})")
    roles = [(nm, workdir.ROLE_OF.get(nm, "treble")) for st, nm in zip(s.staves, names) if st in chosen]
    top, bot = pages._group_bounds(systems, k, chosen, img.shape[0])
    sp = chosen[0].space
    if scale is None:   # a staff space shown at ZOOM_SPACE px (a 7 px one: x7)
        scale = pages.scale_for(sp, pages.ZOOM_SPACE, 9)
    x0 = max(0, int(edges[i] - (5 * sp if i else 0)) if i else int(edges[0] - 2 * sp))
    x1 = min(img.shape[1], int(edges[j + 1] + sp))
    crop = cv2.resize(img[top:bot, x0:x1], None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    crop = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGR)
    gut = pages._gutter(crop.shape[0], chosen, top, roles, scale)
    body = np.hstack([gut, crop])
    marks = [(int(pages.GUTTER + (edges[m] - x0) * scale), f"m{nums[m]}") for m in range(i, j + 1)]
    out = work / "zoom" / f"p{page:03d}_m{lo}-{nums[j]}{'_' + ''.join(staves_sel) if staves_sel else ''}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out), pages._label_strip(body, marks))
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("page", type=int)
    ap.add_argument("measures", help="N or A-B (movement measure numbers, same system)")
    ap.add_argument("--staff", help="comma list among S,A,T,B,PR,PL")
    ap.add_argument("--scale", type=float, help="enlargement (default: a staff space shown at 49 px, x7 for a small photo)")
    ap.add_argument("--movement", type=int, help="movement of the measure (page shared by two movements)")
    ap.add_argument("--work", type=Path, required=True, help="score folder (scores/<work>)")
    a = ap.parse_args(argv)
    lo, _, hi = a.measures.partition("-")
    sel = [x.strip() for x in a.staff.split(",")] if a.staff else None
    print(zoom(workdir.work_folder(a.work), a.page, int(lo), int(hi or lo), sel, a.scale, a.movement))
    return 0


if __name__ == "__main__":
    sys.exit(main())
