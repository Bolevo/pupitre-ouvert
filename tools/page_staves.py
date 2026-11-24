"""Staff positions inside every system of the page images (for the app's per-voice highlight).

    python tools/page_staves.py                      # every work having scores/<work>/pages/pages.json
    python tools/page_staves.py scores/<work>       # one work
    python tools/page_staves.py --dry-run --draw DIR # report only, write contact images to DIR

Reads scores/<work>/pages/pNNN.webp + pages.json (written by tools/page_assets.py, which also
calls annotate() below) and adds to each system:

    systems: [{top, bottom, staves: [{top, bottom}, ...]}]

top/bottom = y of the first/fifth line of each staff, in the webp's pixels, staves top to
bottom. `staves` is stored only when the number of detected staves equals the full staff count
of the system's movement (score staff i+1 = staves[i]); otherwise (staves hidden in a vocal
score, piano-only system, movement not compiled, detection failure) it is left out and the
app falls back to the plain measure highlight. Idempotent: recomputed from the images each run.

Detection: ink (dark or faint-but-thin pixels) -> horizontal opening (keeps long horizontal
strokes: staff lines, beams; drops noteheads, text, ledger lines, slurs, hairpins) -> the
measure area of the system (no brace, no instrument names) is cut into vertical strips
(pages can be slightly bent: lines are straight only locally) -> in each strip, thin runs
of covered rows are line candidates (thick runs are beams; a staff line crossing a beam is
recovered from its full coverage) -> chains of 5 evenly spaced candidates are staves (spacing
free per staff, best fit first) -> staves seen in enough strips are kept, with the median
position over the strips.
"""
from __future__ import annotations

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import cv2
import numpy as np
import yaml

ROOT = Path(__file__).resolve().parents[1]

INK = 190           # gray level below which a pixel is ink (staff lines are ~130 after resizing)
FAINT = 35          # or: this much darker than the white just above/below it (faint lines)
MIN_LINE = 31       # horizontal opening length (px): longer than ledger lines and noteheads
STRIP = 90          # strip width (px)
ROW_COVER = 0.6     # fraction of a strip's columns a staff line row must cover
BEAM = 2            # runs thicker than the typical staff line + BEAM rows are beams
SUPPORT = 0.3       # fraction of the strips in which a staff must be found
SPACE = (5, 22)     # plausible staff line spacing (px)
MARGIN = 12         # rows searched beyond the system band (a staff's centre must stay inside)


# ---------------------------------------------------------------- detection

def line_mask(gray: np.ndarray) -> np.ndarray:
    """Long horizontal ink strokes (staff lines, beams, long text underlines).
    Ink = dark pixels, plus thin strokes clearly darker than the white just above and
    below them (black-hat), so the faint lines of an unevenly lit photo count too."""
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 11))
    ink = ((gray < INK) | (cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, k) > FAINT)).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (MIN_LINE, 1))
    return cv2.morphologyEx(ink, cv2.MORPH_OPEN, k)


def _split(rows: np.ndarray) -> list[np.ndarray]:
    """Runs of consecutive row indices."""
    return [r for r in np.split(rows, np.where(np.diff(rows) != 1)[0] + 1) if r.size]


def strip_lines(cover: np.ndarray, y0: int, thick: int) -> list[float]:
    """Line candidates (y centres) from the row coverage of one strip: runs of
    consecutive rows covered over most of the strip, at most `thick` rows thick.
    A thicker run is a beam (or several): a staff line crossing it shows as rows
    covered over the full strip width, above the beam's own coverage; those rows
    are kept as candidates."""
    out: list[float] = []
    for r in _split(np.where(cover >= ROW_COVER)[0]):
        if r.size > thick:
            plateau = float(np.median(cover[r]))
            parts = [q for q in _split(r[cover[r] >= max(0.95, plateau + 0.05)]) if q.size < thick]
        else:
            parts = [r]
        out += [y0 + float((q * cover[q]).sum() / cover[q].sum()) for q in parts]
    return out


