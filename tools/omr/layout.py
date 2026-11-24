"""Staff, system and barline detection on a deskewed, normalised page.

Coordinates are in pixels of the page image (pNNN.png). The result is a
plain dict (JSON-serialisable) so other tools can reuse it without OpenCV.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

import cv2
import numpy as np


@dataclass
class Staff:
    lines: list[int]          # y of the 5 lines, top to bottom
    x0: int                   # left end of the lines
    x1: int                   # right end of the lines

    @property
    def top(self) -> int:
        return self.lines[0]

    @property
    def bottom(self) -> int:
        return self.lines[-1]

    @property
    def space(self) -> float:
        return (self.lines[-1] - self.lines[0]) / 4.0


@dataclass
class System:
    staves: list[Staff]
    barlines: list[int] = field(default_factory=list)   # x of barlines ending each measure
    start_x: int = 0                                    # x of the system's opening line
    piano: bool = False                                 # last two staves = piano grand staff
    weak: list[int] = field(default_factory=list)       # x of strokes that may be barlines too (best first)
    guessed: bool = False                               # its staves were put together by rule, not by a line seen

    @property
    def top(self) -> int:
        return self.staves[0].top

    @property
    def bottom(self) -> int:
        return self.staves[-1].bottom


def _horizontal_lines(ink: np.ndarray, min_len: int) -> np.ndarray:
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (min_len, 1))
    return cv2.morphologyEx(ink, cv2.MORPH_OPEN, k)


def _peaks(profile: np.ndarray, thresh: float) -> list[int]:
    """Centres of runs of rows whose value exceeds thresh."""
    rows = np.where(profile > thresh)[0]
    out: list[int] = []
    if rows.size == 0:
        return out
    start = prev = rows[0]
    for r in rows[1:]:
        if r > prev + 1:
            out.append((start + prev) // 2)
            start = r
        prev = r
    out.append((start + prev) // 2)
    return out


def find_staves(ink: np.ndarray) -> list[Staff]:
    h, w = ink.shape
    hl = _horizontal_lines(ink, max(30, w // 25))
    prof = (hl > 0).sum(axis=1)
    peaks = _peaks(prof, 0.2 * w)
    # merge peaks closer than 3 px (thick or slightly bent lines)
    merged: list[int] = []
    for p in peaks:
        if merged and p - merged[-1] <= 3:
            merged[-1] = (merged[-1] + p) // 2
        else:
            merged.append(p)
    staves: list[Staff] = []
    i = 0
    while i + 4 < len(merged):
        cand = merged[i:i + 5]
        gaps = np.diff(cand)
        if gaps.min() >= 4 and gaps.max() <= 1.5 * gaps.min() + 2 and gaps.max() < 30:
            band = hl[cand[0]:cand[-1] + 1]
            cols = np.where(band.sum(axis=0) > 0)[0]
            x0, x1 = (int(cols.min()), int(cols.max())) if cols.size else (0, w - 1)
            staves.append(Staff([int(c) for c in cand], x0, x1))
            i += 5
        else:
            i += 1
    return staves


def staves_at(lines: np.ndarray, centres: list[tuple[float, float]]) -> list[Staff]:
    """Fit 5 lines around each known staff centre (from dewarp tracking):
    choose spacing and offset maximising the line-mask row profile."""
    h, w = lines.shape
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(30, w // 25), 1))
    hl = cv2.morphologyEx(lines, cv2.MORPH_OPEN, k) > 0
    prof = hl.sum(axis=1).astype(float)
    out = []
    for c, sp in centres:
        best, best_score = None, -1.0
        for s in np.arange(0.85 * sp, 1.15 * sp + 1e-6, 0.1):
            for off in np.arange(-sp / 2, sp / 2 + 1e-6, 0.5):
                ys = [int(round(c + off + j * s)) for j in (-2, -1, 0, 1, 2)]
                if ys[0] < 1 or ys[-1] >= h - 1:
                    continue
                score = sum(max(prof[y - 1], prof[y], prof[y + 1]) for y in ys)
                if score > best_score:
                    best, best_score = ys, score
        if best is None:
            continue
        best = [y + int(np.argmax(prof[y - 1:y + 2])) - 1 for y in best]   # snap to the ink
        present = np.stack([hl[y - 2:y + 3].any(axis=0) for y in best]).sum(axis=0)
        cols = np.where(present >= 4)[0]
        x0, x1 = (int(cols.min()), int(cols.max())) if cols.size else (0, w - 1)
        out.append(Staff(best, x0, x1))
    return out


def _vertical_coverage(ink: np.ndarray, y0: int, y1: int, x0: int, x1: int) -> np.ndarray:
    """Per column in [x0, x1): fraction of rows y0..y1 that are ink, allowing
    a 1-px horizontal wobble (max over neighbouring columns)."""
    band = ink[y0:y1 + 1, max(0, x0 - 1):x1 + 1] > 0
    wob = band.copy()
    wob[:, 1:] |= band[:, :-1]
    wob[:, :-1] |= band[:, 1:]
    cov = wob.mean(axis=0)
    return cov[1:] if x0 > 0 else cov


def group_systems(ink: np.ndarray, staves: list[Staff]) -> list[System]:
    """Consecutive staves joined by a vertical line near their left end form a system."""
    systems: list[System] = []
    margin = int(np.median([s.x0 for s in staves])) if staves else 0
    for st in staves:
        if systems:
            prev = systems[-1].staves[-1]
            lo = min(prev.x0, st.x0, margin) - 30
            hi = min(prev.x0, st.x0) + 15
            xs = [x for x in range(max(1, lo), hi) if ink[prev.bottom, x]]
            if any(_connected(ink, x, prev.bottom, st.top, max_gap=3) for x in xs):
                systems[-1].staves.append(st)
                continue
        systems.append(System([st]))
    return systems


def _clusters(xs, tol: float) -> list[list[int]]:
    groups: list[list[int]] = []
    for x in sorted(xs):
        if groups and x - groups[-1][-1] <= tol:
            groups[-1].append(int(x))
        else:
            groups.append([int(x)])
    return groups


def _staff_candidates(ink: np.ndarray, s: Staff, x0: int, x1: int, thr: float = 0.95) -> list[tuple[int, float]]:
    """(x, coverage) of columns crossing the whole staff (top to bottom line)."""
    cov = _vertical_coverage(ink, s.top + 1, s.bottom - 1, x0, x1 + 1)
    out = []
    for c in _clusters(np.where(cov > thr)[0], 2):
        best = max(c, key=lambda k: cov[k])
        out.append((int(best) + x0, float(cov[best])))
    return out


def _has_notehead(ink: np.ndarray, s: Staff, x: int) -> bool:
    """True if a notehead-like blob touches the vertical stroke at x inside the staff:
    several 'wide' rows (> 0.8 space) within ~1.5 spaces. Thin slurs/ties crossing
    a barline give only 1-3 wide rows."""
    sp = s.space
    line_rows = {y + d for y in s.lines for d in (-1, 0, 1)}
    wide_rows = []
    for y in range(int(s.top - sp), int(s.bottom + sp) + 1):
        if y in line_rows or y < 0 or y >= ink.shape[0]:
            continue
        row = ink[y]
        l = r = x
        while l > 0 and row[l - 1] and x - l < 2 * sp:
            l -= 1
        while r + 1 < row.size and row[r + 1] and r - x < 2 * sp:
            r += 1
        if r - l + 1 > 0.8 * sp:
            wide_rows.append(y)
    win = 1.5 * sp
    for i, y in enumerate(wide_rows):
        if sum(1 for z in wide_rows[i:] if z - y <= win) >= 4:
            return True
    return False


def _sticks_out(ink: np.ndarray, x: int, y0: int, y1: int) -> bool:
    if y1 <= y0:
        return False
    return _vertical_coverage(ink, y0, y1, x, x + 1)[0] > 0.7


def _connected(ink: np.ndarray, x: int, y0: int, y1: int, max_gap: int = 4) -> bool:
    """Follow a (possibly slightly slanted) vertical stroke from (x, y0) to y1."""
    gap = 0
    for y in range(y0, y1 + 1):
        lo = max(0, x - 2)
        hits = np.where(ink[y, lo:x + 3] > 0)[0]
        if hits.size:
            near = hits[np.argmin(np.abs(hits + lo - x))]
            x = int(near) + lo
            gap = 0
        else:
            gap += 1
            if gap > max_gap:
                return False
    return True


def find_barlines(ink: np.ndarray, sysm: System, strict: np.ndarray | None = None) -> None:
    """Fill sysm.barlines / sysm.start_x.

    A barline crosses a staff from its top to its bottom line. Stems are
    rejected by requiring agreement between staves: >= 3/4 of the staves of a
    system with 3+ staves; for a 2-staff system (piano) the line must also be
    continuous across the gap; for a lone staff it must not stick out of it.
    """
    st = sysm.staves
    x0 = min(s.x0 for s in st)
    x1 = max(s.x1 for s in st)
    sp = float(np.mean([s.space for s in st]))
    per = []
    strokes: list[tuple[int, int]] = []        # (x, staff) of every full-height stroke, stems included
    for i, s in enumerate(st):
        keep = []
        for x, cov in _staff_candidates(ink, s, x0, x1, 0.85):
            strokes.append((x, i))
            # a stroke continuing to the neighbouring staff is a barline (grand staff, bracket)
            if (i > 0 and _connected(ink, x, st[i - 1].bottom, s.top)) or \
               (i + 1 < len(st) and _connected(ink, x, s.bottom, st[i + 1].top)):
                keep.append(x)
                continue
            if cov < 0.95 or _has_notehead(ink if strict is None else strict, s, x):
                continue
            if _sticks_out(ink, x, int(s.top - 1.2 * s.space), s.top - 2) or \
               _sticks_out(ink, x, s.bottom + 2, int(s.bottom + 1.2 * s.space)):
                continue
            keep.append(x)
        per.append(keep)
    need = max(1, int(np.ceil(0.6 * len(st))))
    pts = [(x, i) for i, xs_ in enumerate(per) for x in xs_]
    cands: list[tuple[int, int]] = []          # (x, number of staves agreeing)
    doubt: list[tuple[float, int]] = []        # (evidence, x) of the lines seen on too few staves
    for g in _clusters([p[0] for p in pts], 1.2 * sp):
        hit = {i for x, i in pts if g[0] <= x <= g[-1]}
        x = int(np.median(g))
        if len(hit) >= need:
            cands.append((x, len(hit)))
            continue
        # A barline can be seen for what it is on a few staves only: on the others a note stands
        # against it, or a tie crosses it, and it is put aside with the stems. When those staves
        # do have a full-height stroke at the same place, it is one line down the whole system.
        seen = {i for sx, i in strokes if g[0] - 0.6 * sp <= sx <= g[-1] + 0.6 * sp}
        # (not in the first spaces of the system: the figures of a time signature, one above the
        # other on every staff, make such a column too)
        if len(st) >= 3 and x - x0 > 10 * sp and len(hit) >= max(2, int(np.ceil(len(st) / 3))) \
                and len(seen) >= int(np.ceil(0.8 * len(st))):
            cands.append((x, len(hit)))
        else:
            doubt.append((len(hit) + 0.5 * len(seen - hit), x))
    # a measure is never narrower than ~3 spaces: keep the best-supported line
    # (for double barlines, the last one)
    merged: list[tuple[int, int]] = []
    for x, n in cands:
        if merged and x - merged[-1][0] < 3 * sp:
            if n >= merged[-1][1]:
                merged[-1] = (x, n)
        else:
            merged.append((x, n))
    centers = [x for x, _ in merged]
    if centers and centers[0] - x0 < 2 * sp:
        sysm.start_x = centers.pop(0)
    else:
        sysm.start_x = x0
    # ignore anything inside the clef/key area right after the opening line
    bars = [c for c in centers if c - sysm.start_x > 6 * sp]
    # the system always ends with a barline at the end of its staff lines
    if not bars or x1 - bars[-1] > 2 * sp:
        bars.append(x1)
    sysm.barlines = bars
    # what may be a barline too, best first: used when the count of the page says some are missing
    sysm.weak = [x for _, x in sorted(doubt, reverse=True)
                 if x - sysm.start_x > 3 * sp and all(abs(x - b) >= 3 * sp for b in bars)]
    # piano grand staff = last two staves joined by most barlines
    if len(st) >= 2:
        a, b = st[-2], st[-1]
        joined = sum(_connected(ink, x, a.bottom, b.top) for x in bars)
        sysm.piano = joined >= max(1, len(bars) // 2)


def regroup(systems: list[System], counts: list[int]) -> list[System]:
    """Force `counts` staves per system (top to bottom) when the detected
    grouping differs but the total number of staves agrees."""
    staves = [st for s in systems for st in s.staves]
    if not counts or sum(counts) != len(staves) or [len(s.staves) for s in systems] == counts:
        return systems
    out, i = [], 0
    for c in counts:
        out.append(System(staves[i:i + c]))
        i += c
    return out


def regular_counts(systems: list[System], per_system: int | list[int] | None = None) -> list[int] | None:
    """Staves per system when the grouping found cannot be the page's: None when it can.

    Some editions join the staves of a system with a bracket only, or the line at the left is
    broken in the scan: the staves then come out one by one, or in uneven groups. A page is
    made of systems alike: of `per_system` staves each when the work says so (work.yaml
    `staves`; several sizes when it leaves a doubt) and the page holds a whole number of them;
    else of the number of staves for which the spaces between the staves repeat from one
    system to the next, without cutting two staves that a line does join."""
    staves = [st for s in systems for st in s.staves]
    total, got = len(staves), [len(s.staves) for s in systems]
    sizes = [per_system] if isinstance(per_system, int) else list(per_system or [])
    sizes = [n for n in sizes if n > 0 and total % n == 0]
    if any(set(got) == {n} for n in sizes):
        return None
    if not sizes and len(set(got)) <= 1 and got and got[0] > 1:
        return None                                   # even groups of several staves
    joined, i = set(), 0                              # k: staves k and k+1 are joined by a line
    for s in systems:
        joined.update(range(i, i + len(s.staves) - 1))
        i += len(s.staves)
    gaps = [(b.top - a.bottom) / a.space for a, b in zip(staves, staves[1:])]

    def fit(n: int) -> tuple[float, float]:
        """(how unevenly the spaces inside the systems repeat, the same less the space between systems)."""
        rows = np.array([gaps[k * n:k * n + n - 1] for k in range(total // n)])
        dev = float(np.mean(np.abs(rows - np.median(rows, axis=0)))) if rows.size else 0.0
        between = [gaps[k * n + n - 1] for k in range(total // n - 1)]
        # the space between two systems is usually the widest: it settles between two regular cuts
        inner = float(np.median(rows)) if rows.size else 0.0
        return dev, dev - 0.3 * ((min(between) - inner) if between else 0.0)

    if sizes:
        n = min(sizes, key=lambda n: fit(n)[1]) if len(sizes) > 1 else sizes[0]
        return [n] * (total // n)
    best: tuple[float, int] | None = None
    for n in range(2, 9):
        if total % n or total == n or any((k + 1) % n == 0 for k in joined):
            continue
        dev, score = fit(n)
        if dev < 0.6 and (best is None or score < best[0]):
            best = (score, n)
    return [best[1]] * (total // best[1]) if best else None


def analyse(ink: np.ndarray, strict: np.ndarray | None = None,
            lines: np.ndarray | None = None, centres=None,
            counts: list[int] | None = None, per_system: int | list[int] | None = None) -> list[System]:
    """`ink`: lenient mask (keeps faint lines); `strict`: Otsu mask (thin strokes);
    `lines`: mask used to find staff lines; `centres`: [(y, space)] of staves
    already located by dewarp (more robust than a full-width search);
    `counts`: staves per system of this page (work/pages.tsv), forces the grouping (see regroup);
    `per_system`: staves of a system of the work (work.yaml), see regular_counts."""
    lm = ink if lines is None else lines
    staves = staves_at(lm, centres) if centres else find_staves(lm)
    systems = group_systems(ink, staves)
    guessed = False
    if not counts:
        counts = regular_counts(systems, per_system)
        guessed = bool(counts) and not per_system
    if counts:
        systems = regroup(systems, counts)
        for s in systems:
            s.guessed = guessed
    for s in systems:
        find_barlines(ink, s, strict)
    return systems


def to_dict(systems: list[System]) -> dict:
    out = []
    for s in systems:
        out.append({
            "top": s.top, "bottom": s.bottom, "start_x": s.start_x,
            "barlines": [int(x) for x in s.barlines], "piano": bool(s.piano),
            "weak": [int(x) for x in s.weak],
            "staves": [asdict(st) for st in s.staves],
        })
    return {"systems": out}


def from_dict(d: dict) -> list[System]:
    res = []
    for s in d["systems"]:
        res.append(System([Staff(**st) for st in s["staves"]], list(s["barlines"]),
                          s["start_x"], s.get("piano", False), list(s.get("weak", []))))
    return res
