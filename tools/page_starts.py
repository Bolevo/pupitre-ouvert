"""Where the music starts in the first measure of every system of the page images (for the
app's playhead).

    python tools/page_starts.py                       # every work having scores/<work>/pages/pages.json
    python tools/page_starts.py scores/<work>        # one work
    python tools/page_starts.py --dry-run --draw DIR  # report only, write contact sheets to DIR

The first measure of a system begins with the clef, the key signature and sometimes the time
signature: its box starts at the left edge of the system, well before its first note. The app
moves its playhead across a measure from x0 to x1, the first beat on the barline; in these
measures the first beat was on the clef. This adds to their box in pages.json

    measures: [{mv, n, sys, x0, x1, y0, y1, xn}]

xn = where the playhead starts instead of x0: where a barline would stand before the first
notes (1.5 staff spaces before them, never left of the end of the signatures). Left out when
nothing can be said (movement not compiled, no staff found): the app then starts from x0.
Reads scores/<work>/pages/pNNN.webp + pages.json (tools/page_assets.py, which calls annotate()
below, then tools/page_staves.py for the staves) and the key and time signatures of the
MusicXML. Idempotent: recomputed from the images each run.

Detection. On the page, between the signatures and the first notes, every staff is blank for a
staff space or two: such gaps (columns blank in nearly all the staves of the system, staff
lines put aside) are the candidates. Which one is the right one cannot be told from one system
alone: there is a gap between the clef and the key signature too, and others between the notes,
and their widths overlap from one edition to another (an accidental of the key signature is
1.1 staff spaces wide in the Gloria's edition, 2 in Taneyev's). So the edition is asked: the
signatures end at  A + w·(number of accidentals) + t·(time signature shown)  px from the left
edge, (A, w, t) being the values for which the most systems of the work have a gap starting
there, then centred for each (accidentals, time) on the gaps found. For each system the gap
nearest to that place is taken (measured); without one within TOL staff spaces, the place
itself (model). The report says how many of each; --draw shows every system.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import cv2
import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from tools.page_staves import MARGIN, line_mask, system_staves, write_pages  # noqa: E402

INK = 170          # gray level below which a pixel is ink
REACH = 34         # staff spaces searched from the left edge of the system
AROUND = 1.2       # staff spaces above and below a staff that belong to it (ledger notes, clefs)
SPARE = 0.2        # fraction of the staves that may have ink in a blank column (an accidental, a tie)
MIN_GAP = 0.6      # staff spaces: narrower blanks are the spaces between two accidentals
AFTER = 3.0        # staff spaces: no candidate before this (left barline, clef)
NEAR = 0.8         # staff spaces: a gap this near the model's place supports the model
TOL = 2.0          # staff spaces: a gap farther than this from the centred model is not taken
LEAD = 1.5         # staff spaces between a barline and the first note of a measure
SLACK = 2.0        # staff spaces: the start is at most this far after the end of the signatures
ROOM = 2.0         # staff spaces of the measure left to cross after the start, at least


# ---------------------------------------------------------------- what is printed

def signatures(work_dir: Path) -> dict[tuple[int, str], tuple[int, bool]]:
    """(movement number, 1-based in work.yaml order; printed measure number) -> (accidentals of
    the key signature in force, a time signature is printed in this measure). Compiled
    movements only."""
    cfg = yaml.safe_load((work_dir / "work.yaml").read_text(encoding="utf-8"))
    out = {}
    for i, mv in enumerate(cfg["movements"]):
        f = work_dir / mv["file"]
        if not f.exists():
            continue
        fifths, time = 0, None
        for me in ET.parse(f).getroot().find("part").findall("measure"):
            shown = False
            for a in me.findall("attributes"):
                if a.find("key/fifths") is not None:
                    fifths = int(a.findtext("key/fifths"))
                if a.find("time") is not None:
                    new = (a.findtext("time/beats"), a.findtext("time/beat-type"))
                    shown, time = shown or new != time, new
            out[(i + 1, me.get("number"))] = (abs(fifths), shown)
    return out


# ---------------------------------------------------------------- detection

def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) of the runs of True."""
    edges = np.flatnonzero(np.diff(np.concatenate(([0], mask.astype(np.int8), [0]))))
    return [(int(a), int(b)) for a, b in zip(edges[::2], edges[1::2])]


def blank_gaps(gray: np.ndarray, lines: np.ndarray, staves: list[dict], x0: int, x1: int
               ) -> tuple[list[tuple[int, int]], float]:
    """Candidates of one system: [start, end) in px from x0 of the columns blank in nearly all
    its staves, at least MIN_GAP wide, after the clef; and its staff space (px)."""
    sp = float(np.median([(st["bottom"] - st["top"]) / 4 for st in staves]))
    xb = min(x1, int(x0 + REACH * sp))
    busy = np.zeros(max(0, xb - x0), int)
    for st in staves:
        s = (st["bottom"] - st["top"]) / 4
        ya, yb = max(0, round(st["top"] - AROUND * s)), min(gray.shape[0], round(st["bottom"] + AROUND * s))
        ink = (gray[ya:yb, x0:xb] < INK) & ~lines[ya:yb, x0:xb]
        busy += ink.sum(axis=0) > 2
    gaps = _runs(busy <= int(SPARE * len(staves)))
    return [(a, b) for a, b in gaps if b - a >= MIN_GAP * sp and a >= AFTER * sp], sp