def line_thickness(covers: list[np.ndarray]) -> int:
    """Typical staff line thickness (rows) of a system: most covered runs are staff
    lines. Heavily printed pages have lines as thick as another page's beams."""
    sizes = [r.size for c in covers for r in _split(np.where(c >= ROW_COVER)[0])]
    return int(np.median(sizes)) if sizes else 2


def chains(lines: list[float]) -> list[tuple[float, float]]:
    """Staves (first line, fifth line) made of 5 roughly equidistant candidates.

    The spacing is free per staff (the piano staves are often larger than the vocal ones)
    and may drift slightly inside a staff (dewarped photos). Every (first, second) pair
    with a plausible spacing seeds a chain, extended with the candidate nearest to each
    expected position. Chains are then chosen best first, without overlap; the cost is
    the misfit to evenly spaced lines plus the candidates left unused inside the chain:
    this rejects a chain of every other line (double spacing) or one seeded by a beam."""
    seeds = []
    for i, first in enumerate(lines):
        for second in lines[i + 1:]:
            space = second - first
            if space < SPACE[0]:
                continue
            if space > SPACE[1]:
                break
            ys = [first, second]
            while len(ys) < 5:
                step = (ys[-1] - ys[0]) / (len(ys) - 1)
                want, tol = ys[-1] + step, max(2.0, 0.22 * step)
                near = [y for y in lines if abs(y - want) <= tol]
                if not near:
                    break
                ys.append(min(near, key=lambda y: abs(y - want)))
            if len(ys) < 5:
                continue
            gaps = np.diff(ys)
            if gaps.max() > 1.5 * gaps.min():
                continue
            fit = np.polyval(np.polyfit(range(5), ys, 1), range(5))
            misfit = float(np.abs(fit - ys).mean() / gaps.mean())
            unused = sum(1 for y in lines if ys[0] < y < ys[4] and y not in ys)
            seeds.append((misfit + 0.5 * unused, ys[0], ys[4]))
    out: list[tuple[float, float]] = []
    for _, top, bottom in sorted(seeds):
        if all(bottom < t or top > b for t, b in out):
            out.append((top, bottom))
    return sorted(out)


