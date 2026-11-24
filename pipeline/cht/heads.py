"""Set the noteheads printed on the page against the pitches written: the places to read again.

    python pipeline/cht/heads.py scores/<work>                # every page of src/
    python pipeline/cht/heads.py scores/<work> --pages 8-9

For each voice and measure, the noteheads of the page (looked for in work/img/pNNN.png between
the barlines of work/img/pNNN.json: tools/omr/pages.py) are compared with the notes of
src/NNN.cht. A measure is listed when a note written has no head at its height while a head
stands a step or two away:

    p10 m41 A: g3 written, the head stands 1 step higher (a3?)

It is a place to look at again (tools/omr/zoom.py), not a verdict: an accidental, a rest or a
slur can be taken for a head. A wrong rhythm is not seen, nor an octave. Measures whose heads
could not be told apart are counted, not listed. Voices only (the chords of a keyboard are too
dense); the usual clefs are assumed (S A: treble; T: treble sounding an octave lower; B: bass).
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

from pipeline.cht import workdir  # noqa: E402
from pipeline.cht.parse import ChtError, parse_file  # noqa: E402

STEP = "cdefgab"
BOTTOM_LINE = {"S": 30, "A": 30, "T": 23, "B": 18}      # the pitch on the bottom line (octave x 7 + step), sounding
INK = 140


def blobs(ink: np.ndarray, sp: float) -> list[tuple[float, float, int, int, int, bool]]:
    """The solid marks about as large as a notehead: (x, y, width, height, area, was hollow)."""
    # the small holes are filled: a white notehead becomes a solid one
    n, lab, st, _ = cv2.connectedComponentsWithStats(1 - ink, connectivity=4)
    small = (st[:, cv2.CC_STAT_AREA] <= 1.1 * sp * sp) & (st[:, cv2.CC_STAT_WIDTH] <= 1.9 * sp) & (st[:, cv2.CC_STAT_HEIGHT] <= 1.1 * sp)
    small[0] = False
    holes = small[lab]
    solid = ink | holes.astype(np.uint8)
    t = max(2, int(round(sp * 0.17)))
    thick = cv2.morphologyEx(solid, cv2.MORPH_OPEN, np.ones((2 * t + 1, 1), np.uint8))       # without staff and ledger lines
    thick = cv2.morphologyEx(thick, cv2.MORPH_OPEN, np.ones((1, 2 * t + 1), np.uint8))       # without stems
    oval = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (max(3, int(sp * 0.85)), max(3, int(sp * 0.62))))
    n, lab, st, cen = cv2.connectedComponentsWithStats(cv2.morphologyEx(thick, cv2.MORPH_OPEN, oval), connectivity=8)
    filled = np.bincount(lab.ravel(), weights=holes.ravel().astype(np.float64), minlength=n)
    return [(float(cen[i][0]), float(cen[i][1]), int(st[i][2]), int(st[i][3]), int(st[i][4]), bool(filled[i] > 0.04 * sp * sp))
            for i in range(1, n)]


def page_heads(img: np.ndarray, sp: float) -> list[tuple[float, float]]:
    """(x, y) of the noteheads of a page. Their size is learnt from the page itself: the black
    heads are its most common solid mark of that order (a rest, an accidental are smaller)."""
    marks = blobs((img < INK).astype(np.uint8), sp)
    sized = [m for m in marks if m[4] > 0.5 * sp * sp and m[2] < 2.2 * sp and m[3] < 1.6 * sp]
    black = [m[4] for m in sized if not m[5]] or [m[4] for m in sized]
    if len(black) < 10:
        return []
    size = float(np.median(black))
    size = float(np.median([a for a in black if a >= 0.8 * size]))
    # as large as a head, and lying down as a head does (a natural, a flat stand up)
    return [(m[0], m[1]) for m in marks
            if 0.85 * size <= m[4] <= (2.4 if m[5] else 1.6) * size and m[3] <= 1.7 * sp and 0.95 * m[3] <= m[2] <= 2.6 * sp]


def cells_of(work: Path, cht: Path) -> list[tuple]:
    """(page, measure, voice, positions written, [raw position of each head seen]) for every sung
    measure of a page whose barlines fit; a position counts half staff spaces from the bottom line."""
    page = parse_file(cht)
    js, png = work / "img" / f"p{page.page:03d}.json", work / "img" / f"p{page.page:03d}.png"
    if not js.exists() or not png.exists():
        return []
    d = json.loads(js.read_text())
    img = cv2.imread(str(png), cv2.IMREAD_GRAYSCALE)
    systems = d["systems"]
    if not systems:
        return []
    sp = float(np.median([(s["lines"][4] - s["lines"][0]) / 4 for sy in systems for s in sy["staves"]]))
    heads = page_heads(img, sp)
    by_num = {(m.number): m for m in page.measures}
    key, keys = (page.meta.key if page.meta and page.meta.key is not None else 0), {}
    for m in page.measures:                            # the key signature in force at each measure
        if m.meta is not None and m.meta.key is not None:
            key = m.meta.key
        keys[m.number] = key
    movements = d.get("movements") or [None] * len(systems)
    out = []
    for k, sysd in enumerate(systems):
        edges = [sysd["start_x"]] + list(sysd["barlines"])
        nums = (d.get("numbers") or [[]] * len(systems))[k]
        if len(edges) - 1 != len(nums) or movements[k] not in (None, page.movement):
            continue
        names = (d.get("staff_names") or [None] * len(systems))[k] or workdir.staff_names(len(sysd["staves"]))
        for st, name in zip(sysd["staves"], names):
            if name not in BOTTOM_LINE:
                continue
            lines = st["lines"]
            s, bot = (lines[4] - lines[0]) / 4, lines[4]
            for i, n in enumerate(nums):
                m = by_num.get(n)
                if m is None or name not in m.voices:
                    continue
                want = sorted(p.octave * 7 + STEP.index(p.step) - BOTTOM_LINE[name]
                              for ev in m.voices[name] if ev.kind == "note" for p in ev.pitches)
                if not want:
                    continue
                # at the start of a system: past the clef and the key signature, whose signs are marks too
                xa = edges[i] + ((4.0 + 1.2 * abs(keys.get(n, 0))) * s if i == 0 else 0.3 * s)
                xb = edges[i + 1] - 0.3 * s
                raw = sorted((bot - y) / (s / 2) for x, y in heads if xa <= x <= xb and lines[0] - 3.9 * s <= y <= bot + 3.9 * s)
                out.append((page.page, n, name, want, raw))
    return out


def ledger_levels(cells: list[tuple]) -> dict[int, float]:
    """Where each position outside the staff really stands in this edition. An engraver spaces
    the ledger lines as he pleases, often wider than the staff: learnt from the measures whose
    notes outside the staff are all at one position."""
    samples: dict[int, list[float]] = {}
    for _, _, _, want, raw in cells:
        for below in (True, False):
            outside = {p for p in want if (p < 0 if below else p > 8)}
            if len(outside) == 1:
                p = next(iter(outside))
                samples.setdefault(p, []).extend(r for r in raw if (r < -0.6 if below else r > 8.6) and abs(r - p) < 1.6)
    return {p: float(np.median(v)) for p, v in samples.items() if len(v) >= 3}


def name_of(position: int, voice: str) -> str:
    d = position + BOTTOM_LINE[voice]
    return f"{STEP[d % 7]}{d // 7}"


def judge(cells: list[tuple]) -> tuple[list[tuple], int, int]:
    """-> (the measures to read again: (page, measure, voice, [(position written, position seen)]),
    measures compared, measures that could not be judged)."""
    levels = ledger_levels(cells)

    def position(r: float) -> int:
        if -0.6 <= r <= 8.6:
            return round(r)
        side = [p for p in levels if (p < 0) == (r < 0)]
        best = min(side, key=lambda p: abs(levels[p] - r)) if side else None
        return best if best is not None and abs(levels[best] - r) < 0.45 else round(r)

    reports, blind = [], 0
    for page, n, voice, want, raw in cells:
        seen = [position(r) for r in raw]
        missing = list(want)
        for p in want:
            if p in seen:
                seen.remove(p)
                missing.remove(p)
        if not missing:
            continue                                          # every note written has its head
        near = [(p, [q for q in seen if 0 < abs(q - p) <= 2]) for p in missing]
        if all(c for _, c in near) and len(seen) <= len(missing) + 1:
            reports.append((page, n, voice, [(p, min(c, key=lambda q: abs(q - p))) for p, c in near]))
        else:
            blind += 1                                        # heads not found, or too many marks: nothing to say
    # a whole voice that disagrees is no list of mistakes: another clef than the one assumed
    for voice in BOTTOM_LINE:
        mine = [r for r in reports if r[2] == voice]
        compared = sum(1 for c in cells if c[2] == voice)
        if len(mine) >= 8 and len(mine) > 0.35 * compared:
            reports = [r for r in reports if r[2] != voice]
            reports.append((0, 0, voice, []))
    return reports, len(cells), blind


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("work", type=Path, help="score folder (scores/<work>)")
    ap.add_argument("--pages", help="only report these printed pages, e.g. 8-9")
    a = ap.parse_args(argv)
    work = workdir.work_folder(a.work)
    src = work.parent / "src"
    cells = []
    for cht in sorted(src.glob("*.cht")):
        try:
            cells += cells_of(work, cht)
        except ChtError as e:
            print(f"{cht.name}: not read ({e})")
    if not cells:
        print(f"nothing to compare: no page of {src} has its picture and layout in {work / 'img'} (tools/omr/pages.py)")
        return 0
    focus = None
    if a.pages:
        focus = set()
        for part in a.pages.split(","):
            lo, _, hi = part.partition("-")
            focus.update(range(int(lo), int(hi or lo) + 1))
    reports, compared, blind = judge(cells)
    listed = 0
    for page, n, voice, items in sorted(reports):
        if not items:
            print(f"{voice}: most of its measures disagree with the page: is this staff in another clef than the usual one? Not listed.")
            continue
        if focus is not None and page not in focus:
            continue
        listed += 1
        said = "; ".join(f"{name_of(p, voice)} written, the head stands {abs(q - p)} step{'s' if abs(q - p) > 1 else ''} "
                         f"{'higher' if q > p else 'lower'} ({name_of(q, voice)}?)" for p, q in items)
        print(f"p{page} m{n} {voice}: {said}")
    where = f" on page(s) {a.pages}" if a.pages else ""
    print(f"{listed} measure(s) to read again{where}; {compared} measures compared in all, {blind} could not be judged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
