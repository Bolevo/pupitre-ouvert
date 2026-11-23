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