def system_staves(mask: np.ndarray, band: tuple[int, int, int, int], top: int, bottom: int
                  ) -> tuple[list[dict], float]:
    """Staves of one system: [{top, bottom}], and the lowest agreement over its staves
    (fraction of the strips whose chain lies within half a staff space of the result;
    low when the lines bend or a tie/beam is mistaken for a line in many strips)."""
    y0, y1, x0, x1 = band
    strips = list(range(x0, x1 - STRIP // 2, STRIP)) or [x0]
    covers = [mask[y0:y1, xs:min(xs + STRIP, x1)].mean(axis=1) for xs in strips]
    thick = line_thickness(covers) + BEAM
    found = [(k, a, b) for k, c in enumerate(covers) for a, b in chains(strip_lines(c, y0, thick))]
    # the same staff seen in several strips: cluster by top line (staves are more than
    # one staff height apart)
    found.sort(key=lambda f: f[1])
    clusters: list[list[tuple[int, float, float]]] = []
    for f in found:
        if clusters:
            c = clusters[-1]
            if f[1] - np.median([g[1] for g in c]) < np.median([g[2] - g[1] for g in c]):
                c.append(f)
                continue
        clusters.append([f])
    staves, agree = [], 1.0
    need = max(2, SUPPORT * len(strips))
    for c in clusters:
        if len({f[0] for f in c}) < need:
            continue
        t = float(np.median([f[1] for f in c]))
        b = float(np.median([f[2] for f in c]))
        if not top <= (t + b) / 2 <= bottom:   # belongs to the neighbouring system
            continue
        if staves and t <= staves[-1]["bottom"]:   # overlapping staves: inconsistent detection
            return [], 0.0
        staves.append({"top": round(t), "bottom": round(b)})
        good = {f[0] for f in c if abs(f[1] - t) <= (b - t) / 8 and abs(f[2] - b) <= (b - t) / 8}
        agree = min(agree, len(good) / len(strips))
    return staves, agree


# ---------------------------------------------------------------- staff counts

def staff_counts(work_dir: Path) -> dict[int, int]:
    """Movement number (1-based, work.yaml order) -> number of score staves, for the
    compiled movements (same rule as pipeline/build_pack.py: max <staves> per part)."""
    return {mv: n for mv, (n, _) in score_staves(work_dir).items()}


def score_staves(work_dir: Path) -> dict[int, tuple[int, bool]]:
    """Movement number -> (number of score staves, the score has a keyboard part)."""
    cfg = yaml.safe_load((work_dir / "work.yaml").read_text(encoding="utf-8"))
    out = {}
    for i, mv in enumerate(cfg["movements"]):
        f = work_dir / mv["file"]
        if not f.exists():
            continue
        n, keyboard = 0, False
        for part in ET.parse(f).getroot().iter("part"):
            k = max([1] + [int(s.text) for s in part.iter("staves")])
            n += k
            keyboard = keyboard or k > 1
        out[i + 1] = (n, keyboard)
    return out


def vocal_staves_of(work_dir: Path):
    """-> f(page, number of staves of a system) = the indices of its vocal staves, top to bottom
    (the names of the staves: work.yaml `staves`, work/pages.tsv `solo`; pipeline/cht/workdir.py)."""
    import sys
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from pipeline.cht import workdir
    work = work_dir / "work"

    def vocal(page: int, n: int) -> list[int]:
        names = workdir.staff_names(n, workdir.solo_voices(work, page))
        return [i for i, nm in enumerate(names) if nm not in ("PR", "PL")]
    return vocal


# ---------------------------------------------------------------- pages

def annotate(pages: list[dict], pages_dir: Path, counts: dict[int, int],
             detected: dict | None = None, keyboard: dict[int, bool] | None = None, vocal=None) -> list[str]:
    """Add/refresh systems[].staves in pages (in place). Returns one line per system
    left without staves (with the reason) or with a weak detection. `detected`, if given,
    receives {(page, system index): staves} for every system, kept or not.
    `keyboard` {movement: the score has a keyboard part} and `vocal` (vocal_staves_of): when
    the page prints an accompaniment that the score does not hold (the voices alone were
    transcribed), the vocal staves of the page are the staves of the score."""
    misses = []
    voices_only: list[int] = []
    for pg in pages:
        gray = cv2.imread(str(pages_dir / pg["img"]), cv2.IMREAD_GRAYSCALE)
        mask = line_mask(gray)
        h = gray.shape[0]
        bands = []
        for k, s in enumerate(pg["systems"]):
            ms = [m for m in pg["measures"] if m["sys"] == k]
            x0 = min((m["x0"] for m in ms), default=0)
            x1 = max((m["x1"] for m in ms), default=gray.shape[1])
            bands.append((max(0, s["top"] - MARGIN), min(h, s["bottom"] + MARGIN), x0, x1))
        for k, s in enumerate(pg["systems"]):
            s.pop("staves", None)
            where = f"p{pg['page']} s{k + 1}"
            staves, agree = system_staves(mask, bands[k], s["top"], s["bottom"])
            if detected is not None:
                detected[(pg["page"], k)] = staves
            mvs = sorted({m["mv"] for m in pg["measures"] if m["sys"] == k})
            want = {counts.get(mv) for mv in mvs}
            if None in want or not mvs:
                misses.append(f"{where}: {len(staves)} staves, movement {mvs} not compiled (staff count unknown)")
            elif len(want) > 1:
                misses.append(f"{where}: movements {mvs} with different staff counts")
            elif len(staves) != counts[mvs[0]]:
                ix = vocal(pg["page"], len(staves)) if vocal and keyboard is not None and not keyboard.get(mvs[0], True) else []
                if len(ix) == counts[mvs[0]] and len(ix) < len(staves):
                    s["staves"] = [staves[i] for i in ix]          # the voices, without the accompaniment printed under them
                    if pg["page"] not in voices_only:
                        voices_only.append(pg["page"])
                else:
                    misses.append(f"{where}: {len(staves)} staves on the page, {counts[mvs[0]]} in the score: the app shows "
                                  f"this system without marking the staff of the voice followed. As it should be where a "
                                  f"soloist or the keyboard is alone; else the staves of the work are in work.yaml (`staves`), "
                                  f"those of a page in work/pages.tsv")
            else:
                s["staves"] = staves
                if agree < 0.5:
                    misses.append(f"{where}: kept, but only {agree:.0%} of the strips agree (check the image)")
    if voices_only:
        misses.insert(0, f"page(s) {', '.join(map(str, voices_only))}: the accompaniment printed on the page is not in the score; "
                         f"the vocal staves are those of the score")
    return misses


def write_pages(path: Path, pages: list[dict]) -> None:
    """Same compact formatting as tools/page_assets.py."""
    path.write_text(json.dumps(pages, separators=(",", ":")))


# ---------------------------------------------------------------- contact images

def draw(pages: list[dict], pages_dir: Path, out: Path, prefix: str, detected: dict) -> None:
    """One PNG per page: measure boxes (gray), stored staff bands (one colour per score
    staff) and, for systems left without staves, the detected staves outlined in red."""
    colours = [(230, 60, 60), (40, 160, 40), (40, 90, 230), (200, 140, 0), (170, 60, 200), (0, 170, 190)]
    out.mkdir(parents=True, exist_ok=True)
    for pg in pages:
        img = cv2.cvtColor(cv2.imread(str(pages_dir / pg["img"]), cv2.IMREAD_GRAYSCALE), cv2.COLOR_GRAY2BGR)
        over = img.copy()
        for k, s in enumerate(pg["systems"]):
            ms = [m for m in pg["measures"] if m["sys"] == k]
            x0 = min((m["x0"] for m in ms), default=0)
            x1 = max((m["x1"] for m in ms), default=img.shape[1])
            for i, st in enumerate(s.get("staves", [])):
                cv2.rectangle(over, (x0, st["top"] - 3), (x1, st["bottom"] + 3), colours[i % len(colours)], -1)
            if "staves" not in s:   # not stored: red margin, detected staves outlined
                cv2.rectangle(over, (0, s["top"]), (40, s["bottom"]), (0, 0, 255), -1)
                for st in detected.get((pg["page"], k), []):
                    cv2.rectangle(over, (x0, st["top"] - 3), (x1, st["bottom"] + 3), (0, 0, 255), 2)
        img = cv2.addWeighted(over, 0.35, img, 0.65, 0)
        for m in pg["measures"]:
            cv2.rectangle(img, (m["x0"], m["y0"]), (m["x1"], m["y1"]), (120, 120, 120), 1)
        cv2.imwrite(str(out / f"{prefix}_p{pg['page']:03d}.png"), img)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("works", nargs="*", type=Path, help="scores/<work> (default: all with pages/pages.json)")
    ap.add_argument("--dry-run", action="store_true", help="report only, do not write pages.json")
    ap.add_argument("--draw", type=Path, help="write one contact PNG per page into this directory")
    ap.add_argument("--pages", help="with --draw: comma-separated page numbers to draw")
    a = ap.parse_args()
    works = a.works or sorted(p.parents[1] for p in (ROOT / "scores").glob("*/pages/pages.json"))
    for wd in works:
        path = wd / "pages" / "pages.json"
        pages = json.loads(path.read_text(encoding="utf-8"))
        detected: dict = {}
        layout = score_staves(wd)
        misses = annotate(pages, path.parent, {m: n for m, (n, _) in layout.items()}, detected,
                          {m: k for m, (_, k) in layout.items()}, vocal_staves_of(wd))
        total = sum(len(p["systems"]) for p in pages)
        done = sum(1 for p in pages for s in p["systems"] if "staves" in s)
        print(f"{wd.name}: staves on {done}/{total} systems")
        for m in misses:
            print("  ", m)
        if not a.dry_run:
            write_pages(path, pages)
        if a.draw:
            sel = {int(x) for x in a.pages.split(",")} if a.pages else None
            draw([p for p in pages if sel is None or p["page"] in sel], path.parent, a.draw, wd.name, detected)


if __name__ == "__main__":
    main()
