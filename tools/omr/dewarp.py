"""Straighten curved staff lines (phone photos: perspective + page curl).

Staves are located independently in narrow vertical strips, tracked across
strips, and a smooth vertical displacement field is built so that every staff
becomes horizontal. Text and notes follow the same field.
"""
from __future__ import annotations

import cv2
import numpy as np


def _strip_staves(prof: np.ndarray, thresh: float) -> list[tuple[float, float]]:
    """(centre_y, space) for each 5-line group found in a strip's row profile."""
    rows = np.where(prof > thresh)[0]
    peaks: list[float] = []
    if rows.size:
        start = prev = rows[0]
        for r in rows[1:]:
            if r > prev + 1:
                peaks.append((start + prev) / 2)
                start = r
            prev = r
        peaks.append((start + prev) / 2)
    out = []
    i = 0
    while i + 4 < len(peaks):
        c = np.array(peaks[i:i + 5])
        g = np.diff(c)
        if g.min() >= 4 and g.max() <= 1.4 * g.min() + 1.5 and g.max() < 30:
            out.append((float(c.mean()), float(g.mean())))
            i += 5
        else:
            i += 1
    return out


def staff_tracks(ink: np.ndarray, n_strips: int = 24) -> list[tuple[list[tuple[float, float]], float]]:
    """For each staff: ((x, centre_y) samples across the page width, line spacing)."""
    h, w = ink.shape
    sw = w // n_strips
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, sw // 3), 1))
    hl = cv2.morphologyEx(ink, cv2.MORPH_OPEN, k) > 0
    strips = []
    for s in range(n_strips):
        x0, x1 = s * sw, (s + 1) * sw
        prof = hl[:, x0:x1].sum(axis=1)
        strips.append(((x0 + x1) / 2, _strip_staves(prof, 0.6 * sw)))
    # greedy left-to-right linking; a staff unseen in some strips keeps its track
    tracks: list[list[tuple[float, float]]] = []
    spaces: list[float] = []
    for x, found in strips:
        used: set[int] = set()
        for c, sp in found:
            best, bd = None, 1.2 * sp
            for ti, t in enumerate(tracks):
                d = abs(t[-1][1] - c)
                if ti not in used and d < bd and x - t[-1][0] < 6 * sw:
                    best, bd = ti, d
            if best is None:
                tracks.append([(x, c)])
                spaces.append(sp)
                used.add(len(tracks) - 1)
            else:
                tracks[best].append((x, c))
                used.add(best)
    return [(sorted(t), sp) for t, sp in zip(tracks, spaces) if len(t) >= 5]


def _same_staff(tx: np.ndarray, ty: np.ndarray, sp: float) -> tuple[np.ndarray, np.ndarray]:
    """The samples of a track that follow one staff. A line drawn along the staff over a few
    strips (a hairpin, a long beam, a slur) makes a five-line group one line higher or lower
    there: the track steps by about a staff space and comes back, where a curled page only
    drifts. Such stretches are dropped (the staff is interpolated across them): kept as they
    were, they bent a flat page by a staff space under every hairpin."""
    if len(ty) < 3:
        return tx, ty
    runs, start = [], 0
    for i in range(1, len(ty) + 1):
        if i == len(ty) or abs(ty[i] - ty[i - 1]) > 0.5 * sp:
            runs.append((start, i))
            start = i
    if len(runs) == 1:
        return tx, ty
    a, b = max(runs, key=lambda r: r[1] - r[0])
    keep = np.zeros(len(ty), bool)
    keep[a:b] = True
    for lo, hi in sorted(runs, key=lambda r: min(abs(r[0] - b), abs(a - r[1]))):   # outwards from the longest
        if keep[lo]:
            continue
        mid = float(np.median(tx[lo:hi]))
        if abs(float(np.median(ty[lo:hi])) - float(np.interp(mid, tx[keep], ty[keep]))) < 0.5 * sp:
            keep[lo:hi] = True
    return tx[keep], ty[keep]


def displacement_field(shape: tuple[int, int], tracks, xref: float):
    """Maps for cv2.remap so that each tracked staff becomes flat at its y(xref).
    Returns (map_x, map_y, [(y_ref, space)] of the staves)."""
    h, w = shape
    xs = np.arange(w, dtype=np.float32)
    anchors = []   # (target_y, offset_per_column, space, n_samples)
    for t, sp in tracks:
        tx = np.array([p[0] for p in t])
        ty = np.array([p[1] for p in t])
        tx, ty = _same_staff(tx, ty, sp)
        if len(ty) >= 5:   # drop samples far from the local median (wrong 5-line grouping)
            med5 = np.array([np.median(ty[max(0, i - 2):i + 3]) for i in range(len(ty))])
            good = np.abs(ty - med5) < 3
            tx, ty = tx[good], ty[good]
        if len(ty) >= 5:   # light smoothing: 3-point median
            med = ty.copy()
            med[1:-1] = np.median(np.stack([ty[:-2], ty[1:-1], ty[2:]]), axis=0)
            ty = med
        if len(ty) < 3:
            continue
        # piecewise linear; beyond the ends, extrapolate the end slope but by
        # at most one staff space (wild extrapolation smears the image)
        fy = np.interp(xs, tx, ty)
        lo, hi = xs < tx[0], xs > tx[-1]
        fy[lo] = ty[0] + np.clip((xs[lo] - tx[0]) * (ty[1] - ty[0]) / max(tx[1] - tx[0], 1), -sp, sp)
        fy[hi] = ty[-1] + np.clip((xs[hi] - tx[-1]) * (ty[-1] - ty[-2]) / max(tx[-1] - tx[-2], 1), -sp, sp)
        y_ref = float(np.interp(xref, tx, ty))
        anchors.append((y_ref, (fy - y_ref).astype(np.float32), sp, len(ty)))
    # two tracks of the same staff (broken linking): keep the longer one
    anchors.sort(key=lambda a: a[0])
    dedup = []
    for a in anchors:
        if dedup and a[0] - dedup[-1][0] < 3 * a[2]:
            if a[3] > dedup[-1][3]:
                dedup[-1] = a
        else:
            dedup.append(a)
    anchors = dedup
    map_x = np.tile(xs, (h, 1))
    ys = np.arange(h, dtype=np.float32)[:, None]
    staves = [(a[0], a[2]) for a in anchors]
    if not anchors:
        return map_x, np.tile(ys, (1, w)).astype(np.float32), staves
    ty = np.array([a[0] for a in anchors], dtype=np.float32)
    offs = np.stack([a[1] for a in anchors])          # (n, w)
    # linear interpolation of the offset along y for every column
    idx = np.clip(np.searchsorted(ty, ys[:, 0]), 1, len(ty) - 1) if len(ty) > 1 else None
    if idx is None:
        d = np.tile(offs[0], (h, 1))
    else:
        y0, y1 = ty[idx - 1], ty[idx]
        a = np.clip((ys[:, 0] - y0) / np.maximum(y1 - y0, 1), 0, 1)[:, None]
        d = offs[idx - 1] * (1 - a) + offs[idx] * a
    map_y = (ys + d).astype(np.float32)
    return map_x, map_y, staves


def dewarp(gray: np.ndarray, ink: np.ndarray) -> tuple[np.ndarray, list[tuple[float, float]]]:
    """-> (straightened image, [(centre_y, space)] of every staff found)."""
    tracks = staff_tracks(ink)
    mx, my, staves = displacement_field(gray.shape, tracks, gray.shape[1] / 2)
    return cv2.remap(gray, mx, my, interpolation=cv2.INTER_CUBIC, borderValue=255), staves
