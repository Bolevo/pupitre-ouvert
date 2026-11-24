"""Frame a page: keep what is printed, leave out what surrounds it.

A scan or a photo often shows more than the music: wide margins, the edge of the sheet, a
shadow, the table, the facing page. On a phone every centimetre of margin is music made
smaller. `content_box` finds the printed area of a straightened page (tools/omr/surface.py):

  1. the staves (found as in the straightening) give the core of the page;
  2. the ink is cleaned of what belongs to the surroundings: whatever touches the border of the
     image, is large and lies away from the staves (the table, a shadow, the other page), and
     long thin strokes away from the staves (the edge of the sheet);
  3. the core grows over the ink near it, side by side: titles and page numbers above, lyrics
     and footers below, the names of the voices at the left (a lone speck of dust does not
     count: it would pull the frame towards it);
  4. a margin of a few staff spaces is left around, less where the surroundings begin sooner
     (the edge of the sheet, the grain of a table).

Nothing is moved or retouched: the page is only cut. Without staves, or when there is nothing
to gain, the page is left whole. Each page is framed on its own, then brought to one width
(tools/page_assets.py): a page whose every system is shorter than the others' comes out
enlarged (`page_assets.py --no-frame` keeps the images whole).
"""
from __future__ import annotations

import cv2
import numpy as np

from tools.omr.dewarp import staff_tracks
from tools.omr.surface import ANALYSIS_W, lines_of

INK = 150            # darker than this on the whitened page: ink
REACH_Y = 16.0       # staff spaces of blank crossed to reach a title, a page number, a footer
REACH_X = 6.0        # … to reach the name of a voice, a bracket
MARGIN = 2.5         # staff spaces left around what is printed
MIN_MARGIN = 0.75    # … at least, where the surroundings begin sooner
SPECK = 0.15         # ink in a neighbourhood, in squared staff spaces, below which a mark is dust
PAPER = 205          # lighter than this on the whitened page: paper
MIN_GAIN = 0.03      # cut only if a side moves in by this share of the page
BORDER_BIG = 0.12    # a mark touching the border and this long (share of the page side): surroundings
EDGE_LONG = 0.4      # a thin stroke this long, away from the staves: the edge of the sheet


def content_box(flat: np.ndarray) -> tuple[int, int, int, int] | None:
    """(x0, y0, x1, y1), in the pixels of `flat` (the straightened page, paper white), of what
    is printed with its margin; None to keep the whole page."""
    H, W = flat.shape
    sc = ANALYSIS_W / W
    small = cv2.resize(flat, (ANALYSIS_W, max(1, round(H * sc))), interpolation=cv2.INTER_AREA)
    h, w = small.shape
    tracks = [(t, sp) for t, sp in staff_tracks(lines_of(small), 24) if len(t) >= 8]
    if not tracks:
        return None
    sp = float(np.median([s for _, s in tracks]))
    strip = w / 24
    xs = [x for t, _ in tracks for x, _ in t]
    ys = [y for t, _ in tracks for _, y in t]
    # the staves, with the room of their own notes above and below
    core = [max(0.0, min(xs) - strip / 2), max(0.0, min(ys) - 4 * sp), min(float(w), max(xs) + strip / 2), min(float(h), max(ys) + 4 * sp)]

    ink = (small < INK).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    keep = np.zeros(n, bool)
    cx0, cy0, cx1, cy1 = (int(v) for v in core)
    in_core = np.bincount(labels[cy0:cy1, cx0:cx1].ravel(), minlength=n)    # pixels of each mark among the staves
    for i in range(1, n):
        x, y, bw, bh, area = (int(v) for v in stats[i])
        if area < 3:
            continue                                                        # a speck
        away = in_core[i] < 0.05 * area                                     # (almost) nothing of it among the staves
        touches = x <= 1 or y <= 1 or x + bw >= w - 1 or y + bh >= h - 1
        if touches and away and (bw > BORDER_BIG * w or bh > BORDER_BIG * h or area > (6 * sp) ** 2):
            continue                                                        # the table, a shadow, the other page
        if not in_core[i] and (bw > EDGE_LONG * w or bh > EDGE_LONG * h) and area < 0.1 * bw * bh:
            continue                                                        # the edge of the sheet (long and thin, even bent)
        keep[i] = True
    printed = keep[labels]
    # dust: a mark with (almost) no ink around it. Counted over a neighbourhood, not mark by mark:
    # the small letters of a footer, each as light as a speck, stand together
    near = cv2.boxFilter(printed.astype(np.float32), -1, (int(4 * sp) | 1, int(2 * sp) | 1), normalize=False)
    printed &= near >= SPECK * sp * sp

    box = list(core)
    for _ in range(40):
        before = list(box)
        x0, y0, x1, y1 = (int(round(v)) for v in box)
        cols = slice(max(0, int(x0 - REACH_X * sp)), min(w, int(x1 + REACH_X * sp)))
        rows = slice(max(0, int(y0 - REACH_X * sp)), min(h, int(y1 + REACH_X * sp)))
        top = max(0, int(y0 - REACH_Y * sp))
        r = np.flatnonzero(printed[top:y0, cols].any(axis=1))
        if r.size:
            box[1] = float(top + r[0])
        bot = min(h, int(y1 + REACH_Y * sp))
        r = np.flatnonzero(printed[y1:bot, cols].any(axis=1))
        if r.size:
            box[3] = float(y1 + r[-1] + 1)
        left = max(0, int(x0 - REACH_X * sp))
        c = np.flatnonzero(printed[rows, left:x0].any(axis=0))
        if c.size:
            box[0] = float(left + c[0])
        right = min(w, int(x1 + REACH_X * sp))
        c = np.flatnonzero(printed[rows, x1:right].any(axis=0))
        if c.size:
            box[2] = float(x1 + c[-1] + 1)
        if box == before:
            break
    # the margin, shorter on a side where something that is neither paper nor print begins sooner
    # (the grain of a table, the next sheet): looked for line by line outwards from the print
    bx0, by0, bx1, by1 = (int(round(v)) for v in box)
    grow = cv2.dilate(printed.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    soil = (small < PAPER) & ~grow
    full, least = int(MARGIN * sp), int(MIN_MARGIN * sp)

    def room(counts: np.ndarray) -> float:
        dirty = np.flatnonzero(counts[:full] > sp)
        return float(max(least, int(dirty[0]) - 1)) if dirty.size else float(full)

    x0 = max(0.0, bx0 - room(soil[by0:by1, :bx0].sum(axis=0)[::-1]))
    x1 = min(float(w), bx1 + room(soil[by0:by1, bx1:].sum(axis=0)))
    y0 = max(0.0, by0 - room(soil[:by0, bx0:bx1].sum(axis=1)[::-1]))
    y1 = min(float(h), by1 + room(soil[by1:, bx0:bx1].sum(axis=1)))
    if max(x0 / w, 1 - x1 / w, y0 / h, 1 - y1 / h) < MIN_GAIN:
        return None                                                         # already well framed
    return int(x0 / sc), int(y0 / sc), min(W, int(round(x1 / sc))), min(H, int(round(y1 / sc)))