def fit(rows: list[dict]) -> tuple[float, float, float]:
    """The edition: (A, w, t) in px such that the most systems have a gap starting NEAR
    A + w·accidentals + t·time. Of the answers supported about as well as the best one, the
    earliest: the gap after the first notes comes back from system to system too, when they
    all begin alike. (The gap after the clef cannot follow the number of accidentals: w is at
    least the width of the narrowest accidental.)"""
    sp = statistics.median(r["sp"] for r in rows)
    width = max(len(r["gaps"]) for r in rows) or 1
    starts = np.full((len(rows), width), np.inf)
    for i, r in enumerate(rows):
        starts[i, :len(r["gaps"])] = [a for a, _ in r["gaps"]]
    acc = np.array([r["sig"][0] for r in rows], float)
    timed = np.array([r["sig"][1] for r in rows], bool)
    near = NEAR * np.array([r["sp"] for r in rows])
    found = []   # (systems supporting it, mean place, model)
    for a in np.arange(3.5 * sp, 9.0 * sp, 1.0):
        for w in np.arange(0.8 * sp, 3.0 * sp, 0.5):
            place = a + w * acc
            plain = int((np.abs(starts[~timed] - place[~timed, None]).min(axis=1) <= near[~timed]).sum()) if (~timed).any() else 0
            for t in np.arange(1.5 * sp, 6.0 * sp, 1.0) if timed.any() else [2.5 * sp]:
                hits = plain
                if timed.any():
                    hits += int((np.abs(starts[timed] - place[timed, None] - t).min(axis=1) <= near[timed]).sum())
                found.append((hits, float(place.mean() + t * timed.mean()), (float(a), float(w), float(t))))
    best = max(f[0] for f in found)
    return min((f for f in found if f[0] >= best - max(1.0, 0.15 * best)), key=lambda f: f[1])[2]


def place_starts(rows: list[dict]) -> tuple[float, float, float]:
    """Sets r["end"], r["notes"] (end of the signatures, first notes: px from x0), r["xn"] and
    r["how"] ("measured" | "model") on every row. Returns the edition's model."""
    model = a, w, t = fit(rows)
    for r in rows:
        r["place"] = a + w * r["sig"][0] + (t if r["sig"][1] else 0.0)
    # centre the model on the gaps found: for each kind of signature when there are enough of
    # them, else for the systems with (or without) a time signature, else for all
    off: dict[object, list[float]] = {}
    for r in rows:
        d = min((g[0] - r["place"] for g in r["gaps"]), key=abs, default=None)
        if d is not None and abs(d) <= 1.5 * NEAR * r["sp"]:
            for key in (r["sig"], r["sig"][1], None):
                off.setdefault(key, []).append(d)
    for r in rows:
        mine = next((off[k] for k in (r["sig"], r["sig"][1], None) if len(off.get(k, [])) >= 3), off.get(None, [0.0]))
        r["place"] += statistics.median(mine)
    widths = []
    for r in rows:
        g = min((g for g in r["gaps"] if abs(g[0] - r["place"]) <= TOL * r["sp"]), key=lambda g: abs(g[0] - r["place"]), default=None)
        r["how"] = "measured" if g else "model"
        r["end"], r["notes"] = g if g else (r["place"], None)
        if g:
            widths.append((g[1] - g[0]) / r["sp"])
    usual = statistics.median(widths) if widths else 2.5
    for r in rows:
        if r["notes"] is None:
            r["notes"] = r["end"] + usual * r["sp"]
        start = min(max(r["notes"] - LEAD * r["sp"], r["end"]), r["end"] + SLACK * r["sp"])
        r["xn"] = round(start) if 0 < start <= r["width"] - ROOM * r["sp"] else None
    return model


# ---------------------------------------------------------------- pages

