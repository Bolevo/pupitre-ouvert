"""The straightening of a page (tools/omr/dewarp.py) follows the staves, not what is drawn
along them."""
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools.omr import dewarp  # noqa: E402

SP = 18


def test_a_stretch_one_line_off_is_not_the_staff():
    """A hairpin over three strips: five lines are found one staff space higher there."""
    tx = np.arange(24) * 100.0
    ty = np.full(24, 600.0)
    ty[9:12] -= SP
    kx, ky = dewarp._same_staff(tx, ty, SP)
    assert list(kx) == [x for i, x in enumerate(tx) if not 9 <= i < 12] and set(ky) == {600.0}


def test_a_curled_page_keeps_all_its_samples():
    tx = np.arange(24) * 100.0
    ty = 600 + 40 * np.sin(tx / 2300 * np.pi)       # two staff spaces of curl across the page
    kx, ky = dewarp._same_staff(tx, ty, SP)
    assert len(kx) == 24
    # and a track cut in two by a gap is put together again where the halves agree
    ty2 = ty.copy()
    ty2[12:] += 0.3 * SP
    assert len(dewarp._same_staff(tx, ty2, SP)[0]) == 24


def test_a_flat_page_with_a_hairpin_stays_flat():
    """A printed page with a crescendo above a staff: straightening must not bend it."""
    h, w = 700, 2400
    img = np.full((h, w), 255, np.uint8)
    for y0 in (200, 450):
        for k in range(5):
            img[y0 + k * SP: y0 + k * SP + 2, 100:2300] = 0
    for dy in (0, 1, 2):                                                   # one line of a hairpin, a space above the staff
        cv2.line(img, (900, 200 - SP + dy), (1300, 200 - SP + dy), 0, 1)
    ink = np.where(img < 128, 255, 0).astype(np.uint8)
    _, my, staves = dewarp.displacement_field(img.shape, dewarp.staff_tracks(ink), w / 2)
    moved = np.abs(my - np.arange(h, dtype=np.float32)[:, None])
    assert len(staves) == 2 and float(moved.max()) < 1.0
