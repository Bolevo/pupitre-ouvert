"""Staff / system / barline detection on a synthetic page."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from tools.omr import dewarp, imgproc as ip, layout as lay  # noqa: E402
from tools.omr.pages import reconcile  # noqa: E402


def synthetic_page(bars=(300, 520, 760), n_staves=6, tilt=0.0):
    img = np.full((1300, 1000), 255, np.uint8)
    tops = [100 + i * 110 for i in range(n_staves)]
    for t in tops:
        for k in range(5):
            y = t + 8 * k
            cv2.line(img, (80, y), (900, int(y + tilt * 820)), 0, 1)
    for x in [80] + list(bars) + [900]:
        cv2.line(img, (x, tops[0]), (x, int(tops[-1] + 32 + tilt * (x - 80))), 0, 2)
    # a stem with a notehead (must not be taken for a barline)
    cv2.line(img, (420, tops[2] - 20), (420, tops[2] + 20), 0, 1)
    cv2.ellipse(img, (414, tops[2] + 20), (6, 4), -20, 0, 360, 0, -1)
    return img


def analyse(img):
    norm = ip.normalize_background(img)
    lines = ip.line_mask(norm) | ip.binarize(norm, 205)
    norm, centres = dewarp.dewarp(norm, lines)
    lines = ip.line_mask(norm) | ip.binarize(norm, 205)
    return lay.analyse(ip.binarize(norm, 205), ip.binarize(norm), lines, centres)


def test_one_system_six_staves_four_measures():
    systems = analyse(synthetic_page())
    assert len(systems) == 1
    s = systems[0]
    assert len(s.staves) == 6
    assert len(s.barlines) == 4                     # 3 inner + final
    assert abs(s.staves[0].space - 8) < 1


def test_slightly_tilted_page():
    systems = analyse(synthetic_page(tilt=0.01))
    assert len(systems) == 1 and len(systems[0].staves) == 6


def test_reconcile_merges_narrowest():
    s = lay.System([lay.Staff([0, 8, 16, 24, 32], 0, 900)], [300, 330, 600, 900], 80)
    assert reconcile(s, 3)
    assert s.barlines == [300, 600, 900] or s.barlines == [330, 600, 900]


def test_dict_roundtrip():
    systems = analyse(synthetic_page())
    back = lay.from_dict(lay.to_dict(systems))
    assert back[0].barlines == systems[0].barlines


def test_a_beam_above_the_staff_is_not_taken_for_its_first_line():
    """Repeated chords under one long beam, a staff space above the staff: the tracking can take
    the beam and the first four lines for the staff. The five lines kept are the five full ones."""
    img = np.full((400, 1000), 255, np.uint8)
    top, sp = 200, 16
    for k in range(5):
        cv2.line(img, (80, top + sp * k), (900, top + sp * k), 0, 2)
    for x0 in range(110, 860, 190):                                     # the beams: most of the width, not all
        cv2.line(img, (x0, top - sp), (x0 + 160, top - sp), 0, 5)
    ink = (img < 128).astype(np.uint8) * 255
    wrong_centre = top + 2 * sp - sp                                    # as if the beam were the first line
    staff = lay.staves_at(ink, [(wrong_centre, sp)])[0]
    assert [abs(y - (top + sp * k)) <= 1 for k, y in enumerate(staff.lines)] == [True] * 5
    right = lay.staves_at(ink, [(top + 2 * sp, sp)])[0]                 # and a staff found right stays
    assert right.lines == staff.lines