def annotate(pages: list[dict], pages_dir: Path, sigs: dict[tuple[int, str], tuple[int, bool]],
             rows_out: list[dict] | None = None) -> list[str]:
    """Add/refresh `xn` on the first measure of every system (in place). Returns the report:
    the edition's model, then one line per system placed by the model alone or left without."""
    rows, notes = [], []
    for pg in pages:
        for m in pg["measures"]:
            m.pop("xn", None)
        gray = cv2.imread(str(pages_dir / pg["img"]), cv2.IMREAD_GRAYSCALE)
        mask = line_mask(gray)
        lines = cv2.dilate(mask, np.ones((3, 1), np.uint8)).astype(bool)
        for k, s in enumerate(pg["systems"]):
            ms = sorted((m for m in pg["measures"] if m["sys"] == k), key=lambda m: m["x0"])
            if not ms:
                continue
            first, where = ms[0], f"p{pg['page']} s{k + 1}"
            sig = sigs.get((first["mv"], str(first["n"])))
            if sig is None:
                continue   # movement not compiled: its pages are not in the pack
            staves = s.get("staves")
            if not staves:   # staves hidden, piano alone: not stored, found again here
                band = (max(0, s["top"] - MARGIN), min(gray.shape[0], s["bottom"] + MARGIN), first["x0"], ms[-1]["x1"])
                staves, _ = system_staves(mask, band, s["top"], s["bottom"])
            if not staves:
                notes.append(f"{where}: no staff found, starts on the barline")
                continue
            gaps, sp = blank_gaps(gray, lines, staves, first["x0"], first["x1"])
            rows.append({"where": where, "page": pg, "m": first, "sig": sig, "sp": sp, "gaps": gaps,
                         "width": first["x1"] - first["x0"]})
    if not rows:
        return notes
    a, w, t = place_starts(rows)
    sp = statistics.median(r["sp"] for r in rows)
    measured = sum(1 for r in rows if r["how"] == "measured")
    head = (f"{measured}/{len(rows)} systems measured; edition: clef {a / sp:.1f}, accidental {w / sp:.2f}, "
            f"time signature {t / sp:.1f} staff spaces")
    for r in rows:
        if r["xn"] is None:
            notes.append(f"{r['where']}: the signatures fill the measure, starts on the barline")
            continue
        r["m"]["xn"] = r["m"]["x0"] + r["xn"]
        if r["how"] == "model":
            notes.append(f"{r['where']}: the first note was not found where this edition usually has it; the playhead "
                         f"starts at the usual distance from the barline (clef and signatures of the edition)")
    if rows_out is not None:
        rows_out += rows
    return [head] + notes


# ---------------------------------------------------------------- contact sheets

def draw(rows: list[dict], pages_dir: Path, out: Path, prefix: str, per_row: int = 8, rows_per_sheet: int = 2) -> int:
    """Contact sheets: the beginning of every system, with the left edge of its box (violet),
    the end of the signatures (green), the first notes (orange) and the playhead's start (red,
    thick). Title in red when the model alone placed it."""
    out.mkdir(parents=True, exist_ok=True)
    w, h, tiles, cache = 230, 520, [], {}
    for r in rows:
        if r["xn"] is None:
            continue
        pg, m, sp = r["page"], r["m"], r["sp"]
        if pg["img"] not in cache:
            cache.clear()
            cache[pg["img"]] = cv2.imread(str(pages_dir / pg["img"]))
        img = cache[pg["img"]]
        xa = max(0, m["x0"] - 20)
        crop = img[m["y0"]:m["y1"], xa:min(img.shape[1], int(m["x0"] + 26 * sp))].copy()
        for x, colour, thick in ((0, (200, 0, 200), 1), (r["end"], (0, 170, 0), 1), (r["notes"], (0, 140, 255), 1), (r["xn"], (0, 0, 255), 2)):
            cv2.line(crop, (int(m["x0"] + x - xa), 0), (int(m["x0"] + x - xa), crop.shape[0]), colour, thick)
        scale = min(w / crop.shape[1], (h - 18) / crop.shape[0])
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        tile = np.full((h, w, 3), 255, np.uint8)
        tile[18:18 + crop.shape[0], :crop.shape[1]] = crop
        label = f"{r['where']} {r['sig'][0]} acc.{' + time' if r['sig'][1] else ''}"
        cv2.putText(tile, label, (2, 13), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 220) if r["how"] == "model" else (0, 0, 0), 1)
        tiles.append(tile)
    per = per_row * rows_per_sheet
    for i in range(0, len(tiles), per):
        chunk = tiles[i:i + per] + [np.full((h, w, 3), 255, np.uint8)] * (-len(tiles[i:i + per]) % per_row)
        sheet = np.vstack([np.hstack(chunk[j:j + per_row]) for j in range(0, len(chunk), per_row)])
        cv2.imwrite(str(out / f"{prefix}_starts_{i // per + 1:02d}.png"), sheet)
    return (len(tiles) + per - 1) // per


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("works", nargs="*", type=Path, help="scores/<work> (default: all with pages/pages.json)")
    ap.add_argument("--dry-run", action="store_true", help="report only, do not write pages.json")
    ap.add_argument("--draw", type=Path, help="write contact sheets (the beginning of every system) into this directory")
    a = ap.parse_args()
    works = a.works or sorted(p.parents[1] for p in (ROOT / "scores").glob("*/pages/pages.json"))
    for wd in works:
        path = wd / "pages" / "pages.json"
        pages = json.loads(path.read_text(encoding="utf-8"))
        rows: list[dict] = []
        report = annotate(pages, path.parent, signatures(wd), rows)
        print(f"{wd.name}: " + (report[0] if report else "nothing to place"))
        for line in report[1:]:
            print("  ", line)
        if not a.dry_run:
            write_pages(path, pages)
        if a.draw:
            print(f"   {draw(rows, path.parent, a.draw, wd.name)} contact sheets in {a.draw}")


if __name__ == "__main__":
    main()
